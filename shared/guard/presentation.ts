import { isPending, timestamp, type Pause, type Policy } from "./policy.ts";
import { messageWaiting } from "./hold.ts";

/**
 * What a held session is holding, in the words every view uses: nothing running yet,
 * a message the person sent meanwhile, an interrupted turn, or frozen workers.
 */
export function heldWork(pause: Pause): "idle" | "message" | "frozen" | "interrupted" {
  if (pause.idle) return "idle";
  if (messageWaiting(pause)) return "message";
  return pause.suspension ? "frozen" : "interrupted";
}
/** What happens at the reset, after "Held until 5:58 PM ·". */
export const THEN = { idle: "", message: "your message runs then", frozen: "carries on in place then", interrupted: "continues then" } as const;

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
    : pause.phase === "resuming" ? "Resuming" : pause.demo ? "Demo · resume when ready" : !policy.enabled ? "Protection off · continuation on hold"
    : !policy.autoResume ? "Automatic resume off" : "Will resume automatically after reset";
  return {
    title: pause.title?.trim() || "Untitled session", state, resetLabel,
    coverage: pause.phase === "attention" ? "Check session state" : pause.idle ? "Nothing running" : messageWaiting(pause) ? "Your message waits"
      : pause.suspension ? "Includes native subagents" : pause.restartRecovery ? "Saved conversation · waiting after restart" : "Interrupted turn",
    actionLabel: "Release and turn off",
    actionHint: pause.suspension ? "Resume these workers now and exclude this session from protection."
      : "Let this session go now and stop it pausing at the limit.",
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
    return [`Session Guard: this session is held at the session limit (${pending.phase})${pending.resetsAt ? `; it runs again once the window resets ${pending.resetsAt}` : ""}. Messages sent meanwhile wait for the reset unless a person resumes it.`];
  }
  return [`Session Guard: on. At ${status.thresholdPct}% of the session window Paseo holds this session until the window resets, unless a person resumes it${status.autoResume
    ? ", then continues it in this same conversation — no need to stop early or hand off because of the session limit."
    : "; a person continues it after the reset."}`];
}

type GovernorView = { governor: "off" | "active" | "deferred" | "error"; standalone: boolean | null; error: string | null };

/**
 * Why this plugin is not pausing anything, for the Protection part of each view.
 * Null while it is the host's governor. The standalone plugin keeps its own name:
 * it is a different plugin the person installed, not a part of this one.
 */
export function governorNotice(status: GovernorView): { title: string; hint: string } | null {
  if (status.governor === "active") return null;
  if (status.governor === "off") return { title: "Pause at the limit is off", hint: "Nothing pauses at the session limit. Turn it on in Smart Session settings." };
  if (status.governor === "deferred" && status.standalone !== false) {
    // One calm line; the server's longer story only adds what needs a look.
    const stuck = status.error?.includes("could not be released") ? " Some paused sessions could not be released; check them." : "";
    return { title: "The standalone Session Guard plugin handles pausing here", hint: `Disable or uninstall it to hand back; its per-session choices and waiting pauses carry over.${stuck}` };
  }
  if (status.governor === "deferred") return { title: "Another process handles pausing here", hint: status.error ?? "Nothing is paused from here until it stops." };
  return { title: "Pause at the limit isn't running", hint: status.error ?? "It will retry automatically." };
}

/**
 * Who a pause in the shared state belongs to, when it is not this plugin.
 *
 * Both plugins read one state file, so a list here can show pauses only the other
 * plugin can act on. Null means this plugin governs and can act on them.
 */
export function pauseOwnerNote(status: GovernorView): string | null {
  if (status.governor === "active") return null;
  if (status.governor === "off") return "Saved by the standalone Session Guard plugin. Smart Session takes it over once Pause at the limit is on here and that plugin is disabled or uninstalled.";
  if (status.governor === "deferred" && status.standalone !== false) return "Handled by the standalone Session Guard plugin; change it there.";
  if (status.governor === "deferred") return "Handled by another process on this host; change it there.";
  return "Pause at the limit isn't running here, so this pause can't be changed until it recovers.";
}

