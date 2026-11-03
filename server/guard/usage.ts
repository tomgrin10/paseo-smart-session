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
