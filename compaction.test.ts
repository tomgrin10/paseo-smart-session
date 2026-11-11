import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { confirmation, continuationInstructions, landed } from "./shared/governor.ts";
// @ts-expect-error -- a dependency-free hook module with no type declarations.
import { confirmedAt as hookConfirmedAt, thrashing } from "./hooks/ask.mjs";

interface ToolDescription {
  name: string;
  inputSchema: {
    properties?: Record<string, unknown>;
  };
}

async function agentTools(): Promise<ToolDescription[]> {
  const child = spawn(process.execPath, ["mcp.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PASEO_AGENT_ID: "agent-test" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]
      .map((request) => JSON.stringify(request))
      .join("\n") + "\n",
  );

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, stderr);
  const response = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((message) => message.id === 2);
  return response.result.tools;
}

test("request_compaction lets the agent choose whether and how to continue", async () => {
  const request = (await agentTools()).find((tool) => tool.name === "request_compaction");
  assert.ok(request);
  assert.ok(request.inputSchema.properties?.continue_after_compaction);
  assert.ok(request.inputSchema.properties?.continue_message);
});

test("continuation delivery honours the agent's choice and exact message", () => {
  assert.equal(
    continuationInstructions({
      continueAfterCompaction: false,
      continuationMessage: null,
      statePath: "/tmp/state.md",
    }),
    null,
  );

  const custom = "Open the release checklist and start with the pending verification step.";
  assert.equal(
    continuationInstructions({
      continueAfterCompaction: true,
      continuationMessage: custom,
      statePath: "/tmp/state.md",
    }),
    custom,
  );

  const fallback = continuationInstructions({
    continueAfterCompaction: true,
    continuationMessage: null,
    statePath: "/tmp/state.md",
  });
  assert.match(fallback ?? "", /\/tmp\/state\.md/);
  assert.match(fallback ?? "", /Current step/);
});

/* -------------------------------------------------------------------------- *
 * A compaction counts only once it is confirmed.
 * -------------------------------------------------------------------------- */

const at = (minutes: number) => new Date(Date.parse("2026-11-11T11:27:00Z") + minutes * 60_000).toISOString();
const sent = { agentId: "a", state: "sent" as const, settledAt: at(0), confirmedAt: null, postTokens: null };
const postCompact = (minutes: number, agentId = "a") => ({ at: at(minutes), event: "PostCompact", agentId });

const CASES: Array<[string, Parameters<typeof confirmation>[0], ReturnType<typeof postCompact>[], string | null]> = [
  ["delivered, then cancelled: no record, no shrink", sent, [], null],
  ["confirmed by the governor", { ...sent, confirmedAt: at(1), postTokens: 40_000 }, [], at(1)],
  ["graded before confirmedAt existed", { ...sent, postTokens: 40_000 }, [], at(0)],
  ["the session's PostCompact after delivery", sent, [postCompact(1)], at(1)],
  ["a PostCompact from before delivery", sent, [postCompact(-5)], null],
  ["another agent's PostCompact", sent, [postCompact(1, "b")], null],
  ["still queued", { ...sent, state: "pending", settledAt: null }, [postCompact(1)], null],
  ["failed to send", { ...sent, state: "failed" }, [postCompact(1)], null],
];

test("a compaction counts only once confirmed, never on delivery", () => {
  for (const [name, item, events, expected] of CASES) assert.equal(confirmation(item, events), expected, name);
});

test("the hooks' copy of the rule agrees with the server's on every case", () => {
  for (const [name, item, events, expected] of CASES) assert.equal(hookConfirmedAt(item, events), expected, name);
});

test("thrashing needs a confirmed compaction in the window, not a delivered one", () => {
  const now = Date.parse(at(3));
  assert.equal(thrashing([sent], "a", now, []), false, "the cancelled f01c50e2 case");
  assert.equal(thrashing([sent], "a", now, [postCompact(1)]), true);
  assert.equal(thrashing([{ ...sent, confirmedAt: at(1), postTokens: 40_000 }], "a", now, []), true);
  assert.equal(thrashing([{ ...sent, confirmedAt: at(1), postTokens: 40_000 }], "a", Date.parse(at(20)), []), false, "outside the window");
});

test("landing means the context really emptied, not a wobble or a missing reading", () => {
  assert.equal(landed(307_740, 40_000), true);
  assert.equal(landed(307_740, 307_700), false, "a cancelled /compact leaves the session the same size");
  assert.equal(landed(307_740, 309_052), false);
  assert.equal(landed(null, 40_000), false, "no reading from before proves nothing");
});