/**
 * A paused session's composer pill: the loud state, so the label is the moment it
 * comes back. A clock rather than a countdown, so the label changes once instead of
 * every minute (each change is a registration update).
 */
export function pausePill(pause: Pause, policy: Policy, now = Date.now(), clock: (iso: string) => string = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })) {
  const reset = timestamp(pause.anchorResetsAt);
  // The title is also the phone sheet's title: one short sentence, the detail is in the sheet.
  if (pause.phase === "attention") return { label: "Check session", title: "Paused, then something changed · check it", tone: "danger" as const };
  if (pause.phase === "pausing") return { label: "Pausing…", title: "Pausing at the session limit", tone: "warning" as const };
  if (pause.phase === "resuming") return { label: "Resuming…", title: "The window reset · continuing now", tone: "warning" as const };
  if (pause.demo) return { label: "Paused · test", title: "Test pause · waits for you", tone: "warning" as const };
  if (!policy.enabled) return { label: "On hold", title: "On hold while Pause at the limit is off", tone: "warning" as const };
  if (reset === null) return { label: "Held", title: "Held at the limit · reset time not reported yet", tone: "warning" as const };
  const at = clock(pause.anchorResetsAt!);
  if (reset <= now) return { label: "Held · reset due", title: `Held at the limit · reset was ${at}, waiting for a fresh reading`, tone: "warning" as const };
  const work = heldWork(pause);
  // An idle hold just lets go at the reset, so it reads the same with automatic continuation off.
  if (policy.autoResume || work === "idle") {
    return { label: `Held until ${at}`, title: work === "idle" ? `Held at the limit until ${at}` : `Held until ${at} · ${THEN[work]}`, tone: "warning" as const };
  }
  return { label: `Held · resets ${at}`, title: `Held at the limit · resets ${at}, continue by hand`, tone: "warning" as const };
}

/**
 * The lead for a set of pending pauses: when they come back, or that one needs a
 * look. Null when nothing is paused. `shared` is the one reset they all wait for,
 * when they share it, so rows only repeat a time that differs.
 */
export function pausedLead(pending: readonly Pause[], autoResume: boolean, now: number, clock: (ms: number) => string): { title: string; tone: "warning" | "danger"; shared: number | null; next: number | null } | null {
  if (pending.length === 0) return null;
  const waiting = pending.filter((p) => p.phase !== "attention");
  const stuck = pending.length - waiting.length;
  const resets = waiting.map((p) => timestamp(p.anchorResetsAt)).filter((v): v is number => v !== null && v > now).sort((a, b) => a - b);
  const shared = resets.length === waiting.length && resets.length > 0 && resets[resets.length - 1]! - resets[0]! < 60_000 ? resets[0]! : null;
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const tone = stuck > 0 ? "danger" as const : "warning" as const;
  const next = resets[0] ?? null;
  if (waiting.length === 0) return { title: `${n(stuck, "paused session needs", "paused sessions need")} a look`, tone, shared, next };
  const look = stuck > 0 ? ` · ${stuck} ${stuck === 1 ? "needs" : "need"} a look` : "";
  if (shared !== null) return { title: (autoResume ? `${n(waiting.length, "session", "sessions")} held until ${clock(shared)}` : `${n(waiting.length, "session waits", "sessions wait")} for the ${clock(shared)} reset`) + look, tone, shared, next };
  if (next !== null) return { title: `${n(waiting.length, "session", "sessions")} held · next ${autoResume ? "runs" : "reset"} at ${clock(next)}${look}`, tone, shared, next };
  return { title: `${n(waiting.length, "session waits", "sessions wait")} for a fresh reading${look}`, tone, shared, next };
}

/**
 * The one action set for a waiting pause, wherever it shows: the chat card, the
 * pill's popover and the overview's list. Same words, same order, same hint.
 */
export const PAUSE_ACTIONS = {
  resume: { label: "Resume now", busy: "Resuming…", icon: "Play", hint: "Continues before the reset and stops this session pausing at the limit. The provider may still refuse work until the reset." },
  dismiss: { label: "Dismiss pause", busy: "Dismissing…", hint: "Lets the session go without sending a message and stops it pausing at the limit." },
  note: "Resume now stops this session pausing at the limit · Dismiss sends nothing",
} as const;
