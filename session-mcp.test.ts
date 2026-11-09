import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contributeSessionMcp } from "./server/session-mcp.ts";
import { writeSettings } from "./server/settings.ts";
import type { PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";

async function fixture(t: test.TestContext, config: Record<string, unknown> = {}) {
  const home = await mkdtemp(join(tmpdir(), "smart-session-open-"));
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous; await rm(home, { recursive: true, force: true }); });
  const directory = join(home, "plugin");
  await mkdir(join(directory, "hooks"), { recursive: true });
  for (const script of ["context-threshold.mjs", "ask-compact.mjs", "post-compact.mjs"]) await writeFile(join(directory, "hooks", script), "// fixture");
  await writeFile(join(home, "config.json"), JSON.stringify({ plugins: { "smart-session": { path: directory } }, ...config }));
  let callback: any, removed = false;
  const remove = contributeSessionMcp({ before(name, handler) { assert.equal(name, "agent.session_open"); callback = handler; return () => { removed = true; }; } } as PluginServerContext, async () => ({}));
  return { home, directory, open: (request: unknown) => callback({ request }), remove: () => { remove(); return removed; } };
}

const base = { agentId: "agent-one", provider: "claude", purpose: "interactive", reason: "create", workspaceId: "w", cwd: "/fixture", labels: {}, env: { KEEP: "yes" }, mcpServers: { unrelated: { type: "http", url: "https://example.invalid" } } } as unknown as PluginSessionOpenRequest;

test("Paseo 0.15+: tools go on request.tools, with no per-agent process", async t => {
  const { open, remove } = await fixture(t);
  const request = { ...base, tools: [{ name: "other_tool" }] } as unknown as PluginSessionOpenRequest;
  for (const provider of ["claude", "codex"]) for (const reason of ["create", "resume", "refresh", "import"]) {
    const result = await open({ ...request, provider, reason });
    assert.equal(result.mcpServers, request.mcpServers, "no stdio server");
    assert.deepEqual(result.tools.map((tool: { name: string }) => tool.name), ["other_tool", "smart_context_status", "smart_budget_status", "smart_checkpoint", "smart_request_compaction", "smart_defer_compaction"]);
    assert.equal(result.env.KEEP, "yes"); assert.equal(result.env.SMART_SESSION_TOOLS, "native");
  }
  assert.equal(request.tools.length, 1, "the request is not mutated");
  assert.equal(await open({ ...request, purpose: "history" }), undefined);
  assert.equal(await open({ ...request, labels: { "plugin-tools/enabled": "false" } }), undefined);
  await writeSettings({ enabled: false });
  assert.equal(await open(request), undefined);
  await writeSettings({ enabled: true }); // the settings path is fixed at import
  assert.equal(remove(), true);
});

test("falls back to a stdio server for this launch when the host won't serve plugin tools", async t => {
  for (const [why, config, tools] of [
    ["Paseo 0.14 (no request.tools)", {}, undefined],
    ["daemon MCP off", { daemon: { mcp: { enabled: false } } }, []],
    ["not injected into agents", { daemon: { mcp: { injectIntoAgents: false } } }, []],
    ["provider's Paseo tools off", { agents: { providers: { claude: { paseoTools: { enabled: false } } } } }, []],
    ["smart_ tools disabled", { agents: { providers: { claude: { paseoTools: { disabledTools: ["smart_checkpoint"] } } } } }, []],
  ] as const) {
    const { home, directory, open } = await fixture(t, config);
    const result = await open({ ...base, ...(tools ? { tools } : {}) });
    const server = result.mcpServers["smart-session"];
    assert.ok(server, why);
    assert.equal(result.mcpServers.unrelated, base.mcpServers.unrelated);
    assert.equal(server.env.PASEO_AGENT_ID, "agent-one"); assert.equal(server.env.PASEO_HOME, home);
    assert.deepEqual(server.args, [join(directory, "mcp.mjs")]);
    assert.equal(result.env.SMART_SESSION_TOOLS, "stdio", why);
    assert.equal(result.tools, tools, why);
  }
  assert.equal(Object.keys(base.mcpServers).length, 1);
});
