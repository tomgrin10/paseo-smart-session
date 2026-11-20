/**
 * The Accounts report, read from the logs: each account's weekly and 5-hour readings, its Extra
 * usage, and the account-use logs (holds, placement, moves), handed to the pure rules in
 * `shared/accounts-report.ts`. Read-only: nothing here writes a log or touches ZeroSub.
 *
 * Whose readings are whose (invariant `usage-account-identity`): the main account's come from
 * `usage-*.jsonl`, but only rows that say they are the CLI login's (`login: "cli"`), or, from before
 * those labels, the `upstream` source, which only ever read the CLI's own credentials (the `paseo`
 * source mixed logins). Every other account's come from `accounts-*.jsonl`.
 */

import { readZeroSub } from "./guard/zerosub.ts";
import { readSettings } from "./settings.ts";
import { readAccountLog, readAccounts, readUsage, type AccountSample } from "./store.ts";
import { accountsReport, type AccountSeries, type AccountsReport, type HoldSpan, type MoveEvent, type PlacementSample, type ReportInput, type SeriesReading } from "../shared/accounts-report.ts";
import type { CreditsRow, HoldRow, MoveRow, PlacementRow } from "../shared/account-log.ts";
import { familyOf, type ZeroSubSnapshot } from "../shared/guard/zerosub.ts";
import { subscriptionName } from "../shared/subscriptions.ts";
import { effectiveAt, type UsageSample } from "../shared/usage.ts";

const DAY = 24 * 60 * 60_000;
/** The report's period. */
export const REPORT_DAYS = 14;
/** Readings from before the period: a window that resets inside it started up to a week earlier. */
const LOOKBACK_MS = (REPORT_DAYS + 8) * DAY;
const RECORDED_ACCOUNT = "claude-main";

/** A main-account usage row the report may trust as the CLI login's (see the header). */
export const trustedMainRow = (row: UsageSample) => row.login === "cli" || (row.login === undefined && row.src === "upstream");

const t = (iso: string | null | undefined) => {
  const v = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(v) ? v : null;
};

