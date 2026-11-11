// Native agent tools check: Smart Session's tools reach agents through Paseo's own MCP, with no
// per-agent `node mcp.mjs`.
//
// Starts an isolated Paseo daemon (never the user's) with its agent MCP on, installs a fixture provider
// and the packed plugin, creates N agents and reads each launch config: how many carry a smart-session
// stdio server and whether the agent got the daemon's MCP. Then it calls the tools over that MCP as one
// agent, the way Claude or Codex would, and checks the daemon's caller identity reached the tool.
//
//   node check-native-tools.mjs [--agents 10] [--stdio] [--json]
//
// --stdio forces the per-launch stdio server (the fallback) for comparison.
//
//   node check-native-tools.mjs --start-time [--agents 3] [--rounds 2]
//
// Local only, needs a logged-in `claude`: times opening an unloaded Claude agent (the app's timeline
// fetch, which starts the provider CLI and its MCP servers) with no Smart Session tools, with the stdio
// server and with native tools, and reads each agent's process tree once it has settled.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { openSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";

const exec = promisify(execFile);
try { await exec("paseo", ["--version"], { timeout: 30_000 }); } catch {
  const message = "native tools check: the paseo CLI isn't on PATH (npm i -g @getpaseo/cli@0.15.2).";
  if (process.env.CI) { console.error(`${message} Required in CI.`); process.exit(1); }
  console.warn(`${message} Skipping.`); process.exit(0);
}
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const START_TIME = process.argv.includes("--start-time");
const N = Number(arg("agents", START_TIME ? "3" : "10"));
const STDIO = process.argv.includes("--stdio");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = await mkdtemp(join(tmpdir(), "smart-session-native-"));
// --start-time keeps the real HOME: Claude needs its login. Everything Paseo owns stays in the sandbox.
const home = join(root, "home"); const paseoHome = join(root, "paseo");
const free = async () => { const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };
const port = await free(); const url = `ws://127.0.0.1:${port}/ws`;
const baseEnv = { ...process.env, ...(START_TIME ? {} : { HOME: home, XDG_CONFIG_HOME: join(home, ".config") }), PASEO_HOME: paseoHome, PASEO_DAEMON_URL: url, PASEO_RELAY_ENABLED: "false" };
for (const key of ["PASEO_PASSWORD", "PASEO_PASSWORD_FILE", "PASEO_AGENT_ID", "PASEO_WORKSPACE_ID", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "SMART_SESSION_TOOLS"]) delete baseEnv[key];
const cli = async (...args) => JSON.parse((await exec("paseo", ["--home", paseoHome, "--json", ...args], { env: baseEnv, timeout: 120_000, maxBuffer: 8 << 20 })).stdout);
let daemon = null; let client = null;

async function startDaemon(extra) {
  const log = openSync(join(root, "daemon.log"), "a");
  daemon = spawn("paseo", ["daemon", "run", "--home", paseoHome], { env: { ...baseEnv, ...extra }, stdio: ["ignore", log, log] });
  for (let i = 0; i < 120; i++) {
    try { await cli("workspace", "ls"); break; } catch {
      assert.equal(daemon.exitCode, null, "isolated daemon exited");
      if (i === 119) throw new Error("isolated daemon did not start");
      await sleep(250);
    }
  }
  client = new DaemonClient({ url, clientId: "smart-session-native-check", clientType: "cli", reconnect: { enabled: false }, suppressSendErrors: true });
  await client.connect();
}
async function stopDaemon() {
  await client?.close().catch(() => {}); client = null;
  if (daemon && daemon.exitCode === null) { daemon.kill("SIGTERM"); await new Promise((r) => daemon.once("exit", r)); }
  daemon = null;
}

