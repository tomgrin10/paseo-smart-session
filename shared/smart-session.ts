/**
 * RPC contracts, shared by both bundles.
 *
 * Zod schemas here are the wire contract: the daemon validates input and output
 * against them, so a shape change that a client has not seen fails loudly at the
 * boundary rather than quietly downstream.
 */

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const WindowStatusSchema = z.object({
  id: z.string(),
  pct: z.number(),
  resetsAt: z.string().nullable(),
  /** Percentage points per hour over the recent past; null when it cannot be measured. */
  burnPctPerHour: z.number().nullable(),
  /** When this window hits 100% at that rate, if that happens before it resets. */
  projectedFullAt: z.string().nullable(),
  /** The window's start, when its length is known. Optional: older daemons omit it. */
  startAt: z.string().nullable().optional(),
  /** The open window's recorded readings, oldest first, thinned to a chart's worth. */
  history: z.array(z.object({ t: z.string(), pct: z.number() })).optional(),
});

/** A finished 5-hour window: how close it came to the limit. */
export const PastWindowSchema = z.object({
  startAt: z.string().nullable(),
  resetsAt: z.string().nullable(),
  firstSeenAt: z.string(),
  peakPct: z.number(),
});

export const RecorderStatusSchema = z.object({
  /** The reading the store considers current, as an instant the provider vouched for. */
  newestAt: z.string().nullable(),
  /** How stale that reading is, in seconds. */
  ageSeconds: z.number().nullable(),
  source: z.string().nullable(),
  samplesHeld: z.number(),
  firstSampleAt: z.string().nullable(),
  dataDir: z.string(),
});

/**
 * Everything an agent or a panel needs to answer "how much budget is left, and how
 * fast am I spending it".
 */
export const budgetStatus = defineRpc({
  name: "smart-session.budget",
  input: z.object({}),
  output: z.object({
    windows: z.array(WindowStatusSchema),
    /** Finished session windows from the last 14 days, oldest first. */
    past: z.array(PastWindowSchema).optional(),
    recorder: RecorderStatusSchema,
    error: z.string().nullable(),
  }),
});

export const ContextStatusSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  provider: z.string(),
  model: z.string().nullable(),
  status: z.string(),
  usedTokens: z.number(),
  maxTokens: z.number(),
  usedPct: z.number(),
  costUsd: z.number().nullable(),
  /** Recent context growth, from the recorded history. Null until there is a span to measure. */
  growthTokensPerHour: z.number().nullable(),
  /** When this agent would reach the compact band, at that rate. */
  projectedFullAt: z.string().nullable(),
  /** The percentage at which this window is considered ready to compact. */
  compactAtPct: z.number(),
  /** When this agent's task state file was last written; null when it has none. */
  stateWrittenAt: z.string().nullable().optional(),
});

/** Context occupancy for one agent, or all of them. */
export const contextStatus = defineRpc({
  name: "smart-session.context",
  input: z.object({ agentId: z.string().optional() }),
  output: z.object({
    agents: z.array(ContextStatusSchema),
    error: z.string().nullable(),
  }),
});


const ThresholdProfileSchema = z.object({
  notice: z.number().finite().min(1).max(99),
  closing: z.number().finite().min(1).max(99),
  compact: z.number().finite().min(1).max(99),
});

export const ThresholdsSchema = z.object({
  largeWindowFrom: z.number().finite().positive(),
  large: ThresholdProfileSchema,
  small: ThresholdProfileSchema,
});

export const SettingsSchema = z.object({
  /** The master switch: with this off, Smart Compact does nothing at all. */
  enabled: z.boolean(),
  thresholds: ThresholdsSchema,
  freshStateMinutes: z.number(),
  /** Whether every agent's composer carries the smart-compact pill. */
  showPill: z.boolean(),
  /** Whether checkpointing enrols a session, or enrolment is per-session opt-in. */
  autoEnrol: z.boolean(),
  /** Whether the plugin keeps its own hooks registered in Claude Code. */
  installHooks: z.boolean(),
});

/**
 * What the plugin did to Claude Code's configuration, and whether it worked.
 *
 * Worth surfacing rather than only logging: an install that silently found no
 * hooks directory looks exactly like a working one from the outside.
 */
export const InstallReportSchema = z.object({
  pluginDir: z.string().nullable(),
  settingsPath: z.string(),
  changed: z.boolean(),
  hooks: z.array(z.string()),
  mcp: z.enum(["present", "added", "updated", "unavailable", "skipped", "session"]),
  error: z.string().nullable(),
});

/** The state of the Claude Code integration, re-reconciled on demand. */
export const installStatus = defineRpc({
  name: "smart-session.install.status",
  input: z.object({}),
  output: z.object({ report: InstallReportSchema }),
});

/** Read the governor's settings, and the count of agents currently enrolled. */
export const getSettings = defineRpc({
  name: "smart-session.settings.get",
  input: z.object({}),
  output: z.object({ settings: SettingsSchema, enrolledAgents: z.number() }),
});

export const setSettings = defineRpc({
  name: "smart-session.settings.set",
  input: SettingsSchema.partial(),
  output: z.object({ settings: SettingsSchema }),
});


export const SpendSummarySchema = z.object({
  byDay: z.array(z.object({ day: z.string(), tokens: z.number(), messages: z.number() })),
  heatmap: z.array(z.object({ weekday: z.number(), hour: z.number(), tokens: z.number() })),
  byProject: z.array(z.object({ name: z.string(), tokens: z.number() })),
  byModel: z.array(z.object({ name: z.string(), tokens: z.number() })),
  totalTokens: z.number(),
  subagentTokens: z.number(),
  cacheHitPct: z.number(),
  firstHour: z.string().nullable(),
  lastHour: z.string().nullable(),
  bucketCount: z.number(),
});

/** Token spend reconstructed from transcripts — the history from before the recorder. */
export const spendSummary = defineRpc({
  name: "smart-session.spend",
  input: z.object({ days: z.number().optional() }),
  output: z.object({ summary: SpendSummarySchema, error: z.string().nullable() }),
});
