import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nativeTools } from "./server/native-tools.ts";
import { named } from "./server/agent-tools.mjs";
import type { AgentToolContext } from "@getpaseo/plugin/server";

const context = (id: string) => ({ agent: { id }, paseo: {}, signal: new AbortController().signal }) as unknown as AgentToolContext;

test("native tools run in-process as the daemon's caller, and name the native set", async t => {
  const home = await mkdtemp(join(tmpdir(), "smart-session-native-"));
  const previous = process.env.PASEO_HOME; process.env.PASEO_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous; await rm(home, { recursive: true, force: true }); });
  const calls: [string, unknown][] = [];
  const tools = nativeTools(async (method, input) => {
    calls.push([method, input]);
    if (method === "smart-session.compact.request") return { request: { id: "0123456789", continueAfterCompaction: true, continuationMessage: null, statePath: "/s" } };
    return { agents: [], windows: [], summary: [] };
  });
  const tool = (name: string) => tools.find(t => t.name === name)!;
  assert.match(tool("smart_request_compaction").description, /with smart_checkpoint FIRST/);

  // Identity is the daemon's: the state file and the RPCs are keyed by the calling agent.
  const written = await tool("smart_checkpoint").execute({ goal: "g", current_step: "s" }, context("agent-a"));
  assert.equal(written.isError, undefined);
  assert.match(await readFile(join(home, "plugin-data/smart-session/state/agent-a.md"), "utf8"), /## Goal\ng/);
  await tool("smart_context_status").execute({}, context("agent-b"));
  assert.deepEqual(calls.at(-1), ["smart-session.context", { agentId: "agent-b" }]);
  const queued = await tool("smart_request_compaction").execute({ reason: "done" }, context("agent-a"));
  assert.match(queued.text!, /Compaction queued/);
  assert.equal((calls.find(c => c[0] === "smart-session.compact.request")![1] as { agentId: string }).agentId, "agent-a");
  const refused = await tool("smart_request_compaction").execute({ reason: "x" }, context("agent-c"));
  assert.match(refused.text!, /Call smart_checkpoint first/);

  // A deferral lands in the caller's ledger, not the worker's.
  await tool("smart_defer_compaction").execute({ reason: "mid-edit", minutes: 5 }, context("agent-a"));
  assert.ok(JSON.parse(await readFile(join(home, "plugin-data/smart-session/asks/agent-a.json"), "utf8")).deferredUntil);

  const failed = await nativeTools(async () => { throw new Error("daemon away"); })
    .find(t => t.name === "smart_budget_status")!.execute({}, context("agent-a"));
  assert.equal(failed.isError, true); assert.match(failed.text!, /daemon away/);
});

test("hook text names whichever tool set the agent has", () => {
  const text = "Call checkpoint first, then call request_compaction; or call defer_compaction. The checkpoint tool.";
  assert.equal(named(text, false), text);
  assert.equal(named(text, true), "Call smart_checkpoint first, then call smart_request_compaction; or call smart_defer_compaction. The checkpoint tool.");
});
