/**
 * Smart placement beside ZeroSub: each minute, what the shipped rule (`shared/placement.ts`)
 * would do on the real state, written to `decisions-YYYY-MM.jsonl`, and the summary that compares
 * it with what actually happened. Pure; `server/placement.ts` reads, writes and (live) acts.
 *
 * Shadow mode changes nothing: the rule sees the real accounts and sessions, never a world of its
 * own, so every decision is "on this state, the rule would have…". Live mode acts only through
 * ZeroSub's `move_before_limit`, never a default flip or a reconcile.
 *
 * Rows carry ids, flags, times and numbers only (the account-use logs' rule).
 */

import { DEFAULT_SESSION_RATE, DEFAULT_SESSION_RATIO, type ReplayAccount } from "./accounts-report.ts";
import type { MoveRow, HoldRow } from "./account-log.ts";
import { accountOf, familyOf, FRESH_READING_MS, type ZeroSubSnapshot } from "./guard/zerosub.ts";
import { expiringFirst, placementMoves, type MoveProposal, type PlacementContext } from "./placement.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export type PlacementMode = "off" | "shadow" | "live";
export const PLACEMENT_MODES: readonly PlacementMode[] = ["off", "shadow", "live"];
/** Shadow by default: it only writes a log. */
export const DEFAULT_PLACEMENT_MODE: PlacementMode = "shadow";
export const placementMode = (value: unknown): PlacementMode =>
  value === "off" || value === "shadow" || value === "live" ? value : DEFAULT_PLACEMENT_MODE;

/** Today's move guards (the fork's pace mode): spacing between moves, and per-session cooldown. */
export const MOVE_SPACING_MS = 10 * MINUTE;
export const MOVE_COOLDOWN_MS = 6 * HOUR;
/** A move ahead of a wall counts as avoiding a forced move that comes within this long. */
export const AVOID_WINDOW_MS = HOUR;
/** The 5-hour burn is the change over about this long (the forecast's "last half hour"). */
const BURN_WINDOW_MS = 30 * MINUTE;
/** A context of unknown size, for the move cost. */
const UNKNOWN_CONTEXT = 100_000;

/** What ZeroSub on this host offers live placement. */
export interface LiveLevers {
  /** `zerosub.agents.move_before_limit` exists: a one-agent move we can ask for. */
  readonly moveBeforeLimit: boolean;
  /** ZeroSub's own rebalancing (the fork's `paceWeeklyUsage`) is on: two policies would fight. */
  readonly ownRebalancing: boolean;
}

/** Why live mode can't run here, or null when it can. */
export function liveRefusal(zerosub: boolean, levers: LiveLevers | null): string | null {
  if (!zerosub) return "Live placement needs ZeroSub, which isn't enabled here.";
  if (levers === null || !levers.moveBeforeLimit) return "Live placement needs ZeroSub's move_before_limit, which the installed ZeroSub doesn't have. Staying in shadow.";
  if (levers.ownRebalancing) return "ZeroSub's own pacing is on, and two rules moving sessions would fight. Turn ZeroSub's pacing off first. Staying in shadow.";
  return null;
}

/** `decisions-YYYY-MM.jsonl`: one row per decision the rule made. */
export type DecisionRow =
  | {
    readonly at: string;
    readonly kind: "place";
    readonly mode: "shadow" | "live";
    readonly agentId: string;
    /** Where ZeroSub put the new session. */
    readonly actual: string;
    /** Where the rule would have. */
    readonly pick: string | null;
  }
  | {
    readonly at: string;
    readonly kind: "move";
    readonly mode: "shadow" | "live";
    readonly agentId: string;
    readonly from: string;
    readonly to: string;
    readonly reason: MoveProposal["reason"];
    readonly gain: number;
    readonly cost: number;
    /** Live only: ZeroSub's answer to the move (`moved`, `refused:…`, `failed`). */
    readonly outcome?: string;
  }
  | {
    readonly at: string;
    readonly kind: "forced";
    readonly mode: "shadow" | "live";
    readonly agentId: string;
    readonly from: string | null;
    readonly to: string;
    /** The rule had moved (or would have moved) this session ahead of the wall within the hour before. */
    readonly foreseen: boolean;
  };

