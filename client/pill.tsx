/**
 * The Smart Session pill, on every agent's composer: the one place Smart Session
 * shows up next to the box you are about to type into.
 *
 * Normally it answers how full this session's context is and whether Smart Compact
 * will ask it to compact itself: the icon is a ring that fills with the context and
 * carries a tick at each compact line (end of turn, then right away), the label is the percentage. Protection adds
 * nothing while it simply protects; the quiet case stays quiet. When this session is
 * paused at the session limit the pill turns into the pause itself, an amber pause
 * glyph and the moment it resumes, and it stays on the composer even when the pill
 * is otherwise hidden, so a paused session can always be released from where it is.
 * Pressing it opens `client/popover.tsx`, which has the detail and both switches.
 *
 * State lives in module stores (`pill-store.ts`, `guard/status.ts`) rather than in
 * each pill, because the pill and everything that changes it (its popover, the
 * Command Center item, the overview and settings) are in this one client bundle.
 * Context occupancy comes from the shared agent directory, so the ring moves with
 * every turn without a poll of its own.
 *
 * Registered on the host's own client rather than through the Display gate, because
 * a paused session's pill must outlive "hide the pill".
 */

import type { PluginButtonIconProps, PluginClientContext, PluginButtonRegistration } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useSyncExternalStore } from "react";

import { enrolmentState } from "../shared/governor";
import type { AgentDirectory } from "./agents";
import { Ring, toneFill } from "./charts";
import { subscribeDisplay } from "./display";
import { governedPause, guardSnapshot, subscribeGuard } from "./guard/status";
import { describePill, pillPresentation, pillVisible } from "./pill-view";
import { pillSnapshot, refreshPills, state as currentState, subscribePills } from "./pill-store";
import { makeContextPopover } from "./popover";

export { refreshPills } from "./pill-store";
export { describePill, pillPresentation, pillVisible } from "./pill-view";

/** How often the client re-reads enrolment, for changes made somewhere else. */
const REFRESH_MS = 20_000;

/** One live icon per pill: the pause while paused, otherwise the ring, muted while not enrolled. */
function makeIcon(agents: AgentDirectory) {
  return function SmartSessionPillIcon(props: PluginButtonIconProps) {
    const current = useSyncExternalStore(subscribePills, pillSnapshot, pillSnapshot);
    const status = useSyncExternalStore(subscribeGuard, guardSnapshot, guardSnapshot);
    useSyncExternalStore(agents.subscribe, agents.version, agents.version);
    const agentId = props.context === "agent" ? props.agentId : "";
    const c = props.theme.colors;
    const pause = governedPause(status, agentId);
    if (pause !== undefined) {
      const stuck = pause.phase === "attention";
      return <Icon name={stuck ? "TriangleAlert" : "Pause"} size={props.size} color={stuck ? c.statusDanger : c.statusWarning} />;
    }
    const enrolled = current.compactOn && current.enrolled.has(agentId);
    const view = pillPresentation(agents.current().get(agentId), enrolled, current.thresholds, current.compactOn);
    const color = view.tone !== "default" ? toneFill(c, view.tone) : enrolled ? c.foreground : c.foregroundMuted;
    return <Ring size={props.size} color={color} fraction={view.fraction} mark={enrolled ? view.mark : null} upper={view.upper} />;
  };
}

export function contributeClient(client: PluginClientContext, agents: AgentDirectory) {
  /** Every agent this app knows of, and its pill registration while one is up. */
  const tracked = new Map<string, { workspaceId: string; handle: PluginButtonRegistration | null; signature: string }>();
  const Icon = makeIcon(agents);
  const Content = makeContextPopover(client, agents);
  // The Display switch; shown until the saved preference says otherwise, like the old gate.
  let displayOn = true;

  function describe(agentId: string) {
    return describePill(agentId, agents.current().get(agentId), currentState(), guardSnapshot());
  }

  function register(agentId: string, entry: { workspaceId: string; handle: PluginButtonRegistration | null; signature: string }): void {
    const { label, title } = describe(agentId);
    entry.signature = `${label}|${title}`;
    entry.handle = client.addComposerPill({
      id: "smart-compact",
      workspaceId: entry.workspaceId,
      agentId,
      button: { title, label, icon: Icon, behavior: { kind: "popover", Content } },
    });
  }

  /** Brings the registrations in line with the stores, whichever way they moved. */
  function sync(): void {
    const status = guardSnapshot();
    for (const [agentId, entry] of tracked) {
      const visible = !agents.current().get(agentId)?.closed && pillVisible(agentId, currentState(), status, displayOn);
      if (visible && entry.handle === null) register(agentId, entry);
      else if (!visible && entry.handle !== null) {
        entry.handle.remove();
        entry.handle = null;
      } else if (entry.handle !== null) {
        const { label, title } = describe(agentId);
        const signature = `${label}|${title}`;
        // Only a changed label is sent: a fresh behaviour would remount an open popover.
        if (signature !== entry.signature) {
          entry.signature = signature;
          entry.handle.update({ label, title });
        }
      }
    }
  }

  function forget(agentId: string): void {
    tracked.get(agentId)?.handle?.remove();
    tracked.delete(agentId);
  }

  /** Follows the shared directory: new agents gain a pill, moved or removed ones lose theirs. */
  function followDirectory(): void {
    const current = agents.current();
    for (const [agentId, entry] of [...tracked]) {
      if (current.get(agentId)?.workspaceId !== entry.workspaceId) forget(agentId);
    }
    for (const [agentId, agent] of current) {
      // A pill is pinned to one workspace, so an agent that moved needs a new one.
      if (!tracked.has(agentId)) tracked.set(agentId, { workspaceId: agent.workspaceId, handle: null, signature: "" });
    }
    sync();
  }

  const refresh = () => refreshPills(() => client.rpc(enrolmentState, {}));

  const unsubscribeStore = subscribePills(sync);
  const unsubscribeGuard = subscribeGuard(sync);
  const unsubscribeDisplay = subscribeDisplay((values) => {
    if (values.enable_composer_button === displayOn) return;
    displayOn = values.enable_composer_button;
    sync();
  });
  const unsubscribeAgents = agents.subscribe(followDirectory);
  followDirectory();

  void refresh().catch(() => undefined);
  const timer = setInterval(() => void refresh().catch(() => undefined), REFRESH_MS);

  return () => {
    clearInterval(timer);
    unsubscribeAgents();
    unsubscribeDisplay();
    unsubscribeGuard();
    unsubscribeStore();
    for (const agentId of [...tracked.keys()]) forget(agentId);
  };
}
