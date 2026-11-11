import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginClientContext } from "@getpaseo/plugin/client";

import { commandItems } from "./client/commands.ts";
import { governedPause, sessionProtection, type GuardStatus } from "./client/guard/status.ts";
import { describePill, pillVisible } from "./client/pill-view.ts";
import { PAUSED_SCREEN, SETTINGS_SCREEN } from "./client/screens.ts";
import { PauseSchema, PolicySchema, type Pause } from "./shared/guard/policy.ts";
import { pausePill, pausedLead } from "./shared/guard/presentation.ts";
import { checkTiming, timingOf } from "./shared/guard/timing.ts";

const NOW = Date.parse("2026-11-05T15:00:00Z");
const clock = (iso: string) => new Date(iso).toISOString().slice(11, 16);
const pause = (patch: Partial<Pause> = {}): Pause => PauseSchema.parse({
  id: "p", agentId: "a", provider: "claude", title: "Refactor", windowId: "five_hour", anchorResetsAt: "2026-11-05T17:58:00Z",
  pausedAt: "2026-11-05T14:30:00Z", lastUserMessageAt: null, turnId: null, phase: "waiting", note: null, settledAt: null, ...patch,
});
const status = (patch: Partial<GuardStatus> = {}): GuardStatus => ({
  governor: "active", standalone: false, checkedAt: null, error: null, pauses: [], overrides: {},
  policy: PolicySchema.parse({ enabled: true }), providers: [], ...patch,
});
const pills = { compactOn: true, pillOn: true, enrolled: new Set(["a"]), thresholds: null };
const agent = { usedTokens: 340_000, maxTokens: 1_000_000 };

test("one pill: shown for either feature, and a paused session keeps it even when pills are hidden", () => {
  assert.equal(pillVisible("a", pills, null, true), true);
  assert.equal(pillVisible("a", { ...pills, compactOn: false }, null, true), false, "nothing on, nothing to say");
  assert.equal(pillVisible("a", { ...pills, compactOn: false }, status(), true), true, "protection alone earns the pill");
  assert.equal(pillVisible("a", { ...pills, compactOn: false }, status({ policy: PolicySchema.parse({ enabled: false }) }), true), false);
  assert.equal(pillVisible("a", { ...pills, pillOn: false }, status(), true), false);
  assert.equal(pillVisible("a", pills, status(), false), false, "the display switch hides it");
  const paused = status({ pauses: [pause()] });
  assert.equal(pillVisible("a", { ...pills, pillOn: false }, paused, false), true, "a pause outlives hide the pill");
  assert.equal(pillVisible("b", { ...pills, pillOn: false }, paused, false), false, "only the paused session");
  // Another governor's pause cannot be acted on from here, so it does not hold a pill up.
  assert.equal(pillVisible("a", { ...pills, pillOn: false }, status({ governor: "deferred", pauses: [pause()] }), true), false);
});

test("the quiet case stays quiet; only an excluded session says so, in words", () => {
  const protectedTitle = describePill("a", agent, pills, status(), NOW);
  assert.equal(protectedTitle.label, "34%");
  assert.doesNotMatch(protectedTitle.title, /limit/);
  const excluded = describePill("a", agent, pills, status({ overrides: { a: false } }), NOW);
  assert.equal(excluded.label, "34%");
  assert.match(excluded.title, /not paused at the limit/);
  assert.match(describePill("a", agent, { ...pills, compactOn: false }, status(), NOW).title, /Smart Compact off/);
});

test("paused, the pill becomes the pause and leads with the moment it comes back", () => {
  const view = describePill("a", agent, pills, status({ pauses: [pause()] }), NOW);
  assert.match(view.label, /^Until /);
  assert.match(view.title, /^Held until .* · continues then$/);
  const policy = PolicySchema.parse({ enabled: true });
  assert.equal(pausePill(pause(), policy, NOW, clock).label, "Until 17:58");
  assert.equal(pausePill(pause({ idle: true }), policy, NOW, clock).title, "Held at the limit until 17:58");
  assert.equal(pausePill(pause({ lastUserMessageAt: new Date(NOW).toISOString() }), policy, NOW, clock).title, "Held until 17:58 · your message runs then");
  assert.equal(pausePill(pause({ suspension: { rootPid: 2, processes: [] } }), policy, NOW, clock).title, "Held until 17:58 · carries on in place then");
  assert.equal(pausePill(pause(), { ...policy, autoResume: false }, NOW, clock).label, "Resets 17:58");
  assert.equal(pausePill(pause({ idle: true }), { ...policy, autoResume: false }, NOW, clock).label, "Until 17:58", "an idle hold just lets go at the reset");
  assert.equal(pausePill(pause({ anchorResetsAt: "2026-11-05T14:00:00Z" }), policy, NOW, clock).label, "Reset due");
  assert.equal(pausePill(pause({ anchorResetsAt: null }), policy, NOW, clock).label, "Held");
  assert.equal(pausePill(pause({ phase: "attention" }), policy, NOW, clock).tone, "danger");
  assert.equal(pausePill(pause(), { ...policy, enabled: false }, NOW, clock).label, "On hold");
  // A clock, not a countdown: the label is the same a minute later, so the pill is not re-sent.
  assert.equal(pausePill(pause(), policy, NOW + 60_000, clock).label, pausePill(pause(), policy, NOW, clock).label);
});

