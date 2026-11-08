import { useState, type ReactNode } from "react";
import { Platform, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";

import { formatClock, formatCompactTokens, formatDay, rampStep } from "../shared/format";
import { contextRing, formatMoment, type Tone, type WindowForecast } from "../shared/forecast";
import { isLight, tabular, withAlpha, type Colors, type Theme } from "./theme";

/**
 * Every chart and meter on the overview, drawn with Views (plugins get no SVG
 * library; the host `Icon` draws square inline SVG only, used for the ring).
 *
 * One rule for colour, from the dataviz method: magnitude is neutral ink, one hue at
 * stepped opacity, so a chart reads the same in light and dark. Amber and red are
 * status and appear only where a forecast says a limit will bite or did.
 */

const HOUR = 3_600_000;

/** Ink: the foreground at a given strength, a touch stronger on light grounds. */
export function ink(colors: Colors, strength: number): string {
  return withAlpha(colors.foreground, Math.min(1, strength * (isLight(colors) ? 1.1 : 1)));
}

/** The fill for a value in a given state. */
export function toneFill(colors: Colors, tone: Tone): string {
  return tone === "danger" ? colors.statusDanger : tone === "warning" ? colors.statusWarning : ink(colors, 0.82);
}

const hoverable = Platform.OS === "web";

/** Pointer handlers for a hover readout; inert on touch platforms. */
function hover(set: (value: number | null) => void, index: number) {
  return hoverable ? { onPointerEnter: () => set(index), onPointerLeave: () => set(null) } : {};
}

/**
 * A meter: the used share, an optional faint projection of where it lands at the
 * reset, an optional muted pace tick (where an even spend would be) and optional
 * marks (the two compact lines on a context bar).
 */
export function Meter({ theme, pct, tone = "default", projected, pace, mark, upper, height = 8, label }: {
  theme: Theme; pct: number; tone?: Tone; projected?: number | null; pace?: number | null; mark?: number | null; upper?: number | null; height?: number; label: string;
}) {
  const c = theme.colors;
  const used = Math.max(0, Math.min(100, pct));
  const fill = toneFill(c, tone);
  const ahead = projected === null || projected === undefined ? 0 : Math.max(0, Math.min(100, projected) - used);
  const tick = (at: number, color: string, key: string) => (
    <View key={key} style={{ position: "absolute", left: `${Math.max(0, Math.min(100, at))}%`, top: -3, bottom: -3, width: 2, marginLeft: -1, borderRadius: 1, backgroundColor: color }} />
  );
  return <View accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={{ min: 0, max: 100, now: Math.round(used) }}
    style={{ height, justifyContent: "center", marginVertical: 3 }}>
    <View style={{ height, borderRadius: height / 2, backgroundColor: ink(c, 0.1), overflow: "hidden", flexDirection: "row" }}>
      <View style={{ width: `${used}%`, backgroundColor: fill, borderTopRightRadius: height / 2, borderBottomRightRadius: height / 2 }} />
      {ahead > 0 ? <View style={{ width: `${ahead}%`, backgroundColor: withAlpha(tone === "default" ? c.foreground : fill, tone === "default" ? 0.16 : 0.24), marginLeft: -height / 2, paddingLeft: height / 2 }} /> : null}
    </View>
    {pace !== null && pace !== undefined ? tick(pace, c.foregroundMuted, "pace") : null}
    {mark !== null && mark !== undefined ? tick(mark, c.foreground, "mark") : null}
    {upper !== null && upper !== undefined && upper !== mark ? tick(upper, c.foreground, "upper") : null}
  </View>;
}

/** The context ring glyph, the same object as the composer pill's icon. */
export function Ring({ size, color, fraction, mark, upper = null }: { size: number; color: string; fraction: number; mark: number | null; upper?: number | null }) {
  // A stronger track at pill size, so the ring reads as a gauge and not as the host's spinner.
  return <Icon icon={{ svg: contextRing(fraction, mark, size <= 18 ? 0.5 : 0.28, mark === null ? null : upper) }} size={size} color={color} />;
}

/** The percentage held at `t`: readings only climb within a window, so the last one before it stands. */
function heldAt(history: readonly { t: string; pct: number }[], t: number): number | null {
  let value: number | null = null;
  for (const point of history) {
    if (Date.parse(point.t) > t) break;
    value = point.pct;
  }
  return value;
}

/** A small axis caption. */
function Axis({ theme, children, align = "left" }: { theme: Theme; children: ReactNode; align?: "left" | "right" | "center" }) {
  return <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 10, lineHeight: 14, textAlign: align, ...tabular }}>{children}</Text>;
}

