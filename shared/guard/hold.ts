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
import { CONTINUATION_TAIL, DEFAULT_CONTINUATION, type Agent, type BackgroundJob, type MoveWait, type Pause, type Policy } from "./policy.ts";

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

/**
 * When a hold ends, as every view shows it: the soonest any account the session could use
 * has room again (`nextRoomAt`, another account ZeroSub then moves it to), else its own
 * account's reset.
 */
export function heldUntil(pause: Pick<Pause, "anchorResetsAt" | "nextRoomAt">): string | null {
  return pause.nextRoomAt ?? pause.anchorResetsAt;
}

/**
 * The first line of a continuation after ZeroSub moved a held session to another account: the
 * window didn't reset, the session moved. The chat card recognises it (`shared/chat.ts`).
 */
export const MOVED_LEAD = "Your previous turn was paused at the usage limit, and this session has since moved to another account with room.";

/**
 * Invariant (seam D): a continuation says what ended the hold. After a move it leads with
 * `MOVED_LEAD`, never "the usage window has now reset"; a custom continuation keeps its own words
 * after that line. After a reset it is the configured continuation, unchanged.
 */
export function continuationText(policy: Pick<Policy, "continuation">, moved: boolean, stopped: readonly BackgroundJob[] = []): string {
  if (!moved) return policy.continuation;
  const tail = policy.continuation === DEFAULT_CONTINUATION ? CONTINUATION_TAIL : policy.continuation;
  return stopped.length === 0 ? `${MOVED_LEAD} ${tail}` : `${MOVED_LEAD} ${stoppedJobsLine(stopped)} ${tail}`;
}

/**
 * Invariant (`held-background-work`): a session the guard moved by stopping its background work is
 * told which jobs were stopped, so it can start again the ones it still needs. Each job by its
 * description, else its command with anything that looks like a secret masked (`jobName`).
 */
export function stoppedJobsLine(stopped: readonly BackgroundJob[]): string {
  const named = stopped.map((job) => `${jobName(job)} (${job.kind})`);
  const list = named.length <= 6 ? named.join("; ") : `${named.slice(0, 6).join("; ")}; and ${named.length - 6} more`;
  return `To move it, Session Guard stopped the background ${stopped.length === 1 ? "job" : "jobs"} it had running: ${list}. Start again any you still need.`;
}

const SECRET_WORDS = "token|secret|password|passwd|api[_-]?key|access[_-]?key|auth|credential|bearer";
/**
 * A job as people and the agent read it: Paseo's description, else its command (at most 120
 * characters, values after secret-looking names masked), else its kind. Never a secret on purpose:
 * a command can carry one (`TOKEN=… npm run deploy`), so names like token, key or password lose
 * their values.
 */
export function jobName(job: BackgroundJob): string {
  const described = job.description?.trim();
  if (described) return `"${clip(described)}"`;
  const command = job.command?.trim();
  if (!command) return job.kind === "monitor" ? "a watcher" : "a background job";
  const masked = command
    .replace(new RegExp(`\\b([A-Za-z0-9_]*(?:${SECRET_WORDS})[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\\S+)`, "gi"), "$1=…")
    .replace(new RegExp(`(--?[A-Za-z0-9-]*(?:${SECRET_WORDS})[A-Za-z0-9-]*)(=|\\s+)("[^"]*"|'[^']*'|\\S+)`, "gi"), "$1$2…")
    .replace(/\b(Bearer)\s+[^\s"']+/gi, "$1 …")
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1…@");
  return `\`${clip(masked)}\``;
}
const clip = (value: string) => (value.length > 120 ? `${value.slice(0, 119)}…` : value);

/**
 * What the guard does about a held session whose move waits for background work (Tom, 2026-11-22:
 * "make it work well and seamless"). Waiting is right only while it's short:
 * - never stops work the person asked to keep (`blocked`: a session pinned to its account, a
 *   protection override, or a ZeroSub that can't stop work), nor with the setting at 0: `jobs`;
 * - when its own account resets within the grace of the moment it would move, it waits for that
 *   reset and never stops a job for it: `reset`;
 * - otherwise it waits up to the grace (`afterMinutes`) for the work to end, then stops it and
 *   moves: `move` at `since + grace`. Work that only watches (Paseo's `monitor` kind: a Monitor
 *   streaming a log or CI) loses nothing the agent can't start again, so it moves at once.
 */
export function moveWaitPlan(input: {
  since: number; now: number; afterMinutes: number; resetsAt: number | null;
  jobs: readonly BackgroundJob[]; blocked: MoveWait["why"] | null;
}): Pick<MoveWait, "plan" | "at" | "why"> {
  if (input.blocked) return { plan: "jobs", at: null, why: input.blocked };
  if (input.afterMinutes <= 0) return { plan: "jobs", at: null, why: "setting" };
  const grace = input.afterMinutes * 60_000;
  const watchersOnly = input.jobs.length > 0 && input.jobs.every((job) => job.kind === "monitor");
  const movesAt = watchersOnly ? input.since : input.since + grace;
  if (input.resetsAt !== null && input.resetsAt <= Math.max(movesAt, input.now) + grace) {
    return { plan: "reset", at: new Date(input.resetsAt).toISOString() };
  }
  return { plan: "move", at: new Date(movesAt).toISOString() };
}

/**
 * The workspace label of a held session. Paseo's labels are named, host-wide entities (a new name
 * is a new label in every filter), so the name is one of these few and never carries a time; the
 * page, the chat card and `budget_status` say when (`moveWaitLine`).
 */
export const HELD_LABELS = {
  held: "Held",
  moving: "Held · moving soon",
  reset: "Held · until reset",
  jobs: "Held · until its jobs end",
} as const;
export function heldLabel(pause: Pick<Pause, "moveWait">): string {
  const wait = pause.moveWait;
  if (!wait) return HELD_LABELS.held;
  return wait.plan === "move" ? HELD_LABELS.moving : wait.plan === "reset" ? HELD_LABELS.reset : HELD_LABELS.jobs;
}

/**
 * Why a held session is still where it is, with the time, for the page row, the chat and the
 * agent: "Moves at 5:06 PM unless its background job ends first". Null without a wait.
 */
export function moveWaitLine(pause: Pick<Pause, "moveWait">, now: number, moment: (iso: string) => string): string | null {
  const wait = pause.moveWait;
  if (!wait) return null;
  const count = wait.jobs.length;
  const its = count === 0 ? "its background work" : count === 1 ? `its background job ${jobName(wait.jobs[0]!)}` : `its ${count} background jobs`;
  const ends = count > 1 ? "end" : "ends";
  if (wait.plan === "move" && wait.at) {
    return Date.parse(wait.at) <= now ? `Moving to an account with room: stopping ${its}` : `Moves at ${moment(wait.at)} unless ${its} ${ends} first`;
  }
  if (wait.plan === "reset" && wait.at) return `Waits for the ${moment(wait.at)} reset, so ${its} keeps running`;
  if (wait.why === "unsupported") return "Moves to an account with room once its turn or background work ends";
  const reason = wait.why === "pinned" ? " · it stays on the account picked for it"
    : wait.why === "override" ? " · this session's protection was set by hand"
      : wait.why === "setting" ? " · stopping background work is off"
        : "";
  return `Moves once ${its} ${ends}${reason}`;
}
