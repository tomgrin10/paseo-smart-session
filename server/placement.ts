/**
 * Smart placement on the recorder's minute tick (`server/recorder.ts`): the rule's decisions on the
 * real state, appended to `decisions-YYYY-MM.jsonl`. Rules in `shared/placement-shadow.ts`.
 *
 * - `off`: nothing runs.
 * - `shadow` (default): it writes the log and changes nothing in ZeroSub.
 * - `live`: the rule's moves go to ZeroSub's `move_before_limit`, one agent at a time, and only
 *   while ZeroSub has that lever and its own pacing is off (`liveRefusal`); otherwise it runs as
 *   shadow and says why. Never a default flip, never a reconcile.
 *
 * Capability, not version: the lever is found by its RPC name in the installed ZeroSub's files.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { appendAccountLog } from "./store.ts";
import { readSettings } from "./settings.ts";
import { zerosubInstallId } from "./guard/zerosub.ts";
import type { MoveRow } from "../shared/account-log.ts";
import type { ZeroSubSnapshot } from "../shared/guard/zerosub.ts";
import { EMPTY_SHADOW, liveRefusal, shadowTick, type DecisionRow, type LiveLevers, type ShadowAgent, type ShadowState } from "../shared/placement-shadow.ts";

const paseoHome = () => process.env.PASEO_HOME ?? join(homedir(), ".paseo");
import { readMoveReply } from "../shared/guard/move-reply.ts";
const MOVE_RPC = "zerosub.agents.move_before_limit";
const LEVERS_TTL_MS = 10 * 60_000;
const SCAN_FILES = 400;
const SCAN_BYTES = 2_000_000;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; } catch { return undefined; }
}

/** Does any source file under `dir` name `needle`? Bounded: a few hundred files, no node_modules. */
async function mentions(dir: string, needles: readonly string[], depth = 0, budget = { files: SCAN_FILES }): Promise<Set<string>> {
  const found = new Set<string>();
  if (depth > 5 || budget.files <= 0) return found;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (found.size === needles.length || budget.files <= 0) break;
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const n of await mentions(path, needles.filter((x) => !found.has(x)), depth + 1, budget)) found.add(n);
    } else if (/\.(m?js|ts|cjs)$/.test(entry.name)) {
      budget.files -= 1;
      try {
        if ((await stat(path)).size > SCAN_BYTES) continue;
        const text = await readFile(path, "utf8");
        for (const n of needles) if (text.includes(n)) found.add(n);
      } catch { /* unreadable: not a lever */ }
    }
  }
  return found;
}

/** What the installed ZeroSub offers live placement; null without ZeroSub. Read-only. */
export async function readLevers(home = paseoHome()): Promise<LiveLevers | null> {
  const id = await zerosubInstallId(home);
  if (id === null) return null;
  const entry = record(record(record(await readJson(join(home, "config.json")))?.plugins)?.[id]);
  const path = typeof entry?.path === "string" ? entry.path : null;
  const found = path === null ? new Set<string>() : await mentions(path, [MOVE_RPC, "paceWeeklyUsage", "balanceNewAgents"]);
  const values = record(record(await readJson(join(home, "plugin-settings", id, "preferences.json")))?.values);
  // The fork's pacing defaults to on where the setting exists. Upstream ZeroSub (1.2x+) spreads agents across
  // accounts under "Spread new agents across accounts" (`balanceNewAgents`, off by default), also on a refresh.
  const forkPacing = found.has("paceWeeklyUsage") && values?.paceWeeklyUsage !== false;
  const upstreamSpread = found.has("balanceNewAgents") && values?.balanceNewAgents === true;
  const ownRebalancing = forkPacing || upstreamSpread;
  return { moveBeforeLimit: found.has(MOVE_RPC), ownRebalancing };
}

let levers: { at: number; value: LiveLevers | null; zerosub: boolean } | null = null;

/** Why live can't run here (cached ten minutes), or null when it can. */
export async function currentRefusal(now = Date.now()): Promise<string | null> {
  if (levers === null || now - levers.at > LEVERS_TTL_MS) {
    const zerosub = (await zerosubInstallId().catch(() => null)) !== null;
    levers = { at: now, value: zerosub ? await readLevers().catch(() => null) : null, zerosub };
  }
  return liveRefusal(levers.zerosub, levers.value);
}

let state: ShadowState = EMPTY_SHADOW;

export type Invoke = (pluginId: string, method: string, input: unknown) => Promise<unknown>;

/**
 * One tick. `moves` are the rows the moves log wrote this tick. In live mode, the rule's move goes
 * to ZeroSub; the row records ZeroSub's answer. Never throws.
 */
export async function runPlacement(snapshot: ZeroSubSnapshot | null, agents: readonly ShadowAgent[], moves: readonly MoveRow[], invoke: Invoke | null, now = Date.now()): Promise<void> {
  try {
    const settings = await readSettings();
    const mode = settings.placement.mode;
    if (mode === "off" || snapshot === null) return;
    const live = mode === "live" && invoke !== null && (await currentRefusal(now)) === null;
    const tick = shadowTick({ snapshot, agents, moves, sizes: settings.accountsReport.sizes, mode: live ? "live" : "shadow", state, now });
    state = tick.state;
    let rows: DecisionRow[] = tick.rows;
    if (live && tick.move !== null) {
      const move = tick.move;
      const outcome = await moveNow(invoke!, move.agentId, move.toId);
      rows = rows.map((row) => (row.kind === "move" && row.agentId === move.agentId ? { ...row, outcome } : row));
    }
    for (const row of rows) await appendAccountLog("decisions", row);
  } catch (error) {
    console.error("[smart-session] placement tick failed", String(error));
  }
}

async function moveNow(invoke: Invoke, agentId: string, accountId: string): Promise<string> {
  const pluginId = await zerosubInstallId().catch(() => null);
  if (pluginId === null) return "failed";
  try {
    // Read as the guard reads it (`move-contract`): a move that landed on another account is
    // `landed_elsewhere`, never `moved`.
    const reply = readMoveReply(await invoke(pluginId, MOVE_RPC, { agentId, accountId }), accountId);
    if (reply === null) return "unknown";
    return reply.reason === "landed_elsewhere" || reply.reason === "unknown" ? reply.reason : reply.outcome;
  } catch {
    return "failed";
  }
}

/** A settings patch with live placement taken out when ZeroSub can't take it, and the reason. */
export async function checkPlacementPatch<P extends { placement?: { mode: string } }>(patch: P, refusal: () => Promise<string | null> = () => currentRefusal()): Promise<{ patch: P; refused: string | null }> {
  if (patch.placement?.mode !== "live") return { patch, refused: null };
  const refused = await refusal();
  if (refused === null) return { patch, refused: null };
  const { placement: _dropped, ...rest } = patch;
  return { patch: rest as P, refused };
}

/** Teardown: a reload starts with a fresh state. */
export function forgetPlacement(): void {
  state = EMPTY_SHADOW;
  levers = null;
}