/** What one process remembers between ticks. */
export interface ShadowState {
  readonly lastMoveAt: number | null;
  /** agentId → when the rule last moved it (shadow: would have). */
  readonly movedAt: Readonly<Record<string, number>>;
  /** agentId → when the rule last flagged it ahead of a 5-hour wall. */
  readonly flagged: Readonly<Record<string, number>>;
  /** accountId → recent 5-hour readings, for the burn. */
  readonly samples: Readonly<Record<string, readonly { readonly t: number; readonly pct: number; readonly resetsAt: string | null }[]>>;
}

export const EMPTY_SHADOW: ShadowState = { lastMoveAt: null, movedAt: {}, flagged: {}, samples: {} };

/** An open agent as the recorder lists it. */
export interface ShadowAgent {
  readonly id: string;
  readonly provider: string;
  readonly status: string;
  readonly usedTokens: number | null;
}

const ms = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};
const windowOf = (snapshot: ZeroSubSnapshot, accountId: string, id: string) =>
  snapshot.readings[accountId]?.windows.find((w) => w.id === id) ?? null;

/**
 * One tick. `moves` are the moves log's rows from this tick (ZeroSub's real moves). Returns the rows
 * to write, the next state, and, when the rule wants a move, the move (live acts on it).
 */
export function shadowTick(input: {
  readonly snapshot: ZeroSubSnapshot;
  readonly agents: readonly ShadowAgent[];
  readonly moves: readonly MoveRow[];
  readonly sizes: Readonly<Record<string, number>>;
  readonly mode: "shadow" | "live";
  readonly state: ShadowState;
  readonly now: number;
}): { rows: DecisionRow[]; state: ShadowState; move: MoveProposal & { agentId: string; fromId: string; toId: string } | null } {
  const { snapshot, agents, moves, sizes, mode, now } = input;
  const at = new Date(now).toISOString();
  const claude = snapshot.accounts.filter((a) => a.family === "claude");
  const rows: DecisionRow[] = [];

  // The 5-hour burn per account, from this process's own recent readings.
  const samples: Record<string, { t: number; pct: number; resetsAt: string | null }[]> = {};
  const burn5 = new Map<string, number>();
  for (const account of claude) {
    const w = windowOf(snapshot, account.id, "five_hour");
    const kept = (input.state.samples[account.id] ?? []).filter((s) => now - s.t <= 2 * BURN_WINDOW_MS);
    if (w !== null) kept.push({ t: now, pct: w.usedPct, resetsAt: w.resetsAt });
    samples[account.id] = kept;
    const base = kept.find((s) => now - s.t >= BURN_WINDOW_MS * 0.5 && s.resetsAt === w?.resetsAt);
    const rate = base === undefined || w === null ? 0 : Math.max(0, (w.usedPct - base.pct) / ((now - base.t) / HOUR));
    burn5.set(account.id, rate);
  }

  // The accounts as the rule sees them. A stale or missing reading, a limit, sign-out or set-aside is no room.
  const accounts: ReplayAccount[] = claude.map((account) => {
    const reading = snapshot.readings[account.id];
    const fresh = reading !== undefined && now - (ms(reading.fetchedAt) ?? 0) <= FRESH_READING_MS;
    const weekly = windowOf(snapshot, account.id, "seven_day");
    const session = windowOf(snapshot, account.id, "five_hour");
    const limited = (ms(account.limitedUntil) ?? 0) > now;
    return {
      id: account.id,
      size: sizes[account.id] ?? 1,
      ratio: DEFAULT_SESSION_RATIO,
      weeklyPct: weekly?.usedPct ?? 0,
      weeklyResetAt: ms(weekly?.resetsAt),
      sessionPct: session?.usedPct ?? 0,
      sessionResetAt: ms(session?.resetsAt),
      usable: fresh && weekly !== null && account.signedIn && !account.disabled && !limited,
    };
  });
  const index = new Map(accounts.map((a, i) => [a.id, i]));

  // Sessions on each account, and the burn as the rule's units (weekly points an hour).
  const onAccount = new Map<string, ShadowAgent[]>();
  for (const agent of agents) {
    if (agent.status === "closed" || familyOf(agent.provider) !== "claude") continue;
    const account = accountOf(snapshot, agent.id, agent.provider);
    if (account === null || !index.has(account.id)) continue;
    (onAccount.get(account.id) ?? onAccount.set(account.id, []).get(account.id)!).push(agent);
  }
  const running = (id: string) => (onAccount.get(id) ?? []).filter((a) => a.status === "running" || a.status === "initializing").length;
  const burn = accounts.map((a) => ((burn5.get(a.id) ?? 0) * a.size) / a.ratio);
  const totalRunning = accounts.reduce((s, a) => s + running(a.id), 0);
  const totalBurn = burn.reduce((s, b) => s + b, 0);
  const ctx: PlacementContext = {
    sessionRate: totalRunning > 0 && totalBurn > 0 ? totalBurn / totalRunning : DEFAULT_SESSION_RATE,
    burn,
    poolRate: totalBurn,
  };
  const policy = expiringFirst();

  // New sessions ZeroSub placed this minute: where the rule would have put them.
  for (const m of moves) {
    if (m.family !== "claude" || m.from !== null) continue;
    const pick = policy(accounts, now, ctx)[0];
    rows.push({ at, kind: "place", mode, agentId: m.agentId, actual: m.to, pick: pick === undefined ? null : accounts[pick]!.id });
  }

  // ZeroSub's forced moves (its failover at a limit binds `auto`; an unbound move off a limited
  // account logs `limit`): did the rule see them coming?
  for (const m of moves) {
    if (m.family !== "claude" || m.from === null || !isForced(m.reason)) continue;
    const flaggedAt = input.state.flagged[m.agentId];
    rows.push({ at, kind: "forced", mode, agentId: m.agentId, from: m.from, to: m.to, foreseen: flaggedAt !== undefined && now - flaggedAt <= AVOID_WINDOW_MS });
  }

  // One move, under today's guards: idle sessions only, never a manual pin, spacing and cooldown.
  let move: (MoveProposal & { agentId: string; fromId: string; toId: string }) | null = null;
  const movedAt = { ...input.state.movedAt };
  const flagged = Object.fromEntries(Object.entries(input.state.flagged).filter(([, t]) => now - t <= AVOID_WINDOW_MS));
  let lastMoveAt = input.state.lastMoveAt;
  if (lastMoveAt === null || now - lastMoveAt >= MOVE_SPACING_MS) {
    const candidates = [];
    for (const [accountId, list] of onAccount) {
      for (const agent of list) {
        if (agent.status !== "idle") continue;
        if (snapshot.bindings?.[agent.id]?.source === "user") continue;
        const opened = ms(snapshot.openedAt[agent.id]);
        const last = Math.max(movedAt[agent.id] ?? -Infinity, opened ?? -Infinity);
        if (now - last < MOVE_COOLDOWN_MS) continue;
        candidates.push({ id: agent.id, account: index.get(accountId)!, contextTokens: agent.usedTokens ?? UNKNOWN_CONTEXT });
      }
    }
    const proposal = placementMoves(policy)(accounts, candidates, now, ctx);
    if (proposal !== null) {
      const fromId = accounts[proposal.from]!.id;
      const toId = accounts[proposal.to]!.id;
      move = { ...proposal, agentId: proposal.session, fromId, toId };
      lastMoveAt = now;
      movedAt[proposal.session] = now;
      if (proposal.reason === "five-hour") flagged[proposal.session] = now;
      rows.push({ at, kind: "move", mode, agentId: proposal.session, from: fromId, to: toId, reason: proposal.reason, gain: round3(proposal.gain), cost: round3(proposal.cost) });
    }
  }
  for (const [id, t] of Object.entries(movedAt)) if (now - t > MOVE_COOLDOWN_MS) delete movedAt[id];
  return { rows, state: { lastMoveAt, movedAt, flagged, samples }, move };
}

