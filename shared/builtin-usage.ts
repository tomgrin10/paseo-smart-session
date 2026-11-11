/**
 * Paseo's own Claude card, read so ours is never behind it (Paseo 0.16+).
 *
 * Paseo's built-in `claude` usage source and ZeroSub read the same login from Anthropic
 * on their own clocks, and ZeroSub can lag minutes behind (it backs off on 429s). A card
 * built only from ZeroSub could then hide a built-in card that knows more. So our card
 * takes the built-in's reading for the same login whenever the daemon holds a current
 * one, and the hide has one rule: a built-in card is hidden only while ours shows
 * numbers at least as new as its own.
 *
 * Pure: the server reads the reports from the daemon (`server/builtin-usage.ts`); the
 * login is matched by the SHA-256 of its email, which the server computes in memory and
 * never keeps the email for.
 */

import type { Subscription, SubscriptionWindow } from "./subscriptions.ts";

/** The built-in source's id, and the prefix of its report ids (`claude:<account>`). */
export const BUILTIN_SOURCE_ID = "claude";

/** How long the daemon keeps a report before fetching it again (`UsageSourceRegistry`'s ttl). */
export const DAEMON_TTL_MS = 5 * 60_000;

export interface BuiltinWindow {
  readonly id: string;
  readonly label: string;
  readonly usedPct: number;
  readonly resetsAt: string | null;
}

/** One login's latest successful reading as Paseo's own card shows it. */
export interface BuiltinReading {
  /** The report id, `claude:<account>`. */
  readonly id: string;
  /** When the provider produced these numbers. */
  readonly fetchedAt: string;
  /** True when this is the report's current answer; false for the last good one kept beside an error. */
  readonly current: boolean;
  readonly windows: readonly BuiltinWindow[];
}

const rec = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const instant = (value: unknown): string | null => {
  const s = str(value);
  return s !== null && Number.isFinite(Date.parse(s)) ? s : null;
};

function windowsOf(report: Record<string, unknown> | null): BuiltinWindow[] {
  const out: BuiltinWindow[] = [];
  for (const raw of Array.isArray(report?.windows) ? report!.windows : []) {
    const w = rec(raw);
    const id = str(w?.id);
    const used = finite(w?.usedPct) ?? (finite(w?.remainingPct) === null ? null : 100 - finite(w?.remainingPct)!);
    if (!w || id === null || used === null) continue;
    out.push({ id, label: str(w.label) ?? id, usedPct: Math.min(100, Math.max(0, used)), resetsAt: instant(w.resetsAt) });
  }
  return out;
}

/**
 * One `usage.list_reports` entry from the built-in source: its login (the account label,
 * an email), and its reading. Null for anything else, or a report with no reading at all.
 * The caller hashes `login` and drops it.
 */
export function builtinEntry(entry: unknown): { login: string; reading: BuiltinReading } | null {
  const e = rec(entry);
  const id = str(e?.id);
  if (!e || id === null || e.sourceId !== BUILTIN_SOURCE_ID) return null;
  const login = str(rec(e.account)?.label);
  if (login === null || !login.includes("@")) return null;
  const report = rec(e.report);
  if (report?.status === "available") {
    const fetchedAt = instant(e.successfulAt) ?? instant(e.fetchedAt);
    const windows = windowsOf(report);
    if (fetchedAt === null || windows.length === 0) return null;
    return { login, reading: { id, fetchedAt, current: true, windows } };
  }
  const last = rec(e.lastSuccessful);
  const fetchedAt = instant(last?.fetchedAt);
  const windows = windowsOf(rec(last?.report));
  if (fetchedAt === null || windows.length === 0) return null;
  return { login, reading: { id, fetchedAt, current: false, windows } };
}

/** The built-in window that is the same limit as one of ours, by Paseo's id or, for a scoped weekly, its label. */
function counterpart(ours: SubscriptionWindow, theirs: readonly BuiltinWindow[], label: string): BuiltinWindow | undefined {
  const id = ours.id === "seven_day" ? "weekly" : ours.id;
  return theirs.find((w) => w.id === id) ?? theirs.find((w) => w.label === label);
}

/**
 * The account with the built-in's numbers where they are the ones to show: always while
 * the daemon holds a current reading (both cards then show the same numbers, which is
 * what lets the hide work), else only when its last good reading is newer than ours.
 * The pace (`burnPctPerHour`) stays ours: the built-in has none. Limits only the built-in
 * reports are added, so ours never shows fewer.
 */
export function mergeBuiltin(account: Subscription, reading: BuiltinReading | null, labelOf: (id: string) => string): Subscription {
  if (reading === null) return account;
  const theirsAt = Date.parse(reading.fetchedAt);
  const oursAt = account.readAt === null ? NaN : Date.parse(account.readAt);
  if (!reading.current && Number.isFinite(oursAt) && oursAt >= theirsAt) return account;

  const used = new Set<string>();
  const windows: SubscriptionWindow[] = account.windows.map((w) => {
    const theirs = counterpart(w, reading.windows, labelOf(w.id));
    if (!theirs) return w;
    used.add(theirs.id);
    return { ...w, pct: theirs.usedPct, resetsAt: theirs.resetsAt ?? w.resetsAt };
  });
  for (const theirs of reading.windows) {
    if (used.has(theirs.id)) continue;
    const id = theirs.id === "weekly" ? "seven_day" : theirs.id;
    if (windows.some((w) => w.id === id)) continue;
    windows.push({ id: scopedId(theirs), pct: theirs.usedPct, resetsAt: theirs.resetsAt, burnPctPerHour: null });
  }
  return { ...account, readAt: reading.fetchedAt, windows };
}

/** A built-in-only window under the id Smart Session uses for it (`weekly_model:fable`), so `paseoWindow` names it back. */
function scopedId(window: BuiltinWindow): string {
  if (window.id === "weekly") return "seven_day";
  const scoped = /^weekly_(model|surface)_(.+)$/.exec(window.id);
  const name = /^Weekly · (.+)$/.exec(window.label)?.[1];
  return scoped !== null ? `weekly_${scoped[1]}:${(name ?? scoped[2]!).toLowerCase()}` : window.id;
}

/**
 * The listing in `provider.usage.list`'s shape, for the readers that predate usage
 * sources (the recorder, Session Guard). Each provider keeps its own report's time; the
 * daemon's own conversion stamps the whole list with its oldest report instead.
 */
export function legacyListing(entries: readonly unknown[]): { fetchedAt: string | null; providers: unknown[] } {
  const providers: unknown[] = [];
  let fetchedAt: string | null = null;
  for (const raw of entries) {
    const e = rec(raw);
    const sourceId = str(e?.sourceId);
    if (!e || sourceId === null) continue;
    const report = rec(e.report);
    const available = report?.status === "available";
    providers.push({ providerId: sourceId, status: report?.status ?? "error", windows: available && Array.isArray(report!.windows) ? report!.windows : [] });
    if (fetchedAt === null && sourceId === BUILTIN_SOURCE_ID && available) fetchedAt = instant(e.fetchedAt);
  }
  return { fetchedAt, providers };
}
