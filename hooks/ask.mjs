/**
 * Smart Compact's question, shared by the two hooks that put it.
 *
 * There are two lines per window. Past the lower one, `ask-compact.mjs` on `Stop`
 * asks at the end of a turn, when it is convenient. Past the upper one,
 * `context-threshold.mjs` on `PostToolUse` asks right away, mid-turn, because a
 * session that far along should not start anything new before compacting. Both
 * read the same settings, the same enrolment, the same queue and the same ledger,
 * and the guards live here so the two can never disagree about whether to speak.
 *
 * Either way the plugin only asks. The agent answers with its own tool call, and
 * a queued compaction is still delivered once the session goes idle.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { forTools, isEnrolled, occupancy, readSettings } from "./context.mjs";
import { fileURLToPath } from "node:url";
import { dirname as parentOf } from "node:path";

/**
 * The one-call bridge a detached session is pointed at. The stable shim in the data
 * directory when it exists, since this install's own path is gone after the next update;
 * otherwise the `mcp.mjs` beside these hooks.
 */
const BRIDGE_SHIM = join(pluginDir(), "hooks", "mcp.mjs");
export const BRIDGE = existsSync(BRIDGE_SHIM) ? BRIDGE_SHIM : join(parentOf(fileURLToPath(import.meta.url)), "..", "mcp.mjs");
import { pluginDir, stateAgeSeconds, statePath } from "./pointer.mjs";
import { readLedger } from "./asks.mjs";

/**
 * A compaction that had to be repeated within minutes is not solving the problem —
 * something in the loop is refilling the window as fast as it is emptied, and
 * another compaction just burns tokens on summarizing. Claude Code detects the same
 * pathology and calls it thrashing.
 */
export const THRASH_WINDOW_MS = 15 * 60_000;

