import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./server/guard/engine.ts";
import { Store } from "./server/guard/store.ts";
import { PolicySchema, type Agent, type Policy, type Usage } from "./shared/guard/policy.ts";
import type { GuardClient } from "./server/guard/client.ts";
import type { ProcessControl, Suspension } from "./server/guard/processes.ts";
import type { PublishTimeline } from "./server/guard/timeline.ts";

const base = Date.parse("2026-10-06T10:00:00Z");
const end = base + 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
// Session Guard is off by default in Smart Session; the engine is only ever run with it on.
const policyOf = (patch: Partial<Policy> = {}) => PolicySchema.parse({ enabled: true, ...patch });
function nativeControl() {
  const calls = { frozen: [] as number[], released: [] as number[] };
  const stopped = new Set<number>();
  const controller: ProcessControl = {
    discover: async () => ({ rootPid: 1234, processes: [{ pid: 1234, startTime: "111" }, { pid: 1235, startTime: "112" }] }),
    freeze: async (suspension, journal) => { await journal(); calls.frozen.push(suspension.rootPid); stopped.add(suspension.rootPid); },
    resume: async suspension => { calls.released.push(suspension.rootPid); stopped.delete(suspension.rootPid); },
    stopped: async suspension => stopped.has(suspension.rootPid),
  };
  return { calls, stopped, controller };
}
async function nativeFixture(t: { after(fn: () => Promise<void>): void }, patch: Partial<Policy> = {}) {
  const native = nativeControl();
  const f = await fixture(t, patch, native.controller);
  f.client.getDaemonStatus = async () => ({ pid: 9001 });
  f.client.listProviderSubagents = async () => ({ subagents: [] });
  return { ...f, native };
}
async function fixture(t: { after(fn: () => Promise<void>): void }, patch: Partial<Policy> = {}, processes?: ProcessControl, publish?: PublishTimeline) {
  const dir = await mkdtemp(join(tmpdir(), "session-guard-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  let now = base;
  let policy = policyOf(patch);
  const agents: Agent[] = [{ id: "a", provider: "claude", status: "running", title: "Task", workspaceId: "w", lastUserMessageAt: iso(base - 1000), activeTurn: { turnId: "t1" } }];
  let usage: Usage = { fetchedAt: iso(now), providers: [{ providerId: "claude", status: "available", windows: [{ id: "five_hour", usedPct: 100, resetsAt: iso(end) }] }] };
  const calls: { stopped: string[]; sent: string[]; ids: string[] } = { stopped: [], sent: [], ids: [] };
  const client: GuardClient = {
    fetchAgents: async () => ({ entries: agents.map(agent => ({ agent: { ...agent } })) }),
    fetchAgent: async id => { const a = agents.find(a => a.id === id); return a ? { agent: { ...a } } : null; },
    listProviderUsage: async () => usage,
    cancelAgent: async id => { calls.stopped.push(id); const a = agents.find(a => a.id === id)!; a.status = "idle"; a.activeTurn = null; },
    sendMessage: async (id, text, options) => { assert.match(text, /unfinished task/); calls.sent.push(id); calls.ids.push(options!.messageId); const a = agents.find(a => a.id === id)!; a.status = "running"; a.lastUserMessageAt = iso(now); a.activeTurn = { turnId: "continued" }; },
  };
  const engine = new Engine(store, async () => policy, async work => work(client), () => now, processes, publish);
  const reset = () => { now = end + 31_000; usage = { fetchedAt: iso(now), providers: [{ providerId: "claude", status: "available", windows: [{ id: "five_hour", usedPct: 0, resetsAt: iso(end + 5 * 3600_000) }] }] }; };
  return { store, engine, agents, client, calls, reset, policy: (patch: Partial<Policy>) => { policy = { ...policy, ...patch }; }, time: (ms: number) => { now = ms; }, usage: (next: Usage) => { usage = next; } };
}

test("100% pauses running work and resumes once in the same conversation after a confirmed reset", async t => {
  const f = await fixture(t); await f.engine.tick(); await f.engine.tick();
  assert.deepEqual(f.calls.stopped, ["a"]); assert.deepEqual(f.calls.sent, []);
  const pause = (await f.store.read()).pauses[0]; assert.equal(pause.phase, "waiting");
  f.reset(); await f.engine.tick(); await f.engine.tick();
  assert.deepEqual(f.calls.sent, ["a"]); assert.equal(f.calls.ids[0], pause.id);
  assert.equal((await f.store.read()).pauses[0].phase, "resumed");
});
test("confirmed pause and resume each write one durable timeline event", async t => {
  const events: string[] = [];
  const f = await fixture(t, {}, undefined, async (_agent, notification) => { events.push(notification.data.event); });
  await f.engine.tick(); await f.engine.deliverTimeline(); await f.engine.tick(); assert.deepEqual(events, ["paused"]);
  f.reset(); await f.engine.tick(); await f.engine.deliverTimeline(); await f.engine.tick(); assert.deepEqual(events, ["paused", "resumed"]);
  assert.ok((await f.store.read()).pauses[0].notifications!.every(n => n.delivery === "sent"));
});
test("ambiguous timeline acknowledgements are reconciled without repeating the quota action", async t => {
  const published = new Set<string>(); let lost = true; let reconciled = false;
  const f = await fixture(t, {}, undefined, async (_agent, notification, reconcile) => {
    if (reconcile && published.has(notification.id)) { reconciled = true; return; }
    assert.ok(!published.has(notification.id)); published.add(notification.id);
    if (lost) { lost = false; throw new Error("ack lost"); }
  });
  await f.engine.tick(); await f.engine.deliverTimeline(); assert.match(f.engine.timelineError!, /awaiting delivery/);
  assert.equal((await f.store.read()).pauses[0].phase, "waiting");
  await f.engine.tick(); await f.engine.deliverTimeline(); assert.equal(reconciled, true); assert.equal(f.engine.timelineError, null);
  assert.deepEqual(f.calls.stopped, ["a"]); assert.equal(published.size, 1);
});
test("timeline backfill covers existing confirmed pauses; ambiguous stops never claim a pause succeeded", async t => {
  const f = await fixture(t); await f.engine.tick(); const events: string[] = [];
  const engine = new Engine(f.store, async () => policyOf(), async work => work(f.client), () => base, undefined,
    async (_agent, notification) => { events.push(notification.data.event); });
  await engine.tick(); await engine.deliverTimeline(); await engine.tick(); assert.deepEqual(events, ["paused"]);
  const broken = await fixture(t, {}, undefined, async (_agent, notification) => { events.push(notification.data.event); });
  broken.client.cancelAgent = async () => { throw new Error("unknown stop"); };
  await broken.engine.tick(); await broken.engine.deliverTimeline(); assert.deepEqual(events, ["paused", "attention"]);
});
test("manual cancellation records a timeline event without claiming an interrupted session was resumed", async t => {
  const events: string[] = [];
  const f = await fixture(t, {}, undefined, async (_agent, notification) => { events.push(notification.data.event); });
  await f.engine.tick(); await f.engine.cancelResume("a"); await f.engine.deliverTimeline(); await f.engine.tick();
  assert.deepEqual(events, ["paused", "released"]); assert.deepEqual(f.calls.sent, []);
});
test("Resume now bypasses a full quota once, opts out, and records truthful manual recovery", async t => {
  const events: { event: string; manualResume?: boolean }[] = [];
  const f = await fixture(t, { autoResume: false }, undefined, async (_, n) => { events.push(n.data); });
  await f.engine.tick(); const pause = (await f.store.read()).pauses[0];
  await Promise.all([f.engine.resumeNow("a", pause.id), f.engine.resumeNow("a", pause.id)]);
  await f.engine.tick(); await f.engine.deliverTimeline();
  assert.deepEqual(f.calls.sent, ["a"]); assert.equal((await f.store.read()).overrides.a, false);
  assert.equal((await f.store.read()).pauses[0].phase, "resumed");
  assert.deepEqual(events.map(n => [n.event, !!n.manualResume]), [["paused", false], ["resumed", true]]);
});
test("dismiss cancels an interrupted continuation and survives reset without sending", async t => {
  const events: { event: string; dismissed?: boolean }[] = [];
  const f = await fixture(t, {}, undefined, async (_, n) => { events.push(n.data); });
  await f.engine.tick(); const pause = (await f.store.read()).pauses[0];
  await f.engine.dismissPause("a", pause.id); f.reset(); await f.engine.tick(); await f.engine.deliverTimeline();
  const state = await f.store.read();
  assert.equal(state.pauses[0].phase, "cancelled"); assert.equal(state.pauses[0].dismissed, true);
  assert.equal(state.overrides.a, false); assert.deepEqual(f.calls.sent, []);
  assert.deepEqual(events.map(n => [n.event, !!n.dismissed]), [["paused", false], ["released", true]]);
});
test("dismiss releases native quota-failed background workers without a continuation or re-freeze", async t => {
  const f = await nativeFixture(t); f.agents[0].status = "error"; f.agents[0].activeTurn = null;
  f.agents[0].lastError = "usage limit reached";
  f.client.listProviderSubagents = async () => ({ subagents: [{ status: "running" }] });
  await f.engine.tick(); const pause = (await f.store.read()).pauses[0];
  assert.equal(pause.wasQuotaFailure, true);
  await Promise.all([f.engine.dismissPause("a", pause.id), f.engine.dismissPause("a", pause.id)]);
  await f.engine.tick(); f.reset(); await f.engine.tick();
  assert.deepEqual(f.native.calls.released, [1234]); assert.deepEqual(f.native.calls.frozen, [1234]);
  assert.deepEqual(f.calls.sent, []); assert.equal((await f.store.read()).overrides.a, false);
});
test("dismissal from an old card cannot affect a newer pause or session override", async t => {
  const f = await fixture(t); await f.engine.tick(); const old = (await f.store.read()).pauses[0];
  await assert.rejects(f.engine.dismissPause("a", "missing"));
  await assert.rejects(f.engine.dismissPause("other", old.id));
  assert.equal((await f.store.read()).overrides.a, undefined);
  await f.engine.dismissPause("a", old.id); await f.engine.setProtection("a", true);
  f.agents[0].status = "running"; f.agents[0].activeTurn = { turnId: "new-turn" }; await f.engine.tick();
  const next = (await f.store.read()).pauses.find(p => p.id !== old.id)!; assert.equal(next.phase, "waiting");
  await f.engine.dismissPause("a", old.id);
  const state = await f.store.read(); assert.equal(state.overrides.a, true);
  assert.equal(state.pauses.find(p => p.id === next.id)!.phase, "waiting"); assert.deepEqual(f.calls.sent, []);
});
test("dismissed saved conversations are never reopened after restart", async t => {
  const f = await fixture(t); await f.engine.tick();
  const state = await f.store.read(); const pause = state.pauses[0];
  pause.restartRecovery = true; pause.closedOnRestart = true; await f.store.write(state);
  f.agents[0].status = "closed";
  await f.engine.dismissPause("a", pause.id); f.reset();
  const reboot = new Engine(f.store, async () => policyOf(), async work => work(f.client), () => end + 36000);
  await reboot.recover(); await reboot.tick();
  assert.equal((await f.store.read()).pauses[0].phase, "cancelled"); assert.deepEqual(f.calls.sent, []);
});
test("a partial dismissal journals cancellation before release and retries after restart without sending", async t => {
  const f = await nativeFixture(t); await f.engine.tick(); const pause = (await f.store.read()).pauses[0];
  const release = f.native.controller.resume; let first = true;
  f.native.controller.resume = async suspension => {
    const state = await f.store.read(); assert.equal(state.overrides.a, false); assert.equal(state.pauses[0].dismissed, true);
    if (first) { first = false; throw new Error("partial"); } await release(suspension);
  };
  await assert.rejects(f.engine.dismissPause("a", pause.id));
  assert.equal((await f.store.read()).pauses[0].phase, "attention");
  const reboot = new Engine(f.store, async () => policyOf(), async work => work(f.client), () => base, f.native.controller);
  await reboot.recover(); await reboot.tick(); f.reset(); await reboot.tick();
  assert.equal((await f.store.read()).pauses[0].phase, "cancelled");
  assert.deepEqual(f.native.calls.released, [1234]); assert.deepEqual(f.calls.sent, []);
});
test("dismiss refuses a continuation already in flight or with ambiguous delivery", async t => {
  const f = await fixture(t); await f.engine.tick();
  for (const phase of ["resuming", "attention"] as const) {
    const state = await f.store.read(); state.pauses[0].phase = phase; await f.store.write(state);
    await assert.rejects(f.engine.dismissPause("a", state.pauses[0].id));
    assert.equal((await f.store.read()).overrides.a, undefined);
  }
  assert.deepEqual(f.calls.sent, []);
});
test("Resume now releases native workers without a new message or immediate re-freeze", async t => {
  const f = await nativeFixture(t); await f.engine.tick(); const pause = (await f.store.read()).pauses[0];
  await f.engine.resumeNow("a", pause.id); await f.engine.tick();
  assert.deepEqual(f.native.calls.released, [1234]); assert.deepEqual(f.calls.sent, []);
  assert.deepEqual(f.native.calls.frozen, [1234]); assert.equal((await f.store.read()).overrides.a, false);
});
test("a historical pause action cannot resume a newer pause, changed work, or pending permission", async t => {
  const f = await fixture(t); await f.engine.tick(); const pause = (await f.store.read()).pauses[0];
  await f.engine.resumeNow("a", "old-pause"); assert.deepEqual(f.calls.sent, []);
  f.agents[0].pendingPermissions = [{}]; await assert.rejects(f.engine.resumeNow("a", pause.id));
  f.agents[0].pendingPermissions = []; f.agents[0].provider = "codex";
  await assert.rejects(f.engine.resumeNow("a", pause.id)); assert.deepEqual(f.calls.sent, []);
  assert.equal((await f.store.read()).overrides.a, undefined);
  // A message held meanwhile is not a change: Resume now continues with it.
  f.agents[0].provider = "claude"; f.agents[0].lastUserMessageAt = iso(base + 1000);
  await f.engine.resumeNow("a", pause.id); assert.deepEqual(f.calls.sent, ["a"]);
});
test("manual resume releases native background workers and continues a quota-failed parent once", async t => {
  const f = await nativeFixture(t); f.agents[0].status = "error"; f.agents[0].activeTurn = null;
  f.agents[0].lastError = "usage limit reached";
  f.client.listProviderSubagents = async () => ({ subagents: [{ status: "running" }] });
  await f.engine.tick(); const pause = (await f.store.read()).pauses[0];
  await f.engine.resumeNow("a", pause.id); await f.engine.tick();
  assert.deepEqual(f.native.calls.released, [1234]); assert.deepEqual(f.calls.sent, ["a"]);
});
test("an unconfirmed manual continuation stays for attention and is never sent twice", async t => {
  const f = await fixture(t); await f.engine.tick(); const pause = (await f.store.read()).pauses[0];
  let attempts = 0; f.client.sendMessage = async () => { attempts++; throw new Error("lost ack"); };
  await assert.rejects(f.engine.resumeNow("a", pause.id)); await f.engine.tick();
  await assert.rejects(f.engine.resumeNow("a", pause.id));
  assert.equal(attempts, 1); assert.equal((await f.store.read()).pauses[0].phase, "attention");
});
test("demo pauses only a labelled empty session and never auto-resumes at a reset", async t => {
  const f = await nativeFixture(t); f.agents[0].status = "idle"; f.agents[0].activeTurn = null; f.agents[0].lastUserMessageAt = null;
  await assert.rejects(f.engine.pauseDemo("a"));
  f.agents[0].labels = { session_guard_demo: "true" }; await f.engine.pauseDemo("a");
  f.reset(); await f.engine.tick();
  const pause = (await f.store.read()).pauses[0]; assert.equal(pause.demo, true); assert.equal(pause.phase, "waiting");
  await f.engine.resumeNow("a", pause.id); assert.deepEqual(f.calls.sent, []); assert.deepEqual(f.native.calls.released, [1234]);
});
test("slow timeline delivery never blocks protecting another session or the user's cancellation", async t => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const begun = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, {}, undefined, async () => { started(); await gate; });
  await f.engine.tick(); const delivery = f.engine.deliverTimeline(); await begun;
  try {
    f.agents.push({ ...f.agents[0], id: "b", status: "running", activeTurn: { turnId: "b-turn" } });
    await f.engine.tick(); await f.engine.cancelResume("a");
    assert.deepEqual(f.calls.stopped, ["a", "b"]); assert.equal((await f.store.read()).pauses.find(p => p.agentId === "a")!.phase, "cancelled");
  } finally { release(); await delivery; }
});
test("a missing session's timeline does not prevent delivery for other sessions", async t => {
  const delivered: string[] = [];
  const f = await fixture(t, {}, undefined, async (agentId) => { if (agentId === "a") throw new Error("missing agent"); delivered.push(agentId); });
  f.agents.push({ ...f.agents[0], id: "b" });
  await f.engine.tick(); await f.engine.deliverTimeline();
  assert.deepEqual(delivered, ["b"]); assert.match(f.engine.timelineError!, /awaiting delivery/);
  assert.equal((await f.store.read()).pauses.find(p => p.agentId === "b")!.notifications![0].delivery, "sent");
});
test("native Claude and Codex workers resume their existing turn without cancellation or a new message", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = await nativeFixture(t);
    f.agents[0].provider = provider;
    f.usage({ fetchedAt: iso(base), providers: [{ providerId: provider, status: "available", windows: [{ id: "session", usedPct: 100, resetsAt: iso(end) }] }] });
    await f.engine.tick(); await f.engine.tick();
    assert.deepEqual(f.native.calls.frozen, [1234]); assert.deepEqual(f.calls.stopped, []);
    assert.equal(f.agents[0].activeTurn?.turnId, "t1");
    f.time(end + 31_000);
    f.usage({ fetchedAt: iso(end + 31_000), providers: [{ providerId: provider, status: "available", windows: [{ id: "session", usedPct: 0, resetsAt: iso(end + 5 * 3600_000) }] }] });
    await f.engine.tick(); await f.engine.tick();
    assert.deepEqual(f.native.calls.released, [1234]); assert.deepEqual(f.calls.sent, []);
    assert.equal((await f.store.read()).pauses[0].phase, "resumed");
  }
});
test("idle parents with running native background subagents are suspended, and so are idle ones without them", async t => {
  for (const background of [true, false]) {
    const f = await nativeFixture(t); f.agents[0].status = "idle"; f.agents[0].activeTurn = null;
    if (background) f.client.listProviderSubagents = async () => ({ subagents: [{ status: "running" }, { status: "completed" }] });
    await f.engine.tick(); assert.deepEqual(f.native.calls.frozen, [1234]);
    assert.equal((await f.store.read()).pauses[0].idle, background ? undefined : true);
    f.reset(); await f.engine.tick(); assert.deepEqual(f.native.calls.released, [1234]); assert.deepEqual(f.calls.sent, []);
  }
});
test("native opt-out and manual release resume workers and prevent immediate re-freezing", async t => {
  for (const action of ["opt-out", "release"]) {
    const f = await nativeFixture(t); await f.engine.tick();
    if (action === "opt-out") await f.engine.setProtection("a", false); else await f.engine.cancelResume("a");
    await f.engine.tick(); assert.deepEqual(f.native.calls.released, [1234]); assert.deepEqual(f.native.calls.frozen, [1234]);
    assert.equal((await f.store.read()).overrides.a, false);
  }
});
test("turning off the master switch, native coverage, or provider scope releases suspended workers", async t => {
  for (const patch of [{ enabled: false }, { includeNativeSubagents: false }, { providerIds: ["codex"] }]) {
    const f = await nativeFixture(t); await f.engine.tick(); f.policy(patch); await f.engine.tick();
    assert.deepEqual(f.native.calls.released, [1234]);
    assert.equal((await f.store.read()).pauses[0].phase, "cancelled");
  }
});
test("auto-resume off holds native workers until the explicit release action", async t => {
  const f = await nativeFixture(t, { autoResume: false }); await f.engine.tick(); f.reset(); await f.engine.tick();
  assert.deepEqual(f.native.calls.released, []); await f.engine.cancelResume("a"); assert.deepEqual(f.native.calls.released, [1234]);
});
test("plugin cleanup releases native workers while preserving a confirmed wait across restart", async t => {
  const f = await nativeFixture(t); await f.engine.tick(); await f.engine.recover();
  assert.deepEqual(f.native.calls.released, []); await f.engine.stop();
  assert.deepEqual(f.native.calls.released, [1234]); assert.equal((await f.store.read()).pauses[0].phase, "waiting");
  assert.equal((await f.store.read()).pauses[0].releasedForUnload, true);
});
test("one worker that cannot be released does not strand the others on unload", async t => {
  const f = await nativeFixture(t);
  f.agents.push({ id: "b", provider: "claude", status: "running", title: "Other", workspaceId: "w", lastUserMessageAt: iso(base - 1000), activeTurn: { turnId: "t2" } });
  const roots: Record<string, number> = { a: 1234, b: 5678 };
  f.native.controller.discover = async agent => ({ rootPid: roots[agent.id], processes: [{ pid: roots[agent.id], startTime: "111" }] });
  await f.engine.tick();
  assert.deepEqual(f.native.calls.frozen.sort(), [1234, 5678]);
  const resume = f.native.controller.resume;
  f.native.controller.resume = async suspension => { if (suspension.rootPid === 1234) throw new Error("signal failed"); await resume(suspension); };
  await assert.rejects(f.engine.stop(), /1 suspended session could not be released/);
  assert.deepEqual(f.native.calls.released, [5678], "the later pause is still released");
  const state = await f.store.read();
  assert.equal(state.pauses.find(p => p.agentId === "b")!.releasedForUnload, true, "and its release is saved");
  assert.equal(state.pauses.find(p => p.agentId === "a")!.releasedForUnload, undefined, "the failed one stays journaled for a retry");
});
test("native crash windows release partial freezes and safely finish an interrupted SIGCONT", async t => {
  for (const phase of ["pausing", "resuming"] as const) {
    const f = await nativeFixture(t); await f.engine.tick();
    const state = await f.store.read(); state.pauses[0].phase = phase; await f.store.write(state);
    await f.engine.recover(); assert.deepEqual(f.native.calls.released, [1234]);
    assert.equal((await f.store.read()).pauses[0].phase, phase === "pausing" ? "attention" : "resumed");
  }
});
test("partial native release failures retry only identity-safe signals and never send a duplicate turn", async t => {
  const f = await nativeFixture(t); await f.engine.tick(); f.reset();
  const release = f.native.controller.resume; let first = true;
  f.native.controller.resume = async suspension => { if (first) { first = false; throw new Error("partial"); } await release(suspension); };
  await f.engine.tick(); assert.equal((await f.store.read()).pauses[0].phase, "resuming");
  await f.engine.tick(); assert.equal((await f.store.read()).pauses[0].phase, "resumed"); assert.deepEqual(f.calls.sent, []);
});
test("ownership ambiguity falls back to the foreground for that session and still protects the others natively", async t => {
  const f = await nativeFixture(t); f.agents.push({ ...f.agents[0], id: "b" });
  const discover = f.native.controller.discover;
  f.native.controller.discover = async (agent, pid) => agent.id === "a" ? null : discover(agent, pid);
  await f.engine.tick(); assert.deepEqual(f.calls.stopped, ["a"]); assert.deepEqual(f.native.calls.frozen, [1234]);
  assert.match(f.engine.error!, /ownership/);
  const state = await f.store.read();
  assert.equal(state.pauses.find(p => p.agentId === "a")!.suspension, undefined);
  assert.ok(state.pauses.find(p => p.agentId === "b")!.suspension);
});
test("a stopped turn or an external release lets suspended workers go without scheduling continuation", async t => {
  for (const action of ["stop", "external-release"]) {
    const f = await nativeFixture(t); await f.engine.tick();
    if (action === "stop") { f.agents[0].status = "idle"; f.agents[0].activeTurn = null; }
    if (action === "external-release") { f.native.stopped.clear(); f.agents[0].status = "idle"; f.agents[0].activeTurn = null; }
    await f.engine.tick(); assert.deepEqual(f.native.calls.released, [1234]); assert.deepEqual(f.calls.sent, []);
    assert.equal((await f.store.read()).pauses[0].phase, "cancelled");
  }
});
test("completed foreground notifications do not release paused native background work", async t => {
  const f = await nativeFixture(t); await f.engine.tick();
  await f.engine.turnEnded("a", "t1", "completed");
  f.agents[0].status = "idle"; f.agents[0].activeTurn = null;
  f.client.listProviderSubagents = async () => ({ subagents: [{ status: "running" }] });
  await f.engine.tick(); assert.deepEqual(f.native.calls.released, []);
  f.reset(); await f.engine.tick(); assert.deepEqual(f.native.calls.released, [1234]);
});
test("a user stop releases native background work and suppresses reset recovery until new work starts", async t => {
  const f = await nativeFixture(t); await f.engine.tick();
  f.agents[0].status = "idle"; f.agents[0].activeTurn = null;
  f.client.listProviderSubagents = async () => ({ subagents: [{ status: "running" }] });
  await f.engine.turnEnded("a", "t1", "canceled"); await f.engine.tick();
  assert.deepEqual(f.native.calls.released, [1234]); assert.deepEqual(f.native.calls.frozen, [1234]);
  assert.equal((await f.store.read()).overrides.a, undefined, "stop does not change the protection preference for future work");
  f.agents[0].lastUserMessageAt = iso(base + 1000); f.agents[0].status = "running"; f.agents[0].activeTurn = { turnId: "new" };
  await f.engine.tick(); assert.deepEqual(f.native.calls.frozen, [1234, 1234]);
});
test("quota-failed parent with live native children resumes children before one parent continuation", async t => {
  const f = await nativeFixture(t); f.agents[0].status = "error"; f.agents[0].activeTurn = null; f.agents[0].lastError = "usage limit reached";
  f.client.listProviderSubagents = async () => ({ subagents: [{ status: "running" }] });
  await f.engine.tick(); assert.deepEqual(f.native.calls.frozen, [1234]);
  f.reset(); await f.engine.tick(); assert.deepEqual(f.native.calls.released, [1234]); assert.deepEqual(f.calls.sent, []);
  await f.engine.tick(); await f.engine.tick(); assert.deepEqual(f.calls.sent, ["a"]);
});
test("a buffered quota error from the resumed native turn gets one recovery message after reset", async t => {
  const f = await nativeFixture(t); await f.engine.tick(); f.reset(); await f.engine.tick();
  f.agents[0].status = "error"; f.agents[0].activeTurn = null;
  f.engine.quotaFailure("a", "usage limit reached", "t1");
  f.time(end + 36_000); // Respect spacing after the process-tree release.
  await f.engine.tick(); await f.engine.tick(); assert.deepEqual(f.calls.sent, ["a"]);
});
test("ordinary errors or a different native turn never get a recovery message", async t => {
  for (const [error, turn] of [["socket timeout", "t1"], ["usage limit reached", "different"]]) {
    const f = await nativeFixture(t); await f.engine.tick(); f.reset(); await f.engine.tick();
    f.agents[0].status = "error"; f.agents[0].activeTurn = null;
    f.engine.quotaFailure("a", error, turn); await f.engine.tick(); assert.deepEqual(f.calls.sent, []);
  }
});
test("native suspension preserves outstanding permission prompts without answering them", async t => {
  const f = await nativeFixture(t); f.agents[0].pendingPermissions = [{ id: "permission" }];
  await f.engine.tick(); assert.deepEqual(f.native.calls.frozen, [1234]);
  f.reset(); await f.engine.tick(); assert.deepEqual(f.native.calls.released, [1234]);
  assert.deepEqual(f.agents[0].pendingPermissions, [{ id: "permission" }]); assert.deepEqual(f.calls.sent, []);
});
test("99.9% and an exhausted weekly window alone do not interrupt", async t => {
  const f = await fixture(t); f.usage({ fetchedAt: iso(base), providers: [{ providerId: "claude", status: "available", windows: [{ id: "five_hour", usedPct: 99.9, resetsAt: iso(end) }, { id: "weekly", usedPct: 100 }] }] });
  await f.engine.tick(); assert.deepEqual(f.calls.stopped, []);
});
test("configured threshold, provider selection, and opt-in default are honored", async t => {
  const f = await fixture(t, { protectByDefault: false, thresholdPct: 90 });
  await f.engine.tick(); assert.deepEqual(f.calls.stopped, []);
  await f.engine.setProtection("a", true); f.policy({ providerIds: ["codex"] }); await f.engine.tick(); assert.deepEqual(f.calls.stopped, []);
  f.policy({ providerIds: [] }); await f.engine.tick(); assert.deepEqual(f.calls.stopped, ["a"]);
});
test("session opt-out cancels a scheduled continuation and survives reload", async t => {
  const f = await fixture(t); await f.engine.tick(); await f.engine.setProtection("a", false);
  f.reset(); await f.engine.recover(); await f.engine.tick();
  assert.deepEqual(f.calls.sent, []); assert.equal((await f.store.read()).overrides.a, false);
  assert.equal((await f.store.read()).pauses[0].phase, "cancelled");
});
test("using the default removes only the explicit override", async t => {
  const f = await fixture(t); await f.engine.setProtection("a", false); await f.engine.setProtection("a", null);
  assert.deepEqual((await f.store.read()).overrides, {}); await f.engine.tick(); assert.deepEqual(f.calls.stopped, ["a"]);
});
test("same-window timestamp jitter and earlier usage fetches cannot resume", async t => {
  const f = await fixture(t); await f.engine.tick(); f.time(base + 31_000);
  f.usage({ fetchedAt: iso(base + 31_000), providers: [{ providerId: "claude", status: "available", windows: [{ id: "five_hour", usedPct: 0, resetsAt: iso(end + 310) }] }] });
  await f.engine.tick(); assert.deepEqual(f.calls.sent, []);
  f.reset(); f.usage({ fetchedAt: iso(base), providers: [{ providerId: "claude", status: "available", windows: [{ id: "five_hour", usedPct: 0, resetsAt: iso(end + 5 * 3600_000) }] }] });
  await f.engine.tick(); assert.deepEqual(f.calls.sent, []);
});
test("clock reaching reset with a cached 100% report does not resume", async t => {
  const f = await fixture(t); await f.engine.tick(); f.time(end + 31_000); await f.engine.tick(); assert.deepEqual(f.calls.sent, []);
});
test("an expired cached window cannot pause a new task", async t => {
  const f = await fixture(t); f.time(end + 31_000); await f.engine.tick(); assert.deepEqual(f.calls.stopped, []);
});
test("fresh available capacity after grace resumes even before upstream changes its reset timestamp", async t => {
  const f = await fixture(t); await f.engine.tick(); f.time(end + 31_000);
  f.usage({ fetchedAt: iso(end + 31_000), providers: [{ providerId: "claude", status: "available", windows: [{ id: "five_hour", usedPct: 0, resetsAt: iso(end) }] }] });
  await f.engine.tick(); assert.deepEqual(f.calls.sent, ["a"]);
});
test("provider errors, unavailable percentages, and missing windows hold the pause", async t => {
  const f = await fixture(t); await f.engine.tick(); f.reset();
  for (const provider of [{ providerId: "claude", status: "error", windows: [] }, { providerId: "claude", status: "available", windows: [] }, { providerId: "claude", status: "available", windows: [{ id: "five_hour", usedPct: null }] }]) {
    f.usage({ fetchedAt: iso(end + 31_000), providers: [provider] }); await f.engine.tick();
  }
  assert.deepEqual(f.calls.sent, []);
});
test("missing reset time adopts a fresh below-limit reading after grace", async t => {
  const f = await fixture(t); f.usage({ fetchedAt: iso(base), providers: [{ providerId: "claude", status: "available", windows: [{ id: "five_hour", usedPct: 100 }] }] });
  await f.engine.tick(); f.time(base + 31_000);
  f.usage({ fetchedAt: iso(base + 31_000), providers: [{ providerId: "claude", status: "available", windows: [{ id: "five_hour", remainingPct: 100 }] }] });
  await f.engine.tick(); assert.deepEqual(f.calls.sent, ["a"]);
});
test("closure, archival, removal, or provider switch cancels continuation", async t => {
  for (const change of ["closed", "archived", "removed", "provider"]) {
    const f = await fixture(t); await f.engine.tick();
    if (change === "closed") f.agents[0].status = "closed";
    if (change === "archived") f.agents[0].archivedAt = iso(base + 1000);
    if (change === "removed") f.agents.length = 0;
    if (change === "provider") f.agents[0].provider = "codex";
    f.reset(); await f.engine.tick(); assert.deepEqual(f.calls.sent, [], change);
    assert.equal((await f.store.read()).pauses[0].phase, "cancelled", change);
  }
});
test("pending permissions and idle sessions are never interrupted", async t => {
  const f = await fixture(t); f.agents[0].pendingPermissions = [{}]; await f.engine.tick();
  f.agents[0].pendingPermissions = []; f.agents[0].status = "idle"; await f.engine.tick(); assert.deepEqual(f.calls.stopped, []);
});
test("master and auto-resume switches hold work; re-enabling releases it", async t => {
  const f = await fixture(t); await f.engine.tick(); f.reset();
  f.policy({ enabled: false }); await f.engine.tick(); f.policy({ enabled: true, autoResume: false }); await f.engine.tick(); assert.deepEqual(f.calls.sent, []);
  f.policy({ autoResume: true }); await f.engine.tick(); assert.deepEqual(f.calls.sent, ["a"]);
});
test("multiple sessions are all paused, with continuations spaced after reset", async t => {
  const f = await fixture(t); f.agents.push({ ...f.agents[0], id: "b" }); await f.engine.tick(); assert.deepEqual(f.calls.stopped, ["a", "b"]);
  f.reset(); await f.engine.tick(); assert.deepEqual(f.calls.sent, ["a"]);
  f.time(end + 36_000); await f.engine.tick(); assert.deepEqual(f.calls.sent, ["a", "b"]);
});
test("confirmed waiting work survives a new governor instance", async t => {
  const f = await fixture(t); await f.engine.tick(); f.reset(); await f.engine.recover(); await f.engine.tick(); assert.deepEqual(f.calls.sent, ["a"]);
});
test("ambiguous send is never retried after a connection error or reload", async t => {
  const f = await fixture(t); await f.engine.tick(); f.reset();
  f.client.sendMessage = async id => { f.calls.sent.push(id); throw new Error("socket lost"); };
  await f.engine.tick(); await f.engine.tick(); await f.engine.recover(); await f.engine.tick();
  assert.deepEqual(f.calls.sent, ["a"]); assert.equal((await f.store.read()).pauses[0].phase, "attention");
});
test("reload during an unconfirmed stop or send asks for inspection", async t => {
  const f = await fixture(t); await f.engine.tick(); const state = await f.store.read();
  for (const phase of ["pausing", "resuming"] as const) {
    state.pauses[0].phase = phase; await f.store.write(state); await f.engine.recover();
    assert.equal((await f.store.read()).pauses[0].phase, "attention");
  }
});
test("a turn completed during cancellation does not restart", async t => {
  const f = await fixture(t); await f.engine.tick(); await f.engine.turnEnded("a", "t1", "completed");
  f.reset(); await f.engine.tick(); assert.deepEqual(f.calls.sent, []);
});
test("ordinary errors never restart; a quota rejection at 100% is resumed", async t => {
  const f = await fixture(t); f.agents[0].status = "error"; f.engine.quotaFailure("a", "Tool failed"); await f.engine.tick(); assert.equal((await f.store.read()).pauses.length, 0);
  f.engine.quotaFailure("a", "You've hit your limit"); await f.engine.tick(); assert.equal((await f.store.read()).pauses[0].wasQuotaFailure, true);
  assert.deepEqual(f.calls.stopped, []); f.reset(); await f.engine.tick(); assert.deepEqual(f.calls.sent, ["a"]);
});
test("cancelled quota-error continuation cannot be recreated from a persistent lastError", async t => {
  const f = await fixture(t); f.agents[0].status = "error"; f.agents[0].lastError = "usage limit reached";
  await f.engine.tick(); await f.engine.cancelResume("a"); await f.engine.tick();
  assert.equal((await f.store.read()).pauses.length, 1);
  f.reset(); await f.engine.tick(); assert.deepEqual(f.calls.sent, []);
});
test("snapshot recheck avoids stopping a turn that just completed", async t => {
  const f = await fixture(t); f.client.fetchAgent = async () => ({ agent: { ...f.agents[0], status: "idle" } });
  await f.engine.tick(); assert.deepEqual(f.calls.stopped, []);
});
test("snapshot recheck avoids sending into newly continued work", async t => {
  const f = await fixture(t); await f.engine.tick(); f.reset();
  f.client.fetchAgent = async () => ({ agent: { ...f.agents[0], status: "running", lastUserMessageAt: iso(end) } });
  await f.engine.tick(); assert.deepEqual(f.calls.sent, []);
});
test("daemon outage does not discard a pause and the next tick recovers", async t => {
  const f = await fixture(t); await f.engine.tick(); f.reset(); const read = f.client.listProviderUsage;
  f.client.listProviderUsage = async () => { throw new Error("offline"); }; await f.engine.tick(); assert.ok(f.engine.error);
  f.client.listProviderUsage = read; await f.engine.tick(); assert.equal(f.engine.error, null); assert.deepEqual(f.calls.sent, ["a"]);
});
test("concurrent ticks do not double stop or send", async t => {
  const f = await fixture(t); await Promise.all([f.engine.tick(), f.engine.tick(), f.engine.tick()]); assert.deepEqual(f.calls.stopped, ["a"]);
  f.reset(); await Promise.all([f.engine.tick(), f.engine.tick()]); assert.deepEqual(f.calls.sent, ["a"]);
});
test("all pages of agents are checked", async t => {
  const f = await fixture(t); f.agents.push({ ...f.agents[0], id: "b" });
  f.client.fetchAgents = async options => options?.page?.cursor ? { entries: [{ agent: f.agents[1] }], pageInfo: { hasMore: false } } : { entries: [{ agent: f.agents[0] }], pageInfo: { hasMore: true, nextCursor: "page2" } };
  await f.engine.tick(); assert.deepEqual(f.calls.stopped, ["a", "b"]);
});


