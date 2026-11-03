import { withButtonVisibility } from "./client/button-visibility";
import { contributeDisplay } from "./client/display";
import { withNavigation } from "./client/navigation";
import type { PluginClientContext } from "@getpaseo/plugin/client";

import { observeAgents } from "./client/agents";
import { contributeGuardClient } from "./client/guard/index";
import { contributeClient, refreshPills } from "./client/pill";
import { SmartSessionSurface } from "./client/surface";
import { enrolmentState } from "./shared/governor";
import { getSettings, setSettings } from "./shared/smart-session";

export default function contribute(host: PluginClientContext) {
  const visibility = withButtonVisibility(host);
  const client = visibility.client;
  client.addSurface("overview", withNavigation((props) => <SmartSessionSurface {...props} openSurface={client.openSurface} />, client, "overview"));
  const removeDisplay = contributeDisplay(client, {
    id: "smart-session",
    title: "Smart Session",
    icon: "Gauge",
    surface: "overview",
  });

  client.addCommandCenterItem({
    id: "smart-session-open",
    title: "Show plan usage and agent context",
    icon: "Gauge",
    keywords: ["usage", "budget", "limit", "context", "tokens", "compact"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("overview");
    },
  });

  client.addCommandCenterItem({
    id: "smart-session-pill",
    title: "Show or hide the smart-compact pill",
    icon: "ToggleLeft",
    keywords: ["pill", "compact", "smart", "governor", "enrol"],
    context: "global",
    async onSelect({ rpc }) {
      const { settings } = await rpc(getSettings, {});
      await rpc(setSettings, { showPill: !settings.showPill });
      await refreshPills(() => rpc(enrolmentState, {}));
    },
  });

  // One agent observation for every pill in this bundle.
  const agents = observeAgents(client);
  const removeClient = contributeClient(client, agents);
  const removeGuard = contributeGuardClient(client, agents, "overview");
  return () => { removeGuard(); removeClient(); visibility.dispose(); removeDisplay(); return agents.dispose(); };
}
