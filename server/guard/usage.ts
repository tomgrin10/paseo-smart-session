/**
 * Session Guard's usage reading, sharpened with Smart Session's recorder.
 *
 * The guard needs every provider's session window, which only Paseo's
 * `provider.usage.list` reports. For Claude, though, Paseo serves a cache up to five
 * minutes old and cannot be made to refresh (RESEARCH.md §7a), while the recorder in
 * this same process asks Anthropic directly every three minutes. Whichever reading is
 * newer wins, so a pause and — more usefully — its release follow the fresher number
 * instead of waiting out Paseo's cache.
 *
 * Only a reading that says when the provider produced it is used: `resetReady` trusts
 * `fetchedAt` to prove a report is newer than the pause, and an observation time is not
 * that.
 */

import { canonicalWindowId, effectiveAt, type UsageSample } from "../../shared/usage.ts";
import type { ProviderUsage, Usage, UsageWindow } from "../../shared/guard/policy.ts";

/** The provider the recorder measures. It records nothing for any other. */
const RECORDED_PROVIDER = "claude";

export function withRecordedUsage(paseo: Usage, recorded: UsageSample | null): Usage {
  if (recorded === null || recorded.fetchedAt === null) return paseo;
  const recordedMs = Date.parse(effectiveAt(recorded));
  if (!Number.isFinite(recordedMs)) return paseo;

  const index = paseo.providers.findIndex((provider) => provider.providerId === RECORDED_PROVIDER);
  const current = index === -1 ? undefined : paseo.providers[index];
  if (current?.status === "available") {
    const paseoMs = Date.parse(current.fetchedAt ?? paseo.fetchedAt);
    if (Number.isFinite(paseoMs) && paseoMs >= recordedMs) return paseo;
  }

  // Keep Paseo's window ids, which are what the policy's `windowIds` name, and fill
  // them from the recorder; the recorder's own canonical ids cover any it lacks.
  const used = new Set<string>();
  const windows: UsageWindow[] = [];
  for (const window of current?.status === "available" ? current.windows : []) {
    const id = canonicalWindowId(window.id);
    const reading = recorded.windows[id];
    if (reading === undefined) {
      windows.push(window);
      continue;
    }
    used.add(id);
    windows.push({ id: window.id, usedPct: reading.pct, remainingPct: null, resetsAt: reading.resetsAt ?? window.resetsAt ?? null });
  }
  for (const [id, reading] of Object.entries(recorded.windows)) {
    if (!used.has(id)) windows.push({ id, usedPct: reading.pct, remainingPct: null, resetsAt: reading.resetsAt });
  }

  const merged: ProviderUsage = { providerId: RECORDED_PROVIDER, status: "available", fetchedAt: new Date(recordedMs).toISOString(), windows };
  const providers = [...paseo.providers];
  if (index === -1) providers.push(merged);
  else providers[index] = merged;
  return { ...paseo, providers };
}

/** The login a legacy listing's Claude report is for: "Claude (alice@example.com)" → the email. */
function loginOf(provider: ProviderUsage): string | null {
  const name = (provider as { displayName?: unknown }).displayName;
  if (typeof name !== "string") return null;
  const match = /\(([^()\s]+@[^()\s]+)\)\s*$/.exec(name);
  return match ? match[1]!.trim().toLowerCase() : null;
}

/**
 * Only the CLI login's Claude report out of Paseo's listing (`usage-account-identity`).
 *
 * Paseo 0.16 lists one built-in report per login a session runs on, every one as
 * `claude`, and the guard took the first: a main session was held or released on a
 * seat's numbers whenever the seat's report came first. Seats are measured from
 * ZeroSub's readings (`accountView`), so here only the CLI login's report stays, picked
 * by its email's hash as the recorder does (`cliListing`). A report that names another
 * login, or several with nothing to match, read as none; `withRecordedUsage` then fills
 * the CLI login's windows from the recorder. A report without a login (before 0.16) is
 * the CLI login's.
 */
export function cliOnlyUsage(usage: Usage, cliHash: string | null, hashOf: (login: string) => string): Usage {
  const claude = usage.providers.filter((provider) => provider.providerId === RECORDED_PROVIDER);
  if (claude.length === 0) return usage;
  const mine = (provider: ProviderUsage) => {
    const login = loginOf(provider);
    if (login === null) return claude.length === 1;
    return cliHash !== null ? hashOf(login) === cliHash : claude.length === 1;
  };
  const keep = claude.filter(mine);
  const chosen = keep.length === 1 ? keep[0] : undefined;
  return { ...usage, providers: usage.providers.filter((provider) => provider.providerId !== RECORDED_PROVIDER || provider === chosen) };
}
