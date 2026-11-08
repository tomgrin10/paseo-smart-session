#!/usr/bin/env node
/**
 * A PostToolUse hook that tells the agent how full it is — but only when that has
 * just become worth saying.
 *
 * Sensing is useless if the agent has to remember to ask. This runs after every
 * tool call, stays completely silent below the first threshold, and injects one
 * short line the moment context crosses each band. Each level fires once per
 * compaction epoch, so a long session gets three sentences, not three hundred.
 *
 * Below Smart Compact's upper line it only describes; the end-of-turn question at
 * the lower line is `ask-compact.mjs` on `Stop`. Past the upper line it asks right
 * away, because that is the line where the agent should not start anything new —
 * once per compaction epoch, again only after a deferral runs out, and through the
 * same guards as the `Stop` hook (`ask.mjs`).
 *
 * It reads the transcript rather than asking Paseo, so it works in any Claude Code
 * session, and it reads only the tail of it, because this runs on the hot path.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { askable, compose } from "./ask.mjs";
import { recordNowAsk, shouldAskNow } from "./asks.mjs";
import { BANDS, DEFAULT_THRESHOLDS, occupancy, readSettings } from "./context.mjs";
import { clearPending, pluginDir, readPending, statePath } from "./pointer.mjs";

function latchPathFor(sessionId) {
  return join(pluginDir(), "thresholds", `${sessionId}.json`);
}

function readLatch(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { fired: [], lastUsed: 0 };
  }
}

function writeLatch(path, latch) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(latch), "utf8");
  } catch {
    // A hook that cannot persist its latch must still not break the turn.
  }
}

/**
 * `band` chooses the urgency; `pct` and `used` describe the situation.
 *
 * On a large window the headline is the token count, not the percentage: "30% full"
 * sounds like there is plenty of room, and 300,000 tokens does not.
 */
function advice(band, pct, used, max, path) {
  const large = max >= DEFAULT_THRESHOLDS.largeWindowFrom;
  const lines = [
    `Context holds ${used.toLocaleString()} tokens (${pct}% of a ${max.toLocaleString()}-token window).`,
  ];

  if (band === "compact") {
    lines.push(
      large
        ? "That is a large enough context to be worth compacting now, even though the window is nowhere near full — what costs you is the prefix re-read on every turn, not the ceiling. Finish the step you are on and make sure your durable task state is on disk."
        : "This is the point where recall degrades noticeably and every turn re-reads an expensive prefix. Finish the step you are on and write your durable task state to disk — do not start a new large step first.",
    );
  } else if (band === "closing") {
    lines.push(
      "Start closing out the current step rather than opening a new one. Make sure your durable task state — goal, current step and its next action, decisions and why, and every approach already tried and rejected — is written to disk, not only held in this conversation.",
    );
  } else {
    lines.push(
      "Nothing is wrong yet. This is the moment to make sure your task state is on disk, so that compacting later is cheap rather than lossy.",
    );
  }

  if (path !== null) lines.push(`Your state file for this task: ${path}`);
  else lines.push("If you have not chosen a state file for this task yet, choose one now and write to it.");
  return lines.join(" ");
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

  // Subagents have their own short-lived windows and their own stop conditions;
  // warning them about the main thread's occupancy would be noise.
  if (event.agent_id !== undefined && event.agent_id !== null) return;
  const transcriptPath = event.transcript_path;
  const sessionId = event.session_id;
  if (typeof transcriptPath !== "string" || typeof sessionId !== "string") return;

  // A compaction may have left a state-file pointer that no other hook could
  // deliver. Said first, because it changes what the agent thinks it knows.
  const parts = [];
  const pending = readPending(sessionId);
  if (pending !== null) parts.push(pending);

  const now = occupancy(transcriptPath, readSettings());
  if (now === null) return emit(sessionId, parts, pending);

  const latchPath = latchPathFor(sessionId);
  const latch = readLatch(latchPath);

  // A compaction resets the epoch: the window emptied, so the warnings should be
  // available again. Detected as a large drop rather than any drop, because usage
  // wobbles by a few tokens between turns.
  if (latch.lastUsed > 0 && now.used < latch.lastUsed * 0.6) latch.fired = [];
  latch.lastUsed = now.used;

  const reached = BANDS.filter((band) => now.pct >= now.profile[band]);
  const crossed = reached.filter((band) => !latch.fired.includes(band));
  latch.fired = [...new Set([...latch.fired, ...crossed])];
  writeLatch(latchPath, latch);

  // Past the upper line, the question replaces the description: it says everything
  // the band line would, and two messages about the same moment read as two.
  const asked = now.pct >= now.profile.now ? askNow(event) : null;
  if (asked !== null) {
    parts.push(asked.text);
    emit(sessionId, parts, pending);
    // Recorded only once it has reached stdout, like the `Stop` hook's ask.
    recordNowAsk(sessionId, asked.ledger);
    return;
  }

  // A session that jumped two bands in one turn hears the more urgent one.
  if (crossed.length > 0) parts.push(advice(crossed[crossed.length - 1], now.pct, now.used, now.max, statePath()));
  return emit(sessionId, parts, pending);
}

/** The upper line's question, or null when one of the shared guards says no. */
function askNow(event) {
  try {
    const context = askable(event);
    if (context === null) return null;
    return compose(context, "now", (ledger) => shouldAskNow(ledger));
  } catch {
    return null; // The ask is never worth failing the tool call it rides on.
  }
}

/**
 * Writes whatever there is to say, and only then forgets the pending pointer:
 * clearing it before it reaches stdout would lose it on any later failure.
 */
function emit(sessionId, parts, pending) {
  if (parts.length === 0) return;
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: parts.join("\n\n") },
      suppressOutput: true,
    })}\n`,
  );
  if (pending !== null) clearPending(sessionId);
}

void main();
