/**
 * Working alongside ZeroSub, which runs Claude and Codex agents on several
 * subscription accounts and moves an agent to another account when the CLI reports a
 * limit.
 *
 * Without this, Session Guard measures only the CLI login's usage (all Paseo and the
 * recorder can read) and applies it to every agent of that provider. Under ZeroSub
 * that pauses agents on accounts with room, and its interrupt or SIGSTOP stops the CLI
 * from ever printing the limit notice ZeroSub fails over on. So, when ZeroSub is
 * enabled, the guard reads each agent's account and that account's usage from
 * ZeroSub's own files, and leaves an agent alone while ZeroSub can move it to another
 * account with room.
 *
 * ZeroSub's files are an internal format, so everything here is parsed defensively:
 * anything unexpected reads as "no ZeroSub view", which is exactly the guard's
 * behaviour without ZeroSub. Only ids, flags, timestamps and percentages are kept —
 * never emails, and never anything from a credential file (none is opened).
 */
import type { ProviderUsage, Usage, UsageWindow } from "./policy.ts";

export type ZeroSubFamily = "claude" | "codex";

export interface ZeroSubAccount {
  readonly id: string;
  readonly family: ZeroSubFamily;
  readonly kind: "main" | "managed";
  /** A name the person chose, or null when ZeroSub derived it from the email. */
  readonly label: string | null;
  readonly signedIn: boolean;
  readonly disabled: boolean;
  readonly limitedUntil: string | null;
  readonly limitKind: "window" | "budget" | null;
}

export interface ZeroSubWindow {
  readonly id: string;
  readonly usedPct: number;
  readonly resetsAt: string | null;
  readonly minutes: number | null;
}

export interface ZeroSubReading {
  readonly fetchedAt: string;
  readonly cached: boolean;
  readonly windows: readonly ZeroSubWindow[];
}

export interface ZeroSubSnapshot {
  readonly accounts: readonly ZeroSubAccount[];
  /** Which account each agent's live session was opened on. */
  readonly sessions: Readonly<Record<string, string>>;
  /** Agents whose Codex task carries on in another tab (ZeroSub continuation chains). */
  readonly continuedElsewhere: ReadonlySet<string>;
  readonly readings: Readonly<Record<string, ZeroSubReading>>;
  /** ZeroSub's "Automatic switching" preference. */
  readonly autoSwitch: boolean;
}

/** ZeroSub's ids for the CLI's own login (`server/state.ts` `MAIN_ACCOUNT_ID`). */
const MAIN_ACCOUNT: Record<ZeroSubFamily, string> = { claude: "claude-main", codex: "codex-main" };

/** ZeroSub reads usage at least every half hour for an account in use. Older is not "room". */
export const FRESH_READING_MS = 30 * 60_000;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const family = (value: unknown): ZeroSubFamily | null => (value === "claude" || value === "codex" ? value : null);
const time = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

function parseAccount(value: unknown): ZeroSubAccount | null {
  const raw = record(value);
  const id = text(raw?.id);
  const fam = family(raw?.family);
  if (!raw || !id || !fam) return null;
  const label = text(raw.label);
  return {
    id,
    family: fam,
    kind: raw.kind === "managed" ? "managed" : "main",
    // A generated label is the email, or part of it: never repeat it.
    label: raw.autoLabel === false && label !== null && !label.includes("@") ? label : null,
    signedIn: raw.signedIn !== false,
    disabled: raw.disabled === true,
    limitedUntil: text(raw.limitedUntil),
    limitKind: raw.limitKind === "window" || raw.limitKind === "budget" ? raw.limitKind : null,
  };
}

function parseReading(value: unknown): ZeroSubReading | null {
  const raw = record(value);
  const fetchedAt = text(raw?.fetchedAt);
  if (!raw || !fetchedAt || time(fetchedAt) === null || !Array.isArray(raw.windows)) return null;
  const windows: ZeroSubWindow[] = [];
  for (const entry of raw.windows) {
    const window = record(entry);
    const id = text(window?.id);
    const usedPct = finite(window?.usedPercent);
    if (!window || !id || usedPct === null) continue;
    windows.push({ id, usedPct, resetsAt: text(window.resetsAt), minutes: finite(window.minutes) });
  }
  return { fetchedAt, cached: raw.cached === true, windows };
}

