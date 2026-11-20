import { test } from "node:test";
import assert from "node:assert/strict";

import {
  POLICIES, STEP_MS, accountsReport, paceWithGate, replay,
  type AccountSeries, type DemandStep, type PlacementPolicy, type ReplayAccount, type ReplaySpec,
} from "./shared/accounts-report.ts";
import {
  CUT_OFF_HOURS, EXPIRING_FIRST, WALL_HOURS, expiringFirst, forecastGainMoves, hysteresisMoves, outlook,
  placementMoves, poolForecast, replaySessions, type PlacementContext,
} from "./shared/placement.ts";

/**
 * The placement rules, each stressed by a small fictional scenario (alice, bob, carol on one
 * host). `docs/placement.md` has the math these hold.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const NOW = Date.parse("2026-03-15T00:00:00.000Z");

const acct = (id: string, o: Partial<ReplayAccount> = {}): ReplayAccount => ({
  id, size: 1, ratio: 10, weeklyPct: 0, weeklyResetAt: NOW + 3 * DAY, sessionPct: 0, sessionResetAt: null, usable: true, ...o,
});
const spec = (id: string, pct: number, resetH: number, ratio = 8): ReplaySpec => ({
  id, size: 1, ratio, usable: true, resets: [NOW + resetH * HOUR, NOW + resetH * HOUR + WEEK, NOW + resetH * HOUR + 2 * WEEK],
  start: { weeklyPct: pct, weeklyResetAt: NOW + resetH * HOUR, sessionPct: 0, sessionResetAt: null },
});
/** `perHour(h)` weekly points an hour, `days` long, in replay steps. */
const demandOf = (perHour: (h: number) => number, days = 10): DemandStep[] => {
  const out: DemandStep[] = [];
  for (let i = 0; i < (days * DAY) / STEP_MS; i++) out.push({ t: NOW + i * STEP_MS, used: perHour((i * STEP_MS) / HOUR) * (STEP_MS / HOUR), held: 0, extra: 0 });
  return out;
};
const daytime = (rate: number) => (h: number) => ((h % 24) >= 8 && (h % 24) < 20 ? rate : 0);
const sessionOptions = { stepMs: STEP_MS, sessionRate: 1.5, dollarsPerPoint: 4 };
const ctx = (burn: number[], poolRate?: number): PlacementContext => ({ sessionRate: 1.5, burn, ...(poolRate === undefined ? {} : { poolRate }) });

test("5-hour check: an account whose wall is within the hour goes last, though under ZeroSub's 80% gate", () => {
  // alice's weekly room expires sooner (the better pace score) but her 5-hour window is at 60% and
  // burning 4 points an hour: 40% left at ratio 10 is 4 points, a wall in under an hour.
  const accounts = [acct("alice", { weeklyResetAt: NOW + DAY, sessionPct: 60, sessionResetAt: NOW + 3 * HOUR }), acct("bob", { weeklyResetAt: NOW + 5 * DAY })];
  assert.deepEqual(paceWithGate(accounts, NOW), [0, 1], "today's gate doesn't see it coming");
  assert.deepEqual(expiringFirst()(accounts, NOW, ctx([4, 0])), [1, 0]);
  // With no load, alice's wall is hours away: the pace score decides, as today.
  assert.deepEqual(expiringFirst()(accounts, NOW, ctx([0, 0])), [0, 1]);
});

test("5-hour check: when no window can take a session, the weekly score still decides", () => {
  // Both walls come within the hour. bob's weekly room expires first; a wall costs one move,
  // expired budget is lost, so bob leads (ranking by latest wall put alice first and lost budget).
  const accounts = [
    acct("alice", { weeklyResetAt: NOW + 5 * DAY, sessionPct: 70, sessionResetAt: NOW + 3 * HOUR }),
    acct("bob", { weeklyPct: 20, weeklyResetAt: NOW + DAY, sessionPct: 80, sessionResetAt: NOW + 3 * HOUR }),
  ];
  assert.deepEqual(expiringFirst()(accounts, NOW, ctx([3, 3])), [1, 0]);
});

test("5-hour check: only an imminent wall counts; any wall before the reset loses weekly budget", () => {
  // A steady 1.6 points an hour on two accounts: bob's room expires in 20 h. Demoting bob for a
  // wall hours away moves work to alice and lets bob's budget expire, so work waits later.
  const demand = demandOf(() => 1.6);
  const specs = [spec("alice", 20, 60), spec("bob", 50, 20)];
  const rates = { sessionRate: 1.5, dollarsPerPoint: 4 };
  const shipped = replay(demand, specs, expiringFirst(), rates);
  const anyWall = replay(demand, specs, POLICIES["expiring-first:any-wall"]!, rates);
  assert.ok(anyWall.waitingHours > shipped.waitingHours + 1, `any wall ${anyWall.waitingHours} vs ${shipped.waitingHours}`);
  assert.ok(shipped.waitingHours <= replay(demand, specs, paceWithGate, rates).waitingHours + 1e-9);
});

