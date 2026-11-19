/**
 * Report a bug (docs/report-issue.md): the RPCs behind the agent tools `report_issue` and `report_send` and the
 * Report a bug sheet (client/report-issue.tsx). The sheet files nothing itself: it hands the person's words to an
 * agent, which runs `report_issue` (server/report-issue/, vendored from paseo-plugin-kit) and shows the exact issue
 * before filing it.
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const REPORT_REPO = "tomgrin10/paseo-smart-session";
/** The tool's name as agents see it natively (`mcp.mjs` drops the prefix). */
export const REPORT_TOOL = "smart_report_issue";

const kind = z.enum(["bug", "feature", "feedback"]);
const id = z.string().min(1).max(200);

/** One `report_issue` call. `agentId` is the caller, from the tool's transport, never from the model's arguments. */
export const reportIssueRpc = defineRpc({
  name: "smart-session.report.issue",
  input: z.object({ agentId: id, input: z.record(z.string(), z.unknown()) }),
  output: z.record(z.string(), z.unknown()),
});

const target = z.object({ id: z.string(), title: z.string(), provider: z.string(), status: z.string(), workspaceId: z.string().nullable(), workspaceTitle: z.string().nullable(), main: z.boolean() });
/** Who the sheet (or `report_send`) can hand a report to. Metadata only; no agent is loaded or woken. */
export const reportTargetsRpc = defineRpc({
  name: "smart-session.report.targets",
  input: z.object({ workspaceId: id.optional(), agentId: id.optional() }),
  output: z.object({ agents: z.array(target), defaultId: z.string().nullable(), newAgentWorkspace: z.object({ id: z.string(), title: z.string() }).nullable(), newWorkspace: z.object({ projectId: z.string(), title: z.string() }).nullable().optional() }),
});

/** Send: the person's words to one agent, or to a new agent in a workspace. Exactly one target. */
export const reportSendRpc = defineRpc({
  name: "smart-session.report.send",
  input: z.object({ kind, text: z.string().max(8000), error: z.string().max(2000).nullable().optional(), agentId: id.optional(), newAgentWorkspaceId: id.optional() }),
  output: z.object({ agentId: z.string(), title: z.string(), started: z.boolean(), queued: z.boolean().optional() }),
});

/** Open on GitHub, when there's no agent to send to: a prefilled new-issue link with the redacted versions block. */
export const reportLinkRpc = defineRpc({
  name: "smart-session.report.link",
  input: z.object({ kind, text: z.string().max(8000) }),
  output: z.object({ url: z.string() }),
});
