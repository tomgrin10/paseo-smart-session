/**
 * Recognising the standalone `paseo-session-guard` plugin among the daemon's plugins.
 *
 * Sharing its lock keeps the two plugins from pausing a session twice, but it does not
 * cover the standalone plugin's teardown: released versions call `engine.stop()` on
 * disable or uninstall whether or not they hold the lock, which resumes every
 * suspended session in `state.json` and rewrites the file. Those versions cannot be
 * changed, so Smart Session refuses to govern at all while the standalone plugin is
 * configured and enabled. A disabled one has already run that teardown and is safe.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const STANDALONE_ID = "paseo-session-guard";

/** The fields of the daemon's plugin listing this reads; older daemons omit some. */
export interface ListedPlugin {
  readonly id: string;
  readonly path?: string;
  readonly enabled: boolean;
  readonly remote?: string;
  readonly npm?: { readonly packageName?: string };
}

type ReadText = (path: string) => Promise<string>;
const readText: ReadText = (path) => readFile(path, "utf8");

async function readJson(read: ReadText, path: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await read(path)) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Whether one listed plugin is the standalone Session Guard.
 *
 * The install id can be anything (`--id`), so the manifest and package name in its
 * directory are checked too, along with the npm package and Git remote the daemon
 * recorded.
 */
export async function isStandalone(plugin: ListedPlugin, read: ReadText = readText): Promise<boolean> {
  if (plugin.id === STANDALONE_ID || plugin.npm?.packageName === STANDALONE_ID) return true;
  if (plugin.remote !== undefined && /[/:]paseo-session-guard(\.git)?\/?$/i.test(plugin.remote)) return true;
  if (!plugin.path) return false;
  const manifest = await readJson(read, join(plugin.path, "paseo-plugin.json"));
  if (manifest?.id === STANDALONE_ID) return true;
  const pkg = await readJson(read, join(plugin.path, "package.json"));
  return pkg?.name === STANDALONE_ID;
}

/** Whether any configured, enabled plugin is the standalone Session Guard. */
export async function standaloneEnabled(plugins: readonly ListedPlugin[], read: ReadText = readText): Promise<boolean> {
  for (const plugin of plugins) {
    if (plugin.enabled && (await isStandalone(plugin, read))) return true;
  }
  return false;
}
