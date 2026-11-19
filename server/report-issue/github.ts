// Vendored from paseo-plugin-kit v0.3.0 (report-issue/github.ts). Do not edit; change the kit and run `paseo-kit vendor report-issue <dir>`.
/**
 * GitHub for issue reports, through the reporter's own auth (injected; Follow-up passes its in-process client, so no
 * process is spawned). Reads: who the reporter is, whether a repository is public, likely duplicates. Writes, only
 * from a confirmed plan (invariant `report-issue-files-only-after-confirm`): the issue or comment, and, with the
 * developer's consent for that report, the screenshots in `<login>/paseo-issue-assets`.
 */
export type ReportGithub = {
  /** One REST call as the reporter. Resolves with any HTTP status; rejects only when there is no auth or no network. */
  request(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<{ status: number; data: any }>;
};

export class ReportAuthError extends Error {}

export const ASSETS_REPO = "paseo-issue-assets";
export const ASSETS_README = `# Paseo issue assets

Screenshots attached to issues filed from Paseo plugins (Follow-up and others) by this account's agent.

Each folder is one report: \`<plugin>/<date>-<title>/1.png\`. They're public so the issues can show them. Delete any
file here once its issue is closed, or the whole repository if you don't need it.
`;

/** The reporter's login, or null without usable auth. */
export async function whoAmI(gh: ReportGithub): Promise<string | null> {
  try { const r = await gh.request("GET", "user"); return r.status === 200 && typeof r.data?.login === "string" ? r.data.login : null; }
  catch { return null; }
}

/** Public repositories by owner/name. Unknown (no auth, an error, a 404) counts as private. */
export async function publicRepos(gh: ReportGithub, repos: readonly string[], cache: Map<string, { public: boolean; at: number }>, now: number, limit = 30): Promise<Set<string>> {
  const out = new Set<string>();
  const todo = [...new Set(repos.map(r => r.toLowerCase()))];
  await Promise.all(todo.slice(0, limit).map(async repo => {
    const hit = cache.get(repo);
    if (hit && now - hit.at < 6 * 3_600_000) { if (hit.public) out.add(repo); return; }
    const r = await gh.request("GET", `repos/${repo}`).catch(() => null);
    // Only a confirmed public answer is cached as public; anything else is retried next report.
    const isPublic = r?.status === 200 && r.data?.private === false && r.data?.visibility !== "internal";
    if (r?.status === 200) cache.set(repo, { public: isPublic, at: now });
    if (isPublic) out.add(repo);
  }));
  return out;
}

export type Duplicate = { number: number; title: string; state: string; stateReason: string | null; comments: number; url: string };

const STOP = new Set("a an the and or but of to in on at for with from by is are was were be been it its this that when after before not no does doesn't don't can't cannot into than then there their about as".split(" "));
/** Search words from a title: no stop words, no placeholders, at most six. */
export function searchTerms(title: string): string[] {
  return [...new Set(title.toLowerCase().replace(/[^\w\s-]/g, " ").split(/\s+/).filter(w => w.length > 2 && !STOP.has(w) && !/^(repo|pr|org)-\d+$/.test(w)))].slice(0, 6);
}

/** Open and closed issues in the repository that share the title's words, best first. Empty when search fails. */
export async function findDuplicates(gh: ReportGithub, repo: string, title: string): Promise<Duplicate[]> {
  const terms = searchTerms(title);
  if (!terms.length) return [];
  const q = encodeURIComponent(`repo:${repo} is:issue ${terms.join(" ")}`);
  const loose = encodeURIComponent(`repo:${repo} is:issue ${terms.slice(0, 3).join(" OR ")}`);
  const seen = new Map<number, Duplicate>();
  for (const query of [q, loose]) {
    const r = await gh.request("GET", `search/issues?q=${query}&per_page=5`).catch(() => null);
    for (const i of r?.status === 200 && Array.isArray(r.data?.items) ? r.data.items : []) {
      if (i.pull_request || seen.has(i.number) || seen.size >= 5) continue;
      seen.set(i.number, { number: i.number, title: String(i.title ?? ""), state: String(i.state ?? ""), stateReason: i.state_reason ?? null, comments: Number(i.comments ?? 0), url: String(i.html_url ?? "") });
    }
    if (seen.size >= 3) break;
  }
  return [...seen.values()];
}

/** The issue a comment would go on: refused unless it exists in this repository and isn't a PR. */
export async function existingIssue(gh: ReportGithub, repo: string, number: number): Promise<{ number: number; title: string; state: string; url: string }> {
  const r = await gh.request("GET", `repos/${repo}/issues/${number}`);
  if (r.status !== 200 || r.data?.pull_request) throw new Error(`#${number} isn't an issue in ${repo}.`);
  return { number, title: String(r.data.title ?? ""), state: String(r.data.state ?? ""), url: String(r.data.html_url ?? "") };
}

export async function createIssue(gh: ReportGithub, repo: string, issue: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }> {
  const r = await gh.request("POST", `repos/${repo}/issues`, issue);
  if (r.status === 401) throw new ReportAuthError("GitHub refused the reporter's token (HTTP 401).");
  if (r.status !== 201) throw new Error(`GitHub didn't create the issue (HTTP ${r.status}${r.data?.message ? `: ${r.data.message}` : ""}).`);
  return { number: r.data.number, url: r.data.html_url };
}

export async function addComment(gh: ReportGithub, repo: string, number: number, body: string): Promise<{ number: number; url: string }> {
  const r = await gh.request("POST", `repos/${repo}/issues/${number}/comments`, { body });
  if (r.status === 401) throw new ReportAuthError("GitHub refused the reporter's token (HTTP 401).");
  if (r.status !== 201) throw new Error(`GitHub didn't add the comment (HTTP ${r.status}${r.data?.message ? `: ${r.data.message}` : ""}).`);
  return { number, url: r.data.html_url };
}

/** Where a report's screenshots go: stable for the same plugin folder, day and title. */
export function assetPaths(folder: string, date: string, titleSlug: string, files: { ext: string }[]): string[] {
  return files.map((f, i) => `${folder}/${date}-${titleSlug}/${i + 1}.${f.ext}`);
}

/**
 * Uploads a report's screenshots to `<login>/paseo-issue-assets` (created public, with a README, when missing) and
 * returns a URL per file that renders in an issue. Throws on anything that stops it; the caller files text-only then.
 */
export async function uploadAssets(gh: ReportGithub, login: string, files: { path: string; content: Buffer }[], message: string): Promise<{ urls: string[]; folderUrl: string; created: boolean }> {
  const repo = `${login}/${ASSETS_REPO}`;
  let created = false;
  let info = await gh.request("GET", `repos/${repo}`);
  if (info.status === 404) {
    const made = await gh.request("POST", "user/repos", { name: ASSETS_REPO, description: "Screenshots for issues filed from Paseo plugins", private: false, has_issues: false, has_projects: false, has_wiki: false, auto_init: false });
    if (made.status !== 201) throw new Error(`Couldn't create ${repo} (HTTP ${made.status}).`);
    info = { status: 200, data: made.data }; created = true;
  }
  if (info.status !== 200) throw new Error(`Couldn't read ${repo} (HTTP ${info.status}).`);
  if (info.data?.private) throw new Error(`${repo} is private, so images there wouldn't show in a public issue.`);
  const put = async (path: string, content: Buffer, msg: string) => {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    let r = await gh.request("PUT", `repos/${repo}/contents/${encoded}`, { message: msg, content: content.toString("base64") });
    if (r.status === 422) {
      // Already there (the same report sent twice): replace it in place, so the path stays the same.
      const old = await gh.request("GET", `repos/${repo}/contents/${encoded}`);
      if (old.status === 200 && old.data?.sha) r = await gh.request("PUT", `repos/${repo}/contents/${encoded}`, { message: msg, content: content.toString("base64"), sha: old.data.sha });
    }
    if (r.status !== 201 && r.status !== 200) throw new Error(`Couldn't upload ${path} (HTTP ${r.status}).`);
    return r.data;
  };
  if (created) await put("README.md", Buffer.from(ASSETS_README), "Add README");
  const branch = String(info.data?.default_branch || "main");
  const urls: string[] = [];
  for (const f of files) {
    await put(f.path, f.content, message);
    urls.push(`https://raw.githubusercontent.com/${repo}/${branch}/${f.path.split("/").map(encodeURIComponent).join("/")}`);
  }
  const folder = files[0]?.path.split("/").slice(0, -1).join("/") ?? "";
  return { urls, folderUrl: `https://github.com/${repo}/tree/${branch}/${folder}`, created };
}
