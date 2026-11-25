import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AGENT_SCOPED, REPORT_DESCRIPTION, agentTools } from "./server/agent-tools.mjs";
import { ghApi, githubRepo, reportPrompt, smartSessionReportConfig, stateSection, type SmartSessionReportDeps } from "./server/report-issue-adapter.ts";
import { LogRing } from "./server/report-issue/diagnostics.ts";
import { MAX_DESCRIPTION, Reporter, reportInputSchema, reportToolDescription } from "./server/report-issue/index.ts";
import { Redactor } from "./server/report-issue/redact.ts";
import { reportTargets, sendReport, type ReportPaseo } from "./server/report-send.ts";
import { REPORT_REPO } from "./shared/report-issue.ts";

/**
 * Report a bug (docs/report-issue.md). The module (server/report-issue/) is vendored from paseo-plugin-kit and tested
 * there; `npm run check` fails when the copy differs. These cover Smart Session's side: its diagnostics carry no
 * identifiers (invariant `report-issue-never-carries-secrets`), its tools, and its Send.
 */

const ALICE = "alice@example.com";

/** Smart Session's RPCs as the adapter reads them, with an account named by its email (ZeroSub can do that). */
function deps(extra: Partial<SmartSessionReportDeps> = {}): SmartSessionReportDeps {
  const answers: Record<string, unknown> = {
    "smart-session.settings.get": { settings: { enabled: true, showPill: true, autoEnrol: false, installHooks: true, publishAsMain: false }, enrolledAgents: 3 },
    "smart-session.guard.status": { governor: { state: "active" }, standalone: false, pauses: [{ phase: "waiting" }, { phase: "done" }], policy: { enabled: true, retryTransientErrors: true, thresholdPct: 95 } },
    "smart-session.subscriptions": { zerosub: true, autoSwitch: true, accounts: [{ id: "a1", family: "claude", name: ALICE }, { id: "a2", family: "claude", name: "Account 2" }, { id: "c1", family: "codex", name: "bob@example.com" }] },
    "smart-session.budget": { recorder: { ageSeconds: 120, source: "statusline" }, error: null },
    "smart-session.install.status": { report: { hooks: ["Stop", "PostToolUse"], mcp: "session", error: null } },
  };
  const logs = new LogRing(40, () => new Date("2026-11-12T10:00:00Z"));
  logs.push("warn", `could not read ${homedir()}/.paseo/plugin-data/smart-session/usage-2026-11.jsonl on ${hostname()}`);
  logs.push("error", `ZeroSub account ${ALICE} refused the reading for acme/app`);
  return {
    call: async (method) => { if (!(method in answers)) throw new Error(`no ${method}`); return answers[method]; },
    directory: async () => ({ workspaces: [{ name: "Billing retries", projectDisplayName: "app", projectRootPath: "/work/app" }], agentTitles: ["Fix the checkout flow"] }),
    remote: async (dir) => (dir === "/work/app" ? "git@github.com:acme/app.git" : null),
    logs,
    startedAt: Date.parse("2026-11-12T08:00:00Z"),
    now: () => Date.parse("2026-11-12T10:00:00Z"),
    github: { request: async (method, path) => (method === "GET" && path === "user" ? { status: 401, data: {} } : { status: 404, data: {} }) },
    ...extra,
  };
}

test("report-issue-never-carries-secrets: Smart Session's state rows name no account, only counts and switches", async () => {
  const section = await stateSection(deps());
  const text = JSON.stringify(section.rows);
  assert.ok(!text.includes(ALICE) && !text.includes("bob@example.com") && !text.includes("Account 2"), text);
  const row = (label: string) => section.rows.find(([k]) => k === label)?.[1];
  assert.equal(row("Accounts"), "ZeroSub: 2 Claude, 1 Codex · auto-switch: on");
  assert.match(row("Pause at the limit (Session Guard)")!, /^on · threshold 95 % · retry after API errors: on · governor: active · pending pauses: 1$/);
  assert.match(row("Smart Compact")!, /^on · pill: on · checkpoint enrols: off · enrolled sessions: 3$/);
  assert.match(row("Usage source")!, /2m old \(statusline\)/);
});