test("confirmed native pauses survive abrupt and graceful daemon restarts, then continue once after fresh reset", async t => {
  for (const graceful of [false, true]) {
    const f = await nativeFixture(t); await f.engine.tick();
    const original = (await f.store.read()).pauses[0];
    if (graceful) await f.engine.stop();
    f.native.stopped.clear(); f.native.controller.alive = async () => false;
    f.agents[0].status = "idle"; f.agents[0].activeTurn = null;
    const events: { event: string; native: boolean }[] = [];
    const restarted = new Engine(new Store(f.store.directory), async () => policyOf(), async work => work(f.client), () => end + 31_000,
      f.native.controller, async (_, n) => { events.push(n.data); });
    await restarted.recover(); await restarted.tick(); await restarted.tick();
    const waiting = (await f.store.read()).pauses[0];
    assert.equal(waiting.phase, "waiting"); assert.equal(waiting.restartRecovery, true);
    assert.equal(waiting.suspension, undefined); assert.equal(waiting.anchorResetsAt, original.anchorResetsAt);
    assert.deepEqual(f.calls.sent, [], "elapsed reset time with stale/full quota must not resume");
    // Even a second plugin restart keeps the recovered waiting conversation.
    const second = new Engine(new Store(f.store.directory), async () => policyOf(), async work => work(f.client), () => end + 31_000,
      f.native.controller, async (_, n) => { events.push(n.data); });
    f.reset(); await second.recover(); await second.tick(); await second.tick(); await second.deliverTimeline();
    assert.deepEqual(f.calls.sent, ["a"]); assert.deepEqual(f.calls.ids, [original.id]);
    const settled = (await f.store.read()).pauses[0]; assert.equal(settled.phase, "resumed");
    assert.ok(events.some(n => n.event === "recovery" && !n.native));
    assert.ok(events.some(n => n.event === "resumed" && !n.native));
  }
});
test("a living externally released worker, changed conversation, user stop, and opt-out never become restart recovery", async t => {
  for (const reason of ["external", "stop", "opt-out"]) {
    const f = await nativeFixture(t); await f.engine.tick();
    f.native.stopped.clear(); f.native.controller.alive = async () => reason === "external";
    f.agents[0].status = "idle"; f.agents[0].activeTurn = null;
    if (reason === "stop") await f.engine.turnEnded("a", "t1", "canceled");
    if (reason === "opt-out") await f.engine.setProtection("a", false);
    await f.engine.tick(); f.reset(); await f.engine.tick();
    const pause = (await f.store.read()).pauses[0];
    assert.equal(pause.phase, "cancelled"); assert.notEqual(pause.restartRecovery, true); assert.deepEqual(f.calls.sent, []);
  }
});
test("recovered restart waits respect automatic resume being disabled", async t => {
  const f = await nativeFixture(t, { autoResume: false }); await f.engine.tick();
  f.native.stopped.clear(); f.native.controller.alive = async () => false;
  f.agents[0].status = "idle"; f.agents[0].activeTurn = null;
  await f.engine.tick(); f.reset(); await f.engine.tick();
  assert.equal((await f.store.read()).pauses[0].phase, "waiting"); assert.deepEqual(f.calls.sent, []);
});

