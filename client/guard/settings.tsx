import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { cancelResumeRpc, guardPreferences, setProtectionRpc, statusRpc } from "../../shared/guard/contracts.ts";
import { isPending, PolicySchema, type Policy } from "../../shared/guard/policy.ts";

type Draft = { thresholdPct: string; pollSeconds: string; resetGraceSeconds: string; resumeSpacingSeconds: string; continuation: string; providerIds: string; windowIds: string };
function draftOf(policy: Policy): Draft {
  return { thresholdPct: String(policy.thresholdPct), pollSeconds: String(policy.pollSeconds), resetGraceSeconds: String(policy.resetGraceSeconds),
    resumeSpacingSeconds: String(policy.resumeSpacingSeconds), continuation: policy.continuation, providerIds: policy.providerIds.join(", "), windowIds: policy.windowIds.join(", ") };
}
const list = (value: string) => [...new Set(value.split(",").map(s => s.trim()).filter(Boolean))];

export function GuardSettings({ theme, openOverview }: PluginSurfaceProps & { openOverview(): void }) {
  const settings = useSettings(guardPreferences);
  const readStatus = useRpc(statusRpc);
  const cancelResume = useRpc(cancelResumeRpc);
  const setProtection = useRpc(setProtectionRpc);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof readStatus>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    let pending = false;
    const refresh = async () => {
      if (pending || stopped) return;
      pending = true;
      try { const next = await readStatus({}); if (!stopped) { setStatus(next); setStatusError(null); } }
      catch { if (!stopped) setStatusError("Could not load current session status. Retrying automatically."); }
      finally { pending = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [readStatus]);
  if (settings.status === "loading") return <ActivityIndicator accessibilityLabel="Loading Session Guard settings" color={theme.colors.foregroundMuted} />;
  if (settings.status !== "ready") return <View style={{ gap: 12 }}>
    <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>
    <SettingsCard><SettingsAction label="Load saved settings again" actionLabel="Retry" onPress={() => void settings.reload()} />
      {settings.status === "invalid" && <SettingsAction label="Replace invalid settings with defaults" actionLabel="Reset" onPress={() => void settings.reset()} disabled={settings.saving} />}</SettingsCard>
  </View>;
  const change = (patch: Partial<Policy>) => void settings.save({ ...settings.values, ...patch }, settings.revision);
  const action = async (work: () => Promise<unknown>) => {
    try { await work(); setStatus(await readStatus({})); setError(null); }
    catch { setError("The change could not be saved. Try again."); }
  };
  const saveAdvanced = async () => {
    if (!draft || !revision) return;
    const parsed = PolicySchema.safeParse({ ...settings.values, ...draft,
      thresholdPct: Number(draft.thresholdPct), pollSeconds: Number(draft.pollSeconds), resetGraceSeconds: Number(draft.resetGraceSeconds), resumeSpacingSeconds: Number(draft.resumeSpacingSeconds),
      providerIds: list(draft.providerIds), windowIds: list(draft.windowIds),
    });
    if (!parsed.success) { setError(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("\n")); return; }
    if (await settings.save(parsed.data, revision)) { setDraft(null); setRevision(null); setError(null); }
  };
  const text = { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 };
  const waiting = status?.pauses.filter(isPending) ?? [];
  return <View style={{ gap: 24 }}>
    <Text style={text}>Pause work at the provider’s session limit, then continue the same conversation after reset. Your workspace and conversation stay in place.</Text>
    {status?.governor === "deferred" && <SettingsCard><SettingsRow label="Another plugin is running Session Guard" hint="Most likely the standalone Session Guard plugin. It keeps protecting sessions and nothing is paused from here. Uninstall it to hand over; its per-session choices and waiting pauses carry over automatically." /></SettingsCard>}
    <SettingsSection title="Protection"><SettingsCard>
      <SettingsSwitch label="Enable Session Guard" hint="Off until you turn it on. Runs even when Paseo’s app is closed. Turning it off releases suspended workers; message continuations wait until you turn it back on or cancel them." value={settings.values.enabled} disabled={settings.saving || !!draft} onValueChange={enabled => change({ enabled })} />
      <SettingsSelect label="Default for sessions" hint="Each session’s composer pill can override this default. Existing explicit overrides stay in place." value={settings.values.protectByDefault ? "all" : "opt-in"} options={[{ label: "Protect all sessions", value: "all" }, { label: "Opt in per session", value: "opt-in" }]} disabled={settings.saving || !!draft} onValueChange={value => change({ protectByDefault: value === "all" })} />
      <SettingsSwitch label="Continue automatically after reset" hint="Waits for a fresh usage report below your threshold. Turn this off to continue manually." value={settings.values.autoResume} disabled={settings.saving || !!draft} onValueChange={autoResume => change({ autoResume })} />
      <SettingsSwitch label="Include native subagents" hint="On Linux, pause Claude and Codex sessions together with their nested workers. Turn this off to interrupt only the foreground turn." value={settings.values.includeNativeSubagents} disabled={settings.saving || !!draft} onValueChange={includeNativeSubagents => change({ includeNativeSubagents })} />
      <SettingsSwitch label="Label paused workspaces" hint="Show an amber Paused label in the left sidebar until every paused session in that workspace is released." value={settings.values.workspaceLabels} disabled={settings.saving || !!draft} onValueChange={workspaceLabels => change({ workspaceLabels })} />
    </SettingsCard></SettingsSection>
    <SettingsSection title="Waiting for reset"><SettingsCard>
      {!status && <SettingsRow label="Loading session status…" />}
      {status && waiting.length === 0 && <SettingsRow label="No sessions are paused" hint="Protected work will appear here when the session limit is reached." />}
      {waiting.map(pause => <SettingsAction key={pause.id} label={pause.title ?? "Untitled session"} hint={pause.note ?? `${pause.provider}${pause.suspension ? " · Includes native subagents" : ""} · ${pause.anchorResetsAt ? `Reset ${new Date(pause.anchorResetsAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}` : "Waiting for usage to become available"}`} actionLabel={pause.suspension ? "Release and turn off" : "Cancel continuation"} disabled={settings.saving} onPress={() => void action(() => cancelResume({ agentId: pause.agentId }))} />)}
      <SettingsAction label="All paused sessions" hint="Open sessions, check reset times, and manage each pause in one place." actionLabel="Open list" onPress={openOverview} />
    </SettingsCard></SettingsSection>
    {status && Object.keys(status.overrides).length > 0 && <SettingsSection title="Session overrides"><SettingsCard>
      {Object.entries(status.overrides).map(([agentId, enabled]) => <SettingsAction key={agentId} label={status.pauses.find(p => p.agentId === agentId)?.title ?? `Session ${agentId.slice(0, 8)}`} hint={enabled ? "Explicitly protected" : "Excluded from protection"} actionLabel="Use default" onPress={() => void action(() => setProtection({ agentId, enabled: null }))} />)}
    </SettingsCard></SettingsSection>}
    <SettingsSection title="Timing and continuation"><SettingsCard>
      {!draft ? <SettingsAction label={`Pause at ${settings.values.thresholdPct}% session usage`} hint={`Check every ${settings.values.pollSeconds}s · wait ${settings.values.resetGraceSeconds}s after reset · space continuations by ${settings.values.resumeSpacingSeconds}s`} actionLabel="Edit" onPress={() => { setDraft(draftOf(settings.values)); setRevision(settings.revision); }} /> : <>
        <SettingsInput label="Pause threshold (%)" hint="1–100. Default: 100." initialValue={draft.thresholdPct} disabled={settings.saving} onChangeText={value => setDraft(previous => previous && { ...previous, thresholdPct: value })} />
        <SettingsInput label="Check interval (seconds)" hint="5–300. Upstream usage may be cached by Paseo; this cannot force a provider refresh." initialValue={draft.pollSeconds} disabled={settings.saving} onChangeText={value => setDraft(previous => previous && { ...previous, pollSeconds: value })} />
        <SettingsInput label="Wait after reset (seconds)" hint="0–600. Default: 30." initialValue={draft.resetGraceSeconds} disabled={settings.saving} onChangeText={value => setDraft(previous => previous && { ...previous, resetGraceSeconds: value })} />
        <SettingsInput label="Space continuations (seconds)" hint="0–300. Avoid sending every paused session at once." initialValue={draft.resumeSpacingSeconds} disabled={settings.saving} onChangeText={value => setDraft(previous => previous && { ...previous, resumeSpacingSeconds: value })} />
        <SettingsInput label="Continuation message" hint="Sent once into the same conversation after the reset is confirmed." initialValue={draft.continuation} disabled={settings.saving} onChangeText={value => setDraft(previous => previous && { ...previous, continuation: value })} />
        <SettingsInput label="Provider IDs" hint="Comma separated. Leave empty to protect all providers reporting session usage." initialValue={draft.providerIds} disabled={settings.saving} onChangeText={value => setDraft(previous => previous && { ...previous, providerIds: value })} />
        <SettingsInput label="Session window IDs" hint="Comma separated, in preference order. Default: five_hour, session." initialValue={draft.windowIds} disabled={settings.saving} onChangeText={value => setDraft(previous => previous && { ...previous, windowIds: value })} />
        <SettingsAction label="Apply timing and continuation" actionLabel="Save changes" disabled={settings.saving} onPress={() => void saveAdvanced()} />
        <SettingsAction label="Keep saved values" actionLabel="Discard changes" disabled={settings.saving} onPress={() => { setDraft(null); setRevision(null); setError(null); }} />
      </>}
    </SettingsCard></SettingsSection>
    {(error || settings.saveError) && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{error ?? settings.saveError}</Text>}
    {(statusError || status?.error) && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{statusError ?? status?.error}</Text>}
  </View>;
}