/**
 * ZeroSub's registry (`state.json`), usage readings (`usage.json`) and preferences, as
 * read from disk. Null when the registry is unusable; a missing usage file or
 * preferences file only means "no readings" and "defaults".
 */
export function parseZeroSub(state: unknown, usage: unknown, preferences: unknown): ZeroSubSnapshot | null {
  const raw = record(state);
  if (!raw || !Array.isArray(raw.accounts)) return null;
  const accounts = raw.accounts.map(parseAccount).filter((account): account is ZeroSubAccount => account !== null);
  if (accounts.length === 0) return null;

  const sessions: Record<string, string> = {};
  for (const [agentId, entry] of Object.entries(record(raw.sessions) ?? {})) {
    const accountId = text(record(entry)?.accountId);
    if (accountId) sessions[agentId] = accountId;
  }

  // A Codex task that moved on to another tab: every member but the active one.
  const continuedElsewhere = new Set<string>();
  for (const entry of Object.values(record(raw.continuations) ?? {})) {
    const chain = record(entry);
    const active = text(chain?.activeAgentId);
    if (!chain || !active) continue;
    for (const member of Object.keys(record(chain.members) ?? {})) if (member !== active) continuedElsewhere.add(member);
  }

  const readings: Record<string, ZeroSubReading> = {};
  for (const [accountId, entry] of Object.entries(record(usage) ?? {})) {
    const reading = parseReading(entry);
    if (reading) readings[accountId] = reading;
  }

  // Paseo stores plugin settings as `{ version, values }`; missing means ZeroSub's default (on).
  const values = record(record(preferences)?.values);
  return { accounts, sessions, continuedElsewhere, readings, autoSwitch: values?.autoSwitch !== false };
}

/** The ZeroSub family a Paseo provider belongs to, if ZeroSub manages it. */
export function familyOf(provider: string): ZeroSubFamily | null {
  return provider === "claude" || provider === "codex" ? provider : null;
}

/** The account an agent runs on: its live session's, else the CLI login, as ZeroSub decides. */
export function accountOf(snapshot: ZeroSubSnapshot, agentId: string, provider: string): ZeroSubAccount | null {
  const fam = familyOf(provider);
  if (!fam) return null;
  const id = snapshot.sessions[agentId] ?? MAIN_ACCOUNT[fam];
  return snapshot.accounts.find((account) => account.id === id && account.family === fam) ?? null;
}

/**
 * A ZeroSub window under the id Paseo uses for the same window, which is what the
 * guard's `windowIds` and pause anchors name. Codex windows are told apart by length.
 */
export function paseoWindowId(fam: ZeroSubFamily, window: ZeroSubWindow): string {
  if (fam === "claude") return window.id === "seven_day" ? "weekly" : window.id;
  if (window.minutes !== null) return window.minutes <= 24 * 60 ? "session" : "weekly";
  return window.id === "primary" ? "session" : window.id === "secondary" ? "weekly" : window.id;
}

const limited = (account: ZeroSubAccount, now: number) => {
  const until = time(account.limitedUntil);
  return until !== null && until > now;
};

/**
 * One account's usage as a provider row the guard reads, or an unavailable row when
 * there is no trustworthy reading. A limit the CLI reported is the freshest word on a
 * window, so it shows as full until it lifts.
 */
export function accountUsage(snapshot: ZeroSubSnapshot, account: ZeroSubAccount, now: number): ProviderUsage {
  const reading = snapshot.readings[account.id];
  if (!reading || reading.windows.length === 0) return { providerId: account.family, status: "unavailable", fetchedAt: null, windows: [] };
  const full = limited(account, now) && account.limitKind === "window";
  const windows: UsageWindow[] = reading.windows.map((window) => ({
    id: paseoWindowId(account.family, window),
    usedPct: full ? Math.max(100, window.usedPct) : window.usedPct,
    remainingPct: null,
    resetsAt: window.resetsAt,
  }));
  return { providerId: account.family, status: "available", fetchedAt: reading.fetchedAt, windows };
}

