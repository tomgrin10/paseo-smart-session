import { Icon } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";

import { formatDuration } from "../shared/format";
import { forecastWindow, formatMoment, paceLine } from "../shared/forecast";
import {
  accountOutlook, familyName, limitedWindow, poolHeadline, sessionWindow, subscriptionState, weeklyWindow,
  type LaneKind, type PoolForecast, type Subscription, type SubscriptionWindow,
} from "../shared/subscriptions";
import { Meter, ink } from "./charts";
import { Card, CardRow, Chip, SectionHead, text } from "./kit";
import { tabular, toneColor, withAlpha, type Theme } from "./theme";

const HOUR = 3_600_000;

/** How a lane run is drawn: magnitude is ink, the limit is red, out is a hairline. */
function laneFill(theme: Theme, kind: LaneKind): string {
  const c = theme.colors;
  if (kind === "active") return ink(c, 0.82);
  if (kind === "room") return ink(c, 0.16);
  if (kind === "limit") return withAlpha(c.statusDanger, 0.42);
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
  const nameWidth = compact ? 0 : 112;
  const summary = poolHeadline(pool, accounts, now);
  const dry = pool.runsOutAt !== null && pool.runsOutAt > now && pool.runsOutAt < end ? pool.runsOutAt : null;
  const near = (ms: number, width: number) => dry !== null && Math.abs(ms - dry) / span < width;

  return <View accessible accessibilityRole="image" accessibilityLabel={`${summary.title}. ${summary.detail}`} style={{ gap: 6 }}>
    {accounts.map((account) => <View key={account.id} style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: compact ? 3 : 10 }}>
      <Text numberOfLines={1} style={{ ...t.small, width: compact ? undefined : nameWidth, color: c.foreground }}>{account.name}</Text>
      <View style={{ flex: compact ? undefined : 1, height: 10, borderRadius: 3, overflow: "hidden", backgroundColor: ink(c, 0.04) }}>
        {(pool.lanes[account.id] ?? []).filter((run) => run.from < end).map((run, i) => <View key={i} style={{
          position: "absolute", left: at(Math.max(run.from, now)) as `${number}%`, width: width(run.from, run.to) as `${number}%`,
          ...(run.kind === "out" ? { top: 4.5, bottom: 4.5, backgroundColor: c.border } : { top: 0, bottom: 0, backgroundColor: laneFill(theme, run.kind) }),
        }} />)}
        {/* The moment the pool runs dry, across every lane. */}
        {dry !== null ? <View style={{ position: "absolute", top: 0, bottom: 0, left: at(dry) as `${number}%`, width: 1, backgroundColor: c.foreground }} /> : null}
      </View>
    </View>)}
    {/* The clock under the lanes, aligned with them. */}
    <View style={{ flexDirection: "row", gap: compact ? 0 : 10 }}>
      {compact ? null : <View style={{ width: nameWidth }} />}
      <View style={{ flex: 1, height: 14 }}>
        <Text style={{ ...t.small, fontSize: 10, lineHeight: 14, position: "absolute", left: 0 }}>Now</Text>
        {ticks.map((h, i) => (Math.round(h / HOUR) % every === 0 && (h - now) / span > (compact ? 0.1 : 0.08) && (end - h) / span > (compact ? 0.22 : 0.09) && !near(h, compact ? 0.18 : 0.1))
          ? <Text key={i} style={{ ...t.small, fontSize: 10, lineHeight: 14, position: "absolute", left: at(h) as `${number}%`, transform: [{ translateX: -30 }], width: 60, textAlign: "center" }}>{hourLabel(h, now)}</Text>
          : null)}
        {dry !== null ? <Text style={{ ...t.small, fontSize: 10, lineHeight: 14, fontWeight: "600", color: c.foreground, position: "absolute", left: at(dry) as `${number}%`, transform: [{ translateX: -40 }], width: 80, textAlign: "center" }}>{`out ${formatMoment(new Date(dry).toISOString(), now)}`}</Text> : null}
        <Text style={{ ...t.small, fontSize: 10, lineHeight: 14, position: "absolute", right: 0 }}>{near(end, compact ? 0.2 : 0.12) ? "" : formatMoment(new Date(end).toISOString(), now)}</Text>
      </View>
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 4, paddingLeft: compact ? 0 : nameWidth + 10 }}>
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

