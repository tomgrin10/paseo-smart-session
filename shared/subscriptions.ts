/**
 * Every ZeroSub subscription, as time: how long each lasts, which one takes over
 * next, and how long the pool lasts at this pace.
 *
 * ZeroSub manages accounts (sign-in, default, switching). It moves an agent to the
 * usable account with the most room when the CLI reports a limit. Smart Session
 * already forecasts one login's windows from its recorded history; this file
 * extends that to all of them. It simulates ZeroSub's failover order across the
 * accounts' windows and resets.
 *
 * Plain functions over plain values, shared by the server (which builds the
 * accounts), the overview, the sidebar row, the pill and `budget_status`.
 * `subscriptions.test.ts` holds the rules.
 */

import { formatDuration } from "./format.ts";
import { forecastWindow, formatMoment, type Tone } from "./forecast.ts";

export type Family = "claude" | "codex";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const FIVE_HOURS = 5 * HOUR;
const WEEK = 7 * 24 * HOUR;

/** ZeroSub refreshes an account in use at least every half hour; older readings are not live. */
export const STALE_AFTER_MS = 30 * MINUTE;
/** Rates below this mean nobody is using the window right now (as in `forecast.ts`). */
const IDLE_RATE = 0.2;
/** How far ahead the pool is simulated. Past a day, "at this pace" means nothing. */
export const POOL_HORIZON_MS = 24 * HOUR;

export interface SubscriptionWindow {
  /** `five_hour` and `seven_day` for both families; other caps keep their own id. */
  readonly id: string;
  readonly pct: number;
  readonly resetsAt: string | null;
  /** Percentage points per hour over the last half hour; null when stale or unmeasured. */
  readonly burnPctPerHour: number | null;
}

/** One subscription, as the server hands it over: no email, no credential, no home path. */
export interface Subscription {
  readonly id: string;
  readonly family: Family;
  readonly kind: "main" | "managed";
  /** The name the person gave it in ZeroSub, else a neutral one (`subscriptionName`). */
  readonly name: string;
  /** True when `name` is the person's own; false for "CLI login" / "Account 2". */
  readonly named: boolean;
  readonly isDefault: boolean;
  readonly signedIn: boolean;
  /** Set aside in ZeroSub: signed in, but nothing is routed to it. */
  readonly disabled: boolean;
  /** A limit the CLI reported, until it lifts. */
  readonly limitedUntil: string | null;
  /**
   * When the account has room again, by the guard's own rule (`outUntil` in
   * `shared/guard/zerosub.ts`): a limit ZeroSub recorded or a full window, weekly
   * included. Null while it has room; absent from older servers, when the windows decide.
   */
  readonly outUntil?: string | null;
  readonly createdAt: string | null;
  /** Live sessions on this account now. */
  readonly agents: number;
  /** When the provider produced the reading the windows come from; null with no reading. */
  readonly readAt: string | null;
  readonly windows: SubscriptionWindow[];
  readonly credits: { readonly balance: number | null; readonly unlimited: boolean } | null;
  /** The open session window's readings, oldest first, thinned to a sparkline's worth. */
  readonly history?: { t: string; pct: number }[];
}

const time = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

export const familyName = (family: Family) => (family === "claude" ? "Claude" : "Codex");

/**
 * What to call an account. The name the person chose, else a neutral one: "CLI login"
 * for the CLI's own login, "Account 2", "Account 3"… for the ones ZeroSub added, in
 * the order they were added. Never the email, and never ZeroSub's generated label,
 * which is the email or part of it.
 */
export function subscriptionName(
  account: { id: string; family: Family; kind: "main" | "managed"; label: string | null; createdAt: string | null },
  all: readonly { id: string; family: Family; kind: "main" | "managed"; createdAt: string | null }[],
): { name: string; named: boolean } {
  if (account.label !== null) return { name: account.label, named: true };
  if (account.kind === "main") return { name: "CLI login", named: false };
  const managed = all
    .filter((other) => other.family === account.family && other.kind === "managed")
    .sort((a, b) => (time(a.createdAt) ?? 0) - (time(b.createdAt) ?? 0) || a.id.localeCompare(b.id));
  const hasMain = all.some((other) => other.family === account.family && other.kind === "main");
  return { name: `Account ${managed.findIndex((other) => other.id === account.id) + (hasMain ? 2 : 1)}`, named: false };
}

