/**
 * Invariant: every way an agent or a hook runs a daemon-backed script reaches the daemon on the desktop app.
 *
 * Root cause (3.7.0, issue 44): a detached session was told to run the bridge as `node "<shim>/mcp.mjs" call ...`.
 * On the Paseo desktop app plain node can't load `@getpaseo/client` (it lives inside `app.asar`), so every tool that
 * calls the daemon failed through the bridge, in exactly the situation the bridge exists for. The `publish-as` hook,
 * which Claude Code starts with `node`, failed the same way. `install.ts` already ran the MCP server on the app's
 * Electron runtime with `ELECTRON_RUN_AS_NODE=1`; nothing else did.
 *
 * Here a fake app layout stands in for the real one: `Resources/bin/paseo` is a shell wrapper, the client is a stub
 * under `Resources/app.asar` that throws a sentinel once reached, and "Paseo Helper" is a shell script that refuses to
 * run unless `ELECTRON_RUN_AS_NODE=1` and then runs node with `process.resourcesPath` and `process.versions.electron`
 * set, the two things Electron adds that these scripts read. The app folder's name has a space and a quote, so the printed command must quote properly.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import { mcpDefinition } from "./server/install.ts";
// @ts-expect-error -- a dependency-free hook module with no type declarations.
import { bridgeCommand, detachedNotice, recordedRuntime } from "./server/hooklib/context.mjs";

const REPO = import.meta.dirname;
const SENTINEL = "CHECK_SENTINEL_CONNECT_REACHED";

/** A stub `@getpaseo/client` under `root` that proves it was reached. */
function stubClient(root: string) {
  const pkg = join(root, "node_modules", "@getpaseo", "client");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@getpaseo/client", type: "module", exports: { "./internal/daemon-client": { default: "./dist/daemon-client.js" } } }));
  writeFileSync(join(pkg, "dist", "daemon-client.js"), `export class DaemonClient { constructor(o) { this.url = o.url; } async connect() { throw new Error("${SENTINEL}:" + this.url); } async close() {} }\n`);
}

function desktopBox() {
  const root = mkdtempSync(join(tmpdir(), "ss-bridge-runtime-"));
  const home = join(root, "paseo");
  // What an npm install ships of the agent-facing scripts; no node_modules, so plain node can't find the client.
  const install = join(home, "plugins", "smart-session", "i1", "node_modules", "paseo-smart-session");
  mkdirSync(join(install, "server"), { recursive: true });
  for (const name of ["mcp.mjs", "hooks", "server/daemon-password.mjs", "server/agent-tools.mjs", "server/hooklib"]) cpSync(join(REPO, name), join(install, name), { recursive: true });
  writeFileSync(join(install, "package.json"), JSON.stringify({ name: "paseo-smart-session", type: "module" }));

  const app = join(root, "it's Paseo.app", "Contents");
  const resources = join(app, "Resources");
  mkdirSync(join(resources, "bin"), { recursive: true });
  writeFileSync(join(resources, "bin", "paseo"), "#!/bin/sh\n");
  chmodSync(join(resources, "bin", "paseo"), 0o755);
  const asar = join(resources, "app.asar");
  mkdirSync(join(asar, "node_modules", "@getpaseo", "cli", "dist"), { recursive: true });
  writeFileSync(join(asar, "node_modules", "@getpaseo", "cli", "dist", "index.js"), "");
  stubClient(asar);

  const helperDir = join(app, "Frameworks", "Paseo Helper.app", "Contents", "MacOS");
  mkdirSync(helperDir, { recursive: true });
  const helper = join(helperDir, "Paseo Helper");
  const starts = join(root, "helper-starts.log");
  // What Electron adds that the scripts read: `process.resourcesPath` (daemon.mjs) and `process.versions.electron` (the shim).
  const asElectron = `data:text/javascript,${encodeURIComponent(`process.resourcesPath=${JSON.stringify(resources)};Object.defineProperty(process.versions,"electron",{value:"44.2.0",enumerable:true});`)}`;
  const sq = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  writeFileSync(helper, [
    "#!/bin/sh",
    `[ "$ELECTRON_RUN_AS_NODE" = 1 ] || { echo "not in node mode" >&2; exit 97; }`,
    `printf '%s\\n' "$1" >> ${sq(starts)}`,
    `exec ${sq(process.execPath)} --import ${sq(asElectron)} "$@"`,
    "",
  ].join("\n"));
  chmodSync(helper, 0o755);

  const env: NodeJS.ProcessEnv = { ...process.env, PASEO_HOME: home, PATH: [join(resources, "bin"), ...(process.env.PATH ?? "").split(delimiter)].join(delimiter) };
  for (const key of ["PASEO_AGENT_ID", "PASEO_DAEMON_URL", "PASEO_PASSWORD", "PASEO_PASSWORD_FILE", "ELECTRON_RUN_AS_NODE", "SMART_SESSION_ON_RUNTIME"]) delete env[key];
  const shims = join(home, "plugin-data", "smart-session", "hooks");
  const started = () => (existsSync(starts) ? readFileSync(starts, "utf8").trim().split("\n") : []);
  return { root, home, install, helper, env, shims, started };
}

