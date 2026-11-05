import { useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginButtonContentProps, type PluginClientContext } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";

import { formatCompactTokens, formatDuration, formatRelative } from "../shared/format";
import { contextOutlook } from "../shared/forecast";
import { listCompactions, setEnrolment, type CompactionRequest } from "../shared/governor";
import { contextStatus } from "../shared/smart-session";
import { profileFor } from "../shared/thresholds";
import type { AgentDirectory } from "./agents";
import { Meter, Ring, toneFill } from "./charts";
import { Switch, TextLink, errorText, text, useNow } from "./kit";
import { noteEnrolment, pillSnapshot, subscribePills } from "./pill-store";
import { tabular, toneColor } from "./theme";

/** What the last compaction did, in one line. */
function compactionLine(item: CompactionRequest | undefined, now: number): string {
  if (item === undefined) return "None yet";
  if (item.state === "pending" || item.state === "sending") return "Queued · sent when this turn ends";
  if (item.state === "failed") return `Failed ${formatRelative(item.settledAt ?? item.createdAt, now)}`;
  if (item.state === "cancelled") return `Cancelled ${formatRelative(item.settledAt ?? item.createdAt, now)}`;
  const when = formatRelative(item.settledAt ?? item.createdAt, now);
  return item.preTokens !== null && item.postTokens !== null ? `${when} · ${formatCompactTokens(item.preTokens)} → ${formatCompactTokens(item.postTokens)}` : when;
}

/** The pill's popover: this session's context, its compact line, task state and enrolment. */
export function makeContextPopover(client: PluginClientContext, agents: AgentDirectory) {
  return function ContextPopover({ theme, layout, close, ...rest }: PluginButtonContentProps) {
    const agentId = rest.context === "agent" ? rest.agentId : "";
    const c = theme.colors;
    const t = text(c);
    const now = useNow(30_000);
    const pills = useSyncExternalStore(subscribePills, pillSnapshot, pillSnapshot);
    useSyncExternalStore(agents.subscribe, agents.version, agents.version);
    const readContext = useRpc(contextStatus);
    const readCompactions = useRpc(listCompactions);
    const writeEnrolment = useRpc(setEnrolment);
    const [saving, setSaving] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const detail = useQuery({ queryKey: ["smart-session", "context", agentId], queryFn: () => readContext({ agentId }), refetchInterval: 30_000 });
    const compactions = useQuery({ queryKey: ["smart-session", "compactions", agentId], queryFn: () => readCompactions({ agentId }), refetchInterval: 30_000 });

    const agent = agents.current().get(agentId);
    const row = detail.data?.agents[0];
    const used = agent?.usedTokens ?? row?.usedTokens ?? null;
    const max = agent?.maxTokens ?? row?.maxTokens ?? null;
    const enrolled = pills.enrolled.has(agentId);
    const compact = layout.compact;

    async function toggle(next: boolean) {
      setSaving(true); setProblem(null);
      try {
        const { agent: saved } = await writeEnrolment({ agentId, enrolled: next });
        noteEnrolment(saved.agentId, saved.enrolled);
      } catch (error) {
        setProblem(errorText(error));
      } finally {
        setSaving(false);
      }
    }

    const head = (() => {
      if (used === null || max === null) return null;
      const compactAtPct = row?.compactAtPct ?? profileFor(max, pills.thresholds ?? undefined).compact;
      return { compactAtPct, outlook: contextOutlook({ usedTokens: used, maxTokens: max, compactAtPct, growthTokensPerHour: row?.growthTokensPerHour ?? null }) };
    })();
    const sentence = head === null
      ? { line: "No context reading yet. A session reports one after its first turn.", tone: "default" as const }
      : head.outlook.past
        ? { line: enrolled ? "Past its compact line. Smart Compact asks it at the end of a turn whether to compact." : "Past its compact line, but not enrolled, so nothing will ask it.", tone: head.outlook.tone }
        : head.outlook.untilCompactMs !== null
          ? { line: `Reaches its compact line in about ${formatDuration(head.outlook.untilCompactMs)} at +${formatCompactTokens(row!.growthTokensPerHour!)}/h.`, tone: "default" as const }
          : { line: "Below its compact line and not growing right now.", tone: "default" as const };
    const latest = compactions.data?.items[0];
    const state = row?.stateWrittenAt ?? null;
    const facts: [string, string][] = [
      ["Task state", state === null ? (row === undefined ? "…" : "Not written yet") : `Saved ${formatRelative(state, now)}`],
      ["Last compaction", compactions.data === undefined ? "…" : compactionLine(latest, now)],
    ];
    const ringColor = head === null ? c.foregroundMuted : head.outlook.tone !== "default" ? toneFill(c, head.outlook.tone) : enrolled ? c.foreground : c.foregroundMuted;

    return <View style={{ width: compact ? "100%" : 340, padding: compact ? 16 : 14, gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Ring size={40} color={ringColor} fraction={head === null ? 0 : head.outlook.pct / 100} mark={head === null ? null : head.compactAtPct / 100} />
        <View style={{ flex: 1, gap: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
            <Text style={{ color: c.foreground, fontSize: 22, lineHeight: 28, fontWeight: "600" }}>{head === null ? "—" : `${Math.round(head.outlook.pct)}%`}</Text>
            <Text style={t.meta}>{max === null ? "context" : `of ${formatCompactTokens(max)} context`}</Text>
          </View>
          <Text style={t.meta}>{head === null || used === null ? "Waiting for a reading" : `${formatCompactTokens(used)} tokens · compacts at ${head.compactAtPct}% (${formatCompactTokens(head.outlook.compactTokens)})`}</Text>
        </View>
      </View>
      {head === null ? null : <Meter theme={theme} pct={head.outlook.pct} tone={head.outlook.tone} mark={head.compactAtPct} height={6} label={`Context ${Math.round(head.outlook.pct)}% full, compacts at ${head.compactAtPct}%`} />}
      <Text style={{ ...t.body, color: sentence.tone === "default" ? c.foreground : toneColor(c, sentence.tone) }}>{sentence.line}</Text>
      <View style={{ gap: 6, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.border }}>
        {facts.map(([label, value]) => <View key={label} style={{ flexDirection: "row", gap: 12 }}>
          <Text style={{ ...t.meta, width: 112 }}>{label}</Text>
          <Text style={{ ...t.meta, flex: 1, color: c.foreground, ...tabular }}>{value}</Text>
        </View>)}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.border }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={t.label}>Smart Compact for this session</Text>
          <Text style={t.meta}>{enrolled ? `Asked to compact itself once past ${head?.compactAtPct ?? "its"}%${head === null ? " line" : ""}. Never forced.` : "Never asked to compact. The agent can still request it."}</Text>
        </View>
        <Switch theme={theme} label="Smart Compact for this session" hideLabel value={enrolled} disabled={saving} compact={compact} onChange={(next) => void toggle(next)} />
      </View>
      {problem ? <Text accessibilityRole="alert" style={{ ...t.meta, color: c.statusDanger }}>{problem}</Text> : null}
      <TextLink theme={theme} compact={compact} label="Plan usage and every session" onPress={() => { close(); client.openScreen({ screenId: "overview" }); }} />
    </View>;
  };
}
