/**
 * One governor tick: land what was delivered, continue what landed, deliver what is queued.
 *
 * Kept apart from `governor.ts`, which starts its timer on import, so a test can drive ticks against real files with
 * a fake daemon (`continuation.test.ts`). `io` is the daemon: `governor.ts` passes the real one.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentRow } from "./daemon.ts";
import {
  cancellation,
  compactionInstructions,
  confirmation,
  CONTINUATION_CAP_MS,
  continuationInstructions,
  continuationOwed,
  landed,
  NOT_COMPACTED,
  type CompactionRequest,
} from "../shared/governor.ts";
import { claimContinuation, readClaim, releaseClaim } from "./hooklib/continuation.mjs";
import { queue } from "./compaction-queue.ts";
import { readSettings } from "./settings.ts";
import { dataDir } from "./store.ts";

/** The daemon, as the tick uses it. The two `sendToAgent` calls below are Smart Compact's only messages. */
export interface TickIo<C> {
  withDaemon<T>(work: (client: C) => Promise<T>): Promise<T>;
  readAgents(client: C): Promise<AgentRow[]>;
  sendToAgent(client: C, agentId: string, text: string): Promise<void>;
}


/**
 * How long to keep watching an agent after a compaction, to record what it
 * achieved and to hand it back its state file. Compaction is a summarization turn;
 * a few minutes of ticks is plenty.
 */
const GRADE_WINDOW_MS = 5 * 60_000;

/**
 * Agents whose compaction we are still waiting to land.
 *
 * When it does, the post-compaction size is recorded, so the policy can be graded, and the request is confirmed.
 * Its continuation is then owed, read from the queue (`continueOwed`), so a reload or a long turn doesn't lose it.
 */
const grading = new Map<
  string,
  {
    requestId: string;
    deliveredAt: string;
    preTokens: number | null;
    until: number;
  }
>();

export async function flush<C>(io: TickIo<C>): Promise<void> {
  const settings = await readSettings();
  // The master switch. Off means a queued request waits rather than failing: the
  // agent asked for it, and turning the feature back on should honour that.
  if (!settings.enabled) return;

  const listed = await queue.list();
  const pending = listed.filter((item) => item.state === "pending");
  const owing = listed.some(mayOwe);
  // No queued work, nothing to land and nothing owed means no reason to open a connection.
  if (pending.length === 0 && grading.size === 0 && !owing) return;

  await io.withDaemon(async (client) => {
    const agents = new Map<string, AgentRow>();
    for (const agent of await io.readAgents(client)) agents.set(agent.id, agent);

    // Land compactions that have already happened. Read the hook's records only while one is out or owed.
    const events = grading.size > 0 || owing ? await compactionEvents() : [];
    for (const [agentId, watch] of [...grading]) {
      const agent = agents.get(agentId);
      if (Date.now() > watch.until || agent === undefined) {
        // Delivered, but the context never shrank: the /compact was cancelled or failed, unless the
        // session's own PostCompact hook says otherwise. Either way this decides it for good.
        grading.delete(agentId);
        await settleUnlanded(watch.requestId);
        continue;
      }
      // Claude Code cancelled it: a message replaced the /compact turn, or a Stop. The session's hook says so
      // (`hooks/cancelled.mjs`); settle now so a retry goes out at the next idle moment, not after the watch.
      const cancelled = await settleIfCancelled(watch.requestId, events);
      if (cancelled) {
        grading.delete(agentId);
        continue;
      }
      // The session's PostCompact/SessionStart:compact hook recorded it after delivery: confirmed now, whatever the
      // agent is doing. A person's message right after the compaction keeps it busy past any watch (2026-11-23).
      const recorded = confirmation({ agentId, state: "sent", settledAt: watch.deliveredAt, confirmedAt: null, postTokens: null }, events);
      const idle = agent.status === "idle" && agent.usedTokens !== null;
      if (recorded === null) {
        // Landed means the context really emptied. A wobble of a few tokens, or an idle session with no reading
        // from before, proves nothing: a cancelled /compact leaves the session idle at the same size.
        if (!idle || !landed(watch.preTokens, agent.usedTokens as number)) continue;
      }
      // The size after it, for grading, only while the session sits at it: a turn since has grown it again.
      await queue.update(watch.requestId, { postTokens: idle ? agent.usedTokens : null, confirmedAt: recorded ?? new Date().toISOString() });
      grading.delete(agentId);
    }

    // Continue what landed: at the next idle moment, unless a prompt that came first already carried it.
    const sentTo = await continueOwed(io, client, agents, events);

    for (const item of pending) {
      const agent = agents.get(item.agentId);
      if (agent === undefined || agent.status === "closed") {
        await queue.update(item.id, {
          state: "failed",
          error: "The target session is gone.",
          settledAt: new Date().toISOString(),
        });
        continue;
      }
      // Sending into a live turn steers it instead of arriving as its own
      // instruction, and compacting mid-turn discards exactly the working state the
      // agent has not written down yet. Wait for the next tick instead.
      if (agent.status !== "idle") continue;
      // Its continuation just went out this tick: the agent is busy now, whatever the snapshot says.
      if (sentTo.has(item.agentId)) continue;

      // Claim before sending, so a crash cannot produce a second /compact.
      const claimed = await queue.update(item.id, { state: "sending", preTokens: agent.usedTokens });
      try {
        await io.sendToAgent(client, item.agentId, compactionInstructions(claimed ?? item));
        const deliveredAt = new Date().toISOString();
        await queue.update(item.id, { state: "sent", settledAt: deliveredAt });
        grading.set(item.agentId, {
          requestId: item.id,
          deliveredAt,
          preTokens: agent.usedTokens,
          until: Date.now() + GRADE_WINDOW_MS,
        });
        console.log(`[smart-session] compacted ${item.agentId.slice(0, 8)} (${item.reason})`);
      } catch (error) {
        await queue.update(item.id, {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
          settledAt: new Date().toISOString(),
        });
      }
    }
  });
}

