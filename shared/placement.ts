/**
 * Placing sessions on accounts: the expiring-first policy, its move rule, and a session-level
 * replay that scores both against today's pace rule. The math is in `docs/placement.md`.
 *
 * Pure and deterministic, like `accounts-report.ts`: no clock, file or setting inside.
 *
 * Units are the report's: one point is 1% of one standard account's weekly window. An account's
 * 5-hour window holds `100 × size ÷ ratio` points (`ratio` is 5-hour percent per weekly point).
 */

import type { DemandStep, PlacementPolicy, ReplayAccount, ReplaySpec } from "./accounts-report.ts";
import { forecastWindow } from "./forecast.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WEEK = 7 * 24 * HOUR;
const FIVE_HOURS = 5 * HOUR;
const EPS = 1e-9;
/** Mirrors `LIMIT_PCT` in `accounts-report.ts` (kept here so the import stays type-only). */
const FULL_PCT = 99.5;
/** Mirrors ZeroSub's 5-hour gate (`ZEROSUB_FIVE_HOUR_GATE`). */
const GATE_PCT = 80;
/** The replay's step (mirrors `STEP_MS`). */
const STEP = 15 * MINUTE;

/**
 * Only a 5-hour wall this close (hours) demotes an account or moves a session. Any wall before the
 * window resets was too strict: it kept work off the account whose weekly budget was expiring,
 * which a wall (one move) never pays for (`docs/placement.md`, the benchmark).
 */
export const WALL_HOURS = 1;

/** The pool's forecast demand before step `k`: the last day's average, points per hour. */
export function poolForecast(demand: readonly DemandStep[]): (k: number) => number {
  const window = Math.round((24 * HOUR) / STEP);
  const sums = [0];
  for (const d of demand) sums.push(sums[sums.length - 1]! + d.used + d.held + d.extra);
  return (k) => {
    const from = Math.max(0, k - window);
    return k === from ? 0 : (sums[k]! - sums[from]!) / ((k - from) * (STEP / HOUR));
  };
}

/** What a policy may know beyond the accounts' readings: the forecast burn. */
export interface PlacementContext {
  /** Weekly points per hour one session burns: what a new or moved session adds. */
  readonly sessionRate: number;
  /** Per account (same index as the accounts): weekly points per hour it burns now (the 5-hour forecast's rate). */
  readonly burn: readonly number[];
  /** The pool's forecast demand, weekly points per hour (the last day's average); absent means no look-ahead. */
  readonly poolRate?: number;
}

export interface ExpiringFirstOptions {
  /** Switch to the earliest reset first when the pool forecast says budget will expire while work later waits. */
  readonly lookAhead: boolean;
  /** How the 5-hour window is checked: the forecast burn until it resets, ZeroSub's fixed 80% gate, or not at all. */
  readonly feasibility: "forecast" | "gate" | "none";
  /** `pace`: weekly room ÷ hours to its reset. `edf`: always the earliest weekly reset first. */
  readonly score: "pace" | "edf";
  /** With `forecast`: only a wall within this many hours demotes an account (Infinity: any wall before its reset). */
  readonly wallHours?: number;
}

/** The shipped configuration: what the benchmark kept (the look-ahead never fired; EDF lost). */
export const EXPIRING_FIRST: ExpiringFirstOptions = { lookAhead: false, feasibility: "forecast", score: "pace", wallHours: WALL_HOURS };

const usable = (a: ReplayAccount) => a.usable && a.weeklyPct < FULL_PCT && a.sessionPct < FULL_PCT;
const hoursTo = (at: number | null, now: number, fallback: number) => Math.max(0.25, ((at ?? now + fallback) - now) / HOUR);

/** One account seen by the policy. */
export interface AccountView {
  readonly index: number;
  /** Weekly points left. */
  readonly weeklyLeft: number;
  /** Hours to the weekly reset (a week when the window isn't open). */
  readonly weeklyHours: number;
  /** 5-hour points left, in weekly points. */
  readonly sessionLeft: number;
  /** Hours to the 5-hour reset (5 when the window isn't open). */
  readonly sessionHours: number;
  /** Its own burn now, points per hour: what the 5-hour window sees. */
  readonly burn: number;
  /** Weekly points per hour that would spend it exactly by its reset (the pace score). */
  readonly pace: number;
  /** Its 5-hour window absorbs its burn plus `extra` sessions until that window resets (`forecastWindow`). */
  readonly fits: (extra: number) => boolean;
  /** Hours until its 5-hour window is full with `extra` more sessions. */
  readonly wallIn: (extra: number) => number;
}

