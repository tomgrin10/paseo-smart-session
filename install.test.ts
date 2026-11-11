import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { commandFor, mcpDefinition, mcpPointsAtPlugin, reconcile } from "./server/install.ts";
import { PLUGIN_VERSION } from "./shared/version.ts";

const DIR = "/plugins/paseo-smart-session";
/** Where the stable shims live: Smart Session's data directory, never an install. */
const SHIMS = "/paseo/plugin-data/smart-session/hooks";
const cmd = (script: string, dir = SHIMS) => commandFor(dir, script);

/** A hook entry someone else owns, which must survive every reconciliation. */
const foreign = { type: "command", command: "/Users/x/.claude/hooks/paseo-hook.sh Stop", timeout: 10 };

function commandsFor(map: ReturnType<typeof reconcile>, event: string): string[] {
  return (map[event] ?? []).flatMap((group) => (group.hooks ?? []).map((hook) => hook.command ?? ""));
}

test("the MCP registration must point at the current managed install", () => {
  const current = [
    "smart-session:",
    "  Scope: User config (available in all your projects)",
    "  Status: ✔ Connected",
    "  Type: stdio",
    "  Command: node",
    `  Args: ${DIR}/mcp.mjs`,
  ].join("\n");
  const stale = current.replace(`${DIR}/mcp.mjs`, "/old/checkout/mcp.mjs");
  const definition = mcpDefinition(DIR, NODE_RUNTIME);

  assert.equal(mcpPointsAtPlugin(current, definition), true);
  assert.equal(mcpPointsAtPlugin(stale, definition), false);
  assert.equal(mcpPointsAtPlugin(current.replace("User config", "Local config"), definition), false);
});

const NODE_RUNTIME = { electron: undefined, execPath: "/usr/local/bin/node", appImage: undefined };
const HELPER = "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper";
const DESKTOP_RUNTIME = { electron: "44.0.0", execPath: HELPER, appImage: undefined };

test("under plain Node the MCP server runs on node from PATH", () => {
  assert.deepEqual(mcpDefinition(DIR, NODE_RUNTIME), { type: "stdio", command: "node", args: [`${DIR}/mcp.mjs`] });
});