/**
 * The open session window, start to reset: what was recorded (ink), where the
 * current pace takes it (faint), and the stretch with nothing left (amber) when it
 * runs out first. A hairline at 100%, Session Guard's threshold when it sits lower,
 * and a "now" rule.
 */
export function WindowChart({ theme, forecast, history, now, compact, guardPct, hour12 }: {
  theme: Theme; forecast: WindowForecast; history: readonly { t: string; pct: number }[]; now: number; compact: boolean; guardPct?: number | null; hour12?: boolean;
}) {
  const c = theme.colors;
  const [hovered, setHovered] = useState<number | null>(null);
  if (forecast.startAt === null || forecast.resetsAt === null) return null;
  const start = Date.parse(forecast.startAt);
  const end = Date.parse(forecast.resetsAt);
  const columns = compact ? 40 : 60;
  const slot = (end - start) / columns;
  const height = compact ? 60 : 76;
  const runsOut = forecast.runsOutAt === null ? null : Date.parse(forecast.runsOutAt);
  const bars = Array.from({ length: columns }, (unused, i) => {
    const from = start + i * slot;
    const t = from + slot;
    if (from <= now) {
      const value = heldAt(history, Math.min(t, now)) ?? 0;
      const current = t >= now;
      return { t: Math.min(t, now), value, kind: current ? ("now" as const) : ("past" as const) };
    }
    const rate = forecast.ratePerHour ?? 0;
    const value = Math.min(100, forecast.pct + (rate * (from + slot / 2 - now)) / HOUR);
    const out = runsOut !== null && from + slot / 2 >= runsOut;
    return { t: from + slot / 2, value: out ? 100 : value, kind: out ? ("out" as const) : ("ahead" as const) };
  });
  const elapsed = Math.max(0, Math.min(1, (now - start) / (end - start)));
  const colorOf = (kind: (typeof bars)[number]["kind"]) =>
    kind === "now" ? toneFill(c, forecast.tone === "danger" ? "danger" : "default")
      : kind === "past" ? ink(c, 0.42)
        : kind === "out" ? withAlpha(c.statusWarning, 0.42)
          : ink(c, 0.13);
  const readout = hovered === null ? null : bars[hovered]!;
  const caption = readout === null
    ? null
    : `${formatClock(new Date(readout.t).toISOString(), hour12)} · ${readout.kind === "past" || readout.kind === "now" ? `${Math.round(readout.value)}%` : readout.kind === "out" ? "nothing left" : `~${Math.round(readout.value)}% at this pace`}`;
  const showGuard = guardPct !== null && guardPct !== undefined && guardPct < 100;
  const summary = `Session window from ${formatClock(forecast.startAt, hour12)} to ${formatClock(forecast.resetsAt, hour12)}: ${Math.round(forecast.pct)}% used now${forecast.runsOutAt ? `, runs out around ${formatClock(forecast.runsOutAt, hour12)} at this pace` : ""}.`;
  return <View accessible accessibilityLabel={summary} style={{ gap: 4 }}>
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 14 }}>
      <View style={{ flex: 1 }}>{caption ? <Text style={{ color: c.foreground, fontSize: 11, lineHeight: 14, ...tabular }}>{caption}</Text> : <Axis theme={theme}>This window</Axis>}</View>
      <Axis theme={theme} align="right">100%</Axis>
    </View>
    <View style={{ height, position: "relative" }}>
      <View style={{ position: "absolute", left: 0, right: 0, top: 0, height: 1, backgroundColor: c.border }} />
      <View style={{ position: "absolute", left: 0, right: 0, top: height / 2, height: 1, backgroundColor: withAlpha(c.border, 0.6) }} />
      {showGuard ? <View style={{ position: "absolute", left: 0, right: 0, top: height * (1 - guardPct! / 100), height: 0, borderTopWidth: 1, borderStyle: "dashed", borderColor: c.foregroundMuted }} /> : null}
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, top: 0, flexDirection: "row", alignItems: "flex-end", gap: compact ? 1 : 2 }}>
        {bars.map((bar, i) => (
          <View key={i} {...hover(setHovered, i)} style={{ flex: 1, height: "100%", justifyContent: "flex-end" }}>
            <View style={{ height: Math.max(bar.value > 0 ? 2 : 1, (bar.value / 100) * height), backgroundColor: bar.value > 0 ? colorOf(bar.kind) : withAlpha(c.border, 0.8), borderTopLeftRadius: 2, borderTopRightRadius: 2, opacity: hovered === null || hovered === i ? 1 : 0.7 }} />
          </View>
        ))}
      </View>
      <View style={{ position: "absolute", top: -2, bottom: 0, left: `${elapsed * 100}%`, width: 1, backgroundColor: c.foreground }} />
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 1, backgroundColor: c.border }} />
    </View>
    <View style={{ height: 14, position: "relative" }}>
      <View style={{ position: "absolute", left: 0 }}><Axis theme={theme}>{formatClock(forecast.startAt, hour12)}</Axis></View>
      {elapsed > 0.14 && elapsed < 0.86 ? <View style={{ position: "absolute", left: `${elapsed * 100}%`, width: 60, marginLeft: -30 }}><Axis theme={theme} align="center">now</Axis></View> : null}
      <View style={{ position: "absolute", right: 0 }}><Axis theme={theme} align="right">{`resets ${formatClock(forecast.resetsAt, hour12)}`}</Axis></View>
    </View>
  </View>;
}