test("move rule: a session ahead of an imminent wall moves first, the smallest context, trading a forced move for a chosen one", () => {
  const accounts = [acct("alice", { sessionPct: 70, sessionResetAt: NOW + 3 * HOUR }), acct("bob", { weeklyResetAt: NOW + 5 * DAY })];
  const rule = forecastGainMoves(expiringFirst());
  // alice carries her sessions at 4 points an hour: 3 points of 5-hour room left, a wall in 45 minutes.
  const sessions = [{ id: "s1", account: 0, contextTokens: 400_000 }, { id: "s2", account: 0, contextTokens: 50_000 }];
  const m = rule(accounts, sessions, NOW, ctx([4, 0], 3));
  assert.ok(m !== null);
  assert.equal(m.session, "s2", "the smallest context moves first");
  assert.equal(m.to, 1);
  assert.equal(m.reason, "five-hour");
  // The wall moves it anyway, cache miss and all: moving now saves the cut-off turn on top.
  // One session's forecast use: the pool's 3 points an hour over the 4 ÷ 1.5 sessions running.
  assert.ok(Math.abs(m.gain - m.cost - (3 / (4 / 1.5)) * CUT_OFF_HOURS) < 1e-9, `${m.gain} - ${m.cost}`);
  // Crediting none of the later miss, a big context's miss outweighs the cut-off: it stays.
  assert.equal(forecastGainMoves(expiringFirst(), { laterMiss: 0 })(accounts, [sessions[0]!], NOW, ctx([4, 0], 3)), null);
  // A wall too far ahead to trust (past WALL_HOURS): no move.
  assert.equal(rule([acct("alice", { sessionPct: 40, sessionResetAt: NOW + 3 * HOUR }), accounts[1]!], sessions, NOW, ctx([4, 0], 3)), null);
  // No wall ahead: nothing for the forecast rule to do.
  assert.equal(rule([acct("alice"), acct("bob")], sessions, NOW, ctx([4, 0], 3)), null);
});

test("move rule: without a wall ahead, today's 1.5x rebalance decides", () => {
  // One session sits on alice (room for a week) while bob's room expires tomorrow.
  const accounts = [acct("alice", { weeklyResetAt: NOW + 6 * DAY }), acct("bob", { weeklyPct: 30, weeklyResetAt: NOW + DAY })];
  const sessions = [{ id: "s1", account: 0, contextTokens: 100_000 }];
  const m = placementMoves(expiringFirst())(accounts, sessions, NOW, ctx([1.5, 0], 1.5));
  assert.ok(m !== null);
  assert.equal(m.reason, "rebalance");
  assert.equal(m.to, 1);
  // Within 1.5x of each other: it stays (the hysteresis).
  const close = [acct("alice", { weeklyResetAt: NOW + 2 * DAY }), acct("bob", { weeklyPct: 30, weeklyResetAt: NOW + 2 * DAY })];
  assert.equal(hysteresisMoves(expiringFirst())(close, sessions, NOW, ctx([1.5, 0], 1.5)), null);
});

test("session replay: on a short 5-hour window the new placement cuts off fewer turns, moves less and waits less", () => {
  // Two accounts whose 5-hour window is a quarter of a day's work (ratio 25), 4.5 points an hour by day.
  const demand = demandOf(daytime(4.5));
  const specs = [spec("alice", 0, 160, 25), spec("bob", 0, 150, 25)];
  const today = replaySessions(demand, specs, paceWithGate, hysteresisMoves(paceWithGate), sessionOptions);
  const shipped = replaySessions(demand, specs, expiringFirst(), placementMoves(expiringFirst()), sessionOptions);
  assert.ok(shipped.cutOffHours < today.cutOffHours, `cut off ${shipped.cutOffHours} vs ${today.cutOffHours}`);
  assert.ok(shipped.moves + shipped.forcedMoves < today.moves + today.forcedMoves, `moves ${shipped.moves}+${shipped.forcedMoves} vs ${today.moves}+${today.forcedMoves}`);
  assert.ok(shipped.waitingHours < today.waitingHours, `waiting ${shipped.waitingHours} vs ${today.waitingHours}`);
  // The moves ahead of the wall earn their part: without them, more turns are cut off.
  const placedOnly = replaySessions(demand, specs, expiringFirst(), hysteresisMoves(expiringFirst()), sessionOptions);
  assert.ok(shipped.cutOffHours < placedOnly.cutOffHours, `cut off ${shipped.cutOffHours} vs ${placedOnly.cutOffHours} without moves ahead of the wall`);
  assert.ok(Math.abs(today.cutOffHours - today.forcedMoves * CUT_OFF_HOURS) < 1e-9, "each forced move costs Session Guard's grace");
});

