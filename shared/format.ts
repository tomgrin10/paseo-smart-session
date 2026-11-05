/** Small formatters shared by the surface and any future CLI. */

/** "2h 14m", "4m", "now" — a duration a person reads without decoding. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** "in 2h 14m" / "14m ago", relative to now. */
export function formatRelative(iso: string | null, now = Date.now()): string {
  if (iso === null) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  return ms >= now ? `in ${formatDuration(ms - now)}` : `${formatDuration(now - ms)} ago`;
}

let cachedHour12: boolean | null = null;

/** Whether this device writes times as "8:50 PM" rather than "20:50". */
export function uses12HourClock(): boolean {
  if (cachedHour12 !== null) return cachedHour12;
  try {
    const parts = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).formatToParts(new Date(2020, 0, 1, 13, 0, 0));
    cachedHour12 = parts.some((part) => part.type === "dayPeriod");
  } catch {
    cachedHour12 = false;
  }
  return cachedHour12;
}

/** Local wall-clock time in the device's own convention: "20:50" or "8:50 PM". */
export function formatClock(iso: string | null, hour12: boolean = uses12HourClock()): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  if (!hour12) return `${String(hours).padStart(2, "0")}:${minutes}`;
  // A non-breaking space, so "AM" never wraps onto a line of its own.
  return `${hours % 12 === 0 ? 12 : hours % 12}:${minutes}\u00a0${hours < 12 ? "AM" : "PM"}`;
}

/** "Oct 22" — a short local date. */
export function formatDay(iso: string): string {
  const date = new Date(iso);
  try {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
  } catch {
    return iso.slice(5, 10);
  }
}

/** "261.7k" — token counts, which are always large and never need units. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

/** "1M", "200k", "88.6M" — a window size or a total, without trailing zeros. */
export function formatCompactTokens(count: number): string {
  if (count >= 1_000_000) {
    const value = count / 1_000_000;
    return `${value >= 10 ? Math.round(value) : Number(value.toFixed(1))}M`;
  }
  if (count >= 1000) return `${Math.round(count / 1000)}k`;
  return String(Math.round(count));
}

/** A window id turned into something worth putting on a row. */
export function windowLabel(id: string): string {
  if (id === "five_hour") return "Session · 5h";
  if (id === "seven_day") return "Week";
  const scoped = /^weekly_(model|surface):(.+)$/.exec(id);
  if (scoped !== null) {
    const name = scoped[2]!;
    return `Week · ${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  }
  return id;
}

/**
 * Which windows are worth a row.
 *
 * The provider reports a long tail of caps that are inactive, unnamed, or at zero
 * for this account — internal codenames included. Showing them all buries the two
 * that matter.
 */
export function isInteresting(window: { id: string; pct: number; resetsAt: string | null }): boolean {
  if (window.id === "five_hour" || window.id === "seven_day") return true;
  return window.pct > 0 || window.resetsAt !== null;
}


/**
 * Which step of a sequential ramp a value falls on.
 *
 * Magnitude is encoded with one hue at stepped intensities, so this returns an
 * index into that ramp — or -1 for "no data", which must render as the surface
 * rather than as the faintest step: absence and "a little" must not look alike.
 */
export function rampStep(value: number, max: number, steps: number): number {
  if (steps <= 0 || max <= 0 || value <= 0) return -1;
  const index = Math.ceil((value / max) * steps) - 1;
  return Math.min(steps - 1, Math.max(0, index));
}

/**
 * What the composer pill says about one agent.
 *
 * "Smart Compact" rather than "auto-compact": Claude Code already ships a feature
 * by the latter name that fires on its own thresholds, and a pill that borrowed the
 * name would read as a switch for that.
 *
 * Two states, because there are only two. Whether this session is governed is the
 * only question a pill can answer; whether the feature exists at all is answered by
 * the pill being drawn, since it is hidden entirely when Smart Compact is off.
 */
export function smartCompactLabel(input: { enrolled: boolean }): string {
  return input.enrolled ? "Smart Compact on" : "Smart Compact off";
}