/**
 * Finished session windows over the last 14 days, placed on a calendar: each is
 * a column at its start time, as tall as it got. Red where it hit the limit,
 * amber past 90%.
 */
export function PastWindows({ theme, past, now, compact, hour12 }: {
  theme: Theme; past: readonly { startAt: string | null; firstSeenAt: string; peakPct: number }[]; now: number; compact: boolean; hour12?: boolean;
}) {
  const c = theme.colors;
  const [hovered, setHovered] = useState<number | null>(null);
  const span = 14 * 24 * HOUR;
  const from = now - span;
  const items = past
    .map((w) => ({ at: Date.parse(w.startAt ?? w.firstSeenAt), peak: w.peakPct }))
    .filter((w) => Number.isFinite(w.at) && w.at >= from);
  if (items.length === 0) return null;
  const height = compact ? 36 : 44;
  const width = compact ? 4 : 6;
  const hits = items.filter((w) => w.peak >= 99.5).length;
  // Red only for a window that reached the limit, matching the caption; the rest is ink.
  const color = (peak: number) => (peak >= 99.5 ? c.statusDanger : ink(c, 0.42));
  const readout = hovered === null ? null : items[hovered]!;
  const caption = readout === null
    ? `${items.length} windows · ${hits === 0 ? "none reached the limit" : `${hits} reached the limit`}`
    : `${formatMoment(new Date(readout.at).toISOString(), now, hour12)}${new Date(readout.at).toDateString() === new Date(now).toDateString() ? "" : `, ${formatDay(new Date(readout.at).toISOString())}`} · peaked at ${Math.round(readout.peak)}%`;
  const days = Array.from({ length: 15 }, (unused, i) => {
    const day = new Date(from + i * 24 * HOUR); day.setHours(0, 0, 0, 0);
    return day.getTime();
  }).filter((t) => t > from);
  return <View accessible accessibilityLabel={`Session windows in the last 14 days: ${items.length}, ${hits} reached the limit.`} style={{ gap: 4 }}>
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 14, gap: 8 }}>
      <Text style={{ flex: 1, color: readout ? c.foreground : c.foregroundMuted, fontSize: 11, lineHeight: 14, ...tabular }}>{caption}</Text>
      <Axis theme={theme} align="right">100%</Axis>
    </View>
    <View style={{ height, position: "relative" }}>
      <View style={{ position: "absolute", left: 0, right: 0, top: 0, height: 1, backgroundColor: c.border }} />
      {days.map((t) => <View key={t} style={{ position: "absolute", top: 0, bottom: 0, left: `${((t - from) / span) * 100}%`, width: 1, backgroundColor: withAlpha(c.border, 0.5) }} />)}
      {items.map((w, i) => (
        <View key={i} {...hover(setHovered, i)} style={{ position: "absolute", bottom: 0, left: `${((w.at - from) / span) * 100}%`, width: width + 6, marginLeft: -3, height, justifyContent: "flex-end", alignItems: "center" }}>
          <View style={{ width, height: Math.max(2, (w.peak / 100) * height), backgroundColor: color(w.peak), borderTopLeftRadius: 2, borderTopRightRadius: 2, opacity: hovered === null || hovered === i ? 1 : 0.6 }} />
        </View>
      ))}
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 1, backgroundColor: c.border }} />
    </View>
    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
      <Axis theme={theme}>{formatDay(new Date(from).toISOString())}</Axis>
      <Axis theme={theme} align="right">today</Axis>
    </View>
  </View>;
}

