import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";

import { PROMPT_CARD_KIND, PromptCardSchema, TOOL_ROW_KIND, ToolRowSchema, fileName, promptCard, chatToolRow, type PromptCard, type ToolRow } from "../shared/chat";
import { raised } from "./theme";

const ICONS: Record<ToolRow["tool"], string> = {
  context_status: "FoldVertical",
  budget_status: "Gauge",
  checkpoint: "Save",
  request_compaction: "FoldVertical",
  defer_compaction: "Clock",
  publish_as: "Upload",
  publish_as_settings: "Settings",
};

const mono = () => (Platform.OS === "ios" ? "Menlo" : Platform.OS === "android" ? "monospace" : "ui-monospace, SFMono-Regular, Menlo, monospace");

/**
 * Smart Session's agent tools as one quiet line, sized like Paseo's own tool rows,
 * instead of a raw `mcp__smart-session__request_compaction` call. Press to read
 * what the agent saved or asked for.
 */
function ToolRowView({ item, theme }: PluginTimelineItemProps<ToolRow>) {
  const c = theme.colors;
  const row = item.data;
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const openable = row.detail !== "";
  const open = expanded && openable;
  const active = openable && (hovered || expanded);
  const alert = row.state === "failed" ? c.statusDanger : row.state === "refused" ? c.statusWarning : null;
  return <View style={{ marginHorizontal: -13 }}>
    <Pressable disabled={!openable} onPress={() => setExpanded((value) => !value)} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
      accessibilityRole={openable ? "button" : undefined} aria-expanded={openable ? expanded : undefined} aria-busy={row.state === "running"}
      style={{ flexDirection: "row", alignItems: "center", borderRadius: 8, borderWidth: 1, borderColor: open ? c.border : "transparent", borderBottomLeftRadius: open ? 0 : 8, borderBottomRightRadius: open ? 0 : 8, backgroundColor: open ? c.surface1 : "transparent", paddingHorizontal: 8, paddingVertical: 4 }}>
      <View style={{ width: 22, height: 22, marginRight: 4, alignItems: "center", justifyContent: "center" }}>
        {active
          ? <View style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}><Icon name="ChevronRight" size={14} color={c.foreground} /></View>
          : <Icon name={alert ? "TriangleAlert" : ICONS[row.tool]} size={12} color={alert ?? c.foregroundMuted} />}
      </View>
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 14, fontVariant: ["tabular-nums"], color: alert ?? (active || row.state === "running" ? c.foreground : c.foregroundMuted), opacity: row.state === "running" ? 0.72 : 1 }}>{row.line}</Text>
    </Pressable>
    {open ? <View style={{ borderWidth: 1, borderTopWidth: 0, borderColor: c.border, borderBottomLeftRadius: 8, borderBottomRightRadius: 8, overflow: "hidden" }}>
      <ScrollView style={[{ maxHeight: 240 }, Platform.OS === "web" ? ({ overscrollBehavior: "contain" } as object) : null]} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}>
        <Text selectable style={{ color: alert ?? c.foreground, fontSize: 13, lineHeight: 19, fontVariant: ["tabular-nums"] }}>{row.detail}</Text>
      </ScrollView>
    </View> : null}
  </View>;
}

const CARD: Record<PromptCard["kind"], { icon: string; title: string }> = {
  compact: { icon: "FoldVertical", title: "Compaction the agent asked for" },
  continue: { icon: "CornerDownRight", title: "Continue after compaction" },
  "guard-continue": { icon: "Play", title: "Continue after the reset" },
  "guard-resume": { icon: "Play", title: "Resume now" },
};

function cardBody(card: PromptCard): string {
  switch (card.kind) {
    case "compact": return card.reason ? card.reason : "No reason given.";
    case "continue": return card.statePath ? `Re-read ${fileName(card.statePath)} and carry on from its current step.` : "Pick the task up from the summary and carry on.";
    case "guard-continue": return "The session window reset. Pick up the unfinished task where it stopped.";
    case "guard-resume": return "You resumed this session before the reset. The provider may still refuse work until then.";
  }
}

/** A message Smart Session sent, as a card instead of a wall of instructions. */
function PromptCardView({ item, theme, layout }: PluginTimelineItemProps<PromptCard>) {
  const c = theme.colors;
  const card = item.data;
  const [expanded, setExpanded] = useState(false);
  const look = CARD[card.kind];
  const sender = card.kind.startsWith("guard") ? "Smart Session" : "Smart Compact";
  return <View style={{ alignSelf: layout.compact ? "stretch" : "flex-end", width: "100%", maxWidth: 560, marginVertical: 4 }}>
    <View style={[{ borderRadius: 12, backgroundColor: c.surface1, overflow: "hidden" }, raised(c)]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingTop: 11, paddingBottom: 4 }}>
        <Icon name={look.icon} size={14} color={c.foregroundMuted} />
        <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>{look.title}</Text>
        <Pressable accessibilityRole="button" aria-expanded={expanded} accessibilityLabel={expanded ? "Hide the full message" : "Show the full message"} onPress={() => setExpanded((v) => !v)} hitSlop={6}
          style={(state) => ({ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: state.pressed ? c.surface2 : "transparent" })}>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{expanded ? "Hide" : "Full message"}</Text>
        </Pressable>
      </View>
      <View style={{ paddingHorizontal: 14, paddingBottom: 11, gap: 4 }}>
        <Text selectable style={{ color: c.foreground, fontSize: 13, lineHeight: 19 }}>{cardBody(card)}</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
          {card.kind === "compact" ? `Sent by ${sender} once the agent was idle${card.retry ? ` · retry ${card.retry}: a message interrupted the last /compact` : ""}${card.statePath ? ` · keeps the goal, current step, decisions and dead ends · state in ${fileName(card.statePath)}` : ""}` : `Sent by ${sender}`}
        </Text>
      </View>
      {expanded ? <View style={{ borderTopWidth: 1, borderTopColor: c.border }}>
        <ScrollView style={[{ maxHeight: 300 }, Platform.OS === "web" ? ({ overscrollBehavior: "contain" } as object) : null]} contentContainerStyle={{ padding: 14 }}>
          <Text selectable style={{ color: c.foregroundMuted, fontFamily: mono(), fontSize: 12, lineHeight: 18 }}>{card.text}</Text>
        </ScrollView>
      </View> : null}
    </View>
  </View>;
}

export function contributeChat(client: PluginClientContext) {
  const removers = [
    // Bookkeeping stays Paseo's own grouped tool call (a plugin item always seals Paseo's group). See TOOL_PRESENTATION.
    client.addTimelineTransformer({
      id: "smart-session-tool-calls",
      query: { itemType: "tool_call" },
      transform({ item }) {
        const row = chatToolRow(item.name, item.status, item.detail, item.error);
        return row === null ? undefined : { items: [{ type: "plugin" as const, kind: TOOL_ROW_KIND, version: 1, data: row }] };
      },
    }),
    client.addTimelineTransformer({
      id: "smart-session-prompts",
      query: { itemType: "user_message" },
      transform({ item }) {
        const card = promptCard(item.text);
        return card === null ? undefined : { items: [{ type: "plugin" as const, kind: PROMPT_CARD_KIND, version: 1, data: card }] };
      },
    }),
    client.addTimelineRenderer({ kind: TOOL_ROW_KIND, version: 1, schema: ToolRowSchema, Component: ToolRowView }),
    client.addTimelineRenderer({ kind: PROMPT_CARD_KIND, version: 1, schema: PromptCardSchema, Component: PromptCardView }),
  ];
  return () => { for (const remove of removers) if (typeof remove === "function") void remove(); };
}
