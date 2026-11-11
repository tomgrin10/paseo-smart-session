/**
 * Smart Session as a Paseo usage source (Paseo 0.16+): the session's own Claude
 * account, every other account ZeroSub manages, and how long they last together,
 * in Paseo's own usage card.
 *
 * Plain functions from what Smart Session already holds (the subscriptions view,
 * the recorder's history) to Paseo's `UsageAccount` and `UsageReport` shapes. The
 * server registers them only when the host has `registerUsageSource`; the shapes are
 * declared here because the plugin SDK this repository builds against (0.14) has no
 * usage types.
 *
 * Two rules shape every string. Paseo renders a window's reset and run-out moments
 * itself, in the viewer's timezone. Our detail rows are plain text made on the daemon,
 * which may run in another timezone, so they say durations ("in 3h 10m"), never clocks.
 * And colour follows the forecast (DESIGN.md, "Forecast earns colour"): a window is
 * `default` unless the pace says it bites before the reset.
 */

import { formatDuration } from "./format.ts";
import { forecastWindow, type Tone } from "./forecast.ts";
import {
  poolForecast,
  readingAge,
  subscriptionState,
  type PoolForecast,
  type Subscription,
  type SubscriptionWindow,
} from "./subscriptions.ts";

export const USAGE_SOURCE_ID = "smart-session";
export const USAGE_SOURCE_LABEL = "Smart Session";
/** The key of the one account shown without ZeroSub: the CLI's own login, as the recorder measures it. */
export const CLI_KEY = "cli";

// ---------------------------------------------------------------- Paseo's shapes (0.16 `@getpaseo/plugin/server/usage`)

export type UsageTone = "default" | "ok" | "warning" | "danger";

export interface UsageWindowOut {
  id: string;
  label: string;
  shortLabel?: string;
  summary?: boolean;
  usedPct: number | null;
  remainingPct: number | null;
  resetsAt: string | null;
  runsOutAt?: string | null;
  shortfallPct?: number | null;
  tone?: UsageTone;
}

export interface UsageDetailOut {
  id: string;
  label: string;
  value: string;
  tone?: UsageTone;
}

export type UsageReportOut =
  | { status: "available"; planLabel?: string; windows: UsageWindowOut[]; balances?: []; details?: UsageDetailOut[] }
  | { status: "error"; error: string };

export interface UsageAccountOut {
  key: string;
  label?: string;
  input: UsageInput;
}

export type UsageScopeIn =
  | { kind: "global" }
  | { kind: "session"; provider: string; model?: string; env: Record<string, string> };

/** The locator Paseo hands back to `fetch`: which account, and whether its card carries the pool line. */
export interface UsageInput {
  account: string;
  lead: boolean;
}

// ---------------------------------------------------------------- what the server hands over

/** Per account, what ZeroSub's files say beyond the subscriptions view (which keeps no email by design). */
export interface AccountExtras {
  /**
   * SHA-256 of the login's lowercased email: the same-account proof for the hide. The
   * server hashes it in memory; the email itself is never copied out of ZeroSub's files
   * (AGENTS.md), so the card's footer is the account's neutral name instead.
   */
  readonly emailHash: string | null;
  /** ZeroSub's plan type ("team", "max"). */
  readonly plan: string | null;
  /** ZeroSub's own label per window id ("Weekly · Fable"). */
  readonly windowLabels: Readonly<Record<string, string>>;
  /** Extra usage switched on for the account, when known. */
  readonly extraUsage: boolean | null;
}

export interface SourceState {
  /** Null without ZeroSub. */
  readonly zerosub: {
    readonly accounts: readonly Subscription[];
    readonly autoSwitch: boolean;
    readonly extras: Readonly<Record<string, AccountExtras>>;
    /** Which account each agent's session was opened on. */
    readonly sessions: Readonly<Record<string, string>>;
    /** Account home → account id, for a session whose env names its home but not its agent. */
    readonly homes: Readonly<Record<string, string>>;
  } | null;
  /** The CLI login as the recorder measures it: used without ZeroSub. Null when nothing is recorded. */
  readonly recorded: {
    readonly windows: readonly SubscriptionWindow[];
    readonly readAt: string | null;
    readonly extraUsage: boolean | null;
  } | null;
}

// ---------------------------------------------------------------- discovery

const KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** A ZeroSub id as a Paseo account key: its ids already fit, anything else is folded to fit. */
export function accountKey(id: string): string {
  if (KEY_PATTERN.test(id)) return id;
  const folded = id.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 128);
  return folded === "" ? "account" : folded;
}

