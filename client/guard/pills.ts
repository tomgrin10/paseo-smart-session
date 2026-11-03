/**
 * The Session Guard pill: one per live session, beside Smart Compact's.
 *
 * Drawn only while this plugin is the host's Session Guard governor. Off, there is
 * nothing for it to say; deferring to the standalone plugin, that plugin draws its own,
 * and two shields on one composer would contradict each other. While the feature is
 * being turned off, a session that still has a pause keeps its pill so the pause can
 * be released from where it is.
 */
import type { PluginButtonIcon, PluginClientContext } from "@getpaseo/plugin/client";
import type { AgentDirectory } from "../agents.ts";
import { GUARD_SURFACES } from "./surfaces.ts";
import { cancelResumeRpc, setProtectionRpc, statusRpc } from "../../shared/guard/contracts.ts";
import { isPending, protects, type Pause, type Policy } from "../../shared/guard/policy.ts";

export function pillPresentation(policy: Policy, enabled: boolean, pause: Pause | undefined) {
  if (!policy.enabled) return { label: "Guard off", title: "Session Guard is disabled on this host", icon: "ShieldOff" };
  if (!enabled) return { label: "Guard off", title: "This session is excluded from automatic quota protection", icon: "ShieldOff" };
  if (pause?.phase === "attention") return { label: "Check session", title: pause.note ?? "Check this session before continuing", icon: "TriangleAlert" };
  if (pause) {
    if (pause.demo) return { label: "Paused · demo", title: "This test session is paused. Try Resume now in its timeline; no provider quota was changed.", icon: "Pause" };
    const date = pause.anchorResetsAt ? new Date(pause.anchorResetsAt) : null;
    const time = date && Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
    const resetDetail = date ? ` Expected reset ${date.toLocaleString([], { dateStyle: "short", timeStyle: "short" })}.` : " Reset time is not available yet.";
    return { label: time ? `Paused · ${time}` : "Paused · awaiting reset", title: (policy.autoResume
      ? `Paused at the session limit${pause.suspension ? ", including native subagents" : ""}. Automatic continuation is scheduled after reset.`
      : pause.suspension ? "Session and native subagents are paused. Release and turn off to continue manually; automatic continuation is off."
      : "Paused at the session limit. Continue manually after reset; automatic continuation is off.") + resetDetail, icon: "Pause" };
  }
  return { label: "Session Guard", title: policy.autoResume
    ? `Pause at ${policy.thresholdPct}% session usage and continue after reset`
    : `Pause at ${policy.thresholdPct}% session usage; continue manually after reset`, icon: "ShieldCheck" };
}

/** How often a client re-reads Session Guard status while it is on, and while it is off. */
const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 60_000;

const wakers = new Set<() => void>();
/**
 * Re-reads status now. The settings screens call it whenever the Session Guard
 * document changes — their `useSettings` hears changes from every client — so pills
 * follow a switch without polling hard while the feature is off.
 */
export function refreshGuardPills(): void {
  for (const wake of [...wakers]) wake();
}

export function contributePills(client: PluginClientContext, agents: AgentDirectory, icons: Readonly<Record<string, PluginButtonIcon>> = {}) {
  let stopped = false;
  let running = false;
  let status: Awaited<ReturnType<typeof readStatus>> | null = null;
  const handles = new Map<string, { workspaceId: string; signature: string; registration: ReturnType<PluginClientContext["addComposerPill"]> }>();
  const readStatus = () => client.rpc(statusRpc, {});
  let timer: ReturnType<typeof setTimeout> | null = null;
  const refresh = async () => {
    if (stopped || running) return;
    running = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    try { const next = await readStatus(); if (!stopped) { status = next; reconcile(); } }
    catch { /* Keep the last confirmed presentation across a brief disconnect. */ }
    finally {
      running = false;
      // Off here and nobody governing from here: nothing to draw, so check rarely.
      const idle = status !== null && !status.policy.enabled && status.governor === "off";
      if (!stopped) timer = setTimeout(() => void refresh(), idle ? IDLE_POLL_MS : ACTIVE_POLL_MS);
    }
  };
  function reconcile() {
    if (stopped || !status) return;
    const sessions = new Map<string, string>();
    if (status.governor === "active") {
      for (const [agentId, agent] of agents.current()) {
        if (agent.closed) continue;
        if (status.policy.enabled || status.pauses.some(p => p.agentId === agentId && isPending(p))) sessions.set(agentId, agent.workspaceId);
      }
    }
    for (const [id, handle] of handles) {
      if (sessions.get(id) !== handle.workspaceId) { handle.registration.remove(); handles.delete(id); }
    }
    for (const [agentId, workspaceId] of sessions) {
      const enabled = protects(status.policy, status.overrides, agentId);
      const pause = status.pauses.find(p => p.agentId === agentId && isPending(p));
      const presentation = pillPresentation(status.policy, enabled, pause);
      const signature = JSON.stringify([presentation, enabled, agentId in status.overrides, pause?.id]);
      const handle = handles.get(agentId);
      // Preserve the host menu while polling or receiving agent updates.
      // Replacing behavior on every read remounts an open adaptive menu.
      if (handle?.signature === signature) continue;
      const button = {
        ...presentation,
        icon: icons[presentation.icon] ?? presentation.icon,
        behavior: { kind: "menu" as const, items: [
          { kind: "item" as const, id: "toggle", title: enabled ? "Turn off for this session" : "Protect this session", icon: enabled ? "ShieldOff" : "ShieldCheck",
            behavior: { kind: "action" as const, onPress: async () => { await client.rpc(setProtectionRpc, { agentId, enabled: !enabled }); await refresh(); } } },
          { kind: "item" as const, id: "default", title: "Use host default", visible: agentId in status.overrides,
            behavior: { kind: "action" as const, onPress: async () => { await client.rpc(setProtectionRpc, { agentId, enabled: null }); await refresh(); } } },
          { kind: "item" as const, id: "cancel", title: pause?.suspension ? "Release and turn off for this session" : "Cancel automatic continuation", visible: !!pause,
            behavior: { kind: "action" as const, onPress: async () => { await client.rpc(cancelResumeRpc, { agentId }); await refresh(); } } },
          { kind: "separator" as const, id: "separator" },
          { kind: "item" as const, id: "paused-sessions", title: "All paused sessions", icon: "Pause",
            behavior: { kind: "action" as const, onPress: () => { client.openSurface(GUARD_SURFACES.paused); } } },
          { kind: "item" as const, id: "settings", title: "Session Guard settings", icon: "Settings",
            behavior: { kind: "action" as const, onPress: () => { client.openSurface(GUARD_SURFACES.settings); } } },
        ] },
      };
      if (handle) { handle.registration.update(button); handle.signature = signature; }
      else handles.set(agentId, { workspaceId, signature, registration: client.addComposerPill({ id: "session-guard", workspaceId, agentId, button }) });
    }
  }
  const unsubscribe = agents.subscribe(reconcile);
  const wake = () => void refresh();
  wakers.add(wake);
  void refresh();
  return () => {
    stopped = true; wakers.delete(wake); unsubscribe();
    if (timer !== null) clearTimeout(timer);
    for (const handle of handles.values()) handle.registration.remove();
    handles.clear();
  };
}
