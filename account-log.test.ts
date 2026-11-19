import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cliListing, legacyListing } from "./shared/builtin-usage.ts";
import { creditsKey, creditsRows, holdEvents, moveEvents, placementRow, type PlacementRow } from "./shared/account-log.ts";
import { parseZeroSub, type ZeroSubSnapshot } from "./shared/guard/zerosub.ts";
import type { Pause } from "./shared/guard/policy.ts";
import { asCliReading, fromPaseoProviderUsage, type UsageSample } from "./shared/usage.ts";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const MIN = 60_000;
const iso = (offset: number) => new Date(NOW + offset).toISOString();
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** A built-in report for one login, as Paseo 0.16's `usage.list_reports` lists it. */
const report = (login: string, fiveHour: number, weeklyResets: string) => ({
  id: `claude:${login}`,
  sourceId: "claude",
  account: { label: login },
  fetchedAt: iso(-1 * MIN),
  report: {
    status: "available",
    windows: [
      { id: "session", usedPct: fiveHour, resetsAt: iso(3 * 60 * MIN) },
      { id: "weekly", usedPct: 40, resetsAt: weeklyResets },
    ],
  },
});
const CLI = report("alice@example.com", 30, "2026-11-22T04:00:00.000Z");
const SEAT = report("bob@example.com", 90, "2026-11-20T02:00:00.000Z");

// ------------------------------------------------------------------ usage identity

test("root cause: one login's report per session, and the recorder took the first (account:null rows of two logins)", () => {
  // What the recorder did before: every built-in report is named `claude`, and the first one wins.
  const before = fromPaseoProviderUsage(legacyListing([SEAT, CLI]), "claude", new Date(NOW));
  assert.equal(before?.windows.five_hour?.pct, 90, "the seat's numbers, recorded as the CLI login's");
  assert.equal(before?.account, null);

  // Now: the CLI login's report, picked by its email's hash.
  const after = fromPaseoProviderUsage(cliListing([SEAT, CLI], sha256("alice@example.com"), sha256), "claude", new Date(NOW));
  assert.equal(after?.windows.five_hour?.pct, 30);
  assert.equal(after?.windows.seven_day?.resetsAt, "2026-11-22T04:00:00.000Z");
});

test("cliListing: ambiguity reads as no reading; one report without ZeroSub is the CLI login", () => {
  const read = (entries: unknown[], hash: string | null) => fromPaseoProviderUsage(cliListing(entries, hash, sha256), "claude", new Date(NOW));
  assert.equal(read([SEAT, CLI], null), null, "two logins and no hash to tell them apart");
  assert.equal(read([SEAT], sha256("alice@example.com")), null, "the CLI login's report isn't listed");
  assert.equal(read([CLI], null)?.windows.five_hour?.pct, 30, "a single report: no ZeroSub, the CLI login");
  // Case and whitespace in the label don't hide the match.
  assert.equal(read([SEAT, report(" Alice@Example.com ", 31, iso(0))], sha256("alice@example.com"))?.windows.five_hour?.pct, 31);
  // Other sources' entries ride along untouched and are never read as Claude.
  assert.equal(read([{ id: "smart-session:x", sourceId: "smart-session", report: { status: "available", windows: [] } }, SEAT, CLI], sha256("alice@example.com"))?.windows.five_hour?.pct, 30);
});

