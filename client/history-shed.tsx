import { useRpc, type PluginClientContext } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Text, View } from "react-native";

import { HISTORY_SHED_KIND, HistoryShedNoteSchema, historyShedPrepare, historyShedRestore, historyShedStatus } from "../shared/smart-session";

const mb = (bytes: number) => (bytes >= 10 * 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);
const day = (iso: string | null) => (iso === null ? "" : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }));

/**
 * Settings → Smart Session → Chat history. Opt-in: off, it says what it would do and nothing else,
 * and nothing here asks anyone to turn it on. It lists the agents it moved, with Restore, and the largest
 * closed agents, each with "Move now" (one agent, whatever the switch says).
 */
export function HistoryShedSection({ enabled, thresholds, saving, onToggle }: {
  enabled: boolean; thresholds: { minMb: number; minCompactions: number }; saving: boolean; onToggle: (next: boolean) => void;
}) {
  const read = useRpc(historyShedStatus);
  const restore = useRpc(historyShedRestore);
  const prepareNow = useRpc(historyShedPrepare);
  const queryClient = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: ["smart-session", "history-shed"], queryFn: () => read({ candidates: true }), refetchInterval: 5 * 60_000 });
  const plans = (status.data?.plans ?? []).filter((p) => p.state !== "discarded");
  const hint = enabled
    ? `On. When an agent past ${thresholds.minMb} MB or ${thresholds.minCompactions} compactions next loads, its history from before the last compaction moves to a backup in Smart Session's data folder. A full copy comes first and is never deleted, so those transcripts take about twice the disk. The agent keeps its id and everything it knows.`
    : "Off. Transcripts stay as they are.";
  return (
    <SettingsSection title="Chat history" info="A Claude agent's chat loads its whole transcript, so a long-running agent opens slower after every compaction. Claude no longer reads what came before the last compaction.">
      <SettingsCard>
        <SettingsSwitch label="Move old history aside" hint={hint} value={enabled} disabled={saving}
          onValueChange={(next) => onToggle(next)} />
        {(status.data?.unreadable ?? []).length > 0
          ? <SettingsAction label="Unreadable plans" actionLabel="" disabled onPress={() => undefined}
            hint={`${status.data!.unreadable.length === 1 ? "A plan file" : `${status.data!.unreadable.length} plan files`} in Smart Session's data folder can't be read, so ${status.data!.unreadable.length === 1 ? "that agent is" : "those agents are"} left as they are. Fix or remove ${status.data!.unreadable.length === 1 ? "it" : "them"} under history-shed/plans.`} />
          : null}
        {(status.data?.leftovers ?? []).length > 0
          ? <SettingsAction label="Leftover files" actionLabel="" disabled onPress={() => undefined}
            hint={`${status.data!.leftovers.length === 1 ? "A file" : `${status.data!.leftovers.length} files`} beside a transcript, left when a move was stopped or a process still had the file open: ${status.data!.leftovers.map((l) => l.file).join(", ")}. Nothing in them is lost. The agent's next load finishes what it can, and Smart Session's run log says why anything stays.`} />
          : null}
        {plans.map((plan) => {
          const name = plan.title ?? `Agent ${plan.agentId.slice(0, 8)}`;
          const line = plan.state === "committed" || plan.state === "committing" || plan.state === "restoring"
            ? plan.restoreRequested ? "Full history goes back at its next load." : `${mb(plan.from)} → ${mb(plan.to)} on ${day(plan.committedAt)}. Backup: ${plan.backupDir}`
            : plan.state === "restored" ? `Full history restored on ${day(plan.restoredAt)}. Left as it is from now on.`
              : plan.origin === "requested" || enabled ? `Ready: ${mb(plan.from)} → ${mb(plan.to)} at its next load.`
                : `Prepared: ${mb(plan.from)} → ${mb(plan.to)}. Waits until this switch is on.`;
          return plan.state === "committed" && !plan.restoreRequested
            ? <SettingsAction key={plan.agentId} label={name} hint={line} actionLabel="Restore" disabled={saving}
              onPress={() => void restore({ agentId: plan.agentId }).then((out) => {
                toast.show(out.ok ? `${name}: full history goes back at its next load` : out.error);
                void queryClient.invalidateQueries({ queryKey: ["smart-session", "history-shed"] });
              })} />
            : <SettingsAction key={plan.agentId} label={name} hint={line} actionLabel="" disabled onPress={() => undefined} />;
        })}
        {(status.data?.candidates ?? []).map((agent) => {
          const name = agent.title ?? `Agent ${agent.agentId.slice(0, 8)}`;
          return <SettingsAction key={agent.agentId} label={name} actionLabel="Move now" disabled={saving}
            hint={`${mb(agent.size)}, closed. Move now backs up the whole transcript, then moves its history from before the last compaction aside at its next load, even with this switch off.`}
            onPress={() => void prepareNow({ agentId: agent.agentId }).then((out) => {
              toast.show(out.ok ? `${name}: backed up. Older history moves aside at its next load.` : out.error);
              void queryClient.invalidateQueries({ queryKey: ["smart-session", "history-shed"] });
            })} />;
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
