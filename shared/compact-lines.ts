/**
 * What the views say about Smart Compact's two lines, as plain functions.
 *
 * The lower line is the **end-of-turn line**: past it, the `Stop` hook asks the
 * agent at the end of a turn whether to compact. The upper line is the
 * **right-away line**: past it, the `PostToolUse` hook asks mid-turn, and the agent
 * is told to finish only the step it is on. The pill, its popover and the overview
 * all read these, so they cannot describe the same session two ways.
 */

import { formatCompactTokens, formatDuration } from "./format.ts";
import type { ContextOutlook, Tone } from "./forecast.ts";

/** "asks at 30%, right away at 40%", or the lower line alone when there is no upper one. */
export function linesSummary(lower: number, upper: number | null | undefined): string {
  return typeof upper === "number" ? `asks at ${lower}%, right away at ${upper}%` : `asks at ${lower}%`;
}

/** The popover's one sentence about where this session stands. */
export function outlookSentence(
  outlook: ContextOutlook,
  { enrolled, compactOn, growthPerHour }: { enrolled: boolean; compactOn: boolean; growthPerHour: number | null },
): { line: string; tone: Tone } {
  const pace = growthPerHour !== null && growthPerHour > 0 ? ` at +${formatCompactTokens(growthPerHour)}/h` : "";
  if (outlook.past && !enrolled) {
    return {
      line: compactOn ? "Past its compact line, but not enrolled, so nothing will ask it." : "Past its compact line. Smart Compact is off, so nothing will ask it.",
      tone: outlook.tone,
    };
  }
  if (outlook.pastNow) {
    return { line: "Past its right-away line. Smart Compact asks it mid-turn to finish the step it is on and compact.", tone: outlook.tone };
  }
  if (outlook.past) {
    const next = outlook.untilNowMs !== null
      ? ` Reaches the right-away line in about ${formatDuration(outlook.untilNowMs)}${pace}.`
      : outlook.nowAt !== null ? ` From ${outlook.nowAt}% it is asked right away.` : "";
    return { line: `Past its end-of-turn line: asked at the end of a turn whether to compact.${next}`, tone: outlook.tone };
  }
  if (outlook.untilCompactMs !== null) {
    const upper = outlook.untilNowMs !== null ? ` and its right-away line in about ${formatDuration(outlook.untilNowMs)}` : "";
    return { line: `Reaches its end-of-turn line in about ${formatDuration(outlook.untilCompactMs)}${upper}${pace}.`, tone: "default" };
  }
  return { line: outlook.nowAt !== null ? "Below both compact lines and not growing right now." : "Below its compact line and not growing right now.", tone: "default" };
}

/** The overview row's short line, or null when there is nothing to add. */
export function outlookShort(outlook: ContextOutlook, enrolled: boolean): string | null {
  if (outlook.past && !enrolled) return "Past its compact line · not enrolled";
  if (outlook.pastNow) return "Past its right-away line · asked mid-turn";
  if (outlook.past) {
    return outlook.untilNowMs !== null
      ? `Past its end-of-turn line · right away in ~${formatDuration(outlook.untilNowMs)}`
      : "Past its end-of-turn line · asked at the end of a turn";
  }
  if (outlook.untilCompactMs === null) return null;
  return outlook.untilNowMs !== null && outlook.nowAt !== null
    ? `${outlook.compactAt}% in ~${formatDuration(outlook.untilCompactMs)} · ${outlook.nowAt}% in ~${formatDuration(outlook.untilNowMs)}`
    : `Reaches it in ~${formatDuration(outlook.untilCompactMs)}`;
}
