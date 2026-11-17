/**
 * The `agent.session_open` work for "Move old history aside": settle, a requested restore, and the
 * commit, for a Claude agent opening with no live runtime. Kept apart from the host so it can be tested.
 *
 * - The budget counts from the hook's own start (Paseo gives a hook 30 s, then cancels it and fails the
 *   open). Work stops before any rename once the budget is spent or Paseo cancels.
 * - One piece of work per agent at a time. An open that arrives while an earlier one for the same agent
 *   is still working (Paseo gave up on it) stops that one, waits for it, and changes nothing itself.
 * - After an open Paseo canceled, the next open leaves the files alone; the one after may commit.
 * - A restore the person asked for runs whatever the setting says; only a commit needs it on.
 * - Never throws: a failing open hook fails the agent's open.
 */
import {
  clearOverrun,
  commit,
  logRun,
  markOverrun,
  type OpenKind,
  openIsSafe,
  readPlans,
  restoreRequested,
  settle,
  type ShedEnv,
  type ShedPlan,
  unnoted,
} from "./history-shed.ts";

/** Pre-rename work inside the open hook stops this long after the hook started (Paseo allows 30 s). */
export const OPEN_BUDGET_MS = 12_000;

export interface OpenRequest {
  readonly agentId: string;
  readonly provider: string;
  readonly reason: OpenKind["reason"];
  readonly purpose: OpenKind["purpose"];
  readonly env?: Readonly<Record<string, string>>;
}

export interface OpenDeps {
  readonly env: (extraConfigDirs: readonly (string | undefined)[]) => ShedEnv;
  readonly settings: () => Promise<{ readonly shedHistory: boolean }>;
  readonly session: (agentId: string) => Promise<{ readonly provider: string; readonly sessionId: string } | null>;
  /** The chat row, once the agent is open. */
  readonly note: (plan: ShedPlan) => void;
  readonly budgetMs?: number;
  readonly now?: () => number;
}

export function openHandler(deps: OpenDeps) {
  const now = deps.now ?? Date.now;
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>();

  const work = async (request: OpenRequest, signal: AbortSignal, deadline: number): Promise<void> => {
    const env = deps.env([request.env?.CLAUDE_CONFIG_DIR]);
    const { plans, unreadable } = await readPlans(env, request.agentId);
    if (unreadable.length > 0) { await logRun(env, { event: "refused", agentId: request.agentId, why: "unreadable-plan" }); return; }
    const newest = plans.find((p) => p.state !== "discarded");
    if (!newest) return;
    const session = await deps.session(request.agentId);
    if (!session || session.sessionId !== newest.sessionId) return;
    if (newest.overranAt) {
      // Paseo canceled the last open that worked on it: leave the files alone this time.
      await clearOverrun(env, newest);
      await logRun(env, { event: "skipped", agentId: request.agentId, why: "the open before this one was canceled" });
      return;
    }
    if (signal.aborted || now() > deadline) return;
    await settle(env, newest);
    const fresh = await readPlans(env, request.agentId);
    const plan = fresh.plans.find((p) => p.state !== "discarded");
    if (!plan) return;
    if (fresh.plans.some((p) => p.restoreRequested && (p.state === "committed" || p.state === "committing" || p.state === "restoring"))) {
      for (const out of await restoreRequested(env, request.agentId, deadline, signal)) {
        if (out.ok) continue;
        await logRun(env, { event: "restore-refused", agentId: request.agentId, why: out.why });
        if (out.why === "aborted" && out.plan) await markOverrun(env, out.plan);
      }
      return;
    }
    if (!(await deps.settings()).shedHistory) return;
    if (plan.state !== "prepared") {
      // A commit whose process died before its chat row: add the row now.
      const missing = await unnoted(env, request.agentId);
      if (missing) deps.note(missing);
      return;
    }
    const out = await commit(env, plan, deadline, signal);
    if (out.ok) { deps.note(out.plan); return; }
    await logRun(env, { event: "refused", agentId: plan.agentId, why: out.why });
    if (out.why === "aborted") await markOverrun(env, out.plan ?? plan);
  };

  return async (request: OpenRequest, signal?: AbortSignal, enteredAt: number = now()): Promise<void> => {
    try {
      if (request.provider !== "claude" || !openIsSafe({ reason: request.reason, purpose: request.purpose })) return;
      const previous = running.get(request.agentId);
      if (previous) {
        // Paseo gave up on that open and is opening again: stop it, wait for it, and change nothing now.
        previous.controller.abort();
        await previous.done;
        const env = deps.env([request.env?.CLAUDE_CONFIG_DIR]);
        const newest = (await readPlans(env, request.agentId)).plans.find((p) => p.state !== "discarded");
        if (newest) await clearOverrun(env, newest);
        await logRun(env, { event: "skipped", agentId: request.agentId, why: "an earlier open was still working" });
        return;
      }
      const controller = new AbortController();
      const forward = () => controller.abort();
      if (signal?.aborted) controller.abort();
      signal?.addEventListener("abort", forward, { once: true });
      let finish!: () => void;
      const done = new Promise<void>((resolve) => (finish = resolve));
      running.set(request.agentId, { controller, done });
      try {
        await work(request, controller.signal, enteredAt + (deps.budgetMs ?? OPEN_BUDGET_MS));
      } finally {
        signal?.removeEventListener("abort", forward);
        running.delete(request.agentId);
        finish();
      }
    } catch (error) {
      try {
        await logRun(deps.env([]), { event: "error", stage: "open", agentId: request.agentId, error: error instanceof Error ? error.message : String(error) });
      } catch { /* Never throws. */ }
    }
  };
}
