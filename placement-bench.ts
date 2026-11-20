/**
 * The placement benchmark behind `docs/placement.md`: today's rule against the shipped one and its
 * variants, on random fictional scenarios (two or three accounts, random reset times and 5-hour
 * ratios, bursty daily demand), in both replays. Deterministic per seed.
 *
 *   node --experimental-strip-types placement-bench.ts [seed=7] [scenarios=150]
 */
import { POLICIES, STEP_MS, paceWithGate, replay, type DemandStep, type PlacementPolicy, type ReplaySpec } from "./shared/accounts-report.ts";
import { forecastGainMoves, hysteresisMoves, placementMoves, replaySessions, type MoveRule } from "./shared/placement.ts";

const HOUR = 3_600_000;
const WEEK = 168 * HOUR;
let seed = Number(process.argv[2] ?? 7);
const count = Number(process.argv[3] ?? 150);
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

const scenarios: { demand: DemandStep[]; specs: ReplaySpec[]; rates: { sessionRate: number; dollarsPerPoint: number } }[] = [];
for (let k = 0; k < count; k++) {
  const n = 2 + Math.floor(rnd() * 2);
  const specs: ReplaySpec[] = [];
  for (let j = 0; j < n; j++) {
    const reset = (2 + rnd() * 166) * HOUR;
    const pct = Math.round(rnd() * 80 * (1 - reset / WEEK));
    specs.push({ id: `account-${j}`, size: 1, ratio: 5 + rnd() * 20, usable: true, resets: [reset, reset + WEEK, reset + 2 * WEEK], start: { weeklyPct: pct, weeklyResetAt: reset, sessionPct: 0, sessionResetAt: null } });
  }
  const peak = (0.8 + rnd() * 2.2) * n;
  const start = 6 + rnd() * 6;
  const length = 8 + rnd() * 8;
  const burst = rnd();
  const demand: DemandStep[] = [];
  for (let i = 0; i < (10 * 24 * HOUR) / STEP_MS; i++) {
    const h = ((i * STEP_MS) / HOUR) % 24;
    const perHour = h >= start && h < start + length ? peak * (1 + burst * Math.sin(i / 3)) : peak * 0.05;
    demand.push({ t: i * STEP_MS, used: perHour * (STEP_MS / HOUR), held: 0, extra: 0 });
  }
  scenarios.push({ demand, specs, rates: { sessionRate: 1.2 + rnd(), dollarsPerPoint: 4 } });
}

const shipped = POLICIES["expiring-first"]!;
const rules: [string, PlacementPolicy, MoveRule | null][] = [
  ["today: pace-5h-gate + 1.5x rebalance", paceWithGate, hysteresisMoves(paceWithGate)],
  ["shipped: expiring-first + moves", shipped, placementMoves(shipped)],
  ["  no moves ahead of a wall", shipped, hysteresisMoves(shipped)],
  ["  weekly moves by forecast gain", shipped, ((w: MoveRule, h: MoveRule): MoveRule => (...a) => w(...a) ?? h(...a))(forecastGainMoves(shipped, { gains: ["five-hour", "expiring"] }), hysteresisMoves(shipped))],
  ["  look-ahead", POLICIES["expiring-first:look-ahead"]!, placementMoves(POLICIES["expiring-first:look-ahead"]!)],
  ["  any wall before the reset", POLICIES["expiring-first:any-wall"]!, placementMoves(POLICIES["expiring-first:any-wall"]!)],
  ["  80% gate", POLICIES["expiring-first:gate-80"]!, placementMoves(POLICIES["expiring-first:gate-80"]!)],
  ["  earliest reset first (EDF)", POLICIES["expiring-first:edf"]!, placementMoves(POLICIES["expiring-first:edf"]!)],
];
const base = scenarios.map((s) => ({ fluid: replay(s.demand, s.specs, paceWithGate, s.rates), sessions: replaySessions(s.demand, s.specs, paceWithGate, hysteresisMoves(paceWithGate), { stepMs: STEP_MS, ...s.rates }) }));
const avg = (x: number) => (x / count).toFixed(2);
console.log(`${count} scenarios, seed ${process.argv[2] ?? 7}. Averages per scenario; wins/losses against today by more than 0.25 h.\n`);
console.log("| rule | fluid waiting h | wins/losses | session waiting h | wins/losses | cut-off h | chosen moves | forced moves |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const [name, policy, moves] of rules) {
  let fw = 0, sw = 0, cut = 0, chosen = 0, forced = 0, fwin = 0, floss = 0, swin = 0, sloss = 0;
  scenarios.forEach((s, k) => {
    const f = replay(s.demand, s.specs, policy, s.rates);
    const r = replaySessions(s.demand, s.specs, policy, moves, { stepMs: STEP_MS, ...s.rates });
    fw += f.waitingHours; sw += r.waitingHours; cut += r.cutOffHours; chosen += r.moves; forced += r.forcedMoves;
    if (f.waitingHours < base[k]!.fluid.waitingHours - 0.25) fwin++;
    if (f.waitingHours > base[k]!.fluid.waitingHours + 0.25) floss++;
    if (r.waitingHours < base[k]!.sessions.waitingHours - 0.25) swin++;
    if (r.waitingHours > base[k]!.sessions.waitingHours + 0.25) sloss++;
  });
  console.log(`| ${name} | ${avg(fw)} | ${fwin}/${floss} | ${avg(sw)} | ${swin}/${sloss} | ${avg(cut)} | ${avg(chosen)} | ${avg(forced)} |`);
}
