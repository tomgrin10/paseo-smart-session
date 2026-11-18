/**
 * one-held-daemon-connection: every daemon call in this process shares one held
 * connection, reopened only after a real drop. Before this, `withDaemon` opened a
 * WebSocket per call: about 13-17 hellos a minute in the daemon log.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { sharedDaemon, withDaemon, closeDaemon, type DaemonClient } from "./server/daemon.ts";

type Status = { status: string };

class FakeClient {
  static built = 0;
  static closed = 0;
  state: Status = { status: "idle" };
  listeners = new Set<(s: Status) => void>();
  constructor(_options: unknown) {
    FakeClient.built++;
  }
  async connect() {
    this.set("connected");
  }
  async close() {
    FakeClient.closed++;
    this.set("disposed");
  }
  set(status: string) {
    this.state = { status };
    for (const l of this.listeners) l(this.state);
  }
  getConnectionState() {
    return this.state;
  }
  subscribeConnectionStatus(listener: (s: Status) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async fetchAgents() {
    return { entries: [] };
  }
}

function fakes() {
  const made: FakeClient[] = [];
  const open = async () => {
    const c = new FakeClient({});
    await c.connect();
    made.push(c);
    return c as unknown as DaemonClient;
  };
  return { made, open };
}

test("N withDaemon calls open one daemon connection, closed by closeDaemon", async () => {
  // daemon.ts borrows the host's client through the bare `require`; stand in for it.
  const g = globalThis as { require?: unknown };
  const saved = g.require;
  process.env.PASEO_DAEMON_URL = "ws://127.0.0.1:1/ws";
  process.env.PASEO_PASSWORD = "test-only";
  g.require = () => ({ DaemonClient: FakeClient });
  FakeClient.built = 0;
  FakeClient.closed = 0;
  try {
    for (let i = 0; i < 10; i++) await withDaemon((client) => client.fetchAgents());
    await Promise.all(Array.from({ length: 10 }, () => withDaemon((client) => client.fetchAgents())));
    assert.equal(FakeClient.built, 1, "20 calls should share one connection");
    assert.equal(FakeClient.closed, 0, "the connection is held between calls");
    await closeDaemon();
    assert.equal(FakeClient.closed, 1);
    await assert.rejects(withDaemon((client) => client.fetchAgents()), /stopping/);
    assert.equal(FakeClient.built, 1, "nothing opens after teardown");
  } finally {
    g.require = saved;
  }
});

test("concurrent first calls join one open", async () => {
  const { made, open } = fakes();
  const daemon = sharedDaemon(open);
  await Promise.all(Array.from({ length: 5 }, () => daemon.run(async () => 1)));
  assert.equal(made.length, 1);
  await daemon.close();
});

test("a real drop retires the connection and the next call opens one fresh one", async () => {
  const { made, open } = fakes();
  const daemon = sharedDaemon(open);
  await daemon.run(async () => 1);
  made[0].set("disconnected");
  await daemon.run(async () => 1);
  await daemon.run(async () => 1);
  assert.equal(made.length, 2);
  await daemon.close();
});

test("a call that fails on a dead socket retires it; one that fails on a live one does not", async () => {
  const { made, open } = fakes();
  const daemon = sharedDaemon(open);
  await assert.rejects(daemon.run(async () => { throw new Error("bad request"); }));
  await daemon.run(async () => 1);
  assert.equal(made.length, 1, "an RPC error on a live socket keeps it");
  await assert.rejects(daemon.run(async () => { made[0].state = { status: "disconnected" }; throw new Error("socket gone"); }));
  await daemon.run(async () => 1);
  assert.equal(made.length, 2);
  await daemon.close();
});

test("a failed open backs off: calls in the window fail fast without opening", async () => {
  let t = 0;
  let attempts = 0;
  let up = false;
  const daemon = sharedDaemon(async () => {
    attempts++;
    if (!up) throw new Error("daemon down");
    const c = new FakeClient({});
    await c.connect();
    return c as unknown as DaemonClient;
  }, { now: () => t, backoffMs: 1_000, backoffMaxMs: 4_000 });
  await assert.rejects(daemon.run(async () => 1), /daemon down/);
  await assert.rejects(daemon.run(async () => 1), /daemon down/);
  assert.equal(attempts, 1, "inside the backoff no new open");
  t = 1_000;
  await assert.rejects(daemon.run(async () => 1));
  assert.equal(attempts, 2);
  t = 2_500;
  await assert.rejects(daemon.run(async () => 1));
  assert.equal(attempts, 2, "the backoff doubled to 2 s");
  up = true;
  t = 3_000;
  await daemon.run(async () => 1);
  await daemon.run(async () => 1);
  assert.equal(attempts, 3);
  await daemon.close();
});

test("a connection older than maxMs is replaced, after its in-flight call", async () => {
  let t = 0;
  const { made, open } = fakes();
  const daemon = sharedDaemon(open, { now: () => t, maxMs: 1_000 });
  let release!: () => void;
  const slow = daemon.run(() => new Promise<void>((r) => { release = r; }));
  await new Promise((r) => setImmediate(r));
  t = 1_000;
  await daemon.run(async () => 1);
  assert.equal(made.length, 2);
  assert.equal(made[0].state.status, "connected", "the old one stays open for its last call");
  release();
  await slow;
  await new Promise((r) => setImmediate(r));
  assert.equal(made[0].state.status, "disposed");
  await daemon.close();
  assert.equal(made[1].state.status, "disposed");
});
