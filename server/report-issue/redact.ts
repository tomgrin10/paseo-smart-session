// Vendored from paseo-plugin-kit v0.3.0 (report-issue/redact.ts). Do not edit; change the kit and run `paseo-kit vendor report-issue <dir>`.
/**
 * Redaction for issue reports (invariant `report-issue-never-carries-secrets`). Every field an issue carries goes
 * through one `Redactor`, so the agent's words, the diagnostics and the log lines are cleaned by the same rules:
 *
 * - tokens (GitHub, OpenAI/Anthropic-style `sk-`, Slack `xox*`, bearer headers, AWS keys, JWTs, private key blocks)
 *   → `<token>`;
 * - emails → `<email>`, IPv4/IPv6 addresses → `<ip>`, the machine's hostname → `<host>`;
 * - the home directory → `~` (and any other `/home/<user>` or `/Users/<user>` → `~<user>` is not kept: `~`);
 * - a private repository's `owner/name` → `repo-N`, its bare name → `repo-N`, an owner with no public repository →
 *   `org-N`; PR titles from private repositories → `PR-N`. N is stable within one report, in order of first sight.
 *
 * Public repositories keep their names, and the developer can let a name through with `allow`. Pure and synchronous:
 * whether a repository is public is decided before (see `Visibility` in index.ts).
 */
export type RedactionContext = {
  /** The machine's hostname (os.hostname()), and any other names for it. */
  hostnames?: readonly string[];
  /** The home directory (os.homedir()). */
  home?: string | null;
  /** owner/name of every repository the report may mention that isn't public (unknown visibility counts as private). */
  privateRepos?: readonly string[];
  /** owner/name of repositories known to be public: never replaced. */
  publicRepos?: readonly string[];
  /** Titles of PRs (or issues) in private repositories. */
  privateTitles?: readonly string[];
  /** Words the developer allowed through (a repository name, a title). */
  allow?: readonly string[];
};

