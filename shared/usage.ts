/**
 * Normalizing plan-usage payloads into one canonical sample.
 *
 * Three sources report the same limits in three shapes (see RESEARCH.md §1.2):
 * Claude Code's on-disk cache, Paseo's `provider.usage.list`, and the statusline
 * JSON. They disagree on the percentage scale and on which windows they name, so
 * every reading enters the store through here and nowhere else.
 */

/** A single limit window at a point in time. */
export interface WindowSample {
  /** 0-100. */
  readonly pct: number;
  /** ISO instant the window rolls over, or null when the provider omits it. */
  readonly resetsAt: string | null;
  /** The provider's own severity label, when it offers one. */
  readonly severity?: string;
  /** False for a window the provider reports but is not currently counting. */
  readonly active?: boolean;
  /** Human label for a scoped window ("Fable", "Opus"), when scoped. */
  readonly scope?: string;
}

/** Extra-usage credits: real money already spent beyond the plan. */
export interface CreditsSample {
  readonly usedMinor: number;
  readonly limitMinor: number;
  readonly exponent: number;
  readonly currency: string;
  readonly pct: number;
  readonly enabled: boolean;
}

export type SampleSource = "upstream" | "claudejson" | "paseo" | "statusline";

export interface UsageSample {
  /** When we observed it. */
  readonly at: string;
  /** When the provider produced it, when the source says so. Older than `at` by design. */
  readonly fetchedAt: string | null;
  readonly src: SampleSource;
  readonly account: string | null;
  /**
   * Which login the reading is of. `"cli"`: the CLI's own Claude login (`~/.claude`), the
   * only one the recorder reads. Absent on rows written before 3.8.0-beta.9.
   */
  readonly login?: "cli";
  /** ZeroSub's id for that login (`claude-main`) when ZeroSub is enabled, else null. Absent on older rows. */
  readonly accountId?: string | null;
  readonly windows: Readonly<Record<string, WindowSample>>;
  readonly credits: CreditsSample | null;
}

/**
 * Canonical window ids.
 *
 * The `limits[]` array and the top-level keys name the same two windows
 * differently ("session" vs "five_hour", "weekly_all" vs "seven_day"). Folding
 * them here keeps a block's history continuous across a payload shape change.
 */
const WINDOW_ALIASES: Readonly<Record<string, string>> = {
  // Claude Code's `limits[]` array names the 5-hour window "session".
  session: "five_hour",
  // …and the plan week "weekly_all", which Paseo in turn republishes as "weekly".
  weekly_all: "seven_day",
  weekly: "seven_day",
};

/**
 * A scoped weekly cap, named two different ways by two sources.
 *
 * Claude Code reports `kind: "weekly_scoped"` plus a `scope` object; Paseo flattens
 * the same window into an id like `weekly_model_opus`. Left alone, one cap becomes
 * two series and neither shows the real number — which matters most for exactly the
 * window that bites first, the per-model weekly cap.
 */
const PASEO_SCOPED = /^weekly_(model|surface)_(.+)$/;

export function canonicalWindowId(raw: string, scope?: WindowScope | null): string {
  const flattened = PASEO_SCOPED.exec(raw);
  if (flattened !== null) return `weekly_${flattened[1]}:${flattened[2]!.toLowerCase()}`;

  const base = WINDOW_ALIASES[raw] ?? raw;
  if (scope === undefined || scope === null) return base;
  // Lowercased because one source spells it "Fable" and the other "fable".
  return `weekly_${scope.dimension}:${scope.label.toLowerCase()}`;
}

/** Which axis a scoped window is scoped on, and to what. */
export interface WindowScope {
  readonly dimension: "model" | "surface";
  readonly label: string;
}

/**
 * One percentage convention.
 *
 * `~/.claude.json` reports 26 for 26%; Claude Code's statusline builder multiplies
 * its own reading by 100 before display, so that path carries 0.26. A value can be
 * ambiguous only in [0, 1], where "1" means 1% far more often than 100% — a full
 * window reads as 100 in every source we have seen. So: scale only what a source
 * declares to be fractional, never guess per value.
 */
