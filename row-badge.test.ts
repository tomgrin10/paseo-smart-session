import { test } from "node:test";
import assert from "node:assert/strict";

import { PauseSchema, type Pause } from "./shared/guard/policy.ts";
import { accountBadge, heldBadge, supportsRowBadges, type AccountsReading } from "./shared/guard/row-badge.ts";

const NOW = Date.parse("2026-11-05T15:00:00Z");
const clock = (iso: string) => new Date(iso).toISOString().slice(11, 16);
const pause = (patch: Partial<Pause> = {}): Pause => PauseSchema.parse({
  id: "p", agentId: "a", provider: "claude", title: "Refactor", windowId: "five_hour", anchorResetsAt: "2026-11-05T17:58:00Z",
  pausedAt: "2026-11-05T14:30:00Z", lastUserMessageAt: null, turnId: null, phase: "waiting", note: null, settledAt: null, ...patch,
});
const jobs = [{ kind: "shell" as const, description: "Run the test suite", command: null }];

test("row-badges: supportsRowBadges reads the daemon version, 0.17.1 and up", () => {
  for (const yes of ["0.17.1", "0.17.4", "v0.17.4", "0.18.0", "1.0.0", "0.17.2-beta.1"]) assert.equal(supportsRowBadges(yes), true, yes);
  for (const no of ["0.17.0", "0.16.9", "0.14.0", "0.17.1-beta.3", "", "dev", null, undefined]) assert.equal(supportsRowBadges(no), false, String(no));
});

test("row-badges: nothing held, no badge; settled holds don't count", () => {
  assert.equal(heldBadge([], NOW, clock), null);
  assert.equal(heldBadge([pause({ phase: "resumed" }), pause({ phase: "cancelled" })], NOW, clock), null);
});

test("row-badges: one hold says when it ends, in the words of the held states", () => {
  const one = (patch: Partial<Pause>) => heldBadge([pause(patch)], NOW, clock)!;
  assert.deepEqual(one({}), { label: "Held · 17:58", tone: "warning", accessibilityLabel: "Session Guard holds a session in this workspace at the usage limit: until 17:58" });
  // The closest reset on any account, as everywhere else (`heldUntil`).
  assert.equal(one({ nextRoomAt: "2026-11-05T16:10:00Z", resetAccount: "Account 2" }).label, "Held · 16:10");
  assert.match(one({ nextRoomAt: "2026-11-05T16:10:00Z", resetAccount: "Account 2" }).accessibilityLabel, /until 16:10, then it moves to Account 2$/);
  assert.equal(one({ anchorResetsAt: null }).label, "Held");
  assert.equal(one({ anchorResetsAt: "2026-11-05T14:00:00Z" }).label, "Held · reset due");
  assert.equal(one({ demo: true }).label, "Held · test");
  assert.equal(one({ phase: "resuming" }).label, "Held · continuing");
});

test("row-badges: held-background-work plans carry their time, which a label never could", () => {
  const since = "2026-11-05T14:50:00Z";
  const move = heldBadge([pause({ moveWait: { since, jobs, plan: "move", at: "2026-11-05T15:06:00Z" } })], NOW, clock)!;
  assert.equal(move.label, "Held · moves 15:06");
  assert.match(move.accessibilityLabel, /: moves at 15:06 unless its background job .*Run the test suite.* ends first$/);
  assert.equal(heldBadge([pause({ moveWait: { since, jobs, plan: "move", at: "2026-11-05T14:58:00Z" } })], NOW, clock)!.label, "Held · moving soon");
  assert.equal(heldBadge([pause({ moveWait: { since, jobs, plan: "reset", at: "2026-11-05T15:09:00Z" } })], NOW, clock)!.label, "Held · 15:09");
  assert.equal(heldBadge([pause({ moveWait: { since, jobs, plan: "jobs", at: null, why: "pinned" } })], NOW, clock)!.label, "Held · until its jobs end");
});

test("row-badges: several holds say how many and the first to end", () => {
  const view = heldBadge([
    pause({ id: "1", agentId: "a" }),
    pause({ id: "2", agentId: "b", moveWait: { since: "2026-11-05T14:50:00Z", jobs, plan: "move", at: "2026-11-05T15:06:00Z" } }),
    pause({ id: "3", agentId: "c", phase: "resumed" }),
  ], NOW, clock)!;
  assert.deepEqual(view, { label: "2 held · 15:06", tone: "warning", accessibilityLabel: "Session Guard holds 2 sessions in this workspace at the usage limit; the first is due 15:06" });
  assert.equal(heldBadge([pause({ id: "1", anchorResetsAt: null }), pause({ id: "2", anchorResetsAt: null })], NOW, clock)!.label, "2 held");
});

test("row-badges: a hold that changed while held turns the badge red, as on the pill", () => {
  assert.deepEqual(heldBadge([pause({ phase: "attention" })], NOW, clock), {
    label: "Check session", tone: "danger", accessibilityLabel: "Session Guard holds a session in this workspace at the usage limit. One changed while held and needs a look",
  });
  assert.equal(heldBadge([pause({ id: "1", phase: "attention" }), pause({ id: "2" })], NOW, clock)!.label, "2 held · check 1");
  assert.equal(heldBadge([pause({ id: "1", phase: "attention" }), pause({ id: "2", phase: "attention" })], NOW, clock)!.label, "Check 2 sessions");
});

const subs = (patch: Partial<AccountsReading> = {}): AccountsReading => ({
  zerosub: true,
  accounts: [{ id: "claude-main", name: "Main" }, { id: "claude-bob01", name: "Account 2" }, { id: "claude-carol", name: "Carol's seat" }],
  agents: { a: "claude-main", b: "claude-bob01", c: "claude-main" },
  ...patch,
});

test("row-badges: the account badge names the one account, or counts them", () => {
  assert.deepEqual(accountBadge(subs(), ["a"]), { label: "Main", tone: "muted", accessibilityLabel: "This workspace's session runs on Main" });
  assert.equal(accountBadge(subs(), ["a", "c"])!.label, "Main");
  assert.deepEqual(accountBadge(subs(), ["a", "b"]), { label: "2 accounts", tone: "muted", accessibilityLabel: "This workspace's sessions run on Main and Account 2" });
  assert.equal(accountBadge(subs({ agents: { a: "claude-carol" } }), ["a"])!.label, "Carol's seat");
});

test("row-badges: no account badge without ZeroSub, with one account, or with no session on a known account", () => {
  assert.equal(accountBadge(null, ["a"]), null);
  assert.equal(accountBadge(subs({ zerosub: false }), ["a"]), null);
  assert.equal(accountBadge(subs({ accounts: [{ id: "claude-main", name: "Main" }] }), ["a"]), null);
  assert.equal(accountBadge(subs(), []), null);
  assert.equal(accountBadge(subs(), ["unknown"]), null);
  assert.equal(accountBadge(subs({ agents: { a: "claude-gone" } }), ["a"]), null);
});
