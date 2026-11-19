import { Icon } from "@getpaseo/plugin/client/ui";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

import { formatDay, formatDuration, isInteresting } from "../shared/format";
import { budgetLine, forecastWindow, formatMoment, paceLine, resetLine } from "../shared/forecast";
import {
  accountOutlook, accountSections, extraUsageLine, extraUsagePct, familyName, limitedWindow, poolHeadline, sessionWindow, showsMainChip, subscriptionState,
  type LaneKind, type PoolForecast, type Subscription, type SubscriptionWindow,
} from "../shared/subscriptions";
import { Meter, PastWindows, WindowChart, ink } from "./charts";
import { Card, CardRow, Chip, SectionHead, text } from "./kit";
import { tabular, toneColor, withAlpha, type Theme } from "./theme";

const HOUR = 3_600_000;

/** How a lane run is drawn: magnitude is ink, the limit is red, out is a hairline. */
function laneFill(theme: Theme, kind: LaneKind): string {
  const c = theme.colors;
  if (kind === "active") return ink(c, 0.82);
  if (kind === "room") return ink(c, 0.16);
  if (kind === "limit") return withAlpha(c.statusDanger, 0.6);
  return "transparent";
}

const LANE_WORDS: Record<LaneKind, string> = { active: "In use", room: "Room", limit: "At the limit", out: "Set aside or signed out" };

/**
 * The runway: one lane per account across the next hours, as the pooled forecast
 * runs the work through them: in use, waiting with room, at the limit. Reading down
 * a column says who carries the work then; reading along a lane says when an
 * account fills and when it is back.
 */
function Runway({ theme, pool, accounts, now, compact }: { theme: Theme; pool: PoolForecast; accounts: readonly Subscription[]; now: number; compact: boolean }) {
  const c = theme.colors;
  const t = text(c);
  const span = (compact ? 8 : 12) * HOUR;
  const end = now + span;
  const at = (ms: number) => `${((ms - now) / span) * 100}%`;
  const width = (from: number, to: number) => `${((Math.min(to, end) - Math.max(from, now)) / span) * 100}%`;
  // Hour ticks on the clock, labelled every few hours.
  const first = Math.ceil(now / HOUR) * HOUR;
  const ticks: number[] = [];
  for (let h = first; h < end; h += HOUR) ticks.push(h);
  const every = 2;
  const kinds = new Set<LaneKind>();
  for (const account of accounts) for (const run of pool.lanes[account.id] ?? []) if (run.from < end) kinds.add(run.kind);
  const nameWidth = compact ? 64 : 112;
  const summary = poolHeadline(pool, accounts, now);
  const dry = pool.runsOutAt !== null && pool.runsOutAt > now && pool.runsOutAt < end ? pool.runsOutAt : null;
  const near = (ms: number, width: number) => dry !== null && Math.abs(ms - dry) / span < width;

  return <View accessible accessibilityRole="image" accessibilityLabel={`${summary.title}. ${summary.detail}`} style={{ gap: 6 }}>
    {accounts.map((account) => <View key={account.id} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Text numberOfLines={1} style={{ ...t.small, width: nameWidth, color: c.foreground, fontWeight: account.kind === "main" ? "600" : "400" }}>{account.name}</Text>
      <View style={{ flex: 1, height: 10, borderRadius: 3, overflow: "hidden", backgroundColor: ink(c, 0.04) }}>
        {(pool.lanes[account.id] ?? []).filter((run) => run.from < end).map((run, i) => <View key={i} style={{
          position: "absolute", left: at(Math.max(run.from, now)) as `${number}%`, width: width(run.from, run.to) as `${number}%`,
          ...(run.kind === "out" ? { top: 4.5, bottom: 4.5, backgroundColor: c.border } : { top: 0, bottom: 0, backgroundColor: laneFill(theme, run.kind) }),
        }} />)}
        {/* The moment the pool runs dry, across every lane. */}
        {dry !== null ? <View style={{ position: "absolute", top: 0, bottom: 0, left: at(dry) as `${number}%`, width: 1, backgroundColor: c.foreground }} /> : null}
      </View>
    </View>)}
    {/* The clock under the lanes, aligned with them. */}
    <View style={{ flexDirection: "row", gap: 10 }}>
      <View style={{ width: nameWidth }} />
      <View style={{ flex: 1, height: 14 }}>
        <Text style={{ ...t.small, fontSize: 10, lineHeight: 14, position: "absolute", left: 0 }}>Now</Text>
        {ticks.map((h, i) => (Math.round(h / HOUR) % every === 0 && (h - now) / span > (compact ? 0.1 : 0.08) && (end - h) / span > (compact ? 0.22 : 0.09) && !near(h, compact ? 0.18 : 0.1))
          ? <Text key={i} style={{ ...t.small, fontSize: 10, lineHeight: 14, position: "absolute", left: at(h) as `${number}%`, transform: [{ translateX: -30 }], width: 60, textAlign: "center" }}>{hourLabel(h, now)}</Text>
          : null)}
        {dry !== null ? <Text style={{ ...t.small, fontSize: 10, lineHeight: 14, fontWeight: "600", color: c.foreground, position: "absolute", left: at(dry) as `${number}%`, transform: [{ translateX: -40 }], width: 80, textAlign: "center" }}>{`out ${formatMoment(new Date(dry).toISOString(), now)}`}</Text> : null}
        <Text style={{ ...t.small, fontSize: 10, lineHeight: 14, position: "absolute", right: 0 }}>{near(end, compact ? 0.2 : 0.12) ? "" : formatMoment(new Date(end).toISOString(), now)}</Text>
      </View>
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 4, paddingLeft: nameWidth + 10 }}>
      {(["active", "room", "limit", "out"] as LaneKind[]).filter((k) => kinds.has(k)).map((k) => <View key={k} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View style={{ width: 14, height: k === "out" ? 1 : 6, borderRadius: 2, backgroundColor: k === "out" ? c.border : laneFill(theme, k) }} />
        <Text style={t.small}>{LANE_WORDS[k]}</Text>
      </View>)}
    </View>
  </View>;
}

