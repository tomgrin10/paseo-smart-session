import { randomUUID } from "node:crypto";
import type { Connect, GuardClient } from "./client.ts";
import type { Store } from "./store.ts";
import type { ProcessControl } from "./processes.ts";
import type { PublishTimeline } from "./timeline.ts";

/**
 * How one tick reads provider usage. Defaults to Paseo's own report; the plugin
 * passes one that also consults Smart Session's recorder (see `./usage.ts`).
 */
export type ReadUsage = (client: GuardClient) => Promise<Usage>;
/**
 * Which account each agent runs on, when an account switcher (ZeroSub) is enabled;
 * null otherwise. See `shared/guard/zerosub.ts`.
 */
export type ReadAccounts = (usage: Usage, policy: Policy) => Promise<AccountView | null>;
import type { AccountView } from "../../shared/guard/zerosub.ts";
import {
  isPending, protects, resetReady, sessionWindow, timestamp, usedPct,
  type Agent, type Pause, type Policy, type State, type Usage,
} from "../../shared/guard/policy.ts";
import { continuesAtReset, freezesIdle, holdKind, messageArrived } from "../../shared/guard/hold.ts";

/** Shown while a session is held in the foreground because its provider process couldn't be confirmed as its own. */
const FALLBACK_ERROR = process.platform === "linux"
  ? "Native worker protection could not confirm ownership of a provider process, so that session is held in the foreground (its native subagents are not frozen)."
  : "Native worker protection requires Linux, so sessions are held in the foreground. Turn it off to stop this notice.";

export class Engine {
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private nextResumeAt = 0;
  private quotaFailures = new Map<string, { at: string; turnId: string | null }>();
  /** Pauses held in the foreground because native ownership couldn't be confirmed; their error stays up while they wait. */
  private fallbacks = new Set<string>();
  checkedAt: string | null = null;
  error: string | null = null;
  timelineError: string | null = null;
  usage: Usage | null = null;
  /** The account view from the last pass, for the agent-facing status. */
  accounts: AccountView | null = null;
  /** Each agent's provider from the last pass. */
  providers = new Map<string, string>();
  private store: Store;
  private policy: () => Promise<Policy>;
  private connect: Connect;
  private now: () => number;
  private processes?: ProcessControl;
  private publish?: PublishTimeline;
  private publishing: Promise<void> | null = null;
  private readUsage: ReadUsage;
  private readAccounts: ReadAccounts;
  constructor(store: Store, policy: () => Promise<Policy>, connect: Connect, now: () => number = Date.now, processes?: ProcessControl, publish?: PublishTimeline,
    readUsage: ReadUsage = client => client.listProviderUsage(), readAccounts: ReadAccounts = async () => null) {
    this.store = store; this.policy = policy; this.connect = connect; this.now = now;
    this.processes = processes;
    this.publish = publish;
    this.readUsage = readUsage;
    this.readAccounts = readAccounts;
  }

  private async save(state: State) {
    // The quota action is durable first. A timeline failure must never undo it
    // or stop other sessions from being protected.
    await this.store.write(state);
    if (!this.publish) return;
    try {
      const policy = await this.policy();
      for (const pause of state.pauses) {
        const event = pause.phase === "waiting" ? pause.restartRecovery ? "recovery" : "paused" : pause.phase === "resumed" ? "resumed"
          : pause.phase === "cancelled" ? "released" : pause.phase === "attention" ? "attention" : null;
        if (!event || (["released", "resumed"].includes(event) && !pause.notifications?.length)) continue;
        // An idle hold says nothing in the chat until a person's message waits in it.
        if (pause.idle && (event === "paused" || event === "recovery")) continue;
        pause.notifications ??= [];
        if (pause.notifications.some(n => n.data.event === event)) continue;
        const native = event === "resumed" ? !!pause.resumedInPlace : event === "recovery" ? false
          : !!pause.suspension || !!pause.resumedInPlace || pause.notifications.some(n => n.data.native);
        const window = this.usage?.providers.find(p => p.providerId === pause.provider)?.windows.find(w => w.id === pause.windowId);
        pause.notifications.push({ id: `session-guard:${pause.id}:${event}`, delivery: "pending", data: {
          pauseId: pause.id, event, at: event === "paused" ? pause.pausedAt : pause.settledAt ?? new Date(this.now()).toISOString(),
          provider: pause.provider, native, autoResume: !pause.demo && policy.autoResume && policy.enabled,
          resetAt: pause.anchorResetsAt, usedPct: window ? usedPct(window) : null, note: pause.note,
          ...(pause.manualResume ? { manualResume: true } : {}), ...(pause.demo ? { demo: true } : {}), ...(pause.dismissed ? { dismissed: true } : {}),
        } });
      }
      await this.store.write(state);
    } catch {
      this.timelineError = "Session Guard could not update the timeline yet. Pauses remain protected; delivery will retry.";
    }
  }

