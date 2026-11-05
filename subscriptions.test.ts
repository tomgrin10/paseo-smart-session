import { test } from "node:test";
import assert from "node:assert/strict";

import {
  atTheLimit, leadPool, poolForecast, poolHeadline, poolTrailing, roomLeft, subscriptionName, subscriptionState, type Subscription,
} from "./shared/subscriptions.ts";

const NOW = Date.parse("2026-11-05T15:00:00Z");
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const clock = (ms: number) => iso(ms).slice(11, 16);

function account(id: string, patch: Partial<Subscription> & { p5?: number; r5?: number | null; rate?: number | null; week?: number; wr?: number } = {}): Subscription {
  const { p5 = 20, r5 = NOW + 3 * H, rate = null, week = 30, wr = NOW + 4 * 24 * H, ...rest } = patch;
  return {
    id, family: "claude", kind: id === "claude-main" ? "main" : "managed", name: id, named: true, isDefault: false,
    signedIn: true, disabled: false, limitedUntil: null, createdAt: iso(NOW - 30 * 24 * H), agents: 0, readAt: iso(NOW - 60_000),
    windows: [
      { id: "five_hour", pct: p5, resetsAt: r5 === null ? null : iso(r5), burnPctPerHour: rate },
      { id: "seven_day", pct: week, resetsAt: iso(wr), burnPctPerHour: null },
    ],
    credits: null,
    ...rest,
  };
}

test("names: the person's own, else a neutral one; never an email", () => {
  const all = [
    { id: "claude-main", family: "claude" as const, kind: "main" as const, label: null, createdAt: iso(NOW - 3 * H) },
    { id: "b", family: "claude" as const, kind: "managed" as const, label: null, createdAt: iso(NOW - 2 * H) },
    { id: "c", family: "claude" as const, kind: "managed" as const, label: "Personal", createdAt: iso(NOW - H) },
  ];
  assert.deepEqual(subscriptionName(all[0]!, all), { name: "CLI login", named: false });
  assert.deepEqual(subscriptionName(all[1]!, all), { name: "Account 2", named: false });
  assert.deepEqual(subscriptionName(all[2]!, all), { name: "Personal", named: true });
});

test("state chip: room, the limit with its end, set aside, signed out, stale age", () => {
  assert.equal(subscriptionState(account("a"), NOW).kind, "room");
  const full = subscriptionState(account("a", { p5: 100, r5: NOW + 2 * H }), NOW);
  assert.equal(full.kind, "limit");
  assert.equal(full.until, NOW + 2 * H);
  assert.equal(subscriptionState(account("a", { limitedUntil: iso(NOW + H) }), NOW).until, NOW + H);
  assert.equal(subscriptionState(account("a", { disabled: true }), NOW).label, "Set aside");
  assert.equal(subscriptionState(account("a", { signedIn: false }), NOW).label, "Signed out");
  assert.equal(subscriptionState(account("a", { readAt: iso(NOW - 25 * 60_000) }), NOW).staleMs, null, "25 minutes is still ZeroSub's normal refresh");
  assert.equal(subscriptionState(account("a", { readAt: iso(NOW - 45 * 60_000) }), NOW).staleMs, 45 * 60_000);
  // A full window whose reset has passed is not a limit any more.
  assert.equal(subscriptionState(account("a", { p5: 100, r5: NOW - 60_000 }), NOW).kind, "room");
  assert.equal(roomLeft(account("a", { p5: 40, week: 70 }), NOW), 30, "room is the tightest window's");
});

test("pool: the work moves to the account with the most room, in ZeroSub's order", () => {
  const accounts = [
    account("claude-main", { p5: 80, rate: 20, agents: 2 }),
    account("work", { p5: 50 }),
    account("personal", { p5: 10, createdAt: iso(NOW - H) }),
  ];
  const pool = poolForecast(accounts, "claude", NOW, { autoSwitch: true });
  assert.equal(pool.current, "claude-main");
  assert.equal(pool.pace, 20);
  // 80 → 100 at 20%/h: one hour. Then the least-used account, Personal at 10%.
  assert.equal(pool.takeovers[0]!.accountId, "personal");
  assert.ok(Math.abs(pool.takeovers[0]!.at - (NOW + H)) <= 60_000);
  // Personal 10 → 100 takes 4.5 h; then Work at 50 for 2.5 h. The main account reset at +3 h,
  // so it has room again and is the least used.
  assert.equal(pool.takeovers[1]!.accountId, "claude-main");
  assert.equal(pool.withRoom, 3);
});