/** Tokens per day: one ink series, the peak day labelled, everything else on hover. */
export function DailyBars({ theme, days, compact }: { theme: Theme; days: readonly { day: string; tokens: number }[]; compact: boolean }) {
  const c = theme.colors;
  const [hovered, setHovered] = useState<number | null>(null);
  if (days.length === 0) return null;
  const max = days.reduce((peak, point) => Math.max(peak, point.tokens), 0);
  const height = compact ? 56 : 72;
  const peakIndex = days.findIndex((point) => point.tokens === max);
  const readout = hovered === null ? null : days[hovered]!;
  const dayOf = (day: string) => formatDay(`${day}T12:00:00`);
  return <View accessible accessibilityLabel={`Tokens per day over ${days.length} days; the busiest was ${dayOf(days[peakIndex]!.day)} with ${formatCompactTokens(max)}.`} style={{ gap: 4 }}>
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 14 }}>
      <Text style={{ flex: 1, color: readout ? c.foreground : c.foregroundMuted, fontSize: 11, lineHeight: 14, ...tabular }}>
        {readout ? `${dayOf(readout.day)} · ${formatCompactTokens(readout.tokens)} tokens` : `Busiest: ${dayOf(days[peakIndex]!.day)} · ${formatCompactTokens(max)}`}
      </Text>
      <Axis theme={theme} align="right">{formatCompactTokens(max)}</Axis>
    </View>
    <View style={{ height, position: "relative" }}>
      <View style={{ position: "absolute", left: 0, right: 0, top: 0, height: 1, backgroundColor: withAlpha(c.border, 0.6) }} />
      <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, flexDirection: "row", alignItems: "flex-end", gap: 2 }}>
        {days.map((point, i) => (
          <View key={point.day} {...hover(setHovered, i)} style={{ flex: 1, height: "100%", justifyContent: "flex-end", alignItems: "center" }}>
            <View style={{ width: "100%", maxWidth: 24, height: max === 0 ? 1 : Math.max(point.tokens > 0 ? 2 : 1, (point.tokens / max) * height), backgroundColor: point.tokens === 0 ? withAlpha(c.border, 0.8) : ink(c, i === peakIndex || i === hovered ? 0.82 : 0.42), borderTopLeftRadius: 3, borderTopRightRadius: 3 }} />
          </View>
        ))}
      </View>
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 1, backgroundColor: c.border }} />
    </View>
    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
      <Axis theme={theme}>{dayOf(days[0]!.day)}</Axis>
      <Axis theme={theme} align="right">today</Axis>
    </View>
  </View>;
}

/** A sequential ramp in ink: one hue, stepped opacity. Empty hours are the surface. */
const STEPS = [0.12, 0.26, 0.44, 0.64, 0.88] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hourLabel(hour: number, hour12?: boolean): string {
  const d = new Date(2020, 0, 1, hour, 0, 0);
  return hour12 === false ? `${String(hour).padStart(2, "0")}` : formatClock(d.toISOString(), hour12).replace(":00", "");
}

