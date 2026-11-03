/**
 * Session Guard's wiring: settings, the governor loop, RPCs and lifecycle hooks.
 *
 * The engine (`./engine.ts`) decides what to pause and when to continue; this file
 * decides whether this process may run it at all. Only one process per host may, and
 * that is settled by `governor.lock` in the shared state directory (`./store.ts`):
 *
 * - With the feature off, nothing here holds the lock or touches a session.
 * - Turned on, it takes the lock. If another process already holds it — in practice
 *   the standalone `paseo-session-guard` plugin — this one defers, retries on every
 *   poll, and takes over the moment that plugin is removed.
 * - Turned off again, it stops pausing at once, releases suspended workers on its next
 *   pass, and gives the lock back once no pause is left waiting on it.
 */

import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";

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
import { Engine } from "./engine.ts";
import { WorkspaceLabels } from "./labels.ts";
import { LinuxProcessControl } from "./processes.ts";
import { guardDataDir, LockHeldError, Store } from "./store.ts";
import { timelinePublisher } from "./timeline.ts";
import { withRecordedUsage } from "./usage.ts";

/** The install id this plugin's own RPCs are reached through. */
const PLUGIN_ID = "smart-session";

/** How often to retry the lock while another process holds it. */
const DEFERRED_RETRY_SECONDS = 15;

const DEFERRED_MESSAGE =
  "Another plugin is already running Session Guard on this host — most likely the standalone Session Guard plugin. " +
  "Nothing is paused from here until it stops. Uninstall it to hand over; its per-session choices and waiting pauses carry over.";
const OFF_MESSAGE = "Session Guard is off on this host. Turn it on in Smart Session's Session Guard settings.";

export function contributeGuard(server: PluginServerContext): () => Promise<void> {
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
  const connect: Connect = (work) => {
    if (disposed) return Promise.reject(new Error("Session Guard is stopping."));
    return withDaemon(async (client) => {
      open.add(client);
      try {
        // The same Paseo client the recorder uses, read through the guard's typed view.
        return await work(client as unknown as GuardClient);
      } finally {
        open.delete(client);
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
  const engine = new Engine(store, readPolicy, connect, Date.now, new LinuxProcessControl(), publish, readUsage);
  const labels = new WorkspaceLabels(store, (work) => engine.exclusive(work), connect, readPolicy);

  let governor: Governor = "off";
  let lockError: string | null = null;
  let release: (() => Promise<void>) | null = null;

  const claim = async () => {
    try {
      release = await store.lock();
    } catch (error) {
      governor = error instanceof LockHeldError ? "deferred" : "error";
      lockError = governor === "deferred" ? DEFERRED_MESSAGE : "Session Guard could not take its lock. Check its saved state and try again.";
      return;
    }
    try {
      await engine.recover();
      governor = "active";
      lockError = null;
    } catch {
      governor = "error";
      lockError = "Session Guard could not read its saved state. Restore state.json before continuing.";
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

  const pass = async (): Promise<Policy | null> => {
    let policy: Policy | null = null;
    try {
      policy = await readPolicy();
      settingsError = null;
    } catch {
      settingsError = "Session Guard settings are invalid. Reset them in Session Guard settings.";
    }
    if (policy?.enabled && governor !== "active") await claim();
    if (!policy?.enabled && governor !== "active") {
      governor = "off";
      lockError = null;
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
  const providerRows = (policy: Policy) =>
    (governor === "active" ? (engine.usage?.providers ?? []) : []).map((provider) => {
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
    const pauses = state.pauses
      .filter((pause) => pause.agentId === agentId)
      .map((pause) => ({ id: pause.id, phase: pause.phase, provider: pause.provider, resetsAt: pause.anchorResetsAt }));
    return {
      governor,
      ...protection,
      thresholdPct: policy.thresholdPct,
      autoResume: policy.autoResume,
      pauses,
      providers: providerRows(policy),
      summary: agentGuardSummary({ governor, protected: protection.protected, thresholdPct: policy.thresholdPct, autoResume: policy.autoResume, pauses }),
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
  const removeTurnEnded = server.on("agent.turn_ended", (event) => {
    if (governor !== "active") return;
    // Never await a governor tick inside a lifecycle hook: cancelAgent itself causes
    // turn_ended, and awaiting both would deadlock.
    if (!stopped) void engine.turnEnded(event.agent.id, event.turnId, event.outcome.kind).catch(() => undefined);
    if (event.outcome.kind === "failed") engine.quotaFailure(event.agent.id, event.outcome.error.message, event.turnId);
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
    // Only the owner may touch suspended workers: a deferring process must leave the
    // other governor's pauses exactly as they are.
    if (governor === "active") {
      await engine.stop();
      await labels.stop();
    }
    const unlock = release;
    release = null;
    await unlock?.();
  };
}
