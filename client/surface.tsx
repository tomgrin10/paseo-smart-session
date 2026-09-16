import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { DailyBars, HourHeatmap, RankedTotals } from "./charts";
import { refreshPills } from "./pill";
import { enrolmentState } from "../shared/governor";
import { formatRelative, formatTokens, isInteresting, windowLabel } from "../shared/format";
import {
  budgetStatus,
  contextStatus,
  getSettings,
  installStatus,
  setSettings,
  spendSummary,
} from "../shared/smart-session";
import { withCompactThreshold } from "../shared/thresholds";

type Theme = PluginSurfaceProps["theme"];

/** Green under two thirds, amber past it, red once there is little room left. */
function toneFor(theme: Theme, pct: number): string {
  if (pct >= 90) return theme.colors.statusDanger;
  if (pct >= 66) return theme.colors.statusWarning;
  return theme.colors.accent;
}

function Bar({ theme, pct }: { theme: Theme; pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
      <View style={{ width: `${clamped}%`, height: 6, backgroundColor: toneFor(theme, clamped) }} />
    </View>
  );
}

function Row({
  theme,
  title,
  detail,
  pct,
  trailing,
}: {
  theme: Theme;
  title: string;
  detail: string;
  pct: number;
  trailing: string;
}) {
  return (
    <View style={{ gap: 6, paddingVertical: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600", flexGrow: 1 }}>{title}</Text>
        <Text style={{ color: toneFor(theme, pct), fontVariant: ["tabular-nums"] }}>{trailing}</Text>
      </View>
      <Bar theme={theme} pct={pct} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{detail}</Text>
    </View>
  );
}

function Section({ theme, title, children }: { theme: Theme; title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 2 }}>
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          letterSpacing: 1,
          textTransform: "uppercase",
          marginBottom: 4,
        }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}

/**
 * A switch, and the one thing it controls.
 *
 * `disabled` is for the options that only mean something while Smart Compact is on.
 * They stay visible and keep showing their own value — hiding them would make the
 * master switch look like it had erased them — but they dim and stop responding,
 * which is what says "this one depends on the one above".
 */
function Toggle({
  theme,
  on,
  label,
  detail,
  onPress,
  disabled = false,
}: {
  theme: Theme;
  on: boolean;
  label: string;
  detail: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <View
        style={{
          width: 36,
          height: 20,
          borderRadius: 10,
          padding: 2,
          backgroundColor: on ? theme.colors.accent : theme.colors.surface2,
          justifyContent: "center",
          alignItems: on ? "flex-end" : "flex-start",
        }}
      >
        <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: theme.colors.accentForeground }} />
      </View>
      <View style={{ flexShrink: 1, gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{label}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{detail}</Text>
      </View>
    </Pressable>
  );
}

