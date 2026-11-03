/**
 * The governor's lifecycle: off by default, one governor per host, and handing over
 * to or from the standalone Session Guard plugin without pausing anyone twice.
 *
 * Runs the real `contributeGuard` against a fake plugin host and a fake daemon client
 * in a throwaway PASEO_HOME. The daemon URL also points at a closed port, so nothing
 * here can reach a running Paseo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./server/guard/store.ts";
import { PauseSchema, PolicySchema } from "./shared/guard/policy.ts";
import type { GuardClient } from "./server/guard/client.ts";
import type { ProcessControl } from "./server/guard/processes.ts";
import type { ListedPlugin } from "./server/guard/standalone.ts";

process.env.PASEO_DAEMON_URL = "ws://127.0.0.1:9/ws";
process.env.PASEO_PASSWORD = "guard-host-test";
const { contributeGuard } = await import("./server/guard/index.ts");

type Handler = (input: unknown, context: { paseo: unknown }) => unknown;

const idle = { id: "a", provider: "claude", status: "idle", title: "Task", workspaceId: "w", lastUserMessageAt: null, activeTurn: null };
const smartSession: ListedPlugin = { id: "smart-session", enabled: true };
const standaloneOn: ListedPlugin = { id: "paseo-session-guard", enabled: true };
const standaloneOff: ListedPlugin = { id: "paseo-session-guard", enabled: false };

async function host(t: { after(fn: () => Promise<void>): void }, values: Record<string, unknown> = {}, options: { home?: string; prepare?(dir: string): Promise<void>; plugins?: ListedPlugin[]; processes?: ProcessControl } = {}) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), "guard-host-"));
  process.env.PASEO_HOME = home;
  const dir = join(home, "plugin-data", "session-guard");
  if (options.prepare) { await mkdir(dir, { recursive: true }); await options.prepare(dir); }
  const handlers = new Map<string, Handler>();
  const events = new Map<string, (event: unknown) => void>();
  const listeners = new Set<() => void>();
  let document = { ...values };
  const server = {
    registerSettings: () => ({
      read: async () => ({ status: "ready", revision: "r", values: PolicySchema.parse(document) }),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    }),
    handle: (contract: { name: string }, handler: Handler) => { handlers.set(contract.name, handler); },
    on: (name: string, handler: (event: unknown) => void) => { events.set(name, handler); return () => events.delete(name); },
    before: () => () => {},
  };
  // The daemon's view: no agents, no usage, and whichever plugins the test configures.
  let plugins: ListedPlugin[] | null = options.plugins ?? [smartSession];
  const client = {
    close: async () => {},
    // One idle session, "a", whose saved pauses stay valid while nothing resets.
    fetchAgents: async () => ({ entries: [{ agent: idle }] }),
    fetchAgent: async (id: string) => (id === "a" ? { agent: idle } : null),
    listProviderUsage: async () => ({ fetchedAt: new Date().toISOString(), providers: [] }),
    listPlugins: async () => { if (plugins === null) throw new Error("daemon unavailable"); return plugins; },
    cancelAgent: async () => {},
    sendMessage: async () => { throw new Error("no message may be sent in these tests"); },
  } as unknown as GuardClient;
  const cleanup = contributeGuard(server as never, { connect: work => work(client), processes: options.processes });
  let cleaned = false;
  const stop = async () => { if (!cleaned) { cleaned = true; await cleanup(); } };
  t.after(async () => { await stop(); await rm(home, { recursive: true, force: true }); });
  const rpc = (name: string, input: unknown = {}) => Promise.resolve(handlers.get(`smart-session.guard.${name}`)!(input, { paseo: {} }));
  const status = async () => (await rpc("status")) as { governor: string; standalone: boolean | null; error: string | null; pauses: unknown[] };
  return {
    home, rpc, status, stop,
    dir,
    /** A settings save, as the host would announce it. */
    save(patch: Record<string, unknown>) { document = { ...document, ...patch }; for (const listener of listeners) listener(); },
    poke() { events.get("agent.turn_started")?.({}); },
    /** What the daemon's plugin list reports from now on; null makes it fail. */
    plugins(next: ListedPlugin[] | null) { plugins = next; },
  };
}

