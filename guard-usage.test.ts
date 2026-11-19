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

// Paseo 0.16 lists one built-in Claude report per login, every one as `claude` ("Claude (<email>)").
// The guard took the first, so a main session could be held or released on a seat's numbers.
const sha = (s: string) => `h:${s}`;
const listing = (first: "seat" | "main"): Usage => {
  const seat = { providerId: "claude", displayName: "Claude (bob@example.com)", status: "available", windows: [{ id: "five_hour", usedPct: 97, resetsAt: iso(end) }] };
  const main = { providerId: "claude", displayName: "Claude (alice@example.com)", status: "available", windows: [{ id: "five_hour", usedPct: 12, resetsAt: iso(end) }] };
  return { fetchedAt: iso(base), providers: first === "seat" ? [seat, main, paseo(base, 0).providers[1]!] : [main, seat, paseo(base, 0).providers[1]!] };
};

test("the guard reads the CLI login's Claude report, never a seat's listed before it", async () => {
  const { cliOnlyUsage } = await import("./server/guard/usage.ts");
  for (const first of ["seat", "main"] as const) {
    const usage = cliOnlyUsage(listing(first), sha("alice@example.com"), sha);
    const claude = usage.providers.filter(p => p.providerId === "claude");
    assert.equal(claude.length, 1, first);
    assert.equal(claude[0]!.windows[0]!.usedPct, 12, first);
    assert.ok(usage.providers.some(p => p.providerId === "codex"), "other providers stay");
  }
});

test("with no login to match, several Claude reports read as none, and the recorder fills in", async () => {
  const { cliOnlyUsage } = await import("./server/guard/usage.ts");
  const usage = cliOnlyUsage(listing("seat"), null, sha);
  assert.equal(usage.providers.filter(p => p.providerId === "claude").length, 0);
  const merged = withRecordedUsage(usage, recorded(base + 60_000, 33));
  assert.equal(merged.providers.find(p => p.providerId === "claude")!.windows.find(w => w.id === "five_hour")!.usedPct, 33);
  // One report, and it names a seat's login: not the CLI login's either.
  const lone: Usage = { fetchedAt: iso(base), providers: [listing("seat").providers[0]!] };
  assert.equal(cliOnlyUsage(lone, sha("alice@example.com"), sha).providers.length, 0);
  // One report without a login (pre-0.16): it is the CLI login's.
  assert.equal(cliOnlyUsage(paseo(base, 50), sha("alice@example.com"), sha).providers.length, 2);
});