/** "8 AM" or "20:00": an hour mark on the runway's clock, in the device's convention. */
function hourLabel(ms: number, now: number): string {
  const clock = formatMoment(new Date(ms).toISOString(), now);
  return clock.replace(/:00(?=\s|$)/, "");
}

/** A window's short name on an account row: "5h", "Week", "Opus week". */
function shortLabel(id: string): string {
  if (id === "five_hour") return "5h";
  if (id === "seven_day") return "Week";
  const scoped = /^weekly_(?:model|surface):(.+)$/.exec(id);
  if (scoped !== null) return `${scoped[1]!.charAt(0).toUpperCase()}${scoped[1]!.slice(1)} week`;
  return id;
}
const ORDER = (id: string) => (id === "five_hour" ? 0 : id === "seven_day" ? 1 : 2);

/** One window of one account: "5h 42%", a thin meter with its even-pace tick, and its reset. */
function MiniWindow({ theme, label, w, now, stale, full = false, compact }: { theme: Theme; label: string; w: SubscriptionWindow; now: number; stale: boolean; full?: boolean; compact: boolean }) {
  const c = theme.colors;
  const t = text(c);
  const reset = w.resetsAt === null ? null : Date.parse(w.resetsAt);
  const rolled = reset !== null && reset <= now;
  // A limit the CLI reported is the freshest word on its window: full until it resets.
  const f = forecastWindow({ ...w, pct: rolled ? 0 : full ? Math.max(100, w.pct) : w.pct, burnPctPerHour: stale ? null : w.burnPctPerHour }, now);
  const pct = rolled ? null : Math.round(full ? Math.max(100, w.pct) : w.pct);
  return <View style={{ flex: compact ? undefined : 1, minWidth: compact ? undefined : 150, gap: 3 }}>
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
      <Text style={{ ...t.meta, color: c.foreground }}>{label}</Text>
      <Text style={{ ...t.label, ...tabular, color: f.tone === "default" ? c.foreground : toneColor(c, f.tone) }}>{pct === null ? "reset" : `${pct}%`}</Text>
      <View style={{ flex: 1 }} />
      <Text numberOfLines={1} style={t.small}>{reset === null ? "" : rolled ? `was ${formatMoment(w.resetsAt!, now)}` : `resets ${formatMoment(w.resetsAt!, now)}`}</Text>
    </View>
    <Meter theme={theme} pct={pct ?? 0} tone={f.tone} projected={f.atResetPct} pace={f.elapsed === null || rolled ? null : f.elapsed * 100} height={6}
      label={`${label}: ${pct === null ? "reset since the last reading" : `${pct}% used`}`} />
  </View>;
}