/** The governor's queue, read directly: a hook must not open a daemon connection. */
export function compactions() {
  try {
    const parsed = JSON.parse(readFileSync(join(pluginDir(), "compactions.json"), "utf8"));
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

/** Already asked and waiting to be delivered: there is nothing to add. */
export function alreadyQueued(items, agentId) {
  return items.some(
    (item) => item.agentId === agentId && (item.state === "pending" || item.state === "sending"),
  );
}

export function thrashing(items, agentId, now = Date.now()) {
  return items.some(
    (item) =>
      item.agentId === agentId &&
      item.state === "sent" &&
      item.settledAt !== null &&
      now - Date.parse(item.settledAt) < THRASH_WINDOW_MS,
  );
}

function headline({ used, max, pct }) {
  return `this session holds ${used.toLocaleString()} tokens (${pct}% of a ${max.toLocaleString()}-token window)`;
}

function why(max) {
  return max >= 400_000
    ? "That is worth compacting now even though the window is nowhere near full — what costs you is the prefix re-read on every turn, not the ceiling."
    : "This is the point where recall degrades noticeably and every turn re-reads an expensive prefix.";
}

/** The checkpoint half of either ask, which depends on how old the state file is. */
function checkpointStep(path, age, freshMinutes, then) {
  if (age === null) {
    return `There is no task state on disk yet. Call checkpoint — goal, the step in progress and its exact next action, decisions and why, and every approach already tried and rejected — then ${then} Anything you do not write down is gone after the compaction.`;
  }
  if (age > freshMinutes * 60) {
    return `Your task state at ${path} was last written ${Math.round(age / 60)} minutes ago, so it may predate recent work. Call checkpoint to bring it up to date, then ${then}`;
  }
  return null;
}

/**
 * The end-of-turn question, at the lower line.
 *
 * On a large window the headline is the token count, not the percentage: "30% full"
 * sounds like there is plenty of room, and 300,000 tokens does not.
 *
 * It has to be answerable in one turn, so it names the tools and says what to do
 * with each, and it has to be refusable, or it is not a question — hence the
 * deferral, which the agent is told about in the same breath.
 */
export function askAtTurnEnd(reading, path, age, freshMinutes) {
  const lines = [
    `Smart Compact: ${headline(reading)}.`,
    why(reading.max),
    "Compacting is your call, not this plugin's, and nothing will happen unless you ask. Do one of these before you stop:",
  ];
  const stale = checkpointStep(path, age, freshMinutes, "call request_compaction.");
  lines.push(
    stale !== null
      ? `1. ${stale}`
      : `1. Your task state at ${path} is current, so this is cheap: call request_compaction with a one-line reason. If work remains, ask it to continue (and optionally choose the follow-up message); if the task is finished, ask it not to continue.`,
  );
  lines.push(
    "2. Or, if this is the wrong moment — mid-refactor, a tool sequence half finished, an answer the user is waiting on — call defer_compaction with a reason and you will not be asked again for a while.",
    "Either way, do it now and then stop. A queued compaction is delivered as a real /compact once this session goes idle; a follow-up turn is sent only if you requested one.",
  );
  return forTools(lines.join("\n"), BRIDGE);
}

/**
 * The mid-turn question, at the upper line.
 *
 * It arrives after a tool call, in the middle of the agent's work, so it says what
 * to finish (only the step already under way) and what not to start. The compaction
 * still lands only once the session is idle, which is why it ends with "then end
 * your turn": without that the agent would queue it and carry on for an hour.
 */
export function askRightAway(reading, upper, path, age, freshMinutes) {
  const lines = [
    `Smart Compact: ${headline(reading)}, past its upper line of ${upper}%.`,
    `This is the line where you should not push on. ${why(reading.max)}`,
    "Finish only the atomic step you are on — the edit half applied, the command already running — and do not start a new step, read a large file or begin another tool sequence. Then:",
  ];
  const stale = checkpointStep(path, age, freshMinutes, "go on to step 2.");
  lines.push(stale !== null ? `1. ${stale}` : `1. Your task state at ${path} is current, so go straight to step 2.`);
  lines.push(
    "2. Call request_compaction with continue_after_compaction set to true and a one-line reason. If you know the next action, put it in continue_message so the follow-up names it.",
    "3. End your turn. The compaction is delivered as a real /compact once this session goes idle, so it cannot land while you keep working.",
    "If stopping now would leave something broken that the next turn could not pick up, call defer_compaction with that reason instead — you will be asked again when it runs out. Do not defer just to keep going.",
  );
  return forTools(lines.join("\n"), BRIDGE);
}

/**
 * What to say instead, when compacting is not the answer.
 *
 * Said once, as an ask, so it counts against the same latch: repeating it every
 * turn would be the nagging these hooks exist to avoid.
 */
export function thrashAdvice({ used, pct }) {
  return forTools([
    `Smart Compact: this session refilled to ${used.toLocaleString()} tokens (${pct}%) within minutes of its last compaction.`,
    "Compacting again would not help — something in this loop is reading far more than it keeps, so the window would refill just as fast and you would pay for another summary.",
    "Write what you have learned to your state file with checkpoint, then either change the approach so it stops re-reading the same material, or finish and let a fresh session take the rest.",
  ].join("\n"), BRIDGE);
}

/**
 * Whether there is anyone to ask, and how full they are.
 *
 * The guards both hooks share: a subagent is never asked (its window is its own),
 * Smart Compact must be on, the session must be enrolled, and the transcript must
 * have a reading. Returns null whenever the answer is "say nothing".
 */
export function askable(event) {
  if (event.agent_id !== undefined && event.agent_id !== null) return null;
  const transcriptPath = event.transcript_path;
  const sessionId = event.session_id;
  if (typeof transcriptPath !== "string" || typeof sessionId !== "string") return null;

  const settings = readSettings();
  if (!settings.enabled) return null;

  const agentId = process.env.PASEO_AGENT_ID ?? null;
  if (!isEnrolled(agentId, settings)) return null;

  const reading = occupancy(transcriptPath, settings);
  if (reading === null) return null;
  return { sessionId, agentId, settings, reading };
}

/**
 * The text to put to the agent at one of the two lines, or null for silence.
 *
 * `line` is "compact" (end of turn) or "now" (right away). `allowed` is that
 * line's own back-off rule over the ledger. The queue is read last because it is
 * the most expensive check and the others usually decide first.
 */
export function compose(context, line, allowed) {
  const { sessionId, agentId, settings, reading } = context;
  if (reading.pct < reading.profile[line]) return null;

  const ledger = readLedger(sessionId);
  if (!allowed(ledger, reading.pct)) return null;

  const queue = compactions();
  if (alreadyQueued(queue, agentId)) return null;

  const path = statePath();
  const age = stateAgeSeconds(path);
  let text;
  if (thrashing(queue, agentId)) text = thrashAdvice(reading);
  else if (line === "now") text = askRightAway(reading, reading.profile.now, path, age, settings.freshStateMinutes);
  else text = askAtTurnEnd(reading, path, age, settings.freshStateMinutes);
  return { text, ledger };
}
