#!/usr/bin/env node
/**
 * Tells a detached session how to reach Smart Session's tools: on `PostToolUseFailure` for a `smart_*` call and on
 * `UserPromptSubmit`. (`PostToolUse` is covered by `context-threshold.mjs`, which already runs on every tool call.)
 *
 * A plugin update detaches native tools from every open session until Paseo reopens it, which it does only for a
 * prompt that arrives while the agent is idle. A failed `smart_*` call raises `PostToolUseFailure`, never
 * `PostToolUse` (Claude Code 2.1.322, verified end to end), and once the client re-lists its tools the agent may not
 * call `smart_*` at all, so the notice rides every hook that fires anyway. It is said once per agent per worker
 * instance (`detachedOnce`).
 *
 * On `UserPromptSubmit` it also looks for a `/compact` the prompt just cancelled (`cancelled.mjs`).
 */

import { BRIDGE } from "./ask.mjs";
import { noteCancelledCompaction } from "./cancelled.mjs";
import { detachedOnce, markDetachedTold } from "./context.mjs";

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
    return;
  }
  // Subagents share the parent's tools; the parent is told.
  if (event.agent_id !== undefined && event.agent_id !== null) return;
  const name = event.hook_event_name;
  if (name !== "PostToolUseFailure" && name !== "UserPromptSubmit") return;
  // The replacing prompt is the first thing to run after a cancelled /compact: record it and say so.
  const cancelled = name === "UserPromptSubmit" ? noteCancelledCompaction(event, { prompting: true }) : null;
  const notice = detachedOnce(BRIDGE);
  const text = [cancelled, notice?.text ?? null].filter((part) => part !== null).join("\n\n");
  if (text === "") return;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: name, additionalContext: text }, suppressOutput: true })}\n`);
  if (notice !== null) markDetachedTold(notice.instance);
}

void main().catch(() => {});
