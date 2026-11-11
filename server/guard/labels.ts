import type { Connect } from "./client.ts";
import type { Store } from "./store.ts";
import type { Policy } from "../../shared/guard/policy.ts";

export const PAUSED_WORKSPACE_LABEL = { name: "Held", color: "amber" as const };
type Exclusive = <T>(work: () => Promise<T>) => Promise<T>;

/** Label delivery never holds the governor's action lock during daemon I/O. */
export class WorkspaceLabels {
  private store: Store;
  private exclusive: Exclusive;
  private connect: Connect;
  private policy: () => Promise<Policy>;
  private pending: Promise<void> | null = null;
  private stopped = false;
  error: string | null = null;
  constructor(store: Store, exclusive: Exclusive, connect: Connect, policy: () => Promise<Policy>) {
    this.store = store; this.exclusive = exclusive; this.connect = connect; this.policy = policy;
  }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.reconcile().catch(() => {
      this.error = "Workspace pause labels are awaiting delivery. Session protection is still active; labels will retry.";
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
  private async reconcile() {
    const pauses = await this.exclusive(async () => (await this.store.read()).pauses.filter(p => ["waiting", "resuming"].includes(p.phase)));
    const assignments = new Map<string, string>();
    if (pauses.length) await this.connect(async client => {
      for (const pause of pauses) {
        const agent = (await client.fetchAgent(pause.agentId))?.agent;
        if (agent?.workspaceId) assignments.set(pause.id, agent.workspaceId);
      }
    });
    await this.exclusive(async () => {
      const state = await this.store.read(); let changed = false;
      for (const pause of state.pauses) {
        const workspaceId = assignments.get(pause.id);
        if (workspaceId && pause.workspaceId !== workspaceId) { pause.workspaceId = workspaceId; changed = true; }
      }
      if (changed) await this.store.write(state);
    });
    // Re-read after every acknowledgement: another session may pause or resume
    // while a label RPC is in flight. Journal ownership before an assignment so
    // a lost acknowledgement or crash still lets us remove the label later.
    const acknowledged = new Set<string>();
    for (let i = 0; i < 400 && !this.stopped; i++) {
      const policy = await this.policy();
      const action = await this.exclusive(async () => {
        const state = await this.store.read();
        const desired = new Set(policy.workspaceLabels ? state.pauses.filter(p => ["waiting", "resuming"].includes(p.phase)).map(p => p.workspaceId).filter((id): id is string => !!id) : []);
        const managed = state.labelledWorkspaces ?? [];
        const name = state.workspaceLabelName ?? "Paused by Session Guard";
        const remove = managed.find(id => name !== PAUSED_WORKSPACE_LABEL.name || !desired.has(id));
        if (remove) return { workspaceId: remove, assigned: false, name };
        const add = [...desired].find(id => !acknowledged.has(id));
        if (!add) return null;
        if (!managed.includes(add)) { state.labelledWorkspaces = [...managed, add]; state.workspaceLabelName = PAUSED_WORKSPACE_LABEL.name; await this.store.write(state); }
        return { workspaceId: add, assigned: true, name: PAUSED_WORKSPACE_LABEL.name };
      });
      if (!action) { this.error = null; return; }
      await this.connect(async client => {
        if (!client.setWorkspaceLabel) throw new Error("Workspace labels are unavailable on this Paseo host.");
        await client.setWorkspaceLabel({ workspaceId: action.workspaceId, assigned: action.assigned, label: { ...PAUSED_WORKSPACE_LABEL, name: action.name } });
      });
      if (action.assigned) acknowledged.add(action.workspaceId);
      else await this.exclusive(async () => {
        const state = await this.store.read();
        state.labelledWorkspaces = (state.labelledWorkspaces ?? []).filter(id => id !== action.workspaceId);
        await this.store.write(state);
      });
    }
  }
  async stop() { this.stopped = true; await this.pending; }
}
