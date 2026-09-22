import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

interface JsonRpcResponse {
  id: number;
  result?: { tools?: Array<{ name: string }> };
}

async function listTools(options: { agentId?: string; scope?: string } = {}): Promise<string[]> {
  const env = { ...process.env };
  delete env.PASEO_AGENT_ID;
  delete env.SMART_SESSION_MCP_SCOPE;
  if (options.agentId !== undefined) env.PASEO_AGENT_ID = options.agentId;
  if (options.scope !== undefined) env.SMART_SESSION_MCP_SCOPE = options.scope;

  const child = spawn(process.execPath, ["mcp.mjs"], {
    cwd: process.cwd(),
    env,
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
  assert.equal(exitCode, 0, `mcp.mjs exited unsuccessfully: ${stderr}`);

  const response = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as JsonRpcResponse)
    .find((message) => message.id === 2);
  assert.ok(response?.result?.tools, `tools/list response missing from: ${stdout}`);
  return response.result.tools.map((tool) => tool.name).sort();
}

test("MCP exposes only budget_status outside a Paseo agent", async () => {
  assert.deepEqual(await listTools(), ["budget_status"]);
});

test("MCP can be explicitly hidden outside Paseo without hiding agent tools", async () => {
  assert.deepEqual(await listTools({ scope: "paseo" }), []);
  assert.deepEqual(await listTools({ agentId: "agent-123", scope: "paseo" }), [
    "budget_status",
    "checkpoint",
    "context_status",
    "defer_compaction",
    "request_compaction",
  ]);
});