test("a restart between journaling native release and SIGCONT preserves the original confirmed wait", async t => {
  const f = await nativeFixture(t); await f.engine.tick();
  const state = await f.store.read(); state.pauses[0].phase = "resuming"; await f.store.write(state);
  f.native.stopped.clear(); f.native.controller.alive = async () => false;
  f.agents[0].status = "idle"; f.agents[0].activeTurn = null;
  await f.engine.recover(); await f.engine.tick();
  assert.equal((await f.store.read()).pauses[0].phase, "waiting");
  assert.equal((await f.store.read()).pauses[0].restartRecovery, true); assert.deepEqual(f.calls.sent, []);
  f.reset(); await f.engine.tick(); await f.engine.tick(); assert.deepEqual(f.calls.sent, ["a"]);
});

test("stopped orphan workers from the previous daemon are released without dropping the saved conversation", async t => {
  const f = await nativeFixture(t); await f.engine.tick();
  f.native.controller.alive = async () => true; f.native.controller.owned = async () => false;
  f.agents[0].status = "idle"; f.agents[0].activeTurn = null;
  await f.engine.tick();
  assert.deepEqual(f.native.calls.released, [1234]);
  const pause = (await f.store.read()).pauses[0]; assert.equal(pause.phase, "waiting"); assert.equal(pause.restartRecovery, true);
  assert.deepEqual(f.calls.sent, []); f.reset(); await f.engine.tick(); await f.engine.tick(); assert.deepEqual(f.calls.sent, ["a"]);
});

