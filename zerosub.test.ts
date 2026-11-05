import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./server/guard/engine.ts";
import { Store } from "./server/guard/store.ts";
import { readZeroSub, zerosubBudgetAccount, zerosubInstallId } from "./server/guard/zerosub.ts";
import { agentGuardSummary } from "./shared/guard/presentation.ts";
import { PolicySchema, type Agent, type Policy, type Usage } from "./shared/guard/policy.ts";
import { accountOf, accountView, paseoWindowId, parseZeroSub, type ZeroSubSnapshot } from "./shared/guard/zerosub.ts";
import type { GuardClient } from "./server/guard/client.ts";
import type { ProcessControl } from "./server/guard/processes.ts";

const base = Date.parse("2026-10-06T10:00:00Z");
const end = base + 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** ZeroSub's `state.json`, as 1.5.0 writes it; emails are fixtures, never output. */
function stateFixture(patch: { managed?: Record<string, unknown>; sessions?: Record<string, string>; continuations?: unknown } = {}) {
  return {
    version: 1,
    accounts: [
      { id: "codex-main", family: "codex", label: "me@example.com", autoLabel: true, kind: "main", home: null, email: "me@example.com", signedIn: true, disabled: false, limitedUntil: null, createdAt: iso(base) },
      { id: "claude-main", family: "claude", label: "me@example.com", autoLabel: true, kind: "main", home: null, email: "me@example.com", signedIn: true, disabled: false, limitedUntil: null, createdAt: iso(base) },
      { id: "claude-work", family: "claude", label: "Work", autoLabel: false, kind: "managed", home: "/nowhere/homes/claude-work", email: "work@example.com", signedIn: true, disabled: false, limitedUntil: null, createdAt: iso(base), ...patch.managed },
    ],
    defaults: { claude: null, codex: null },
    bindings: {},
    sessions: Object.fromEntries(Object.entries(patch.sessions ?? {}).map(([agentId, accountId]) => [agentId, { accountId, family: accountId.split("-")[0], openedAt: iso(base) }])),
    continuations: patch.continuations ?? {},
  };
}
function usageFixture(workPct = 0, mainPct = 100, at = base) {
  return {
    "claude-main": { fetchedAt: iso(at), windows: [{ id: "five_hour", label: "5h", usedPercent: mainPct, resetsAt: iso(end) }, { id: "seven_day", label: "Week", usedPercent: 40, resetsAt: iso(end + 86_400_000) }], error: null, cached: false },
    "claude-work": { fetchedAt: iso(at), windows: [{ id: "five_hour", label: "5h", usedPercent: workPct, resetsAt: iso(end + 3 * 3600_000) }, { id: "seven_day", label: "Week", usedPercent: 10, resetsAt: iso(end + 2 * 86_400_000) }], error: null, cached: false },
  };
}
const snapshotOf = (state: unknown = stateFixture(), usage: unknown = usageFixture(), prefs: unknown = undefined) => parseZeroSub(state, usage, prefs)!;

test("ZeroSub's registry parses defensively and never keeps an email", () => {
  const snapshot = snapshotOf(stateFixture({ sessions: { a: "claude-work" } }));
  assert.equal(snapshot.accounts.length, 3);
  assert.ok(!JSON.stringify(snapshot).includes("@"), "no email or email-derived label survives parsing");
  assert.equal(snapshot.accounts.find((a) => a.id === "claude-work")!.label, "Work");
  assert.equal(snapshot.sessions.a, "claude-work");
  assert.equal(snapshot.autoSwitch, true, "ZeroSub's default");
  assert.equal(parseZeroSub(stateFixture(), {}, { version: 1, values: { autoSwitch: false } })!.autoSwitch, false);
  for (const garbage of [undefined, null, "x", { accounts: "no" }, { accounts: [{ id: 1 }] }]) assert.equal(parseZeroSub(garbage, {}, undefined), null);
  // One broken reading costs that reading, not the rest.
  const partial = parseZeroSub(stateFixture(), { "claude-main": { fetchedAt: "never" }, "claude-work": usageFixture()["claude-work"] }, undefined)!;
  assert.deepEqual(Object.keys(partial.readings), ["claude-work"]);
});

test("ZeroSub's window ids map onto the ids Paseo and the guard use", () => {
  assert.equal(paseoWindowId("claude", { id: "five_hour", usedPct: 0, resetsAt: null, minutes: null }), "five_hour");
  assert.equal(paseoWindowId("claude", { id: "seven_day", usedPct: 0, resetsAt: null, minutes: null }), "weekly");
  assert.equal(paseoWindowId("codex", { id: "primary", usedPct: 0, resetsAt: null, minutes: 300 }), "session");
  assert.equal(paseoWindowId("codex", { id: "primary", usedPct: 0, resetsAt: null, minutes: 10080 }), "weekly");
  assert.equal(paseoWindowId("codex", { id: "secondary", usedPct: 0, resetsAt: null, minutes: null }), "weekly");
});

