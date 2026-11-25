/**
 * ZeroSub's `zerosub.agents.move_before_limit` reply, read one way whichever ZeroSub answered
 * (`move-contract`, AGENTS.md).
 *
 * - The reviewed contract (ZeroSub 1.31.0+, and the fork's 1.31.0-pace.16) says `reason`,
 *   `retryable` and `accountId` (the account the live session runs on when it answers). Its
 *   `waiting` queues NOTHING: the caller asks again once the turn or the background work ends.
 *   `pending` means the reload outlasted the answer; `moved` only when the session runs on the
 *   target, and `refused` + `landed_elsewhere` when routing opened it on another account.
 * - An older ZeroSub (1.28.1-pace.15 and before) answers `outcome` and `detail` (pace.14+ adds
 *   `waitingFor`, `backgroundWork`, `stopped`), and its `waiting` queues the move. Asking it again is
 *   the same move: no second pin, no switch-guard count, no timeline row. So asking again is
 *   harmless under both, and the guard does it for both.
 */
import type { BackgroundJob } from "./policy.ts";

export type MoveOutcome = "moved" | "already" | "waiting" | "pending" | "refused";

export interface MoveAnswer {
  outcome: MoveOutcome;
  /** ZeroSub's reason (`busy_turn`, `switch_guard`, …), `unknown` for one this release doesn't know, or null. */
  reason: string | null;
  /** Asking again as is can work later. An unknown reason never is (the contract says so). */
  retryable: boolean;
  /** Where the live session runs when ZeroSub answered; null when unknown (an older ZeroSub). */
  accountId: string | null;
  /** The account we asked for. */
  target: string;
  /** The reply is the reviewed contract's (`retryable` present): `waiting` queued nothing. */
  reasons: boolean;
  detail: string | null;
  waitingFor: "turn" | "background" | null | undefined;
  backgroundWork: BackgroundJob[] | undefined;
  stopped: BackgroundJob[];
}

/** Reasons the reviewed contract names, and whether asking again can work. */
export const MOVE_REASONS: Readonly<Record<string, boolean>> = {
  busy_turn: true, background_work: true, switch_guard: true, in_progress: true, reload_failed: true,
  auto_switch_off: false, not_open: false, unsupported_provider: false, ineligible_target: false,
  user_pinned: false, landed_elsewhere: false,
};
const OUTCOMES = new Set<MoveOutcome>(["moved", "already", "waiting", "pending", "refused"]);
const text = (value: unknown) => (typeof value === "string" ? value : null);
const jobs = (value: unknown) => (Array.isArray(value) ? value as BackgroundJob[] : undefined);

/** Reads a reply; null for none (an RPC that returned nothing usable). */
export function readMoveReply(reply: unknown, target: string): MoveAnswer | null {
  if (!reply || typeof reply !== "object") return null;
  const r = reply as Record<string, unknown>;
  const waitingFor: MoveAnswer["waitingFor"] = "waitingFor" in r ? (r.waitingFor === "turn" || r.waitingFor === "background" ? r.waitingFor : null) : undefined;
  const base = { target, detail: text(r.detail), waitingFor, backgroundWork: jobs(r.backgroundWork), stopped: jobs(r.stopped) ?? [] };
  const raw = text(r.outcome);
  if (typeof r.retryable !== "boolean") {
    // An older ZeroSub: no reasons, and `waiting` queued the move. Today's reading, unchanged.
    const outcome: MoveOutcome = raw !== null && OUTCOMES.has(raw as MoveOutcome) ? raw as MoveOutcome : "refused";
    const reason = outcome === "waiting" ? (waitingFor === "background" ? "background_work" : waitingFor === "turn" ? "busy_turn" : null) : null;
    return { ...base, outcome, reason, retryable: true, accountId: null, reasons: false };
  }
  const accountId = text(r.accountId);
  const answer = (outcome: MoveOutcome, reason: string | null, retryable: boolean): MoveAnswer =>
    ({ ...base, outcome, reason, retryable, accountId, reasons: true });
  if (raw === null || !OUTCOMES.has(raw as MoveOutcome)) return answer("refused", "unknown", false);
  const outcome = raw as MoveOutcome;
  if (outcome === "moved" || outcome === "already") {
    // `accountId` is where it runs: a move that landed on another account is not a move to the target.
    return accountId !== null && accountId !== target ? answer("refused", "landed_elsewhere", false) : answer(outcome, null, false);
  }
  if (outcome === "pending") return answer("pending", null, false);
  const reason = text(r.reason);
  if (reason === null || !(reason in MOVE_REASONS)) return answer("refused", "unknown", false);
  return answer(outcome, reason, r.retryable && MOVE_REASONS[reason]!);
}

