/**
 * The Governor: letting an agent compact itself.
 *
 * An agent cannot run `/compact` — it is a client command, not something the model
 * can invoke. But Paseo parses slash commands out of any message sent to an agent
 * and honours the root-only set, `compact` included, so a request routed through
 * the daemon becomes a real compaction with real custom instructions. Verified end
 * to end: 39,325 -> 6,160 tokens with instructions honoured (RESEARCH.md §7.1).
 */

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ThresholdsSchema } from "./smart-session.ts";

export const CompactionStateSchema = z.enum(["pending", "sending", "sent", "failed", "cancelled"]);

export const CompactionRequestSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  /** Why the agent asked, in its own words. Goes into the compaction instructions. */
  reason: z.string(),
  /** A file the agent considers authoritative, re-read after compaction. */
  statePath: z.string().nullable(),
  /** Whether to start another model turn after the compaction lands. */
  continueAfterCompaction: z.boolean(),
  /** Exact follow-up chosen by the agent, or null for the state-aware default. */
  continuationMessage: z.string().nullable(),
  createdAt: z.string(),
  state: CompactionStateSchema,
  /** When the request settled: for `sent`, when `/compact` was delivered, which is not when it compacted. */
  settledAt: z.string().nullable(),
  /**
   * When the compaction is known to have happened: the context shrank after delivery. Null until
   * then, and for good when it never did (cancelled or failed; `error` then says so). See
   * `confirmation`.
   */
  confirmedAt: z.string().nullable(),
  error: z.string().nullable(),
  /** Context occupancy either side of the compaction, for grading the policy. */
  preTokens: z.number().nullable(),
  postTokens: z.number().nullable(),
  /**
   * When the requested continuation message was sent.
   *
   * Nothing in Claude Code restarts a task after a manual `/compact` — verified
   * across 190 real compactions, 163 of which stopped dead waiting for a person
   * (`RESEARCH.md` §3.4). When the agent wants to keep working, the governor says
   * the default or agent-supplied follow-up once and records that it did.
   */
  resumedAt: z.string().nullable(),
});
export type CompactionRequest = z.infer<typeof CompactionRequestSchema>;

/** Whether the context emptied the way a compaction empties it, not by a few tokens. */
export function landed(preTokens: number | null, usedTokens: number): boolean {
  return preTokens !== null && preTokens > 0 && usedTokens < preTokens * COMPACTED_FRACTION;
}

/** A compaction leaves well under this share of the context it started with (300k becomes 20-60k). */
const COMPACTED_FRACTION = 0.6;

/** What the governor writes when a delivered `/compact` never compacted. */
export const NOT_COMPACTED = "The /compact was delivered but no compaction followed (cancelled or failed), so it does not count.";

/**
 * When a queued compaction is known to have happened, or null.
 *
 * Invariant: a compaction counts only once it is confirmed. A request, a delivery and a
 * cancelled or failed `/compact` never count: the person or the client can cancel a delivered
 * `/compact` ("Compaction canceled."), which leaves the request `sent`. Confirmed means the
 * context shrank after delivery (`confirmedAt`, or `postTokens` on rows from before that field), or
 * the session's PostCompact or SessionStart:compact hook recorded a compaction after delivery
 * (`events`, the hook's `compaction-events.jsonl`). `hooks/ask.mjs` mirrors this as `confirmedAt`.
 */
export function confirmation(
  item: Pick<CompactionRequest, "agentId" | "state" | "settledAt" | "confirmedAt" | "postTokens">,
  events: readonly { agentId?: unknown; event?: unknown; at?: unknown }[] = [],
): string | null {
  if (item.state !== "sent" || item.settledAt === null) return null;
  if (item.confirmedAt) return item.confirmedAt;
  if (typeof item.postTokens === "number") return item.settledAt;
  const delivered = Date.parse(item.settledAt);
  const record = events.find((event) => event.agentId === item.agentId
    && (event.event === "PostCompact" || event.event === "SessionStart")
    && typeof event.at === "string" && Date.parse(event.at) >= delivered);
  return record === undefined ? null : (record.at as string);
}

/**
 * Queues a compaction for an agent, delivered once that agent is idle.
 *
 * Never delivered mid-turn: a message arriving during a turn steers it instead of
 * arriving as its own instruction, and a compaction that interrupts a half-finished
 * tool sequence loses exactly the state the agent had not written down yet.
 */
