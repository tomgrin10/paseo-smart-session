import { execFile } from "node:child_process";
import { Reporter, environment, manualIssueLink, type Diagnostics, type DiagnosticsSection, type RedactionContext, type ReportGithub, type ReportKind, type ReportPluginConfig } from "./report-issue/index.ts";
import type { LogRing } from "./report-issue/diagnostics.ts";
import { REPORT_REPO, REPORT_TOOL } from "../shared/report-issue.ts";
import { PLUGIN_VERSION } from "../shared/version.ts";

/**
 * Smart Session's adapter for the shared Report-an-issue module (server/report-issue/, vendored from paseo-plugin-kit;
 * docs/report-issue.md): its repository, its tool name, and what it knows about itself for the diagnostics block and
 * for redaction. Everything here is read only while a report is being prepared; nothing runs in the background.
 *
 * Never put a name or an email in a diagnostics row: accounts are a count, Session Guard is on/off, hooks are a count.
 * The module redacts every row again anyway (tokens, emails, IPs, the hostname, home paths, private repositories).
 */
export type SmartSessionReportDeps = {
  /** This plugin's RPC handlers, in-process (settings, guard status, subscriptions, install). Best effort. */
  call: (method: string, input?: unknown) => Promise<unknown>;
  /** Workspaces and agents Paseo knows, for redaction (their titles and git remotes). Metadata only. */
  directory: () => Promise<{ workspaces: { name?: string | null; title?: string | null; projectDisplayName?: string | null; projectRootPath?: string | null }[]; agentTitles: string[] }>;
  logs: LogRing;
  startedAt: number;
  github?: ReportGithub;
  /** `git remote get-url origin` in a directory (tests inject one). */
  remote?: (dir: string) => Promise<string | null>;
  now?: () => number;
};

type GhRun = (args: string[], stdin?: string) => Promise<{ stdout: string; code: number | null }>;
const ghRun: GhRun = (args, stdin) => new Promise((resolve, reject) => {
  const child = execFile("gh", args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }, (error, stdout) => {
    // ENOENT (no gh) or a kill: no answer at all. An HTTP error still has its headers on stdout.
    if (error && (!stdout || typeof (error as NodeJS.ErrnoException).code === "string")) reject(error);
    else resolve({ stdout: String(stdout ?? ""), code: error ? (error as { code?: number }).code ?? 1 : 0 });
  });
  if (stdin !== undefined) child.stdin?.end(stdin); else child.stdin?.end();
});

/**
 * The person's own GitHub through `gh api` (their sign-in; no token is read or stored here). `--include` puts the
 * status line first, so any HTTP status resolves; no `gh`, or no sign-in, rejects, which the module reads as "no auth"
 * and answers with a prefilled link instead.
 */
export function ghApi(run: GhRun = ghRun): ReportGithub {
  return {
    async request(method, path, body) {
      const args = ["api", "--include", "--method", method, "-H", "Accept: application/vnd.github+json", path];
      if (body !== undefined) args.push("--input", "-");
      const { stdout } = await run(args, body === undefined ? undefined : JSON.stringify(body));
      const status = Number(/^HTTP\/[\d.]+ (\d{3})/m.exec(stdout)?.[1]);
      if (!status) throw new Error("gh api gave no HTTP status (is gh signed in?)");
      const at = stdout.search(/\r?\n\r?\n/);
      const text = at < 0 ? "" : stdout.slice(at).trim();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { status, data };
    },
  };
}

const gitRemote = (dir: string) => new Promise<string | null>((resolve) => {
  execFile("git", ["-C", dir, "remote", "get-url", "origin"], { timeout: 3_000 }, (error, stdout) => resolve(error ? null : String(stdout).trim() || null));
});
/** owner/name from a GitHub remote URL (https or ssh). */
export function githubRepo(url: string | null): string | null {
  const m = url ? /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url) : null;
  return m ? `${m[1]}/${m[2]}` : null;
}

