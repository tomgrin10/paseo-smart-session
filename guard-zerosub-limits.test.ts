/**
 * Session Guard × ZeroSub when every account is out: the agent is paused (whichever of
 * the guard and the CLI sees the limit first), held while only another account has room,
 * and continued exactly once when its own account has room again.
 *
 * ZeroSub is played by fixture `state.json` / `usage.json` / preferences, parsed by the
 * real reader, plus a stand-in for what ZeroSub 1.5.0 does on a limit notice
 * (`server/service.ts` `handleUnavailable`): record the limit on the account, then
 * either move the agent to a usable account and send its own continue prompt, or stop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./server/guard/engine.ts";
import { Store } from "./server/guard/store.ts";
import { PolicySchema, type Agent, type Pause, type Policy, type Usage } from "./shared/guard/policy.ts";
import { accountView, parseZeroSub } from "./shared/guard/zerosub.ts";
import { limitNotice, turnRows } from "./shared/guard/limit-notice.ts";
import { heldUntil, ZEROSUB_MOVE_GRACE_MS, ZeroSubMoves } from "./shared/guard/hold.ts";
import type { GuardClient } from "./server/guard/client.ts";
import type { ProcessControl } from "./server/guard/processes.ts";

const T0 = Date.parse("2026-11-05T10:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
const NOTICE = "You've hit your 5-hour limit · resets 3pm (UTC)";

// --------------------------------------------------------------------------- ZeroSub fixture

interface Acct { id: string; family: "claude" | "codex"; kind: "main" | "managed"; disabled?: boolean; signedIn?: boolean; limitedUntil?: string | null; limitKind?: "window" | "budget" | null }
interface Reading { at: number; fiveHour: number; fiveResets: number; weekly?: number; weeklyResets?: number }

/** ZeroSub's files, as 1.5.0 writes them (emails are fixtures, never read back). */
class ZeroSub {
  accounts: Acct[];
  sessions: Record<string, string> = {};
  /** When each session was opened, if not at T0. */
  opened: Record<string, number> = {};
  readings: Record<string, Reading> = {};
  autoSwitch = true;
  constructor(accounts: Acct[]) { this.accounts = accounts; }
  account(id: string) { return this.accounts.find(a => a.id === id)!; }
  state() {
    return {
      version: 1,
      accounts: this.accounts.map(a => ({ label: `${a.id}@example.com`, autoLabel: true, home: a.kind === "main" ? null : `/nowhere/${a.id}`, email: `${a.id}@example.com`, signedIn: true, disabled: false, limitedUntil: null, createdAt: iso(T0 - 86_400_000), ...a })),
      defaults: { claude: null, codex: null }, bindings: {},
      sessions: Object.fromEntries(Object.entries(this.sessions).map(([agentId, accountId]) => [agentId, { accountId, family: accountId.split("-")[0], openedAt: iso(this.opened[agentId] ?? T0) }])),
      continuations: {},
    };
  }
  usage() {
    return Object.fromEntries(Object.entries(this.readings).map(([id, r]) => {
      const family = this.account(id).family;
      const windows = family === "claude"
        ? [{ id: "five_hour", label: "5h", usedPercent: r.fiveHour, resetsAt: iso(r.fiveResets) }, { id: "seven_day", label: "Week", usedPercent: r.weekly ?? 10, resetsAt: iso(r.weeklyResets ?? T0 + 3 * 86_400_000) }]
        : [{ id: "primary", label: "5h", usedPercent: r.fiveHour, resetsAt: iso(r.fiveResets), minutes: 300 }, { id: "secondary", label: "Week", usedPercent: r.weekly ?? 10, resetsAt: iso(r.weeklyResets ?? T0 + 3 * 86_400_000), minutes: 10080 }];
      return [id, { fetchedAt: iso(r.at), windows, error: null, cached: false }];
    }));
  }
  prefs() { return { version: 1, values: { autoSwitch: this.autoSwitch } }; }
  snapshot() { return parseZeroSub(JSON.parse(JSON.stringify(this.state())), JSON.parse(JSON.stringify(this.usage())), this.prefs()); }
  /** ZeroSub's `markLimited` from a turn's notice. */
  markLimited(id: string, until: number) { Object.assign(this.account(id), { limitedUntil: iso(until), limitKind: "window" }); }
  /** A reading under the limit lifts it, as ZeroSub's `refreshUsage` does. */
  read(id: string, reading: Reading) {
    this.readings[id] = reading;
    if (Math.max(reading.fiveHour, reading.weekly ?? 0) < 90) Object.assign(this.account(id), { limitedUntil: null, limitKind: null });
  }
  /** ZeroSub reopens the agent's session on another account (`moveIdleAgentsOff`). */
  move(agentId: string, to: string, at: number) { this.sessions[agentId] = to; this.opened[agentId] = at; }
  /** `mostAvailable`: a signed-in, enabled account with no recorded limit. */
  usable(family: string, except: string, now: number) {
    return this.accounts.find(a => a.family === family && a.id !== except && a.signedIn !== false && !a.disabled && !(a.limitedUntil && Date.parse(a.limitedUntil) > now));
  }
}

/** Tom's layout: the CLI login set aside, two managed Claude accounts. */
const claudeAccounts = (): Acct[] => [
  { id: "claude-main", family: "claude", kind: "main", disabled: true },
  { id: "claude-a", family: "claude", kind: "managed" },
  { id: "claude-b", family: "claude", kind: "managed" },
  { id: "codex-main", family: "codex", kind: "main" },
];

// --------------------------------------------------------------------------- engine fixture

function nativeControl() {
  const calls = { frozen: [] as number[], released: [] as number[] };
  const stopped = new Set<number>();
  const controller: ProcessControl = {
    discover: async () => ({ rootPid: 1234, processes: [{ pid: 1234, startTime: "111" }] }),
    freeze: async (s, journal) => { await journal(); calls.frozen.push(s.rootPid); stopped.add(s.rootPid); },
    resume: async s => { calls.released.push(s.rootPid); stopped.delete(s.rootPid); },
    stopped: async s => stopped.has(s.rootPid),
  };
  return { calls, controller };
}

