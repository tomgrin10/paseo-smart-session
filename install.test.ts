import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { commandFor, managedFor, mcpDefinition, mcpPointsAtPlugin, reconcile } from "./server/install.ts";
import { clearSettingsCache } from "./server/settings.ts";
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

test("an empty settings file gains exactly the managed entries", () => {
  const next = reconcile({}, SHIMS);
  assert.deepEqual(Object.keys(next).sort(), ["PostCompact", "PostToolUse", "PostToolUseFailure", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
  // A detached session hears how to reach its tools: a failed smart_* call raises PostToolUseFailure, not PostToolUse.
  assert.deepEqual(commandsFor(next, "PostToolUseFailure"), [cmd("detached.mjs")]);
  assert.equal(next.PostToolUseFailure?.[0]?.matcher, "mcp__paseo__smart_.*");
  assert.deepEqual(commandsFor(next, "UserPromptSubmit"), [cmd("detached.mjs")]);
  // Publishing as the main account runs a helper agent: Artifact only, with a long timeout.
  assert.deepEqual(commandsFor(next, "PreToolUse"), [cmd("publish-as.mjs")]);
  assert.equal(next.PreToolUse?.[0]?.matcher, "Artifact|ArtifactData|ArtifactComments");
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
    "if [ -f '/paseo/plugin-data/smart-session/hooks/publish-as.mjs' ]; then node '/paseo/plugin-data/smart-session/hooks/publish-as.mjs'; fi",
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
  assert.deepEqual(commandsFor(next, "PostToolUse"), [cmd("context-threshold.mjs"), cmd("publish-as.mjs")]);
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

test("a load against another Paseo home never removes or duplicates this home's hooks", () => {
  // A sandbox (harness) load shares ~/.claude/settings.json with the real install. Its own shims live in
  // its own PASEO_HOME, so the real home's entries are not its to strip, with installHooks off or on.
  const real = reconcile({ Stop: [{ matcher: "", hooks: [foreign] }] }, SHIMS);
  const sandbox = "/tmp/harness/paseo/plugin-data/smart-session/hooks";
  assert.deepEqual(reconcile(real, null, undefined, sandbox), real, "installHooks off in the sandbox");
  const both = reconcile(real, sandbox, undefined, sandbox);
  for (const event of Object.keys(real)) {
    const mine = (map: typeof real) => commandsFor(map, event).filter((c) => c.includes(`'${SHIMS}/`)).length;
    assert.equal(mine(both), mine(real), event);
  }
  // The real home itself still removes its own, and adopts old install-directory entries.
  assert.deepEqual(commandsFor(reconcile(real, null, undefined, SHIMS), "Stop"), [foreign.command]);
  const legacy = { Stop: [{ matcher: "", hooks: [{ type: "command", command: "node /old/install/hooks/ask-compact.mjs" }] }] };
  assert.deepEqual(reconcile(legacy, null, undefined, SHIMS), {});
});

test("a load against another live Paseo home's settings file adds none of its own hooks there", () => {
  // 3.8.0-beta.1 review: a sandbox load kept the real home's 7 entries and added its own 7 beside them.
  const real = reconcile({ Stop: [{ matcher: "", hooks: [foreign] }] }, SHIMS);
  const sandbox = "/tmp/harness/paseo/plugin-data/smart-session/hooks";
  assert.deepEqual(reconcile(real, sandbox, undefined, sandbox, () => true, false), real, "installHooks on in the sandbox");
});

test("the default home always manages its own entries; a sandbox never writes the person's settings", () => {
  // 3.8.0-beta.3 review (R1): a file holding only a sandbox's entries got none of the real home's, and with both,
  // features off removed the real 7 and features on added none back.
  const real = reconcile({ Stop: [{ matcher: "", hooks: [foreign] }] }, SHIMS);
  const sandbox = "/tmp/harness/paseo/plugin-data/smart-session/hooks";
  const sandboxOnly = JSON.parse(JSON.stringify(real).replaceAll(`${SHIMS}/`, `${sandbox}/`)) as typeof real;
  const doubled = JSON.parse(JSON.stringify(real)) as typeof real;
  for (const [event, groups] of Object.entries(doubled)) {
    for (const group of groups) group.hooks = [...(group.hooks ?? []), ...(group.hooks ?? []).filter((h) => String(h.command).includes(`'${SHIMS}/`)).map((h) => ({ ...h, command: String(h.command).replaceAll(`${SHIMS}/`, `${sandbox}/`) }))];
    doubled[event] = groups;
  }
  const count = (map: typeof real, dir: string) => Object.values(map).flat().flatMap((g) => g.hooks ?? []).filter((h) => String(h.command).includes(`'${dir}/`)).length;
  const own = count(real, SHIMS);
  assert.ok(own > 0);
  const live = () => true;
  const gone = (dir: string) => dir === SHIMS;
  // 1. Only a sandbox's entries (the 3.8.0-beta.1 incident state): the real home adds its own; a gone sandbox's go.
  assert.equal(count(reconcile(sandboxOnly, SHIMS, undefined, SHIMS, live, true), SHIMS), own);
  assert.equal(count(reconcile(sandboxOnly, SHIMS, undefined, SHIMS, gone, true), sandbox), 0);
  assert.equal(count(reconcile(sandboxOnly, SHIMS, undefined, SHIMS, gone, true), SHIMS), own);
  // 2. A first-ever sandbox load on a clean file: it isn't the sandbox's file, so nothing is added.
  const clean = { Stop: [{ matcher: "", hooks: [foreign] }] };
  assert.deepEqual(reconcile(clean, sandbox, undefined, sandbox, live, false), clean);
  // ...and it never touches anything: not the real entries, and not its own (3.8.0-beta.4 review: they may be the
  // working hooks of a custom-home install).
  assert.deepEqual(reconcile(doubled, sandbox, undefined, sandbox, live, false), doubled);
  assert.deepEqual(reconcile(real, sandbox, undefined, sandbox, gone, false), real);
  // 3. Both: features off removes the real 7, features on brings them back.
  const OFF = { compact: false, publish: false };
  const off = reconcile(doubled, SHIMS, OFF, SHIMS, live, true);
  assert.equal(count(off, SHIMS), 0);
  assert.equal(count(reconcile(off, SHIMS, undefined, SHIMS, live, true), SHIMS), own);
});

test("whatever the sequence of loads, sandbox loads and feature toggles, the real home ends with exactly its own hooks", () => {
  let seed = 20261117;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const sandbox = "/tmp/harness/paseo/plugin-data/smart-session/hooks";
  const entries = (map: ReturnType<typeof reconcile>, dir: string) => Object.entries(map)
    .flatMap(([event, groups]) => groups.flatMap((g) => (g.hooks ?? []).filter((h) => String(h.command).includes(`'${dir}/`)).map((h) => `${event}|${g.matcher ?? ""}|${h.command}`))).sort();
  const FEATURES = [{ compact: true, publish: true }, { compact: true, publish: false }, { compact: false, publish: true }, { compact: false, publish: false }];
  const expected = (features: (typeof FEATURES)[number]) => entries(reconcile({}, SHIMS, features), SHIMS);
  const base = reconcile({ Stop: [{ matcher: "", hooks: [foreign] }] }, SHIMS);
  const starts = [{}, { Stop: [{ matcher: "", hooks: [foreign] }] }, base, reconcile(base, sandbox, undefined, sandbox, () => true, true), JSON.parse(JSON.stringify(base).replaceAll(`${SHIMS}/`, `${sandbox}/`))];
  for (let run = 0; run < 400; run++) {
    let map = JSON.parse(JSON.stringify(pick(starts))) as ReturnType<typeof reconcile>;
    let sandboxAlive = random() < 0.5;
    const alive = (dir: string) => dir === SHIMS || (dir === sandbox && sandboxAlive);
    let realFeatures = pick(FEATURES);
    for (let step = 0; step < 12; step++) {
      const op = pick(["real", "sandbox", "sandbox", "die", "revive"] as const);
      if (op === "die") { sandboxAlive = false; continue; }
      if (op === "revive") { sandboxAlive = true; continue; }
      if (op === "real") {
        realFeatures = pick(FEATURES);
        map = reconcile(map, random() < 0.9 ? SHIMS : null, realFeatures, SHIMS, alive, true);
        if (Object.keys(map).length === 0) map = {};
        continue;
      }
      const before = entries(map, SHIMS);
      map = reconcile(map, random() < 0.7 ? sandbox : null, pick(FEATURES), sandbox, alive, false);
      assert.deepEqual(entries(map, SHIMS), before, `run ${run} step ${step}: a sandbox load never changes the real entries`);
    }
    map = reconcile(map, SHIMS, realFeatures, SHIMS, alive, true);
    assert.deepEqual(entries(map, SHIMS), expected(realFeatures), `run ${run}: the real home's own set, exactly`);
    if (!sandboxAlive) assert.deepEqual(entries(map, sandbox), [], `run ${run}: a gone sandbox's entries are removed`);
    assert.equal(commandsFor(map, "Stop").filter((c) => c === foreign.command).length, JSON.stringify(map).includes(foreign.command) ? 1 : 0);
  }
});

test("which settings file a load may write: the default home its own, a sandbox only one inside its own HOME or config dir", async () => {
  const install = await import("./server/install.ts") as Record<string, unknown>;
  assert.equal(typeof install.ownsSettings, "function");
  const ownsSettings = install.ownsSettings as (path: string, where: { paseoHome: string; home?: string; configDir?: string; userHome: string }) => boolean;
  const user = mkdtempSync(join(tmpdir(), "owner-user-"));
  mkdirSync(join(user, ".claude")); mkdirSync(join(user, ".paseo", "plugin-data", "smart-session", "hooks"), { recursive: true });
  const real = join(user, ".claude", "settings.json");
  writeFileSync(real, "{}");
  const sandbox = mkdtempSync(join(tmpdir(), "owner-sandbox-"));
  mkdirSync(join(sandbox, "home", ".claude"), { recursive: true });
  const own = join(sandbox, "home", ".claude", "settings.json");
  writeFileSync(own, "{}");
  const linked = join(sandbox, "home", ".claude", "linked.json");
  symlinkSync(real, linked);
  assert.equal(ownsSettings(real, { paseoHome: join(user, ".paseo"), home: user, userHome: user }), true, "the default home");
  assert.equal(ownsSettings(real, { paseoHome: join(sandbox, "paseo"), home: user, userHome: user }), false, "a sandbox with the real HOME (3.8.0-beta.1)");
  assert.equal(ownsSettings(own, { paseoHome: join(sandbox, "paseo"), home: join(sandbox, "home"), userHome: user }), true, "a sandbox's own temp HOME");
  assert.equal(ownsSettings(own, { paseoHome: join(sandbox, "paseo"), home: user, configDir: join(sandbox, "home", ".claude"), userHome: user }), true, "a sandbox's own CLAUDE_CONFIG_DIR");
  assert.equal(ownsSettings(linked, { paseoHome: join(sandbox, "paseo"), home: join(sandbox, "home"), userHome: user }), false, "never the real file through a link");
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
  for (const script of ["context-threshold.mjs", "ask-compact.mjs", "post-compact.mjs", "publish-as.mjs", "detached.mjs"]) {
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
  // The settings module is shared by every instance below and caches what it read.
  clearSettingsCache();
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

/* -------------------------------------------------------------------------- *
 * Hooks follow the features that need them.
 * -------------------------------------------------------------------------- */

/** Smart Session's own settings file in a fake Paseo home. */
function writePluginSettings(paseoHome: string, settings: Record<string, unknown>): void {
  const dir = join(paseoHome, "plugin-data", "smart-session");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings), "utf8");
  clearSettingsCache();
}

const events = (path: string) => Object.keys(JSON.parse(readFileSync(path, "utf8")).hooks ?? {}).sort();

test("each feature brings only its own hooks", () => {
  // The detached-tools hooks ride along with either feature: the tools exist whatever is on. So does Stop, which also
  // names background jobs a session restart killed (its compaction ask checks Smart Compact itself).
  assert.deepEqual(managedFor({ compact: false, publish: true }).map((m) => m.script), ["ask-compact.mjs", "publish-as.mjs", "publish-as.mjs", "detached.mjs", "detached.mjs"]);
  assert.ok(!managedFor({ compact: true, publish: false }).some((m) => m.script === "publish-as.mjs"));
  assert.deepEqual(managedFor({ compact: false, publish: false }), []);
  const publishOnly = reconcile({ Stop: [{ matcher: "", hooks: [foreign] }] }, SHIMS, { compact: false, publish: true });
  assert.deepEqual(Object.keys(publishOnly).sort(), ["PostToolUse", "PostToolUseFailure", "PreToolUse", "Stop", "UserPromptSubmit"]);
  assert.deepEqual(commandsFor(publishOnly, "Stop"), [foreign.command, cmd("ask-compact.mjs")]);
});

test("a fresh install with Smart Compact off still gets the Artifact hook, and no compaction hook", async () => {
  // Publishing as the main account is on by default and needs only its PreToolUse routing and PostToolUse owner record.
  const { paseoHome, claudeDir } = fakeInstall();
  writePluginSettings(paseoHome, { enabled: false });
  const installer = await freshInstaller(paseoHome, claudeDir);

  const report = await installer.install({ registerMcp: false });
  assert.equal(report.error, null);
  assert.deepEqual(report.hooks, ["Stop", "PreToolUse:Artifact|ArtifactData|ArtifactComments", "PostToolUse:Artifact", "PostToolUseFailure:mcp__paseo__smart_.*", "UserPromptSubmit"]);
  assert.deepEqual(events(join(claudeDir, "settings.json")), ["PostToolUse", "PostToolUseFailure", "PreToolUse", "Stop", "UserPromptSubmit"]);
});

test("turning publishing off removes the Artifact hook, and turning it on adds it back", async () => {
  const { paseoHome, claudeDir } = fakeInstall();
  const path = join(claudeDir, "settings.json");
  const installer = await freshInstaller(paseoHome, claudeDir);
  await installer.install({ registerMcp: false });
  assert.ok(events(path).includes("PreToolUse"));

  writePluginSettings(paseoHome, { publishAsMain: false });
  const off = await installer.install({ registerMcp: false });
  assert.equal(off.changed, true);
  assert.ok(!off.hooks.includes("PreToolUse:Artifact|ArtifactData|ArtifactComments"));
  assert.ok(!off.hooks.includes("PostToolUse:Artifact"));
  assert.deepEqual(events(path), ["PostCompact", "PostToolUse", "PostToolUseFailure", "SessionStart", "Stop", "UserPromptSubmit"]);

  writePluginSettings(paseoHome, { publishAsMain: true });
  const on = await installer.install({ registerMcp: false });
  assert.equal(on.changed, true);
  assert.ok(on.hooks.includes("PreToolUse:Artifact|ArtifactData|ArtifactComments"));
  assert.ok(on.hooks.includes("PostToolUse:Artifact"));
  assert.deepEqual(events(path), ["PostCompact", "PostToolUse", "PostToolUseFailure", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
});

test("turning Smart Compact off removes its hooks and keeps the Artifact hook", async () => {
  const { paseoHome, claudeDir } = fakeInstall();
  const path = join(claudeDir, "settings.json");
  const installer = await freshInstaller(paseoHome, claudeDir);
  await installer.install({ registerMcp: false });

  writePluginSettings(paseoHome, { enabled: false });
  await installer.install({ registerMcp: false });
  assert.deepEqual(events(path), ["PostToolUse", "PostToolUseFailure", "PreToolUse", "Stop", "UserPromptSubmit"]);

  writePluginSettings(paseoHome, { enabled: false, publishAsMain: false });
  const none = await installer.install({ registerMcp: false });
  assert.deepEqual(none.hooks, []);
  assert.deepEqual(events(path), []);
});

/* -------------------------------------------------------------------------- *
 * 3.8.0-beta.4 review: a custom PASEO_HOME, and a link to a file not there yet.
 * -------------------------------------------------------------------------- */

type OwnsSettings = (path: string, where: { paseoHome: string; home?: string; configDir?: string; userHome: string }) => boolean;

test("a custom PASEO_HOME owns the person's settings when the default home has no Smart Session; a link to a missing file is still the real one", async () => {
  const install = await import("./server/install.ts") as Record<string, unknown>;
  const ownsSettings = install.ownsSettings as OwnsSettings;
  const user = mkdtempSync(join(tmpdir(), "owner-user-"));
  mkdirSync(join(user, ".claude"));
  const real = join(user, ".claude", "settings.json");
  writeFileSync(real, "{}");
  const custom = mkdtempSync(join(tmpdir(), "owner-custom-"));
  // 1. The single custom-home user: ~/.paseo holds no Smart Session, so the custom home is the owner.
  assert.equal(ownsSettings(real, { paseoHome: custom, home: user, userHome: user }), true, "the only Smart Session home");
  mkdirSync(join(user, ".paseo"));
  assert.equal(ownsSettings(real, { paseoHome: custom, home: user, userHome: user }), true, "an empty ~/.paseo is no Smart Session install");
  // 2. With Smart Session in the default home, that one owns it.
  mkdirSync(join(user, ".paseo", "plugin-data", "smart-session", "hooks"), { recursive: true });
  assert.equal(ownsSettings(real, { paseoHome: custom, home: user, userHome: user }), false, "the default home's");
  // 3. A sandbox config dir whose settings.json links to the person's, before that file exists.
  const sandbox = mkdtempSync(join(tmpdir(), "owner-sandbox-"));
  const config = join(sandbox, "claude");
  mkdirSync(config);
  const missing = join(user, ".claude", "not-yet.json");
  symlinkSync(missing, join(config, "settings.json"));
  assert.equal(ownsSettings(join(config, "settings.json"), { paseoHome: join(sandbox, "paseo"), home: sandbox, configDir: config, userHome: user }), false, "a dangling link into ~/.claude is the person's file");
  const relTarget = join(config, "rel-abs.json");
  symlinkSync(join(user, ".claude", "chain.json"), join(config, "hop.json"));
  symlinkSync(join(config, "hop.json"), relTarget);
  assert.equal(ownsSettings(relTarget, { paseoHome: join(sandbox, "paseo"), home: sandbox, configDir: config, userHome: user }), false, "a chain of links ending in ~/.claude");
});

test("upgrading from 3.7.0 with a custom PASEO_HOME keeps its eight hooks, with or without Smart Session in ~/.paseo", async () => {
  for (const defaultInUse of [false, true]) {
    const { paseoHome, pluginDir } = fakeInstall();
    const user = mkdtempSync(join(tmpdir(), "upgrade-user-"));
    mkdirSync(join(user, ".claude"));
    if (defaultInUse) mkdirSync(join(user, ".paseo", "plugin-data", "smart-session", "hooks"), { recursive: true });
    const shims = join(paseoHome, "plugin-data", "smart-session", "hooks");
    // What 3.7.0 wrote: the same guarded shim commands, all seven, beside someone else's hook.
    const v370 = reconcile({ Stop: [{ matcher: "", hooks: [foreign] }] }, shims);
    const file = join(user, ".claude", "settings.json");
    writeFileSync(file, JSON.stringify({ model: "opus[1m]", hooks: v370 }, null, 2));
    const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
    process.env.HOME = user;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.PASEO_HOME = paseoHome;
      clearSettingsCache();
      const installer = (await import(`./server/install.ts?upgrade=${user}`)) as Record<string, unknown>;
      assert.equal(typeof installer.setUserHomeForTest, "function", "a test seam for the person's home");
      (installer.setUserHomeForTest as (dir: string | null) => void)(user);
      const report = await (installer.install as (o: { registerMcp: boolean }) => Promise<{ error: string | null; pluginDir: string | null }>)({ registerMcp: false });
      assert.equal(report.error, null);
      assert.equal(report.pluginDir, pluginDir);
      const after = JSON.parse(readFileSync(file, "utf8"));
      const ours = Object.values(after.hooks as ReturnType<typeof reconcile>).flat().flatMap((g) => g.hooks ?? []).filter((h) => String(h.command).includes(`'${shims}/`));
      assert.equal(ours.length, 8, `default home in use: ${defaultInUse}`);
      assert.equal(commandsFor(after.hooks, "Stop").filter((c) => c === foreign.command).length, 1);
    } finally {
      process.env.HOME = saved.HOME;
      if (saved.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR;
    }
  }
});
