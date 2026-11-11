import { useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useRpc, type PluginButtonContentProps, type PluginClientContext } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";

import { formatClock, formatCompactTokens, formatDuration, formatRelative } from "../shared/format";
import { linesSummary, outlookSentence } from "../shared/compact-lines";
import { contextOutlook } from "../shared/forecast";
import { confirmation, listCompactions, setEnrolment, type CompactionRequest } from "../shared/governor";
import { cancelResumeRpc, dismissPauseRpc, resumeNowRpc, setProtectionRpc, statusRpc } from "../shared/guard/contracts";
import { PAUSE_ACTIONS, THEN, governorNotice, heldWork, pausePresentation } from "../shared/guard/presentation";
import { contextStatus } from "../shared/smart-session";
import { profileFor } from "../shared/thresholds";
import type { AgentDirectory } from "./agents";
import { Meter, Ring, toneFill } from "./charts";
import { governedPause, guardSnapshot, publishGuard, resumeMoment, sessionProtection, subscribeGuard } from "./guard/status";
import { Button, Switch, TextLink, errorText, text, useNow } from "./kit";
import { noteEnrolment, pillSnapshot, subscribePills } from "./pill-store";
import { tabular, toneColor } from "./theme";
import { SETTINGS_SCREEN } from "./screens";
import { hasSubscriptions, subscribeSubscriptions, subscriptionsSnapshot } from "./subscriptions";
import { atTheLimit, sessionWindow, subscriptionState, weeklyWindow } from "../shared/subscriptions";

/** What the last compaction did, in one line. */
function compactionLine(item: CompactionRequest | undefined, now: number): string {
  if (item === undefined) return "None yet";
  if (item.state === "pending" || item.state === "sending") return "Queued · sent when this turn ends";
  if (item.state === "failed") return `Failed ${formatRelative(item.settledAt ?? item.createdAt, now)}`;
  if (item.state === "cancelled") return `Cancelled ${formatRelative(item.settledAt ?? item.createdAt, now)}`;
  // Delivered is not compacted: a /compact can be cancelled or fail (`confirmation`).
  const confirmed = confirmation(item);
  if (confirmed === null) return `${item.error !== null ? "Didn't compact" : "Not confirmed"} · sent ${formatRelative(item.settledAt ?? item.createdAt, now)}`;
  const when = formatRelative(confirmed, now);
  return item.preTokens !== null && item.postTokens !== null ? `${when} · ${formatCompactTokens(item.preTokens)} → ${formatCompactTokens(item.postTokens)}` : when;
}