async function fixture(t: { after(fn: () => Promise<void>): void }, options: { zerosub?: ZeroSub | null; provider?: string; native?: boolean; policy?: Partial<Policy>; paseoPct?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "guard-zerosub-limits-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  let now = T0;
  const provider = options.provider ?? "claude";
  const policy = PolicySchema.parse({ enabled: true, includeNativeSubagents: !!options.native, resumeSpacingSeconds: 0, ...options.policy });
  const zs = options.zerosub === undefined ? new ZeroSub(claudeAccounts()) : options.zerosub;
  const agent: Agent = { id: "x", provider, status: "running", title: "Task", workspaceId: "w", lastUserMessageAt: iso(T0 - MIN), activeTurn: { turnId: "t1" } };
  // Paseo's reading measures only the CLI login.
  let paseoPct = options.paseoPct ?? 0;
  let paseoResets = T0 + 2 * HOUR;
  const paseo = (): Usage => ({ fetchedAt: iso(now), providers: [{ providerId: provider, status: "available", fetchedAt: iso(now),
    windows: [{ id: provider === "codex" ? "session" : "five_hour", usedPct: paseoPct, resetsAt: iso(paseoResets) }] }] });
  const log: string[] = [];
  const client: GuardClient = {
    fetchAgents: async () => ({ entries: [{ agent: structuredClone(agent) }] }),
    fetchAgent: async id => (id === agent.id ? { agent: structuredClone(agent) } : null),
    listProviderUsage: async () => paseo(),
    cancelAgent: async () => { log.push("guard:interrupt"); agent.status = "idle"; agent.activeTurn = null; },
    sendMessage: async (_id, _text, opts) => { log.push(`guard:continue:${opts?.messageId}`); userTurn("c"); },
    getDaemonStatus: async () => ({ pid: 9001 }),
    listProviderSubagents: async () => ({ subagents: [] }),
  };
  let turns = 0;
  const userTurn = (prefix: string) => { turns++; agent.status = "running"; agent.lastUserMessageAt = iso(now + turns); agent.activeTurn = { turnId: `${prefix}${turns}` }; };
  const native = nativeControl();
  const engine = new Engine(store, async () => policy, async work => work(client), () => now, options.native ? native.controller : undefined, undefined,
    async c => c.listProviderUsage(), async (usage, p) => { const s = zs?.snapshot(); return s ? accountView(s, usage, p, now) : null; });

  /**
   * The CLI reaches the limit: the turn completes with the notice, and ZeroSub reacts
   * as it does (records the limit, then moves the agent and continues it, or stops).
   * `guardSeesNoticeFirst` runs a guard pass between the notice and ZeroSub's move.
   */
  const hitLimit = async (opts: { guardSeesNoticeFirst?: boolean; zerosubReacts?: boolean } = {}) => {
    const turnId = agent.activeTurn?.turnId ?? null;
    agent.status = "idle"; agent.activeTurn = null;
    log.push(`cli:limit-notice:${turnId}`);
    if (zs) engine.limitReached(agent.id, turnId); // What the turn_ended hook reports under ZeroSub.
    else engine.quotaFailure(agent.id, NOTICE, turnId); // (Without ZeroSub nothing reads the notice.)
    if (opts.guardSeesNoticeFirst) await engine.tick();
    if (!zs || opts.zerosubReacts === false) return;
    const family = provider === "codex" ? "codex" : "claude";
    const on = zs.sessions[agent.id] ?? `${family}-main`;
    zs.markLimited(on, T0 + 5 * HOUR);
    const next = zs.autoSwitch ? zs.usable(family, on, now) : undefined;
    if (next) { zs.sessions[agent.id] = next.id; log.push(`zerosub:switch:${next.id}`); log.push("zerosub:continue"); userTurn("z"); }
    else log.push("zerosub:stayed");
  };
  return {
    store, engine, agent, zs: zs!, log, native,
    at: (ms: number) => { now = ms; },
    get now() { return now; },
    paseoReads: (pct: number, resets = paseoResets) => { paseoPct = pct; paseoResets = resets; },
    hitLimit,
    async pauses(): Promise<Pause[]> { return (await store.read()).pauses; },
    continuations: () => log.filter(l => l.startsWith("guard:continue") || l === "zerosub:continue"),
  };
}

/** Both managed accounts full and fresh, as ZeroSub records them. */
function bothFull(zs: ZeroSub, at = T0) {
  zs.read("claude-a", { at, fiveHour: 100, fiveResets: T0 + 5 * HOUR });
  zs.read("claude-b", { at, fiveHour: 100, fiveResets: T0 + 3 * HOUR });
  zs.markLimited("claude-a", T0 + 5 * HOUR);
  zs.markLimited("claude-b", T0 + 3 * HOUR);
}

// --------------------------------------------------------------------------- the notice itself

test("the limit notice is read the way ZeroSub reads it, from this turn's rows only", () => {
  assert.equal(limitNotice("claude", [{ type: "user_message", text: "go" }, { type: "assistant_message", text: NOTICE }]), NOTICE);
  assert.equal(limitNotice("claude", [{ type: "assistant_message", text: "You’ve hit your weekly limit · resets Nov 9, 3pm (UTC)" }]) !== null, true);
  assert.equal(limitNotice("claude", [{ type: "assistant_message", text: "You've hit your GitHub API rate limit, retrying" }]), null, "prose is not a notice");
  assert.equal(limitNotice("claude", [{ type: "assistant_message", text: NOTICE }, { type: "user_message", text: "next" }, { type: "assistant_message", text: "done" }]), null, "an earlier turn's notice");
  assert.equal(limitNotice("codex", [{ type: "assistant_message", text: "You've hit your usage limit." }]), null, "Codex replies are the model's");
  assert.equal(limitNotice("codex", [{ type: "error", message: "You've hit your usage limit. Try again later." }]) !== null, true);
  assert.equal(limitNotice("opencode", [{ type: "assistant_message", text: NOTICE }]), null);
  const entries = [
    { turnId: "1", item: { type: "user_message", text: "a" } }, { turnId: "1", item: { type: "assistant_message", text: NOTICE } },
    { turnId: "1", item: { type: "user_message", text: "b" } }, { turnId: "1", item: { type: "assistant_message", text: "fine" } },
  ];
  assert.equal(limitNotice("claude", turnRows(entries, "1")), null, "a reused turn id's earlier notice is not this turn's");
  assert.deepEqual(turnRows([{ turnId: "0", item: { type: "user_message", text: "z" } }, ...entries.slice(0, 2), { turnId: "2", item: { type: "user_message", text: "n" } }], "1").map(r => r.text), ["a", NOTICE], "another turn's rows are left out");
});

// --------------------------------------------------------------------------- (a) + (b)

test("(a,b) every account full: the guard pauses first; B getting room keeps the hold, A's own reset continues it once", async t => {
  const f = await fixture(t);
  f.zs.sessions.x = "claude-a";
  bothFull(f.zs);
  await f.engine.tick();
  assert.deepEqual(f.log, ["guard:interrupt"], "no account has room, so the guard pauses before the CLI hits it");
  const [pause] = await f.pauses();
  assert.equal(pause!.phase, "waiting");

  // B's 5-hour window resets; ZeroSub reads it. A is still out for two more hours.
  f.at(T0 + 3 * HOUR + MIN);
  f.zs.read("claude-b", { at: f.now, fiveHour: 0, fiveResets: T0 + 8 * HOUR });
  await f.engine.tick();
  assert.equal(f.continuations().length, 0, "room on B is not a reason to run a turn on A: held until a person resumes it or A resets");
  assert.equal((await f.pauses())[0]!.phase, "waiting");

  // A resets; ZeroSub re-reads it.
  f.at(T0 + 5 * HOUR + 2 * MIN);
  f.zs.read("claude-a", { at: f.now, fiveHour: 0, fiveResets: T0 + 10 * HOUR });
  await f.engine.tick(); await f.engine.tick();
  assert.deepEqual(f.continuations(), [`guard:continue:${pause!.id}`], "one continuation, on A");
  assert.equal(f.zs.sessions.x, "claude-a");
  assert.equal((await f.pauses())[0]!.phase, "resumed");
});
test("(a) the CLI reaches the limit first: the notice turn records a waiting pause once ZeroSub has recorded the limit", async t => {
  const f = await fixture(t);
  f.zs.sessions.x = "claude-a";
  // Readings lag behind the CLI: A last read at 96 %, B is out.
  f.zs.read("claude-a", { at: T0 - 2 * MIN, fiveHour: 96, fiveResets: T0 + 5 * HOUR });
  f.zs.read("claude-b", { at: T0 - 2 * MIN, fiveHour: 100, fiveResets: T0 + 3 * HOUR });
  f.zs.markLimited("claude-b", T0 + 3 * HOUR);
  await f.engine.tick();
  assert.equal(f.log.length, 0, "96 % is not the threshold: the turn runs on");

  // The guard's pass lands between the notice and ZeroSub's reaction: nothing to anchor on yet.
  await f.hitLimit({ guardSeesNoticeFirst: true });
  assert.equal((await f.pauses()).length, 0, "no pause without a recorded limit to anchor on");
  assert.deepEqual(f.log.slice(-1), ["zerosub:stayed"], "no account has room, so ZeroSub stops");
  await f.engine.tick();
  await f.engine.tick();
  const pauses = await f.pauses();
  assert.equal(pauses.length, 1, "exactly one pause");
  assert.equal(pauses[0]!.phase, "waiting");
  assert.equal(pauses[0]!.wasQuotaFailure, true);
  assert.equal(pauses[0]!.anchorResetsAt, iso(T0 + 5 * HOUR), "anchored on when A has room again");
  assert.ok(!f.log.includes("guard:interrupt"), "the turn already ended: nothing to interrupt");
  assert.equal(f.continuations().length, 0);
});

// --------------------------------------------------------------------------- (c)

test("(c) every account out after the notice, then A resets first: one continuation, on A", async t => {
  const f = await fixture(t);
  f.zs.sessions.x = "claude-a";
  f.zs.read("claude-a", { at: T0 - MIN, fiveHour: 97, fiveResets: T0 + 2 * HOUR });
  f.zs.read("claude-b", { at: T0 - MIN, fiveHour: 100, fiveResets: T0 + 6 * HOUR });
  f.zs.markLimited("claude-b", T0 + 6 * HOUR);
  await f.hitLimit();
  f.zs.markLimited("claude-a", T0 + 2 * HOUR); // ZeroSub's exact reset from its re-read.
  await f.engine.tick();
  const [pause] = await f.pauses();
  assert.equal(pause!.phase, "waiting");

  f.at(T0 + HOUR);
  await f.engine.tick();
  assert.equal(f.continuations().length, 0, "nothing has room yet");

  // A resets; ZeroSub re-reads it (a reading past its reset) and lifts the limit.
  f.at(T0 + 2 * HOUR + 2 * MIN);
  f.zs.read("claude-a", { at: f.now, fiveHour: 0, fiveResets: T0 + 7 * HOUR });
  await f.engine.tick();
  await f.engine.tick();
  assert.deepEqual(f.continuations(), [`guard:continue:${pause!.id}`]);
  assert.equal(f.zs.sessions.x, "claude-a", "it stays where it was");
  assert.equal((await f.pauses())[0]!.phase, "resumed");
});

// --------------------------------------------------------------------------- (d) (e) (f)

test("(d) a reading taken before the pause, or too old to trust, never counts as room", async t => {
  const f = await fixture(t);
  f.zs.sessions.x = "claude-a";
  bothFull(f.zs);
  await f.engine.tick();
  const [pause] = await f.pauses();
  assert.equal(pause!.phase, "waiting");
  f.at(T0 + 5 * HOUR + MIN); // A's limit has expired, but no one has looked since.
  f.zs.readings["claude-a"] = { at: T0 - MIN, fiveHour: 40, fiveResets: T0 + 5 * HOUR }; // Before the pause.
  await f.engine.tick();
  assert.equal(f.continuations().length, 0, "a reading from before the pause is not room");
  f.zs.readings["claude-a"] = { at: T0 + 2 * MIN, fiveHour: 40, fiveResets: T0 + 5 * HOUR }; // After the pause, but stale now.
  await f.engine.tick();
  assert.equal(f.continuations().length, 0, "a 5-hour-old reading is not room");
  f.zs.read("claude-a", { at: f.now, fiveHour: 0, fiveResets: T0 + 10 * HOUR });
  await f.engine.tick();
  assert.equal(f.continuations().length, 1, "a fresh reading after the pause is");
});
test("(e) room on another account never continues a held session, set aside or not", async t => {
  const f = await fixture(t);
  f.zs.sessions.x = "claude-a";
  bothFull(f.zs);
  await f.engine.tick();
  f.at(T0 + 3 * HOUR + MIN);
  f.zs.account("claude-b").disabled = true;
  f.zs.read("claude-b", { at: f.now, fiveHour: 0, fiveResets: T0 + 8 * HOUR });
  f.zs.read("claude-main", { at: f.now, fiveHour: 0, fiveResets: T0 + 8 * HOUR }); // The set-aside CLI login, empty.
  await f.engine.tick();
  assert.equal(f.continuations().length, 0);
  f.zs.account("claude-b").disabled = false;
  await f.engine.tick();
  assert.equal(f.continuations().length, 0, "B usable again is still not A's reset");
  assert.equal((await f.pauses())[0]!.phase, "waiting");
});
test("(f) a full weekly window makes an account out, even while its 5-hour window has room", async t => {
  const f = await fixture(t);
  f.zs.sessions.x = "claude-a";
  f.zs.read("claude-a", { at: T0, fiveHour: 40, fiveResets: T0 + 2 * HOUR, weekly: 100, weeklyResets: T0 + 30 * HOUR });
  f.zs.read("claude-b", { at: T0, fiveHour: 100, fiveResets: T0 + 3 * HOUR });
  f.zs.markLimited("claude-b", T0 + 3 * HOUR);
  await f.engine.tick();
  assert.deepEqual(f.log, ["guard:interrupt"], "A is out for the week and B is full");
  const [pause] = await f.pauses();
  assert.equal(pause!.anchorResetsAt, iso(T0 + 30 * HOUR), "anchored on the weekly reset, not the 5-hour one");

  f.at(T0 + 2 * HOUR + 5 * MIN); // A's 5-hour window rolls over; its week has not.
  f.zs.read("claude-a", { at: f.now, fiveHour: 0, fiveResets: T0 + 7 * HOUR, weekly: 100, weeklyResets: T0 + 30 * HOUR });
  await f.engine.tick();
  assert.equal(f.continuations().length, 0, "a 5-hour reset does not lift a weekly limit");

  f.at(T0 + 3 * HOUR + 5 * MIN); // B's 5-hour resets, but B's week is full too.
  f.zs.read("claude-b", { at: f.now, fiveHour: 0, fiveResets: T0 + 8 * HOUR, weekly: 100, weeklyResets: T0 + 40 * HOUR });
  await f.engine.tick();
  assert.equal(f.continuations().length, 0, "B's full week is not room");

  f.at(T0 + 30 * HOUR + 5 * MIN); // A's week rolls over.
  f.zs.read("claude-a", { at: f.now, fiveHour: 0, fiveResets: T0 + 35 * HOUR, weekly: 0, weeklyResets: T0 + 198 * HOUR });
  await f.engine.tick();
  assert.equal(f.continuations().length, 1);
});

// --------------------------------------------------------------------------- (g) (h)

test("(g) Codex, one account: a failed limit turn pauses on ZeroSub's recorded limit and continues once after the reset", async t => {
  const f = await fixture(t, { provider: "codex", paseoPct: 90, zerosub: new ZeroSub(claudeAccounts()) });
  // Codex fails the turn; Paseo's reading still lags at 90 %.
  f.agent.status = "error"; f.agent.activeTurn = null; f.agent.lastError = "You've hit your usage limit. Try again at 3:00 PM.";
  f.zs.markLimited("codex-main", T0 + 2 * HOUR);
  await f.engine.tick();
  const pauses = await f.pauses();
  assert.equal(pauses.length, 1, "ZeroSub's recorded limit is enough when Paseo's reading lags");
  assert.equal(pauses[0]!.phase, "waiting");
  f.at(T0 + HOUR); await f.engine.tick();
  assert.equal(f.continuations().length, 0);
  f.at(T0 + 2 * HOUR + 2 * MIN);
  f.paseoReads(0, T0 + 7 * HOUR);
  await f.engine.tick(); await f.engine.tick();
  assert.equal(f.continuations().length, 1);
});

test("(h) without ZeroSub nothing changes: a notice turn alone records no pause, a full reading interrupts", async t => {
  const f = await fixture(t, { zerosub: null, paseoPct: 96 });
  await f.engine.tick();
  await f.hitLimit();
  await f.engine.tick();
  assert.equal((await f.pauses()).length, 0, "a completed turn at 96 % is not a pause, as before");
  const g = await fixture(t, { zerosub: null, paseoPct: 100 });
  await g.engine.tick();
  assert.deepEqual(g.log, ["guard:interrupt"]);
});

test("an interrupt racing the CLI's notice keeps its one pause instead of releasing it and pausing again", async t => {
  const f = await fixture(t);
  f.zs.sessions.x = "claude-a";
  bothFull(f.zs);
  await f.engine.tick();
  assert.deepEqual(f.log, ["guard:interrupt"]);
  // The interrupted turn reports "completed" — it ended on the notice, not with the work done.
  await f.engine.turnEnded("x", "t1", "completed", true);
  f.engine.limitReached("x", "t1");
  await f.engine.tick(); await f.engine.tick();
  const pauses = await f.pauses();
  assert.deepEqual(pauses.map(p => [p.phase, p.wasQuotaFailure]), [["waiting", true]], "one pause, still waiting");
  // A turn that completed with the work done needs no continuation, but stays held.
  const g = await fixture(t);
  g.zs.sessions.x = "claude-a";
  bothFull(g.zs);
  await g.engine.tick();
  await g.engine.turnEnded("x", "t1", "completed");
  assert.deepEqual((await g.pauses()).map(p => [p.phase, p.idle]), [["waiting", true]]);
});

// --------------------------------------------------------------------------- frozen sessions

test("a frozen session is let go when B gets room, ZeroSub moves it, and it continues there", async t => {
  // Tom, 2026-11-12: hold only when no account the session could move to has room.
  const f = await fixture(t, { native: true });
  f.zs.sessions.x = "claude-a";
  bothFull(f.zs);
  await f.engine.tick();
  assert.deepEqual(f.native.calls.frozen, [1234], "no account has room: held as before");
  f.at(T0 + 3 * HOUR + MIN);
  f.zs.read("claude-b", { at: f.now, fiveHour: 0, fiveResets: T0 + 8 * HOUR });
  await f.engine.tick();
  assert.deepEqual(f.native.calls.released, [1234], "thawed so ZeroSub can reopen it");
  assert.deepEqual(f.log, ["guard:interrupt"], "and its turn stopped in the foreground, not run on A's limit (Extra usage)");
  assert.equal((await f.pauses())[0]!.phase, "waiting");
  f.zs.move("x", "claude-b", f.now + 10_000);
  f.at(f.now + 15_000);
  await f.engine.tick();
  assert.deepEqual(f.continuations().length, 1, "continued on B");
  assert.equal((await f.pauses())[0]!.phase, "resumed");
});
test("autoResume off: room on another account leaves the pause for a person", async t => {
  const f = await fixture(t, { policy: { autoResume: false } });
  f.zs.sessions.x = "claude-a";
  bothFull(f.zs);
  await f.engine.tick();
  f.at(T0 + 3 * HOUR + MIN);
  f.zs.read("claude-b", { at: f.now, fiveHour: 0, fiveResets: T0 + 8 * HOUR });
  await f.engine.tick();
  assert.equal(f.continuations().length, 0);
  assert.equal((await f.pauses())[0]!.phase, "waiting");
});

// --------------------------------------------------------------------------- the hook, end to end in-process

test("the turn-ended hook reads the notice from the agent's timeline and the host records the pause", async t => {
  const home = await mkdtemp(join(tmpdir(), "guard-zerosub-hook-"));
  let stop: () => Promise<void> = async () => {};
  // Stop the guard before removing its home: it may still be writing there.
  t.after(async () => { await stop(); await rm(home, { recursive: true, force: true }); });
  process.env.PASEO_HOME = home;
  process.env.PASEO_DAEMON_URL = "ws://127.0.0.1:9/ws";
  process.env.PASEO_PASSWORD = "guard-zerosub-test";
  const { contributeGuard } = await import("./server/guard/index.ts");
  const now = Date.now();
  // A fake ZeroSub install in this home only: both accounts out, A by the notice just now.
  const zs = new ZeroSub(claudeAccounts());
  zs.sessions.x = "claude-a";
  zs.read("claude-a", { at: now - 2 * MIN, fiveHour: 97, fiveResets: now + 2 * HOUR });
  zs.read("claude-b", { at: now - 2 * MIN, fiveHour: 100, fiveResets: now + 3 * HOUR });
  zs.markLimited("claude-b", now + 3 * HOUR);
  await mkdir(join(home, "zerosub"), { recursive: true });
  await mkdir(join(home, "plugins", "zs"), { recursive: true });
  await writeFile(join(home, "plugins", "zs", "package.json"), JSON.stringify({ name: "@kapybara/zerosub" }));
  await writeFile(join(home, "config.json"), JSON.stringify({ plugins: { zerosub: { source: "directory", path: join(home, "plugins", "zs"), enabled: true } } }));
  const writeZs = async () => {
    await writeFile(join(home, "zerosub", "state.json"), JSON.stringify(zs.state()));
    await writeFile(join(home, "zerosub", "usage.json"), JSON.stringify(zs.usage()));
  };
  await writeZs();

  const agent = { id: "x", provider: "claude", status: "idle", title: "Task", workspaceId: "w", lastUserMessageAt: new Date(now - MIN).toISOString(), activeTurn: null };
  const events = new Map<string, (event: unknown, context: unknown) => void>();
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
  const server = {
    registerSettings: () => ({ read: async () => ({ status: "ready", revision: "r", values: PolicySchema.parse({ enabled: true, includeNativeSubagents: false }) }), subscribe: () => () => {} }),
    handle: (contract: { name: string }, handler: (input: unknown, context: unknown) => unknown) => { handlers.set(contract.name, handler); },
    on: (name: string, handler: (event: unknown, context: unknown) => void) => { events.set(name, handler); return () => events.delete(name); },
    before: () => () => {},
  };
  const client = {
    close: async () => {},
    fetchAgents: async () => ({ entries: [{ agent }] }),
    fetchAgent: async () => ({ agent }),
    listProviderUsage: async () => ({ fetchedAt: new Date().toISOString(), providers: [] }),
    listPlugins: async () => [{ id: "smart-session", enabled: true }, { id: "zerosub", enabled: true }],
    cancelAgent: async () => { throw new Error("nothing to interrupt"); },
    sendMessage: async () => { throw new Error("nothing has room"); },
  } as unknown as GuardClient;
  stop = contributeGuard(server as never, { connect: work => work(client) });
  const status = async () => (await handlers.get("smart-session.guard.status")!({}, { paseo: {} })) as { governor: string; pauses: Pause[] };
  const until = async (check: () => Promise<boolean>, what: string) => {
    for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
    assert.fail(`timed out waiting until ${what}`);
  };
  await until(async () => (await status()).governor === "active", "it governs");
  await until(async () => { events.get("agent.turn_started")?.({}, {}); return (await status()).governor === "active"; }, "a pass with ZeroSub's view");
  await new Promise(r => setTimeout(r, 50));

  // ZeroSub records the limit from the same notice; then the turn-ended hook fires.
  zs.markLimited("claude-a", now + 2 * HOUR);
  await writeZs();
  const timeline = { entries: [
    { turnId: "t1", item: { type: "user_message", text: "work" } },
    { turnId: "t1", item: { type: "assistant_message", text: NOTICE } },
  ] };
  const context = { paseo: { agents: { ref: () => ({ timeline: { refetch: async () => timeline } }) } } };
  events.get("agent.turn_ended")!({ agent: { id: "x", provider: "claude" }, turnId: "t1", outcome: { kind: "completed" }, timeline: [] }, context);
  await until(async () => (await status()).pauses.some(p => p.phase === "waiting" && p.wasQuotaFailure), "the notice becomes a waiting pause");
  assert.equal((await status()).pauses.length, 1);
});

// --------------------------------------------------------------------------- switch first, hold as the fallback (2026-11-12)

/** A full, B with room; the agent on A. The CLI login is set aside, as in Tom's layout. */
function aFullBRoomy(zs: ZeroSub, at = T0) {
  zs.read("claude-a", { at, fiveHour: 100, fiveResets: T0 + 47 * MIN, weekly: 87 });
  zs.markLimited("claude-a", T0 + 47 * MIN); // ZeroSub's reading marks it (limitSource "reading").
  zs.read("claude-b", { at, fiveHour: 6, fiveResets: T0 + 5 * HOUR, weekly: 88 });
}

test("the grace ZeroSub gets to move a session is short, and pinned", () => {
  assert.equal(ZEROSUB_MOVE_GRACE_MS, 2 * MIN);
  const moves = new ZeroSubMoves();
  moves.begin();
  assert.equal(moves.moves("x", T0), true);
  moves.end();
  moves.begin();
  assert.equal(moves.moves("x", T0 + ZEROSUB_MOVE_GRACE_MS - 1), true);
  assert.equal(moves.moves("x", T0 + ZEROSUB_MOVE_GRACE_MS), false);
  moves.end();
  moves.begin(); moves.end(); // A pass where it isn't movable: its grace is gone.
  moves.begin();
  assert.equal(moves.moves("x", T0 + HOUR), true, "a new stretch starts a new grace");
});

test("invariant: an idle session ZeroSub can move is never held while ZeroSub moves it", async t => {
  // The live case: the seat at 100% (ZeroSub's reading marked it), the CLI login with room,
  // idle sessions on the seat. beta.9 froze them all.
  const f = await fixture(t, { native: true });
  f.zs.sessions.x = "claude-a";
  aFullBRoomy(f.zs);
  f.agent.status = "idle"; f.agent.activeTurn = null;
  await f.engine.tick();
  assert.deepEqual(f.native.calls.frozen, [], "not frozen");
  assert.deepEqual(await f.pauses(), [], "no hold");
  f.zs.move("x", "claude-b", T0 + 20_000);
  f.at(T0 + 30_000);
  await f.engine.tick();
  f.at(T0 + 10 * MIN);
  await f.engine.tick();
  assert.deepEqual(await f.pauses(), [], "on B it has room: nothing to hold");
  assert.deepEqual(f.log, []);
});

test("a running session ZeroSub can move is stopped in the foreground, never frozen, and continues where ZeroSub moved it", async t => {
  const f = await fixture(t, { native: true });
  f.zs.sessions.x = "claude-a";
  aFullBRoomy(f.zs);
  await f.engine.tick();
  assert.deepEqual(f.native.calls.frozen, [], "a frozen process can't be reopened on B");
  assert.deepEqual(f.log, ["guard:interrupt"], "the turn doesn't run on A's limit");
  const [pause] = await f.pauses();
  assert.equal(pause!.phase, "waiting");
  assert.equal(pause!.suspension, undefined);
  // ZeroSub reopens it on B: for a moment Paseo shows it closed. That is not a person closing it.
  f.agent.status = "closed";
  f.at(T0 + 20_000);
  await f.engine.tick();
  assert.equal((await f.pauses())[0]!.phase, "waiting", "kept through the reopen");
  f.zs.move("x", "claude-b", T0 + 25_000);
  f.agent.status = "idle";
  f.at(T0 + 30_000);
  await f.engine.tick();
  assert.deepEqual(f.continuations(), [`guard:continue:${pause!.id}`], "continued on B, well before A's reset");
  assert.equal((await f.pauses())[0]!.phase, "resumed");
});

test("a session ZeroSub didn't move within the grace is held as before", async t => {
  const f = await fixture(t, { native: true });
  f.zs.sessions.x = "claude-a";
  aFullBRoomy(f.zs);
  f.agent.status = "idle"; f.agent.activeTurn = null;
  await f.engine.tick();
  f.at(T0 + ZEROSUB_MOVE_GRACE_MS - 1000);
  f.zs.read("claude-b", { at: f.now, fiveHour: 6, fiveResets: T0 + 5 * HOUR, weekly: 88 });
  await f.engine.tick();
  assert.deepEqual(await f.pauses(), [], "still ZeroSub's turn");
  f.at(T0 + ZEROSUB_MOVE_GRACE_MS);
  await f.engine.tick();
  const pauses = await f.pauses();
  assert.deepEqual(pauses.map(p => [p.phase, p.idle]), [["waiting", true]]);
  assert.deepEqual(f.native.calls.frozen, [1234], "frozen, as beta.9 holds an idle Claude session");
  f.at(T0 + ZEROSUB_MOVE_GRACE_MS + 5 * MIN);
  await f.engine.tick();
  assert.deepEqual(f.native.calls.released, [], "and not let go again for the same stretch");
});

for (const [name, setUpCase] of [
  ["no other account has room", (zs: ZeroSub) => bothFull(zs)],
  ["automatic switching is off", (zs: ZeroSub) => { aFullBRoomy(zs); zs.autoSwitch = false; }],
  ["B's reading is too old to trust", (zs: ZeroSub) => { aFullBRoomy(zs); zs.read("claude-b", { at: T0 - 31 * MIN, fiveHour: 6, fiveResets: T0 + 5 * HOUR }); }],
] as const) {
  test(`unchanged from beta.9 when ${name}: an idle session is frozen, a running one too`, async t => {
    for (const status of ["idle", "running"] as const) {
      const f = await fixture(t, { native: true });
      f.zs.sessions.x = "claude-a";
      setUpCase(f.zs);
      if (status === "idle") { f.agent.status = "idle"; f.agent.activeTurn = null; }
      await f.engine.tick();
      assert.deepEqual(f.native.calls.frozen, [1234], status);
      assert.deepEqual(f.log, [], `${status}: frozen, not interrupted`);
      assert.deepEqual((await f.pauses()).map(p => p.phase), ["waiting"]);
    }
  });
}

test("unchanged without ZeroSub: the CLI login at the limit freezes an idle session", async t => {
  const f = await fixture(t, { native: true, zerosub: null, paseoPct: 100 });
  f.agent.status = "idle"; f.agent.activeTurn = null;
  await f.engine.tick();
  assert.deepEqual(f.native.calls.frozen, [1234]);
  assert.deepEqual((await f.pauses()).map(p => [p.phase, p.idle]), [["waiting", true]]);
});

// --------------------------------------------------------------------------- the closest reset (Tom, 2026-11-12)

/**
 * Tom: "When a session is paused, it displays the time to the closest reset out of the
 * accounts, and when unpaused the session also moves to that account."
 *
 * The invariant: a hold's displayed reset is the earliest moment any account the session
 * could use has room again, and names that account; the hold ends by moving the session
 * there, never by running a turn on the account that is still out.
 */
test("invariant: a hold shows the earliest reset across the accounts it could use, names it, and is released onto that account", async t => {
  const f = await fixture(t, { native: true });
  f.zs.sessions.x = "claude-a";
  bothFull(f.zs); // A is out until T0+5h, B until T0+3h.
  await f.engine.tick();
  assert.deepEqual(f.native.calls.frozen, [1234], "no account has room: held");
  const [pause] = await f.pauses();
  assert.equal(heldUntil(pause!), iso(T0 + 3 * HOUR), "B's reset, not A's: the earliest");
  assert.equal(pause!.anchorResetsAt, iso(T0 + 5 * HOUR), "A's own reset still decides when A has room (\`resetReady\`)");
  assert.equal(pause!.resetAccount, "Account 3", "and it says whose (a neutral name, never the email)");

  // ZeroSub last read B ten minutes before its reset (it reads an idle account every 20 minutes).
  f.zs.read("claude-b", { at: T0 + 3 * HOUR - 10 * MIN, fiveHour: 100, fiveResets: T0 + 3 * HOUR });
  f.at(T0 + 3 * HOUR - MIN);
  await f.engine.tick();
  assert.deepEqual(f.native.calls.released, [], "held until B resets");

  f.at(T0 + 3 * HOUR + MIN);
  await f.engine.tick();
  assert.deepEqual(f.native.calls.released, [1234], "B's window rolled over: thawed so ZeroSub can move it there");
  assert.deepEqual(f.log, ["guard:interrupt"], "its turn stopped in the foreground");
  assert.equal(f.continuations().length, 0, "never continued on A, which is still out");

  f.zs.move("x", "claude-b", f.now + 10_000); // ZeroSub's next move-off pass.
  f.at(f.now + 15_000);
  await f.engine.tick();
  assert.deepEqual(f.continuations(), [`guard:continue:${pause!.id}`], "continued once");
  assert.equal(f.zs.sessions.x, "claude-b", "on the account the hold named");
  assert.equal((await f.pauses())[0]!.phase, "resumed");
});

test("the hold names the session's own account when it resets first, and moves earlier when a reading shows an earlier one", async t => {
  const f = await fixture(t);
  f.zs.sessions.x = "claude-a";
  f.zs.read("claude-a", { at: T0, fiveHour: 100, fiveResets: T0 + 4 * HOUR });
  f.zs.markLimited("claude-a", T0 + 4 * HOUR);
  f.zs.markLimited("claude-b", T0 + 6 * HOUR); // Out, by the CLI's notice; no reading yet.
  await f.engine.tick();
  let [pause] = await f.pauses();
  assert.equal(heldUntil(pause!), iso(T0 + 4 * HOUR));
  assert.equal(pause!.resetAccount, "Account 2", "A itself");
  // A reading shows B's limit lifts sooner than its recorded one.
  f.zs.account("claude-b").limitedUntil = iso(T0 + 2 * HOUR);
  f.zs.read("claude-b", { at: T0 + MIN, fiveHour: 100, fiveResets: T0 + 2 * HOUR });
  f.at(T0 + 2 * MIN);
  await f.engine.tick();
  [pause] = await f.pauses();
  assert.equal(heldUntil(pause!), iso(T0 + 2 * HOUR), "the earlier reset, now that it is known");
  assert.equal(pause!.resetAccount, "Account 3");
});

for (const [name, setUp] of [
  ["automatic switching is off", (zs: ZeroSub) => { bothFull(zs); zs.autoSwitch = false; }],
  ["the other account is set aside", (zs: ZeroSub) => { bothFull(zs); zs.account("claude-b").disabled = true; }],
] as const) {
  test(`unchanged when ${name}: the hold shows its own account's reset, unnamed`, async t => {
    const f = await fixture(t);
    f.zs.sessions.x = "claude-a";
    setUp(f.zs);
    await f.engine.tick();
    const [pause] = await f.pauses();
    assert.equal(heldUntil(pause!), iso(T0 + 5 * HOUR));
    assert.equal(pause!.resetAccount, undefined);
  });
}

test("unchanged for Codex: a thread can't change accounts, so its hold shows its own reset", async t => {
  const zs = new ZeroSub([...claudeAccounts(), { id: "codex-b", family: "codex", kind: "managed" }]);
  const f = await fixture(t, { provider: "codex", zerosub: zs });
  f.zs.read("codex-main", { at: T0, fiveHour: 100, fiveResets: T0 + 5 * HOUR });
  f.zs.read("codex-b", { at: T0, fiveHour: 100, fiveResets: T0 + 2 * HOUR });
  f.zs.markLimited("codex-b", T0 + 2 * HOUR);
  f.paseoReads(100, T0 + 5 * HOUR);
  await f.engine.tick();
  const [pause] = await f.pauses();
  assert.equal(heldUntil(pause!), iso(T0 + 5 * HOUR));
  assert.equal(pause!.resetAccount, undefined);
});

test("Resume now prefers an account with room: the session moves there first, then continues", async t => {
  const f = await fixture(t, { native: true });
  f.zs.sessions.x = "claude-a";
  aFullBRoomy(f.zs);
  await f.engine.tick(); // Stopped in the foreground for ZeroSub to move…
  f.at(T0 + ZEROSUB_MOVE_GRACE_MS + MIN);
  f.zs.read("claude-b", { at: f.now, fiveHour: 6, fiveResets: T0 + 5 * HOUR, weekly: 88 });
  await f.engine.tick(); // …which it didn't, within the grace: held.
  const [pause] = await f.pauses();
  assert.equal(pause!.phase, "waiting");
  await f.engine.resumeNow("x", pause!.id);
  assert.equal(f.continuations().length, 0, "not sent on A, which is out");
  f.zs.move("x", "claude-b", f.now + 10_000);
  f.at(f.now + 15_000);
  await f.engine.tick();
  assert.equal(f.continuations().length, 1, "continued once, on B");
  const after = (await f.pauses())[0]!;
  assert.equal(after.phase, "resumed");
  assert.equal(after.manualResume, true);
  assert.equal((await f.store.read()).overrides.x, false, "Resume now still turns pausing off for the session");
});

test("Resume now that ZeroSub doesn't act on within the grace resumes in place, as before", async t => {
  const f = await fixture(t, { native: true });
  f.zs.sessions.x = "claude-a";
  aFullBRoomy(f.zs);
  await f.engine.tick();
  f.at(T0 + ZEROSUB_MOVE_GRACE_MS + MIN);
  f.zs.read("claude-b", { at: f.now, fiveHour: 6, fiveResets: T0 + 5 * HOUR, weekly: 88 });
  await f.engine.tick();
  const [pause] = await f.pauses();
  await f.engine.resumeNow("x", pause!.id);
  f.at(f.now + ZEROSUB_MOVE_GRACE_MS + 1000);
  await f.engine.tick();
  assert.equal(f.continuations().length, 1, "continued where it is");
  assert.equal((await f.pauses())[0]!.phase, "resumed");
});

test("Resume now with no account that has room resumes in place, as before", async t => {
  const f = await fixture(t, { native: true });
  f.zs.sessions.x = "claude-a";
  bothFull(f.zs);
  await f.engine.tick();
  const [pause] = await f.pauses();
  await f.engine.resumeNow("x", pause!.id);
  assert.deepEqual(f.native.calls.released, [1234], "thawed in place at once");
  assert.equal((await f.pauses())[0]!.phase, "resumed");
});

// --------------------------------------------------------------------------- audit B: the re-hold after Resume now

/**
 * 2026-11-12, 18dfa78f: Resume now at 11:43:57 thawed a frozen hold and turned pausing off
 * for the session; at 11:44:06 the guard held the same turn again, which it does only once
 * protection is back on. Nothing in the engine turns it back on; only a person's protection
 * change does (the popover's switch or "Use default", the overview's "Use default"), and the
 * daemon log can't say which, if any. This is that sequence, and the trail it now leaves.
 */
test("audit B: a Resume now undone by a protection change is re-held, and the log says who did what", async t => {
  const f = await fixture(t, { native: true });
  const lines: string[] = [];
  f.engine.log = line => lines.push(line);
  f.zs.sessions.x = "claude-a";
  bothFull(f.zs);
  await f.engine.tick();
  const [first] = await f.pauses();
  await f.engine.resumeNow("x", first!.id);
  assert.equal((await f.store.read()).overrides.x, false);
  f.at(T0 + 9_000);
  await f.engine.tick();
  assert.equal((await f.pauses()).filter(p => p.phase === "waiting").length, 0, "nothing re-holds it on its own");

  await f.engine.setProtection("x", null, "popover-use-default"); // Back to the default: pausing on.
  f.at(T0 + 18_000);
  await f.engine.tick();
  assert.equal((await f.pauses()).filter(p => p.phase === "waiting").length, 1, "held again: protection is on and the account is at the limit");

  const trail = lines.map(line => line.replace(/^\[smart-session\] guard /, ""));
  assert.deepEqual(trail.map(line => line.split(" ")[0]), ["hold", "resume-now", "protection", "hold"]);
  assert.match(trail[0]!, /^hold x pause \S+ kind=interrupt frozen=yes override=default 100% resets \S+ shows \S+ \(Account 3\)$/);
  assert.match(trail[1]!, /^resume-now x pause \S+ in-place protection=off$/);
  assert.equal(trail[2], "protection x off -> default (popover-use-default)");
  assert.match(trail[3]!, /override=default/);
});
