import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentTools } from "./server/agent-tools.mjs";
import { toolRow } from "./shared/chat.ts";
import type { HoldRow, MoveRow } from "./shared/account-log.ts";
import type { ZeroSubSnapshot } from "./shared/guard/zerosub.ts";
import {
  EMPTY_SHADOW, MOVE_SPACING_MS, isForced, liveRefusal, placementFacts, placementLine, placementMode, placementSummary, shadowTick,
  type DecisionRow, type ShadowAgent, type ShadowState,
} from "./shared/placement-shadow.ts";

/**
 * Smart placement beside ZeroSub, with fictional accounts: alice's (claude-main) and bob's
 * (claude-bob). Shadow writes a log and changes nothing; live acts only through move_before_limit.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-03-15T12:00:00.000Z");
const iso = (t: number) => new Date(t).toISOString();

function snapshot(o: { aliceFive: number; bobFive?: number; sessions: Record<string, string>; bindings?: Record<string, string>; openedAt?: Record<string, number>; at?: number }): ZeroSubSnapshot {
  const at = o.at ?? NOW;
  const reading = (five: number, weekly: number) => ({
    fetchedAt: iso(at - MIN), cached: false, credits: null, extraUsage: null,
    windows: [
      { id: "five_hour", usedPct: five, resetsAt: iso(NOW + 3 * HOUR), minutes: 300 },
      { id: "seven_day", usedPct: weekly, resetsAt: iso(NOW + 2 * 24 * HOUR), minutes: 10080 },
    ],
  });
  const account = (id: string, kind: "main" | "managed") => ({ id, family: "claude" as const, kind, label: null, signedIn: true, disabled: false, limitedUntil: null, limitKind: null, createdAt: null });
  return {
    accounts: [account("claude-main", "main"), account("claude-bob", "managed")],
    sessions: o.sessions,
    openedAt: Object.fromEntries(Object.entries(o.openedAt ?? {}).map(([k, t]) => [k, iso(t)])),
    continuedElsewhere: new Set(),
    readings: { "claude-main": reading(o.aliceFive, 40), "claude-bob": reading(o.bobFive ?? 5, 60) },
    autoSwitch: true,
    defaults: { claude: null, codex: null },
    bindings: Object.fromEntries(Object.entries(o.bindings ?? {}).map(([k, source]) => [k, { accountId: o.sessions[k]!, source, selectionReason: null }])),
  };
}
const agent = (id: string, status = "idle", usedTokens: number | null = 50_000): ShadowAgent => ({ id, provider: "claude", status, usedTokens });

/**
 * Two ticks half an hour apart on alice's account: her 5-hour window climbs 30% → 70% (80%/h),
 * a wall in about 20 minutes, while bob's sits at 5%.
 */
function wallTicks(agents: ShadowAgent[], extra: { bindings?: Record<string, string>; openedAt?: Record<string, number> } = {}, state: ShadowState = EMPTY_SHADOW) {
  const sessions = Object.fromEntries(agents.map((a) => [a.id, "claude-main"]));
  const first = shadowTick({ snapshot: snapshot({ aliceFive: 30, sessions, at: NOW - 30 * MIN, ...extra }), agents, moves: [], sizes: {}, mode: "shadow", state, now: NOW - 30 * MIN });
  return shadowTick({ snapshot: snapshot({ aliceFive: 70, sessions, ...extra }), agents, moves: [], sizes: {}, mode: "shadow", state: { ...first.state, lastMoveAt: state.lastMoveAt }, now: NOW });
}

test("shadow: a session ahead of an imminent 5-hour wall would move, the smallest idle context first", () => {
  const tick = wallTicks([agent("s-big", "idle", 400_000), agent("s-small", "idle", 20_000), agent("s-busy", "running", 1_000)]);
  const move = tick.rows.find((r): r is Extract<DecisionRow, { kind: "move" }> => r.kind === "move");
  assert.ok(move, JSON.stringify(tick.rows));
  assert.equal(move.agentId, "s-small", "a running session is never moved; the smallest idle one goes first");
  assert.deepEqual([move.from, move.to, move.reason, move.mode], ["claude-main", "claude-bob", "five-hour", "shadow"]);
  assert.equal(move.outcome, undefined, "shadow asks ZeroSub nothing");
  assert.ok(tick.state.flagged["s-small"] === NOW);
});

