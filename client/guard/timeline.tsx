import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { timelinePresentation, type TimelineData } from "../../shared/guard/timeline.ts";
import { dismissPauseRpc, resumeNowRpc, statusRpc } from "../../shared/guard/contracts.ts";
import { timestamp, type Pause } from "../../shared/guard/policy.ts";
import { formatClock, formatDuration } from "../../shared/format.ts";
import { formatMoment } from "../../shared/forecast.ts";
import { Button, TextLink, text, useNow } from "../kit.tsx";
import { Spinner } from "../motion.tsx";
import { raised, tabular, withAlpha } from "../theme.ts";

const providerName = (id: string) => (id === "claude" ? "Claude" : id === "codex" ? "Codex" : id);

/**
 * A Session Guard pause in the chat. While the pause waits, it is a card that leads
 * with the clock the window resets at, a live countdown, and Resume now / Dismiss.
 * Once the pause settles it resolves itself into one quiet line, so the chat keeps
 * the history without a stale card. Settled events (resumed, released) are lines
 * from the start.
 */
export function GuardTimelineItem({ theme, agentId, item, layout, openOverview }: PluginTimelineItemProps<TimelineData> & { openOverview(): void }) {
  const c = theme.colors;
  const t = text(c);
  const compact = layout.compact;
  const readStatus = useRpc(statusRpc);
  const resumeNow = useRpc(resumeNowRpc);
  const dismissPause = useRpc(dismissPauseRpc);
  const [pause, setPause] = useState<Pause | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [action, setAction] = useState<"resume" | "dismiss" | null>(null);
  const busy = action !== null;
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const live = ["paused", "recovery"].includes(item.data.event);
  const now = useNow(live && pause?.phase === "waiting" ? 15_000 : 60_000);
  useEffect(() => {
    if (!live) return;
    setPause(null); setLoaded(false); setError(null); setStatusError(null);
    let stopped = false, pending = false;
    const refresh = async () => {
      if (pending || stopped) return;
      pending = true;
      try {
        const status = await readStatus({});
        if (!stopped) { setPause(status.pauses.find((p) => p.id === item.data.pauseId && p.agentId === agentId) ?? null); setLoaded(true); setStatusError(null); }
      } catch { if (!stopped) setStatusError("Couldn't check this pause. Retrying."); }
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
      setPause(status.pauses.find((p) => p.id === item.data.pauseId && p.agentId === agentId) ?? null);
    } catch {
      setError(kind === "resume" ? "Resume could not be confirmed. Check the session before trying again."
        : "Dismissal could not be confirmed. Check the pause; retrying dismissal sends no message.");
    } finally { setAction(null); }
  };

  const presentation = timelinePresentation(item.data);
  const at = formatClock(item.data.at);

  /** One quiet line: the settled form of every card. */
  const line = (icon: string, color: string, words: string, extra?: string) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}>
      <View style={{ width: 22, alignItems: "center" }}><Icon name={icon} size={13} color={color} /></View>
      <Text style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: 13, lineHeight: 18, ...tabular }}>
        <Text style={{ color: c.foreground }}>{words}</Text>{extra ? ` · ${extra}` : ""}
      </Text>
    </View>
  );

  if (!live) {
    if (item.data.event === "resumed") return line("Play", c.foregroundMuted, presentation.title, item.data.manualResume ? `${at} · by you · protection off for this session` : `${at} · ${item.data.native ? "workers continued in place" : "continuation sent"}`);
    if (item.data.event === "released") return line("ShieldOff", c.foregroundMuted, presentation.title, item.data.dismissed ? `${at} · no message sent · protection off` : at);
    // attention
    return <View style={[{ borderRadius: 12, backgroundColor: c.surface1, padding: 14, gap: 6, borderWidth: 1, borderColor: withAlpha(c.statusDanger, 0.6) }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="TriangleAlert" size={15} color={c.statusDanger} />
        <Text style={{ ...t.label, color: c.statusDanger, flex: 1 }}>{presentation.title}</Text>
        <Text style={t.meta}>{at}</Text>
      </View>
      <Text style={t.body}>{presentation.detail}</Text>
    </View>;
  }

  // A live pause: settled ones fold to a line.
  if (loaded && (pause === null || pause.phase === "cancelled" || pause.phase === "resumed")) {
    if (pause?.phase === "cancelled" && pause.dismissed) return line("ShieldOff", c.foregroundMuted, "Pause dismissed", "no message sent · protection off");
    if (pause?.phase === "resumed") return line("Pause", c.foregroundMuted, `Paused at ${at}`, pause.manualResume ? `resumed by you ${formatClock(pause.settledAt)}` : `resumed ${formatClock(pause.settledAt)}`);
    // The event that ended it has its own line; this one only says when.
    return line("Pause", c.foregroundMuted, `Paused at ${at}`, pause?.settledAt ? `ended ${formatClock(pause.settledAt)}` : "no longer active");
  }

  const reset = timestamp(item.data.resetAt);
  const auto = item.data.autoResume;
  const waiting = pause?.phase === "waiting";
  const stuck = pause?.phase === "attention";
  // Lead with the moment, the way every family card does: the reset clock, then the countdown.
  const big = item.data.demo ? "Test pause" : reset === null ? "Reset time unknown" : formatMoment(item.data.resetAt!, now);
  const countdown = item.data.demo ? "waits for you" : reset === null ? "waiting for the provider to report it" : reset <= now ? "reset passed · waiting for a fresh reading" : `${auto ? "resumes" : "resets"} in ${formatDuration(reset - now)}`;
  const facts = [item.data.demo ? "Test pause" : item.data.event === "recovery" ? "Saved through a Paseo restart" : "Paused at the session limit", at, providerName(item.data.provider),
    item.data.usedPct === null ? null : `${Math.round(item.data.usedPct)}% used`,
    item.data.native ? "native subagents frozen" : "turn interrupted",
    auto ? null : "continue by hand"].filter(Boolean).join(" · ");
  const accent = stuck ? c.statusDanger : c.statusWarning;

  return <View style={[{ borderRadius: 12, backgroundColor: c.surface1, paddingHorizontal: 14, paddingVertical: 12, gap: 8 }, stuck ? { borderWidth: 1, borderColor: withAlpha(c.statusDanger, 0.6) } : raised(c)]}>
    {stuck ? <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="TriangleAlert" size={14} color={accent} />
        <Text style={{ ...t.label, flex: 1, color: c.statusDanger }}>Pause needs attention</Text>
        <Text style={t.meta}>{at}</Text>
      </View>
      <Text style={t.body}>{pause?.note ?? (pause?.dismissed ? "Worker release needs attention. Automatic continuation is cancelled." : "Check the session before continuing by hand.")}</Text>
    </> : <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", rowGap: 0 }}>
        <Icon name="Pause" size={compact ? 15 : 16} color={accent} />
        <Text style={{ color: c.foreground, fontSize: compact ? 18 : 20, lineHeight: compact ? 24 : 26, fontWeight: "600", ...tabular }}>{big}</Text>
        <Text style={{ ...t.meta, fontSize: 13, flexShrink: 1 }}>{countdown}</Text>
      </View>
      <Text style={t.meta}>{facts}</Text>
      {item.data.event === "recovery" ? <Text style={t.meta}>The original workers ended; the conversation and workspace stay in place.</Text> : null}
    </>}
    {!loaded ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Spinner color={c.foregroundMuted} size={11} /><Text style={t.meta}>Checking the pause…</Text></View> : null}
    {pause?.phase === "resuming" ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Spinner color={c.foregroundMuted} size={11} /><Text style={t.meta}>Resuming…</Text></View> : null}
    {waiting ? <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Button theme={theme} small compact={compact} icon="Play" title={action === "resume" ? "Resuming…" : "Resume now"} loading={action === "resume"} disabled={busy}
          accessibilityHint={item.data.demo ? "Releases this test session and turns its protection off." : "Continues before the reset and turns protection off for this session. The provider may still refuse work until the reset."} onPress={() => void act("resume")} />
        <Button theme={theme} small compact={compact} kind="ghost" title={action === "dismiss" ? "Dismissing…" : "Dismiss pause"} disabled={busy}
          accessibilityLabel="Dismiss pause without sending a message" onPress={() => void act("dismiss")} />
        <View style={{ flex: 1, minWidth: 8 }} />
        <TextLink theme={theme} compact={compact} label="All paused" onPress={openOverview} />
      </View>
      <Text style={t.small}>{item.data.demo ? "Resume now releases this test session and turns its protection off." : "Resume now turns protection off for this session · Dismiss sends nothing"}</Text>
    </View> : null}
    {stuck && pause?.dismissed ? <View style={{ flexDirection: "row" }}>
      <Button theme={theme} small compact={compact} title={action === "dismiss" ? "Dismissing…" : "Retry dismissal"} disabled={busy}
        accessibilityLabel="Retry dismissing pause without sending a message" onPress={() => void act("dismiss")} />
    </View> : null}
    {error ? <Text accessibilityRole="alert" style={{ ...t.meta, color: c.statusDanger }}>{error}</Text> : null}
    {statusError ? <Text accessibilityRole="alert" style={{ ...t.meta, color: c.statusDanger }}>{statusError}</Text> : null}
    {stuck ? <TextLink theme={theme} compact={compact} label="All paused sessions" onPress={openOverview} /> : null}
  </View>;
}