function CompactThreshold({
  theme,
  label,
  detail,
  value,
  disabled,
  onSave,
}: {
  theme: Theme;
  label: string;
  detail: string;
  value: number;
  disabled: boolean;
  onSave: (value: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(value));
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(String(value)), [value]);

  const parsed = Number(draft.trim());
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 99;
  const changed = valid && parsed !== value;

  function save() {
    if (disabled || !changed || saving) return;
    setSaving(true);
    void onSave(parsed).finally(() => setSaving(false));
  }

  return (
    <View
      style={{
        gap: 8,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <View style={{ flexGrow: 1, flexShrink: 1, gap: 2 }}>
          <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{label}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{detail}</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={save}
            editable={!disabled && !saving}
            keyboardType="number-pad"
            maxLength={2}
            selectTextOnFocus
            accessibilityLabel={`${label} percentage`}
            style={{
              width: 48,
              paddingVertical: 6,
              paddingHorizontal: 8,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: valid ? theme.colors.border : theme.colors.statusDanger,
              backgroundColor: theme.colors.surface0,
              color: theme.colors.foreground,
              textAlign: "right",
              fontVariant: ["tabular-nums"],
            }}
          />
          <Text style={{ color: theme.colors.foregroundMuted }}>%</Text>
          <Pressable
            onPress={save}
            disabled={disabled || !changed || saving}
            style={{
              paddingVertical: 7,
              paddingHorizontal: 10,
              borderRadius: 6,
              backgroundColor: changed ? theme.colors.accent : theme.colors.surface2,
              opacity: disabled || !changed || saving ? 0.5 : 1,
            }}
          >
            <Text style={{ color: changed ? theme.colors.accentForeground : theme.colors.foregroundMuted }}>
              {saving ? "Saving…" : "Save"}
            </Text>
          </Pressable>
        </View>
      </View>
      {!valid ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>Enter a whole number from 1 to 99.</Text>
      ) : null}
    </View>
  );
}

export function SmartSessionSurface({ theme, layout }: PluginSurfaceProps) {
  const budget = useRpc(budgetStatus);
  const context = useRpc(contextStatus);
  const spend = useRpc(spendSummary);
  const readSettings = useRpc(getSettings);
  const writeSettings = useRpc(setSettings);
  const readEnrolment = useRpc(enrolmentState);
  const readInstall = useRpc(installStatus);
  const toast = useToast();
  const queryClient = useQueryClient();

  // The daemon serves usage from a five-minute cache, so polling it harder than
  // the recorder does would only redraw the same number.
  const budgetQuery = useQuery({ queryKey: ["smart-session", "budget"], queryFn: () => budget({}), refetchInterval: 30_000 });
  const contextQuery = useQuery({
    queryKey: ["smart-session", "context"],
    queryFn: () => context({}),
    refetchInterval: 15_000,
  });

  // Reconstructed from transcripts, which only change when an agent writes a turn.
  const spendQuery = useQuery({
    queryKey: ["smart-session", "spend"],
    queryFn: () => spend({ days: 30 }),
    refetchInterval: 5 * 60_000,
  });

  const settingsQuery = useQuery({
    queryKey: ["smart-session", "settings"],
    queryFn: () => readSettings({}),
    refetchInterval: 60_000,
  });

  // Cheap on every call after the first: with nothing to reconcile it reads two
  // files and writes none.
  const installQuery = useQuery({
    queryKey: ["smart-session", "install"],
    queryFn: () => readInstall({}),
    refetchInterval: 5 * 60_000,
  });

  const settings = settingsQuery.data?.settings;
  const enrolled = settingsQuery.data?.enrolledAgents ?? 0;
  const install = installQuery.data?.report;

  function toggleInstallHooks() {
    if (settings === undefined) return;
    const next = !settings.installHooks;
    void writeSettings({ installHooks: next })
      .then(() => {
        toast.show(next ? "Hooks registered with Claude Code" : "Hooks removed from Claude Code");
        return Promise.all([
          queryClient.invalidateQueries({ queryKey: ["smart-session", "settings"] }),
          queryClient.invalidateQueries({ queryKey: ["smart-session", "install"] }),
        ]);
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
  }

  function toggleEnabled() {
    if (settings === undefined) return;
    const next = !settings.enabled;
    void writeSettings({ enabled: next })
      // The pills live in this same client bundle, and the master switch decides
      // whether they exist at all, so they are told directly rather than waiting
      // out their own refresh interval.
      .then(() => refreshPills(() => readEnrolment({})))
      .then(() => {
        toast.show(next ? "Smart Compact on" : "Smart Compact off");
        return queryClient.invalidateQueries({ queryKey: ["smart-session", "settings"] });
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
  }

  function toggleAutoEnrol() {
    if (settings === undefined) return;
    const next = !settings.autoEnrol;
    void writeSettings({ autoEnrol: next })
      .then(() => refreshPills(() => readEnrolment({})))
      .then(() => {
        toast.show(next ? "Sessions enrol themselves" : "Sessions are enrolled one at a time");
        return queryClient.invalidateQueries({ queryKey: ["smart-session", "settings"] });
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
  }

  function togglePill() {
    if (settings === undefined) return;
    const next = !settings.showPill;
    void writeSettings({ showPill: next })
      // The pills live in this same client bundle, so they can be told directly
      // rather than waiting out their own refresh interval.
      .then(() => refreshPills(() => readEnrolment({})))
      .then(() => {
        toast.show(next ? "Pill shown on every agent" : "Pill hidden");
        return queryClient.invalidateQueries({ queryKey: ["smart-session", "settings"] });
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
  }

  async function saveCompactThreshold(profile: "large" | "small", compact: number): Promise<void> {
    if (settings === undefined) return;
    try {
      const result = await writeSettings({
        thresholds: {
          ...settings.thresholds,
          [profile]: withCompactThreshold(settings.thresholds[profile], compact),
        },
      });
      queryClient.setQueryData(["smart-session", "settings"], {
        settings: result.settings,
        enrolledAgents: enrolled,
      });
      await queryClient.invalidateQueries({ queryKey: ["smart-session", "context"] });
      toast.show(`Smart Compact will ask at ${compact}% for ${profile} windows`);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  const padding = layout.compact ? 12 : 20;
  const windows = (budgetQuery.data?.windows ?? []).filter(isInteresting);
  const agents = contextQuery.data?.agents ?? [];
  const recorder = budgetQuery.data?.recorder;
  const summary = spendQuery.data?.summary;
  const error = budgetQuery.data?.error ?? contextQuery.data?.error ?? null;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding, gap: 24 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="Gauge" size={18} color={theme.colors.foreground} />
        <Text style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "700" }}>Smart Session</Text>
      </View>

      {error !== null ? (
        <Text style={{ color: theme.colors.statusDanger }}>{error}</Text>
      ) : null}

      <Section theme={theme} title="Plan limits">
        {windows.length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted }}>
            No reading yet. The recorder samples every minute.
          </Text>
        ) : (
          windows.map((window) => (
            <Row
              key={window.id}
              theme={theme}
              title={windowLabel(window.id)}
              pct={window.pct}
              trailing={`${Math.round(window.pct)}%`}
              detail={[
                window.resetsAt === null ? null : `resets ${formatRelative(window.resetsAt)}`,
                window.burnPctPerHour === null || window.burnPctPerHour <= 0
                  ? null
                  : `${window.burnPctPerHour.toFixed(1)}%/h`,
                window.projectedFullAt === null ? null : `full ${formatRelative(window.projectedFullAt)}`,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
            />
          ))
        )}
      </Section>

      <Section theme={theme} title="Agent context">
        {agents.length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted }}>No agent has reported a turn yet.</Text>
        ) : (
          agents.map((agent) => (
            <Row
              key={agent.agentId}
              theme={theme}
              title={agent.title ?? agent.agentId.slice(0, 8)}
              pct={agent.usedPct}
              trailing={`${agent.usedPct.toFixed(1)}%`}
              detail={`${formatTokens(agent.usedTokens)} / ${formatTokens(agent.maxTokens)} · compact at ${
                agent.compactAtPct
              }% · ${agent.status}${agent.model === null ? "" : ` · ${agent.model}`}`}
            />
          ))
        )}
      </Section>

      {summary === undefined || summary.bucketCount === 0 ? null : (
        <Section theme={theme} title="Where the tokens went">
          <View style={{ flexDirection: "row", gap: 24, marginBottom: 12, flexWrap: "wrap" }}>
            <View>
              <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "700" }}>
                {formatTokens(summary.totalTokens)}
              </Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                billable tokens, last 30 days
              </Text>
            </View>
            <View>
              <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "700" }}>
                {Math.round(summary.cacheHitPct)}%
              </Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>served from cache</Text>
            </View>
            {summary.subagentTokens === 0 ? null : (
              <View>
                <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "700" }}>
                  {formatTokens(summary.subagentTokens)}
                </Text>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>from subagents</Text>
              </View>
            )}
          </View>

          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginBottom: 6 }}>Tokens per day</Text>
          <DailyBars theme={theme} days={summary.byDay.slice(-30)} compact={layout.compact} />

          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 16, marginBottom: 6 }}>
            Tokens by hour of the week
          </Text>
          <HourHeatmap theme={theme} cells={summary.heatmap} compact={layout.compact} />

          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 16, marginBottom: 6 }}>
            By workspace
          </Text>
          <RankedTotals theme={theme} rows={summary.byProject} total={summary.totalTokens} />

          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 12, marginBottom: 6 }}>
            By model
          </Text>
          <RankedTotals theme={theme} rows={summary.byModel} total={summary.totalTokens} />
        </Section>
      )}

      {settings === undefined ? null : (
        <Section theme={theme} title="Smart Compact">
          <Toggle
            theme={theme}
            on={settings.enabled}
            label="Smart Compact"
            detail={
              settings.enabled
                ? `On. Past ${settings.thresholds.large.compact}% of a large window or ${settings.thresholds.small.compact}% of a small one, a session is asked at the end of a turn whether to compact itself — and compacted only if it says yes. ${enrolled} session${
                    enrolled === 1 ? "" : "s"
                  } enrolled.`
                : "Off. Nothing is asked and nothing is compacted. A request an agent already made waits rather than failing."
            }
            onPress={toggleEnabled}
          />
          <View style={{ marginTop: 8 }}>
            <CompactThreshold
              theme={theme}
              label="Large-window compact threshold"
              detail={`For context windows of ${formatTokens(settings.thresholds.largeWindowFrom)} or more. Earlier notice bands move down when needed.`}
              value={settings.thresholds.large.compact}
              disabled={!settings.enabled}
              onSave={(value) => saveCompactThreshold("large", value)}
            />
          </View>
          <View style={{ marginTop: 8 }}>
            <CompactThreshold
              theme={theme}
              label="Small-window compact threshold"
              detail={`For context windows below ${formatTokens(settings.thresholds.largeWindowFrom)}. Earlier notice bands move down when needed.`}
              value={settings.thresholds.small.compact}
              disabled={!settings.enabled}
              onSave={(value) => saveCompactThreshold("small", value)}
            />
          </View>
          <View style={{ marginTop: 8 }}>
            <Toggle
              theme={theme}
              on={settings.autoEnrol}
              disabled={!settings.enabled}
              label="Enrol sessions automatically"
              detail="On, a session that has written task state with the checkpoint tool is enrolled by that alone. Off, each session is enrolled by hand from its pill."
              onPress={toggleAutoEnrol}
            />
          </View>
          <View style={{ marginTop: 8 }}>
            <Toggle
              theme={theme}
              on={settings.showPill}
              disabled={!settings.enabled}
              label="Show the pill on every agent"
              detail="Puts the smart-compact state on each composer, where pressing it enrols that session or takes it out."
              onPress={togglePill}
            />
          </View>
          <View style={{ marginTop: 8 }}>
            <Toggle
              theme={theme}
              on={settings.installHooks}
              disabled={!settings.enabled}
              label="Register the hooks with Claude Code"
              detail={
                install === undefined
                  ? "Keeps this plugin's hooks in ~/.claude/settings.json up to date. Nothing asks a session to compact itself without them."
                  : install.error !== null
                    ? install.error
                    : install.pluginDir === null
                      ? "Not registered. Nothing will ask a session to compact itself."
                      : `Registered: ${install.hooks.join(", ")}. Only entries pointing at this plugin are touched; the MCP server is ${
                          install.mcp === "unavailable" ? "not registered — the claude CLI was not reachable" : "registered"
                        }.`
              }
              onPress={toggleInstallHooks}
            />
          </View>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, marginTop: 6 }}>
            A session is never compacted unless it asks. Paseo puts the question at a turn boundary
            and sends the /compact it asked for. The agent also chooses whether to start another turn
            afterwards and can supply that follow-up message itself.
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, marginTop: 4 }}>
            {`Asked at ${settings.thresholds.large.compact}% of a ${formatTokens(settings.thresholds.largeWindowFrom)}+ window (${formatTokens(
              Math.round((settings.thresholds.large.compact / 100) * 1_000_000),
            )} tokens on a 1M session), or ${settings.thresholds.small.compact}% of a smaller one. What tires a context is its absolute size, not its share of the window.`}
          </Text>
        </Section>
      )}

      {recorder === undefined ? null : (
        <Section theme={theme} title="Recorder">
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {recorder.newestAt === null
              ? "Nothing recorded yet."
              : `Newest reading ${formatRelative(recorder.newestAt)} from ${recorder.source ?? "?"} · ${
                  recorder.samplesHeld
                } samples held${
                  recorder.firstSampleAt === null ? "" : ` since ${formatRelative(recorder.firstSampleAt)}`
                }`}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{recorder.dataDir}</Text>
        </Section>
      )}
    </ScrollView>
  );
}
