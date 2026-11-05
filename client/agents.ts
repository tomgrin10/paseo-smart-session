/**
 * The one agent directory this client bundle keeps, shared by every composer pill.
 *
 * Both the Smart Compact pill and the Session Guard pill need to know which agents
 * exist and which workspace each sits in, since a pill registration bakes in its
 * workspace. Following the host's agents twice would open two observations of the
 * same directory; this opens one and lets each pill read it.
 *
 * It must be an *owned* observation, `agents.list({ subscribe: {}, signal })`: bare
 * `agents.subscribe()` only listens to observations this API instance already holds,
 * so on its own it never discovers a new agent (RESEARCH.md §5.1). A 0.8 runtime
 * returns no observation and emits its updates through that local listener instead,
 * so the listener stays attached until an owned observation replaces it.
 */

import type { PluginClientContext } from "@getpaseo/plugin/client";

export interface DirectoryAgent {
  readonly workspaceId: string;
  /** Closed or archived: still listed, but no longer a session anyone is working in. */
  readonly closed: boolean;
  /** Context occupancy as of the agent's last turn, from its snapshot; null until it has run one. */
  readonly usedTokens: number | null;
  readonly maxTokens: number | null;
}

export interface AgentDirectory {
  current(): ReadonlyMap<string, DirectoryAgent>;
  /** Called after every change; read `current()` for the new state. */
  subscribe(listener: () => void): () => void;
  /** Bumped on every change, for `useSyncExternalStore`. */
  version(): number;
  /** Releases the observation. Safe to call more than once. */
  dispose(): Promise<void>;
}

/** The lean shapes this needs from the agent directory, which carries far more. */
interface ListedAgent {
  readonly id?: string;
  readonly workspaceId?: string | null;
  readonly status?: string;
  readonly archivedAt?: string | null;
  readonly lastUsage?: { readonly contextWindowUsedTokens?: number; readonly contextWindowMaxTokens?: number } | null;
}

interface AgentUpdate {
  readonly kind: "remove" | "upsert";
  readonly agentId?: string;
  readonly agent?: ListedAgent;
}

interface AgentListing {
  readonly entries?: readonly { readonly agent?: ListedAgent }[];
  readonly subscription?: {
    subscribe(observer: {
      snapshot(listing: AgentListing): void;
      update(message: { readonly type?: string; readonly payload?: AgentUpdate }): void;
    }): () => void;
    release(): Promise<void>;
  };
}

function entryOf(agent: ListedAgent | undefined): [string, DirectoryAgent] | null {
  if (typeof agent?.id !== "string" || typeof agent.workspaceId !== "string" || agent.workspaceId === "") return null;
  const used = agent.lastUsage?.contextWindowUsedTokens;
  const max = agent.lastUsage?.contextWindowMaxTokens;
  return [agent.id, {
    workspaceId: agent.workspaceId,
    closed: agent.status === "closed" || !!agent.archivedAt,
    usedTokens: typeof used === "number" && Number.isFinite(used) ? used : null,
    maxTokens: typeof max === "number" && Number.isFinite(max) && max > 0 ? max : null,
  }];
}

function same(a: DirectoryAgent | undefined, b: DirectoryAgent): boolean {
  return a !== undefined && a.workspaceId === b.workspaceId && a.closed === b.closed && a.usedTokens === b.usedTokens && a.maxTokens === b.maxTokens;
}

export function observeAgents(client: PluginClientContext): AgentDirectory {
  const agents = new Map<string, DirectoryAgent>();
  const listeners = new Set<() => void>();
  const lifetime = new AbortController();
  let stopped = false;
  let unsubscribeOwnedObservation: (() => void) | null = null;
  let releaseObservation: (() => Promise<void>) | null = null;

  let version = 0;
  const notify = () => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };

  function upsert(agent: ListedAgent | undefined): boolean {
    let entry = entryOf(agent);
    if (entry === null) return false;
    // An update that carries no usage is not a reading of zero: keep the last one.
    const known = agents.get(entry[0]);
    if (entry[1].usedTokens === null && agent?.lastUsage == null && known !== undefined) {
      entry = [entry[0], { ...entry[1], usedTokens: known.usedTokens, maxTokens: known.maxTokens }];
    }
    if (same(known, entry[1])) return false;
    agents.set(entry[0], entry[1]);
    return true;
  }

  function apply(update: AgentUpdate): void {
    if (stopped) return;
    if (update.kind === "remove") {
      if (typeof update.agentId === "string" && agents.delete(update.agentId)) notify();
      return;
    }
    if (upsert(update.agent)) notify();
  }

  /** The legacy listener is live while the snapshot is in flight, so bootstrap is additive. */
  function add(entries: AgentListing["entries"]): void {
    let changed = false;
    for (const entry of entries ?? []) changed = upsert(entry.agent) || changed;
    if (changed) notify();
  }

  /** A restored observation replaces its directory snapshot, including removals. */
  function replace(entries: AgentListing["entries"]): void {
    const present = new Set<string>();
    let changed = false;
    for (const entry of entries ?? []) {
      const parsed = entryOf(entry.agent);
      if (parsed === null) continue;
      present.add(parsed[0]);
      changed = upsert(entry.agent) || changed;
    }
    for (const agentId of [...agents.keys()]) {
      if (!present.has(agentId)) {
        agents.delete(agentId);
        changed = true;
      }
    }
    if (changed) notify();
  }

  let unsubscribeLegacy: (() => void) | null = client.paseo.agents.subscribe((update) => apply(update as AgentUpdate));

  void (async () => {
    try {
      const listAgents = client.paseo.agents.list as unknown as (options: {
        subscribe: Record<string, never>;
        signal: AbortSignal;
      }) => Promise<AgentListing>;
      const listing = await listAgents({ subscribe: {}, signal: lifetime.signal });
      const release = listing.subscription ? () => listing.subscription!.release() : null;
      if (stopped) {
        await release?.();
        return;
      }
      releaseObservation = release;
      add(listing.entries);
      if (listing.subscription) {
        unsubscribeOwnedObservation = listing.subscription.subscribe({
          snapshot(snapshot) {
            if (!stopped) replace(snapshot.entries);
          },
          update(message) {
            if (message.type === "agent_update" && message.payload) apply(message.payload);
          },
        });
        unsubscribeLegacy?.();
        unsubscribeLegacy = null;
      }
    } catch {
      const release = releaseObservation;
      releaseObservation = null;
      await release?.().catch(() => undefined);
      // Not fatal to the rest of the client contribution; a reload can retry.
    }
  })();

  return {
    current: () => agents,
    version: () => version,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async dispose() {
      stopped = true;
      lifetime.abort();
      unsubscribeLegacy?.();
      unsubscribeLegacy = null;
      unsubscribeOwnedObservation?.();
      unsubscribeOwnedObservation = null;
      listeners.clear();
      agents.clear();
      const release = releaseObservation;
      releaseObservation = null;
      await release?.().catch(() => undefined);
    },
  };
}