const onOff = (v: unknown) => v === true ? "on" : v === false ? "off" : "unknown";
const ago = (ms: number) => { const m = Math.round(ms / 60_000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };

type SettingsView = { settings?: { enabled?: boolean; showPill?: boolean; autoEnrol?: boolean; installHooks?: boolean; publishAsMain?: boolean; shedHistory?: boolean }; enrolledAgents?: number };
type GuardView = { governor?: { state?: string }; standalone?: boolean | null; pauses?: { phase?: string }[]; policy?: { enabled?: boolean; retryTransientErrors?: boolean; thresholdPct?: number } };
type SubscriptionsView = { zerosub?: boolean; autoSwitch?: boolean; accounts?: { family?: string }[] };
type BudgetView = { recorder?: { ageSeconds?: number | null; source?: string | null }; error?: string | null };
type InstallView = { report?: { hooks?: string[]; mcp?: string; error?: string | null } };

function versionsSection(): DiagnosticsSection {
  return { title: "Versions and install", level: "versions", rows: [["Smart Session", PLUGIN_VERSION]] };
}

/** Smart Session's own state: switches, counts and health. Never a name, an email or a path. */
export async function stateSection(d: SmartSessionReportDeps): Promise<DiagnosticsSection> {
  const now = (d.now ?? Date.now)();
  const read = <T,>(method: string): Promise<T | null> => d.call(method, {}).then((v) => v as T).catch(() => null);
  const [settings, guard, subs, budget, install] = await Promise.all([
    read<SettingsView>("smart-session.settings.get"), read<GuardView>("smart-session.guard.status"), read<SubscriptionsView>("smart-session.subscriptions"),
    read<BudgetView>("smart-session.budget"), read<InstallView>("smart-session.install.status"),
  ]);
  const rows: [string, string][] = [];
  const s = settings?.settings;
  if (s) {
    rows.push(["Smart Compact", `${onOff(s.enabled)} · pill: ${onOff(s.showPill)} · checkpoint enrols: ${onOff(s.autoEnrol)} · enrolled sessions: ${settings?.enrolledAgents ?? "?"}`]);
    rows.push(["Other features", `Claude Code hooks: ${onOff(s.installHooks)} · publish as main account: ${onOff(s.publishAsMain)} · move old history aside: ${onOff(s.shedHistory)}`]);
  }
  if (guard?.policy) {
    const pending = (guard.pauses ?? []).filter((p) => ["pausing", "waiting", "resuming", "attention"].includes(String(p.phase))).length;
    rows.push(["Pause at the limit (Session Guard)", `${onOff(guard.policy.enabled)} · threshold ${guard.policy.thresholdPct ?? "?"} % · retry after API errors: ${onOff(guard.policy.retryTransientErrors)} · governor: ${guard.governor?.state ?? "unknown"} · pending pauses: ${pending}${guard.standalone ? " · standalone Session Guard enabled" : ""}`]);
  }
  if (subs) {
    const claude = (subs.accounts ?? []).filter((a) => a.family === "claude").length;
    const codex = (subs.accounts ?? []).filter((a) => a.family === "codex").length;
    rows.push(["Accounts", subs.zerosub ? `ZeroSub: ${claude} Claude, ${codex} Codex · auto-switch: ${onOff(subs.autoSwitch)}` : "no ZeroSub (the CLI login only)"]);
  }
  if (budget) {
    const age = budget.recorder?.ageSeconds;
    rows.push(["Usage source", budget.error ? `error: ${budget.error}` : `newest reading ${age == null ? "none" : `${ago(age * 1000)} old`} (${budget.recorder?.source ?? "no source"})`]);
  }
  if (install?.report) rows.push(["Claude Code integration", `${install.report.hooks?.length ?? 0} hooks · MCP: ${install.report.mcp ?? "?"}${install.report.error ? ` · error: ${install.report.error}` : ""}`]);
  rows.push(["Worker", `up ${ago(now - d.startedAt)} · RSS ${Math.round(process.memoryUsage().rss / 1_048_576)} MB`]);
  return { title: "Smart Session state", level: "state", rows };
}

/** Names Smart Session can see that may be private: workspace, project and agent titles, and GitHub repositories. */
export async function redaction(d: SmartSessionReportDeps): Promise<RedactionContext> {
  const dir = await d.directory().catch(() => ({ workspaces: [], agentTitles: [] }));
  const titles = new Set<string>();
  for (const w of dir.workspaces) for (const t of [w.name, w.title, w.projectDisplayName]) if (t) titles.add(t);
  for (const t of dir.agentTitles) titles.add(t);
  const roots = [...new Set(dir.workspaces.map((w) => w.projectRootPath).filter((p): p is string => !!p))].slice(0, 30);
  const remote = d.remote ?? gitRemote;
  const repos = (await Promise.all(roots.map((r) => remote(r).catch(() => null)))).map(githubRepo).filter((r): r is string => !!r);
  return { privateRepos: [...new Set(repos)], privateTitles: [...titles] };
}

export function smartSessionReportConfig(d: SmartSessionReportDeps): ReportPluginConfig {
  return {
    name: "Smart Session", repo: REPORT_REPO, toolName: REPORT_TOOL, assetsFolder: "smart-session",
    github: d.github ?? ghApi(),
    diagnostics: async (): Promise<Diagnostics> => {
      const [env, state] = await Promise.all([environment({ clis: [["Paseo CLI", "paseo", ["--version"]], ["Claude Code", "claude", ["--version"]], ["Codex", "codex", ["--version"]]] }), stateSection(d)]);
      return { sections: [versionsSection(), env, state], logs: d.logs.recent(20) };
    },
    redaction: () => redaction(d),
    now: d.now,
  };
}

export function smartSessionReporter(d: SmartSessionReportDeps) {
  const config = smartSessionReportConfig(d);
  const reporter = new Reporter(config);
  return {
    reporter,
    /** The sheet's Open on GitHub (no agent to send to): a prefilled link with the redacted versions block. */
    manualLink: (kind: ReportKind, text: string) => manualIssueLink({ ...config, diagnostics: async () => ({ sections: [versionsSection(), await environment({ clis: [] })] }) }, kind, text),
  };
}

/** What the sheet (or `report_send`) sends to the agent it picked. The words name the tool so the agent takes it from there. */
export function reportPrompt(kind: ReportKind, text: string, error?: string | null): string {
  const what = kind === "bug" ? "a bug" : kind === "feature" ? "a feature request" : "feedback";
  return [
    `Report ${what} about Smart Session for me: ${text.trim() || "(I'll describe it when you ask.)"}`,
    ...(error ? [``, `The error I saw: ${error.trim()}`] : []),
    ``,
    `Use the ${REPORT_TOOL} tool (call it with kind="${kind}" and a one-line summary first; it returns the steps). Ask me for anything it needs, and show me the exact issue before filing it.`,
  ].join("\n");
}
