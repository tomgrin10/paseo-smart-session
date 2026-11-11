/**
 * Reaching the Paseo daemon from a script Claude Code runs (`mcp.mjs`, `hooks/publish-as.mjs`), with
 * no module graph of its own. Dependency-free, like the hooks.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveDaemonPassword } from "../daemon-password.mjs";

const PLUGIN_ID = "smart-session";

/**
 * Paseo's daemon client, loaded only when something actually needs it.
 *
 * A top-level import would make this whole server fail to start wherever
 * `@getpaseo/client` cannot be resolved — which is every Claude Code session that
 * is not a Paseo agent, since the plugin ships with no installed dependencies. The
 * tools that need it are already hidden outside Paseo by `availableTools()`; this
 * makes the ones that do not need it work there too.
 *
 * This process is spawned directly by Claude Code from the plugin's own checkout,
 * not by Paseo, so unlike `server/daemon.ts` it has no module graph to borrow from
 * and a bare specifier resolves only in a dev checkout with `node_modules`
 * installed. On a managed Git install the fallback instead finds the `paseo` CLI
 * on `PATH` and resolves the client from its own installed dependencies — the
 * same package the running daemon was built with.
 *
 * The desktop app is the exception. Its client lives inside `app.asar`, which
 * only Electron can read, and its `paseo` is a shell wrapper with no
 * `node_modules` beside it. `server/install.ts` therefore registers this server
 * to run on the app's own Electron runtime in node mode, and from there the
 * client resolves through `process.resourcesPath`.
 */
let daemonClientModule = null;

const CLIENT_SPECIFIER = ["@getpaseo", "client", "internal", "daemon-client"].join("/");

export async function loadDaemonClient() {
  if (daemonClientModule !== null) return daemonClientModule;
  const failures = [];
  for (const { label, resolve } of clientCandidates()) {
    try {
      daemonClientModule = await import(resolve());
      return daemonClientModule;
    } catch (error) {
      failures.push(`${label} (${error.message})`);
    }
  }
  throw new Error(`Cannot resolve ${CLIENT_SPECIFIER} ${failures.join(" or ")}${desktopHint()}`);
}

/** Every place the client can come from, cheapest first. */
function clientCandidates() {
  const fromEntry = (entry) => () => pathToFileURL(createRequire(entry).resolve(CLIENT_SPECIFIER)).href;
  const candidates = [{ label: "directly", resolve: () => CLIENT_SPECIFIER }];
  // Set only under Electron, where the bundled CLI inside app.asar is readable.
  if (typeof process.resourcesPath === "string") {
    const entry = join(process.resourcesPath, "app.asar", "node_modules", "@getpaseo", "cli", "dist", "index.js");
    candidates.push({ label: `from the Paseo app bundle at ${process.resourcesPath}`, resolve: fromEntry(entry) });
  }
  const cliPath = findPaseoCli();
  if (cliPath !== null) candidates.push({ label: `via the paseo CLI at ${cliPath}`, resolve: fromEntry(cliPath) });
  return candidates;
}

/** Explains the one failure a person can fix without reading the code. */
function desktopHint() {
  if (process.versions.electron !== undefined) return "";
  const cliPath = findPaseoCli();
  if (cliPath === null || !existsSync(join(dirname(cliPath), "..", "app.asar"))) return "";
  return ". The paseo CLI is the desktop app's, whose client only its own runtime can load: reload the smart-session plugin so it re-registers this MCP server on that runtime, then restart the Claude Code session";
}

/** Finds `paseo` on PATH and resolves symlinks, the way a shell's `which` would. */
function findPaseoCli() {
  const name = process.platform === "win32" ? "paseo.cmd" : "paseo";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      statSync(candidate);
      return realpathSync(candidate);
    } catch {
      // Not here; keep looking.
    }
  }
  return null;
}

function daemonUrl() {
  if (process.env.PASEO_DAEMON_URL) return process.env.PASEO_DAEMON_URL;
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  try {
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    if (typeof config.daemon?.listen === "string") return `ws://${config.daemon.listen}/ws`;
  } catch { /* Use the documented default when configuration is absent. */ }
  return "ws://127.0.0.1:6767/ws";
}

export async function callPlugin(method, input) {
  const { DaemonClient } = await loadDaemonClient();
  const password = await resolveDaemonPassword();
  const client = new DaemonClient({
    url: daemonUrl(),
    clientId: process.env.SMART_SESSION_CLIENT_ID ?? "smart-session-mcp",
    clientType: "cli",
    reconnect: { enabled: false },
    connectTimeoutMs: 10_000,
    suppressSendErrors: true,
    ...(password === undefined ? {} : { password }),
  });
  await client.connect();
  try {
    return await client.invokePluginRpc(PLUGIN_ID, method, input);
  } finally {
    try {
      await client.close();
    } catch {
      /* Teardown must not mask the result. */
    }
  }
}

