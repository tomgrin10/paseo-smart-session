import { z } from "zod";
import type { AgentToolContext, AgentToolDefinition, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { TOOL_SHAPES, agentTools, named } from "./agent-tools.mjs";

/**
 * Smart Session's agent tools served natively (Paseo 0.15+). At `agent.session_open` they go on
 * `request.tools`, and the daemon lists them on the agent's own Paseo MCP server and routes each
 * call here over IPC. No process per agent, and the caller's id comes from the daemon's per-agent
 * endpoint rather than an environment variable. `mcp.mjs` stays as the per-launch fallback where
 * the host doesn't serve plugin tools (`nativeToolsAvailable`).
 *
 * Names carry a `smart_` prefix: plugin tools share one namespace with Paseo's own, and a
 * collision fails the agent's whole Paseo tool list.
 */
export const PREFIX = "smart_";

type PaseoConfig = {
  daemon?: { mcp?: { enabled?: boolean; injectIntoAgents?: boolean } };
  agents?: { providers?: Record<string, { paseoTools?: { enabled?: boolean; disabledTools?: string[] } }> };
};

/** Whether this host serves plugin tools to this agent: `request.tools` exists, the daemon injects its MCP, and the provider's Paseo tools aren't off. */
export function nativeToolsAvailable(request: Pick<PluginSessionOpenRequest, "provider"> & { tools?: unknown }, config: PaseoConfig | null): boolean {
  if (!Array.isArray(request.tools)) return false;
  if (config?.daemon?.mcp?.enabled === false || config?.daemon?.mcp?.injectIntoAgents === false) return false;
  const policy = config?.agents?.providers?.[request.provider]?.paseoTools;
  if (policy?.enabled === false) return false;
  return !policy?.disabledTools?.some((name) => name.startsWith(PREFIX));
}

/** Calls one of this plugin's RPCs in-process, as the stdio server would over the daemon. */
export type Invoke = (method: string, input: unknown, context: AgentToolContext) => Promise<unknown>;

const fromJSONSchema = (schema: unknown): z.ZodType =>
  (z as unknown as { fromJSONSchema: (schema: unknown) => z.ZodType }).fromJSONSchema(schema);

/** The tool definitions for one session. The same text and rules as `mcp.mjs`, run in this process. */
export function nativeTools(invoke: Invoke): AgentToolDefinition[] {
  // Built once per worker: the definitions hold no per-session state (the caller comes with each call).
  const cached = built.get(invoke);
  if (cached) return cached;
  const tools = TOOL_SHAPES.map((shape) => ({
    name: PREFIX + shape.name,
    description: named(shape.description, true),
    input: fromJSONSchema(shape.inputSchema),
    async execute(input: unknown, context: AgentToolContext) {
      try {
        const tools = agentTools({ agentId: context.agent.id, call: (method, payload) => invoke(method, payload, context) });
        const text = await tools[shape.name as keyof typeof tools].run((input ?? {}) as Record<string, unknown>);
        return { text: named(text, true) };
      } catch (error) {
        // A tool result, not a protocol error, so the model reads it, as in mcp.mjs.
        return { isError: true, text: `Failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  }));
  built.set(invoke, tools);
  return tools;
}
const built = new WeakMap<Invoke, AgentToolDefinition[]>();
