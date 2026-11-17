/**
 * "Move old history aside" in the plugin host: when to prepare, where to commit, and the RPCs.
 * Off unless `shedHistory` is on; see `server/history-shed.ts` for the rules it keeps.
 *
 * - Prepare (read-only, writes the backup) only for an agent that is not loaded: when Paseo closes
 *   it, and in a slow sweep over agents that are already closed. Never wakes an agent.
 * - Commit, and a requested restore, only inside `agent.session_open` for a Claude agent opening
 *   with no live runtime (a resume, an import, or a history-only view). Never throws there: a
 *   failing open hook fails the agent's open, so every path ends in "leave it as it is".
 */
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDue } from "../shared/history-shed.ts";
import { historyShedRestore, historyShedStatus, HISTORY_SHED_KIND } from "../shared/smart-session.ts";
import { readAgents, withDaemon } from "./daemon.ts";
import {
  claudeConfigDirs,
  commit,
  linuxProcesses,
  logRun,
  type OpenKind,
  openIsSafe,
  persistedSession,
  prepare,
  readPlan,
  restoreRequested,
  settle,
  type ShedEnv,
  type ShedPlan,
  agentPlans,
  listPlans,
  requestRestore,
} from "./history-shed.ts";
import { readSettings } from "./settings.ts";
import { dataDir } from "./store.ts";

const paseoHome = () => process.env.PASEO_HOME ?? join(homedir(), ".paseo");
/** Commit work inside the open hook stops before the rename after this long (the hook allows 30 s). */
const COMMIT_BUDGET_MS = 15_000;
const SWEEP_EVERY_MS = 15 * 60_000;
const FIRST_SWEEP_MS = 3 * 60_000;

function shedEnv(extraConfigDirs: readonly (string | undefined)[] = []): ShedEnv {
  return {
    dataDir: dataDir(),
    configDirs: () => claudeConfigDirs(paseoHome(), extraConfigDirs),
    processes: linuxProcesses,
  };
}