test("protection for one session: default, override, and who runs it", () => {
  assert.deepEqual(sessionProtection(status(), "a"), { kind: "on", protected: true, byDefault: true, override: null, thresholdPct: 100, autoResume: true });
  assert.equal((sessionProtection(status({ overrides: { a: false } }), "a") as { protected: boolean }).protected, false);
  assert.deepEqual(sessionProtection(status({ governor: "deferred", standalone: true }), "a"), { kind: "elsewhere", standalone: true });
  assert.equal(sessionProtection(status({ governor: "off" }), "a").kind, "off");
  assert.equal(governedPause(status({ pauses: [pause({ phase: "resumed" })] }), "a"), undefined);
});

test("the overview lead says what is paused and when it comes back", () => {
  const ms = (value: number) => new Date(value).toISOString().slice(11, 16);
  assert.equal(pausedLead([], true, NOW, ms), null);
  const two = [pause(), pause({ id: "q", agentId: "b" })];
  assert.equal(pausedLead(two, true, NOW, ms)!.title, "2 sessions held until 17:58");
  assert.equal(pausedLead(two, false, NOW, ms)!.title, "2 sessions wait for the 17:58 reset");
  const stuck = pausedLead([...two, pause({ id: "r", agentId: "c", phase: "attention" })], true, NOW, ms)!;
  assert.equal(stuck.tone, "danger");
  assert.match(stuck.title, /1 needs a look/);
  assert.equal(pausedLead([pause(), pause({ id: "q", agentId: "b", anchorResetsAt: "2026-11-05T19:00:00Z" })], true, NOW, ms)!.title, "2 sessions held · next runs at 17:58");
});

test("limit timing is checked field by field, and an untouched draft saves the same values", () => {
  const policy = PolicySchema.parse({});
  const clean = checkTiming(timingOf(policy));
  assert.deepEqual(clean.errors, {});
  assert.equal(clean.values.thresholdPct, 100);
  assert.deepEqual(clean.values.windowIds, ["five_hour", "session"]);
  const bad = checkTiming({ ...timingOf(policy), thresholdPct: "0", pollSeconds: "2.5", resetGraceSeconds: "", continuation: " ", windowIds: " , " });
  assert.deepEqual(Object.keys(bad.errors).sort(), ["continuation", "pollSeconds", "resetGraceSeconds", "thresholdPct", "windowIds"]);
  assert.equal(bad.values.resumeSpacingSeconds, 5, "valid fields still parse");
});

test("Command Center: one name, the old keywords still find it, paused lands on the list", async () => {
  const items = commandItems();
  assert.deepEqual(items.map((item) => item.title), ["Smart Session", "Smart Session: settings", "Smart Session: paused sessions", "Smart Session: show or hide the pill"]);
  for (const item of items) assert.ok(String(item.title).startsWith("Smart Session"));
  const words = items.flatMap((item) => item.keywords ?? []);
  for (const word of ["quota", "limit", "pause", "resume", "guard", "session guard", "display"]) assert.ok(words.includes(word), word);
  const opened: unknown[] = [];
  const context = { openScreen: (input: unknown) => opened.push(input), openSettings: (id: string) => opened.push(id) } as never;
  await items[1]!.onSelect(context);
  await items[2]!.onSelect(context);
  assert.deepEqual(opened, [SETTINGS_SCREEN, { screenId: "overview", params: { focus: "paused" } }]);
  assert.equal(PAUSED_SCREEN, "paused-sessions", "old links to the Paused sessions screen must keep resolving");
});

test("show or hide the pill flips the one visible switch, turning the display gate back on when showing", async () => {
  const writes: unknown[] = [];
  let showPill = false;
  const rpc = (async (contract: { name: string }, input: Record<string, unknown>) => {
    if (contract.name === "smart-session.settings.get") return { settings: { showPill } };
    if (contract.name.endsWith("display.read")) return { status: "ready", revision: "1", values: { enable_composer_button: false, showSidebar: true } };
    if (contract.name.endsWith("display.write")) { writes.push(input); return { status: "saved", revision: "2", values: input.values }; }
    if (contract.name === "smart-session.settings.set") { showPill = input.showPill as boolean; return {}; }
    return { enabled: true, showPill, agents: [] };
  }) as unknown as PluginClientContext["rpc"];
  const toggle = commandItems().find((item) => item.id === "smart-session-pill")!;
  await toggle.onSelect({ rpc } as never);
  assert.equal(showPill, true);
  assert.deepEqual(writes, [{ values: { enable_composer_button: true, showSidebar: true, replaceUsageCard: true }, revision: "1" }]);
});
