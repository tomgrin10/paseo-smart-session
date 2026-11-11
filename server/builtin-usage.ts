/**
 * Paseo's own Claude card, as the daemon already holds it (Paseo 0.16+), so ours never
 * shows older numbers than the card it stands in for (`shared/builtin-usage.ts`).
 *
 * Three moments, none of which asks Anthropic for anything the daemon would not:
 *
 * - The recorder's minute tick lists every usage report once (what `provider.usage.list`
 *   already did on 0.16, which is the same call underneath). Each built-in report is kept
 *   here under the SHA-256 of its login; the email itself is dropped on the spot.
 * - Our own fetch reads the session's built-in report by id, from the daemon's cache or
 *   by joining the fetch already in flight. Never `forceRefresh`.
 * - When a built-in report has been refreshed after ours was built, or is about to
 *   expire, our report (only ours) is refreshed, so the two stay built from one reading.
 *   Ours re-reads the built-in from the cache; once that has expired, the daemon refetches
 *   it as it would for the next popover anyway.
 */

import { createHash } from "node:crypto";

import { withDaemon, type DaemonClient } from "./daemon.ts";
import { lifecycle } from "../shared/lifecycle.ts";
import { BUILTIN_SOURCE_ID, DAEMON_TTL_MS, builtinEntry, type BuiltinReading } from "../shared/builtin-usage.ts";

const READ_TIMEOUT_MS = 3_000;
/** After a built-in report expires, how long to wait before refreshing ours against it. */
const EXPIRY_SLACK_MS = 1_500;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Login hash → the newest reading of it the daemon has handed us. Memory only. */
const byHash = new Map<string, BuiltinReading>();
/** Our report id per login hash, as the daemon lists it (`smart-session:<key>`). */
const oursByHash = new Map<string, string>();
/** Per login hash: the built-in reading our last report was built from (its `fetchedAt`), or "" for none. */
const builtFrom = new Map<string, string>();

type Listing = { reports?: unknown };
type WithReports = DaemonClient & {
  listUsageReports?: (options?: { reportIds?: string[]; forceRefresh?: boolean }) => Promise<Listing>;
};

/** The daemon's usage entries, or null when this host has no usage sources (before 0.16). */
export async function listReports(client: DaemonClient, options?: { reportIds?: string[]; forceRefresh?: boolean }): Promise<unknown[] | null> {
  const list = (client as WithReports).listUsageReports;
  if (typeof list !== "function") return null;
  try {
    const listing = await list.call(client, options);
    return Array.isArray(listing?.reports) ? listing.reports : [];
  } catch {
    // "Update the host to see usage." on an older daemon, or usage turned off.
    return null;
  }
}

/** Keeps each built-in report's reading under its login's hash; notes our own report ids. */
export function capture(entries: readonly unknown[], hashOf: (key: string) => string | null): void {
  for (const raw of entries) {
    const found = builtinEntry(raw);
    if (found !== null) {
      const hash = sha256(found.login.trim().toLowerCase());
      const known = byHash.get(hash);
      if (!known || known.id !== found.reading.id || Date.parse(found.reading.fetchedAt) >= Date.parse(known.fetchedAt)) byHash.set(hash, found.reading);
      continue;
    }
    const entry = raw as { id?: unknown; sourceId?: unknown };
    if (entry?.sourceId === BUILTIN_SOURCE_ID || typeof entry?.id !== "string") continue;
    const [sourceId, key] = splitId(entry.id);
    if (sourceId !== "smart-session" || key === null) continue;
    const hash = hashOf(key);
    if (hash !== null) oursByHash.set(hash, entry.id);
  }
}

const splitId = (id: string): [string, string | null] => {
  const at = id.indexOf(":");
  return at === -1 ? [id, null] : [id.slice(0, at), id.slice(at + 1)];
};

/** The newest built-in reading of a login, as last seen. */
export function captured(hash: string | null): BuiltinReading | null {
  return hash === null ? null : (byHash.get(hash) ?? null);
}

/**
 * The login's built-in reading as the daemon holds it now: from its cache, or by joining
 * the fetch in flight (a popover asks for both cards at once). Falls back to the last
 * capture after a short wait; the daemon is never asked to refetch.
 */
export async function readBuiltin(hash: string | null): Promise<BuiltinReading | null> {
  const known = captured(hash);
  if (known === null) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const entries = await Promise.race([
      withDaemon((client) => listReports(client, { reportIds: [known.id] })),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS);
      }),
    ]);
    if (entries) capture(entries, () => null);
  } catch {
    // The capture stands in.
  } finally {
    clearTimeout(timer);
  }
  return captured(hash);
}

/** Records which built-in reading a report of ours was just built from. */
export function noteBuilt(hash: string | null, reading: BuiltinReading | null): void {
  if (hash !== null) builtFrom.set(hash, reading?.fetchedAt ?? "");
}

/** Our report ids that were built from an older built-in reading than the daemon now holds. */
export function behind(): string[] {
  const ids: string[] = [];
  for (const [hash, ours] of oursByHash) {
    const reading = byHash.get(hash);
    const from = builtFrom.get(hash);
    if (!reading || from === undefined) continue;
    if (from === "" || Date.parse(reading.fetchedAt) > Date.parse(from)) ids.push(ours);
  }
  return ids;
}

/** Refreshes our reports that are behind the built-in ones. Ours only; the built-in is read from cache. */
export async function realign(client: DaemonClient): Promise<void> {
  const ids = behind();
  if (ids.length > 0) await listReports(client, { reportIds: ids, forceRefresh: true });
  scheduleExpiry();
}

let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let registered = false;

/**
 * One timer for the soonest built-in report to expire among the logins we show: at that
 * moment ours is refreshed, which reads the expired built-in back through the daemon. A
 * popover opened then joins both fetches instead of getting a fresh built-in beside a
 * cached card of ours.
 */
function scheduleExpiry(): void {
  if (!registered) {
    registered = true;
    lifecycle.teardowns.push(() => {
      if (expiryTimer !== null) clearTimeout(expiryTimer);
      expiryTimer = null;
    });
  }
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
  let soonest: number | null = null;
  const ids: string[] = [];
  for (const [hash, ours] of oursByHash) {
    const reading = byHash.get(hash);
    if (!reading?.current) continue;
    const at = Date.parse(reading.fetchedAt) + DAEMON_TTL_MS + EXPIRY_SLACK_MS;
    if (!Number.isFinite(at)) continue;
    if (soonest === null || at < soonest) soonest = at;
    ids.push(ours);
  }
  if (soonest === null || ids.length === 0) return;
  // The recorder's next tick reschedules this; the timer only closes the gap between ticks.
  const delay = Math.max(EXPIRY_SLACK_MS, soonest - Date.now());
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    void withDaemon(async (client) => {
      const entries = await listReports(client, { reportIds: ids, forceRefresh: true });
      if (entries) capture(entries, () => null);
    }).catch(() => undefined);
  }, delay);
  expiryTimer.unref?.();
}

/** Test seam. */
export function forgetBuiltin(): void {
  byHash.clear();
  oursByHash.clear();
  builtFrom.clear();
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
}
