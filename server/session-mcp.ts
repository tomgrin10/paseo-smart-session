import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import { mcpDefinition, resolvePluginDir } from "./install.ts";
import { readSettings } from "./settings.ts";

/** MCP is a launch contribution, so it never writes global provider settings. */
export function contributeSessionMcp(server: PluginServerContext) {
  return server.before("agent.session_open", async ({ request }) => {
    if (request.purpose !== "interactive" || !["claude", "codex"].includes(request.provider)
      || request.labels["plugin-tools/enabled"] === "false" || !(await readSettings()).enabled) return;
    const directory = await resolvePluginDir();
    if (!directory) return;
    const definition = mcpDefinition(directory);
    return {
      ...request,
      mcpServers: { ...request.mcpServers, "smart-session": { ...definition, env: {
        ...definition.env, PASEO_AGENT_ID: request.agentId,
        PASEO_HOME: process.env.PASEO_HOME ?? join(homedir(), ".paseo"), SMART_SESSION_MCP_SCOPE: "paseo",
        ...(process.env.PASEO_DAEMON_URL ? { PASEO_DAEMON_URL: process.env.PASEO_DAEMON_URL } : {}),
        ...(process.env.PASEO_PASSWORD ? { PASEO_PASSWORD: process.env.PASEO_PASSWORD } : {}),
        ...(process.env.PASEO_PASSWORD_FILE ? { PASEO_PASSWORD_FILE: process.env.PASEO_PASSWORD_FILE } : {}),
      } } },
    };
  });
}
