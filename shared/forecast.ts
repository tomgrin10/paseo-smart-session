/**
 * Turning a usage reading into the moment it matters.
 *
 * Plain functions over the budget and context RPC outputs, shared by the overview,
 * the pill and the checks, so every view says the same thing about one window: when
 * it resets, whether it runs out first at this pace, and how much is left per hour.
 */

import { formatClock, formatDuration, windowLabel } from "./format.ts";

export type Tone = "default" | "warning" | "danger";

const HOUR = 3_600_000;
const FIVE_HOURS = 5 * HOUR;
const WEEK = 7 * 24 * HOUR;

/** A window's nominal length, or null for a cap whose length is not known. */
export function windowLength(id: string): number | null {
  if (id === "five_hour") return FIVE_HOURS;
  if (id === "seven_day" || id.startsWith("weekly")) return WEEK;
  return null;
}

export interface WindowReading {
  readonly id: string;
  readonly pct: number;
  readonly resetsAt: string | null;
  /** Percentage points per hour over the recent past; null when it cannot be measured. */
  readonly burnPctPerHour: number | null;
}

export interface WindowForecast {
  readonly id: string;
  readonly label: string;
  readonly pct: number;
  readonly resetsAt: string | null;
  /** The window's start, when its length is known. */
  readonly startAt: string | null;
  /** How far through the window we are, 0–1: where an even pace would put the meter. */
  readonly elapsed: number | null;
  /** The rate the forecast uses: the last half hour for the session, the window's average for a week. */
  readonly ratePerHour: number | null;
  /** Where the window ends up at the reset at that rate, uncapped. */
  readonly atResetPct: number | null;
  /** When it reaches 100% at that rate, if that comes before the reset. */
  readonly runsOutAt: string | null;
  /** How long before the reset it runs out. */
  readonly shortMs: number | null;
  /** Percentage points per hour that would last exactly until the reset. */
  readonly budgetPerHour: number | null;
  readonly state: "full" | "short" | "ok" | "idle" | "unknown";
  readonly tone: Tone;
}

/** Rates below this are a window nobody is using right now. */
const IDLE_RATE = 0.2;

export function forecastWindow(window: WindowReading, now = Date.now()): WindowForecast {
  const length = windowLength(window.id);
  const reset = window.resetsAt === null ? NaN : Date.parse(window.resetsAt);
  const known = Number.isFinite(reset) && reset > now;
  const start = known && length !== null ? reset - length : null;
  const elapsed = start === null || length === null ? null : Math.min(1, Math.max(0, (now - start) / length));
  const hoursLeft = known ? (reset - now) / HOUR : null;
  const base = {
    id: window.id,
    label: windowLabel(window.id),
    pct: window.pct,
    resetsAt: known ? new Date(reset).toISOString() : window.resetsAt,
    startAt: start === null ? null : new Date(start).toISOString(),
    elapsed,
  };
  const budgetPerHour = hoursLeft === null || hoursLeft <= 0 ? null : Math.max(0, 100 - window.pct) / hoursLeft;
  const none = { ratePerHour: null, atResetPct: null, runsOutAt: null, shortMs: null, budgetPerHour };

  if (window.pct >= 99.5) return { ...base, ...none, state: "full", tone: "danger" };
  if (hoursLeft === null) return { ...base, ...none, state: "unknown", tone: window.pct >= 90 ? "warning" : "default" };

  // A week is bursty: half an hour of work extrapolated over four days says nothing.
  // Its pace is the window's own average so far.
  const elapsedHours = elapsed === null || length === null ? null : (elapsed * length) / HOUR;
  const rate = length !== null && length > FIVE_HOURS
    ? (elapsedHours !== null && elapsedHours >= 1 ? window.pct / elapsedHours : null)
    : window.burnPctPerHour;
  if (rate === null || !Number.isFinite(rate) || rate < IDLE_RATE) {
    return { ...base, ...none, ratePerHour: rate === null ? null : Math.max(0, rate), state: "idle", tone: window.pct >= 90 ? "warning" : "default" };
  }
  const atResetPct = window.pct + rate * hoursLeft;
  if (atResetPct < 100) {
    return { ...base, ratePerHour: rate, atResetPct, runsOutAt: null, shortMs: null, budgetPerHour, state: "ok", tone: window.pct >= 90 ? "warning" : "default" };
  }
  const runsOut = now + ((100 - window.pct) / rate) * HOUR;
  const shortMs = reset - runsOut;
  const soon = runsOut - now <= 30 * 60_000 || window.pct >= 95;
  return {
    ...base, ratePerHour: rate, atResetPct, runsOutAt: new Date(runsOut).toISOString(), shortMs, budgetPerHour,
    state: "short", tone: soon ? "danger" : "warning",
  };
}

