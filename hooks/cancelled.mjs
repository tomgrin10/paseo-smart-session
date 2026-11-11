/**
 * Notices a delivered `/compact` that Claude Code cancelled, so the governor can retry it.
 *
 * Paseo 0.16 cannot steer a message into a slash-command turn. A message that reaches an agent
 * while its `/compact` runs (an agent notification, a person's message) replaces the turn instead,
 * and Claude Code cancels the compaction: it writes `<local-command-stdout>Compaction canceled.`
 * to the transcript and the new prompt starts milliseconds later. No hook fires for the cancel
 * itself, and PostCompact never fires, so the transcript is the only witness.
 *
 * The hooks that run anyway look for it: `UserPromptSubmit` (the replacing prompt itself, the
 * common case) and `Stop` (a fallback at the end of the next turn). Each records it once in
 * `compaction-events.jsonl`, tied to the request it cancelled, and the governor settles that
 * request and queues the retry (`shared/governor.ts` `retryVerdict`). `UserPromptSubmit` also
 * tells the agent, which otherwise reads the line as a person cancelling it.
 *
 * Cheap when there is nothing to find: the transcript is read only while this agent has a
 * delivered, unconfirmed `/compact` from the last few minutes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BRIDGE, compactionEvents, compactions, confirmedAt } from "./ask.mjs";
import { forTools, readTail } from "./context.mjs";
import { pluginDir } from "./pointer.mjs";

/** Mirrors `CANCEL_EVENT`, `RETRY_LIMIT` and `RETRY_WINDOW_MS` in `shared/governor.ts` (tested). */
export const CANCEL_EVENT = "CompactCanceled";
export const RETRY_LIMIT = 2;
export const RETRY_WINDOW_MS = 60 * 60_000;

/** A new prompt this soon after the cancel is what cancelled it. Live and in the harness it was 18-28 ms. */
export const REPLACED_WITHIN_MS = 10_000;

/** How long after delivery a cancel is still looked for. The governor stops watching after 5 minutes. */
const LOOK_FOR_MS = 15 * 60_000;

/** Delivery is stamped after the send returns, so a very fast cancel can predate it slightly. */
const DELIVERY_SKEW_MS = 30_000;

const TRANSCRIPT_TAIL = 1024 * 1024;
const CANCEL_LINE = /<local-command-stdout>\s*Compaction canceled\.?\s*<\/local-command-stdout>/;

const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "";

/** A transcript row that is a new prompt, as opposed to the `/compact` command's own rows or a tool result. */
function isPrompt(row) {
  if (row.type === "queue-operation") return row.operation === "enqueue";
  if (row.type === "attachment") return row.attachment?.type === "queued_command";
  if (row.type !== "user" || row.isMeta === true) return false;
  const content = row.message?.content;
  if (Array.isArray(content) && content.some((part) => part?.type === "tool_result")) return false;
  return !/<command-name>|<local-command-caveat>|<local-command-stdout>/.test(textOf(content));
}

/**
 * The latest "Compaction canceled." at or after `sinceMs` in transcript text, and what cancelled it:
 * "replaced" when a prompt followed within `REPLACED_WITHIN_MS` (or this hook is that prompt, while
 * it is still that soon), else "stopped".
 */
export function cancelInTranscript(text, sinceMs, { prompting = false, now = Date.now() } = {}) {
  const rows = text.split("\n").flatMap((line) => {
    if (!line.includes("Compaction canceled") && !line.includes('"timestamp"')) return [];
    try {
      const row = JSON.parse(line);
      return row !== null && typeof row === "object" ? [row] : [];
    } catch {
      return [];
    }
  });
  let found = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.type === "system" && row.subtype === "local_command" && CANCEL_LINE.test(textOf(row.content)) && Date.parse(row.timestamp) >= sinceMs) {
      found = i;
      break;
    }
  }
  if (found === -1) return null;
  const at = rows[found].timestamp;
  const cancelled = Date.parse(at);
  const followed = rows.slice(found + 1).some((row) => {
    const t = Date.parse(row.timestamp ?? row.attachment?.timestamp);
    return Number.isFinite(t) && t >= cancelled && t - cancelled <= REPLACED_WITHIN_MS && isPrompt(row);
  });
  const cause = followed || (prompting && now - cancelled <= REPLACED_WITHIN_MS) ? "replaced" : "stopped";
  return { at, cause };
}