export function toPercent(value: number, scale: "percent" | "fraction"): number {
  if (!Number.isFinite(value)) return 0;
  const pct = scale === "fraction" ? value * 100 : value;
  return Math.min(100, Math.max(0, pct));
}

function instant(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * The scope of a `limits[]` entry.
 *
 * Both axes are read, and the dimension is kept: a model named "x" and a surface
 * named "x" are different caps and must not share an id.
 */
function readScope(scope: unknown): WindowScope | null {
  if (typeof scope !== "object" || scope === null) return null;
  const record = scope as Record<string, { display_name?: unknown; id?: unknown } | undefined>;
  for (const dimension of ["model", "surface"] as const) {
    const candidate = record[dimension];
    const name = candidate?.display_name ?? candidate?.id;
    if (typeof name === "string" && name !== "") return { dimension, label: name };
  }
  return null;
}

/**
 * The `/api/oauth/usage` body, fetched directly.
 *
 * The authoritative source: no cache in front of it, so `fetchedAt` is genuinely
 * now. Same shape as the payload Claude Code caches, minus the wrapper.
 */
export function fromUpstream(raw: unknown, observedAt = new Date()): UsageSample | null {
  const sample = fromClaudeJson({ fetchedAtMs: observedAt.getTime(), utilization: raw }, observedAt);
  return sample === null ? null : { ...sample, src: "upstream" };
}

/**
 * `~/.claude.json` -> `cachedUsageUtilization`, and the `/api/oauth/usage` body it
 * caches. Both the named top-level windows and the self-describing `limits[]` are
 * read; `limits[]` wins on conflict because it carries severity and an active flag.
 */
export function fromClaudeJson(raw: unknown, observedAt = new Date()): UsageSample | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const utilization = record.utilization;
  if (typeof utilization !== "object" || utilization === null) return null;
  const util = utilization as Record<string, unknown>;

  const windows: Record<string, WindowSample> = {};

  for (const [key, value] of Object.entries(util)) {
    if (key === "limits" || key === "extra_usage" || key === "spend") continue;
    if (typeof value !== "object" || value === null) continue;
    const window = value as Record<string, unknown>;
    if (typeof window.utilization !== "number") continue;
    windows[canonicalWindowId(key)] = {
      pct: toPercent(window.utilization, "percent"),
      resetsAt: instant(window.resets_at),
    };
  }

  const limits = util.limits;
  if (Array.isArray(limits)) {
    for (const entry of limits) {
      if (typeof entry !== "object" || entry === null) continue;
      const limit = entry as Record<string, unknown>;
      if (typeof limit.kind !== "string" || typeof limit.percent !== "number") continue;
      const scope = readScope(limit.scope);
      windows[canonicalWindowId(limit.kind, scope)] = {
        pct: toPercent(limit.percent, "percent"),
        resetsAt: instant(limit.resets_at),
        ...(typeof limit.severity === "string" ? { severity: limit.severity } : {}),
        ...(typeof limit.is_active === "boolean" ? { active: limit.is_active } : {}),
        ...(scope !== null ? { scope: scope.label } : {}),
      };
    }
  }

  if (Object.keys(windows).length === 0) return null;

  const fetchedAtMs = record.fetchedAtMs;
  return {
    at: observedAt.toISOString(),
    fetchedAt: typeof fetchedAtMs === "number" ? new Date(fetchedAtMs).toISOString() : null,
    src: "claudejson",
    account: typeof record.accountUuid === "string" ? record.accountUuid : null,
    windows,
    credits: creditsFromSpend(util.spend),
  };
}

/**
 * The `spend` section, which reports extra-usage credits in minor units. This is
 * the only figure in any payload denominated in money already spent rather than
 * in percent of an opaque allowance, so it is worth carrying separately.
 */