const rounded = (value: number) => (value >= 10 ? Math.round(value) : Math.round(value * 10) / 10);
const until = (iso: string, now: number) => formatDuration(Date.parse(iso) - now);

/** A clock within the next day, else a weekday and clock: "9:21 PM", "Sat 11:00 PM". */
export function formatMoment(iso: string, now = Date.now(), hour12?: boolean): string {
  const at = Date.parse(iso);
  const clock = formatClock(iso, hour12);
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  if (sameDay || (at > now && at - now < 12 * HOUR)) return clock;
  try {
    return `${new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(at))} ${clock}`;
  } catch {
    return clock;
  }
}

/** "Resets 9:21 PM · in 1h 57m". */
export function resetLine(f: WindowForecast, now = Date.now(), hour12?: boolean): string {
  if (f.resetsAt === null) return "Reset time not reported";
  const at = Date.parse(f.resetsAt);
  if (!Number.isFinite(at)) return "Reset time not reported";
  // Past its reset but no newer reading yet: name the moment rather than "due".
  if (at <= now) return `Reset was ${formatMoment(f.resetsAt, now, hour12)}`;
  return `Resets ${formatMoment(f.resetsAt, now, hour12)} · in ${until(f.resetsAt, now)}`;
}

/** The short pace phrase on a meter row: "runs out ~8:47 PM", "on pace for ~88%". */
export function paceLine(f: WindowForecast, now = Date.now(), hour12?: boolean): string {
  switch (f.state) {
    case "full": return "Limit reached";
    case "short": return `Runs out ~${formatMoment(f.runsOutAt!, now, hour12)} at ${rounded(f.ratePerHour!)}%/h`;
    case "ok": return `On pace for ~${Math.round(f.atResetPct!)}% by the reset`;
    case "idle": return f.ratePerHour === null ? "No pace yet" : "Not in use right now";
    default: return "";
  }
}

/** When a window runs short: the pace that would still last until the reset. */
export function budgetLine(f: WindowForecast): string | null {
  if (f.budgetPerHour === null || f.state !== "short") return null;
  return `${rounded(f.budgetPerHour)}%/h would last until the reset`;
}

/** The overview's status headline and the sentence under it. */
export function headline(f: WindowForecast | null, now = Date.now(), hour12?: boolean): { title: string; detail: string; tone: Tone } {
  if (f === null) return { title: "No plan usage recorded yet", detail: "The recorder samples every minute while Paseo runs.", tone: "default" };
  const name = f.id === "five_hour" ? "Session" : f.label;
  const pct = `${Math.round(f.pct)}% used`;
  switch (f.state) {
    case "full": {
      const at = f.resetsAt === null ? NaN : Date.parse(f.resetsAt);
      const detail = !Number.isFinite(at) ? "Waiting for the provider to report the reset"
        : at <= now ? `${resetLine(f, now, hour12)} · waiting for the provider to report the new window`
          : `Back at the ${formatMoment(f.resetsAt!, now, hour12)} reset · in ${until(f.resetsAt!, now)}`;
      return { title: `${name} limit reached`, detail, tone: "danger" };
    }
    case "short":
      return {
        title: `${name} runs out around ${formatMoment(f.runsOutAt!, now, hour12)}`,
        detail: `${formatDuration(f.shortMs!)} before the ${formatMoment(f.resetsAt!, now, hour12)} reset · ${pct} · ${rounded(f.ratePerHour!)}%/h`,
        tone: f.tone,
      };
    case "ok":
      return { title: `${name} lasts until the ${formatMoment(f.resetsAt!, now, hour12)} reset`, detail: `${pct} · on pace for ~${Math.round(f.atResetPct!)}%`, tone: f.tone };
    case "idle":
      return {
        title: `${name} at ${Math.round(f.pct)}%`,
        detail: f.resetsAt === null ? "Nothing used in the last half hour" : `Nothing used in the last half hour · ${resetLine(f, now, hour12).replace(/^R/, "r")}`,
        tone: f.tone,
      };
    default:
      return { title: `${name} at ${Math.round(f.pct)}%`, detail: "The provider has not reported a reset time", tone: f.tone };
  }
}

/** The window the overview leads with: the session, else whichever is fullest. */
export function leadWindow(windows: readonly WindowForecast[]): WindowForecast | null {
  return windows.find((window) => window.id === "five_hour") ?? [...windows].sort((a, b) => b.pct - a.pct)[0] ?? null;
}

