/**
 * Proves `mcp.mjs` can reach a daemon client on a managed Git install: a checkout
 * with no `node_modules` of its own, where `@getpaseo/client` exists only inside
 * the globally installed `paseo` CLI's own dependency tree.
 *
 * This is the exact layout that broke on a real VM install: the direct bare
 * specifier resolves in a dev checkout (which has `@getpaseo/client` as a
 * devDependency) but not in a Git install, so this check must run with none of
 * this repo's own `node_modules` visible — hence the copy into an isolated
 * staging directory rather than a run from `DIR` itself.
 *
 * The desktop app broke the same way on macOS: its `paseo` is a wrapper script
 * and the client lives only inside `app.asar`, so it gets its own cases.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
console.log("Checking mcp.mjs daemon-client resolution on a Git install...");

const staging = mkdtempSync(join(tmpdir(), "smart-session-mcp-resolve-"));
const failures = [];

/** A package tree whose own @getpaseo/client is a stub that proves it was reached. */
function writeStubClient(root) {
  const clientDist = join(root, "node_modules", "@getpaseo", "client", "dist");
  mkdirSync(clientDist, { recursive: true });
  writeFileSync(
    join(root, "node_modules", "@getpaseo", "client", "package.json"),
    JSON.stringify({
      name: "@getpaseo/client",
      version: "0.0.0-stub",
      type: "module",
      exports: { "./internal/daemon-client": { default: "./dist/daemon-client.js" } },
    }),
  );
  writeFileSync(
    join(clientDist, "daemon-client.js"),
    // A sentinel rejection, not a real connection: this only needs to prove the
    // module resolved and its class was reached, not that a daemon is running.
    [
      "export class DaemonClient {",
      "  constructor() {}",
      '  async connect() { throw new Error("CHECK_SENTINEL_CONNECT_REACHED"); }',
      "  async close() {}",
      "}",
    ].join("\n"),
  );
}

/** Runs `budget_status` through mcp.mjs and returns the tool's text. */
function callBudget(checkout, { pathDirs, nodeArgs = [] }) {
  const result = execFileSync(process.execPath, [...nodeArgs, join(checkout, "mcp.mjs")], {
    cwd: checkout,
    encoding: "utf8",
    // No ancestor of `staging` has a node_modules with @getpaseo/client, so the
    // bare specifier import can only succeed through a fallback.
    env: { ...process.env, PATH: [...pathDirs, ...(process.env.PATH ?? "").split(delimiter)].join(delimiter) },
    input:
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "0" } },
        }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "budget_status", arguments: {} } }),
      ].join("\n") + "\n",
    timeout: 15_000,
  });
  const lines = result.trim().split("\n");
  return JSON.parse(lines[lines.length - 1])?.result?.content?.[0]?.text ?? "";
}

function expectReached(text, success) {
  if (text.includes("CHECK_SENTINEL_CONNECT_REACHED")) console.log(`  ✓ ${success}`);
  else failures.push(`resolution did not reach the stub client (${success}): ${text}`);
}

try {
  // The checkout: only what a Git install actually ships, no node_modules.
  const checkout = join(staging, "checkout");
  mkdirSync(checkout, { recursive: true });
  for (const name of ["mcp.mjs", "hooks", "server/daemon-password.mjs"]) {
    cpSync(join(DIR, name), join(checkout, name), { recursive: true });
  }

  // A stand-in for the machine's global @getpaseo/cli install: a `paseo`
  // executable whose real package tree has its own @getpaseo/client.
  const cli = join(staging, "cli");
  mkdirSync(join(cli, "bin"), { recursive: true });
  writeFileSync(join(cli, "bin", "paseo"), "#!/usr/bin/env node\n");
  writeStubClient(cli);
  expectReached(
    callBudget(checkout, { pathDirs: [join(cli, "bin")] }),
    "mcp.mjs resolves @getpaseo/client via the paseo CLI on PATH with no local node_modules",
  );

  // The desktop app's layout: `Resources/bin/paseo` is a shell wrapper with no
  // node_modules beside it, and the client exists only under `app.asar`. A plain
  // directory stands in for the archive; Electron reads a real one transparently.
  const resources = join(staging, "Paseo.app", "Contents", "Resources");
  const asar = join(resources, "app.asar");
  mkdirSync(join(resources, "bin"), { recursive: true });
  writeFileSync(join(resources, "bin", "paseo"), "#!/bin/sh\n");
  mkdirSync(join(asar, "node_modules", "@getpaseo", "cli", "dist"), { recursive: true });
  writeFileSync(join(asar, "node_modules", "@getpaseo", "cli", "dist", "index.js"), "");
  writeStubClient(asar);

  // Under the app's own Electron runtime, which is what install.ts registers.
  // `process.resourcesPath` is the one thing Electron adds that mcp.mjs reads.
  const asElectron = `data:text/javascript,process.resourcesPath=${encodeURIComponent(JSON.stringify(resources))}`;
  expectReached(
    callBudget(checkout, { pathDirs: [join(resources, "bin")], nodeArgs: ["--import", asElectron] }),
    "mcp.mjs resolves @getpaseo/client from the desktop app bundle under its Electron runtime",
  );

  // Under plain node the bundle is unreadable, so the failure must say how to fix it.
  const plain = callBudget(checkout, { pathDirs: [join(resources, "bin")] });
  if (plain.includes("reload the smart-session plugin")) {
    console.log("  ✓ mcp.mjs explains the desktop-app failure under plain node");
  } else {
    failures.push(`plain node against the desktop app gave no fix-it hint: ${plain}`);
  }
} catch (error) {
  failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  rmSync(staging, { recursive: true, force: true });
}

for (const failure of failures) console.error(`  ✗ ${failure}`);
if (failures.length > 0) {
  console.error("mcp.mjs Git-install resolution check failed.");
  process.exitCode = 1;
} else {
  console.log("mcp.mjs resolution OK.");
}
