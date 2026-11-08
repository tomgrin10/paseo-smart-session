/**
 * What every hook needs to know about the session it is running in.
 *
 * Two hooks now answer "how full is this context" — `context-threshold.mjs` on
 * `PostToolUse` and `ask-compact.mjs` on `Stop` — and they must not disagree. One
 * reading them differently from the other would mean the agent hears the number and
 * the advice from two different sessions.
 *
 * Everything here reads the tail of a file rather than the whole of it: these run
 * on the hot path, and the newest row is the only one that matters.
 */

import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

import { pluginDir } from "./pointer.mjs";

/** Enough tail to contain the last assistant message in any realistic transcript. */
const TAIL_BYTES = 256 * 1024;

/**
 * Defaults mirroring thresholds.shared.ts, used when the plugin has not written a
 * settings file yet. Kept in sync by a test that runs the hooks and checks where
 * they fire against the shared module's numbers.
 *
 * Two profiles because a percentage of the window is the wrong unit on its own:
 * what tires a context is the absolute prefix re-read every turn, so 30% of a
 * million tokens is a heavier context than 85% of two hundred thousand.
 */
export const DEFAULT_THRESHOLDS = {
  largeWindowFrom: 400_000,
  large: { notice: 15, closing: 22, compact: 30, now: 40 },
  small: { notice: 60, closing: 75, compact: 85, now: 90 },
};

export const BANDS = ["notice", "closing", "compact"];

export const DEFAULT_SETTINGS = {
  enabled: true,
  showPill: true,
  autoEnrol: true,
  freshStateMinutes: 30,
  thresholds: DEFAULT_THRESHOLDS,
};

/** The plugin's settings are the single source of truth when they exist. */
export function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(join(pluginDir(), "settings.json"), "utf8"));
    const merged = { ...DEFAULT_THRESHOLDS, ...(raw.thresholds ?? {}) };
    return {
      // Absent means an install that predates the switch, which was always meant
      // to be on once it could only ask rather than act.
      enabled: raw.enabled !== false,
      showPill: raw.showPill !== false,
      autoEnrol: raw.autoEnrol !== false,
      freshStateMinutes:
        typeof raw.freshStateMinutes === "number" && raw.freshStateMinutes > 0
          ? raw.freshStateMinutes
          : DEFAULT_SETTINGS.freshStateMinutes,
      thresholds: {
        largeWindowFrom: merged.largeWindowFrom ?? DEFAULT_THRESHOLDS.largeWindowFrom,
        large: withUpperLine(merged.large, DEFAULT_THRESHOLDS.large),
        small: withUpperLine(merged.small, DEFAULT_THRESHOLDS.small),
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * A saved profile, with the upper line filled in when it predates one.
 *
 * Mirrors `normalizeProfile` in thresholds.ts: the saved lower line is kept, and an
 * absent upper line keeps the default's distance above it, never falling below it.
 */
export function withUpperLine(saved, fallback) {
  const profile = { ...fallback, ...(saved ?? {}) };
  const compact = profile.compact;
  const migrated = Math.min(99, Math.max(fallback.now, compact + (fallback.now - fallback.compact)));
  const raw = typeof saved?.now === "number" && Number.isFinite(saved.now) ? saved.now : migrated;
  return { ...profile, now: Math.min(99, Math.max(Math.min(99, compact + 1), raw)) };
}

export function profileFor(maxTokens, thresholds) {
  return maxTokens >= thresholds.largeWindowFrom ? thresholds.large : thresholds.small;
}

/**
 * Whether this agent is one the governor may speak to.
 *
 * The same rule settings.server.ts resolves, duplicated here because a hook on the
 * hot path must not open a daemon connection to answer it: an explicit answer in
 * `enrolment.json` outranks the state-file inference in both directions, and the
 * inference itself only counts while `autoEnrol` is on.
 */
export function isEnrolled(agentId, settings = readSettings()) {
  if (typeof agentId !== "string" || agentId === "") return false;
  try {
    const overrides = JSON.parse(readFileSync(join(pluginDir(), "enrolment.json"), "utf8"));
    if (typeof overrides?.[agentId] === "boolean") return overrides[agentId];
  } catch {
    // No file, or one we cannot read: nobody has overridden anything.
  }
  if (!settings.autoEnrol) return false;
  try {
    return readdirSync(join(pluginDir(), "state")).includes(`${agentId}.md`);
  } catch {
    return false;
  }
}

/** The tail of a file as text, or null if it cannot be read. */
function tail(path, bytes) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Context occupancy from the last assistant message's usage.
 *
 * input + cache_read + cache_creation + output is the same arithmetic Claude Code
 * itself documents for a resumed session's `context_tokens`, so it is the
 * sanctioned way to ask "how much of the window is currently occupied".
 */
export function readContextTokens(transcriptPath) {
  const text = tail(transcriptPath, TAIL_BYTES);
  if (text === null) return null;
  const lines = text.split("\n");

  // Backwards: the newest assistant message wins, and a partial first line from
  // slicing mid-file simply fails to parse and is skipped.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || line === "" || !line.includes('"usage"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") continue;
    // A subagent's usage is its own window, not the main thread's.
    if (entry.isSidechain === true) continue;
    const usage = entry.message?.usage;
    if (usage === undefined) continue;
    const used =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.output_tokens ?? 0);
    return { used, model: entry.message?.model ?? null };
  }
  return null;
}