export const requestCompaction = defineRpc({
  name: "smart-session.compact.request",
  input: z.object({
    agentId: z.string(),
    reason: z.string(),
    statePath: z.string().nullable().optional(),
    continueAfterCompaction: z.boolean().optional(),
    continuationMessage: z.string().min(1).nullable().optional(),
  }),
  output: z.object({ request: CompactionRequestSchema }),
});

export const listCompactions = defineRpc({
  name: "smart-session.compact.list",
  input: z.object({ agentId: z.string().optional() }),
  output: z.object({ items: z.array(CompactionRequestSchema) }),
});

export const cancelCompaction = defineRpc({
  name: "smart-session.compact.cancel",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const AgentEnrolmentSchema = z.object({
  agentId: z.string(),
  enrolled: z.boolean(),
  /** True when a person said so, false when it was inferred from a state file. */
  explicit: z.boolean(),
});

/**
 * Everything the composer pill draws itself from, in one round trip.
 *
 * `enabled` rides along because it decides whether there is a pill at all: with the
 * feature switched off there is nothing for one to say, and a pill that read
 * "paused" would just be a second way of spelling off.
 */
export const EnrolmentStateSchema = z.object({
  showPill: z.boolean(),
  enabled: z.boolean(),
  /** Only agents with a state file or an explicit answer. Anyone absent is off. */
  agents: z.array(AgentEnrolmentSchema),
  /** The compact bands, so a pill can mark where its session will be asked. Optional for older daemons. */
  thresholds: ThresholdsSchema.optional(),
});
export type EnrolmentState = z.infer<typeof EnrolmentStateSchema>;

export const enrolmentState = defineRpc({
  name: "smart-session.enrolment.state",
  input: z.object({}),
  output: EnrolmentStateSchema,
});

export const setEnrolment = defineRpc({
  name: "smart-session.enrolment.set",
  input: z.object({ agentId: z.string(), enrolled: z.boolean() }),
  output: z.object({ agent: AgentEnrolmentSchema }),
});

/**
 * The instructions sent with `/compact`.
 *
 * Two jobs. It tells the summarizer what this particular task cannot afford to
 * lose, and — when the agent named a state file — it points the continuation at the
 * one thing on disk that is authoritative, so the quality of the summary stops
 * being load-bearing.
 */
export function compactionInstructions(request: {
  reason: string;
  statePath: string | null;
}): string {
  const parts = [
    "/compact",
    `Preserve: the current goal, the step in progress and its exact next action, decisions already made and why, and every approach already tried and rejected.`,
    `Discard: file contents already read, superseded plans, and tool output that has been acted on.`,
    `Reason for compacting now: ${request.reason}`,
  ];
  if (request.statePath !== null && request.statePath !== "") {
    parts.push(
      `Authoritative state lives at ${request.statePath}. Re-read that file before acting; where it disagrees with this summary, the file wins.`,
    );
  }
  return parts.join(" ");
}

/**
 * What the continuation is told, once the compaction has landed.
 *
 * This is the second and last message Paseo sends, and it exists because no hook
 * can do it. `PostCompact` cannot inject at all; `SessionStart:compact` injects
 * context but starts no turn — its `initialUserMessage` field is only ever read at
 * process startup; and `Stop` does not fire for a `/compact`, because a command
 * runs no model turn. All three were tested against 2.1.263 (`RESEARCH.md` §3.4).
 *
 * Deliberately short. The state file holds the task and the summary holds the
 * conversation, so restating either here would only give the continuation a third
 * account to reconcile.
 */
export function resumeInstructions(request: { statePath: string | null }): string {
  if (request.statePath === null || request.statePath === "") {
    return (
      "That compaction was the one you asked for. Pick the task back up from the summary above and carry on from the next action it describes — " +
      "and write your task state to disk with the checkpoint tool now, so the next one costs nothing."
    );
  }
  return (
    `That compaction was the one you asked for. Re-read ${request.statePath} and continue from its "Current step" section. ` +
    "Where the file disagrees with the summary above, the file is correct — it was written deliberately; the summary was compressed automatically. " +
    "Carry on from there without asking what to do next."
  );
}

/**
 * Resolves the optional second message after a queued compaction lands.
 *
 * Continuing remains the default for requests made by older plugin versions, but
 * the requesting agent can suppress the turn when its task is already complete or
 * replace the state-aware default with the exact next instruction it needs.
 */
export function continuationInstructions(request: {
  continueAfterCompaction: boolean;
  continuationMessage: string | null;
  statePath: string | null;
}): string | null {
  if (!request.continueAfterCompaction) return null;
  return request.continuationMessage ?? resumeInstructions({ statePath: request.statePath });
}