/** A move ZeroSub made because an account was out, not by choice. */
export const isForced = (reason: string) => reason === "limit" || reason === "auto";

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Shadow beside reality, over the report's window: what Tom judges the rule by. */
export interface PlacementSummary {
  readonly mode: PlacementMode;
  /** Why live isn't running, when it was asked for or isn't possible. */
  readonly liveRefusal: string | null;
  /** The first decision in the window; null before any. */
  readonly since: string | null;
  readonly placed: { readonly total: number; readonly differently: number };
  readonly moves: { readonly aheadOfWall: number; readonly rebalance: number };
  /** ZeroSub's forced moves (at a limit), and how many the rule foresaw within the hour before. */
  readonly forced: { readonly total: number; readonly foreseen: number };
  /** Turns Session Guard stopped at a limit (holds starting for a limit), and the waiting they cost. */
  readonly actual: { readonly cutOffs: number; readonly waitingHours: number };
}

export function placementSummary(rows: readonly DecisionRow[], holds: readonly HoldRow[], from: number, now: number, mode: PlacementMode, refusal: string | null): PlacementSummary {
  const inWindow = rows.filter((r) => { const t = Date.parse(r.at); return t >= from && t <= now; });
  const since = inWindow.reduce<number | null>((m, r) => { const t = Date.parse(r.at); return m === null || t < m ? t : m; }, null);
  const place = inWindow.filter((r): r is Extract<DecisionRow, { kind: "place" }> => r.kind === "place");
  const moved = inWindow.filter((r): r is Extract<DecisionRow, { kind: "move" }> => r.kind === "move");
  const forced = inWindow.filter((r): r is Extract<DecisionRow, { kind: "forced" }> => r.kind === "forced");
  // Holds compared only over the stretch the rule was watching.
  const start = since ?? now;
  const byPause = new Map<string, { from: number; to: number | null; reason: string }>();
  for (const h of holds) {
    if (h.provider !== "claude") continue;
    const cur = byPause.get(h.pauseId) ?? { from: Date.parse(h.pausedAt) || Date.parse(h.at), to: null, reason: h.reason };
    if (h.event === "end") cur.to = Date.parse(h.at);
    byPause.set(h.pauseId, cur);
  }
  let cutOffs = 0;
  let waiting = 0;
  for (const h of byPause.values()) {
    if (h.reason !== "limit" && h.reason !== "quota-failure") continue;
    const to = Math.min(h.to ?? now, now);
    if (to <= start || h.from > now) continue;
    if (h.from >= start) cutOffs += 1;
    waiting += Math.max(0, to - Math.max(h.from, start)) / HOUR;
  }
  return {
    mode,
    liveRefusal: refusal,
    since: since === null ? null : new Date(since).toISOString(),
    placed: { total: place.length, differently: place.filter((p) => p.pick !== null && p.pick !== p.actual).length },
    moves: { aheadOfWall: moved.filter((m) => m.reason === "five-hour").length, rebalance: moved.filter((m) => m.reason !== "five-hour").length },
    forced: { total: forced.length, foreseen: forced.filter((f) => f.foreseen).length },
    actual: { cutOffs, waitingHours: Math.round(waiting * 10) / 10 },
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The Accounts section's one line, and the text report's. */
export function placementLine(s: PlacementSummary): string {
  if (s.mode === "off") return "Smart placement: off.";
  const verb = s.mode === "live" && s.liveRefusal === null ? "moved" : "would have moved";
  if (s.since === null) return `Smart placement (${s.mode === "live" && s.liveRefusal === null ? "live" : "shadow"}): watching; nothing to compare yet.${s.mode === "live" && s.liveRefusal !== null ? ` ${s.liveRefusal}` : ""}`;
  const parts = [
    `${verb} ${plural(s.moves.aheadOfWall, "session")} ahead of a 5-hour wall`,
    s.forced.total > 0 ? `${s.forced.foreseen} of ${plural(s.forced.total, "forced move")} seen coming` : "no forced moves",
    `${s.placed.differently} of ${plural(s.placed.total, "new session")} placed elsewhere`,
  ];
  if (s.moves.rebalance > 0) parts.push(`${plural(s.moves.rebalance, "rebalance")}`);
  const actual = `Actual: ${plural(s.actual.cutOffs, "turn")} stopped at a limit, ${s.actual.waitingHours} h waiting.`;
  const refused = s.mode === "live" && s.liveRefusal !== null ? ` ${s.liveRefusal}` : "";
  return `Smart placement (${s.mode === "live" && s.liveRefusal === null ? "live" : "shadow"}, since ${shortDate(s.since)}): ${parts.join("; ")}. ${actual}${refused}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso: string) => { const d = new Date(iso); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
