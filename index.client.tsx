import { withButtonVisibility } from "./client/button-visibility";
import { contributeDisplay } from "./client/display";
import { withNavigation } from "./client/navigation";
import type { PluginClientContext } from "@getpaseo/plugin/client";

import { contributeClient, refreshPills } from "./client/pill";
import { SmartSessionSurface } from "./client/surface";
import { enrolmentState } from "./shared/governor";
import { getSettings, setSettings } from "./shared/smart-session";

export default function contribute(host: PluginClientContext) {
  const visibility = withButtonVisibility(host);
  const client = visibility.client;
  client.addSurface("overview", withNavigation(SmartSessionSurface, client, "overview"));
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

  const removeClient = contributeClient(client);
  return () => { visibility.dispose(); removeDisplay(); return removeClient(); };
}