/** How often the guard asks about one agent's move while it still wants it (`moveAskDue`). */
export const ASK_AGAIN_MS = 60_000;
/** After a turn ZeroSub waited for ends, the guard asks again, but never more often than this. */
export const TURN_ENDED_MS = 10_000;
/** A reload in flight (`pending`, `in_progress`): its result shows in ZeroSub's state; ask again only after this. */
export const IN_FLIGHT_MS = 2 * 60_000;
/** The switch guard counts 4 moves in 10 minutes: asking every minute meanwhile only gets refused. */
export const SWITCH_GUARD_MS = 5 * 60_000;
/** A refusal not worth retrying (or an unknown reason), to the same account: asked again only after this. */
export const REFUSED_MS = 10 * 60_000;

export interface MoveAsk { at: number; target: string; answer: MoveAnswer | null }

/**
 * Whether the guard may ask ZeroSub about this agent's move now. Bounded so it never spins: a turn
 * ZeroSub waited for is asked about again once it ended (`TURN_ENDED_MS` apart at most), background
 * work each `ASK_AGAIN_MS`, a reload in flight after `IN_FLIGHT_MS`, the switch guard after
 * `SWITCH_GUARD_MS`, and a final refusal to the same account after `REFUSED_MS`. Another target is
 * always a new question. An older ZeroSub keeps today's cadence (`legacyEvery`).
 */
export function moveAskDue(last: MoveAsk | undefined, input: { now: number; target: string; turnRunning: boolean; legacyEvery: number }): boolean {
  if (!last || last.target !== input.target) return true;
  const since = input.now - last.at;
  const a = last.answer;
  if (!a || !a.reasons) return since >= input.legacyEvery;
  if (a.outcome === "pending" || a.reason === "in_progress") return since >= IN_FLIGHT_MS;
  if (!a.retryable && (a.outcome === "refused" || a.outcome === "waiting")) return since >= REFUSED_MS;
  if (a.reason === "busy_turn") return since >= (input.turnRunning ? ASK_AGAIN_MS : TURN_ENDED_MS);
  if (a.reason === "switch_guard") return since >= SWITCH_GUARD_MS;
  if (a.reason === "reload_failed") return since >= IN_FLIGHT_MS;
  return since >= ASK_AGAIN_MS;
}

/** One line for the trace: ids, outcome and reason only. */
export function moveTrace(a: MoveAnswer): string {
  const why = a.outcome === "waiting" ? ` (${a.waitingFor ?? "turn or work"}${a.backgroundWork?.length ? `, ${a.backgroundWork.length} job(s)` : ""})` : "";
  const reason = a.reason && (a.reasons || a.outcome !== "waiting") ? ` ${a.reason}` : "";
  const on = a.reasons && a.accountId !== null && a.accountId !== a.target ? ` on ${a.accountId}` : "";
  const stopped = a.stopped.length ? ` stopped ${a.stopped.length} job(s)` : "";
  return `${a.outcome}${reason}${why}${on}${stopped}${a.reasons ? "" : " (older ZeroSub)"}`;
}
