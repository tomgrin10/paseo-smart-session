import { useRpc, useSettings, type PluginClientContext, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";

import { displayPreferences } from "../shared/display";
import { formatCompactTokens } from "../shared/format";
import { enrolmentState } from "../shared/governor";
import { guardPreferences } from "../shared/guard/contracts";
import { isPending, type Policy } from "../shared/guard/policy";
import { checkTiming, timingOf, type Timing } from "../shared/guard/timing";
import { governorNotice } from "../shared/guard/presentation";
import { getSettings, installStatus, setSettings } from "../shared/smart-session";
import { withCompactThreshold } from "../shared/thresholds";
import { broadcastDisplay } from "./display";
import { guardSnapshot, refreshGuard, subscribeGuard } from "./guard/status";
import { errorText } from "./kit";
import { refreshPills } from "./pill-store";

/** A whole number from 1 to 99, or null. */
function percent(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 99 ? parsed : null;
}

/**
 * Settings → Plugins → Smart Session: every setting in one place, in the order a
 * session meets them. Context first (when to compact), then the limit (pause and
 * continue), then where Smart Session shows up, the Claude Code hooks, and the
 * protection timing nobody needs to touch, folded behind Edit. Live lists of paused
 * sessions and per-session choices live on the overview; this links there.
 */
export function makeSettings(client: PluginClientContext) {
  const openPaused = () => client.openScreen({ screenId: "overview", params: { focus: "paused" } });
  return function SmartSessionSettings({ theme }: PluginSurfaceProps) {
    const c = theme.colors;
    const toast = useToast();
    const queryClient = useQueryClient();
    const read = useRpc(getSettings);
    const write = useRpc(setSettings);
    const readEnrolment = useRpc(enrolmentState);
    const readInstall = useRpc(installStatus);
    const query = useQuery({ queryKey: ["smart-session", "settings"], queryFn: () => read({}), refetchInterval: 60_000 });
    const install = useQuery({ queryKey: ["smart-session", "install"], queryFn: () => readInstall({}), refetchInterval: 5 * 60_000 });
    const guard = useSettings(guardPreferences);
    const display = useSettings(displayPreferences);
    const status = useSyncExternalStore(subscribeGuard, guardSnapshot, guardSnapshot);
    const [saving, setSaving] = useState(false);
    const [draft, setDraft] = useState<{ large: string; small: string } | null>(null);
    const [inputKey, setInputKey] = useState(0);
    const [timing, setTiming] = useState<{ draft: Timing; revision: string } | null>(null);
    const [timingTried, setTimingTried] = useState(false);
    const settings = query.data?.settings;
    useEffect(() => { setDraft(null); }, [settings?.thresholds.large.compact, settings?.thresholds.small.compact]);

    // The pill and sidebar follow these documents; `useSettings` hears every client's change.
    const guardValues = guard.status === "ready" ? guard.values : undefined;
    useEffect(() => { if (guardValues !== undefined) refreshGuard(); }, [guardValues]);
    const displayValues = display.status === "ready" ? display.values : undefined;
    useEffect(() => { if (displayValues !== undefined) broadcastDisplay(displayValues); }, [displayValues]);

    if (query.isError && settings === undefined) return <View style={{ paddingVertical: 8, gap: 12 }}>
      <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{errorText(query.error)}</Text>
      <SettingsCard><SettingsAction label="Load the settings again" actionLabel="Retry" onPress={() => void query.refetch()} /></SettingsCard>
    </View>;
    if (settings === undefined) return <ActivityIndicator accessibilityLabel="Loading Smart Session settings" color={c.foregroundMuted} style={{ padding: 24 }} />;

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
    function changeGuard(patch: Partial<Policy>, message: string) {
      if (guard.status !== "ready") return;
      void guard.save({ ...guard.values, ...patch }, guard.revision).then((saved) => {
        if (saved) toast.show(message);
        else toast.error("That change couldn't be saved. Try again.");
      });
    }
    async function setPill(next: boolean) {
      // One switch over two stored preferences: the Smart Compact pill flag and the Display gate.
      if (next && display.status === "ready" && !display.values.enable_composer_button) await display.save({ ...display.values, enable_composer_button: true }, display.revision);
      if (settings!.showPill !== next) await save({ showPill: next }, next ? "Pill shown on every session" : "Pill hidden");
      else toast.show(next ? "Pill shown on every session" : "Pill hidden");
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

    // Protection: the stored document, plus who runs it on this host.
    const policy = guard.status === "ready" ? guard.values : null;
    const notice = status === null ? null : governorNotice(status);
    const elsewhere = notice !== null && status?.governor !== "off" ? notice : null;
    const guardBusy = guard.status !== "ready" || guard.saving || timing !== null;
    const pending = status?.pauses.filter(isPending) ?? [];
    const overrides = status === null ? 0 : Object.keys(status.overrides).length;
    const listHint = status === null ? "Paused sessions and sessions you changed from the default, on the overview."
      : [pending.length === 0 ? "Nothing paused" : `${pending.length} paused`, overrides === 0 ? "no session changed from the default" : `${overrides} ${overrides === 1 ? "session" : "sessions"} changed from the default`].join(" · ");
    const checked = timing === null ? null : checkTiming(timing.draft);
    const fieldError = (key: keyof Timing) => (timingTried ? checked?.errors[key] ?? null : null);
    async function saveTiming() {
      if (timing === null || guard.status !== "ready" || checked === null) return;
      setTimingTried(true);
      if (Object.keys(checked.errors).length > 0) return;
      if (await guard.save({ ...guard.values, ...checked.values }, timing.revision)) {
        setTiming(null); setTimingTried(false);
        toast.show("Limit timing saved");
      }
    }
    const pillOn = settings.showPill && (display.status !== "ready" || display.values.enable_composer_button);

    return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 8, gap: 24 }}>
      <SettingsSection title="Smart Compact" info="A session is never compacted unless it agrees. At the end of a turn past its line, it is asked whether to compact; it can compact, put it off with a reason, or keep working.">
        <SettingsCard>
          <SettingsSwitch label="Smart Compact" hint={settings.enabled ? "On. Context notices, and the question at the compact line." : "Off. Nothing is asked and nothing is compacted."}
            value={settings.enabled} disabled={saving} onValueChange={(enabled) => void save({ enabled }, enabled ? "Smart Compact on" : "Smart Compact off")} />
          <SettingsSwitch label="Enrol sessions automatically" hint="A session that saves its task state with the checkpoint tool is enrolled by that alone. Off, enrol each one from its pill."
            value={settings.autoEnrol} disabled={off} onValueChange={(autoEnrol) => void save({ autoEnrol }, autoEnrol ? "Sessions enrol themselves" : "Sessions are enrolled one at a time")} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="When to ask" info="What wears a session down is its absolute size, not its share of the window, so large windows are asked much earlier. Earlier context notices move down with the line.">
        <SettingsCard>
          <SettingsInput key={`large-${inputKey}`} label={`Windows of ${from} or more (%)`} hint={`Asked at ${large ?? "—"}%, about ${large === null ? "—" : formatCompactTokens((large / 100) * 1_000_000)} tokens of a 1M window. Default 30.`}
            initialValue={String(settings.thresholds.large.compact)} disabled={off} error={draft !== null && large === null ? "Enter a whole number from 1 to 99." : null}
            onChangeText={(value) => setDraft((previous) => ({ large: value, small: previous?.small ?? String(settings.thresholds.small.compact) }))} />
          <SettingsInput key={`small-${inputKey}`} label="Smaller windows (%)" hint={`Asked at ${small ?? "—"}% of a window under ${from}. Default 85.`}
            initialValue={String(settings.thresholds.small.compact)} disabled={off} error={draft !== null && small === null ? "Enter a whole number from 1 to 99." : null}
            onChangeText={(value) => setDraft((previous) => ({ small: value, large: previous?.large ?? String(settings.thresholds.large.compact) }))} />
          {draft !== null ? <>
            <SettingsAction label="Apply the new lines" hint={changed ? `Large ${large}% · small ${small}%` : "Nothing to apply yet"} actionLabel="Save" disabled={!changed || off}
              onPress={() => void save({ thresholds: { ...settings.thresholds, large: withCompactThreshold(settings.thresholds.large, large!), small: withCompactThreshold(settings.thresholds.small, small!) } }, `Smart Compact asks at ${large}% and ${small}%`)} />
            <SettingsAction label="Keep the saved lines" actionLabel="Discard" disabled={saving} onPress={() => { setDraft(null); setInputKey((k) => k + 1); }} />
          </> : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Pause at the limit" info="When the provider's session window is spent, a running session is paused instead of failing, then continued in the same conversation once the window resets. Formerly the Session Guard plugin; its choices and waiting pauses carry over.">
        {guard.status === "loading" ? <ActivityIndicator accessibilityLabel="Loading Pause at the limit settings" color={c.foregroundMuted} style={{ padding: 16 }} />
          : guard.status !== "ready" ? <View style={{ gap: 8 }}>
            <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{guard.error}</Text>
            <SettingsCard>
              <SettingsAction label="Load the saved settings again" actionLabel="Retry" onPress={() => void guard.reload()} />
              {guard.status === "invalid" ? <SettingsAction label="Replace the invalid settings with defaults" actionLabel="Reset" disabled={guard.saving} onPress={() => void guard.reset()} /> : null}
            </SettingsCard>
          </View>
            : <SettingsCard>
              {elsewhere ? <SettingsRow label={elsewhere.title} hint={elsewhere.hint} /> : null}
              <SettingsSwitch label="Pause at the limit" hint={guard.values.enabled ? `On. Sessions pause at ${guard.values.thresholdPct}% of the session window. Works while the app is closed.` : "Off until you turn it on. Turning it off lets frozen workers go; waiting continuations hold until you turn it back on or cancel them."}
                value={guard.values.enabled} disabled={guardBusy} onValueChange={(enabled) => changeGuard({ enabled }, enabled ? "Sessions pause at the limit" : "Pause at the limit off")} />
              <SettingsSelect label="Sessions" hint="Change any one session from its pill."
                value={guard.values.protectByDefault ? "all" : "opt-in"} options={[{ label: "Every session", value: "all" }, { label: "Only ones I turn on", value: "opt-in" }]}
                disabled={guardBusy || !guard.values.enabled} onValueChange={(value) => changeGuard({ protectByDefault: value === "all" }, value === "all" ? "Every session pauses at the limit" : "Sessions pause only when you turn them on")} />
              <SettingsSwitch label="Continue after the reset" hint="Waits for a fresh usage reading below the line, then sends the continuation. Off, you continue each one by hand."
                value={guard.values.autoResume} disabled={guardBusy || !guard.values.enabled} onValueChange={(autoResume) => changeGuard({ autoResume }, autoResume ? "Paused sessions continue after the reset" : "Paused sessions wait for you")} />
              <SettingsSwitch label="Include native subagents" hint="On Linux, freeze Claude and Codex sessions together with their nested workers. Off, only the foreground turn is interrupted."
                value={guard.values.includeNativeSubagents} disabled={guardBusy || !guard.values.enabled} onValueChange={(includeNativeSubagents) => changeGuard({ includeNativeSubagents }, includeNativeSubagents ? "Subagents pause too" : "Only the foreground turn pauses")} />
              <SettingsSwitch label="Label paused workspaces" hint="An amber Paused label in the sidebar until every session in the workspace continues."
                value={guard.values.workspaceLabels} disabled={guardBusy || !guard.values.enabled} onValueChange={(workspaceLabels) => changeGuard({ workspaceLabels }, workspaceLabels ? "Paused workspaces are labelled" : "No workspace labels")} />
              <SettingsAction label="Paused sessions and exceptions" hint={listHint} actionLabel="Open" onPress={openPaused} />
            </SettingsCard>}
      </SettingsSection>

      <SettingsSection title="Display" info="Hiding the row or the pill never turns a feature off. ⌘K Smart Session still opens the overview.">
        {display.status === "loading" ? <ActivityIndicator accessibilityLabel="Loading display settings" color={c.foregroundMuted} style={{ padding: 16 }} />
          : display.status !== "ready" ? <View style={{ gap: 8 }}>
            <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{display.error}</Text>
            <SettingsCard>
              <SettingsAction label="Load the saved display settings again" actionLabel="Retry" onPress={() => void display.reload()} />
              {display.status === "invalid" ? <SettingsAction label="Replace the invalid display settings with defaults" actionLabel="Reset" disabled={display.saving} onPress={() => void display.reset()} /> : null}
            </SettingsCard>
          </View>
            : <SettingsCard>
              <SettingsSwitch label="Sidebar row" hint="Smart Session in the sidebar, with the session window's use, or how many sessions are paused."
                value={display.values.showSidebar} disabled={display.saving} onValueChange={(showSidebar) => void display.save({ ...display.values, showSidebar }, display.revision)} />
              <SettingsSwitch label="Pill on every session" hint="The context ring above each message box. A paused session keeps its pill either way."
                value={pillOn} disabled={saving || display.saving} onValueChange={(next) => void setPill(next)} />
            </SettingsCard>}
        {display.status === "ready" && display.saveError ? <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{display.saveError}</Text> : null}
      </SettingsSection>

      <SettingsSection title="Claude Code">
        <SettingsCard>
          <SettingsSwitch label="Register the hooks" hint={hooksHint} value={settings.installHooks} disabled={off}
            onValueChange={(installHooks) => void save({ installHooks }, installHooks ? "Hooks registered with Claude Code" : "Hooks removed from Claude Code")} />
          {report?.mcp === "unavailable" ? <SettingsRow label="MCP server not registered" hint="The claude command was not reachable from the daemon." /> : null}
        </SettingsCard>
      </SettingsSection>

      {policy === null ? null : <SettingsSection title="Limit timing" info="How Pause at the limit reads usage and continues sessions. The defaults suit almost everyone.">
        <SettingsCard>
          {timing === null ? <SettingsAction label={`Pause at ${policy.thresholdPct}% of the session window`}
            hint={`Check every ${policy.pollSeconds}s · wait ${policy.resetGraceSeconds}s after the reset · ${policy.resumeSpacingSeconds}s between continuations · ${policy.providerIds.length === 0 ? "every provider" : policy.providerIds.join(", ")}`}
            actionLabel="Edit" disabled={guard.status !== "ready" || guard.saving} onPress={() => { if (guard.status === "ready") { setTiming({ draft: timingOf(guard.values), revision: guard.revision }); setTimingTried(false); } }} /> : <>
            <SettingsInput label="Pause at (%)" hint="Of the session window. 1–100, default 100." initialValue={timing.draft.thresholdPct} error={fieldError("thresholdPct")} disabled={guard.saving}
              onChangeText={(value) => setTiming((t) => t && { ...t, draft: { ...t.draft, thresholdPct: value } })} />
            <SettingsInput label="Check every (seconds)" hint="5–300, default 15. Paseo may cache usage; this can't force a provider refresh." initialValue={timing.draft.pollSeconds} error={fieldError("pollSeconds")} disabled={guard.saving}
              onChangeText={(value) => setTiming((t) => t && { ...t, draft: { ...t.draft, pollSeconds: value } })} />
            <SettingsInput label="Wait after the reset (seconds)" hint="0–600, default 30." initialValue={timing.draft.resetGraceSeconds} error={fieldError("resetGraceSeconds")} disabled={guard.saving}
              onChangeText={(value) => setTiming((t) => t && { ...t, draft: { ...t.draft, resetGraceSeconds: value } })} />
            <SettingsInput label="Between continuations (seconds)" hint="0–300, default 5, so paused sessions don't all start at once." initialValue={timing.draft.resumeSpacingSeconds} error={fieldError("resumeSpacingSeconds")} disabled={guard.saving}
              onChangeText={(value) => setTiming((t) => t && { ...t, draft: { ...t.draft, resumeSpacingSeconds: value } })} />
            <SettingsInput label="Continuation message" hint="Sent once into the same conversation after the reset is confirmed." initialValue={timing.draft.continuation} error={fieldError("continuation")} disabled={guard.saving}
              onChangeText={(value) => setTiming((t) => t && { ...t, draft: { ...t.draft, continuation: value } })} />
            <SettingsInput label="Providers" hint="Comma separated. Empty means every provider that reports session usage." initialValue={timing.draft.providerIds} error={fieldError("providerIds")} disabled={guard.saving}
              onChangeText={(value) => setTiming((t) => t && { ...t, draft: { ...t.draft, providerIds: value } })} />
            <SettingsInput label="Session windows" hint="Comma separated, in order of preference. Default: five_hour, session." initialValue={timing.draft.windowIds} error={fieldError("windowIds")} disabled={guard.saving}
              onChangeText={(value) => setTiming((t) => t && { ...t, draft: { ...t.draft, windowIds: value } })} />
            <SettingsAction label="Apply the new timing" hint={timingTried && checked && Object.keys(checked.errors).length > 0 ? "Fix the fields above first" : undefined} actionLabel="Save" disabled={guard.saving} onPress={() => void saveTiming()} />
            <SettingsAction label="Keep the saved timing" actionLabel="Discard" disabled={guard.saving} onPress={() => { setTiming(null); setTimingTried(false); }} />
          </>}
        </SettingsCard>
        {guard.status === "ready" && guard.saveError ? <Text accessibilityRole="alert" style={{ color: c.statusDanger }}>{guard.saveError}</Text> : null}
      </SettingsSection>}
    </ScrollView>;
  };
}
