import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTransient } from "./shared/guard/transient.ts";
import { TransientRecovery } from "./server/guard/transient.ts";
import type { Agent } from "./shared/guard/policy.ts";
import type { GuardClient } from "./server/guard/client.ts";

const matches = [
  ["Failed to authenticate. API Error: 403 Attention Required! | Cloudflare", "cloudflare"],
  ["403 <html>cf-ray: abc</html>", "cloudflare"],
  ["API Error: 500 Internal Server Error", "server"],
  ["HTTP 502 Bad Gateway", "server"],
  ["status code 503", "server"],
  ["HTTP/1.1 504 Gateway Timeout", "server"],
  ["overloaded", "overloaded"],
  ["API Error: 529", "overloaded"],
  ["ECONNRESET", "connection"],
  ["connection reset by peer", "connection"],
  ["ETIMEDOUT", "timeout"],
  ["request timed out", "timeout"],
  ["connection timeout", "timeout"],
  ["timeout", "timeout"],
  ["timed out", "timeout"],
] as const;
for (const [message, kind] of matches) test(`classifies ${message}`, () => assert.equal(classifyTransient(message), kind));
for (const message of ["401 Unauthorized", "403 Forbidden", "Failed to authenticate", "Login expired", "API Error: 429 too many requests", "usage limit reached", "quota exceeded", "rate limit: 503", "expired token: overloaded", "401 Attention Required cf-ray", "ENOENT", "", "file 500 missing", "processed 529 files", "authentication failed: timeout", "not logged in: overloaded"]) {
  test(`does not retry ${message || "empty errors"}`, () => assert.equal(classifyTransient(message), null));
}

function setup() {
  let clock = 0, enabled = true, blocked = false, acquired = 0, released = 0;
  const agents = new Map<string, Agent>();
  const sends: { id: string; at: number; text: string; messageId: string }[] = [];
  const logs: string[] = [];
  let beforeFetch: (() => void) | null = null;
  let failSend = false;
  const recovery = new TransientRecovery({
    policy: async () => enabled,
    blocked: async () => blocked,
    claim: async () => { acquired++; return async () => { released++; }; },
    now: () => clock,
    schedule: () => () => {},
    log: line => logs.push(line),
    connect: async work => work({
      fetchAgent: async id => {
        beforeFetch?.(); beforeFetch = null;
        const agent = agents.get(id); return agent ? { agent: structuredClone(agent) } : null;
      },
      sendMessage: async (id, text, options) => {
        sends.push({ id, at: clock, text, messageId: options!.messageId });
        if (failSend) throw new Error("unconfirmed delivery");
        const agent = agents.get(id)!;
        agent.status = "running"; agent.activeTurn = { turnId: `retry-${sends.length}` };
        agent.lastUserMessageAt = String(clock);
        recovery.started(id, agent.activeTurn.turnId);
      },
    } as GuardClient),
  });
  async function start(id = "a", turnId = "t1") {
    agents.set(id, { id, provider: "claude", status: "running", activeTurn: { turnId }, lastUserMessageAt: "original" });
    recovery.started(id, turnId);
    await Promise.resolve();
  }
  async function fail(id = "a", message = "API Error: 503", turnId = agents.get(id)?.activeTurn?.turnId ?? "t1") {
    const agent = agents.get(id)!;
    agent.status = "error"; agent.activeTurn = null; agent.lastError = message;
    await recovery.ended(id, turnId, { kind: "failed", error: { message } });
  }
  return { recovery, agents, sends, logs, start, fail,
    time: (value: number) => { clock = value; },
    enabled: (value: boolean) => { enabled = value; },
    blocked: (value: boolean) => { blocked = value; },
    beforeFetch: (fn: () => void) => { beforeFetch = fn; },
    failSend: () => { failSend = true; },
    locks: () => ({ acquired, released }),
  };
}

test("only observed working turns resume in place, with an id-only trace", async () => {
  const h = setup(); await h.start(); await h.fail();
  h.time(59_999); await h.recovery.tick(); assert.equal(h.sends.length, 0);
  h.time(60_000); await h.recovery.tick();
  assert.equal(h.sends.length, 1); assert.equal(h.sends[0].id, "a");
  assert.match(h.sends[0].text, /transient API error/);
  assert.match(h.logs[0], /agent=a.*class=server.*try=1/);
  assert.ok(!h.logs.join().includes("API Error: 503"));
  await h.recovery.stop(); assert.deepEqual(h.locks(), { acquired: 1, released: 1 });
});

