/**
 * The runtime that can reach the Paseo daemon, as the shims' pointer records it (`pointShimsAt` in
 * `server/hook-path.ts`), and the command that runs a script on it. Dependency-free, like the hooks.
 *
 * Under the desktop app Paseo's daemon client lives inside `app.asar`, which plain `node` can't read, so the plugin
 * registers its MCP server on the app's Electron in node mode (`ELECTRON_RUN_AS_NODE=1`, `mcpDefinition` in
 * `server/install.ts`). Anything that tells an agent or a person how to run `mcp.mjs` by hand says the same.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { pluginDir } from "./pointer.mjs";

/** A shell word, single-quoted so nothing in it expands (a path with a space, `$` or a quote stays one word). */
export const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

/** The recorded runtime, `{ command, env }`, or null for plain `node` (nothing recorded, or that runtime is gone). */
export function recordedRuntime(dir = pluginDir()) {
  let runtime;
  try {
    runtime = JSON.parse(readFileSync(join(dir, "hooks", "current.json"), "utf8"))?.runtime;
  } catch {
    return null;
  }
  if (typeof runtime?.command !== "string" || runtime.command === "" || !existsSync(runtime.command)) return null;
  const env = runtime.env !== null && typeof runtime.env === "object" ? runtime.env : {};
  return {
    command: runtime.command,
    env: Object.fromEntries(Object.entries(env).filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string")),
  };
}

/** The command that runs `script` for a POSIX shell: on the recorded runtime, or `node` when there is none. */
export function bridgeCommand(script, runtime = recordedRuntime()) {
  if (runtime === null) return `node ${quote(script)}`;
  const env = Object.entries(runtime.env).map(([key, value]) => `${key}=${/^[A-Za-z0-9_.-]+$/.test(value) ? value : quote(value)}`);
  return [...env, quote(runtime.command), quote(script)].join(" ");
}
