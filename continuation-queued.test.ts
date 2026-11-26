/**
 * The continuation queued right behind the `/compact`, on a daemon that holds a steered message until the compaction
 * ends (Paseo 0.17.0+, getpaseo/paseo#10028). Older daemons keep the idle route. These ticks run the real governor
 * tick against real files with a fake daemon, and the real hooks in a child process or in-process.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentRow } from "./server/daemon.ts";
import {
  compactionLine,
  continuationNote,
  QUEUED_PREFIX,
  queuedContinuationInstructions,
  queuedResumeInstructions,
  queuesContinuation,
  resumeInstructions,
  retryRequest,
  type CompactionRequest,
} from "./shared/governor.ts";
import { promptCard } from "./shared/chat.ts";
// @ts-expect-error -- a dependency-free hook module with no type declarations.
import * as cancelled from "./hooks/cancelled.mjs";

const AGENT = "agent-queued";
const STATE = "/state/task.md";

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "continuation-queued-"));
  mkdirSync(join(dir, "plugin-data", "smart-session"), { recursive: true });
  process.env.PASEO_HOME = dir;
  return dir;
}
const data = (dir: string) => join(dir, "plugin-data", "smart-session");

function request(patch: Partial<CompactionRequest> = {}): CompactionRequest {
  return {
    id: "req-q", agentId: AGENT, reason: "Context is at 70%.", statePath: STATE, continueAfterCompaction: true, continuationMessage: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(), state: "pending", settledAt: null, confirmedAt: null, error: null,
    preTokens: null, postTokens: null, resumedAt: null, resumedVia: null, attempt: 0, retryOf: null, retriedBy: null, cancelledAt: null, cancelCause: null,
    ...patch,
  };
}

function seed(dir: string, items: CompactionRequest[]) {
  writeFileSync(join(data(dir), "compactions.json"), JSON.stringify({ version: 1, items }), "utf8");
}

function compacted(dir: string, at = new Date().toISOString()) {
  for (const event of ["SessionStart", "PostCompact"]) {
    appendFileSync(join(data(dir), "compaction-events.jsonl"), `${JSON.stringify({ at, event, agentId: AGENT, trigger: "manual" })}\n`);
  }
}

function cancel(dir: string, requestId: string, cause: "replaced" | "stopped", at = new Date().toISOString()) {
  appendFileSync(join(data(dir), "compaction-events.jsonl"), `${JSON.stringify({ at, event: "CompactCanceled", agentId: AGENT, requestId, cause })}\n`);
}

/** The daemon at `version`: one agent whose status the test sets, and every message the tick sent with how. */
function daemon(version: string | null) {
  const sends: { text: string; steer: boolean }[] = [];
  const state = { status: "idle" as AgentRow["status"], usedTokens: 300_000 as number | null };
  const io = {
    withDaemon: <T,>(work: (client: null) => Promise<T>) => work(null),
    readAgents: async () => [{ id: AGENT, status: state.status, usedTokens: state.usedTokens } as unknown as AgentRow],
    sendToAgent: async (_client: null, agentId: string, text: string, options?: { steer?: boolean }) => {
      assert.equal(agentId, AGENT);
      sends.push({ text, steer: options?.steer === true });
    },
    daemonVersion: () => version,
  };
  return { io, sends, state };
}

async function tick(io: ReturnType<typeof daemon>["io"]) {
  const { flush } = await import("./server/compaction-tick.ts");
  await flush(io);
}

async function items(): Promise<CompactionRequest[]> {
  const { queue } = await import("./server/compaction-queue.ts");
  return queue.list();
}