const claudeAccounts = (state: SourceState) => state.zerosub?.accounts.filter((a) => a.family === "claude") ?? [];

/** The account a session runs on: ZeroSub's binding for the agent, else the home its env names, else the default. */
export function sessionAccount(state: SourceState, env: Readonly<Record<string, string>>): Subscription | null {
  const accounts = claudeAccounts(state);
  if (accounts.length === 0) return null;
  const zs = state.zerosub!;
  const agentId = env.PASEO_AGENT_ID;
  const byAgent = agentId ? zs.sessions[agentId] : undefined;
  const configDir = env.CLAUDE_CONFIG_DIR?.replace(/\/+$/, "");
  const byHome = configDir ? zs.homes[configDir] : undefined;
  const id = byAgent ?? byHome;
  return accounts.find((a) => a.id === id) ?? accounts.find((a) => a.isDefault) ?? accounts.find((a) => a.kind === "main") ?? null;
}

/** Lead first, then the family's default, then the CLI login, then the rest in the order they were added. */
function ordered(accounts: readonly Subscription[], leadId: string | null): Subscription[] {
  const rank = (a: Subscription) => (a.id === leadId ? 0 : a.isDefault ? 1 : a.kind === "main" ? 2 : 3);
  const at = (a: Subscription) => (a.createdAt ? Date.parse(a.createdAt) || 0 : 0);
  return [...accounts].sort((x, y) => rank(x) - rank(y) || at(x) - at(y) || x.id.localeCompare(y.id));
}

/**
 * The accounts for a scope. A Claude session lists its own account first and then
 * the others; the global scope lists them all, the default leading. Without ZeroSub
 * it is the CLI login alone, while the recorder has measured it.
 */
export function discoverAccounts(state: SourceState, scope: UsageScopeIn): UsageAccountOut[] {
  if (scope.kind === "session") {
    if (scope.provider !== "claude") return [];
    // Bedrock, Vertex and foreign gateways have no plan limits, exactly as Paseo's own source decides.
    const env = scope.env;
    const on = (value: string | undefined) => value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
    const base = env.ANTHROPIC_BASE_URL?.replace(/\/+$/, "");
    if (on(env.CLAUDE_CODE_USE_BEDROCK) || on(env.CLAUDE_CODE_USE_VERTEX) || (base && base !== "https://api.anthropic.com")) return [];
  }
  const accounts = claudeAccounts(state);
  if (accounts.length === 0) {
    return state.recorded === null ? [] : [{ key: CLI_KEY, label: "CLI login", input: { account: CLI_KEY, lead: true } }];
  }
  const lead = scope.kind === "session" ? sessionAccount(state, scope.env) : (accounts.find((a) => a.isDefault) ?? null);
  return ordered(accounts, lead?.id ?? null).map((account) => ({
    key: accountKey(account.id),
    label: account.name,
    input: { account: account.id, lead: account.id === lead?.id },
  }));
}

// ---------------------------------------------------------------- windows

const titleCase = (name: string) => name.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * A Smart Session window id under the id, label and short label Paseo's own Claude
 * card uses, so the two cards read alike and a pin means the same thing.
 * Recorder ids are `weekly_model:fable`; ZeroSub's are `weekly_fable` or `seven_day_opus`.
 */
export function paseoWindow(id: string, zerosubLabel?: string): { id: string; label: string; shortLabel: string; summary: boolean } {
  if (id === "five_hour") return { id: "five_hour", label: "Session", shortLabel: "5h", summary: true };
  if (id === "seven_day") return { id: "weekly", label: "Weekly", shortLabel: "wk", summary: true };
  const scoped = /^weekly_(model|surface):(.+)$/.exec(id) ?? /^(?:seven_day|weekly)_()(.+)$/.exec(id);
  if (scoped !== null) {
    const dimension = scoped[1] || "model";
    const fromLabel = zerosubLabel ? /^Weekly · (.+)$/.exec(zerosubLabel)?.[1] : undefined;
    const name = fromLabel ?? titleCase(scoped[2]!);
    return { id: `weekly_${dimension}_${normalize(name)}`, label: `Weekly · ${name}`, shortLabel: `wk ${name}`, summary: false };
  }
  return { id, label: zerosubLabel ?? titleCase(id), shortLabel: "", summary: false };
}

const ORDER = (id: string) => (id === "five_hour" ? 0 : id === "weekly" ? 1 : 2);

