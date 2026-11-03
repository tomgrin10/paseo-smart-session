import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { timelinePresentation, type TimelineData } from "../../shared/guard/timeline.ts";
import { dismissPauseRpc, resumeNowRpc, statusRpc } from "../../shared/guard/contracts.ts";
import type { Pause } from "../../shared/guard/policy.ts";

export function GuardTimelineItem({ theme, agentId, item, openOverview }: PluginTimelineItemProps<TimelineData> & { openOverview(): void }) {
  const readStatus = useRpc(statusRpc);
  const resumeNow = useRpc(resumeNowRpc);
  const dismissPause = useRpc(dismissPauseRpc);
  const [pause, setPause] = useState<Pause | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [action, setAction] = useState<"resume" | "dismiss" | null>(null);
  const busy = action !== null;
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  useEffect(() => {
    if (!["paused", "recovery"].includes(item.data.event)) return;
    setPause(null); setLoaded(false); setError(null); setStatusError(null);
    let stopped = false, pending = false;
    const refresh = async () => {
      if (pending || stopped) return;
      pending = true;
      try {
        const status = await readStatus({});
        if (!stopped) { setPause(status.pauses.find(p => p.id === item.data.pauseId && p.agentId === agentId) ?? null); setLoaded(true); setStatusError(null); }
      } catch { if (!stopped) setStatusError("Could not check this pause. Retrying automatically."); }
      finally { pending = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [readStatus, agentId, item.data.event, item.data.pauseId]);
  const act = async (kind: "resume" | "dismiss") => {
    if (busy) return;
    setAction(kind); setError(null);
    try {
      await (kind === "resume" ? resumeNow : dismissPause)({ agentId, pauseId: item.data.pauseId });
      const status = await readStatus({});
      setPause(status.pauses.find(p => p.id === item.data.pauseId && p.agentId === agentId) ?? null);
    } catch { setError(kind === "resume" ? "Resume could not be confirmed. Check the session before trying again."
      : "Dismissal could not be confirmed. Check the pause status; you can retry dismissal without sending a message."); }
    finally { setAction(null); }
  };
  if (pause?.phase === "cancelled" && pause.dismissed && ["paused", "recovery"].includes(item.data.event)) return <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 14 }}>
    <Icon name="ShieldOff" size={16} color={theme.colors.foregroundMuted} />
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>Pause dismissed · no message sent · protection off</Text>
  </View>;
  const presentation = timelinePresentation(item.data);
  const color = presentation.tone === "warning" ? theme.colors.statusWarning : presentation.tone === "success" ? theme.colors.statusSuccess
    : presentation.tone === "danger" ? theme.colors.statusDanger : theme.colors.foregroundMuted;
  return <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.surface1, padding: 14, gap: 10 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name={presentation.icon} size={18} color={color} />
      <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600", flex: 1 }}>{presentation.title}</Text>
    </View>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>{presentation.detail}</Text>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{new Date(item.data.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</Text>
    {["paused", "recovery"].includes(item.data.event) && <View style={{ gap: 6 }}>
      {!loaded && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Checking pause status…</Text>}
      {pause?.phase === "waiting" && <>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Resume now" accessibilityState={{ disabled: busy, busy: action === "resume" }} disabled={busy} onPress={() => void act("resume")} style={({ pressed }) => ({ alignSelf: "flex-start", minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, opacity: busy || pressed ? 0.6 : 1 })}>
          <Icon name="Play" size={16} color={theme.colors.statusSuccess} />
          <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{action === "resume" ? "Resuming…" : "Resume now"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss pause without sending a message" accessibilityState={{ disabled: busy, busy: action === "dismiss" }} disabled={busy} onPress={() => void act("dismiss")} style={({ pressed }) => ({ alignSelf: "flex-start", minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, opacity: busy || pressed ? 0.6 : 1 })}>
          <Icon name="ShieldOff" size={16} color={theme.colors.foregroundMuted} />
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{action === "dismiss" ? "Dismissing…" : "Dismiss pause"}</Text>
        </Pressable>
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{item.data.demo
          ? "Releases this test session and turns its protection off."
          : "Turns protection off for this session. The provider may still reject work until reset."}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>Dismiss cancels automatic continuation without sending a message. Existing workers are released and may continue their current work.</Text>
      </>}
      {loaded && pause?.phase === "resumed" && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{pause.manualResume ? "Resumed · protection off for this session" : "This pause has already resumed."}</Text>}
      {loaded && (!pause || pause.phase === "cancelled") && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>This pause is no longer active.</Text>}
      {pause?.phase === "resuming" && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Resuming session…</Text>}
      {pause?.phase === "attention" && <>
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{pause.dismissed ? "Worker release needs attention. Automatic continuation is cancelled." : "Check the session before continuing manually."}</Text>
        {pause.dismissed && <Pressable accessibilityRole="button" accessibilityLabel="Retry dismissing pause without sending a message" disabled={busy} accessibilityState={{ disabled: busy, busy: action === "dismiss" }} onPress={() => void act("dismiss")} style={{ minHeight: 44, justifyContent: "center" }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13, textDecorationLine: "underline" }}>{action === "dismiss" ? "Dismissing…" : "Retry dismissal"}</Text>
        </Pressable>}
      </>}
      {error && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text>}
      {statusError && <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{statusError}</Text>}
    </View>}
    <Pressable accessibilityRole="button" accessibilityLabel="See all paused sessions" onPress={openOverview} style={({ pressed }) => ({ alignSelf: "flex-start", minHeight: 44, justifyContent: "center", paddingVertical: 8, paddingHorizontal: 2, opacity: pressed ? 0.7 : 1 })}>
      <Text style={{ color: theme.colors.foreground, fontSize: 13, textDecorationLine: "underline" }}>See all paused sessions</Text>
    </Pressable>
  </View>;
}
