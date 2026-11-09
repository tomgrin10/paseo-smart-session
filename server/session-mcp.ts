import type { PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readPointer, shimFor } from "./hook-path.ts";
import { mcpDefinition, resolvePluginDir } from "./install.ts";
import { type Invoke, nativeTools, nativeToolsAvailable } from "./native-tools.ts";
import { readSettings } from "./settings.ts";

const paseoHome = () => process.env.PASEO_HOME ?? join(homedir(), ".paseo");

async function paseoConfig(): Promise<Record<string, any> | null> {
  try { return JSON.parse(await readFile(join(paseoHome(), "config.json"), "utf8")); } catch { return null; }
}

/** Providers whose sessions get the tools. A test harness may widen it to its fixture provider. */
const providers = () => (process.env.SMART_SESSION_TOOL_PROVIDERS ?? "claude,codex").split(",").map((name) => name.trim());

/**
 * The agent tools are a launch contribution, so nothing global is written. On Paseo 0.15+ they go
 * on `request.tools` and the daemon serves them through the agent's own Paseo MCP; otherwise this
 * launch alone gets `mcp.mjs` as a stdio server. `SMART_SESSION_TOOLS` tells the hooks which names
 * the agent has (`smart_checkpoint` or `checkpoint`).
 */
export function contributeSessionMcp(server: PluginServerContext, invoke: Invoke) {
  // A reload or update detaches native tools from open sessions until each reopens. This worker's instance, and the
  // instance that attached each session, let the hooks tell a detached session how to reach the tools meanwhile
  // (hooks/context.mjs toolsMode). Written synchronously, before any session can open.
  const instance = randomUUID();
  const data = join(paseoHome(), "plugin-data", "smart-session");
  try {
    mkdirSync(join(data, "tools"), { recursive: true });
    writeFileSync(join(data, `tools-instance.json.${instance}`), JSON.stringify({ instance }));
    renameSync(join(data, `tools-instance.json.${instance}`), join(data, "tools-instance.json"));
  } catch { /* Without it the hooks assume the tools are attached. */ }
  return server.before("agent.session_open", async ({ request }) => {
    if (request.purpose !== "interactive" || !providers().includes(request.provider)
      || request.labels["plugin-tools/enabled"] === "false" || !(await readSettings()).enabled) return;
    if (process.env.SMART_SESSION_FORCE_STDIO !== "1" && nativeToolsAvailable(request, await paseoConfig())) {
      await writeFile(join(data, "tools", `native-${request.agentId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`), JSON.stringify({ instance })).catch(() => undefined);
      return { ...request, env: { ...request.env, SMART_SESSION_TOOLS: "native" }, tools: [...request.tools, ...nativeTools(invoke)] };
    }
    return withStdio(request);
  });
}

async function withStdio(request: PluginSessionOpenRequest): Promise<PluginSessionOpenRequest | void> {
  const directory = await resolvePluginDir();
  if (!directory) return;
  // Through the stable shim when it is in place, so a session opened just before an
  // update does not hold a path Paseo is about to delete.
  const shim = shimFor("mcp.mjs");
  const definition = mcpDefinition(directory, undefined, (await readPointer()) === directory && existsSync(shim) ? shim : undefined);
  return {
    ...request,
    env: { ...request.env, SMART_SESSION_TOOLS: "stdio" },
    mcpServers: { ...request.mcpServers, "smart-session": { ...definition, env: {
      ...definition.env, PASEO_AGENT_ID: request.agentId,
      PASEO_HOME: paseoHome(), SMART_SESSION_MCP_SCOPE: "paseo",
      ...(process.env.PASEO_DAEMON_URL ? { PASEO_DAEMON_URL: process.env.PASEO_DAEMON_URL } : {}),
      ...(process.env.PASEO_PASSWORD ? { PASEO_PASSWORD: process.env.PASEO_PASSWORD } : {}),
      ...(process.env.PASEO_PASSWORD_FILE ? { PASEO_PASSWORD_FILE: process.env.PASEO_PASSWORD_FILE } : {}),
    } } },
  };
}
