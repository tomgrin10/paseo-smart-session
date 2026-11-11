/**
 * Installing the agent-facing half of the plugin into Claude Code.
 *
 * The `Stop` hook is not a nice-to-have: it is the only thing that ever asks a
 * session whether to compact itself, so a Smart Session install without it does
 * nothing at all except record. Leaving that to a paragraph in a README meant the
 * feature was off for anyone who skimmed, and off in a way that looked like it was
 * working — the surface said "on", and nothing ever happened.
 *
 * Paseo 0.14 attaches MCP servers at session open. Claude Code's provider hooks
 * still need reconciliation in `~/.claude/settings.json`; this module owns only
 * those hooks during normal load. Global MCP registration is an explicit legacy
 * compatibility operation, never the default.
 *
 * The rules that make that acceptable:
 *
 *   - **Own only our own.** An entry is ours when its command points at one of our
 *     `hooks/*.mjs` scripts: the stable shim in Smart Session's data directory, or
 *     (from older versions, migrated on the next load) an install's own `hooks/`.
 *     Nothing else in the file is read for meaning, reordered or rewritten.
 *   - **Never name an install directory.** Paseo deletes the old one on every update,
 *     so the commands run shims in the fixed data directory (`server/hook-path.ts`),
 *     each guarded so that a missing shim is a silent no-op. The shims are written, and
 *     their pointer checked against the scripts themselves, before any command naming
 *     them is.
 *   - **Write only on a real change.** Reconciling to identical JSON writes nothing,
 *     so the common case — every reload after the first — touches no files.
 *   - **Be reversible.** One backup, kept from the first modification, and turning
 *     `installHooks` off removes every entry we added.
 */

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { PLUGIN_VERSION } from "../shared/version.ts";
import { complete, pointerHealthy, pointShimsAt } from "./hook-path.ts";
import { readSettings } from "./settings.ts";

const execFileAsync = promisify(execFile);

/**
 * The hooks this plugin owns, and the events they belong on.
 *
 * `PostCompact` appears alongside `SessionStart` deliberately: the same script is
 * registered on both because neither event can do the whole job — `PostCompact`
 * knows a compaction happened but cannot inject, and `SessionStart:compact` can
 * inject but does not know. See `hooks/pointer.mjs`.
 */
const MANAGED = [
  { event: "PostToolUse", matcher: "", script: "context-threshold.mjs" },
  { event: "Stop", matcher: "", script: "ask-compact.mjs" },
  { event: "PostCompact", matcher: "", script: "post-compact.mjs" },
  { event: "SessionStart", matcher: "compact", script: "post-compact.mjs" },
  // Publishes an artifact as the main account through a helper agent, which takes 10-20 s and may
  // queue behind another; the hook gives up at 160 s (`hooks/publish-as.mjs`).
  { event: "PreToolUse", matcher: "Artifact", script: "publish-as.mjs", timeout: 180 },
] as const;

/** Every script we might have written, including into an older install's path. */
const OUR_SCRIPTS = ["context-threshold.mjs", "ask-compact.mjs", "post-compact.mjs", "publish-as.mjs"];

const HOOK_TIMEOUT_SECONDS = 10;

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
}

interface MatcherGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

type HookMap = Record<string, MatcherGroup[]>;

export interface InstallReport {
  /** Where the hook scripts were found, or null when they could not be. */
  readonly pluginDir: string | null;
  readonly settingsPath: string;
  /** True when this run actually modified the file. */
  readonly changed: boolean;
  /** One line per managed event, for the surface to show. */
  readonly hooks: string[];
  readonly mcp: "present" | "added" | "updated" | "unavailable" | "skipped" | "session";
  readonly error: string | null;
}

const claudeDir = (): string => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const settingsPath = (): string => join(claudeDir(), "settings.json");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface Candidate {
  readonly dir: string;
  /** Explicitly named (SMART_SESSION_PLUGIN_DIR): taken as is, whatever its version. */
  readonly explicit?: boolean;
}

