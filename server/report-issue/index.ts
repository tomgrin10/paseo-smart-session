// Vendored from paseo-plugin-kit v0.3.0 (report-issue/index.ts). Do not edit; change the kit and run `paseo-kit vendor report-issue <dir>`.
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { extname } from "node:path";
import { z } from "zod";
import { Redactor, looksSecret, type RedactionContext, type Replacement } from "./redact.ts";
import { FIELD_HELP, RECOMMENDED, REPORT_KINDS, REQUIRED, labelsFor, missingFields, newIssueUrl, renderBody, renderDiagnostics, slug, type Diagnostics, type DiagnosticsSection, type ReportFields, type ReportKind } from "./render.ts";
import { ASSETS_REPO, ReportAuthError, addComment, assetPaths, createIssue, existingIssue, findDuplicates, publicRepos, uploadAssets, whoAmI, type Duplicate, type ReportGithub } from "./github.ts";

/**
 * Report an issue: a plugin-agnostic module that lets an agent file a bug, feature request or feedback about a plugin
 * in the plugin's GitHub repository, carefully: interview, inspect, dry-run, show the exact issue, file only after the
 * developer's yes. Nothing here imports the host plugin; everything comes through `ReportPluginConfig`, so the folder
 * can move into its own package unchanged.
 *
 * Context cost (invariant `report-issue-costs-no-standing-context`): the tool's description is one short line. The
 * procedure, template, redaction notes and screenshot-consent steps come back in the first call's reply, so they cost
 * context only while someone is reporting. Nothing is added to hooks, instructions or session start.
 *
 * Calls:
 *   1. { kind, summary }                → the procedure and the fields this kind needs.
 *   2. { kind, title, …fields }         → missing fields (refused), or the dry run: the exact issue, likely
 *                                          duplicates, what was redacted, screenshot consent, and a planId.
 *   3. { confirm: true, planId, screenshot_consent } → files it (or comments on comment_on) and returns the link;
 *                                          without GitHub auth, a prefilled new-issue link and the markdown to paste.
 */
export type ReportPluginConfig = {
  /** Shown in the issue and the procedure: "Follow-up". */
  name: string;
  /** Where issues go: "owner/repo". */
  repo: string;
  /** The tool's full name agents see (e.g. "follow_report_issue"), for the procedure's wording. */
  toolName: string;
  /** Folder in the reporter's assets repository: "follow-up". */
  assetsFolder: string;
  /** The reporter's GitHub, with their own auth. */
  github: ReportGithub;
  /** The plugin's diagnostics (versions, settings, counts, health), already free of tokens. Redacted again here. */
  diagnostics: () => Promise<Diagnostics>;
  /** What to redact: repository names and titles the plugin knows. Hostname and home are added here. */
  redaction?: () => Promise<RedactionContext>;
  /** Reads a screenshot (tests inject one). */
  readFile?: (path: string) => Promise<Buffer>;
  now?: () => number;
};

export const MAX_DESCRIPTION = 150;
/** The tool's one-line description: the only standing context this feature costs. */
export const reportToolDescription = (plugin: string) => `Report a bug, feature request or feedback about ${plugin} to its GitHub. Call with kind+summary first; the reply has the procedure.`;

const kind = z.enum(REPORT_KINDS);
const text = (max: number) => z.string().trim().max(max);
/** Everything the issue says. One object in the tool's schema, so the schema stays small; the first reply lists the keys. */
export const reportFieldsSchema = z.strictObject({
  title: text(120).optional(),
  what_happened: text(4000).optional(),
  steps: z.union([z.array(text(500)).max(30), text(6000)]).optional(),
  expected: text(2000).optional(),
  actual: text(4000).optional(),
  problem: text(4000).optional(),
  proposal: text(4000).optional(),
  alternatives: text(2000).optional(),
  feedback: text(4000).optional(),
  context: text(2000).optional(),
  findings: text(6000).optional(),
  screenshots: z.array(z.strictObject({ path: z.string().trim().min(1).max(1000), description: text(300).min(1) })).max(6).optional(),
  comment_on: z.number().int().positive().optional(),
  allow_names: z.array(text(200).min(1)).max(20).optional(),
});
export const reportInputSchema = z.strictObject({
  kind: kind.optional(),
  summary: text(500).optional(),
  fields: reportFieldsSchema.optional(),
  planId: z.string().trim().min(1).max(200).optional(),
  confirm: z.boolean().optional(),
  screenshot_consent: z.boolean().optional(),
});
export type ReportInput = z.infer<typeof reportInputSchema>;

