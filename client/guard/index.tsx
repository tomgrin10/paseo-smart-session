import type { PluginClientContext } from "@getpaseo/plugin/client";

import { TimelineDataSchema } from "../../shared/guard/timeline.ts";
import { GuardTimelineItem } from "./timeline.tsx";

/**
 * The pause card in the chat. The kind and version are the ones the standalone
 * Session Guard plugin wrote, so a pause it recorded and this plugin later delivers
 * renders the same card, and old chats keep rendering.
 */
export function contributeGuardTimeline(client: PluginClientContext) {
  const openPaused = () => client.openScreen({ screenId: "overview", params: { focus: "paused" } });
  return client.addTimelineRenderer({
    kind: "quota-pause", version: 1, schema: TimelineDataSchema,
    Component: (props) => <GuardTimelineItem {...props} openOverview={openPaused} />,
  });
}