/** Every install directory under `$PASEO_HOME/plugins/<id>/<install>/`, newest first. */
async function scanInstalls(home: string): Promise<string[]> {
  const root = join(home, "plugins");
  const found: { dir: string; mtime: number }[] = [];
  for (const id of await readdir(root).catch(() => [] as string[])) {
    for (const install of await readdir(join(root, id)).catch(() => [] as string[])) {
      // npm installs land in node_modules/<package>, Git installs in checkout/.
      for (const dir of [join(root, id, install, "node_modules", "paseo-smart-session"), join(root, id, install, "checkout")]) {
        const info = await stat(dir).catch(() => null);
        if (info?.isDirectory()) found.push({ dir, mtime: info.mtimeMs });
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map(({ dir }) => dir);
}

async function packageVersion(dir: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    return pkg.name === "paseo-smart-session" && typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Where the running plugin's files live.
 *
 * Paseo evaluates the server bundle from a string and hands it no directory, so
 * `import.meta.url` and `__dirname` say nothing. What the bundle does carry is its own
 * version, and the install it came from carries the same one in `package.json`. That is
 * the first test, because `config.json` is not trustworthy during an update: on
 * 2026-11-09 it still named the previous install when this ran, the hooks were written
 * against it, and Paseo deleted it seconds later.
 *
 * Candidates are `SMART_SESSION_PLUGIN_DIR` (taken as is), every plugin `config.json`
 * names (a second install under `--id something-else` is supported), then every install
 * directory under `$PASEO_HOME/plugins`, newest first. Only a directory holding the
 * scripts counts. The first whose version is the running one wins; failing that, the
 * first complete one, which is what this did before it knew its version.
 */
export async function resolvePluginDir(options: { version?: string } = {}): Promise<string | null> {
  const version = options.version ?? PLUGIN_VERSION;
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  let configured: string[] = [];
  try {
    const raw = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as {
      plugins?: Record<string, { path?: unknown }>;
    };
    configured = Object.values(raw.plugins ?? {})
      .map((entry) => entry.path)
      .filter((path): path is string => typeof path === "string" && path !== "");
  } catch {
    // No config, or one we cannot read. Fall through to the environment and the scan.
  }

  const fromEnv = process.env.SMART_SESSION_PLUGIN_DIR;
  const candidates: Candidate[] = [
    ...(fromEnv !== undefined && fromEnv !== "" ? [{ dir: fromEnv, explicit: true }] : []),
    ...configured.map((dir) => ({ dir })),
    ...(await scanInstalls(home)).map((dir) => ({ dir })),
  ];

  let fallback: string | null = null;
  const seen = new Set<string>();
  for (const { dir, explicit } of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    // The scripts themselves are the proof. A directory that merely has the right
    // name would still produce hook commands that fail on every turn.
    if (!(await complete(dir))) continue;
    if (explicit === true || (await packageVersion(dir)) === version) return dir;
    fallback ??= dir;
  }
  return fallback;
}

/** Whether a hook command is one of ours, wherever it was installed from. */
function isOurs(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return OUR_SCRIPTS.some((script) => command.includes(`hooks/${script}`));
}

/** A shell word, single-quoted. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command for one hook: the stable shim, guarded, so a missing shim is a silent
 * no-op rather than a failing hook on every turn of every session.
 */
export function commandFor(shims: string, script: string): string {
  const path = quote(join(shims, script));
  return `if [ -f ${path} ]; then node ${path}; fi`;
}

/**
 * The hook map this plugin wants, given the one already on disk.
 *
 * Every entry of ours is stripped first and then re-added, so a plugin that moved
 * directory or renamed a script leaves nothing stale behind — and so the manual
 * entries an early adopter added by hand are adopted rather than duplicated.
 */
export function reconcile(existing: HookMap, shims: string | null): HookMap {
  const next: HookMap = {};

  for (const [event, groups] of Object.entries(existing)) {
    const kept = (Array.isArray(groups) ? groups : [])
      .map((group) => ({
        ...group,
        hooks: (group.hooks ?? []).filter((hook) => !isOurs(hook.command)),
      }))
      // A matcher group we emptied was only ever there for us.
      .filter((group) => (group.hooks ?? []).length > 0);
    if (kept.length > 0) next[event] = kept;
  }

  if (shims === null) return next;

  for (const managed of MANAGED) {
    const { event, matcher, script } = managed;
    const groups = next[event] ?? [];
    const entry: HookEntry = {
      type: "command",
      command: commandFor(shims, script),
      timeout: "timeout" in managed ? managed.timeout : HOOK_TIMEOUT_SECONDS,
    };
    const group = groups.find((candidate) => (candidate.matcher ?? "") === matcher);
    if (group === undefined) groups.push({ matcher, hooks: [entry] });
    else group.hooks = [...(group.hooks ?? []), entry];
    next[event] = groups;
  }
  return next;
}

/** One backup, from the first time we ever touched the file. */
async function backupOnce(path: string): Promise<void> {
  const backup = `${path}.smart-session-backup`;
  if (await exists(backup)) return;
  try {
    await copyFile(path, backup);
  } catch {
    // A missing backup is not worth refusing the install over; the reconciler is
    // additive and reversible on its own terms.
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.smart-session-${randomUUID()}.tmp`);
  await writeFile(temp, text, "utf8");
  await rename(temp, path);
}

export interface McpDefinition {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpRuntime {
  electron: string | undefined;
  execPath: string;
  appImage: string | undefined;
}

const currentRuntime = (): McpRuntime => ({
  electron: process.versions.electron,
  execPath: process.execPath,
  appImage: process.env.APPIMAGE,
});

/**
 * How Claude Code should launch `mcp.mjs`.
 *
 * `node` from `PATH`, except under the desktop app. There the daemon client lives
 * inside `app.asar`, which plain Node cannot read, so the server runs on the
 * runtime this plugin is itself running on — Electron in node mode, the same way
 * the app launches its bundled `paseo` CLI. An AppImage mounts at a fresh path on
 * every launch, so its stable `$APPIMAGE` stands in for the mounted executable.
 */
export function mcpDefinition(pluginDir: string, runtime: McpRuntime = currentRuntime(), script?: string): McpDefinition {
  const args = [script ?? join(pluginDir, "mcp.mjs")];
  if (runtime.electron === undefined) return { type: "stdio", command: "node", args };
  return {
    type: "stdio",
    command: runtime.appImage ?? runtime.execPath,
    args,
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

/**
 * Registers the agent-facing MCP server, through Claude Code's own CLI.
 *
 * `~/.claude.json` is where the MCP list lives, and it is also where credentials
 * live, so this plugin does not write it: `claude mcp add-json` does, which keeps
 * us out of a file we have no business editing. Only ever called when the server is
 * absent or points at an older installation path. Managed npm and Git updates
 * install into a new directory, so an entry can exist while its script no longer
 * does.
 */
export function mcpPointsAtPlugin(output: string, definition: McpDefinition): boolean {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  return lines.includes("Scope: User config (available in all your projects)")
    && lines.includes(`Command: ${definition.command}`)
    && lines.includes(`Args: ${definition.args.join(" ")}`)
    && Object.entries(definition.env ?? {}).every(([key, value]) => lines.includes(`${key}=${value}`));
}

async function ensureMcp(pluginDir: string): Promise<InstallReport["mcp"]> {
  const run = (args: string[]): Promise<{ stdout: string }> =>
    execFileAsync("claude", args, { timeout: 20_000, maxBuffer: 1024 * 1024 });
  const definition = mcpDefinition(pluginDir);

  let existing = false;
  try {
    const { stdout } = await run(["mcp", "get", "smart-session"]);
    if (mcpPointsAtPlugin(stdout, definition)) return "present";
    existing = true;
  } catch {
    // Absent, or no `claude` on PATH. The add below tells the two apart.
  }

  try {
    if (existing) await run(["mcp", "remove", "smart-session", "--scope", "user"]);
    await run(["mcp", "add-json", "--scope", "user", "smart-session", JSON.stringify(definition)]);
    return existing ? "updated" : "added";
  } catch {
    // No `claude` binary on the daemon's PATH is the usual reason, and it is not
    // an error worth failing a plugin load over.
    return "unavailable";
  }
}

/**
 * Reconciles one Claude Code settings file: only our entries change, a malformed file is left
 * alone, and an unchanged file is not written. `create`: write the file when it doesn't exist.
 */
async function reconcileFile(path: string, shims: string | null, create: boolean): Promise<{ changed: boolean; error: string | null }> {
  let raw = "";
  let parsed: Record<string, unknown> = {};
  try {
    raw = await readFile(path, "utf8");
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // Malformed settings are not ours to repair, and rewriting them from a
      // partial parse would lose whatever the user has in there.
      return { changed: false, error: `${path} is not valid JSON, so it was left alone. Fix it and reload the plugin.` };
    }
    if (!create) return { changed: false, error: null };
  }

  const before = (parsed.hooks ?? {}) as HookMap;
  const after = reconcile(before, shims);
  const merged = { ...parsed, hooks: after };
  if (Object.keys(after).length === 0) delete (merged as { hooks?: unknown }).hooks;

  const text = `${JSON.stringify(merged, null, 2)}\n`;
  const changed = text !== raw;
  if (changed) {
    if (raw !== "") await backupOnce(path);
    await writeAtomic(path, text);
  }
  return { changed, error: null };
}

/**
 * The settings.json of every ZeroSub account home that has one of its own, by real path, minus
 * `main`. A home whose file is still a symlink to `main` resolves to it and is skipped, so the
 * symlink is never replaced by a copy.
 */
export async function zerosubSettingsFiles(main: string, paseoHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo")): Promise<string[]> {
  const mainReal = await realpath(main).catch(() => main);
  const homes = join(paseoHome, "zerosub", "homes");
  const found = new Set<string>();
  for (const entry of await readdir(homes, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const real = await realpath(join(homes, entry.name, "settings.json")).catch(() => null);
    if (real !== null && real !== mainReal && (await stat(real).catch(() => null))?.isFile()) found.add(real);
  }
  return [...found];
}

let tail: Promise<unknown> = Promise.resolve();

/** One writer at a time: this is read-modify-write over a file we do not own. */
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  tail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Brings Claude Code's configuration in line with this plugin's settings.
 *
 * Safe to call on every load and after every settings change: with nothing to do it
 * reads two files and writes none.
 */
export function install(options: { registerMcp?: boolean } = {}): Promise<InstallReport> {
  const registerMcp = options.registerMcp === true;
  return serialize(async () => {
    const path = settingsPath();
    const settings = await readSettings();
    // Resolved and pointed at whether or not hooks are installed: the stdio MCP server
    // and the bridge the asks name run through the same shims.
    const resolved = await resolvePluginDir();
    let shims: string | null = null;
    if (resolved !== null) {
      try {
        shims = (await pointShimsAt(resolved)).dir;
      } catch (error) {
        return {
          pluginDir: resolved,
          settingsPath: path,
          changed: false,
          hooks: [],
          mcp: "skipped",
          error: `Could not write the hook shims into Smart Session's data directory (${(error as NodeJS.ErrnoException).code ?? "error"}), so no hooks were installed.`,
        };
      }
    }
    const pluginDir = settings.installHooks ? resolved : null;

    if (settings.installHooks && pluginDir === null) {
      return {
        pluginDir: null,
        settingsPath: path,
        changed: false,
        hooks: [],
        mcp: "skipped",
        error:
          "Could not find this plugin's hooks/ directory from Paseo's config.json, so no hooks were installed. Set SMART_SESSION_PLUGIN_DIR to the checkout if the plugin runs from somewhere unusual.",
      };
    }

    const main = await reconcileFile(path, pluginDir === null ? null : shims, true);
    if (main.error !== null) {
      return { pluginDir, settingsPath: path, changed: false, hooks: [], mcp: "skipped", error: main.error };
    }
    // ZeroSub's account homes each have their own settings.json once anything rewrote the symlink
    // it starts as, and their sessions read only that one. Same rules; never created there.
    let changed = main.changed;
    for (const extra of await zerosubSettingsFiles(path)) {
      const result = await reconcileFile(extra, pluginDir === null ? null : shims, false).catch(() => ({ changed: false, error: null }));
      changed ||= result.changed;
    }

    const lines = pluginDir === null
      ? []
      : MANAGED.map(({ event, matcher }) => `${event}${matcher === "" ? "" : `:${matcher}`}`);

    return {
      pluginDir,
      settingsPath: path,
      changed,
      hooks: lines,
      mcp: pluginDir === null ? "skipped" : !registerMcp ? "session" : await ensureMcp(pluginDir),
      error: null,
    };
  });
}

/**
 * Points the shims at the running install, if they do not already point at one that
 * still exists. Cheap enough for a timer: when the pointer is healthy it stats a handful
 * of files and writes nothing. When it moves, the hooks are reconciled too (which writes
 * `settings.json` only if that changes anything). Returns whether the pointer moved.
 */
export async function refreshPointer(): Promise<boolean> {
  // The load-time install() already pointed the shims at the running version; this only
  // repairs a pointer whose target has since gone (or a shim someone deleted).
  if (await pointerHealthy()) return false;
  const dir = await resolvePluginDir();
  if (dir === null) return false;
  const { moved } = await pointShimsAt(dir);
  if (moved) await install();
  return moved;
}
