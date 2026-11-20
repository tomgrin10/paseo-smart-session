import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REPORT_SETTINGS, LIMIT_PCT, STEP_MS, accountsReport, normalizeReportSettings, paceWithGate, replay, reportLines,
  type AccountSeries, type HoldSpan, type PlacementSample, type ReplayAccount, type ReplaySpec, type ReportInput,
} from "./shared/accounts-report.ts";

/**
 * Small fictional histories: alice, bob and carol are three accounts on one host. Readings come
 * every 15 minutes; each weekly window is a function of time.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const NOW = Date.parse("2026-03-15T00:00:00.000Z");
const iso = (t: number) => new Date(t).toISOString();

/** The window that contains `t`, for resets every week from `anchor`. */
function windowAt(t: number, anchor: number) {
  const k = Math.floor((t - anchor) / WEEK) + 1;
  const reset = anchor + k * WEEK;
  return { start: reset - WEEK, reset };
}

function series(id: string, opts: {
  anchor: number;
  /** Weekly percent at `t`, given how long the window has been open. */
  weekly: (t: number, sinceStart: number) => number;
  session?: (t: number) => { pct: number; resetsAt: number | null };
  spend?: (t: number) => number;
  from?: number;
  to?: number;
  main?: boolean;
  disabled?: boolean;
}): AccountSeries {
  const readings = [];
  const spend = [];
  for (let t = opts.from ?? NOW - 21 * DAY; t <= (opts.to ?? NOW); t += 15 * MIN) {
    const w = windowAt(t, opts.anchor);
    const s = opts.session?.(t) ?? { pct: 0, resetsAt: null };
    readings.push({
      t,
      weekly: { pct: Math.min(100, Math.round(opts.weekly(t, t - w.start))), resetsAt: iso(w.reset) },
      session: { pct: Math.min(100, Math.round(s.pct)), resetsAt: s.resetsAt === null ? null : iso(s.resetsAt) },
    });
    if (opts.spend) spend.push({ t, minor: opts.spend(t) });
  }
  return { id, name: id[0]!.toUpperCase() + id.slice(1), main: opts.main ?? false, disabled: opts.disabled ?? false, readings, spend };
}

const input = (accounts: AccountSeries[], extra: Partial<ReportInput> = {}): ReportInput => ({
  family: "claude",
  accounts,
  holds: [],
  placement: [],
  moves: [],
  since: { holds: null, placement: null, moves: null },
  now: NOW,
  ...extra,
});

/** A steady burn: `perHour` weekly points while the window is open. */
const steady = (perHour: number) => (_t: number, since: number) => (since / HOUR) * perHour;

test("Used is each weekly window's share by its reset; the open one is shown apart", () => {
  // alice resets every week at the anchor; she reaches 60% in her first window in the period, then 100%.
  const anchor = NOW - 10 * DAY;
  const alice = series("alice", {
    anchor,
    main: true,
    weekly: (t, since) => (t < anchor ? (since / HOUR) * 0.36 : (since / HOUR) * 1.2),
  });
  const report = accountsReport(input([alice]));
  const a = report.accounts[0]!;
  // Windows that reset inside the 14 days: at anchor (NOW-10d) and anchor+7d (NOW-3d).
  assert.equal(a.closedWindows.length, 2);
  assert.ok(a.closedWindows[0]!.pct >= 59 && a.closedWindows[0]!.pct <= 61, `first ${a.closedWindows[0]!.pct}`);
  assert.equal(a.closedWindows[1]!.pct, 100);
  assert.ok(a.usedPct !== null && a.usedPct >= 79 && a.usedPct <= 81);
  assert.ok(a.openPct !== null && a.openPct > 80, "the open window is reported apart");
  assert.equal(report.window.days, 14);
  assert.equal(a.strip.length, 14);
});

