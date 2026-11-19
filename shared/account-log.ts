/**
 * What Smart Session logs so it can later say how well the accounts are used: where
 * each open agent runs, every Session Guard hold, every ZeroSub move, and each account's
 * Extra usage (credits). Pure rules; `server/account-log.ts` reads and appends.
 *
 * Every row carries ids only: agent ids, ZeroSub account ids, flags, times and numbers.
 * Never a title, a prompt, an email, a label ZeroSub generated, or a path.
 */

import type { Pause } from "./guard/policy.ts";
import { accountOf, familyOf, type ZeroSubSnapshot } from "./guard/zerosub.ts";

/** An open agent as the recorder's minute listing has it. */
export interface PlacedAgent {
  readonly id: string;
  readonly provider: string;
  readonly status: string;
}

/**
 * `placement-YYYY-MM.jsonl`, one row a minute: per account, how many open Claude/Codex
 * agents run and idle on it, and the ids of the running ones. The full agent → account
 * map (`agents`) rides only on a row where it changed, and on a process's first row, so
 * a month stays small; a reader carries the last map forward.
 */
export interface PlacementRow {
  readonly at: string;
  /** ZeroSub's account id, or `<family>-cli` without ZeroSub (the CLI's own login). */
  readonly accounts: Readonly<Record<string, { readonly running: number; readonly idle: number; readonly other?: number }>>;
  /** Agent ids whose turn is running (initializing counts as running). */
  readonly running: readonly string[];
  /** agentId → account key; present only when it changed since this process's last row. */
  readonly agents?: Readonly<Record<string, string>>;
}

/** The account an agent counts against: ZeroSub's id, else the CLI login of its family. */
export function placementKey(snapshot: ZeroSubSnapshot | null, agent: PlacedAgent): string | null {
  const family = familyOf(agent.provider);
  if (family === null) return null;
  if (snapshot === null) return `${family}-cli`;
  return accountOf(snapshot, agent.id, agent.provider)?.id ?? `${family}-unknown`;
}

const sameMap = (a: Readonly<Record<string, string>> | null, b: Readonly<Record<string, string>>) => {
  if (a === null) return false;
  const keys = Object.keys(b);
  return keys.length === Object.keys(a).length && keys.every((k) => a[k] === b[k]);
};

/**
 * This minute's placement row, and the map to compare the next one with. `previous` is
 * the map last written by this process (null on its first row). Null row: no open
 * Claude/Codex agent and nothing to say (an empty map is still written once, so the end
 * of the last agent is on record).
 */
export function placementRow(
  snapshot: ZeroSubSnapshot | null,
  agents: readonly PlacedAgent[],
  previous: Readonly<Record<string, string>> | null,
  at: string,
): { row: PlacementRow | null; map: Readonly<Record<string, string>> } {
  const accounts: Record<string, { running: number; idle: number; other?: number }> = {};
  const running: string[] = [];
  const map: Record<string, string> = {};
  for (const agent of agents) {
    if (agent.status === "closed") continue;
    const key = placementKey(snapshot, agent);
    if (key === null) continue;
    map[agent.id] = key;
    const bucket = (accounts[key] ??= { running: 0, idle: 0 });
    if (agent.status === "running" || agent.status === "initializing") {
      bucket.running += 1;
      running.push(agent.id);
    } else if (agent.status === "idle") bucket.idle += 1;
    else bucket.other = (bucket.other ?? 0) + 1;
  }
  const changed = !sameMap(previous, map);
  if (Object.keys(map).length === 0 && !changed) return { row: null, map };
  running.sort();
  return { row: { at, accounts, running, ...(changed ? { agents: map } : {}) }, map };
}

/**
 * `holds-YYYY-MM.jsonl`: a Session Guard hold starting or ending, appended when the
 * guard writes it (`server/guard/store.ts`). One row per change, ids and flags only.
 */
export interface HoldRow {
  readonly at: string;
  readonly event: "start" | "end";
  readonly pauseId: string;
  readonly agentId: string;
  readonly provider: string;
  /** The ZeroSub account it was held on, when the guard knew it. */
  readonly accountId: string | null;
  readonly windowId: string;
  /** Why it started: `limit` (the threshold), `quota-failure` (a turn failed on the limit), `idle`, `demo`. */
  readonly reason: string;
  readonly pausedAt: string;
  /** The window reset the hold waits for (its own account's). */
  readonly resetsAt: string | null;
  /** With ZeroSub, when another account has room again, if sooner. */
  readonly nextRoomAt: string | null;
  /** How it ended: `resumed`, `resumed-in-place`, `manual`, `manual-in-place`, `dismissed`, `unload`, `cancelled`, `stopped` (a move shows in `moves-*.jsonl`). */
  readonly outcome?: string;
  readonly phase: string;
}

const isOpen = (pause: Pick<Pause, "settledAt">) => pause.settledAt === null;

function startReason(pause: Pause): string {
  if (pause.demo) return "demo";
  if (pause.wasQuotaFailure) return "quota-failure";
  if (pause.idle) return "idle";
  return "limit";
}

function endOutcome(pause: Pause): string {
  if (pause.releasedForUnload) return "unload";
  if (pause.dismissed) return "dismissed";
  if (pause.stoppedByUser) return "stopped";
  if (pause.phase === "cancelled") return "cancelled";
  if (pause.manualResume) return pause.resumedInPlace ? "manual-in-place" : "manual";
  if (pause.resumedInPlace) return "resumed-in-place";
  return "resumed";
}

