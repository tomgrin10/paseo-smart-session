import { test } from "node:test";
import assert from "node:assert/strict";
import { compactionInstructions, resumeInstructions } from "./shared/governor.ts";
import { PolicySchema } from "./shared/guard/policy.ts";
import { promptCard, smartSessionTool, toolRow } from "./shared/chat.ts";

const out = (text: string) => ({ type: "unknown", input: {}, output: { content: [{ type: "text", text }] } });

test("only Smart Session's own tools are claimed, under Claude's and Codex's names", () => {
  assert.equal(smartSessionTool("mcp__smart-session__request_compaction"), "request_compaction");
  assert.equal(smartSessionTool("smart-session.checkpoint"), "checkpoint");
  // Served through Paseo's own MCP (1 the Claude form, 2 the Codex form).
  assert.equal(smartSessionTool("mcp__paseo__smart_request_compaction"), "request_compaction");
  assert.equal(smartSessionTool("paseo.smart_checkpoint"), "checkpoint");
  assert.equal(smartSessionTool("mcp__paseo__checkpoint"), null);
  assert.equal(smartSessionTool("mcp__other__checkpoint"), null);
  assert.equal(smartSessionTool("checkpoint"), null);
  assert.equal(smartSessionTool("mcp__smart-session__unknown_tool"), null);
  assert.equal(toolRow("Bash", "completed", {}, null), null);
});

test("context and budget calls read as one line with the numbers that matter", () => {
  const context = toolRow("mcp__smart-session__context_status", "completed",
    out("Context holds 318,442 tokens (31.8% of a 1,000,000-token window). Worth compacting from 30% (300,000 tokens).\nYou are already past that point."), null);
  assert.equal(context?.line, "Checked its context · 32% of 1M · past its 30% line");
  const below = toolRow("mcp__smart-session__context_status", "completed", out("Context holds 64,000 tokens (32% of a 200,000-token window). Worth compacting from 85% (170,000 tokens)."), null);
  assert.equal(below?.line, "Checked its context · 32% of 200k · compacts at 85%");
  const budget = toolRow("mcp__smart-session__budget_status", "completed", out("- Session (5h): 74% used, resets in 1h 58m\n- Week: 41% used, resets in 3d 4h\nSession Guard: on."), null);
  assert.equal(budget?.line, "Checked plan usage · session 74% · week 41%");
  assert.equal(toolRow("mcp__smart-session__budget_status", "running", {}, null)?.line, "Checking plan usage…");
});

test("a checkpoint names its current step; its detail lists what was saved", () => {
  const row = toolRow("mcp__smart-session__checkpoint", "completed", { input: { goal: "Ship retries", current_step: "Cap retries at five", dead_ends: ["Retrying in the webhook"] }, output: { content: [{ type: "text", text: "Task state written to /x/state/a.md (1 new entry)." }] } }, null);
  assert.equal(row?.line, "Saved task state · Cap retries at five");
  assert.equal(row?.detail, "Goal: Ship retries\nCurrent step: Cap retries at five\nDead end: Retrying in the webhook");
});

test("a compaction request says why, and a refusal says what to fix", () => {
  const queued = toolRow("mcp__smart-session__request_compaction", "completed", { input: { reason: "Clean boundary.", continue_after_compaction: false }, output: "Compaction queued (3f9c2a1e). It will be delivered as soon as this session is idle." }, null);
  assert.equal(queued?.state, "done");
  assert.equal(queued?.line, "Asked to compact and stop · Clean boundary.");
  assert.match(queued!.detail, /Then: stop, the task is done/);
  const stale = toolRow("mcp__smart-session__request_compaction", "completed", out("Not queued: /x/a.md was last written 42 minutes ago, so it probably predates the work."), null);
  assert.equal(stale?.state, "refused");
  assert.equal(stale?.line, "Compaction not queued · task state is out of date");
  const missing = toolRow("mcp__smart-session__request_compaction", "completed", out("Not queued: there is no task state at /x/a.md"), null);
  assert.equal(missing?.line, "Compaction not queued · no task state saved yet");
  const failed = toolRow("mcp__smart-session__request_compaction", "failed", {}, "daemon unreachable");
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.detail, "daemon unreachable");
});

test("a deferral reads as how long and why", () => {
  const row = toolRow("mcp__smart-session__defer_compaction", "completed", { input: { reason: "Mid-refactor.", minutes: 20 }, output: "Deferred for 20 minutes (until 2026-11-04T18:40:00Z)." }, null);
  assert.equal(row?.line, "Put off compacting for 20m · Mid-refactor.");
});

test("the messages Smart Session sends become cards; a person's own /compact does not", () => {
  const compact = promptCard(compactionInstructions({ reason: "Backoff is merged.", statePath: "/home/u/.paseo/plugin-data/smart-session/state/a1.md" }));
  assert.deepEqual({ kind: compact?.kind, reason: compact?.reason, statePath: compact?.statePath }, { kind: "compact", reason: "Backoff is merged.", statePath: "/home/u/.paseo/plugin-data/smart-session/state/a1.md" });
  const continued = promptCard(resumeInstructions({ statePath: "/s/a1.md" }));
  assert.equal(continued?.kind, "continue");
  assert.equal(continued?.statePath, "/s/a1.md");
  assert.equal(promptCard(resumeInstructions({ statePath: null }))?.kind, "continue");
  assert.equal(promptCard(PolicySchema.parse({}).continuation)?.kind, "guard-continue", "Session Guard's default continuation");
  assert.equal(promptCard("/compact keep the API notes"), null);
  assert.equal(promptCard("Please continue."), null);
});