test("an agent is measured on its own account, and the CLI login keeps Paseo's reading", () => {
  const snapshot = snapshotOf(stateFixture({ sessions: { onWork: "claude-work" } }));
  const paseo: Usage = { fetchedAt: iso(base), providers: [{ providerId: "claude", status: "available", fetchedAt: iso(base), windows: [{ id: "five_hour", usedPct: 100, resetsAt: iso(end) }] }] };
  const view = accountView(snapshot, paseo, PolicySchema.parse({ enabled: true }), base);
  assert.equal(accountOf(snapshot, "unrouted", "claude")!.id, "claude-main", "no session falls back to the CLI login, as ZeroSub does");
  assert.equal(view.usageFor("unrouted", "claude"), paseo);
  const own = view.usageFor("onWork", "claude").providers.find((p) => p.providerId === "claude")!;
  assert.deepEqual(own.windows.map((w) => [w.id, w.usedPct]), [["five_hour", 0], ["weekly", 10]]);
});

test("ZeroSub fails over only to an account that is usable, fresh and has room", () => {
  const policy = PolicySchema.parse({ enabled: true });
  const failsOver = (snapshot: ZeroSubSnapshot, now = base) => accountView(snapshot, { fetchedAt: iso(now), providers: [] }, policy, now).failsOver("a", "claude");
  assert.equal(failsOver(snapshotOf()), true);
  assert.equal(failsOver(snapshotOf(stateFixture(), usageFixture(100))), false, "full");
  assert.equal(failsOver(snapshotOf(stateFixture({ managed: { disabled: true } }))), false, "set aside");
  assert.equal(failsOver(snapshotOf(stateFixture({ managed: { signedIn: false } }))), false, "signed out");
  assert.equal(failsOver(snapshotOf(stateFixture({ managed: { limitedUntil: iso(end) } }))), false, "limit reported by the CLI");
  assert.equal(failsOver(snapshotOf(), base + 31 * 60_000), false, "reading too old to trust");
  assert.equal(failsOver(snapshotOf(stateFixture(), { "claude-main": usageFixture()["claude-main"] })), false, "no reading at all");
  assert.equal(failsOver(parseZeroSub(stateFixture(), usageFixture(), { values: { autoSwitch: false } })!), false, "automatic switching off");
  assert.equal(accountView(snapshotOf(), { fetchedAt: iso(base), providers: [] }, policy, base).failsOver("a", "codex"), false, "the only Codex account");
});

async function home(t: { after(fn: () => Promise<void>): void }, options: { enabled?: boolean; id?: string; state?: unknown; usage?: unknown; prefs?: unknown } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "zerosub-home-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pluginDir = join(dir, "plugins", "zs");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, "package.json"), JSON.stringify({ name: "@kapybara/zerosub" }));
  await writeFile(join(dir, "config.json"), JSON.stringify({ plugins: { [options.id ?? "accounts"]: { source: "directory", path: pluginDir, enabled: options.enabled ?? true } } }));
  await mkdir(join(dir, "zerosub", "homes", "claude-work"), { recursive: true });
  await writeFile(join(dir, "zerosub", "homes", "claude-work", ".credentials.json"), "{}");
  await writeFile(join(dir, "zerosub", "state.json"), JSON.stringify(options.state ?? stateFixture({ sessions: { a: "claude-work" } })));
  await writeFile(join(dir, "zerosub", "usage.json"), JSON.stringify(options.usage ?? usageFixture()));
  if (options.prefs) {
    await mkdir(join(dir, "plugin-settings", options.id ?? "accounts"), { recursive: true });
    await writeFile(join(dir, "plugin-settings", options.id ?? "accounts", "preferences.json"), JSON.stringify(options.prefs));
  }
  return dir;
}

test("ZeroSub is read only while enabled, from its registry, readings and preferences, never a credential", async t => {
  const dir = await home(t, { prefs: { version: 1, values: { autoSwitch: false } } });
  const opened: string[] = [];
  const { readFile } = await import("node:fs/promises");
  const read = (path: string) => { opened.push(path); return readFile(path, "utf8"); };
  assert.equal(await zerosubInstallId(dir, read), "accounts", "found by package name under any install id");
  const snapshot = await readZeroSub(dir, read);
  assert.equal(snapshot!.sessions.a, "claude-work");
  assert.equal(snapshot!.autoSwitch, false);
  assert.ok(opened.every(path => !path.includes("homes") && !path.includes("credentials")), opened.join(", "));
  assert.equal(await readZeroSub(await home(t, { enabled: false })), null, "disabled ZeroSub is ignored");
  assert.equal(await readZeroSub(join(dir, "missing")), null);
});

