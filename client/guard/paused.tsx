import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { cancelResumeRpc, statusRpc } from "../../shared/guard/contracts.ts";
import { governorNotice, pauseOwnerNote, pausedSessions, pausePresentation } from "../../shared/guard/presentation.ts";

export function PausedSessions({ theme, host, layout, navigation, openSettings }: PluginSurfaceProps & { openSettings(): void }) {
  const read = useRpc(statusRpc);
  const cancel = useRpc(cancelResumeRpc);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof read>> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let stopped = false, fetching = false;
    const fetch = async () => {
      if (fetching || stopped) return;
      fetching = true;
      try { const next = await read({}); if (!stopped) { setStatus(next); setLoadError(null); } }
      catch { if (!stopped) setLoadError("Could not refresh paused sessions. Showing the last report; retrying automatically."); }
      finally { fetching = false; }
    };
    refresh.current = fetch;
    void fetch(); const timer = setInterval(() => void fetch(), 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [read]);
  const release = async (agentId: string) => {
    if (busy) return;
    setBusy(agentId);
    try { await cancel({ agentId }); await refresh.current(); setActionError(null); }
    catch { setActionError("Could not change this pause. Refresh the list and try again."); }
    finally { setBusy(null); }
  };
  const all = status ? pausedSessions(status.pauses) : [];
  const visible = status ? pausedSessions(status.pauses, query) : [];
  const attention = visible.filter(p => p.phase === "attention");
  const waiting = visible.filter(p => p.phase !== "attention");
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 };
  // Both plugins share one state file: when this one is not governing, the list is
  // the other plugin's (or a leftover), and its controls would only fail.
  const notice = status ? governorNotice(status) : null;
  const owner = status ? pauseOwnerNote(status) : null;
  const row = (pause: typeof all[number]) => {
    const presentation = pausePresentation(pause, status!.policy);
    const hint = `${pause.provider} · ${pause.agentId.slice(0, 8)} · ${presentation.coverage}\n${presentation.resetLabel}\n${owner ?? presentation.state}${pause.note ? `\n${pause.note}` : ""}`;
    return <View key={pause.id}>
      {navigation ? <SettingsAction label={presentation.title} hint={hint} actionLabel="Open session" onPress={() => navigation.openAgent({ agentId: pause.agentId, serverId: host.id })} />
        : <SettingsRow label={presentation.title} hint={hint} />}
      {owner === null && <SettingsAction label={busy === pause.agentId ? "Updating this pause…" : "Manual control"} hint={presentation.actionHint} actionLabel={presentation.actionLabel} disabled={busy !== null} onPress={() => void release(pause.agentId)} />}
    </View>;
  };
  return <ScrollView contentContainerStyle={{ padding: layout.compact ? 16 : 24, paddingBottom: 40 }}>
    <View style={{ width: "100%", maxWidth: 760, alignSelf: "center", gap: 24 }}>
      <View style={{ gap: 8 }}>
        <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "600" }}>Paused sessions</Text>
        <Text style={muted}>All Session Guard pauses on {host.label}. Native subagents are included with their parent session.</Text>
      </View>
      {!status && !loadError && <ActivityIndicator accessibilityLabel="Loading paused sessions" color={theme.colors.foregroundMuted} />}
      {notice && <SettingsCard><SettingsAction label={notice.title} hint={notice.hint} actionLabel="Settings" onPress={openSettings} /></SettingsCard>}
      {status && !notice && <SettingsCard><SettingsAction label={`${all.length} ${all.length === 1 ? "session" : "sessions"} in Session Guard${all.some(p => p.phase === "attention") ? " · attention needed" : ""}`} hint={status.checkedAt ? `Last checked ${new Date(status.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · refreshes automatically` : "Waiting for the first usage check"} actionLabel="Refresh" onPress={() => void refresh.current()} /></SettingsCard>}
      {(all.length > 5 || query !== "") && <SettingsCard><SettingsInput label="Find a paused session" placeholder="Title or provider" initialValue="" onChangeText={setQuery} /></SettingsCard>}
      {status && all.length === 0 && !notice && <SettingsCard><SettingsRow label="No sessions are paused" hint="When a protected session reaches its limit, it appears here and receives a timeline entry." /></SettingsCard>}
      {status && all.length > 0 && visible.length === 0 && <SettingsCard><SettingsRow label="No matching paused sessions" hint="Try another title or provider." /></SettingsCard>}
      {owner && visible.length > 0 && <SettingsSection title={`Not managed by Smart Session (${visible.length})`}><SettingsCard>{visible.map(row)}</SettingsCard></SettingsSection>}
      {!owner && attention.length > 0 && <SettingsSection title={`Needs attention (${attention.length})`}><SettingsCard>{attention.map(row)}</SettingsCard></SettingsSection>}
      {!owner && waiting.length > 0 && <SettingsSection title={`Waiting for reset (${waiting.length})`}><SettingsCard>{waiting.map(row)}</SettingsCard></SettingsSection>}
      <SettingsCard><SettingsAction label="Protection and timing" hint="Configure the default, native subagents, and automatic resume." actionLabel="Settings" onPress={openSettings} /></SettingsCard>
      {loadError && <Text accessibilityRole="alert" style={{ ...muted, color: theme.colors.statusDanger }}>{status ? loadError : "Could not load paused sessions. Retrying automatically."}</Text>}
      {actionError && <Text accessibilityRole="alert" style={{ ...muted, color: theme.colors.statusDanger }}>{actionError}</Text>}
      {status?.error && !notice && <Text accessibilityRole="alert" style={{ ...muted, color: theme.colors.statusDanger }}>{status.error}</Text>}
    </View>
  </ScrollView>;
}