test("session replay: sessions stay put, so without moves a lone session strands expiring budget", () => {
  // One session for ten days. Placed on alice, it stays while bob's room expires; the rebalance fixes it.
  const demand = demandOf(() => 1.6);
  const specs = [spec("alice", 20, 60), spec("bob", 50, 20)];
  const stuck = replaySessions(demand, specs, expiringFirst(), null, sessionOptions);
  const moved = replaySessions(demand, specs, expiringFirst(), placementMoves(expiringFirst()), sessionOptions);
  assert.ok(moved.waitingHours + 10 < stuck.waitingHours, `${moved.waitingHours} vs ${stuck.waitingHours}`);
  assert.ok(moved.moves >= 1);
  // Guards: at most one chosen move per 10 minutes, none within 6 hours of the session's last.
  assert.ok(moved.moves <= Math.ceil((10 * DAY) / (6 * HOUR)));
});

test("look-ahead: the outlook finds budget that expires while work later waits", () => {
  // alice's pace score is better (100 points over 20 h) than bob's (4 points, resetting in an hour), so
  // the pace rule gives alice the hour and bob's 4 points expire; 6 points an hour outruns both later.
  const accounts = [acct("alice", { weeklyResetAt: NOW + 20 * HOUR }), acct("bob", { weeklyPct: 96, weeklyResetAt: NOW + HOUR })];
  const tight = outlook(accounts, NOW, 6);
  assert.ok(tight.unserved > 0 && Math.abs(tight.wasted - 4) < 1e-9 && tight.tight, JSON.stringify(tight));
  // Half a point an hour: nothing waits, so nothing that expires is waste.
  assert.equal(outlook(accounts, NOW, 0.5).tight, false);
  // Tight: the look-ahead variant ranks the earliest reset first; the shipped rule keeps the pace score.
  assert.deepEqual(expiringFirst({ ...EXPIRING_FIRST, lookAhead: true })(accounts, NOW, ctx([0, 0], 6)), [1, 0]);
});

test("the fluid replay hands a policy the forecast: each account's recent burn and the pool's last day", () => {
  const seen: PlacementContext[] = [];
  const spy: PlacementPolicy = (accounts, now, c) => { if (c) seen.push(c); return paceWithGate(accounts, now); };
  replay(demandOf(() => 2, 2), [spec("alice", 0, 100), spec("bob", 0, 120)], spy, { sessionRate: 1.5, dollarsPerPoint: null });
  const last = seen[seen.length - 1]!;
  assert.equal(last.sessionRate, 1.5);
  assert.ok(Math.abs(last.poolRate! - 2) < 1e-9, `${last.poolRate}`);
  assert.ok(Math.abs(last.burn.reduce((s, b) => s + b, 0) - 2) < 1e-9);
  const pool = poolForecast(demandOf(() => 3, 2));
  assert.equal(pool(0), 0, "no history, no forecast");
  assert.ok(Math.abs(pool(10) - 3) < 1e-9);
});

test("replay: an account added later is not room before its first reading", () => {
  // alice is at her limit all period; work is held on her for 10 hours, 8 days ago. carol arrives
  // two days ago: the held work had nowhere to go then, so the replay must count it as waiting.
  const series = (id: string, from: number, pct: number): AccountSeries => {
    const readings = [];
    for (let t = from; t <= NOW; t += 15 * MIN) readings.push({ t, weekly: { pct, resetsAt: new Date(NOW + 3 * DAY).toISOString() }, session: { pct: 0, resetsAt: null } });
    return { id, name: id, main: id === "alice", disabled: false, readings, spend: [] };
  };
  const report = accountsReport({
    family: "claude",
    accounts: [series("alice", NOW - 21 * DAY, 100), series("carol", NOW - 2 * DAY, 5)],
    holds: [{ pauseId: "p1", accountId: "alice", from: NOW - 8 * DAY, to: NOW - 8 * DAY + 10 * HOUR }],
    placement: [],
    moves: [],
    since: { holds: NOW - 9 * DAY, placement: NOW - 9 * DAY, moves: NOW - 9 * DAY },
    now: NOW,
  });
  assert.ok(report.replay.same.waitingHours >= 9.5, `waiting ${report.replay.same.waitingHours}`);
  assert.equal(report.replay.same.expired.carol, 0, "nothing of carol's expired before she existed");
});

test("every scored rule is pure: the same state gives the same order and the same replay", () => {
  const demand = demandOf(daytime(4));
  const specs = [spec("alice", 0, 100), spec("bob", 30, 30), spec("carol", 10, 70)];
  for (const [name, policy] of Object.entries(POLICIES)) {
    const a = replaySessions(demand, specs, policy, placementMoves(policy), sessionOptions);
    const b = replaySessions(demand, specs, policy, placementMoves(policy), sessionOptions);
    assert.deepEqual(a, b, name);
  }
  assert.equal(WALL_HOURS, 1);
});