/** A detail block's caption, and its body or the plain fact that nothing is recorded yet. */
function Detail({ theme, title, empty, children }: { theme: Theme; title: string | null; empty: string | null; children?: ReactNode }) {
  const t = text(theme.colors);
  return <View style={{ gap: 4 }}>
    {title === null ? null : <Text style={t.group}>{title}</Text>}
    {empty !== null ? <Text style={t.meta}>{empty}</Text> : children}
  </View>;
}

/**
 * Everything recorded about one account, the same blocks for main and every other account
 * (`ACCOUNT_SECTIONS`): the open session window's chart with its pace, earlier windows,
 * Extra usage and where the history comes from. A block with nothing yet says so.
 */
function AccountDetails({ theme, account, now, compact, guardPct, stale, full }: { theme: Theme; account: Subscription; now: number; compact: boolean; guardPct: number | null; stale: boolean; full: boolean }) {
  const c = theme.colors;
  const t = text(c);
  const has = accountSections(account);
  const s5 = sessionWindow(account);
  const rolled = s5?.resetsAt ? Date.parse(s5.resetsAt) <= now : false;
  const f = s5 && !rolled ? forecastWindow({ ...s5, pct: full ? Math.max(100, s5.pct) : s5.pct, burnPctPerHour: stale ? null : s5.burnPctPerHour }, now) : null;
  const pace = f ? paceLine(f, now) : "";
  const budget = f ? budgetLine(f) : null;
  const extra = account.extraUsage ?? null;
  const extraPct = extra ? extraUsagePct(extra) : null;
  const rec = account.recorded;
  return <View style={{ gap: 16, paddingTop: 4, paddingLeft: compact ? 0 : 22 }}>
    <Detail theme={theme} title={has.chart && f !== null ? null : "This session window"} empty={!has.chart || f === null ? (s5 && rolled ? "Reset since the last reading" : "No readings of the open window yet") : null}>
      {f ? <View style={{ gap: 6 }}>
        <WindowChart theme={theme} forecast={f} history={account.history ?? []} now={now} compact={compact} guardPct={guardPct} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 10, rowGap: 2 }}>
          <Text style={t.meta}>{resetLine(f, now)}</Text>
          {pace ? <Text style={{ ...t.meta, color: f.state === "short" || f.state === "full" ? toneColor(c, f.tone) : c.foregroundMuted, fontWeight: f.state === "short" ? "600" : "400" }}>{pace}</Text> : null}
          {budget ? <Text style={t.meta}>{budget}</Text> : null}
        </View>
      </View> : null}
    </Detail>
    <Detail theme={theme} title="Earlier session windows, last 14 days" empty={has.past ? null : "None recorded yet"}>
      <PastWindows theme={theme} past={account.past ?? []} now={now} compact={compact} />
    </Detail>
    {account.family === "claude" ? <Detail theme={theme} title="Extra usage" empty={extra === null ? "Not reported for this account" : null}>
      {extra ? <View style={{ gap: 4 }}>
        <Text style={{ ...t.meta, color: c.foreground, ...tabular }}>{extraUsageLine(extra)}</Text>
        {extraPct !== null ? <Meter theme={theme} pct={extraPct} tone={extraPct >= 100 ? "danger" : extraPct >= 90 ? "warning" : "default"} height={6} label={`Extra usage: ${extraUsageLine(extra)}`} /> : null}
      </View> : null}
    </Detail> : null}
    {rec ? <Text style={t.small}>{rec.readings === 0 ? "No history recorded yet"
      : `${rec.source === "recorder" ? "Recorded by Smart Session" : "From ZeroSub's readings"}${rec.since ? ` since ${formatDay(rec.since)}` : ""} · ${rec.readings.toLocaleString()} readings`}</Text> : null}
  </View>;
}