test("Misplaced: session-hours at a limit while another account had room, with its cause and a Switch earlier", () => {
  const anchor = NOW - 20 * DAY;
  // alice hits 100% at about 83h into her window and stays there; bob idles at 20%.
  const alice = series("alice", { anchor, main: true, weekly: steady(1.2) });
  const bob = series("bob", { anchor: anchor + 3 * DAY, weekly: () => 20 });
  // Two sessions kept running on alice the whole time; moves were logged and pacing ran.
  const placement: PlacementSample[] = [];
  for (let t = NOW - 14 * DAY; t < NOW; t += 5 * MIN) placement.push({ t, running: { alice: 2, bob: 0 } });
  const report = accountsReport(input([alice, bob], {
    placement,
    moves: [{ t: NOW - 14 * DAY, from: null, to: "bob", reason: "pace" }],
    since: { holds: null, placement: NOW - 14 * DAY, moves: NOW - 14 * DAY },
  }));
  const a = report.accounts.find((m) => m.id === "alice")!;
  assert.ok(a.atLimitHours > 100, `at limit ${a.atLimitHours}`);
  // Two sessions × every hour at the limit with bob free.
  assert.ok(Math.abs(a.misplacedHours - 2 * a.limitWhileRoomHours) < 0.6, `${a.misplacedHours} vs ${a.limitWhileRoomHours}`);
  assert.equal(report.accounts.find((m) => m.id === "bob")!.misplacedHours, 0);
  const better = report.suggestions.find((s) => s.kind === "use-better");
  assert.ok(better, "Switch earlier is suggested");
  assert.equal(better.accountId, "alice");
  assert.equal(better.numbers.roomOn, "bob");
  assert.equal(better.numbers.cause, "late-switch");
  assert.match(better.reason, /on Alice at its limit while Bob had room/);
  assert.deepEqual(better.window, report.window, "every suggestion carries its data window");
});

test("Misplaced before moves were logged says the cause is unknown, never a guess", () => {
  const anchor = NOW - 20 * DAY;
  const alice = series("alice", { anchor, main: true, weekly: steady(1.2), spend: (t) => Math.max(0, Math.round((t - (NOW - 10 * DAY)) / HOUR)) * 10 });
  const bob = series("bob", { anchor, weekly: () => 20 });
  const report = accountsReport(input([alice, bob]));
  const a = report.accounts.find((m) => m.id === "alice")!;
  assert.ok(a.misplacedDollars > 0, "Extra usage paid at the limit while bob had room is misplaced money");
  assert.ok(a.extraDollars >= a.misplacedDollars);
  const better = report.suggestions.find((s) => s.kind === "use-better")!;
  assert.equal(better.numbers.cause, "not-logged");
});

test("the 5-hour edge: past the gate an account ranks last, and a full 5-hour window spills work to the next", () => {
  const acct = (id: string, weeklyPct: number, sessionPct: number, resetIn: number): ReplayAccount =>
    ({ id, size: 1, ratio: 10, weeklyPct, weeklyResetAt: NOW + resetIn, sessionPct, sessionResetAt: NOW + HOUR, usable: true });
  // alice has more weekly room per hour but is past 80% of her 5-hour window.
  const order = paceWithGate([acct("alice", 10, 85, DAY), acct("bob", 60, 10, 5 * DAY)], NOW);
  assert.deepEqual(order, [1, 0]);
  // Under the gate, the pace score decides: alice's room expires sooner.
  assert.deepEqual(paceWithGate([acct("alice", 10, 10, DAY), acct("bob", 60, 10, 5 * DAY)], NOW), [0, 1]);
  // A full one is never offered.
  assert.deepEqual(paceWithGate([acct("alice", 10, 100, DAY), acct("bob", 60, 10, 5 * DAY)], NOW), [1]);

  // One step asks for 6 points; alice's 5-hour window has room for 2.2 (22% at ratio 10), the rest spills to bob.
  const spec = (id: string, sessionPct: number, resets: number[]): ReplaySpec => ({
    id, size: 1, ratio: 10, usable: true, resets,
    start: { weeklyPct: 0, weeklyResetAt: resets[0] ?? null, sessionPct, sessionResetAt: NOW + HOUR },
  });
  const result = replay([{ t: NOW, used: 6, held: 0, extra: 0 }], [spec("alice", 78, [NOW + DAY]), spec("bob", 0, [NOW + 5 * DAY])], paceWithGate, { sessionRate: 1, dollarsPerPoint: null });
  assert.equal(result.short.used, 0);
  assert.equal(result.waitingHours, 0);
  // With bob gone 3.8 points have nowhere to go: 3.8 session-hours of waiting at 1 point a session-hour.
  const alone = replay([{ t: NOW, used: 6, held: 0, extra: 0 }], [spec("alice", 78, [NOW + DAY])], paceWithGate, { sessionRate: 1, dollarsPerPoint: null });
  assert.ok(Math.abs(alone.short.used - 3.8) < 1e-6, `${alone.short.used}`);
  assert.ok(Math.abs(alone.waitingHours - 3.8) < 1e-6);
});

