/**
 * A path to this plugin's scripts that survives updates.
 *
 * Paseo installs every npm or Git update into a fresh directory and deletes the old one.
 * Claude Code's hook commands and the stdio MCP server are absolute paths, so anything
 * written against an install directory breaks the moment that directory goes: on
 * 2026-11-09 the 3.6.0 update registered the hooks against the 3.5 directory seconds
 * before Paseo removed it, and every hook failed with MODULE_NOT_FOUND for hours.
 *
 * So nothing outside the plugin names an install directory any more. Small shims live in
 * the fixed data directory (`plugin-data/smart-session/hooks/`), and each one reads
 * `current.json` beside it to find the install it should run. The plugin rewrites that
 * pointer on every load and checks it on a slow timer. A shim whose target is missing
 * exits 0 without a word: a hook that fails would fail every turn of every session.
 */

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { dataDir } from "./store.ts";

/** The runtime this plugin runs on, as `install.ts` registers the MCP server on it. */
export interface McpRuntime {
  electron: string | undefined;
  execPath: string;
  appImage: string | undefined;
}

export const currentRuntime = (): McpRuntime => ({
  electron: process.versions.electron,
  execPath: process.execPath,
  appImage: process.env.APPIMAGE,
});

/** A command plus the environment it needs, to run a script on the runtime that can reach the daemon. */
export interface Launcher {
  command: string;
  env: Record<string, string>;
}

/**
 * The runtime a script must run on to load Paseo's daemon client, or null for plain `node`.
 *
 * Under the desktop app the client lives inside `app.asar`, which only Electron reads, so scripts run on the app's
 * own Electron runtime in node mode, the way the app launches its bundled `paseo` CLI. An AppImage mounts at a fresh
 * path on every launch, so its stable `$APPIMAGE` stands in for the mounted executable. `mcpDefinition` registers the
 * MCP server with exactly this, and the pointer records it for the shims and the bridge notice.
 */