function AccountRow({ theme, account, pool, now, compact, first, alone, open, onToggle, guardPct }: {
  theme: Theme; account: Subscription; pool: PoolForecast | null; now: number; compact: boolean; first: boolean; alone: boolean;
  open: boolean; onToggle: (() => void) | null; guardPct: number | null;
}) {
  const c = theme.colors;
  const t = text(c);
  const state = subscriptionState(account, now);
  const stale = state.staleMs !== null;
  const s5 = sessionWindow(account);
  const muted = state.kind === "aside" || state.kind === "signed-out";
  // When it runs out comes from the pool's simulation, so the row, the lead and the
  // popover say the same time; "on pace for" is its own pace when nothing moves onto it.
  const outlook = state.kind === "room" && pool ? accountOutlook(pool, account, now) : null;
  const f = s5 && !stale && !(s5.resetsAt && Date.parse(s5.resetsAt) <= now) ? forecastWindow(s5, now) : null;
  const pace: { text: string; tone: "default" | "warning" | "danger" } | null = outlook?.kind === "runs-out"
    ? { text: `Runs out ~${formatMoment(new Date(outlook.at).toISOString(), now)}`, tone: outlook.at - now <= 30 * 60_000 ? "danger" : "warning" }
    : pool === null && f && (f.state === "short" || f.state === "full") ? { text: paceLine(f, now), tone: f.tone === "default" ? "default" : f.tone as "warning" | "danger" }
      : outlook?.kind === "lasts" && f && f.state === "ok" ? { text: paceLine(f, now), tone: "default" } : null;
  const extra = account.extraUsage;
  const facts = [
    account.agents > 0 ? `${account.agents} ${account.agents === 1 ? "session" : "sessions"} on it` : null,
    stale && !muted ? `Reading ${formatDuration(state.staleMs!)} old` : null,
    account.credits ? (account.credits.unlimited ? "Unlimited credits" : account.credits.balance !== null ? `${Math.round(account.credits.balance).toLocaleString()} credits` : null) : null,
    extra?.enabled ? `Extra usage ${extraUsageLine(extra)}` : null,
  ].filter(Boolean);
  const limitedId = state.kind === "limit" ? limitedWindow(account, now)?.id ?? null : null;
  const windows = account.windows.filter(isInteresting).sort((a, b) => ORDER(a.id) - ORDER(b.id) || b.pct - a.pct);
  const main = account.kind === "main";

  const head = <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
    <Icon name={main ? "Terminal" : "UserRound"} size={14} color={c.foregroundMuted} />
    <Text numberOfLines={1} style={{ ...t.label, flexShrink: 1 }}>{account.name}</Text>
    {showsMainChip(account) && !alone ? <Chip theme={theme} label="Main" /> : null}
    {account.isDefault && !alone && !main ? <Chip theme={theme} label="Default" accessibilityLabel="Default for new sessions" /> : null}
    <View style={{ flex: 1 }} />
    {state.kind === "room" ? null : <Chip theme={theme} icon={state.kind === "limit" ? "OctagonAlert" : undefined} label={state.label} color={toneColor(c, state.tone)} />}
    {onToggle ? <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}><Icon name="ChevronRight" size={14} color={c.foregroundMuted} /></View> : null}
  </View>;

  return <CardRow theme={theme} first={first} style={{ gap: 10, opacity: muted ? 0.62 : 1 }}>
    {onToggle ? <Pressable accessibilityRole="button" aria-expanded={open} accessibilityLabel={`${open ? "Hide" : "Show"} details for ${account.name}${main && !alone ? " (main account)" : ""}`} onPress={onToggle} hitSlop={6}
      style={(s) => ({ minHeight: compact ? 44 : 22, justifyContent: "center", opacity: s.pressed ? 0.7 : 1 })}>{head}</Pressable> : head}
    {muted || windows.length === 0 ? (windows.length === 0 && !muted ? <Text style={{ ...t.meta, paddingLeft: 22 }}>No reading yet</Text> : null)
      : <View style={{ flexDirection: compact ? "column" : "row", flexWrap: compact ? "nowrap" : "wrap", columnGap: 20, rowGap: 10, paddingLeft: compact ? 0 : 22 }}>
        {windows.map((w) => <MiniWindow key={w.id} theme={theme} label={shortLabel(w.id)} w={w} now={now} stale={stale} full={limitedId !== null && limitedId === w.id} compact={compact} />)}
      </View>}
    {facts.length > 0 || pace ? <Text style={{ ...t.meta, paddingLeft: compact ? 0 : 22 }}>
      {facts.join(" · ")}{facts.length > 0 && pace ? " · " : ""}
      {/* Only the clause that is state wears the state colour. */}
      {pace ? <Text style={{ color: pace.tone === "default" ? c.foregroundMuted : toneColor(c, pace.tone), fontWeight: pace.tone === "default" ? "400" : "600" }}>{pace.text}</Text> : null}
    </Text> : null}
    {open ? <AccountDetails theme={theme} account={account} now={now} compact={compact} guardPct={guardPct} stale={stale} full={limitedId !== null && limitedId === s5?.id} /> : null}
  </CardRow>;
}

/** Which account rows are open, kept while the page is away and back (per viewer, this session). */
const openRows = new Map<string, boolean>();