test("pool: ties go to the default account, then the CLI login", () => {
  const accounts = [
    account("claude-main", { p5: 100, r5: NOW + 4 * H, rate: 10, agents: 1 }),
    account("a", { p5: 30 }),
    account("b", { p5: 30, isDefault: true }),
  ];
  const pool = poolForecast(accounts, "claude", NOW, { autoSwitch: true });
  assert.equal(pool.current, "b", "the work in use is at the limit, so ZeroSub moves it now: to the default on a tie");
});

test("pool: runs dry when every account is full, and says when the first is back", () => {
  const accounts = [
    account("claude-main", { p5: 90, r5: NOW + 4 * H, rate: 30, agents: 1 }),
    account("work", { p5: 85, r5: NOW + 2 * H }),
  ];
  const pool = poolForecast(accounts, "claude", NOW, { autoSwitch: true });
  // main 90 → 100 in 20 min; work 85 → 100 in 30 more.
  assert.ok(pool.runsOutAt !== null && Math.abs(pool.runsOutAt - (NOW + 50 * 60_000)) <= 2 * 60_000, clock(pool.runsOutAt ?? 0));
  assert.equal(pool.backAccount, "work");
  assert.ok(Math.abs(pool.backAt! - (NOW + 2 * H)) <= 60_000);
  const head = poolHeadline(pool, accounts, NOW);
  assert.match(head.title, /last until about/);
  assert.equal(head.tone, "warning");
  assert.match(poolTrailing(pool, NOW).label, /^out /);
});

test("pool: all at the limit now leads with the first one back", () => {
  const accounts = [
    account("claude-main", { p5: 100, r5: NOW + 3 * H }),
    account("work", { p5: 40, limitedUntil: iso(NOW + 90 * 60_000), name: "Work" }),
  ];
  const pool = poolForecast(accounts, "claude", NOW, { autoSwitch: true });
  assert.equal(pool.runsOutAt, NOW);
  assert.equal(pool.backAccount, "work");
  const head = poolHeadline(pool, accounts, NOW);
  assert.equal(head.title, "Both Claude subscriptions are at the limit");
  assert.match(head.detail, /^First one back at .* · Work · in 1h 30m/);
  assert.equal(head.tone, "danger");
  assert.equal(poolTrailing(pool, NOW).tone, "danger");
});

test("pool: set-aside and signed-out accounts are never room", () => {
  const accounts = [
    account("claude-main", { p5: 95, rate: 10, agents: 1 }),
    account("aside", { p5: 0, disabled: true }),
    account("out", { p5: 0, signedIn: false }),
  ];
  const pool = poolForecast(accounts, "claude", NOW, { autoSwitch: true });
  assert.equal(pool.takeovers.length, 0);
  assert.ok(pool.runsOutAt !== null && pool.runsOutAt - NOW <= 31 * 60_000);
  assert.equal(pool.withRoom, 1);
});

test("pool: a stale reading adds no pace and is not extrapolated", () => {
  const stale = account("claude-main", { p5: 60, rate: 40, agents: 1, readAt: iso(NOW - 2 * H) });
  const pool = poolForecast([stale, account("work", { p5: 10 })], "claude", NOW, { autoSwitch: true });
  assert.equal(pool.pace, null, "a two-hour-old rate is not the pace now");
  assert.equal(pool.runsOutAt, null);
  assert.equal(pool.stale, 1);
  const head = poolHeadline(pool, [stale], NOW);
  assert.match(head.title, /2 of 2 subscriptions with room/);
  assert.match(head.detail, /1 reading is over 30 min old/);
});

test("pool: a window past its reset has refilled, even on an old reading", () => {
  const old = account("work", { p5: 100, r5: NOW - 10 * 60_000, readAt: iso(NOW - 3 * H) });
  const pool = poolForecast([account("claude-main", { p5: 100, r5: NOW + 2 * H }), old], "claude", NOW, { autoSwitch: true });
  assert.equal(pool.withRoom, 1);
  assert.equal(pool.runsOutAt, null);
});

