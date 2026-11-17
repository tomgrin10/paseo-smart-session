/**
 * "Move old history aside" in the plugin host: when to prepare, where to commit, and the RPCs.
 * Off unless `shedHistory` is on; see `server/history-shed.ts` for the rules it keeps.
 *
 * - Prepare (read-only, writes the backup) only for an agent that is not loaded: when Paseo closes
 *   it, and in a slow sweep over agents that are already closed. Never wakes an agent.
 * - `history_shed.prepare` does the same for one closed agent the person names, whatever the setting says
 *   (a canary, or "Move now"): that plan is marked requested and commits at the agent's next open.
 * - Commit, and a requested restore, only inside `agent.session_open` for a Claude agent opening
 *   with no live runtime (a resume, an import, or a history-only view); see `history-shed-open.ts`.
 *   A requested restore runs whatever the setting says. Never throws there.
 */
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDue } from "../shared/history-shed.ts";
import { historyShedPrepare, historyShedRestore, historyShedStatus, HISTORY_SHED_KIND } from "../shared/smart-session.ts";
import { readAgents, withDaemon } from "./daemon.ts";
import {
  agentPlans,
  claudeConfigDirs,
  linuxProcesses,
  listPlans,
  logRun,
  markNoted,
  migrateBackups,
  persistedSession,
  prepare,
  readPlan,
  type Refusal,
  requestRestore,
  requestShed,
  transcriptSizes,
  settle,
  type ShedEnv,
  type ShedPlan,
  unreadablePlans,
  leftoverFiles,
} from "./history-shed.ts";
import { openHandler } from "./history-shed-open.ts";
import { readSettings } from "./settings.ts";
import { dataDir } from "./store.ts";

const paseoHome = () => process.env.PASEO_HOME ?? join(homedir(), ".paseo");
const SWEEP_EVERY_MS = 15 * 60_000;
const FIRST_SWEEP_MS = 3 * 60_000;

function shedEnv(extraConfigDirs: readonly (string | undefined)[] = []): ShedEnv {
  return {
    dataDir: dataDir(),
    configDirs: () => claudeConfigDirs(paseoHome(), extraConfigDirs),
    processes: linuxProcesses,
  };
}

/** What a refused request tells the person. */
function refusalText(why: Refusal): string {
  switch (why) {
    case "not-closed": return "This agent is open or running. Close it first: history only moves while an agent isn't loaded.";
    case "no-session": return "Paseo has no Claude session saved for this agent.";
    case "not-claude": return "Only Claude agents' history can be moved.";
    case "busy": return "A process has this agent's transcript open. Try again once it's closed.";
    case "no-proc": return "Couldn't check which processes have the transcript open, so nothing was done.";
    case "no-transcript": return "Couldn't find this agent's transcript.";
    case "ambiguous-transcript": return "This agent's session id names more than one transcript, so nothing was done.";
    case "changed": return "The transcript changed while it was read. Try again.";
    case "unreadable-plan": return "A plan file for this agent can't be read. Fix or remove it under history-shed/plans.";
    case "unused-backups": return "This agent already has two unused backups. Its transcript kept changing before each move.";
    case "restore-pending": return "A restore is waiting for this agent's next load. Moving history again would undo it.";
    default:
      if (why.startsWith("cut:")) return "There's no compaction to cut at: all of this history is still in use.";
      if (why === "due:too-little-to-move") return "Less than 1 MB would move, so it isn't worth a backup.";
      return `Not prepared (${why}).`;
  }
}

