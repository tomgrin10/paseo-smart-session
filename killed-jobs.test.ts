/**
 * Background jobs a session restart killed (2026-11-11). Paseo 0.16 closes an agent's Claude process whenever it
 * reopens the session: on the first prompt after a plugin reload, and on every refresh (a ZeroSub account move).
 * The process takes its `run_in_background` shells and Monitors with it. The dying process's own "was stopped"
 * notice is never delivered; the next process says "didn't finish before the previous session ended" once, and that
 * turn can itself be cut by the next reopen. The agent then sat idle for 25 minutes with nothing running.
 *
 * Invariant: no agent ends a turn idle while a job the restart killed was never rerun or reported. The
 * `UserPromptSubmit` and `Stop` hooks name every such job once, with "rerun it now or report why not".
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as hook from "./hooks/killed-jobs.mjs";

const AGENT = "11111111-2222-3333-4444-555555555555";
const t0 = Date.parse("2026-11-11T14:10:00.000Z");
const at = (minutes: number) => new Date(t0 + minutes * 60_000).toISOString();
const jsonl = (rows: object[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

const bashStart = (id: string, description: string, command: string, minutes: number) => ({
  type: "assistant", timestamp: at(minutes),
  message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command, description, run_in_background: true } }] },
});
const bashStarted = (id: string, task: string, minutes: number) => ({
  type: "user", timestamp: at(minutes),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `Command running in background with ID: ${task}. Output is being written to: /tmp/x/tasks/${task}.output` }] },
});
const monitorStart = (id: string, description: string, minutes: number) => ({
  type: "assistant", timestamp: at(minutes),
  message: { role: "assistant", content: [{ type: "tool_use", id, name: "Monitor", input: { command: "until false; do sleep 5; done", description, timeout_ms: 1_800_000 } }] },
});
const monitorStarted = (id: string, task: string, minutes: number) => ({
  type: "user", timestamp: at(minutes),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `Monitor started (task ${task}, expires in 30m unless the source ends first).` }] },
});
// What the dying process writes (never delivered) and what the next one writes on start.
const killedByTeardown = (task: string, description: string, minutes: number) => ({
  type: "queue-operation", operation: "enqueue", timestamp: at(minutes),
  content: `<task-notification>\n<task-id>${task}</task-id>\n<status>killed</status>\n<summary>Background command "${description}" was stopped</summary>\n</task-notification>`,
});
const stoppedOne = (task: string, minutes: number) => ({
  type: "queue-operation", operation: "enqueue", timestamp: at(minutes),
  content: `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>stopped</status>\n<summary>Background shell command didn't finish before the previous session ended</summary>\n<note>No completion record was found for it in the previous session.</note>\n</task-notification>`,
});
const stoppedMany = (tasks: string[], minutes: number) => ({
  type: "queue-operation", operation: "enqueue", timestamp: at(minutes),
  content: `<task-notification>\n${tasks.map((task) => `<task-id>${task}</task-id>\n`).join("")}<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>\n<summary>${tasks.length} background shell command tasks didn't finish before the previous session ended. Task ids: ${tasks.join(", ")}.</summary>\n</task-notification>`,
});
const completed = (task: string, minutes: number) => ({
  type: "queue-operation", operation: "enqueue", timestamp: at(minutes),
  content: `<task-notification>\n<task-id>${task}</task-id>\n<status>completed</status>\n<summary>Background command "x" completed (exit code 0)</summary>\n</task-notification>`,
});

// The e5a9ef53 shape: render job started, refresh kills it, next process reports it 25 minutes later.
const renderKilled = [
  bashStart("toolu_r", "Render sheet: loaded and blocked images", "node scripts/screenshots.mjs --only sheet", 0),
  bashStarted("toolu_r", "bx9npminm", 0.01),
  killedByTeardown("bx9npminm", "Render sheet: loaded and blocked images", 10),
  stoppedOne("bx9npminm", 35),
];

test("a job the restart killed is found, named by its description", () => {
  const jobs = hook.killedJobs(jsonl(renderKilled), { now: t0 + 36 * 60_000 });
  assert.deepEqual(jobs.map((job) => [job.taskId, job.kind, job.description]), [["bx9npminm", "shell", "Render sheet: loaded and blocked images"]]);
  assert.equal(jobs[0].stoppedAt, at(35));
});

test("one notice for several jobs lists each, Monitors included, and skips Claude Code's scan marker", () => {
  const rows = [
    bashStart("toolu_a", "Watch the release chain", "watch-pid 123", 0), bashStarted("toolu_a", "bhqzji8y4", 0.01),
    monitorStart("toolu_m", "PR checks", 1), monitorStarted("toolu_m", "b9cc74319", 1.01),
    stoppedMany(["bhqzji8y4", "b9cc74319"], 20),
  ];
  const jobs = hook.killedJobs(jsonl(rows), { now: t0 + 21 * 60_000 });
  assert.deepEqual(jobs.map((job) => [job.taskId, job.kind, job.description]), [
    ["bhqzji8y4", "shell", "Watch the release chain"],
    ["b9cc74319", "monitor", "PR checks"],
  ]);
});

test("a job rerun after the notice, a job that completed, and an old notice are not reported", () => {
  const rows = [
    ...renderKilled,
    bashStart("toolu_r2", "Render sheet: loaded and blocked images", "node scripts/screenshots.mjs --only sheet", 36),
    bashStarted("toolu_r2", "b2nd", 36.01),
    bashStart("toolu_c", "Build", "npm run build", 1), bashStarted("toolu_c", "bdone", 1.01), completed("bdone", 2),
  ];
  assert.deepEqual(hook.killedJobs(jsonl(rows), { now: t0 + 37 * 60_000 }), []);
  // Same command, new description: still a rerun.
  const recommanded = [...renderKilled, bashStart("toolu_r3", "Rerun renders", "node scripts/screenshots.mjs --only sheet", 36)];
  assert.deepEqual(hook.killedJobs(jsonl(recommanded), { now: t0 + 37 * 60_000 }), []);
  assert.deepEqual(hook.killedJobs(jsonl(renderKilled), { now: t0 + 35 * 60_000 + hook.LOOK_BACK_MS + 1 }), []);
});

test("a job started before the transcript tail still gets a name", () => {
  const jobs = hook.killedJobs(jsonl([stoppedOne("bfar", 35)]), { now: t0 + 36 * 60_000 });
  assert.deepEqual(jobs.map((job) => [job.taskId, job.description]), [["bfar", null]]);
  assert.match(hook.killedNotice(jobs), /task bfar/);
});

test("the notice names each job and asks for a rerun or a report", () => {
  const text = hook.killedNotice(hook.killedJobs(jsonl(renderKilled), { now: t0 + 36 * 60_000 }));
  assert.match(text, /Render sheet: loaded and blocked images/);
  assert.match(text, /bx9npminm/);
  assert.match(text, /rerun/i);
  assert.match(text, /report/i);
  assert.doesNotMatch(text, /—/);
});

function sandbox(rows: object[]) {
  const home = mkdtempSync(join(tmpdir(), "killed-jobs-"));
  mkdirSync(join(home, "plugin-data", "smart-session"), { recursive: true });
  const path = join(home, "transcript.jsonl");
  writeFileSync(path, jsonl(rows));
  return { home, path };
}

async function run(script: string, event: object, home: string) {
  const child = spawn(process.execPath, [`hooks/${script}`], { env: { ...process.env, PASEO_HOME: home, PASEO_AGENT_ID: AGENT, SMART_SESSION_TOOLS: "native" }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stdin.end(JSON.stringify(event));
  await new Promise((resolve) => child.once("close", resolve));
  return out;
}

// Live timestamps: the hooks judge "recent" against the real clock.
const live = (rows: object[]) => {
  const shift = Date.now() - (t0 + 36 * 60_000);
  return rows.map((row: any) => ({ ...row, timestamp: new Date(Date.parse(row.timestamp) + shift).toISOString() }));
};

test("the first prompt after the restart tells the agent once; the next prompt does not repeat it", async () => {
  const box = sandbox(live(renderKilled));
  const event = { session_id: "s1", transcript_path: box.path, cwd: box.home, hook_event_name: "UserPromptSubmit", prompt: "From the orchestrator: status?" };
  const first = JSON.parse(await run("detached.mjs", event, box.home));
  assert.equal(first.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(first.hookSpecificOutput.additionalContext, /bx9npminm/);
  assert.equal(await run("detached.mjs", event, box.home), "");
  // Told on the prompt, so the turn's Stop doesn't say it again.
  const stop = { session_id: "s1", transcript_path: box.path, cwd: box.home, hook_event_name: "Stop", stop_hook_active: false, background_tasks: [] };
  assert.equal(await run("ask-compact.mjs", stop, box.home), "");
});

test("a turn that would end idle with an unreported killed job is kept going once, even with other jobs running", async () => {
  // The turn Claude Code starts on its own "didn't finish" notice fires no UserPromptSubmit.
  const box = sandbox(live(renderKilled));
  const stop = { session_id: "s1", transcript_path: box.path, cwd: box.home, hook_event_name: "Stop", stop_hook_active: false, background_tasks: [{ id: "bother" }] };
  const first = JSON.parse(await run("ask-compact.mjs", stop, box.home));
  assert.equal(first.hookSpecificOutput.hookEventName, "Stop");
  assert.match(first.hookSpecificOutput.additionalContext, /Render sheet/);
  assert.equal(await run("ask-compact.mjs", stop, box.home), "");
  assert.equal(await run("ask-compact.mjs", { ...stop, stop_hook_active: true }, box.home), "");
});

test("subagents are left alone", async () => {
  const box = sandbox(live(renderKilled));
  const stop = { session_id: "s1", transcript_path: box.path, cwd: box.home, hook_event_name: "Stop", agent_id: "sub", background_tasks: [] };
  assert.equal(await run("ask-compact.mjs", stop, box.home), "");
});