  /** Timeline I/O runs outside quota actions, so a slow append cannot prevent
   * another session from pausing or block the person's release action. */
  deliverTimeline(): Promise<void> {
    if (!this.publish || this.stopped) return Promise.resolve();
    if (this.publishing) return this.publishing;
    this.publishing = (async () => {
      const failed = new Set<string>();
      try {
        for (let batch = 0; batch < 20 && !this.stopped; batch++) {
          const next = await this.exclusive(async () => {
            const state = await this.store.read();
            for (const pause of state.pauses) {
              if (failed.has(pause.id)) continue;
              const notification = pause.notifications?.find(n => n.delivery !== "sent");
              if (!notification) continue;
              const reconcile = notification.delivery === "sending";
              notification.delivery = "sending"; await this.store.write(state);
              return { agentId: pause.agentId, notification: structuredClone(notification), reconcile };
            }
            return null;
          });
          if (!next) { if (!failed.size) this.timelineError = null; return; }
          try { await this.publish!(next.agentId, next.notification, next.reconcile); }
          catch {
            this.timelineError = "Some Session Guard timeline entries are awaiting delivery. Pauses remain protected; delivery will retry.";
            failed.add(next.notification.data.pauseId);
            continue; // Keep this pause's events in order, while delivering other sessions.
          }
          await this.exclusive(async () => {
            const state = await this.store.read();
            const notification = state.pauses.flatMap(p => p.notifications ?? []).find(n => n.id === next.notification.id);
            if (notification) { notification.delivery = "sent"; await this.store.write(state); }
          });
          if (!failed.size) this.timelineError = null;
        }
      } catch { this.timelineError = "Session Guard could not update the timeline yet. Delivery will retry."; }
    })().finally(() => { this.publishing = null; });
    return this.publishing;
  }