/** One MCP JSON-RPC exchange over streamable HTTP (JSON or SSE replies). */
async function mcp(server, session, body) {
  const response = await fetch(server.url, { method: "POST", headers: { ...server.headers, "content-type": "application/json", accept: "application/json, text/event-stream", ...(session.id ? { "mcp-session-id": session.id } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", ...body }) });
  session.id = response.headers.get("mcp-session-id") ?? session.id;
  const text = await response.text();
  if (body.id === undefined) return null;
  const json = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop());
  if (json.error) throw new Error(`${body.method}: ${json.error.message}`);
  return json.result;
}

/** Every process under `pid`, with its command line and proportional memory. */
function tree(pid) {
  const children = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try { const ppid = Number(readFileSync(`/proc/${entry}/stat`, "utf8").split(") ")[1].split(" ")[1]); (children.get(ppid) ?? children.set(ppid, []).get(ppid)).push(Number(entry)); } catch {}
  }
  const out = [];
  const walk = (p) => { for (const child of children.get(p) ?? []) {
    try {
      const cmd = readFileSync(`/proc/${child}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      const pss = Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${child}/smaps_rollup`, "utf8"))?.[1] ?? 0) / 1024;
      out.push({ pid: child, cmd, pssMb: pss });
    } catch {}
    walk(child);
  } };
  walk(pid);
  return out;
}

async function installPlugin() {
  const plugin = join(root, "plugin"); await mkdir(plugin);
  const packed = JSON.parse((await exec("npm", ["pack", "--json", "--pack-destination", root], { timeout: 60_000 })).stdout)[0];
  await exec("tar", ["-xzf", join(root, packed.filename), "--strip-components=1", "-C", plugin]);
  await cli("plugin", "install", plugin);
}

async function writeConfig() {
  await mkdir(join(paseoHome, "plugin-data", "smart-session"), { recursive: true });
  await writeFile(join(paseoHome, "config.json"), JSON.stringify({ pluginsEnabled: true, daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false }, mcp: { enabled: true, injectIntoAgents: true }, browserTools: { enabled: false } } }));
  // The sandbox never writes the real Claude settings, even with the real HOME.
  await writeFile(join(paseoHome, "plugin-data", "smart-session", "settings.json"), JSON.stringify({ installHooks: false }));
}

