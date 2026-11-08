/**
 * Context growth, measured from recorded history.
 *
 * Lives in the server runtime rather than in the entry so its history and
 * filesystem dependencies can never cross into the client bundle.
 */

import { readContext } from "./store.ts";
import { profileFor, type Thresholds } from "../shared/thresholds.ts";

/**
 * How fast each agent's context is filling, in tokens per hour.
 *
 * Measured from what the recorder has actually seen rather than from the agent's
 * own bookkeeping: a rate is only meaningful over a span, and the span has to come
 * from somewhere that survives the turn.
 */
export async function contextGrowth(): Promise<Map<string, number>> {
  const MEASURE_MS = 2 * 60 * 60 * 1000;
  const MIN_SPAN_MS = 5 * 60 * 1000;
  const rows = await readContext({ sinceMs: Date.now() - MEASURE_MS });

  const byAgent = new Map<string, { firstAt: number; firstTokens: number; lastAt: number; lastTokens: number }>();
  for (const row of rows) {
    const at = Date.parse(row.at);
    const seen = byAgent.get(row.agentId);
    if (seen === undefined) {
      byAgent.set(row.agentId, { firstAt: at, firstTokens: row.usedTokens, lastAt: at, lastTokens: row.usedTokens });
      continue;
    }
    // A compaction resets the baseline: growth measured across one would be
    // negative and meaningless, so start again from the drop.
    if (row.usedTokens < seen.lastTokens) {
      byAgent.set(row.agentId, { firstAt: at, firstTokens: row.usedTokens, lastAt: at, lastTokens: row.usedTokens });
      continue;
    }
    seen.lastAt = at;
    seen.lastTokens = row.usedTokens;
  }

  const rates = new Map<string, number>();
  for (const [agentId, span] of byAgent) {
    const ms = span.lastAt - span.firstAt;
    if (ms < MIN_SPAN_MS) continue;
    rates.set(agentId, ((span.lastTokens - span.firstTokens) / ms) * 3_600_000);
  }
  return rates;
}

/**
 * When an agent's context would reach the point where compacting is the right call.
 *
 * Aimed at the window's own compact band, not at its ceiling: on a large window the
 * ceiling is never what bites first, so projecting to 100% would forecast a moment
 * nobody should ever reach.
 */
export function projectFull(
  usedTokens: number,
  maxTokens: number,
  ratePerHour: number | null,
  thresholds?: Thresholds,
  line: "compact" | "now" = "compact",
): string | null {
  if (ratePerHour === null || ratePerHour <= 0) return null;
  const room = maxTokens * (profileFor(maxTokens, thresholds)[line] / 100) - usedTokens;
  if (room <= 0) return new Date().toISOString();
  return new Date(Date.now() + (room / ratePerHour) * 3_600_000).toISOString();
}
