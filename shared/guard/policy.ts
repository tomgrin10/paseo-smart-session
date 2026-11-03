/**
 * Session Guard: pausing work at a provider's session limit and continuing it after
 * the window resets.
 *
 * This module, and the rest of `shared/guard/`, `server/guard/` and `client/guard/`,
 * was folded in from the standalone `paseo-session-guard` plugin. The pause record and
 * state file are deliberately unchanged (see `server/guard/store.ts`): during the
 * transition both plugins can be installed on one host, and sharing one state file and
 * one governor lock is what guarantees a session is never paused twice.
 */
import { z } from "zod";
import { NotificationSchema } from "./timeline.ts";

export const PolicySchema = z.object({
  /**
   * Off by default, unlike the standalone plugin. Pausing a running agent is a much
   * bigger thing to do unasked than drawing a chart, and an existing Smart Session
   * install must not start freezing processes on upgrade.
   */
  enabled: z.boolean().default(false),
  protectByDefault: z.boolean().default(true),
  thresholdPct: z.number().min(1).max(100).default(100),
  pollSeconds: z.number().int().min(5).max(300).default(15),
  resetGraceSeconds: z.number().int().min(0).max(600).default(30),
  resumeSpacingSeconds: z.number().int().min(0).max(300).default(5),
  autoResume: z.boolean().default(true),
  includeNativeSubagents: z.boolean().default(true),
  workspaceLabels: z.boolean().default(true),
  providerIds: z.array(z.string().min(1)).default([]),
  windowIds: z.array(z.string().min(1)).min(1).default(["five_hour", "session"]),
  continuation: z.string().trim().min(1).max(8000).default(
    "Your previous turn was paused because the provider's session usage limit was reached. " +
    "The usage window has now reset. Continue the unfinished task from where you left off, " +
    "using this conversation and the current workspace state. Check any interrupted operation " +
    "before retrying it. If the task is already complete, do not repeat it.",
  ),
});
export type Policy = z.infer<typeof PolicySchema>;

export const PauseSchema = z.object({
  id: z.string(), agentId: z.string(), workspaceId: z.string().optional(), provider: z.string(), title: z.string().nullable(),
  windowId: z.string(), anchorResetsAt: z.string().nullable(),
  pausedAt: z.string(), lastUserMessageAt: z.string().nullable(), turnId: z.string().nullable(),
  phase: z.enum(["pausing", "waiting", "resuming", "resumed", "cancelled", "attention"]),
  note: z.string().nullable(), settledAt: z.string().nullable(),
  wasQuotaFailure: z.boolean().default(false),
  resumedInPlace: z.boolean().optional(),
  manualResume: z.boolean().optional(),
  dismissed: z.boolean().optional(),
  restartRecovery: z.boolean().optional(),
  daemonIdentity: z.string().optional(),
  closedOnRestart: z.boolean().optional(),
  releasedForUnload: z.boolean().optional(),
  demo: z.boolean().optional(),
  stoppedByUser: z.boolean().optional(),
  notifications: z.array(NotificationSchema).optional(),
  suspension: z.object({
    rootPid: z.number().int().positive(),
    processes: z.array(z.object({ pid: z.number().int().positive(), startTime: z.string() })),
  }).optional(),
});
export type Pause = z.infer<typeof PauseSchema>;
export const StateSchema = z.object({
  version: z.literal(1),
  overrides: z.record(z.string(), z.boolean()),
  pauses: z.array(PauseSchema),
  labelledWorkspaces: z.array(z.string()).optional(),
  workspaceLabelName: z.string().optional(),
});
export type State = z.infer<typeof StateSchema>;
export const isPending = (pause: Pause) => ["pausing", "waiting", "resuming", "attention"].includes(pause.phase);
export const protects = (policy: Policy, overrides: State["overrides"], id: string) => overrides[id] ?? policy.protectByDefault;

export interface Agent {
  id: string; provider: string; status: string; title?: string | null;
  workspaceId?: string; lastUserMessageAt?: string | null; archivedAt?: string | null;
  activeTurn?: { turnId: string } | null;
  pendingPermissions?: readonly unknown[];
  labels?: Record<string, string>;
  lastError?: string;
}
export interface UsageWindow {
  id: string; usedPct?: number | null; remainingPct?: number | null; resetsAt?: string | null;
}
export interface ProviderUsage {
  providerId: string; status: string; fetchedAt?: string | null; windows: readonly UsageWindow[];
}
export interface Usage {
  fetchedAt: string; providers: readonly ProviderUsage[];
}

export function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
export function usedPct(window: UsageWindow): number | null {
  if (typeof window.usedPct === "number" && Number.isFinite(window.usedPct)) return window.usedPct;
  if (typeof window.remainingPct === "number" && Number.isFinite(window.remainingPct)) return 100 - window.remainingPct;
  return null;
}
export function sessionWindow(provider: ProviderUsage | undefined, policy: Policy): UsageWindow | undefined {
  if (provider?.status !== "available") return undefined;
  return policy.windowIds.map(id => provider.windows.find(window => window.id === id)).find(Boolean);
}

// Reused from paseo-defer's scheduler: upstream re-reads of one window differ
// by milliseconds. Only a materially later reset is a rollover.
export const SAME_WINDOW_MS = 60_000;
export function resetReady(pause: Pause, usage: Usage, policy: Policy, now: number): boolean {
  const provider = usage.providers.find(p => p.providerId === pause.provider);
  if (provider?.status !== "available") return false;
  const window = provider.windows.find(w => w.id === pause.windowId);
  if (!window) return false;
  const pct = usedPct(window);
  if (pct === null || pct >= policy.thresholdPct) return false;
  // A later reset with an old cached percentage must never release a pause.
  const fetched = timestamp(provider.fetchedAt ?? usage.fetchedAt);
  const paused = timestamp(pause.pausedAt)!;
  if (fetched === null || fetched <= paused || fetched > now + SAME_WINDOW_MS) return false;
  const anchor = timestamp(pause.anchorResetsAt);
  const current = timestamp(window.resetsAt);
  const grace = policy.resetGraceSeconds * 1000;
  if (anchor === null) return fetched >= paused + grace;
  // Millisecond jitter is the same window; a real rollover moves it hours.
  if (current !== null && current - anchor > SAME_WINDOW_MS) return fetched >= paused + grace;
  return now >= anchor + grace && fetched >= anchor + grace;
}
