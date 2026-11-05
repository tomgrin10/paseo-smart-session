import type { PluginClientContext, PluginSidebarItemProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch, SidebarRow } from "@getpaseo/plugin/client/ui";
import { useEffect } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { displayPreferences, displayRpc } from "../shared/display";
import { Chip, useNow } from "./kit";
import { useLive, type Live } from "./live";
import { OVERVIEW_SCREEN, sidebarTrailing } from "./overview";
import { sidebarVisibility } from "./sidebar-visibility";
import { tabular, toneColor } from "./theme";

type Display = import("zod").infer<typeof displayPreferences.schema>;
const listeners = new Set<(values: Display) => void>();
export function subscribeDisplay(listener: (values: Display) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** Where Smart Session shows up. Hiding something never turns its feature off. */
function DisplaySettings({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(displayPreferences);
  const values = settings.status === "ready" ? settings.values : undefined;
  useEffect(() => {
    if (values !== undefined) for (const listener of listeners) listener(values);
  }, [values]);

  if (settings.status === "loading") return <ActivityIndicator accessibilityLabel="Loading display settings" color={theme.colors.foregroundMuted} style={{ padding: 24 }} />;
  if (settings.status !== "ready") return (
    <View style={{ gap: 12, padding: 16 }}>
      <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>
      <SettingsCard>
        <SettingsAction label="Try loading the saved settings again" actionLabel="Retry" onPress={() => void settings.reload()} />
        {settings.status === "invalid" && <SettingsAction label="Replace invalid display settings with defaults" actionLabel="Reset" disabled={settings.saving} onPress={() => void settings.reset()} />}
      </SettingsCard>
      {settings.saveError && <Text style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text>}
    </View>
  );

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 8, gap: 16 }}>
      <SettingsSection title="Where Smart Session appears" info="Hiding a row or a pill never turns its feature off. ⌘K Smart Session still opens the overview.">
        <SettingsCard>
          <SettingsSwitch
            label="Sidebar row"
            hint="Smart Session in the sidebar, with the session window's usage, or how many sessions are paused."
            value={settings.values.showSidebar}
            disabled={settings.saving}
            onValueChange={(showSidebar) => void settings.save({ ...settings.values, showSidebar }, settings.revision)}
          />
          <SettingsSwitch
            label="Composer pills"
            hint="The context ring and, while Session Guard runs, its shield, above each message box."
            value={settings.values.enable_composer_button}
            disabled={settings.saving}
            onValueChange={(enable_composer_button) => void settings.save({ ...settings.values, enable_composer_button }, settings.revision)}
          />
        </SettingsCard>
        {settings.saveError && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text>}
      </SettingsSection>
    </ScrollView>
  );
}

/** The sidebar row, the Display settings screen, and the preference poll that drives both. */
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
          ? <Text accessibilityLabel={`Session window ${trailing.label} used`} numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, ...tabular }}>{trailing.label}</Text>
          : <Chip theme={theme} label={trailing.label} color={toneColor(c, trailing.tone)} />}
      />
    );
  }

  const sidebar = sidebarVisibility(() => client.addSidebarHeaderItem({ id: "smart-session", title: "Smart Session", Component: SmartSessionSidebarItem }));
  // Paseo 0.10.1 memoizes sidebar route resolution when an installation mounts.
  // Register synchronously, then reconcile the saved preference, so that an
  // already-open sidebar route can resolve its screen during that first render.
  sidebar.set(true);
  const removeSettings = client.addSettingsScreen({ id: "display", title: "Display", icon: "PanelLeft", Component: DisplaySettings });
  const removeCommand = client.addCommandCenterItem({
    id: "display-settings",
    title: "Smart Session: display settings",
    icon: "PanelLeft",
    keywords: ["smart session", "sidebar", "pill", "show", "hide", "display", "settings"],
    context: "global",
    onSelect({ openSettings }) { openSettings("display"); },
  });
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
        if (parsed.success) { sidebar.set(parsed.data.showSidebar); for (const listener of listeners) listener(parsed.data); }
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
    removeSettings();
    removeCommand();
  };
}
