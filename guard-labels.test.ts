import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./server/guard/store.ts";
import { WorkspaceLabels, PAUSED_WORKSPACE_LABEL } from "./server/guard/labels.ts";
import { PolicySchema, PauseSchema } from "./shared/guard/policy.ts";
import type { GuardClient } from "./server/guard/client.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "guard-labels-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir); let enabled = true;
  const pauses = ["a", "b"].map(id => PauseSchema.parse({ id, agentId: id, provider: "claude", title: id,
    windowId: "session", anchorResetsAt: null, pausedAt: new Date().toISOString(), lastUserMessageAt: null, turnId: null,
    phase: "waiting", note: null, settledAt: null }));
  await store.write({ version: 1, overrides: {}, pauses });
  const calls: { workspaceId: string; assigned: boolean; label: { name: string; color: string } }[] = [];
  const client = { fetchAgent: async () => ({ agent: { id: "a", provider: "claude", status: "idle", workspaceId: "w" } }),
    setWorkspaceLabel: async (options: { workspaceId: string; assigned: boolean; label: { name: string; color: string } }) => { if (options.assigned) assert.deepEqual(options.label, PAUSED_WORKSPACE_LABEL); calls.push(options); },
  } as unknown as GuardClient;
  const labels = () => new WorkspaceLabels(store, async work => work(), async work => work(client), async () => PolicySchema.parse({ workspaceLabels: enabled }));
  return { store, calls, client, labels, disable: () => { enabled = false; } };
}
test("workspace labels aggregate pauses, survive reload, and clear only after the last pause", async t => {
  const f = await fixture(t); await f.labels().refresh(); assert.equal(f.calls[0].assigned, true);
  const state = await f.store.read(); state.pauses[0].phase = "resumed"; state.pauses[0].settledAt = new Date().toISOString(); await f.store.write(state);
  await f.labels().refresh(); assert.ok(f.calls.every(call => call.assigned));
  state.pauses[1].phase = "cancelled"; state.pauses[1].settledAt = new Date().toISOString(); await f.store.write(state);
  await f.labels().refresh(); assert.equal(f.calls.at(-1)!.assigned, false);
  assert.deepEqual((await f.store.read()).labelledWorkspaces, []);
});
test("lost label acknowledgement remains journaled and is removed after restart or opt-out", async t => {
  const f = await fixture(t); let fail = true; const assign = f.client.setWorkspaceLabel!;
  f.client.setWorkspaceLabel = async options => { await assign(options); if (fail) { fail = false; throw new Error("ack lost"); } };
  const first = f.labels(); await first.refresh(); assert.ok(first.error); assert.deepEqual((await f.store.read()).labelledWorkspaces, ["w"]);
  f.disable(); const next = f.labels(); await next.refresh(); assert.equal(next.error, null); assert.equal(f.calls.at(-1)!.assigned, false);
});
test("a pause cleared during slow label assignment is reconciled before delivery ends", async t => {
  const f = await fixture(t); const assign = f.client.setWorkspaceLabel!;
  f.client.setWorkspaceLabel = async options => { await assign(options); if (options.assigned) {
    const s = await f.store.read(); for (const p of s.pauses) { p.phase = "cancelled"; p.settledAt = new Date().toISOString(); } await f.store.write(s);
  } };
  await f.labels().refresh(); assert.deepEqual(f.calls.map(c => c.assigned), [true, false]);
});

test("short-label migration removes only the previous Guard assignment and journals the new label", async t => {
  const f = await fixture(t); const s = await f.store.read();
  s.labelledWorkspaces = ["w"]; await f.store.write(s);
  await f.labels().refresh();
  assert.deepEqual(f.calls.map(c => [c.assigned, c.label.name]), [[false, "Paused by Session Guard"], [true, "Held"]]);
  assert.equal((await f.store.read()).workspaceLabelName, "Held");
});
test("the Paused label of an earlier version becomes Held: removed under its old name, then assigned again", async t => {
  const f = await fixture(t); const s = await f.store.read();
  s.labelledWorkspaces = ["w"]; s.workspaceLabelName = "Paused"; await f.store.write(s);
  await f.labels().refresh();
  assert.deepEqual(f.calls.map(c => [c.assigned, c.label.name]), [[false, "Paused"], [true, "Held"]]);
  assert.equal((await f.store.read()).workspaceLabelName, "Held");
});
test("moving a paused session keeps the other workspace paused until its final wait is cleared", async t => {
  const f = await fixture(t); await f.labels().refresh();
  f.client.fetchAgent = async id => ({ agent: { id, provider: "claude", status: "idle", workspaceId: id === "a" ? "new" : "w" } });
  await f.labels().refresh(); assert.ok(f.calls.some(c => c.assigned && c.workspaceId === "new"));
  assert.ok(!f.calls.some(c => !c.assigned && c.workspaceId === "w"));
  const s = await f.store.read(); s.pauses.find(p => p.agentId === "b")!.phase = "cancelled"; await f.store.write(s);
  await f.labels().refresh(); assert.ok(f.calls.some(c => !c.assigned && c.workspaceId === "w"));
});

