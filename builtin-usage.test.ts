import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { builtinEntry, legacyListing, mergeBuiltin, type BuiltinReading } from "./shared/builtin-usage.ts";
import type { Subscription, SubscriptionWindow } from "./shared/subscriptions.ts";
import { buildReport, hideableCards, withBuiltin, type SourceState } from "./shared/usage-source.ts";
import { fromPaseoProviderUsage } from "./shared/usage.ts";
import { behind, capture, captured, forgetBuiltin, noteBuilt } from "./server/builtin-usage.ts";
import { createHash } from "node:crypto";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const win = (id: string, pct: number, resetIn: number, burn: number | null = 2): SubscriptionWindow => ({ id, pct, resetsAt: iso(resetIn), burnPctPerHour: burn });

function account(over: Partial<Subscription> = {}): Subscription {
  return {
    id: "claude-two", family: "claude", kind: "managed", name: "Account 2", named: false, isDefault: false,
    signedIn: true, disabled: false, limitedUntil: null, outUntil: null, createdAt: "2026-10-01T00:00:00Z", agents: 1,
    readAt: iso(-12 * MIN),
    windows: [win("five_hour", 20, 3 * HOUR), win("seven_day", 58, 3 * 24 * HOUR)],
    credits: null,
    ...over,
  };
}

/** A daemon `usage.list_reports` entry from Paseo's own Claude source, as 0.16 sends it. */
const entry = (over: Record<string, unknown> = {}) => ({
  id: "claude:uuid.org",
  sourceId: "claude",
  sourceLabel: "Claude",
  account: { label: "Seat@Example.com" },
  fetchedAt: iso(-1 * MIN),
  successfulAt: iso(-1 * MIN + 900),
  report: {
    status: "available",
    windows: [
      { id: "five_hour", label: "Session", usedPct: 30, remainingPct: 70, resetsAt: iso(3 * HOUR) },
      { id: "weekly", label: "Weekly", usedPct: 60, remainingPct: 40, resetsAt: iso(3 * 24 * HOUR) },
      { id: "weekly_model_fable", label: "Weekly · Fable", usedPct: 12, remainingPct: 88, resetsAt: iso(3 * 24 * HOUR) },
    ],
  },
  ...over,
});

const reading = (over: Partial<BuiltinReading> = {}): BuiltinReading => builtinEntry(entry())!.reading && { ...builtinEntry(entry())!.reading, ...over };
const labelOf = (id: string) => (id === "five_hour" ? "Session" : id === "seven_day" ? "Weekly" : id);

test("a built-in entry yields its login and reading; anything else is ignored", () => {
  const found = builtinEntry(entry());
  assert.equal(found?.login, "Seat@Example.com");
  assert.equal(found?.reading.id, "claude:uuid.org");
  assert.equal(found?.reading.current, true);
  assert.equal(found?.reading.fetchedAt, iso(-1 * MIN + 900));
  assert.deepEqual(found?.reading.windows.map((w) => [w.id, w.usedPct]), [["five_hour", 30], ["weekly", 60], ["weekly_model_fable", 12]]);
  assert.equal(builtinEntry(entry({ sourceId: "smart-session" })), null);
  assert.equal(builtinEntry(entry({ account: {} })), null);
  assert.equal(builtinEntry(entry({ account: { label: "Claude" } })), null);
  assert.equal(builtinEntry({ ...entry(), report: { status: "error", error: "x" } }), null);
  assert.equal(builtinEntry(null), null);
  // An error keeps the last good reading, marked as not current.
  const kept = builtinEntry({ ...entry(), report: { status: "error", error: "429" }, lastSuccessful: { fetchedAt: iso(-20 * MIN), report: entry().report } });
  assert.equal(kept?.reading.current, false);
  assert.equal(kept?.reading.fetchedAt, iso(-20 * MIN));
});

test("live bug B: ZeroSub lags at 20%/58% while Paseo's card reads 30%/60%; ours shows Paseo's numbers, not older ones", () => {
  const merged = mergeBuiltin(account(), reading(), labelOf);
  assert.deepEqual(merged.windows.map((w) => [w.id, w.pct]), [["five_hour", 30], ["seven_day", 60], ["weekly_model:fable", 12]]);
  // The pace is still ours; the reading's time is the built-in's.
  assert.equal(merged.windows[0]!.burnPctPerHour, 2);
  assert.equal(merged.readAt, iso(-1 * MIN + 900));
});

