#!/usr/bin/env node
/**
 * A `Stop` hook that asks the session to compact itself — and nothing else.
 *
 * This is the piece that keeps compaction agent-mandated. The plugin never decides
 * to compact a session and never sends it a message to say so; it puts the question
 * at the one moment where acting on it is safe, and the agent answers with its own
 * tool call. What Paseo sends is the `/compact` the agent asked for.
 *
 * `Stop` is the right event for three reasons, all of them verified against Claude
 * Code 2.1.263 rather than assumed (`RESEARCH.md` §3.4):
 *
 *   - it fires at a turn boundary, which is exactly the moment the governor used to
 *     sit in a fifteen-second poll waiting for;
 *   - its `additionalContext` is documented as "non-error feedback delivered to the
 *     model; the conversation continues so the model can act on it", so the ask
 *     costs no extra turn and needs no `decision: "block"`; and
 *   - its payload carries `background_tasks`, which is how a hook tells "this
 *     session is done" from "this session is waiting on work still in flight".
 *
 * It stays completely silent unless there is something worth stopping for.
 *
 * This is the lower of Smart Compact's two lines. The upper one asks mid-turn from
 * `context-threshold.mjs`; the text and the guards both use are in `ask.mjs`.
 */

import { askable, compose } from "./ask.mjs";
import { noteCancelledCompaction } from "./cancelled.mjs";
import { recordAsk, shouldAsk } from "./asks.mjs";

function emit(text) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "Stop", additionalContext: text },
      suppressOutput: true,
    })}\n`,
  );
}

async function main() {
  const raw = await new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => resolve(input));
  });

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return; // Not our business to complain about a malformed event.
  }

  // Claude Code overrides a hook that keeps a turn alive too many times in a row,
  // and tells you to check this flag. A second ask would also be arriving into the
  // turn the first one created, which is not a boundary at all.
  if (event.stop_hook_active === true) return;

  // Subagents have their own short-lived windows and their own stop conditions.
  if (event.agent_id !== undefined && event.agent_id !== null) return;

  // A /compact cancelled since the last turn, in case UserPromptSubmit missed it. Recorded only: text
  // on Stop would start another model turn.
  noteCancelledCompaction(event);

  // "Stopped" and "waiting for work that is still running" are different states.
  // Compacting through the second one discards the context that work reports into.
  if (Array.isArray(event.background_tasks) && event.background_tasks.length > 0) return;

  // The lower line, "when convenient". Past the upper one the agent was already
  // asked mid-turn by `context-threshold.mjs`; this is the turn-end follow-up, under
  // this line's own back-off, unless that ask was answered.
  const context = askable(event);
  if (context === null) return;
  const decision = compose(context, "compact", shouldAsk);
  if (decision === null) return;

  // Recorded only after it has reached stdout: a latch set on an ask that was never
  // delivered would silence the next one for nothing.
  emit(decision.text);
  recordAsk(context.sessionId, decision.ledger, context.reading.pct);
}

void main();
