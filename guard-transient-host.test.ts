import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicySchema, type Agent } from "./shared/guard/policy.ts";
import type { GuardClient } from "./server/guard/client.ts";
import { Store } from "./server/guard/store.ts";

process.env.PASEO_DAEMON_URL = "ws://127.0.0.1:9/ws";
process.env.PASEO_PASSWORD = "guard-transient-test";
const { contributeGuard } = await import("./server/guard/index.ts");
async function settle(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Recovery did not settle");
}

test("real guard hooks recover working errors with quota pausing off, persist no quota state, and clean up", async t => {
  const home = await mkdtemp(join(tmpdir(), "guard-transient-host-"));
  process.env.PASEO_HOME = home;
  const events = new Map<string, (event: any) => void>();
  const handlers = new Map<string, (input: any, context: any) => any>();
  const listeners = new Set<() => void>();
  let values = PolicySchema.parse({});
  let clock = 0;
  let pending: { callback: () => void; delay: number } | null = null;
  let sent = 0;
  const agent: Agent = { id: "a", provider: "claude", status: "running", activeTurn: { turnId: "t1" }, lastUserMessageAt: "original" };
  const client = {
    close: async () => {},
    fetchAgent: async () => ({ agent: structuredClone(agent) }),
    sendMessage: async () => { sent++; },
  } as unknown as GuardClient;
  const server = {
    registerSettings: () => ({ read: async () => ({ status: "ready", values }), subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); } }),
    handle: (contract: { name: string }, handler: any) => handlers.set(contract.name, handler),
    on: (name: string, fn: any) => { events.set(name, fn); return () => events.delete(name); },
  };
  const cleanup = contributeGuard(server as never, {
    connect: work => work(client),
    transient: { now: () => clock, log: () => {}, schedule: (callback, delay) => {
      const scheduled = { callback, delay }; pending = scheduled;
      return () => { if (pending === scheduled) pending = null; };
    } },
  });
  t.after(async () => { await cleanup(); await rm(home, { recursive: true, force: true }); });
  const dir = join(home, "plugin-data", "session-guard");
  assert.equal(values.enabled, false); assert.equal(values.retryTransientErrors, true);
  const summary = await handlers.get("smart-session.guard.agent")!({ agentId: "a" }, { paseo: {} });
  assert.equal(summary.retryTransientErrors, true); assert.match(summary.summary.join(), /Transient API error recovery is on/);
  assert.equal(existsSync(dir), false);
  events.get("agent.turn_started")!({ agent: { id: "a" }, turnId: "t1" });
  // Let the turn-start snapshot settle before the failure.
  await new Promise(resolve => setTimeout(resolve, 10));
  agent.status = "error"; agent.activeTurn = null; agent.lastError = "API Error: 503";
  events.get("agent.turn_ended")!({ agent: { id: "a" }, turnId: "t1", outcome: { kind: "failed", error: { message: agent.lastError } } });
  await settle(() => pending !== null);
  assert.equal(pending!.delay, 60_000);
  assert.equal(existsSync(join(dir, "governor.lock")), false);
  assert.equal(existsSync(join(dir, "state.json")), false);
  assert.equal(existsSync(join(dir, "transient-recovery", "governor.lock")), true);
  // A second install cannot take ownership of transient recovery.
  await assert.rejects(new Store(join(dir, "transient-recovery")).lock(), /already running/);
  clock = 60_000; pending!.callback();
  await settle(() => sent === 1);
  values = PolicySchema.parse({ retryTransientErrors: false });
  for (const listener of listeners) listener();
  await settle(() => !existsSync(join(dir, "transient-recovery", "governor.lock")));
  assert.equal(pending, null);
  await cleanup();
  assert.equal(events.size, 0); assert.equal(listeners.size, 0);
});