export interface ContextReading {
  readonly usedTokens: number;
  readonly maxTokens: number;
  /** The lower line: Smart Compact asks at the end of a turn. */
  readonly compactAtPct: number;
  /** The upper line: Smart Compact asks mid-turn. Absent from older daemons. */
  readonly compactNowAtPct?: number | null;
  readonly growthTokensPerHour?: number | null;
}

export interface ContextOutlook {
  readonly pct: number;
  readonly compactAt: number;
  /** Tokens at the lower line. */
  readonly compactTokens: number;
  /** Past the lower line. */
  readonly past: boolean;
  /** Time until the lower line at the measured growth; null when not growing or already past. */
  readonly untilCompactMs: number | null;
  /** The upper line, or null when the reading has none. */
  readonly nowAt: number | null;
  readonly nowTokens: number | null;
  /** Past the upper line, where the agent is asked mid-turn. */
  readonly pastNow: boolean;
  /** Time until the upper line at the measured growth; null when not growing, already past or unknown. */
  readonly untilNowMs: number | null;
  readonly tone: Tone;
}

export function contextOutlook(reading: ContextReading): ContextOutlook {
  const pct = reading.maxTokens > 0 ? (reading.usedTokens / reading.maxTokens) * 100 : 0;
  const compactTokens = Math.round((reading.compactAtPct / 100) * reading.maxTokens);
  const past = pct >= reading.compactAtPct;
  const growth = reading.growthTokensPerHour ?? null;
  const growing = growth !== null && growth > 0;
  const untilCompactMs = past || !growing ? null : ((compactTokens - reading.usedTokens) / growth) * HOUR;
  const nowAt = typeof reading.compactNowAtPct === "number" ? reading.compactNowAtPct : null;
  const nowTokens = nowAt === null ? null : Math.round((nowAt / 100) * reading.maxTokens);
  const pastNow = nowAt !== null && pct >= nowAt;
  const untilNowMs = nowTokens === null || pastNow || !growing ? null : ((nowTokens - reading.usedTokens) / growth) * HOUR;
  // Amber past the lower line, red past the upper one (or a nearly full window).
  const tone = pct >= 90 || pastNow ? "danger" : past ? "warning" : "default";
  return { pct, compactAt: reading.compactAtPct, compactTokens, past, untilCompactMs, nowAt, nowTokens, pastNow, untilNowMs, tone };
}

/**
 * The context ring: a faint full track, an arc for the share of the window used, and a
 * tick at each compact line: inward at the end-of-turn line, outward at the mid-turn line. Inline SVG in the surface's own colour, so
 * the host `Icon` can draw it anywhere a Lucide glyph fits. Quantized to 1/48 so a
 * ticking view rarely redraws.
 */
export function contextRing(fraction: number, mark: number | null, track = 0.28, upper: number | null = null): string {
  const steps = 48;
  const f = Math.round(Math.min(1, Math.max(0, fraction)) * steps) / steps;
  const r = 8.5;
  const c = 12;
  const point = (t: number, radius: number) => [(c + radius * Math.sin(t * 2 * Math.PI)).toFixed(2), (c - radius * Math.cos(t * 2 * Math.PI)).toFixed(2)];
  let arc = "";
  if (f >= 1) arc = `<circle cx="${c}" cy="${c}" r="${r}"/>`;
  else if (f > 0) {
    const [x, y] = point(f, r);
    arc = `<path d="M${c} ${c - r}A${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${x} ${y}"/>`;
  }
  // The end-of-turn tick points inward from the ring and the mid-turn tick outward, so the pair sits
  // on opposite sides of the stroke and stays apart at pill size, where two ticks 36° apart that
  // both crossed the ring merged with the arc's end into one hooked smudge.
  const tickAt = (at: number | null, from: number, to: number) => {
    if (at === null || !(at > 0 && at < 1)) return "";
    const [x1, y1] = point(at, from);
    const [x2, y2] = point(at, to);
    return `<path d="M${x1} ${y1}L${x2} ${y2}" stroke-width="1.8"/>`;
  };
  // A muted ring (no lower line) has no upper one either.
  const inward = tickAt(mark, r - 3.8, r);
  // r + 2.6 plus the 0.9 round cap ends exactly at the 24-unit box edge, so the stub is never clipped.
  const outward = upper !== null && upper !== mark ? tickAt(upper, r, r + 2.6) : "";
  const tick = mark === null ? "" : inward + outward;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="${c}" cy="${c}" r="${r}" stroke-opacity="${track}"/>${arc}${tick}</svg>`;
}