export function launcherFor(runtime: McpRuntime): Launcher | null {
  if (runtime.electron === undefined) return null;
  return { command: runtime.appImage ?? runtime.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** The scripts that get a shim: the hooks, and the agent-facing MCP server. */
export const SHIMMED = ["context-threshold.mjs", "ask-compact.mjs", "post-compact.mjs", "publish-as.mjs", "detached.mjs", "mcp.mjs"] as const;
export type Shimmed = (typeof SHIMMED)[number];

/**
 * The shimmed scripts that call the Paseo daemon (`server/hooklib/daemon.mjs`). Started under plain `node` while the
 * pointer records an Electron runtime (the desktop app), their shim runs them on that runtime instead: an agent's
 * bridge call typed as `node .../mcp.mjs call ...`, and the `publish-as` hook, which Claude Code starts with `node`.
 * The other hooks never reach the daemon and stay in-process, so the hot `PostToolUse` path starts no second process.
 */
export const NEEDS_DAEMON: readonly Shimmed[] = ["mcp.mjs", "publish-as.mjs"];

/** Where each script lives inside an install. */
export function scriptIn(pluginDir: string, script: Shimmed): string {
  return script === "mcp.mjs" ? join(pluginDir, "mcp.mjs") : join(pluginDir, "hooks", script);
}

/** The stable directory the shims and their pointer live in. */
export function shimDir(): string {
  return join(dataDir(), "hooks");
}

export function pointerPath(): string {
  return join(shimDir(), "current.json");
}

/**
 * The shim itself. Dependency-free, and it never fails: an unreadable pointer, a missing
 * target, or a target that disappears between the check and the import all end in a
 * silent exit 0. The real script runs in this same process through `import()`, so it
 * keeps its own `import.meta.url` (and with it its siblings) and the hot `PostToolUse`
 * path pays for no second Node start. A script in `NEEDS_DAEMON` started under plain
 * `node` while the pointer records an Electron runtime runs on that runtime instead, with
 * the same arguments, stdin, stdout and exit code; if that runtime can't start it runs
 * here as before.
 */
export function shimSource(script: Shimmed): string {
  const relative = script === "mcp.mjs" ? ["mcp.mjs"] : ["hooks", script];
  const reexec = NEEDS_DAEMON.includes(script);
  const spawnImport = reexec ? `import { spawnSync } from "node:child_process";\n` : "";
  const runtimeDecl = reexec ? "let runtime = null;\n" : "";
  const runtimeRead = reexec ? `  if (typeof pointer.runtime?.command === "string" && pointer.runtime.command !== "") runtime = pointer.runtime;\n` : "";
  const runtimeRun = reexec
    ? `// Plain node can't load the desktop app's daemon client (inside app.asar): run on the app's runtime instead.
// SMART_SESSION_ON_RUNTIME marks the second start, so a runtime that isn't Electron after all can't loop.
if (runtime !== null && process.versions.electron === undefined && process.env.SMART_SESSION_ON_RUNTIME !== "1" && existsSync(runtime.command)) {
  const env = { ...process.env, ...(runtime.env !== null && typeof runtime.env === "object" ? runtime.env : {}), SMART_SESSION_ON_RUNTIME: "1" };
  const child = spawnSync(runtime.command, [target, ...process.argv.slice(2)], { stdio: "inherit", env });
  if (child.error === undefined) process.exit(child.status ?? 1);
}
`
    : "";
  return `#!/usr/bin/env node
// Written by the Smart Session Paseo plugin, rewritten on every load. Do not edit.
// Runs ${script} from the install named in current.json, or exits 0 if there is none.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
${spawnImport}
let target = null;
${runtimeDecl}try {
  const pointer = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "current.json"), "utf8"));
  const dir = pointer.dir;
  const candidate = typeof dir === "string" && dir !== "" ? join(dir, ...${JSON.stringify(relative)}) : null;
  if (candidate !== null && existsSync(candidate)) target = candidate;
${runtimeRead}} catch {}
if (target === null) process.exit(0);
${runtimeRun}try {
  await import(pathToFileURL(target).href);
} catch {
  process.exit(0);
}
`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeIfChanged(path: string, text: string): Promise<boolean> {
  const current = await readFile(path, "utf8").catch(() => null);
  if (current === text) return false;
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, text, "utf8");
  await rename(temp, path);
  return true;
}

/** The install directory the pointer names, or null when there is no readable pointer. */
export async function readPointer(): Promise<string | null> {
  try {
    const { dir } = JSON.parse(await readFile(pointerPath(), "utf8")) as { dir?: unknown };
    return typeof dir === "string" && dir !== "" ? dir : null;
  } catch {
    return null;
  }
}

/** Whether every shimmed script exists in that install. */
export async function complete(pluginDir: string): Promise<boolean> {
  const found = await Promise.all(SHIMMED.map((script) => exists(scriptIn(pluginDir, script))));
  return found.every(Boolean);
}

/**
 * Writes the shims and points them at `pluginDir`. Touches nothing that is already
 * right, so the common case (every load after the first) reads five small files and
 * writes none. Returns the shim directory, and whether the pointer moved.
 *
 * The pointer also records the runtime that can reach the daemon (`launcherFor`, the one
 * the MCP server is registered on), when it isn't plain `node`: the shims of `NEEDS_DAEMON`
 * and the detached-tools notice (`bridgeCommand` in `server/hooklib/context.mjs`) read it.
 */
export async function pointShimsAt(pluginDir: string, runtime: McpRuntime = currentRuntime()): Promise<{ dir: string; moved: boolean }> {
  const dir = shimDir();
  await mkdir(dir, { recursive: true });
  for (const script of SHIMMED) await writeIfChanged(join(dir, script), shimSource(script));
  const launcher = launcherFor(runtime);
  const moved = await writeIfChanged(pointerPath(), `${JSON.stringify(launcher === null ? { dir: pluginDir } : { dir: pluginDir, runtime: launcher })}\n`);
  return { dir, moved };
}

/** The stable path of one shim (whether or not it has been written yet). */
export function shimFor(script: Shimmed): string {
  return join(shimDir(), script);
}

/**
 * The cheap check the timer runs: true when the pointer names an install that still has
 * its scripts and every shim is in place. Stats only; reads and writes nothing else.
 */
export async function pointerHealthy(): Promise<boolean> {
  const dir = await readPointer();
  if (dir === null) return false;
  const shims = await Promise.all(SHIMMED.map((script) => exists(shimFor(script))));
  return shims.every(Boolean) && (await complete(dir));
}
