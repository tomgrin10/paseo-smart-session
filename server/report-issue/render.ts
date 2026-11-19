// Vendored from paseo-plugin-kit v0.3.0 (report-issue/render.ts). Do not edit; change the kit and run `paseo-kit vendor report-issue <dir>`.
/**
 * The issue's shape: which fields each kind needs, the body template, the diagnostics block, and the prefilled
 * "new issue" link for reporters without GitHub auth. Pure: everything here is already redacted by the caller.
 */
export const REPORT_KINDS = ["bug", "feature", "feedback"] as const;
export type ReportKind = typeof REPORT_KINDS[number];

export type ReportFields = {
  title?: string;
  what_happened?: string;
  steps?: string[] | string;
  expected?: string;
  actual?: string;
  problem?: string;
  proposal?: string;
  alternatives?: string;
  feedback?: string;
  context?: string;
  findings?: string;
};

export type Screenshot = { path: string; description: string };

/** One diagnostics table. `level` decides which kinds carry it: a bug carries everything, feedback only versions. */
export type DiagnosticsSection = { title: string; level: "versions" | "environment" | "state"; rows: [string, string][] };
export type Diagnostics = { sections: DiagnosticsSection[]; logs?: string[] };

const LEVELS: Record<ReportKind, readonly DiagnosticsSection["level"][]> = {
  bug: ["versions", "environment", "state"],
  feature: ["versions", "environment"],
  feedback: ["versions"],
};

/** Required per kind, in the order the developer is asked. Refused with this list when any is missing. */
export const REQUIRED: Record<ReportKind, readonly (keyof ReportFields)[]> = {
  bug: ["title", "what_happened", "steps", "expected", "actual"],
  feature: ["title", "problem", "proposal"],
  feedback: ["title", "feedback"],
};
/** Asked for but not required: the issue reads worse without them. */
export const RECOMMENDED: Record<ReportKind, readonly (keyof ReportFields)[]> = {
  bug: ["findings"],
  feature: ["alternatives"],
  feedback: ["context"],
};

export const FIELD_HELP: Record<keyof ReportFields, string> = {
  title: "one line a maintainer can scan (≤ 90 chars), what's wrong or wanted, not \"Bug\"",
  what_happened: "what the developer saw, in their words, with any exact error text",
  steps: "numbered steps from a clean start that make it happen (array of strings)",
  expected: "what should have happened",
  actual: "what happened instead",
  problem: "the problem or need behind the request",
  proposal: "what the developer would like the plugin to do",
  alternatives: "workarounds or alternatives considered",
  feedback: "the feedback itself",
  context: "what the developer was doing, how they use the plugin",
  findings: "what you inspected or reproduced yourself: tool results, logs, files, a guess at the cause",
};

const LABELS: Record<ReportKind, string> = { bug: "bug", feature: "enhancement", feedback: "feedback" };
export const AGENT_LABEL = "via-agent";
export const labelsFor = (kind: ReportKind) => [LABELS[kind], AGENT_LABEL];

const present = (v: unknown) => Array.isArray(v) ? v.some(s => typeof s === "string" && s.trim()) : typeof v === "string" && v.trim().length > 0;
export function missingFields(kind: ReportKind, fields: ReportFields) {
  return { required: REQUIRED[kind].filter(f => !present(fields[f])), recommended: RECOMMENDED[kind].filter(f => !present(fields[f])) };
}

function stepsList(steps: string[] | string | undefined): string {
  const list = Array.isArray(steps) ? steps : (steps ?? "").split(/\n+/);
  return list.map(s => s.trim().replace(/^\d+[.)]\s*/, "")).filter(Boolean).map((s, i) => `${i + 1}. ${s}`).join("\n");
}

/** A markdown table cell: no pipes or newlines. */
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function renderDiagnostics(kind: ReportKind, d: Diagnostics, opts: { plugin: string; open?: boolean } = { plugin: "the plugin" }): string {
  const sections = d.sections.filter(s => LEVELS[kind].includes(s.level) && s.rows.length);
  if (!sections.length) return "";
  const parts = sections.map(s => `**${s.title}**\n\n| | |\n| --- | --- |\n${s.rows.map(([k, v]) => `| ${cell(k)} | ${cell(v)} |`).join("\n")}`);
  if (kind === "bug" && d.logs?.length) parts.push(`**Recent warnings and errors** (last ${d.logs.length}, oldest first)\n\n\`\`\`\n${d.logs.join("\n").replace(/```/g, "'''")}\n\`\`\``);
  return `<details${opts.open ? " open" : ""}>\n<summary>Diagnostics (collected by ${opts.plugin}, private names removed)</summary>\n\n${parts.join("\n\n")}\n\n</details>`;
}

/** Where each screenshot goes in the body: an image once uploaded, else a note to drag it in. */
export type ScreenshotSlot = { description: string; url?: string | null };

export function renderBody(kind: ReportKind, f: ReportFields, o: { plugin: string; diagnostics: string; screenshots?: ScreenshotSlot[]; comment?: boolean }): string {
  const out: string[] = [];
  out.push(o.comment
    ? `> More detail from another ${o.plugin} user, added by their agent with their review and OK. Private names are replaced with placeholders (repo-1, PR-1).`
    : `> Filed by an agent for a ${o.plugin} user, with their review and OK. Private names are replaced with placeholders (repo-1, PR-1).`);
  const section = (title: string, text?: string) => { if (text?.trim()) out.push(`### ${title}\n\n${text.trim()}`); };
  if (kind === "bug") {
    section("What happened", f.what_happened);
    section("Steps to reproduce", stepsList(f.steps));
    section("Expected", f.expected);
    section("Actual", f.actual);
  } else if (kind === "feature") {
    section("The problem", f.problem);
    section("What I'd like", f.proposal);
    section("Alternatives considered", f.alternatives);
  } else {
    section("Feedback", f.feedback);
    section("Context", f.context);
  }
  section("What the agent checked", f.findings);
  if (o.screenshots?.length) {
    out.push(`### Screenshots\n\n${o.screenshots.map((s, i) => {
      const text = s.description.trim();
      const head = `${i + 1}. ${text}`;
      return s.url ? `${head}\n   ![${text.replace(/[[\]]/g, "").slice(0, 120)}](${s.url})` : `${head}\n   _(image to be attached by the reporter)_`;
    }).join("\n")}`);
  }
  if (o.diagnostics) out.push(o.diagnostics);
  return out.join("\n\n") + "\n";
}

/** GitHub's prefilled new-issue link. The body is cut to fit a safe URL length, with a note to paste the rest. */
export const URL_LIMIT = 7_500;
export function newIssueUrl(repo: string, title: string, body: string, labels: string[], limit = URL_LIMIT): { url: string; trimmed: boolean } {
  const base = `https://github.com/${repo}/issues/new?`;
  const make = (b: string) => base + new URLSearchParams({ title, labels: labels.join(","), body: b }).toString();
  let url = make(body);
  if (url.length <= limit) return { url, trimmed: false };
  const note = "\n\n_(Cut to fit the link. Paste the full text from the agent's reply over this.)_\n";
  let lo = 0, hi = body.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (make(body.slice(0, mid) + note).length <= limit) lo = mid; else hi = mid - 1; }
  url = make(body.slice(0, lo) + note);
  return { url, trimmed: true };
}

/** A slug for the assets folder: lowercase words from the title, at most 60 chars. */
export function slug(title: string): string {
  return title.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60).replace(/-$/, "") || "report";
}