test("budget_status describes the agent's ZeroSub account and its room elsewhere", async t => {
  const dir = await home(t);
  const managed = await zerosubBudgetAccount("a", dir, undefined, base);
  assert.equal(managed!.account.kind, "managed");
  assert.equal(managed!.account.label, "Work");
  assert.equal(managed!.account.readAt, iso(base));
  assert.equal(managed!.account.otherAccountsWithRoom, 0, "the CLI login is full");
  assert.deepEqual(managed!.windows!.map(w => [w.id, w.pct]), [["five_hour", 0], ["seven_day", 10]]);
  const main = await zerosubBudgetAccount("unrouted", dir, undefined, base);
  assert.equal(main!.account.kind, "main");
  assert.equal(main!.account.label, null, "a generated label is the email");
  assert.equal(main!.windows, null, "the recorder's numbers stand for the CLI login");
  assert.equal(main!.account.otherAccountsWithRoom, 1);
});

test("the agent-facing summary says ZeroSub goes first", () => {
  const line = agentGuardSummary({ governor: "active", protected: true, thresholdPct: 100, autoResume: true, pauses: [], failsOver: true })[0]!;
  assert.match(line, /ZeroSub goes first/);
  assert.match(agentGuardSummary({ governor: "active", protected: true, thresholdPct: 100, autoResume: true, pauses: [] })[0]!, /pauses this session/);
});

// The engine, with ZeroSub's view wired in as the plugin wires it.

function nativeControl() {
  const calls = { frozen: [] as number[], released: [] as number[] };
  const stopped = new Set<number>();
  const controller: ProcessControl = {
    discover: async () => ({ rootPid: 1234, processes: [{ pid: 1234, startTime: "111" }] }),
    freeze: async (suspension, journal) => { await journal(); calls.frozen.push(suspension.rootPid); stopped.add(suspension.rootPid); },
    resume: async suspension => { calls.released.push(suspension.rootPid); stopped.delete(suspension.rootPid); },
    stopped: async suspension => stopped.has(suspension.rootPid),
  };
  return { calls, controller };
}

