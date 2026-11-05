/**
 * The pill store: one module-level answer to "is there a pill, who is enrolled, and
 * where are the compact lines", shared by every pill, its popover, the Command
 * Center item and the screens in this client bundle, so a change redraws them all
 * at once instead of waiting out a poll.
 */

import type { EnrolmentState } from "../shared/governor";
import type { Thresholds } from "../shared/thresholds";

export interface PillState {
  /** Both switches folded into one answer: is Smart Compact's part of the pill wanted. */
  readonly showPill: boolean;
  /** Smart Compact's master switch, on its own. */
  readonly compactOn: boolean;
  /** The "pill on every session" preference, on its own; it also covers protection. */
  readonly pillOn: boolean;
  readonly enrolled: ReadonlySet<string>;
  /** The compact bands; null until the daemon has answered. */
  readonly thresholds: Thresholds | null;
}

/**
 * Hidden until the daemon says otherwise.
 *
 * The alternative — assume shown, then retract — flashes a pill at everyone who
 * turned it off, every time the app loads.
 */
let current: PillState = { showPill: false, compactOn: false, pillOn: false, enrolled: new Set(), thresholds: null };

/** The current answer, for code outside React. */
export function state(): PillState {
  return current;
}

const listeners = new Set<() => void>();

export function subscribePills(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pillSnapshot(): PillState {
  return current;
}

function publish(next: PillState): void {
  current = next;
  for (const listener of [...listeners]) listener();
}

/** Marks one agent enrolled or not after a write, without waiting for the next read. */
export function noteEnrolment(agentId: string, enrolled: boolean): void {
  const next = new Set(current.enrolled);
  if (enrolled) next.add(agentId);
  else next.delete(agentId);
  publish({ ...current, enrolled: next });
}

function enrolmentSet(agents: EnrolmentState["agents"]): ReadonlySet<string> {
  return new Set(agents.filter((agent) => agent.enrolled).map((agent) => agent.agentId));
}

/**
 * Re-reads enrolment and redraws every pill.
 *
 * Takes the call rather than making it: the same fetch is reachable from the client
 * entry, a Command Center item and the screens, and each of those holds a different
 * flavour of RPC caller.
 */
export async function refreshPills(fetch: () => Promise<EnrolmentState>): Promise<void> {
  const next = await fetch();
  publish({
    showPill: next.enabled && next.showPill,
    compactOn: next.enabled,
    pillOn: next.showPill,
    enrolled: enrolmentSet(next.agents),
    thresholds: next.thresholds ?? current.thresholds,
  });
}

