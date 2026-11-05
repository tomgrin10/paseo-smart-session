/**
 * Session Guard's wiring: settings, the governor loop, RPCs and lifecycle hooks.
 *
 * The engine (`./engine.ts`) decides what to pause and when to continue; this file
 * decides whether this process may run it at all. Only one process per host may:
 *
 * - With the feature off, nothing here holds the lock or touches a session.
 * - While the standalone `paseo-session-guard` plugin is configured and enabled, this
 *   one never governs, even if it could take the lock: that plugin's teardown resumes
 *   every suspended session in the shared state whether or not it owns it
 *   (`./standalone.ts`). If it becomes enabled while this one governs, this one
 *   releases its suspended workers, gives the lock back and waits.
 * - Otherwise it takes `governor.lock` in the shared state directory (`./store.ts`).
 *   If another live process holds it, this one defers and retries on every poll.
 * - Turned off again, it stops pausing at once, releases suspended workers on its next
 *   pass, and gives the lock back once no pause is left waiting on it.
 */

import type { PluginHandlerContext, PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";

import {
  agentStatusRpc,
  cancelResumeRpc,
  demoPauseRpc,
  dismissPauseRpc,
  guardPreferences,
  resumeNowRpc,
  runtimeRpc,
  setProtectionRpc,
  statusRpc,
  type Governor,
} from "../../shared/guard/contracts.ts";
import { isPending, PolicySchema, sessionWindow, usedPct, type Policy, type State, type Usage } from "../../shared/guard/policy.ts";
import { agentGuardSummary, callerProtection } from "../../shared/guard/presentation.ts";
import { withDaemon } from "../daemon.ts";
import { freshestUsage } from "../store.ts";
import type { Connect, GuardClient } from "./client.ts";
import { Engine, type ReadAccounts } from "./engine.ts";
import { WorkspaceLabels } from "./labels.ts";
import { LinuxProcessControl, type ProcessControl } from "./processes.ts";
import { standaloneEnabled } from "./standalone.ts";
import { guardDataDir, LockHeldError, Store } from "./store.ts";
import { timelinePublisher } from "./timeline.ts";
import { withRecordedUsage } from "./usage.ts";
import { readZeroSub } from "./zerosub.ts";
import { accountView } from "../../shared/guard/zerosub.ts";
import { limitNotice, turnRows, type TurnRow } from "../../shared/guard/limit-notice.ts";

/** How many timeline rows to read back for a finished turn's limit notice (as ZeroSub). */
const NOTICE_ROWS = 40;

/** Whether a finished turn ended on the CLI's limit notice, read from the agent's timeline tail. */
async function readLimitNotice(context: PluginHookContext, agentId: string, provider: string, turnId: string): Promise<boolean> {
  if (provider !== "claude" && provider !== "codex") return false;
  const page = await context.paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: NOTICE_ROWS });
  const entries = page.entries as unknown as readonly { item: TurnRow; turnId?: string }[];
  return limitNotice(provider, turnRows(entries, turnId)) !== null;
}

/** The install id this plugin's own RPCs are reached through. */
const PLUGIN_ID = "smart-session";

/** How often to retry the lock while another process holds it. */
const DEFERRED_RETRY_SECONDS = 15;

const STANDALONE_MESSAGE =
  "The standalone Session Guard plugin is enabled on this host, so Smart Session leaves pausing at the limit to it. " +
  "Disable or uninstall Session Guard to hand over; its per-session choices and waiting pauses carry over.";
const HANDED_BACK_MESSAGE =
  "The standalone Session Guard plugin was enabled while Smart Session was pausing at the limit here, so Smart Session released its paused sessions and stopped. " +
  "Disable or uninstall Session Guard to hand back to Smart Session, or reload Session Guard to let it take over.";
const LOCK_HELD_MESSAGE =
  "Another process already pauses sessions at the limit on this host, most likely a second Smart Session install. Nothing is paused from here until it stops.";
const OFF_MESSAGE = "Pause at the limit is off on this host. Turn it on in Smart Session settings.";
const UNCHECKED_MESSAGE = "Smart Session could not check which plugins are installed, so it is not pausing anything yet. It will retry.";

