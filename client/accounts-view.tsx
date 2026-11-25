import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Platform, Text, View } from "react-native";
import type { z } from "zod";

import { formatDay } from "../shared/format";
import { reportBasis, shortDay } from "../shared/accounts-report";
import type { AccountsReportSchema } from "../shared/smart-session";
import { ink } from "./charts";
import { Card, CardRow, Chip, SectionHead, text } from "./kit";
import { Skeleton } from "./motion";
import { tabular, withAlpha, type Theme } from "./theme";

type Report = z.infer<typeof AccountsReportSchema>;
type Metrics = Report["accounts"][number];
type Day = Metrics["strip"][number];
type Suggestion = NonNullable<Report["recommendation"]>;

/** "0 h", "6.3 h", "82 h". */
export const hoursText = (h: number) => (h < 0.05 ? "0 h" : h < 10 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h)} h`);
/** "$6", "$102": whole dollars unless under ten. */
export const dollarsText = (d: number) => (d >= 10 ? `$${Math.round(d)}` : `$${d.toFixed(2).replace(/\.00$/, "")}`);

const ICON: Record<Suggestion["kind"], string> = {
  add: "UserPlus",
  drop: "UserMinus",
  "use-better": "ArrowLeftRight",
  keep: "CircleCheck",
  verdict: "CalendarClock",
};

/** The facts under an account (or the pool): what waited, what was misplaced, what was paid. */
export function factsLine(m: { waitingHours: number; misplacedHours: number; misplacedDollars: number; extraDollars: number }, waitingMeasured: boolean): string {
  return [
    waitingMeasured ? `${hoursText(m.waitingHours)} waiting` : null,
    `${hoursText(m.misplacedHours)} misplaced${m.misplacedDollars > 0.005 ? ` (${dollarsText(m.misplacedDollars)})` : ""}`,
    m.extraDollars > 0.005 ? `${dollarsText(m.extraDollars)} Extra usage` : null,
  ].filter(Boolean).join(" · ");
}

/** The strip's vertical scale: the busiest day across every account, at least a quarter of a week. */
const stripScale = (report: Report) => Math.max(25, ...report.accounts.flatMap((a) => a.strip.map((d) => d.usedPct + d.expiredPct)));

/**
 * One account's 14 days, a column a day: what it used (ink), the share of a week that expired
 * at a reset that day (faint ink above it), and a red cap on a day it spent an hour or more at a
 * limit. A day with no reading is only the baseline.
 */
function Strip({ theme, days, scale, compact, name }: { theme: Theme; days: readonly Day[]; scale: number; compact: boolean; name: string }) {
  const c = theme.colors;
  const [hovered, setHovered] = useState<number | null>(null);
  const height = compact ? 30 : 36;
  const limited = days.filter((d) => d.limitHours >= 1).length;
  const expired = days.filter((d) => d.expiredPct >= 1).length;
  const summary = `${name}, last two weeks: ${limited} ${limited === 1 ? "day" : "days"} at a limit, ${expired === 0 ? "nothing expired" : `${expired} ${expired === 1 ? "reset" : "resets"} with room left`}.`;
  const readout = hovered === null ? null : days[hovered]!;
  const web = Platform.OS === "web";
  return <View accessible accessibilityRole="image" accessibilityLabel={summary} style={{ gap: 3 }}>
    <View style={{ height, flexDirection: "row", alignItems: "flex-end", gap: compact ? 2 : 3 }}>
      {days.map((d, i) => {
        const known = d.knownHours >= 1;
        const used = known ? Math.max(d.usedPct > 0.2 ? 2 : 0, (d.usedPct / scale) * height) : 0;
        const lost = known && d.expiredPct >= 1 ? Math.max(2, (d.expiredPct / scale) * height) : 0;
        const today = i === days.length - 1;
        const props = web ? { onPointerEnter: () => setHovered(i), onPointerLeave: () => setHovered((h) => (h === i ? null : h)) } : {};
        return <View key={d.day} {...props} style={{ flex: 1, height, justifyContent: "flex-end", opacity: hovered === null || hovered === i ? 1 : 0.6 }}>
          {d.limitHours >= 1 ? <View style={{ height: 3, borderRadius: 1, marginBottom: 1, backgroundColor: withAlpha(c.statusDanger, 0.75) }} /> : null}
          {lost > 0 ? <View style={{ height: Math.min(lost, height - used - 4), backgroundColor: ink(c, 0.13), borderTopLeftRadius: 2, borderTopRightRadius: 2 }} /> : null}
          {used > 0 ? <View style={{ height: Math.min(used, height - 4), backgroundColor: ink(c, today ? 0.82 : 0.42), borderTopLeftRadius: lost > 0 ? 0 : 2, borderTopRightRadius: lost > 0 ? 0 : 2 }} /> : null}
          <View style={{ height: 1, backgroundColor: known ? c.border : withAlpha(c.border, 0.5) }} />
        </View>;
      })}
    </View>
    <View style={{ flexDirection: "row", justifyContent: "space-between", minHeight: 14 }}>
      {readout ? <Text style={{ color: c.foreground, fontSize: 10, lineHeight: 14, ...tabular }}>{dayReadout(readout)}</Text>
        : <>
          <Text style={{ color: c.foregroundMuted, fontSize: 10, lineHeight: 14, ...tabular }}>{days[0] ? stripDay(days[0].day) : ""}</Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 10, lineHeight: 14 }}>today</Text>
        </>}
    </View>
  </View>;
}

/** A strip day is a UTC day (the server can't know the viewer's zone), so it is named in UTC too. */
const stripDay = (iso: string) => shortDay(Date.parse(iso));

function dayReadout(d: Day): string {
  if (d.knownHours < 1) return `${stripDay(d.day)} · no reading`;
  return [
    stripDay(d.day),
    `${Math.round(d.usedPct)}% of a week used`,
    d.limitHours >= 1 ? `${hoursText(d.limitHours)} at a limit` : null,
    d.expiredPct >= 1 ? `${Math.round(d.expiredPct)}% expired at the reset` : null,
  ].filter(Boolean).join(" · ");
}

function AccountUseRow({ theme, m, report, scale, compact }: { theme: Theme; m: Metrics; report: Report; scale: number; compact: boolean }) {
  const c = theme.colors;
  const t = text(c);
  const figure = m.usedPct === null ? null : `${Math.round(m.usedPct)}%`;
  const verdict = m.verdictAt === null ? null : `verdict on ${formatDay(m.verdictAt)}`;
  const lead = figure === null ? `No reset yet${m.openPct !== null ? ` · ${Math.round(m.openPct)}% so far` : ""}` : `of each week used${m.openPct !== null ? ` · ${Math.round(m.openPct)}% now` : ""}`;
  return <CardRow theme={theme} first={false} style={{ gap: 8, opacity: m.disabled ? 0.62 : 1 }}>
    <View style={{ flexDirection: compact ? "column" : "row", gap: compact ? 8 : 18, alignItems: compact ? "stretch" : "center" }}>
      <View style={{ width: compact ? undefined : 320, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name={m.main ? "Terminal" : "UserRound"} size={14} color={c.foregroundMuted} />
          <Text numberOfLines={1} style={{ ...t.label, flexShrink: 1 }}>{m.name}</Text>
          {m.main && m.name !== "Main" ? <Chip theme={theme} label="Main" /> : null}
          {m.disabled ? <Chip theme={theme} label="Set aside" /> : null}
          {m.size !== 1 ? <Chip theme={theme} label={`×${m.size}`} accessibilityLabel={`Plan size ${m.size}`} /> : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, paddingLeft: 22 }}>
          {figure ? <Text style={{ color: c.foreground, fontSize: 17, lineHeight: 22, fontWeight: "600", ...tabular }}>{figure}</Text> : null}
          <Text numberOfLines={1} style={{ ...t.meta, flexShrink: 1 }}>{lead}</Text>
        </View>
        <Text style={{ ...t.meta, paddingLeft: 22 }}>{factsLine(m, report.waitingSince !== null)}{verdict ? <Text style={{ color: c.foreground }}>{` · ${verdict}`}</Text> : null}</Text>
      </View>
      <View style={{ flex: compact ? undefined : 1, paddingLeft: compact ? 22 : 0 }}>
        <Strip theme={theme} days={m.strip} scale={scale} compact={compact} name={m.name} />
      </View>
    </View>
  </CardRow>;
}

/** The answer first: one suggestion, with the numbers it stands on. */
function Recommendation({ theme, report, compact, first }: { theme: Theme; report: Report; compact: boolean; first: boolean }) {
  const c = theme.colors;
  const t = text(c);
  const s = report.recommendation;
  if (s === null) return null;
  const basis = reportBasis(report, formatDay);
  return <CardRow theme={theme} first={first} style={{ gap: 6, paddingVertical: compact ? 14 : 16 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name={ICON[s.kind]} size={16} color={c.foreground} />
      <Text accessibilityRole="header" style={t.title}>{s.title}</Text>
    </View>
    <Text style={{ ...t.body, paddingLeft: 24 }}>{s.reason}</Text>
    <Text style={{ ...t.small, paddingLeft: 24 }}>{basis}</Text>
  </CardRow>;
}

/** All accounts together, under the rows. */
function PooledRow({ theme, report }: { theme: Theme; report: Report }) {
  const c = theme.colors;
  const t = text(c);
  const p = report.pooled;
  return <CardRow theme={theme} first={false} style={{ gap: 2, backgroundColor: withAlpha(c.surface1, 0.6) }}>
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
      <Text style={t.label}>All accounts</Text>
      {p.usedPct !== null ? <Text style={{ ...t.label, ...tabular }}>{`${Math.round(p.usedPct)}%`}</Text> : null}
      <Text style={t.meta}>{p.usedPct !== null ? "of each week used" : "no reset yet"}</Text>
    </View>
    <Text style={t.meta}>
      {[factsLine(p, report.waitingSince !== null), `${hoursText(p.allOutHours)} all out`, p.idlePoints >= 1 ? `${Math.round(p.idlePoints)}% of a week idle` : null].filter(Boolean).join(" · ")}
    </Text>
  </CardRow>;
}

function StripKey({ theme }: { theme: Theme }) {
  const c = theme.colors;
  const t = text(c);
  const swatch = (color: string, h = 6) => <View style={{ width: 10, height: h, borderRadius: 1, backgroundColor: color }} />;
  return <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 14, rowGap: 4, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>{swatch(ink(c, 0.42))}<Text style={t.small}>Used that day</Text></View>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>{swatch(withAlpha(c.statusDanger, 0.75), 3)}<Text style={t.small}>An hour or more at a limit</Text></View>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>{swatch(ink(c, 0.13))}<Text style={t.small}>Expired unused at a reset</Text></View>
  </View>;
}

/**
 * How well the accounts are used, over the last 14 days: one recommendation with its reason,
 * a row per account (used, waiting, misplaced, Extra usage and a 14-day strip), and all of them
 * together. The same numbers an agent gets from `smart_accounts_report`.
 */
export function AccountsUseSection({ theme, compact, reports, error }: { theme: Theme; compact: boolean; reports: readonly Report[] | undefined; error: string | null }) {
  const c = theme.colors;
  const t = text(c);
  const loading = reports === undefined && error === null;
  const shown = (reports ?? []).filter((r) => r.accounts.length > 0);
  if (!loading && error === null && shown.length === 0) return null;
  return <View style={{ gap: 8 }}>
    <SectionHead theme={theme} title="How your accounts were used" trailing={<Text style={t.small}>Last 14 days</Text>} />
    {error !== null && shown.length === 0 ? <Card theme={theme}><CardRow theme={theme} first><Text style={{ ...t.meta, color: c.statusDanger }}>{`Couldn't build the report: ${error}`}</Text></CardRow></Card> : null}
    {loading ? <Card theme={theme}>{[0, 1, 2].map((i) => <CardRow key={i} theme={theme} first={i === 0} style={{ gap: 8 }}>
      <Skeleton width="42%" height={11} color={c.surface2} />
      <Skeleton width="100%" height={20} color={c.surface2} />
    </CardRow>)}</Card> : null}
    {shown.map((report) => {
      const scale = stripScale(report);
      const rows = [...report.accounts].sort((a, b) => Number(b.main) - Number(a.main));
      return <Card key={report.family} theme={theme}>
        {shown.length > 1 ? <CardRow theme={theme} first><Text style={t.title}>{report.family === "claude" ? "Claude" : "Codex"}</Text></CardRow> : null}
        <Recommendation theme={theme} report={report} compact={compact} first={shown.length === 1} />
        {rows.map((m) => <AccountUseRow key={m.id} theme={theme} m={m} report={report} scale={scale} compact={compact} />)}
        {rows.length > 1 ? <PooledRow theme={theme} report={report} /> : null}
        <StripKey theme={theme} />
      </Card>;
    })}
  </View>;
}