/** One window with the forecast, or the bare reading when the reading is too old to forecast from. */
export function reportWindow(window: SubscriptionWindow, stale: boolean, now: number, zerosubLabel?: string): UsageWindowOut {
  const named = paseoWindow(window.id, zerosubLabel);
  const used = Math.min(100, Math.max(0, window.pct));
  const out: UsageWindowOut = {
    ...named,
    usedPct: used,
    remainingPct: 100 - used,
    resetsAt: window.resetsAt,
  };
  if (named.shortLabel === "") delete out.shortLabel;
  if (stale) {
    // No pace from an old reading; a full window is still full.
    out.tone = used >= 99.5 ? "danger" : "default";
    return out;
  }
  // The forecast's rules are keyed on Smart Session's own ids.
  const forecast = forecastWindow({ id: window.id === "seven_day" ? "seven_day" : window.id, pct: used, resetsAt: window.resetsAt, burnPctPerHour: window.burnPctPerHour }, now);
  out.tone = forecast.tone satisfies Tone;
  if (forecast.state === "short" && forecast.runsOutAt !== null && forecast.atResetPct !== null) {
    out.runsOutAt = forecast.runsOutAt;
    out.shortfallPct = Math.round(Math.max(0, forecast.atResetPct - 100));
  }
  return out;
}

// ---------------------------------------------------------------- details