export const sessionWindow = (account: Subscription) => account.windows.find((w) => w.id === "five_hour") ?? null;
export const weeklyWindow = (account: Subscription) => account.windows.find((w) => w.id === "seven_day") ?? null;

/** How old the reading is, when that is worth saying; null while it is fresh. */
export function readingAge(account: Subscription, now: number): number | null {
  const at = time(account.readAt);
  if (at === null) return null;
  return now - at > STALE_AFTER_MS ? now - at : null;
}

export type SubscriptionStateKind = "room" | "limit" | "aside" | "signed-out" | "unknown";

export interface SubscriptionState {
  readonly kind: SubscriptionStateKind;
  /** The chip: "Room", "At the limit until 3:12 PM", "Set aside", "Signed out", "No reading yet". */
  readonly label: string;
  readonly tone: Tone | "muted";
  /** When an account at the limit is back, if known. */
  readonly until: number | null;
  /** The reading is older than ZeroSub refreshes an account in use. */
  readonly staleMs: number | null;
}

/** How close ZeroSub's recorded limit and a window's reset must be to be the same moment. */
const SAME_MOMENT_MS = 20 * MINUTE;

/** The window ZeroSub's recorded limit is about: the one resetting when the limit lifts. */
export function limitedWindow(account: Subscription, now: number): SubscriptionWindow | null {
  const limited = time(account.limitedUntil);
  if (limited === null || limited <= now) return null;
  return account.windows.find((w) => time(w.resetsAt) !== null && Math.abs(time(w.resetsAt)! - limited) <= SAME_MOMENT_MS) ?? null;
}

/**
 * When an account at the limit is back: the reset of its full window. ZeroSub's own
 * limit time stands only when no window explains it (a budget limit, or a later one).
 */
export function limitEnd(account: Subscription, now: number): number | null {
  if (account.outUntil !== undefined) { const out = time(account.outUntil); return out !== null && out > now ? out : null; }
  const limited = time(account.limitedUntil);
  const full = fullUntil(account, now);
  const window = limitedWindow(account, now);
  const zs = limited !== null && limited > now ? (window ? time(window.resetsAt)! : limited) : 0;
  return Math.max(zs, full ?? 0) || null;
}

/** When a full window lets go: the soonest future reset among the windows at 100%. */
function fullUntil(account: Subscription, now: number): number | null | undefined {
  const full = account.windows.filter((w) => w.pct >= 99.5 && !(time(w.resetsAt) !== null && time(w.resetsAt)! <= now));
  if (full.length === 0) return undefined;
  // Full until every full window has reset: the latest of their resets.
  const resets = full.map((w) => time(w.resetsAt));
  return resets.some((r) => r === null) ? null : Math.max(...(resets as number[]));
}

export function subscriptionState(account: Subscription, now: number, hour12?: boolean): SubscriptionState {
  const staleMs = readingAge(account, now);
  const at = (ms: number) => formatMoment(new Date(ms).toISOString(), now, hour12);
  if (account.disabled) return { kind: "aside", label: "Set aside", tone: "muted", until: null, staleMs };
  if (!account.signedIn) return { kind: "signed-out", label: "Signed out", tone: "muted", until: null, staleMs };
  const limited = time(account.limitedUntil);
  const full = fullUntil(account, now);
  const out = account.outUntil === undefined ? (limited !== null && limited > now) || full !== undefined : limitEnd(account, now) !== null;
  if (out) {
    const until = limitEnd(account, now);
    return { kind: "limit", label: until === null ? "At the limit" : `At the limit until ${at(until)}`, tone: "danger", until, staleMs };
  }
  if (account.readAt === null || account.windows.length === 0) return { kind: "unknown", label: "No reading yet", tone: "muted", until: null, staleMs };
  return { kind: "room", label: "Room", tone: "default", until: null, staleMs };
}

/** The share of an account's tightest window still free, 0–100, as ZeroSub ranks room. */
export function roomLeft(account: Subscription, now: number): number | null {
  if (account.windows.length === 0) return null;
  const live = account.windows.map((w) => (time(w.resetsAt) !== null && time(w.resetsAt)! <= now ? 0 : w.pct));
  return Math.max(0, 100 - Math.max(...live));
}

// ---------------------------------------------------------------- the pool

