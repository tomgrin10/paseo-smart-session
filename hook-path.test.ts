/**
 * The hook path has to survive an update: Paseo installs the new version into a fresh
 * directory and deletes the old one. On 2026-11-09 the 3.6.0 update registered the hooks
 * against the 3.5 directory (config.json still named it), Paseo deleted it seconds later,
 * and every hook failed with MODULE_NOT_FOUND for hours.
 *
 * Everything here runs against a sandbox PASEO_HOME and CLAUDE_CONFIG_DIR.
 */

import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { PLUGIN_VERSION } from "./shared/version.ts";

const execFileAsync = promisify(execFile);
const REPO = import.meta.dirname;

interface Sandbox {
  root: string;
  paseoHome: string;
  claudeDir: string;
  shims: string;
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "ss-hookpath-"));
  const paseoHome = join(root, "paseo");
  const claudeDir = join(root, "claude");
  mkdirSync(paseoHome, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  return { root, paseoHome, claudeDir, shims: join(paseoHome, "plugin-data", "smart-session", "hooks") };
}

/** Paseo's layout for an npm install: plugins/<id>/<install>/node_modules/<package>. */
function npmDir(paseoHome: string, install: string): string {
  return join(paseoHome, "plugins", "smart-session", install, "node_modules", "paseo-smart-session");
}

function configure(paseoHome: string, pluginDir: string): void {
  writeFileSync(
    join(paseoHome, "config.json"),
    JSON.stringify({ plugins: { "smart-session": { source: "npm", path: pluginDir, enabled: true } } }),
  );
}

/** Stub scripts that announce themselves, so a test can tell which install ran. */
function stubInstall(dir: string, version: string, label: string): void {
  mkdirSync(join(dir, "hooks"), { recursive: true });
  const say = (script: string) => `process.stdout.write(${JSON.stringify(`${label}:${script}`)});\n`;
  for (const script of ["context-threshold.mjs", "ask-compact.mjs", "post-compact.mjs", "publish-as.mjs"]) {
    writeFileSync(join(dir, "hooks", script), say(script));
  }
  writeFileSync(join(dir, "mcp.mjs"), say("mcp.mjs"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "paseo-smart-session", version }));
}

/** A real copy of this plugin's agent-facing scripts at a given version, marked by label. */
function realInstall(dir: string, version: string, label: string, marker: string): void {
  mkdirSync(join(dir, "server"), { recursive: true });
  cpSync(join(REPO, "hooks"), join(dir, "hooks"), { recursive: true });
  cpSync(join(REPO, "server", "hooklib"), join(dir, "server", "hooklib"), { recursive: true });
  for (const file of ["agent-tools.mjs", "daemon-password.mjs"]) cpSync(join(REPO, "server", file), join(dir, "server", file));
  cpSync(join(REPO, "mcp.mjs"), join(dir, "mcp.mjs"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "paseo-smart-session", version, type: "module" }));
  // Each hook records that it ran, from which install, before doing its real work.
  for (const script of ["context-threshold.mjs", "ask-compact.mjs", "post-compact.mjs"]) {
    const path = join(dir, "hooks", script);
    const record = `import { appendFileSync as __ran } from "node:fs";\n__ran(${JSON.stringify(marker)}, ${JSON.stringify(`${label}:${script}\n`)});\n`;
    writeFileSync(path, record + readFileSync(path, "utf8").replace(/^#!.*\n/, ""));
  }
}

/** A fresh module graph bound to this sandbox (settings.ts caches its paths). */
async function loadIn(box: Sandbox) {
  process.env.PASEO_HOME = box.paseoHome;
  process.env.CLAUDE_CONFIG_DIR = box.claudeDir;
  delete process.env.SMART_SESSION_PLUGIN_DIR;
  const tag = encodeURIComponent(box.root);
  return {
    installer: (await import(`./server/install.ts?box=${tag}`)) as typeof import("./server/install.ts"),
    paths: (await import(`./server/hook-path.ts?box=${tag}`)) as typeof import("./server/hook-path.ts"),
  };
}

function runShim(box: Sandbox, script: string, args: string[] = []) {
  return spawnSync(process.execPath, [join(box.shims, script), ...args], {
    input: "{}",
    encoding: "utf8",
    env: { ...process.env, PASEO_HOME: box.paseoHome },
  });
}

test("resolvePluginDir prefers the running install over a stale config.json entry", async () => {
  const box = sandbox();
  const stale = npmDir(box.paseoHome, "0409fe47");
  const running = npmDir(box.paseoHome, "e2d0a795");
  stubInstall(stale, "0.0.1", "old");
  stubInstall(running, PLUGIN_VERSION, "new");
  configure(box.paseoHome, stale); // mid-update: config.json still names the old install

  const { installer } = await loadIn(box);
  assert.equal(await installer.resolvePluginDir(), running);
  // With nothing at the running version, the first complete candidate still counts.
  assert.equal(await installer.resolvePluginDir({ version: "9.9.9" }), stale);
});

test("a shim whose pointer names a missing install exits 0 and says nothing", async () => {
  const box = sandbox();
  const dir = npmDir(box.paseoHome, "gone");
  stubInstall(dir, PLUGIN_VERSION, "gone");
  const { paths } = await loadIn(box);
  await paths.pointShimsAt(dir);
  assert.equal(runShim(box, "ask-compact.mjs").stdout, "gone:ask-compact.mjs", "the shim runs its target while it exists");

  rmSync(dir, { recursive: true, force: true });
  for (const script of ["context-threshold.mjs", "ask-compact.mjs", "post-compact.mjs", "publish-as.mjs", "mcp.mjs"]) {
    const result = runShim(box, script);
    assert.equal(result.status, 0, script);
    assert.equal(result.stdout, "", script);
    assert.equal(result.stderr, "", script);
  }

  // No pointer at all is the same.
  rmSync(paths.pointerPath());
  const result = runShim(box, "post-compact.mjs");
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, "", ""]);
});

