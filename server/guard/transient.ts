import { randomUUID } from "node:crypto";
import type { Connect } from "./client.ts";
import type { Agent } from "../../shared/guard/policy.ts";
import { classifyTransient, TRANSIENT_BACKOFF_MS, TRANSIENT_CONTINUATION, TRANSIENT_SPACING_MS, type TransientClass } from "../../shared/guard/transient.ts";

export interface RecoveryOptions {
  policy: () => Promise<boolean>; blocked: (agentId: string) => Promise<boolean>;
  claim: () => Promise<() => Promise<void>>; connect: Connect;
  now?: () => number; schedule?: (work: () => void, delay: number) => () => void; log?: (line: string) => void;
}
interface Incident {
  id: string; provider: string; messageAt: string | null; kind: TransientClass;
  tries: number; due: number | null; awaitingStart: boolean;
}
interface WorkingTurn {
  id: string; snapshot: Promise<Agent | null>; incident?: Incident; ended: boolean;
}
/** Only live turn events establish unfinished work. Never sweep errored/idle agents
 * on load: an old error is not authority to wake a dormant conversation. */
export class TransientRecovery {
  private readonly options: RecoveryOptions;
  private readonly now: () => number;
  private readonly schedule: NonNullable<RecoveryOptions["schedule"]>;
  private turns = new Map<string, WorkingTurn>();
  private incidents = new Map<string, Incident>();
  private ownership: Promise<() => Promise<void>> | null = null;
  private cancelTimer: (() => void) | null = null;
  private current: Promise<void> | null = null;
  private stopped = false;
  private nextSendAt = 0;
  constructor(options: RecoveryOptions) {
    this.options = options; this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((work, delay) => {
      const timer = setTimeout(work, delay); timer.unref();
      return () => clearTimeout(timer);
    });
  }
  get nextAt(): number | null {
    const times = [...this.incidents.values()].flatMap(i => i.due === null ? [] : [Math.max(i.due, this.nextSendAt)]);
    return times.length ? Math.min(...times) : null;
  }
  private arm() {
    this.cancelTimer?.(); this.cancelTimer = null;
    const due = this.nextAt;
    if (!this.stopped && due !== null) this.cancelTimer = this.schedule(() => { void this.tick(); }, Math.max(0, due - this.now()));
  }
  started(agentId: string, turnId: string | null): void {
    if (this.stopped || !turnId) return;
    const previous = this.incidents.get(agentId);
    const incident = previous?.awaitingStart ? previous : undefined;
    if (incident) incident.awaitingStart = false;
    else this.incidents.delete(agentId); // A person or another actor took over.
    const snapshot = this.options.policy().then(enabled => enabled
      ? this.options.connect(async client => (await client.fetchAgent(agentId))?.agent ?? null) : null).catch(() => null);
    this.turns.set(agentId, { id: turnId, snapshot, incident, ended: false });
    this.arm();
  }
  async ended(agentId: string, turnId: string | null, outcome: { kind: string; error?: { message: string } }): Promise<void> {
    const turn = this.turns.get(agentId);
    if (this.stopped || !turn || turn.ended || turn.id !== turnId) return;
    turn.ended = true;
    const kind = outcome.kind === "failed" ? classifyTransient(outcome.error?.message ?? "") : null;
    const snapshot = await turn.snapshot;
    if (this.stopped || this.turns.get(agentId) !== turn) return;
    if (!kind || !snapshot || snapshot.archivedAt || !await this.options.policy().catch(() => false)) {
      this.turns.delete(agentId); this.incidents.delete(agentId); this.arm(); return;
    }
    // Lazy, separate ownership: quota protection can remain off, and an unused
    // recovery feature creates no directory or lock. Duplicate installs cannot send.
    try {
      this.ownership ??= this.options.claim();
      await this.ownership;
    } catch { this.ownership = null; this.turns.delete(agentId); return; }
    if (this.stopped || this.turns.get(agentId) !== turn) return;
    this.turns.delete(agentId);
    const incident = turn.incident ?? { id: randomUUID(), provider: snapshot.provider, messageAt: null, kind, tries: 0, due: null, awaitingStart: false };
    incident.messageAt = snapshot.lastUserMessageAt ?? null;
    incident.kind = kind;
    incident.due = incident.tries < TRANSIENT_BACKOFF_MS.length ? this.now() + TRANSIENT_BACKOFF_MS[incident.tries] : null;
    this.incidents.set(agentId, incident);
    this.arm();
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.current) return this.current;
    this.cancelTimer?.(); this.cancelTimer = null;
    this.current = this.run().finally(() => { this.current = null; this.arm(); });
    return this.current;
  }
  private async run() {
    if (!await this.options.policy().catch(() => false)) { this.clear(); return; }
    for (const [agentId, incident] of this.incidents) {
      if (this.stopped || incident.due === null || this.now() < Math.max(incident.due, this.nextSendAt)) continue;
      try {
        if (await this.options.blocked(agentId)) { this.incidents.delete(agentId); continue; }
        await this.options.connect(async client => {
          const latest = (await client.fetchAgent(agentId))?.agent;
          if (this.stopped || this.incidents.get(agentId) !== incident) return;
          if (!latest || latest.status !== "error" || latest.archivedAt || latest.activeTurn || latest.pendingPermissions?.length ||
            latest.provider !== incident.provider || (latest.lastUserMessageAt ?? null) !== incident.messageAt ||
            (latest.lastError !== undefined && classifyTransient(latest.lastError) !== incident.kind)) {
            this.incidents.delete(agentId); return;
          }
          if (!await this.options.policy().catch(() => false) || this.stopped || this.incidents.get(agentId) !== incident) return;
          // Spend the attempt before the send. An uncertain delivery never causes a
          // blind retry; only a new, observed retry turn failing can schedule another.
          incident.tries++; incident.due = null; incident.awaitingStart = true;
          this.nextSendAt = this.now() + TRANSIENT_SPACING_MS;
          try {
            await client.sendMessage(agentId, TRANSIENT_CONTINUATION, { messageId: `transient-${incident.id}-${incident.tries}`, activeTurnBehavior: "steer" });
            this.trace(agentId, incident, "sent");
          } catch {
            this.incidents.delete(agentId); this.turns.delete(agentId);
            this.trace(agentId, incident, "unconfirmed");
          }
        });
      } catch {
        // A failed observation is not a failed model attempt. Recheck without
        // sending, without consuming a try, and without a tight timer loop.
        if (this.incidents.get(agentId) === incident) incident.due = this.now() + TRANSIENT_SPACING_MS;
      }
    }
  }
  private trace(agentId: string, incident: Incident, delivery: "sent" | "unconfirmed") {
    try { (this.options.log ?? console.log)(`[smart-session] guard transient-resume agent=${agentId} at=${new Date(this.now()).toISOString()} class=${incident.kind} try=${incident.tries} delivery=${delivery}`); } catch {}
  }
  private clear() {
    this.turns.clear(); this.incidents.clear(); this.cancelTimer?.(); this.cancelTimer = null;
  }
  async settingsChanged(): Promise<void> {
    if (!await this.options.policy().catch(() => false)) {
      this.clear();
      const ownership = this.ownership; this.ownership = null;
      await this.current?.catch(() => undefined);
      if (ownership) await (await ownership.catch(() => null))?.();
    }
  }
  async stop(): Promise<void> {
    this.stopped = true; this.clear();
    await this.current?.catch(() => undefined);
    const ownership = this.ownership; this.ownership = null;
    if (ownership) await (await ownership.catch(() => null))?.();
  }
}
