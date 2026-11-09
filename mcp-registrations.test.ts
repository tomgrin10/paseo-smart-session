import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentHomes, removeGlobalRegistrations, withoutCodexEntry, type RunClaude } from "./server/mcp-registrations.ts";

const ours = { type: "stdio", command: "node", args: ["/fixture/plugins/smart-session/0000/node_modules/paseo-smart-session/mcp.mjs"] };
const codex = `model = "x"

[mcp_servers.figma]
url = "https://example.invalid/mcp"

[mcp_servers.smart-session]
command = "node"
args = ["/fixture/paseo-smart-session/mcp.mjs"]

[mcp_servers.smart-session.env]
SMART_SESSION_MCP_SCOPE = "paseo"

# Trusted projects
[projects."/fixture"]
trust_level = "trusted"
`;

test("removes only Smart Session's own Codex tables and keeps the rest verbatim", () => {
  const next = withoutCodexEntry(codex)!;
  assert.doesNotMatch(next, /smart-session/);
  assert.match(next, /\[mcp_servers\.figma\]\nurl = "https:\/\/example\.invalid\/mcp"\n\n# Trusted projects\n\[projects\."\/fixture"\]/);
  assert.equal(withoutCodexEntry('[mcp_servers.other]\ncommand = "x"\n'), null);
  const foreign = '[mcp_servers.smart-session]\ncommand = "my-own-server"\n';
  assert.equal(withoutCodexEntry(foreign), foreign, "a user's own entry under the name stays");
});

test("finds default, provider and ZeroSub homes and removes ours through claude mcp remove, with a backup", async t => {
  const root = await mkdtemp(join(tmpdir(), "smart-session-unreg-")); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), paseo = join(home, ".paseo"), zero = join(paseo, "zerosub/homes/claude-abc"), custom = join(root, "custom-claude");
  for (const dir of [join(home, ".codex"), zero, custom]) await mkdir(dir, { recursive: true });
  await writeFile(join(paseo, "config.json"), JSON.stringify({ agents: { providers: { claude: { env: { CLAUDE_CONFIG_DIR: custom } } } } }));
  const claudeJson = (servers: Record<string, unknown>) => JSON.stringify({ oauthAccount: { fixture: true }, mcpServers: servers }, null, 2);
  await writeFile(join(home, ".claude.json"), claudeJson({ "smart-session": ours, other: { type: "stdio", command: "x" } }), { mode: 0o600 });
  await writeFile(join(zero, ".claude.json"), claudeJson({ "smart-session": ours }));
  await writeFile(join(custom, ".claude.json"), claudeJson({ "smart-session": { type: "stdio", command: "my-own-server" } }));
  await writeFile(join(home, ".codex/config.toml"), codex);

  // Stands in for `claude mcp remove`: which file it edits depends only on CLAUDE_CONFIG_DIR.
  const runs: (string | undefined)[] = [];
  const run: RunClaude = async (args, env) => {
    assert.deepEqual(args, ["mcp", "remove", "smart-session", "--scope", "user"]);
    runs.push(env.CLAUDE_CONFIG_DIR);
    const file = join(env.CLAUDE_CONFIG_DIR ?? home, ".claude.json"); // the default home is the fixture's
    const config = JSON.parse(await readFile(file, "utf8")); delete config.mcpServers["smart-session"];
    await writeFile(file, JSON.stringify(config));
  };
  const homes = await agentHomes({}, paseo, home);
  const real = (await import("node:fs/promises")).realpath; const zeroReal = await real(zero);
  assert.equal(homes.claude.length, 3); assert.equal(homes.codex.length, 1);
  const by = Object.fromEntries((await removeGlobalRegistrations(homes, run, home)).map(r => [r.path, r.status]));
  assert.equal(by[join(home, ".claude.json")], "removed");
  assert.equal(by[join(zero, ".claude.json")], "removed");
  assert.equal(by[join(custom, ".claude.json")], "foreign");
  assert.equal(by[join(home, ".codex/config.toml")], "removed");
  assert.equal(runs.length, 2, "the CLI runs only where there is something of ours");
  assert.ok(runs.includes(undefined) && runs.includes(zeroReal), "default home without CLAUDE_CONFIG_DIR, ZeroSub's with it");

  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(home, ".claude.json"), "utf8")).mcpServers), ["other"]);
  const backup = join(home, ".claude.json.smart-session-unregister.bak");
  assert.ok(JSON.parse(await readFile(backup, "utf8")).mcpServers["smart-session"], "backed up first");
  assert.match(await readFile(join(home, ".codex/config.toml.smart-session-unregister.bak"), "utf8"), /smart-session/);
  // Idempotent: nothing left to do, no CLI run.
  assert.deepEqual((await removeGlobalRegistrations(homes, run, home)).map(r => r.status).sort(), ["absent", "absent", "absent", "foreign"]);
  assert.equal(runs.length, 2);
});

test("no claude CLI leaves the file alone and says so", async t => {
  const root = await mkdtemp(join(tmpdir(), "smart-session-unreg-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".claude.json"), JSON.stringify({ mcpServers: { "smart-session": ours } }));
  const missing: RunClaude = async () => { throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }); };
  const [result] = await removeGlobalRegistrations({ claude: [join(root, ".claude.json")], codex: [] }, missing);
  assert.equal(result!.status, "unavailable");
});
