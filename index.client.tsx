import { withButtonVisibility } from "./client/button-visibility";
import { contributeDisplay } from "./client/display";
import type { PluginClientContext } from "@getpaseo/plugin/client";

import { observeAgents } from "./client/agents";
import { contributeChat } from "./client/chat";
import { contributeGuardClient } from "./client/guard/index";
import { createLive } from "./client/live";
import { OVERVIEW_SCREEN, SMART_COMPACT_SETTINGS, makeOverview } from "./client/overview";
import { contributeClient, refreshPills } from "./client/pill";
import { SmartCompactSettings } from "./client/settings";
import { enrolmentState } from "./shared/governor";
import { budgetStatus, getSettings, setSettings } from "./shared/smart-session";

export default function contribute(host: PluginClientContext) {
  const visibility = withButtonVisibility(host);
  const client = visibility.client;
  const live = createLive();
  const removers = [
    client.addScreen({ id: OVERVIEW_SCREEN, title: "Smart Session", Component: makeOverview(client, live) }),
    client.addSettingsScreen({ id: SMART_COMPACT_SETTINGS, title: "Smart Compact", icon: "FoldVertical", Component: SmartCompactSettings }),
    contributeDisplay(client, live),
    client.addCommandCenterItem({
      id: "smart-session-open",
      title: "Smart Session: plan usage and context",
      icon: "Gauge",
      keywords: ["usage", "budget", "limit", "forecast", "context", "tokens", "compact", "smart session"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: OVERVIEW_SCREEN });
      },
    }),
    client.addCommandCenterItem({
      id: "smart-session-pill",
      title: "Show or hide the context pill",
      icon: "ToggleLeft",
      keywords: ["pill", "compact", "smart", "context", "ring", "enrol"],
      context: "global",
      async onSelect({ rpc }) {
        const { settings } = await rpc(getSettings, {});
        await rpc(setSettings, { showPill: !settings.showPill });
        await refreshPills(() => rpc(enrolmentState, {}));
      },
    }),
    contributeChat(client),
  ];

  // The sidebar row shows the session window between overview visits.
  const readBudget = () => client.rpc(budgetStatus, {}).then((budget) => live.setBudget(budget)).catch(() => undefined);
  void readBudget();
  const budgetTimer = setInterval(() => void readBudget(), 2 * 60_000);

  // One agent observation for every pill in this bundle.
  const agents = observeAgents(client);
  const removeClient = contributeClient(client, agents);
  const removeGuard = contributeGuardClient(client, agents, live);
  return () => {
    clearInterval(budgetTimer);
    removeGuard();
    removeClient();
    for (const remove of removers.splice(0)) void remove();
    visibility.dispose();
    return agents.dispose();
  };
}
