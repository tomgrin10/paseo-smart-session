/**
 * How well the accounts are used: metrics, a replay of the logged demand against more or
 * fewer accounts, and the suggestions that follow from it.
 *
 * Pure and deterministic: the server (`server/accounts-report.ts`) reads the logs and hands
 * over plain series; nothing here reads a clock, a file or a setting. `accounts-report.test.ts`
 * holds the rules with small fictional histories.
 *
 * Units. Demand is counted in "points": one point is 1% of one standard account's weekly
 * window. An account of size 2 (a plan twice as large) moves 1% for every 2 points.
 *
 * Demand at a time step is what the sessions asked for:
 * - `used`: each account's weekly increase (× its size), the work that ran;
 * - `held`: Session Guard hold time × the burn rate before the hold, work that waited;
 * - `extra`: time an account spent paying Extra usage × its burn rate before the limit.
 * The replay places that demand on N-1, N or N+1 accounts with a placement policy (a plain
 * function, so the next PR can score a new one against `paceWithGate`). Demand with nowhere to
 * go is waiting (session-hours) when it was work, or Extra usage ($) when it was paid for.
 *
 * The replay is fluid: a step's demand may split across accounts, and moving work costs
 * nothing. Real placement keeps a session on its account, so the replay is a lower bound on
 * waiting for every account count alike; the comparisons between counts stay fair.
 */

import { ZEROSUB_FIVE_HOUR_GATE } from "./subscriptions.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const FIVE_HOURS = 5 * HOUR;

/** The replay's time step. */
export const STEP_MS = 15 * MINUTE;
/** How long a reading stands for an account before its state is unknown. */
export const CARRY_MS = 6 * HOUR;
/** A window at or past this is at its limit (readings are whole percents; 100 means full). */
export const LIMIT_PCT = 99.5;
/** Two readings whose resets differ by less are the same window (as `shared/blocks.ts`). */
const SAME_WINDOW_MS = 120_000;
/** A session-hour's weekly points when nothing measured it. */
export const DEFAULT_SESSION_RATE = 1;
/** 5-hour points per weekly point when an account's history can't tell. */
export const DEFAULT_SESSION_RATIO = 10;
/** Full weekly windows an account needs before the report judges it. */
export const VERDICT_WINDOWS = 2;

/** Thresholds and plan sizes; every one a setting (`settings.accountsReport`). */
export interface ReportSettings {
  /** Relative plan size per account id; absent means 1. */
  readonly sizes: Readonly<Record<string, number>>;
  /** Suggest adding an account when one more saves at least this much waiting a week… */
  readonly addWaitHoursPerWeek: number;
  /** …or at least this much Extra usage a week. */
  readonly addDollarsPerWeek: number;
  /** Suggest dropping one when one fewer adds at most this much waiting a week… */
  readonly dropWaitHoursPerWeek: number;
  /** …and at most this much Extra usage a week. */
  readonly dropDollarsPerWeek: number;
  /** Suggest better placement when Misplaced is over this many hours a week. */
  readonly misplacedHoursPerWeek: number;
}

export const DEFAULT_REPORT_SETTINGS: ReportSettings = {
  sizes: {},
  addWaitHoursPerWeek: 2,
  addDollarsPerWeek: 10,
  dropWaitHoursPerWeek: 1,
  dropDollarsPerWeek: 5,
  misplacedHoursPerWeek: 1,
};

