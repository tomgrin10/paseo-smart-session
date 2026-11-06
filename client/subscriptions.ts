/**
 * ZeroSub subscriptions for this client bundle: one poll of
 * `smart-session.subscriptions` that the overview, the sidebar row and the pill's
 * popover all read. Without ZeroSub it answers `zerosub: false`, is asked rarely, and
 * every view looks exactly as it does without this file.
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { z } from "zod";

import { subscriptionsStatus } from "../shared/smart-session.ts";
import { poolForecast, type Family, type PoolForecast } from "../shared/subscriptions.ts";

export type Subscriptions = z.infer<(typeof subscriptionsStatus)["output"]>;

/** ZeroSub refreshes an account in use every few minutes; half a minute keeps up. */
const ZEROSUB_POLL_MS = 30_000;
/** Without ZeroSub: only to notice it being turned on. */
const IDLE_POLL_MS = 5 * 60_000;

let current: Subscriptions | null = null;
const listeners = new Set<() => void>();

export function subscriptionsSnapshot(): Subscriptions | null {
  return current;
}

export function subscribeSubscriptions(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function publishSubscriptions(next: Subscriptions | null): void {
  current = next;
  for (const listener of [...listeners]) listener();
}

/** The families worth a pooled view: ZeroSub on, and at least one account in them. */
export function pools(subs: Subscriptions | null, now: number): PoolForecast[] {
  if (!subs?.zerosub) return [];
  const families = (["claude", "codex"] as Family[]).filter((family) => subs.accounts.some((a) => a.family === family));
  return families.map((family) => poolForecast(subs.accounts, family, now, { autoSwitch: subs.autoSwitch }));
}

/** Whether the views speak about subscriptions at all: ZeroSub with more than one login. */
export function hasSubscriptions(subs: Subscriptions | null): subs is Subscriptions {
  return subs?.zerosub === true && subs.accounts.length > 1;
}

/** Starts the one poll for this bundle. */
export function watchSubscriptions(client: PluginClientContext, onChange?: (next: Subscriptions) => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const refresh = async () => {
    try {
      const next = await client.rpc(subscriptionsStatus, {});
      if (!stopped) { publishSubscriptions(next); onChange?.(next); }
    } catch {
      // Keep the last reading across a brief disconnect.
    } finally {
      if (!stopped) timer = setTimeout(() => void refresh(), current?.zerosub ? ZEROSUB_POLL_MS : IDLE_POLL_MS);
    }
  };
  void refresh();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}
