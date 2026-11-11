import assert from "node:assert/strict";
import { test } from "node:test";

import type { Subscription, SubscriptionWindow } from "./shared/subscriptions.ts";
import {
  CLI_KEY,
  accountKey,
  buildReport,
  cardsToHide,
  loginText,
  discoverAccounts,
  hideableCards,
  paseoWindow,
  parseExtras,
  reportWindow,
  type AccountExtras,
  type SourceState,
} from "./shared/usage-source.ts";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const win = (id: string, pct: number, resetIn: number | null, burn: number | null = null): SubscriptionWindow => ({
  id,
  pct,
  resetsAt: resetIn === null ? null : iso(resetIn),
  burnPctPerHour: burn,
});

function account(id: string, over: Partial<Subscription> = {}): Subscription {
  return {
    id,
    family: "claude",
    kind: id === "claude-main" ? "main" : "managed",
    name: id === "claude-main" ? "CLI login" : "Account 2",
    named: false,
    isDefault: false,
    signedIn: true,
    disabled: false,
    limitedUntil: null,
    outUntil: null,
    createdAt: "2026-10-01T00:00:00Z",
    agents: 0,
    readAt: iso(-2 * MIN),
    windows: [win("five_hour", 20, 3 * HOUR, 2), win("seven_day", 40, 3 * 24 * HOUR)],
    credits: null,
    ...over,
  };
}

const extras = (over: Partial<AccountExtras> = {}): AccountExtras => ({ emailHash: "h-main", plan: "team", windowLabels: {}, extraUsage: null, ...over });

function zerosubState(accounts: Subscription[], over: Partial<NonNullable<SourceState["zerosub"]>> = {}): SourceState {
  return {
    zerosub: {
      accounts,
      autoSwitch: true,
      extras: Object.fromEntries(accounts.map((a) => [a.id, extras({ emailHash: `h-${a.id}` })])),
      sessions: {},
      homes: {},
      ...over,
    },
    recorded: null,
  };
}

const session = (env: Record<string, string>) => ({ kind: "session" as const, provider: "claude", env });

// ---------------------------------------------------------------- windows and tones

test("a window on pace for the reset is default tone with no run-out", () => {
  const out = reportWindow(win("five_hour", 20, 3 * HOUR, 2), false, NOW);
  assert.equal(out.id, "five_hour");
  assert.equal(out.label, "Session");
  assert.equal(out.shortLabel, "5h");
  assert.equal(out.summary, true);
  assert.equal(out.tone, "default");
  assert.equal(out.runsOutAt, undefined);
  assert.equal(out.usedPct, 20);
  assert.equal(out.remainingPct, 80);
});

test("a window that runs out before its reset carries runsOutAt, shortfall and a warning", () => {
  // 50% used, 30%/h, resets in 3h: 100% in 1h40m, ~140% by the reset.
  const out = reportWindow(win("five_hour", 50, 3 * HOUR, 30), false, NOW);
  assert.equal(out.tone, "warning");
  assert.equal(out.runsOutAt, iso((50 / 30) * HOUR));
  assert.equal(out.shortfallPct, 40);
});

test("a window that runs out within half an hour is danger", () => {
  const out = reportWindow(win("five_hour", 90, 3 * HOUR, 30), false, NOW);
  assert.equal(out.tone, "danger");
  assert.ok(out.runsOutAt);
});

test("a full window is danger without a run-out moment", () => {
  const out = reportWindow(win("seven_day", 100, 24 * HOUR), false, NOW);
  assert.equal(out.id, "weekly");
  assert.equal(out.tone, "danger");
  assert.equal(out.runsOutAt, undefined);
});

test("a stale reading keeps its numbers but drops the forecast", () => {
  const out = reportWindow(win("five_hour", 50, 3 * HOUR, 30), true, NOW);
  assert.equal(out.usedPct, 50);
  assert.equal(out.tone, "default");
  assert.equal(out.runsOutAt, undefined);
  assert.equal(out.shortfallPct, undefined);
});