/** What the rows' meters mean, once, at the foot of the card. */
function MeterKey({ theme }: { theme: Theme }) {
  const c = theme.colors;
  const t = text(c);
  const swatch = (color: string) => <View style={{ width: 14, height: 6, borderRadius: 3, backgroundColor: color }} />;
  return <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 14, rowGap: 4, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>{swatch(ink(c, 0.82))}<Text style={t.small}>Used</Text></View>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>{swatch(ink(c, 0.16))}<Text style={t.small}>By the reset at this pace</Text></View>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><View style={{ width: 2, height: 12, borderRadius: 1, backgroundColor: c.foregroundMuted }} /><Text style={t.small}>Even pace</Text></View>
  </View>;
}

/**
 * Every account, grouped by provider: the pool's runway and headline, then one row per
 * account, main first. Every row has the same anatomy and the same details (invariant:
 * every account shows everything the main account shows). Without ZeroSub this is the
 * one login, through the same row, titled "Plan limits".
 */
export function SubscriptionsSection({ theme, compact, accounts, pools, now, autoSwitch, leadFamily, guardPct = null, title = "Subscriptions" }: {
  theme: Theme; compact: boolean; accounts: readonly Subscription[]; pools: readonly PoolForecast[]; now: number; autoSwitch: boolean;
  /** The family the page's headline already speaks for; its card does not repeat it. */
  leadFamily: string | null;
  guardPct?: number | null;
  title?: string;
}) {
  const c = theme.colors;
  const t = text(c);
  const [, redraw] = useState(0);
  const isOpen = (account: Subscription, alone: boolean) => alone || (openRows.get(account.id) ?? (account.kind === "main" && !compact));
  const toggle = (account: Subscription, alone: boolean) => { openRows.set(account.id, !isOpen(account, alone)); redraw((n) => n + 1); };
  const families = pools.length > 0 ? pools.map((pool) => ({ family: pool.family, pool: pool as PoolForecast | null })) : [...new Set(accounts.map((a) => a.family))].map((family) => ({ family, pool: null }));
  return <View style={{ gap: 8 }}>
    <SectionHead theme={theme} title={title} count={pools.length > 0 ? accounts.length : undefined}
      trailing={autoSwitch || pools.length === 0 ? null : <Text style={t.small}>Automatic switching is off in ZeroSub</Text>} />
    {families.map(({ family, pool }) => {
      // Main first: where it sits is the plainest way to say which one it is.
      const mine = [...accounts.filter((a) => a.family === family)].sort((a, b) =>
        Number(b.kind === "main") - Number(a.kind === "main") || Number(b.agents > 0) - Number(a.agents > 0) || Number(b.isDefault) - Number(a.isDefault));
      const alone = mine.length === 1;
      const head = pool ? poolHeadline(pool, mine, now) : null;
      return <Card key={family} theme={theme}>
        {pool && !alone ? <CardRow theme={theme} first style={{ gap: 12 }}>
          <View style={{ gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ ...t.title }}>{familyName(family)}</Text>
              <Text style={t.meta}>{`${pool.withRoom} of ${pool.total} with room`}</Text>
            </View>
            {head && family !== leadFamily ? <Text style={{ ...t.meta, color: head.tone === "default" ? c.foregroundMuted : toneColor(c, head.tone) }}>{headLine(head, pool)}</Text> : null}
          </View>
          <Runway theme={theme} pool={pool} accounts={mine} now={now} compact={compact} />
        </CardRow> : null}
        {mine.map((account, i) => <AccountRow key={account.id} theme={theme} account={account} pool={pool} now={now} compact={compact}
          first={i === 0 && !(pool && !alone)} alone={alone} open={isOpen(account, alone)} onToggle={alone ? null : () => toggle(account, alone)} guardPct={guardPct} />)}
        <MeterKey theme={theme} />
      </Card>;
    })}
  </View>;
}

/** The family's one line in its card: the headline's facts, which the title already frames. */
function headLine(head: { title: string; detail: string }, pool: PoolForecast): string {
  // "Claude · 2 subscriptions last until about 9:40 PM" → "Last until about 9:40 PM".
  const lead = head.title.replace(/^(Claude|Codex) · \d+ subscriptions? /, "").replace(/^(Claude|Codex) /, "");
  const sentence = lead.charAt(0).toUpperCase() + lead.slice(1);
  if (pool.pace === null && pool.runsOutAt === null) return head.detail;
  return [sentence, head.detail].filter(Boolean).join(" · ");
}
