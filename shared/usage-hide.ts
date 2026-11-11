/**
 * When Paseo's own Claude card steps aside for ours (Paseo 0.16, web and desktop), as
 * one pure rule the client applies to what is on screen (`client/usage-hide.ts`).
 *
 * The invariant: **Paseo's card is shown only when it may know something ours doesn't.**
 * Ours is built from the newer of ZeroSub's reading and Paseo's own for that login
 * (`shared/builtin-usage.ts`). So a built-in card steps aside, beside our card for the
 * same login, when the two show the same numbers, or when it shows a reading the server
 * knows ours is at least as new as (`supersedes`: a 429 kept its last good reading, or a
 * reset passed since). Any other difference means Paseo's may be newer: both stay.
 *
 * Nothing here waits on the network. A built-in card is held back from its first frame
 * (a CSS animation, so even a dead script lets it through) for at most `GRACE_MS` while
 * our card arrives, then decided from the DOM in the same frame our card renders:
 * hidden for good if the numbers match, shown otherwise. Once shown, a card stays shown
 * for as long as it is mounted, so the list never loses a card it has already shown.
 */

/** How long a built-in card waits, unseen, for ours. */
export const GRACE_MS = 1_500;
/** The CSS animation that holds a built-in card back while it waits. */
export const GRACE_ANIMATION = "smart-session-usage-grace";
/** Set on a built-in card once decided: "hide" or "show". */
export const DECIDED_ATTR = "data-smart-session-usage";

export const BUILTIN_PREFIX = "usage-report-claude:";
export const OURS_PREFIX = "usage-report-smart-session:";
/**
 * The lists that show usage cards in Paseo 0.16: the context window details (the
 * composer's popover), the Usage screen, and a host's settings page. Anything else, and
 * any of these renamed in a later Paseo, is left alone.
 */
export const SCOPES = ["context-window-details", "usage-modal-body", "usage-card"] as const;

export type Verdict = "hide" | "show" | "wait";

/** Window rows as a card renders them: label → value text ("Session" → "22%"). */
export type WindowValues = ReadonlyMap<string, string>;

export interface CardFacts {
  /** The person's "Replace Paseo's Claude usage card" setting. */
  readonly enabled: boolean;
  /** Login hash → our card's key, for cards the server says may stand in; null before its first answer. */
  readonly hideable: ReadonlyMap<string, string> | null;
  /** The login the built-in card names, hashed (synchronously, `shared/sha256.ts`); null when it names none. */
  readonly loginHash: string | null;
  /** The built-in card's rows. */
  readonly theirs: WindowValues;
  /** Our cards in the same list, by key. */
  readonly ours: ReadonlyMap<string, WindowValues>;
  /** The card's grace is over (or it never had one). */
  readonly graceOver: boolean;
  /** The card has been shown while mounted. */
  readonly shown: boolean;
  /**
   * The used percentages of the built-in reading the server holds for this login, when
   * ours is at least as new as it; null or absent when ours may be older.
   */
  readonly supersedes?: readonly number[] | null;
}

/** What to do with one built-in card now. */
export function decide(f: CardFacts): Verdict {
  if (f.shown || !f.enabled || f.hideable === null || f.loginHash === null) return "show";
  const key = f.hideable.get(f.loginHash);
  if (key === undefined) return "show";
  const ours = f.ours.get(key);
  if (ours === undefined) return f.graceOver ? "show" : "wait";
  if (sameNumbers(f.theirs, ours)) return "hide";
  return f.supersedes && showsReading(f.theirs, f.supersedes) ? "hide" : "show";
}

/**
 * The built-in card shows exactly this reading: its window values are these used
 * percentages, read as used or as left (the person's display setting), in any order.
 * Labels are not compared: Paseo names its windows itself.
 */
export function showsReading(theirs: WindowValues, usedPcts: readonly number[]): boolean {
  const shown = [...theirs.values()].map(percentOf);
  if (shown.length === 0 || shown.length !== usedPcts.length || shown.some((n) => n === null)) return false;
  const matches = (expected: number[]) => {
    const a = [...(shown as number[])].sort((x, y) => x - y);
    const b = [...expected].sort((x, y) => x - y);
    return a.every((n, i) => Math.abs(n - b[i]!) < 1);
  };
  return matches([...usedPcts]) || matches(usedPcts.map((u) => 100 - u));
}

/** The number in a rendered percentage ("78%", "22% left", "12,5 %"). */
function percentOf(text: string): number | null {
  const m = /(\d+(?:[.,]\d+)?)\s*%|%\s*(\d+(?:[.,]\d+)?)/.exec(text);
  const digits = m?.[1] ?? m?.[2];
  return digits === undefined ? null : Number(digits.replace(",", "."));
}

/**
 * Every window both cards show reads the same, and they share at least one. Values are
 * compared as rendered, so the person's "used"/"left" display and locale apply to both.
 */
export function sameNumbers(theirs: WindowValues, ours: WindowValues): boolean {
  let shared = 0;
  for (const [label, value] of theirs) {
    const mine = ours.get(label);
    if (mine === undefined) continue;
    if (mine.trim() !== value.trim()) return false;
    shared += 1;
  }
  return shared > 0;
}

/** A window row's value: it carries a percentage. */
export const PERCENT = /\d\s*%|%\s*\d/;

/** The stylesheet: held back while waiting, hidden once decided so, untouched once shown. */
export function hideStylesheet(withGrace: boolean): string {
  const cards = SCOPES.map((scope) => `[data-testid="${scope}"] [data-testid^="${BUILTIN_PREFIX}"]`);
  const rules = [`${cards.map((c) => `${c}[${DECIDED_ATTR}="hide"]`).join(",\n")} { display: none !important; }`];
  // The Usage screen wraps each card in a bordered box: while the card is not shown, a box
  // holding only that card gives up its own (border, padding, the list's gap) and keeps its child.
  const unseen = withGrace ? `:not([${DECIDED_ATTR}="show"])` : `[${DECIDED_ATTR}="hide"]`;
  const wrappers = SCOPES.map((scope) => `[data-testid="${scope}"] :has(> [data-testid^="${BUILTIN_PREFIX}"]${unseen}):not(:has(> * + *))`);
  rules.push(`${wrappers.join(",\n")} { display: contents !important; }`);
  if (withGrace) {
    rules.push(`${cards.map((c) => `${c}:not([${DECIDED_ATTR}])`).join(",\n")} { animation: ${GRACE_ANIMATION} ${GRACE_MS}ms linear 1; }`);
    rules.push(`@keyframes ${GRACE_ANIMATION} { from, to { display: none; } }`);
  }
  return rules.join("\n");
}