test("pool: a week that runs out at its own pace takes the account out until the weekly reset", () => {
  // 95% of the week used two days in: it runs out within hours at its average pace.
  const tired = account("claude-main", { p5: 10, rate: 10, agents: 1, week: 99, wr: NOW + 5 * 24 * H });
  const pool = poolForecast([tired, account("work", { p5: 0 })], "claude", NOW, { autoSwitch: true });
  assert.equal(pool.takeovers[0]?.accountId, "work");
  assert.ok(pool.takeovers[0]!.at - NOW < 2 * H);
});

test("pool: with automatic switching off the work stays put", () => {
  const accounts = [account("claude-main", { p5: 90, rate: 20, agents: 1 }), account("work", { p5: 0 })];
  const pool = poolForecast(accounts, "claude", NOW, { autoSwitch: false });
  assert.equal(pool.takeovers.length, 0);
  assert.ok(pool.runsOutAt !== null && pool.runsOutAt - NOW <= 31 * 60_000);
  assert.match(poolHeadline(pool, accounts, NOW).detail, /automatic switching is off/);
});

test("pool: nothing in use says how many have room", () => {
  const pool = poolForecast([account("claude-main"), account("work", { p5: 100 })], "claude", NOW, { autoSwitch: true });
  assert.equal(pool.pace, null);
  assert.equal(poolHeadline(pool, [], NOW).title, "Claude · 1 of 2 subscriptions with room");
  assert.equal(poolTrailing(pool, NOW).label, "1 of 2");
});

test("pool: lasting at this pace names the next account and keeps a normal tone", () => {
  const accounts = [account("claude-main", { p5: 70, rate: 5, agents: 1 }), account("work", { p5: 0, name: "Personal" })];
  const pool = poolForecast(accounts, "claude", NOW, { autoSwitch: true });
  assert.equal(pool.runsOutAt, null);
  const head = poolHeadline(pool, accounts, NOW);
  assert.equal(head.title, "Claude · 2 subscriptions last at this pace");
  assert.equal(head.tone, "default");
});

test("lead: the family in trouble leads, Claude on a tie", () => {
  const claude = poolForecast([account("claude-main")], "claude", NOW, { autoSwitch: true });
  const codex = poolForecast([account("codex-main", { family: "codex", p5: 100 })], "codex", NOW, { autoSwitch: true });
  assert.equal(leadPool([claude, codex], NOW)?.family, "codex");
  assert.equal(leadPool([claude, poolForecast([account("codex-main", { family: "codex" })], "codex", NOW, { autoSwitch: true })], NOW)?.family, "claude");
});

test("at the limit: ZeroSub's move, or the pause when nothing has room", () => {
  const accounts = [account("claude-main", { p5: 60 }), account("work", { p5: 36, name: "Personal" }), account("full", { p5: 100 })];
  assert.equal(atTheLimit(accounts, "claude-main", NOW, { autoSwitch: true, protectedHere: true }).text, "At the limit, ZeroSub moves it to Personal (64% left)");
  const none = [account("claude-main", { p5: 60, r5: NOW + 2 * H }), account("full", { p5: 100, r5: NOW + 3 * H })];
  assert.match(atTheLimit(none, "claude-main", NOW, { autoSwitch: true, protectedHere: true }).text, /^No other account has room · Smart Session pauses it until /);
  assert.match(atTheLimit(none, "claude-main", NOW, { autoSwitch: true, protectedHere: false }).text, /it stops at the limit/);
  assert.match(atTheLimit(accounts, "claude-main", NOW, { autoSwitch: false, protectedHere: false }).text, /^Automatic switching is off/);
});