test("gracefully closed snapshots survive changed daemon identities and reopen the same conversation only after reset", async t => {
  const f = await nativeFixture(t); let daemon = "boot:daemon-one";
  f.native.controller.daemonIdentity = async () => daemon;
  await f.engine.tick(); const original = (await f.store.read()).pauses[0];
  assert.equal(original.daemonIdentity, daemon);
  await f.engine.stop(); f.native.stopped.clear(); daemon = "boot:daemon-two";
  f.agents[0].status = "closed"; f.agents[0].activeTurn = null; f.native.controller.alive = async () => false;
  const restarted = new Engine(new Store(f.store.directory), async () => policyOf(), async work => work(f.client), () => end + 31_000, f.native.controller);
  await restarted.recover(); await restarted.tick(); await restarted.tick();
  const saved = (await f.store.read()).pauses[0]; assert.equal(saved.phase, "waiting");
  assert.equal(saved.closedOnRestart, true); assert.equal(saved.restartRecovery, true); assert.deepEqual(f.calls.sent, []);
  daemon = "different-boot:daemon-three"; await restarted.tick(); assert.equal((await f.store.read()).pauses[0].phase, "waiting");
  f.reset(); await restarted.tick(); await restarted.tick(); assert.deepEqual(f.calls.sent, ["a"]); assert.deepEqual(f.calls.ids, [original.id]);
});
test("closing or archiving a session in the same daemon does not authorize reopening it", async t => {
  for (const action of ["closed", "archived"]) {
    const f = await nativeFixture(t); f.native.controller.daemonIdentity = async () => "same-daemon";
    await f.engine.tick(); f.native.stopped.clear(); f.native.controller.alive = async () => false;
    f.agents[0].status = action === "closed" ? "closed" : "idle"; f.agents[0].activeTurn = null;
    if (action === "archived") f.agents[0].archivedAt = iso(base + 1000);
    await f.engine.tick(); f.reset(); await f.engine.tick();
    assert.equal((await f.store.read()).pauses[0].phase, "cancelled"); assert.deepEqual(f.calls.sent, []);
  }
});
test("a running session at the limit whose native ownership can't be confirmed is still paused, in the foreground", async t => {
  // Live 2026-11-11: two provider processes carried the agent's id, discover() returned null,
  // and the session ran on past the limit with no pause at all.
  const f = await nativeFixture(t); f.native.controller.discover = async () => null;
  await f.engine.tick();
  assert.deepEqual(f.calls.stopped, ["a"], "the turn is interrupted");
  assert.deepEqual(f.native.calls.frozen, [], "nothing is frozen without confirmed ownership");
  const pause = (await f.store.read()).pauses[0];
  assert.equal(pause?.phase, "waiting"); assert.equal(pause.suspension, undefined);
  assert.match(f.engine.error!, /ownership/, "the native problem is still reported");
  f.reset(); await f.engine.tick(); assert.deepEqual(f.calls.sent, ["a"], "and it continues after the reset");
});

