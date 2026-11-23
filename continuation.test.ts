/**
 * Invariant: a confirmed compaction's continuation is never silently dropped.
 *
 * 2026-11-23 live: an agent asked to compact and carry on. The compaction landed (PostCompact and
 * SessionStart:compact recorded 79 s after delivery), then a person's message started a turn at once. The governor
 * checked landing only while the agent was idle and watched for 5 minutes from delivery; when the watch ran out it
 * confirmed from the hook's record and never sent the continuation. These ticks run the real governor tick against
 * real files with a fake daemon, and the real `UserPromptSubmit` hook in a child process.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

import type { AgentRow } from "./server/daemon.ts";
import {
  compactionLine,
  CONTINUATION_CAP_MS,
  continuationOwed,
  LANDS_WITHIN_MS,
  promptContinuation,
  resumeInstructions,
  type CompactionRequest,
} from "./shared/governor.ts";
// @ts-expect-error -- a dependency-free hook module with no type declarations.
import * as hook from "./hooks/continuation.mjs";

const AGENT = "agent-continue";
const STATE = "/state/task.md";

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "continuation-"));
  mkdirSync(join(dir, "plugin-data", "smart-session"), { recursive: true });
  process.env.PASEO_HOME = dir;
  return dir;
}
const data = (dir: string) => join(dir, "plugin-data", "smart-session");

function request(patch: Partial<CompactionRequest> = {}): CompactionRequest {
  return {
    id: "req-1", agentId: AGENT, reason: "Context is at 70%.", statePath: STATE, continueAfterCompaction: true, continuationMessage: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(), state: "pending", settledAt: null, confirmedAt: null, error: null,
    preTokens: null, postTokens: null, resumedAt: null, resumedVia: null, attempt: 0, retryOf: null, retriedBy: null, cancelledAt: null, cancelCause: null,
    ...patch,
  };
}

function seed(dir: string, items: CompactionRequest[]) {
  writeFileSync(join(data(dir), "compactions.json"), JSON.stringify({ version: 1, items }), "utf8");
}

function compacted(dir: string, at = new Date().toISOString(), agentId = AGENT) {
  for (const event of ["SessionStart", "PostCompact"]) {
    appendFileSync(join(data(dir), "compaction-events.jsonl"), `${JSON.stringify({ at, event, agentId, trigger: "manual" })}\n`);
  }
}

/** The daemon: one agent whose status the test sets, and every message the tick sent. */
function daemon() {
  const sends: string[] = [];
  const state = { status: "idle" as AgentRow["status"], usedTokens: 300_000 as number | null };
  const io = {
    withDaemon: <T,>(work: (client: null) => Promise<T>) => work(null),
    readAgents: async () => [{ id: AGENT, status: state.status, usedTokens: state.usedTokens } as unknown as AgentRow],
    sendToAgent: async (_client: null, agentId: string, text: string) => {
      assert.equal(agentId, AGENT);
      sends.push(text);
    },
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

const CONTINUATION = resumeInstructions({ statePath: STATE });

test.beforeEach(async () => {
  const { resetTick } = await import("./server/compaction-tick.ts");
  resetTick();
});

test("a message right after the compaction carries the continuation, and the governor doesn't send it too", async () => {
  const dir = home();
  const { io, sends, state } = daemon();
  seed(dir, [request()]);
  await tick(io);
  assert.equal(sends.length, 1, "the /compact");
  assert.match(sends[0], /^\/compact /);

  // It lands; a person's message starts a turn at once.
  compacted(dir);
  state.status = "running";
  await tick(io);
  const [confirmed] = await items();
  assert.notEqual(confirmed.confirmedAt, null, "confirmed from the hook's record while busy");
  assert.equal(sends.length, 1);

  assert.equal(await prompt(dir), promptContinuation(CONTINUATION));
  assert.equal(await prompt(dir), "", "said once");

  state.status = "idle";
  await tick(io);
  await tick(io);
  assert.equal(sends.length, 1, "the governor never sends it after the prompt carried it");
  const [done] = await items();
  assert.equal(done.resumedVia, "prompt");
  assert.notEqual(done.resumedAt, null);
  assert.match(compactionLine(done, Date.now()), / · continuation added to the next message$/);
});

test("a compaction and a turn longer than five minutes, with no message, are continued at the next idle moment", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-23T14:17:26Z") });
  try {
    const dir = home();
    const { io, sends, state } = daemon();
    seed(dir, [request({ createdAt: new Date().toISOString() })]);
    await tick(io);
    state.status = "running";
    mock.timers.tick(79_000);
    compacted(dir);
    // The compaction's own turn and the work after it outlast the 5-minute watch.
    for (let minute = 0; minute < 12; minute++) {
      mock.timers.tick(60_000);
      await tick(io);
    }
    assert.equal(sends.length, 1, "nothing sent into the busy session");
    state.status = "idle";
    state.usedTokens = 90_000;
    await tick(io);
    assert.deepEqual(sends.slice(1), [CONTINUATION]);
    const [done] = await items();
    assert.equal(done.resumedVia, "sent");
    assert.match(compactionLine(done, Date.now()), / · continuation sent$/);
    await tick(io);
    assert.equal(sends.length, 2, "once");
  } finally {
    mock.timers.reset();
  }
});

test("a continuation still owed past the cap is dropped, logged and shown, never sent", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-23T14:17:26Z") });
  const logs: string[] = [];
  const log = mock.method(console, "log", (line: string) => logs.push(line));
  try {
    const dir = home();
    const { io, sends, state } = daemon();
    seed(dir, [request({ createdAt: new Date().toISOString() })]);
    await tick(io);
    state.status = "running";
    mock.timers.tick(60_000);
    compacted(dir);
    await tick(io);
    mock.timers.tick(CONTINUATION_CAP_MS + 60_000);
    await tick(io);
    state.status = "idle";
    await tick(io);
    assert.equal(sends.length, 1, "only the /compact");
    const [done] = await items();
    assert.equal(done.resumedVia, "stale");
    assert.equal(done.resumedAt, null);
    assert.match(compactionLine(done, Date.now()), / · continuation dropped as stale$/);
    assert.ok(logs.some((line) => /dropped agent-co's continuation: still not idle 120 min after compacting/.test(line)), logs.join("\n"));
    // A late prompt can't carry it either: the drop holds the claim.
    assert.equal(hook.continuationNotice({ prompt: "hi" }, { env: { PASEO_AGENT_ID: AGENT } }), null);
  } finally {
    log.mock.restore();
    mock.timers.reset();
  }
});

test("the hook and the governor racing for one continuation deliver it exactly once", async () => {
  for (let round = 0; round < 8; round++) {
    const dir = home();
    const { resetTick } = await import("./server/compaction-tick.ts");
    resetTick();
    const { io, sends, state } = daemon();
    const settledAt = new Date(Date.now() - 120_000).toISOString();
    seed(dir, [request({ state: "sent", settledAt, preTokens: 300_000 })]);
    compacted(dir, new Date(Date.now() - 60_000).toISOString());
    state.status = "idle";
    // Stagger the tick across the hook's start-up so either side can get there first.
    const [, carried] = await Promise.all([new Promise((resolve) => setTimeout(resolve, round * 15)).then(() => tick(io)), prompt(dir)]);
    await tick(io);
    const delivered = sends.length + (carried === "" ? 0 : 1);
    assert.equal(delivered, 1, `round ${round}: sent ${sends.length}, carried ${carried !== ""}`);
    const [done] = await items();
    assert.equal(done.resumedVia, sends.length === 1 ? "sent" : "prompt");
  }
});

test("a /compact the person typed is never followed by a continuation", async () => {
  const dir = home();
  const { io, sends } = daemon();
  // Smart Compact's own earlier request continued long ago; then the person typed /compact.
  seed(dir, [request({ state: "sent", settledAt: new Date(Date.now() - 3_600_000).toISOString(), confirmedAt: new Date(Date.now() - 3_590_000).toISOString(), resumedAt: new Date(Date.now() - 3_580_000).toISOString(), resumedVia: "sent" })]);
  compacted(dir);
  await tick(io);
  assert.equal(sends.length, 0);
  assert.equal(await prompt(dir), "");

  // A row whose watch a reload lost isn't confirmed by the person's /compact 40 minutes later either.
  const lost = request({ id: "req-lost", state: "sent", settledAt: new Date(Date.now() - 40 * 60_000).toISOString() });
  assert.equal(continuationOwed(lost, [{ agentId: AGENT, event: "PostCompact", at: new Date().toISOString() }]), null);
  seed(dir, [lost]);
  await tick(io);
  assert.equal(sends.length, 0);
  assert.equal(await prompt(dir), "");
  assert.equal(existsSync(join(data(dir), "continuations", "req-lost.json")), false);
});

test("a /compact prompt carries nothing; the next real prompt does", async () => {
  const dir = home();
  seed(dir, [request({ state: "sent", settledAt: new Date(Date.now() - 120_000).toISOString(), confirmedAt: new Date(Date.now() - 60_000).toISOString(), continuationMessage: "Run the release checklist." })]);
  assert.equal(await prompt(dir, "/compact Preserve: everything"), "");
  assert.equal(await prompt(dir), promptContinuation("Run the release checklist."));
  assert.deepEqual(JSON.parse(readFileSync(join(data(dir), "continuations", "req-1.json"), "utf8")).by, "prompt");
});

test("the popover says a continuation still waiting, and stays quiet on old rows it can't tell", () => {
  const now = Date.now();
  const row = request({ state: "sent", settledAt: new Date(now - 120_000).toISOString(), confirmedAt: new Date(now - 60_000).toISOString() });
  assert.match(compactionLine(row, now), / · continuation sent when idle$/);
  assert.doesNotMatch(compactionLine(row, now + CONTINUATION_CAP_MS + 60_000), /continuation/);
  assert.doesNotMatch(compactionLine({ ...row, continueAfterCompaction: false }, now), /continuation/);
  assert.match(compactionLine({ ...row, resumedAt: new Date(now).toISOString() }, now), / · continuation sent$/);
});

test("the hook's mirrors match the governor's rules", () => {
  assert.equal(hook.CONTINUATION_CAP_MS, CONTINUATION_CAP_MS);
  assert.equal(hook.LANDS_WITHIN_MS, LANDS_WITHIN_MS);
  for (const path of [STATE, null, ""]) assert.equal(hook.resumeInstructions(path), resumeInstructions({ statePath: path }));
  assert.equal(hook.promptContinuation("x."), promptContinuation("x."));
  const now = Date.now();
  const settledAt = new Date(now - 120_000).toISOString();
  const events = [{ agentId: AGENT, event: "PostCompact", at: new Date(now - 60_000).toISOString() }];
  const cases: Partial<CompactionRequest>[] = [
    {}, { continueAfterCompaction: false }, { resumedAt: settledAt }, { resumedVia: "stale" }, { cancelledAt: settledAt }, { retriedBy: "r2" },
    { error: "x" }, { confirmedAt: settledAt }, { postTokens: 50_000 }, { settledAt: new Date(now - 30 * 60_000).toISOString() }, { state: "pending" },
  ];
  for (const patch of cases) {
    const item = request({ state: "sent", settledAt, ...patch });
    assert.equal(hook.owedSince(item, events), continuationOwed(item, events), JSON.stringify(patch));
  }
});
