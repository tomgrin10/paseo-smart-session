import { execFile } from "node:child_process";
import { chmod, copyFile, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

/**
 * Smart Session's agent tools are attached per launch (natively on Paseo 0.15+, or as a per-launch
 * stdio server), so a user-scope "smart-session" MCP entry left by an older version only makes every
 * Claude or Codex session on the machine, Paseo's or not, start its own `node mcp.mjs` — or fail to,
 * when it points at an install directory a later update removed. This removes such entries from
 * every Claude and Codex home Paseo launches agents with, backing each file up first.
 *
 * An entry is ours only when it runs this plugin's `mcp.mjs`. `.claude.json` holds credentials, so
 * it is read but never written here: `claude mcp remove` does that, under Claude Code's own lock,
 * with `CLAUDE_CONFIG_DIR` pointing at the home in question.
 */
export type Unregistered = { path: string; status: "removed" | "absent" | "foreign" | "unavailable" | "error"; error?: string };
const NAME = "smart-session";
const BACKUP = ".smart-session-unregister.bak";
const OURS = /(?:^|[\\/])(?:paseo-smart-session|smart-session)[\\/](?:.*[\\/])?mcp\.mjs$/;
const execFileAsync = promisify(execFile);

/** Every Claude global config (.claude.json) and Codex config.toml Paseo may launch an agent with. */
export async function agentHomes(env: NodeJS.ProcessEnv = process.env, paseoHome = env.PASEO_HOME ?? join(homedir(), ".paseo"), home = homedir()): Promise<{ claude: string[]; codex: string[] }> {
  const claudeDirs = new Set<string>([env.CLAUDE_CONFIG_DIR?.trim() || home, home]);
  const codexDirs = new Set<string>([env.CODEX_HOME?.trim() || join(home, ".codex"), join(home, ".codex")]);
  // Homes set in Paseo's provider settings (agents.providers.<id>.env).
  try {
    const config = JSON.parse(await readFile(join(paseoHome, "config.json"), "utf8"));
    for (const provider of Object.values(config?.agents?.providers ?? {}) as { env?: Record<string, string> }[]) {
      if (provider?.env?.CLAUDE_CONFIG_DIR) claudeDirs.add(provider.env.CLAUDE_CONFIG_DIR);
      if (provider?.env?.CODEX_HOME) codexDirs.add(provider.env.CODEX_HOME);
    }
  } catch { /* No config: the defaults. */ }
  // Homes ZeroSub creates per account (~/.paseo/zerosub/homes/<id>/), Claude and Codex alike. ZeroSub
  // seeds them from the main .claude.json, which is in the list above, so the entry does not come back.
  const zerosub = join(paseoHome, "zerosub", "homes");
  for (const entry of await readdir(zerosub, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    claudeDirs.add(join(zerosub, entry.name)); codexDirs.add(join(zerosub, entry.name));
  }
  const existing = async (paths: string[]) => [...new Set((await Promise.all(paths.map(async (p) => (await stat(p).catch(() => null))?.isFile() ? await realpath(p) : null))).filter((p): p is string => !!p))];
  return {
    claude: await existing([...claudeDirs].map((dir) => join(resolve(dir), ".claude.json"))),
    codex: await existing([...codexDirs].map((dir) => join(resolve(dir), "config.toml"))),
  };
}

const ours = (server: unknown) => {
  const entry = server as { command?: unknown; args?: unknown } | null;
  return [entry?.command, ...(Array.isArray(entry?.args) ? entry.args : [])].some((part) => typeof part === "string" && OURS.test(part));
};

async function backup(path: string): Promise<void> {
  await copyFile(path, path + BACKUP, 1).catch((error) => { if (error.code !== "EEXIST") throw error; });
  await chmod(path + BACKUP, (await stat(path)).mode & 0o777);
}

export type RunClaude = (args: string[], env: NodeJS.ProcessEnv) => Promise<unknown>;
const runClaude: RunClaude = (args, env) => execFileAsync("claude", args, { env, timeout: 30_000, maxBuffer: 1024 * 1024 });

export async function unregisterClaude(path: string, run: RunClaude = runClaude, home = homedir()): Promise<Unregistered> {
  try {
    const entry = JSON.parse(await readFile(path, "utf8"))?.mcpServers?.[NAME];
    if (!entry) return { path, status: "absent" };
    if (!ours(entry)) return { path, status: "foreign" };
    await backup(path);
    const env: NodeJS.ProcessEnv = { ...process.env };
    // ~/.claude.json is the default home's; any other directory is a CLAUDE_CONFIG_DIR.
    if (dirname(path) === await realpath(home).catch(() => resolve(home))) delete env.CLAUDE_CONFIG_DIR; else env.CLAUDE_CONFIG_DIR = dirname(path);
    try { await run(["mcp", "remove", NAME, "--scope", "user"], env); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, status: "unavailable" };
      throw error;
    }
    const after = JSON.parse(await readFile(path, "utf8"))?.mcpServers?.[NAME];
    return after ? { path, status: "error", error: "still registered after claude mcp remove" } : { path, status: "removed" };
  } catch (error) { return { path, status: "error", error: (error as Error).message }; }
}

/** Removes [mcp_servers.smart-session] and its sub-tables when they run our mcp.mjs, keeping everything else verbatim. */
export function withoutCodexEntry(text: string): string | null {
  const lines = text.split("\n");
  const header = (line: string) => /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line)?.[1].replace(/["']/g, "") ?? null;
  const mine = (name: string | null) => name === `mcp_servers.${NAME}` || name?.startsWith(`mcp_servers.${NAME}.`);
  const tables: { start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!mine(header(lines[i]!))) continue;
    let end = i + 1;
    while (end < lines.length && header(lines[end]!) === null) end++;
    // Comments and blank lines just above the next table belong to it.
    while (end > i + 1 && /^\s*(#.*)?$/.test(lines[end - 1]!)) end--;
    tables.push({ start: i, end }); i = end - 1;
  }
  if (!tables.length) return null;
  const body = tables.map((t) => lines.slice(t.start, t.end).join("\n")).join("\n");
  const strings = [...body.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
  if (!strings.some((value) => OURS.test(value))) return text;
  const keep = lines.filter((_, i) => !tables.some((t) => i >= t.start && i < t.end));
  return keep.join("\n").replace(/\n{3,}/g, "\n\n");
}

export async function unregisterCodex(path: string): Promise<Unregistered> {
  try {
    const text = await readFile(path, "utf8");
    const next = withoutCodexEntry(text);
    if (next === null) return { path, status: "absent" };
    if (next === text) return { path, status: "foreign" };
    await backup(path);
    const temporary = `${path}.smart-session.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, next, { mode: (await stat(path)).mode & 0o777 });
    await rename(temporary, path);
    return { path, status: "removed" };
  } catch (error) { return { path, status: "error", error: (error as Error).message }; }
}

/** Removes Smart Session's own global registrations from every known home. Never throws. */
export async function removeGlobalRegistrations(homes?: { claude: string[]; codex: string[] }, run: RunClaude = runClaude, home = homedir()): Promise<Unregistered[]> {
  const found = homes ?? await agentHomes().catch(() => ({ claude: [], codex: [] }));
  // One at a time: `claude mcp remove` is a whole CLI process, and they would share the main file's lock.
  const results: Unregistered[] = [];
  for (const path of found.claude) results.push(await unregisterClaude(path, run, home));
  for (const path of found.codex) results.push(await unregisterCodex(path));
  return results;
}
