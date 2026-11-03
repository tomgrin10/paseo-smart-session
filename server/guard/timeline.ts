import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { Notification } from "../../shared/guard/timeline.ts";

export type PublishTimeline = (agentId: string, notification: Notification, reconcile: boolean) => Promise<void>;
export function timelinePublisher(api: () => Promise<PluginHandlerContext["paseo"]>): PublishTimeline {
  return async (agentId, notification, reconcile) => {
    const timeline = (await api()).agents.ref(agentId).timeline;
    if (reconcile) {
      // Lost acknowledgements are checked against durable history before retry.
      // Only IDs/timestamps are inspected; content is never logged or retained.
      let cursor: NonNullable<Parameters<typeof timeline.refetch>[0]>["cursor"];
      for (let page = 0; page < 32; page++) {
        const result = await timeline.refetch({ direction: cursor ? "before" : "tail", ...(cursor ? { cursor } : {}), limit: 100, projection: "canonical" });
        if (result.error || result.staleCursor) throw new Error("Timeline receipt could not be checked.");
        if (result.entries.some(entry => entry.item.type === "plugin" && entry.item.id === notification.id)) return;
        if (!result.hasOlder || result.entries.some(entry => Date.parse(entry.timestamp) < Date.parse(notification.data.at))) break;
        if (!result.startCursor) throw new Error("Timeline receipt cursor is unavailable.");
        cursor = result.startCursor;
        if (page === 31) throw new Error("Timeline receipt check exceeded its page budget.");
      }
    }
    await timeline.append({ type: "plugin", id: notification.id, kind: "quota-pause", version: 1, data: notification.data });
  };
}