export interface Takeover {
  /** Where the work was. */
  readonly from: string;
  readonly accountId: string;
  readonly at: number;
}

export interface PoolForecast {
  readonly family: Family;
  readonly total: number;
  /** Accounts signed in and not set aside: the ones the pool can use at all. */
  readonly usable: number;
  /** Accounts that could take an agent right now. */
  readonly withRoom: number;
  /** The pool's measured pace in session-window points per hour; null when nothing is in use. */
  readonly pace: number | null;
  /** The account the work is on now, in the simulation. */
  readonly current: string | null;
  /** Accounts the work moves to before the pool runs dry, in order. */
  readonly takeovers: readonly Takeover[];
  /** When no account has room at this pace (now, when it already happened); null when it lasts. */
  readonly runsOutAt: number | null;
  /**
   * Which limit runs out then: every account's 5-hour session window, or every account's
   * week. Null when it lasts, or when the accounts stop for different reasons.
   */
  readonly limit?: "session" | "weekly" | null;
  /** After it runs dry: when the first account is back, and which. */
  readonly backAt: number | null;
  readonly backAccount: string | null;
  /** How far the forecast looked. */
  readonly horizon: number;
  /** ZeroSub's automatic switching; off, the work stays where it is. */
  readonly autoSwitch: boolean;
  /** Some account's numbers are older than ZeroSub's refresh: the forecast is rough. */
  readonly stale: number;
  /** Each account's state over the forecast, as runs: in use, room, at the limit, out. */
  readonly lanes: Readonly<Record<string, readonly LaneSegment[]>>;
}

export type LaneKind = "active" | "room" | "limit" | "out";
export interface LaneSegment { from: number; to: number; kind: LaneKind }

interface SimAccount {
  readonly a: Subscription;
  readonly usable: boolean;
  limitedUntil: number | null;
  p5: number;
  /** The session window's reset; null while the window has not started. */
  r5: number | null;
  weeklyPct: number;
  /** When the week is full (or runs out at its own pace) until `wReset`. */
  weeklyFullAt: number | null;
  wReset: number | null;
  rank: number;
}

function simAccount(a: Subscription, rank: number, now: number): SimAccount {
  const s = sessionWindow(a);
  const w = weeklyWindow(a);
  let r5 = time(s?.resetsAt);
  let p5 = s?.pct ?? 0;
  // A window past its reset has rolled over; the next one starts at the next use.
  if (r5 !== null && r5 <= now) { p5 = 0; r5 = null; }
  // A reading at 99.5% is the provider's "full" (as in forecast.ts).
  if (p5 >= 99.5) p5 = 100;
  let wReset = time(w?.resetsAt);
  let weeklyPct = w?.pct ?? 0;
  let weeklyFullAt: number | null = null;
  if (wReset !== null && wReset <= now) { weeklyPct = 0; wReset += Math.ceil((now - wReset) / WEEK) * WEEK; }
  else if (w) {
    const f = forecastWindow({ ...w, pct: weeklyPct }, now);
    weeklyFullAt = f.state === "full" ? now : f.state === "short" && f.runsOutAt ? Date.parse(f.runsOutAt) : null;
  }
  // Another cap at 100% (a per-model week) holds the account until it resets.
  const other = a.windows.filter((x) => x.id !== "five_hour" && x.id !== "seven_day" && x.pct >= 99.5 && (time(x.resetsAt) ?? Infinity) > now);
  const otherUntil = other.length === 0 ? null : Math.max(...other.map((x) => time(x.resetsAt) ?? now + POOL_HORIZON_MS * 2));
  const limited = time(a.limitedUntil);
  return {
    a, rank, p5, r5, weeklyPct, weeklyFullAt, wReset,
    usable: a.signedIn && !a.disabled,
    // The guard's verdict when the server sends it; else ZeroSub's limit and any other full cap.
    limitedUntil: a.outUntil !== undefined ? limitEnd(a, now) : Math.max(limited !== null && limited > now ? limited : 0, otherUntil ?? 0) || null,
  };
}

const available = (s: SimAccount, t: number) =>
  s.usable && !(s.limitedUntil !== null && t < s.limitedUntil) && s.p5 < 100 &&
  !(s.weeklyFullAt !== null && t >= s.weeklyFullAt && (s.wReset === null || t < s.wReset));