async function point(box: ReturnType<typeof desktopBox>, electron: string | undefined) {
  process.env.PASEO_HOME = box.home;
  const paths = (await import(`./server/hook-path.ts?box=${encodeURIComponent(box.root)}`)) as typeof import("./server/hook-path.ts");
  await paths.pointShimsAt(box.install, { electron, execPath: electron === undefined ? process.execPath : box.helper, appImage: undefined });
  return paths;
}

const run = (box: ReturnType<typeof desktopBox>, args: string[], input = "") =>
  spawnSync(process.execPath, args, { env: box.env, input, encoding: "utf8", timeout: 20_000 });

test("the pointer records the runtime the MCP server is registered on, and only under the desktop app", async () => {
  const box = desktopBox();
  await point(box, "44.2.0");
  const pointer = JSON.parse(readFileSync(join(box.shims, "current.json"), "utf8"));
  const registered = mcpDefinition(box.install, { electron: "44.2.0", execPath: box.helper, appImage: undefined });
  assert.deepEqual(pointer.runtime, { command: registered.command, env: registered.env }, "the same runtime and env as the MCP registration");
  assert.deepEqual(recordedRuntime(join(box.home, "plugin-data", "smart-session")), pointer.runtime);

  await point(box, undefined);
  assert.equal(JSON.parse(readFileSync(join(box.shims, "current.json"), "utf8")).runtime, undefined, "plain node records nothing");
  assert.equal(recordedRuntime(join(box.home, "plugin-data", "smart-session")), null);
});

test("on the desktop app the bridge reaches the daemon however it is typed", async () => {
  const box = desktopBox();
  const paths = await point(box, "44.2.0");
  const bridge = paths.shimFor("mcp.mjs");

  // The command the detached notice prints, run by a shell exactly as written.
  const runtime = recordedRuntime(join(box.home, "plugin-data", "smart-session"));
  const notice = detachedNotice(bridge, runtime) as string;
  const printed = bridgeCommand(bridge, runtime) as string;
  assert.ok(notice.includes(`${printed} call <tool> '<json>'`));
  assert.ok(printed.startsWith("ELECTRON_RUN_AS_NODE=1 '"), printed);
  const viaShell = spawnSync("/bin/sh", ["-c", `${printed} call budget_status '{}'`], { env: box.env, encoding: "utf8", timeout: 20_000 });
  assert.match(viaShell.stderr, new RegExp(SENTINEL), "the printed command reaches the daemon client");

  // An agent that types `node <shim>` from memory: the shim runs it on the app's runtime instead.
  const typed = run(box, [bridge, "call", "budget_status", "{}"]);
  assert.match(typed.stderr, new RegExp(SENTINEL));
  assert.equal(typed.status, 1, "the bridge's own exit code comes through");
  assert.equal(run(box, [bridge, "call", "no_such_tool", "{}"]).status, 2);

  // The stdio server through the shim: stdin and stdout pass through.
  const stdio = run(box, [bridge], `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "budget_status", arguments: {} } })}\n`);
  assert.match(stdio.stdout, new RegExp(SENTINEL));
  assert.equal(box.started().length, 4, "each start went through the app's runtime once");
});