const finite = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** A saved or patched value, made whole: bad numbers fall back, sizes stay positive. */
export function normalizeReportSettings(raw: unknown): ReportSettings {
  const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const sizes: Record<string, number> = {};
  if (r.sizes !== null && typeof r.sizes === "object") {
    for (const [id, size] of Object.entries(r.sizes as Record<string, unknown>)) {
      if (typeof size === "number" && Number.isFinite(size) && size > 0 && size <= 100 && id.length <= 80) sizes[id] = size;
    }
  }
  const d = DEFAULT_REPORT_SETTINGS;
  return {
    sizes,
    addWaitHoursPerWeek: finite(r.addWaitHoursPerWeek, d.addWaitHoursPerWeek, 0, 168),
    addDollarsPerWeek: finite(r.addDollarsPerWeek, d.addDollarsPerWeek, 0, 100_000),
    dropWaitHoursPerWeek: finite(r.dropWaitHoursPerWeek, d.dropWaitHoursPerWeek, 0, 168),
    dropDollarsPerWeek: finite(r.dropDollarsPerWeek, d.dropDollarsPerWeek, 0, 100_000),
    misplacedHoursPerWeek: finite(r.misplacedHoursPerWeek, d.misplacedHoursPerWeek, 0, 168),
  };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface WindowReading {
  readonly pct: number;
  readonly resetsAt: string | null;
}

/** One account's readings, oldest first: its weekly and 5-hour windows. */
export interface SeriesReading {
  readonly t: number;
  readonly weekly: WindowReading | null;
  readonly session: WindowReading | null;
}

export interface AccountSeries {
  readonly id: string;
  readonly name: string;
  readonly main: boolean;
  /** Set aside in ZeroSub: shown, but never counted as room. */
  readonly disabled: boolean;
  readonly readings: readonly SeriesReading[];
  /** Extra usage spent this month, as read (cumulative, minor units; drops at a month's start). */
  readonly spend: readonly { readonly t: number; readonly minor: number }[];
}

export interface HoldSpan {
  readonly pauseId: string;
  readonly accountId: string | null;
  readonly from: number;
  /** Null while it still holds. */
  readonly to: number | null;
}

/** A minute of the placement log: running sessions per account. */
export interface PlacementSample {
  readonly t: number;
  readonly running: Readonly<Record<string, number>>;
}

export interface MoveEvent {
  readonly t: number;
  readonly from: string | null;
  readonly to: string;
  readonly reason: string;
}

export interface ReportInput {
  readonly family: "claude" | "codex";
  readonly accounts: readonly AccountSeries[];
  readonly holds: readonly HoldSpan[];
  readonly placement: readonly PlacementSample[];
  readonly moves: readonly MoveEvent[];
  /** When each account-use log began; null when it has no rows yet. */
  readonly since: { readonly holds: number | null; readonly placement: number | null; readonly moves: number | null };
  readonly now: number;
  readonly days?: number;
}

// ---------------------------------------------------------------------------
// Reconstruction: each account's state and demand per step
// ---------------------------------------------------------------------------

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

const laterWindow = (current: number | null, next: number | null) =>
  next !== null && (current === null || next - current > SAME_WINDOW_MS);

/** A weekly window as observed: when it reset, how much of it was used, how much of it was seen. */
export interface ObservedWindow {
  readonly resetsAt: number;
  readonly peakPct: number;
  readonly firstSeen: number;
  /** The first reading in it was near 0%, so it was seen from its start. */
  readonly fromStart: boolean;
}

interface Timeline {
  readonly id: string;
  readonly size: number;
  /** Per step: known state at the step's end. */
  readonly known: boolean[];
  readonly weeklyPct: number[];
  readonly weeklyResetAt: (number | null)[];
  readonly sessionPct: number[];
  readonly sessionResetAt: (number | null)[];
  readonly atLimit: boolean[];
  /** Weekly points used in the step (× size). */
  readonly used: number[];
  /** 5-hour percent used in the step (own scale). */
  readonly sessionUsed: number[];
  /** Extra usage spent in the step, minor units. */
  readonly spent: number[];
  /** Weekly windows seen, closed ones and the open one. */
  readonly windows: ObservedWindow[];
  readonly firstReading: number | null;
  readonly readingsInPeriod: number;
}

function timelineOf(series: AccountSeries, size: number, t0: number, steps: number): Timeline {
  const known = new Array<boolean>(steps).fill(false);
  const weeklyPct = new Array<number>(steps).fill(0);
  const weeklyResetAt = new Array<number | null>(steps).fill(null);
  const sessionPct = new Array<number>(steps).fill(0);
  const sessionResetAt = new Array<number | null>(steps).fill(null);
  const used = new Array<number>(steps).fill(0);
  const sessionUsed = new Array<number>(steps).fill(0);
  const spent = new Array<number>(steps).fill(0);
  const windows: ObservedWindow[] = [];
  const stepOf = (t: number) => Math.floor((t - t0) / STEP_MS);

  const readings = [...series.readings].sort((a, b) => a.t - b.t);
  let wReset: number | null = null;
  let wMax = 0;
  let wFirst = 0;
  let wFromStart = false;
  let sReset: number | null = null;
  let sMax = 0;
  let seen = false;
  let inPeriod = 0;
  const close = () => {
    if (wReset !== null) windows.push({ resetsAt: wReset, peakPct: wMax, firstSeen: wFirst, fromStart: wFromStart });
  };
  for (const r of readings) {
    const i = stepOf(r.t);
    if (i >= 0 && i < steps) inPeriod += 1;
    if (r.weekly !== null) {
      const reset = ms(r.weekly.resetsAt);
      let inc = 0;
      if (!seen) {
        wReset = reset; wMax = r.weekly.pct; wFirst = r.t; wFromStart = r.weekly.pct <= 1;
      } else if (laterWindow(wReset, reset)) {
        close();
        inc = r.weekly.pct;
        wReset = reset; wMax = r.weekly.pct; wFirst = r.t; wFromStart = true;
      } else {
        inc = Math.max(0, r.weekly.pct - wMax);
        wMax = Math.max(wMax, r.weekly.pct);
        if (reset !== null) wReset = reset;
      }
      seen = true;
      if (i >= 0 && i < steps) used[i] += inc * size;
    }
    if (r.session !== null) {
      const reset = ms(r.session.resetsAt);
      let inc = 0;
      if (sReset !== null && laterWindow(sReset, reset)) { inc = r.session.pct; sMax = r.session.pct; }
      else if (sReset === null && reset !== null) { inc = Math.max(0, r.session.pct - sMax); sMax = r.session.pct; }
      else { inc = Math.max(0, r.session.pct - sMax); sMax = Math.max(sMax, r.session.pct); }
      if (reset !== null) sReset = reset;
      else if (r.session.pct === 0) { sReset = null; sMax = 0; }
      if (i >= 0 && i < steps) sessionUsed[i] += inc;
    }
  }
  if (seen) close();

  // State at each step's end: the last reading at or before it, while it still stands.
  let k = -1;
  for (let i = 0; i < steps; i++) {
    const end = t0 + (i + 1) * STEP_MS;
    while (k + 1 < readings.length && readings[k + 1]!.t <= end) k += 1;
    const r = k >= 0 ? readings[k]! : null;
    if (r === null || end - r.t > CARRY_MS) continue;
    known[i] = true;
    const w = r.weekly;
    const wr = ms(w?.resetsAt);
    weeklyResetAt[i] = wr !== null && wr > end ? wr : null;
    weeklyPct[i] = w === null || (wr !== null && wr <= end) ? 0 : w.pct;
    const s = r.session;
    const sr = ms(s?.resetsAt);
    sessionResetAt[i] = sr !== null && sr > end ? sr : null;
    sessionPct[i] = s === null || (sr !== null && sr <= end) ? 0 : s.pct;
  }
  const atLimit = known.map((ok, i) => ok && (weeklyPct[i]! >= LIMIT_PCT || sessionPct[i]! >= LIMIT_PCT));

  const spend = [...series.spend].sort((a, b) => a.t - b.t);
  for (let j = 1; j < spend.length; j++) {
    const a = spend[j - 1]!;
    const b = spend[j]!;
    // A new month starts from 0; any other drop is a correction, not spending.
    const newMonth = new Date(a.t).getUTCMonth() !== new Date(b.t).getUTCMonth();
    const inc = b.minor >= a.minor ? b.minor - a.minor : newMonth ? b.minor : 0;
    const i = stepOf(b.t);
    if (inc > 0 && i >= 0 && i < steps) spent[i] += inc;
  }

  return {
    id: series.id, size, known, weeklyPct, weeklyResetAt, sessionPct, sessionResetAt, atLimit,
    used, sessionUsed, spent, windows, firstReading: readings[0]?.t ?? null, readingsInPeriod: inPeriod,
  };
}

/** Weekly points per hour over the `lookback` steps that end at step `i` (inclusive). */
function rateAt(tl: Timeline, i: number, lookback: number): number {
  let sum = 0;
  let n = 0;
  for (let j = Math.max(0, i - lookback + 1); j <= i; j++) { sum += tl.used[j]!; n += 1; }
  return n === 0 ? 0 : sum / ((n * STEP_MS) / HOUR);
}

/** The burn rate before the account last reached a limit at or before step `i`. */
function rateBeforeLimit(tl: Timeline, i: number): number {
  let j = i;
  const floor = Math.max(0, i - Math.round(DAY / STEP_MS));
  while (j > floor && tl.atLimit[j]) j -= 1;
  return rateAt(tl, j, Math.round((2 * HOUR) / STEP_MS));
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/** One account's state inside the replay; a policy reads it and never changes it. */
export interface ReplayAccount {
  readonly id: string;
  readonly size: number;
  /** 5-hour percent per weekly point on this account. */
  readonly ratio: number;
  weeklyPct: number;
  weeklyResetAt: number | null;
  sessionPct: number;
  sessionResetAt: number | null;
  /** False for an account set aside. */
  readonly usable: boolean;
}

/**
 * A placement policy: the accounts to fill, best first. Accounts it leaves out get nothing;
 * full ones are skipped by the replay. Pure: same state, same answer.
 */
export type PlacementPolicy = (accounts: readonly ReplayAccount[], now: number) => number[];

export const hasRoom = (a: ReplayAccount) => a.usable && a.weeklyPct < LIMIT_PCT && a.sessionPct < LIMIT_PCT;

/**
 * Today's behaviour, approximated: ZeroSub's pace score (weekly room left ÷ hours to its reset;
 * a window not open yet counts as a whole week), and an account past the 5-hour gate only after
 * every account under it.
 */
export const paceWithGate: PlacementPolicy = (accounts, now) => {
  const score = (a: ReplayAccount) => (100 - a.weeklyPct) / Math.max(0.25, ((a.weeklyResetAt ?? now + WEEK) - now) / HOUR);
  const gated = (a: ReplayAccount) => (a.sessionPct >= ZEROSUB_FIVE_HOUR_GATE ? 1 : 0);
  return accounts
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => hasRoom(a))
    .sort((x, y) => gated(x.a) - gated(y.a) || score(y.a) - score(x.a) || x.i - y.i)
    .map(({ i }) => i);
};

export const POLICIES: Readonly<Record<string, PlacementPolicy>> = { "pace-5h-gate": paceWithGate };

export interface DemandStep {
  readonly t: number;
  readonly used: number;
  readonly held: number;
  readonly extra: number;
}

export interface ReplaySpec {
  readonly id: string;
  readonly size: number;
  readonly ratio: number;
  readonly usable: boolean;
  /** Known weekly resets after the start, oldest first; past the last one, a window opens on first use. */
  readonly resets: readonly number[];
  readonly start: { weeklyPct: number; weeklyResetAt: number | null; sessionPct: number; sessionResetAt: number | null };
}

export interface ReplayResult {
  readonly accounts: number;
  /** Points with nowhere to go, by what they were. */
  readonly short: { readonly used: number; readonly held: number; readonly extra: number };
  /** Session-hours that would wait: work points ÷ a session-hour's points. */
  readonly waitingHours: number;
  /** Points that would be paid as Extra usage. */
  readonly extraPoints: number;
  /** Their cost at the logged price; null when no Extra usage was ever logged. */
  readonly extraDollars: number | null;
  /** Hours with no account to take work. */
  readonly allOutHours: number;
  /** Weekly points that expired unused, per account id. */
  readonly expired: Readonly<Record<string, number>>;
}

const EPS = 1e-9;

export function replay(
  demand: readonly DemandStep[],
  specs: readonly ReplaySpec[],
  policy: PlacementPolicy,
  rates: { sessionRate: number; dollarsPerPoint: number | null },
): ReplayResult {
  const accounts: ReplayAccount[] = specs.map((s) => ({ id: s.id, size: s.size, ratio: s.ratio, usable: s.usable, ...s.start }));
  const nextReset = specs.map(() => 0);
  const expired: Record<string, number> = Object.fromEntries(specs.map((s) => [s.id, 0]));
  const short = { used: 0, held: 0, extra: 0 };
  let allOut = 0;
  for (const step of demand) {
    const t = step.t;
    accounts.forEach((a, i) => {
      if (a.weeklyResetAt !== null && t >= a.weeklyResetAt) {
        expired[a.id]! += Math.max(0, 100 - a.weeklyPct) * a.size;
        a.weeklyPct = 0;
        const resets = specs[i]!.resets;
        while (nextReset[i]! < resets.length && resets[nextReset[i]!]! <= t) nextReset[i]! += 1;
        a.weeklyResetAt = resets[nextReset[i]!] ?? null;
      }
      if (a.sessionResetAt !== null && t >= a.sessionResetAt) { a.sessionPct = 0; a.sessionResetAt = null; }
    });
    if (!accounts.some(hasRoom)) allOut += STEP_MS / HOUR;
    const order = policy(accounts, t);
    for (const origin of ["used", "held", "extra"] as const) {
      let left = step[origin];
      for (const i of order) {
        if (left <= EPS) break;
        const a = accounts[i]!;
        if (!hasRoom(a)) continue;
        const cap = Math.min((100 - a.weeklyPct) * a.size, ((100 - a.sessionPct) * a.size) / a.ratio);
        const take = Math.min(left, Math.max(0, cap));
        if (take <= EPS) continue;
        a.weeklyPct += take / a.size;
        a.sessionPct += (take * a.ratio) / a.size;
        a.weeklyResetAt ??= t + WEEK;
        a.sessionResetAt ??= t + FIVE_HOURS;
        left -= take;
      }
      if (left > EPS) short[origin] += left;
    }
  }
  const waitingHours = (short.used + short.held) / rates.sessionRate;
  return {
    accounts: specs.length,
    short,
    waitingHours,
    extraPoints: short.extra,
    extraDollars: rates.dollarsPerPoint === null ? (short.extra > EPS ? null : 0) : short.extra * rates.dollarsPerPoint,
    allOutHours: allOut,
    expired,
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface StripDay {
  /** The day's start, UTC. */
  readonly day: string;
  /** Weekly percent used that day (the account's own scale). */
  readonly usedPct: number;
  /** Hours the account was at a limit. */
  readonly limitHours: number;
  /** Weekly percent that expired at a reset that day. */
  readonly expiredPct: number;
  /** Hours with a reading standing. */
  readonly knownHours: number;
}

export interface MisplacedEpisode {
  readonly accountId: string;
  readonly from: string;
  readonly to: string;
  readonly hours: number;
  readonly dollars: number;
  /** An account that had room meanwhile. */
  readonly roomOn: string;
  readonly cause: "manual-pin" | "stale-reading" | "pacing-off" | "late-switch" | "not-logged";
}

export interface AccountMetrics {
  readonly id: string;
  readonly name: string;
  readonly main: boolean;
  readonly disabled: boolean;
  readonly size: number;
  /** Mean share of each weekly window used by its reset, over windows that reset in the period; null with none. */
  readonly usedPct: number | null;
  readonly closedWindows: readonly { readonly resetsAt: string; readonly pct: number }[];
  /** The open window now. */
  readonly openPct: number | null;
  readonly openResetsAt: string | null;
  /** Session-hours held on this account (since holds were logged). */
  readonly waitingHours: number;
  readonly misplacedHours: number;
  readonly misplacedDollars: number;
  /** Hours at a limit while another account had room (with or without work waiting). */
  readonly limitWhileRoomHours: number;
  readonly atLimitHours: number;
  /** Extra usage spent in the period. */
  readonly extraDollars: number;
  /** Weekly points that expired while work waited or paid elsewhere. */
  readonly idlePoints: number;
  readonly strip: readonly StripDay[];
  /** Full weekly windows observed. */
  readonly fullWindows: number;
  /** When it has enough full windows to judge; null once it has. */
  readonly verdictAt: string | null;
  readonly readings: number;
}

export interface Suggestion {
  readonly kind: "add" | "drop" | "use-better" | "keep" | "verdict";
  readonly title: string;
  readonly reason: string;
  readonly accountId: string | null;
  /** Every number the suggestion stands on. */
  readonly numbers: Readonly<Record<string, number | string | null>>;
  readonly window: { readonly from: string; readonly to: string; readonly days: number };
}

export interface AccountsReport {
  readonly family: "claude" | "codex";
  readonly generatedAt: string;
  readonly window: { readonly from: string; readonly to: string; readonly days: number };
  readonly readings: number;
  /** When waiting started to be measured (the holds log); null when it hasn't. */
  readonly waitingSince: string | null;
  readonly accounts: readonly AccountMetrics[];
  readonly pooled: {
    readonly usedPct: number | null;
    readonly waitingHours: number;
    readonly misplacedHours: number;
    readonly misplacedDollars: number;
    readonly allOutHours: number;
    readonly idlePoints: number;
    readonly extraDollars: number;
  };
  readonly rates: { readonly sessionRate: number; readonly dollarsPerPoint: number | null };
  /** Today's policy against the logged demand with one account fewer (each one dropped), the same, and one more. */
  readonly replay: {
    readonly policy: string;
    readonly fewer: readonly (ReplayResult & { readonly without: string })[];
    readonly same: ReplayResult;
    readonly more: ReplayResult;
  };
  readonly suggestions: readonly Suggestion[];
  /** The one to show: add, use-better, drop or keep, in that order. */
  readonly recommendation: Suggestion | null;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const iso = (t: number) => new Date(t).toISOString();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Dec 3", UTC, the same on every machine. */
export const shortDay = (t: number) => `${MONTHS[new Date(t).getUTCMonth()]} ${new Date(t).getUTCDate()}`;
const hours = (h: number) => (h < 0.05 ? "0 h" : h < 10 ? `${round1(h)} h` : `${Math.round(h)} h`);
const dollars = (d: number) => `$${d < 100 ? d.toFixed(d < 10 ? 2 : 0) : Math.round(d)}`;

/** The step demand of the period, and the rates it is converted at. */
function demandOf(tls: readonly Timeline[], input: ReportInput, t0: number, steps: number, running: (id: string, i: number) => number | null) {
  // A session-hour's points: measured where the placement log says how many sessions ran.
  let pts = 0;
  let sessionHours = 0;
  for (const tl of tls) {
    for (let i = 0; i < steps; i++) {
      const r = running(tl.id, i);
      if (r === null || r <= 0 || tl.atLimit[i] || !tl.known[i]) continue;
      pts += tl.used[i]!;
      sessionHours += (r * STEP_MS) / HOUR;
    }
  }
  const sessionRate = pts > 0.5 && sessionHours > 0.5 ? pts / sessionHours : DEFAULT_SESSION_RATE;

  const used = new Array<number>(steps).fill(0);
  const held = new Array<number>(steps).fill(0);
  const extra = new Array<number>(steps).fill(0);
  const heldOn = new Map<string, number[]>();
  const extraOn = new Map<string, number[]>();
  let extraPts = 0;
  let extraMinor = 0;
  for (const tl of tls) {
    const mine = new Array<number>(steps).fill(0);
    for (let i = 0; i < steps; i++) {
      used[i] += tl.used[i]!;
      if (tl.spent[i]! > 0) {
        const p = (rateBeforeLimit(tl, i) || sessionRate) * (STEP_MS / HOUR);
        extra[i] += p;
        mine[i] = p;
        extraPts += p;
        extraMinor += tl.spent[i]!;
      }
    }
    extraOn.set(tl.id, mine);
  }
  const byId = new Map(tls.map((tl) => [tl.id, tl]));
  const now = input.now;
  for (const hold of input.holds) {
    const from = Math.max(hold.from, t0);
    const to = Math.min(hold.to ?? now, now);
    if (to <= from) continue;
    const tl = hold.accountId === null ? undefined : byId.get(hold.accountId);
    const at = Math.floor((hold.from - t0) / STEP_MS);
    let rate = sessionRate;
    if (tl !== undefined && at >= 0 && at < steps) {
      const before = rateAt(tl, Math.max(0, at - 1), Math.round(HOUR / STEP_MS));
      const r = running(tl.id, Math.max(0, at - 1));
      if (before > 0) rate = before / Math.max(1, r ?? 1);
    }
    const mine = hold.accountId === null ? null : (heldOn.get(hold.accountId) ?? heldOn.set(hold.accountId, new Array<number>(steps).fill(0)).get(hold.accountId)!);
    for (let i = Math.max(0, Math.floor((from - t0) / STEP_MS)); i < steps; i++) {
      const s = t0 + i * STEP_MS;
      const overlap = Math.min(to, s + STEP_MS) - Math.max(from, s);
      if (overlap <= 0) { if (s >= to) break; continue; }
      held[i] += (overlap / HOUR) * rate;
      if (mine !== null) mine[i] += overlap / HOUR;
    }
  }
  const demand: DemandStep[] = used.map((u, i) => ({ t: t0 + i * STEP_MS, used: u, held: held[i]!, extra: extra[i]! }));
  return { demand, sessionRate, dollarsPerPoint: extraPts > 0 && extraMinor > 0 ? extraMinor / 100 / extraPts : null, heldOn, extraOn };
}

function ratioOf(tl: Timeline): number | null {
  let w = 0;
  let s = 0;
  for (let i = 0; i < tl.used.length; i++) {
    if (tl.used[i]! > 0 && tl.known[i]) { w += tl.used[i]! / tl.size; s += tl.sessionUsed[i]!; }
  }
  return w >= 5 && s > 0 ? s / w : null;
}

function specOf(tl: Timeline, t0: number, ratio: number, usable: boolean, now: number): ReplaySpec {
  const first = tl.known.indexOf(true);
  const i = first === 0 ? 0 : -1;
  const resets = new Set<number>();
  for (const w of tl.windows) if (w.resetsAt > t0) resets.add(w.resetsAt);
  for (const r of tl.weeklyResetAt) if (r !== null && r > t0) resets.add(r);
  // A known reset is followed by one a week later, through the period.
  const sorted = [...resets].sort((a, b) => a - b).filter((r, k, all) => k === 0 || r - all[k - 1]! > SAME_WINDOW_MS);
  const last = sorted[sorted.length - 1];
  if (last !== undefined) for (let r = last + WEEK; r <= now + WEEK; r += WEEK) sorted.push(r);
  return {
    id: tl.id,
    size: tl.size,
    ratio,
    usable,
    resets: sorted,
    start: i === 0
      ? { weeklyPct: tl.weeklyPct[0]!, weeklyResetAt: tl.weeklyResetAt[0]!, sessionPct: tl.sessionPct[0]!, sessionResetAt: tl.sessionResetAt[0]! }
      : { weeklyPct: 0, weeklyResetAt: sorted[0] ?? null, sessionPct: 0, sessionResetAt: null },
  };
}

/** When an account will have `VERDICT_WINDOWS` full weekly windows; null when it has them. */
function verdictOf(tl: Timeline, now: number): { full: number; at: number | null } {
  const closed = tl.windows.filter((w) => w.resetsAt <= now);
  const full = closed.filter((w) => w.fromStart || w.firstSeen <= w.resetsAt - WEEK + HOUR).length;
  if (full >= VERDICT_WINDOWS) return { full, at: null };
  const first = tl.windows[0];
  if (first === undefined) return { full, at: null };
  // The first window seen from its start counts; else the next one starts at its reset.
  const startsFull = first.fromStart || first.firstSeen <= first.resetsAt - WEEK + HOUR;
  const start = startsFull ? Math.min(first.firstSeen, first.resetsAt - WEEK) : first.resetsAt;
  return { full, at: start + VERDICT_WINDOWS * WEEK };
}

/** The report for one family. */
export function accountsReport(input: ReportInput, settings: ReportSettings = DEFAULT_REPORT_SETTINGS, policyName = "pace-5h-gate"): AccountsReport {
  const days = input.days ?? 14;
  const now = input.now;
  const steps = Math.max(1, Math.floor((days * DAY) / STEP_MS));
  const t0 = now - steps * STEP_MS;
  const stepH = STEP_MS / HOUR;
  const policy = POLICIES[policyName] ?? paceWithGate;
  const window = { from: iso(t0), to: iso(now), days };
  const sizeOf = (id: string) => settings.sizes[id] ?? 1;

  const tls = input.accounts.map((a) => timelineOf(a, sizeOf(a.id), t0, steps));
  const byIndex = (id: string) => input.accounts.findIndex((a) => a.id === id);

  // Running sessions per account per step, where the placement log covers it.
  const placement = [...input.placement].sort((a, b) => a.t - b.t);
  const runningGrid = new Map<string, (number | null)[]>();
  {
    const sums = new Map<string, number[]>();
    const counts = new Array<number>(steps).fill(0);
    for (const p of placement) {
      const i = Math.floor((p.t - t0) / STEP_MS);
      if (i < 0 || i >= steps) continue;
      counts[i] += 1;
      for (const [id, r] of Object.entries(p.running)) {
        const s = sums.get(id) ?? sums.set(id, new Array<number>(steps).fill(0)).get(id)!;
        s[i] += r;
      }
    }
    for (const a of input.accounts) {
      const s = sums.get(a.id);
      runningGrid.set(a.id, counts.map((c, i) => (c === 0 ? null : (s?.[i] ?? 0) / c)));
    }
  }
  const running = (id: string, i: number) => runningGrid.get(id)?.[i] ?? null;

  const { demand, sessionRate, dollarsPerPoint, heldOn, extraOn } = demandOf(tls, input, t0, steps, running);

  // Per-account metrics from what happened.
  const room = (i: number, except: number) => tls.some((tl, k) => k !== except && !input.accounts[k]!.disabled && tl.known[i] && !tl.atLimit[i]);
  const episodes: MisplacedEpisode[] = [];
  const movesSorted = [...input.moves].sort((a, b) => a.t - b.t);
  const causeOf = (k: number, i: number): MisplacedEpisode["cause"] => {
    const at = t0 + i * STEP_MS;
    if (input.since.moves === null || at < input.since.moves) return "not-logged";
    const id = input.accounts[k]!.id;
    if (movesSorted.some((m) => m.to === id && m.reason === "user" && m.t <= at && m.t >= at - WEEK)) return "manual-pin";
    const other = tls.find((tl, j) => j !== k && tl.known[i] && !tl.atLimit[i]);
    if (other !== undefined) {
      const series = input.accounts[byIndex(other.id)]!;
      const last = [...series.readings].reverse().find((r) => r.t <= at);
      if (last !== undefined && at - last.t > 30 * MINUTE) return "stale-reading";
    }
    if (!movesSorted.some((m) => m.reason === "pace" && m.t <= at)) return "pacing-off";
    return "late-switch";
  };

  const metrics: AccountMetrics[] = tls.map((tl, k) => {
    const series = input.accounts[k]!;
    const held = heldOn.get(tl.id);
    let misplacedHours = 0;
    let misplacedDollars = 0;
    let limitWhileRoom = 0;
    let atLimitHours = 0;
    let extraMinor = 0;
    let open: { from: number; hours: number; dollars: number; roomOn: string; cause: MisplacedEpisode["cause"] } | null = null;
    const flush = (end: number) => {
      if (open !== null) episodes.push({ accountId: tl.id, from: iso(open.from), to: iso(end), hours: open.hours, dollars: open.dollars, roomOn: open.roomOn, cause: open.cause });
      open = null;
    };
    for (let i = 0; i < steps; i++) {
      extraMinor += tl.spent[i]!;
      if (!tl.atLimit[i]) { flush(t0 + i * STEP_MS); continue; }
      atLimitHours += stepH;
      if (!room(i, k)) { flush(t0 + i * STEP_MS); continue; }
      limitWhileRoom += stepH;
      const r = running(tl.id, i);
      const sessions = Math.max(r ?? 0, held?.[i] !== undefined && held[i]! > 0 ? held[i]! / stepH : 0, tl.spent[i]! > 0 ? 1 : 0);
      if (sessions <= 0) { flush(t0 + i * STEP_MS); continue; }
      const h = sessions * stepH;
      misplacedHours += h;
      misplacedDollars += tl.spent[i]! / 100;
      if (open === null) {
        const roomOn = tls.find((other, j) => j !== k && !input.accounts[j]!.disabled && other.known[i] && !other.atLimit[i])!.id;
        open = { from: t0 + i * STEP_MS, hours: 0, dollars: 0, roomOn, cause: causeOf(k, i) };
      }
      open.hours += h;
      open.dollars += tl.spent[i]! / 100;
    }
    flush(now);

    const closed = tl.windows.filter((w) => w.resetsAt > t0 && w.resetsAt <= now);
    const openWindow = tl.windows.find((w) => w.resetsAt > now) ?? null;
    // Idle: what expired at each reset while work waited or paid on another account in that window.
    let idlePoints = 0;
    for (const w of closed) {
      const expiredPts = Math.max(0, 100 - w.peakPct) * tl.size;
      let pressure = 0;
      for (let i = 0; i < steps; i++) {
        const t = t0 + i * STEP_MS;
        if (t < w.resetsAt - WEEK || t >= w.resetsAt) continue;
        for (const [id, h] of heldOn) if (id !== tl.id) pressure += (h[i] ?? 0) * sessionRate;
        for (const [id, e] of extraOn) if (id !== tl.id) pressure += e[i] ?? 0;
      }
      idlePoints += Math.min(expiredPts, pressure);
    }

    const strip: StripDay[] = [];
    const firstDay = Math.floor(t0 / DAY) * DAY;
    for (let d = firstDay; d < now; d += DAY) {
      let usedPct = 0, limitHours = 0, knownHours = 0;
      for (let i = Math.max(0, Math.floor((d - t0) / STEP_MS)); i < steps; i++) {
        const t = t0 + i * STEP_MS;
        if (t >= d + DAY) break;
        if (t < d) continue;
        usedPct += tl.used[i]! / tl.size;
        if (tl.atLimit[i]) limitHours += stepH;
        if (tl.known[i]) knownHours += stepH;
      }
      const expiredPct = closed.filter((w) => w.resetsAt >= d && w.resetsAt < d + DAY).reduce((s, w) => s + Math.max(0, 100 - w.peakPct), 0);
      strip.push({ day: iso(d), usedPct: round1(usedPct), limitHours: round1(limitHours), expiredPct: round1(expiredPct), knownHours: round1(knownHours) });
    }

    const verdict = verdictOf(tl, now);
    const waitingHours = held === undefined ? 0 : held.reduce((s, h) => s + h, 0);
    return {
      id: tl.id,
      name: series.name,
      main: series.main,
      disabled: series.disabled,
      size: tl.size,
      usedPct: closed.length === 0 ? null : round1(closed.reduce((s, w) => s + w.peakPct, 0) / closed.length),
      closedWindows: closed.map((w) => ({ resetsAt: iso(w.resetsAt), pct: w.peakPct })),
      openPct: openWindow?.peakPct ?? null,
      openResetsAt: openWindow === null ? null : iso(openWindow.resetsAt),
      waitingHours: round1(waitingHours),
      misplacedHours: round1(misplacedHours),
      misplacedDollars: Math.round(misplacedDollars * 100) / 100,
      limitWhileRoomHours: round1(limitWhileRoom),
      atLimitHours: round1(atLimitHours),
      extraDollars: Math.round(extraMinor) / 100,
      idlePoints: round1(idlePoints),
      strip,
      fullWindows: verdict.full,
      verdictAt: verdict.at === null ? null : iso(verdict.at),
      readings: tl.readingsInPeriod,
    };
  });

  // Hours when every usable account was at a limit. An account added later isn't room before its
  // first reading; one that existed but has no standing reading makes the hour unknown, not "out".
  let allOutHours = 0;
  for (let i = 0; i < steps; i++) {
    const end = t0 + (i + 1) * STEP_MS;
    const live = tls.filter((tl, k) => !input.accounts[k]!.disabled && tl.firstReading !== null && tl.firstReading <= end);
    if (live.length > 0 && live.every((tl) => tl.known[i]) && live.every((tl) => tl.atLimit[i])) allOutHours += stepH;
  }
  // Unheld waiting that no account recorded: holds without an account.
  const unattributed = input.holds.filter((h) => h.accountId === null || byIndex(h.accountId) < 0)
    .reduce((s, h) => s + Math.max(0, Math.min(h.to ?? now, now) - Math.max(h.from, t0)) / HOUR, 0);

  // Replays.
  const ratios = tls.map(ratioOf);
  const knownRatios = ratios.filter((r): r is number => r !== null);
  const pooledRatio = knownRatios.length > 0 ? knownRatios.reduce((s, r) => s + r, 0) / knownRatios.length : DEFAULT_SESSION_RATIO;
  const specs = tls.map((tl, k) => specOf(tl, t0, ratios[k] ?? pooledRatio, !input.accounts[k]!.disabled, now));
  const rates = { sessionRate, dollarsPerPoint };
  const same = replay(demand, specs, policy, rates);
  const sizes = specs.map((s) => s.size).sort((a, b) => a - b);
  const extraSpec: ReplaySpec = {
    id: "added", size: sizes[Math.floor((sizes.length - 1) / 2)] ?? 1, ratio: pooledRatio, usable: true, resets: [],
    start: { weeklyPct: 0, weeklyResetAt: null, sessionPct: 0, sessionResetAt: null },
  };
  const more = replay(demand, [...specs, extraSpec], policy, rates);
  const fewer = specs.length < 2 ? [] : specs.map((s) => ({ ...replay(demand, specs.filter((o) => o !== s), policy, rates), without: s.id }));

  const periodDays = (() => {
    const firsts = tls.map((tl) => tl.firstReading).filter((t): t is number => t !== null);
    if (firsts.length === 0) return days;
    return Math.max(1, Math.min(days, (now - Math.max(t0, Math.min(...firsts))) / DAY));
  })();
  const perWeek = (x: number) => (x * 7) / periodDays;

  const suggestions: Suggestion[] = [];
  const n = input.accounts.filter((a) => !a.disabled).length;
  const nameOf = (id: string) => input.accounts.find((a) => a.id === id)?.name ?? id;
  const dollarsOrNull = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
  const span = `${Math.round(periodDays)} days`;

  const savedWait = Math.max(0, same.waitingHours - more.waitingHours);
  const savedDollars = same.extraDollars === null || more.extraDollars === null ? null : Math.max(0, same.extraDollars - more.extraDollars);
  const addBy = perWeek(savedWait) >= settings.addWaitHoursPerWeek || (savedDollars !== null && perWeek(savedDollars) >= settings.addDollarsPerWeek);
  if (addBy) {
    suggestions.push({
      kind: "add",
      title: "Add an account",
      reason: `Replaying the last ${span}, one more account would have saved ${hours(savedWait)} of waiting${savedDollars !== null && savedDollars > 0.005 ? ` and ${dollars(savedDollars)} of Extra usage` : ""}.`,
      accountId: null,
      numbers: { accounts: n, savedWaitHours: round1(savedWait), savedWaitHoursPerWeek: round1(perWeek(savedWait)), savedDollars: dollarsOrNull(savedDollars), savedDollarsPerWeek: savedDollars === null ? null : dollarsOrNull(perWeek(savedDollars)), allOutHours: round1(same.allOutHours) },
      window,
    });
  }

  const misplacedTotal = metrics.reduce((s, m) => s + m.misplacedHours, 0);
  if (perWeek(misplacedTotal) > settings.misplacedHoursPerWeek && episodes.length > 0) {
    const worst = [...metrics].sort((a, b) => b.misplacedHours - a.misplacedHours)[0]!;
    const episode = episodes.filter((e) => e.accountId === worst.id).sort((a, b) => b.hours - a.hours)[0]!;
    const cause = {
      "manual-pin": "a manual pin kept sessions there",
      "stale-reading": `${nameOf(episode.roomOn)}'s reading was stale`,
      "pacing-off": "pacing was off",
      "late-switch": "sessions switched only at the limit",
      "not-logged": "before moves were logged, so the cause is unknown",
    }[episode.cause];
    suggestions.push({
      kind: "use-better",
      title: "Switch earlier",
      reason: `${hours(worst.misplacedHours)} on ${worst.name} at its limit while ${nameOf(episode.roomOn)} had room. The longest stretch began ${shortDay(Date.parse(episode.from))}; likely cause: ${cause}.`,
      accountId: worst.id,
      numbers: { misplacedHours: worst.misplacedHours, misplacedHoursPerWeek: round1(perWeek(worst.misplacedHours)), misplacedDollars: worst.misplacedDollars, roomOn: episode.roomOn, from: episode.from, to: episode.to, cause: episode.cause },
      window,
    });
  }

  const ready = metrics.filter((m) => m.verdictAt === null && !m.disabled);
  // On a tie, the account whose windows did the least work.
  const usedShare = (id: string) => { const m = metrics.find((x) => x.id === id)!; return (m.usedPct ?? 0) * m.size; };
  const cheapest = fewer
    .filter((f) => ready.some((m) => m.id === f.without))
    .map((f) => ({ f, wait: Math.max(0, f.waitingHours - same.waitingHours), cost: f.extraDollars === null || same.extraDollars === null ? null : Math.max(0, f.extraDollars - same.extraDollars) }))
    .sort((a, b) => a.wait - b.wait || (a.cost ?? Infinity) - (b.cost ?? Infinity) || usedShare(a.f.without) - usedShare(b.f.without) || a.f.without.localeCompare(b.f.without))[0];
  const dropBy = cheapest !== undefined && !addBy && n >= 2
    && perWeek(cheapest.wait) <= settings.dropWaitHoursPerWeek && (cheapest.cost === null ? true : perWeek(cheapest.cost) <= settings.dropDollarsPerWeek);
  if (dropBy && cheapest !== undefined) {
    const m = metrics.find((x) => x.id === cheapest.f.without)!;
    suggestions.push({
      kind: "drop",
      title: `Drop ${m.name}`,
      reason: `${m.name} used ${m.usedPct === null ? "little" : `${Math.round(m.usedPct)}%`} of its windows. Without it you'd have waited about ${hours(cheapest.wait)} more over ${span}${cheapest.cost !== null && cheapest.cost > 0.005 ? ` and paid ${dollars(cheapest.cost)} more` : ""}.`,
      accountId: m.id,
      numbers: { accounts: n, addedWaitHours: round1(cheapest.wait), addedWaitHoursPerWeek: round1(perWeek(cheapest.wait)), addedDollars: dollarsOrNull(cheapest.cost), usedPct: m.usedPct },
      window,
    });
  }

  for (const m of metrics) {
    if (m.verdictAt === null || m.disabled) continue;
    suggestions.push({
      kind: "verdict",
      title: `Verdict on ${m.name} on ${shortDay(Date.parse(m.verdictAt))}`,
      reason: `${m.name} has ${m.fullWindows} of the ${VERDICT_WINDOWS} full weekly windows a verdict needs.`,
      accountId: m.id,
      numbers: { fullWindows: m.fullWindows, verdictAt: m.verdictAt },
      window,
    });
  }

  if (!addBy && !dropBy) {
    const fewerWait = cheapest === undefined ? null : Math.max(0, cheapest.f.waitingHours - same.waitingHours);
    const parts = [
      fewerWait !== null ? `with ${n - 1} you'd have waited ${hours(fewerWait)} more` : null,
      `with ${n + 1} you'd have saved ${hours(savedWait)}`,
    ].filter(Boolean);
    suggestions.push({
      kind: "keep",
      title: `Keep ${n} ${n === 1 ? "account" : "accounts"}`,
      reason: `Replay over ${span}: ${parts.join(", and ")}.`,
      accountId: null,
      numbers: { accounts: n, fewerWaitHours: fewerWait === null ? null : round1(fewerWait), savedWaitHours: round1(savedWait), savedDollars: dollarsOrNull(savedDollars) },
      window,
    });
  }

  const order: Suggestion["kind"][] = ["add", "use-better", "drop", "keep"];
  const recommendation = order.map((k) => suggestions.find((s) => s.kind === k)).find((s) => s !== undefined) ?? null;

  const closedAll = metrics.flatMap((m) => m.closedWindows.map((w) => ({ pct: w.pct, size: m.size })));
  const holdsSince = input.since.holds;
  return {
    family: input.family,
    generatedAt: iso(now),
    window,
    readings: tls.reduce((s, tl) => s + tl.readingsInPeriod, 0),
    waitingSince: holdsSince === null ? null : iso(Math.max(holdsSince, t0)),
    accounts: metrics,
    pooled: {
      usedPct: closedAll.length === 0 ? null : round1(closedAll.reduce((s, w) => s + w.pct * w.size, 0) / closedAll.reduce((s, w) => s + w.size, 0)),
      waitingHours: round1(metrics.reduce((s, m) => s + m.waitingHours, 0) + unattributed),
      misplacedHours: round1(misplacedTotal),
      misplacedDollars: Math.round(metrics.reduce((s, m) => s + m.misplacedDollars, 0) * 100) / 100,
      allOutHours: round1(allOutHours),
      idlePoints: round1(metrics.reduce((s, m) => s + m.idlePoints, 0)),
      extraDollars: Math.round(metrics.reduce((s, m) => s + m.extraDollars, 0) * 100) / 100,
    },
    rates: { sessionRate: Math.round(sessionRate * 1000) / 1000, dollarsPerPoint: dollarsPerPoint === null ? null : Math.round(dollarsPerPoint * 1000) / 1000 },
    replay: { policy: policyName in POLICIES ? policyName : "pace-5h-gate", fewer, same, more },
    suggestions,
    recommendation,
  };
}

/** The report as lines, for `smart_accounts_report` and anything else that reads text. */
export function reportLines(report: AccountsReport): string[] {
  const lines: string[] = [];
  const w = report.window;
  lines.push(`${report.family === "claude" ? "Claude" : "Codex"} accounts, ${shortDay(Date.parse(w.from))} to ${shortDay(Date.parse(w.to))} (${w.days} days, ${report.readings} readings).`);
  for (const m of report.accounts) {
    const parts = [
      m.usedPct === null ? "no window has reset yet" : `used ${Math.round(m.usedPct)}% of its windows`,
      m.openPct === null ? null : `${Math.round(m.openPct)}% now`,
      `${hours(m.waitingHours)} waiting`,
      `${hours(m.misplacedHours)} misplaced${m.misplacedDollars > 0 ? ` (${dollars(m.misplacedDollars)})` : ""}`,
      m.extraDollars > 0 ? `${dollars(m.extraDollars)} Extra usage` : null,
      `${hours(m.atLimitHours)} at a limit`,
      m.verdictAt === null ? null : `verdict on ${shortDay(Date.parse(m.verdictAt))}`,
      m.size !== 1 ? `size ${m.size}` : null,
      m.disabled ? "set aside" : null,
    ].filter(Boolean);
    lines.push(`- ${m.name}${m.main ? " (main)" : ""} [${m.id}]: ${parts.join(", ")}.`);
  }
  const p = report.pooled;
  lines.push(`All accounts: ${p.usedPct === null ? "no reset yet" : `${Math.round(p.usedPct)}% used`}, ${hours(p.waitingHours)} waiting, ${hours(p.misplacedHours)} misplaced, ${hours(p.allOutHours)} all out, ${round1(p.idlePoints)} points idle, ${dollars(p.extraDollars)} Extra usage.`);
  lines.push(report.waitingSince === null ? "Waiting isn't measured yet (no holds logged)." : `Waiting measured since ${shortDay(Date.parse(report.waitingSince))}.`);
  const r = report.replay;
  const fmt = (x: ReplayResult) => `${hours(x.waitingHours)} waiting, ${x.extraDollars === null ? "Extra usage unpriced" : dollars(x.extraDollars)}, ${hours(x.allOutHours)} all out`;
  lines.push(`Replay (${r.policy}): with ${r.same.accounts}: ${fmt(r.same)}; with ${r.more.accounts}: ${fmt(r.more)}.`);
  for (const f of r.fewer) lines.push(`  without ${f.without}: ${fmt(f)}.`);
  for (const s of report.suggestions) lines.push(`${s === report.recommendation ? "Recommendation" : "Also"}: ${s.title}. ${s.reason}`);
  return lines;
}