export type Replacement = { kind: "token" | "email" | "ip" | "host" | "home" | "repo" | "org" | "title"; count: number };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Secrets first: they can contain anything the later rules would split. */
const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bxapp-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b((?:api[_-]?key|access[_-]?token|secret|password|passwd|client[_-]?secret|authorization)["']?\s*[:=]\s*["']?)(?:(?:bearer|token|basic)\s+)?[^\s"',;]{6,}/gi,
  /\b(bearer|token|basic)(\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g,
];
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi;
const HOME_DIRS = /(?:\/home|\/Users)\/[A-Za-z0-9._-]+/g;

export class Redactor {
  private repos = new Map<string, string>();
  private orgs = new Map<string, string>();
  private titles = new Map<string, string>();
  private counts = new Map<Replacement["kind"], number>();
  private allow: Set<string>;
  private privateRepos: string[];
  private privateOwners: string[];
  private privateTitles: string[];
  private publicRepos: string[];

  private ctx: RedactionContext;

  constructor(ctx: RedactionContext = {}) {
    this.ctx = ctx;
    this.allow = new Set((ctx.allow ?? []).map(a => a.toLowerCase()));
    const pub = new Set((ctx.publicRepos ?? []).map(r => r.toLowerCase()));
    this.privateRepos = [...new Set((ctx.privateRepos ?? []).map(r => r.trim()).filter(r => /^[\w.-]+\/[\w.-]+$/.test(r) && !pub.has(r.toLowerCase()) && !this.allow.has(r.toLowerCase())))]
      .sort((a, b) => b.length - a.length);
    this.publicRepos = [...pub];
    const publicOwners = new Set([...pub].map(r => r.split("/")[0]));
    this.privateOwners = [...new Set(this.privateRepos.map(r => r.split("/")[0].toLowerCase()))].filter(o => !publicOwners.has(o) && !this.allow.has(o) && o.length >= 3);
    this.privateTitles = [...new Set((ctx.privateTitles ?? []).map(t => t.trim()).filter(t => t.length >= 6 && !this.allow.has(t.toLowerCase())))].sort((a, b) => b.length - a.length);
  }

  private bump(kind: Replacement["kind"], n = 1) { this.counts.set(kind, (this.counts.get(kind) ?? 0) + n); }
  private sub(text: string, pattern: RegExp, kind: Replacement["kind"], to: string | ((...m: string[]) => string)): string {
    return text.replace(pattern, (...m: string[]) => { this.bump(kind); return typeof to === "string" ? to : to(...m); });
  }
  /** One regex for many literal names, longest first, matched as whole words (`word`) or anywhere. */
  private alternation(items: readonly string[], word: boolean): RegExp {
    const body = [...items].sort((a, b) => b.length - a.length).map(escape).join("|");
    return new RegExp(word ? `(?<![\\w.-])(?:${body})(?![\\w-])` : `(?:${body})`, "gi");
  }
  private canonical(items: readonly string[], match: string) { return items.find(i => i.toLowerCase() === match.toLowerCase()) ?? match; }
  private label(map: Map<string, string>, key: string, prefix: string) {
    const k = key.toLowerCase();
    let v = map.get(k); if (!v) { v = `${prefix}-${map.size + 1}`; map.set(k, v); }
    return v;
  }

  /** One string, cleaned. Safe on any input; never throws. */
  text(input: string | null | undefined): string {
    if (!input) return "";
    let s = String(input);
    for (const p of TOKEN_PATTERNS) s = this.sub(s, p, "token", (...m) => {
      // Keep the label of `key=value` and `bearer x` forms so the line still reads.
      if (/^(bearer|token|basic)$/i.test(m[1] ?? "")) return `${m[1]}${m[2]}<token>`;
      if (/^https?:\/\/$/.test(m[1] ?? "")) return `${m[1]}<token>@`;
      if (m[1] && /[:=]/.test(m[1])) return `${m[1]}<token>`;
      return "<token>";
    });
    s = this.sub(s, EMAIL, "email", "<email>");
    const home = this.ctx.home?.replace(/\/+$/, "");
    if (home && home.length > 1) s = this.sub(s, new RegExp(escape(home) + "(?=/|\\b|$)", "g"), "home", "~");
    s = this.sub(s, HOME_DIRS, "home", "~");
    for (const h of this.ctx.hostnames ?? []) {
      if (!h || h.length < 3 || h === "localhost") continue;
      s = this.sub(s, new RegExp(`(?<![\\w-])${escape(h)}(?![\\w-])`, "gi"), "host", "<host>");
      const short = h.split(".")[0];
      if (short !== h && short.length >= 3) s = this.sub(s, new RegExp(`(?<![\\w-])${escape(short)}(?![\\w-])`, "gi"), "host", "<host>");
    }
    s = this.sub(s, IPV4, "ip", m => (m === "127.0.0.1" || m === "0.0.0.0" ? (this.bump("ip", -1), m) : "<ip>"));
    s = this.sub(s, IPV6, "ip", "<ip>");
    // Public repositories are set aside first, so a private repo with the same name never touches them.
    const kept: string[] = [];
    if (this.publicRepos.length) s = s.replace(this.alternation(this.publicRepos, true), m => `\u0000${kept.push(m) - 1}\u0000`);
    if (this.privateTitles.length) s = this.sub(s, this.alternation(this.privateTitles, false), "title", m => this.label(this.titles, this.canonical(this.privateTitles, m), "PR"));
    if (this.privateRepos.length) s = this.sub(s, this.alternation(this.privateRepos, true), "repo", m => this.label(this.repos, this.canonical(this.privateRepos, m), "repo"));
    // Bare names, in paths (~/Projects/storefront) and prose; each maps to its repository's label.
    const names = this.privateRepos.map(r => r.split("/")[1]).filter(n => n.length >= 4);
    if (names.length) s = this.sub(s, this.alternation(names, true), "repo", m => this.label(this.repos, this.privateRepos.find(r => r.split("/")[1].toLowerCase() === m.toLowerCase())!, "repo"));
    if (this.privateOwners.length) s = this.sub(s, this.alternation(this.privateOwners, true), "org", m => this.label(this.orgs, m, "org"));
    if (kept.length) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
    return s;
  }

  /** Every string in a JSON-like value, cleaned. */
  deep<T>(value: T): T {
    if (typeof value === "string") return this.text(value) as T;
    if (Array.isArray(value)) return value.map(v => this.deep(v)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.deep(v)])) as T;
    return value;
  }

  /** What was replaced, for the dry run ("2 private repos, 1 hostname"). */
  summary(): Replacement[] {
    return [...this.counts].filter(([, n]) => n > 0).map(([kind, count]) => ({ kind, count: kind === "repo" ? this.repos.size : kind === "org" ? this.orgs.size : kind === "title" ? this.titles.size : count }));
  }
}

/** Last line of defence before anything leaves the machine: true when a string still looks like it carries a secret. */
export function looksSecret(text: string): boolean {
  return TOKEN_PATTERNS.some(p => { p.lastIndex = 0; const m = p.exec(text); p.lastIndex = 0; return !!m && !m[0].includes("<token>"); });
}
