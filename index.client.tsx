import { withButtonVisibility } from "./client/button-visibility";
import { contributeDisplay } from "./client/display";
import type { PluginClientContext } from "@getpaseo/plugin/client";

import { observeAgents } from "./client/agents";
import { contributeChat } from "./client/chat";
import { commandItems } from "./client/commands";
import { contributeGuardTimeline } from "./client/guard/index";
import { watchGuard } from "./client/guard/status";
import { createLive } from "./client/live";
import { OVERVIEW_SCREEN, PAUSED_SCREEN, SMART_COMPACT_SETTINGS, makeOverview } from "./client/overview";
import { contributeClient } from "./client/pill";
import { makeSettings } from "./client/settings";
import { budgetStatus } from "./shared/smart-session";

export default function contribute(host: PluginClientContext) {
  const visibility = withButtonVisibility(host);
  const client = visibility.client;
  const live = createLive();
  const Overview = makeOverview(client, live);
  const removers = [
    client.addScreen({ id: OVERVIEW_SCREEN, title: "Smart Session", Component: Overview }),
    // The old Paused sessions screen: links to it from older chats and clients land on the list.
    client.addScreen({ id: PAUSED_SCREEN, title: "Smart Session", Component: (props) => <Overview {...props} params={{ ...props.params, focus: "paused" }} /> }),
    client.addSettingsScreen({ id: SMART_COMPACT_SETTINGS, title: "Settings", icon: "Gauge", Component: makeSettings(client) }),
    contributeDisplay(client, live),
    ...commandItems().map((item) => client.addCommandCenterItem(item)),
    contributeChat(client),
    contributeGuardTimeline(client),
  ];

  // The sidebar row shows the session window between overview visits.
  const readBudget = () => client.rpc(budgetStatus, {}).then((budget) => live.setBudget(budget)).catch(() => undefined);
  void readBudget();
  const budgetTimer = setInterval(() => void readBudget(), 2 * 60_000);

  // One agent observation and one protection poll for the one pill.
  const agents = observeAgents(client);
  const stopGuard = watchGuard(client, live);
  // The pill registers on the host's own client: a paused session keeps it even when pills are hidden.
  const removeClient = contributeClient(host, agents);
  return () => {
    clearInterval(budgetTimer);
    stopGuard();
    removeClient();
    for (const remove of removers.splice(0)) void remove();
    visibility.dispose();
    return agents.dispose();
  };
}