function creditsFromSpend(raw: unknown): CreditsSample | null {
  if (typeof raw !== "object" || raw === null) return null;
  const spend = raw as Record<string, unknown>;
  const used = spend.used as Record<string, unknown> | undefined;
  const limit = spend.limit as Record<string, unknown> | undefined;
  if (typeof used?.amount_minor !== "number") return null;
  return {
    usedMinor: used.amount_minor,
    limitMinor: typeof limit?.amount_minor === "number" ? limit.amount_minor : 0,
    exponent: typeof used.exponent === "number" ? used.exponent : 2,
    currency: typeof used.currency === "string" ? used.currency : "USD",
    pct: typeof spend.percent === "number" ? toPercent(spend.percent, "percent") : 0,
    enabled: spend.enabled === true,
  };
}

/**
 * Paseo's `provider.usage.list`, which has already parsed the upstream body into
 * `providers[].windows[]`. Its percentages arrive under one of several field names
 * depending on daemon version, so all the known spellings are tried.
 *
 * This is the authoritative source: the daemon fetches upstream itself on a 5 minute
 * TTL and stamps the response with the instant it actually fetched, so a reading is
 * never older than five minutes and always says how old it is.
 */
export function fromPaseoProviderUsage(
  raw: unknown,
  providerId = "claude",
  observedAt = new Date(),
): UsageSample | null {
  if (typeof raw !== "object" || raw === null) return null;
  const providers = (raw as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) return null;
  const entry = providers.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { providerId?: unknown }).providerId === providerId,
  ) as { windows?: unknown } | undefined;
  if (entry === undefined || !Array.isArray(entry.windows)) return null;

  const windows: Record<string, WindowSample> = {};
  for (const candidate of entry.windows) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const window = candidate as Record<string, unknown>;
    if (typeof window.id !== "string") continue;
    const percent = readPercent(window);
    if (percent === null) continue;
    const flattened = PASEO_SCOPED.exec(window.id);
    windows[canonicalWindowId(window.id)] = {
      pct: percent,
      resetsAt: instant(window.resetsAt ?? window.resets_at),
      ...(typeof window.tone === "string" ? { severity: window.tone } : {}),
      ...(flattened !== null ? { scope: flattened[2]! } : {}),
    };
  }
  if (Object.keys(windows).length === 0) return null;

  const fetchedAt = instant((raw as { fetchedAt?: unknown }).fetchedAt);
  return {
    at: observedAt.toISOString(),
    fetchedAt,
    src: "paseo",
    account: null,
    windows,
    credits: null,
  };
}

/** Percent under any of the spellings a daemon version might use. */
function readPercent(window: Record<string, unknown>): number | null {
  if (typeof window.usedPct === "number") return toPercent(window.usedPct, "percent");
  if (typeof window.used_percentage === "number") return toPercent(window.used_percentage, "percent");
  if (typeof window.percent === "number") return toPercent(window.percent, "percent");
  // `utilization` is the upstream field name and the one place a fraction shows up.
  if (typeof window.utilization === "number") {
    return toPercent(window.utilization, window.utilization <= 1 ? "fraction" : "percent");
  }
  return null;
}

/** The statusline payload's `rate_limits`, whose percentages are already 0-100. */
export function fromStatusline(raw: unknown, observedAt = new Date()): UsageSample | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rateLimits = (raw as { rate_limits?: unknown }).rate_limits;
  if (typeof rateLimits !== "object" || rateLimits === null) return null;

  const windows: Record<string, WindowSample> = {};
  for (const [key, value] of Object.entries(rateLimits as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const window = value as Record<string, unknown>;
    if (typeof window.used_percentage !== "number") continue;
    windows[canonicalWindowId(key)] = {
      pct: toPercent(window.used_percentage, "percent"),
      // The statusline reports resets_at as epoch seconds, not ISO.
      resetsAt:
        typeof window.resets_at === "number"
          ? new Date(window.resets_at * 1000).toISOString()
          : instant(window.resets_at),
    };
  }
  if (Object.keys(windows).length === 0) return null;

  return {
    at: observedAt.toISOString(),
    fetchedAt: null,
    src: "statusline",
    account: null,
    windows,
    credits: null,
  };
}

