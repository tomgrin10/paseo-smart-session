/**
 * When a context is too full — which depends on how big the window is.
 *
 * A percentage of the window is the wrong unit on its own. What degrades recall and
 * what costs money is the *absolute* size of the prefix re-read every turn, so 30%
 * of a million-token window (300k) is a heavier context than 85% of a 200k one
 * (170k). A single percentage band would either nag a small session or let a large
 * one drift for hours.
 *
 * So there are two profiles. A small window is allowed to fill up, because its
 * ceiling arrives before its context gets unwieldy. A large window is asked to
 * compact long before the ceiling, because the ceiling was never the constraint.
 */

export type Band = "notice" | "closing" | "compact";

export interface ThresholdProfile {
  /** Percentage of the window at which to first mention it. */
  readonly notice: number;
  /** Percentage at which to stop opening new work. */
  readonly closing: number;
  /**
   * The lower line, "when convenient": the `Stop` hook asks at the end of a turn.
   * Kept under its old name so saved settings and older daemons still read it.
   */
  readonly compact: number;
  /**
   * The upper line, "right away": the `PostToolUse` hook asks mid-turn, and the
   * agent is told to finish only the step it is on. Always at or above `compact`.
   */
  readonly now: number;
}

export interface Thresholds {
  /** Windows at least this large use the `large` profile. */
  readonly largeWindowFrom: number;
  readonly large: ThresholdProfile;
  readonly small: ThresholdProfile;
}

/**
 * Defaults.
 *
 * The `large` numbers are deliberately early: 30% of a million tokens is 300k, and
 * a 300k prefix is already past the point where a session is sharp or cheap.
 * The `small` numbers let a 200k session use most of its window, because 85% of it
 * is only 170k.
 *
 * Windows are 200k or 1M in practice, so 400k separates them with room to spare.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  largeWindowFrom: 400_000,
  large: { notice: 15, closing: 22, compact: 30, now: 40 },
  small: { notice: 60, closing: 75, compact: 85, now: 90 },
};

/**
 * Where the upper line goes when a saved profile predates it.
 *
 * The saved lower line is kept as it is, and the upper line keeps the default's
 * distance above it, so a person who moved their compact line to 50% does not get
 * an upper line at 40% — below it — the moment they upgrade.
 */
export function defaultNowFor(compact: number, fallback: ThresholdProfile): number {
  return Math.min(99, Math.max(fallback.now, compact + (fallback.now - fallback.compact)));
}

export function profileFor(maxTokens: number, thresholds: Thresholds = DEFAULT_THRESHOLDS): ThresholdProfile {
  return maxTokens >= thresholds.largeWindowFrom ? thresholds.large : thresholds.small;
}

/** The highest band a given occupancy has reached, or null for "nothing to say". */
export function bandFor(pct: number, profile: ThresholdProfile): Band | null {
  if (pct >= profile.compact) return "compact";
  if (pct >= profile.closing) return "closing";
  if (pct >= profile.notice) return "notice";
  return null;
}

/** Every band at or below the current occupancy, so each fires exactly once. */
export function bandsReached(pct: number, profile: ThresholdProfile): Band[] {
  const reached: Band[] = [];
  if (pct >= profile.notice) reached.push("notice");
  if (pct >= profile.closing) reached.push("closing");
  if (pct >= profile.compact) reached.push("compact");
  return reached;
}

/** Clamps a user-supplied profile into something monotonic and in range. */
export function normalizeProfile(raw: Partial<ThresholdProfile> | undefined, fallback: ThresholdProfile): ThresholdProfile {
  const clamp = (value: unknown, dflt: number): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(99, Math.max(1, value)) : dflt;
  // `compact` is the user-facing setting, so it is authoritative. In particular,
  // asking for 25% must not silently become the old closing threshold because the
  // other two bands happened to be higher. Pull those advisory bands down instead.
  const compact = clamp(raw?.compact, fallback.compact);
  const closing = Math.min(compact, clamp(raw?.closing, fallback.closing));
  const notice = Math.min(closing, clamp(raw?.notice, fallback.notice));
  // The upper line must stay above the lower one; a saved file from before it
  // existed gets the default distance above whatever lower line it kept.
  const now = Math.max(Math.min(99, compact + 1), clamp(raw?.now, defaultNowFor(compact, fallback)));
  return { notice, closing, compact, now: Math.min(99, now) };
}

/** Why a pair of lines cannot be saved, or null when it can. */
export function linesProblem(lower: number | null, upper: number | null): string | null {
  if (lower === null || upper === null) return "Enter a whole number from 1 to 99.";
  if (upper <= lower) return "The right-away line has to be above the end-of-turn line.";
  return null;
}

/**
 * Changes the compact point while keeping useful space between its earlier bands.
 *
 * Lowering an 85% profile straight to 25% would otherwise make notice, closing and
 * compact all fire together. Scale the earlier bands with it when necessary;
 * raising it leaves the existing advance notice intact.
 */
export function withCompactThreshold(profile: ThresholdProfile, value: number, nowValue?: number): ThresholdProfile {
  const compact = Number.isFinite(value) ? Math.round(Math.min(99, Math.max(1, value))) : profile.compact;
  // An explicit upper line wins; otherwise it keeps its distance above the lower one.
  const now =
    nowValue !== undefined && Number.isFinite(nowValue)
      ? Math.round(Math.min(99, Math.max(1, nowValue)))
      : Math.min(99, Math.max(profile.now, compact + (profile.now - profile.compact)));
  if (compact >= profile.closing) return normalizeProfile({ ...profile, compact, now }, profile);

  const scale = compact / profile.compact;
  return normalizeProfile(
    {
      notice: Math.max(1, Math.round(profile.notice * scale)),
      closing: Math.max(1, Math.round(profile.closing * scale)),
      compact,
      now,
    },
    profile,
  );
}

export function normalizeThresholds(raw: Partial<Thresholds> | undefined): Thresholds {
  const largeWindowFrom =
    typeof raw?.largeWindowFrom === "number" && raw.largeWindowFrom > 0
      ? raw.largeWindowFrom
      : DEFAULT_THRESHOLDS.largeWindowFrom;
  return {
    largeWindowFrom,
    large: normalizeProfile(raw?.large, DEFAULT_THRESHOLDS.large),
    small: normalizeProfile(raw?.small, DEFAULT_THRESHOLDS.small),
  };
}