/**
 * Whether an account could take an agent right now: usable by ZeroSub's own rules
 * (signed in, not set aside, no recorded limit) and, stricter than ZeroSub, with a
 * fresh reading that shows room in every window. An account with no reading is not
 * counted: deferring to a switch onto an account that may be just as full would only
 * trade a pause for a failed turn.
 */
export function hasRoom(snapshot: ZeroSubSnapshot, account: ZeroSubAccount, thresholdPct: number, sessionWindowIds: readonly string[], now: number): boolean {
  if (!account.signedIn || account.disabled || limited(account, now)) return false;
  const reading = snapshot.readings[account.id];
  const fetched = time(reading?.fetchedAt);
  if (!reading || fetched === null || now - fetched > FRESH_READING_MS || reading.windows.length === 0) return false;
  return reading.windows.every((window) => {
    const limit = sessionWindowIds.includes(paseoWindowId(account.family, window)) ? thresholdPct : 100;
    return window.usedPct < limit;
  });
}

/** Other accounts of the agent's provider that ZeroSub could move it to now. */
export function accountsWithRoom(snapshot: ZeroSubSnapshot, current: ZeroSubAccount, thresholdPct: number, sessionWindowIds: readonly string[], now: number): number {
  return snapshot.accounts.filter((account) =>
    account.family === current.family && account.id !== current.id && hasRoom(snapshot, account, thresholdPct, sessionWindowIds, now)).length;
}

/** The view Session Guard's engine asks, once per pass. */
export interface AccountView {
  /** Usage as the agent's own account sees it. */
  usageFor(agentId: string, provider: string): Usage;
  /** ZeroSub will move this agent to another account with room when its account hits the limit. */
  failsOver(agentId: string, provider: string): boolean;
  /** ZeroSub already carries this agent's Codex task on in another tab. */
  continuedElsewhere(agentId: string): boolean;
}

export function accountView(
  snapshot: ZeroSubSnapshot,
  usage: Usage,
  policy: { thresholdPct: number; windowIds: readonly string[] },
  now: number,
): AccountView {
  return {
    usageFor(agentId, provider) {
      const account = accountOf(snapshot, agentId, provider);
      // The CLI login is what Paseo and the recorder already measure, and measure more often.
      if (!account || account.kind === "main") return usage;
      const own = accountUsage(snapshot, account, now);
      return { ...usage, providers: [...usage.providers.filter((p) => p.providerId !== provider), { ...own, providerId: provider }] };
    },
    failsOver(agentId, provider) {
      if (!snapshot.autoSwitch) return false;
      const account = accountOf(snapshot, agentId, provider);
      return account !== null && accountsWithRoom(snapshot, account, policy.thresholdPct, policy.windowIds, now) > 0;
    },
    continuedElsewhere: (agentId) => snapshot.continuedElsewhere.has(agentId),
  };
}

/** What `budget_status` says about the account an agent's numbers describe. */
export interface BudgetAccount {
  /** `main` is the CLI's own login, which the recorder measures; `managed` is one ZeroSub added. */
  readonly kind: "main" | "managed";
  readonly label: string | null;
  /** Other accounts of the same provider ZeroSub could move the agent to now. */
  readonly otherAccountsWithRoom: number;
  readonly autoSwitch: boolean;
  /** For a managed account: ZeroSub's reading of it, which replaces the recorder's numbers. */
  readonly reading: { readonly fetchedAt: string; readonly windows: readonly { readonly id: string; readonly pct: number; readonly resetsAt: string | null }[] } | null;
}

/** The Claude account behind an agent's budget, as ZeroSub routes it. */
export function budgetAccount(snapshot: ZeroSubSnapshot, agentId: string, now: number): BudgetAccount | null {
  const account = accountOf(snapshot, agentId, "claude");
  if (!account) return null;
  const reading = account.kind === "managed" ? snapshot.readings[account.id] : undefined;
  return {
    kind: account.kind,
    label: account.label,
    otherAccountsWithRoom: accountsWithRoom(snapshot, account, 100, [], now),
    autoSwitch: snapshot.autoSwitch,
    reading: reading
      ? { fetchedAt: reading.fetchedAt, windows: reading.windows.map((window) => ({ id: window.id, pct: window.usedPct, resetsAt: window.resetsAt })) }
      : null,
  };
}
