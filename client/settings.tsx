import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";

import { formatCompactTokens } from "../shared/format";
import { enrolmentState } from "../shared/governor";
import { getSettings, installStatus, setSettings } from "../shared/smart-session";
import { withCompactThreshold } from "../shared/thresholds";
import { errorText } from "./kit";
import { refreshPills } from "./pill-store";

/** A whole number from 1 to 99, or null. */
function percent(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 99 ? parsed : null;
}

/**
 * Settings → Plugins → Smart Session → Smart Compact. Everything that tunes when a
 * session is asked to compact itself; the overview keeps only the on/off switch.
 */
export function SmartCompactSettings({ theme, layout }: PluginSurfaceProps) {
  const c = theme.colors;
  const toast = useToast();
  const queryClient = useQueryClient();
  const read = useRpc(getSettings);
  const write = useRpc(setSettings);
  const readEnrolment = useRpc(enrolmentState);
  const readInstall = useRpc(installStatus);
  const query = useQuery({ queryKey: ["smart-session", "settings"], queryFn: () => read({}), refetchInterval: 60_000 });
  const install = useQuery({ queryKey: ["smart-session", "install"], queryFn: () => readInstall({}), refetchInterval: 5 * 60_000 });
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<{ large: string; small: string } | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const settings = query.data?.settings;
  useEffect(() => { setDraft(null); }, [settings?.thresholds.large.compact, settings?.thresholds.small.compact]);

  if (query.isError && settings === undefined) return <View style={{ padding: 16, gap: 12 }}>
    <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{errorText(query.error)}</Text>
    <SettingsCard><SettingsAction label="Load the settings again" actionLabel="Retry" onPress={() => void query.refetch()} /></SettingsCard>
  </View>;
  if (settings === undefined) return <ActivityIndicator accessibilityLabel="Loading Smart Compact settings" color={c.foregroundMuted} style={{ padding: 24 }} />;

  async function save(patch: Parameters<typeof write>[0], message: string) {
    setSaving(true);
    try {
      await write(patch);
      await refreshPills(() => readEnrolment({}));
      await queryClient.invalidateQueries({ queryKey: ["smart-session"] });
      toast.show(message);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setSaving(false);
    }
  }

  const large = draft === null ? settings.thresholds.large.compact : percent(draft.large);
  const small = draft === null ? settings.thresholds.small.compact : percent(draft.small);
  const changed = draft !== null && large !== null && small !== null && (large !== settings.thresholds.large.compact || small !== settings.thresholds.small.compact);
  const off = !settings.enabled || saving;
  const report = install.data?.report;
  const hooksHint = report === undefined ? "Keeps this plugin's context and compaction hooks in ~/.claude/settings.json."
    : report.error !== null ? report.error
      : report.pluginDir === null || report.hooks.length === 0 ? "Not registered, so nothing will ask a session to compact itself."
        : `Registered: ${report.hooks.join(", ")}. Only entries that point at this plugin are touched.`;
  const from = formatCompactTokens(settings.thresholds.largeWindowFrom);

  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 8, gap: 24 }}>
    <SettingsSection title="Smart Compact" info="A session is never compacted unless it agrees. At the end of a turn past its line, it is asked whether to compact; it can compact, put it off with a reason, or keep working.">
      <SettingsCard>
        <SettingsSwitch label="Smart Compact" hint={settings.enabled ? "On. Context notices, and the question at the compact line." : "Off. Nothing is asked and nothing is compacted."}
          value={settings.enabled} disabled={saving} onValueChange={(enabled) => void save({ enabled }, enabled ? "Smart Compact on" : "Smart Compact off")} />
        <SettingsSwitch label="Enrol sessions automatically" hint="A session that saves its task state with the checkpoint tool is enrolled by that alone. Off, enrol each one from its pill."
          value={settings.autoEnrol} disabled={off} onValueChange={(autoEnrol) => void save({ autoEnrol }, autoEnrol ? "Sessions enrol themselves" : "Sessions are enrolled one at a time")} />
        <SettingsSwitch label="Context pill on every session" hint="A ring above the message box with the session's context and its compact line. Press it to enrol or remove the session."
          value={settings.showPill} disabled={off} onValueChange={(showPill) => void save({ showPill }, showPill ? "Pill shown on every session" : "Pill hidden")} />
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="When to ask" info="What wears a session down is its absolute size, not its share of the window, so large windows are asked much earlier. Earlier context notices move down with the line.">
      <SettingsCard>
        <SettingsInput key={`large-${inputKey}`} label={`Windows of ${from} or more (%)`} hint={`Asked at ${large ?? "—"}%, about ${large === null ? "—" : formatCompactTokens((large / 100) * 1_000_000)} tokens of a 1M window. Default 30.`}
          initialValue={String(settings.thresholds.large.compact)} disabled={off} error={draft !== null && large === null ? "Enter a whole number from 1 to 99." : null}
          onChangeText={(value) => setDraft((previous) => ({ large: value, small: previous?.small ?? String(settings.thresholds.small.compact) }))} />
        <SettingsInput key={`small-${inputKey}`} label={`Smaller windows (%)`} hint={`Asked at ${small ?? "—"}% of a window under ${from}. Default 85.`}
          initialValue={String(settings.thresholds.small.compact)} disabled={off} error={draft !== null && small === null ? "Enter a whole number from 1 to 99." : null}
          onChangeText={(value) => setDraft((previous) => ({ small: value, large: previous?.large ?? String(settings.thresholds.large.compact) }))} />
        {draft !== null ? <>
          <SettingsAction label="Apply the new lines" hint={changed ? `Large ${large}% · small ${small}%` : "Nothing to apply yet"} actionLabel="Save" disabled={!changed || off}
            onPress={() => void save({ thresholds: { ...settings.thresholds, large: withCompactThreshold(settings.thresholds.large, large!), small: withCompactThreshold(settings.thresholds.small, small!) } }, `Smart Compact asks at ${large}% and ${small}%`)} />
          <SettingsAction label="Keep the saved lines" actionLabel="Discard" disabled={saving} onPress={() => { setDraft(null); setInputKey((k) => k + 1); }} />
        </> : null}
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="Claude Code">
      <SettingsCard>
        <SettingsSwitch label="Register the hooks" hint={hooksHint} value={settings.installHooks} disabled={off}
          onValueChange={(installHooks) => void save({ installHooks }, installHooks ? "Hooks registered with Claude Code" : "Hooks removed from Claude Code")} />
        {report?.mcp === "unavailable" ? <SettingsRow label="MCP server not registered" hint="The claude command was not reachable from the daemon." /> : null}
      </SettingsCard>
    </SettingsSection>
  </ScrollView>;
}