/**
 * A reading the recorder takes, tagged with its login: every source it reads is the CLI's
 * own Claude login (`login: "cli"`), which ZeroSub calls `accountId` (null without ZeroSub).
 * Before 3.8.0-beta.9 every row said `account: null` and nothing else, so readers treat a
 * row without `login` as unknown, never as another account.
 */
export function asCliReading(sample: UsageSample, accountId: string | null): UsageSample {
  return { ...sample, login: "cli", accountId };
}

/**
 * When the reading was true, as opposed to when we noticed it.
 *
 * `~/.claude.json` is a cache that only a running Claude Code refreshes, and it is
 * routinely hours behind — observed 14h stale on this machine while a Paseo-driven
 * session was active. Plotting such a reading at its observation time would draw a
 * long-finished window across the present, so every analysis keys off this and
 * never off `at`.
 */
export function effectiveAt(sample: UsageSample): string {
  return sample.fetchedAt ?? sample.at;
}

/** Whether a reading was already this old when we saw it. */
export function isStale(sample: UsageSample, toleranceMs = 5 * 60 * 1000): boolean {
  if (sample.fetchedAt === null) return false;
  return Date.parse(sample.at) - Date.parse(sample.fetchedAt) > toleranceMs;
}

/**
 * Whether a new reading is worth a line in the store.
 *
 * Samples arrive far faster than they change: a 60s poll over a quiet hour is 60
 * identical readings. Only a changed percentage, a rolled window, an appeared or
 * vanished window, or a credit movement is recorded — plus a heartbeat, so that a
 * long flat stretch stays distinguishable from a recorder that was not running.
 */
export function isWorthRecording(
  previous: UsageSample | null,
  next: UsageSample,
  heartbeatMs = 10 * 60 * 1000,
): boolean {
  if (previous === null) return true;
  if (Date.parse(next.at) - Date.parse(previous.at) >= heartbeatMs) return true;
  // A cache re-read that carries the same upstream timestamp is the same reading.
  if (previous.src === next.src && next.fetchedAt !== null && previous.fetchedAt === next.fetchedAt) {
    return false;
  }

  const ids = new Set([...Object.keys(previous.windows), ...Object.keys(next.windows)]);
  for (const id of ids) {
    const before = previous.windows[id];
    const after = next.windows[id];
    if (before === undefined || after === undefined) return true;
    if (before.pct !== after.pct) return true;
    if (before.resetsAt !== after.resetsAt) return true;
  }

  if ((previous.credits?.usedMinor ?? null) !== (next.credits?.usedMinor ?? null)) return true;
  return false;
}


/**
 * Whether a reading may enter the series at all.
 *
 * Correctness before resolution. Two of the three sources are caches that can hand
 * back something hours old — `~/.claude.json` only refreshes when a Claude Code
 * session refreshes it, which in practice means when someone runs `/usage`. A stale
 * reading plotted as current would understate a window that has since filled, which
 * is the exact failure this whole store exists to avoid.
 *
 * So a reading is refused when it carries no new information (it is older than what
 * we already hold), or when it contradicts a hard invariant of the window itself.
 */
export function acceptReading(
  newestAccepted: UsageSample | null,
  next: UsageSample,
): { readonly ok: boolean; readonly reason?: string } {
  if (newestAccepted === null) return { ok: true };

  const known = Date.parse(effectiveAt(newestAccepted));
  const incoming = Date.parse(effectiveAt(next));
  if (!Number.isFinite(incoming)) return { ok: false, reason: "unparseable timestamp" };
  if (incoming < known) return { ok: false, reason: "older than the newest reading held" };

  for (const [id, window] of Object.entries(next.windows)) {
    const previous = newestAccepted.windows[id];
    if (previous === undefined) continue;
    // Same window instance: a limit window only ever fills until it rolls over, so a
    // percentage that went backwards is a stale or incoherent reading, not progress.
    const sameInstance =
      previous.resetsAt !== null && window.resetsAt !== null && previous.resetsAt === window.resetsAt;
    if (sameInstance && window.pct < previous.pct) {
      return { ok: false, reason: `${id} went backwards within one window` };
    }
  }

  return { ok: true };
}
