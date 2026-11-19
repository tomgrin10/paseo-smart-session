import { randomUUID } from "node:crypto";
import { reportPrompt } from "./report-issue-adapter.ts";
import type { ReportKind, SendTargets } from "../shared/report-send.ts";

/**
 * Report a bug's Send (smart-session.report.send, and an agent's `report_send`): the person's words go to an agent,
 * or to a new agent in a workspace (docs/report-issue.md). This is the person's own message, sent only because they
 * pressed Send or asked an agent to hand it over; it is not one of Smart Compact's or Session Guard's messages.
 */
type Agent = { id: string; title?: string | null; provider: string; model?: string | null; status: string; workspaceId?: string | null; archivedAt?: string | null; internal?: boolean; labels?: Record<string, string>; createdAt?: string; lastUserMessageAt?: string | null };
type Workspace = { id: string; name?: string | null; title?: string | null; archivingAt?: string | null; internal?: boolean; background?: boolean };
export type ReportPaseo = {
  agents: { list(o?: unknown): Promise<{ entries: { agent: Agent }[] }>; ref(id: string): { send(text: string, o?: { messageId?: string }): Promise<void> } };
  workspaces: { list(o?: unknown): Promise<{ entries: Workspace[] }>; ref(id: string): { agents: { create(o: { config: { provider: string }; title?: string; prompt?: string }): Promise<{ id: string }> } } };
};
export type ReportSendInput = { kind: ReportKind; text: string; error?: string | null; agentId?: string; newAgentWorkspaceId?: string };
export type ReportSendResult = { agentId: string; title: string; started: boolean; queued?: boolean };

const workspaceTitle = (w: Workspace) => w.title || w.name || "Workspace";
const live = (a: Agent) => !a.archivedAt && !a.internal;

async function directory(paseo: ReportPaseo) {
  const [agents, workspaces] = await Promise.all([
    paseo.agents.list().then((r) => r.entries.map((e) => e.agent)).catch(() => [] as Agent[]),
    paseo.workspaces.list().then((r) => r.entries).catch(() => [] as Workspace[]),
  ]);
  return { agents, workspaces: workspaces.filter((w) => !w.archivingAt && !w.internal && !w.background) };
}

/**
 * Who the sheet can send to: the asking agent first, then this workspace's agents, then the most recent anywhere (at
 * most 6). The new agent starts in this workspace, else the picked agent's, else the first one.
 */
export async function reportTargets(paseo: ReportPaseo, at: { workspaceId?: string; agentId?: string }): Promise<SendTargets> {
  const { agents, workspaces } = await directory(paseo);
  const titles = new Map(workspaces.map((w) => [w.id, workspaceTitle(w)]));
  const last = (a: Agent) => Date.parse(a.lastUserMessageAt ?? a.createdAt ?? "") || 0;
  const rank = (a: Agent) => (a.id === at.agentId ? 4 : 0) + (at.workspaceId && a.workspaceId === at.workspaceId ? 2 : 0);
  const sorted = agents.filter(live).filter((a) => !a.workspaceId || titles.has(a.workspaceId)).sort((x, y) => rank(y) - rank(x) || last(y) - last(x)).slice(0, 6);
  const rows = sorted.map((a) => ({ id: a.id, title: a.title || "Untitled agent", provider: a.provider, status: a.status, workspaceId: a.workspaceId ?? null, workspaceTitle: a.workspaceId ? titles.get(a.workspaceId) ?? null : null, main: false }));
  const hereId = (at.workspaceId && titles.has(at.workspaceId) ? at.workspaceId : null) ?? rows[0]?.workspaceId ?? workspaces[0]?.id ?? null;
  return { agents: rows, defaultId: rows[0]?.id ?? null, newAgentWorkspace: hereId ? { id: hereId, title: titles.get(hereId) ?? "Workspace" } : null, newWorkspace: null };
}

export const agentTitleFor = (kind: ReportKind) => kind === "bug" ? "Report a Smart Session bug" : kind === "feature" ? "Smart Session feature request" : "Smart Session feedback";

export async function sendReport(paseo: ReportPaseo, input: ReportSendInput): Promise<ReportSendResult> {
  const { kind, text, error, agentId, newAgentWorkspaceId } = input;
  if (!!agentId === !!newAgentWorkspaceId) throw new Error("Pick one target: an agent, or a workspace to start a new agent in.");
  if (!text.trim() && !error?.trim()) throw new Error("Say what happened first.");
  const prompt = reportPrompt(kind, text, error);
  const { agents } = await directory(paseo);
  if (agentId) {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent || !live(agent)) throw new Error("That agent isn't available any more. Pick another one.");
    await paseo.agents.ref(agentId).send(prompt, { messageId: randomUUID() });
    return { agentId, title: agent.title || "the agent", started: false };
  }
  // A new agent runs on the provider and model of the workspace's most recent agent, else Claude Code's default.
  const like = agents.filter((a) => live(a) && a.workspaceId === newAgentWorkspaceId).sort((x, y) => (Date.parse(y.createdAt ?? "") || 0) - (Date.parse(x.createdAt ?? "") || 0))[0];
  const provider = like ? (like.model ? `${like.provider}/${like.model}` : like.provider) : "claude";
  const title = agentTitleFor(kind);
  const created = await paseo.workspaces.ref(newAgentWorkspaceId!).agents.create({ config: { provider }, title, prompt });
  return { agentId: created.id, title, started: true };
}
