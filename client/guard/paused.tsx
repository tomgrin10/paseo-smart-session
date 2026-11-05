import { useEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { cancelResumeRpc, statusRpc } from "../../shared/guard/contracts.ts";
import { governorNotice, pauseOwnerNote, pausedSessions, pausePresentation } from "../../shared/guard/presentation.ts";
import { timestamp, type Pause } from "../../shared/guard/policy.ts";
import { formatDuration, formatRelative } from "../../shared/format.ts";
import { formatMoment } from "../../shared/forecast.ts";
import { Button, Card, CardRow, Chip, IconButton, SectionHead, text, useNow } from "../kit.tsx";
import { Skeleton } from "../motion.tsx";
import { tabular } from "../theme.ts";

const providerName = (id: string) => (id === "claude" ? "Claude" : id === "codex" ? "Codex" : id);

/**
 * Every Session Guard pause on this host, as times: when each session's window
 * resets and whether it continues by itself. Rows act only on pauses this process
 * governs; another governor's pauses are listed read-only.
 */
export function PausedSessions({ theme, host, layout, navigation, openSettings }: PluginSurfaceProps & { openSettings(): void }) {
  const c = theme.colors;
  const t = text(c);
  const compact = layout.compact;
  const toast = useToast();
  const now = useNow(15_000);
  const read = useRpc(statusRpc);
  const cancel = useRpc(cancelResumeRpc);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof read>> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let stopped = false, fetching = false;
    const fetch = async () => {
      if (fetching || stopped) return;
      fetching = true;
      try { const next = await read({}); if (!stopped) { setStatus(next); setLoadError(null); } }
      catch { if (!stopped) setLoadError("Couldn't refresh paused sessions. Showing the last report; retrying."); }
      finally { fetching = false; }
    };
    refresh.current = fetch;
    void fetch(); const timer = setInterval(() => void fetch(), 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [read]);
  const release = async (pause: Pause) => {
    if (busy) return;
    setBusy(pause.agentId);
    try { await cancel({ agentId: pause.agentId }); await refresh.current(); toast.show(pause.suspension ? "Released · protection off for that session" : "Continuation cancelled"); }
    catch { toast.error("Couldn't change this pause. Refresh and try again."); }
    finally { setBusy(null); }
  };

  const all = status ? pausedSessions(status.pauses) : [];
  const visible = status ? pausedSessions(status.pauses, query) : [];
  const attention = visible.filter((p) => p.phase === "attention");
  const waiting = visible.filter((p) => p.phase !== "attention");
  // Both plugins share one state file: when this one is not governing, the list is
  // the other plugin's (or a leftover), and its controls would only fail.
  const notice = status ? governorNotice(status) : null;
  const owner = status ? pauseOwnerNote(status) : null;
  const autoResume = status ? status.policy.enabled && status.policy.autoResume : false;

  // The headline is the moment: when they come back, or that one needs a look.
  const allWaiting = all.filter((p) => p.phase !== "attention");
  const allStuck = all.length - allWaiting.length;
  const resets = allWaiting.map((p) => timestamp(p.anchorResetsAt)).filter((v): v is number => v !== null && v > now).sort((a, b) => a - b);
  const shared = resets.length === allWaiting.length && resets.length > 0 && resets[resets.length - 1]! - resets[0]! < 60_000 ? resets[0]! : null;
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const clock = (ms: number) => formatMoment(new Date(ms).toISOString(), now);
  const title = status === null ? null
    : all.length === 0 ? "Nothing is paused"
      : allWaiting.length === 0 ? `${n(allStuck, "session needs", "sessions need")} a look`
        : shared !== null ? (autoResume ? `${n(allWaiting.length, "session resumes", "sessions resume")} at ${clock(shared)}` : `${n(allWaiting.length, "session waits", "sessions wait")} for the ${clock(shared)} reset`)
          : resets.length > 0 ? `${n(allWaiting.length, "session", "sessions")} paused · next ${autoResume ? "resumes" : "reset"} at ${clock(resets[0]!)}`
            : `${n(allWaiting.length, "session waits", "sessions wait")} for a fresh reading`;
  const sentence = status === null ? "" : [
    shared !== null ? `in ${formatDuration(shared - now)}` : null,
    allStuck > 0 && allWaiting.length > 0 ? `${allStuck} ${allStuck === 1 ? "needs" : "need"} a look` : null,
    all.length === 0 || allWaiting.length === 0 ? null : owner ? "Managed by another Session Guard" : autoResume ? "Each continues in the same conversation" : "Continue each by hand after the reset",
    status.checkedAt ? `Checked ${formatRelative(status.checkedAt, now)}` : "Waiting for the first usage check",
  ].filter(Boolean).join(" · ");

  const row = (pause: Pause, i: number) => {
    const presentation = pausePresentation(pause, status!.policy, now);
    const reset = timestamp(pause.anchorResetsAt);
    const stuck = pause.phase === "attention";
    // A row leads with what differs between rows, the session; its time only when it differs from the headline's.
    const ownTime = !stuck && !pause.demo && reset !== null && reset > now && (shared === null || Math.abs(reset - shared) >= 60_000) ? formatMoment(pause.anchorResetsAt!, now) : null;
    const after = stuck ? (pause.note ?? "It stopped before Session Guard could confirm the pause. Check it before continuing by hand.")
      : pause.demo ? "Test pause · waits for you"
        : reset === null ? "Waiting for the provider to report the reset"
          : reset > now ? `${autoResume ? "Resumes" : "Resets"} in ${formatDuration(reset - now)}`
            : `Reset was ${formatMoment(pause.anchorResetsAt!, now)} · waiting for a fresh reading`;
    const chips = [providerName(pause.provider), presentation.coverage];
    const canAct = owner === null;
    return <CardRow key={pause.id} theme={theme} first={i === 0} style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name={stuck ? "TriangleAlert" : "Pause"} size={14} color={stuck ? c.statusDanger : c.statusWarning} />
        <Text numberOfLines={2} style={{ ...t.title, flex: 1 }}>{presentation.title}</Text>
        {ownTime ? <Text style={{ color: c.foreground, fontSize: 15, lineHeight: 21, fontWeight: "600", ...tabular }}>{ownTime}</Text> : null}
      </View>
      <Text style={{ ...t.meta, color: stuck ? c.statusDanger : c.foregroundMuted, paddingLeft: 22 }}>{after}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingLeft: 22 }}>
        {chips.map((chip) => <Chip key={chip} theme={theme} label={chip} />)}
        {owner ? <Chip theme={theme} label="Read-only here" /> : null}
      </View>
      {owner ? <Text style={{ ...t.meta, paddingLeft: 22 }}>{owner}</Text> : null}
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 2, paddingLeft: 22 }}>
        {navigation ? <Button theme={theme} small compact={compact} icon={compact ? undefined : "ArrowUpRight"} title="Open session" onPress={() => navigation.openAgent({ agentId: pause.agentId, serverId: host.id })} /> : null}
        <View style={{ flex: 1, minWidth: 8 }} />
        {canAct ? <Button theme={theme} small compact={compact} kind="ghost" title={busy === pause.agentId ? "Updating…" : presentation.actionLabel} disabled={busy !== null}
          accessibilityHint={presentation.actionHint} onPress={() => void release(pause)} /> : null}
      </View>
    </CardRow>;
  };

  return <ScrollView contentContainerStyle={{ padding: compact ? 16 : 32, paddingBottom: 48 }}>
    <View style={{ width: "100%", maxWidth: 760, alignSelf: "center", gap: compact ? 18 : 22 }}>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {title ? <Text accessibilityRole="header" style={{ flex: 1, color: c.foreground, fontSize: compact ? 19 : 22, lineHeight: compact ? 25 : 29, fontWeight: "600" }}>{title}</Text>
            : <View style={{ flex: 1 }}><Skeleton width="40%" height={22} color={c.surface2} /></View>}
          <IconButton theme={theme} icon="Settings" label="Session Guard settings" compact={compact} onPress={openSettings} />
        </View>
        {sentence ? <Text style={{ ...t.meta, fontSize: 13, lineHeight: 19 }}>{sentence}</Text> : null}
      </View>

      {notice ? <Card theme={theme}><CardRow theme={theme} first style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
        <Icon name="ShieldOff" size={15} color={c.foregroundMuted} />
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={t.label}>{notice.title}</Text>
          <Text style={t.meta}>{notice.hint}</Text>
        </View>
        <Button theme={theme} small compact={compact} title="Settings" onPress={openSettings} />
      </CardRow></Card> : null}

      {all.length > 5 || query !== "" ? <TextInput value={query} onChangeText={setQuery} placeholder="Find a paused session by title or provider" placeholderTextColor={c.foregroundMuted} accessibilityLabel="Find a paused session"
        style={{ minHeight: compact ? 44 : 34, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, color: c.foreground, fontSize: 13 }} /> : null}

      {status === null && !loadError ? <Card theme={theme}>{[0, 1].map((i) => <CardRow key={i} theme={theme} first={i === 0} style={{ gap: 8 }}>
        <Skeleton width="30%" height={14} color={c.surface2} /><Skeleton width="70%" height={11} color={c.surface2} /></CardRow>)}</Card> : null}

      {status && all.length === 0 && !notice ? <Card theme={theme}><CardRow theme={theme} first style={{ gap: 6, paddingVertical: 16 }}>
        <Text style={t.label}>Nothing is waiting for a reset</Text>
        <Text style={t.meta}>{`When a protected session reaches ${status.policy.thresholdPct}% of its session window, Session Guard pauses it here and ${status.policy.autoResume ? "continues it in the same conversation after the reset" : "you continue it after the reset"}.`}</Text>
      </CardRow></Card> : null}
      {status && all.length > 0 && visible.length === 0 ? <Text style={t.meta}>No paused session matches that.</Text> : null}

      {attention.length > 0 ? <View style={{ gap: 8 }}>
        <SectionHead theme={theme} title="Needs attention" count={attention.length} />
        <Card theme={theme}>{attention.map(row)}</Card>
      </View> : null}
      {waiting.length > 0 ? <View style={{ gap: 8 }}>
        <SectionHead theme={theme} title="Waiting for the reset" count={waiting.length} />
        <Card theme={theme}>{waiting.map(row)}</Card>
      </View> : null}

      {loadError ? <Text accessibilityRole="alert" style={{ ...t.meta, color: c.statusDanger }}>{status ? loadError : "Couldn't load paused sessions. Retrying."}</Text> : null}
      {status?.error && !notice ? <Text accessibilityRole="alert" style={{ ...t.meta, color: c.statusDanger }}>{status.error}</Text> : null}
    </View>
  </ScrollView>;
}