/** The pill's popover: a pause when there is one, this session's context and both of its switches. */
export function makeContextPopover(client: PluginClientContext, agents: AgentDirectory) {
  return function ContextPopover({ theme, layout, close, ...rest }: PluginButtonContentProps) {
    const agentId = rest.context === "agent" ? rest.agentId : "";
    const c = theme.colors;
    const t = text(c);
    const now = useNow(15_000);
    const pills = useSyncExternalStore(subscribePills, pillSnapshot, pillSnapshot);
    const guard = useSyncExternalStore(subscribeGuard, guardSnapshot, guardSnapshot);
    const subs = useSyncExternalStore(subscribeSubscriptions, subscriptionsSnapshot, subscriptionsSnapshot);
    useSyncExternalStore(agents.subscribe, agents.version, agents.version);
    const readContext = useRpc(contextStatus);
    const readCompactions = useRpc(listCompactions);
    const writeEnrolment = useRpc(setEnrolment);
    const readGuard = useRpc(statusRpc);
    const writeProtection = useRpc(setProtectionRpc);
    const cancelResume = useRpc(cancelResumeRpc);
    const resumeNow = useRpc(resumeNowRpc);
    const dismissPause = useRpc(dismissPauseRpc);
    const [saving, setSaving] = useState<"compact" | "protect" | "release" | "resume" | "dismiss" | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const detail = useQuery({ queryKey: ["smart-session", "context", agentId], queryFn: () => readContext({ agentId }), refetchInterval: 30_000 });
    const compactions = useQuery({ queryKey: ["smart-session", "compactions", agentId], queryFn: () => readCompactions({ agentId }), refetchInterval: 30_000 });

    const agent = agents.current().get(agentId);
    const row = detail.data?.agents[0];
    const used = agent?.usedTokens ?? row?.usedTokens ?? null;
    const max = agent?.maxTokens ?? row?.maxTokens ?? null;
    const compactOn = pills.compactOn;
    const enrolled = compactOn && pills.enrolled.has(agentId);
    const compact = layout.compact;
    const pause = governedPause(guard, agentId);
    const protection = sessionProtection(guard, agentId);

    async function run(kind: "compact" | "protect" | "release" | "resume" | "dismiss", work: () => Promise<void>) {
      setSaving(kind); setProblem(null);
      try {
        await work();
      } catch (error) {
        setProblem(errorText(error));
      } finally {
        setSaving(null);
      }
    }
    const toggleCompact = (next: boolean) => run("compact", async () => {
      const { agent: saved } = await writeEnrolment({ agentId, enrolled: next });
      noteEnrolment(saved.agentId, saved.enrolled);
    });
    // Back to the default is the same as no override, so the switch never leaves a redundant one.
    const setProtected = (next: boolean | null) => run("protect", async () => {
      const enabled = protection.kind === "on" && next === protection.byDefault ? null : next;
      await writeProtection({ agentId, enabled });
      publishGuard(await readGuard({}));
    });
    // A stuck pause can only be released; a waiting one gets the same two actions as its chat card.
    const release = () => run("release", async () => {
      await cancelResume({ agentId });
      publishGuard(await readGuard({}));
    });
    const settle = (kind: "resume" | "dismiss", pauseId: string) => run(kind, async () => {
      await (kind === "resume" ? resumeNow : dismissPause)({ agentId, pauseId });
      publishGuard(await readGuard({}));
    });
    const openOverview = (focus?: string) => { close(); client.openScreen({ screenId: "overview", params: focus ? { focus } : undefined }); };
    const openSettings = () => { close(); client.openSettings(SETTINGS_SCREEN); };

    const head = (() => {
      if (used === null || max === null) return null;
      const profile = profileFor(max, pills.thresholds ?? undefined);
      const compactAtPct = row?.compactAtPct ?? profile.compact;
      const nowAtPct = row?.compactNowAtPct ?? profile.now;
      return { compactAtPct, nowAtPct, outlook: contextOutlook({ usedTokens: used, maxTokens: max, compactAtPct, compactNowAtPct: nowAtPct, growthTokensPerHour: row?.growthTokensPerHour ?? null }) };
    })();
    const sentence = head === null
      ? { line: "No context reading yet. A session reports one after its first turn.", tone: "default" as const }
      : outlookSentence(head.outlook, { enrolled, compactOn, growthPerHour: row?.growthTokensPerHour ?? null });
    const latest = compactions.data?.items[0];
    const state = row?.stateWrittenAt ?? null;
    const facts: [string, string][] = [
      ["Task state", state === null ? (row === undefined ? "…" : "Not written yet") : `Saved ${formatRelative(state, now)}`],
      ["Last compaction", compactions.data === undefined ? "…" : compactionLine(latest, now)],
    ];
    // Under ZeroSub with several subscriptions: which one this session runs on, and what happens at its limit.
    const account = (() => {
      if (!hasSubscriptions(subs)) return null;
      const own = subs.accounts.find((a) => a.id === subs.agents[agentId]);
      if (!own || subs.accounts.filter((a) => a.family === own.family).length < 2) return null;
      const pct = (w: { pct: number; resetsAt: string | null } | null) => w === null ? null : w.resetsAt !== null && Date.parse(w.resetsAt) <= now ? 0 : Math.round(w.pct);
      const s5 = pct(sessionWindow(own));
      const week = pct(weeklyWindow(own));
      const state = subscriptionState(own, now);
      const windows = [s5 === null ? null : `5h ${s5}%`, week === null ? null : `week ${week}%`].filter(Boolean).join(" · ");
      const value = [own.name, state.kind === "room" ? windows : state.label].filter(Boolean).join(" · ");
      const next = atTheLimit(subs.accounts, own.id, now, { autoSwitch: subs.autoSwitch, protectedHere: protection.kind === "on" && protection.protected });
      return { value, next, tone: state.kind === "limit" ? "danger" as const : null };
    })();
    if (account) facts.push(["Subscription", account.value]);
    const ringColor = head === null ? c.foregroundMuted : head.outlook.tone !== "default" ? toneFill(c, head.outlook.tone) : enrolled ? c.foreground : c.foregroundMuted;
    const part = { gap: 6, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.border } as const;

    // The loud state: what happened, when it comes back, and the one way to let it go.
    const pausePart = (() => {
      if (pause === undefined || guard === null) return null;
      const look = pausePresentation(pause, guard.policy, now);
      const stuck = pause.phase === "attention";
      const reset = resumeMoment(pause);
      const auto = guard.policy.enabled && guard.policy.autoResume;
      const work = heldWork(pause);
      const held = auto || work === "idle";
      const moment = stuck ? "Needs a look" : pause.demo ? "Test pause" : reset === null ? "Held · reset time unknown" : reset <= now ? "Held · reset due" : `${held ? "Held until" : "Resets"} ${formatClock(pause.anchorResetsAt)}`;
      // The moment says when; this line says what happens then, and what the hold covers.
      const after = stuck ? (pause.note ?? "It stopped before the pause was confirmed. Check it before continuing by hand.")
        : pause.demo ? "a test pause that waits for you"
          : reset === null ? "Waiting for the provider to report the reset"
            : reset <= now ? "Waiting for a fresh usage reading"
              : `in ${formatDuration(reset - now)} · ${work === "idle" ? "no turn runs before then" : held ? THEN[work] : "continue it by hand"}`;
      const tone = stuck ? c.statusDanger : c.statusWarning;
      // "your message runs then" already says a message waits; coverage would only repeat it.
      const meta = [after, work === "message" ? null : look.coverage.toLowerCase()].filter(Boolean).join(" · ");
      const waiting = pause.phase === "waiting";
      return <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name={stuck ? "TriangleAlert" : "Pause"} size={18} color={tone} />
          <Text style={{ color: c.foreground, fontSize: 20, lineHeight: 26, fontWeight: "600", flexShrink: 1, ...tabular }}>{moment}</Text>
        </View>
        <Text style={{ ...t.meta, color: stuck ? c.statusDanger : c.foregroundMuted }}>{meta}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
          {waiting ? <>
            <Button theme={theme} small compact={compact} icon={PAUSE_ACTIONS.resume.icon} title={saving === "resume" ? PAUSE_ACTIONS.resume.busy : PAUSE_ACTIONS.resume.label} disabled={saving !== null}
              accessibilityHint={PAUSE_ACTIONS.resume.hint} onPress={() => void settle("resume", pause.id)} />
            <Button theme={theme} small compact={compact} kind="ghost" title={saving === "dismiss" ? PAUSE_ACTIONS.dismiss.busy : PAUSE_ACTIONS.dismiss.label} disabled={saving !== null}
              accessibilityHint={PAUSE_ACTIONS.dismiss.hint} onPress={() => void settle("dismiss", pause.id)} />
          </> : stuck ? <Button theme={theme} small compact={compact} title={saving === "release" ? "Updating…" : look.actionLabel} disabled={saving !== null}
            accessibilityHint={look.actionHint} onPress={() => void release()} /> : null}
          <View style={{ flex: 1 }} />
          <TextLink theme={theme} compact={compact} label="All paused sessions" onPress={() => openOverview("paused")} />
        </View>
        {waiting ? <Text style={t.small}>{PAUSE_ACTIONS.note}</Text> : null}
      </View>;
    })();

    const protectionPart = (() => {
      if (pause !== undefined) return null;
      if (protection.kind === "unknown") return null;
      if (protection.kind === "on") {
        const meta = protection.protected
          ? `Held at ${protection.thresholdPct}% until the reset, ${protection.autoResume ? "then continues" : "then you continue it"}`
          : "Off for this session · at the limit the provider refuses work and nothing continues it";
        const source = protection.override === null ? (protection.byDefault ? "Your default" : "Your default is off") : "Changed for this session";
        return <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={t.label}>Pause at the limit (Session Guard)</Text>
            <Text style={t.meta}>{meta}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <Text style={t.small}>{source}</Text>
              {protection.override !== null ? <TextLink theme={theme} compact={compact} icon="RotateCcw" label="Use default" onPress={() => void setProtected(null)} /> : null}
            </View>
          </View>
          <Switch theme={theme} label="Pause this session at the limit" hideLabel value={protection.protected} disabled={saving !== null} compact={compact} onChange={(next) => void setProtected(next)} />
        </View>;
      }
      // Not running here: one calm line, and where to change it.
      const line = protection.kind === "off" ? "Pause at the limit (Session Guard) is off on this host"
        : protection.kind === "elsewhere" ? (protection.standalone ? "The standalone Session Guard plugin handles pausing at the limit here" : "Another process runs Session Guard here")
          : `${governorNotice(guard!)?.title ?? "Pause at the limit isn't running"} (Session Guard)`;
      return <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="CirclePause" size={13} color={c.foregroundMuted} />
        <Text style={{ ...t.meta, flex: 1 }}>{line}</Text>
        {protection.kind === "off" ? <TextLink theme={theme} compact={compact} icon="Settings" label="Turn on" onPress={openSettings} /> : null}
      </View>;
    })();

    return <View style={{ width: compact ? "100%" : 340, padding: compact ? 16 : 14, paddingTop: compact ? 4 : 14, gap: 12 }}>
      {pausePart}
      <View style={[{ gap: 12 }, pausePart === null ? null : part]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Ring size={pausePart === null ? 40 : 28} color={ringColor} fraction={head === null ? 0 : head.outlook.pct / 100} mark={head === null || !enrolled ? null : head.compactAtPct / 100} upper={head === null ? null : head.nowAtPct / 100} />
          <View style={{ flex: 1, gap: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
              <Text style={{ color: c.foreground, fontSize: pausePart === null ? 22 : 15, lineHeight: pausePart === null ? 28 : 20, fontWeight: "600", ...tabular }}>{head === null ? "—" : `${Math.round(head.outlook.pct)}%`}</Text>
              <Text style={t.meta}>{max === null ? "context" : `of ${formatCompactTokens(max)} context`}</Text>
            </View>
            <Text style={t.meta}>{head === null || used === null ? "Waiting for a reading" : `${formatCompactTokens(used)} tokens · ${linesSummary(head.compactAtPct, head.nowAtPct)}`}</Text>
          </View>
        </View>
        {head === null || pausePart !== null ? null : <Meter theme={theme} pct={head.outlook.pct} tone={head.outlook.tone} mark={head.compactAtPct} upper={head.nowAtPct} height={6} label={`Context ${Math.round(head.outlook.pct)}% full. Smart Compact ${linesSummary(head.compactAtPct, head.nowAtPct)}`} />}
        {pausePart !== null ? null : <Text style={{ ...t.body, color: sentence.tone === "default" ? c.foreground : toneColor(c, sentence.tone) }}>{sentence.line}</Text>}
      </View>
      {pausePart !== null ? null : <View style={part}>
        {facts.map(([label, value]) => <View key={label} style={{ flexDirection: "row", gap: 12 }}>
          <Text style={{ ...t.meta, width: 112 }}>{label}</Text>
          <Text style={{ ...t.meta, flex: 1, color: label === "Subscription" && account?.tone ? toneColor(c, account.tone) : c.foreground, ...tabular }}>{value}</Text>
        </View>)}
        {account && account.next.text ? <Text style={{ ...t.meta, paddingLeft: 124, color: account.next.tone === "default" ? c.foregroundMuted : toneColor(c, account.next.tone) }}>{account.next.text}</Text> : null}
      </View>}
      <View style={{ ...part, gap: 12 }}>
        {compactOn ? <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={t.label}>Smart Compact</Text>
            <Text style={t.meta}>{enrolled ? "Asked at the end of a turn, then mid-turn. Never forced." : "Never asked to compact. The agent can still request it."}</Text>
          </View>
          <Switch theme={theme} label="Smart Compact for this session" hideLabel value={enrolled} disabled={saving !== null} compact={compact} onChange={(next) => void toggleCompact(next)} />
        </View> : <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name="FoldVertical" size={13} color={c.foregroundMuted} />
          <Text style={{ ...t.meta, flex: 1 }}>Smart Compact is off on this host</Text>
        </View>}
        {protectionPart}
      </View>
      {problem ? <Text accessibilityRole="alert" style={{ ...t.meta, color: c.statusDanger }}>{problem}</Text> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <TextLink theme={theme} compact={compact} label="Plan usage and every session" onPress={() => openOverview()} />
        <View style={{ flex: 1 }} />
        <TextLink theme={theme} compact={compact} icon="Settings" label="Settings" onPress={openSettings} />
      </View>
    </View>;
  };
}