/** ZeroSub's pick: the least-used usable account; then the default, the CLI login, the oldest. */
function mostRoom(sims: readonly SimAccount[], t: number, exclude?: SimAccount): SimAccount | null {
  const candidates = sims.filter((s) => s !== exclude && available(s, t));
  candidates.sort((x, y) => Math.max(x.p5, x.weeklyPct) - Math.max(y.p5, y.weeklyPct) || x.rank - y.rank);
  return candidates[0] ?? null;
}

/**
 * How long one family's subscriptions last together at this pace.
 *
 * Each account in use burns at its own measured pace (session-window points per
 * hour), and that work stays on it until a window there is full or the week runs
 * out at its own pace. Then ZeroSub moves it to the usable account with the most
 * room, where it adds to whatever already runs there. Resets refill a window, and a
 * session window starts again at the next use. Moved work is assumed to cost the
 * same share of the new account's window; plans of different sizes make that rough.
 * "Runs out" is the first moment some work has nowhere to go.
 *
 * A reading older than ZeroSub's refresh adds no pace and is never extrapolated. Its
 * last numbers stand until its reset, and the forecast counts it as stale.
 */
export function poolForecast(
  accounts: readonly Subscription[],
  family: Family,
  now: number,
  options: { autoSwitch: boolean; horizonMs?: number; stepMs?: number } = { autoSwitch: true },
): PoolForecast {
  const mine = accounts.filter((a) => a.family === family);
  const horizon = now + (options.horizonMs ?? POOL_HORIZON_MS);
  const step = options.stepMs ?? MINUTE;
  const order = [...mine].sort((x, y) =>
    Number(y.isDefault) - Number(x.isDefault) || Number(y.kind === "main") - Number(x.kind === "main") || (time(x.createdAt) ?? 0) - (time(y.createdAt) ?? 0));
  const sims = order.map((a, rank) => simAccount(a, rank, now));
  const stale = mine.filter((a) => readingAge(a, now) !== null).length;
  const withRoom = sims.filter((s) => available(s, now)).length;

  // The work in use now: what each fresh account burns, as its own stream.
  const streams = sims.flatMap((s) => {
    const rate = readingAge(s.a, now) === null ? sessionWindow(s.a)?.burnPctPerHour ?? null : null;
    return rate !== null && rate >= IDLE_RATE ? [{ on: s, rate, stalled: false }] : [];
  }).sort((x, y) => y.rate - x.rate);
  const pace = streams.reduce((sum, w) => sum + w.rate, 0);
  const base = { family, total: mine.length, usable: sims.filter((s) => s.usable).length, withRoom, autoSwitch: options.autoSwitch, horizon, stale };

  const takeovers: Takeover[] = [];
  let runsOutAt: number | null = null;
  let limit: "session" | "weekly" | null = null;
  let backAt: number | null = null;
  let backAccount: string | null = null;

  // Each account's lane over the forecast, for the runway chart.
  const lanes: Record<string, LaneSegment[]> = Object.fromEntries(sims.map((s) => [s.a.id, []]));
  const mark = (s: SimAccount, t: number, kind: LaneKind) => {
    const lane = lanes[s.a.id]!;
    const last = lane[lane.length - 1];
    if (last && last.kind === kind && last.to === t) last.to = t + step;
    else lane.push({ from: t, to: t + step, kind });
  };

  for (let t = now; t < horizon; t += step) {
    for (const s of sims) {
      if (s.r5 !== null && t >= s.r5) { s.p5 = 0; s.r5 = null; }
      if (s.wReset !== null && t >= s.wReset) { s.weeklyPct = 0; s.weeklyFullAt = null; s.wReset += WEEK; }
    }
    // Each account's work stays on it until it is full; then ZeroSub moves it to the
    // account with the most room. With nowhere to go it stops until one is back.
    for (const work of streams) {
      if (available(work.on, t)) {
        if (work.stalled) { work.stalled = false; if (backAt === null) { backAt = t; backAccount = work.on.a.id; } }
        continue;
      }
      const next = options.autoSwitch ? mostRoom(sims, t) : null;
      if (next === null) {
        if (!work.stalled) { work.stalled = true; if (runsOutAt === null) { runsOutAt = t; limit = limitAt(sims, t); } }
        continue;
      }
      if (work.stalled) { if (backAt === null) { backAt = t; backAccount = next.a.id; } }
      else if (runsOutAt === null && t > now) takeovers.push({ from: work.on.a.id, accountId: next.a.id, at: t });
      work.on = next;
      work.stalled = false;
    }
    // Nothing in use: only the limits now and their resets.
    if (streams.length === 0) {
      const open = mostRoom(sims, t);
      if (open === null && t === now) { runsOutAt = now; limit = limitAt(sims, t); }
      else if (open !== null && runsOutAt !== null && backAt === null) { backAt = t; backAccount = open.a.id; }
    }
    for (const s of sims) {
      const busy = streams.some((w) => w.on === s && !w.stalled);
      mark(s, t, !s.usable ? "out" : !available(s, t) ? "limit" : busy ? "active" : "room");
    }
    for (const work of streams) {
      if (work.stalled) continue;
      if (work.on.r5 === null) work.on.r5 = t + FIVE_HOURS;
      work.on.p5 += (work.rate * step) / HOUR;
    }
  }

  // The account carrying the most work now, else the one ZeroSub would open next.
  const lead = streams.length > 0 ? lanes[streams[0]!.on.a.id] : null;
  const first = Object.entries(lanes).find(([, lane]) => lane[0]?.kind === "active");
  const opener = mostRoom(sims.map((s) => simAccount(s.a, s.rank, now)), now);
  return {
    ...base,
    pace: pace > 0 ? pace : null,
    current: lead === null ? opener?.a.id ?? null : first?.[0] ?? null,
    takeovers,
    runsOutAt,
    limit,
    backAt,
    backAccount,
    lanes,
  };
}