/**
 * Models whose context window is not the current default of 1M.
 *
 * The transcript records the resolved model id (`claude-opus-5`), never the config
 * alias (`opus[1m]`), so the suffix is not a signal. Every current Opus, Sonnet and
 * Fable model has a 1M window; Haiku and the older generations do not.
 */
const SMALL_WINDOW = /haiku|-3-|sonnet-3|opus-3|sonnet-4-5|opus-4-5|sonnet-4-20|opus-4-20/;

/**
 * The window size Paseo reported for this agent, from the recorder's own log.
 *
 * Read from the tail, like the transcript: this is the hot path, and the newest row
 * is the only one that matters.
 */
function recordedWindow() {
  const agentId = process.env.PASEO_AGENT_ID;
  if (agentId === undefined || agentId === "") return null;
  const month = new Date().toISOString().slice(0, 7);
  const text = tail(join(pluginDir(), `context-${month}.jsonl`), 64 * 1024);
  if (text === null) return null;

  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || !line.includes(agentId)) continue;
    try {
      const row = JSON.parse(line);
      if (row.agentId === agentId && typeof row.maxTokens === "number" && row.maxTokens > 0) {
        return row.maxTokens;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The window size for this session.
 *
 * Getting this wrong is worse than not warning at all: assuming 200k on a 1M
 * session warns at a fifth of the real occupancy and reports negative headroom.
 * So the first choice is what Paseo actually measured for this agent — recorded by
 * the plugin, read from the tail of its log — and the model table is the fallback.
 */
export function windowFor(model) {
  const override = Number(process.env.SMART_SESSION_CONTEXT_WINDOW ?? "");
  if (Number.isFinite(override) && override > 0) return override;

  const recorded = recordedWindow();
  if (recorded !== null) return recorded;

  if (typeof model === "string" && SMALL_WINDOW.test(model)) return 200_000;
  return 1_000_000;
}

/**
 * Occupancy, the window it is measured against, and the bands that apply.
 *
 * Returns null when the transcript says nothing yet — a session with no completed
 * assistant turn has no usage to read, and guessing would be worse than silence.
 */
export function occupancy(transcriptPath, settings = readSettings()) {
  const reading = readContextTokens(transcriptPath);
  if (reading === null) return null;
  const max = windowFor(reading.model);
  return {
    used: reading.used,
    max,
    model: reading.model,
    pct: Math.floor((reading.used / max) * 100),
    profile: profileFor(max, settings.thresholds),
  };
}
