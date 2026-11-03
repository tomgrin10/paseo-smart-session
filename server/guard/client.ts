import type { Agent, Usage } from "../../shared/guard/policy.ts";
import type { ListedPlugin } from "./standalone.ts";

/**
 * The slice of Paseo's daemon client that Session Guard uses, typed.
 *
 * It is the same short-lived client `server/daemon.ts` opens for the recorder; this
 * is only a narrower, typed view of it. The optional members arrived in later daemon
 * versions, and the engine checks for them before relying on them.
 */
export interface GuardClient {
  fetchAgents(options?: { filter?: { includeArchived?: boolean }; page?: { limit: number; cursor?: string } }): Promise<{
    entries: readonly { agent: Agent }[];
    pageInfo?: { hasMore: boolean; nextCursor?: string | null };
  }>;
  fetchAgent(agentId: string): Promise<{ agent: Agent } | null>;
  listProviderUsage(): Promise<Usage>;
  setWorkspaceLabel?(options: { workspaceId: string; label: { name: string; color: "amber" }; assigned: boolean }): Promise<unknown>;
  invokePluginRpc?(pluginId: string, method: string, input: unknown): Promise<unknown>;
  getDaemonStatus?(): Promise<{ pid: number }>;
  listPlugins?(): Promise<readonly ListedPlugin[]>;
  listProviderSubagents?(agentId: string): Promise<{ subagents: readonly { status: string }[] }>;
  cancelAgent(agentId: string): Promise<void>;
  sendMessage(agentId: string, text: string, options?: { messageId: string; activeTurnBehavior: "steer" }): Promise<unknown>;
}

export type Connect = <T>(work: (client: GuardClient) => Promise<T>) => Promise<T>;