/**
 * A row that may owe a continuation, before the hook's records are read: it asked for one, none went out yet, and
 * it was delivered recently enough to still be confirmed and within `CONTINUATION_CAP_MS` of it.
 */
function mayOwe(item: CompactionRequest): boolean {
  if (item.state !== "sent" || item.settledAt === null || !item.continueAfterCompaction) return false;
  if (item.resumedAt !== null || item.resumedVia !== null || item.cancelledAt !== null || item.retriedBy !== null || item.error !== null) return false;
  return Date.now() - Date.parse(item.settledAt) < CONTINUATION_CAP_MS + GRADE_WINDOW_MS + OWED_SLACK_MS;
}

/** A compaction itself can take minutes; a row this far past its cap is never owed anything. */
const OWED_SLACK_MS = 60 * 60_000;

/** Requests whose continuation send failed in this process: never retried, though the next prompt may still carry it. */
const sendFailed = new Set<string>();

/**
 * Sends each owed continuation (`continuationOwed`) at the agent's next idle moment, exactly once.
 *
 * Invariant: a confirmed compaction's continuation is never silently dropped. The claim file
 * (`server/hooklib/continuation.mjs`) decides who delivers it: the governor here, or `hooks/continuation.mjs` on a
 * prompt that reached the session first; the queue records which (`resumedVia`). Past `CONTINUATION_CAP_MS` after
 * the compaction it is dropped, logged, and the popover says so. Returns the agents sent to.
 */