/** Tokens by weekday and hour of day, in local time, with a less–more key. */
export function HourHeatmap({ theme, cells, compact, hour12 }: { theme: Theme; cells: readonly { weekday: number; hour: number; tokens: number }[]; compact: boolean; hour12?: boolean }) {
  const c = theme.colors;
  const [hovered, setHovered] = useState<number | null>(null);
  const grid = new Map<string, number>();
  let max = 0;
  for (const cell of cells) {
    grid.set(`${cell.weekday}|${cell.hour}`, cell.tokens);
    if (cell.tokens > max) max = cell.tokens;
  }
  const gap = 2;
  const cellFill = (tokens: number) => {
    const step = rampStep(tokens, max, STEPS.length);
    return step === -1 ? withAlpha(c.border, 0.55) : ink(c, STEPS[step]!);
  };
  const readout = hovered === null ? null : { weekday: Math.floor(hovered / 24), hour: hovered % 24 };
  return <View style={{ gap: 6 }}>
    <Text style={{ color: readout ? c.foreground : c.foregroundMuted, fontSize: 11, lineHeight: 14, ...tabular }}>
      {readout ? `${WEEKDAYS[readout.weekday]} ${hourLabel(readout.hour, hour12)} · ${formatCompactTokens(grid.get(`${readout.weekday}|${readout.hour}`) ?? 0)} tokens` : "Local time, last 30 days"}
    </Text>
    <View style={{ gap }}>
      {WEEKDAYS.map((label, weekday) => (
        <View key={label} style={{ flexDirection: "row", alignItems: "center", gap }}>
          <Text style={{ color: c.foregroundMuted, fontSize: 10, width: 28 }}>{label}</Text>
          {Array.from({ length: 24 }, (unused, hour) => (
            <View key={hour} {...hover(setHovered, weekday * 24 + hour)} style={{ flex: 1, maxWidth: compact ? 12 : 18, aspectRatio: 1, borderRadius: 2, backgroundColor: cellFill(grid.get(`${weekday}|${hour}`) ?? 0), borderWidth: hovered === weekday * 24 + hour ? 1 : 0, borderColor: c.foreground }} />
          ))}
        </View>
      ))}
    </View>
    <View style={{ flexDirection: "row", marginLeft: 28 + gap, marginTop: 2, maxWidth: 24 * ((compact ? 12 : 18) + gap) }}>
      {[0, 6, 12, 18].map((hour) => (
        <View key={hour} style={{ flex: 1 }}><Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 10, lineHeight: 13, ...tabular }}>{hourLabel(hour, hour12)}</Text></View>
      ))}
    </View>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 10 }}>
      <Axis theme={theme}>Less</Axis>
      {STEPS.map((step) => <View key={step} style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: ink(c, step) }} />)}
      <Axis theme={theme}>{`More · busiest hour ${formatCompactTokens(max)}`}</Axis>
    </View>
  </View>;
}

/** A ranked list with a thin share bar: a bar chart of eight rows would say the same with more ink. */
export function RankedTotals({ theme, rows, total, compact }: { theme: Theme; rows: readonly { name: string; tokens: number }[]; total: number; compact: boolean }) {
  const c = theme.colors;
  const top = rows.reduce((peak, row) => Math.max(peak, row.tokens), 0);
  return <View style={{ gap: 9 }}>
    {rows.slice(0, compact ? 5 : 6).map((row) => (
      <View key={row.name} style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: 12, lineHeight: 16 }}>{row.name}</Text>
          <Text style={{ color: c.foreground, fontSize: 12, lineHeight: 16, ...tabular }}>{formatCompactTokens(row.tokens)}</Text>
          <Text style={{ width: 34, textAlign: "right", color: c.foregroundMuted, fontSize: 11, lineHeight: 16, ...tabular }}>{total === 0 ? "" : `${Math.round((row.tokens / total) * 100)}%`}</Text>
        </View>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: ink(c, 0.08), overflow: "hidden" }}>
          <View style={{ width: `${top === 0 ? 0 : (row.tokens / top) * 100}%`, height: 4, borderRadius: 2, backgroundColor: ink(c, 0.5) }} />
        </View>
      </View>
    ))}
  </View>;
}
