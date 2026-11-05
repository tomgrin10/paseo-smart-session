import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { cancelResumeRpc, setProtectionRpc, statusRpc } from "../../shared/guard/contracts.ts";
import { governorNotice, pauseOwnerNote, pausedLead, pausedSessions, pausePresentation } from "../../shared/guard/presentation.ts";
import { timestamp, type Pause } from "../../shared/guard/policy.ts";
import { formatDuration } from "../../shared/format.ts";
import { formatMoment } from "../../shared/forecast.ts";
import { Button, Card, CardRow, Chip, SectionHead, TextLink, text } from "../kit.tsx";
import { tabular, type Theme } from "../theme.ts";
import { publishGuard, type GuardStatus } from "./status.ts";

const providerName = (id: string) => (id === "claude" ? "Claude" : id === "codex" ? "Codex" : id);

/**
 * The overview's Paused sessions section: every pause on this host as times, when
 * each session's window resets and whether it continues by itself. Rows act only on
 * pauses this process governs; another governor's pauses are listed read-only.
 */
export function PausedSection({ theme, layout, host, navigation, status, shared: lead, now, openSettings }: Pick<PluginScreenProps, "theme" | "layout" | "host" | "navigation"> & {
  status: GuardStatus | null; shared: number | null; now: number; openSettings(): void;
}) {
  const c = theme.colors;
  const t = text(c);
  const compact = layout.compact;
  const toast = useToast();
  const read = useRpc(statusRpc);
  const cancel = useRpc(cancelResumeRpc);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const release = async (pause: Pause) => {
    if (busy) return;
    setBusy(pause.agentId);
    try { await cancel({ agentId: pause.agentId }); publishGuard(await read({})); toast.show(pause.suspension ? "Released · that session no longer pauses at the limit" : "Continuation cancelled"); }
    catch { toast.error("Couldn't change this pause. Refresh and try again."); }
    finally { setBusy(null); }
  };

  const all = status ? pausedSessions(status.pauses) : [];
  const visible = status ? pausedSessions(status.pauses, query) : [];
  // Both plugins share one state file: when this one is not governing, the list is
  // the other plugin's (or a leftover), and its controls would only fail.
  const notice = status ? governorNotice(status) : null;
  const owner = status ? pauseOwnerNote(status) : null;
  const autoResume = status ? status.policy.enabled && status.policy.autoResume : false;
  // The overview's lead names the shared reset only for pauses governed here; the list
  // finds it itself otherwise, so rows never repeat a time the section already implies.
  const shared = lead ?? pausedLead(all, autoResume, now, String)?.shared ?? null;

  const row = (pause: Pause, i: number) => {
    const presentation = pausePresentation(pause, status!.policy, now);
    const reset = timestamp(pause.anchorResetsAt);
    const stuck = pause.phase === "attention";
    // A row leads with what differs between rows, the session; its time only when it differs from the lead's.
    const ownTime = !stuck && !pause.demo && reset !== null && reset > now && (shared === null || Math.abs(reset - shared) >= 60_000) ? formatMoment(pause.anchorResetsAt!, now) : null;
    const after = stuck ? (pause.note ?? "It stopped before the pause was confirmed. Check it before continuing by hand.")
      : pause.demo ? "Test pause · waits for you"
        : reset === null ? "Waiting for the provider to report the reset"
          // The lead already says when a shared reset lands; the row says what happens then.
          : reset > now ? (ownTime === null && shared !== null ? (autoResume ? "Continues in the same conversation" : "Continue it by hand after the reset") : `${autoResume ? "Resumes" : "Resets"} in ${formatDuration(reset - now)}`)
            : `Reset was ${formatMoment(pause.anchorResetsAt!, now)} · waiting for a fresh reading`;
    return <CardRow key={pause.id} theme={theme} first={i === 0} style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name={stuck ? "TriangleAlert" : "Pause"} size={14} color={stuck ? c.statusDanger : c.statusWarning} />
        <Text numberOfLines={2} style={{ ...t.label, flex: 1 }}>{presentation.title}</Text>
        {ownTime ? <Text style={{ color: c.foreground, fontSize: 15, lineHeight: 21, fontWeight: "600", ...tabular }}>{ownTime}</Text> : null}
      </View>
      <Text style={{ ...t.meta, color: stuck ? c.statusDanger : c.foregroundMuted, paddingLeft: 22 }}>{after}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingLeft: 22 }}>
        {[providerName(pause.provider), presentation.coverage].map((chip) => <Chip key={chip} theme={theme} label={chip} />)}
        {owner ? <Chip theme={theme} label="Read-only here" /> : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 2, paddingLeft: 22 }}>
        {navigation ? <Button theme={theme} small compact={compact} icon={compact ? undefined : "ArrowUpRight"} title="Open session" onPress={() => navigation.openAgent({ agentId: pause.agentId, serverId: host.id })} /> : null}
        <View style={{ flex: 1, minWidth: 8 }} />
        {owner === null ? <Button theme={theme} small compact={compact} kind="ghost" title={busy === pause.agentId ? "Updating…" : presentation.actionLabel} disabled={busy !== null}
          accessibilityHint={presentation.actionHint} onPress={() => void release(pause)} /> : null}
      </View>
    </CardRow>;
  };

  const attention = visible.filter((p) => p.phase === "attention");
  const waiting = visible.filter((p) => p.phase !== "attention");
  return <View style={{ gap: 8 }}>
    <SectionHead theme={theme} title="Paused sessions" count={all.length || undefined} />
    {notice && all.length > 0 ? <Card theme={theme}><CardRow theme={theme} first style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
      <Icon name="ShieldOff" size={15} color={c.foregroundMuted} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={t.label}>{notice.title}</Text>
        <Text style={t.meta}>{notice.hint}</Text>
        {owner && status?.governor === "off" ? <Text style={t.meta}>{owner}</Text> : null}
      </View>
      <TextLink theme={theme} compact={compact} icon="Settings" label="Settings" onPress={openSettings} />
    </CardRow></Card> : null}
    {all.length > 5 || query !== "" ? <TextInput value={query} onChangeText={setQuery} placeholder="Find a paused session by title or provider" placeholderTextColor={c.foregroundMuted} accessibilityLabel="Find a paused session"
      style={{ minHeight: compact ? 44 : 34, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, color: c.foreground, fontSize: 13 }} /> : null}
    {status && all.length === 0 ? <Card theme={theme}><CardRow theme={theme} first style={{ gap: 4, paddingVertical: 16 }}>
      <Text style={t.label}>Nothing is waiting for a reset</Text>
      <Text style={t.meta}>{notice ? notice.title + "." : `When a session reaches ${status.policy.thresholdPct}% of its session window, it pauses here and ${status.policy.autoResume ? "continues in the same conversation after the reset" : "waits for you after the reset"}.`}</Text>
    </CardRow></Card> : null}
    {status && all.length > 0 && visible.length === 0 ? <Text style={t.meta}>No paused session matches that.</Text> : null}
    {visible.length > 0 ? <Card theme={theme}>{[...attention, ...waiting].map(row)}</Card> : null}
  </View>;
}