test("every recorded reading says whose it is; old rows without it still read back", async (t) => {
  const sample = fromPaseoProviderUsage(cliListing([CLI], null, sha256), "claude", new Date(NOW))!;
  const tagged = asCliReading(sample, "claude-main");
  assert.equal(tagged.login, "cli");
  assert.equal(tagged.accountId, "claude-main");
  assert.equal(asCliReading(sample, null).accountId, null, "without ZeroSub the login is still the CLI's");

  const home = await mkdtemp(join(tmpdir(), "account-log-usage-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  process.env.PASEO_HOME = home;
  const { appendUsage, readUsage } = await import("./server/store.ts");
  const dir = join(home, "plugin-data", "smart-session");
  await mkdir(dir, { recursive: true });
  const old: UsageSample = { at: iso(-10 * MIN), fetchedAt: iso(-10 * MIN), src: "paseo", account: null, windows: { five_hour: { pct: 20, resetsAt: null } }, credits: null };
  await appendFile(join(dir, `usage-${iso(0).slice(0, 7)}.jsonl`), `${JSON.stringify(old)}\n`);
  await appendUsage(tagged);
  const rows = await readUsage();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.login, undefined, "an old row stays as written");
  assert.equal(rows[1]!.accountId, "claude-main");
});

// ------------------------------------------------------------------ ZeroSub fixtures

function zerosub(sessions: Record<string, string>, extra: Record<string, unknown> = {}): ZeroSubSnapshot {
  return parseZeroSub(
    {
      accounts: [
        { id: "claude-main", family: "claude", kind: "main", email: "alice@example.com", autoLabel: true, label: "alice@example.com" },
        { id: "claude-seat", family: "claude", kind: "managed", limitedUntil: iso(60 * MIN), limitKind: "window" },
        { id: "codex-main", family: "codex", kind: "main" },
      ],
      sessions: Object.fromEntries(Object.entries(sessions).map(([agent, accountId]) => [agent, { accountId, openedAt: iso(0) }])),
      ...extra,
    },
    {
      "claude-main": { fetchedAt: iso(-MIN), windows: [], extraUsage: { enabled: true, spend: 1200, limit: 5000, currency: "USD" } },
      "claude-seat": { fetchedAt: iso(-MIN), windows: [], extraUsage: { enabled: false, spend: null, limit: null, currency: null } },
      "codex-main": { fetchedAt: iso(-MIN), windows: [], credits: { balance: 12, unlimited: false } },
    },
    undefined,
  )!;
}

// ------------------------------------------------------------------ placement

test("placement: per account, running and idle counts and the running ids; the map only when it changes", () => {
  const agents = [
    { id: "a1", provider: "claude", status: "running" },
    { id: "a2", provider: "claude", status: "idle" },
    { id: "a3", provider: "claude", status: "idle" },
    { id: "c1", provider: "codex", status: "initializing" },
    { id: "x1", provider: "opencode", status: "running" },
    { id: "z1", provider: "claude", status: "closed" },
  ];
  const snapshot = zerosub({ a2: "claude-seat" });
  const first = placementRow(snapshot, agents, null, iso(0));
  assert.deepEqual(first.row, {
    at: iso(0),
    accounts: { "claude-main": { running: 1, idle: 1 }, "claude-seat": { running: 0, idle: 1 }, "codex-main": { running: 1, idle: 0 } },
    running: ["a1", "c1"],
    agents: { a1: "claude-main", a2: "claude-seat", a3: "claude-main", c1: "codex-main" },
  } satisfies PlacementRow);
  assert.ok(!JSON.stringify(first.row).includes("example.com"), "ids only, never an email");

  // Same places, a status flip: counts and running ids only.
  const second = placementRow(snapshot, agents.map((a) => (a.id === "a1" ? { ...a, status: "idle" } : a)), first.map, iso(MIN));
  assert.equal(second.row?.agents, undefined);
  assert.deepEqual(second.row?.running, ["c1"]);

  // A move: the map again.
  const third = placementRow(zerosub({ a2: "claude-seat", a3: "claude-seat" }), agents, second.map, iso(2 * MIN));
  assert.equal(third.row?.agents?.a3, "claude-seat");

  // Without ZeroSub every agent is on its family's CLI login.
  assert.deepEqual(Object.keys(placementRow(null, agents, null, iso(0)).row!.accounts).sort(), ["claude-cli", "codex-cli"]);

  // Nothing open: one row saying so, then silence.
  const emptied = placementRow(snapshot, [], third.map, iso(3 * MIN));
  assert.deepEqual(emptied.row, { at: iso(3 * MIN), accounts: {}, running: [], agents: {} });
  assert.equal(placementRow(snapshot, [], emptied.map, iso(4 * MIN)).row, null);
});

// ------------------------------------------------------------------ holds

const pause = (over: Partial<Pause> = {}): Pause => ({
  id: "p1", agentId: "a1", provider: "claude", title: "Secret task title", windowId: "session", anchorResetsAt: iso(60 * MIN),
  pausedAt: iso(0), lastUserMessageAt: null, turnId: null, phase: "waiting", note: null, settledAt: null, wasQuotaFailure: false,
  accountId: "claude-main", ...over,
}) as Pause;

test("holds: a start when a pause opens, an end when it settles, with the reason and the outcome; no titles", () => {
  const started = holdEvents([], [pause()], iso(0));
  assert.equal(started.length, 1);
  assert.equal(started[0]!.event, "start");
  assert.equal(started[0]!.reason, "limit");
  assert.equal(started[0]!.accountId, "claude-main");
  assert.ok(!JSON.stringify(started).includes("Secret"), "never the session's title");

  assert.deepEqual(holdEvents([{ id: "p1", settledAt: null }], [pause()], iso(MIN)), [], "unchanged: nothing");

  const ended = holdEvents([{ id: "p1", settledAt: null }], [pause({ phase: "resumed", settledAt: iso(30 * MIN), manualResume: true })], iso(31 * MIN));
  assert.equal(ended[0]!.event, "end");
  assert.equal(ended[0]!.outcome, "manual");
  assert.equal(ended[0]!.at, iso(30 * MIN), "when it settled");

  assert.equal(holdEvents([], [pause({ idle: true })], iso(0))[0]!.reason, "idle");
  assert.equal(holdEvents([], [pause({ wasQuotaFailure: true })], iso(0))[0]!.reason, "quota-failure");
  assert.equal(holdEvents([{ id: "p1", settledAt: null }], [pause({ phase: "cancelled", settledAt: iso(1), releasedForUnload: true })], iso(1))[0]!.outcome, "unload");
  // No baseline yet (first save after a reload): open holds are starts, settled history is not.
  assert.deepEqual(holdEvents(null, [pause(), pause({ id: "old", settledAt: iso(-MIN), phase: "resumed" })], iso(0)).map((r) => r.pauseId), ["p1"]);
});

test("holds: every save through the guard's store is observed, so no hold path can skip the log", async (t) => {
  const { Store } = await import("./server/guard/store.ts");
  const dir = await mkdtemp(join(tmpdir(), "account-log-holds-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const seen: string[] = [];
  const store = new Store(dir, (previous, next) => {
    for (const row of holdEvents(previous, next, iso(0))) seen.push(`${row.event}:${row.pauseId}`);
  });
  const state = await store.read();
  state.pauses.push(pause());
  await store.write(state);
  // The caller mutates what it read, as the engine does; the baseline isn't fooled by that.
  const again = await store.read();
  again.pauses[0]!.phase = "resumed";
  again.pauses[0]!.settledAt = iso(MIN);
  await store.write(again);
  assert.deepEqual(seen, ["start:p1", "end:p1"]);
  // A throwing observer never fails a save.
  await new Store(dir, () => { throw new Error("boom"); }).write(again);
});

// ------------------------------------------------------------------ credits and moves

test("credits: every account's Extra usage or credits and limit state, written when it changes", () => {
  const snapshot = zerosub({});
  const rows = creditsRows(snapshot, new Map(), iso(0));
  assert.deepEqual(rows.map((r) => r.accountId), ["claude-main", "claude-seat", "codex-main"], "the CLI login too, not only it");
  assert.deepEqual(rows[0]!.extraUsage, { enabled: true, spend: 1200, limit: 5000, currency: "USD" });
  assert.deepEqual(rows[2]!.credits, { balance: 12, unlimited: false });
  assert.equal(rows[1]!.limitKind, "window");
  assert.ok(!JSON.stringify(rows).includes("example.com"));
  const last = new Map(rows.map((r) => [r.accountId, creditsKey(r)]));
  assert.deepEqual(creditsRows(snapshot, last, iso(MIN)), [], "nothing moved");
});

test("moves: a session reopened on another account, with ZeroSub's reason; the first look is a baseline", () => {
  const bindings = { a1: { accountId: "claude-seat", source: "pace", at: iso(0) }, a2: { accountId: "claude-main", source: "balance", selectionReason: "headroom", at: iso(0) } };
  const before = { a1: "claude-main", a3: "claude-seat" };
  assert.deepEqual(moveEvents(null, zerosub({ a1: "claude-seat" }, { bindings }), iso(0)), []);
  const rows = moveEvents(before, zerosub({ a1: "claude-seat", a2: "claude-main", a3: "claude-main" }, { bindings }), iso(0));
  assert.deepEqual(rows.map((r) => [r.agentId, r.from, r.to, r.reason]), [
    ["a1", "claude-main", "claude-seat", "pace"],
    ["a2", null, "claude-main", "balance:headroom"],
    ["a3", "claude-seat", "claude-main", "limit"],
  ]);
});

test("the tick writes placement, moves and credits to monthly files, and only changes after that", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "account-log-tick-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  process.env.PASEO_HOME = home;
  const { forgetAccountUse, logAccountUse } = await import("./server/account-log.ts");
  const { readAccountLog } = await import("./server/store.ts");
  forgetAccountUse();
  const agents = [{ id: "a1", provider: "claude", status: "running" }];
  await logAccountUse(zerosub({ a1: "claude-main" }), agents, NOW);
  await logAccountUse(zerosub({ a1: "claude-seat" }, { bindings: { a1: { accountId: "claude-seat", source: "auto", at: iso(0) } } }), agents, NOW + MIN);
  const month = iso(0).slice(0, 7);
  const dir = join(home, "plugin-data", "smart-session");
  assert.deepEqual((await readdir(dir)).sort(), [`credits-${month}.jsonl`, `moves-${month}.jsonl`, `placement-${month}.jsonl`]);
  const placement = await readAccountLog<PlacementRow>("placement");
  assert.equal(placement.length, 2);
  assert.equal(placement[1]!.agents?.a1, "claude-seat");
  const moves = await readAccountLog<{ at: string; reason: string }>("moves");
  assert.deepEqual(moves.map((m) => m.reason), ["auto"]);
  assert.equal((await readAccountLog("credits")).length, 3, "once per account, not once per tick");

  // A reload starts a new process: credits aren't written again, from the log's own last rows.
  forgetAccountUse();
  await logAccountUse(zerosub({ a1: "claude-seat" }), agents, NOW + 2 * MIN);
  assert.equal((await readAccountLog("credits")).length, 3);

  // Read-back is defensive: a torn line and a row of another shape are skipped.
  await appendFile(join(dir, `moves-${month}.jsonl`), `{"at":"broken\n[1,2]\n{"agentId":"x"}\n`);
  assert.equal((await readAccountLog("moves")).length, 1);
  assert.match(await readFile(join(dir, `placement-${month}.jsonl`), "utf8"), /^\{"at":/);
});
