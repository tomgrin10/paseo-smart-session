/**
 * Protection status for this client bundle: one poll of `smart-session.guard.status`
 * that the composer pill, its popover and the sidebar row all read.
 *
 * Module-level for the same reason as the pill store: everything that shows or
 * changes protection lives in this one bundle, so a change made from the popover
 * redraws the pill at once instead of waiting out the next read.
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { z } from "zod";

import { statusRpc } from "../../shared/guard/contracts.ts";
import { isPending, protects, timestamp, type Pause } from "../../shared/guard/policy.ts";
import { heldUntil } from "../../shared/guard/hold.ts";
import type { Live } from "../live.ts";

export type GuardStatus = z.infer<(typeof statusRpc)["output"]>;

/** How often status is re-read while protection runs here, and while it is off. */
const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 60_000;

let current: GuardStatus | null = null;
const listeners = new Set<() => void>();
const wakers = new Set<() => void>();

export function guardSnapshot(): GuardStatus | null {
  return current;
}

export function subscribeGuard(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Publishes a reading. Exported for the screens that read status themselves, and for tests. */
export function publishGuard(next: GuardStatus | null): void {
  current = next;
  for (const listener of [...listeners]) listener();
}

/**
 * Re-reads status now. Settings and the overview call it when the protection
 * document changes (their `useSettings` hears every client), so the pill follows a
 * switch without polling hard while the feature is off.
 */
export function refreshGuard(): void {
  for (const wake of [...wakers]) wake();
}

/** The pending pause this process can act on for one session, if any. */
export function governedPause(status: GuardStatus | null, agentId: string): Pause | undefined {
  if (status === null || status.governor !== "active") return undefined;
  return status.pauses.find((pause) => pause.agentId === agentId && isPending(pause));
}

/** What protection means for one session, in the words the pill and popover use. */
export function sessionProtection(status: GuardStatus | null, agentId: string) {
  if (status === null) return { kind: "unknown" as const };
  if (status.governor === "deferred") return { kind: "elsewhere" as const, standalone: status.standalone !== false };
  if (status.governor === "error") return { kind: "error" as const, error: status.error };
  if (status.governor === "off" || !status.policy.enabled) return { kind: "off" as const };
  const override = agentId in status.overrides ? status.overrides[agentId]! : null;
  return {
    kind: "on" as const,
    protected: protects(status.policy, status.overrides, agentId),
    byDefault: status.policy.protectByDefault,
    override,
    thresholdPct: status.policy.thresholdPct,
    autoResume: status.policy.autoResume,
  };
}

/** The moment a pause comes back, or null when the provider has not said. */
export function resumeMoment(pause: Pause): number | null {
  return timestamp(heldUntil(pause));
}

/** Starts the one poll for this bundle and feeds the sidebar row's paused count. */
export function watchGuard(client: PluginClientContext, live?: Live): () => void {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const refresh = async () => {
    if (stopped || running) return;
    running = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    try {
      const next = await client.rpc(statusRpc, {});
      if (!stopped) {
        publishGuard(next);
        // The sidebar row counts pauses only this process can act on.
        const pending = next.governor === "active" ? next.pauses.filter(isPending) : [];
        live?.setPaused({ waiting: pending.filter((p) => p.phase !== "attention").length, attention: pending.filter((p) => p.phase === "attention").length });
      }
    } catch {
      // Keep the last confirmed reading across a brief disconnect.
    } finally {
      running = false;
      // Off here and nobody governing from here: nothing to draw, so check rarely.
      const idle = current !== null && !current.policy.enabled && current.governor === "off";
      if (!stopped) timer = setTimeout(() => void refresh(), idle ? IDLE_POLL_MS : ACTIVE_POLL_MS);
    }
  };
  const wake = () => void refresh();
  wakers.add(wake);
  void refresh();
  return () => {
    stopped = true;
    wakers.delete(wake);
    if (timer !== null) clearTimeout(timer);
  };
}