/** Sessions changed from the default, with the way back. Read-only unless this process governs. */
export function Exceptions({ theme, layout, status, titleOf }: { theme: Theme; layout: { compact: boolean }; status: GuardStatus; titleOf(agentId: string): string }) {
  const c = theme.colors;
  const t = text(c);
  const write = useRpc(setProtectionRpc);
  const read = useRpc(statusRpc);
  const toast = useToast();
  const entries = Object.entries(status.overrides);
  if (entries.length === 0) return null;
  const canAct = status.governor === "active";
  const reset = async (agentId: string) => {
    try { await write({ agentId, enabled: null }); publishGuard(await read({})); toast.show("Back to your default"); }
    catch { toast.error("Couldn't change that session. Try again."); }
  };
  return <View style={{ gap: 2, paddingLeft: 25 }}>
    <Text style={t.small}>{entries.length === 1 ? "One session differs from your default" : `${entries.length} sessions differ from your default`}</Text>
    {entries.map(([agentId, on]) => <View key={agentId} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: layout.compact ? 44 : 24 }}>
      <Text numberOfLines={1} style={{ ...t.meta, flex: 1, color: c.foreground }}>{titleOf(agentId)}</Text>
      <Text style={t.meta}>{on ? "Pauses" : "Doesn't pause"}</Text>
      {canAct ? <TextLink theme={theme} compact={layout.compact} icon="RotateCcw" label="Use default" onPress={() => void reset(agentId)} /> : null}
    </View>)}
  </View>;
}