test("report-issue-never-carries-secrets: the dry run of a Smart Session bug strips emails, the hostname, home and private repos", async () => {
  const reporter = new Reporter(smartSessionReportConfig(deps()));
  const dry = await reporter.run("agent-1", { kind: "bug", fields: {
    title: "Session Guard held acme/app after the reset",
    what_happened: `The pill stayed amber; ZeroSub showed ${ALICE}. Logs in ${homedir()}/.paseo on ${hostname()}.`,
    steps: ["Turn on Pause at the limit", "Hit the 5-hour limit"], expected: "It continues after the reset.", actual: "It stays held.",
    findings: "smart_budget_status said the window reset; Billing retries workspace, agent Fix the checkout flow.",
  } });
  assert.equal(dry.stage, "dry_run");
  const body = `${dry.title}\n${dry.body}`;
  for (const leak of [ALICE, "bob@example.com", hostname(), homedir(), "acme/app", "Billing retries", "Fix the checkout flow"]) assert.ok(!body.includes(leak), `${leak} leaked`);
  assert.ok(body.includes("<email>"), "the email became <email>");
  assert.ok(body.includes("repo-1"), "the private repository became repo-1");
  assert.match(String(dry.body), /\| Smart Session \| \d+\.\d+\.\d+/);
  assert.match(String(dry.body), /Recent warnings and errors/);
  assert.match(String(dry.redacted), /email/);
  // Without a GitHub sign-in, confirm hands back a prefilled link to Smart Session's repository and posts nothing.
  const out = await reporter.run("agent-1", { confirm: true, planId: dry.planId });
  assert.equal(out.filed, false);
  assert.ok(String(out.url).startsWith(`https://github.com/${REPORT_REPO}/issues/new?`));
});

test("report-issue-never-carries-secrets: the vendored Redactor turns an account email into <email>", () => {
  assert.equal(new Redactor({}).text(`account ${ALICE} at 100%`), "account <email> at 100%");
});

test("report-issue-costs-no-standing-context: report_issue is one short line, the kit's own words", () => {
  assert.equal(REPORT_DESCRIPTION, reportToolDescription("Smart Session"));
  assert.ok(REPORT_DESCRIPTION.length <= MAX_DESCRIPTION);
  const tools = agentTools({ agentId: "a", call: async () => ({}) });
  assert.ok(tools.report_send.description.length <= MAX_DESCRIPTION, tools.report_send.description);
  assert.deepEqual(Object.keys((tools.report_issue.inputSchema as { properties: object }).properties).sort(), Object.keys(reportInputSchema.shape).sort());
  // Nothing else an agent always sees mentions reporting: hooks, their libraries, the stdio server's instructions.
  for (const dir of ["hooks", "server/hooklib"]) for (const f of readdirSync(dir).filter((f) => f.endsWith(".mjs"))) {
    assert.ok(!/report_issue|report (a|an) (bug|issue)/i.test(readFileSync(join(dir, f), "utf8")), `${dir}/${f} talks about reporting`);
  }
  assert.ok(AGENT_SCOPED.has("report_issue") && AGENT_SCOPED.has("report_send"), "both need the caller's agent id");
});

test("report_issue passes the caller from the transport, never from the arguments, and names itself per transport", async () => {
  const calls: [string, unknown][] = [];
  const call = async (method: string, input: unknown) => { calls.push([method, input]); return { stage: "procedure", next: "call smart_report_issue again" }; };
  const stdio = await agentTools({ agentId: "agent-7", call }).report_issue.run({ kind: "bug", summary: "pill" });
  assert.deepEqual(calls[0], ["smart-session.report.issue", { agentId: "agent-7", input: { kind: "bug", summary: "pill" } }]);
  assert.match(stdio, /call report_issue again/);
  const native = await agentTools({ agentId: "agent-7", call, native: true }).report_issue.run({ kind: "bug" });
  assert.match(native, /call smart_report_issue again/);
});

function fakePaseo() {
  const sent: { agentId: string; text: string }[] = [];
  const created: { workspaceId: string; config: { provider: string }; title?: string; prompt?: string }[] = [];
  const agents = [
    { id: "me", title: "Overview polish", provider: "claude", model: "opus", status: "running", workspaceId: "w1", createdAt: "2026-11-12T09:00:00Z", lastUserMessageAt: "2026-11-12T09:50:00Z" },
    { id: "other", title: "Docs pass", provider: "codex", model: null, status: "idle", workspaceId: "w1", createdAt: "2026-11-12T08:00:00Z", lastUserMessageAt: "2026-11-12T09:00:00Z" },
    { id: "gone", title: "Old", provider: "claude", status: "idle", workspaceId: "w1", archivedAt: "2026-11-11T00:00:00Z" },
  ];
  const paseo: ReportPaseo = {
    agents: { list: async () => ({ entries: agents.map((agent) => ({ agent })) }), ref: (id) => ({ send: async (text) => { sent.push({ agentId: id, text }); } }) },
    workspaces: { list: async () => ({ entries: [{ id: "w1", name: "acme" }] }), ref: (workspaceId) => ({ agents: { create: async (o) => { created.push({ workspaceId, ...o }); return { id: "new-1" }; } } }) },
  };
  return { paseo, sent, created };
}