/** The tool's JSON schema, for MCP registration (kept beside the zod one; a test checks they agree). */
export const reportToolProperties = {
  kind: { type: "string", enum: [...REPORT_KINDS] },
  summary: { type: "string" },
  fields: { type: "object" },
  planId: { type: "string" },
  confirm: { type: "boolean" },
  screenshot_consent: { type: "boolean" },
} as const;

const IMAGE = new Map([[".png", "png"], [".jpg", "jpg"], [".jpeg", "jpg"], [".gif", "gif"], [".webp", "webp"]]);
const MAX_IMAGE = 10 * 1024 * 1024;
const PLAN_TTL = 20 * 60_000;
const FIELDS: (keyof ReportFields)[] = ["title", "what_happened", "steps", "expected", "actual", "problem", "proposal", "alternatives", "feedback", "context", "findings"];

type Plan = {
  id: string; caller: string; expiresAt: number;
  kind: ReportKind; title: string; labels: string[]; fields: ReportFields; diagnostics: string;
  screenshots: { path: string; description: string; ext: string }[];
  comment: { number: number; url: string } | null;
  assetFolder: string;
  assetPaths: string[];
};

export class Reporter {
  private plans = new Map<string, Plan>();
  private visibility = new Map<string, { public: boolean; at: number }>();
  private now: () => number;
  private c: ReportPluginConfig;
  constructor(c: ReportPluginConfig) { this.c = c; this.now = c.now ?? Date.now; }

  /** One tool call. `caller` is the agent, from the host (never an argument): a plan runs only for the agent that made it. */
  async run(caller: string, raw: unknown): Promise<Record<string, unknown>> {
    const parsed = reportInputSchema.safeParse(raw ?? {});
    if (!parsed.success) throw new Error(`${this.c.toolName}: ${parsed.error.issues.map(i => `${i.path.join(".") || "arguments"} ${i.message}`).join("; ")}`);
    const a = parsed.data;
    if (a.confirm) return this.confirm(caller, a);
    if (!a.kind) throw new Error(`${this.c.toolName}: give kind (bug, feature or feedback) and a one-line summary first.`);
    if (!a.fields || !Object.keys(a.fields).length) return this.procedure(a.kind, a.summary);
    return this.dryRun(caller, a.kind, a.fields);
  }

  /** Call 1: the whole procedure, only now that someone is reporting. */
  procedure(k: ReportKind, summary?: string) {
    const t = this.c.toolName;
    const fields = (list: readonly (keyof ReportFields)[]) => Object.fromEntries(list.map(f => [f, FIELD_HELP[f]]));
    return {
      stage: "procedure",
      plugin: this.c.name, repo: this.c.repo, kind: k, ...(summary ? { summary } : {}),
      howToCall: `${this.c.toolName}({ kind: "${k}", fields: { ${REQUIRED[k].join(", ")}, … } }); the keys below go inside fields.`,
      required: fields(REQUIRED[k]),
      recommended: fields(RECOMMENDED[k]),
      optional: { screenshots: "[{path, description}]: local image files the developer gives you (png, jpg, gif, webp; up to 6). describe each in words: the words go in the issue either way", comment_on: "an existing issue number from the duplicates, to add these details there instead", allow_names: "names the developer chose to keep (a repository, a title) that would otherwise be replaced" },
      procedure: [
        `1. Interview the developer for anything required above that you don't already know, in one short message. Use their words; don't invent steps or results.`,
        `2. Inspect or reproduce it yourself where you can (${this.c.name}'s read tools, its state and logs, trying the steps) and put what you found in findings.`,
        `3. Screenshots: ask if they have any. Take local paths, describe each one, and look at each image yourself: point out anything that looks private (repository or company names, hostnames, Slack or email text, people) before going on.`,
        `4. Call ${t} again with kind and fields: { …every key above }. The reply is a dry run: the exact title, labels and body, likely duplicates, what was redacted, and a planId. ${this.c.name} adds versions, environment and recent errors itself and removes tokens, emails, hostnames, home paths and private repository names and PR titles.`,
        `5. Show the developer the title, labels and body exactly as returned, the duplicates and the redaction summary. If a duplicate matches, offer to add these details to it instead (comment_on). Fix anything they want changed and dry-run again.`,
        `6. Screenshots become public: tell them exactly which files and where (the dry run says), ask them to check the images for private information, and ask yes or no for this report.`,
        `7. Only after an explicit yes to filing: call ${t} with confirm=true, the planId, and screenshot_consent=true or false. Never file without that yes; ${this.c.repo} is public.`,
        `8. Give them the link. If the images weren't uploaded, ask them to drag them into the issue at that link.`,
      ],
      next: `Interview the developer, then call ${t} with kind="${k}" and fields.`,
    };
  }

