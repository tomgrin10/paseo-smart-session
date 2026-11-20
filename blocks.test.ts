import assert from "node:assert/strict";
import { test } from "node:test";

import { burnRatePctPerHour, projectedExhaustion, segmentBlocks, thinPoints } from "./shared/blocks.ts";
import type { UsageSample } from "./shared/usage.ts";

function sample(at: string, pct: number, resetsAt: string | null): UsageSample {
  return {
    at,
    fetchedAt: null,
    src: "paseo",
    account: null,
    windows: { five_hour: { pct, resetsAt } },
    credits: null,
  };
}

test("a later reset starts a new block; peak and final are per block", () => {
  const blocks = segmentBlocks([
    sample("2026-09-05T09:00:00Z", 10, "2026-09-05T12:00:00Z"),
    sample("2026-09-05T10:00:00Z", 80, "2026-09-05T12:00:00Z"),
    sample("2026-09-05T11:00:00Z", 55, "2026-09-05T12:00:00Z"),
    sample("2026-09-05T12:30:00Z", 4, "2026-09-05T17:00:00Z"),
  ]);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.peakPct, 80);
  assert.equal(blocks[0]!.finalPct, 55, "peak and final are different questions");
  assert.equal(blocks[0]!.startAt, "2026-09-05T07:00:00.000Z", "resetsAt minus five hours");
  assert.equal(blocks[1]!.points.length, 1);
});