test("shadow keeps today's guards: a manual pin, a fresh move and the 10-minute spacing all stop a move", () => {
  assert.equal(wallTicks([agent("s1")], { bindings: { s1: "user" } }).rows.filter((r) => r.kind === "move").length, 0, "a manual pin wins");
  assert.equal(wallTicks([agent("s1")], { openedAt: { s1: NOW - 2 * HOUR } }).rows.filter((r) => r.kind === "move").length, 0, "moved 2 h ago: 6 h cooldown");
  assert.equal(wallTicks([agent("s1")], {}, { ...EMPTY_SHADOW, lastMoveAt: NOW - MOVE_SPACING_MS / 2 }).rows.filter((r) => r.kind === "move").length, 0, "another move 5 minutes ago");
});

test("shadow: a new session ZeroSub placed is logged beside the rule's pick; a forced move says whether the rule saw it coming", () => {
  const moved = wallTicks([agent("s1")]);
  const moves: MoveRow[] = [
    { at: iso(NOW + MIN), agentId: "s-new", family: "claude", from: null, to: "claude-main", reason: "balance", openedAt: null },
    { at: iso(NOW + MIN), agentId: "s1", family: "claude", from: "claude-main", to: "claude-bob", reason: "auto", openedAt: null },
    { at: iso(NOW + MIN), agentId: "s-other", family: "claude", from: "claude-main", to: "claude-bob", reason: "limit", openedAt: null },
  ];
  const tick = shadowTick({ snapshot: snapshot({ aliceFive: 90, sessions: { s1: "claude-bob", "s-new": "claude-main" } }), agents: [agent("s1"), agent("s-new")], moves, sizes: {}, mode: "shadow", state: moved.state, now: NOW + MIN });
  const place = tick.rows.find((r) => r.kind === "place");
  assert.deepEqual(place && { actual: place.actual, pick: place.pick }, { actual: "claude-main", pick: "claude-bob" }, "alice is walling: the rule picks bob");
  const forced = tick.rows.filter((r): r is Extract<DecisionRow, { kind: "forced" }> => r.kind === "forced");
  assert.deepEqual(forced.map((f) => [f.agentId, f.foreseen]), [["s1", true], ["s-other", false]]);
  assert.ok(isForced("auto") && isForced("limit") && !isForced("pace") && !isForced("user"));
});

test("the placement line folds zero counts and names every move the summary counted", () => {
  // Live: "placed 0 of 0 new sessions elsewhere", and the text said "1 rebalance" the page didn't.
  const base = { mode: "shadow" as const, liveRefusal: null, since: iso(NOW - HOUR), forced: { total: 0, foreseen: 0 }, actual: { cutOffs: 0, waitingHours: 0 } };
  const quiet = { ...base, placed: { total: 0, differently: 0 }, moves: { aheadOfWall: 0, rebalance: 0 } };
  assert.equal(placementFacts(quiet).facts, "Nothing to compare yet: no new sessions, no moves, nothing stopped at a limit.");
  const rebalanced = { ...base, placed: { total: 0, differently: 0 }, moves: { aheadOfWall: 0, rebalance: 1 } };
  const said = placementFacts(rebalanced).facts;
  assert.equal(said, "It would have rebalanced 1 session. It saw no new sessions. No forced moves. Nothing stopped at a limit.");
  assert.doesNotMatch(said, /0 of 0/);
  assert.match(placementLine(rebalanced), /rebalanced 1 session/);
  const agreed = { ...base, placed: { total: 3, differently: 0 }, moves: { aheadOfWall: 0, rebalance: 0 } };
  assert.match(placementFacts(agreed).facts, /^It agreed with ZeroSub on all 3 new sessions\./);
  const live = { ...base, mode: "live" as const, placed: { total: 1, differently: 1 }, moves: { aheadOfWall: 2, rebalance: 1 } };
  assert.match(placementFacts(live).facts, /^It moved 2 sessions before a 5-hour limit and rebalanced 1 session\./);
  assert.equal(placementFacts(live).label, "Live");
});