test("under the desktop app the MCP server runs on the app's Electron in node mode", () => {
  // Plain node cannot read app.asar, where the desktop app keeps its daemon client.
  assert.deepEqual(mcpDefinition(DIR, DESKTOP_RUNTIME), {
    type: "stdio",
    command: HELPER,
    args: [`${DIR}/mcp.mjs`],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
  // The mount path of an AppImage changes every launch; $APPIMAGE does not.
  const appImage = { electron: "44.0.0", execPath: "/tmp/.mount_PaseoAb12/paseo", appImage: "/home/x/Paseo.AppImage" };
  assert.equal(mcpDefinition(DIR, appImage).command, "/home/x/Paseo.AppImage");
});

test("a node registration is stale once the plugin runs under the desktop app", () => {
  const nodeRegistration = [
    "  Scope: User config (available in all your projects)",
    "  Command: node",
    `  Args: ${DIR}/mcp.mjs`,
  ].join("\n");
  const desktopRegistration = [
    "  Scope: User config (available in all your projects)",
    `  Command: ${HELPER}`,
    `  Args: ${DIR}/mcp.mjs`,
    "  Environment:",
    "    ELECTRON_RUN_AS_NODE=1",
  ].join("\n");
  const desktop = mcpDefinition(DIR, DESKTOP_RUNTIME);

  assert.equal(mcpPointsAtPlugin(nodeRegistration, desktop), false);
  assert.equal(mcpPointsAtPlugin(desktopRegistration, desktop), true);
  // Without node mode the helper would start the app itself instead of a script.
  assert.equal(mcpPointsAtPlugin(desktopRegistration.replace("ELECTRON_RUN_AS_NODE=1", ""), desktop), false);
});

test("an empty settings file gains exactly the five managed entries", () => {
  const next = reconcile({}, SHIMS);
  assert.deepEqual(Object.keys(next).sort(), ["PostCompact", "PostToolUse", "PreToolUse", "SessionStart", "Stop"]);
  // Publishing as the main account runs a helper agent: Artifact only, with a long timeout.
  assert.deepEqual(commandsFor(next, "PreToolUse"), [cmd("publish-as.mjs")]);
  assert.equal(next.PreToolUse?.[0]?.matcher, "Artifact");
  assert.equal(next.PreToolUse?.[0]?.hooks?.[0]?.timeout, 180);
  assert.equal(next.Stop?.[0]?.hooks?.[0]?.timeout, 10);
  assert.deepEqual(commandsFor(next, "Stop"), [cmd("ask-compact.mjs")]);
  // The one that cannot inject and the one that can, same script, two events.
  assert.deepEqual(commandsFor(next, "PostCompact"), [cmd("post-compact.mjs")]);
  assert.deepEqual(commandsFor(next, "SessionStart"), [cmd("post-compact.mjs")]);
  assert.equal(next.SessionStart?.[0]?.matcher, "compact");
});

test("reconcile writes the guarded stable shim, never an install directory", () => {
  // Paseo deletes an install directory on every update, so a command naming one fails
  // on every turn of every session from the moment it does. The guard makes a missing
  // shim a silent no-op instead.
  const next = reconcile({}, SHIMS);
  assert.deepEqual(commandsFor(next, "PostToolUse"), [
    "if [ -f '/paseo/plugin-data/smart-session/hooks/context-threshold.mjs' ]; then node '/paseo/plugin-data/smart-session/hooks/context-threshold.mjs'; fi",
  ]);
  for (const event of ["PostToolUse", "Stop", "PostCompact", "SessionStart", "PreToolUse"]) {
    for (const command of commandsFor(next, event)) assert.doesNotMatch(command, /\/plugins\/|node_modules|checkout/);
  }
});

test("both older absolute forms migrate to the shim, once each", () => {
  // npm installs (…/<install>/node_modules/paseo-smart-session) and Git installs
  // (…/<install>/checkout), as written by 3.6.0 and earlier, plus a hand-added quoted one.
  const npm = "/home/u/.paseo/plugins/smart-session/0409fe47/node_modules/paseo-smart-session";
  const git = "/home/u/.paseo/plugins/smart-session/98ae937d/checkout";
  const before = {
    PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: `node ${npm}/hooks/context-threshold.mjs`, timeout: 10 }] }],
    Stop: [{ matcher: "", hooks: [foreign, { type: "command", command: `node ${git}/hooks/ask-compact.mjs`, timeout: 10 }] }],
    PostCompact: [{ matcher: "", hooks: [{ type: "command", command: `node "${npm}/hooks/post-compact.mjs"` }] }],
    SessionStart: [{ matcher: "compact", hooks: [{ type: "command", command: `node ${git}/hooks/post-compact.mjs` }] }],
  };
  const next = reconcile(before, SHIMS);
  assert.deepEqual(commandsFor(next, "PostToolUse"), [cmd("context-threshold.mjs")]);
  assert.deepEqual(commandsFor(next, "Stop"), [foreign.command, cmd("ask-compact.mjs")]);
  assert.deepEqual(commandsFor(next, "PostCompact"), [cmd("post-compact.mjs")]);
  assert.deepEqual(commandsFor(next, "SessionStart"), [cmd("post-compact.mjs")]);
  assert.equal(next.SessionStart?.length, 1);
  assert.match(cmd("ask-compact.mjs"), /^if \[ -f '\/paseo\/plugin-data\/smart-session\/hooks\/ask-compact\.mjs' \]/);
});

test("a shim path with a quote in it stays one shell word", () => {
  assert.equal(commandFor("/o'brien/hooks", "ask-compact.mjs"), "if [ -f '/o'\\''brien/hooks/ask-compact.mjs' ]; then node '/o'\\''brien/hooks/ask-compact.mjs'; fi");
});

test("hooks belonging to anyone else are left exactly as they were", () => {
  // Paseo puts its own Stop hook here. Losing it would break the app around us.
  const before = {
    Stop: [{ matcher: "", hooks: [foreign] }],
    PreToolUse: [{ matcher: "mcp__.*", hooks: [{ type: "command", command: "check-auth.sh" }] }],
  };
  const next = reconcile(before, SHIMS);
  assert.ok(commandsFor(next, "Stop").includes(foreign.command));
  // Ours goes in its own Artifact group; theirs keeps its matcher and its place.
  assert.deepEqual(commandsFor(next, "PreToolUse"), ["check-auth.sh", cmd("publish-as.mjs")]);
  assert.equal(next.PreToolUse?.[0]?.matcher, "mcp__.*");
  assert.deepEqual(next.PreToolUse?.[0]?.hooks, [{ type: "command", command: "check-auth.sh" }]);
});