/** Why every usable account is out at `t`: all on their week, all on their session (or a limit the CLI reported), or a mix. */
function limitAt(sims: readonly SimAccount[], t: number): "session" | "weekly" | null {
  const weekly = (s: SimAccount) => s.weeklyFullAt !== null && t >= s.weeklyFullAt && (s.wReset === null || t < s.wReset);
  const out = sims.filter((s) => s.usable);
  if (out.length === 0) return null;
  if (out.every(weekly)) return "weekly";
  if (out.every((s) => !weekly(s))) return "session";
  return null;
}

// ---------------------------------------------------------------- words

export interface PoolHeadline {
  readonly title: string;
  readonly detail: string;
  readonly tone: Tone;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The overview's lead and a family's group header, in one sentence and a line under it. */
export function poolHeadline(pool: PoolForecast, accounts: readonly Subscription[], now: number, hour12?: boolean): PoolHeadline {
  const fam = familyName(pool.family);
  const name = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? "another account";
  const at = (ms: number) => formatMoment(new Date(ms).toISOString(), now, hour12);
  const subs = `${pool.total} ${plural(pool.total, "subscription", "subscriptions")}`;
  // What lasts is what can be used: set-aside and signed-out accounts are not counted in.
  const usable = `${pool.usable} ${plural(pool.usable, "subscription", "subscriptions")}`;
  const roughly = pool.stale > 0 ? `${pool.stale} ${plural(pool.stale, "reading is", "readings are")} over 30 min old` : null;
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(" · ");

  if (pool.runsOutAt !== null && pool.runsOutAt <= now) {
    const title = pool.total === 1 ? `${fam} is at the limit` : pool.total === 2 ? `Both ${fam} subscriptions are at the limit` : `All ${pool.total} ${fam} subscriptions are at the limit`;
    const back = pool.backAt !== null ? `${pool.total === 1 ? "Back" : "First one back"} at ${at(pool.backAt)}${pool.total === 1 ? "" : ` · ${name(pool.backAccount)}`} · in ${formatDuration(pool.backAt - now)}`
      : "No reset reported yet";
    return { title, detail: join(back, roughly), tone: "danger" };
  }
  const moves = pool.takeovers.slice(0, 2).map((m, i) => `${i === 0 ? "" : "then "}${name(m.accountId)} ${i === 0 ? "takes over" : ""} at ${at(m.at)}`.replace(/ {2}/g, " "));
  if (pool.runsOutAt !== null) {
    const soon = pool.runsOutAt - now <= 30 * MINUTE;
    const lead = pool.usable <= 1 ? `${fam} runs out around ${at(pool.runsOutAt)}` : `${fam} · ${usable} last until about ${at(pool.runsOutAt)}`;
    const back = pool.backAt !== null ? `first one back at ${at(pool.backAt)}` : null;
    const off = !pool.autoSwitch && pool.total > 1 ? "automatic switching is off in ZeroSub" : null;
    return { title: lead, detail: join(...moves, off, back, `${rounded(pool.pace ?? 0)}%/h combined`, roughly), tone: soon ? "danger" : "warning" };
  }
  if (pool.pace !== null) {
    const through = `past ${at(pool.horizon)}`;
    return {
      title: pool.usable <= 1 ? `${fam} lasts ${through}` : `${fam} · ${usable} last ${through}`,
      detail: join(moves.length > 0 ? moves.join(", ") : "No switch needed", `${rounded(pool.pace)}%/h combined`, roughly),
      tone: "default",
    };
  }
  return {
    title: `${fam} · ${pool.withRoom} of ${subs} with room`,
    detail: join("Nothing used in the last half hour", roughly),
    tone: pool.withRoom === 0 ? "danger" : "default",
  };
}

const rounded = (value: number) => (value >= 10 ? Math.round(value) : Math.round(value * 10) / 10);

/** The sidebar row's right slot for the pool: a time when it runs short, else how many have room. */
export function poolTrailing(pool: PoolForecast, now: number, hour12?: boolean): { label: string; tone: Tone | "muted" } {
  if (pool.runsOutAt !== null && pool.runsOutAt <= now) {
    return { label: pool.backAt !== null ? `back ${formatMoment(new Date(pool.backAt).toISOString(), now, hour12)}` : "all at limit", tone: "danger" };
  }
  if (pool.runsOutAt !== null) {
    return { label: `out ${formatMoment(new Date(pool.runsOutAt).toISOString(), now, hour12)}`, tone: pool.runsOutAt - now <= 30 * MINUTE ? "danger" : "warning" };
  }
  return { label: `${pool.withRoom} of ${pool.total}`, tone: "muted" };
}

/** Which family the page leads with: the one in the most trouble, Claude on a tie. */
export function leadPool(pools: readonly PoolForecast[], now: number): PoolForecast | null {
  const weight = (p: PoolForecast) => (p.runsOutAt !== null && p.runsOutAt <= now ? 3 : p.runsOutAt !== null ? 2 : p.pace !== null ? 1 : 0);
  return [...pools].filter((p) => p.total > 0).sort((a, b) => weight(b) - weight(a) || (a.family === "claude" ? -1 : 1))[0] ?? null;
}

/**
 * One account's outlook inside the pool: full now, runs out at a moment (with the
 * pooled work that moves onto it counted), or lasts to its reset. Read from the
 * simulation, so a row, the lead and the popover never disagree about a time.
 */
export type AccountOutlook = { kind: "full" } | { kind: "runs-out"; at: number } | { kind: "lasts"; reset: number | null } | { kind: "idle" };

export function accountOutlook(pool: PoolForecast, account: Subscription, now: number): AccountOutlook {
  const lane = pool.lanes[account.id] ?? [];
  if (lane[0]?.kind === "limit") return { kind: "full" };
  const reset = time(sessionWindow(account)?.resetsAt);
  const until = reset !== null && reset > now ? reset : pool.horizon;
  const active = lane.find((run) => run.kind === "active" && run.from < until);
  if (!active) return { kind: "idle" };
  const out = lane.find((run) => run.kind === "limit" && run.from > now && run.from <= until);
  return out ? { kind: "runs-out", at: out.from } : { kind: "lasts", reset: reset !== null && reset > now ? reset : null };
}

/**
 * What happens when this session's account hits the limit, for the pill's popover:
 * when it runs out at this pace and where ZeroSub moves the work then, or that
 * nothing has room and the pause (when on) holds it until its own reset.
 */
function limitSentence(
  accounts: readonly Subscription[],
  accountId: string,
  now: number,
  options: { autoSwitch: boolean; protectedHere: boolean; hour12?: boolean },
): { text: string; tone: Tone; target: string | null } {
  const own = accounts.find((a) => a.id === accountId);
  if (!own) return { text: "", tone: "default", target: null };
  const mine = accounts.filter((a) => a.family === own.family);
  const others = mine.filter((a) => a.id !== own.id);
  const pool = poolForecast(mine, own.family, now, { autoSwitch: options.autoSwitch });
  const at = (ms: number) => formatMoment(new Date(ms).toISOString(), now, options.hour12);
  const name = (id: string | null) => mine.find((a) => a.id === id)?.name ?? "another account";
  const outlook = accountOutlook(pool, own, now);
  const ownReset = (() => {
    const state = subscriptionState(own, now, options.hour12);
    if (state.kind === "limit") return state.until;
    const reset = time(sessionWindow(own)?.resetsAt);
    return reset !== null && reset > now ? reset : null;
  })();
  const pause = `Smart Session pauses it until ${ownReset === null ? "its reset" : `its ${at(ownReset)} reset`}`;
  const lead = others.length === 0 ? "No other account" : !options.autoSwitch ? "Automatic switching is off" : "No other account has room";
  // Where the work goes, and how long that account then lasts.
  const lasting = (id: string) => {
    const target = mine.find((a) => a.id === id)!;
    const after = accountOutlook(pool, target, now);
    return after.kind === "runs-out" ? `, which lasts until about ${at(after.at)}` : "";
  };

  if (outlook.kind === "full") {
    const sims = [own, ...others].map((a, i) => simAccount(a, a.isDefault ? -1 : a.kind === "main" ? 0 : i + 1, now));
    const target = options.autoSwitch ? mostRoom(sims, now, sims[0]) : null;
    if (target) return { text: `At the limit · ZeroSub moves it to ${target.a.name}${lasting(target.a.id)}`, tone: "default", target: target.a.id };
    const back = pool.backAt !== null && pool.backAccount !== own.id ? ` until ${at(pool.backAt)} (${name(pool.backAccount)})` : ownReset !== null ? ` until ${at(ownReset)}` : "";
    return { text: options.protectedHere ? `${lead} · ${pause}` : `${lead} · it waits${back}`, tone: others.length > 0 ? "warning" : "default", target: null };
  }
  if (outlook.kind === "runs-out") {
    const move = pool.takeovers.find((m) => m.from === own.id && Math.abs(m.at - outlook.at) <= 2 * MINUTE);
    if (move) return { text: `Runs out ~${at(outlook.at)} · ZeroSub moves it to ${name(move.accountId)}${lasting(move.accountId)}`, tone: "warning", target: move.accountId };
    const back = pool.backAt !== null ? ` until ${at(pool.backAt)}${pool.backAccount !== own.id ? ` (${name(pool.backAccount)})` : ""}` : "";
    return { text: options.protectedHere ? `Runs out ~${at(outlook.at)} · ${lead.toLowerCase()}, so ${pause}` : `Runs out ~${at(outlook.at)} · ${lead.toLowerCase()}${back}`, tone: "warning", target: null };
  }
  if (outlook.kind === "lasts") return { text: outlook.reset === null ? "Lasts at this pace" : `Lasts to its ${at(outlook.reset)} reset at this pace`, tone: "default", target: null };
  // Not in use: what would happen if it filled.
  const sims = [own, ...others].map((a, i) => simAccount(a, a.isDefault ? -1 : a.kind === "main" ? 0 : i + 1, now));
  const target = options.autoSwitch ? mostRoom(sims, now, sims[0]) : null;
  if (target) return { text: `If it fills, ZeroSub moves it to ${target.a.name}`, tone: "default", target: target.a.id };
  return { text: options.protectedHere ? `If it fills: ${lead.toLowerCase()}, so ${pause}` : `If it fills: ${lead.toLowerCase()}`, tone: "default", target: null };
}

/**
 * What happens when this session's account hits the limit, for the pill's popover,
 * with a word on old readings: a forecast over numbers ZeroSub has not refreshed for
 * half an hour says so rather than reading as current.
 */
export function atTheLimit(
  accounts: readonly Subscription[],
  accountId: string,
  now: number,
  options: { autoSwitch: boolean; protectedHere: boolean; hour12?: boolean },
): { text: string; tone: Tone; target: string | null } {
  const said = limitSentence(accounts, accountId, now, options);
  const own = accounts.find((a) => a.id === accountId);
  const target = accounts.find((a) => a.id === said.target);
  const ownAge = own ? readingAge(own, now) : null;
  const targetAge = target ? readingAge(target, now) : null;
  if (ownAge !== null) return { ...said, text: `${said.text.replace(/ at this pace$/, "")} · this reading is ${formatDuration(ownAge)} old` };
  if (targetAge !== null) return { ...said, text: `${said.text} · its reading is ${formatDuration(targetAge)} old` };
  return said;
}
