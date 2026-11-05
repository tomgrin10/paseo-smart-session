import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { displayPreferences, displayRpc } from "../shared/display";
import { Chip, useNow } from "./kit";
import { useLive, type Live } from "./live";
import { OVERVIEW_SCREEN, sidebarTrailing } from "./overview";
import { sidebarVisibility } from "./sidebar-visibility";
import { tabular, toneColor } from "./theme";

type Display = import("zod").infer<typeof displayPreferences.schema>;
const listeners = new Set<(values: Display) => void>();
export function subscribeDisplay(listener: (values: Display) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** Tells the pill and the sidebar about a display document read anywhere in this bundle. */
export function broadcastDisplay(values: Display) {
  for (const listener of [...listeners]) listener(values);
}

/** The sidebar row, and the display preference poll that drives it and the pill. */
export function contributeDisplay(client: PluginClientContext, live: Live) {
  function SmartSessionSidebarItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
    useLive(live);
    const now = useNow(60_000);
    const trailing = sidebarTrailing(live, now);
    const c = theme.colors;
    return (
      <SidebarRow
        icon="Gauge"
        active={currentScreen?.screenId === OVERVIEW_SCREEN || currentScreen?.screenId === "paused-sessions"}
        onPress={() => openScreen({ screenId: OVERVIEW_SCREEN })}
        trailing={trailing === null ? undefined : trailing.tone === "muted"
          ? <Text accessibilityLabel={trailing.a11y} numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, ...tabular }}>{trailing.label}</Text>
          : <Chip theme={theme} icon={trailing.label.endsWith("paused") ? "Pause" : undefined} label={trailing.label} color={toneColor(c, trailing.tone)} accessibilityLabel={trailing.a11y} />}
      />
    );
  }

  const sidebar = sidebarVisibility(() => client.addSidebarHeaderItem({ id: "smart-session", title: "Smart Session", Component: SmartSessionSidebarItem }));
  // Paseo 0.10.1 memoizes sidebar route resolution when an installation mounts.
  // Register synchronously, then reconcile the saved preference, so that an
  // already-open sidebar route can resolve its screen during that first render.
  sidebar.set(true);
  let disposed = false;
  let pending = false;
  let generation = 0;
  const update = (values: Display) => { generation += 1; sidebar.set(values.showSidebar); };
  listeners.add(update);
  const refresh = async () => {
    if (disposed || pending) return;
    pending = true;
    const currentGeneration = generation;
    try {
      const result = await client.rpc(displayRpc.read, {});
      if (!disposed && generation === currentGeneration && result.status === "ready") {
        const parsed = displayPreferences.schema.safeParse(result.values);
        if (parsed.success) { sidebar.set(parsed.data.showSidebar); broadcastDisplay(parsed.data); }
      }
    } catch {
      // Retain the last valid preference through temporary disconnects.
    } finally { pending = false; }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), 5000);
  return () => {
    disposed = true;
    clearInterval(timer);
    listeners.delete(update);
    sidebar.dispose();
  };
}
