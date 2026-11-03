import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./server/guard/engine.ts";
import { Store } from "./server/guard/store.ts";
import { withRecordedUsage } from "./server/guard/usage.ts";
import type { GuardClient } from "./server/guard/client.ts";
import { PolicySchema, type Agent, type Usage } from "./shared/guard/policy.ts";
import type { UsageSample } from "./shared/usage.ts";

const base = Date.parse("2026-10-06T10:00:00Z");
const end = base + 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const paseo = (at: number, pct: number, resetsAt = end): Usage => ({
  fetchedAt: iso(at),
  providers: [
    { providerId: "claude", status: "available", fetchedAt: iso(at), windows: [{ id: "five_hour", usedPct: pct, resetsAt: iso(resetsAt) }, { id: "weekly", usedPct: 40, resetsAt: null }] },
    { providerId: "codex", status: "available", fetchedAt: iso(at), windows: [{ id: "session", usedPct: 10, resetsAt: null }] },
  ],
});
const recorded = (at: number, pct: number, resetsAt = end, src: UsageSample["src"] = "upstream"): UsageSample => ({
  at: iso(at), fetchedAt: iso(at), src, account: null, credits: null,
  windows: { five_hour: { pct, resetsAt: iso(resetsAt) }, seven_day: { pct: 41, resetsAt: null } },
});

test("a newer recorder reading replaces Paseo's cached Claude windows, under Paseo's window ids", () => {
  const merged = withRecordedUsage(paseo(base, 99), recorded(base + 60_000, 100));
  const claude = merged.providers.find(p => p.providerId === "claude")!;
  assert.equal(claude.fetchedAt, iso(base + 60_000));
  assert.deepEqual(claude.windows.map(w => [w.id, w.usedPct]), [["five_hour", 100], ["weekly", 41]]);
  assert.deepEqual(merged.providers.find(p => p.providerId === "codex"), paseo(base, 99).providers[1], "other providers are Paseo's alone");
});

test("an older, undated or missing recorder reading leaves Paseo's report alone", () => {
  const report = paseo(base + 60_000, 99);
  assert.equal(withRecordedUsage(report, recorded(base, 100)), report);
  assert.equal(withRecordedUsage(report, { ...recorded(base + 120_000, 100), fetchedAt: null, src: "statusline" }), report);
  assert.equal(withRecordedUsage(report, null), report);
});

test("a fresh recorder reading stands in when Paseo cannot report Claude at all", () => {
  const report: Usage = { fetchedAt: iso(base), providers: [{ providerId: "claude", status: "error", windows: [] }] };
  const claude = withRecordedUsage(report, recorded(base + 60_000, 100)).providers[0];
  assert.equal(claude.status, "available");
  assert.deepEqual(claude.windows.map(w => [w.id, w.usedPct]), [["five_hour", 100], ["seven_day", 41]]);
});

test("the recorder's fresher reading releases a pause before Paseo's cache catches up", async t => {
  const dir = await mkdtemp(join(tmpdir(), "guard-usage-")); t.after(() => rm(dir, { recursive: true, force: true }));
  let now = base;
  let latest: UsageSample | null = null;
  const agent: Agent = { id: "a", provider: "claude", status: "running", title: "Task", workspaceId: "w", lastUserMessageAt: iso(base - 1000), activeTurn: { turnId: "t1" } };
  const sent: string[] = [];
  // Paseo keeps serving the reading from before the reset: 100%, fetched at the start.
  const client: GuardClient = {
    fetchAgents: async () => ({ entries: [{ agent: { ...agent } }] }),
    fetchAgent: async () => ({ agent: { ...agent } }),
    listProviderUsage: async () => paseo(base, 100),
    cancelAgent: async () => { agent.status = "idle"; agent.activeTurn = null; },
    sendMessage: async id => { sent.push(id); agent.status = "running"; agent.lastUserMessageAt = iso(now); agent.activeTurn = { turnId: "continued" }; },
  };
  const engine = new Engine(new Store(dir), async () => PolicySchema.parse({ enabled: true }), async work => work(client), () => now, undefined, undefined,
    async c => withRecordedUsage(await c.listProviderUsage(), latest));
  await engine.tick();
  assert.equal(agent.status, "idle", "paused at 100%");
  now = end + 31_000;
  await engine.tick();
  assert.deepEqual(sent, [], "Paseo's stale 100% alone holds the pause");
  latest = recorded(now - 1000, 2, end + 5 * 3600_000);
  await engine.tick();
  assert.deepEqual(sent, ["a"], "the recorder's post-reset reading continues it once");
});
