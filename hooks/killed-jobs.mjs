/**
 * Background jobs a session restart killed, named to the agent once each so it reruns them or reports why not.
 *
 * Paseo 0.16 closes an agent's Claude process whenever it reopens the session: on the agent's first prompt after a
 * reload of any plugin with an `agent.open.before` hook (every plugin with native agent tools), and on every refresh
 * (a ZeroSub account move). The `run_in_background` shells and Monitors go with it. The dying process writes
 * `<status>killed</status>` for each, but that notice is never delivered. The next process, once something starts it,
 * writes one `<status>stopped</status>` "didn't finish before the previous session ended" notice and starts a turn on
 * it, and that turn can be cut by the next reopen in turn. 2026-11-11: a render job died at 14:20, its agent sat idle
 * 25 minutes, and the notice turn that finally came was cut before the agent replied (`RESEARCH.md` §3.7).
 *
 * Invariant: no agent ends a turn idle while a job the restart killed was never rerun or reported. `UserPromptSubmit`
 * (`detached.mjs`) and `Stop` (`ask-compact.mjs`) both look; whichever fires first in a turn says it, once per job
 * (latch `killed-jobs/<agentId>.json`). The "stopped" notice is the evidence: Claude Code writes it only for tasks it
 * started and never saw finish. A job started again after it (same description or command) counts as rerun.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readTail } from "./context.mjs";
import { pluginDir } from "./pointer.mjs";

/** Notices older than this are history, not news: the agent has had turns since. */
export const LOOK_BACK_MS = 2 * 60 * 60_000;

const TRANSCRIPT_TAIL = 2 * 1024 * 1024;
const STOPPED = "didn't finish before the previous session ended";
const STARTED = [/Command running in background with ID: ([A-Za-z0-9_-]+)/, /Monitor started \(task ([A-Za-z0-9_-]+)/];
const KEEP_TOLD = 200;

const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : textOf(part?.content))).join("") : "";

function parseRows(text) {
  return text.split("\n").flatMap((line) => {
    if (line === "") return [];
    try {
      const row = JSON.parse(line);
      return row !== null && typeof row === "object" ? [row] : [];
    } catch {
      return []; // The tail's first line is usually cut.
    }
  });
}