  private async redactor(allow: string[]): Promise<Redactor> {
    const base = await this.c.redaction?.().catch(() => ({} as RedactionContext)) ?? {};
    const candidates = [...new Set([...(base.privateRepos ?? []), ...(base.publicRepos ?? [])])].filter(r => r.toLowerCase() !== this.c.repo.toLowerCase());
    const pub = await publicRepos(this.c.github, candidates, this.visibility, this.now()).catch(() => new Set<string>());
    const host = hostname();
    return new Redactor({
      ...base,
      hostnames: [...(base.hostnames ?? []), host],
      home: base.home ?? homedir(),
      privateRepos: candidates.filter(r => !pub.has(r.toLowerCase())),
      publicRepos: [this.c.repo, ...candidates.filter(r => pub.has(r.toLowerCase()))],
      allow: [...(base.allow ?? []), ...allow],
    });
  }

  private async diagnostics(k: ReportKind, r: Redactor): Promise<string> {
    const d = await this.c.diagnostics().catch((error: unknown): Diagnostics => ({ sections: [{ title: "Diagnostics", level: "versions", rows: [["Error", `couldn't collect: ${error instanceof Error ? error.message : String(error)}`]] }] }));
    const clean: Diagnostics = { sections: d.sections.map(s => ({ ...s, title: r.text(s.title), rows: s.rows.map(([a, b]) => [r.text(a), r.text(b)] as [string, string]) })), logs: d.logs?.map(l => r.text(l)) };
    return renderDiagnostics(k, clean, { plugin: this.c.name });
  }

  private async screenshots(list: { path: string; description: string }[]) {
    const out: Plan["screenshots"] = [];
    const problems: string[] = [];
    for (const s of list) {
      const ext = IMAGE.get(extname(s.path).toLowerCase());
      if (!ext) { problems.push(`${s.path}: not an image (png, jpg, gif or webp)`); continue; }
      const info = await stat(s.path).catch(() => null);
      if (!this.c.readFile && !info?.isFile()) { problems.push(`${s.path}: no such file`); continue; }
      if (info && info.size > MAX_IMAGE) { problems.push(`${s.path}: larger than 10 MB`); continue; }
      out.push({ path: s.path, description: s.description, ext });
    }
    return { out, problems };
  }