export function viewOf(a: ReplayAccount, index: number, now: number, ctx: PlacementContext | undefined): AccountView {
  const weeklyLeft = Math.max(0, 100 - a.weeklyPct) * a.size;
  const weeklyHours = hoursTo(a.weeklyResetAt, now, WEEK);
  const sessionLeft = (Math.max(0, 100 - a.sessionPct) * a.size) / a.ratio;
  const open = a.sessionResetAt !== null && a.sessionResetAt > now;
  const sessionHours = open ? (a.sessionResetAt! - now) / HOUR : 5;
  const burn = Math.max(0, ctx?.burn[index] ?? 0);
  const rate = ctx?.sessionRate ?? 1;
  const load = (extra: number) => burn + extra * rate;
  const fits = (extra: number) => {
    if (!open) return load(extra) * 5 <= sessionLeft + EPS;
    // The same rule every view uses: the window runs short when it reaches 100% before its reset.
    const f = forecastWindow({ id: "five_hour", pct: a.sessionPct, resetsAt: new Date(a.sessionResetAt!).toISOString(), burnPctPerHour: (load(extra) * a.ratio) / a.size }, now);
    return f.state !== "short" && f.state !== "full";
  };
  return {
    index, weeklyLeft, weeklyHours, sessionLeft, sessionHours, burn,
    pace: weeklyLeft / weeklyHours,
    fits,
    wallIn: (extra) => (load(extra) <= EPS ? Infinity : sessionLeft / load(extra)),
  };
}

/** The pool forecast run forward: what expires unused, and what work finds no account. */
export interface Outlook {
  /** Weekly points that expire unused before the last moment work goes unserved. */
  readonly wasted: number;
  /** Weekly points of forecast work with no account. */
  readonly unserved: number;
  /** Budget expires while work later waits: spending the earliest reset first saves `min(wasted, unserved)`. */
  readonly tight: boolean;
}

/**
 * Run the pool's forecast demand forward an hour at a time under the pace rule (weekly windows
 * only; the 5-hour check covers the short window), refilling each account at its reset.
 */
export function outlook(accounts: readonly ReplayAccount[], now: number, poolRate: number, horizonHours = 168): Outlook {
  const left = accounts.map((a) => (usable(a) ? Math.max(0, 100 - a.weeklyPct) * a.size : 0));
  const reset = accounts.map((a) => a.weeklyResetAt);
  const expiries: { at: number; pts: number }[] = [];
  let unserved = 0;
  let lastShort = -Infinity;
  for (let h = 0; h < horizonHours; h++) {
    const t = now + h * HOUR;
    accounts.forEach((a, i) => {
      if (!a.usable) return;
      const r = reset[i]!;
      if (r !== null && t >= r) {
        if (left[i]! > EPS) expiries.push({ at: r, pts: left[i]! });
        left[i] = 100 * a.size;
        reset[i] = r + WEEK;
      }
    });
    let want = poolRate;
    const order = accounts.map((_, i) => i).filter((i) => left[i]! > EPS)
      .sort((x, y) => left[y]! / hoursTo(reset[y]!, t, WEEK) - left[x]! / hoursTo(reset[x]!, t, WEEK) || x - y);
    for (const i of order) {
      if (want <= EPS) break;
      const got = Math.min(want, left[i]!);
      left[i]! -= got;
      want -= got;
      reset[i] ??= t + WEEK;
    }
    if (want > EPS) { unserved += want; lastShort = t; }
  }
  const wasted = expiries.filter((e) => e.at < lastShort).reduce((s, e) => s + e.pts, 0);
  return { wasted, unserved, tight: wasted > EPS && unserved > EPS };
}