const inDuration = (ms: number) => (ms <= 60_000 ? "now" : `in ${formatDuration(ms)}`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The pool, on the lead card. Its label names the subject ("All 3 accounts", "Both
 * accounts") so it never reads as the lead account's own runway.
 */
export function poolDetail(pool: PoolForecast, now: number): UsageDetailOut | null {
  if (pool.total < 2) return null;
  const label = pool.total === 2 ? "Both accounts" : `All ${pool.total} accounts`;
  if (pool.runsOutAt !== null && pool.runsOutAt <= now) {
    const back = pool.backAt === null ? "" : ` · back ${inDuration(pool.backAt - now)}`;
    return { id: "pool", label, value: `at the limit${back}`, tone: "danger" };
  }
  if (pool.runsOutAt !== null) {
    const soon = pool.runsOutAt - now <= 30 * 60_000;
    return { id: "pool", label, value: `run out ${inDuration(pool.runsOutAt - now)} at this pace`, tone: soon ? "danger" : "warning" };
  }
  if (pool.pace !== null) return { id: "pool", label, value: `last ${Math.round((pool.horizon - now) / 3_600_000)}h+ at this pace` };
  return { id: "pool", label, value: `${pool.withRoom} with room` };
}

/** The window a limit lifts with, by its reset, so the row can name it instead of repeating a countdown Paseo prints. */
function windowEnding(account: Subscription, at: number): string | null {
  const window = account.windows.find((w) => w.resetsAt !== null && Math.abs(Date.parse(w.resetsAt) - at) <= 20 * 60_000);
  if (!window) return null;
  return window.id === "five_hour" ? "the 5-hour reset" : window.id === "seven_day" ? "the weekly reset" : `the ${paseoWindow(window.id).label} reset`;
}

/**
 * What sets this account apart in the pool: at the limit, set aside, or next to take
 * over. Times Paseo already prints on the card (a window's reset, the lead's run-out)
 * are named, not repeated as a second countdown that rounds a minute differently.
 */
export function statusDetail(account: Subscription, pool: PoolForecast | null, now: number, nameOf: (id: string) => string = (id) => id): UsageDetailOut | null {
  const state = subscriptionState(account, now);
  if (state.kind === "limit") {
    const ending = state.until === null ? null : windowEnding(account, state.until);
    const value = state.until === null ? "no reset reported" : ending ? `until ${ending}` : `back ${inDuration(state.until - now)}`;
    return { id: "status", label: "At the limit", value, tone: "danger" };
  }
  if (state.kind === "aside") return { id: "status", label: "Set aside", value: "in ZeroSub" };
  if (pool === null) return null;
  // The pool runs one stream of work per busy account; a takeover is work moving from one account to another.
  // Work coming back to an account that ran out earlier is not news on that account's card.
  const takeover = pool.takeovers.find((t) => t.accountId === account.id && t.from !== account.id);
  if (!takeover) return null;
  if (pool.takeovers.some((t) => t.from === account.id && t.at < takeover.at)) return null;
  return { id: "status", label: "Takes over", value: `when ${nameOf(takeover.from)} runs out` };
}

/** On a card whose own work moves on: who carries it next, so its run-out has the answer on the same card. */
function handoffDetail(account: Subscription, pool: PoolForecast | null, nameOf: (id: string) => string): UsageDetailOut | null {
  const next = pool?.takeovers.find((t) => t.from === account.id && t.accountId !== account.id);
  return next ? { id: "then", label: "Then", value: `${nameOf(next.accountId)} takes over` } : null;
}

function readingDetail(readAt: string | null, now: number): UsageDetailOut | null {
  const at = readAt === null ? NaN : Date.parse(readAt);
  if (!Number.isFinite(at)) return null;
  return { id: "reading", label: "Reading", value: `${formatDuration(now - at)} old · no forecast`, tone: "warning" };
}

const extraDetail = (enabled: boolean | null): UsageDetailOut | null =>
  enabled === null ? null : { id: "extra_usage", label: "Extra usage", value: enabled ? "Enabled" : "Disabled" };

/** The badge beside the header: which account, then its plan ("Work · Team"), so a card says whose it is at the top. */
const badge = (name: string, plan: string | null) => (plan ? `${name} · ${plan.charAt(0).toUpperCase()}${plan.slice(1)}` : name);

/** Windows a card shows: all of them on the session's own card; the plan's 5-hour and weekly on the others, to keep the list short. */
const BASE_WINDOWS = new Set(["five_hour", "seven_day"]);

// ---------------------------------------------------------------- the report

/** One account's card. */
export function buildReport(state: SourceState, input: UsageInput, now: number): UsageReportOut {
  if (input.account === CLI_KEY && claudeAccounts(state).length === 0) {
    const rec = state.recorded;
    if (rec === null || rec.windows.length === 0) return { status: "error", error: "Smart Session has not recorded this login's usage yet." };
    const at = rec.readAt === null ? NaN : Date.parse(rec.readAt);
    const stale = !Number.isFinite(at) || now - at > STALE_MS;
    const details = [stale ? readingDetail(rec.readAt, now) : null, extraDetail(rec.extraUsage)].filter((d): d is UsageDetailOut => d !== null);
    return { status: "available", windows: windowsOf(rec.windows, stale, now, {}), balances: [], details };
  }

  const zs = state.zerosub;
  const account = zs?.accounts.find((a) => a.id === input.account && a.family === "claude");
  if (!zs || !account) return { status: "error", error: "ZeroSub no longer lists this account." };
  if (!account.signedIn) return { status: "error", error: "Signed out in ZeroSub." };
  if (account.readAt === null || account.windows.length === 0) return { status: "error", error: "No usage reading from ZeroSub yet." };

  const extras = zs.extras[account.id];
  const stale = readingAge(account, now) !== null;
  const pool = claudeAccounts(state).length > 1 ? poolForecast(zs.accounts, "claude", now, { autoSwitch: zs.autoSwitch }) : null;
  const nameOf = (id: string) => zs.accounts.find((a) => a.id === id)?.name ?? "another account";
  const shown = input.lead ? account.windows : account.windows.filter((w) => BASE_WINDOWS.has(w.id));
  const windows = windowsOf(shown, stale, now, extras?.windowLabels ?? {});
  const status = statusDetail(account, pool, now, nameOf);
  // Extra usage is the built-in card's row, so the session's own card always carries it; elsewhere only where it matters.
  const atStake = status?.label === "At the limit" || windows.some((w) => w.runsOutAt);
  const details = [
    // A stale reading leads: everything under it is that old, and nothing is forecast from it.
    stale ? readingDetail(account.readAt, now) : null,
    input.lead && pool && !stale ? poolDetail(pool, now) : null,
    status,
    stale ? null : handoffDetail(account, pool, nameOf),
    input.lead || atStake ? extraDetail(extras?.extraUsage ?? null) : null,
  ].filter((d): d is UsageDetailOut => d !== null);
  const age = stale && account.readAt ? `${formatDuration(now - Date.parse(account.readAt))} old` : null;
  return {
    status: "available",
    // Stale, the badge says so: it is the most visible slot a card gives us.
    planLabel: age ? `${account.name} · ${age}` : badge(account.name, extras?.plan ?? null),
    windows,
    balances: [],
    details,
  };
}

const STALE_MS = 30 * 60_000;

function windowsOf(windows: readonly SubscriptionWindow[], stale: boolean, now: number, labels: Readonly<Record<string, string>>): UsageWindowOut[] {
  return windows
    .map((w) => reportWindow(w, stale, now, labels[w.id]))
    .sort((a, b) => ORDER(a.id) - ORDER(b.id) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- the hide

/**
 * The cards that may stand in for Paseo's own Claude card: an account ZeroSub
 * names a login for (by its email's hash), signed in, with a reading fresh enough to forecast from. The
 * client hides a built-in card only while one of these, for the same login, is on
 * screen beside it. Anything less (no ZeroSub, a stale or missing reading, no email)
 * leaves the built-in card alone.
 */
export function hideableCards(state: SourceState, now: number): { key: string; emailHash: string }[] {
  const zs = state.zerosub;
  if (!zs) return [];
  return claudeAccounts(state).flatMap((account) => {
    const emailHash = zs.extras[account.id]?.emailHash ?? null;
    if (emailHash === null || !account.signedIn || account.readAt === null || account.windows.length === 0) return [];
    if (readingAge(account, now) !== null || now - Date.parse(account.readAt) > STALE_MS) return [];
    return [{ key: accountKey(account.id), emailHash }];
  });
}

// ---------------------------------------------------------------- reading ZeroSub's files for the source

const rec = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * What the source needs from ZeroSub's `state.json` and `usage.json` beyond the
 * subscriptions view: the plan, ZeroSub's window labels, extra usage when ZeroSub
 * records it (an optional per-account `extraUsage: { enabled }`), session bindings
 * and account homes. The email is only ever passed through `hash`, in memory: no
 * email leaves this function. Anything unexpected reads as absent.
 */
export function parseExtras(
  state: unknown,
  usage: unknown,
  hash: (email: string) => string,
): { extras: Record<string, AccountExtras>; sessions: Record<string, string>; homes: Record<string, string> } {
  const extras: Record<string, AccountExtras> = {};
  const homes: Record<string, string> = {};
  const sessions: Record<string, string> = {};
  const raw = rec(state);
  const readings = rec(usage) ?? {};
  for (const entry of Array.isArray(raw?.accounts) ? raw!.accounts : []) {
    const account = rec(entry);
    const id = str(account?.id);
    if (!account || !id) continue;
    const email = str(account.email);
    const reading = rec(readings[id]);
    const windowLabels: Record<string, string> = {};
    for (const w of Array.isArray(reading?.windows) ? reading!.windows : []) {
      const window = rec(w);
      const wid = str(window?.id);
      const label = str(window?.label);
      if (wid && label) windowLabels[wid] = label;
    }
    const extra = rec(reading?.extraUsage);
    extras[id] = {
      emailHash: email ? hash(email.trim().toLowerCase()) : null,
      plan: str(account.plan),
      windowLabels,
      extraUsage: typeof extra?.enabled === "boolean" ? extra.enabled : null,
    };
    const home = str(account.home);
    if (home) homes[home.replace(/\/+$/, "")] = id;
  }
  for (const [agentId, entry] of Object.entries(rec(raw?.sessions) ?? {})) {
    const accountId = str(rec(entry)?.accountId);
    if (accountId) sessions[agentId] = accountId;
  }
  return { extras, sessions, homes };
}

// ---------------------------------------------------------------- the hide (client/usage-hide.ts), as a rule

export const BUILTIN_PREFIX = "usage-report-claude:";
export const OURS_PREFIX = `usage-report-${USAGE_SOURCE_ID}:`;

export interface RenderedCard {
  /** The card's test id, e.g. `usage-report-claude:<account>`. */
  readonly testId: string;
  /** SHA-256 of the login its footer names, lowercased; null when it names none. */
  readonly loginHash: string | null;
}

/**
 * Which built-in cards in one list to hide: those whose login matches one of our
 * cards rendered in the same list that the server currently calls fresh.
 */
export function cardsToHide(cards: readonly RenderedCard[], fresh: readonly { key: string; emailHash: string }[]): Set<string> {
  const freshByKey = new Map(fresh.map((card) => [card.key, card.emailHash]));
  const covered = new Set<string>();
  for (const card of cards) {
    if (!card.testId.startsWith(OURS_PREFIX)) continue;
    const hash = freshByKey.get(card.testId.slice(OURS_PREFIX.length));
    if (hash) covered.add(hash);
  }
  const hide = new Set<string>();
  for (const card of cards) {
    if (card.testId.startsWith(BUILTIN_PREFIX) && card.loginHash !== null && covered.has(card.loginHash)) hide.add(card.testId);
  }
  return hide;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The one text in a card that is a login email: Paseo puts the account label in the footer. */
export function loginText(texts: readonly string[]): string | null {
  const found = texts.map((t) => t.trim()).filter((t) => EMAIL.test(t));
  return found.length === 1 ? found[0]!.toLowerCase() : null;
}