export function contributeHistoryShed(server: PluginServerContext): () => void {
  let runtime: PluginHandlerContext["paseo"] | null = null;
  let stopped = false;
  const preparing = new Set<string>();
  /** The last refusal logged per agent, so a sweep every 15 minutes doesn't repeat it. */
  const lastRefusal = new Map<string, string>();

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
      if (!out.ok && !out.why.startsWith("due:") && !out.why.startsWith("cut:no-boundary") && lastRefusal.get(agentId) !== out.why) {
        await logRun(env, { event: "not-prepared", agentId, why: out.why });
      }
      if (out.ok) lastRefusal.delete(agentId);
      else lastRefusal.set(agentId, out.why);
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

  const onOpen = openHandler({
    env: (extra) => shedEnv(extra),
    settings: readSettings,
    session: (agentId) => persistedSession(paseoHome(), agentId),
    note: (plan) => noteLater(plan),
  });
  const removeOpen = server.before("agent.session_open", async ({ request }, context) => {
    // The budget counts from here: Paseo cancels a hook after 30 s and fails the open.
    await onOpen(request, context?.signal, Date.now());
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
    let lastError = "";
    const attempt = async () => {
      if (stopped) return;
      if (++tries > 30) { await logRun(shedEnv(), { event: "note-failed", agentId: plan.agentId, error: lastError }); return; }
      try {
        await (await hostApi()).agents.ref(plan.agentId).timeline.append({
          type: "plugin",
          id: `history-shed-${plan.id}`,
          kind: HISTORY_SHED_KIND,
          version: 1,
          data: { at: plan.committedAt ?? new Date().toISOString(), from: plan.original.size, to: plan.cut.newSize, backupDir: plan.backupDir },
        });
        await markNoted(shedEnv(), plan);
        await logRun(shedEnv(), { event: "noted", agentId: plan.agentId, tries });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (tries === 1) await logRun(shedEnv(), { event: "note-retry", agentId: plan.agentId, error: lastError });
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

  server.handle(historyShedStatus, async ({ agentId, candidates }, context) => {
    runtime = context.paseo;
    const settings = await readSettings();
    const all = await listPlans(shedEnv());
    const plans = all.filter((p) => agentId === undefined || p.agentId === agentId);
    return {
      enabled: settings.shedHistory,
      unreadable: (await unreadablePlans(shedEnv())).filter((u) => agentId === undefined || u.agentId === agentId),
      leftovers: (await leftoverFiles(shedEnv())).filter((l) => agentId === undefined || l.agentId === agentId),
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
        rollbackPending: p.rollback !== undefined,
        origin: p.requested === true ? "requested" as const : "sweep" as const,
        requestedAt: p.requestedAt ?? null,
      }))),
      ...(candidates === true ? { candidates: await candidateAgents(all) } : {}),
    };
  });

  /** Closed Claude agents a request could move: no shed under way or restored, at least 5 MB, largest first. */
  let candidateCache: { at: number; rows: { agentId: string; title: string | null; size: number }[] } | null = null;
  const candidateAgents = async (plans: readonly ShedPlan[]) => {
    if (candidateCache && Date.now() - candidateCache.at < 60_000) return candidateCache.rows;
    const busy = new Set(plans.filter((p) => p.state !== "discarded").map((p) => p.agentId));
    let rows: Awaited<ReturnType<typeof readAgents>> = [];
    try { rows = await withDaemon((client) => readAgents(client)); } catch { return []; }
    const sessions = new Map<string, { agentId: string; title: string | null }>();
    for (const row of rows) {
      if (row.provider !== "claude" || row.status !== "closed" || busy.has(row.id)) continue;
      const session = await persistedSession(paseoHome(), row.id).catch(() => null);
      if (session?.provider === "claude") sessions.set(session.sessionId, { agentId: row.id, title: row.title ?? session.title });
    }
    const sizes = await transcriptSizes(await shedEnv().configDirs(), new Set(sessions.keys()));
    const out = [...sizes].map(([sessionId, size]) => ({ ...sessions.get(sessionId)!, size }))
      .filter((c) => c.size >= 5 * 1024 * 1024)
      .sort((a, b) => b.size - a.size)
      .slice(0, 10);
    candidateCache = { at: Date.now(), rows: out };
    return out;
  };

  server.handle(historyShedPrepare, async ({ agentId }, context) => {
    runtime = context.paseo;
    try {
      let closed = false;
      try {
        const row = (await withDaemon((client) => readAgents(client))).find((r) => r.id === agentId);
        closed = row?.status === "closed";
      } catch { /* Unknown: refused as not closed. */ }
      const session = await persistedSession(paseoHome(), agentId);
      const out = await requestShed(shedEnv(), agentId, { session, closed });
      candidateCache = null;
      if (!out.ok) return { ok: false as const, why: out.why, error: refusalText(out.why) };
      const p = out.plan;
      return {
        ok: true as const,
        note: "Backup written and verified. The older history moves aside the next time this agent loads or its chat opens, even with the setting off.",
        plan: {
          agentId: p.agentId,
          sessionId: p.sessionId,
          planId: p.id,
          reused: out.reused,
          transcript: p.path,
          from: p.original.size,
          to: p.cut.newSize,
          movedBytes: p.cut.movedBytes,
          movedRecords: p.cut.movedRecords,
          compactions: p.cut.compactions,
          cutAt: p.cut.boundaryTimestamp,
          backupDir: p.backupDir,
          backupFile: join(p.backupDir, "transcript.jsonl"),
          backupSha256: p.original.sha256,
          afterSha256: p.expectedSha256,
          subagentsMoving: p.subagents.filter((s) => s.move).length,
          preparedAt: p.preparedAt,
        },
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await logRun(shedEnv(), { event: "error", stage: "request", agentId, error: text });
      return { ok: false as const, why: "error", error: `Couldn't prepare it: ${text}` };
    }
  });

  server.handle(historyShedRestore, async ({ agentId }, context) => {
    runtime = context.paseo;
    const plan = await requestRestore(shedEnv(), agentId);
    return plan === null
      ? { ok: false as const, error: "No moved history to restore for this agent." }
      : { ok: true as const, note: "The full history goes back the next time this agent loads or its chat opens." };
  });

  // Backups 3.8.0-beta.1 kept beside the transcript are copied into the data folder (whatever the setting says).
  const migrate = setTimeout(() => void migrateBackups(shedEnv()).catch(() => undefined), 10_000);
  migrate.unref?.();
  const first = setTimeout(() => void sweep(), FIRST_SWEEP_MS);
  first.unref?.();
  const every = setInterval(() => void sweep(), SWEEP_EVERY_MS);
  every.unref?.();

  return () => {
    stopped = true;
    clearTimeout(migrate);
    clearTimeout(first);
    clearInterval(every);
    removeOpen?.();
    removeClosed?.();
  };
}