function holdRow(pause: Pause, event: "start" | "end", at: string): HoldRow {
  return {
    at,
    event,
    pauseId: pause.id,
    agentId: pause.agentId,
    provider: pause.provider,
    accountId: pause.accountId ?? null,
    windowId: pause.windowId,
    reason: startReason(pause),
    pausedAt: pause.pausedAt,
    resetsAt: pause.anchorResetsAt,
    nextRoomAt: pause.nextRoomAt ?? null,
    ...(event === "end" ? { outcome: endOutcome(pause) } : {}),
    phase: pause.phase,
  };
}

/**
 * Holds that started or ended between two saved guard states. `previous` null means
 * this process has no baseline yet: every open hold is a start then, so a hold that
 * began before a reload is on record once (a reader dedupes by `pauseId`).
 */
export function holdEvents(previous: readonly Pick<Pause, "id" | "settledAt">[] | null, next: readonly Pause[], at: string): HoldRow[] {
  const before = new Map((previous ?? []).map((p) => [p.id, p]));
  const rows: HoldRow[] = [];
  for (const pause of next) {
    const was = before.get(pause.id);
    if (isOpen(pause) && (was === undefined || !isOpen(was))) rows.push(holdRow(pause, "start", at));
    else if (!isOpen(pause) && was !== undefined && isOpen(was)) rows.push(holdRow(pause, "end", pause.settledAt ?? at));
  }
  return rows;
}

/**
 * `credits-YYYY-MM.jsonl`: each ZeroSub account's Extra usage (Claude) or credits
 * (Codex) and its limit state, written when any of it changes. The CLI login included:
 * the usage log keeps its spend too, but only for that one login.
 */
export interface CreditsRow {
  readonly at: string;
  readonly accountId: string;
  readonly family: "claude" | "codex";
  /** When ZeroSub read it. */
  readonly fetchedAt: string | null;
  /** Claude Extra usage; `spend` and `limit` in minor units of `currency`. */
  readonly extraUsage: { readonly enabled: boolean; readonly spend: number | null; readonly limit: number | null; readonly currency: string | null } | null;
  /** Codex (ChatGPT) credits. */
  readonly credits: { readonly balance: number | null; readonly unlimited: boolean } | null;
  readonly limitedUntil: string | null;
  readonly limitKind: "window" | "budget" | null;
  readonly signedIn: boolean;
  readonly disabled: boolean;
}

/** The part of a credits row that, changed, is worth a new line. */
export const creditsKey = (row: CreditsRow) =>
  JSON.stringify([row.extraUsage, row.credits, row.limitedUntil, row.limitKind, row.signedIn, row.disabled]);

/** Rows for every account whose credits or limit state differs from the last one kept. */
export function creditsRows(snapshot: ZeroSubSnapshot, last: ReadonlyMap<string, string>, at: string): CreditsRow[] {
  const rows: CreditsRow[] = [];
  for (const account of snapshot.accounts) {
    const reading = snapshot.readings[account.id];
    const row: CreditsRow = {
      at,
      accountId: account.id,
      family: account.family,
      fetchedAt: reading?.fetchedAt ?? null,
      extraUsage: reading?.extraUsage ?? null,
      credits: reading?.credits ?? null,
      limitedUntil: account.limitedUntil,
      limitKind: account.limitKind,
      signedIn: account.signedIn,
      disabled: account.disabled,
    };
    if (last.get(account.id) !== creditsKey(row)) rows.push(row);
  }
  return rows;
}

/**
 * `moves-YYYY-MM.jsonl`: an agent's live ZeroSub session reopened on another account
 * (`from` → `to`), or a new session placed (`from` null), as seen in ZeroSub's
 * `state.json` between two minute ticks. We don't own ZeroSub: this only reads it.
 */
export interface MoveRow {
  readonly at: string;
  readonly agentId: string;
  readonly family: string | null;
  readonly from: string | null;
  readonly to: string;
  /**
   * ZeroSub's binding source when it bound the agent to `to` (`pace`, `auto`, `balance`,
   * `thread`, `user`, plus `balance:<selectionReason>`), else `limit` when `from` was
   * limited, else `unknown`.
   */
  readonly reason: string;
  /** When ZeroSub opened the session on `to`. */
  readonly openedAt: string | null;
}

const SAFE = /^[a-z][a-z0-9_-]{0,39}$/;

/**
 * Sessions whose account changed since `previous` (agentId → accountId of the last
 * tick). Null `previous`: this process's first look, a baseline with no rows.
 */
export function moveEvents(previous: Readonly<Record<string, string>> | null, snapshot: ZeroSubSnapshot, at: string): MoveRow[] {
  if (previous === null) return [];
  const rows: MoveRow[] = [];
  for (const [agentId, to] of Object.entries(snapshot.sessions)) {
    const from = previous[agentId] ?? null;
    if (from === to) continue;
    const binding = snapshot.bindings?.[agentId];
    let reason = "unknown";
    if (binding && binding.accountId === to && SAFE.test(binding.source)) {
      reason = binding.selectionReason && SAFE.test(binding.selectionReason) ? `${binding.source}:${binding.selectionReason}` : binding.source;
    } else if (from !== null) {
      const was = snapshot.accounts.find((a) => a.id === from);
      if (was?.limitedUntil && Date.parse(was.limitedUntil) > Date.parse(at)) reason = "limit";
    }
    rows.push({
      at,
      agentId,
      family: snapshot.accounts.find((a) => a.id === to)?.family ?? null,
      from,
      to,
      reason,
      openedAt: snapshot.openedAt[agentId] ?? null,
    });
  }
  return rows;
}
