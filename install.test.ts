import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { mcpPointsAtPlugin, reconcile } from "./server/install.ts";

const DIR = "/plugins/paseo-smart-session";

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

  assert.equal(mcpPointsAtPlugin(current, DIR), true);
  assert.equal(mcpPointsAtPlugin(stale, DIR), false);
  assert.equal(mcpPointsAtPlugin(current.replace("User config", "Local config"), DIR), false);
});

test("an empty settings file gains exactly the four managed entries", () => {
  const next = reconcile({}, DIR);
  assert.deepEqual(Object.keys(next).sort(), ["PostCompact", "PostToolUse", "SessionStart", "Stop"]);
  assert.deepEqual(commandsFor(next, "Stop"), [`node ${DIR}/hooks/ask-compact.mjs`]);
  // The one that cannot inject and the one that can, same script, two events.
  assert.deepEqual(commandsFor(next, "PostCompact"), [`node ${DIR}/hooks/post-compact.mjs`]);
  assert.deepEqual(commandsFor(next, "SessionStart"), [`node ${DIR}/hooks/post-compact.mjs`]);
  assert.equal(next.SessionStart?.[0]?.matcher, "compact");
});

test("hooks belonging to anyone else are left exactly as they were", () => {
  // Paseo puts its own Stop hook here. Losing it would break the app around us.
  const before = {
    Stop: [{ matcher: "", hooks: [foreign] }],
    PreToolUse: [{ matcher: "mcp__.*", hooks: [{ type: "command", command: "check-auth.sh" }] }],
  };
  const next = reconcile(before, DIR);
  assert.ok(commandsFor(next, "Stop").includes(foreign.command));
  assert.deepEqual(commandsFor(next, "PreToolUse"), ["check-auth.sh"]);
  assert.equal(next.PreToolUse?.[0]?.matcher, "mcp__.*");
});

test("entries added by hand are adopted, not duplicated", () => {
  // The README used to tell people to write these themselves; an install that
  // appended to them would run every hook twice for the life of the session.
  const byHand = {
    Stop: [{ matcher: "", hooks: [foreign, { type: "command", command: `node ${DIR}/hooks/ask-compact.mjs` }] }],
  };
  const next = reconcile(byHand, DIR);
  assert.deepEqual(commandsFor(next, "Stop"), [foreign.command, `node ${DIR}/hooks/ask-compact.mjs`]);
});

test("an entry left behind by an older install path is removed, not kept alongside", () => {
  const moved = {
    Stop: [{ matcher: "", hooks: [{ type: "command", command: "node /old/checkout/hooks/ask-compact.mjs" }] }],
  };
  const next = reconcile(moved, DIR);
  assert.deepEqual(commandsFor(next, "Stop"), [`node ${DIR}/hooks/ask-compact.mjs`]);
});

test("reconciling twice changes nothing the second time", () => {
  const once = reconcile({ Stop: [{ matcher: "", hooks: [foreign] }] }, DIR);
  assert.deepEqual(reconcile(once, DIR), once);
});

test("a null plugin directory removes ours and keeps everyone else's", () => {
  // This is what switching the setting off does, and what happens when the hook
  // scripts cannot be found — in which case writing the paths anyway would leave
  // every session running a command that fails on every turn.
  const installed = reconcile({ Stop: [{ matcher: "", hooks: [foreign] }] }, DIR);
  const removed = reconcile(installed, null);
  assert.deepEqual(commandsFor(removed, "Stop"), [foreign.command]);
  assert.equal(removed.PostCompact, undefined);
  assert.equal(removed.PostToolUse, undefined);
});

test("a matcher group that only ever held our hook is dropped, not left empty", () => {
  const installed = reconcile({}, DIR);
  assert.deepEqual(reconcile(installed, null), {});
});

/* -------------------------------------------------------------------------- *
 * The whole reconciliation, against real files.
 * -------------------------------------------------------------------------- */

/** A Paseo home whose config points at a checkout containing the hook scripts. */
function fakeInstall(): { paseoHome: string; claudeDir: string; pluginDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ss-install-"));
  const pluginDir = join(root, "checkout");
  mkdirSync(join(pluginDir, "hooks"), { recursive: true });
  for (const script of ["context-threshold.mjs", "ask-compact.mjs", "post-compact.mjs"]) {
    writeFileSync(join(pluginDir, "hooks", script), "// stub\n", "utf8");
  }
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
  assert.equal(written.hooks.Stop[0].hooks[0].command, `node ${pluginDir}/hooks/ask-compact.mjs`);

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
  const { paseoHome, claudeDir, pluginDir } = fakeInstall();
  const installer = await freshInstaller(paseoHome, claudeDir);

  const report = await installer.install({ registerMcp: false });
  assert.equal(report.changed, true);
  const written = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
  assert.equal(written.hooks.PostToolUse[0].hooks[0].command, `node ${pluginDir}/hooks/context-threshold.mjs`);
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
