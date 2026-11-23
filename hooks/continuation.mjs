/**
 * Carries a compaction's continuation on the prompt that reached the session before the governor could send it.
 *
 * Root cause (2026-11-23): an agent asked to compact and carry on; the compaction landed and a person's message
 * started a turn at once. The governor sends the continuation only at an idle moment and watched for 5 minutes, so
 * the busy session never got it. Now a confirmed compaction owes its continuation until it is delivered: by the
 * governor at the next idle moment, or here, as `additionalContext` on the `UserPromptSubmit` that came first. The
 * two never both deliver it: whoever claims it first does (`server/hooklib/continuation.mjs`).
 *
 * `UserPromptSubmit`'s `additionalContext` reaches the model (`RESEARCH.md` §3.5 and §3.6, Claude Code 2.1.322).
 */

import { compactionEvents, compactions, confirmedAt } from "./ask.mjs";
import { claimContinuation } from "../server/hooklib/continuation.mjs";

/** Mirrors `CONTINUATION_CAP_MS` in `shared/governor.ts` (tested). */
export const CONTINUATION_CAP_MS = 2 * 60 * 60_000;

/** Mirrors `resumeInstructions` in `shared/governor.ts` (tested). */
export function resumeInstructions(statePath) {
  if (statePath === null || statePath === undefined || statePath === "") {
    return (
      "That compaction was the one you asked for. Pick the task back up from the summary above and carry on from the next action it describes — " +
      "and write your task state to disk with the checkpoint tool now, so the next one costs nothing."
    );
  }
  return (
    `That compaction was the one you asked for. Re-read ${statePath} and continue from its "Current step" section. ` +
    "Where the file disagrees with the summary above, the file is correct — it was written deliberately; the summary was compressed automatically. " +
    "Carry on from there without asking what to do next."
  );
}

/** Mirrors `promptContinuation` in `shared/governor.ts` (tested). */
export function promptContinuation(continuation) {
  return `Smart Compact: before compacting you asked to carry on with: ${continuation} Answer this message first, then carry on with that if it still applies.`;
}

/** Mirrors `continuationOwed` in `shared/governor.ts` (tested). */
export function owedSince(item, events) {
  if (item.continueAfterCompaction === false) return null;
  if (typeof item.resumedAt === "string" || typeof item.resumedVia === "string") return null;
  if (typeof item.cancelledAt === "string" || typeof item.retriedBy === "string" || typeof item.error === "string") return null;
  const confirmed = confirmedAt(item, events);
  if (confirmed === null || typeof item.confirmedAt === "string" || typeof item.postTokens === "number") return confirmed;
  return Date.parse(confirmed) - Date.parse(item.settledAt) <= LANDS_WITHIN_MS ? confirmed : null;
}

/** Mirrors `LANDS_WITHIN_MS` in `shared/governor.ts` (tested). */
export const LANDS_WITHIN_MS = 15 * 60_000;

/**
 * The continuation this prompt carries, claimed so the governor won't send it too, or null. Never throws.
 * A `/compact` prompt carries nothing: its turn is a command, not one the model answers.
 */
export function continuationNotice(event, { now = Date.now(), env = process.env } = {}) {
  try {
    const agentId = env.PASEO_AGENT_ID;
    if (typeof agentId !== "string" || agentId === "") return null;
    if (typeof event.prompt === "string" && /^\s*\/compact\b/.test(event.prompt)) return null;
    const events = compactionEvents();
    const owed = compactions()
      .filter((item) => item?.agentId === agentId)
      .map((item) => ({ item, since: owedSince(item, events) }))
      .filter(({ since }) => since !== null && now - Date.parse(since) <= CONTINUATION_CAP_MS)
      .sort((a, b) => Date.parse(b.since) - Date.parse(a.since))[0];
    if (owed === undefined) return null;
    const message = typeof owed.item.continuationMessage === "string" && owed.item.continuationMessage !== "" ? owed.item.continuationMessage : resumeInstructions(owed.item.statePath);
    if (!claimContinuation(owed.item.id, "prompt", now)) return null;
    return promptContinuation(message);
  } catch {
    return null;
  }
}
