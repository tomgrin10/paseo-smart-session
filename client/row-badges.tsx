/**
 * Badges on a sidebar workspace row (Paseo 0.17.1+): the held badge, and with ZeroSub the account the
 * workspace's sessions run on. The words are `shared/guard/row-badge.ts`; this file only picks one
 * workspace's pauses and agents out of the bundle's existing reads (the guard status poll, the
 * subscriptions poll and the agent directory) and adds no poll of its own.
 *
 * Feature-detected: an older Paseo has no `addWorkspaceRowBadgeItem` (and no `WorkspaceRowBadge`), so
 * nothing registers and the server keeps the held workspace label (`server/guard/labels.ts`).
 */
import { useSyncExternalStore, type ComponentType } from "react";
import * as ui from "@getpaseo/plugin/client/ui";
import type { PluginClientContext } from "@getpaseo/plugin/client";

import { formatMoment } from "../shared/forecast.ts";
import { isPending } from "../shared/guard/policy.ts";
import { accountBadge, heldBadge, type RowBadgeView } from "../shared/guard/row-badge.ts";
import type { AgentDirectory } from "./agents.ts";
import { guardSnapshot, subscribeGuard } from "./guard/status.ts";
import { subscribeSubscriptions, subscriptionsSnapshot } from "./subscriptions.ts";

/** The item ids, also each item's toggle in the sidebar's Show menu. `check-bundles.mjs` pins them. */
export const HELD_BADGE_ID = "held";
export const ACCOUNT_BADGE_ID = "account";

/** Paseo 0.17.1's badge API, typed here because the repo builds against 0.14's types. */
interface RowBadgeItem {
  id: string;
  title: string;
  icon: string;
  Component: ComponentType<{ workspaceId: string }>;
}
type BadgeHost = PluginClientContext & { addWorkspaceRowBadgeItem?: (item: RowBadgeItem) => () => void | Promise<void> };
type BadgeProps = { icon?: string; label?: string; tone?: RowBadgeView["tone"]; accessibilityLabel?: string };

export function rowBadgesSupported(client: PluginClientContext): boolean {
  return typeof (client as BadgeHost).addWorkspaceRowBadgeItem === "function"
    && typeof (ui as unknown as { WorkspaceRowBadge?: unknown }).WorkspaceRowBadge !== "undefined";
}

export function contributeRowBadges(client: PluginClientContext, agents: AgentDirectory): Array<() => void | Promise<void>> {
  const host = client as BadgeHost;
  const Found = (ui as unknown as { WorkspaceRowBadge?: ComponentType<BadgeProps> }).WorkspaceRowBadge;
  if (typeof host.addWorkspaceRowBadgeItem !== "function" || Found === undefined) return [];
  const Badge: ComponentType<BadgeProps> = Found;
  const add = (item: RowBadgeItem) => host.addWorkspaceRowBadgeItem!(item);
  const useAgents = () => useSyncExternalStore(agents.subscribe, agents.version, agents.version);
  const workspaceOf = (agentId: string, fallback?: string) => agents.current().get(agentId)?.workspaceId ?? fallback;

  function HeldBadge({ workspaceId }: { workspaceId: string }) {
    const status = useSyncExternalStore(subscribeGuard, guardSnapshot, guardSnapshot);
    useAgents();
    // Only holds this process governs, as on the pill: another governor draws its own.
    if (status === null || status.governor !== "active") return null;
    const here = status.pauses.filter((pause) => isPending(pause) && workspaceOf(pause.agentId, pause.workspaceId) === workspaceId);
    const now = Date.now();
    const view = heldBadge(here, now, (iso) => formatMoment(iso, now));
    return view === null ? null : <Badge icon="Pause" label={view.label} tone={view.tone} accessibilityLabel={view.accessibilityLabel} />;
  }

  function AccountBadge({ workspaceId }: { workspaceId: string }) {
    const subs = useSyncExternalStore(subscribeSubscriptions, subscriptionsSnapshot, subscriptionsSnapshot);
    useAgents();
    const open = [...agents.current()].filter(([, agent]) => agent.workspaceId === workspaceId && !agent.closed).map(([id]) => id);
    const view = accountBadge(subs, open);
    return view === null ? null : <Badge icon="UserRound" label={view.label} tone={view.tone} accessibilityLabel={view.accessibilityLabel} />;
  }

  return [
    add({ id: HELD_BADGE_ID, title: "Held sessions", icon: "Pause", Component: HeldBadge }),
    add({ id: ACCOUNT_BADGE_ID, title: "Accounts", icon: "UserRound", Component: AccountBadge }),
  ];
}
