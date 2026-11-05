/**
 * Every ZeroSub subscription's history and status, read-only.
 *
 * The recorder already keeps the CLI login's plan usage (`usage-*.jsonl`). Under
 * ZeroSub the other accounts' readings exist only as the latest copy in ZeroSub's own
 * `usage.json`, overwritten in place. So each new one is kept here in
 * `accounts-*.jsonl`, keyed by ZeroSub's account id (never an email), which gives
 * every account a pace and a forecast. ZeroSub's files are only read: nothing here
 * writes them, opens an account home, or asks ZeroSub for a refresh, a switch or a
 * reset.
 */

import { readAgents, withDaemon } from "./daemon.ts";
import { readZeroSub } from "./guard/zerosub.ts";
import { appendAccount, readAccounts, readUsage, type AccountSample } from "./store.ts";
import { burnRatePctPerHour, segmentBlocks, thinPoints } from "../shared/blocks.ts";
import { accountOf, type ZeroSubAccount, type ZeroSubReading, type ZeroSubSnapshot, type ZeroSubWindow } from "../shared/guard/zerosub.ts";
import { STALE_AFTER_MS, poolForecast, subscriptionName, type Subscription, type SubscriptionWindow } from "../shared/subscriptions.ts";
import { canonicalWindowId, effectiveAt, type UsageSample } from "../shared/usage.ts";

const DAY = 24 * 60 * 60_000;
/** Enough history for an open week and its pace. */
const HISTORY_MS = 8 * DAY;
/** The CLI's own Claude login: the recorder measures it, and more often than ZeroSub. */
const RECORDED_ACCOUNT = "claude-main";

/**
 * A ZeroSub window under Smart Session's ids: `five_hour` and `seven_day` for both
 * families (Codex's are told apart by length), so one set of rules reads both.
 */
export function canonicalAccountWindow(family: "claude" | "codex", window: ZeroSubWindow): string {
  if (family === "claude") return canonicalWindowId(window.id);
  if (window.minutes !== null) return window.minutes <= 6 * 60 ? "five_hour" : window.minutes >= 6 * DAY / 60_000 ? "seven_day" : window.id;
  return window.id === "primary" ? "five_hour" : window.id === "secondary" ? "seven_day" : window.id;
}

/** ZeroSub's reading as an account sample, with the window ids Smart Session uses. */
export function accountSample(account: ZeroSubAccount, reading: ZeroSubReading, at: string): AccountSample {
  const windows: Record<string, { pct: number; resetsAt: string | null }> = {};
  for (const window of reading.windows) windows[canonicalAccountWindow(account.family, window)] = { pct: window.usedPct, resetsAt: window.resetsAt };
  return { at, fetchedAt: reading.fetchedAt, src: "zerosub", account: null, accountId: account.id, family: account.family, windows, credits: null };
}

/** The newest reading already kept per account; filled from the log on first use. */
let lastKept: Map<string, string> | null = null;

/**
 * Keeps every new ZeroSub reading. Runs on the recorder's tick; costs three small file
 * reads when nothing changed and nothing at all without ZeroSub.
 */
export async function recordAccounts(now = Date.now()): Promise<number> {
  const snapshot = await readZeroSub();
  if (snapshot === null) return 0;
  if (lastKept === null) {
    lastKept = new Map();
    for (const row of await readAccounts({ sinceMs: now - HISTORY_MS })) {
      const previous = lastKept.get(row.accountId);
      if (row.fetchedAt && (!previous || Date.parse(row.fetchedAt) > Date.parse(previous))) lastKept.set(row.accountId, row.fetchedAt);
    }
  }
  let kept = 0;
  for (const account of snapshot.accounts) {
    if (account.id === RECORDED_ACCOUNT) continue;
    const reading = snapshot.readings[account.id];
    if (!reading || reading.windows.length === 0) continue;
    const previous = lastKept.get(account.id);
    if (previous && Date.parse(reading.fetchedAt) <= Date.parse(previous)) continue;
    await appendAccount(accountSample(account, reading, new Date(now).toISOString()));
    lastKept.set(account.id, reading.fetchedAt);
    kept += 1;
  }
  return kept;
}

export function forgetAccounts(): void {
  lastKept = null;
  cached = null;
}

/** One account's windows from its history, with the live reading as the newest point. */
export function windowsFrom(samples: readonly UsageSample[], readAt: string | null, now: number): { windows: SubscriptionWindow[]; history: { t: string; pct: number }[] } {
  const open = new Map<string, ReturnType<typeof segmentBlocks>[number]>();
  for (const block of segmentBlocks(samples)) open.set(block.windowId, block);
  const fresh = readAt !== null && now - Date.parse(readAt) <= STALE_AFTER_MS;
  const windows = [...open.values()].map((block) => ({
    id: block.windowId,
    pct: block.finalPct,
    resetsAt: block.resetsAt,
    // A rate measured hours ago is not the pace now.
    burnPctPerHour: fresh ? burnRatePctPerHour(block) : null,
  }));
  const session = open.get("five_hour");
  return { windows, history: session ? thinPoints(session.points, 48) : [] };
}