test("windows take Paseo's ids and labels, model-scoped weeks included", () => {
  assert.deepEqual(paseoWindow("seven_day"), { id: "weekly", label: "Weekly", shortLabel: "wk", summary: true });
  // ZeroSub's flat id with its own label, and the recorder's scoped id.
  assert.deepEqual(paseoWindow("weekly_fable", "Weekly · Fable"), { id: "weekly_model_fable", label: "Weekly · Fable", shortLabel: "wk Fable", summary: false });
  assert.deepEqual(paseoWindow("weekly_model:fable"), { id: "weekly_model_fable", label: "Weekly · Fable", shortLabel: "wk Fable", summary: false });
  assert.equal(paseoWindow("seven_day_opus").label, "Weekly · Opus");
  assert.equal(paseoWindow("weekly_surface:omelette").id, "weekly_surface_omelette");
});

test("account keys fit Paseo's key pattern", () => {
  assert.equal(accountKey("claude-bf9144bd576e"), "claude-bf9144bd576e");
  assert.equal(accountKey("a b/c"), "a_b_c");
  assert.match(accountKey("x".repeat(300)), /^[A-Za-z0-9._-]{1,128}$/);
});

// ---------------------------------------------------------------- discovery

test("a session lists its own account first, then the default, then the rest", () => {
  const main = account("claude-main");
  const a2 = account("claude-two", { isDefault: true });
  const a3 = account("claude-three", { createdAt: "2026-10-05T00:00:00Z", name: "Account 3" });
  const state = zerosubState([main, a2, a3], { sessions: { agent1: "claude-three" } });
  const found = discoverAccounts(state, session({ PASEO_AGENT_ID: "agent1" }));
  assert.deepEqual(found.map((a) => a.key), ["claude-three", "claude-two", "claude-main"]);
  assert.deepEqual(found.map((a) => a.input.lead), [true, false, false]);
  // The footer is the account's own name, never an email.
  assert.deepEqual(found.map((a) => a.label), ["Account 3", "Account 2", "CLI login"]);
});

test("a session with no binding falls back to its home, then to the default", () => {
  const state = zerosubState([account("claude-main"), account("claude-two")], { homes: { "/h/two": "claude-two" } });
  assert.equal(discoverAccounts(state, session({ CLAUDE_CONFIG_DIR: "/h/two/" }))[0]!.key, "claude-two");
  assert.equal(discoverAccounts(state, session({}))[0]!.key, "claude-main");
});

test("the global scope leads with the default account", () => {
  const state = zerosubState([account("claude-main"), account("claude-two", { isDefault: true })]);
  const found = discoverAccounts(state, { kind: "global" });
  assert.equal(found[0]!.key, "claude-two");
  assert.equal(found[0]!.input.lead, true);
});

test("other providers and gateways get nothing", () => {
  const state = zerosubState([account("claude-main")]);
  assert.deepEqual(discoverAccounts(state, { kind: "session", provider: "codex", env: {} }), []);
  assert.deepEqual(discoverAccounts(state, session({ CLAUDE_CODE_USE_BEDROCK: "1" })), []);
  assert.deepEqual(discoverAccounts(state, session({ ANTHROPIC_BASE_URL: "https://proxy.example" })), []);
});

test("without ZeroSub, the CLI login alone, while the recorder has it", () => {
  const recorded = { windows: [win("five_hour", 30, 2 * HOUR, 5)], readAt: iso(-MIN), extraUsage: true };
  assert.deepEqual(discoverAccounts({ zerosub: null, recorded: null }, session({})), []);
  const found = discoverAccounts({ zerosub: null, recorded }, session({}));
  assert.deepEqual(found, [{ key: CLI_KEY, label: "CLI login", input: { account: CLI_KEY, lead: true } }]);
  const report = buildReport({ zerosub: null, recorded }, found[0]!.input, NOW);
  assert.equal(report.status, "available");
  if (report.status !== "available") return;
  assert.equal(report.windows[0]!.id, "five_hour");
  assert.deepEqual(report.details, [{ id: "extra_usage", label: "Extra usage", value: "Enabled" }]);
  // No login to match, so the built-in card always stays.
  assert.deepEqual(hideableCards({ zerosub: null, recorded }, NOW), []);
});

// ---------------------------------------------------------------- reports