test("recorder: keeps each new ZeroSub reading once, keyed by account id, never an email", async () => {
  const { mkdtemp, mkdir, writeFile, readdir, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "ss-subs-"));
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  try {
    const { recordAccounts, forgetAccounts, buildView } = await import("./server/subscriptions.ts");
    const { readAccounts } = await import("./server/store.ts");
    const { parseZeroSub } = await import("./shared/guard/zerosub.ts");
    forgetAccounts();
    await mkdir(join(home, "zerosub"), { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({ plugins: { zerosub: { enabled: true } } }));
    const state = {
      accounts: [
        { id: "claude-main", family: "claude", label: "me@example.com", autoLabel: true, kind: "main", signedIn: true, createdAt: iso(NOW - 9 * H) },
        { id: "claude-x1", family: "claude", label: "Personal", autoLabel: false, kind: "managed", email: "p@example.com", signedIn: true, createdAt: iso(NOW - 8 * H) },
        { id: "claude-x2", family: "claude", label: "w@example.com", autoLabel: true, kind: "managed", email: "w@example.com", signedIn: true, disabled: true, createdAt: iso(NOW - 7 * H) },
        { id: "codex-main", family: "codex", label: "me@example.com", autoLabel: true, kind: "main", signedIn: true, createdAt: iso(NOW - 9 * H) },
      ],
      defaults: { claude: "claude-x1", codex: null },
      sessions: { a1: { accountId: "claude-x1", family: "claude", openedAt: iso(NOW) } },
    };
    const reading = (pct: number, at: number) => ({ fetchedAt: iso(at), cached: false, error: null, windows: [
      { id: "five_hour", label: "5h", usedPercent: pct, resetsAt: iso(NOW + 2 * H) },
      { id: "seven_day", label: "Week", usedPercent: 20, resetsAt: iso(NOW + 3 * 24 * H) },
    ] });
    const codex = { fetchedAt: iso(NOW - 40 * 60_000), cached: false, error: null, credits: { balance: 120, unlimited: false }, windows: [
      { id: "primary", label: "5h", usedPercent: 55, resetsAt: iso(NOW + H), minutes: 300 },
      { id: "secondary", label: "Week", usedPercent: 70, resetsAt: iso(NOW + 2 * 24 * H), minutes: 10080 },
    ] };
    const usage = { "claude-main": reading(80, NOW - 60_000), "claude-x1": reading(10, NOW - 20 * 60_000), "codex-main": codex };
    await writeFile(join(home, "zerosub", "state.json"), JSON.stringify(state));
    await writeFile(join(home, "zerosub", "usage.json"), JSON.stringify(usage));

    assert.equal(await recordAccounts(NOW - 19 * 60_000), 2, "the CLI login is the recorder's; the others are kept");
    assert.equal(await recordAccounts(NOW - 18 * 60_000), 0, "the same reading is not kept twice");
    usage["claude-x1"] = reading(20, NOW - 60_000);
    await writeFile(join(home, "zerosub", "usage.json"), JSON.stringify(usage));
    forgetAccounts(); // a reload reads what was kept back from the log
    assert.equal(await recordAccounts(NOW), 1);
    const rows = await readAccounts();
    assert.deepEqual(rows.map((r) => r.accountId), ["claude-x1", "codex-main", "claude-x1"]);
    assert.equal(rows[1]!.windows.five_hour!.pct, 55, "Codex windows use the same ids");
    const files = await readdir(join(home, "plugin-data", "smart-session"));
    const written = (await Promise.all(files.map((f) => readFile(join(home, "plugin-data", "smart-session", f), "utf8")))).join("");
    assert.ok(!written.includes("@"), "no email reaches Smart Session's storage");

    const snapshot = parseZeroSub(state, usage, undefined)!;
    const view = buildView(snapshot, { recorded: [], accountRows: rows, liveAgents: [{ id: "a1", provider: "claude" }, { id: "a2", provider: "claude" }] }, NOW);
    assert.ok(!JSON.stringify(view).includes("@"), "no email in the RPC output");
    const byId = Object.fromEntries(view.accounts.map((a) => [a.id, a]));
    assert.deepEqual([byId["claude-main"]!.name, byId["claude-x1"]!.name, byId["claude-x2"]!.name, byId["codex-main"]!.name], ["CLI login", "Personal", "Account 3", "CLI login"]);
    assert.equal(byId["claude-x1"]!.isDefault, true);
    assert.equal(byId["claude-x1"]!.agents, 1);
    assert.equal(byId["claude-main"]!.agents, 1, "an agent with no session of its own runs on the CLI login");
    assert.equal(view.agents.a1, "claude-x1");
    assert.ok(byId["claude-x1"]!.windows.find((w) => w.id === "five_hour")!.burnPctPerHour! > 0, "a pace from the kept history");
    assert.equal(byId["codex-main"]!.windows.find((w) => w.id === "five_hour")!.burnPctPerHour, null, "a 40-minute-old reading has no pace");
    assert.deepEqual(byId["codex-main"]!.credits, { balance: 120, unlimited: false });
  } finally {
    if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