  /** Serialize whole actions, so an opt-out cannot race a scheduled send. */
  exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.chain.then(action);
    this.chain = next.catch(() => undefined);
    return next;
  }
  async stop() {
    this.stopped = true; await this.chain;
    // Disabling/unloading a plugin must not strand stopped OS processes.
    try { await this.releaseWorkers(); }
    finally { await this.publishing; }
  }
  /**
   * Releases every suspended worker, keeping confirmed waits on disk.
   *
   * Used on unload and when handing the host to another governor. Each pause is
   * released on its own: one failed SIGCONT must not leave the sessions after it
   * frozen, nor lose what was already released. Failures are rethrown together once
   * the state is saved.
   */
  releaseWorkers(): Promise<void> {
    if (!this.processes) return Promise.resolve();
    return this.exclusive(async () => {
      const state = await this.store.read();
      let failed = 0;
      for (const pause of state.pauses.filter(p => isPending(p) && p.suspension)) {
        try {
          if (["waiting", "resuming"].includes(pause.phase) && !pause.demo && !pause.manualResume) {
            // Unload must release OS workers, but the confirmed schedule remains
            // durable in case the daemon now exits and those workers disappear.
            await this.processes!.resume(pause.suspension!);
            pause.releasedForUnload = true;
          } else await this.cancel(pause, "Suspended workers released because Session Guard stopped.");
        } catch { failed++; }
      }
      await this.save(state);
      if (failed) throw new Error(`${failed} suspended ${failed === 1 ? "session" : "sessions"} could not be released.`);
    });
  }
  quotaFailure(agentId: string, message: string, turnId: string | null = null) {
    // Provider rejection can win the race against the usage polling interval.
    // Only rate/quota failures qualify; ordinary errors must never restart work.
    if (/usage limit|rate.?limit|hit your limit|quota|limit reached|exceeded.*limit|limit.*exceeded|too many requests/i.test(message)) {
      this.quotaFailures.set(agentId, { at: new Date(this.now()).toISOString(), turnId });
    }
  }
  /**
   * The agent's finished turn ended on the CLI's limit notice (`shared/guard/limit-notice.ts`).
   * Claude completes such a turn rather than failing it, so this is how a pause is recorded
   * when the CLI reaches the limit before the guard's reading does. Only reported while
   * ZeroSub is enabled, whose own detection this mirrors.
   */
  limitReached(agentId: string, turnId: string | null) {
    this.quotaFailures.set(agentId, { at: new Date(this.now()).toISOString(), turnId });
  }
  private async leftDaemon(suspension: NonNullable<Pause["suspension"]>) {
    return !!this.processes && ((this.processes.alive && !await this.processes.alive(suspension)) ||
      (this.processes.owned && !await this.processes.owned(suspension))) === true;
  }
  private async recoverActions(state: Awaited<ReturnType<Store["read"]>>) {
      let changed = false;
      for (const pause of state.pauses) {
        if (pause.phase === "resuming" || pause.phase === "pausing") {
          if (pause.suspension && this.processes) {
            const workerEnded = await this.leftDaemon(pause.suspension);
            await this.processes.resume(pause.suspension);
            delete pause.suspension;
            if (pause.phase === "resuming" && workerEnded) {
              // A crash after journaling SIGCONT must not mark a dead worker as
              // resumed and drop the original confirmed wait.
              pause.phase = pause.manualResume || pause.demo ? "attention" : "waiting";
              pause.restartRecovery = pause.phase === "waiting";
              pause.settledAt = null;
              pause.note = pause.phase === "waiting" ? "Paseo's original workers ended during release. This conversation will continue after the quota resets."
                : "The worker ended during manual release. Check the session before continuing.";
              changed = true; continue;
            }
            if (pause.phase === "resuming") {
              pause.phase = pause.wasQuotaFailure && !pause.manualResume ? "waiting" : "resumed";
              pause.resumedInPlace = pause.phase === "resumed";
              pause.settledAt = pause.phase === "waiting" ? null : new Date(this.now()).toISOString(); pause.note = null;
              changed = true; continue;
            }
          }
          pause.phase = "attention";
          pause.note = "A reload interrupted an action before it was confirmed. Check the session before continuing manually.";
          changed = true;
        }
      }
      if (changed) await this.save(state);
  }
  async recover() {
    return this.exclusive(async () => {
      await this.recoverActions(await this.store.read());
    });
  }
  async setProtection(agentId: string, enabled: boolean | null) {
    return this.exclusive(async () => {
      const state = await this.store.read();
      if (enabled === null) delete state.overrides[agentId];
      else state.overrides[agentId] = enabled;
      const policy = await this.policy();
      if (!protects(policy, state.overrides, agentId)) {
        for (const pause of state.pauses.filter(p => p.agentId === agentId && isPending(p))) await this.cancel(pause, "Protection turned off for this session.");
      }
      await this.save(state);
    });
  }
  async cancelResume(agentId: string) {
    return this.exclusive(async () => {
      const state = await this.store.read();
      for (const pause of state.pauses.filter(p => p.agentId === agentId && isPending(p))) {
        // Releasing a hold opts out, so the next pass does not hold it again while the
        // account is still at the limit: frozen workers resume, a foreground hold lets go.
        state.overrides[agentId] = false;
        await this.cancel(pause, pause.suspension ? "Workers resumed immediately and this session was excluded from Session Guard."
          : "Released; this session no longer pauses at the limit. Continue it when ready.");
      }
      await this.save(state);
    });
  }
  /** Dismiss this exact pause without creating a message or restarting a turn. */
  async dismissPause(agentId: string, pauseId: string) {
    return this.exclusive(async () => {
      const state = await this.store.read();
      const pause = state.pauses.find(p => p.id === pauseId && p.agentId === agentId);
      if (pause?.phase === "cancelled" && pause.dismissed) return;
      if (!pause || !(pause.phase === "waiting" || (pause.phase === "attention" && pause.dismissed))) throw new Error("This pause is no longer available to dismiss.");
      state.overrides[agentId] = false;
      pause.dismissed = true;
      // Journal cancellation intent before SIGCONT: a crash or partial release
      // must never revive its scheduled continuation on the next boot.
      await this.store.write(state);
      try {
        await this.cancel(pause, "Pause dismissed without sending a message. Protection is off for this session.");
      } catch {
        pause.phase = "attention";
        pause.note = "Pause dismissal could not be completed. Protection is off; worker release will retry without sending a message.";
        await this.save(state);
        throw new Error(pause.note);
      }
      await this.save(state);
    });
  }
  /** Explicitly resumes this exact pause, even before the provider resets. */
  async resumeNow(agentId: string, pauseId: string) {
    return this.exclusive(async () => {
      const state = await this.store.read();
      const pause = state.pauses.find(p => p.id === pauseId && p.agentId === agentId);
      if (!pause || !isPending(pause)) return;
      if (pause.phase !== "waiting") throw new Error("Check this session before resuming it.");
      await this.connect(async client => {
        const latest = (await client.fetchAgent(agentId))?.agent;
        // A message sent since the last check is part of the hold, not a change: adopt it,
        // as the next check would.
        if (latest && messageArrived(pause, latest) && latest.status !== "closed") {
          pause.lastUserMessageAt = latest.lastUserMessageAt ?? null; delete pause.idle;
          if (pause.suspension && latest.activeTurn) pause.turnId = latest.activeTurn.turnId;
        }
        // Its turn may already be running, not yet interrupted: resuming just lets it run.
        const running = !pause.suspension && latest?.status === "running" && !!latest.activeTurn && latest.activeTurn.turnId !== pause.turnId;
        if (!latest || latest.archivedAt || (latest.status === "closed" && !pause.closedOnRestart) || latest.provider !== pause.provider ||
          (latest.lastUserMessageAt ?? null) !== pause.lastUserMessageAt ||
          (pause.suspension ? (latest.activeTurn?.turnId ?? null) !== pause.turnId
            : !running && (!(latest.status === "idle" || (pause.closedOnRestart && latest.status === "closed") || (pause.wasQuotaFailure && latest.status === "error")) || !!latest.pendingPermissions?.length))) {
          throw new Error("The session changed. Check it before continuing.");
        }
        if (pause.suspension && !this.processes) throw new Error("Native worker protection is unavailable.");
        state.overrides[agentId] = false; pause.manualResume = true; pause.phase = "resuming";
        await this.save(state);
        const needsMessage = (!pause.suspension && !running && continuesAtReset(pause)) || (pause.wasQuotaFailure && ["idle", "error"].includes(latest.status) && !latest.pendingPermissions?.length);
        if (pause.suspension) {
          // Identity-safe SIGCONT can be retried after a partial release.
          await this.processes!.resume(pause.suspension);
          delete pause.suspension; pause.resumedInPlace = true;
        }
        if (needsMessage) {
          try {
            await client.sendMessage(agentId, "You explicitly chose Resume now while Session Guard was waiting for the provider's session quota to reset. Continue the unfinished task in this conversation. Inspect interrupted operations before retrying. The provider may still reject requests until the quota resets. If the task is already complete, do not repeat it.", { messageId: pause.id, activeTurnBehavior: "steer" });
          } catch {
            pause.phase = "attention";
            pause.note = "Manual continuation could not be confirmed. Check the session before sending another message.";
            await this.save(state);
            throw new Error(pause.note);
          }
        }
        pause.phase = "resumed"; pause.settledAt = new Date(this.now()).toISOString();
        pause.note = "Resumed manually; protection is off for this session.";
        await this.save(state);
      });
    });
  }
  /** Only an explicitly labelled, empty disposable demo session may use this. */
  async pauseDemo(agentId: string) {
    return this.exclusive(async () => {
      const state = await this.store.read();
      if (state.pauses.some(p => p.agentId === agentId && isPending(p))) return;
      await this.connect(async client => {
        const agent = (await client.fetchAgent(agentId))?.agent;
        if (!agent || agent.labels?.session_guard_demo !== "true" || agent.status !== "idle" || agent.archivedAt ||
          agent.lastUserMessageAt || agent.activeTurn || agent.pendingPermissions?.length || !this.processes || !client.getDaemonStatus) {
          throw new Error("Only an empty Session Guard demo session can be paused for testing.");
        }
        const suspension = await this.processes.discover(agent, (await client.getDaemonStatus()).pid);
        if (!suspension) throw new Error("The demo provider process is unavailable.");
        const pause: Pause = { id: randomUUID(), agentId, workspaceId: agent.workspaceId, provider: agent.provider, title: agent.title ?? "Session Guard demo",
          windowId: "demo", anchorResetsAt: null, pausedAt: new Date(this.now()).toISOString(),
          lastUserMessageAt: null, turnId: null, phase: "pausing", note: "Test pause · waiting for your Resume now action.",
          settledAt: null, wasQuotaFailure: false, demo: true, suspension, daemonIdentity: await this.processes.daemonIdentity?.() };
        state.overrides[agentId] = true; state.pauses.push(pause); await this.save(state);
        try { await this.processes.freeze(suspension, () => this.store.write(state)); pause.phase = "waiting"; }
        catch { await this.processes.resume(suspension); delete pause.suspension; pause.phase = "attention"; pause.note = "The demo pause could not be confirmed."; }
        await this.save(state);
      });
    });
  }
  private async cancel(pause: Pause, note: string) {
    if (pause.suspension) {
      if (!this.processes) throw new Error("Suspended workers require a process controller.");
      await this.processes.resume(pause.suspension);
      delete pause.suspension;
    }
    pause.phase = "cancelled"; pause.note = note; pause.settledAt = new Date(this.now()).toISOString();
  }
  /** A normally completed turn racing cancel must never become a continuation. */
  async turnEnded(agentId: string, turnId: string | null, outcome: string, endedOnLimit = false) {
    return this.exclusive(async () => {
      if (!["completed", "canceled"].includes(outcome)) return;
      const state = await this.store.read();
      let changed = false;
      for (const pause of state.pauses.filter(p => p.agentId === agentId && isPending(p))) {
        if (pause.suspension) {
          if (outcome === "canceled" && turnId === pause.turnId) {
            pause.stoppedByUser = true;
            await this.cancel(pause, "The suspended turn was stopped by the user."); changed = true;
          }
          continue; // A completed foreground can still own background workers.
        }
        if (outcome !== "completed") continue;
        if (turnId !== null && pause.turnId === turnId) {
          if (endedOnLimit) {
            // It completed on the limit notice, not with the work done: the same pause
            // stands, now as the quota stop it is, rather than a release and a second pause.
            if (!pause.wasQuotaFailure) { pause.wasQuotaFailure = true; changed = true; }
            continue;
          }
          // Its work finished before the interrupt took, so nothing needs continuing; the
          // session is still at the limit, so it stays held.
          if (!pause.idle) { pause.idle = true; changed = true; }
        }
      }
      if (changed) await this.save(state);
    });
  }
  tick(): Promise<void> {
    return this.exclusive(async () => {
      if (this.stopped) return;
      try { this.error = null; await this.flush(); }
      catch { this.error = "Session Guard could not check the daemon or saved state. It will retry automatically."; }
    });
  }
  private async flush() {
    const policy = await this.policy();
    if (this.stopped) return;
    const state = await this.store.read();
    // Also backfill confirmed pauses created before timeline support was installed.
    if (this.publish) await this.save(state);
    // Process release is safely retryable after a partial signal failure.
    if (state.pauses.some(p => p.suspension && ["pausing", "resuming"].includes(p.phase))) await this.recoverActions(state);
    // Legacy continuations can wait while disabled; native OS workers must be
    // released when their protection is disabled, even if the daemon is offline.
    let released = false;
    for (const pause of state.pauses.filter(p => isPending(p) && p.suspension)) {
      if (!policy.enabled || !policy.includeNativeSubagents || !protects(policy, state.overrides, pause.agentId) ||
        (policy.providerIds.length > 0 && !policy.providerIds.includes(pause.provider))) {
        await this.cancel(pause, "Native worker protection turned off; workers released."); released = true;
      }
    }
    // An idle hold has nothing to continue, so turning the guard off simply ends it.
    if (!policy.enabled) {
      for (const pause of state.pauses.filter(p => p.phase === "waiting" && p.idle && !p.suspension)) {
        await this.cancel(pause, "Session Guard turned off; the hold ended."); released = true;
      }
    }
    if (released) await this.save(state);
    if (!policy.enabled) return;
    await this.connect(async client => {
      const agents: Agent[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.fetchAgents({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        agents.push(...page.entries.map(e => e.agent));
        if (!page.pageInfo?.hasMore) break;
        const next = page.pageInfo.nextCursor;
        if (!next || next === cursor) throw new Error("Agent pagination did not advance.");
        cursor = next;
      } while (!this.stopped);
      if (this.stopped) return;
      // New usage is always read through the daemon, never provider credentials.
      const usage = await this.readUsage(client);
      this.usage = usage;
      this.checkedAt = new Date(this.now()).toISOString();
      // With ZeroSub, each agent is measured on its own account, and an agent it can
      // move to an account with room is left to it: pausing first would stop the CLI
      // from reporting the limit ZeroSub fails over on. A failed read is "no ZeroSub".
      const accounts = await this.readAccounts(usage, policy).catch(() => null);
      this.accounts = accounts;
      const usageOf = (agentId: string, provider: string) => accounts?.usageFor(agentId, provider) ?? usage;
      // A hold ends when its own account has room again: the account it was paused on
      // resetting, or — with ZeroSub — the account ZeroSub has since moved it to, shown by
      // a reading newer than the pause. Room on some *other* account does not end it: a
      // turn sent then meets the limit on this account, and with Extra usage on the CLI
      // never reports that limit, so ZeroSub never moves it and the turn runs on paid
      // credits (the 2026-11-11 case).
      const ready = (pause: Pause) => resetReady(pause, usageOf(pause.agentId, pause.provider), policy, this.now()) ||
        (!!accounts && accounts.roomSince(pause.agentId, pause.provider, timestamp(pause.pausedAt)!) === "own");
      const byId = new Map(agents.map(a => [a.id, a]));
      this.providers = new Map(agents.map(a => [a.id, a.provider]));
      const currentDaemon = await this.processes?.daemonIdentity?.();
      let daemonPid: number | null = null;
      const nativeRunning = async (id: string) => client.listProviderSubagents
        ? (await client.listProviderSubagents(id)).subagents.some(s => s.status === "running") : false;
      let changed = false;
      // A quota response already in flight at SIGSTOP can arrive after SIGCONT.
      // Recover only that same failed native turn, once, using its original
      // reset anchor; unrelated errors and newer user work remain untouched.
      for (const pause of state.pauses.filter(p => p.phase === "resumed" && p.resumedInPlace && !p.wasQuotaFailure && !p.manualResume)) {
        const agent = byId.get(pause.agentId);
        const failure = this.quotaFailures.get(pause.agentId);
        if (agent && ["idle", "error"].includes(agent.status) && failure && failure.turnId === pause.turnId &&
          timestamp(failure.at)! >= timestamp(pause.settledAt)! && (agent.lastUserMessageAt ?? null) === pause.lastUserMessageAt) {
          pause.wasQuotaFailure = true; pause.phase = "waiting"; pause.settledAt = null; changed = true;
        }
      }
      for (const pause of state.pauses.filter(isPending)) {
        // Ambiguous manual sends remain for inspection, never a blind retry.
        if (pause.manualResume && pause.phase === "attention") continue;
        const agent = byId.get(pause.agentId);
        const restarted = !!currentDaemon && !!pause.daemonIdentity && currentDaemon !== pause.daemonIdentity;
        if (restarted && agent?.status === "closed" && !agent.archivedAt && !pause.demo && !pause.stoppedByUser &&
          !pause.manualResume && agent.provider === pause.provider && (agent.lastUserMessageAt ?? null) === pause.lastUserMessageAt &&
          protects(policy, state.overrides, pause.agentId)) {
          // Graceful shutdown persists closed snapshots. Only a changed daemon
          // identity permits reopening one; a user close in this daemon cancels.
          if (pause.suspension) { await this.processes!.resume(pause.suspension); delete pause.suspension; }
          pause.closedOnRestart = true; pause.restartRecovery = true; pause.phase = "waiting"; pause.settledAt = null;
          pause.note = "Paseo closed its workers during restart. This conversation will reopen after the quota resets.";
        }
        if (currentDaemon && pause.daemonIdentity !== currentDaemon) { pause.daemonIdentity = currentDaemon; changed = true; }
        // A person's message joins a waiting hold rather than ending it (below). Anything
        // not yet confirmed as waiting still gives way to it, and the next pass holds anew.
        if (!agent || (agent.status === "closed" && !pause.closedOnRestart) || agent.archivedAt || agent.provider !== pause.provider ||
          (pause.phase !== "waiting" && messageArrived(pause, agent)) ||
          !protects(policy, state.overrides, pause.agentId) ||
          (policy.providerIds.length > 0 && !policy.providerIds.includes(pause.provider))) {
          await this.cancel(pause, "Session changed, was closed, or protection was turned off."); changed = true; continue;
        }
        if (pause.phase !== "waiting") continue;
        if (messageArrived(pause, agent)) {
          if (pause.closedOnRestart && agent.status !== "closed") delete pause.closedOnRestart;
          // The message waits in the hold and runs after the reset: in a frozen process it
          // sits in the provider's input until SIGCONT (RESEARCH.md, "Messages to a stopped
          // provider"); in the foreground its turn is interrupted just below.
          pause.lastUserMessageAt = agent.lastUserMessageAt ?? null;
          if (pause.suspension && agent.activeTurn) pause.turnId = agent.activeTurn.turnId;
          delete pause.idle; pause.note = null;
          await this.save(state);
        }
        if (!pause.demo && !pause.manualResume && accounts) {
          if (pause.wasQuotaFailure && !pause.suspension && accounts.continuedElsewhere(pause.agentId)) {
            // ZeroSub carried this Codex task on in another tab; continuing here too would run it twice.
            await this.cancel(pause, "ZeroSub continued this task on another account, so Session Guard will not continue it here."); changed = true; continue;
          }
        }
        if (pause.suspension) {
          if (!this.processes) throw new Error("Native worker protection is unavailable.");
          const workerEnded = await this.leftDaemon(pause.suspension);
          if (workerEnded || !await this.processes.stopped(pause.suspension)) {
            if (!pause.demo && workerEnded && agent.status === "idle" && !pause.stoppedByUser) {
              // The old PID is gone (or reused). Release only matching orphan
              // identities, then keep the original reset anchor and conversation.
              await this.processes.resume(pause.suspension);
              delete pause.suspension; delete pause.releasedForUnload;
              pause.restartRecovery = true;
              pause.note = "Paseo's original workers ended. This conversation will continue after the quota resets.";
              await this.save(state); continue;
            }
            await this.cancel(pause, "Provider workers exited or were released outside Session Guard."); changed = true; continue;
          }
          if ((agent.activeTurn?.turnId ?? null) !== pause.turnId && !await nativeRunning(agent.id)) {
            await this.cancel(pause, "The suspended turn was stopped or changed outside Session Guard."); changed = true; continue;
          }
          if (pause.demo || (!policy.autoResume && !pause.idle) || this.now() < this.nextResumeAt || !ready(pause)) continue;
          const latest = (await client.fetchAgent(pause.agentId))?.agent;
          if (!latest || latest.archivedAt || latest.status === "closed" || latest.provider !== pause.provider ||
            (latest.lastUserMessageAt ?? null) !== pause.lastUserMessageAt ||
            (latest.activeTurn?.turnId ?? null) !== (agent.activeTurn?.turnId ?? null)) continue;
          if (this.stopped) return;
          pause.phase = "resuming"; await this.save(state);
          // SIGCONT is identity-checked and idempotent; it resumes the existing
          // parent + nested workers without injecting a new turn/message.
          await this.processes.resume(pause.suspension);
          delete pause.suspension;
          if (pause.wasQuotaFailure) {
            pause.phase = "waiting"; await this.save(state); continue;
          }
          pause.phase = "resumed"; pause.settledAt = new Date(this.now()).toISOString(); pause.note = null;
          pause.resumedInPlace = true;
          this.nextResumeAt = this.now() + policy.resumeSpacingSeconds * 1000;
          await this.save(state); continue;
        }
        if (agent.status === "running" && agent.activeTurn && agent.activeTurn.turnId !== pause.turnId) {
          // A turn started in a held session (a person's message, or another agent's): stop
          // it at once and keep holding. Its message stays in the conversation, and the
          // continuation after the reset carries it on.
          const latest = (await client.fetchAgent(pause.agentId))?.agent;
          if (!latest || latest.status !== "running" || !latest.activeTurn || latest.activeTurn.turnId === pause.turnId) continue;
          if (this.stopped) return;
          try { await client.cancelAgent(pause.agentId); }
          catch { this.error = "Session Guard could not stop a turn in a held session. It will retry automatically."; continue; }
          pause.turnId = latest.activeTurn.turnId; pause.lastUserMessageAt = latest.lastUserMessageAt ?? null;
          delete pause.idle; pause.note = null;
          await this.save(state); continue;
        }
        if (pause.idle) {
          // Nothing was interrupted, so the reset just lets go, with no message, whatever
          // automatic continuation says.
          if (!ready(pause)) continue;
          pause.phase = "resumed"; pause.settledAt = new Date(this.now()).toISOString(); pause.note = null;
          await this.save(state); continue;
        }
        const canContinue = (candidate: Agent) => candidate.status === "idle" || (pause.closedOnRestart && candidate.status === "closed") || (pause.wasQuotaFailure && candidate.status === "error");
        if (!canContinue(agent) || agent.pendingPermissions?.length || !policy.autoResume ||
          this.now() < this.nextResumeAt || !ready(pause)) continue;
        // Re-read just before sending: a person may have continued while usage was fetched.
        const latest = (await client.fetchAgent(pause.agentId))?.agent;
        if (!latest || !canContinue(latest) || latest.archivedAt || latest.pendingPermissions?.length ||
          latest.provider !== pause.provider || (latest.lastUserMessageAt ?? null) !== pause.lastUserMessageAt) continue;
        if (this.stopped) return;
        pause.phase = "resuming";
        await this.save(state);
        try {
          await client.sendMessage(pause.agentId, policy.continuation, { messageId: pause.id, activeTurnBehavior: "steer" });
          pause.phase = "resumed"; pause.settledAt = new Date(this.now()).toISOString(); pause.note = null;
          this.nextResumeAt = this.now() + policy.resumeSpacingSeconds * 1000;
        } catch {
          // Acceptance may have happened even if the socket dropped. No blind retry.
          pause.phase = "attention";
          pause.note = "Continuation could not be confirmed. Check the session and continue manually if needed.";
        }
        await this.save(state);
      }
      if (changed) await this.save(state);
      for (const id of this.fallbacks) if (!state.pauses.some(p => p.agentId === id && isPending(p) && !p.suspension)) this.fallbacks.delete(id);
      if (this.fallbacks.size) this.error = FALLBACK_ERROR;
      for (const agent of agents) {
        if (this.stopped) return;
        if (state.pauses.some(p => p.agentId === agent.id && p.stoppedByUser &&
          p.lastUserMessageAt === (agent.lastUserMessageAt ?? null) &&
          (!agent.activeTurn || agent.activeTurn.turnId === p.turnId))) continue;
        const failureAt = this.quotaFailures.get(agent.id)?.at;
        if (failureAt && (timestamp(agent.lastUserMessageAt) ?? 0) > timestamp(failureAt)!) this.quotaFailures.delete(agent.id);
        const quotaFailed = (agent.status === "error" || agent.status === "idle") && (
          this.quotaFailures.has(agent.id) || (agent.lastError !== undefined && /usage limit|rate.?limit|hit your limit|quota|limit reached|exceeded.*limit|limit.*exceeded|too many requests/i.test(agent.lastError)));
        if (quotaFailed && state.pauses.some(p => p.agentId === agent.id && p.wasQuotaFailure && p.lastUserMessageAt === (agent.lastUserMessageAt ?? null))) continue;
        const nativeEnabled = !!this.processes && policy.includeNativeSubagents && ["claude", "codex"].includes(agent.provider);
        if (agent.archivedAt || agent.status === "closed" || (!nativeEnabled && agent.pendingPermissions?.length) ||
          agent.labels?.internal === "true" || !protects(policy, state.overrides, agent.id) ||
          (policy.providerIds.length > 0 && !policy.providerIds.includes(agent.provider)) ||
          state.pauses.some(p => p.agentId === agent.id && isPending(p))) continue;
        const own = usageOf(agent.id, agent.provider);
        const provider = own.providers.find(p => p.providerId === agent.provider);
        const window = sessionWindow(provider, policy);
        if (!window || (usedPct(window) ?? -1) < policy.thresholdPct) continue;
        // Past the limit notice it is ZeroSub that switches, by its own rule: leave it be
        // while that rule has an account to move to.
        if (quotaFailed && accounts?.switchesAtLimit(agent.id, agent.provider)) continue;
        const fetchedAt = timestamp(provider?.fetchedAt ?? own.fetchedAt);
        const windowEnd = timestamp(window.resetsAt);
        if (windowEnd !== null && windowEnd <= this.now() && (fetchedAt === null || fetchedAt <= windowEnd)) continue;
        const hasBackground = nativeEnabled && agent.status !== "running" && await nativeRunning(agent.id);
        // Idle sessions are held too: a message sent into one must wait for the reset.
        const kind = holdKind(agent, quotaFailed, hasBackground);
        if (kind === null) continue;
        const idle = kind === "idle";
        // Do not stop a new turn based on a snapshot from before the upstream read.
        const latest = (await client.fetchAgent(agent.id))?.agent;
        if (!latest || latest.status !== agent.status || latest.provider !== agent.provider || latest.archivedAt ||
          (!nativeEnabled && latest.pendingPermissions?.length) || (latest.lastUserMessageAt ?? null) !== (agent.lastUserMessageAt ?? null) ||
          latest.activeTurn?.turnId !== agent.activeTurn?.turnId) continue;
        if (this.stopped) return;
        let suspension: Pause["suspension"];
        if (nativeEnabled && (!quotaFailed || hasBackground) && (!idle || freezesIdle(agent.provider))) {
          if (!client.getDaemonStatus) throw new Error("Daemon process identity is unavailable.");
          daemonPid ??= (await client.getDaemonStatus()).pid;
          suspension = await this.processes!.discover(latest, daemonPid) ?? undefined;
          if (!suspension && !idle) this.fallbacks.add(agent.id);
          if (!suspension && !idle) {
            // Fall back to the foreground rather than skip the session: never pretend the
            // interrupt also covers native children, but never let the turn run on either.
            this.error = FALLBACK_ERROR;
          }
        }
        const reset = timestamp(window.resetsAt);
        const pause: Pause = {
          id: randomUUID(), agentId: agent.id, workspaceId: agent.workspaceId, provider: agent.provider, title: agent.title ?? null,
          windowId: window.id, anchorResetsAt: reset === null ? null : new Date(reset).toISOString(),
          pausedAt: new Date(this.now()).toISOString(), lastUserMessageAt: agent.lastUserMessageAt ?? null,
          turnId: agent.activeTurn?.turnId ?? null, phase: (quotaFailed || idle) && !suspension ? "waiting" : "pausing", note: null, settledAt: null,
          wasQuotaFailure: quotaFailed, daemonIdentity: currentDaemon, ...(idle ? { idle: true } : {}),
          ...(suspension ? { suspension } : {}),
        };
        state.pauses.push(pause);
        await this.save(state);
        if (quotaFailed) this.quotaFailures.delete(agent.id);
        if ((quotaFailed || idle) && !suspension) continue;
        try {
          if (pause.suspension) await this.processes!.freeze(pause.suspension, () => this.store.write(state));
          else await client.cancelAgent(agent.id);
          pause.phase = "waiting";
        } catch {
          if (pause.suspension) {
            // Release partial suspensions before asking for manual inspection.
            await this.processes!.resume(pause.suspension);
            delete pause.suspension;
          }
          pause.phase = "attention";
          pause.note = "The pause could not be confirmed. Check the session before continuing manually.";
        }
        await this.save(state);
      }
    });
  }
}
