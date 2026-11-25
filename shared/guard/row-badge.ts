/**
 * What a sidebar workspace row says about Session Guard and ZeroSub (Paseo 0.17.1+ row badges).
 *
 * Pure, so the words are tested (`row-badge.test.ts`) and the client only picks the pauses and agents
 * of one workspace. The held badge replaces the held workspace label on hosts that draw badges
 * (`server/guard/labels.ts`): a label is a host-wide named entity and can't carry a time, a badge can.
 */
import { HELD_LABELS, heldUntil, moveWaitLine } from "./hold.ts";
import { heldWhere } from "./presentation.ts";
import { isPending, timestamp, type Pause } from "./policy.ts";

export type RowBadgeTone = "muted" | "success" | "warning" | "danger" | "info";
export interface RowBadgeView { label: string; tone: RowBadgeTone; accessibilityLabel: string }

/** The first Paseo whose app draws plugin badges on a workspace row (`addWorkspaceRowBadgeItem`). */
export const ROW_BADGES_SINCE = [0, 17, 1] as const;

/**
 * Whether a daemon of this version draws row badges, from `server_info.version` ("0.17.4"). Unknown or
 * unreadable: no, so an older host keeps its label. A prerelease of 0.17.1 itself counts as older.
 */
export function supportsRowBadges(version: string | null | undefined): boolean {
  const match = typeof version === "string" ? /^v?(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?/.exec(version.trim()) : null;
  if (!match) return false;
  const have = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < 3; i++) if (have[i] !== ROW_BADGES_SINCE[i]) return have[i]! > ROW_BADGES_SINCE[i]!;
  return match[4] === undefined;
}

/** When one hold ends as the row shows it: the planned move or reset, else the reset (or the next room). */
function endsAt(pause: Pause): number | null {
  const wait = pause.moveWait;
  if (wait?.at && (wait.plan === "move" || wait.plan === "reset")) return timestamp(wait.at);
  return timestamp(heldUntil(pause));
}

/** One hold's short words: "Held · 5:58 PM", "Held · moves 5:06 PM", "Held · until its jobs end". */
function oneHeld(pause: Pause, now: number, moment: (iso: string) => string): string {
  if (pause.demo) return "Held · test";
  if (pause.phase === "resuming") return "Held · continuing";
  const wait = pause.moveWait;
  if (wait?.plan === "move" && wait.at) return Date.parse(wait.at) <= now ? HELD_LABELS.moving : `Held · moves ${moment(wait.at)}`;
  if (wait?.plan === "reset" && wait.at) return `Held · ${moment(wait.at)}`;
  if (wait) return HELD_LABELS.jobs;
  const reset = timestamp(heldUntil(pause));
  if (reset === null) return HELD_LABELS.held;
  return reset <= now ? "Held · reset due" : `Held · ${moment(heldUntil(pause)!)}`;
}

/** The full sentence for one hold, for screen readers: the page row's own words where it has them. */
function oneHeldInFull(pause: Pause, now: number, moment: (iso: string) => string): string {
  if (pause.demo) return "a test pause that waits for you";
  if (pause.phase === "resuming") return "the window reset and it is continuing now";
  const line = moveWaitLine(pause, now, moment);
  if (line !== null) return line.charAt(0).toLowerCase() + line.slice(1);
  const at = heldUntil(pause);
  const reset = timestamp(at);
  if (reset === null) return "the reset time isn't reported yet";
  const where = heldWhere(pause);
  return reset <= now ? `its reset was ${moment(at!)}, waiting for a fresh reading` : `until ${moment(at!)}${where ? `, then it ${where}` : ""}`;
}

/**
 * The held badge for one workspace, from the pauses whose session sits in it; null when none is held.
 * One hold says when it ends; several say how many and the first to end; a hold that changed while
 * held turns it red, as on the pill.
 */
export function heldBadge(pauses: readonly Pause[], now: number, moment: (iso: string) => string): RowBadgeView | null {
  const held = pauses.filter(isPending);
  if (held.length === 0) return null;
  const check = held.filter((pause) => pause.phase === "attention").length;
  const n = held.length;
  const sessions = n === 1 ? "a session" : `${n} sessions`;
  const lead = `Session Guard holds ${sessions} in this workspace at the usage limit`;
  const needs = check === 0 ? "" : `. ${check === 1 ? "One" : check} changed while held and need${check === 1 ? "s" : ""} a look`;
  if (check > 0) {
    const label = check === n ? (n === 1 ? "Check session" : `Check ${n} sessions`) : `${n} held · check ${check}`;
    return { label, tone: "danger", accessibilityLabel: `${lead}${needs}` };
  }
  if (n === 1) return { label: oneHeld(held[0]!, now, moment), tone: "warning", accessibilityLabel: `${lead}: ${oneHeldInFull(held[0]!, now, moment)}` };
  let first: { at: number; iso: string } | null = null;
  for (const pause of held) {
    const at = endsAt(pause);
    if (at === null || at <= now) continue;
    if (first === null || at < first.at) first = { at, iso: new Date(at).toISOString() };
  }
  return first === null
    ? { label: `${n} held`, tone: "warning", accessibilityLabel: lead }
    : { label: `${n} held · ${moment(first.iso)}`, tone: "warning", accessibilityLabel: `${lead}; the first is due ${moment(first.iso)}` };
}

/** Just what the account badge reads from Smart Session's subscriptions status. */
export interface AccountsReading {
  zerosub: boolean;
  accounts: readonly { id: string; name: string }[];
  /** Which account each live session runs on, by agent id. */
  agents: Readonly<Record<string, string>>;
}

/**
 * Which account a workspace's open sessions run on: "Main", "Account 2", or "2 accounts". Only with
 * ZeroSub and more than one account; null otherwise, or when none of them is on a known account.
 * Names are the subscriptions' own (`subscriptionName`): never an email or a generated label.
 */
export function accountBadge(subs: AccountsReading | null, agentIds: readonly string[]): RowBadgeView | null {
  if (!subs?.zerosub || subs.accounts.length < 2) return null;
  const names: string[] = [];
  for (const agentId of agentIds) {
    const accountId = subs.agents[agentId];
    const name = accountId === undefined ? undefined : subs.accounts.find((account) => account.id === accountId)?.name;
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  if (names.length === 0) return null;
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return {
    label: names.length === 1 ? names[0]! : `${names.length} accounts`,
    tone: "muted",
    accessibilityLabel: `${agentIds.length === 1 ? "This workspace's session runs" : "This workspace's sessions run"} on ${list}`,
  };
}