  /** Call 2: refuse with what's missing, or plan the issue. Reads only (invariant `report-issue-files-only-after-confirm`). */
  private async dryRun(caller: string, k: ReportKind, a: z.infer<typeof reportFieldsSchema>) {
    const fields: ReportFields = Object.fromEntries(FIELDS.filter(f => a[f] !== undefined).map(f => [f, a[f]]));
    const missing = missingFields(k, fields);
    if (missing.required.length) {
      return { stage: "missing", kind: k, missing: missing.required, help: Object.fromEntries(missing.required.map(f => [f, FIELD_HELP[f]])), next: `Ask the developer for ${missing.required.join(", ")}, then call ${this.c.toolName} again with kind and every field in fields. Nothing was filed.` };
    }
    const r = await this.redactor(a.allow_names ?? []);
    const clean = r.deep(fields);
    const title = r.text(fields.title).slice(0, 120);
    const shots = await this.screenshots(a.screenshots ?? []);
    if (shots.problems.length) throw new Error(`${this.c.toolName}: ${shots.problems.join("; ")}. Fix the paths or leave those screenshots out.`);
    const descriptions = shots.out.map(s => ({ ...s, description: r.text(s.description) }));
    const block = await this.diagnostics(k, r);
    const comment = a.comment_on ? await existingIssue(this.c.github, this.c.repo, a.comment_on).catch((e: unknown) => { throw new Error(`${this.c.toolName}: ${e instanceof Error ? e.message : String(e)}`); }) : null;
    const duplicates: Duplicate[] = comment ? [] : await findDuplicates(this.c.github, this.c.repo, title).catch(() => []);
    const date = new Date(this.now()).toISOString().slice(0, 10);
    const paths = assetPaths(this.c.assetsFolder, date, slug(title), shots.out);
    const folder = `${this.c.assetsFolder}/${date}-${slug(title)}`;
    const labels = labelsFor(k);
    const body = renderBody(k, clean, { plugin: this.c.name, diagnostics: block, screenshots: descriptions.map((s, i) => ({ description: s.description, url: `https://raw.githubusercontent.com/<you>/${ASSETS_REPO}/main/${paths[i]}` })), comment: !!comment });
    if (looksSecret(body) || looksSecret(title)) throw new Error(`${this.c.toolName}: the issue still looks like it carries a secret after redaction. Remove it from the fields and try again.`);
    for (const [key, p] of this.plans) if (p.expiresAt <= this.now()) this.plans.delete(key);
    const plan: Plan = { id: randomUUID(), caller, expiresAt: this.now() + PLAN_TTL, kind: k, title, labels, fields: clean, diagnostics: block, screenshots: descriptions, comment: comment ? { number: comment.number, url: comment.url } : null, assetFolder: folder, assetPaths: paths };
    this.plans.set(plan.id, plan);
    const redacted = describe(r.summary());
    return {
      stage: "dry_run", dryRun: true, planId: plan.id, repo: this.c.repo,
      action: comment ? `comment on #${comment.number} (${comment.title})` : "create a new issue",
      title: comment ? null : title, labels: comment ? [] : labels, body,
      ...(missing.recommended.length ? { recommendedMissing: missing.recommended } : {}),
      duplicates: duplicates.map(d => `#${d.number} "${d.title}" · ${d.state}${d.stateReason ? ` (${d.stateReason})` : ""} · ${d.comments} comment${d.comments === 1 ? "" : "s"} · ${d.url}`),
      redacted: redacted || "nothing",
      ...(descriptions.length ? { screenshots: {
        consent: "required",
        files: descriptions.map((s, i) => `${s.path} → ${paths[i]}`),
        where: `public repository <your GitHub login>/${ASSETS_REPO} (created with a short README if missing), folder ${folder}`,
        ask: "These images become public and can't be redacted like the text. Ask the developer to check them for repository or company names, hostnames, Slack or email text, or people, and to say yes or no to uploading them for this report.",
      } } : {}),
      next: `Show the developer the ${comment ? "comment" : "title, labels and body"} above exactly${duplicates.length ? ", the possible duplicates (offer comment_on)" : ""} and what was redacted. File only after an explicit yes: ${this.c.toolName} with confirm=true, planId=${plan.id}${descriptions.length ? ", screenshot_consent=true or false" : ""}, within 20 minutes.`,
    };
  }

