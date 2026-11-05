import { useRpc, useSettings, type PluginClientContext, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { Platform, ScrollView, Text, View } from "react-native";

import { formatCompactTokens, formatDay, formatDuration, formatRelative, isInteresting } from "../shared/format";
import {
  budgetLine, contextOutlook, forecastWindow, formatMoment, headline, leadWindow, paceLine, resetLine,
  type Tone, type WindowForecast,
} from "../shared/forecast";
import { enrolmentState } from "../shared/governor";
import { guardPreferences, statusRpc as guardStatus } from "../shared/guard/contracts";
import { governorNotice, pausedSessions } from "../shared/guard/presentation";
import { budgetStatus, contextStatus, getSettings, installStatus, setSettings, spendSummary } from "../shared/smart-session";
import { DailyBars, HourHeatmap, Meter, PastWindows, RankedTotals, Ring, WindowChart, ink, toneFill } from "./charts";
import { refreshGuardPills } from "./guard/pills";
import { GUARD_SCREENS } from "./guard/surfaces";
import { Card, CardRow, Chip, IconButton, SectionHead, StatusGlyph, Switch, TextLink, errorText, text, useNow } from "./kit";
import type { Live } from "./live";
import { Reveal, Skeleton } from "./motion";
import { refreshPills } from "./pill-store";
import { tabular, toneColor, type Theme } from "./theme";

export const OVERVIEW_SCREEN = "overview";
export const SMART_COMPACT_SETTINGS = "smart-compact";

const ORDER = (id: string) => (id === "five_hour" ? 0 : id === "seven_day" ? 1 : 2);

function toneIcon(tone: Tone, state: WindowForecast["state"] | null): string {
  if (state === "full") return "OctagonAlert";
  if (tone !== "default") return "Hourglass";
  return "Gauge";
}

/** A meter row for one plan window: label and percentage, meter, reset and pace. */
function WindowRow({ theme, f, now, first, children }: { theme: Theme; f: WindowForecast; now: number; first: boolean; children?: ReactNode }) {
  const c = theme.colors;
  const t = text(c);
  const pace = paceLine(f, now);
  const budget = f.id === "five_hour" ? budgetLine(f) : null;
  return <CardRow theme={theme} first={first} style={{ gap: 6 }}>
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
      <Text style={{ ...t.label, flex: 1 }}>{f.label}</Text>
      <Text style={{ color: c.foreground, fontSize: 17, lineHeight: 22, fontWeight: "600" }}>{`${Math.round(f.pct)}%`}</Text>
    </View>
    <Meter theme={theme} pct={f.pct} tone={f.tone} projected={f.atResetPct} pace={f.elapsed === null ? null : f.elapsed * 100}
      label={`${f.label}: ${Math.round(f.pct)}% used${f.state === "short" ? `, ${pace.toLowerCase()}` : ""}`} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 10, rowGap: 2 }}>
      <Text style={t.meta}>{resetLine(f, now)}</Text>
      {pace ? <Text style={{ ...t.meta, color: f.state === "short" || f.state === "full" ? toneColor(c, f.tone) : c.foregroundMuted, fontWeight: f.state === "short" ? "600" : "400" }}>{pace}</Text> : null}
      {budget ? <Text style={t.meta}>{budget}</Text> : null}
    </View>
    {children}
  </CardRow>;
}

/** What the meter's three marks mean, once, under the card. */
function MeterKey({ theme }: { theme: Theme }) {
  const c = theme.colors;
  const swatch = (color: string) => <View style={{ width: 14, height: 6, borderRadius: 3, backgroundColor: color }} />;
  return <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 14, rowGap: 4, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>{swatch(ink(c, 0.82))}<Text style={text(c).small}>Used</Text></View>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>{swatch(ink(c, 0.16))}<Text style={text(c).small}>By the reset at this pace</Text></View>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><View style={{ width: 2, height: 12, borderRadius: 1, backgroundColor: c.foregroundMuted }} /><Text style={text(c).small}>Even pace</Text></View>
  </View>;
}