test("held-background-work: a held workspace's label says why it's still held, and changes with the reason", async t => {
  const f = await fixture(t);
  f.client.setWorkspaceLabel = async options => { f.calls.push(options); };
  const s = await f.store.read();
  const wait = { since: new Date().toISOString(), jobs: [{ kind: "shell", description: "Run the test suite", command: null }], at: new Date(Date.now() + 600_000).toISOString() };
  for (const p of s.pauses) p.moveWait = { ...wait, plan: "move" };
  await f.store.write(s);
  await f.labels().refresh();
  assert.deepEqual(f.calls.map(c => [c.assigned, c.label.name, c.label.color]), [[true, "Held · moving soon", "amber"]]);
  // The reset now comes first: the old label comes off, the new one goes on.
  const later = await f.store.read();
  for (const p of later.pauses) p.moveWait = { ...wait, plan: "reset" };
  await f.store.write(later);
  await f.labels().refresh();
  assert.deepEqual(f.calls.slice(1).map(c => [c.assigned, c.label.name]), [[false, "Held · moving soon"], [true, "Held · until reset"]]);
  // Two holds in one workspace that say different things: plain Held.
  const mixed = await f.store.read();
  mixed.pauses[0]!.moveWait = { ...wait, plan: "jobs", at: null, why: "setting" };
  await f.store.write(mixed);
  await f.labels().refresh();
  assert.deepEqual(f.calls.slice(3).map(c => [c.assigned, c.label.name]), [[false, "Held · until reset"], [true, "Held"]]);
  assert.deepEqual((await f.store.read()).workspaceLabelNames, { w: "Held" });
});

// row-badges: on a Paseo that draws row badges (0.17.1+, read from the daemon's `server_info`), the held badge says
// what the label said, with a time, so the label comes off: only ours (`labelledWorkspaces`), never another's.
const onHost = (client: GuardClient, version: string | null | undefined) => {
  (client as GuardClient & { getLastServerInfoMessage(): unknown }).getLastServerInfoMessage = () => (version === undefined ? null : { status: "server_info", serverId: "s", version });
};
test("row-badges: a badge host gets no held label, and the label we assigned before comes off", async t => {
  const f = await fixture(t); onHost(f.client, "0.17.4");
  const s = await f.store.read(); s.labelledWorkspaces = ["w"]; s.workspaceLabelNames = { w: "Held" }; await f.store.write(s);
  await f.labels().refresh();
  assert.deepEqual(f.calls.map(c => [c.workspaceId, c.assigned, c.label.name]), [["w", false, "Held"]]);
  assert.deepEqual((await f.store.read()).labelledWorkspaces, []);
  await f.labels().refresh();
  assert.equal(f.calls.length, 1, "nothing goes back on");
});
test("row-badges: a label someone else gave a workspace is never touched", async t => {
  const f = await fixture(t); onHost(f.client, "0.17.4");
  // Workspace "x" carries a Held label we never journaled (another plugin's, or the person's own).
  await f.labels().refresh();
  assert.deepEqual(f.calls, [], "no label goes on and none comes off");
});
test("row-badges: an older host, or one that doesn't say its version, keeps the label", async t => {
  for (const version of ["0.17.0", "0.16.3", "0.17.1-beta.2", null, undefined]) {
    const f = await fixture(t); onHost(f.client, version);
    await f.labels().refresh();
    assert.deepEqual(f.calls.map(c => [c.assigned, c.label.name]), [[true, "Held"]], String(version));
  }
  const f = await fixture(t); // a client with no server info at all (Paseo 0.14's typed slice)
  await f.labels().refresh();
  assert.deepEqual(f.calls.map(c => [c.assigned, c.label.name]), [[true, "Held"]]);
});
test("row-badges: with nothing held and nothing labelled, the host isn't asked", async t => {
  const f = await fixture(t); let asked = 0;
  (f.client as GuardClient & { getLastServerInfoMessage(): unknown }).getLastServerInfoMessage = () => { asked++; return { version: "0.17.4" }; };
  const s = await f.store.read(); for (const p of s.pauses) { p.phase = "cancelled"; p.settledAt = new Date().toISOString(); } await f.store.write(s);
  await f.labels().refresh();
  assert.equal(asked, 0); assert.deepEqual(f.calls, []);
});