  /** Call 3: file it. Screenshots upload only with screenshot_consent=true for this plan. */
  private async confirm(caller: string, a: ReportInput) {
    const t = this.c.toolName;
    if (!a.planId) throw new Error(`${t}: confirm needs the planId from the dry run. Call ${t} without confirm first.`);
    const plan = this.plans.get(a.planId);
    if (!plan || plan.expiresAt <= this.now()) throw new Error(`${t}: this plan expired or was already used. Run the dry run again.`);
    if (plan.caller !== caller) throw new Error(`${t}: this plan belongs to another agent. Run the dry run again.`);
    if (plan.screenshots.length && a.screenshot_consent === undefined) throw new Error(`${t}: this report has ${plan.screenshots.length} screenshot(s). Ask the developer whether they may become public, then confirm again with screenshot_consent=true or false.`);
    this.plans.delete(plan.id);
    const login = await whoAmI(this.c.github);
    if (!login) return this.fallback(plan, "No GitHub sign-in was found for this machine (gh auth login).");
    let urls: (string | null)[] = plan.screenshots.map(() => null);
    let images: Record<string, unknown> | null = null;
    if (plan.screenshots.length) {
      if (!a.screenshot_consent) images = { uploaded: 0, reason: "The developer said no to uploading them." };
      else {
        try {
          const read = this.c.readFile ?? ((p: string) => readFile(p));
          const files = await Promise.all(plan.screenshots.map(async (s, i) => ({ path: plan.assetPaths[i], content: await read(s.path) })));
          const up = await uploadAssets(this.c.github, login, files, `${this.c.name}: screenshots for "${plan.title}"`);
          urls = up.urls;
          images = { uploaded: up.urls.length, folder: up.folderUrl, ...(up.created ? { createdRepository: `${login}/${ASSETS_REPO}` } : {}) };
        } catch (error) {
          images = { uploaded: 0, reason: `Upload failed: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
    }
    const body = renderBody(plan.kind, plan.fields, { plugin: this.c.name, diagnostics: plan.diagnostics, screenshots: plan.screenshots.map((s, i) => ({ description: s.description, url: urls[i] })), comment: !!plan.comment });
    try {
      const out = plan.comment ? await addComment(this.c.github, this.c.repo, plan.comment.number, body) : await createIssue(this.c.github, this.c.repo, { title: plan.title, body, labels: plan.labels });
      const dragIn = plan.screenshots.length && !urls.every(Boolean);
      return {
        filed: true, action: plan.comment ? "commented" : "created", url: out.url, number: out.number,
        ...(images ? { screenshots: images } : {}),
        next: dragIn ? `Give the developer ${out.url} and ask them to drag the ${plan.screenshots.length} screenshot(s) into ${plan.comment ? "a comment there" : "the issue"} (the body describes each one).` : `Give the developer the link: ${out.url}`,
      };
    } catch (error) {
      if (error instanceof ReportAuthError) return this.fallback(plan, error.message);
      throw new Error(`${t}: ${error instanceof Error ? error.message : String(error)} Nothing was filed; the dry run can be run again.`);
    }
  }

  /** Without GitHub auth: the prefilled new-issue link and the full markdown to paste. */
  private fallback(plan: Plan, why: string) {
    const body = renderBody(plan.kind, plan.fields, { plugin: this.c.name, diagnostics: plan.diagnostics, screenshots: plan.screenshots.map(s => ({ description: s.description })), comment: !!plan.comment });
    const target = plan.comment ? { url: plan.comment.url, trimmed: false } : newIssueUrl(this.c.repo, plan.title, body, plan.labels);
    return {
      filed: false, reason: why, url: target.url, ...(target.trimmed ? { trimmed: true } : {}),
      markdown: plan.comment ? body : `# ${plan.title}\n\n${body}`,
      next: plan.comment
        ? `Nothing was posted. Give the developer ${plan.comment.url} and the markdown above to paste as a comment${plan.screenshots.length ? ", then drag the screenshots in" : ""}.`
        : `Nothing was posted. Give the developer the link (it opens a prefilled issue on GitHub)${target.trimmed ? " and the full markdown, since the link's body was cut" : ""}${plan.screenshots.length ? "; they drag the screenshots in before submitting" : ""}.`,
    };
  }
}

function describe(list: Replacement[]): string {
  const name: Record<Replacement["kind"], [string, string]> = { token: ["token", "tokens"], email: ["email", "emails"], ip: ["IP address", "IP addresses"], host: ["hostname", "hostnames"], home: ["home path", "home paths"], repo: ["private repository", "private repositories"], org: ["private owner", "private owners"], title: ["private PR title", "private PR titles"] };
  return list.map(r => `${r.count} ${name[r.kind][r.count === 1 ? 0 : 1]}`).join(", ");
}

/**
 * A prefilled new-issue link for a developer filing by hand (no agent to send to), with the basic versions block,
 * redacted. `text` is what they typed in the sheet.
 */
export async function manualIssueLink(c: Pick<ReportPluginConfig, "name" | "repo" | "diagnostics" | "redaction">, kindIn: ReportKind, typed: string): Promise<{ url: string; trimmed: boolean }> {
  const base = await c.redaction?.().catch(() => ({} as RedactionContext)) ?? {};
  // No GitHub call here: every repository the plugin knows counts as private.
  const r = new Redactor({ ...base, hostnames: [...(base.hostnames ?? []), hostname()], home: base.home ?? homedir(), privateRepos: [...(base.privateRepos ?? []), ...(base.publicRepos ?? [])].filter(x => x.toLowerCase() !== c.repo.toLowerCase()), publicRepos: [c.repo] });
  const d = await c.diagnostics().catch((): Diagnostics => ({ sections: [] }));
  const versions = renderDiagnostics("feedback", { sections: d.sections.map(s => ({ ...s, rows: s.rows.map(([a, b]) => [r.text(a), r.text(b)] as [string, string]) })) }, { plugin: c.name, open: true });
  const first = r.text(typed).split("\n").find(l => l.trim())?.trim() ?? "";
  const title = first.length > 80 ? `${first.slice(0, 77)}…` : first;
  const heading = kindIn === "bug" ? "What happened" : kindIn === "feature" ? "What I'd like" : "Feedback";
  const body = `### ${heading}\n\n${r.text(typed).trim()}\n\n${versions}\n`;
  return newIssueUrl(c.repo, title, body, [labelsFor(kindIn)[0]]);
}

export { REPORT_KINDS, type Diagnostics, type DiagnosticsSection, type ReportKind, type ReportGithub, type RedactionContext };
export { environment, LogRing } from "./diagnostics.ts";