function LoadingCard({ theme, rows = 3 }: { theme: Theme; rows?: number }) {
  const c = theme.colors;
  return <Card theme={theme}>
    {Array.from({ length: rows }, (unused, i) => <CardRow key={i} theme={theme} first={i === 0} style={{ gap: 8 }}>
      <Skeleton width="38%" height={11} color={c.surface2} />
      <Skeleton width="100%" height={8} color={c.surface2} />
    </CardRow>)}
  </Card>;
}

function Empty({ theme, title, detail }: { theme: Theme; title: string; detail: string }) {
  const t = text(theme.colors);
  return <Card theme={theme}><CardRow theme={theme} first style={{ gap: 4, paddingVertical: 16 }}>
    <Text style={t.label}>{title}</Text>
    <Text style={t.meta}>{detail}</Text>
  </CardRow></Card>;
}

/** A feature row: icon, name and one line of state paired with its moment, then its links and switch. */
function FeatureRow({ theme, icon, title, line, tone = "default", on, onToggle, disabled, compact, first, links, children }: {
  theme: Theme; icon: string; title: string; line: ReactNode; tone?: Tone; on: boolean | null; onToggle: (next: boolean) => void; disabled?: boolean; compact: boolean; first: boolean; links: ReactNode; children?: ReactNode;
}) {
  const c = theme.colors;
  const t = text(c);
  return <CardRow theme={theme} first={first} style={{ gap: 6 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Icon name={icon} size={15} color={on ? c.foreground : c.foregroundMuted} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={t.label}>{title}</Text>
        <Text style={{ ...t.meta, color: tone === "default" ? c.foregroundMuted : toneColor(c, tone) }}>{line}</Text>
      </View>
      {compact ? null : links}
      <Switch theme={theme} label={title} hideLabel value={on} onChange={onToggle} disabled={disabled} compact={compact} />
    </View>
    {children}
    {compact ? <View style={{ flexDirection: "row", gap: 16, paddingLeft: 25 }}>{links}</View> : null}
  </CardRow>;
}

export function makeOverview(client: PluginClientContext, live: Live) {
  return function SmartSessionOverview({ theme, layout, navigation }: PluginScreenProps) {
    const c = theme.colors;
    const t = text(c);
    const compact = layout.compact;
    const now = useNow(30_000);
    const toast = useToast();
    const queryClient = useQueryClient();
    const budget = useRpc(budgetStatus);
    const context = useRpc(contextStatus);
    const spend = useRpc(spendSummary);
    const readSettings = useRpc(getSettings);
    const writeSettings = useRpc(setSettings);
    const readEnrolment = useRpc(enrolmentState);
    const readInstall = useRpc(installStatus);
    const readGuard = useRpc(guardStatus);
    const guardSettings = useSettings(guardPreferences);

    // The recorder writes once a minute and the daemon caches usage for five, so
    // polling harder than this would only redraw the same numbers.
    const budgetQuery = useQuery({ queryKey: ["smart-session", "budget"], queryFn: () => budget({}), refetchInterval: 30_000 });
    const contextQuery = useQuery({ queryKey: ["smart-session", "context"], queryFn: () => context({}), refetchInterval: 15_000 });
    // Reconstructed from transcripts, which only change when an agent writes a turn.
    const spendQuery = useQuery({ queryKey: ["smart-session", "spend"], queryFn: () => spend({ days: 30 }), refetchInterval: 5 * 60_000 });
    const settingsQuery = useQuery({ queryKey: ["smart-session", "settings"], queryFn: () => readSettings({}), refetchInterval: 60_000 });
    const enrolmentQuery = useQuery({ queryKey: ["smart-session", "enrolment"], queryFn: () => readEnrolment({}), refetchInterval: 30_000 });
    // Cheap after the first call: with nothing to reconcile it reads two files and writes none.
    const installQuery = useQuery({ queryKey: ["smart-session", "install"], queryFn: () => readInstall({}), refetchInterval: 5 * 60_000 });
    const guardQuery = useQuery({ queryKey: ["smart-session", "guard"], queryFn: () => readGuard({}), refetchInterval: 15_000 });

    useEffect(() => { if (budgetQuery.data) live.setBudget(budgetQuery.data); }, [budgetQuery.data]);
    const guardValues = guardSettings.status === "ready" ? guardSettings.values : undefined;
    // A change made here or on another client moves the pills without waiting out their poll.
    useEffect(() => { if (guardValues !== undefined) refreshGuardPills(); }, [guardValues]);

    const settings = settingsQuery.data?.settings;
    const forecasts = (budgetQuery.data?.windows ?? []).filter(isInteresting).map((w) => forecastWindow(w, now)).sort((a, b) => ORDER(a.id) - ORDER(b.id) || b.pct - a.pct);
    const lead = leadWindow(forecasts);
    const head = budgetQuery.data === undefined ? null : headline(lead, now);
    const session = budgetQuery.data?.windows.find((w) => w.id === "five_hour");
    const guard = guardQuery.data;
    const paused = guard === undefined ? [] : pausedSessions(guard.pauses);
    const enrolled = new Set((enrolmentQuery.data?.agents ?? []).filter((a) => a.enrolled).map((a) => a.agentId));
    const agents = (contextQuery.data?.agents ?? []).filter((a) => a.status !== "closed");
    const recorder = budgetQuery.data?.recorder;
    const summary = spendQuery.data?.summary;
    const error = budgetQuery.data?.error ?? contextQuery.data?.error ?? (budgetQuery.error ? errorText(budgetQuery.error) : null);
    const guardOn = guardSettings.status === "ready" ? guardSettings.values.enabled : null;
    const guardPct = guardOn && guard?.governor === "active" ? guard.policy.thresholdPct : null;
    const openPaused = () => client.openScreen({ screenId: GUARD_SCREENS.paused });

    async function saveSmartCompact(patch: Parameters<typeof writeSettings>[0], message: string) {
      try {
        await writeSettings(patch);
        // The pills live in this same client bundle, so they are told directly.
        await refreshPills(() => readEnrolment({}));
        toast.show(message);
        await queryClient.invalidateQueries({ queryKey: ["smart-session"] });
      } catch (problem) {
        toast.error(errorText(problem));
      }
    }

    function toggleGuard(next: boolean) {
      if (guardSettings.status !== "ready") return;
      void guardSettings.save({ ...guardSettings.values, enabled: next }, guardSettings.revision).then((saved) => {
        if (!saved) return toast.error("Session Guard could not be changed. Try again.");
        toast.show(next ? "Session Guard on" : "Session Guard off");
        void guardQuery.refetch();
      });
    }

    const install = installQuery.data?.report;
    // Only a problem earns a line: a working install is the default.
    const hooksProblem = install === undefined ? null
      : install.error !== null ? install.error
        : install.pluginDir === null || install.hooks.length === 0 ? "Hooks not registered with Claude Code, so nothing will ask a session to compact."
          : null;
    const notice = guard === undefined ? null : governorNotice(guard);
    // One line each, paired with its moment where there is one.
    const pastLine = agents.filter((agent) => enrolled.has(agent.agentId) && contextOutlook(agent).past).length;
    const compactLine: ReactNode = settings === undefined ? "…" : !settings.enabled ? "Off · nothing is asked or compacted"
      // Only the clause that is state wears the state colour.
      : pastLine > 0 ? <>{`${enrolled.size} enrolled · `}<Text style={{ color: c.statusWarning }}>{`${pastLine} past ${pastLine === 1 ? "its" : "their"} compact line, asked at the end of a turn`}</Text></>
        : `${enrolled.size} enrolled · asked past ${settings.thresholds.large.compact}% of a ${formatCompactTokens(settings.thresholds.largeWindowFrom)}+ window, ${settings.thresholds.small.compact}% of a smaller one`;
    const waitingResets = paused.filter((p) => p.phase !== "attention").map((p) => (p.anchorResetsAt ? Date.parse(p.anchorResetsAt) : NaN)).filter((t) => Number.isFinite(t) && t > now).sort((a, b) => a - b);
    const guardState: { line: string; tone: Tone } = (() => {
      if (guardOn === null) return { line: "…", tone: "default" };
      if (!guardOn) return { line: paused.length > 0 ? `Off · ${paused.length} paused still ${paused.length === 1 ? "waits" : "wait"} for the reset` : "Off · nothing pauses at the session limit", tone: "default" };
      if (notice !== null && guard?.governor !== "off") return { line: notice.title, tone: "default" };
      const auto = guard?.policy.autoResume !== false;
      if (paused.some((p) => p.phase === "attention")) return { line: `${paused.length} paused · ${paused.filter((p) => p.phase === "attention").length} need${paused.filter((p) => p.phase === "attention").length === 1 ? "s" : ""} a look`, tone: "danger" };
      if (paused.length > 0) {
        const at = waitingResets[0];
        return { line: at === undefined ? `${paused.length} paused · waiting for a fresh reading` : `${paused.length} paused · ${auto ? `resume${paused.length === 1 ? "s" : ""} at` : "continue by hand after"} ${formatMoment(new Date(at).toISOString(), now)}`, tone: "warning" };
      }
      const threshold = guard?.policy.thresholdPct ?? 100;
      const s5 = lead?.id === "five_hour" ? lead : null;
      if (s5 && s5.pct >= threshold) {
        const reset = s5.resetsAt !== null && Date.parse(s5.resetsAt) > now ? ` until the ${formatMoment(s5.resetsAt, now)} reset` : " until the next reset";
        return { line: `At the limit · a running session pauses${reset}`, tone: "warning" };
      }
      if (s5 && s5.resetsAt && s5.ratePerHour && s5.ratePerHour > 0 && s5.pct < threshold && s5.pct + s5.ratePerHour * ((Date.parse(s5.resetsAt) - now) / 3_600_000) >= threshold) {
        const at = new Date(now + ((threshold - s5.pct) / s5.ratePerHour) * 3_600_000).toISOString();
        return { line: `Pauses sessions at ~${formatMoment(at, now)} · ${auto ? "resumes" : "you continue"} after the ${formatMoment(s5.resetsAt, now)} reset`, tone: "default" };
      }
      if (s5 && s5.resetsAt && Date.parse(s5.resetsAt) > now) return { line: `Pauses at ${threshold}% · not expected before the ${formatMoment(s5.resetsAt, now)} reset`, tone: "default" };
      return { line: `Pauses at ${threshold}% of the session window · ${auto ? "resumes by itself" : "you continue"} after the reset`, tone: "default" };
    })();

    const header = <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        {head ? <View style={{ paddingTop: compact ? 3 : 5 }}><Icon name={toneIcon(head.tone, lead?.state ?? null)} size={compact ? 17 : 19} color={head.tone === "default" ? c.foregroundMuted : toneColor(c, head.tone)} /></View> : null}
        <View style={{ flex: 1, gap: 4 }}>
          {head ? <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: compact ? 19 : 22, lineHeight: compact ? 25 : 29, fontWeight: "600" }}>{head.title}</Text>
            : <Skeleton width="60%" height={22} color={c.surface2} />}
          {head ? <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 19, ...tabular }}>{head.detail}</Text> : null}
        </View>
        <IconButton theme={theme} icon="Settings" label="Smart Session settings" compact={compact} onPress={() => client.openSettings(SMART_COMPACT_SETTINGS)} />
      </View>
      {paused.length > 0 && guard?.governor === "active" ? <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, paddingLeft: compact ? 27 : 29 }}>
        <Chip theme={theme} icon="Pause" label={`${paused.length} paused`} color={paused.some((p) => p.phase === "attention") ? c.statusDanger : c.statusWarning} />
        <TextLink theme={theme} label={paused.some((p) => p.phase === "attention") ? "Check the paused sessions" : "Session Guard resumes them after the reset"} onPress={openPaused} />
      </View> : null}
    </View>;

    return <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: compact ? 16 : 32, paddingBottom: 48 }}>
      <View style={{ width: "100%", maxWidth: 860, alignSelf: "center", gap: compact ? 20 : 26 }}>
        {header}
        {error ? <Text accessibilityRole="alert" style={{ ...t.meta, color: c.statusDanger }}>{error}</Text> : null}

        <View style={{ gap: 8 }}>
          <SectionHead theme={theme} title="Plan limits" />
          {budgetQuery.data === undefined ? <LoadingCard theme={theme} />
            : forecasts.length === 0 ? <Empty theme={theme} title="No reading yet" detail="Smart Session records Claude's plan usage every minute while Paseo runs. The first reading usually arrives within a few minutes of signing in to Claude on this host." />
              : <Reveal><Card theme={theme}>
                {forecasts.map((f, i) => <WindowRow key={f.id} theme={theme} f={f} now={now} first={i === 0}>
                  {f.id === "five_hour" && session?.history && session.history.length > 0 ? <View style={{ gap: 14, paddingTop: 10 }}>
                    <WindowChart theme={theme} forecast={f} history={session.history} now={now} compact={compact} guardPct={guardPct} />
                    {budgetQuery.data?.past && budgetQuery.data.past.length > 0 ? <View style={{ gap: 2 }}>
                      <Text style={t.small}>Earlier session windows, last 14 days</Text>
                      <PastWindows theme={theme} past={budgetQuery.data.past} now={now} compact={compact} />
                    </View> : null}
                  </View> : null}
                </WindowRow>)}
                <MeterKey theme={theme} />
              </Card></Reveal>}
        </View>

        <View style={{ gap: 8 }}>
          <SectionHead theme={theme} title="Session context" count={agents.length || undefined} />
          {contextQuery.data === undefined ? <LoadingCard theme={theme} rows={2} />
            : agents.length === 0 ? <Empty theme={theme} title="No session has reported its context yet" detail="Each session reports how full its context is after its first turn." />
              : <Card theme={theme}>{agents.map((agent, i) => {
                const outlook = contextOutlook(agent);
                const on = enrolled.has(agent.agentId);
                const parts = [`${formatCompactTokens(agent.usedTokens)} of ${formatCompactTokens(agent.maxTokens)}`, `compacts at ${agent.compactAtPct}%`];
                if (agent.growthTokensPerHour !== null && agent.growthTokensPerHour > 0) parts.push(`+${formatCompactTokens(agent.growthTokensPerHour)}/h`);
                const outlookLine = outlook.past ? (on ? "Past its compact line · asked at the end of a turn" : "Past its compact line · not enrolled")
                  : outlook.untilCompactMs !== null ? `Reaches it in ~${formatDuration(outlook.untilCompactMs)}` : null;
                return <CardRow key={agent.agentId} theme={theme} first={i === 0} style={{ gap: 6 }}
                  onPress={navigation ? () => navigation.openAgent({ agentId: agent.agentId }) : undefined} accessibilityLabel={`Open ${agent.title ?? "session"}`}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <StatusGlyph theme={theme} status={agent.status} />
                    <Text numberOfLines={1} style={{ ...t.label, flexShrink: 1 }}>{agent.title ?? `Session ${agent.agentId.slice(0, 8)}`}</Text>
                    <View style={{ flex: 1 }} />
                    {on ? <Chip theme={theme} label="Smart Compact" /> : compact ? null : <Text style={t.small}>Not enrolled</Text>}
                    <Ring size={16} color={outlook.tone !== "default" ? toneFill(c, outlook.tone) : on ? c.foreground : c.foregroundMuted} fraction={outlook.pct / 100} mark={on ? agent.compactAtPct / 100 : null} />
                    <Text style={{ color: c.foreground, fontSize: 15, lineHeight: 20, fontWeight: "600", minWidth: 36, textAlign: "right", ...tabular }}>{`${Math.round(outlook.pct)}%`}</Text>
                  </View>
                  <Meter theme={theme} pct={outlook.pct} tone={outlook.tone} mark={agent.compactAtPct} height={6} label={`${agent.title ?? "Session"}: ${Math.round(outlook.pct)}% of its context, compacts at ${agent.compactAtPct}%`} />
                  <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 10, rowGap: 2 }}>
                    <Text style={t.meta}>{parts.join(" · ")}</Text>
                    {outlookLine ? <Text style={{ ...t.meta, color: outlook.past ? toneColor(c, outlook.tone) : c.foregroundMuted }}>{outlookLine}</Text> : null}
                  </View>
                </CardRow>;
              })}</Card>}
        </View>

        <Card theme={theme}>
          <FeatureRow theme={theme} first icon="FoldVertical" title="Smart Compact" line={compactLine} on={settings?.enabled ?? null} compact={compact}
            onToggle={(next) => void saveSmartCompact({ enabled: next }, next ? "Smart Compact on" : "Smart Compact off")}
            links={<TextLink theme={theme} compact={compact} label="Settings" onPress={() => client.openSettings(SMART_COMPACT_SETTINGS)} />}>
            {settings?.enabled && hooksProblem ? <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 25 }}>
              <Icon name="TriangleAlert" size={13} color={c.statusWarning} />
              <Text style={{ ...t.meta, flex: 1, color: c.statusWarning }}>{hooksProblem}</Text>
            </View> : null}
          </FeatureRow>
          <FeatureRow theme={theme} first={false} icon={guardOn ? "ShieldCheck" : "ShieldOff"} title="Session Guard" line={guardState.line} tone={guardState.tone} on={guardOn} compact={compact} disabled={guardSettings.saving} onToggle={toggleGuard}
            links={<View style={{ flexDirection: "row", gap: 14 }}>
              {paused.length > 0 || guardOn ? <TextLink theme={theme} compact={compact} label="Paused sessions" onPress={openPaused} /> : null}
              <TextLink theme={theme} compact={compact} label="Settings" onPress={() => client.openSettings("session-guard")} />
            </View>}>
            {paused.length > 0 ? <View style={{ gap: 2, paddingLeft: 25 }}>{paused.slice(0, 3).map((pause) => {
              const at = pause.anchorResetsAt ? Date.parse(pause.anchorResetsAt) : NaN;
              // The line above already names the first reset; a row repeats a time only when its own differs.
              const own = pause.phase === "attention" ? "Check" : Number.isFinite(at) && at > now && Math.abs(at - (waitingResets[0] ?? at)) >= 60_000 ? formatMoment(pause.anchorResetsAt!, now) : null;
              return <View key={pause.id} style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                <Text numberOfLines={1} style={{ ...t.meta, flex: 1, color: c.foreground }}>{pause.title?.trim() || "Untitled session"}</Text>
                {own ? <Text style={{ ...t.meta, color: pause.phase === "attention" ? c.statusDanger : c.foreground, fontWeight: "600" }}>{own}</Text> : null}
              </View>;
            })}</View> : null}
          </FeatureRow>
        </Card>

        {summary === undefined || summary.bucketCount === 0 ? null : <View style={{ gap: 8 }}>
          <SectionHead theme={theme} title="Tokens, last 30 days" />
          <Card theme={theme}>
            <View style={{ padding: 14, gap: 18 }}>
              <Text style={{ ...t.body, color: c.foregroundMuted, ...tabular }}>
                <Text style={{ color: c.foreground, fontWeight: "600" }}>{formatCompactTokens(summary.totalTokens)}</Text>{" billable tokens · "}
                <Text style={{ color: c.foreground, fontWeight: "600" }}>{`${Math.round(summary.cacheHitPct)}%`}</Text>{" of input from cache"}
                {summary.subagentTokens === 0 ? null : <>{" · "}<Text style={{ color: c.foreground, fontWeight: "600" }}>{`${Math.round((summary.subagentTokens / summary.totalTokens) * 100)}%`}</Text>{" spent by subagents"}</>}
              </Text>
              <View style={{ gap: 4 }}>
                <Text style={t.group}>Per day</Text>
                <DailyBars theme={theme} days={summary.byDay.slice(-30)} compact={compact} />
              </View>
              <View style={{ gap: 4 }}>
                <Text style={t.group}>By hour of the week</Text>
                <HourHeatmap theme={theme} cells={summary.heatmap} compact={compact} />
              </View>
              <View style={{ flexDirection: compact ? "column" : "row", gap: compact ? 18 : 32 }}>
                <View style={{ flex: compact ? undefined : 1, gap: 8 }}>
                  <Text style={t.group}>By workspace</Text>
                  <RankedTotals theme={theme} rows={summary.byProject} total={summary.totalTokens} compact={compact} />
                </View>
                <View style={{ flex: compact ? undefined : 1, gap: 8 }}>
                  <Text style={t.group}>By model</Text>
                  <RankedTotals theme={theme} rows={summary.byModel} total={summary.totalTokens} compact={compact} />
                </View>
              </View>
            </View>
          </Card>
        </View>}

        {recorder === undefined ? null : <View style={{ gap: 3 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Ring size={12} color={recorder.ageSeconds !== null && recorder.ageSeconds > 900 ? c.statusWarning : c.foregroundMuted} fraction={1} mark={null} />
            <Text style={{ ...t.small, color: recorder.ageSeconds !== null && recorder.ageSeconds > 900 ? c.statusWarning : c.foregroundMuted }}>
              {recorder.newestAt === null ? "Recorder running · nothing recorded yet"
                : `Recording since ${recorder.firstSampleAt ? formatDay(recorder.firstSampleAt) : "—"} · ${recorder.samplesHeld.toLocaleString()} readings in the last 14 days · newest ${formatRelative(recorder.newestAt, now)}${recorder.ageSeconds !== null && recorder.ageSeconds > 900 ? " — treat these numbers as a floor" : ""}`}
            </Text>
          </View>
          <Text selectable numberOfLines={1} style={{ ...t.small, paddingLeft: 18, fontFamily: Platform.OS === "ios" ? "Menlo" : Platform.OS === "android" ? "monospace" : "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{recorder.dataDir}</Text>
        </View>}
      </View>
    </ScrollView>;
  };
}

/** The sidebar row's right slot: what is paused, else the session window. */
export function sidebarTrailing(live: Live, now: number): { label: string; tone: Tone | "muted" } | null {
  const paused = live.paused();
  if (paused.attention > 0) return { label: `${paused.attention + paused.waiting} paused`, tone: "danger" };
  if (paused.waiting > 0) return { label: `${paused.waiting} paused`, tone: "warning" };
  const windows = live.budget()?.windows ?? [];
  const session = windows.find((w) => w.id === "five_hour");
  if (session === undefined) return null;
  const f = forecastWindow(session, now);
  // Usage is a time: when the window runs out first, the row says when.
  if (f.state === "short" && f.runsOutAt) return { label: `out ${formatMoment(f.runsOutAt, now)}`, tone: f.tone };
  if (f.state === "full") return { label: "at limit", tone: "danger" };
  return { label: `${Math.round(f.pct)}%`, tone: "muted" };
}

