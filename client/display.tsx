import type { PluginClientContext, PluginSidebarContribution, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useEffect } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { displayPreferences, displayRpc } from "../shared/display";
import { withNavigation } from "./navigation";
import { sidebarVisibility } from "./sidebar-visibility";

type Display = import("zod").infer<typeof displayPreferences.schema>;
const listeners = new Set<(values: Display) => void>();
export function subscribeDisplay(listener: (values: Display) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

function DisplaySettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(displayPreferences);
  const values = settings.status === "ready" ? settings.values : undefined;
  useEffect(() => {
    if (values !== undefined) for (const listener of listeners) listener(values);
  }, [values]);

  if (settings.status === "loading") return <ActivityIndicator accessibilityLabel="Loading display settings" color={theme.colors.foregroundMuted} />;
  if (settings.status !== "ready") return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>
      <SettingsCard>
        <SettingsAction label="Try loading the saved settings again" actionLabel="Retry" onPress={() => void settings.reload()} />
        {settings.status === "invalid" && <SettingsAction label="Replace invalid display settings with defaults" actionLabel="Reset" disabled={settings.saving} onPress={() => void settings.reset()} />}

      </SettingsCard>
      {settings.saveError && <Text style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text>}
    </View>
  );

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
    <SettingsSection title="Navigation">
      <SettingsCard>
        <SettingsSwitch
          label="Show in sidebar"
          hint="Open this plugin from Command-K (Ctrl-K on Windows and Linux) while viewing a workspace or plugin on this host."
          value={settings.values.showSidebar}
          disabled={settings.saving}
          onValueChange={(showSidebar) => void settings.save({ ...settings.values, showSidebar }, settings.revision)}
        />

        <SettingsSwitch label="Show composer button" hint="Command-K and the sidebar remain available when this button is hidden." value={settings.values.enable_composer_button} disabled={settings.saving} onValueChange={(enable_composer_button) => void settings.save({ ...settings.values, enable_composer_button }, settings.revision)} />
      </SettingsCard>
      {settings.saveError && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text>}
    </SettingsSection>
    </ScrollView>
  );
}

/** Settings notifications reach mounted screens; poll for changes made on other clients. */
export function contributeDisplay(client: PluginClientContext, item: PluginSidebarContribution) {
  const sidebar = sidebarVisibility(() => client.addSidebarItem(item));
  // Paseo 0.10.1 memoizes sidebar route resolution when an installation mounts.
  // Register synchronously, then reconcile the saved preference, so that an
  // already-open sidebar route can resolve its surface during that first render.
  sidebar.set(true);
  const Settings = withNavigation(DisplaySettings, client, item.surface, "display");
  const removeSurface = client.addSurface("display-settings", Settings);
  const removeSettings = client.addSettingsScreen({ id: "display", title: "Display", icon: "PanelLeft", Component: Settings });
  const removeCommand = client.addCommandCenterItem({
    id: "display-settings",
    title: `${item.title}: display settings`,
    icon: "PanelLeft",
    keywords: [item.title, "sidebar", "show", "hide", "display", "settings"],
    context: "global",
    onSelect({ openSurface }) { openSurface("display-settings"); },
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
    removeSurface();
    removeSettings();
    removeCommand();
  };
}
