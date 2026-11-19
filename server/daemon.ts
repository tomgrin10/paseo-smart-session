/**
 * Smart Session's connection to Paseo's own daemon.
 *
 * The plugin SDK exposes neither provider usage nor per-agent context usage, so
 * this borrows the host's daemon client the way paseo-defer does.
 *
 * Invariant: one daemon connection per process, held and reused
 * (one-held-daemon-connection). It reopens only after a real drop or a failed
 * call on a dead socket, with backoff after a failed open, and closes in
 * the plugin's teardown (`closeDaemon`, run last by `index.server.ts`), so the subprocess still exits and
 * reload never wedges (`check-teardown.mjs`). 2026-11-18 live: `withDaemon`
 * opened a WebSocket per call (governor and guard ticks, the recorder's minute,
 * usage reads), about 13-17 hellos a minute in the daemon log.
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
  /** The helper's turn, read back from its tool calls (`turnItems` in `server/publish-as.ts`). */
  fetchAgentTimeline(agentId: string, options?: { direction?: "tail" | "before" | "after"; limit?: number; projection?: "projected" | "canonical" }): Promise<unknown>;
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

/** The connection options, without the password. */
async function clientOptions() {
  const password = await resolveDaemonPassword();
  return {
    url: await resolveUrl(),
    clientId: "paseo-smart-session",
    clientType: "cli",
    reconnect: { enabled: false },
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    suppressSendErrors: true,
    ...(password === undefined ? {} : { password }),
  };
}

/** Builds and connects one client. The only place a DaemonClient is constructed. */
export async function openDaemon(): Promise<DaemonClient> {
  const { DaemonClient } = loadDaemonClientModule();
  const client = new DaemonClient(await clientOptions());
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

/** A long-lived connection is replaced after this long, so one never ages past daemon-side limits. */
export const SHARED_CLIENT_MAX_MS = 30 * 60_000;
/** Backoff after a failed open: 1 s, doubling, capped at 30 s. Calls in the window fail fast. */
export const OPEN_BACKOFF_MS = 1_000;
export const OPEN_BACKOFF_MAX_MS = 30_000;

export interface SharedDaemon {
  /** Runs `work` on the held connection, opening it if there is none. */
  run<T>(work: (client: DaemonClient) => Promise<T>): Promise<T>;
  /** Closes the connection; nothing opens afterwards. */
  close(): Promise<void>;
}

type Entry = { client: Promise<DaemonClient>; opened: number; users: number; retired: boolean; unsubscribe?: () => void };
type StatusSource = { getConnectionState?(): { status: string }; subscribeConnectionStatus?(listener: (state: { status: string }) => void): () => void };

const live = (client: DaemonClient) => {
  const status = (client as unknown as StatusSource).getConnectionState?.().status;
  return status === undefined || status === "connected";
};

/**
 * One held connection, shared by every caller (one-held-daemon-connection). Concurrent
 * callers join the open in flight; a dropped socket is retired at once and the next
 * call opens a fresh one; a retired socket closes after its last call finishes.
 */
export function sharedDaemon(
  open: () => Promise<DaemonClient> = openDaemon,
  options: { maxMs?: number; now?: () => number; backoffMs?: number; backoffMaxMs?: number; name?: string } = {},
): SharedDaemon {
  const maxMs = options.maxMs ?? SHARED_CLIENT_MAX_MS;
  const now = options.now ?? Date.now;
  const backoffMs = options.backoffMs ?? OPEN_BACKOFF_MS;
  const backoffMaxMs = options.backoffMaxMs ?? OPEN_BACKOFF_MAX_MS;
  const name = options.name ?? "Smart Session";
  let current: Entry | null = null;
  let stopped = false;
  let failures = 0;
  let retryAt = 0;
  let lastError: unknown = null;
  const all = new Set<Entry>();

  const shut = async (entry: Entry) => {
    all.delete(entry);
    if (current === entry) current = null;
    entry.unsubscribe?.();
    const client = await entry.client.catch(() => null);
    if (client) await client.close().catch(() => undefined);
  };
  const retire = (entry: Entry) => {
    entry.retired = true;
    if (current === entry) current = null;
    if (entry.users === 0) void shut(entry);
  };

  const run = async <T>(work: (client: DaemonClient) => Promise<T>): Promise<T> => {
    if (stopped) throw new Error(`${name} is stopping.`);
    if (current && now() - current.opened >= maxMs) retire(current);
    if (!current) {
      if (failures > 0 && now() < retryAt) throw lastError instanceof Error ? lastError : new Error(String(lastError));
      const entry: Entry = { client: Promise.resolve(null as unknown as DaemonClient), opened: now(), users: 0, retired: false };
      entry.client = open().then(
        (client) => {
          failures = 0;
          if (stopped) {
            void client.close().catch(() => undefined);
            throw new Error(`${name} is stopping.`);
          }
          // A real drop retires it at once (reconnect is off on the client itself).
          entry.unsubscribe = (client as unknown as StatusSource).subscribeConnectionStatus?.((state) => {
            if (state.status === "disconnected" || state.status === "disposed") retire(entry);
          });
          return client;
        },
        (error: unknown) => {
          failures++;
          lastError = error;
          retryAt = now() + Math.min(backoffMs * 2 ** (failures - 1), backoffMaxMs);
          all.delete(entry);
          if (current === entry) current = null;
          throw error;
        },
      );
      current = entry;
      all.add(entry);
    }
    const entry = current;
    entry.users++;
    try {
      const client = await entry.client;
      try {
        return await work(client);
      } catch (error) {
        // A dead socket is not reused: the next call opens a fresh one.
        if (!live(client)) retire(entry);
        throw error;
      }
    } finally {
      entry.users--;
      if (entry.retired && entry.users === 0 && all.has(entry)) void shut(entry);
    }
  };

  const close = async () => {
    stopped = true;
    await Promise.allSettled([...all].map((entry) => shut(entry)));
  };
  return { run, close };
}

/** The process's one held connection. */
const shared = sharedDaemon();

/**
 * Closes the held connection. `index.server.ts` runs it after every other teardown, so a
 * feature stopping mid-call finishes on a live socket, and then the subprocess can exit.
 */
export function closeDaemon(): Promise<void> {
  return shared.close();
}

/** Runs `work` on the process's one held daemon connection. */
export function withDaemon<T>(work: (client: DaemonClient) => Promise<T>): Promise<T> {
  return shared.run(work);
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
