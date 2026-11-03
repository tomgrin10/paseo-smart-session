import { isPending, timestamp, type Pause, type Policy } from "./policy.ts";

export function pausedSessions(pauses: readonly Pause[], query = "") {
  const needle = query.trim().toLocaleLowerCase();
  return pauses.filter(isPending).filter(p => !needle ||
    `${p.title ?? "Untitled session"} ${p.provider} ${p.agentId} ${p.suspension ? "native subagents" : "interrupted turn"}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => {
      if ((a.phase === "attention") !== (b.phase === "attention")) return a.phase === "attention" ? -1 : 1;
      return (timestamp(a.anchorResetsAt) ?? Infinity) - (timestamp(b.anchorResetsAt) ?? Infinity) || a.pausedAt.localeCompare(b.pausedAt);
    });
}
export function pausePresentation(pause: Pause, policy: Policy, now = Date.now()) {
  const reset = timestamp(pause.anchorResetsAt);
  const resetLabel = pause.demo ? "Waiting for your test action" : reset === null ? "Reset time unavailable" : reset <= now
    ? "Reset due · waiting for fresh usage"
    : `Reset ${new Date(reset).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`;
  const state = pause.phase === "attention" ? "Needs attention" : pause.phase === "pausing" ? "Pausing"
    : pause.phase === "resuming" ? "Resuming" : pause.demo ? "Demo · resume when ready" : !policy.enabled ? "Guard off · continuation on hold"
    : !policy.autoResume ? "Automatic resume off" : "Will resume automatically after reset";
  return {
    title: pause.title?.trim() || "Untitled session", state, resetLabel,
    coverage: pause.phase === "attention" ? "Check session state" : pause.suspension ? "Includes native subagents" : pause.restartRecovery ? "Saved conversation · waiting after restart" : "Interrupted turn",
    actionLabel: pause.suspension ? "Release and turn off" : "Cancel continuation",
    actionHint: pause.suspension ? "Resume these workers now and exclude this session from protection."
      : "Leave this session for you to continue manually.",
  };
}

/** The host master switch always outranks a session's saved preference. */
export function callerProtection(enabled: boolean, protectByDefault: boolean, override: boolean | undefined) {
  return { enabled, protected: enabled && (override ?? protectByDefault), override: override ?? null };
}

/**
 * What an agent is told about Session Guard, in the words it reads.
 *
 * Read-only by design: nothing here lets an agent opt itself out or resume a pause,
 * so it says what will happen rather than offering a way round it.
 */
export function agentGuardSummary(status: {
  governor: "off" | "active" | "deferred" | "error";
  protected: boolean; thresholdPct: number; autoResume: boolean;
  pauses: readonly { phase: Pause["phase"]; resetsAt: string | null }[];
}): string[] {
  if (status.governor === "deferred") return ["Session Guard: run by another plugin on this host (likely the standalone Session Guard); this session's protection is not visible from here."];
  if (status.governor === "error") return ["Session Guard: status unavailable."];
  if (status.governor === "off" || !status.protected) return ["Session Guard: off for this session. Reaching the session limit will not pause it here; the provider will simply refuse requests until reset."];
  const pending = status.pauses.find(pause => ["pausing", "waiting", "resuming", "attention"].includes(pause.phase));
  if (pending) {
    return [`Session Guard: this session is paused for the session limit (${pending.phase})${pending.resetsAt ? `; the window resets ${pending.resetsAt}` : ""}.`];
  }
  return [`Session Guard: on. At ${status.thresholdPct}% of the session window Paseo pauses this session${status.autoResume
    ? " and continues it in this same conversation once the window resets — no need to stop early or hand off because of the session limit."
    : "; a person continues it after the reset."}`];
}
