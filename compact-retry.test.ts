/**
 * Invariant: a requested compaction either lands, or is retried and visibly reported; never silently dropped.
 *
 * 2026-11-11 11:27: Smart Session delivered a queued /compact. An agent notification reached the agent nine
 * seconds later; Paseo 0.16 cannot steer into a slash-command turn, so it replaced the turn, Claude Code wrote
 * "Compaction canceled." and the notification's turn started 18 ms later. Nothing retried it and nothing said why:
 * the agent read it as a person cancelling. Reproduced in an isolated 0.16 daemon with a real Claude session.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { promptCard } from "./shared/chat.ts";
import {
  cancellation,
  cancelledError,
  compactionInstructions,
  compactionLine,
  RETRY_LIMIT,
  RETRY_WINDOW_MS,
  retryRequest,
  retryVerdict,
  type CompactionRequest,
} from "./shared/governor.ts";
// @ts-expect-error -- a dependency-free hook module with no type declarations.
import * as hook from "./hooks/cancelled.mjs";

const AGENT = "agent-retry";
const T0 = Date.parse("2026-11-11T11:27:01.517Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();

function request(patch: Partial<CompactionRequest> = {}): CompactionRequest {
  return {
    id: "req-1",
    agentId: AGENT,
    reason: "Context is at 30%.",
    statePath: "/state/task.md",
    continueAfterCompaction: true,
    continuationMessage: null,
    createdAt: iso(-60_000),
    state: "sent",
    settledAt: iso(0),
    confirmedAt: null,
    error: null,
    preTokens: 307_740,
    postTokens: null,
    resumedAt: null,
    attempt: 0,
    retryOf: null,
    retriedBy: null,
    cancelledAt: null,
    cancelCause: null,
    ...patch,
  };
}

/* The transcript rows around a cancel, shaped like Claude Code 2.1.322 writes them (live 11:27 and the harness run). */
const compactCommand = { type: "user", timestamp: iso(14), message: { role: "user", content: "<command-name>/compact</command-name>\n<command-args>Preserve: ...</command-args>" } };
const caveat = { type: "user", isMeta: true, timestamp: iso(9_116), message: { role: "user", content: "<local-command-caveat>The command below was run directly in Claude Code.</local-command-caveat>" } };
const cancelRow = { type: "system", subtype: "local_command", content: "<local-command-stdout>Compaction canceled.</local-command-stdout>", level: "info", timestamp: iso(9_115) };
const enqueue = (ms: number) => ({ type: "queue-operation", operation: "enqueue", timestamp: iso(ms) });
const prompt = (ms: number) => ({ type: "user", timestamp: iso(ms), message: { role: "user", content: [{ type: "text", text: "<paseo-system kind=\"agent-notification\">Agent finished.</paseo-system>" }] } });
const toolResult = (ms: number) => ({ type: "user", timestamp: iso(ms), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
const jsonl = (rows: object[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

const REPLACED = jsonl([compactCommand, caveat, cancelRow, enqueue(9_133), { type: "queue-operation", operation: "dequeue", timestamp: iso(9_134) }, prompt(9_145)]);
const STOPPED = jsonl([compactCommand, caveat, cancelRow]);

test("the transcript tells a message that replaced the /compact from a Stop", () => {
  assert.deepEqual(hook.cancelInTranscript(REPLACED, T0 - 30_000), { at: iso(9_115), cause: "replaced" });
  assert.deepEqual(hook.cancelInTranscript(STOPPED, T0 - 30_000, { now: T0 + 60_000 }), { at: iso(9_115), cause: "stopped" });
  // A person's next message a minute later is not what cancelled it, and neither are the command's own rows.
  assert.equal(hook.cancelInTranscript(jsonl([compactCommand, caveat, cancelRow, toolResult(9_200), prompt(70_000)]), T0 - 30_000).cause, "stopped");
  // The prompt this hook runs for, while it is still that soon, is the replacement.
  assert.equal(hook.cancelInTranscript(STOPPED, T0 - 30_000, { prompting: true, now: T0 + 9_140 }).cause, "replaced");
  assert.equal(hook.cancelInTranscript(STOPPED, T0 - 30_000, { prompting: true, now: T0 + 90_000 }).cause, "stopped");
  // A cancel from before this delivery belongs to another request.
  assert.equal(hook.cancelInTranscript(REPLACED, T0 + 10_000), null);
  assert.equal(hook.cancelInTranscript(jsonl([prompt(5)]), T0 - 30_000), null);
});

test("a replaced /compact is retried, a Stop is not, and retries are capped per hour", () => {
  const now = T0 + 60_000;
  const item = request();
  assert.equal(retryVerdict([item], item, "replaced", now), "retry");
  assert.equal(retryVerdict([item], item, "stopped", now), "stopped");
  assert.equal(retryVerdict([item, request({ id: "other", state: "pending" })], item, "replaced", now), "queued");
  const retries = Array.from({ length: RETRY_LIMIT }, (_, i) => request({ id: `r${i}`, retryOf: "x", attempt: 1, createdAt: iso(-10 * 60_000) }));
  assert.equal(retryVerdict([item, ...retries], item, "replaced", now), "limit");
  const old = retries.map((r) => ({ ...r, createdAt: new Date(now - RETRY_WINDOW_MS - 1).toISOString() }));
  assert.equal(retryVerdict([item, ...old], item, "replaced", now), "retry", "an hour later the budget is back");
  assert.equal(retryVerdict([item, request({ id: "b", agentId: "b", retryOf: "x" }), request({ id: "c", agentId: "b", retryOf: "x" })], item, "replaced", now), "retry", "another agent's retries");
});

test("the hooks' copy of the retry rule agrees with the server's", () => {
  const now = T0 + 60_000;
  const item = request();
  const shapes: CompactionRequest[][] = [
    [item],
    [item, request({ id: "p", state: "pending" })],
    [item, request({ id: "s", state: "sending" })],
    [item, request({ id: "r0", retryOf: "x" })],
    [item, request({ id: "r0", retryOf: "x" }), request({ id: "r1", retryOf: "x" })],
    [item, request({ id: "r0", retryOf: "x", createdAt: iso(-2 * RETRY_WINDOW_MS) }), request({ id: "r1", retryOf: "x" })],
  ];
  for (const items of shapes) for (const cause of ["replaced", "stopped"] as const) assert.equal(hook.retryVerdict(items, item, cause, now), retryVerdict(items, item, cause, now));
  assert.equal(hook.CANCEL_EVENT, "CompactCanceled");
  assert.equal(hook.RETRY_LIMIT, RETRY_LIMIT);
  assert.equal(hook.RETRY_WINDOW_MS, RETRY_WINDOW_MS);
});

test("a cancel record applies only to the request it names", () => {
  const item = request();
  const record = { at: iso(9_115), event: "CompactCanceled", agentId: AGENT, requestId: "req-1", cause: "replaced" };
  assert.deepEqual(cancellation(item, [record]), { at: iso(9_115), cause: "replaced" });
  assert.equal(cancellation(item, [{ ...record, requestId: "req-0" }]), null);
  assert.equal(cancellation(item, [{ ...record, agentId: "b" }]), null);
  assert.equal(cancellation({ ...item, state: "pending", settledAt: null }, [record]), null);
  assert.deepEqual(cancellation(item, [{ ...record, cause: "stopped" }]), { at: iso(9_115), cause: "stopped" });
});

test("every way a request ends is said in the popover, and the retry carries the ask", () => {
  const now = T0 + 120_000;
  const original = request();
  const retry = retryRequest(original, "req-2", iso(20_000));
  assert.equal(retry.state, "pending");
  assert.equal(retry.attempt, 1);
  assert.equal(retry.retryOf, "req-1");
  assert.equal(retry.reason, original.reason);
  assert.equal(retry.statePath, original.statePath);
  assert.equal(retry.continueAfterCompaction, true);

  const lines = {
    retryQueued: compactionLine(retry, now),
    retried: compactionLine({ ...original, cancelledAt: iso(9_115), cancelCause: "replaced", retriedBy: "req-2", error: cancelledError("retry") }, now),
    limit: compactionLine({ ...original, cancelledAt: iso(9_115), cancelCause: "replaced", error: cancelledError("limit") }, now),
    queued: compactionLine({ ...original, cancelledAt: iso(9_115), cancelCause: "replaced", error: cancelledError("queued") }, now),
    stopped: compactionLine({ ...original, cancelledAt: iso(9_115), cancelCause: "stopped", error: cancelledError("stopped") }, now),
    landedOnRetry: compactionLine({ ...retry, state: "sent", settledAt: iso(60_000), confirmedAt: iso(70_000), preTokens: 310_000, postTokens: 40_000 }, now),
  };
  assert.match(lines.retryQueued, /^Retry 1 queued/);
  assert.match(lines.retried, /Interrupted · retry queued/);
  assert.match(lines.limit, new RegExp(`not retried \\(${RETRY_LIMIT} an hour\\)`));
  assert.match(lines.queued, /another is queued/);
  assert.match(lines.stopped, /^Stopped mid-compaction/);
  assert.match(lines.landedOnRetry, /retry 1$/);
  for (const verdict of ["retry", "queued", "limit", "stopped"] as const) assert.match(cancelledError(verdict), verdict === "retry" ? /Retried/ : /Not retried/);

  // The timeline card says it is a retry, and still reads the agent's reason and state file.
  const card = promptCard(compactionInstructions(retry));
  assert.equal(card?.retry, 1);
  assert.equal(card?.reason, original.reason);
  assert.equal(card?.statePath, original.statePath);
  assert.equal(promptCard(compactionInstructions(original))?.retry, undefined);
});

/* -------------------------------------------------------------------------- *
 * The hooks, driven as Claude Code runs them.
 * -------------------------------------------------------------------------- */

function sandbox(transcript: string, items: CompactionRequest[]) {
  const home = mkdtempSync(join(tmpdir(), "compact-retry-"));
  const data = join(home, "plugin-data", "smart-session");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "compactions.json"), JSON.stringify({ version: 1, items }), "utf8");
  const path = join(home, "transcript.jsonl");
  writeFileSync(path, transcript, "utf8");
  const events = () => {
    try {
      return readFileSync(join(data, "compaction-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  return { home, path, events };
}

async function run(script: string, event: object, home: string): Promise<string> {
  const child = spawn(process.execPath, [`hooks/${script}`], { env: { ...process.env, PASEO_HOME: home, PASEO_AGENT_ID: AGENT, SMART_SESSION_TOOLS: "native" }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stdin.end(JSON.stringify(event));
  await new Promise((resolve) => child.once("close", resolve));
  return out;
}

test("the prompt that replaced a /compact records it once and tells the agent it will be retried", async () => {
  // Delivered moments ago, so the hook's "now" is within the window it looks in.
  const settled = Date.now() - 20_000;
  const at = (ms: number) => new Date(settled + ms).toISOString();
  const rows = jsonl([
    { ...compactCommand, timestamp: at(14) },
    { ...cancelRow, timestamp: at(9_115) },
    { ...enqueue(0), timestamp: at(9_133) },
  ]);
  const box = sandbox(rows, [request({ settledAt: at(0), createdAt: at(-60_000) })]);
  const event = { session_id: "s1", transcript_path: box.path, cwd: box.home, hook_event_name: "UserPromptSubmit", prompt: "notification" };

  const first = JSON.parse(await run("detached.mjs", event, box.home));
  assert.equal(first.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(first.hookSpecificOutput.additionalContext, /cancelled/);
  assert.match(first.hookSpecificOutput.additionalContext, /Nobody cancelled it on purpose/);
  assert.match(first.hookSpecificOutput.additionalContext, /sends it again once this session is idle/);
  assert.deepEqual(box.events().map(({ event: name, requestId, cause, at: when }) => ({ name, requestId, cause, when })), [
    { name: "CompactCanceled", requestId: "req-1", cause: "replaced", when: at(9_115) },
  ]);

  assert.equal(await run("detached.mjs", event, box.home), "", "said once");
  assert.equal(await run("ask-compact.mjs", { ...event, hook_event_name: "Stop", stop_hook_active: false }, box.home), "");
  assert.equal(box.events().length, 1, "recorded once");
});

test("Stop records a cancel the prompt missed, silently", async () => {
  const settled = Date.now() - 120_000;
  const at = (ms: number) => new Date(settled + ms).toISOString();
  const rows = jsonl([{ ...compactCommand, timestamp: at(14) }, { ...cancelRow, timestamp: at(9_115) }, { ...enqueue(0), timestamp: at(9_133) }, { ...prompt(0), timestamp: at(9_145) }]);
  const box = sandbox(rows, [request({ settledAt: at(0), createdAt: at(-60_000) })]);
  const out = await run("ask-compact.mjs", { session_id: "s1", transcript_path: box.path, cwd: box.home, hook_event_name: "Stop", stop_hook_active: false }, box.home);
  assert.equal(out, "", "text on Stop would start another turn");
  assert.equal(box.events()[0]?.cause, "replaced");
});

test("nothing is read or recorded without a delivered, unconfirmed /compact", async () => {
  const settled = Date.now() - 20_000;
  const at = (ms: number) => new Date(settled + ms).toISOString();
  const rows = jsonl([{ ...compactCommand, timestamp: at(14) }, { ...cancelRow, timestamp: at(9_115) }, { ...enqueue(0), timestamp: at(9_133) }]);
  const recent = { settledAt: at(0), createdAt: at(-60_000) };
  const cases: [string, CompactionRequest[]][] = [
    ["no request", []],
    ["still queued", [request({ ...recent, state: "pending", settledAt: null })]],
    ["confirmed", [request({ ...recent, confirmedAt: at(30_000), postTokens: 40_000 })]],
    ["another agent's", [request({ ...recent, agentId: "b" })]],
    ["already settled", [request({ ...recent, error: "x" })]],
  ];
  for (const [name, items] of cases) {
    const box = sandbox(rows, items);
    assert.equal(await run("detached.mjs", { session_id: "s1", transcript_path: box.path, cwd: box.home, hook_event_name: "UserPromptSubmit" }, box.home), "", name);
    assert.equal(box.events().length, 0, name);
  }
  // Control: the same rows with a live request are recorded, so the cases above are silent for their own reason.
  const box = sandbox(rows, [request(recent)]);
  await run("detached.mjs", { session_id: "s1", transcript_path: box.path, cwd: box.home, hook_event_name: "UserPromptSubmit" }, box.home);
  assert.equal(box.events().length, 1);
});

test("the governor settles a cancel and queues its retry in one write, once", async () => {
  const home = mkdtempSync(join(tmpdir(), "compact-retry-queue-"));
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  try {
    const { queue } = await import("./server/compaction-queue.ts");
    const data = join(home, "plugin-data", "smart-session");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "compactions.json"), JSON.stringify({ version: 1, items: [request()] }), "utf8");

    const settled = await queue.settleCancelled("req-1", { at: iso(9_115), cause: "replaced" }, T0 + 60_000);
    assert.equal(settled?.verdict, "retry");
    const items = await queue.list();
    const [original, retry] = items;
    assert.equal(items.length, 2);
    assert.equal(original.cancelCause, "replaced");
    assert.equal(original.cancelledAt, iso(9_115));
    assert.equal(original.retriedBy, retry.id);
    assert.equal(original.error, cancelledError("retry"));
    assert.equal(retry.state, "pending");
    assert.equal(retry.retryOf, "req-1");
    assert.equal(await queue.settleCancelled("req-1", { at: iso(9_115), cause: "replaced" }, T0 + 61_000), null, "once");
    assert.equal((await queue.list()).length, 2);

    // Rows written before these fields existed read back with defaults.
    writeFileSync(join(data, "compactions.json"), JSON.stringify({ version: 1, items: [{ ...request(), attempt: undefined, retryOf: undefined, retriedBy: undefined, cancelledAt: undefined, cancelCause: undefined }] }), "utf8");
    const [legacy] = await queue.list();
    assert.deepEqual([legacy.attempt, legacy.retryOf, legacy.retriedBy, legacy.cancelledAt, legacy.cancelCause], [0, null, null, null, null]);
  } finally {
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
  }
});
