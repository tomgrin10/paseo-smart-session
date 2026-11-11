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
import { formatCompactTokens, formatRelative } from "./format.ts";
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
  /** 0 for a request an agent or person made; n for the governor's nth retry of a cancelled one. */
  attempt: z.number(),
  /** The cancelled request this one retries, or null. */
  retryOf: z.string().nullable(),
  /** The retry queued for this one after it was cancelled, or null. */
  retriedBy: z.string().nullable(),
  /** When Claude Code cancelled this delivered `/compact` ("Compaction canceled."), or null. */
  cancelledAt: z.string().nullable(),
  /** What cancelled it: a message that replaced the turn, or a Stop with nothing after it. */
  cancelCause: z.enum(["replaced", "stopped"]).nullable(),
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

/** The session hook's record of a delivered `/compact` that Claude Code cancelled (`hooks/cancelled.mjs`). */
export const CANCEL_EVENT = "CompactCanceled";

/** Retries per agent per hour. A session that keeps getting messages mid-compaction gets this many, then a report. */
export const RETRY_LIMIT = 2;
export const RETRY_WINDOW_MS = 60 * 60_000;

export type CancelCause = "replaced" | "stopped";
export interface Cancellation {
  at: string;
  cause: CancelCause;
}

/**
 * Whether the session recorded that this delivered `/compact` was cancelled, and by what.
 *
 * Paseo 0.16 cannot steer a message into a slash-command turn, so a message that reaches an agent
 * while its `/compact` runs replaces the turn and Claude Code cancels the compaction ("replaced").
 * A Stop leaves the same line with no message after it ("stopped"). The hook ties its record to
 * the request it found delivered, so a record never applies to a different request.
 */
export function cancellation(
  item: Pick<CompactionRequest, "id" | "agentId" | "state" | "settledAt">,
  events: readonly { agentId?: unknown; event?: unknown; at?: unknown; requestId?: unknown; cause?: unknown }[],
): Cancellation | null {
  if (item.state !== "sent" || item.settledAt === null) return null;
  const record = events.find((event) => event.event === CANCEL_EVENT && event.agentId === item.agentId && event.requestId === item.id && typeof event.at === "string");
  if (record === undefined) return null;
  return { at: record.at as string, cause: record.cause === "stopped" ? "stopped" : "replaced" };
}

/**
 * What happens to a cancelled `/compact`: retried, or reported with the reason it was not.
 *
 * A Stop is a person's decision and is never retried. A replaced one is, at the next idle moment,
 * unless another request for the agent is already waiting (that one lands instead) or the agent
 * already had `RETRY_LIMIT` retries this hour. Mirrored by `retryVerdict` in `hooks/cancelled.mjs`.
 */
export type RetryVerdict = "retry" | "stopped" | "queued" | "limit";

export function retryVerdict(
  items: readonly Pick<CompactionRequest, "id" | "agentId" | "state" | "createdAt" | "retryOf">[],
  item: Pick<CompactionRequest, "id" | "agentId">,
  cause: CancelCause,
  now: number,
): RetryVerdict {
  if (cause === "stopped") return "stopped";
  const mine = items.filter((other) => other.agentId === item.agentId && other.id !== item.id);
  if (mine.some((other) => other.state === "pending" || other.state === "sending")) return "queued";
  const recent = mine.filter((other) => other.retryOf !== null && other.retryOf !== undefined && now - Date.parse(other.createdAt) < RETRY_WINDOW_MS);
  return recent.length >= RETRY_LIMIT ? "limit" : "retry";
}

/** What the governor writes on a cancelled `/compact`, per verdict. Says what happened and what happens next. */
export function cancelledError(verdict: RetryVerdict): string {
  switch (verdict) {
    case "retry": return "Cancelled while it ran: a message reached the agent mid-compaction and replaced the turn. Retried once the agent is idle.";
    case "queued": return "Cancelled while it ran: a message reached the agent mid-compaction and replaced the turn. Not retried: another compaction is already queued.";
    case "limit": return `Cancelled while it ran: a message reached the agent mid-compaction and replaced the turn. Not retried: ${RETRY_LIMIT} retries already this hour.`;
    case "stopped": return "Stopped while it ran, with no message after it. Not retried: a Stop is deliberate.";
  }
}

/**
 * What the last compaction did, in one line (the popover's "Last compaction").
 *
 * Invariant: a requested compaction either lands, or is retried and visibly reported; never silently
 * dropped. Every way a request can end has its own line here, and `compaction.test.ts` walks them.
 */
export function compactionLine(item: CompactionRequest | undefined, now: number): string {
  if (item === undefined) return "None yet";
  if (item.state === "pending" || item.state === "sending") return item.attempt > 0 ? `Interrupted · retry ${item.attempt} sent when idle` : "Queued · sent when this turn ends";
  if (item.state === "failed") return `Failed ${formatRelative(item.settledAt ?? item.createdAt, now)}`;
  if (item.state === "cancelled") return `Cancelled ${formatRelative(item.settledAt ?? item.createdAt, now)}`;
  // Delivered is not compacted: a /compact can be cancelled or fail (`confirmation`).
  const confirmed = confirmation(item);
  if (confirmed === null) {
    const sent = formatRelative(item.settledAt ?? item.createdAt, now);
    if (item.cancelCause === "stopped") return `Stopped · not retried · ${sent}`;
    if (item.cancelCause === "replaced") {
      if (item.retriedBy !== null) return `Interrupted · retry ${item.attempt + 1} sent when idle`;
      return item.error === cancelledError("limit") ? "Interrupted · retry limit reached" : "Interrupted · newer one queued";
    }
    return `${item.error !== null ? "Didn't compact" : "Not confirmed"} · sent ${sent}`;
  }
  const when = formatRelative(confirmed, now);
  const sizes = item.preTokens !== null && item.postTokens !== null ? ` · ${formatCompactTokens(item.preTokens)} → ${formatCompactTokens(item.postTokens)}` : "";
  return `${when}${sizes}${item.attempt > 0 ? ` · on retry ${item.attempt}` : ""}`;
}

/** The retry of a cancelled request: the same ask, queued again. */
export function retryRequest(item: CompactionRequest, id: string, createdAt: string): CompactionRequest {
  return {
    id,
    agentId: item.agentId,
    reason: item.reason,
    statePath: item.statePath,
    continueAfterCompaction: item.continueAfterCompaction,
    continuationMessage: item.continuationMessage,
    createdAt,
    state: "pending",
    settledAt: null,
    confirmedAt: null,
    error: null,
    preTokens: null,
    postTokens: null,
    resumedAt: null,
    attempt: item.attempt + 1,
    retryOf: item.id,
    retriedBy: null,
    cancelledAt: null,
    cancelCause: null,
  };
}

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
  attempt?: number;
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
  if (request.attempt !== undefined && request.attempt > 0) parts.push(retryLine(request.attempt));
  return parts.join(" ");
}

/** The last sentence of a retried `/compact`, which the timeline card reads back (`promptCard`). */
export function retryLine(attempt: number): string {
  return `Retry ${attempt}: the previous /compact was cancelled because a message reached the agent while it ran.`;
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