test("the lead card carries the pool line; the others do not", () => {
  const busy = [win("five_hour", 60, 4 * HOUR, 30), win("seven_day", 40, 3 * 24 * HOUR)];
  const state = zerosubState([account("claude-main", { windows: busy, isDefault: true }), account("claude-two", { windows: busy })]);
  const lead = buildReport(state, { account: "claude-main", lead: true }, NOW);
  const other = buildReport(state, { account: "claude-two", lead: false }, NOW);
  assert.equal(lead.status, "available");
  assert.equal(other.status, "available");
  if (lead.status !== "available" || other.status !== "available") return;
  const pool = lead.details!.find((d) => d.id === "pool");
  assert.ok(pool, "lead has the pool line");
  assert.equal(pool!.label, "2 accounts");
  assert.match(pool!.value, /^run out in .+ at this pace$/);
  assert.equal(pool!.tone, "warning");
  assert.equal(other.details!.some((d) => d.id === "pool"), false);
  // The badge names the account, then the plan.
  assert.equal(lead.planLabel, "CLI login · Team");
  assert.equal(other.planLabel, "Account 2 · Team");
  // Detail times are durations, never clocks: the daemon's timezone is not the viewer's.
  for (const detail of [...lead.details!, ...other.details!]) assert.doesNotMatch(detail.value, /\b\d{1,2}:\d{2}\b/);
});

test("a limited account says so in red, with when it is back", () => {
  const limited = account("claude-two", { limitedUntil: iso(90 * MIN), outUntil: iso(90 * MIN), windows: [win("five_hour", 100, 90 * MIN), win("seven_day", 50, 3 * 24 * HOUR)] });
  const state = zerosubState([account("claude-main"), limited]);
  const report = buildReport(state, { account: "claude-two", lead: false }, NOW);
  assert.equal(report.status, "available");
  if (report.status !== "available") return;
  assert.deepEqual(report.details!.find((d) => d.id === "status"), { id: "status", label: "At the limit", value: "back in 1h 30m", tone: "danger" });
  assert.equal(report.windows[0]!.tone, "danger");
});

test("a stale account says how old its reading is and is never hideable", () => {
  const stale = account("claude-two", { readAt: iso(-42 * MIN), windows: [win("five_hour", 50, 3 * HOUR, null)] });
  const state = zerosubState([account("claude-main"), stale]);
  const report = buildReport(state, { account: "claude-two", lead: false }, NOW);
  assert.equal(report.status, "available");
  if (report.status !== "available") return;
  assert.deepEqual(report.details!.find((d) => d.id === "reading"), { id: "reading", label: "Last reading", value: "42m ago", tone: "warning" });
  assert.deepEqual(hideableCards(state, NOW).map((c) => c.key), ["claude-main"]);
});

test("signed out, unknown and unread accounts are errors and never hideable", () => {
  const state = zerosubState([account("claude-main", { signedIn: false }), account("claude-two", { readAt: null, windows: [] })]);
  assert.deepEqual(buildReport(state, { account: "claude-main", lead: true }, NOW), { status: "error", error: "Signed out in ZeroSub." });
  assert.deepEqual(buildReport(state, { account: "claude-two", lead: false }, NOW), { status: "error", error: "No usage reading from ZeroSub yet." });
  assert.deepEqual(buildReport(state, { account: "gone", lead: false }, NOW), { status: "error", error: "ZeroSub no longer lists this account." });
  assert.deepEqual(hideableCards(state, NOW), []);
});

test("an account without a known login is never hideable", () => {
  const state = zerosubState([account("claude-main")]);
  (state.zerosub!.extras as Record<string, AccountExtras>)["claude-main"] = extras({ emailHash: null });
  assert.deepEqual(hideableCards(state, NOW), []);
});

test("extra usage shows when ZeroSub records it", () => {
  const state = zerosubState([account("claude-main")]);
  (state.zerosub!.extras as Record<string, AccountExtras>)["claude-main"] = extras({ extraUsage: false });
  const report = buildReport(state, { account: "claude-main", lead: true }, NOW);
  assert.equal(report.status, "available");
  if (report.status !== "available") return;
  assert.deepEqual(report.details!.find((d) => d.id === "extra_usage"), { id: "extra_usage", label: "Extra usage", value: "Disabled" });
});

// ---------------------------------------------------------------- ZeroSub's files