/** Task ids in one "stopped ... didn't finish" notice, without Claude Code's `__orphan_summary__` scan markers. */
function stoppedTasks(content) {
  if (!content.includes("<task-notification>") || !content.includes(STOPPED) || !/<status>stopped<\/status>/.test(content)) return [];
  return [...content.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map((m) => m[1].trim()).filter((id) => id !== "" && !id.startsWith("__orphan"));
}

/**
 * Jobs the transcript says a restart killed within `LOOK_BACK_MS` of `now` and that were not started again since:
 * `{ taskId, kind: "shell"|"monitor", description, command, stoppedAt }`, oldest first.
 */
export function killedJobs(text, { now = Date.now() } = {}) {
  const rows = parseRows(text);
  const starts = new Map(); // tool_use id -> start
  const tasks = new Map(); // task id -> start
  const later = []; // every start, with its time, for the rerun check
  const stopped = new Map(); // task id -> stoppedAt
  for (const row of rows) {
    const content = row.message?.content;
    if (row.type === "assistant" && Array.isArray(content)) {
      for (const part of content) {
        if (part?.type !== "tool_use") continue;
        const input = part.input ?? {};
        const kind = part.name === "Monitor" ? "monitor" : part.name === "Bash" && input.run_in_background === true ? "shell" : null;
        if (kind === null) continue;
        const start = { kind, description: typeof input.description === "string" ? input.description : null, command: typeof input.command === "string" ? input.command : null, at: Date.parse(row.timestamp) };
        starts.set(part.id, start);
        later.push(start);
      }
    } else if (row.type === "user" && Array.isArray(content)) {
      for (const part of content) {
        if (part?.type !== "tool_result" || !starts.has(part.tool_use_id)) continue;
        const result = textOf(part.content);
        const id = STARTED.map((re) => result.match(re)?.[1]).find(Boolean);
        if (id) tasks.set(id, starts.get(part.tool_use_id));
      }
    }
    if (row.type === "queue-operation" && row.operation === "enqueue" && typeof row.content === "string") {
      for (const id of stoppedTasks(row.content)) if (!stopped.has(id)) stopped.set(id, row.timestamp);
    }
  }
  const jobs = [];
  for (const [taskId, stoppedAt] of stopped) {
    const when = Date.parse(stoppedAt);
    if (!Number.isFinite(when) || now - when > LOOK_BACK_MS) continue;
    const start = tasks.get(taskId) ?? null;
    const rerun = start !== null && later.some((other) => other !== start && other.at >= when && ((start.description !== null && other.description === start.description) || (start.command !== null && other.command === start.command)));
    if (rerun) continue;
    jobs.push({ taskId, kind: start?.kind ?? "shell", description: start?.description ?? null, command: start?.command ?? null, stoppedAt });
  }
  return jobs.sort((a, b) => Date.parse(a.stoppedAt) - Date.parse(b.stoppedAt));
}

const clock = (iso) => `${new Date(iso).toISOString().slice(11, 16)} UTC`;

/** What the agent is told. */
export function killedNotice(jobs) {
  const lines = jobs.map((job) => {
    const what = job.description !== null ? `"${job.description}" (task ${job.taskId})` : job.command !== null ? `\`${job.command.split("\n")[0].slice(0, 80)}\` (task ${job.taskId})` : `task ${job.taskId}`;
    return `- ${job.kind === "monitor" ? "Monitor " : ""}${what}, reported stopped at ${clock(job.stoppedAt)}`;
  });
  const one = jobs.length === 1;
  return [
    `Smart Session: this session was restarted (a plugin reload or an account move reopens it), and the restart ended ${one ? "a background job" : "background jobs"} you started before it:`,
    ...lines,
    `${one ? "It is" : "They are"} not running and will not report back. Before you end this turn, rerun ${one ? "it" : "each one"} now if the work still matters (check the output file for partial results first), or tell whoever is waiting on ${one ? "it" : "them"} why not.`,
  ].join("\n");
}

function latchPath(agentId) {
  return join(pluginDir(), "killed-jobs", `${String(agentId).replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function told(agentId) {
  try {
    const data = JSON.parse(readFileSync(latchPath(agentId), "utf8"));
    return data !== null && typeof data.told === "object" && data.told !== null ? data.told : {};
  } catch {
    return {};
  }
}

/** Marks these jobs told for this agent. Call once the notice has reached stdout. */
export function markKilledTold(agentId, jobs, now = Date.now()) {
  try {
    const all = { ...told(agentId) };
    for (const job of jobs) all[job.taskId] = new Date(now).toISOString();
    const kept = Object.fromEntries(Object.entries(all).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).slice(0, KEEP_TOLD));
    mkdirSync(join(pluginDir(), "killed-jobs"), { recursive: true });
    writeFileSync(latchPath(agentId), JSON.stringify({ told: kept }));
  } catch {
    // Telling again is better than failing the hook.
  }
}

/**
 * The notice for this agent's killed jobs not yet told, and the jobs it names, or null. Never throws. The caller
 * writes the text and then calls `markKilledTold(agentId, jobs)`.
 */
export function killedJobsNotice(event, { now = Date.now(), env = process.env } = {}) {
  try {
    const agentId = env.PASEO_AGENT_ID;
    if (typeof agentId !== "string" || agentId === "" || typeof event.transcript_path !== "string") return null;
    const text = readTail(event.transcript_path, TRANSCRIPT_TAIL);
    if (text === null || !text.includes(STOPPED)) return null;
    const already = told(agentId);
    const jobs = killedJobs(text, { now }).filter((job) => !(job.taskId in already));
    if (jobs.length === 0) return null;
    return { agentId, jobs, text: killedNotice(jobs) };
  } catch {
    return null;
  }
}
