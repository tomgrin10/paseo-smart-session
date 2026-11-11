import { test } from "node:test";
import assert from "node:assert/strict";
import { continuesAtReset, freezesIdle, holdKind, isLive, messageArrived, messageWaiting } from "./shared/guard/hold.ts";

test("only a session the daemon has open is live; a closed or archived one is never held", () => {
  for (const status of ["idle", "running", "initializing", "error"]) assert.equal(isLive({ status }), true, status);
  assert.equal(isLive({ status: "closed" }), false);
  assert.equal(isLive({ status: "idle", archivedAt: "2026-11-11T00:00:00Z" }), false);
});
test("how a session at the limit is held", () => {
  assert.equal(holdKind({ status: "running" }, false, false), "interrupt");
  assert.equal(holdKind({ status: "error" }, true, false), "quota");
  assert.equal(holdKind({ status: "idle" }, false, true), "background");
  assert.equal(holdKind({ status: "idle" }, false, false), "idle");
  assert.equal(holdKind({ status: "initializing" }, false, false), null, "held once it shows idle or running");
  assert.equal(holdKind({ status: "error" }, false, false), null, "an ordinary error: its next turn is held");
  assert.equal(holdKind({ status: "closed" }, true, true), null, "never a closed one");
});
test("a message is noticed by its timestamp, and waits when it came after the pause", () => {
  const pause = { pausedAt: "2026-11-11T12:00:00Z", lastUserMessageAt: "2026-11-11T11:00:00Z" };
  assert.equal(messageArrived(pause, { lastUserMessageAt: "2026-11-11T11:00:00Z" }), false);
  assert.equal(messageArrived(pause, { lastUserMessageAt: "2026-11-11T12:05:00Z" }), true);
  assert.equal(messageArrived({ lastUserMessageAt: null }, {}), false);
  assert.equal(messageWaiting(pause), false);
  assert.equal(messageWaiting({ ...pause, lastUserMessageAt: "2026-11-11T12:05:00Z" }), true);
  assert.equal(messageWaiting({ ...pause, lastUserMessageAt: null }), false);
});
test("the reset continues only what was interrupted; only Claude idles are frozen", () => {
  assert.equal(continuesAtReset({ idle: true }), false);
  assert.equal(continuesAtReset({}), true);
  assert.equal(freezesIdle("claude"), true);
  assert.equal(freezesIdle("codex"), false);
  assert.equal(freezesIdle("opencode"), false);
});