/** One window of one account: "5h 42%", a thin meter, and its reset. */
function MiniWindow({ theme, label, w, now, stale, full = false }: { theme: Theme; label: string; w: SubscriptionWindow | null; now: number; stale: boolean; full?: boolean }) {
  const c = theme.colors;
  const t = text(c);
  if (w === null) return <View style={{ flex: 1, minWidth: 130, gap: 2 }}><Text style={t.meta}>{`${label} · not reported`}</Text></View>;
  const reset = w.resetsAt === null ? null : Date.parse(w.resetsAt);
  const rolled = reset !== null && reset <= now;
  // A limit the CLI reported is the freshest word on its window: full until it resets.
  const f = forecastWindow({ ...w, pct: rolled ? 0 : full ? Math.max(100, w.pct) : w.pct, burnPctPerHour: stale ? null : w.burnPctPerHour }, now);
  const pct = rolled ? null : Math.round(full ? Math.max(100, w.pct) : w.pct);
  return <View style={{ flex: 1, minWidth: 130, gap: 1 }}>
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
      <Text style={{ ...t.meta, color: c.foreground }}>{label}</Text>
      <Text style={{ ...t.label, ...tabular, color: f.tone === "default" ? c.foreground : toneColor(c, f.tone) }}>{pct === null ? "reset" : `${pct}%`}</Text>
      <View style={{ flex: 1 }} />
      <Text numberOfLines={1} style={t.small}>{reset === null ? "" : rolled ? `was ${formatMoment(w.resetsAt!, now)}` : `resets ${formatMoment(w.resetsAt!, now)}`}</Text>
    </View>
    <Meter theme={theme} pct={pct ?? 0} tone={f.tone} projected={f.atResetPct} height={5} label={`${label}: ${pct === null ? "reset since the last reading" : `${pct}% used`}`} />
  </View>;
}

