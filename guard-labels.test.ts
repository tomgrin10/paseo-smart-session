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
  assert.deepEqual(f.calls.map(c => [c.assigned, c.label.name]), [[false, "Paused by Session Guard"], [true, "Paused"]]);
  assert.equal((await f.store.read()).workspaceLabelName, "Paused");
});
test("moving a paused session keeps the other workspace paused until its final wait is cleared", async t => {
  const f = await fixture(t); await f.labels().refresh();
  f.client.fetchAgent = async id => ({ agent: { id, provider: "claude", status: "idle", workspaceId: id === "a" ? "new" : "w" } });
  await f.labels().refresh(); assert.ok(f.calls.some(c => c.assigned && c.workspaceId === "new"));
  assert.ok(!f.calls.some(c => !c.assigned && c.workspaceId === "w"));
  const s = await f.store.read(); s.pauses.find(p => p.agentId === "b")!.phase = "cancelled"; await f.store.write(s);
  await f.labels().refresh(); assert.ok(f.calls.some(c => !c.assigned && c.workspaceId === "w"));
});