test("the summary sets what the rule would have done beside what happened, over the report's window", () => {
  const rows: DecisionRow[] = [
    { at: iso(NOW - 2 * HOUR), kind: "move", mode: "shadow", agentId: "a", from: "claude-main", to: "claude-bob", reason: "five-hour", gain: 1, cost: 0.05 },
    { at: iso(NOW - HOUR), kind: "forced", mode: "shadow", agentId: "a", from: "claude-main", to: "claude-bob", foreseen: true },
    { at: iso(NOW - HOUR), kind: "forced", mode: "shadow", agentId: "b", from: "claude-main", to: "claude-bob", foreseen: false },
    { at: iso(NOW - HOUR), kind: "place", mode: "shadow", agentId: "c", actual: "claude-main", pick: "claude-bob" },
    { at: iso(NOW - HOUR), kind: "place", mode: "shadow", agentId: "d", actual: "claude-bob", pick: "claude-bob" },
    { at: iso(NOW - 40 * 24 * HOUR), kind: "move", mode: "shadow", agentId: "old", from: "x", to: "y", reason: "rebalance", gain: 0, cost: 0 },
  ];
  const hold = (pauseId: string, event: "start" | "end", t: number, reason = "limit"): HoldRow => ({ at: iso(t), event, pauseId, agentId: "a", provider: "claude", accountId: "claude-main", windowId: "five_hour", reason, pausedAt: iso(NOW - 90 * MIN), resetsAt: null, nextRoomAt: null, phase: "x" });
  const holds = [hold("p1", "start", NOW - 90 * MIN), hold("p1", "end", NOW - 60 * MIN), hold("p2", "start", NOW - 90 * MIN, "idle")];
  const s = placementSummary(rows, holds, NOW - 14 * 24 * HOUR, NOW, "shadow", null);
  assert.deepEqual([s.moves, s.forced, s.placed, s.actual], [{ aheadOfWall: 1, rebalance: 0 }, { total: 2, foreseen: 1 }, { total: 2, differently: 1 }, { cutOffs: 1, waitingHours: 0.5 }]);
  assert.equal(placementLine(s), "Smart placement (shadow, since Mar 15): It would have moved 1 session before a 5-hour limit. It would have placed 1 of 2 new sessions elsewhere. It saw 1 of 2 forced moves coming. What happened: 1 turn stopped at a limit, 0.5 h waiting.");
  assert.equal(placementFacts(s).facts, placementLine(s).replace(/^Smart placement \(shadow, since Mar 15\): /, ""), "the page and the text say the same");
  const refused = placementSummary([], [], 0, NOW, "live", "Live placement needs ZeroSub's move_before_limit, which the installed ZeroSub doesn't have. Staying in shadow.");
  assert.match(placementLine(refused), /^Smart placement \(shadow\): watching.*Staying in shadow\.$/);
  assert.equal(placementLine(placementSummary(rows, holds, 0, NOW, "off", null)), "Smart placement: off.");
});

test("live is refused unless ZeroSub has move_before_limit and its own pacing is off; the mode defaults to shadow", () => {
  assert.match(liveRefusal(false, null)!, /needs ZeroSub/);
  assert.match(liveRefusal(true, { moveBeforeLimit: false, ownRebalancing: false })!, /move_before_limit/);
  assert.match(liveRefusal(true, { moveBeforeLimit: true, ownRebalancing: true })!, /pacing is on/);
  assert.equal(liveRefusal(true, { moveBeforeLimit: true, ownRebalancing: false }), null);
  assert.equal(placementMode(undefined), "shadow");
  assert.equal(placementMode("live"), "live");
  assert.equal(placementMode("sometimes"), "shadow");
});

/** A Paseo home with a ZeroSub install whose files do or don't name the lever. */
async function home(o: { lever: boolean; pacing: boolean | null; mode: string }) {
  const dir = await mkdtemp(join(tmpdir(), "placement-"));
  const zs = join(dir, "zs");
  await mkdir(join(zs, "shared"), { recursive: true });
  await writeFile(join(zs, "package.json"), JSON.stringify({ name: "@kapybara/zerosub" }));
  await writeFile(join(zs, "shared", "rpc.ts"), `export const a = "zerosub.agents.account";\n${o.lever ? 'export const b = "zerosub.agents.move_before_limit";\n' : ""}export const p = { paceWeeklyUsage: true };\n`);
  await writeFile(join(dir, "config.json"), JSON.stringify({ plugins: { zerosub: { enabled: true, path: zs } } }));
  await mkdir(join(dir, "plugin-settings", "zerosub"), { recursive: true });
  await writeFile(join(dir, "plugin-settings", "zerosub", "preferences.json"), JSON.stringify({ version: 1, values: o.pacing === null ? {} : { paceWeeklyUsage: o.pacing } }));
  await mkdir(join(dir, "plugin-data", "smart-session"), { recursive: true });
  await writeFile(join(dir, "plugin-data", "smart-session", "settings.json"), JSON.stringify({ placement: { mode: o.mode } }));
  return dir;
}

