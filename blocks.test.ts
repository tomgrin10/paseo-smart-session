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
