/**
 * Whether a finished turn ended on the CLI's limit notice.
 *
 * Claude Code does not fail a turn at the limit: it completes it with a synthetic reply,
 * "You've hit your 5-hour limit · resets 3pm (…)". Paseo reports that as an ordinary
 * completed turn, so the guard's failed-turn path never sees it. ZeroSub reads the same
 * reply to fail over (`server/limits.ts` in `@kapybara/zerosub` 1.5.0); when it finds no
 * account with room it stops there, and nothing continues the agent after the reset
 * unless Session Guard records a pause. These are ZeroSub's patterns, so the guard
 * treats exactly the turns ZeroSub treats as limits as limits.
 *
 * Only the first line of each candidate counts, and only CLI-generated places are read:
 * error rows, warning notifications, `[System Error]` replies and, for Claude, the
 * final two replies. Prose earlier in a turn never matches.
 */

export interface TurnRow {
  readonly type: string;
  readonly text?: string;
  readonly message?: string;
  readonly level?: string;
}

const END = String.raw`(?=\s*(?:·|\.|$))`;
const APOSTROPHE = "['’]";
const CLAUDE: readonly RegExp[] = [
  new RegExp(`^You${APOSTROPHE}ve hit your (?:5-hour |session |weekly |Opus |Sonnet |Fable )?limit${END}`, "i"),
  new RegExp(`^You${APOSTROPHE}ve reached your (?:Fable|Opus|Sonnet|Haiku)(?: [\\w.]{1,10})? limit${END}`),
  /Claude AI usage limit reached\|\d{9,}/,
  new RegExp(
    `^You${APOSTROPHE}ve hit your (?:usage limit|usage credit limit|team${APOSTROPHE}s shared budget|(?:monthly|individual) spend limit|individual usage limit|(?:org|channel)${APOSTROPHE}s monthly (?:usage|spend) limit)${END}`,
    "i",
  ),
  new RegExp(`^You${APOSTROPHE}re out of (?:usage credits|extra usage)${END}`, "i"),
  /^Your org is out of usage\s*·/i,
];
const CODEX: readonly RegExp[] = [
  new RegExp(`^You${APOSTROPHE}ve hit your usage limit\\b`, "i"),
  /^The usage limit has been reached\b/i,
  /"type"\s*:\s*"usage_limit_reached"/,
  /^Your workspace is out of credits\b/i,
  /^You hit your spend cap\b/i,
];

const SYSTEM_ERROR = /^\[System Error\]\s*/;
const MAX_NOTICE = 400;
const clean = (text: string) => text.replace(SYSTEM_ERROR, "").replace(/^API Error:\s*/i, "").trim();
const firstLine = (text: string) => (text.split("\n")[0] ?? text).trim();

/** The limit notice a finished turn ended on, given that turn's rows oldest first; null when none. */
export function limitNotice(provider: string, rows: readonly TurnRow[]): string | null {
  const patterns = provider === "claude" ? CLAUDE : provider === "codex" ? CODEX : null;
  if (!patterns) return null;
  const found: string[] = [];
  let replies = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.type === "user_message") break;
    if (row.type === "error" && row.message) found.push(row.message);
    else if (row.type === "notification" && row.level !== "info" && row.message) found.push(row.message);
    else if (row.type === "assistant_message" && typeof row.text === "string") {
      if (SYSTEM_ERROR.test(row.text) || (provider === "claude" && replies < 2)) found.push(row.text);
      replies += 1;
    }
  }
  for (const text of found.map(clean)) {
    if (text.length === 0 || text.length > MAX_NOTICE) continue;
    const line = firstLine(text);
    if (patterns.some((pattern) => pattern.test(provider === "claude" ? line : text))) return line;
  }
  return null;
}

/**
 * One turn's rows from a tail page of the agent's timeline, oldest first. Providers can
 * reuse a turn id, so reading back from the turn's last row, another turn's prompt is
 * where this one began (as ZeroSub's `turnRows`).
 */
export function turnRows<T extends TurnRow>(entries: readonly { item: T; turnId?: string }[], turnId: string): T[] {
  const rows: T[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.turnId === turnId) rows.push(entry.item);
    else if (rows.length > 0 && entry.turnId && entry.item.type === "user_message") break;
  }
  return rows.reverse();
}
