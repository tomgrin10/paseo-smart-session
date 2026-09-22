/**
 * Installing the agent-facing half of the plugin into Claude Code.
 *
 * The `Stop` hook is not a nice-to-have: it is the only thing that ever asks a
 * session whether to compact itself, so a Smart Session install without it does
 * nothing at all except record. Leaving that to a paragraph in a README meant the
 * feature was off for anyone who skimmed, and off in a way that looked like it was
 * working — the surface said "on", and nothing ever happened.
 *
 * Paseo cannot do this for us. Its plugin API contributes UI, commands, timeline
 * renderers and RPCs, and explicitly nothing about agent configuration — there is
 * no hook contribution and no way to set an agent's environment. So the plugin
 * reconciles the entries itself, in `~/.claude/settings.json`.
 *
 * The rules that make that acceptable:
 *
 *   - **Own only our own.** An entry is ours when its command points at a
 *     `hooks/*.mjs` in this repository. Nothing else in the file is read for
 *     meaning, reordered or rewritten.
 *   - **Never write a path that does not exist.** The plugin directory comes from
 *     Paseo's own `config.json` and is then checked for the scripts themselves. A
 *     hook command pointing at a missing file fails on every turn of every session.
 *   - **Write only on a real change.** Reconciling to identical JSON writes nothing,
 *     so the common case — every reload after the first — touches no files.
 *   - **Be reversible.** One backup, kept from the first modification, and turning
 *     `installHooks` off removes every entry we added.
 */

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

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
] as const;

/** Every script we might have written, including into an older install's path. */
const OUR_SCRIPTS = ["context-threshold.mjs", "ask-compact.mjs", "post-compact.mjs"];

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
  readonly mcp: "present" | "added" | "updated" | "unavailable" | "skipped";
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

/**
 * Where this plugin's files live, according to Paseo.
 *
 * Read from the host's own `config.json` rather than derived from the module's
 * location: Paseo compiles `index.server.ts` into a bundle whose path is an
 * implementation detail, and `import.meta` is not safe to rely on across that
 * compilation. Every configured plugin is checked rather than just `smart-session`,
 * because a second install under `--id something-else` is a supported thing to do.
 */
export async function resolvePluginDir(): Promise<string | null> {
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
    // No config, or one we cannot read. Fall through to the environment.
  }

  const fromEnv = process.env.SMART_SESSION_PLUGIN_DIR;
  const candidates = fromEnv !== undefined && fromEnv !== "" ? [fromEnv, ...configured] : configured;

  for (const candidate of candidates) {
    // The scripts themselves are the proof. A directory that merely has the right
    // name would still produce hook commands that fail on every turn.
    const complete = await Promise.all(
      OUR_SCRIPTS.map((script) => exists(join(candidate, "hooks", script))),
    );
    if (complete.every(Boolean)) return candidate;
  }
  return null;
}

/** Whether a hook command is one of ours, wherever it was installed from. */
function isOurs(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return OUR_SCRIPTS.some((script) => command.includes(`hooks/${script}`));
}

function commandFor(pluginDir: string, script: string): string {
  return `node ${join(pluginDir, "hooks", script)}`;
}

/**
 * The hook map this plugin wants, given the one already on disk.
 *
 * Every entry of ours is stripped first and then re-added, so a plugin that moved
 * directory or renamed a script leaves nothing stale behind — and so the manual
 * entries an early adopter added by hand are adopted rather than duplicated.
 */
export function reconcile(existing: HookMap, pluginDir: string | null): HookMap {
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

  if (pluginDir === null) return next;

  for (const { event, matcher, script } of MANAGED) {
    const groups = next[event] ?? [];
    const entry: HookEntry = {
      type: "command",
      command: commandFor(pluginDir, script),
      timeout: HOOK_TIMEOUT_SECONDS,
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
export function mcpPointsAtPlugin(output: string, pluginDir: string): boolean {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  return lines.includes("Scope: User config (available in all your projects)")
    && lines.includes("Command: node")
    && lines.includes(`Args: ${join(pluginDir, "mcp.mjs")}`);
}

async function ensureMcp(pluginDir: string): Promise<InstallReport["mcp"]> {
  const run = (args: string[]): Promise<{ stdout: string }> =>
    execFileAsync("claude", args, { timeout: 20_000, maxBuffer: 1024 * 1024 });

  let existing = false;
  try {
    const { stdout } = await run(["mcp", "get", "smart-session"]);
    if (mcpPointsAtPlugin(stdout, pluginDir)) return "present";
    existing = true;
  } catch {
    // Absent, or no `claude` on PATH. The add below tells the two apart.
  }

  const definition = JSON.stringify({
    type: "stdio",
    command: "node",
    args: [join(pluginDir, "mcp.mjs")],
  });
  try {
    if (existing) await run(["mcp", "remove", "smart-session", "--scope", "user"]);
    await run(["mcp", "add-json", "--scope", "user", "smart-session", definition]);
    return existing ? "updated" : "added";
  } catch {
    // No `claude` binary on the daemon's PATH is the usual reason, and it is not
    // an error worth failing a plugin load over.
    return "unavailable";
  }
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
  const registerMcp = options.registerMcp !== false;
  return serialize(async () => {
    const path = settingsPath();
    const settings = await readSettings();
    const pluginDir = settings.installHooks ? await resolvePluginDir() : null;

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
        return {
          pluginDir,
          settingsPath: path,
          changed: false,
          hooks: [],
          mcp: "skipped",
          error: `${path} is not valid JSON, so it was left alone. Fix it and reload the plugin.`,
        };
      }
    }

    const before = (parsed.hooks ?? {}) as HookMap;
    const after = reconcile(before, pluginDir);
    const merged = { ...parsed, hooks: after };
    if (Object.keys(after).length === 0) delete (merged as { hooks?: unknown }).hooks;

    const text = `${JSON.stringify(merged, null, 2)}\n`;
    const changed = text !== raw;
    if (changed) {
      if (raw !== "") await backupOnce(path);
      await writeAtomic(path, text);
    }

    const lines = pluginDir === null
      ? []
      : MANAGED.map(({ event, matcher }) => `${event}${matcher === "" ? "" : `:${matcher}`}`);

    return {
      pluginDir,
      settingsPath: path,
      changed,
      hooks: lines,
      mcp: pluginDir === null || !registerMcp ? "skipped" : await ensureMcp(pluginDir),
      error: null,
    };
  });
}
