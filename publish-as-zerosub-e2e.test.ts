/**
 * End to end against the real ZeroSub: a limited main, a publish on its Extra usage, and the pin this
 * plugin sends. It runs ZeroSub's own routing and RPC schema, not a stub, so a change on either
 * side that breaks the contract fails here. Opt-in: set ZEROSUB_DIR to a ZeroSub (fork 1.5.1-pace.12+)
 * checkout or install; without it the test is skipped (CI has no ZeroSub).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { HELPER_LABEL } from "./shared/publish-as.ts";
import { daemonOps, type HelperOps } from "./server/publish-as.ts";

const dir = process.env.ZEROSUB_DIR ?? "";
const present = dir !== "" && existsSync(join(dir, "server", "routing.ts"));

// ZeroSub's sources import without extensions and resolve zod from their own install; point both
// at what this repository has.
const loader = `
const ZS = ${JSON.stringify(pathToFileURL(dir).href)};
const HERE = ${JSON.stringify(import.meta.url)};
export async function resolve(specifier, context, next) {
  const inside = context.parentURL?.startsWith(ZS);
  if (inside && (specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
    for (const ext of [".ts", ".tsx", "/index.ts"]) { try { return await next(specifier + ext, context); } catch {} }
  }
  if (inside && !specifier.startsWith(".") && !specifier.startsWith("node:")) return next(specifier, { ...context, parentURL: HERE });
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (!url.startsWith(ZS) || !/\.tsx?$/.test(url)) return next(url, context);
  const { readFile } = await import("node:fs/promises");
  const { stripTypeScriptTypes } = await import("node:module");
  const source = await readFile(new URL(url), "utf8");
  return { format: "module", source: stripTypeScriptTypes(source, { mode: "transform" }), shortCircuit: true };
}`;

test("Extra usage end to end: ZeroSub keeps a pinned helper on a limited main, and accepts our pin", { skip: !present && "set ZEROSUB_DIR to run against the real ZeroSub" }, async () => {
  register(`data:text/javascript,${encodeURIComponent(loader)}`);
  const routing = await import(pathToFileURL(join(dir, "server", "routing.ts")).href);
  const { StoredStateSchema } = await import(pathToFileURL(join(dir, "server", "state.ts")).href);
  const rpc = await import(pathToFileURL(join(dir, "shared", "rpc.ts")).href);
  const now = Date.parse("2026-11-19T12:00:00Z");
  const limitedUntil = "2026-11-21T04:00:00Z";
  const state = (binding: Record<string, unknown> | null) => StoredStateSchema.parse({
    accounts: [
      { id: "claude-main", family: "claude", label: "Main", kind: "main", home: null, limitedUntil, limitKind: "window", createdAt: "2026-01-01T00:00:00Z" },
      { id: "claude-seat", family: "claude", label: "Seat", kind: "managed", home: "/homes/seat", createdAt: "2026-02-01T00:00:00Z" },
    ],
    bindings: binding ? { helper: binding } : {},
  });

  // What this plugin sends: captured from the real daemon ops, not retyped here.
  let sent: { method: string; input: Record<string, unknown> } | null = null;
  const ops: HelperOps = daemonOps({ invokePluginRpc: async (_id: string, method: string, input: Record<string, unknown>) => { sent = { method, input }; } } as never, "zerosub");
  await ops.pin("helper", "claude-main", true);
  assert.equal(sent!.method, "zerosub.agents.account");
  const schema = Object.values(rpc).find((value: any) => value?.name === "zerosub.agents.account") as { input: { parse(value: unknown): unknown } } | undefined;
  assert.ok(schema, "ZeroSub still has the pin RPC");
  assert.deepEqual(schema!.input.parse(sent!.input), { agentId: "helper", accountId: "claude-main", allowLimited: true });

  // ZeroSub's binding for that pin (`setAgentAccount`), then its routing on the helper's reopen.
  const route = (binding: Record<string, unknown> | null) => routing.chooseAccount(state(binding), {
    agentId: "helper", family: "claude", reason: "refresh", now, autoSwitch: true, balanceNewAgents: true, paceWeeklyUsage: true, portable: true,
    usageOf: () => null,
  });
  const pinned = route({ accountId: "claude-main", source: "user", at: new Date(now).toISOString(), allowLimited: true });
  assert.equal(pinned.account.id, "claude-main", "a limited main keeps the helper that may spend its Extra usage");
  const plain = route({ accountId: "claude-main", source: "user", at: new Date(now).toISOString() });
  assert.equal(plain.account.id, "claude-seat", "without the pin ZeroSub moves it, which is why the helper checks its account");

  // ZeroSub only honours the pin for helpers it knows as one-shot, by this label.
  const service = readFileSync(join(dir, "server", "service.ts"), "utf8");
  assert.match(service, new RegExp(`\\["${HELPER_LABEL.key.replace(".", "\\.")}", "${HELPER_LABEL.value}"\\]`));
});
