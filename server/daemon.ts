/**
 * Short-lived connections to Paseo's own daemon.
 *
 * The plugin SDK exposes neither provider usage nor per-agent context usage, so
 * this borrows the host's daemon client the way paseo-defer does. Each call opens
 * and closes its own connection: a long-lived socket in this subprocess keeps the
 * event loop alive and hangs Paseo's "Stopping plugin" step, which wedges reload
 * for the life of the daemon.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveDaemonPassword } from "./daemon-password.mjs";

const CONNECT_TIMEOUT_MS = 10_000;

export interface DaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  fetchAgents(): Promise<unknown>;
  listProviderUsage(): Promise<unknown>;
  sendMessage(agentId: string, text: string): Promise<unknown>;
  /** The publish-as helper's lifecycle (`server/publish-as.ts`). */
  createAgent(options: {
    agentId: string;
    provider: string;
    model: string;
    modeId: string;
    cwd: string;
    title: string;
    background: boolean;
    env: Record<string, string>;
    labels: Record<string, string>;
  }): Promise<unknown>;
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
  /** Closes and reopens the provider session with current configuration, rerunning session-open hooks. */
  refreshAgent(agentId: string): Promise<unknown>;
  sendAgentMessage(agentId: string, text: string): Promise<unknown>;
  waitForFinish(agentId: string, timeout?: number): Promise<{ status: string; error: string | null; lastMessage: string | null }>;
  archiveAgent(agentId: string): Promise<unknown>;
}

interface DaemonClientModule {
  DaemonClient: new (options: {
    url: string;
    clientId: string;
    clientType: string;
    reconnect: { enabled: boolean };
    connectTimeoutMs: number;
    suppressSendErrors: boolean;
    password?: string;
  }) => DaemonClient;
}

let daemonClientModule: DaemonClientModule | null = null;

/**
 * The specifier is assembled rather than written as a literal so the plugin
 * compiler cannot resolve it at build time: `paseo plugin add` installs from Git
 * and runs no package manager, so a statically imported dependency fails to
 * compile. Resolving through the subprocess's own `require` also guarantees the
 * client matches the daemon's protocol version exactly.
 */
function loadDaemonClientModule(): DaemonClientModule {
  if (daemonClientModule !== null) return daemonClientModule;
  const specifier = ["@getpaseo", "client", "internal", "daemon-client"].join("/");
  try {
    daemonClientModule = require(specifier) as DaemonClientModule;
  } catch (error) {
    throw new Error(
      `This Paseo host does not expose its daemon client (${specifier}), which Smart Session needs to read plan usage and agent context: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return daemonClientModule;
}

let cachedUrl: string | null = null;

async function resolveUrl(): Promise<string> {
  if (cachedUrl !== null) return cachedUrl;
  const fromEnv = process.env.PASEO_DAEMON_URL;
  if (fromEnv !== undefined && fromEnv !== "") {
    cachedUrl = fromEnv;
    return cachedUrl;
  }
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  let listen: string | undefined;
  try {
    const raw = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as {
      daemon?: { listen?: string };
    };
    listen = raw.daemon?.listen;
  } catch {
    // Fall through to the documented default.
  }
  cachedUrl = `ws://${listen ?? "127.0.0.1:6767"}/ws`;
  return cachedUrl;
}

/** Runs `work` against a connection that is always closed before returning. */
export async function withDaemon<T>(work: (client: DaemonClient) => Promise<T>): Promise<T> {
  const { DaemonClient } = loadDaemonClientModule();
  const password = await resolveDaemonPassword();
  const client = new DaemonClient({
    url: await resolveUrl(),
    clientId: "paseo-smart-session",
    clientType: "cli",
    reconnect: { enabled: false },
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    suppressSendErrors: true,
    ...(password === undefined ? {} : { password }),
  });
  try {
    await client.connect();
    return await work(client);
  } finally {
    try {
      await client.close();
    } catch {
      // Teardown must not mask the original result or error.
    }
  }
}

/**
 * The raw `provider.usage.list` payload.
 *
 * Deliberately untyped past `unknown`: it goes straight into the normalizer in
 * `shared/usage.ts`, which is the one place that knows how to read it, and which
 * tolerates a daemon that renames a field.
 */
export async function readProviderUsage(client: DaemonClient): Promise<unknown> {
  return (await client.listProviderUsage()) as unknown;
}

export type AgentState = "initializing" | "idle" | "running" | "error" | "closed";

export interface AgentRow {
  readonly id: string;
  readonly title: string | null;
  readonly provider: string;
  readonly model: string | null;
  readonly status: AgentState;
  readonly cwd: string | null;
  readonly workspaceId: string | null;
  /** Context occupancy as of the agent's last turn; absent until it has run one. */
  readonly usedTokens: number | null;
  readonly maxTokens: number | null;
  readonly costUsd: number | null;
}

/**
 * Every agent the daemon knows, with its context-window occupancy.
 *
 * `lastUsage` rides on the agent *snapshot* (`entries[].agent`), not on the leaner
 * list-item shape, which carries no usage at all.
 */
export async function readAgents(client: DaemonClient): Promise<AgentRow[]> {
  const payload = (await client.fetchAgents()) as {
    entries?: readonly {
      agent?: {
        id?: string;
        title?: string | null;
        provider?: string;
        model?: string | null;
        status?: string;
        cwd?: string | null;
        workspaceId?: string | null;
        lastUsage?: {
          contextWindowUsedTokens?: number;
          contextWindowMaxTokens?: number;
          totalCostUsd?: number;
        };
      };
    }[];
  };

  const rows: AgentRow[] = [];
  for (const entry of payload.entries ?? []) {
    const agent = entry.agent;
    if (agent?.id === undefined) continue;
    rows.push({
      id: agent.id,
      title: agent.title ?? null,
      provider: agent.provider ?? "unknown",
      model: agent.model ?? null,
      status: (agent.status ?? "closed") as AgentState,
      cwd: agent.cwd ?? null,
      workspaceId: agent.workspaceId ?? null,
      usedTokens: agent.lastUsage?.contextWindowUsedTokens ?? null,
      maxTokens: agent.lastUsage?.contextWindowMaxTokens ?? null,
      costUsd: agent.lastUsage?.totalCostUsd ?? null,
    });
  }
  return rows;
}

/**
 * Delivers text to an agent as a new message.
 *
 * A leading `/compact` is not a string the model reads: Paseo parses slash
 * commands out of a prompt and honours the root-only set — `clear`, `compact`,
 * `context`, `usage` and friends — so this is the supported route to compaction,
 * and the reason an agent can be made to compact itself at all.
 */
export async function sendToAgent(
  client: DaemonClient,
  agentId: string,
  text: string,
): Promise<void> {
  await client.sendMessage(agentId, text);
}
