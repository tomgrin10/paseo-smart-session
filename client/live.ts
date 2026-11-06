import { useSyncExternalStore } from "react";
import type { z } from "zod";

import type { budgetStatus, subscriptionsStatus } from "../shared/smart-session";

type Budget = z.infer<(typeof budgetStatus)["output"]>;
type Subscriptions = z.infer<(typeof subscriptionsStatus)["output"]>;

/**
 * What the sidebar row shows, fed by the polls that already run: the budget from
 * the overview and the client's own slow poll, the paused count from the Session
 * Guard pills' status poll. One per plugin installation.
 */
export interface Live {
  subscribe(listener: () => void): () => void;
  version(): number;
  budget(): Budget | null;
  paused(): { waiting: number; attention: number };
  /** ZeroSub's accounts, when it runs here; the row then speaks for the pool. */
  subscriptions(): Subscriptions | null;
  setBudget(budget: Budget): void;
  setSubscriptions(next: Subscriptions): void;
  setPaused(counts: { waiting: number; attention: number }): void;
}

export function createLive(): Live {
  let budget: Budget | null = null;
  let paused = { waiting: 0, attention: 0 };
  let subscriptions: Subscriptions | null = null;
  let version = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    version: () => version,
    budget: () => budget,
    paused: () => paused,
    subscriptions: () => subscriptions,
    setBudget(next) { budget = next; notify(); },
    setSubscriptions(next) { subscriptions = next; notify(); },
    setPaused(next) {
      if (next.waiting === paused.waiting && next.attention === paused.attention) return;
      paused = next; notify();
    },
  };
}

export function useLive(live: Live): number {
  return useSyncExternalStore(live.subscribe, live.version, live.version);
}
