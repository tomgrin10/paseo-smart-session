import { useRpc, type PluginClientContext } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Text, View } from "react-native";

import { HISTORY_SHED_KIND, HistoryShedNoteSchema, historyShedRestore, historyShedStatus } from "../shared/smart-session";

const mb = (bytes: number) => (bytes >= 10 * 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);
const day = (iso: string | null) => (iso === null ? "" : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }));

/**
 * Settings → Smart Session → Chat history. Opt-in: off, it says what it would do and nothing else,
 * and nothing here asks anyone to turn it on. On, it lists the agents it moved and offers Restore.
 */
export function HistoryShedSection({ enabled, thresholds, saving, onToggle }: {
  enabled: boolean; thresholds: { minMb: number; minCompactions: number }; saving: boolean; onToggle: (next: boolean) => void;
}) {
  const read = useRpc(historyShedStatus);
  const restore = useRpc(historyShedRestore);
  const queryClient = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: ["smart-session", "history-shed"], queryFn: () => read({}), refetchInterval: 5 * 60_000 });
  const plans = (status.data?.plans ?? []).filter((p) => p.state !== "discarded");
  const hint = enabled
    ? `On. When an agent past ${thresholds.minMb} MB or ${thresholds.minCompactions} compactions next loads, its history from before the last compaction moves to a backup beside its transcript. A full copy comes first and is never deleted, so those transcripts take about twice the disk. The agent keeps its id and everything it knows.`
    : "Off. Transcripts stay as they are.";
  return (
    <SettingsSection title="Chat history" info="A Claude agent's chat loads its whole transcript, so a long-running agent opens slower after every compaction. Claude no longer reads what came before the last compaction.">
      <SettingsCard>
        <SettingsSwitch label="Move old history aside" hint={hint} value={enabled} disabled={saving}
          onValueChange={(next) => onToggle(next)} />
        {plans.map((plan) => {
          const name = plan.title ?? `Agent ${plan.agentId.slice(0, 8)}`;
          const line = plan.state === "committed"
            ? plan.restoreRequested ? "Full history goes back at its next load." : `${mb(plan.from)} → ${mb(plan.to)} on ${day(plan.committedAt)}. Backup: ${plan.backupDir}`
            : plan.state === "restored" ? `Full history restored on ${day(plan.restoredAt)}. Left as it is from now on.`
              : `Ready: ${mb(plan.from)} → ${mb(plan.to)} at its next load.`;
          return plan.state === "committed" && !plan.restoreRequested
            ? <SettingsAction key={plan.agentId} label={name} hint={line} actionLabel="Restore" disabled={saving}
              onPress={() => void restore({ agentId: plan.agentId }).then((out) => {
                toast.show(out.ok ? `${name}: full history goes back at its next load` : out.error);
                void queryClient.invalidateQueries({ queryKey: ["smart-session", "history-shed"] });
              })} />
            : <SettingsAction key={plan.agentId} label={name} hint={line} actionLabel="" disabled onPress={() => undefined} />;
        })}
      </SettingsCard>
    </SettingsSection>
  );
}

/** The chat row a shed leaves. */
export function contributeHistoryShedTimeline(client: PluginClientContext) {
  return client.addTimelineRenderer({
    kind: HISTORY_SHED_KIND, version: 1, schema: HistoryShedNoteSchema,
    Component: ({ item, theme }) => (
      <View style={{ paddingVertical: 6, gap: 2 }}>
        <Text style={{ color: theme.colors.foreground }}>Older history moved to {item.data.backupDir}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{mb(item.data.from)} → {mb(item.data.to)}. The agent still knows everything it did. Restore it in Smart Session's settings.</Text>
      </View>
    ),
  });
}
