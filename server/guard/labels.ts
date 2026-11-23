import type { Connect } from "./client.ts";
import type { Store } from "./store.ts";
import type { Pause, Policy, State } from "../../shared/guard/policy.ts";
import { HELD_LABELS, heldLabel } from "../../shared/guard/hold.ts";

export const PAUSED_WORKSPACE_LABEL = { name: HELD_LABELS.held, color: "amber" as const };

/**
 * The label each held workspace should carry: its hold's (`heldLabel`, which says why it's still
 * held), or plain "Held" when its holds say different things.
 */
export function desiredLabels(pauses: readonly Pause[]): Map<string, string> {
  const desired = new Map<string, string>();
  for (const pause of pauses) {
    if (!pause.workspaceId || !["waiting", "resuming"].includes(pause.phase)) continue;
    const name = heldLabel(pause);
    const before = desired.get(pause.workspaceId);
    desired.set(pause.workspaceId, before === undefined || before === name ? name : HELD_LABELS.held);
  }
  return desired;
}
/** The label name this process gave a workspace it labelled (older states kept one name for all). */
const managedName = (state: State, workspaceId: string) => state.workspaceLabelNames?.[workspaceId] ?? state.workspaceLabelName ?? "Paused by Session Guard";
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
        const desired = policy.workspaceLabels ? desiredLabels(state.pauses) : new Map<string, string>();
        const managed = state.labelledWorkspaces ?? [];
        // A label whose reason changed comes off before the new one goes on.
        const remove = managed.find(id => desired.get(id) !== managedName(state, id));
        if (remove) return { workspaceId: remove, assigned: false, name: managedName(state, remove) };
        const add = [...desired].find(([id, name]) => !acknowledged.has(`${id}\0${name}`));
        if (!add) return null;
        const [workspaceId, name] = add;
        if (!managed.includes(workspaceId)) {
          state.labelledWorkspaces = [...managed, workspaceId];
          state.workspaceLabelNames = { ...state.workspaceLabelNames, [workspaceId]: name };
          state.workspaceLabelName = PAUSED_WORKSPACE_LABEL.name;
          await this.store.write(state);
        }
        return { workspaceId, assigned: true, name };
      });
      if (!action) { this.error = null; return; }
      await this.connect(async client => {
        if (!client.setWorkspaceLabel) throw new Error("Workspace labels are unavailable on this Paseo host.");
        await client.setWorkspaceLabel({ workspaceId: action.workspaceId, assigned: action.assigned, label: { ...PAUSED_WORKSPACE_LABEL, name: action.name } });
      });
      if (action.assigned) acknowledged.add(`${action.workspaceId}\0${action.name}`);
      else await this.exclusive(async () => {
        const state = await this.store.read();
        state.labelledWorkspaces = (state.labelledWorkspaces ?? []).filter(id => id !== action.workspaceId);
        if (state.workspaceLabelNames?.[action.workspaceId] !== undefined) {
          const { [action.workspaceId]: _gone, ...rest } = state.workspaceLabelNames;
          state.workspaceLabelNames = rest;
        }
        await this.store.write(state);
      });
    }
  }
  async stop() { this.stopped = true; await this.pending; }
}