test("parseExtras hashes the email and keeps no copy of it", () => {
  const state = {
    accounts: [
      { id: "claude-main", email: "Me@Example.com ", plan: "team", home: null },
      { id: "claude-two", email: "two@example.com", plan: "max", home: "/z/homes/claude-two/" },
      { nope: true },
    ],
    sessions: { a1: { accountId: "claude-two" }, a2: {} },
  };
  const usage = {
    "claude-main": { windows: [{ id: "weekly_fable", label: "Weekly · Fable", usedPercent: 3 }], extraUsage: { enabled: true, spend: 12 } },
    "claude-two": { windows: "broken" },
  };
  const parsed = parseExtras(state, usage, (email) => (email === "me@example.com" ? "H-main" : "H-other"));
  assert.equal(parsed.extras["claude-main"]!.emailHash, "H-main");
  assert.equal(parsed.extras["claude-main"]!.extraUsage, true);
  assert.deepEqual(parsed.extras["claude-main"]!.windowLabels, { weekly_fable: "Weekly · Fable" });
  assert.equal(parsed.extras["claude-two"]!.extraUsage, null);
  assert.deepEqual(parsed.sessions, { a1: "claude-two" });
  assert.deepEqual(parsed.homes, { "/z/homes/claude-two": "claude-two" });
  assert.doesNotMatch(JSON.stringify(parsed), /example\.com/);
});

test("parseExtras reads garbage as nothing", () => {
  assert.deepEqual(parseExtras(undefined, null, () => "x"), { extras: {}, sessions: {}, homes: {} });
  assert.deepEqual(parseExtras({ accounts: "no" }, [], () => "x"), { extras: {}, sessions: {}, homes: {} });
});

// ---------------------------------------------------------------- the hide's rule

test("a built-in card hides only beside our fresh card for the same login", () => {
  const fresh = [{ key: "claude-two", emailHash: "H2" }];
  const cards = [
    { testId: "usage-report-claude:uuid.org", loginHash: "H2" },
    { testId: "usage-report-smart-session:claude-two", loginHash: null },
  ];
  assert.deepEqual([...cardsToHide(cards, fresh)], ["usage-report-claude:uuid.org"]);
  // Our card not rendered (still loading, or errored and dropped): nothing hides.
  assert.deepEqual([...cardsToHide([cards[0]!], fresh)], []);
  // Our card rendered but stale (not in the fresh list): nothing hides.
  assert.deepEqual([...cardsToHide(cards, [])], []);
  // Another login: nothing hides.
  assert.deepEqual([...cardsToHide([{ ...cards[0]!, loginHash: "H9" }, cards[1]!], fresh)], []);
  // No login read from the built-in card: nothing hides.
  assert.deepEqual([...cardsToHide([{ ...cards[0]!, loginHash: null }, cards[1]!], fresh)], []);
  // Test ids Paseo might rename to: nothing hides.
  assert.deepEqual([...cardsToHide([{ testId: "usage-card-claude:uuid.org", loginHash: "H2" }, { testId: "usage-card-smart-session:claude-two", loginHash: null }], fresh)], []);
});

test("the login is the card's one email-shaped text", () => {
  assert.equal(loginText(["Claude", "Team", "Session", "20%", " Me@Example.com "]), "me@example.com");
  assert.equal(loginText(["Claude", "Session"]), null);
  assert.equal(loginText(["a@b.co", "c@d.co"]), null);
});

test("the account in use is never 'taking over', and other cards keep to the 5-hour and weekly windows", () => {
  const busy = [win("five_hour", 60, 4 * HOUR, 30), win("seven_day", 40, 3 * 24 * HOUR), win("weekly_fable", 3, 3 * 24 * HOUR)];
  const state = zerosubState([account("claude-main", { windows: busy, isDefault: true }), account("claude-two", { windows: [win("five_hour", 10, 1 * HOUR, 1), win("seven_day", 10, 3 * 24 * HOUR), win("weekly_fable", 1, 3 * 24 * HOUR)] })]);
  const lead = buildReport(state, { account: "claude-main", lead: true }, NOW);
  const other = buildReport(state, { account: "claude-two", lead: false }, NOW);
  if (lead.status !== "available" || other.status !== "available") return assert.fail("both available");
  assert.equal(lead.details!.some((d) => d.label === "Takes over"), false);
  assert.equal(other.details!.find((d) => d.id === "status")?.label, "Takes over");
  assert.deepEqual(lead.windows.map((w) => w.id), ["five_hour", "weekly", "weekly_model_fable"]);
  assert.deepEqual(other.windows.map((w) => w.id), ["five_hour", "weekly"]);
});