test("backoff is 1, 3, 10 minutes and stops after three tries for one incident", async () => {
  const h = setup(); await h.start(); await h.fail();
  for (const [at, next] of [[60_000, 240_000], [240_000, 840_000], [840_000, null]] as const) {
    h.time(at); await h.recovery.tick(); await h.fail();
    assert.equal(h.recovery.nextAt, next);
  }
  h.time(10_000_000); await h.recovery.tick(); assert.equal(h.sends.length, 3);
  assert.equal(new Set(h.sends.map(s => s.messageId)).size, 3);
  await h.recovery.stop();
});

test("a failed event without a matching observed turn never wakes an agent", async () => {
  const h = setup();
  h.agents.set("a", { id: "a", provider: "claude", status: "error", lastError: "API Error: 503" });
  await h.recovery.ended("a", "old", { kind: "failed", error: { message: "API Error: 503" } });
  await h.start("b"); await h.fail("b", "API Error: 503", "wrong-turn");
  h.time(1_000_000); await h.recovery.tick();
  assert.equal(h.sends.length, 0); assert.equal(h.locks().acquired, 0);
});

for (const change of ["idle", "closed", "archived", "running", "permission", "message", "auth", "quota", "missing"] as const) {
  test(`pending recovery never wakes a session changed to ${change}`, async () => {
    const h = setup(); await h.start(); await h.fail(); const a = h.agents.get("a")!;
    if (["idle", "closed", "running"].includes(change)) a.status = change;
    if (change === "archived") a.archivedAt = "now";
    if (change === "permission") a.pendingPermissions = [{}];
    if (change === "message") a.lastUserMessageAt = "new-message";
    if (change === "auth") a.lastError = "401 Unauthorized";
    if (change === "quota") a.lastError = "usage limit reached";
    if (change === "missing") h.agents.delete("a");
    h.time(60_000); await h.recovery.tick(); assert.equal(h.sends.length, 0);
    await h.recovery.stop();
  });
}

test("burst failures are staggered by five seconds", async () => {
  const h = setup(); await h.start("a"); await h.start("b"); await h.fail("a"); await h.fail("b");
  h.time(60_000); await h.recovery.tick(); assert.deepEqual(h.sends.map(s => s.id), ["a"]);
  h.time(64_999); await h.recovery.tick(); assert.equal(h.sends.length, 1);
  h.time(65_000); await h.recovery.tick(); assert.deepEqual(h.sends.map(s => s.id), ["a", "b"]);
  await h.recovery.stop();
});

test("settings off, quota holds, and teardown cancel recovery without a send", async () => {
  for (const reason of ["off", "quota", "stop"]) {
    const h = setup(); await h.start(); await h.fail();
    if (reason === "off") { h.enabled(false); await h.recovery.settingsChanged(); }
    if (reason === "quota") h.blocked(true);
    if (reason === "stop") await h.recovery.stop();
    h.time(60_000); await h.recovery.tick(); assert.equal(h.sends.length, 0);
    await h.recovery.stop();
  }
});

test("a new turn or completion cancels the old incident; delivery uncertainty is never retried", async () => {
  const h = setup(); await h.start(); await h.fail();
  await h.start("a", "manual");
  await h.recovery.ended("a", "manual", { kind: "completed" });
  h.time(60_000); await h.recovery.tick(); assert.equal(h.sends.length, 0);
  await h.start(); await h.fail(); h.failSend(); h.time(120_000); await h.recovery.tick();
  h.time(1_000_000); await h.recovery.tick(); assert.equal(h.sends.length, 1);
  await h.recovery.stop();
});

test("in-flight observation cannot send after disable, stop, or a newer turn", async () => {
  for (const reason of ["off", "stop", "new-turn"]) {
    const h = setup(); await h.start(); await h.fail();
    h.beforeFetch(() => {
      if (reason === "off") h.enabled(false);
      if (reason === "stop") void h.recovery.stop();
      if (reason === "new-turn") h.recovery.started("a", "manual");
    });
    h.time(60_000); await h.recovery.tick(); assert.equal(h.sends.length, 0);
    await h.recovery.stop();
  }
});

test("overlapping ticks and duplicate failure events spend one attempt", async () => {
  const h = setup(); await h.start();
  await Promise.all([h.fail(), h.fail()]);
  h.time(60_000); await Promise.all([h.recovery.tick(), h.recovery.tick()]);
  assert.equal(h.sends.length, 1);
  await h.recovery.stop();
});