function AccountRow({ theme, account, pool, now, compact, first, alone }: { theme: Theme; account: Subscription; pool: PoolForecast; now: number; compact: boolean; first: boolean; alone: boolean }) {
  const c = theme.colors;
  const t = text(c);
  const state = subscriptionState(account, now);
  const stale = state.staleMs !== null;
  const s5 = sessionWindow(account);
  const week = weeklyWindow(account);
  const muted = state.kind === "aside" || state.kind === "signed-out";
  // When it runs out comes from the pool's simulation, so the row, the lead and the
  // popover say the same time; "on pace for" is its own pace when nothing moves onto it.
  const outlook = state.kind === "room" ? accountOutlook(pool, account, now) : null;
  const f = s5 && !stale && !(s5.resetsAt && Date.parse(s5.resetsAt) <= now) ? forecastWindow(s5, now) : null;
  const pace: { text: string; tone: "default" | "warning" | "danger" } | null = outlook?.kind === "runs-out"
    ? { text: `Runs out ~${formatMoment(new Date(outlook.at).toISOString(), now)}`, tone: outlook.at - now <= 30 * 60_000 ? "danger" : "warning" }
    : outlook?.kind === "lasts" && f && f.state === "ok" ? { text: paceLine(f, now), tone: "default" } : null;
  const facts = [
    account.agents > 0 ? `${account.agents} ${account.agents === 1 ? "session" : "sessions"} on it` : null,
    stale && !muted ? `Reading ${formatDuration(state.staleMs!)} old` : null,
    account.credits ? (account.credits.unlimited ? "Unlimited credits" : account.credits.balance !== null ? `${Math.round(account.credits.balance).toLocaleString()} credits` : null) : null,
  ].filter(Boolean);
  const limitedId = state.kind === "limit" ? limitedWindow(account, now)?.id ?? null : null;

  return <CardRow theme={theme} first={first} style={{ gap: 8, opacity: muted ? 0.62 : 1 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name={account.kind === "main" ? "Terminal" : "UserRound"} size={14} color={c.foregroundMuted} />
      <Text numberOfLines={1} style={{ ...t.label, flexShrink: 1 }}>{account.name}</Text>
      {account.isDefault && !alone ? <Chip theme={theme} label="Default" /> : null}
      <View style={{ flex: 1 }} />
      {state.kind === "room" ? null : <Chip theme={theme} icon={state.kind === "limit" ? "OctagonAlert" : undefined} label={state.label} color={toneColor(c, state.tone)} />}
    </View>
    {muted ? null : <View style={{ flexDirection: compact ? "column" : "row", gap: compact ? 8 : 20, paddingLeft: 22 }}>
      <MiniWindow theme={theme} label="5h" w={s5} now={now} stale={stale} full={limitedId !== null && limitedId === s5?.id} />
      <MiniWindow theme={theme} label="Week" w={week} now={now} stale={stale} full={limitedId !== null && limitedId === week?.id} />
    </View>}
    {facts.length > 0 || pace ? <Text style={{ ...t.meta, paddingLeft: 22 }}>
      {facts.join(" · ")}{facts.length > 0 && pace ? " · " : ""}
      {/* Only the clause that is state wears the state colour. */}
      {pace ? <Text style={{ color: pace.tone === "default" ? c.foregroundMuted : toneColor(c, pace.tone), fontWeight: pace.tone === "default" ? "400" : "600" }}>{pace.text}</Text> : null}
    </Text> : null}
  </CardRow>;
}

/**
 * Every ZeroSub subscription, grouped by provider: the pool's runway and headline,
 * then one row per account. ZeroSub manages the accounts; this says when.
 */
export function SubscriptionsSection({ theme, compact, accounts, pools, now, autoSwitch, leadFamily }: {
  theme: Theme; compact: boolean; accounts: readonly Subscription[]; pools: readonly PoolForecast[]; now: number; autoSwitch: boolean;
  /** The family the page's headline already speaks for; its card does not repeat it. */
  leadFamily: string | null;
}) {
  const c = theme.colors;
  const t = text(c);
  return <View style={{ gap: 8 }}>
    <SectionHead theme={theme} title="Subscriptions" count={accounts.length}
      trailing={autoSwitch ? null : <Text style={t.small}>Automatic switching is off in ZeroSub</Text>} />
    {pools.map((pool) => {
      const mine = [...accounts.filter((a) => a.family === pool.family)].sort((a, b) =>
        Number(b.agents > 0) - Number(a.agents > 0) || Number(b.isDefault) - Number(a.isDefault) || Number(b.kind === "main") - Number(a.kind === "main"));
      const head = poolHeadline(pool, mine, now);
      return <Card key={pool.family} theme={theme}>
        <CardRow theme={theme} first style={{ gap: 12 }}>
          <View style={{ gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ ...t.title }}>{familyName(pool.family)}</Text>
              <Text style={t.meta}>{`${pool.withRoom} of ${pool.total} with room`}</Text>
            </View>
            {mine.length > 1 && pool.family !== leadFamily ? <Text style={{ ...t.meta, color: head.tone === "default" ? c.foregroundMuted : toneColor(c, head.tone) }}>{headLine(head, pool)}</Text> : null}
          </View>
          {mine.length > 1 ? <Runway theme={theme} pool={pool} accounts={mine} now={now} compact={compact} /> : null}
        </CardRow>
        {mine.map((account) => <AccountRow key={account.id} theme={theme} account={account} pool={pool} now={now} compact={compact} first={false} alone={mine.length === 1} />)}
      </Card>;
    })}
    {/* What the rows' meters mean, once. */}
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 14, rowGap: 4, paddingHorizontal: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><View style={{ width: 14, height: 5, borderRadius: 3, backgroundColor: ink(c, 0.82) }} /><Text style={t.small}>Used</Text></View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><View style={{ width: 14, height: 5, borderRadius: 3, backgroundColor: ink(c, 0.16) }} /><Text style={t.small}>By the reset at its own pace</Text></View>
    </View>
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