function readingsOf(rows: readonly { at: string; fetchedAt: string | null; windows: UsageSample["windows"] }[]): SeriesReading[] {
  const out: SeriesReading[] = [];
  for (const row of rows) {
    const at = t(effectiveAt(row as UsageSample));
    if (at === null) continue;
    const w = row.windows?.seven_day;
    const s = row.windows?.five_hour;
    if (!w && !s) continue;
    out.push({
      t: at,
      weekly: w && typeof w.pct === "number" ? { pct: w.pct, resetsAt: w.resetsAt ?? null } : null,
      session: s && typeof s.pct === "number" ? { pct: s.pct, resetsAt: s.resetsAt ?? null } : null,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface ReportLogs {
  readonly usage: readonly UsageSample[];
  readonly accounts: readonly AccountSample[];
  readonly holds: readonly HoldRow[];
  readonly placement: readonly PlacementRow[];
  readonly moves: readonly MoveRow[];
  readonly credits: readonly CreditsRow[];
}

/**
 * The report's input for one family, from the logs as read. Pure. Without ZeroSub the CLI login is
 * the only account (`<family>-cli`, the placement log's key), and only Claude has one.
 */
export function reportInput(snapshot: ZeroSubSnapshot | null, logs: ReportLogs, family: "claude" | "codex", now: number): ReportInput | null {
  const accounts: AccountSeries[] = [];
  const spendFromCredits = (id: string) => logs.credits
    .filter((row) => row.accountId === id && row.extraUsage?.enabled && typeof row.extraUsage.spend === "number")
    .map((row) => ({ t: t(row.fetchedAt) ?? Date.parse(row.at), minor: row.extraUsage!.spend! }));
  const mainRows = logs.usage.filter(trustedMainRow);
  const mainSeries = (id: string, name: string, disabled: boolean): AccountSeries => {
    const fromUsage = mainRows
      .filter((row) => row.credits !== null && row.credits !== undefined && row.credits.enabled !== false && typeof row.credits.usedMinor === "number")
      .map((row) => ({ t: Date.parse(effectiveAt(row)), minor: row.credits!.usedMinor }));
    // One source per account: two of them interleaved would read as spending and refunds.
    return { id, name, main: true, disabled, readings: readingsOf(mainRows), spend: fromUsage.length > 0 ? fromUsage : spendFromCredits(id) };
  };

  if (snapshot === null) {
    if (family !== "claude" || mainRows.length === 0) return null;
    accounts.push(mainSeries("claude-cli", "Main", false));
  } else {
    const ofFamily = snapshot.accounts.filter((a) => a.family === family);
    if (ofFamily.length === 0) return null;
    for (const account of ofFamily) {
      const { name } = subscriptionName(account, snapshot.accounts);
      if (account.id === RECORDED_ACCOUNT && mainRows.length > 0) {
        accounts.push(mainSeries(account.id, name, account.disabled));
        continue;
      }
      const rows = logs.accounts.filter((row) => row.accountId === account.id);
      accounts.push({
        id: account.id, name, main: account.kind === "main", disabled: account.disabled,
        readings: readingsOf(rows), spend: spendFromCredits(account.id),
      });
    }
  }

  const ofFamily = (provider: string | null | undefined) => provider !== null && provider !== undefined && familyOf(provider) === family;
  const holdsById = new Map<string, { accountId: string | null; from: number; to: number | null }>();
  for (const row of logs.holds) {
    if (!ofFamily(row.provider) || typeof row.pauseId !== "string") continue;
    const from = t(row.pausedAt) ?? Date.parse(row.at);
    const held = holdsById.get(row.pauseId) ?? { accountId: row.accountId ?? null, from, to: null };
    held.from = Math.min(held.from, from);
    if (row.accountId) held.accountId = row.accountId;
    if (row.event === "end") held.to = Date.parse(row.at);
    holdsById.set(row.pauseId, held);
  }
  const holds: HoldSpan[] = [...holdsById].map(([pauseId, h]) => ({ pauseId, ...h }));
  const ids = new Set(accounts.map((a) => a.id));
  const placement: PlacementSample[] = logs.placement.map((row) => {
    const running: Record<string, number> = {};
    for (const [id, counts] of Object.entries(row.accounts ?? {})) if (ids.has(id)) running[id] = counts?.running ?? 0;
    return { t: Date.parse(row.at), running };
  });
  const moves: MoveEvent[] = logs.moves.filter((row) => row.family === family || ids.has(row.to))
    .map((row) => ({ t: Date.parse(row.at), from: row.from, to: row.to, reason: row.reason }));
  const first = (rows: readonly { at: string }[]) => rows.length === 0 ? null : Math.min(...rows.map((r) => Date.parse(r.at)).filter(Number.isFinite));
  return {
    family,
    accounts,
    holds,
    placement,
    moves,
    // The logs began together (3.8.0-beta.9); a family with no hold yet was still being watched.
    since: { holds: first(logs.placement), placement: first(logs.placement), moves: first(logs.placement) },
    now,
    days: REPORT_DAYS,
  };
}

/** Several clients poll this, and it reads three weeks of logs: good for five minutes. */
let cached: { at: number; reports: AccountsReport[] } | null = null;
const CACHE_MS = 5 * 60_000;

/** One report per family with accounts, Claude first. */
export async function accountsReports(now = Date.now()): Promise<AccountsReport[]> {
  if (cached && now - cached.at < CACHE_MS) return cached.reports;
  const since = now - LOOKBACK_MS;
  const [snapshot, usage, accounts, holds, placement, moves, credits, settings] = await Promise.all([
    readZeroSub(),
    readUsage({ sinceMs: since }),
    readAccounts({ sinceMs: since }),
    readAccountLog<HoldRow>("holds", { sinceMs: since }),
    readAccountLog<PlacementRow>("placement", { sinceMs: since }),
    readAccountLog<MoveRow>("moves", { sinceMs: since }),
    readAccountLog<CreditsRow>("credits", { sinceMs: since }),
    readSettings(),
  ]);
  const logs = { usage, accounts, holds, placement, moves, credits };
  const reports: AccountsReport[] = [];
  for (const family of ["claude", "codex"] as const) {
    const input = reportInput(snapshot, logs, family, now);
    if (input !== null && input.accounts.some((a) => a.readings.length > 0)) reports.push(accountsReport(input, settings.accountsReport));
  }
  cached = { at: now, reports };
  return reports;
}

export function forgetAccountsReport(): void {
  cached = null;
}