/** The daemon connection and process control, replaceable only by tests. */
export interface GuardDependencies {
  connect?: Connect;
  processes?: ProcessControl;
  readAccounts?: ReadAccounts;
}

export function contributeGuard(server: PluginServerContext, options: GuardDependencies = {}): () => Promise<void> {
  const settings = server.registerSettings(guardPreferences);
  let settingsError: string | null = null;
  const readPolicy = async (): Promise<Policy> => {
    const result = await settings.read();
    if (result.status !== "ready") throw new Error("Session Guard settings are invalid.");
    return PolicySchema.parse(result.values);
  };

  // The guard's own connections, so teardown can close one that is mid-call without
  // touching a delivery the compaction governor has in flight on another socket.
  const open = new Set<{ close(): Promise<void> }>();
  let disposed = false;
  const daemon: Connect = options.connect ?? ((work) => withDaemon((client) => work(client as unknown as GuardClient)));
  const connect: Connect = (work) => {
    if (disposed) return Promise.reject(new Error("Session Guard is stopping."));
    return daemon(async (client) => {
      const closable = client as unknown as { close(): Promise<void> };
      open.add(closable);
      try {
        // The same Paseo client the recorder uses, read through the guard's typed view.
        return await work(client);
      } finally {
        open.delete(closable);
      }
    });
  };

  // Timeline appends need the host-owned API, which only an RPC handler receives.
  let runtime: PluginHandlerContext["paseo"] | null = null;
  server.handle(runtimeRpc, (_, context) => {
    runtime = context.paseo;
    return { ok: true };
  });
  const publish = timelinePublisher(async () => {
    if (!runtime) {
      await connect(async (client) => {
        if (!client.invokePluginRpc) throw new Error("Plugin runtime API is unavailable.");
        await client.invokePluginRpc(PLUGIN_ID, runtimeRpc.name, {});
      });
    }
    if (!runtime) throw new Error("Plugin runtime API is unavailable.");
    return runtime;
  });

  const store = new Store(guardDataDir());
  const readUsage = async (client: GuardClient): Promise<Usage> =>
    withRecordedUsage(await client.listProviderUsage(), await freshestUsage().catch(() => null));
  // With ZeroSub enabled, agents are measured on their own accounts (`shared/guard/zerosub.ts`).
  const readAccounts = options.readAccounts ?? (async (usage: Usage, policy: Policy) => {
    const snapshot = await readZeroSub();
    return snapshot ? accountView(snapshot, usage, policy, Date.now()) : null;
  });
  const engine = new Engine(store, readPolicy, connect, Date.now, options.processes ?? new LinuxProcessControl(), publish, readUsage, readAccounts);
  const labels = new WorkspaceLabels(store, (work) => engine.exclusive(work), connect, readPolicy);

  let governor: Governor = "off";
  let lockError: string | null = null;
  let release: (() => Promise<void>) | null = null;

  const claim = async () => {
    try {
      release = await store.lock();
    } catch (error) {
      governor = error instanceof LockHeldError ? "deferred" : "error";
      lockError = governor === "deferred" ? LOCK_HELD_MESSAGE : "Pause at the limit could not take its lock. Check its saved state and try again.";
      return;
    }
    try {
      await engine.recover();
      governor = "active";
      lockError = null;
    } catch {
      governor = "error";
      lockError = "Pause at the limit could not read its saved state (session-guard/state.json). Restore it before continuing.";
      const unlock = release;
      release = null;
      await unlock?.();
    }
  };

  /** Gives the lock back, but only with nothing left that needs an owner. */
  const standDown = async () => {
    const idle = await engine.exclusive(async () => !(await store.read()).pauses.some(isPending));
    if (!idle) return;
    await engine.deliverTimeline();
    await labels.refresh();
    await engine.exclusive(async () => {
      if ((await store.read()).pauses.some(isPending)) return;
      governor = "off";
      const unlock = release;
      release = null;
      await unlock?.();
    });
  };

  /** True or false from the daemon's plugin list; null when it could not be read. */
  let standalone: boolean | null = null;
  const checkStandalone = async () => {
    try {
      standalone = await connect(async (client) => (client.listPlugins ? standaloneEnabled(await client.listPlugins()) : false));
    } catch {
      standalone = null;
    }
  };

  /** Steps aside for an enabled standalone plugin: nothing frozen is left without an owner. */
  const handBack = async () => {
    governor = "deferred"; // Refuse new actions before releasing anything.
    lockError = HANDED_BACK_MESSAGE;
    try {
      await engine.releaseWorkers();
    } catch {
      lockError = `${HANDED_BACK_MESSAGE} Some paused sessions could not be released; check them.`;
    }
    await engine.exclusive(async () => {
      const unlock = release;
      release = null;
      await unlock?.();
    });
  };

  const pass = async (): Promise<Policy | null> => {
    let policy: Policy | null = null;
    try {
      policy = await readPolicy();
      settingsError = null;
    } catch {
      settingsError = "The Pause at the limit settings are invalid. Reset them in Smart Session settings.";
    }
    if (!policy?.enabled && governor !== "active") {
      governor = "off";
      lockError = null;
      return policy;
    }
    await checkStandalone();
    if (governor === "active") {
      if (standalone === true) {
        await handBack();
        return policy;
      }
    } else if (standalone === true) {
      governor = "deferred";
      // Keep the fuller explanation if this process just handed the host back.
      if (!lockError?.startsWith(HANDED_BACK_MESSAGE)) lockError = STANDALONE_MESSAGE;
      return policy;
    } else if (standalone === null) {
      governor = "error";
      lockError = UNCHECKED_MESSAGE;
      return policy;
    } else {
      await claim();
    }
    if (governor !== "active") return policy;
    await engine.tick();
    void engine.deliverTimeline();
    void labels.refresh();
    if (policy !== null && !policy.enabled) await standDown();
    return policy;
  };

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: Promise<void> | null = null;
  let again = false;
  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (current) {
      again = true; // A settings change mid-pass must not wait out a whole interval.
      return current;
    }
    if (timer !== null) clearTimeout(timer);
    timer = null;
    current = (async () => {
      let policy: Policy | null = null;
      try {
        policy = await pass();
      } catch {
        // Each step records its own error for the status RPC; the loop must survive.
      }
      current = null;
      if (stopped) return;
      if (again) {
        again = false;
        void refresh();
        return;
      }
      // Off needs no timer: turning it on arrives through the settings subscription.
      if (governor === "active") timer = setTimeout(() => void refresh(), (policy?.pollSeconds ?? 15) * 1000);
      else if (governor !== "off") timer = setTimeout(() => void refresh(), DEFERRED_RETRY_SECONDS * 1000);
    })();
    return current;
  };

  const requireOwner = async () => {
    if (current) await current;
    if (stopped) throw new Error("Session Guard is stopping.");
    if (governor !== "active") throw new Error(lockError ?? OFF_MESSAGE);
  };
  /** Readable whether or not this process governs: the file is replaced atomically. */
  const readState = async (): Promise<State> => (governor === "active" ? engine.exclusive(() => store.read()) : store.read());
  const readPolicyOrDefaults = () => readPolicy().catch(() => PolicySchema.parse({}));
  const emptyState = (): State => ({ version: 1, overrides: {}, pauses: [] });
  const providerRows = (policy: Policy, agentId?: string) =>
    (governor === "active" ? (engine.usage?.providers ?? []) : []).map((listed) => {
      // An agent sees its own account's numbers, which under ZeroSub may not be the CLI login's.
      const provider = (agentId !== undefined && engine.accounts?.usageFor(agentId, listed.providerId).providers.find((p) => p.providerId === listed.providerId)) || listed;
      const window = sessionWindow(provider, policy);
      return { providerId: provider.providerId, usedPct: window ? usedPct(window) : null, resetsAt: window?.resetsAt ?? null };
    });
  const afterAction = () => {
    void engine.deliverTimeline();
    void labels.refresh();
  };

  server.handle(statusRpc, async (_, context) => {
    runtime = context.paseo;
    const policy = await readPolicyOrDefaults();
    let state = emptyState();
    let stateError: string | null = null;
    try {
      state = await readState();
    } catch (error) {
      stateError = error instanceof Error ? error.message : String(error);
    }
    const active = governor === "active";
    return {
      governor,
      standalone: governor === "off" ? null : standalone,
      checkedAt: active ? engine.checkedAt : null,
      error: lockError ?? settingsError ?? stateError ?? (active ? (engine.error ?? engine.timelineError ?? labels.error) : null),
      pauses: state.pauses,
      overrides: state.overrides,
      policy,
      providers: providerRows(policy),
    };
  });

  server.handle(agentStatusRpc, async ({ agentId }) => {
    const policy = await readPolicyOrDefaults();
    const state = await readState().catch(emptyState);
    const protection = callerProtection(governor === "active" && policy.enabled, policy.protectByDefault, state.overrides[agentId]);
    const agentProvider = engine.providers.get(agentId);
    const failsOver = governor === "active" && agentProvider !== undefined && (engine.accounts?.failsOver(agentId, agentProvider) ?? false);
    const pauses = state.pauses
      .filter((pause) => pause.agentId === agentId)
      .map((pause) => ({ id: pause.id, phase: pause.phase, provider: pause.provider, resetsAt: pause.anchorResetsAt }));
    return {
      governor,
      ...protection,
      thresholdPct: policy.thresholdPct,
      autoResume: policy.autoResume,
      pauses,
      providers: providerRows(policy, agentId),
      summary: agentGuardSummary({ governor, protected: protection.protected, thresholdPct: policy.thresholdPct, autoResume: policy.autoResume, pauses, failsOver }),
      ...(failsOver ? { failsOver } : {}),
    };
  });

  server.handle(setProtectionRpc, async ({ agentId, enabled }) => {
    await requireOwner();
    await engine.setProtection(agentId, enabled);
    afterAction();
    void refresh();
    return { ok: true };
  });
  server.handle(cancelResumeRpc, async ({ agentId }) => {
    await requireOwner();
    await engine.cancelResume(agentId);
    afterAction();
    return { ok: true };
  });
  server.handle(resumeNowRpc, async ({ agentId, pauseId }) => {
    await requireOwner();
    await engine.resumeNow(agentId, pauseId);
    afterAction();
    return { ok: true };
  });
  server.handle(dismissPauseRpc, async ({ agentId, pauseId }) => {
    await requireOwner();
    await engine.dismissPause(agentId, pauseId);
    afterAction();
    return { ok: true };
  });
  server.handle(demoPauseRpc, async ({ agentId }) => {
    await requireOwner();
    await engine.pauseDemo(agentId);
    afterAction();
    return { ok: true };
  });

  const removeSettings = settings.subscribe(() => {
    void refresh();
  });
  const removeTurnStarted = server.on("agent.turn_started", () => {
    if (governor !== "off") void refresh();
  });
  const removeTurnEnded = server.on("agent.turn_ended", (event, context) => {
    if (governor !== "active") return;
    // Never await a governor tick inside a lifecycle hook: cancelAgent itself causes
    // turn_ended, and awaiting both would deadlock.
    if (!stopped) void engine.turnEnded(event.agent.id, event.turnId, event.outcome.kind).catch(() => undefined);
    if (event.outcome.kind === "failed") engine.quotaFailure(event.agent.id, event.outcome.error.message, event.turnId);
    // Claude completes a turn at the limit with a notice instead of failing it. Under
    // ZeroSub, when no account has room, that notice is all there is: read it so the
    // agent is paused and continued after a reset. Without ZeroSub nothing changes.
    if (event.outcome.kind === "completed" && event.turnId && engine.accounts && !stopped) {
      void readLimitNotice(context, event.agent.id, event.agent.provider, event.turnId).then((found) => {
        if (found && !stopped) {
          engine.limitReached(event.agent.id, event.turnId);
          void refresh();
        }
      }).catch(() => undefined);
    }
    void refresh();
  });

  void refresh();

  return async () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    removeSettings();
    removeTurnStarted();
    removeTurnEnded();
    disposed = true;
    await Promise.allSettled([...open].map((client) => client.close()));
    await current?.catch(() => undefined);
    try {
      // Only the owner may touch suspended workers: a deferring process must leave the
      // other governor's pauses exactly as they are.
      if (governor === "active") {
        try {
          await engine.stop();
        } finally {
          await labels.stop();
        }
      }
    } finally {
      // Always give the lock back, even when a release failed: this process is exiting,
      // and a held lock would only keep the next governor waiting.
      const unlock = release;
      release = null;
      await unlock?.();
    }
  };
}
