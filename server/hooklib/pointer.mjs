/**
 * The state-file pointer, and the two ways it can reach the model.
 *
 * Compaction is the one moment the agent is deciding what it knows, so it is the
 * one moment worth spending an injection on. But `PostCompact` — the event that
 * knows a compaction happened — cannot inject: Claude Code validates
 * `hookSpecificOutput.hookEventName` against a union that does not contain it, and
 * rejects the whole output. So the pointer is written here as a small pending note
 * and delivered by whichever hook speaks first:
 *
 *   - `SessionStart` with `source: "compact"`, which fires in the emptied context
 *     and does accept `additionalContext`; or
 *   - the next `PostToolUse`, which is guaranteed to run.
 *
 * Whoever delivers it clears it, so it is said exactly once.
 *
 * Keyed by Paseo agent id when there is one, because that survives compaction
 * whatever Claude Code decides to do with the session id.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function pluginDir() {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(home, "plugin-data", "smart-session");
}

/** The same derivation the agent's `checkpoint` tool uses. */
export function statePath() {
  const override = process.env.SMART_SESSION_STATE_FILE;
  if (override !== undefined && override !== "") return override;
  const agentId = process.env.PASEO_AGENT_ID;
  if (agentId === undefined || agentId === "") return null;
  return join(pluginDir(), "state", `${agentId}.md`);
}

/** Seconds since the state file was last written, or null if there isn't one. */
export function stateAgeSeconds(path) {
  if (path === null || !existsSync(path)) return null;
  try {
    return Math.round((Date.now() - statSync(path).mtimeMs) / 1000);
  } catch {
    return null;
  }
}

const STALE_AFTER_SECONDS = 30 * 60;

/**
 * What the continuation needs to hear, given what is actually on disk.
 *
 * Returns null when there is nowhere to point — no agent id, no override — since
 * naming no file at all would be worse than silence.
 */
export function pointerText(path = statePath(), age = stateAgeSeconds(path)) {
  if (path === null) return null;
  if (age === null) {
    return (
      `No durable state file exists yet for this session (expected at ${path}). Everything not in the summary above is now gone. ` +
      "Before continuing, write down the goal, the step in progress and its exact next action, decisions made and why, and every approach already tried and rejected — then keep it current, so the next compaction costs nothing."
    );
  }
  const lines = [
    `Durable task state for this session is at ${path}. Re-read it before acting. Where it disagrees with the summary above, the file is correct — it was written deliberately; the summary was compressed automatically.`,
  ];
  // A state file older than the work it is supposed to describe is worse than
  // none, because it reads as authoritative. Say so plainly.
  if (age > STALE_AFTER_SECONDS) {
    lines.push(
      `Note: that file was last written ${Math.round(age / 60)} minutes ago, so it may predate recent work. Reconcile it against the summary and update it before continuing.`,
    );
  }
  return lines.join(" ");
}

function pointerPath(sessionId) {
  const agentId = process.env.PASEO_AGENT_ID;
  const key = agentId !== undefined && agentId !== "" ? agentId : sessionId;
  if (typeof key !== "string" || key === "") return null;
  return join(pluginDir(), "pointers", `${key.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function readNote(sessionId) {
  const path = pointerPath(sessionId);
  if (path === null) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeNote(sessionId, note) {
  const path = pointerPath(sessionId);
  if (path === null) return;
  try {
    mkdirSync(join(pluginDir(), "pointers"), { recursive: true });
    writeFileSync(path, JSON.stringify(note), "utf8");
  } catch {
    // A hook that cannot persist its note must still not break the turn.
  }
}

/** Leaves the pointer where either delivery path will find it. */
export function writePending(sessionId, text) {
  if (text === null) return;
  writeNote(sessionId, { at: new Date().toISOString(), text });
}

/**
 * Records that the pointer has already reached the model for this compaction.
 *
 * Measured on a real compaction: `SessionStart:compact` fires ~55ms *before*
 * `PostCompact`, so without this the later event would queue a note that the next
 * tool call repeats. The marker is left in place rather than deleted — the next
 * compaction overwrites it, and an absent file has to keep meaning "nothing
 * pending".
 */
export function markDelivered(sessionId) {
  writeNote(sessionId, { at: new Date().toISOString(), delivered: true });
}

/** Whether this compaction's pointer was already said, within `withinMs`. */
export function deliveredRecently(sessionId, withinMs) {
  const note = readNote(sessionId);
  if (note?.delivered !== true) return false;
  const at = Date.parse(note.at ?? "");
  return Number.isFinite(at) && Date.now() - at < withinMs;
}

/** The pending pointer, without consuming it — nothing is cleared until it is said. */
export function readPending(sessionId) {
  const note = readNote(sessionId);
  if (note === null || note.delivered === true) return null;
  return typeof note.text === "string" && note.text !== "" ? note.text : null;
}

/** Called only once the pointer has actually been written to stdout. */
export function clearPending(sessionId) {
  const path = pointerPath(sessionId);
  if (path === null) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // A stale note costs one repeated sentence, never a failed turn.
  }
}
