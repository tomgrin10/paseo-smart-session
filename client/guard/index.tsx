import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ScrollView } from "react-native";

import { TimelineDataSchema } from "../../shared/guard/timeline.ts";
import type { AgentDirectory } from "../agents.ts";
import type { Live } from "../live.ts";
import { PausedSessions } from "./paused.tsx";
import { guardPillIcons } from "./pill-icons.tsx";
import { contributePills } from "./pills.ts";
import { GuardSettings } from "./settings.tsx";
import { GUARD_SCREENS, GUARD_SETTINGS } from "./surfaces.ts";
import { GuardTimelineItem } from "./timeline.tsx";

/** Session Guard's client half: its settings, paused-sessions screen, timeline cards and pill. */
export function contributeGuardClient(client: PluginClientContext, agents: AgentDirectory, live?: Live) {
  const openPaused = () => client.openScreen({ screenId: GUARD_SCREENS.paused });
  const openSettings = () => client.openSettings(GUARD_SETTINGS);
  const Settings = (props: Parameters<typeof GuardSettings>[0] extends infer P ? Omit<P, "openOverview"> : never) => (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 8 }}>
      <GuardSettings {...props} openOverview={openPaused} />
    </ScrollView>
  );

  const removers = [
    client.addScreen({ id: GUARD_SCREENS.paused, title: "Paused sessions", Component: (props) => <PausedSessions {...props} openSettings={openSettings} /> }),
    client.addSettingsScreen({ id: GUARD_SETTINGS, title: "Session Guard", icon: "ShieldCheck", Component: Settings }),
    client.addCommandCenterItem({
      id: "session-guard-settings", title: "Session Guard: settings", icon: "ShieldCheck",
      keywords: ["quota", "limit", "reset", "pause", "resume", "protection", "session guard"], context: "global",
      onSelect({ openSettings: open }) { open(GUARD_SETTINGS); },
    }),
    client.addCommandCenterItem({
      id: "session-guard-paused", title: "Session Guard: paused sessions", icon: "Pause",
      keywords: ["quota", "waiting", "reset", "resume", "subagents", "session guard"], context: "global",
      onSelect({ openScreen }) { openScreen({ screenId: GUARD_SCREENS.paused }); },
    }),
    // The kind and version the standalone plugin wrote, so a pause it recorded and this
    // plugin later delivers renders the same card.
    client.addTimelineRenderer({
      kind: "quota-pause", version: 1, schema: TimelineDataSchema,
      Component: (props) => <GuardTimelineItem {...props} openOverview={openPaused} />,
    }),
    contributePills(client, agents, guardPillIcons, live),
  ];
  return () => {
    for (const remove of removers.splice(0)) remove();
  };
}