test("a reset reported microseconds apart is the same window, not a rollover", () => {
  // The provider re-derives the instant on each read; exact comparison would see
  // a brand new window on every single refresh.
  const blocks = segmentBlocks([
    sample("2026-09-05T09:00:00Z", 10, "2026-09-05T12:00:00.309Z"),
    sample("2026-09-05T09:01:00Z", 11, "2026-09-05T12:00:00.873Z"),
    sample("2026-09-05T09:02:00Z", 12, "2026-09-05T12:00:01.004Z"),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.points.length, 3);
});

test("an earlier reported reset is a revision, never a rollover", () => {
  // A new window always ends later than the one it replaced. Treating a backwards
  // revision as a rollover would split one block in two and halve its peak.
  const blocks = segmentBlocks([
    sample("2026-09-05T09:00:00Z", 10, "2026-09-05T12:00:00Z"),
    sample("2026-09-05T09:30:00Z", 40, "2026-09-05T11:40:00Z"),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.peakPct, 40);
  assert.equal(blocks[0]!.resetsAt, "2026-09-05T11:40:00.000Z", "the newer reading wins");
});

test("a stretch with nobody watching is recorded, not smoothed over", () => {
  const blocks = segmentBlocks(
    [
      sample("2026-09-05T09:00:00Z", 10, "2026-09-05T12:00:00Z"),
      sample("2026-09-05T10:30:00Z", 70, "2026-09-05T12:00:00Z"),
    ],
    { gapMs: 15 * 60 * 1000 },
  );
  assert.deepEqual(blocks[0]!.gaps, [{ from: "2026-09-05T09:00:00.000Z", to: "2026-09-05T10:30:00.000Z" }]);
});

test("windows are segmented independently of each other", () => {
  const both: UsageSample = {
    at: "2026-09-05T09:00:00Z",
    fetchedAt: null,
    src: "paseo",
    account: null,
    windows: {
      five_hour: { pct: 10, resetsAt: "2026-09-05T12:00:00Z" },
      seven_day: { pct: 3, resetsAt: "2026-09-08T00:00:00Z" },
    },
    credits: null,
  };
  const rolled: UsageSample = {
    ...both,
    at: "2026-09-05T13:00:00Z",
    windows: {
      five_hour: { pct: 2, resetsAt: "2026-09-05T17:00:00Z" },
      seven_day: { pct: 5, resetsAt: "2026-09-08T00:00:00Z" },
    },
  };
  const blocks = segmentBlocks([both, rolled]);
  assert.equal(blocks.filter((block) => block.windowId === "five_hour").length, 2);
  assert.equal(blocks.filter((block) => block.windowId === "seven_day").length, 1, "the weekly window did not roll");
});

test("burn rate and projected exhaustion", () => {
  const [block] = segmentBlocks([
    sample("2026-09-05T09:00:00Z", 10, "2026-09-05T14:00:00Z"),
    sample("2026-09-05T09:30:00Z", 20, "2026-09-05T14:00:00Z"),
    sample("2026-09-05T10:00:00Z", 30, "2026-09-05T14:00:00Z"),
  ]);
  assert.equal(burnRatePctPerHour(block!), 20, "20 points per hour over the last half hour");
  assert.equal(
    projectedExhaustion(block!, new Date("2026-09-05T10:00:00Z")),
    "2026-09-05T13:30:00.000Z",
    "70 points left at 20/h lands before the window resets",
  );
});

test("a window minutes old is measured from its start, not from one integer step", () => {
  // The provider reports whole percents. A window opened at 06:50 read 0% at 06:58, 1% at 06:59
  // and 1% at 07:01: one step over three minutes read as 20%/h ("on pace for ~97%"), and over one
  // minute as 60%/h ("runs out ~8:40"). The window was 0% when it opened, so that is a reading too.
  const reset = "2026-09-05T11:50:00Z";
  const [block] = segmentBlocks([
    sample("2026-09-05T06:58:48Z", 0, reset),
    sample("2026-09-05T06:59:48Z", 1, reset),
    sample("2026-09-05T07:01:48Z", 1, reset),
  ]);
  const rate = burnRatePctPerHour(block!)!;
  assert.ok(Math.abs(rate - 1 / (11.8 / 60)) < 0.01, `1 point over the window's 11.8 minutes, not ${rate}`);
  // Under ten minutes of window there is nothing to extrapolate yet.
  const [young] = segmentBlocks([sample("2026-09-05T06:51:00Z", 0, reset), sample("2026-09-05T06:53:00Z", 1, reset)]);
  assert.equal(burnRatePctPerHour(young!), null);
  // Without a reset time the start is unknown: the same ten-minute floor holds.
  const [unknown] = segmentBlocks([sample("2026-09-05T06:51:00Z", 0, null), sample("2026-09-05T06:53:00Z", 1, null)]);
  assert.equal(burnRatePctPerHour(unknown!), null);
});

test("a window reported with no reset after the held one reset is a new window not yet started", () => {
  // Wednesday's window reset at 15:59; on Friday the provider reports the 5-hour window as 0% with
  // no reset (nothing has started one). That reading used to join Wednesday's block, so the account
  // row said "5h reset · was Wed 3:59 PM" on a fresh reading.
  const blocks = segmentBlocks([
    sample("2026-11-18T12:00:00Z", 30, "2026-11-18T13:59:00Z"),
    sample("2026-11-18T13:00:00Z", 45, "2026-11-18T13:59:00Z"),
    sample("2026-11-20T07:00:00Z", 0, null),
    sample("2026-11-20T07:01:00Z", 0, null),
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.resetsAt, "2026-11-18T13:59:00.000Z");
  assert.equal(blocks[0]!.peakPct, 45);
  const open = blocks[1]!;
  assert.equal(open.resetsAt, null, "the open window has not started");
  assert.equal(open.finalPct, 0);
  // When it starts, the not-started stretch gives way to it: no empty window among the earlier ones.
  const started = segmentBlocks([
    sample("2026-11-18T12:00:00Z", 30, "2026-11-18T13:59:00Z"),
    sample("2026-11-20T07:00:00Z", 0, null),
    sample("2026-11-20T08:10:00Z", 2, "2026-11-20T13:10:00Z"),
  ]);
  assert.deepEqual(started.map((b) => [b.resetsAt, b.peakPct]), [["2026-11-18T13:59:00.000Z", 30], ["2026-11-20T13:10:00.000Z", 2]]);
  // A reset not reported while the held window is still open changes nothing.
  const same = segmentBlocks([
    sample("2026-11-18T12:00:00Z", 30, "2026-11-18T13:59:00Z"),
    sample("2026-11-18T12:30:00Z", 31, null),
  ]);
  assert.equal(same.length, 1);
});

test("nothing is projected when the window rolls over first", () => {
  const [block] = segmentBlocks([
    sample("2026-09-05T09:00:00Z", 10, "2026-09-05T11:00:00Z"),
    sample("2026-09-05T10:00:00Z", 12, "2026-09-05T11:00:00Z"),
  ]);
  assert.equal(projectedExhaustion(block!, new Date("2026-09-05T10:00:00Z")), null);
});

test("a flat block has a rate but no exhaustion", () => {
  const [block] = segmentBlocks([
    sample("2026-09-05T09:00:00Z", 40, "2026-09-05T14:00:00Z"),
    sample("2026-09-05T10:00:00Z", 40, "2026-09-05T14:00:00Z"),
  ]);
  assert.equal(burnRatePctPerHour(block!), 0);
  assert.equal(projectedExhaustion(block!, new Date("2026-09-05T10:00:00Z")), null);
});

test("thinPoints keeps the first and last reading and at most the asked number", () => {
  const points = Array.from({ length: 500 }, (unused, i) => ({ t: new Date(Date.UTC(2026, 10, 4, 12, 0, i)).toISOString(), pct: i / 5 }));
  const thin = thinPoints(points, 96);
  assert.equal(thin.length, 96);
  assert.deepEqual(thin[0], points[0]);
  assert.deepEqual(thin[95], points[499]);
  assert.ok(thin.every((point, i) => i === 0 || point.pct >= thin[i - 1]!.pct), "still in order");
  assert.equal(thinPoints(points.slice(0, 10), 96).length, 10, "short series pass through");
});