test("Send: the person's words go to the picked agent, or start a new one in the workspace with the tool named", async () => {
  const f = fakePaseo();
  const targets = await reportTargets(f.paseo, { agentId: "other", workspaceId: "w1" });
  assert.deepEqual(targets.agents.map((a) => a.id), ["other", "me"], "the asking agent first; archived agents never");
  assert.deepEqual(targets.newAgentWorkspace, { id: "w1", title: "acme" });
  const one = await sendReport(f.paseo, { kind: "bug", text: "The pill stays amber", agentId: "other" });
  assert.deepEqual(one, { agentId: "other", title: "Docs pass", started: false });
  assert.equal(f.sent[0].text, reportPrompt("bug", "The pill stays amber"));
  assert.match(f.sent[0].text, /smart_report_issue/);
  const started = await sendReport(f.paseo, { kind: "feature", text: "Show the reset in the sidebar", newAgentWorkspaceId: "w1" });
  assert.deepEqual(started, { agentId: "new-1", title: "Smart Session feature request", started: true });
  assert.equal(f.created[0].config.provider, "claude/opus", "the workspace's most recent agent's provider and model");
  await assert.rejects(sendReport(f.paseo, { kind: "bug", text: "x" }), /one target/);
  await assert.rejects(sendReport(f.paseo, { kind: "bug", text: "x", agentId: "gone" }), /isn't available/);
  await assert.rejects(sendReport(f.paseo, { kind: "bug", text: "  ", agentId: "other" }), /what happened/);
});

test("agent parity: report_send lists targets, refuses itself, and sends like the sheet", async () => {
  const f = fakePaseo();
  const call = async (method: string, input: any) => method === "smart-session.report.targets" ? reportTargets(f.paseo, input) : sendReport(f.paseo, input);
  const tool = agentTools({ agentId: "me", call }).report_send;
  const list = await tool.run({});
  assert.match(list, /agentId other: acme · Docs pass/);
  assert.ok(!/agentId me:/.test(list), "never offers itself");
  assert.match(list, /Nothing was sent/);
  assert.match(await tool.run({ agentId: "me", text: "x" }), /That's you/);
  assert.match(await tool.run({ agentId: "other", text: "Pill stays amber", kind: "bug" }), /^Sent to Docs pass/);
  assert.equal(f.sent.length, 1);
});

test("gh api: the status line and JSON body are read; no status means no auth", async () => {
  const seen: string[][] = [];
  const api = ghApi(async (args, stdin) => { seen.push([...args, stdin ?? ""]); return { stdout: "HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n{\"number\":7,\"html_url\":\"https://github.com/x/y/issues/7\"}", code: 0 }; });
  assert.deepEqual(await api.request("POST", "repos/x/y/issues", { title: "t" }), { status: 201, data: { number: 7, html_url: "https://github.com/x/y/issues/7" } });
  assert.deepEqual(seen[0], ["api", "--include", "--method", "POST", "-H", "Accept: application/vnd.github+json", "repos/x/y/issues", "--input", "-", "{\"title\":\"t\"}"]);
  const notFound = ghApi(async () => ({ stdout: "HTTP/2.0 404 Not Found\n\n{\"message\":\"Not Found\"}", code: 1 }));
  assert.equal((await notFound.request("GET", "repos/x/y")).status, 404);
  await assert.rejects(ghApi(async () => ({ stdout: "To get started with GitHub CLI, please run: gh auth login", code: 4 })).request("GET", "user"), /no HTTP status/);
});

test("githubRepo reads owner/name from https and ssh remotes only on github.com", () => {
  assert.equal(githubRepo("git@github.com:acme/app.git"), "acme/app");
  assert.equal(githubRepo("https://github.com/acme/app"), "acme/app");
  assert.equal(githubRepo("https://gitlab.com/acme/app.git"), null);
  assert.equal(githubRepo(null), null);
});
