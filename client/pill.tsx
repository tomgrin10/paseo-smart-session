/**
 * The Smart Compact pill, on every agent's composer.
 *
 * It answers two questions where they matter, next to the box you are about to type
 * into: how full is this session's context, and will Smart Compact ask it to compact
 * itself. The icon is a ring that fills with the context and carries a tick at the
 * compact line; the label is the percentage. Pressing it opens a popover with the
 * detail and the enrolment switch.
 *
 * State lives in this module rather than in each pill, because the pill and the
 * things that change it (its own popover, the Command Center item, the overview and
 * settings) are all in this one client bundle. One store, one fetch, and every
 * mounted pill redraws together. Context occupancy comes from the shared agent
 * directory, which already carries each agent's last usage, so the ring moves with
 * every turn without a poll of its own.
 *
 * With Smart Compact off there is no pill at all: there is nothing for one to say.
 */

import type { PluginButtonIconProps, PluginClientContext, PluginButtonRegistration } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";

import { contextOutlook } from "../shared/forecast";
import { enrolmentState } from "../shared/governor";
import { pillSnapshot, refreshPills, state as currentState, subscribePills } from "./pill-store";

export { refreshPills } from "./pill-store";
import { profileFor } from "../shared/thresholds";
import type { Thresholds } from "../shared/thresholds";
import type { AgentDirectory, DirectoryAgent } from "./agents";
import { Ring, toneFill } from "./charts";
import { makeContextPopover } from "./popover";

/** How often the client re-reads enrolment, for changes made somewhere else. */
const REFRESH_MS = 20_000;

/** Everything a pill shows about one agent, in one place for the icon, label and title. */
export function pillPresentation(agent: Pick<DirectoryAgent, "usedTokens" | "maxTokens"> | undefined, enrolled: boolean, thresholds: Thresholds | null) {
  const known = agent !== undefined && agent.usedTokens !== null && agent.maxTokens !== null;
  if (!known) {
    return {
      label: "Smart Compact",
      title: enrolled ? "Smart Compact on · no context reading yet" : "Smart Compact off · no context reading yet",
      fraction: 0, mark: null as number | null, tone: "default" as const, pct: null as number | null,
    };
  }
  const compactAtPct = profileFor(agent.maxTokens!, thresholds ?? undefined).compact;
  const outlook = contextOutlook({ usedTokens: agent.usedTokens!, maxTokens: agent.maxTokens!, compactAtPct });
  const pct = Math.round(outlook.pct);
  return {
    label: `${pct}%`,
    title: `Context ${pct}% full · ${enrolled ? `Smart Compact asks at ${compactAtPct}%` : "Smart Compact off for this session"}`,
    fraction: outlook.pct / 100, mark: compactAtPct / 100, tone: outlook.tone, pct,
  };
}

/** One live icon per pill: the ring, muted while the session is not enrolled. */
function makeIcon(agents: AgentDirectory) {
  return function ContextRingIcon(props: PluginButtonIconProps) {
    const current = useSyncExternalStore(subscribePills, pillSnapshot, pillSnapshot);
    useSyncExternalStore(agents.subscribe, agents.version, agents.version);
    const agentId = props.context === "agent" ? props.agentId : "";
    const enrolled = current.enrolled.has(agentId);
    const view = pillPresentation(agents.current().get(agentId), enrolled, current.thresholds);
    const c = props.theme.colors;
    const color = view.tone !== "default" ? toneFill(c, view.tone) : enrolled ? c.foreground : c.foregroundMuted;
    return <Ring size={props.size} color={color} fraction={view.fraction} mark={enrolled ? view.mark : null} />;
  };
}

export function contributeClient(client: PluginClientContext, agents: AgentDirectory) {
  /** Every agent this app knows of, and its pill registration while one is up. */
  const tracked = new Map<string, { workspaceId: string; handle: PluginButtonRegistration | null; signature: string }>();
  const Icon = makeIcon(agents);
  const Content = makeContextPopover(client, agents);

  function describe(agentId: string) {
    const view = pillPresentation(agents.current().get(agentId), currentState().enrolled.has(agentId), currentState().thresholds);
    return { label: view.label, title: view.title };
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

  /** Brings the registrations in line with the store, whichever way it moved. */
  function sync(): void {
    for (const [agentId, entry] of tracked) {
      if (currentState().showPill && entry.handle === null) register(agentId, entry);
      else if (!currentState().showPill && entry.handle !== null) {
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
  const unsubscribeAgents = agents.subscribe(followDirectory);
  followDirectory();

  void refresh().catch(() => undefined);
  const timer = setInterval(() => void refresh().catch(() => undefined), REFRESH_MS);

  return () => {
    clearInterval(timer);
    unsubscribeAgents();
    unsubscribeStore();
    for (const agentId of [...tracked.keys()]) forget(agentId);
  };
}
