import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ScrollView } from "react-native";

import { TimelineDataSchema } from "../../shared/guard/timeline.ts";
import type { AgentDirectory } from "../agents.ts";
import { withNavigation } from "../navigation.tsx";
import { PausedSessions } from "./paused.tsx";
import { guardPillIcons } from "./pill-icons.tsx";
import { contributePills } from "./pills.ts";
import { GuardSettings } from "./settings.tsx";
import { GUARD_SURFACES } from "./surfaces.ts";
import { GuardTimelineItem } from "./timeline.tsx";

/** Session Guard's client half: its settings, paused-sessions list, timeline cards and pill. */
export function contributeGuardClient(client: PluginClientContext, agents: AgentDirectory, home: string) {
  const openPaused = () => client.openSurface(GUARD_SURFACES.paused);
  const openSettings = () => client.openSurface(GUARD_SURFACES.settings);
  const Settings = withNavigation((props) => (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <GuardSettings {...props} openOverview={openPaused} />
    </ScrollView>
  ), client, home, "session-guard");
  const Paused = withNavigation((props) => <PausedSessions {...props} openSettings={openSettings} />, client, home, "session-guard");

  const removers = [
    client.addSurface(GUARD_SURFACES.settings, Settings),
    client.addSurface(GUARD_SURFACES.paused, Paused),
    client.addSettingsScreen({ id: "session-guard", title: "Session Guard", icon: "ShieldCheck", Component: Settings }),
    client.addCommandCenterItem({
      id: "session-guard-settings", title: "Session Guard: settings", icon: "ShieldCheck",
      keywords: ["quota", "limit", "reset", "pause", "resume", "protection", "session guard"], context: "global",
      onSelect({ openSurface }) { openSurface(GUARD_SURFACES.settings); },
    }),
    client.addCommandCenterItem({
      id: "session-guard-paused", title: "Session Guard: paused sessions", icon: "Pause",
      keywords: ["quota", "waiting", "reset", "resume", "subagents", "session guard"], context: "global",
      onSelect({ openSurface }) { openSurface(GUARD_SURFACES.paused); },
    }),
    // The kind and version the standalone plugin wrote, so a pause it recorded and this
    // plugin later delivers renders the same card.
    client.addTimelineRenderer({
      kind: "quota-pause", version: 1, schema: TimelineDataSchema,
      Component: (props) => <GuardTimelineItem {...props} openOverview={openPaused} />,
    }),
    contributePills(client, agents, guardPillIcons),
  ];
  return () => {
    for (const remove of removers.splice(0)) remove();
  };
}