test("different reset times: the replay spends what expires first and counts what expired", () => {
  const spec = (id: string, reset: number): ReplaySpec => ({
    id, size: 1, ratio: 1, usable: true, resets: [reset, reset + WEEK],
    start: { weeklyPct: 0, weeklyResetAt: reset, sessionPct: 0, sessionResetAt: null },
  });
  // 1 point an hour for 2 days, hourly steps of 15 minutes.
  const demand = [];
  for (let t = NOW; t < NOW + 2 * DAY; t += STEP_MS) demand.push({ t, used: 0.25, held: 0, extra: 0 });
  const result = replay(demand, [spec("alice", NOW + 6 * DAY), spec("bob", NOW + DAY)], paceWithGate, { sessionRate: 1, dollarsPerPoint: null });
  // bob resets first: his room went to work instead of expiring.
  assert.ok(result.expired.bob! < 80, `bob expired ${result.expired.bob}`);
  assert.equal(result.expired.alice, 0, "alice has not reset within the demand");
  assert.equal(result.waitingHours, 0);
});

test("Add an account: held work the pool couldn't take is waiting one more account saves", () => {
  const anchor = NOW - 20 * DAY;
  const alice = series("alice", { anchor, main: true, weekly: steady(2) });
  const bob = series("bob", { anchor: anchor + DAY, weekly: steady(2) });
  // Both full for most of each week: sessions were held 8 hours a day, every day.
  const holds: HoldSpan[] = [];
  for (let d = 13; d >= 1; d--) holds.push({ pauseId: `p${d}`, accountId: d % 2 === 0 ? "alice" : "bob", from: NOW - d * DAY, to: NOW - d * DAY + 8 * HOUR });
  const report = accountsReport(input([alice, bob], { holds, since: { holds: NOW - 14 * DAY, placement: null, moves: null } }));
  assert.ok(report.pooled.waitingHours > 100, `waiting ${report.pooled.waitingHours}`);
  assert.ok(report.pooled.allOutHours > 0, "both at a limit at once");
  assert.ok(report.replay.more.waitingHours < report.replay.same.waitingHours);
  assert.equal(report.recommendation?.kind, "add");
  assert.match(report.recommendation!.reason, /one more account would have saved \d+ h of waiting/);
  assert.equal(report.recommendation!.numbers.accounts, 2);
  assert.equal(report.waitingSince, iso(NOW - 14 * DAY));
});

test("Drop names the account that costs least; one still being judged is never dropped, its verdict date shown", () => {
  const anchor = NOW - 20 * DAY;
  const alice = series("alice", { anchor, main: true, weekly: steady(0.3) });
  const bob = series("bob", { anchor: anchor + 2 * DAY, weekly: steady(0.05) });
  // carol arrived three days ago at 0% and is barely used.
  const carol = series("carol", { anchor: NOW - 3 * DAY, from: NOW - 3 * DAY, weekly: () => 1 });
  const report = accountsReport(input([alice, bob, carol]));
  const c = report.accounts.find((m) => m.id === "carol")!;
  assert.equal(c.fullWindows, 0);
  assert.equal(c.verdictAt, iso(NOW - 3 * DAY + 2 * WEEK));
  const verdict = report.suggestions.find((s) => s.kind === "verdict" && s.accountId === "carol")!;
  assert.match(verdict.title, /^Verdict on Carol on Mar 26$/);
  const drop = report.suggestions.find((s) => s.kind === "drop");
  assert.ok(drop, "a light pool suggests dropping one");
  assert.equal(drop.accountId, "bob", "the cheapest account that has its verdict");
  assert.equal(report.recommendation?.kind, "drop");
  assert.ok((drop.numbers.addedWaitHoursPerWeek as number) <= DEFAULT_REPORT_SETTINGS.dropWaitHoursPerWeek);
});

