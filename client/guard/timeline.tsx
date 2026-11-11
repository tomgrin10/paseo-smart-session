import { useEffect, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { timelinePresentation, type TimelineData } from "../../shared/guard/timeline.ts";
import { dismissPauseRpc, resumeNowRpc, statusRpc } from "../../shared/guard/contracts.ts";
import { PAUSE_ACTIONS, heldWork } from "../../shared/guard/presentation.ts";
import { timestamp, type Pause } from "../../shared/guard/policy.ts";
import { formatClock, formatDuration } from "../../shared/format.ts";
import { formatMoment } from "../../shared/forecast.ts";
import { Button, TextLink, text, useNow } from "../kit.tsx";
import { Spinner } from "../motion.tsx";
import { raised, tabular, withAlpha } from "../theme.ts";

const providerName = (id: string) => (id === "claude" ? "Claude" : id === "codex" ? "Codex" : id);

/**
 * A pause at the session limit, in the chat, drawn like Smart Session's other chat
 * cards and rows. While the pause waits, it is a card that leads
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
  /** One quiet line, sized like Smart Session's tool rows and Paseo's own. */
  const line = (icon: string, color: string, words: string, extra?: string) => (
    <View style={{ marginHorizontal: -13, flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 4 }}>
      <View style={{ width: 22, height: 22, marginRight: 4, alignItems: "center", justifyContent: "center" }}><Icon name={icon} size={12} color={color} /></View>
      <Text numberOfLines={2} style={{ flexShrink: 1, color: c.foregroundMuted, fontSize: 14, lineHeight: 20, ...tabular }}>
        <Text style={{ color: c.foreground }}>{words}</Text>{extra ? ` · ${extra}` : ""}
      </Text>
    </View>
  );
  /** The card shell shared with the messages Smart Session sends. */
  const shell = (alarm: boolean, children: ReactNode) => <View style={{ width: "100%", maxWidth: 560, marginVertical: 4 }}>
    <View style={[{ borderRadius: 12, backgroundColor: c.surface1, overflow: "hidden" }, alarm ? { borderWidth: 1, borderColor: withAlpha(c.statusDanger, 0.6) } : raised(c)]}>{children}</View>
  </View>;
  const titleRow = (icon: string, color: string, title: string, titleColor = c.foreground) => <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingTop: 11, paddingBottom: 4 }}>
    <Icon name={icon} size={14} color={color} />
    <Text numberOfLines={1} style={{ flex: 1, color: titleColor, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>{title}</Text>
    <Text style={t.meta}>{at}</Text>
  </View>;

  if (!live) {
    if (item.data.event === "resumed") return line("Play", c.foregroundMuted, presentation.title, item.data.manualResume ? `${at} · by you · no longer pauses at the limit` : `${at} · ${item.data.native ? "workers continued in place" : "continuation sent"}`);
    if (item.data.event === "released") return line("Pause", c.foregroundMuted, presentation.title, item.data.dismissed ? `${at} · no message sent · no longer pauses at the limit` : at);
    // attention
    return shell(true, <>
      {titleRow("TriangleAlert", c.statusDanger, presentation.title, c.statusDanger)}
      <View style={{ paddingHorizontal: 14, paddingBottom: 11 }}><Text style={t.body}>{presentation.detail}</Text></View>
    </>);
  }

  // A live pause: settled ones fold to a line.
  if (loaded && (pause === null || pause.phase === "cancelled" || pause.phase === "resumed")) {
    if (pause?.phase === "cancelled" && pause.dismissed) return line("Pause", c.foregroundMuted, "Pause dismissed", "no message sent · no longer pauses at the limit");
    if (pause?.phase === "resumed") return line("Pause", c.foregroundMuted, `Held at ${at}`, pause.manualResume ? `resumed by you ${formatClock(pause.settledAt)}` : `resumed ${formatClock(pause.settledAt)}`);
    // The event that ended it has its own line; this one only says when.
    return line("Pause", c.foregroundMuted, `Held at ${at}`, pause?.settledAt ? `ended ${formatClock(pause.settledAt)}` : "no longer active");
  }

  const reset = timestamp(item.data.resetAt);
  const auto = item.data.autoResume;
  const waiting = pause?.phase === "waiting";
  const stuck = pause?.phase === "attention";
  // Lead with the moment, the way every family card does: the reset clock, then the countdown.
  const big = item.data.demo ? "Test pause" : reset === null ? "Reset time unknown" : formatMoment(item.data.resetAt!, now);
  // What the hold is holding: the live pause knows about a message sent since the card was written.
  const work = pause ? heldWork(pause) : item.data.native ? "frozen" : "interrupted";
  const countdown = item.data.demo ? "waits for you" : reset === null ? "waiting for the provider to report it" : reset <= now ? "reset passed · waiting for a fresh reading"
    : `${!auto ? "resets" : work === "message" ? "your message runs" : "continues"} in ${formatDuration(reset - now)}`;
  const facts = [providerName(item.data.provider),
    item.data.usedPct === null ? null : `${Math.round(item.data.usedPct)}% used`,
    work === "message" ? (auto ? null : "your message waits") : work === "frozen" ? "native subagents frozen" : work === "idle" ? null : "turn interrupted",
    auto ? null : "continue by hand"].filter(Boolean).join(" · ");
  const accent = stuck ? c.statusDanger : c.statusWarning;

  return shell(stuck, <>
    {stuck ? titleRow("TriangleAlert", accent, "Pause needs attention", c.statusDanger)
      : titleRow("Pause", accent, item.data.demo ? "Test pause" : item.data.event === "recovery" ? "Still held after a Paseo restart" : "Held at the session limit")}
    <View style={{ paddingHorizontal: 14, paddingBottom: 11, gap: 8 }}>
      {stuck ? <Text style={t.body}>{pause?.note ?? (pause?.dismissed ? "Releasing the workers needs a look. Automatic continuation is cancelled." : "Check the session before continuing by hand.")}</Text> : <>
        <View style={{ gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, flexWrap: "wrap", rowGap: 0 }}>
            <Text style={{ color: c.foreground, fontSize: compact ? 17 : 18, lineHeight: compact ? 22 : 24, fontWeight: "600", ...tabular }}>{big}</Text>
            <Text style={{ ...t.meta, fontSize: 13, flexShrink: 1 }}>{countdown}</Text>
          </View>
          <Text style={t.meta}>{facts}</Text>
          {item.data.event === "recovery" ? <Text style={t.meta}>The original workers ended; the conversation and workspace stay in place.</Text> : null}
        </View>
      </>}
      {!loaded ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Spinner color={c.foregroundMuted} size={11} /><Text style={t.meta}>Checking the pause…</Text></View> : null}
      {pause?.phase === "resuming" ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Spinner color={c.foregroundMuted} size={11} /><Text style={t.meta}>Resuming…</Text></View> : null}
      {waiting ? <View style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          <Button theme={theme} small compact={compact} icon={PAUSE_ACTIONS.resume.icon} title={action === "resume" ? PAUSE_ACTIONS.resume.busy : PAUSE_ACTIONS.resume.label} loading={action === "resume"} disabled={busy}
            accessibilityHint={item.data.demo ? "Releases this test session and stops it pausing at the limit." : PAUSE_ACTIONS.resume.hint} onPress={() => void act("resume")} />
          <Button theme={theme} small compact={compact} kind="ghost" title={action === "dismiss" ? PAUSE_ACTIONS.dismiss.busy : PAUSE_ACTIONS.dismiss.label} disabled={busy}
            accessibilityHint={PAUSE_ACTIONS.dismiss.hint} onPress={() => void act("dismiss")} />
          <View style={{ flex: 1, minWidth: 8 }} />
          <TextLink theme={theme} compact={compact} label="Paused sessions" onPress={openOverview} />
        </View>
        <Text style={t.small}>{item.data.demo ? "Resume now releases this test session." : PAUSE_ACTIONS.note}</Text>
      </View> : null}
      {stuck && pause?.dismissed ? <View style={{ flexDirection: "row" }}>
        <Button theme={theme} small compact={compact} title={action === "dismiss" ? "Dismissing…" : "Retry dismissal"} disabled={busy}
          accessibilityLabel="Retry dismissing pause without sending a message" onPress={() => void act("dismiss")} />
      </View> : null}
      {error ? <Text accessibilityRole="alert" style={{ ...t.meta, color: c.statusDanger }}>{error}</Text> : null}
      {statusError ? <Text accessibilityRole="alert" style={{ ...t.meta, color: c.statusDanger }}>{statusError}</Text> : null}
      {stuck ? <TextLink theme={theme} compact={compact} label="Paused sessions" onPress={openOverview} /> : null}
    </View>
  </>);
}
