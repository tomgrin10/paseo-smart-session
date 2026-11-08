/**
 * What the one Smart Session pill says, as plain functions: whether a session gets
 * one, and its label and title. Kept apart from `pill.tsx` so tests can run them.
 */
import { formatClock } from "../shared/format.ts";
import { linesSummary } from "../shared/compact-lines.ts";
import { contextOutlook } from "../shared/forecast.ts";
import { pausePill } from "../shared/guard/presentation.ts";
import { profileFor, type Thresholds } from "../shared/thresholds.ts";
import type { DirectoryAgent } from "./agents.ts";
import { governedPause, sessionProtection, type GuardStatus } from "./guard/status.ts";
import type { PillState } from "./pill-store.ts";

/** Everything the ring shows about one agent's context, for the icon, label and title. */
export function pillPresentation(agent: Pick<DirectoryAgent, "usedTokens" | "maxTokens"> | undefined, enrolled: boolean, thresholds: Thresholds | null, compactOn = true) {
  const known = agent !== undefined && agent.usedTokens !== null && agent.maxTokens !== null;
  const compactWords = !compactOn ? "Smart Compact off" : enrolled ? null : "Smart Compact off for this session";
  if (!known) {
    return {
      label: compactOn ? "Smart Compact" : "Context",
      title: `${compactWords ?? "Smart Compact on"} · no context reading yet`,
      fraction: 0, mark: null as number | null, upper: null as number | null, tone: "default" as const, pct: null as number | null,
    };
  }
  const profile = profileFor(agent.maxTokens!, thresholds ?? undefined);
  const outlook = contextOutlook({ usedTokens: agent.usedTokens!, maxTokens: agent.maxTokens!, compactAtPct: profile.compact, compactNowAtPct: profile.now });
  const pct = Math.round(outlook.pct);
  return {
    label: `${pct}%`,
    title: `Context ${pct}% full · ${compactWords ?? `Smart Compact ${linesSummary(profile.compact, profile.now)}`}`,
    fraction: outlook.pct / 100, mark: profile.compact / 100, upper: profile.now / 100 as number | null, tone: outlook.tone, pct,
  };
}

/** Whether protection runs from this process, so the pill has something to say about it. */
function governing(status: GuardStatus | null): boolean {
  return status !== null && status.governor === "active" && status.policy.enabled;
}

/**
 * Whether one session gets a pill. A pause governed here always does; otherwise the
 * pill follows its preference and needs at least one of its features on.
 */
export function pillVisible(agentId: string, pills: Pick<PillState, "compactOn" | "pillOn">, status: GuardStatus | null, displayOn: boolean): boolean {
  if (governedPause(status, agentId) !== undefined) return true;
  return displayOn && pills.pillOn && (pills.compactOn || governing(status));
}

/** The pill's label and title: the pause when there is one, else the context. */
export function describePill(agentId: string, agent: Pick<DirectoryAgent, "usedTokens" | "maxTokens"> | undefined, pills: Pick<PillState, "enrolled" | "thresholds" | "compactOn">, status: GuardStatus | null, now = Date.now()) {
  const pause = governedPause(status, agentId);
  if (pause !== undefined && status !== null) {
    const view = pausePill(pause, status.policy, now, (iso) => formatClock(iso));
    return { label: view.label, title: view.title };
  }
  const view = pillPresentation(agent, pills.enrolled.has(agentId), pills.thresholds, pills.compactOn);
  const protection = sessionProtection(status, agentId);
  // Only the exception earns words: a protected session says nothing about it.
  const title = protection.kind === "on" && !protection.protected ? `${view.title} · not paused at the limit` : view.title;
  return { label: view.label, title };
}

