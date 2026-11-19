// Vendored from paseo-plugin-kit v0.3.0 (report-issue/diagnostics.ts). Do not edit; change the kit and run `paseo-kit vendor report-issue <dir>`.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { arch, release, type } from "node:os";
import type { DiagnosticsSection } from "./render.ts";

/**
 * Diagnostics every plugin shares: the machine (OS, arch, kernel, distribution, Node) and the CLIs agents run on
 * (provider CLIs, gh and whether it is signed in, never a token). Collected only while a report is being prepared,
 * never in the background. Each probe has a short timeout and an argument array; a probe that fails reads "unknown".
 */
export type Run = (bin: string, args: string[]) => Promise<string>;
const run: Run = (bin, args) => new Promise((resolve, reject) => execFile(bin, args, { timeout: 4_000, env: { ...process.env, NO_COLOR: "1", GH_PROMPT_DISABLED: "1" } }, (error, stdout, stderr) => error && !stdout && !stderr ? reject(error) : resolve(`${stdout ?? ""}${stderr ?? ""}`)));

const firstVersion = (text: string) => /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(text)?.[0] ?? null;

export async function distribution(read = (p: string) => readFile(p, "utf8")): Promise<string | null> {
  try { return /^PRETTY_NAME="?([^"\n]+)"?/m.exec(await read("/etc/os-release"))?.[1] ?? null; } catch { return null; }
}

export type EnvironmentOptions = {
  /** CLIs to report, as [label, bin, args]. Default: Claude Code, Codex, Graphite. */
  clis?: [string, string, string[]][];
  run?: Run;
};

export async function environment(o: EnvironmentOptions = {}): Promise<DiagnosticsSection> {
  const exec = o.run ?? run;
  const version = async (bin: string, args: string[]) => { try { return firstVersion(await exec(bin, args)); } catch { return null; } };
  const clis = o.clis ?? [["Claude Code", "claude", ["--version"]], ["Codex", "codex", ["--version"]], ["Graphite", "gt", ["--version"]]];
  const [distro, gh, ghStatus, ...versions] = await Promise.all([
    distribution(),
    version("gh", ["--version"]),
    exec("gh", ["auth", "status", "--hostname", "github.com"]).catch(() => ""),
    ...clis.map(([, bin, args]) => version(bin, args)),
  ]);
  const accounts = new Set([...String(ghStatus).matchAll(/account (\S+)/g)].map(m => m[1])).size;
  const rows: [string, string][] = [
    ["OS", `${type()} ${release()}, ${arch()}${distro ? ` (${distro})` : ""}`],
    ["Node", process.version],
    ["gh", gh ? `${gh} · ${accounts ? `signed in (${accounts} account${accounts === 1 ? "" : "s"})` : "not signed in"}` : "not installed"],
    ...clis.map(([label], i): [string, string] => [label, (versions[i] as string | null) ?? "not installed"]),
  ];
  return { title: "Environment", level: "environment", rows };
}

/**
 * The plugin's own recent warnings and errors, kept in memory: a ring of console.warn/console.error lines that start
 * with the plugin's prefix (e.g. "[follow-up]"). Install once at worker start; the returned function restores console.
 */
export class LogRing {
  private lines: string[] = [];
  private size: number;
  private now: () => Date;
  constructor(size = 40, now = () => new Date()) { this.size = size; this.now = now; }
  push(level: "warn" | "error", text: string) {
    const t = this.now().toISOString().slice(11, 19);
    this.lines.push(`${t} ${level.padEnd(5)} ${text.replace(/\s+/g, " ").slice(0, 400)}`);
    if (this.lines.length > this.size) this.lines.splice(0, this.lines.length - this.size);
  }
  recent(n = 20) { return this.lines.slice(-n); }
  capture(prefix: string, target: Pick<Console, "warn" | "error"> = console): () => void {
    const warn = target.warn, error = target.error;
    const wrap = (level: "warn" | "error", original: (...a: unknown[]) => void) => (...args: unknown[]) => {
      try {
        const text = args.map(a => a instanceof Error ? a.message : typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()).join(" ");
        if (text.startsWith(prefix)) this.push(level, text.slice(prefix.length).trim());
      } catch { /* never let logging break the caller */ }
      original.apply(target, args);
    };
    target.warn = wrap("warn", warn); target.error = wrap("error", error);
    return () => { if (target.warn !== warn) target.warn = warn; if (target.error !== error) target.error = error; };
  }
}