test("while the daemon holds a current reading both cards show it, even when ours is a little newer", () => {
  const merged = mergeBuiltin(account({ readAt: iso(-10_000) }), reading(), labelOf);
  assert.equal(merged.windows[0]!.pct, 30);
});

test("a built-in error's last good reading replaces ours only when it is newer", () => {
  const older = reading({ current: false, fetchedAt: iso(-20 * MIN) });
  assert.equal(mergeBuiltin(account(), older, labelOf).windows[0]!.pct, 20);
  const newer = reading({ current: false, fetchedAt: iso(-5 * MIN) });
  assert.equal(mergeBuiltin(account(), newer, labelOf).windows[0]!.pct, 30);
  assert.equal(mergeBuiltin(account(), null, labelOf).windows[0]!.pct, 20);
});

test("invariant: the card that may hide Paseo's shows numbers at least as new as Paseo's own", () => {
  const state: SourceState = {
    zerosub: {
      accounts: [account({ readAt: iso(-40 * MIN) })], // ZeroSub so far behind ours reads stale
      autoSwitch: true,
      extras: { "claude-two": { emailHash: "H2", plan: "team", windowLabels: {}, extraUsage: null } },
      sessions: {}, homes: {},
    },
    recorded: null,
  };
  // Unmerged: stale, not hideable, and the card says "Reading · 40m old".
  assert.deepEqual(hideableCards(state, NOW), []);
  const merged = withBuiltin(state, (hash) => (hash === "H2" ? reading() : null));
  const report = buildReport(merged, { account: "claude-two", lead: true }, NOW);
  assert.equal(report.status, "available");
  if (report.status !== "available") return;
  for (const theirs of reading().windows) {
    const ours: { usedPct: number | null } | undefined = report.windows.find((w) => w.label === theirs.label);
    assert.equal(ours?.usedPct, theirs.usedPct, `${theirs.label} shows Paseo's reading`);
  }
  assert.ok(!report.details?.some((d) => d.id === "reading"), "no stale-reading row once merged");
  assert.deepEqual(hideableCards(merged, NOW), [{ key: "claude-two", emailHash: "H2" }]);
});

test("the server keeps readings by login hash only, and knows when a card of ours is behind", () => {
  forgetBuiltin();
  const hash = createHash("sha256").update("seat@example.com").digest("hex");
  const ours = { id: "smart-session:claude-two", sourceId: "smart-session", report: { status: "available", windows: [] } };
  capture([entry(), ours], (key) => (key === "claude-two" ? hash : null));
  assert.equal(captured(hash)?.id, "claude:uuid.org");
  assert.equal(captured("seat@example.com"), null, "never keyed by the email");
  assert.deepEqual(behind(), [], "nothing built yet: nothing to realign");
  noteBuilt(hash, captured(hash));
  assert.deepEqual(behind(), []);
  // The daemon refreshes Paseo's card after ours was built: ours is behind.
  capture([entry({ successfulAt: iso(0) })], () => null);
  assert.deepEqual(behind(), ["smart-session:claude-two"]);
  // An older capture never replaces a newer one.
  capture([entry({ successfulAt: iso(-30 * MIN) })], () => null);
  assert.equal(captured(hash)?.fetchedAt, iso(0));
  forgetBuiltin();
});

test("the recorder reads the same listing in provider.usage.list's shape", () => {
  const listing = legacyListing([{ id: "smart-session:x", sourceId: "smart-session", fetchedAt: iso(-9 * MIN), report: { status: "available", windows: [] } }, entry()]);
  const sample = fromPaseoProviderUsage(listing, "claude", new Date(NOW));
  assert.equal(sample?.windows.five_hour?.pct, 30);
  assert.equal(sample?.fetchedAt, iso(-1 * MIN), "the built-in report's own time, not the oldest report's");
});

test("live bug A: deciding a card never waits on the server, the hash or a frame", () => {
  const source = readFileSync("client/usage-hide.ts", "utf8");
  const body = source.slice(source.indexOf("const decideList"), source.indexOf("const watch ="));
  assert.ok(body.length > 0);
  assert.doesNotMatch(body, /await|\.rpc\(|requestAnimationFrame|digest\(/);
});