async function fixtureCheck() {
  await mkdir(home, { recursive: true });
  await writeConfig();
  const fixture = join(root, "fixture"); await mkdir(fixture);
  await writeFile(join(fixture, "paseo-plugin.json"), JSON.stringify({ id: "smart-session-fixture", requirements: { paseo: ">=0.11.0" } }));
  await writeFile(join(fixture, "index.server.ts"), await readFile("check-native/fixture-provider.ts", "utf8"));
  await startDaemon({ SMART_SESSION_TOOL_PROVIDERS: "claude,codex,smart-session-fixture", ...(STDIO ? { SMART_SESSION_FORCE_STDIO: "1" } : {}) });
  await cli("plugin", "install", fixture);
  await installPlugin();
  const api = createPaseoApi(client);
  const created = [];
  for (let i = 0; i < N; i++) {
    const dir = join(root, "projects", `w${i}`); await mkdir(dir, { recursive: true });
    const w = await api.workspaces.create({ title: `Synthetic workspace ${i}`, source: { kind: "directory", path: dir } });
    const a = await w.agents.create({ config: { provider: "smart-session-fixture/fixture", model: "fixture", modeId: "default" }, title: `Synthetic agent ${i}` });
    created.push(a.id);
  }
  await sleep(1_500);
  const configs = await Promise.all(created.map(async (id) => JSON.parse(await readFile(join(paseoHome, `fixture-agent-config-${id}.json`), "utf8"))));
  const stdioServers = configs.filter((c) => c.mcpServers?.["smart-session"]?.type === "stdio").length;
  const result = { mode: STDIO ? "stdio" : "native", agents: N, smartSessionStdioServers: stdioServers, agentsWithPaseoMcp: configs.filter((c) => Object.values(c.mcpServers ?? {}).some((s) => s?.type === "http")).length, toolsEnv: [...new Set(configs.map((c) => c.env?.SMART_SESSION_TOOLS))], smartTools: 0, calls: null };
  const server = Object.values(configs[0].mcpServers ?? {}).find((s) => s?.type === "http");
  if (server) {
    const session = {};
    await mcp(server, session, { id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smart-session-native-check", version: "1" } } });
    await mcp(server, session, { method: "notifications/initialized" });
    const tools = (await mcp(server, session, { id: 2, method: "tools/list" })).tools.map((t) => t.name);
    result.smartTools = tools.filter((n) => n.startsWith("smart_")).length;
    if (!STDIO) {
      assert.deepEqual(tools.filter((n) => n.startsWith("smart_")).sort(), ["smart_budget_status", "smart_checkpoint", "smart_context_status", "smart_defer_compaction", "smart_publish_as", "smart_publish_as_settings", "smart_request_compaction"]);
      const call = async (id, name, args) => (await mcp(server, session, { id, method: "tools/call", params: { name, arguments: args } })).content[0].text;
      const written = await call(3, "smart_checkpoint", { goal: "Synthetic goal", current_step: "Synthetic step" });
      // The daemon's caller identity picked the state file: the first agent's, keyed by its id.
      assert.match(written, new RegExp(`state/${created[0]}\\.md`));
      assert.match(await readFile(join(paseoHome, "plugin-data", "smart-session", "state", `${created[0]}.md`), "utf8"), /Synthetic goal/);
      const refused = await call(4, "smart_request_compaction", { reason: "synthetic", continue_after_compaction: false });
      const context = await call(5, "smart_context_status", {});
      result.calls = { checkpoint: "state file keyed by the calling agent", request_compaction: refused.split("\n")[0], context_status: context.split("\n")[0] };

      // A plugin reload (every update) detaches native tools from open sessions; Paseo 0.15.2 reattaches them only when
      // a session reopens, before that agent's next prompt. Mid-turn the hooks point at `mcp.mjs call`.
      const data = join(paseoHome, "plugin-data", "smart-session");
      const instance = async () => JSON.parse(await readFile(join(data, "tools-instance.json"), "utf8").catch(() => "{}")).instance;
      const marker = async () => JSON.parse(await readFile(join(data, "tools", `native-${created[0]}.json`), "utf8")).instance;
      // The queued compaction above would be delivered to this idle agent as a prompt, which reopens the session.
      for (const item of (await client.invokePluginRpc("smart-session", "smart-session.compact.list", { agentId: created[0] })).items ?? []) {
        if (item.state === "queued" || item.state === "pending") await client.invokePluginRpc("smart-session", "smart-session.compact.cancel", { id: item.id });
      }
      const before = await instance();
      await cli("plugin", "reload", "smart-session");
      let after = before;
      for (let i = 0; i < 80 && after === before; i++) { await sleep(250); after = (await instance()) ?? before; }
      assert.notEqual(after, before, "the reloaded worker records a new instance");
      const stale = await mcp(server, session, { id: 6, method: "tools/call", params: { name: "smart_context_status", arguments: {} } }).then((r) => (r?.isError ? r.content?.[0]?.text ?? "error" : null), (e) => e.message);
      assert.match(stale ?? "", /not found/i, "a detached tool fails until the session reopens");
      assert.equal(await marker(), before, "the hooks see the session as detached");
      const plugin = JSON.parse(await readFile(join(paseoHome, "config.json"), "utf8")).plugins?.["smart-session"]?.path;
      const bridged = (await exec(process.execPath, [join(plugin, "mcp.mjs"), "call", "checkpoint", JSON.stringify({ current_step: "Bridged step" })], { env: { ...baseEnv, ...configs[0].env, PASEO_AGENT_ID: created[0] }, timeout: 60_000 })).stdout;
      assert.match(bridged, new RegExp(`state/${created[0]}\\.md`), "the bridge serves the same tool mid-turn as the same agent");
      await client.sendAgentMessage(created[0], "Synthetic follow-up prompt");
      for (let i = 0; i < 80 && (await marker()) !== after; i++) await sleep(250);
      assert.equal(await marker(), after, "the next prompt reopened the session under the new worker");
      const reopened = JSON.parse(await readFile(join(paseoHome, `fixture-agent-config-${created[0]}.json`), "utf8"));
      const server2 = Object.values(reopened.mcpServers ?? {}).find((s) => s?.type === "http"); const session2 = {};
      await mcp(server2, session2, { id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smart-session-native-check", version: "1" } } });
      await mcp(server2, session2, { method: "notifications/initialized" });
      const again = (await mcp(server2, session2, { id: 2, method: "tools/call", params: { name: "smart_checkpoint", arguments: { current_step: "Native again" } } })).content[0].text;
      assert.match(again, new RegExp(`state/${created[0]}\\.md`), "smart_checkpoint works again after the reload");
      result.reload = { midTurnNative: "fails (detached)", midTurnBridge: "ok", afterNextPrompt: "ok" };
    }
  }
  if (STDIO) assert.equal(stdioServers, N, "stdio mode: one server per agent");
  else { assert.equal(stdioServers, 0, "native mode: no per-agent server"); assert.ok(result.smartTools > 0); assert.deepEqual(result.toolsEnv, ["native"]); }
  return result;
}

const MODES = { none: { SMART_SESSION_TOOL_PROVIDERS: "none" }, stdio: { SMART_SESSION_FORCE_STDIO: "1" }, native: {} };

async function startTime() {
  await writeConfig();
  await startDaemon(MODES.native);
  await installPlugin();
  const api = createPaseoApi(client);
  const agents = [];
  for (let i = 0; i < N; i++) {
    const dir = join(root, "projects", `w${i}`); await mkdir(dir, { recursive: true });
    const w = await api.workspaces.create({ title: `Synthetic workspace ${i}`, source: { kind: "directory", path: dir } });
    const agent = await w.agents.create({ config: { provider: "claude/claude-haiku-5-5", modeId: "default" }, title: `Synthetic agent ${i}` });
    // One tiny turn, so the agent has a provider session to come back to (an agent with none opens from nothing).
    await agent.run("Reply with the single word OK.", { timeoutMs: 180_000 });
    agents.push(agent.id);
  }
  await sleep(5_000);
  const rows = [];
  for (let round = 0; round < Number(arg("rounds", "2")); round++) {
    for (const [mode, env] of Object.entries(MODES)) {
      // A fresh daemon: every agent is persisted but unloaded, as after a restart or idle unload.
      await stopDaemon(); await startDaemon(env);
      for (const agentId of agents) {
        const before = tree(daemon.pid).length;
        const t0 = performance.now();
        await client.fetchAgentTimeline(agentId, { limit: 50, timeout: 120_000 });
        const ms = Math.round(performance.now() - t0);
        // On 0.15.2 the open restores the timeline from persistence and starts nothing; the provider CLI and its MCP
        // servers start with the next prompt. Time that too: one tiny turn, prompt to finished.
        const t1 = performance.now();
        await client.sendAgentMessage(agentId, "Reply with the single word OK.");
        await client.waitForFinish(agentId, 180_000);
        const promptMs = Math.round(performance.now() - t1);
        await sleep(3_000);
        const procs = tree(daemon.pid);
        const smart = procs.filter((p) => /smart-session.*mcp\.mjs/.test(p.cmd));
        rows.push({ round, mode, agentId: agentId.slice(0, 8), openMs: ms, promptMs, newProcesses: procs.length - before, smartSessionMcp: smart.length, smartSessionMcpPssMb: Math.round(smart.reduce((s, p) => s + p.pssMb, 0)) });
      }
      const all = tree(daemon.pid);
      rows.push({ round, mode, agentId: "all", treePssMb: Math.round(all.filter((p) => !/paseo daemon|plugin-process|plugin-host/.test(p.cmd)).reduce((s, p) => s + p.pssMb, 0)) });
    }
  }
  return rows;
}

try {
  const result = START_TIME ? await startTime() : await fixtureCheck();
  if (START_TIME) console.table(result); else console.log(process.argv.includes("--json") ? JSON.stringify(result) : result);
} catch (error) { process.exitCode = 1; throw error; } finally {
  await stopDaemon();
  if (process.exitCode) console.error(`daemon log: ${join(root, "daemon.log")}`); else await rm(root, { recursive: true, force: true });
}
