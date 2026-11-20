/**
 * The account-use logs, written on the recorder's minute tick (`server/recorder.ts`) and,
 * for holds, when Session Guard saves its state (`server/guard/store.ts`). Rules and row
 * shapes are in `shared/account-log.ts`; the files are append-only (`server/store.ts`).
 *
 * Cheap by design: the tick reuses the agent listing and the ZeroSub snapshot the
 * recorder already has, reads nothing else after its first run, and writes one
 * placement line a minute plus a line per change.
 */

import { appendAccountLog, readAccountLog } from "./store.ts";
import {
  creditsKey,
  creditsRows,
  holdEvents,
  moveEvents,
  placementRow,
  type CreditsRow,
  type HoldRow,
  type MoveRow,
  type PlacedAgent,
} from "../shared/account-log.ts";
import type { Pause } from "../shared/guard/policy.ts";
import type { ZeroSubSnapshot } from "../shared/guard/zerosub.ts";

/** The agent → account map of this process's last placement row; null before its first. */
let lastPlacement: Readonly<Record<string, string>> | null = null;
/** ZeroSub's session accounts at the last tick; null before the first look (a baseline). */
let lastSessions: Readonly<Record<string, string>> | null = null;
/** Per account, the credits key last written; filled from this month's log on first use. */
let lastCredits: Map<string, string> | null = null;

const DAY = 24 * 60 * 60_000;

async function creditsBaseline(now: number): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const row of await readAccountLog<CreditsRow>("credits", { sinceMs: now - 31 * DAY })) {
    if (typeof row.accountId === "string") map.set(row.accountId, creditsKey(row));
  }
  return map;
}

/**
 * One minute's account-use rows. `agents` is the recorder's listing (closed ones are
 * skipped); `snapshot` null means no ZeroSub, where only placement is logged.
 */
export async function logAccountUse(snapshot: ZeroSubSnapshot | null, agents: readonly PlacedAgent[], now = Date.now()): Promise<MoveRow[]> {
  const at = new Date(now).toISOString();
  const placement = placementRow(snapshot, agents, lastPlacement, at);
  if (placement.row !== null) await appendAccountLog("placement", placement.row);
  lastPlacement = placement.map;

  if (snapshot === null) {
    lastSessions = null;
    return [];
  }
  const moves = moveEvents(lastSessions, snapshot, at);
  for (const row of moves) await appendAccountLog("moves", row);
  lastSessions = { ...snapshot.sessions };

  lastCredits ??= await creditsBaseline(now);
  for (const row of creditsRows(snapshot, lastCredits, at)) {
    await appendAccountLog("credits", row);
    lastCredits.set(row.accountId, creditsKey(row));
  }
  return moves;
}

/** Session Guard saved its state: log the holds that started or ended. Never throws. */
export function logHolds(previous: readonly Pick<Pause, "id" | "settledAt">[] | null, next: readonly Pause[], now = Date.now()): Promise<void> {
  const rows: HoldRow[] = holdEvents(previous, next, new Date(now).toISOString());
  return (async () => {
    for (const row of rows) await appendAccountLog("holds", row);
  })().catch((error) => console.error("[smart-session] could not log a hold", String(error)));
}

/** Teardown: a reload starts with fresh baselines. */
export function forgetAccountUse(): void {
  lastPlacement = null;
  lastSessions = null;
  lastCredits = null;
}