export interface SubscriptionsView {
  readonly zerosub: boolean;
  readonly autoSwitch: boolean;
  readonly accounts: Subscription[];
  /** Which account each live agent runs on. */
  readonly agents: Record<string, string>;
}

const NONE: SubscriptionsView = { zerosub: false, autoSwitch: false, accounts: [], agents: {} };

export function buildView(
  snapshot: ZeroSubSnapshot,
  input: { recorded: readonly UsageSample[]; accountRows: readonly AccountSample[]; liveAgents: readonly { id: string; provider: string }[] },
  now: number,
): SubscriptionsView {
  const agents: Record<string, string> = {};
  const counts = new Map<string, number>();
  for (const agent of input.liveAgents) {
    const account = accountOf(snapshot, agent.id, agent.provider);
    if (!account) continue;
    agents[agent.id] = account.id;
    counts.set(account.id, (counts.get(account.id) ?? 0) + 1);
  }
  const defaults = (family: "claude" | "codex") => {
    const chosen = snapshot.defaults[family];
    const ofFamily = snapshot.accounts.filter((a) => a.family === family);
    return ofFamily.find((a) => a.id === chosen)?.id ?? ofFamily.find((a) => a.kind === "main")?.id ?? ofFamily[0]?.id ?? null;
  };

  const accounts = snapshot.accounts.map((account): Subscription => {
    const reading = snapshot.readings[account.id];
    const own = input.accountRows.filter((row) => row.accountId === account.id) as unknown as UsageSample[];
    const live = reading ? [accountSample(account, reading, new Date(now).toISOString()) as unknown as UsageSample] : [];
    // The CLI login's windows come from the recorder when it has them: fresher, and with history.
    const recorded = account.id === RECORDED_ACCOUNT && input.recorded.length > 0;
    const samples = recorded ? input.recorded : [...own, ...live];
    const readAt = recorded ? effectiveAt(input.recorded[input.recorded.length - 1]!) : reading?.fetchedAt ?? null;
    const { windows, history } = windowsFrom(samples, readAt, now);
    const { name, named } = subscriptionName(account, snapshot.accounts);
    return {
      id: account.id,
      family: account.family,
      kind: account.kind,
      name,
      named,
      isDefault: defaults(account.family) === account.id,
      signedIn: account.signedIn,
      disabled: account.disabled,
      limitedUntil: account.limitedUntil,
      createdAt: account.createdAt,
      agents: counts.get(account.id) ?? 0,
      readAt,
      windows,
      credits: reading?.credits ?? null,
      history,
    };
  });
  return { zerosub: true, autoSwitch: snapshot.autoSwitch, accounts, agents };
}

/** Several clients poll this; the answer is good for a few seconds. */
let cached: { at: number; view: SubscriptionsView } | null = null;
const CACHE_MS = 10_000;

export async function subscriptionsView(now = Date.now()): Promise<SubscriptionsView> {
  if (cached && now - cached.at < CACHE_MS) return cached.view;
  const snapshot = await readZeroSub();
  if (snapshot === null) {
    cached = { at: now, view: NONE };
    return NONE;
  }
  const since = now - HISTORY_MS;
  const [recorded, accountRows, liveAgents] = await Promise.all([
    readUsage({ sinceMs: since }),
    readAccounts({ sinceMs: since }),
    withDaemon((client) => readAgents(client)).then((rows) => rows.filter((row) => row.status !== "closed")).catch(() => []),
  ]);
  const view = buildView(snapshot, { recorded, accountRows, liveAgents }, now);
  cached = { at: now, view };
  return view;
}

/**
 * What `budget_status` adds for an agent under ZeroSub when its provider has several
 * subscriptions: the pool, by name. Null without ZeroSub or with one account.
 */
export async function budgetPool(agentId: string | undefined, now = Date.now()) {
  const view = await subscriptionsView(now);
  if (!view.zerosub) return null;
  const own = agentId === undefined ? undefined : view.accounts.find((a) => a.id === view.agents[agentId]);
  const family = own?.family ?? "claude";
  const mine = view.accounts.filter((a) => a.family === family);
  if (mine.length < 2) return null;
  const pool = poolForecast(view.accounts, family, now, { autoSwitch: view.autoSwitch });
  const name = (id: string | null) => mine.find((a) => a.id === id)?.name ?? "another account";
  const at = (ms: number) => new Date(ms).toISOString();
  const next = pool.takeovers[0];
  return {
    family,
    accounts: pool.total,
    withRoom: pool.withRoom,
    pacePctPerHour: pool.pace === null ? null : Math.round(pool.pace * 10) / 10,
    runsOutAt: pool.runsOutAt === null ? null : at(pool.runsOutAt),
    next: next ? { name: name(next.accountId), at: at(next.at) } : null,
    back: pool.backAt === null ? null : { name: name(pool.backAccount), at: at(pool.backAt) },
    staleReadings: pool.stale,
  };
}
