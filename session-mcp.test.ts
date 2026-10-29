import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contributeSessionMcp } from "./server/session-mcp.ts";
import { writeSettings } from "./server/settings.ts";
import type { PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";

test("MCP attaches to current Paseo sessions without modifying saved MCP configuration", async t => {
  const home = await mkdtemp(join(tmpdir(), "smart-session-open-"));
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous; await rm(home, { recursive: true, force: true }); });
  const directory = join(home, "plugin");
  await mkdir(join(directory, "hooks"), { recursive: true });
  for (const script of ["context-threshold.mjs", "ask-compact.mjs", "post-compact.mjs"]) await writeFile(join(directory, "hooks", script), "// fixture");
  const config = JSON.stringify({ plugins: { "smart-session": { path: directory } } });
  await writeFile(join(home, "config.json"), config);
  let callback: any, removed = false;
  const remove = contributeSessionMcp({ before(name, handler) { assert.equal(name, "agent.session_open"); callback = handler; return () => { removed = true; }; } } as PluginServerContext);
  const request = { agentId: "agent-one", provider: "claude", purpose: "interactive", reason: "create", workspaceId: "w", cwd: "/fixture", labels: {}, tools: [], env: { KEEP: "yes" }, mcpServers: { unrelated: { type: "http", url: "https://example.invalid" } } } as unknown as PluginSessionOpenRequest;
  for (const provider of ["claude", "codex"]) for (const reason of ["create", "resume", "refresh", "import"]) {
    const result = await callback({ request: { ...request, provider, reason } });
    assert.equal(result.env, request.env);
    assert.equal(result.mcpServers.unrelated, request.mcpServers.unrelated);
    assert.equal(result.mcpServers["smart-session"].env.PASEO_AGENT_ID, "agent-one");
    assert.equal(result.mcpServers["smart-session"].env.PASEO_HOME, home);
    assert.deepEqual(result.mcpServers["smart-session"].args, [join(directory, "mcp.mjs")]);
  }
  assert.equal(await callback({ request: { ...request, purpose: "history" } }), undefined);
  assert.equal(await callback({ request: { ...request, labels: { "plugin-tools/enabled": "false" } } }), undefined);
  await writeSettings({ enabled: false });
  assert.equal(await callback({ request }), undefined);
  remove(); assert.equal(removed, true);
  assert.equal(Object.keys(request.mcpServers).length, 1);
});
