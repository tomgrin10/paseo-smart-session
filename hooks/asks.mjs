/**
 * The record of what this session has already been asked, and what it answered.
 *
 * Asking once and never again lets a session drift; asking every turn is nagging.
 * So the ask is latched, re-armed by growth rather than by a clock alone, and can
 * be switched off for a while by the agent itself — that last part is what makes it
 * a question instead of an announcement.
 *
 * One file per agent rather than one shared file. `state/<agentId>.md` already
 * works that way, and it means the `Stop` hook and the `defer_compaction` tool —
 * two separate processes — can never be writing the same file at the same moment.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { pluginDir } from "./pointer.mjs";

/** Asks per compaction epoch, after which the session is left to its own judgement. */
export const MAX_ASKS = 3;

/**
 * Further occupancy, in percentage points of the window, that re-arms the ask.
 *
 * Time alone is the wrong trigger: a session parked at 31% for an hour has not
 * changed its situation, and one that went 31% to 55% in ten minutes plainly has.
 */
export const RE_ASK_GROWTH_PCT = 10;

/**
 * `now*` is the upper line's own record. It is kept apart from the end-of-turn ask
 * so that having been asked politely at the lower line never silences the one ask
 * that says "stop pushing on", and `deferredAt` survives an answered ask so the
 * upper line can tell "deferred after I asked" from "never answered".
 */
const EMPTY = {
  askCount: 0,
  lastAskedAt: null,
  askedAtPct: null,
  deferredUntil: null,
  deferReason: null,
  deferredAt: null,
  nowAskCount: 0,
  nowAskedAt: null,
};

/**
 * Keyed by Paseo agent id where there is one, because that survives compaction
 * whatever Claude Code decides to do with the session id.
 */
export function ledgerPath(sessionId) {
  const agentId = process.env.PASEO_AGENT_ID;
  const key = agentId !== undefined && agentId !== "" ? agentId : sessionId;
  if (typeof key !== "string" || key === "") return null;
  return join(pluginDir(), "asks", `${key.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

export function readLedger(sessionId) {
  const path = ledgerPath(sessionId);
  if (path === null) return { ...EMPTY };
  try {
    return { ...EMPTY, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { ...EMPTY };
  }
}

export function writeLedger(sessionId, ledger) {
  const path = ledgerPath(sessionId);
  if (path === null) return;
  try {
    mkdirSync(join(pluginDir(), "asks"), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(ledger), "utf8");
    renameSync(temp, path);
  } catch {
    // A hook that cannot persist its latch must still not break the turn.
  }
}

/**
 * Forgets everything, because the window just emptied.
 *
 * A compaction is a new epoch: the occupancy the last ask was about is gone, and a
 * session that fills up again deserves to be asked again.
 */
export function resetLedger(sessionId) {
  const path = ledgerPath(sessionId);
  if (path === null) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // A stale ledger costs one missed ask, never a failed turn.
  }
}

/** The agent's own answer: not now, and here is for how long. */
export function defer(sessionId, minutes, reason) {
  const ledger = readLedger(sessionId);
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  writeLedger(sessionId, { ...ledger, deferredUntil: until, deferReason: reason, deferredAt: new Date().toISOString() });
  return until;
}

/**
 * Whether to ask, given what has already been said and how much has changed.
 *
 * `pct` is the occupancy now; `askedAtPct` the occupancy the last ask was about.
 */
function deferred(ledger, now) {
  if (ledger.deferredUntil === null) return false;
  const until = Date.parse(ledger.deferredUntil);
  return Number.isFinite(until) && now < until;
}

export function shouldAsk(ledger, pct, now = Date.now()) {
  if (deferred(ledger, now)) return false;
  if (ledger.askCount >= MAX_ASKS) return false;
  if (ledger.askedAtPct === null) return true;
  return pct >= ledger.askedAtPct + RE_ASK_GROWTH_PCT;
}

/** Records that the question was actually put to the model. */
export function recordAsk(sessionId, ledger, pct) {
  writeLedger(sessionId, {
    ...ledger,
    askCount: ledger.askCount + 1,
    lastAskedAt: new Date().toISOString(),
    askedAtPct: pct,
    // An answered ask clears the deferral it was waiting out.
    deferredUntil: null,
    deferReason: null,
  });
}

/**
 * Whether to ask right away, mid-turn, at the upper line.
 *
 * Once per compaction epoch. It comes back only if the agent answered the last one
 * with a deferral and that deferral has run out — ignoring it earns no repeat, so a
 * long turn hears it once rather than after every tool call — and never more than
 * `MAX_ASKS` times in all. Any live deferral, from either ask, holds it off: the
 * agent's "not now" is one answer, not one per line.
 */
export function shouldAskNow(ledger, now = Date.now()) {
  if (deferred(ledger, now)) return false;
  if (ledger.nowAskCount === 0 || ledger.nowAskedAt === null) return true;
  if (ledger.nowAskCount >= MAX_ASKS) return false;
  const asked = Date.parse(ledger.nowAskedAt);
  const answered = ledger.deferredAt === null ? Number.NaN : Date.parse(ledger.deferredAt);
  return Number.isFinite(asked) && Number.isFinite(answered) && answered >= asked;
}

/** Records that the upper line's question was put to the model. */
export function recordNowAsk(sessionId, ledger) {
  writeLedger(sessionId, {
    ...ledger,
    nowAskCount: ledger.nowAskCount + 1,
    nowAskedAt: new Date().toISOString(),
    deferredUntil: null,
    deferReason: null,
  });
}
