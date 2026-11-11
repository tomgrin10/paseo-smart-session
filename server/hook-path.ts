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

/** The scripts that get a shim: the hooks, and the agent-facing MCP server. */
export const SHIMMED = ["context-threshold.mjs", "ask-compact.mjs", "post-compact.mjs", "publish-as.mjs", "mcp.mjs"] as const;
export type Shimmed = (typeof SHIMMED)[number];

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
 * path pays for no second Node start.
 */
export function shimSource(script: Shimmed): string {
  const relative = script === "mcp.mjs" ? ["mcp.mjs"] : ["hooks", script];
  return `#!/usr/bin/env node
// Written by the Smart Session Paseo plugin, rewritten on every load. Do not edit.
// Runs ${script} from the install named in current.json, or exits 0 if there is none.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let target = null;
try {
  const { dir } = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "current.json"), "utf8"));
  const candidate = typeof dir === "string" && dir !== "" ? join(dir, ...${JSON.stringify(relative)}) : null;
  if (candidate !== null && existsSync(candidate)) target = candidate;
} catch {}
if (target === null) process.exit(0);
try {
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
 */
export async function pointShimsAt(pluginDir: string): Promise<{ dir: string; moved: boolean }> {
  const dir = shimDir();
  await mkdir(dir, { recursive: true });
  for (const script of SHIMMED) await writeIfChanged(join(dir, script), shimSource(script));
  const moved = await writeIfChanged(pointerPath(), `${JSON.stringify({ dir: pluginDir })}\n`);
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