export function contributeHistoryShed(server: PluginServerContext): () => void {
  let runtime: PluginHandlerContext["paseo"] | null = null;
  let stopped = false;
  const preparing = new Set<string>();

  const prepareAgent = async (agentId: string): Promise<void> => {
    if (stopped || preparing.has(agentId)) return;
    const settings = await readSettings();
    if (!settings.shedHistory) return;
    preparing.add(agentId);
    try {
      const session = await persistedSession(paseoHome(), agentId);
      if (!session || session.provider !== "claude") return;
      const env = shedEnv();
      // An agent whose history was restored is left alone from then on.
      if ((await agentPlans(env, agentId)).some((p) => p.state === "restored" || p.restoreRequested)) return;
      const existing = await readPlan(env, agentId);
      if (existing) {
        const settled = await settle(env, existing);
        const again = await readPlan(env, agentId);
        if (again && again.sessionId === session.sessionId && (again.state === "prepared" || again.state === "committing")) return;
        if (settled === "kept") return;
      }
      const out = await prepare(env, agentId, session.sessionId, (size, plan) => {
        const due = isDue(size, plan, settings.shedThresholds);
        return due.due ? true : due.why;
      });
      if (!out.ok && !out.why.startsWith("due:") && !out.why.startsWith("cut:no-boundary")) {
        await logRun(env, { event: "not-prepared", agentId, why: out.why });
      }
    } catch (error) {
      await logRun(shedEnv(), { event: "error", stage: "prepare", agentId, error: error instanceof Error ? error.message : String(error) });
    } finally {
      preparing.delete(agentId);
    }
  };

  const sweep = async () => {
    if (stopped || !(await readSettings()).shedHistory) return;
    try {
      const rows = await withDaemon((client) => readAgents(client));
      for (const row of rows) {
        if (stopped) return;
        if (row.provider !== "claude" || row.status !== "closed") continue;
        await prepareAgent(row.id);
      }
    } catch { /* Daemon unreachable: the next sweep tries again. */ }
  };

  const removeOpen = server.before("agent.session_open", async ({ request }) => {
    try {
      if (request.provider !== "claude") return;
      if (!openIsSafe({ reason: request.reason, purpose: request.purpose } as OpenKind)) return;
      if (!(await readSettings()).shedHistory) return;
      const env = shedEnv([request.env?.CLAUDE_CONFIG_DIR]);
      let plan = await readPlan(env, request.agentId);
      if (!plan) return;
      const session = await persistedSession(paseoHome(), request.agentId);
      if (!session || session.sessionId !== plan.sessionId) return;
      await settle(env, plan);
      plan = (await readPlan(env, request.agentId))!;
      const deadline = Date.now() + COMMIT_BUDGET_MS;
      if ((await agentPlans(env, request.agentId)).some((p) => p.state === "committed" && p.restoreRequested)) {
        for (const out of await restoreRequested(env, request.agentId, deadline)) {
          if (!out.ok) await logRun(env, { event: "restore-refused", agentId: request.agentId, why: out.why });
        }
        return;
      }
      if (plan.state !== "prepared") return;
      const out = await commit(env, plan, deadline);
      if (out.ok) noteLater(out.plan);
      else await logRun(env, { event: "refused", agentId: plan.agentId, why: out.why });
    } catch (error) {
      await logRun(shedEnv(), { event: "error", stage: "open", agentId: request.agentId, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  });

  /**
   * Timeline appends need the host-owned API, which only an RPC handler receives (as in the guard): ask our own
   * status RPC once to get it. Hook and event contexts don't carry one that can append.
   */
  const hostApi = async (): Promise<PluginHandlerContext["paseo"]> => {
    if (!runtime) await withDaemon(async (client) => { await client.invokePluginRpc?.("smart-session", historyShedStatus.name, {}); });
    if (!runtime) throw new Error("Plugin runtime API is unavailable.");
    return runtime;
  };

  /** One chat row once the agent is open: "Older history moved to <folder>". Best effort, retried for a minute. */
  const noteLater = (plan: ShedPlan) => {
    let tries = 0;
    const attempt = async () => {
      if (stopped) return;
      if (++tries > 30) { await logRun(shedEnv(), { event: "note-failed", agentId: plan.agentId }); return; }
      try {
        await (await hostApi()).agents.ref(plan.agentId).timeline.append({
          type: "plugin",
          id: `history-shed-${plan.id}`,
          kind: HISTORY_SHED_KIND,
          version: 1,
          data: { at: plan.committedAt ?? new Date().toISOString(), from: plan.original.size, to: plan.cut.newSize, backupDir: plan.backupDir },
        });
      } catch {
        setTimeout(() => void attempt(), 2_000).unref?.();
      }
    };
    setTimeout(() => void attempt(), 1_000).unref?.();
  };

  const removeClosed = server.on("agent.closed", (event) => {
    if (event.agent.provider !== "claude") return;
    // A moment later, once Paseo has finished closing it.
    setTimeout(() => void prepareAgent(event.agent.id), 5_000).unref?.();
  });

  server.handle(historyShedStatus, async ({ agentId }, context) => {
    runtime = context.paseo;
    const settings = await readSettings();
    const plans = (await listPlans(shedEnv())).filter((p) => agentId === undefined || p.agentId === agentId);
    return {
      enabled: settings.shedHistory,
      plans: await Promise.all(plans.map(async (p) => ({
        agentId: p.agentId,
        title: (await persistedSession(paseoHome(), p.agentId).catch(() => null))?.title ?? null,
        state: p.state,
        from: p.original.size,
        to: p.cut.newSize,
        compactions: p.cut.compactions,
        backupDir: p.backupDir,
        preparedAt: p.preparedAt,
        committedAt: p.committedAt ?? null,
        restoredAt: p.restoredAt ?? null,
        restoreRequested: p.restoreRequested === true,
      }))),
    };
  });

  server.handle(historyShedRestore, async ({ agentId }, context) => {
    runtime = context.paseo;
    const plan = await requestRestore(shedEnv(), agentId);
    return plan === null
      ? { ok: false as const, error: "No moved history to restore for this agent." }
      : { ok: true as const, note: "The full history goes back the next time this agent loads or its chat opens." };
  });

  const first = setTimeout(() => void sweep(), FIRST_SWEEP_MS);
  first.unref?.();
  const every = setInterval(() => void sweep(), SWEEP_EVERY_MS);
  every.unref?.();

  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(every);
    removeOpen?.();
    removeClosed?.();
  };
}