/** Runs the real UserPromptSubmit hook for this agent; returns its additionalContext, or "". */
async function prompt(dir: string, text = "Can you also check the tests?"): Promise<string> {
  const child = spawn(process.execPath, ["hooks/detached.mjs"], { env: { ...process.env, PASEO_HOME: dir, PASEO_AGENT_ID: AGENT, SMART_SESSION_TOOLS: "native" }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stdin.end(JSON.stringify({ session_id: "s1", transcript_path: join(dir, "none.jsonl"), cwd: dir, hook_event_name: "UserPromptSubmit", prompt: text }));
  await new Promise((resolve) => child.once("close", resolve));
  return out === "" ? "" : (JSON.parse(out).hookSpecificOutput.additionalContext as string);
}

test.beforeEach(async () => {
  const { resetTick } = await import("./server/compaction-tick.ts");
  resetTick();
});

test("on a daemon that queues, the continuation goes out once, steered, right behind the /compact", async () => {
  const dir = home();
  const { io, sends, state } = daemon("0.17.4");
  seed(dir, [request()]);
  await tick(io);
  assert.equal(sends.length, 2, "the /compact and its continuation in one tick");
  assert.match(sends[0]!.text, /^\/compact /);
  assert.equal(sends[0]!.steer, false, "the /compact is sent as before");
  assert.equal(sends[1]!.text, queuedResumeInstructions({ statePath: STATE }));
  assert.equal(sends[1]!.steer, true, "steer, so Paseo holds it until the compaction ends instead of replacing the turn");
  const [row] = await items();
  assert.equal(row!.resumedVia, "queued");
  assert.ok(row!.resumedAt !== null);
  assert.ok(existsSync(join(data(dir), "continuations", "req-q.json")), "claimed before the send");

  // The compaction lands while the queued continuation runs, then the agent goes idle: nothing more goes out.
  state.status = "running";
  compacted(dir);
  await tick(io);
  state.status = "idle";
  state.usedTokens = 40_000;
  await tick(io);
  await tick(io);
  assert.equal(sends.length, 2, "no second continuation from the idle route");
  assert.equal(await prompt(dir), "", "nor from the next prompt");
  const [after] = await items();
  assert.ok(after!.confirmedAt !== null, "the compaction is still confirmed as before");
  assert.equal(after!.resumedVia, "queued");
  assert.match(compactionLine(after, Date.now()), /continuation queued behind it$/);
});

test("the agent's own continuation text is queued as is", async () => {
  const dir = home();
  const { io, sends } = daemon("0.17.4");
  seed(dir, [request({ continuationMessage: "Run the billing tests next." })]);
  await tick(io);
  assert.deepEqual(sends.map((send) => send.text).slice(1), ["Run the billing tests next."]);
});

test("a request that asked for no continuation gets none on a daemon that queues", async () => {
  const dir = home();
  const { io, sends } = daemon("0.17.4");
  seed(dir, [request({ continueAfterCompaction: false })]);
  await tick(io);
  compacted(dir);
  await tick(io);
  assert.equal(sends.length, 1);
  assert.equal((await items())[0]!.resumedVia, null);
});

for (const version of [null, "0.16.2", "0.14.0", "0.17.0-beta.1", "garbage"]) {
  test(`an older or unknown daemon (${version}) keeps the idle route exactly`, async () => {
    const dir = home();
    const { io, sends, state } = daemon(version);
    seed(dir, [request()]);
    await tick(io);
    assert.equal(sends.length, 1, "only the /compact");
    assert.equal((await items())[0]!.resumedVia, null);
    compacted(dir);
    state.usedTokens = 40_000;
    await tick(io);
    assert.equal(sends.length, 2);
    assert.equal(sends[1]!.text, resumeInstructions({ statePath: STATE }), "the old text, after the compaction landed");
    assert.equal(sends[1]!.steer, false, "sent as before, with no behaviour");
    assert.equal((await items())[0]!.resumedVia, "sent");
  });
}

test("a cancelled compaction's retry sends no second continuation", async () => {
  const dir = home();
  const { io, sends, state } = daemon("0.17.4");
  seed(dir, [request()]);
  await tick(io);
  assert.equal(sends.length, 2);

  // A person's Interrupt replaced the /compact turn; the hook recorded it.
  state.status = "running";
  cancel(dir, "req-q", "replaced");
  await tick(io);
  const listed = await items();
  const original = listed.find((item) => item.id === "req-q")!;
  const retry = listed.find((item) => item.retryOf === "req-q")!;
  assert.ok(original.cancelledAt !== null && retry !== undefined, "retried as before");
  assert.equal(retry.continueAfterCompaction, false, "the continuation already queued stays the only one");

  // The retry goes out at the next idle moment and lands: only its /compact is sent.
  state.status = "idle";
  await tick(io);
  assert.equal(sends.length, 3);
  assert.match(sends[2]!.text, /^\/compact .*Retry 1:/);
  compacted(dir);
  state.usedTokens = 40_000;
  await tick(io);
  await tick(io);
  assert.equal(sends.length, 3, "no continuation after the retry");
  assert.equal(await prompt(dir), "", "and the next prompt carries none");
});

test("a retry of a request whose continuation went the idle route still carries its own", () => {
  const sent = request({ state: "sent", resumedVia: null });
  assert.equal(retryRequest(sent, "r2", new Date().toISOString()).continueAfterCompaction, true);
  const queued = request({ state: "sent", resumedVia: "queued" });
  assert.equal(retryRequest(queued, "r3", new Date().toISOString()).continueAfterCompaction, false);
});

test("a claim the prompt hook already holds stops the queued send", async () => {
  const dir = home();
  const { io, sends } = daemon("0.17.4");
  seed(dir, [request()]);
  mkdirSync(join(data(dir), "continuations"), { recursive: true });
  writeFileSync(join(data(dir), "continuations", "req-q.json"), JSON.stringify({ by: "prompt", at: new Date().toISOString() }));
  await tick(io);
  assert.equal(sends.length, 1, "only the /compact: whoever claims first delivers");
});

test("the prompt hook racing the queued send delivers the continuation exactly once", async () => {
  const dir = home();
  const { io, sends } = daemon("0.17.4");
  seed(dir, [request()]);
  // The compaction already landed by the time a prompt races the tick (the hook only claims an owed one).
  const [hookContext] = await Promise.all([prompt(dir), tick(io)]);
  compacted(dir);
  const second = await prompt(dir);
  const continuations = sends.filter((send) => !send.text.startsWith("/compact")).length + [hookContext, second].filter((c) => c !== "").length;
  assert.equal(continuations, 1);
});

test("a /compact the person typed is never followed by a continuation, queuing daemon or not", async () => {
  const dir = home();
  const { io, sends } = daemon("0.17.4");
  seed(dir, []);
  compacted(dir);
  await tick(io);
  await tick(io);
  assert.equal(sends.length, 0);
  assert.equal(await prompt(dir), "");
});

test("a Stop mid-compaction stays a Stop when the queued continuation runs after it", () => {
  const t0 = Date.parse("2026-11-26T10:00:00.000Z");
  const at = (ms: number) => new Date(t0 + ms).toISOString();
  const row = (record: object) => JSON.stringify(record);
  const transcript = [
    row({ type: "queue-operation", operation: "enqueue", content: queuedResumeInstructions({ statePath: STATE }), timestamp: at(500) }),
    row({ type: "system", subtype: "local_command", content: "<local-command-stdout>Compaction canceled.</local-command-stdout>", timestamp: at(9_000) }),
    row({ type: "queue-operation", operation: "dequeue", timestamp: at(9_010) }),
    row({ type: "user", message: { role: "user", content: queuedResumeInstructions({ statePath: STATE }) }, timestamp: at(9_020) }),
  ].join("\n");
  const item = request({ state: "sent", resumedVia: "queued" });
  const ours = (body: string) => cancelled.isQueuedContinuation(item, body);
  assert.equal(cancelled.cancelInTranscript(transcript, t0, { now: t0 + 9_100 }).cause, "replaced", "without the rule it read as replaced");
  assert.equal(cancelled.cancelInTranscript(transcript, t0, { now: t0 + 9_100, ours }).cause, "stopped");
  // The agent's own text counts too; a person's message after a Stop still reads as replaced.
  const own = request({ state: "sent", resumedVia: "queued", continuationMessage: "Run the billing tests next." });
  assert.equal(cancelled.isQueuedContinuation(own, "Run the billing tests next."), true);
  assert.equal(cancelled.isQueuedContinuation(own, "Can you also check the tests?"), false);
  assert.equal(cancelled.isQueuedContinuation(request({ resumedVia: "sent" }), queuedResumeInstructions({ statePath: STATE })), false, "only a queued row");
});

test("the Stop hook path records a Stop, and the queued continuation's own prompt says nothing", () => {
  const dir = home();
  const t0 = Date.now() - 30_000;
  const at = (ms: number) => new Date(t0 + ms).toISOString();
  seed(dir, [request({ state: "sent", settledAt: at(0), createdAt: at(-1000), resumedVia: "queued", resumedAt: at(10) })]);
  const transcriptPath = join(dir, "t.jsonl");
  writeFileSync(transcriptPath, [
    JSON.stringify({ type: "system", subtype: "local_command", content: "<local-command-stdout>Compaction canceled.</local-command-stdout>", timestamp: at(25_000) }),
    JSON.stringify({ type: "user", message: { role: "user", content: queuedResumeInstructions({ statePath: STATE }) }, timestamp: at(25_020) }),
  ].join("\n"));
  const notice = cancelled.noteCancelledCompaction(
    { session_id: "s1", transcript_path: transcriptPath, prompt: queuedResumeInstructions({ statePath: STATE }) },
    { prompting: true, now: t0 + 25_100, env: { PASEO_AGENT_ID: AGENT } },
  );
  assert.equal(notice, null, "no 'nobody cancelled it' notice on our own continuation");
  const recorded = readFileSync(join(data(dir), "compaction-events.jsonl"), "utf8").trim().split("\n").map((line: string) => JSON.parse(line));
  assert.equal(recorded.at(-1).cause, "stopped", "so it is not retried");
});

test("version gate, words and mirrors", () => {
  for (const [version, want] of [["0.17.0", true], ["0.17.4", true], ["v0.18.1", true], ["1.0.0", true], ["0.17.0-beta.1", false], ["0.16.2", false], ["0.14.0", false], [null, false], ["", false], ["x", false]] as const) {
    assert.equal(queuesContinuation(version), want, String(version));
  }
  assert.equal(cancelled.QUEUED_PREFIX, QUEUED_PREFIX, "the hook mirrors the prefix");
  assert.ok(queuedResumeInstructions({ statePath: null }).startsWith(QUEUED_PREFIX));
  assert.match(queuedResumeInstructions({ statePath: null }), /if no compaction ran/, "reads right if the compaction didn't land");
  assert.equal(queuedContinuationInstructions({ continueAfterCompaction: false, continuationMessage: null, statePath: STATE }), null);
  assert.deepEqual(promptCard(queuedResumeInstructions({ statePath: STATE })), { kind: "continue", reason: "", statePath: STATE, text: queuedResumeInstructions({ statePath: STATE }) });
  assert.equal(promptCard(queuedResumeInstructions({ statePath: null }))?.kind, "continue");
  assert.equal(continuationNote({ continueAfterCompaction: true, resumedVia: "queued", resumedAt: new Date().toISOString() }, Date.now(), Date.now()), "continuation queued behind it");
});