test("entries added by hand are adopted, not duplicated", () => {
  // The README used to tell people to write these themselves; an install that
  // appended to them would run every hook twice for the life of the session.
  const byHand = {
    Stop: [{ matcher: "", hooks: [foreign, { type: "command", command: cmd("ask-compact.mjs") }] }],
  };
  const next = reconcile(byHand, SHIMS);
  assert.deepEqual(commandsFor(next, "Stop"), [foreign.command, cmd("ask-compact.mjs")]);
});

test("an entry left behind by an older install path is removed, not kept alongside", () => {
  const moved = {
    Stop: [{ matcher: "", hooks: [{ type: "command", command: "node /old/checkout/hooks/ask-compact.mjs" }] }],
  };
  const next = reconcile(moved, SHIMS);
  assert.deepEqual(commandsFor(next, "Stop"), [cmd("ask-compact.mjs")]);
});

test("reconciling twice changes nothing the second time", () => {
  const once = reconcile({ Stop: [{ matcher: "", hooks: [foreign] }] }, SHIMS);
  assert.deepEqual(reconcile(once, SHIMS), once);
});

test("a null plugin directory removes ours and keeps everyone else's", () => {
  // This is what switching the setting off does, and what happens when the hook
  // scripts cannot be found — in which case writing the paths anyway would leave
  // every session running a command that fails on every turn.
  const installed = reconcile({ Stop: [{ matcher: "", hooks: [foreign] }] }, SHIMS);
  const removed = reconcile(installed, null);
  assert.deepEqual(commandsFor(removed, "Stop"), [foreign.command]);
  assert.equal(removed.PostCompact, undefined);
  assert.equal(removed.PostToolUse, undefined);
});

test("a matcher group that only ever held our hook is dropped, not left empty", () => {
  const installed = reconcile({}, SHIMS);
  assert.deepEqual(reconcile(installed, null), {});
});

/* -------------------------------------------------------------------------- *
 * The whole reconciliation, against real files.
 * -------------------------------------------------------------------------- */

/** An install directory holding every script a shim can name, at a given version. */
function stubInstall(dir: string, version: string): void {
  mkdirSync(join(dir, "hooks"), { recursive: true });
  for (const script of ["context-threshold.mjs", "ask-compact.mjs", "post-compact.mjs", "publish-as.mjs"]) {
    writeFileSync(join(dir, "hooks", script), "// stub\n", "utf8");
  }
  writeFileSync(join(dir, "mcp.mjs"), "// stub\n", "utf8");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "paseo-smart-session", version }), "utf8");
}

/** A Paseo home whose config points at a checkout containing the hook scripts. */
function fakeInstall(): { paseoHome: string; claudeDir: string; pluginDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ss-install-"));
  const pluginDir = join(root, "checkout");
  stubInstall(pluginDir, PLUGIN_VERSION);
  const paseoHome = join(root, "paseo");
  mkdirSync(paseoHome, { recursive: true });
  writeFileSync(
    join(paseoHome, "config.json"),
    JSON.stringify({ plugins: { "smart-session": { source: "directory", path: pluginDir } } }),
    "utf8",
  );
  const claudeDir = join(root, "claude");
  mkdirSync(claudeDir, { recursive: true });
  return { paseoHome, claudeDir, pluginDir };
}

async function freshInstaller(paseoHome: string, claudeDir: string) {
  process.env.PASEO_HOME = paseoHome;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  // settings.server.ts caches, so each case takes its own module instance.
  return (await import(`./server/install.ts?case=${claudeDir}`)) as typeof import("./server/install.ts");
}

test("the first load writes the hooks; the second writes nothing at all", async () => {
  const { paseoHome, claudeDir, pluginDir } = fakeInstall();
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ model: "opus[1m]" }), "utf8");
  const installer = await freshInstaller(paseoHome, claudeDir);

  const first = await installer.install({ registerMcp: false });
  assert.equal(first.changed, true);
  assert.equal(first.pluginDir, pluginDir);
  assert.equal(first.error, null);

  const written = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
  // Whatever else was in the file is still in the file.
  assert.equal(written.model, "opus[1m]");
  assert.equal(written.hooks.Stop[0].hooks[0].command, cmd("ask-compact.mjs", join(paseoHome, "plugin-data", "smart-session", "hooks")));

  // Every reload after the first must be a no-op, or this rewrites a file it does
  // not own on a fifteen-second timer forever.
  const second = await installer.install({ registerMcp: false });
  assert.equal(second.changed, false);
});