async function fixture(t: { after(fn: () => Promise<void>): void }, options: { native?: boolean; policy?: Partial<Policy>; provider?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "session-guard-zerosub-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  let now = base;
  const policy = PolicySchema.parse({ enabled: true, includeNativeSubagents: !!options.native, ...options.policy });
  const provider = options.provider ?? "claude";
  const agents: Agent[] = [{ id: "a", provider, status: "running", title: "Task", workspaceId: "w", lastUserMessageAt: iso(base - 1000), activeTurn: { turnId: "t1" } }];
  // Paseo and the recorder measure the CLI login, which is full.
  let usage: Usage = { fetchedAt: iso(now), providers: [{ providerId: provider, status: "available", fetchedAt: iso(now), windows: [{ id: provider === "codex" ? "session" : "five_hour", usedPct: 100, resetsAt: iso(end) }] }] };
  let snapshot: ZeroSubSnapshot | null = snapshotOf();
  const calls = { stopped: [] as string[], sent: [] as string[] };
  const client: GuardClient = {
    fetchAgents: async () => ({ entries: agents.map(agent => ({ agent: { ...agent } })) }),
    fetchAgent: async id => { const a = agents.find(a => a.id === id); return a ? { agent: { ...a } } : null; },
    listProviderUsage: async () => usage,
    cancelAgent: async id => { calls.stopped.push(id); const a = agents.find(a => a.id === id)!; a.status = "idle"; a.activeTurn = null; },
    sendMessage: async id => { calls.sent.push(id); const a = agents.find(a => a.id === id)!; a.status = "running"; a.lastUserMessageAt = iso(now); a.activeTurn = { turnId: "continued" }; },
    getDaemonStatus: async () => ({ pid: 9001 }),
    listProviderSubagents: async () => ({ subagents: [] }),
  };
  const native = nativeControl();
  const engine = new Engine(store, async () => policy, async work => work(client), () => now, options.native ? native.controller : undefined, undefined,
    async c => c.listProviderUsage(), async (read, p) => (snapshot ? accountView(snapshot, read, p, now) : null));
  return {
    store, engine, agents, calls, native,
    zerosub: (next: ZeroSubSnapshot | null) => { snapshot = next; },
    time: (ms: number) => { now = ms; usage = { ...usage, fetchedAt: iso(ms), providers: usage.providers.map(p => ({ ...p, fetchedAt: iso(ms) })) }; },
  };
}

test("an agent ZeroSub runs on an account with room is not paused when the CLI login is full", async t => {
  const f = await fixture(t);
  f.zerosub(snapshotOf(stateFixture({ sessions: { a: "claude-work" } }), usageFixture(0), undefined));
  await f.engine.tick();
  assert.deepEqual(f.calls.stopped, []);
  assert.equal((await f.store.read()).pauses.length, 0);
});

test("the guard leaves a full account's agent to ZeroSub while another account has room", async t => {
  const f = await fixture(t);
  await f.engine.tick(); await f.engine.tick();
  assert.deepEqual(f.calls.stopped, [], "the CLI must reach the limit so ZeroSub can switch");
  // Once no account has room, the guard is the fallback again.
  f.zerosub(snapshotOf(stateFixture(), usageFixture(100)));
  await f.engine.tick();
  assert.deepEqual(f.calls.stopped, ["a"]);
  assert.equal((await f.store.read()).pauses[0]!.phase, "waiting");
});

test("without ZeroSub nothing changes", async t => {
  const f = await fixture(t);
  f.zerosub(null);
  await f.engine.tick();
  assert.deepEqual(f.calls.stopped, ["a"]);
});

test("an agent ZeroSub moved off a full account is not paused again", async t => {
  const f = await fixture(t);
  // ZeroSub reopened it on the account with room and continued it: a new running turn.
  f.zerosub(snapshotOf(stateFixture({ sessions: { a: "claude-work" } }), usageFixture(0)));
  f.agents[0]!.activeTurn = { turnId: "after-switch" }; f.agents[0]!.lastUserMessageAt = iso(base);
  await f.engine.tick();
  assert.deepEqual(f.calls.stopped, []);
});

test("a frozen session is released for ZeroSub once another account has room", async t => {
  const f = await fixture(t, { native: true });
  f.zerosub(snapshotOf(stateFixture(), usageFixture(100)));
  await f.engine.tick();
  assert.deepEqual(f.native.calls.frozen, [1234]);
  f.zerosub(snapshotOf(stateFixture(), usageFixture(0)));
  f.time(base + 60_000);
  await f.engine.tick();
  assert.deepEqual(f.native.calls.released, [1234]);
  const pause = (await f.store.read()).pauses[0]!;
  assert.equal(pause.phase, "cancelled");
  assert.match(pause.note!, /Released for ZeroSub/);
  await f.engine.tick();
  assert.deepEqual(f.native.calls.frozen, [1234], "not frozen again while ZeroSub can switch");
});

test("an interrupted session moved to an account with room continues without waiting for the old reset", async t => {
  const f = await fixture(t);
  f.zerosub(snapshotOf(stateFixture(), usageFixture(100)));
  await f.engine.tick();
  assert.deepEqual(f.calls.stopped, ["a"]);
  // ZeroSub moved the idle agent (another agent's limit notice); the old account is still full.
  f.time(base + 60_000);
  f.zerosub(snapshotOf(stateFixture({ sessions: { a: "claude-work" } }), usageFixture(0, 100, base + 60_000)));
  await f.engine.tick();
  assert.deepEqual(f.calls.sent, ["a"], "one continuation, on the account with room");
  assert.equal((await f.store.read()).pauses[0]!.phase, "resumed");
});

test("a Codex task ZeroSub continued in another tab is not continued here too", async t => {
  const f = await fixture(t, { provider: "codex" });
  f.zerosub(snapshotOf(stateFixture(), usageFixture(100)));
  // The turn failed on the limit: a waiting pause with no interrupt.
  f.agents[0]!.status = "error"; f.agents[0]!.activeTurn = null; f.agents[0]!.lastError = "You've hit your usage limit.";
  await f.engine.tick();
  assert.equal((await f.store.read()).pauses[0]!.phase, "waiting");
  f.zerosub(snapshotOf(stateFixture({ continuations: { task: { activeAgentId: "b", members: { a: { accountId: "codex-main", identity: null, email: null, seen: {} }, b: { accountId: "codex-2", identity: null, email: null, seen: {} } } } } }), usageFixture(100)));
  await f.engine.tick();
  const pause = (await f.store.read()).pauses[0]!;
  assert.equal(pause.phase, "cancelled");
  assert.match(pause.note!, /ZeroSub continued this task/);
  assert.deepEqual(f.calls.sent, []);
});
