import { test } from "node:test";
import assert from "node:assert/strict";
import { PauseSchema, PolicySchema } from "./shared/guard/policy.ts";
import { agentGuardSummary, callerProtection, governorNotice, pauseOwnerNote, pausedSessions, pausePresentation } from "./shared/guard/presentation.ts";
import { timelinePresentation, type TimelineData } from "./shared/guard/timeline.ts";
import { timelinePublisher } from "./server/guard/timeline.ts";
import type { PaseoApi } from "@getpaseo/client";

const pause = PauseSchema.parse({ id: "p", agentId: "a", provider: "claude", title: "Review branch", windowId: "five_hour", anchorResetsAt: "2026-10-06T18:00:00Z", pausedAt: "2026-10-06T15:00:00Z", lastUserMessageAt: null, turnId: "t", phase: "waiting", note: null, settledAt: null });
test("overview includes every pending session, prioritizes attention, sorts resets, and filters", () => {
  const pauses = [pause, { ...pause, id: "done", phase: "resumed" as const }, { ...pause, id: "unknown", anchorResetsAt: null }, { ...pause, id: "early", anchorResetsAt: "2026-10-06T16:00:00Z" }, { ...pause, id: "check", phase: "attention" as const, provider: "codex" }];
  assert.deepEqual(pausedSessions(pauses).map(p => p.id), ["check", "early", "p", "unknown"]);
  assert.deepEqual(pausedSessions(pauses, "codex").map(p => p.id), ["check"]);
  assert.equal(pausedSessions(pauses, "nothing").length, 0);
});
test("overview distinguishes due resets, held continuations, and native manual release", () => {
  const policy = PolicySchema.parse({ enabled: true });
  assert.match(pausePresentation(pause, policy, Date.parse("2026-10-06T18:30:00Z")).resetLabel, /waiting for fresh usage/);
  assert.match(pausePresentation(pause, { ...policy, enabled: false }).state, /on hold/);
  const native = { ...pause, suspension: { rootPid: 1234, processes: [{ pid: 1234, startTime: "11" }] } };
  assert.equal(pausePresentation(native, { ...policy, autoResume: false }).actionLabel, "Release and turn off");
  assert.match(pausePresentation(native, policy).coverage, /native subagents/);
  assert.equal(pausePresentation({ ...pause, phase: "attention" }, policy).coverage, "Check session state");
});
const data: TimelineData = { pauseId: "p", event: "paused", at: pause.pausedAt, provider: "claude", native: true, autoResume: true, resetAt: pause.anchorResetsAt, usedPct: 100, note: null };
test("timeline language states actual pause coverage, quota/reset, and distinct recovery outcomes", () => {
  const paused = timelinePresentation(data);
  assert.equal(paused.title, "Held at the session limit"); assert.match(paused.detail, /100%/); assert.match(paused.detail, /native subagents/); assert.match(paused.detail, /Expected reset/);
  assert.match(timelinePresentation({ ...data, autoResume: false }).detail, /continue manually/);
  assert.equal(timelinePresentation({ ...data, event: "resumed" }).title, "Session resumed");
  assert.equal(timelinePresentation({ ...data, event: "released", native: false }).title, "Automatic resume cancelled");
  assert.equal(timelinePresentation({ ...data, event: "attention" }).title, "Pause needs attention");
});
test("publisher reconciles a lost append acknowledgement by ID before retrying", async () => {
  const entries: { item: { type: string; id: string }; timestamp: string }[] = [];
  let appends = 0, checks = 0, lose = true;
  const api = { agents: { ref: () => ({ timeline: {
    append: async (item: { id: string }) => { appends++; entries.push({ item: { type: "plugin", id: item.id }, timestamp: data.at }); if (lose) { lose = false; throw new Error("lost ack"); } },
    refetch: async () => { checks++; return { error: null, staleCursor: false, entries, hasOlder: false, startCursor: null }; },
  } }) } } as unknown as PaseoApi;
  const publish = timelinePublisher(async () => api);
  const notification = { id: "unique-pause", delivery: "sending" as const, data };
  await assert.rejects(() => publish("a", notification, false));
  await publish("a", notification, true); assert.equal(appends, 1); assert.equal(checks, 1);
  await publish("a", { ...notification, id: "new-id" }, true); assert.equal(appends, 2);
});
test("dismissal history states no message was sent and distinguishes existing native work", () => {
  for (const native of [true, false]) {
    const dismissed = timelinePresentation({ ...data, event: "released", dismissed: true, native });
    assert.equal(dismissed.title, "Pause dismissed"); assert.match(dismissed.detail, /No message was sent/);
    assert.match(dismissed.detail, /Protection is off/); assert.equal(dismissed.detail.includes("current work may continue"), native);
  }
});

test("a disabled host policy cannot claim that a session override protects work", () => {
  assert.deepEqual(callerProtection(false, true, true), { enabled: false, protected: false, override: true });
  assert.equal(callerProtection(true, true, false).protected, false);
  assert.equal(callerProtection(true, false, true).protected, true);
});
test("an agent is told what will happen at the limit, and never offered a way round it", () => {
  const base = { governor: "active" as const, protected: true, thresholdPct: 100, autoResume: true, pauses: [] };
  assert.match(agentGuardSummary(base)[0], /continues it in this same conversation/);
  assert.match(agentGuardSummary({ ...base, autoResume: false })[0], /a person continues it/);
  assert.match(agentGuardSummary({ ...base, protected: false })[0], /off for this session/);
  assert.match(agentGuardSummary({ ...base, governor: "off" })[0], /off for this session/);
  assert.match(agentGuardSummary({ ...base, governor: "deferred" })[0], /another plugin/);
  assert.match(agentGuardSummary({ ...base, pauses: [{ phase: "resumed", resetsAt: null }] })[0], /^Session Guard: on/);
  assert.match(agentGuardSummary({ ...base, pauses: [{ phase: "waiting", resetsAt: "2026-10-06T18:00:00Z" }] })[0], /held .* resets 2026-10-06T18:00:00Z/);
});

test("views say why nothing is paused from here, and whose pauses the shared list shows", () => {
  const view = (governor: "off" | "active" | "deferred" | "error", standalone: boolean | null = null, error: string | null = null) => ({ governor, standalone, error });
  assert.equal(governorNotice(view("active")), null);
  assert.equal(pauseOwnerNote(view("active")), null, "the governor can act on its own pauses");
  assert.match(governorNotice(view("off"))!.title, /off/);
  assert.match(pauseOwnerNote(view("off"))!, /saved by the standalone/i);
  assert.match(governorNotice(view("deferred", true, "Disable or uninstall Session Guard to hand over."))!.title, /standalone/);
  assert.match(pauseOwnerNote(view("deferred", true))!, /standalone Session Guard plugin; change it there/);
  assert.match(governorNotice(view("deferred", false))!.title, /Another process/);
  assert.match(pauseOwnerNote(view("error"))!, /can.t be changed/);
  // The feature has one name in the UI; the standalone plugin keeps its own.
  for (const status of [view("off"), view("error"), view("deferred", false)]) assert.doesNotMatch(governorNotice(status)!.title, /Session Guard/);
});