/**
 * The expiring-first policy. Accounts whose 5-hour window can absorb one more session until it
 * resets come first; among them the pace score (weekly room ÷ hours to its reset) ranks, or, when
 * the look-ahead finds the pool tight, the earliest weekly reset. The rest follow in the same
 * order: when no 5-hour window can take a session, the weekly budget still decides, because
 * budget that expires is lost for good while a wall costs one move. Full and set-aside accounts
 * are left out.
 */
export function expiringFirst(options: ExpiringFirstOptions = EXPIRING_FIRST): PlacementPolicy {
  return (accounts, now, ctx) => {
    const views = accounts.map((a, i) => ({ a, v: viewOf(a, i, now, ctx) })).filter(({ a }) => usable(a));
    const fits = (v: AccountView, a: ReplayAccount) =>
      options.feasibility === "none" ? true : options.feasibility === "gate" ? a.sessionPct < GATE_PCT
        : options.wallHours === undefined || !Number.isFinite(options.wallHours) ? v.fits(1) : v.wallIn(1) >= Math.min(options.wallHours, v.sessionHours);
    const edf = options.score === "edf"
      || (options.lookAhead && ctx?.poolRate !== undefined && ctx.poolRate > EPS && outlook(accounts, now, ctx.poolRate).tight);
    const score = (v: AccountView) => (edf ? -v.weeklyHours : v.pace);
    return views
      .map(({ a, v }) => ({ v, ok: fits(v, a), s: score(v), wall: v.wallIn(1) }))
      .sort((x, y) => Number(y.ok) - Number(x.ok)
        || y.s - x.s
        || y.wall - x.wall
        || x.v.index - y.v.index)
      .map(({ v }) => v.index);
  };
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

/** A session a move rule may consider. */
export interface MoveCandidate {
  readonly id: string;
  /** Index of the account it is on. */
  readonly account: number;
  /** Context tokens; the cost of a move is the cache it throws away. */
  readonly contextTokens: number;
}

export interface MoveProposal {
  readonly session: string;
  readonly from: number;
  readonly to: number;
  /** Points of budget the move is forecast to save. */
  readonly gain: number;
  /** Points the cache miss costs. */
  readonly cost: number;
  readonly reason: "expiring" | "five-hour" | "rebalance";
}

/**
 * Points a cache miss costs per thousand context tokens. A move re-reads the whole context at the
 * full input price instead of the cache-read price (about a tenth). A rough figure: a 100k context
 * costs about 0.05 points (1% of a week ≈ $10 of API-priced work; a 100k Opus miss ≈ $0.55).
 */
export const MISS_POINTS_PER_KTOK = 0.0005;

/**
 * How much of the later forced move's cache miss a move ahead of a wall counts as saved (0–1). A
 * wall within the hour on the last half hour's rate is the move ZeroSub makes anyway; crediting it
 * fully gave the least waiting and the fewest cut-off turns, with total moves unchanged (a forced
 * move becomes a chosen one), in the benchmark.
 */
export const LATER_MISS = 1;

/** A turn cut off at a limit waits about this long (Session Guard's grace, `ZEROSUB_MOVE_GRACE_MS`). */
export const CUT_OFF_HOURS = 2 / 60;

export type MoveRule = (accounts: ReplayAccount[], sessions: readonly MoveCandidate[], now: number, ctx: PlacementContext) => MoveProposal | null;

/**
 * Move only when the forecast gain beats the move's cost (both in points). Two gains count:
 * - expiring: the target resets before the source and, at its forecast load, would let budget
 *   expire. By the exchange argument (`docs/placement.md`) shifting load to the earlier deadline
 *   is never worse, and it saves `min(target's surplus, the session's forecast use before that reset)`.
 *   The forecast load of an account is the pool forecast × its share of today's sessions (sessions stay put).
 * - five-hour: the source's 5-hour wall comes within `wallHours`. A session there will be moved at
 *   the wall anyway, with its turn cut off (Session Guard's grace) and the same cache miss; moving
 *   it now saves the cut-off and that later miss.
 * Targets must clear the same 5-hour check as a new session. The smallest context moves first.
 * Guards (background jobs, spacing, cooldown, pins) are the caller's.
 */
export function forecastGainMoves(policy: PlacementPolicy, options: { wallHours?: number; missPointsPerKTok?: number; minGain?: number; gains?: readonly MoveProposal["reason"][]; laterMiss?: number } = {}): MoveRule {
  const wallHours = options.wallHours ?? WALL_HOURS;
  const minGain = options.minGain ?? 0;
  const gains = options.gains ?? ["five-hour"];
  const laterMiss = options.laterMiss ?? LATER_MISS;
  const perKTok = options.missPointsPerKTok ?? MISS_POINTS_PER_KTOK;
  return (accounts, sessions, now, ctx) => {
    if (sessions.length === 0) return null;
    const views = accounts.map((a, i) => viewOf(a, i, now, ctx));
    const order = policy(accounts, now, ctx);
    const load = views.reduce((sum, v) => sum + v.burn, 0);
    const pool = Math.max(0, ctx.poolRate ?? 0);
    const count = Math.max(1, load / Math.max(EPS, ctx.sessionRate));
    // One session's forecast use per hour: its share of the pool forecast.
    const moved = pool / count;
    let best: MoveProposal | null = null;
    const bySource = new Map<number, MoveCandidate>();
    for (const s of sessions) {
      const cur = bySource.get(s.account);
      if (cur === undefined || s.contextTokens < cur.contextTokens) bySource.set(s.account, s);
    }
    for (const [from, s] of bySource) {
      const src = views[from];
      if (src === undefined) continue;
      const cost = (s.contextTokens / 1000) * perKTok;
      const walling = src.wallIn(0) < Math.min(wallHours, src.sessionHours);
      for (const to of order) {
        if (to === from) continue;
        const dst = views[to]!;
        if (dst.wallIn(1) < Math.min(wallHours, dst.sessionHours)) continue;
        let gain = 0;
        let reason: MoveProposal["reason"] = "expiring";
        if (gains.includes("expiring") && dst.weeklyHours < src.weeklyHours) {
          const share = load > EPS ? dst.burn / load : 0;
          const surplus = Math.max(0, dst.weeklyLeft - pool * share * dst.weeklyHours);
          gain = Math.min(surplus, moved * dst.weeklyHours);
        }
        if (walling && gains.includes("five-hour")) {
          const g = moved * CUT_OFF_HOURS + laterMiss * cost;
          if (g > gain) { gain = g; reason = "five-hour"; }
        }
        if (gain > cost + EPS && gain - cost >= minGain && (best === null || gain - cost > best.gain - best.cost)) {
          best = { session: s.id, from, to, gain, cost, reason };
        }
      }
    }
    return best;
  };
}

/**
 * Today's rebalancing (the fork's pace mode): move one session from the lowest pace score to the
 * policy's first pick when that pick's score is at least 1.5× (the hysteresis).
 */
export function hysteresisMoves(policy: PlacementPolicy, ratio = 1.5): MoveRule {
  return (accounts, sessions, now, ctx) => {
    const pace = (i: number) => viewOf(accounts[i]!, i, now, ctx).pace;
    const order = policy(accounts, now, ctx);
    const to = order[0];
    if (to === undefined) return null;
    let worst: MoveCandidate | null = null;
    for (const s of sessions) {
      if (s.account === to) continue;
      if (worst === null || pace(s.account) < pace(worst.account) || (pace(s.account) === pace(worst.account) && s.contextTokens < worst.contextTokens)) worst = s;
    }
    if (worst === null || pace(to) < ratio * Math.max(EPS, pace(worst.account))) return null;
    return { session: worst.id, from: worst.account, to, gain: 0, cost: 0, reason: "rebalance" };
  };
}

/**
 * The shipped move rule: a session ahead of an imminent 5-hour wall moves when the gain beats the
 * cost; otherwise today's 1.5× rebalance. (Weekly moves by forecast gain lost to the hysteresis in
 * the benchmark, so the weekly side stays as it is.)
 */
export function placementMoves(policy: PlacementPolicy, options: { wallHours?: number; missPointsPerKTok?: number } = {}): MoveRule {
  const wall = forecastGainMoves(policy, { ...options, gains: ["five-hour"] });
  const rebalance = hysteresisMoves(policy);
  return (accounts, sessions, now, ctx) => wall(accounts, sessions, now, ctx) ?? rebalance(accounts, sessions, now, ctx);
}

// ---------------------------------------------------------------------------
// The session replay
// ---------------------------------------------------------------------------

export interface SessionReplayOptions {
  readonly stepMs: number;
  /** Weekly points one session burns per hour. */
  readonly sessionRate: number;
  /** Price of a point of Extra usage; null when none was ever logged. */
  readonly dollarsPerPoint: number | null;
  /** Context of a replayed session (unknown in the logs); the move cost's size. */
  readonly contextTokens?: number;
  /** Spacing between voluntary moves (today's guard: 10 minutes). */
  readonly moveSpacingMs?: number;
  /** Per-session cooldown after a move (today's guard: 6 hours). */
  readonly cooldownMs?: number;
  /** A session cut off at a limit waits this long before it runs elsewhere (Session Guard's grace). */
  readonly forcedWaitMs?: number;
  /** Hours of history a forecast burn looks back over. */
  readonly burnHours?: number;
}

export interface SessionReplayResult {
  readonly waitingHours: number;
  /** Of which: turns cut off at a limit and moved (the grace each). */
  readonly cutOffHours: number;
  readonly extraPoints: number;
  readonly extraDollars: number | null;
  /** Moves the rule chose ahead of a limit. */
  readonly moves: number;
  /** Moves a limit forced. */
  readonly forcedMoves: number;
  /** Points thrown away as cache misses, all moves. */
  readonly missPoints: number;
  readonly expired: Readonly<Record<string, number>>;
}

interface SimSession { id: number; account: number; movedAt: number }

/**
 * Replay demand as sessions that stay on their account. Each step the demand is so many sessions
 * (demand ÷ a session's points); new ones are placed by the policy, ended ones are the newest.
 * A session draws its share from its own account; when that account can't give it, the session is
 * cut off and moved (a forced move) to the policy's pick, or waits. Between steps the move rule
 * may move one session (spacing and cooldown as today's guards).
 */
export function replaySessions(
  demand: readonly DemandStep[],
  specs: readonly ReplaySpec[],
  policy: PlacementPolicy,
  moveRule: MoveRule | null,
  options: SessionReplayOptions,
): SessionReplayResult {
  const stepH = options.stepMs / HOUR;
  const ctxTokens = options.contextTokens ?? 100_000;
  const spacing = options.moveSpacingMs ?? 10 * MINUTE;
  const cooldown = options.cooldownMs ?? 6 * HOUR;
  const forcedWaitH = options.forcedWaitMs === undefined ? CUT_OFF_HOURS : options.forcedWaitMs / HOUR;
  const burnSteps = Math.max(1, Math.round(((options.burnHours ?? 2) * HOUR) / options.stepMs));
  const rate = options.sessionRate;
  const missCost = (ctxTokens / 1000) * MISS_POINTS_PER_KTOK;

  const accounts: ReplayAccount[] = specs.map((s) => ({ id: s.id, size: s.size, ratio: s.ratio, usable: s.usable, ...s.start }));
  const nextReset = specs.map(() => 0);
  const expired: Record<string, number> = Object.fromEntries(specs.map((s) => [s.id, 0]));
  const history: number[][] = specs.map(() => []);
  let sessions: SimSession[] = [];
  let nextId = 0;
  let lastMove = -Infinity;
  let waiting = 0, cutOff = 0, extraPts = 0, moves = 0, forced = 0, miss = 0;

  let now = -Infinity;
  const room = (i: number) => {
    const a = accounts[i]!;
    if (!usable(a) || (specs[i]!.from ?? -Infinity) > now) return 0;
    return Math.max(0, Math.min((100 - a.weeklyPct) * a.size, ((100 - a.sessionPct) * a.size) / a.ratio));
  };
  const take = (i: number, want: number, t: number) => {
    const a = accounts[i]!;
    const got = Math.min(want, room(i));
    if (got <= EPS) return 0;
    a.weeklyPct += got / a.size;
    a.sessionPct += (got * a.ratio) / a.size;
    a.weeklyResetAt ??= t + WEEK;
    a.sessionResetAt ??= t + FIVE_HOURS;
    return got;
  };

  const pool = poolForecast(demand);
  for (const [k, step] of demand.entries()) {
    const t = step.t;
    const poolRate = pool(k);
    now = t;
    accounts.forEach((a, i) => {
      if (a.weeklyResetAt !== null && t >= a.weeklyResetAt) {
        if ((specs[i]!.from ?? -Infinity) <= t) expired[a.id]! += Math.max(0, 100 - a.weeklyPct) * a.size;
        a.weeklyPct = 0;
        const resets = specs[i]!.resets;
        while (nextReset[i]! < resets.length && resets[nextReset[i]!]! <= t) nextReset[i]! += 1;
        a.weeklyResetAt = resets[nextReset[i]!] ?? null;
      }
      if (a.sessionResetAt !== null && t >= a.sessionResetAt) { a.sessionPct = 0; a.sessionResetAt = null; }
    });
    const burn = history.map((h) => h.slice(-burnSteps).reduce((s, x) => s + x, 0) / (Math.max(1, Math.min(burnSteps, h.length)) * stepH));
    const total = step.used + step.held + step.extra;
    const n = total <= EPS ? 0 : Math.max(1, Math.round(total / (rate * stepH)));

    if (sessions.length > n) sessions = sessions.slice(0, n);
    // Today's load per account, from the sessions it carries (the forecast a pick sees).
    const load = accounts.map((_, i) => burn[i]!);
    while (sessions.length < n) {
      const ctx = { sessionRate: rate, burn: load, poolRate };
      const pick = policy(accounts, t, ctx).find((i) => room(i) > EPS) ?? -1;
      sessions.push({ id: nextId++, account: pick, movedAt: -Infinity });
      if (pick >= 0) load[pick] += rate;
    }

    // One voluntary move between steps, under the guards.
    if (moveRule !== null && t - lastMove >= spacing) {
      const ctx = { sessionRate: rate, burn: accounts.map((_, i) => sessions.filter((s) => s.account === i).length * rate), poolRate };
      const candidates = sessions.filter((s) => s.account >= 0 && t - s.movedAt >= cooldown)
        .map((s) => ({ id: String(s.id), account: s.account, contextTokens: ctxTokens }));
      const m = moveRule(accounts, candidates, t, ctx);
      const s = m === null ? undefined : sessions.find((x) => String(x.id) === m.session);
      if (m !== null && s !== undefined && m.to !== s.account && room(m.to) > EPS) {
        s.account = m.to; s.movedAt = t; lastMove = t; moves += 1; miss += missCost;
      }
    }

    // Serve: each session's share, from its own account; cut off and moved when it can't.
    const share = n === 0 ? 0 : total / n;
    const parts = total <= EPS ? { work: 0, extra: 0 } : { work: (step.used + step.held) / total, extra: step.extra / total };
    const took = accounts.map(() => 0);
    for (const s of sessions) {
      let left = share;
      if (s.account >= 0) { const g = take(s.account, left, t); took[s.account]! += g; left -= g; }
      if (left > EPS) {
        const ctx = { sessionRate: rate, burn: accounts.map((_, i) => burn[i]!), poolRate };
        for (const i of policy(accounts, t, ctx)) {
          if (left <= EPS) break;
          if (i === s.account || room(i) <= EPS) continue;
          if (s.account >= 0) { forced += 1; miss += missCost; cutOff += forcedWaitH; }
          s.account = i; s.movedAt = t;
          const g = take(i, left, t); took[i]! += g; left -= g;
        }
      }
      if (left > EPS) {
        extraPts += left * parts.extra;
        waiting += (left * parts.work) / rate;
      }
    }
    took.forEach((g, i) => history[i]!.push(g));
  }
  const waitingHours = waiting + cutOff;
  return {
    waitingHours,
    cutOffHours: cutOff,
    extraPoints: extraPts,
    extraDollars: options.dollarsPerPoint === null ? (extraPts > EPS ? null : 0) : extraPts * options.dollarsPerPoint,
    moves,
    forcedMoves: forced,
    missPoints: miss,
    expired,
  };
}
