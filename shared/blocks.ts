/**
 * Turning a stream of samples into the thing you actually want to look at:
 * one record per limit window occurrence — a "block".
 */

import { effectiveAt, type UsageSample, type WindowSample } from "./usage.ts";

/**
 * How far two reported resets may differ and still be the same window.
 *
 * The provider re-derives the reset instant on every read, so the same window
 * comes back as "…:59.873850" then "…:00.309167". Compared exactly, every refresh
 * looks like a rollover. (Learned the hard way in paseo-defer; see its
 * `paseo-defer/server/engine.ts`.)
 */
const SAME_WINDOW_TOLERANCE_MS = 120_000;

/** Nominal lengths, used only to place a block's start on a timeline. */
const WINDOW_DURATION_MS: Readonly<Record<string, number>> = {
  five_hour: 5 * 60 * 60 * 1000,
  seven_day: 7 * 24 * 60 * 60 * 1000,
};

/** A stretch with no samples, long enough that a chart must not draw across it. */
export interface Gap {
  readonly from: string;
  readonly to: string;
}

export interface BlockPoint {
  readonly t: string;
  readonly pct: number;
}

export interface Block {
  readonly windowId: string;
  /** The window's rollover instant, as last reported. */
  readonly resetsAt: string | null;
  /** resetsAt minus the window's nominal length; null when the length is unknown. */
  readonly startAt: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly peakPct: number;
  readonly finalPct: number;
  readonly points: readonly BlockPoint[];
  readonly gaps: readonly Gap[];
  readonly scope?: string;
}

/** One instant format, whatever spelling the source used. */
function normalize(value: string | null): string | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function sameWindow(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_WINDOW_TOLERANCE_MS;
}

/**
 * Whether `next` is a genuinely later window than `current`.
 *
 * A new window always ends later than the one it replaced. An *earlier* reported
 * reset is the provider revising the window we are already in, never a rollover —
 * treating it as one attributes the rest of the block to the wrong occurrence.
 */
function isRollover(current: string | null, next: string | null): boolean {
  if (next === null) return false;
  if (current === null) return true;
  return Date.parse(next) - Date.parse(current) > SAME_WINDOW_TOLERANCE_MS;
}

interface OpenBlock {
  windowId: string;
  resetsAt: string | null;
  scope?: string;
  points: BlockPoint[];
  gaps: Gap[];
}

function seal(open: OpenBlock): Block {
  const points = open.points;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const duration = WINDOW_DURATION_MS[open.windowId.split(":")[0]!];
  return {
    windowId: open.windowId,
    resetsAt: open.resetsAt,
    startAt:
      open.resetsAt !== null && duration !== undefined
        ? new Date(Date.parse(open.resetsAt) - duration).toISOString()
        : null,
    firstSeenAt: first.t,
    lastSeenAt: last.t,
    peakPct: points.reduce((peak, point) => Math.max(peak, point.pct), 0),
    finalPct: last.pct,
    points,
    gaps: open.gaps,
    ...(open.scope !== undefined ? { scope: open.scope } : {}),
  };
}

/**
 * Segment samples into blocks, newest last.
 *
 * `gapMs` should exceed the recorder's heartbeat: anything longer than that means
 * nobody was watching, which is a fact about the recorder and must stay visible in
 * the output rather than being smoothed over.
 */
export function segmentBlocks(
  samples: readonly UsageSample[],
  options: { readonly gapMs?: number } = {},
): Block[] {
  const gapMs = options.gapMs ?? 15 * 60 * 1000;
  const ordered = [...samples].sort((a, b) => Date.parse(effectiveAt(a)) - Date.parse(effectiveAt(b)));

  const open = new Map<string, OpenBlock>();
  const sealed: Block[] = [];

  for (const sample of ordered) {
    // One instant format in, whatever the source spelled it as.
    const t = new Date(Date.parse(effectiveAt(sample))).toISOString();
    for (const [windowId, window] of Object.entries(sample.windows)) {
      const current = open.get(windowId);
      if (current === undefined) {
        open.set(windowId, startBlock(windowId, window, t));
        continue;
      }

      if (isRollover(current.resetsAt, window.resetsAt)) {
        sealed.push(seal(current));
        open.set(windowId, startBlock(windowId, window, t));
        continue;
      }

      // Not a rollover: adopt a reset instant we did not have, keep the one we did.
      if (current.resetsAt === null && window.resetsAt !== null) current.resetsAt = normalize(window.resetsAt);
      else if (!sameWindow(current.resetsAt, window.resetsAt) && window.resetsAt !== null) {
        // Reported earlier than what we hold — a revision. Keep the block, take the value.
        current.resetsAt = normalize(window.resetsAt);
      }

      const previous = current.points[current.points.length - 1]!;
      if (Date.parse(t) - Date.parse(previous.t) > gapMs) {
        current.gaps.push({ from: previous.t, to: t });
      }
      current.points.push({ t, pct: window.pct });
    }
  }

  for (const current of open.values()) sealed.push(seal(current));
  return sealed.sort((a, b) => Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt));
}

function startBlock(windowId: string, window: WindowSample, t: string): OpenBlock {
  return {
    windowId,
    resetsAt: normalize(window.resetsAt),
    ...(window.scope !== undefined ? { scope: window.scope } : {}),
    points: [{ t, pct: window.pct }],
    gaps: [],
  };
}

/**
 * Burn rate in percentage points per hour over *at least* the block's most recent
 * `spanMs`.
 *
 * The anchor is the last point at or before the cutoff, not the first one after
 * it. Samples are only written when something changes, so a quiet stretch may hold
 * a single point inside any given span — anchoring inside the window would make
 * the span zero and the rate unreportable exactly when the answer is "flat".
 */
export function burnRatePctPerHour(block: Block, spanMs = 30 * 60 * 1000): number | null {
  const points = block.points;
  if (points.length < 2) return null;
  const last = points[points.length - 1]!;
  const cutoff = Date.parse(last.t) - spanMs;

  let index = points.findIndex((point) => Date.parse(point.t) >= cutoff);
  if (index === -1) index = points.length - 1;
  if (index > 0) index -= 1;

  const first = points[index]!;
  const hours = (Date.parse(last.t) - Date.parse(first.t)) / 3_600_000;
  if (hours <= 0) return null;
  return (last.pct - first.pct) / hours;
}

/**
 * When this block reaches 100% at the current burn rate.
 *
 * Null when it is not burning, or when it would exhaust after the window rolls
 * over anyway — in which case there is nothing to warn about.
 */
export function projectedExhaustion(block: Block, now = new Date()): string | null {
  const rate = burnRatePctPerHour(block);
  if (rate === null || rate <= 0) return null;
  const last = block.points[block.points.length - 1]!;
  const hoursLeft = (100 - last.pct) / rate;
  if (!Number.isFinite(hoursLeft) || hoursLeft < 0) return null;
  const at = Date.parse(last.t) + hoursLeft * 3_600_000;
  if (at < now.getTime()) return null;
  if (block.resetsAt !== null && at > Date.parse(block.resetsAt)) return null;
  return new Date(at).toISOString();
}

/**
 * At most `max` points from a block, for a chart.
 *
 * Keeps the first and last points and every turn of the curve a chart can show; drops
 * the rest evenly. The percentage only climbs within one window, so an even stride
 * loses nothing a 96-column chart could draw.
 */
export function thinPoints(points: readonly BlockPoint[], max: number): BlockPoint[] {
  if (points.length <= max || max < 2) return [...points];
  const stride = (points.length - 1) / (max - 1);
  const out: BlockPoint[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * stride)]!);
  return out;
}