test("the mcp.mjs shim passes its arguments through to the real script", async () => {
  const box = sandbox();
  const dir = npmDir(box.paseoHome, "args");
  mkdirSync(dir, { recursive: true });
  stubInstall(dir, PLUGIN_VERSION, "x");
  writeFileSync(join(dir, "mcp.mjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const { paths } = await loadIn(box);
  await paths.pointShimsAt(dir);
  assert.equal(runShim(box, "mcp.mjs", ["call", "checkpoint", "{}"]).stdout, '["call","checkpoint","{}"]');
});

test("update simulation: install vA, install vB, delete vA — the hooks run vB", async () => {
  const box = sandbox();
  const marker = join(box.root, "ran.log");
  const vA = npmDir(box.paseoHome, "aaaa-old");
  const vB = npmDir(box.paseoHome, "bbbb-new");
  writeFileSync(join(box.claudeDir, "settings.json"), JSON.stringify({ model: "opus" }));

  // vA is installed and loaded.
  realInstall(vA, "0.0.1", "A", marker);
  configure(box.paseoHome, vA);
  const { installer, paths } = await loadIn(box);
  const first = await installer.install({ registerMcp: false });
  assert.equal(first.error, null);
  assert.equal(first.pluginDir, vA);

  // vB lands and loads while config.json still names vA, as on 2026-11-09.
  realInstall(vB, PLUGIN_VERSION, "B", marker);
  const second = await installer.install({ registerMcp: false });
  assert.equal(second.pluginDir, vB);
  assert.equal(await paths.readPointer(), vB);
  // Then Paseo deletes vA and catches config.json up.
  rmSync(vA, { recursive: true, force: true });
  configure(box.paseoHome, vB);

  const settings = JSON.parse(readFileSync(join(box.claudeDir, "settings.json"), "utf8"));
  assert.equal(settings.model, "opus");
  const commands: string[] = Object.values(settings.hooks as Record<string, { hooks: { command: string }[] }[]>)
    .flat().flatMap((group) => group.hooks.map((hook) => hook.command));
  assert.equal(commands.length, 5);
  for (const command of commands) {
    assert.doesNotMatch(command, /aaaa-old|bbbb-new/, "no command names an install directory");
    // Exactly as Claude Code runs it: through a shell, the hook event on stdin.
    const event = JSON.stringify({ session_id: "s1", transcript_path: join(box.root, "none.jsonl"), cwd: box.root, hook_event_name: "Stop" });
    const result = spawnSync("bash", ["-c", command], { input: event, encoding: "utf8", env: { ...process.env, PASEO_HOME: box.paseoHome } });
    assert.equal(result.status, 0, `${command}\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|Cannot find module/);
  }
  const ran = readFileSync(marker, "utf8").trim().split("\n").sort();
  assert.deepEqual(ran, ["B:ask-compact.mjs", "B:context-threshold.mjs", "B:post-compact.mjs", "B:post-compact.mjs"]);

  // The real bridge runs through its shim from vB too.
  const bridge = await execFileAsync(process.execPath, [join(box.shims, "mcp.mjs"), "call", "no_such_tool", "{}"], {
    env: { ...process.env, PASEO_HOME: box.paseoHome, PASEO_AGENT_ID: "a" },
  }).catch((error: { stderr: string }) => error);
  assert.match(String((bridge as { stderr: string }).stderr), /Unknown tool/);
});

test("self-heal: a pointer left at a deleted install is re-pointed at the running one", async () => {
  const box = sandbox();
  const vA = npmDir(box.paseoHome, "aaaa");
  const vB = npmDir(box.paseoHome, "bbbb");
  stubInstall(vA, "0.0.1", "A");
  stubInstall(vB, PLUGIN_VERSION, "B");
  configure(box.paseoHome, vA);
  const { installer, paths } = await loadIn(box);
  await paths.pointShimsAt(vA);
  writeFileSync(join(box.claudeDir, "settings.json"), "{}\n");

  // Healthy: nothing moves, nothing is written.
  assert.equal(await installer.refreshPointer(), false);
  assert.equal(await paths.readPointer(), vA);
  assert.equal(readFileSync(join(box.claudeDir, "settings.json"), "utf8"), "{}\n");

  rmSync(vA, { recursive: true, force: true });
  assert.equal(await installer.refreshPointer(), true);
  assert.equal(await paths.readPointer(), vB);
  assert.equal(runShim(box, "ask-compact.mjs").stdout, "B:ask-compact.mjs");
  assert.ok(existsSync(join(box.claudeDir, "settings.json")));
});