// ------------------------------------------------------------------ holding until the reset
// While a protected session's account is at the limit, no turn runs in it unless a person
// explicitly resumes it (AGENTS.md, "Session Guard").

const idleAgent = (f: { agents: Agent[] }) => { f.agents[0].status = "idle"; f.agents[0].activeTurn = null; };
const message = (f: { agents: Agent[] }, at: number, turnId = "m1") => {
  f.agents[0].status = "running"; f.agents[0].activeTurn = { turnId }; f.agents[0].lastUserMessageAt = iso(at);
};

test("an idle session on an at-limit account is held in the foreground, with nothing interrupted or said", async t => {
  const events: string[] = [];
  const f = await fixture(t, {}, undefined, async (_a, n) => { events.push(n.data.event); }); idleAgent(f);
  await f.engine.tick(); await f.engine.deliverTimeline();
  const [pause] = (await f.store.read()).pauses;
  assert.equal(pause?.phase, "waiting"); assert.equal(pause.idle, true);
  assert.deepEqual(f.calls.stopped, []); assert.deepEqual(events, [], "an idle hold puts no card in the chat");
  f.reset(); await f.engine.tick(); await f.engine.deliverTimeline();
  assert.deepEqual(f.calls.sent, [], "nothing to continue, so the reset just lets go");
  assert.equal((await f.store.read()).pauses[0].phase, "resumed"); assert.deepEqual(events, []);
});
test("an idle Claude session is held natively by freezing it; an idle Codex session is held in the foreground", async t => {
  for (const provider of ["claude", "codex"]) {
    const f = await nativeFixture(t); idleAgent(f); f.agents[0].provider = provider;
    f.usage({ fetchedAt: iso(base), providers: [{ providerId: provider, status: "available", windows: [{ id: "five_hour", usedPct: 100, resetsAt: iso(end) }] }] });
    await f.engine.tick();
    const [pause] = (await f.store.read()).pauses;
    assert.equal(pause?.phase, "waiting", provider); assert.equal(pause.idle, true, provider);
    assert.deepEqual(f.native.calls.frozen, provider === "claude" ? [1234] : [], provider);
    assert.equal(f.engine.error, null, "an idle foreground hold is not an ownership problem");
  }
});
test("a message to a foreground hold does not cancel it: its turn is stopped at once and continued after the reset", async t => {
  const events: string[] = [];
  const f = await fixture(t, {}, undefined, async (_a, n) => { events.push(n.data.event); }); idleAgent(f);
  await f.engine.tick();
  message(f, base + 60_000); await f.engine.tick(); await f.engine.deliverTimeline();
  assert.deepEqual(f.calls.stopped, ["a"], "the new turn is interrupted");
  let [pause] = (await f.store.read()).pauses;
  assert.equal(pause.phase, "waiting"); assert.equal(pause.idle, undefined); assert.equal(pause.turnId, "m1");
  assert.equal(pause.lastUserMessageAt, iso(base + 60_000));
  assert.deepEqual(events, ["paused"], "the card appears once a message is waiting");
  message(f, base + 120_000, "m2"); await f.engine.tick();
  assert.deepEqual(f.calls.stopped, ["a", "a"], "and every later one too");
  assert.equal((await f.store.read()).pauses.length, 1, "one hold throughout");
  f.reset(); await f.engine.tick(); await f.engine.tick();
  assert.deepEqual(f.calls.sent, ["a"], "one continuation after the reset");
  [pause] = (await f.store.read()).pauses; assert.equal(pause.phase, "resumed");
});
test("a message to an interrupted session keeps its pause and still gets one continuation", async t => {
  const f = await fixture(t); await f.engine.tick(); assert.deepEqual(f.calls.stopped, ["a"]);
  message(f, base + 1000); await f.engine.tick();
  assert.deepEqual(f.calls.stopped, ["a", "a"]);
  assert.equal((await f.store.read()).pauses[0].phase, "waiting");
  f.reset(); await f.engine.tick(); assert.deepEqual(f.calls.sent, ["a"]);
});
test("a message to a frozen session waits in it and runs at SIGCONT after the reset, with no message from the guard", async t => {
  for (const idle of [true, false]) {
    const f = await nativeFixture(t); if (idle) idleAgent(f);
    await f.engine.tick(); assert.deepEqual(f.native.calls.frozen, [1234]);
    // Paseo shows the message as a running turn while the Claude CLI is stopped (RESEARCH.md).
    message(f, base + 60_000); await f.engine.tick();
    let [pause] = (await f.store.read()).pauses;
    assert.equal(pause.phase, "waiting"); assert.equal(pause.turnId, "m1"); assert.equal(pause.idle, undefined);
    assert.deepEqual(f.native.calls.released, [], "still frozen");
    assert.deepEqual(f.calls.stopped, [], "a frozen turn is never interrupted");
    f.reset(); await f.engine.tick();
    assert.deepEqual(f.native.calls.released, [1234]); assert.deepEqual(f.calls.sent, []);
    [pause] = (await f.store.read()).pauses; assert.equal(pause.phase, "resumed");
  }
});
test("Resume now releases a hold at once, without a message when nothing was interrupted", async t => {
  const f = await fixture(t); idleAgent(f); await f.engine.tick();
  const [pause] = (await f.store.read()).pauses;
  await f.engine.resumeNow("a", pause.id);
  let state = await f.store.read();
  assert.equal(state.pauses[0].phase, "resumed"); assert.equal(state.overrides.a, false); assert.deepEqual(f.calls.sent, []);
  message(f, base + 1000); await f.engine.tick();
  assert.deepEqual(f.calls.stopped, [], "resumed by a person: the next turn runs");
  const g = await nativeFixture(t); idleAgent(g); await g.engine.tick();
  await g.engine.resumeNow("a", (await g.store.read()).pauses[0].id);
  assert.deepEqual(g.native.calls.released, [1234]); assert.deepEqual(g.calls.sent, []);
  // A held message is continued by Resume now.
  const h = await fixture(t); idleAgent(h); await h.engine.tick();
  message(h, base + 1000); await h.engine.tick();
  await h.engine.resumeNow("a", (await h.store.read()).pauses[0].id);
  assert.deepEqual(h.calls.sent, ["a"]);
  state = await h.store.read(); assert.equal(state.pauses[0].phase, "resumed");
});
test("a session that opens mid-window is held then; a dormant or closed one is never opened or signalled", async t => {
  const f = await nativeFixture(t); f.agents[0].status = "closed"; f.agents[0].activeTurn = null;
  let discovered = 0; const discover = f.native.controller.discover;
  f.native.controller.discover = async (agent, pid) => { discovered++; return discover(agent, pid); };
  let fetched = 0; const fetchAgent = f.client.fetchAgent;
  f.client.fetchAgent = async id => { fetched++; return fetchAgent(id); };
  let sent = 0; const sendMessage = f.client.sendMessage;
  f.client.sendMessage = async (...args) => { sent++; return sendMessage(...args); };
  await f.engine.tick(); await f.engine.tick();
  assert.equal((await f.store.read()).pauses.length, 0);
  assert.deepEqual([discovered, fetched, sent, f.calls.stopped.length, f.native.calls.frozen.length], [0, 0, 0, 0, 0], "untouched while closed");
  // A person opens it during the window: Paseo loads it, idle.
  f.agents[0].status = "idle"; await f.engine.tick();
  assert.deepEqual(f.native.calls.frozen, [1234]);
  assert.equal((await f.store.read()).pauses[0].idle, true);
  // Closing it again ends the hold and lets the process go.
  f.agents[0].status = "closed"; await f.engine.tick();
  assert.equal((await f.store.read()).pauses[0].phase, "cancelled"); assert.deepEqual(f.native.calls.released, [1234]);
});
test("a session that starts a turn mid-window is held", async t => {
  const f = await fixture(t); f.agents[0].status = "closed"; f.agents[0].activeTurn = null;
  await f.engine.tick(); assert.equal((await f.store.read()).pauses.length, 0);
  message(f, base + 1000); await f.engine.tick();
  assert.deepEqual(f.calls.stopped, ["a"]); assert.equal((await f.store.read()).pauses[0].phase, "waiting");
});
test("the explicit ways out end a hold: dismiss, release, opt-out and turning Session Guard off", async t => {
  for (const way of ["dismiss", "release", "opt-out", "off"]) {
    const f = await fixture(t); idleAgent(f); await f.engine.tick();
    const [pause] = (await f.store.read()).pauses;
    if (way === "dismiss") await f.engine.dismissPause("a", pause.id);
    if (way === "release") await f.engine.cancelResume("a");
    if (way === "opt-out") await f.engine.setProtection("a", false);
    if (way === "off") { f.policy({ enabled: false }); await f.engine.tick(); }
    assert.equal((await f.store.read()).pauses[0].phase, "cancelled", way);
    message(f, base + 1000); f.policy({ enabled: way !== "off" }); if (way === "off") f.policy({ enabled: false });
    await f.engine.tick(); assert.deepEqual(f.calls.stopped, [], way); assert.deepEqual(f.calls.sent, [], way);
  }
});
test("the native fallback error stays up while that session is held in the foreground", async t => {
  const f = await nativeFixture(t); f.native.controller.discover = async () => null;
  await f.engine.tick(); await f.engine.tick(); await f.engine.tick();
  assert.match(f.engine.error!, /ownership/);
  await f.engine.cancelResume("a"); await f.engine.tick();
  assert.equal(f.engine.error, null, "and goes once the hold ends");
});
test("Resume now right after a message adopts it rather than refusing a changed session", async t => {
  for (const native of [false, true]) {
    const f = native ? await nativeFixture(t) : await fixture(t); idleAgent(f); await f.engine.tick();
    message(f, base + 1000); // Before the guard's next check.
    await f.engine.resumeNow("a", (await f.store.read()).pauses[0].id);
    assert.equal((await f.store.read()).pauses[0].phase, "resumed", native ? "native" : "foreground");
    assert.deepEqual(f.calls.sent, [], "its own turn runs; no extra message");
  }
});