async function continueOwed<C>(io: TickIo<C>, client: C, agents: Map<string, AgentRow>, events: readonly CompactionEvent[]): Promise<Set<string>> {
  const sentTo = new Set<string>();
  for (const item of (await queue.list()).filter(mayOwe)) {
    const confirmed = continuationOwed(item, events);
    if (confirmed === null) continue;
    const who = item.agentId.slice(0, 8);
    if (item.confirmedAt === null) await queue.update(item.id, { confirmedAt: confirmed });

    // Someone already has it: record who, and never deliver it again.
    const claim = readClaim(item.id);
    if (claim !== null) {
      const via = claim.by === "prompt" ? "prompt" : claim.by === "stale" ? "stale" : "sent";
      await queue.update(item.id, { resumedVia: via, resumedAt: via === "stale" ? null : (claim.at ?? new Date().toISOString()) });
      if (via === "prompt") console.log(`[smart-session] ${who}'s continuation rode the next message after compacting`);
      continue;
    }

    if (Date.now() - Date.parse(confirmed) > CONTINUATION_CAP_MS) {
      if (claimContinuation(item.id, "stale")) {
        await queue.update(item.id, { resumedVia: "stale" });
        console.log(`[smart-session] dropped ${who}'s continuation: still not idle ${Math.round(CONTINUATION_CAP_MS / 60_000)} min after compacting`);
      }
      continue;
    }

    const agent = agents.get(item.agentId);
    if (agent === undefined || agent.status !== "idle" || sentTo.has(item.agentId) || sendFailed.has(item.id)) continue;
    const continuation = continuationInstructions(item);
    if (continuation === null || !claimContinuation(item.id, "governor")) continue;

    // A manual /compact leaves the session idle with the task abandoned: no hook fires afterwards that can start a
    // turn. Send one only when the requesting agent explicitly or implicitly chose to continue.
    try {
      sentTo.add(item.agentId);
      await io.sendToAgent(client, item.agentId, continuation);
      await queue.update(item.id, { resumedAt: new Date().toISOString(), resumedVia: "sent" });
      console.log(`[smart-session] sent ${who} its continuation after compacting`);
    } catch (error) {
      // The compaction itself succeeded. Not sent again from here (it may have arrived), but the next prompt may
      // still carry it, so the claim goes back.
      sendFailed.add(item.id);
      releaseClaim(item.id);
      console.error(`[smart-session] could not continue ${who}`, String(error));
    }
  }
  return sentTo;
}

type CompactionEvent = { agentId?: unknown; event?: unknown; at?: unknown; requestId?: unknown; cause?: unknown };

/** The session hooks' records: PostCompact/SessionStart (`hooks/post-compact.mjs`) and cancels (`hooks/cancelled.mjs`). */
async function compactionEvents(): Promise<CompactionEvent[]> {
  try {
    const raw = (await readFile(join(dataDir(), "compaction-events.jsonl"), "utf8")).slice(-65_536);
    return raw.split("\n").flatMap((line) => {
      try {
        const event = JSON.parse(line) as unknown;
        return event !== null && typeof event === "object" ? [event as CompactionEvent] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/**
 * Settles a delivered compaction the session recorded as cancelled, unless a compaction is confirmed after all.
 * True when it was settled (or already was).
 */
async function settleIfCancelled(requestId: string, events: readonly CompactionEvent[]): Promise<boolean> {
  const item = (await queue.list()).find((candidate) => candidate.id === requestId);
  if (item === undefined) return true;
  if (item.cancelledAt !== null) return true;
  if (confirmation(item, events) !== null) return false;
  const cancel = cancellation(item, events);
  if (cancel === null) return false;
  const settled = await queue.settleCancelled(requestId, cancel);
  if (settled !== null) {
    const who = item.agentId.slice(0, 8);
    console.log(settled.retry !== null
      ? `[smart-session] ${who}'s /compact was cancelled (${cancel.cause}); retry ${settled.retry.attempt} queued`
      : `[smart-session] ${who}'s /compact was cancelled (${cancel.cause}); not retried (${settled.verdict})`);
  }
  return true;
}

/** A delivered compaction whose watch ran out: confirmed by the hook's record, settled as cancelled, or marked as never compacted. */
async function settleUnlanded(requestId: string): Promise<void> {
  const item = (await queue.list()).find((candidate) => candidate.id === requestId);
  if (item === undefined || confirmation(item) !== null || item.cancelledAt !== null) return;
  const events = await compactionEvents();
  if (await settleIfCancelled(requestId, events)) return;
  const at = confirmation(item, events);
  await queue.update(requestId, at !== null ? { confirmedAt: at } : { error: NOT_COMPACTED });
  if (at === null) console.log(`[smart-session] ${item.agentId.slice(0, 8)}'s /compact was delivered but never compacted`);
}


/** Forgets what this process watched, on teardown (and between tests). */
export function resetTick(): void {
  grading.clear();
  sendFailed.clear();
}