test("the original settings file is backed up before it is first touched", async () => {
  const { paseoHome, claudeDir } = fakeInstall();
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ model: "opus[1m]" }), "utf8");
  const installer = await freshInstaller(paseoHome, claudeDir);
  await installer.install({ registerMcp: false });

  const backup = JSON.parse(readFileSync(join(claudeDir, "settings.json.smart-session-backup"), "utf8"));
  assert.deepEqual(backup, { model: "opus[1m]" });
});

test("settings we cannot parse are reported and left completely alone", async () => {
  // Rewriting from a partial parse would silently drop whatever the user has.
  const { paseoHome, claudeDir } = fakeInstall();
  const path = join(claudeDir, "settings.json");
  writeFileSync(path, "{ not json", "utf8");
  const installer = await freshInstaller(paseoHome, claudeDir);

  const report = await installer.install({ registerMcp: false });
  assert.equal(report.changed, false);
  assert.match(report.error ?? "", /not valid JSON/);
  assert.equal(readFileSync(path, "utf8"), "{ not json");
});

test("no hook scripts found means no hooks written, and a reason given", async () => {
  const { claudeDir } = fakeInstall();
  const emptyHome = mkdtempSync(join(tmpdir(), "ss-nohome-"));
  const installer = await freshInstaller(emptyHome, claudeDir);

  const report = await installer.install({ registerMcp: false });
  assert.equal(report.pluginDir, null);
  assert.equal(report.changed, false);
  assert.match(report.error ?? "", /SMART_SESSION_PLUGIN_DIR/);
});

test("a settings file that does not exist yet is created", async () => {
  const { paseoHome, claudeDir } = fakeInstall();
  const installer = await freshInstaller(paseoHome, claudeDir);

  const report = await installer.install({ registerMcp: false });
  assert.equal(report.changed, true);
  const written = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
  assert.equal(written.hooks.PostToolUse[0].hooks[0].command, cmd("context-threshold.mjs", join(paseoHome, "plugin-data", "smart-session", "hooks")));
});

test("importing the installer writes nothing; only the load module does", async () => {
  // This is a regression test for a leak that actually happened. While the
  // self-start lived in install.server.ts, importing it from a test evaluated it —
  // against whatever PASEO_HOME a previously-loaded test file had set — and wrote
  // hook commands pointing at a temp directory into the real ~/.claude/settings.json.
  // The reconciler cleaned them up on the next load, but no test should ever be
  // able to reach into the machine's own configuration.
  const { paseoHome, claudeDir } = fakeInstall();
  const path = join(claudeDir, "settings.json");
  writeFileSync(path, JSON.stringify({ model: "opus[1m]" }), "utf8");

  await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", 'await import("./server/install.ts");'],
    { env: { ...process.env, PASEO_HOME: paseoHome, CLAUDE_CONFIG_DIR: claudeDir }, cwd: import.meta.dirname },
  );

  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { model: "opus[1m]" });
});

test("a symlinked settings.json stays a symlink: the hooks are written through to its target", async () => {
  // Dotfiles setups link ~/.claude/settings.json, and each ZeroSub account home links its
  // settings.json to the main one. Replacing a link with a copy splits the two for good: a seat
  // session then never sees a hook installed in the main file (2026-11-10).
  const { paseoHome, claudeDir } = fakeInstall();
  const dotfiles = mkdtempSync(join(tmpdir(), "ss-dotfiles-"));
  const target = join(dotfiles, "claude-settings.json");
  writeFileSync(target, JSON.stringify({ model: "opus" }), "utf8");
  const link = join(claudeDir, "settings.json");
  symlinkSync(target, link);
  const installer = await freshInstaller(paseoHome, claudeDir);

  const report = await installer.install({ registerMcp: false });
  assert.equal(report.error, null);
  assert.equal(report.changed, true);
  assert.ok(lstatSync(link).isSymbolicLink(), "the link is still a link");
  const written = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(written.model, "opus");
  assert.equal(written.hooks.Stop[0].hooks[0].command, cmd("ask-compact.mjs", join(paseoHome, "plugin-data", "smart-session", "hooks")));
  assert.equal((await installer.install({ registerMcp: false })).changed, false);
});