/** Mirrors `retryVerdict` in `shared/governor.ts` (tested against it). */
export function retryVerdict(items, item, cause, now) {
  if (cause === "stopped") return "stopped";
  const mine = items.filter((other) => other.agentId === item.agentId && other.id !== item.id);
  if (mine.some((other) => other.state === "pending" || other.state === "sending")) return "queued";
  const recent = mine.filter((other) => typeof other.retryOf === "string" && now - Date.parse(other.createdAt) < RETRY_WINDOW_MS);
  return recent.length >= RETRY_LIMIT ? "limit" : "retry";
}

/** What the agent is told, in the prompt that cancelled its compaction. */
export function cancelNotice(verdict) {
  const head = "Smart Session: the /compact you asked for was cancelled. This message reached you while it ran, and Paseo replaced the compaction turn with it. Nobody cancelled it on purpose.";
  switch (verdict) {
    case "retry":
      return `${head} Smart Session sends it again once this session is idle, so don't call request_compaction again: handle this message and end your turn.`;
    case "queued":
      return `${head} Another compaction is already queued and lands once this session is idle: handle this message and end your turn.`;
    case "limit":
      return forTools(`${head} It is not retried: this session already had ${RETRY_LIMIT} retries this hour. If you still need to compact, call request_compaction once this message is handled.`, BRIDGE);
    default:
      return null;
  }
}

/** The delivered, unconfirmed `/compact` this agent may have just lost, or null. */
function watched(items, events, agentId, now) {
  const recorded = new Set(events.filter((event) => event.event === CANCEL_EVENT).map((event) => event.requestId));
  const candidates = items.filter(
    (item) =>
      item.agentId === agentId &&
      item.state === "sent" &&
      typeof item.settledAt === "string" &&
      now - Date.parse(item.settledAt) < LOOK_FOR_MS &&
      (item.error === null || item.error === undefined) &&
      !recorded.has(item.id) &&
      confirmedAt(item, events) === null,
  );
  return candidates.sort((a, b) => Date.parse(b.settledAt) - Date.parse(a.settledAt))[0] ?? null;
}

/**
 * Records a cancelled `/compact` for the governor, once. Returns the agent's notice when `prompting`
 * (`UserPromptSubmit`) and the compaction was replaced, else null. Never throws.
 */
export function noteCancelledCompaction(event, { prompting = false, now = Date.now(), env = process.env } = {}) {
  try {
    const agentId = env.PASEO_AGENT_ID;
    if (typeof agentId !== "string" || agentId === "" || typeof event.transcript_path !== "string") return null;
    const items = compactions();
    const events = compactionEvents();
    const item = watched(items, events, agentId, now);
    if (item === null) return null;
    const text = readTail(event.transcript_path, TRANSCRIPT_TAIL);
    if (text === null) return null;
    const cancel = cancelInTranscript(text, Math.max(Date.parse(item.createdAt), Date.parse(item.settledAt) - DELIVERY_SKEW_MS), { prompting, now });
    if (cancel === null) return null;
    mkdirSync(pluginDir(), { recursive: true });
    writeFileSync(
      join(pluginDir(), "compaction-events.jsonl"),
      `${JSON.stringify({ at: cancel.at, event: CANCEL_EVENT, sessionId: event.session_id ?? null, agentId, requestId: item.id, cause: cancel.cause, recordedAt: new Date(now).toISOString() })}\n`,
      { flag: "a" },
    );
    return prompting ? cancelNotice(retryVerdict(items, item, cancel.cause, now)) : null;
  } catch {
    // Bookkeeping must never break the turn it is describing.
    return null;
  }
}