async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting until ${what}`);
}

test("off by default: no lock, no state directory, and no action is accepted", async t => {
  const h = await host(t);
  await until(async () => (await h.status()).governor === "off", "the first pass settles");
  assert.equal(existsSync(h.dir), false, "an unused feature leaves nothing on disk");
  await assert.rejects(h.rpc("protection", { agentId: "a", enabled: false }), /off on this host/);
  const agent = (await h.rpc("agent", { agentId: "a" })) as { protected: boolean; summary: string[] };
  assert.equal(agent.protected, false);
  assert.match(agent.summary[0], /off for this session/);
});

test("never governs while the standalone plugin is enabled, even with the lock free, and takes over once it is disabled", async t => {
  const h = await host(t, { enabled: true }, { plugins: [smartSession, standaloneOn] });
  await until(async () => (await h.status()).governor === "deferred", "it defers");
  const status = await h.status();
  assert.equal(status.standalone, true);
  assert.match(status.error ?? "", /Disable or uninstall Session Guard/);
  await assert.rejects(h.rpc("protection", { agentId: "a", enabled: false }), /standalone Session Guard/);
  // Free to take, and still not taken: the standalone's teardown would undo its pauses.
  await (await new Store(h.dir).lock().catch(async () => { await mkdir(h.dir, { recursive: true }); return new Store(h.dir).lock(); }))();
  assert.equal(existsSync(join(h.dir, "state.json")), false, "a deferring plugin writes nothing");

  h.plugins([smartSession, standaloneOff]);
  h.poke();
  await until(async () => (await h.status()).governor === "active", "it takes over once the standalone is disabled");
  await assert.rejects(new Store(h.dir).lock(), /already running/, "and now holds the lock itself");
  await h.stop();
  await (await new Store(h.dir).lock())();
});

test("recognises the standalone plugin installed under another id", async t => {
  const h = await host(t, { enabled: true }, { plugins: [smartSession, { id: "guard", enabled: true, npm: { packageName: "paseo-session-guard" } }] });
  await until(async () => (await h.status()).governor === "deferred", "it defers");
});

test("waits for the standalone plugin to let go of the lock after it is disabled", async t => {
  let standalone: () => Promise<void> = async () => {};
  const h = await host(t, { enabled: true }, { plugins: [smartSession, standaloneOff], prepare: async dir => { standalone = await new Store(dir).lock(); } });
  await until(async () => (await h.status()).governor === "deferred", "it defers to the held lock");
  await standalone();
  h.poke();
  await until(async () => (await h.status()).governor === "active", "it takes over");
});

test("hands the host back when the standalone plugin is enabled while it governs", async t => {
  // A suspended session, under a fake process controller: nothing real is signalled.
  const pause = PauseSchema.parse({ id: "p", agentId: "a", provider: "claude", title: "Task", windowId: "five_hour", anchorResetsAt: null, pausedAt: "2026-10-06T00:00:00Z", lastUserMessageAt: null, turnId: null, phase: "waiting", note: null, settledAt: null,
    suspension: { rootPid: 4321, processes: [{ pid: 4321, startTime: "1" }] } });
  const released: number[] = [];
  const processes: ProcessControl = {
    discover: async () => null, freeze: async () => {}, stopped: async () => released.length === 0,
    resume: async suspension => { released.push(suspension.rootPid); },
  };
  const h = await host(t, { enabled: true }, { processes, prepare: dir => writeFile(join(dir, "state.json"), JSON.stringify({ version: 1, overrides: {}, pauses: [pause] })) });
  await until(async () => (await h.status()).governor === "active", "it governs");
  h.plugins([smartSession, standaloneOn]);
  h.poke();
  await until(async () => (await h.status()).governor === "deferred", "it steps aside");
  assert.match((await h.status()).error ?? "", /released its paused sessions/);
  await until(async () => new Store(h.dir).lock().then(async release => { await release(); return true; }, () => false), "it gives the lock back");
  const saved = JSON.parse(await readFile(join(h.dir, "state.json"), "utf8"));
  assert.deepEqual(released, [4321], "suspended workers are released before letting go");
  assert.equal(saved.pauses[0].releasedForUnload, true);
  assert.equal(saved.pauses[0].phase, "waiting", "and the confirmed wait is kept for whoever governs next");
});

test("does not govern when the plugin list cannot be read", async t => {
  const h = await host(t, { enabled: true }, { plugins: null as never });
  h.plugins(null);
  h.poke();
  await until(async () => (await h.status()).governor === "error", "it reports the problem");
  assert.match((await h.status()).error ?? "", /could not check which plugins/);
  await mkdir(h.dir, { recursive: true });
  await (await new Store(h.dir).lock())();
});

test("teardown gives the lock back even when releasing workers fails", async t => {
  const h = await host(t, { enabled: true });
  await until(async () => (await h.status()).governor === "active", "it governs");
  await writeFile(join(h.dir, "state.json"), "broken");
  await assert.rejects(h.stop(), /could not be read/);
  await (await new Store(h.dir).lock())();
});

test("a second install on the same host defers instead of governing alongside", async t => {
  const first = await host(t, { enabled: true });
  await until(async () => (await first.status()).governor === "active", "the first governs");
  const second = await host(t, { enabled: true }, { home: first.home });
  await until(async () => (await second.status()).governor === "deferred", "the second defers");
  assert.equal((await first.status()).governor, "active");
});

test("carried-over choices and waits are read from the standalone plugin's state", async t => {
  const pause = PauseSchema.parse({ id: "p", agentId: "a", provider: "claude", title: "Task", windowId: "five_hour", anchorResetsAt: null, pausedAt: "2026-10-06T00:00:00Z", lastUserMessageAt: null, turnId: null, phase: "waiting", note: null, settledAt: null });
  const h = await host(t, { enabled: true }, { prepare: dir => writeFile(join(dir, "state.json"), JSON.stringify({ version: 1, overrides: { b: false }, pauses: [pause] })) });
  await until(async () => (await h.status()).governor === "active", "it governs");
  const status = (await h.rpc("status")) as { overrides: Record<string, boolean>; pauses: { id: string }[] };
  assert.deepEqual(status.overrides, { b: false });
  assert.deepEqual(status.pauses.map(p => p.id), ["p"]);
});

test("turning it off gives the lock back, but not while a pause still waits on it", async t => {
  const pause = PauseSchema.parse({ id: "p", agentId: "a", provider: "claude", title: "Task", windowId: "five_hour", anchorResetsAt: null, pausedAt: "2026-10-06T00:00:00Z", lastUserMessageAt: null, turnId: null, phase: "waiting", note: null, settledAt: null });
  const h = await host(t, { enabled: true }, { prepare: dir => writeFile(join(dir, "state.json"), JSON.stringify({ version: 1, overrides: {}, pauses: [pause] })) });
  await until(async () => (await h.status()).governor === "active", "it governs");

  h.save({ enabled: false });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await h.status()).governor, "active", "a held continuation still needs its owner");
  await assert.rejects(new Store(h.dir).lock(), /already running/);

  await h.rpc("cancel", { agentId: "a" });
  h.save({ enabled: false });
  await until(async () => (await h.status()).governor === "off", "it stands down");
  await (await new Store(h.dir).lock())();
});

test("a deferring plugin's teardown leaves the other governor's suspended workers alone", async t => {
  // A PID that cannot exist, so no real process is ever signalled.
  const pause = PauseSchema.parse({ id: "p", agentId: "a", provider: "claude", title: "Task", windowId: "five_hour", anchorResetsAt: null, pausedAt: "2026-10-06T00:00:00Z", lastUserMessageAt: null, turnId: "t", phase: "waiting", note: null, settledAt: null,
    suspension: { rootPid: 2_147_483_646, processes: [{ pid: 2_147_483_646, startTime: "1" }] } });
  const saved = JSON.stringify({ version: 1, overrides: {}, pauses: [pause] });
  let standalone: () => Promise<void> = async () => {};
  const h = await host(t, { enabled: true }, { prepare: async dir => { await writeFile(join(dir, "state.json"), saved); standalone = await new Store(dir).lock(); } });
  await until(async () => (await h.status()).governor === "deferred", "it defers");
  await h.stop();
  assert.equal(await readFile(join(h.dir, "state.json"), "utf8"), saved, "only the owner may release or rewrite a pause");
  await standalone();
});