test("Keep, with the replay's numbers either side, when neither adding nor dropping pays", () => {
  const anchor = NOW - 20 * DAY;
  // Each account alone can't hold the pair's work, together they can.
  const alice = series("alice", { anchor, main: true, weekly: steady(0.5) });
  const bob = series("bob", { anchor: anchor + 3 * DAY, weekly: steady(0.5) });
  const report = accountsReport(input([alice, bob]));
  assert.equal(report.recommendation?.kind, "keep");
  assert.match(report.recommendation!.title, /^Keep 2 accounts$/);
  assert.match(report.recommendation!.reason, /with 1 you'd have waited \d+ h more, and with 3 you'd have saved 0 h/);
});

test("plan sizes: an account twice the size counts its percent twice", () => {
  const anchor = NOW - 20 * DAY;
  const alice = series("alice", { anchor, main: true, weekly: steady(0.3) });
  const one = accountsReport(input([alice]));
  const two = accountsReport(input([alice]), normalizeReportSettings({ sizes: { alice: 2 } }));
  const sum = (r: typeof one) => r.replay.same.expired.alice! ;
  assert.equal(two.accounts[0]!.size, 2);
  assert.ok(Math.abs(sum(two) - 2 * sum(one)) < 1, `${sum(two)} vs ${sum(one)}`);
});

test("deterministic: the same logs give the same report", () => {
  const anchor = NOW - 20 * DAY;
  const make = () => accountsReport(input([series("alice", { anchor, main: true, weekly: steady(1) }), series("bob", { anchor: anchor + DAY, weekly: steady(0.7) })]));
  assert.deepEqual(make(), make());
});

test("an account without readings is unknown, never at a limit or out", () => {
  const anchor = NOW - 20 * DAY;
  const alice = series("alice", { anchor, main: true, weekly: () => 100 });
  // bob's readings stopped 10 days ago.
  const bob = series("bob", { anchor, weekly: () => 100, to: NOW - 10 * DAY });
  const report = accountsReport(input([alice, bob]));
  const b = report.accounts.find((m) => m.id === "bob")!;
  assert.ok(b.atLimitHours < 4 * 24 + 7, `bob at a limit only while a reading stood: ${b.atLimitHours}`);
  // All out only while both had a reading: the first four days (and the 6 h a last reading stands).
  assert.ok(report.pooled.allOutHours <= 4 * 24 + 6.5 && report.pooled.allOutHours >= 4 * 24, `${report.pooled.allOutHours}`);
  assert.ok(b.strip.slice(-5).every((d) => d.knownHours === 0));
});

test("All out: an account added later is not room before its first reading", () => {
  const anchor = NOW - 20 * DAY;
  const alice = series("alice", { anchor, main: true, weekly: () => 100 });
  const bob = series("bob", { anchor, weekly: () => 100 });
  // carol arrives two days before the end, with room.
  const carol = series("carol", { anchor: NOW - 2 * DAY, from: NOW - 2 * DAY, weekly: () => 5 });
  const report = accountsReport(input([alice, bob, carol]));
  assert.ok(Math.abs(report.pooled.allOutHours - 12 * 24) <= 0.5, `${report.pooled.allOutHours}`);
});

test("settings: bad values fall back, sizes stay positive", () => {
  const s = normalizeReportSettings({ sizes: { alice: 2, bob: -1, carol: "x" }, addWaitHoursPerWeek: "a", dropDollarsPerWeek: 7 });
  assert.deepEqual(s.sizes, { alice: 2 });
  assert.equal(s.addWaitHoursPerWeek, 2);
  assert.equal(s.dropDollarsPerWeek, 7);
  assert.deepEqual(normalizeReportSettings(null), DEFAULT_REPORT_SETTINGS);
});

test("the text report carries every account, the pooled line, the replay and the recommendation", () => {
  const anchor = NOW - 20 * DAY;
  const report = accountsReport(input([series("alice", { anchor, main: true, weekly: steady(0.5) }), series("bob", { anchor: anchor + 3 * DAY, weekly: steady(0.5) })]));
  const text = reportLines(report).join("\n");
  assert.match(text, /- Alice \(main\) \[alice\]: used \d+% of its windows/);
  assert.match(text, /- Bob \[bob\]/);
  assert.match(text, /^All accounts: /m);
  assert.match(text, /Waiting isn't measured yet/);
  assert.match(text, /Replay \(pace-5h-gate\): with 2: .*; with 3: /);
  assert.match(text, /^Recommendation: Keep 2 accounts\./m);
  assert.ok(LIMIT_PCT > 99 && LIMIT_PCT <= 100);
});