test("on the desktop app the publish-as hook runs on the app's runtime, and the other hooks stay in-process", async () => {
  const box = desktopBox();
  const paths = await point(box, "44.2.0");
  assert.equal(run(box, [paths.shimFor("publish-as.mjs")], "{}").status, 0);
  assert.deepEqual(box.started(), [join(box.install, "hooks", "publish-as.mjs")]);
  for (const script of ["context-threshold.mjs", "ask-compact.mjs", "post-compact.mjs", "detached.mjs"] as const) {
    assert.doesNotMatch(paths.shimSource(script), /spawnSync/, script);
  }
});

test("without the desktop app, or once its runtime is gone, the bridge is plain node", async () => {
  const box = desktopBox();
  const paths = await point(box, undefined);
  const bridge = paths.shimFor("mcp.mjs");
  assert.equal(bridgeCommand(bridge, recordedRuntime(join(box.home, "plugin-data", "smart-session"))), `node '${bridge}'`);
  // Plain node can't reach the app's client: the failure names the fix.
  const plain = run(box, [bridge, "call", "budget_status", "{}"]);
  assert.match(plain.stderr, /Cannot resolve @getpaseo\/client/);
  assert.match(plain.stderr, /Reload the smart-session plugin/);
  assert.deepEqual(box.started(), []);

  // A recorded runtime that no longer exists (the app moved) falls back to running in-process.
  writeFileSync(join(box.shims, "current.json"), JSON.stringify({ dir: box.install, runtime: { command: join(box.root, "gone"), env: { ELECTRON_RUN_AS_NODE: "1" } } }));
  assert.equal(recordedRuntime(join(box.home, "plugin-data", "smart-session")), null);
  assert.match(run(box, [bridge, "call", "budget_status", "{}"]).stderr, /Cannot resolve @getpaseo\/client/);
});

test("paths with spaces, quotes and dollars stay one shell word", () => {
  const runtime = { command: "/Apps/it's $HOME/Paseo Helper", env: { ELECTRON_RUN_AS_NODE: "1" } };
  const printed = bridgeCommand("/data/a b/mcp.mjs", runtime) as string;
  assert.equal(printed, `ELECTRON_RUN_AS_NODE=1 '/Apps/it'\\''s $HOME/Paseo Helper' '/data/a b/mcp.mjs'`);
  const echoed = spawnSync("/bin/sh", ["-c", `set -- ${printed.replace(/^ELECTRON_RUN_AS_NODE=1 /, "")}; printf '%s\\n' "$@"`], { encoding: "utf8" });
  assert.deepEqual(echoed.stdout.trim().split("\n"), ["/Apps/it's $HOME/Paseo Helper", "/data/a b/mcp.mjs"]);
});

test("the bridge refuses arguments a tool doesn't take, rather than ignoring them", () => {
  const env: NodeJS.ProcessEnv = { ...process.env, PASEO_HOME: mkdtempSync(join(tmpdir(), "ss-bridge-args-")) };
  delete env.PASEO_AGENT_ID;
  const unknown = spawnSync(process.execPath, ["mcp.mjs", "call", "budget_status", '{"no_such_arg":true}'], { cwd: REPO, env, encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /budget_status has no argument no_such_arg\./);

  // `{"continue": false}` meant continue_after_compaction: ignoring it would compact and then start another turn.
  const misspelt = spawnSync(process.execPath, ["mcp.mjs", "call", "request_compaction", '{"reason":"done","continue":false}'], { cwd: REPO, env: { ...env, PASEO_AGENT_ID: "agent-a" }, encoding: "utf8" });
  assert.equal(misspelt.status, 2);
  assert.match(misspelt.stderr, /request_compaction has no argument continue\. Valid: reason, state_path, continue_after_compaction, continue_message\./);
  const missing = spawnSync(process.execPath, ["mcp.mjs", "call", "request_compaction", "{}"], { cwd: REPO, env: { ...env, PASEO_AGENT_ID: "agent-a" }, encoding: "utf8" });
  assert.match(missing.stderr, /request_compaction needs reason\./);

  // The stdio server answers the same as a tool error the model can read.
  const stdio = spawnSync(process.execPath, ["mcp.mjs"], { cwd: REPO, env, encoding: "utf8", input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "budget_status", arguments: { no_such_arg: true } } })}\n` });
  const answer = JSON.parse(stdio.stdout.trim().split("\n").at(-1)!);
  assert.equal(answer.result.isError, true);
  assert.match(answer.result.content[0].text, /no argument no_such_arg/);
});
