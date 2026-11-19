/**
 * Report an issue's Send to (client/report-issue.tsx, docs/report-issue.md): who the developer's words can go to,
 * in the order the picker draws them, and the title a report's new workspace gets.
 *
 * The same picker as Follow-up's sheet: the "new" rows come first and are pinned above the scrolling agent list, so a
 * phone reaches them without scrolling. The default pick is the best agent, else a new agent in this workspace; a new
 * workspace is never picked for the developer.
 */
export type ReportKind = "bug" | "feature" | "feedback";
export type SendTarget = { id: string; title: string; provider: string; status: string; workspaceId: string | null; workspaceTitle: string | null; main: boolean };
export type SendTargets = {
  agents: SendTarget[];
  defaultId: string | null;
  newAgentWorkspace: { id: string; title: string } | null;
  /** The project a new workspace would start in; absent from servers before 2.1. */
  newWorkspace?: { projectId: string; title: string } | null;
};
export type PickerRow = { id: string; lines: [string, string]; provider: string | null; mark: "workspace" | "agent" | null };

export const NEW_AGENT = "new";
/**
 * The agent list's height on desktop: about three and a half rows (52 each), so it's clear the list scrolls; the new
 * rows sit above it, pinned. On phones the list doesn't scroll by itself (`pickerScrolls`): a Paseo bottom sheet
 * coordinates one scrollable, its body, and a second one inside it would fight the sheet for the pan gesture. There the
 * whole sheet scrolls, and the new rows come first.
 */
export const PICKER_MAX = (compact: boolean) => Math.round((compact ? 54 : 52) * 3.5);
export const pickerScrolls = (compact: boolean) => !compact;
export const NEW_WORKSPACE = "new-workspace";
/** The word a kind goes by in the sheet (its segmented control) and in a new workspace's title. */
export const KIND_WORD: Record<ReportKind, string> = { bug: "Bug", feature: "Idea", feedback: "Feedback" };
export const WORKSPACE_TITLE_MAX = 60;

/** "Billing retries · main agent", "Claude Code · idle". */
export function targetLines(t: SendTarget): [string, string] {
  const provider = t.provider === "claude" ? "Claude Code" : t.provider === "codex" ? "Codex" : t.provider;
  const head = t.workspaceTitle ? `${t.workspaceTitle} · ${t.main ? "main agent" : t.title}` : t.title;
  return [head, `${provider} · ${t.status === "running" ? "working" : t.status}`];
}

export function newWorkspaceLines(project: string): [string, string] { return ["A new workspace", `In ${project}, with the default model`]; }
export function newAgentLines(workspace: string | null | undefined): [string, string] { return [workspace ? `A new agent in ${workspace}` : "A new agent", "Starts there, with the default model"]; }

/** The picker's rows: `pinned` (new workspace, then new agent) above the scrolling `agents`. */
export function pickerRows(t: SendTargets): { pinned: PickerRow[]; agents: PickerRow[] } {
  const pinned: PickerRow[] = [];
  if (t.newWorkspace) pinned.push({ id: NEW_WORKSPACE, lines: newWorkspaceLines(t.newWorkspace.title), provider: null, mark: "workspace" });
  if (t.newAgentWorkspace) pinned.push({ id: NEW_AGENT, lines: newAgentLines(t.newAgentWorkspace.title), provider: null, mark: "agent" });
  return { pinned, agents: t.agents.map(a => ({ id: a.id, lines: targetLines(a), provider: a.provider, mark: null })) };
}

/** What Send goes to before the developer picks: today's rule, unchanged. */
export function defaultChoice(t: SendTargets): string | null { return t.defaultId ?? (t.newAgentWorkspace ? NEW_AGENT : null); }

/**
 * A report's new workspace: "<Kind>: <first words>", at most 60 characters, cut at a word with "…". The words are the
 * first line's first sentence of what the developer typed, or of the error when they typed nothing. No AI call.
 */
export function reportWorkspaceTitle(kind: ReportKind, text: string, error?: string | null): string {
  const word = KIND_WORD[kind];
  const source = (text.trim() ? text : error ?? "").split("\n").map(l => l.trim()).find(Boolean) ?? "";
  const sentence = source.replace(/\s+/g, " ").split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, "").trim();
  if (!sentence) return `${word} report`;
  const prefix = `${word}: `;
  const room = WORKSPACE_TITLE_MAX - prefix.length;
  if (sentence.length <= room) return prefix + sentence;
  const cut = sentence.slice(0, room - 1);
  const space = cut.lastIndexOf(" ");
  const words = (space > room / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.!?-]+$/, "");
  return `${prefix}${words}…`;
}
