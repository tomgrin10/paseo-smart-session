#!/usr/bin/env node
/**
 * The compaction hook, registered on two events because neither one can do the
 * whole job.
 *
 * `PostCompact` is the event that knows a compaction happened and carries the
 * summary and its trigger — but Claude Code's hook-output schema has no
 * `PostCompact` variant, so anything it returns in `hookSpecificOutput` is
 * rejected wholesale and injects nothing. It is used here for what it can do:
 * record the compaction, reset the threshold latch so the warnings are available
 * again in the emptied window, and leave the state-file pointer pending.
 *
 * `SessionStart` with `source: "compact"` runs in the fresh context and *does*
 * accept `additionalContext`, so it delivers the pointer. If it never fires, the
 * `PostToolUse` threshold hook delivers the same note on the next tool call.
 * Either way it is said exactly once — see hooks/pointer.mjs.
 */

import { isPublishHelper } from "./context.mjs";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearPending,
  deliveredRecently,
  markDelivered,
  pluginDir,
  pointerText,
  stateAgeSeconds,
  statePath,
  writePending,
} from "./pointer.mjs";
import { resetLedger } from "./asks.mjs";

/**
 * How recently SessionStart must have spoken for PostCompact to stay quiet.
 *
 * The two events are milliseconds apart for the same compaction; anything on this
 * scale separates "already said" from a genuinely new one.
 */
const SAME_COMPACTION_MS = 120_000;

function resetLatch(sessionId) {
  if (typeof sessionId !== "string") return;
  const path = join(pluginDir(), "thresholds", `${sessionId}.json`);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // A stale latch only costs a missed warning; never fail the turn over it.
  }
}

/** Records what compaction cost, so the policy can be graded later. */
function recordCompaction(event, eventName, age) {
  try {
    const dir = pluginDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "compaction-events.jsonl"),
      `${JSON.stringify({
        at: new Date().toISOString(),
        event: eventName,
        sessionId: event.session_id ?? null,
        agentId: process.env.PASEO_AGENT_ID ?? null,
        trigger: event.trigger ?? event.source ?? null,
        summaryChars: typeof event.compact_summary === "string" ? event.compact_summary.length : null,
        statePath: statePath(),
        stateAgeSeconds: age,
      })}\n`,
      { flag: "a" },
    );
  } catch {
    // Bookkeeping must never break the turn it is describing.
  }
}

/**
 * Which event this invocation is, without trusting a single field.
 *
 * `hook_event_name` is authoritative when present; the payload shape decides
 * otherwise, since only `SessionStart` carries `source`.
 */
function eventNameOf(event) {
  if (typeof event.hook_event_name === "string") return event.hook_event_name;
  return typeof event.source === "string" ? "SessionStart" : "PostCompact";
}

async function main() {
  if (isPublishHelper()) return;
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

  const eventName = eventNameOf(event);
  // Every other way a session starts — startup, clear, resume, fork — has its own
  // context and its own reasons; only compaction just destroyed something.
  if (eventName === "SessionStart" && event.source !== "compact") return;

  const sessionId = event.session_id;
  const path = statePath();
  const age = stateAgeSeconds(path);
  const text = pointerText(path, age);

  resetLatch(sessionId);
  // A new epoch: the occupancy the last ask was about no longer exists, so a
  // session that fills up again is entitled to be asked again.
  resetLedger(sessionId);
  recordCompaction(event, eventName, age);

  if (eventName !== "SessionStart") {
    // PostCompact cannot speak. Leave the note for whoever can — unless
    // SessionStart already said it moments ago for this same compaction.
    if (!deliveredRecently(sessionId, SAME_COMPACTION_MS)) writePending(sessionId, text);
    return;
  }

  if (text === null) return;
  clearPending(sessionId);
  markDelivered(sessionId);
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
      suppressOutput: true,
    })}\n`,
  );
}

void main();
