/**
 * Proves the plugin subprocess can exit after cleanup.
 *
 * Paseo stops a plugin by running the cleanup returned from contribute() and
 * then waiting for the subprocess to exit. Anything still holding the event
 * loop -- an uncleared interval, an open socket -- makes that wait never
 * finish, leaving the plugin stuck "Stopping" and wedging reload for the rest
 * of the daemon's life. Typecheck and the bundle check cannot see this.
 *
 * Runs against an isolated PASEO_HOME so the real queue is never touched.
 */
import * as esbuild from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { SDK_SPECIFIERS } from "./check-lib.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(DIR, "index.server.ts");
const EXIT_BUDGET_MS = 10_000;

/**
 * The daemon hands the SDK to the subprocess at runtime. Nothing else is
 * stubbed: the point of this check is to run the real server code.
 */
const stubSdkModules = {
  name: "stub-sdk-modules",
  setup(build) {
    const filter = new RegExp(
      `^(${SDK_SPECIFIERS.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`,
    );
    build.onResolve({ filter }, (args) => ({ path: args.path, namespace: "sdk-stub" }));
    build.onLoad({ filter: /.*/, namespace: "sdk-stub" }, () => ({
      contents: "module.exports = { defineSettings: (d) => d, settingsRpc: (id) => ({ read: { name: `settings.${id}.read` } }), defineRpc: (d) => d, defineAgentTool: (d) => d, defineAttachmentSource: (d) => d };",
      loader: "js",
    }));
  },
};

const built = await esbuild.build({
  entryPoints: [ENTRY],
  absWorkingDir: DIR,
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  target: "node20",
  plugins: [stubSdkModules],
  logLevel: "silent",
});

const sandbox = mkdtempSync(join(tmpdir(), "smart-session-teardown-"));
const bundlePath = join(sandbox, "bundle.cjs");
const harnessPath = join(sandbox, "harness.cjs");
writeFileSync(bundlePath, built.outputFiles[0].text);
writeFileSync(
  harnessPath,
  `const mod = require(${JSON.stringify(bundlePath)});
const contribute = mod.default ?? mod;
const [values, settleMs] = [JSON.parse(process.argv[2]), Number(process.argv[3])];
const settings = { read: async () => ({ status: "ready", revision: "0", values }), subscribe: () => () => {} };
const plugin = new Proxy({}, { get: (_, name) => ["on", "before"].includes(name) ? () => () => {} : name === "registerSettings" ? () => settings : () => {} });
(async () => {
  const cleanup = contribute(plugin);
  if (typeof cleanup !== "function") throw new Error("contribute() must return a cleanup function");
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  await cleanup();
  console.log("CLEANUP_RETURNED");
})();
`,
);

/**
 * Two runs: every setting at its default and stopped at once, and with Session Guard
 * on and given time to take its lock and arm its poll timer — the state a reload
 * actually finds it in. The daemon URL points at a closed port either way.
 */
const scenarios = [
  { name: "defaults", values: {}, settleMs: 0 },
  { name: "Session Guard on", values: { enabled: true }, settleMs: 500 },
];

// A stand-in for the machine's home, holding an old global registration: loading the bundle
// against a sandbox must never touch it (only a real install removes old registrations).
const fakeHome = join(sandbox, "home");
mkdirSync(fakeHome, { recursive: true });
const registration = JSON.stringify({ mcpServers: { "smart-session": { type: "stdio", command: "node", args: ["/x/paseo-smart-session/mcp.mjs"] } } });
writeFileSync(join(fakeHome, ".claude.json"), registration);

for (const scenario of scenarios) {
  const child = spawn(process.execPath, [harnessPath, JSON.stringify(scenario.values), String(scenario.settleMs)], {
    env: { ...process.env, HOME: fakeHome, PASEO_HOME: sandbox, PASEO_DAEMON_URL: "ws://127.0.0.1:9/ws" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));

  const exitCode = await new Promise((settle) => {
    const timer = setTimeout(() => settle(null), EXIT_BUDGET_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      settle(code ?? 0);
    });
  });
  if (exitCode === null) child.kill("SIGKILL");

  if (!out.includes("CLEANUP_RETURNED")) {
    console.error(`  ✗ teardown (${scenario.name}): cleanup never returned`);
    console.error(out.trim().split("\n").slice(-6).map((line) => `      ${line}`).join("\n"));
    process.exitCode = 1;
  } else if (exitCode === null) {
    console.error(`  ✗ teardown (${scenario.name}): still alive ${EXIT_BUDGET_MS}ms after cleanup — Paseo's stop would hang here`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ teardown (${scenario.name}): subprocess exited after cleanup`);
  }
}
if (readFileSync(join(fakeHome, ".claude.json"), "utf8") !== registration || existsSync(join(fakeHome, ".claude.json.smart-session-unregister.bak"))) {
  console.error("  ✗ loading the bundle against a sandbox touched the home's Claude config");
  process.exitCode = 1;
} else {
  console.log("  ✓ a sandboxed load leaves the home's Claude and Codex config alone");
}
rmSync(sandbox, { recursive: true, force: true });
