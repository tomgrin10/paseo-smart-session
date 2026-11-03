import { test } from "node:test";
import assert from "node:assert/strict";
import { observeAgents } from "./client/agents.ts";
import { contributePills, pillPresentation, refreshGuardPills } from "./client/guard/pills.ts";
import { PauseSchema, PolicySchema } from "./shared/guard/policy.ts";
import type { PluginClientContext } from "@getpaseo/plugin/client";

test("pill describes manual continuation when automatic continuation is disabled", () => {
  const policy = PolicySchema.parse({ enabled: true, autoResume: false });
  assert.match(pillPresentation(policy, true, undefined).title, /continue manually/i);
  const pause = PauseSchema.parse({ id: "p", agentId: "a", provider: "claude", title: null, windowId: "five_hour", anchorResetsAt: null, pausedAt: "2026-10-06T00:00:00Z", lastUserMessageAt: null, turnId: null, phase: "waiting", note: null, settledAt: null });
  assert.match(pillPresentation(policy, true, pause).title, /automatic continuation is off/i);
  assert.match(pillPresentation({ ...policy, autoResume: true }, true, pause).title, /scheduled after reset/i);
});

test("agent observation, stable menu updates, opt-out, workspace moves, and teardown", async () => {
  const policy = PolicySchema.parse({ enabled: true });
  const status = { governor: "active", checkedAt: null, error: null, pauses: [], overrides: {} as Record<string, boolean>, policy, providers: [] };
  let observer: { snapshot(payload: unknown): void; update(event: unknown): void } | null = null;
  let releases = 0, removals = 0, updates = 0;
  const surfaces: string[] = [];
  const registered: { agentId: string; workspaceId: string; button: { behavior: { items: { id: string; behavior?: { onPress(): Promise<void> } }[] } } }[] = [];
  const context = {
    rpc: async (contract: { name: string }, input: { agentId?: string; enabled?: boolean | null }) => {
      if (contract.name === "smart-session.guard.status") return structuredClone(status);
      if (input.enabled === null) delete status.overrides[input.agentId!];
      else if (input.enabled !== undefined) status.overrides[input.agentId!] = input.enabled;
      return { ok: true };
    },
    openSettings() {},
    openSurface(id: string) { surfaces.push(id); },
    paseo: { observeEvents() {}, agents: {
      subscribe: () => () => {},
      list: async () => ({ subscription: { subscribe: (next: typeof observer) => { observer = next; return () => {}; }, release: async () => { releases++; } } }),
    } },
    addComposerPill: (contribution: typeof registered[number]) => {
      registered.push(contribution);
      return { update: (button: typeof contribution.button) => { updates++; contribution.button = button; }, remove: () => { removals++; } };
    },
  } as unknown as PluginClientContext;
  const agents = observeAgents(context);
  const cleanup = contributePills(context, agents);
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    await settle();
    const next = observer!;
    const agent = { id: "a", status: "idle", workspaceId: "w" };
    next.snapshot({ entries: [{ agent }] });
    assert.equal(registered.length, 1);
    const before = registered[0].button;
    await before.behavior.items.find(item => item.id === "paused-sessions")!.behavior!.onPress();
    assert.deepEqual(surfaces, ["paused-sessions"]);
    next.update({ type: "agent_update", payload: { kind: "upsert", agent: { ...agent, title: "Changed" } } });
    assert.equal(updates, 0, "presentation polling must not remount an open menu");
    assert.equal(registered[0].button, before);
    await registered[0].button.behavior.items.find(item => item.id === "toggle")!.behavior!.onPress();
    assert.equal(status.overrides.a, false); assert.equal(updates, 1);
    next.update({ type: "agent_update", payload: { kind: "upsert", agent: { ...agent, workspaceId: "new" } } });
    assert.equal(removals, 1); assert.equal(registered.length, 2); assert.equal(registered[1].workspaceId, "new");
    next.update({ type: "agent_update", payload: { kind: "remove", agentId: "a" } });
    assert.equal(removals, 2);
  } finally { cleanup(); await agents.dispose(); await settle(); }
  assert.equal(releases, 1);
});

test("the pill is drawn only while this plugin governs, and for a waiting pause while turning off", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pause = PauseSchema.parse({ id: "p", agentId: "b", provider: "claude", title: null, windowId: "five_hour", anchorResetsAt: null, pausedAt: "2026-10-06T00:00:00Z", lastUserMessageAt: null, turnId: null, phase: "waiting", note: null, settledAt: null });
  const status = { governor: "deferred", checkedAt: null, error: null, pauses: [pause], overrides: {}, policy: PolicySchema.parse({ enabled: true }), providers: [] };
  let observer: { snapshot(payload: unknown): void } | null = null;
  const live = new Set<string>();
  const context = {
    rpc: async () => structuredClone(status),
    openSurface() {},
    paseo: { agents: {
      subscribe: () => () => {},
      list: async () => ({ subscription: { subscribe: (next: typeof observer) => { observer = next; return () => {}; }, release: async () => {} } }),
    } },
    addComposerPill: (contribution: { agentId: string }) => { live.add(contribution.agentId); return { update() {}, remove: () => { live.delete(contribution.agentId); } }; },
  } as unknown as PluginClientContext;
  const agents = observeAgents(context);
  const cleanup = contributePills(context, agents);
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    await settle();
    observer!.snapshot({ entries: [
      { agent: { id: "a", status: "idle", workspaceId: "w" } },
      { agent: { id: "b", status: "idle", workspaceId: "w" } },
      { agent: { id: "c", status: "closed", workspaceId: "w" } },
    ] });
    assert.deepEqual([...live], [], "another governor draws its own pill; two would contradict each other");
    status.governor = "active";
    t.mock.timers.tick(5000); await settle();
    assert.deepEqual([...live].sort(), ["a", "b"], "every live session, never a closed one");
    status.policy = PolicySchema.parse({ enabled: false });
    t.mock.timers.tick(5000); await settle();
    assert.deepEqual([...live], ["b"], "turned off, only a session with a pause keeps its pill");
  } finally { cleanup(); await agents.dispose(); }
});

test("while Session Guard is off the pills poll rarely, and a settings change re-reads at once", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const status = { governor: "off", checkedAt: null, error: null, pauses: [], overrides: {}, policy: PolicySchema.parse({}), providers: [] };
  let reads = 0;
  const context = {
    rpc: async () => { reads++; return structuredClone(status); },
    openSurface() {},
    paseo: { agents: { subscribe: () => () => {}, list: async () => ({ entries: [] }) } },
    addComposerPill: () => ({ update() {}, remove() {} }),
  } as unknown as PluginClientContext;
  const agents = observeAgents(context);
  const cleanup = contributePills(context, agents);
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    await settle();
    assert.equal(reads, 1);
    t.mock.timers.tick(30_000); await settle();
    assert.equal(reads, 1, "no 5-second polling while the feature is off");
    status.policy = PolicySchema.parse({ enabled: true });
    refreshGuardPills(); await settle();
    assert.equal(reads, 2, "a settings change is read straight away");
    t.mock.timers.tick(5000); await settle();
    assert.equal(reads, 3, "and once it is on, polling is brisk again");
  } finally { cleanup(); await agents.dispose(); }
});
