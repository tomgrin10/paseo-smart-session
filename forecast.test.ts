process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetLine, contextOutlook, contextRing, forecastWindow, headline, leadWindow, paceLine, resetLine, windowLength } from "./shared/forecast.ts";

const NOW = Date.parse("2026-11-04T19:00:00Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

test("a session window that runs out before its reset says when, and by how much", () => {
  // 74% used, 18%/h, reset in 2h: 26 points last 1h27m, 33 minutes short.
  const f = forecastWindow({ id: "five_hour", pct: 74, resetsAt: iso(NOW + 2 * HOUR), burnPctPerHour: 18 }, NOW);
  assert.equal(f.state, "short");
  assert.equal(f.tone, "warning");
  assert.equal(Math.round((Date.parse(f.runsOutAt!) - NOW) / 60_000), 87);
  assert.equal(Math.round(f.shortMs! / 60_000), 33);
  assert.equal(Math.round(f.elapsed! * 100), 60, "three of five hours gone");
  assert.equal(f.budgetPerHour, 13, "26 points over 2 hours");
  assert.match(paceLine(f, NOW, false), /^Runs out ~20:26 at 18%\/h$/);
  assert.equal(budgetLine(f), "13%/h would last until the reset");
  const h = headline(f, NOW, false);
  assert.equal(h.title, "Session runs out around 20:26");
  assert.match(h.detail, /^33m before the 21:00 reset · 74% used · 18%\/h$/);
});

test("a window that lasts says where it lands, and offers no budget line", () => {
  const f = forecastWindow({ id: "five_hour", pct: 40, resetsAt: iso(NOW + 2 * HOUR), burnPctPerHour: 10 }, NOW);
  assert.equal(f.state, "ok");
  assert.equal(Math.round(f.atResetPct!), 60);
  assert.equal(paceLine(f, NOW), "On pace for ~60% by the reset");
  assert.equal(budgetLine(f), null);
  assert.match(headline(f, NOW, false).title, /^Session lasts until the 21:00 reset$/);
});

test("runs out within half an hour, or nearly full, is red", () => {
  assert.equal(forecastWindow({ id: "five_hour", pct: 90, resetsAt: iso(NOW + HOUR), burnPctPerHour: 30 }, NOW).tone, "danger");
  assert.equal(forecastWindow({ id: "five_hour", pct: 100, resetsAt: iso(NOW + HOUR), burnPctPerHour: 0 }, NOW).state, "full");
});

test("a week is paced by its own average, not the last half hour", () => {
  // 46% after 4 days of a 7-day week: 0.48%/h, lands near 80%. A 30-minute burst of 20%/h must not say "runs out".
  const f = forecastWindow({ id: "seven_day", pct: 46, resetsAt: iso(NOW + 3 * 24 * HOUR), burnPctPerHour: 20 }, NOW);
  assert.equal(f.state, "ok");
  assert.equal(Math.round(f.atResetPct!), 81);
  assert.equal(windowLength("weekly_model:opus"), 7 * 24 * HOUR);
});

test("an idle window and an unknown reset are said plainly", () => {
  const idle = forecastWindow({ id: "five_hour", pct: 30, resetsAt: iso(NOW + HOUR), burnPctPerHour: 0 }, NOW);
  assert.equal(idle.state, "idle");
  assert.equal(paceLine(idle, NOW), "Not in use right now");
  const unknown = forecastWindow({ id: "five_hour", pct: 30, resetsAt: null, burnPctPerHour: 5 }, NOW);
  assert.equal(unknown.state, "unknown");
  assert.equal(resetLine(unknown, NOW), "Reset time not reported");
  assert.equal(headline(null).title, "No plan usage recorded yet");
});

test("the overview leads with the session window, else the fullest", () => {
  const week = forecastWindow({ id: "seven_day", pct: 80, resetsAt: iso(NOW + 24 * HOUR), burnPctPerHour: 1 }, NOW);
  const session = forecastWindow({ id: "five_hour", pct: 10, resetsAt: iso(NOW + HOUR), burnPctPerHour: 1 }, NOW);
  assert.equal(leadWindow([week, session])?.id, "five_hour");
  assert.equal(leadWindow([week])?.id, "seven_day");
  assert.equal(leadWindow([]), null);
});

test("context outlook marks the compact line, past it, and how long until it", () => {
  const below = contextOutlook({ usedTokens: 200_000, maxTokens: 1_000_000, compactAtPct: 30, growthTokensPerHour: 50_000 });
  assert.equal(below.past, false);
  assert.equal(below.untilCompactMs, 2 * HOUR);
  assert.equal(below.tone, "default");
  const past = contextOutlook({ usedTokens: 336_000, maxTokens: 1_000_000, compactAtPct: 30, growthTokensPerHour: 50_000 });
  assert.equal(past.past, true);
  assert.equal(past.untilCompactMs, null);
  assert.equal(past.tone, "warning");
  assert.equal(contextOutlook({ usedTokens: 190_000, maxTokens: 200_000, compactAtPct: 85 }).tone, "danger");
});

test("the context ring is a valid inline icon that quantizes and marks the line", () => {
  const ring = contextRing(0.336, 0.3);
  assert.match(ring, /^<svg [^>]*viewBox="0 0 24 24"/);
  assert.doesNotMatch(ring, /<script|<style|on[a-z]+=/i);
  assert.equal(contextRing(0.335, 0.3), contextRing(0.34, 0.3), "1/48 steps");
  assert.equal((ring.match(/<path/g) ?? []).length, 2, "arc and tick");
  assert.equal((contextRing(0, null).match(/<path/g) ?? []).length, 0);
  assert.match(contextRing(1, null), /<circle[^>]*r="8.5"\/><\/svg>$/);
});

test("a reset that has passed without a newer reading is named, not just called due", () => {
  const f = forecastWindow({ id: "five_hour", pct: 100, resetsAt: iso(NOW - 30 * 60_000), burnPctPerHour: 0 }, NOW);
  assert.equal(f.state, "full");
  assert.equal(resetLine(f, NOW, false), "Reset was 18:30");
  assert.equal(headline(f, NOW, false).detail, "Reset was 18:30 · waiting for the provider to report the new window");
  const ahead = forecastWindow({ id: "five_hour", pct: 100, resetsAt: iso(NOW + 90 * 60_000), burnPctPerHour: 0 }, NOW);
  assert.equal(headline(ahead, NOW, false).detail, "Back at the 20:30 reset · in 1h 30m");
});
