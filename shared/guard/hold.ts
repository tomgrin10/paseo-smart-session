/**
 * Holding a session at the limit: the rules, without the I/O.
 *
 * The invariant (AGENTS.md, "Session Guard"): while a protected session's account is at
 * or over the pause threshold, no turn runs in it unless a person explicitly resumes it.
 * So a pause is a hold, not a one-off interrupt: a person's message joins it instead of
 * ending it, and an idle session is held as well as a running one.
 *
 * Switch first, hold as the fallback: a Claude session ZeroSub can move to another account
 * with room is not held while ZeroSub moves it (`zerosubMoves`). A running turn is still
 * stopped at once (in the foreground, never frozen, so ZeroSub can reopen the session) and
 * continues on the new account; an idle one is left alone. Only if the session is still on
 * the full account after `ZEROSUB_MOVE_GRACE_MS` is it held as usual. Without room on any
 * other account, with automatic switching off or without ZeroSub, nothing changes.
 */
import type { Agent, Pause } from "./policy.ts";

/**
 * Whether the guard may hold this session: the daemon has it open now. A closed
 * (dormant or unloaded) or archived agent has no provider to run a turn, and the guard
 * never opens one to hold it; once a person opens it, it is live and held then.
 */
export function isLive(agent: Pick<Agent, "status" | "archivedAt">): boolean {
  return !agent.archivedAt && agent.status !== "closed";
}

/** How a session at the limit is held, from its state this pass; null leaves it for a later pass. */
export function holdKind(agent: Pick<Agent, "status" | "archivedAt">, quotaFailed: boolean, nativeBackground: boolean): "interrupt" | "quota" | "background" | "idle" | null {
  if (!isLive(agent)) return null;
  if (agent.status === "running") return "interrupt";
  if (quotaFailed) return "quota";
  if (nativeBackground) return "background";
  // Starting up or failed for another reason: a turn it starts is held when it shows as running.
  return agent.status === "idle" ? "idle" : null;
}

/** A person's message reached the session since the pause last looked. */
export function messageArrived(pause: Pick<Pause, "lastUserMessageAt">, agent: Pick<Agent, "lastUserMessageAt">): boolean {
  return (agent.lastUserMessageAt ?? null) !== pause.lastUserMessageAt;
}

/**
 * Whether a message the person sent during the hold is waiting in it, to run after the
 * reset. True once a message arrived after the pause began.
 */
export function messageWaiting(pause: Pick<Pause, "pausedAt" | "lastUserMessageAt">): boolean {
  const at = pause.lastUserMessageAt ? Date.parse(pause.lastUserMessageAt) : NaN;
  return Number.isFinite(at) && at > Date.parse(pause.pausedAt);
}

/**
 * What the reset does for a foreground hold: an idle hold just lets go (there is nothing
 * to continue); any other one sends the continuation into the same conversation, where
 * a message held meanwhile is the latest thing the agent reads.
 */
export function continuesAtReset(pause: Pick<Pause, "idle">): boolean {
  return !pause.idle;
}

/**
 * Whether an idle session may be held by freezing its provider process. Only Claude: a
 * message sent to a stopped Claude CLI is accepted at once, shows in the chat as a
 * running turn and runs at SIGCONT, while one sent to a stopped Codex app-server times
 * out in the sender's app and stays invisible until SIGCONT (RESEARCH.md, "Messages to a
 * stopped provider"). Idle Codex sessions are held in the foreground instead.
 */
export function freezesIdle(provider: string): boolean {
  return provider === "claude";
}

/**
 * How long the guard leaves a session ZeroSub can move to another account with room before
 * holding it as usual. ZeroSub moves a full account's idle agents as soon as its reading
 * finds it full (the same reading the guard acts on) and looks again every minute, a few
 * seconds per agent; a session still on the full account after this is held.
 */
export const ZEROSUB_MOVE_GRACE_MS = 2 * 60_000;

/** Only Claude sessions move between accounts in place; a Codex thread can't change accounts. */
export function zerosubCanMove(provider: string): boolean {
  return provider === "claude";
}

/**
 * When each session at the limit was first seen movable by ZeroSub, so the grace is counted
 * once per stretch: a session ZeroSub didn't move in time is held, and isn't let go again
 * until it stops being movable (another account fills, or it left the full account).
 */
export class ZeroSubMoves {
  private readonly since = new Map<string, number>();
  private touched = new Set<string>();

  /** Starts a pass: sessions not seen movable during it lose their grace at `end()`. */
  begin(): void { this.touched = new Set(); }

  /** Whether ZeroSub still has time to move this session, which is movable now. */
  moves(agentId: string, now: number): boolean {
    this.touched.add(agentId);
    let since = this.since.get(agentId);
    if (since === undefined) this.since.set(agentId, since = now);
    return now - since < ZEROSUB_MOVE_GRACE_MS;
  }

  end(): void {
    for (const id of [...this.since.keys()]) if (!this.touched.has(id)) this.since.delete(id);
  }
}