/** Run two wall ticks through the server with a fake daemon; what ZeroSub was asked, and what was logged. */
async function serverRun(o: { lever: boolean; pacing: boolean | null; mode: string }) {
  const dir = await home(o);
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = dir;
  try {
    const { clearSettingsCache } = await import("./server/settings.ts");
    const placement = await import("./server/placement.ts");
    clearSettingsCache();
    placement.forgetPlacement();
    const calls: { pluginId: string; method: string; input: unknown }[] = [];
    const invoke = async (pluginId: string, method: string, input: unknown) => { calls.push({ pluginId, method, input }); return { outcome: "moved" }; };
    const agents = [agent("s1")];
    await placement.runPlacement(snapshot({ aliceFive: 30, sessions: { s1: "claude-main" }, at: NOW - 30 * MIN }), agents, [], invoke, NOW - 30 * MIN);
    await placement.runPlacement(snapshot({ aliceFive: 70, sessions: { s1: "claude-main" } }), agents, [], invoke, NOW);
    const text = await readFile(join(dir, "plugin-data", "smart-session", `decisions-${iso(NOW).slice(0, 7)}.jsonl`), "utf8").catch(() => "");
    const rows = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as DecisionRow);
    return { calls, rows, refusal: await placement.currentRefusal(NOW), patch: await placement.checkPlacementPatch({ placement: { mode: "live" }, showPill: true }) };
  } finally {
    if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous;
  }
}

test("invariant: shadow mode changes nothing; it only writes the decisions log", async () => {
  const run = await serverRun({ lever: true, pacing: false, mode: "shadow" });
  assert.deepEqual(run.calls, [], "nothing was asked of ZeroSub");
  assert.equal(run.rows.filter((r) => r.kind === "move" && r.mode === "shadow").length, 1);
  assert.equal(run.rows.some((r) => "outcome" in r), false);
});

test("live acts only through move_before_limit, one agent, and only where the lever exists and ZeroSub's pacing is off", async () => {
  const live = await serverRun({ lever: true, pacing: false, mode: "live" });
  assert.deepEqual(live.calls, [{ pluginId: "zerosub", method: "zerosub.agents.move_before_limit", input: { agentId: "s1", accountId: "claude-bob" } }]);
  const row = live.rows.find((r) => r.kind === "move");
  assert.deepEqual(row && [row.mode, "outcome" in row ? row.outcome : null], ["live", "moved"]);
  assert.equal(live.refusal, null);
  assert.deepEqual(live.patch, { patch: { placement: { mode: "live" }, showPill: true }, refused: null });

  for (const o of [{ lever: false, pacing: false }, { lever: true, pacing: true }, { lever: true, pacing: null }]) {
    const run = await serverRun({ ...o, mode: "live" });
    assert.deepEqual(run.calls, [], `${JSON.stringify(o)}: refused, so nothing is asked`);
    assert.ok(run.rows.every((r) => r.mode === "shadow"), "it runs as shadow meanwhile");
    assert.ok(run.refusal !== null);
    assert.deepEqual(run.patch, { patch: { showPill: true }, refused: run.refusal }, "the settings change keeps the mode and says why");
  }
});

test("agent parity: smart_accounts_report reads the placement line and sets the mode through the settings path", async () => {
  const calls: { method: string; input: unknown }[] = [];
  const line = "Smart placement (shadow): watching; nothing to compare yet.";
  const call = async (method: string, input: unknown) => {
    calls.push({ method, input });
    if (method === "smart-session.settings.set") return (input as { placement: { mode: string } }).placement.mode === "live" ? { settings: { placement: { mode: "shadow" } }, refused: "Live placement needs ZeroSub." } : { settings: { placement: input && (input as { placement: unknown }).placement } };
    return { reports: [], lines: ["Accounts", line], error: null };
  };
  const tools = agentTools({ agentId: null, call });
  assert.equal(await tools.accounts_report.run({}), `Accounts\n${line}`);
  const saved = await tools.accounts_report.run({ placement_mode: "off" });
  assert.match(saved, /^Saved\. Smart placement: off\./);
  assert.deepEqual(calls.slice(1, 3).map((c) => c.method), ["smart-session.settings.set", "smart-session.accounts.report"]);
  const refused = await tools.accounts_report.run({ placement_mode: "live" });
  assert.match(refused, /^Not changed: Live placement needs ZeroSub\./);
  assert.equal(toolRow("mcp__paseo__smart_accounts_report", "completed", { input: { placement_mode: "off" }, output: saved }, null)!.line, "Smart placement set to off");
  assert.equal(toolRow("mcp__paseo__smart_accounts_report", "completed", { input: { placement_mode: "live" }, output: refused }, null)!.line, "Smart placement unchanged");
});
