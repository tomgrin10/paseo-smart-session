/**
 * Delivery for compaction requests.
 *
 * The queue lives on the daemon so a request survives a plugin reload, a Paseo
 * restart, and the client that made it going away. Delivery waits for the target
 * agent to be idle, then sends `/compact <instructions>` — which Paseo routes as a
 * real command rather than as text the model reads.
 *
 * This file decides nothing. Every request in the queue was put there by the agent
 * it belongs to, or by a person; the governor's whole job is to carry it out at a
 * moment when doing so is safe, and then, when requested, to hand the emptied
 * session back its state file. Those are the only things this plugin ever says to
 * an agent.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { readAgents, sendToAgent, withDaemon, type AgentRow } from "./daemon.ts";
import { cancellation, compactionInstructions, confirmation, continuationInstructions, landed, NOT_COMPACTED } from "../shared/governor.ts";
import { queue } from "./compaction-queue.ts";
import { lifecycle } from "../shared/lifecycle.ts";
import { readSettings } from "./settings.ts";
import { dataDir } from "./store.ts";

export { queue };

const TICK_MS = 15_000;

/**
 * How long to keep watching an agent after a compaction, to record what it
 * achieved and to hand it back its state file. Compaction is a summarization turn;
 * a few minutes of ticks is plenty.
 */
const GRADE_WINDOW_MS = 5 * 60_000;

/**
 * Agents whose compaction we are still waiting to land.
 *
 * Two things happen when it does: the post-compaction size is recorded, so the
 * policy can be graded, and, if the agent requested it, the emptied session is
 * sent its chosen continuation. Nothing else will start that turn — see
 * `continuationInstructions`.
 */
const grading = new Map<
  string,
  {
    requestId: string;
    deliveredAt: string;
    preTokens: number | null;
    statePath: string | null;
    continueAfterCompaction: boolean;
    continuationMessage: string | null;
    until: number;
  }
>();

async function flush(): Promise<void> {
  const settings = await readSettings();
  // The master switch. Off means a queued request waits rather than failing: the
  // agent asked for it, and turning the feature back on should honour that.
  if (!settings.enabled) return;

  const pending = (await queue.list()).filter((item) => item.state === "pending");
  // No queued work and nothing to land means no reason to open a connection.
  if (pending.length === 0 && grading.size === 0) return;

  await withDaemon(async (client) => {
    const agents = new Map<string, AgentRow>();
    for (const agent of await readAgents(client)) agents.set(agent.id, agent);

    // Land compactions that have already happened. Read the hook's records only while one is out.
    const events = grading.size > 0 ? await compactionEvents() : [];
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
      if (agent.status !== "idle" || agent.usedTokens === null) continue;
      // Landed means the context really emptied, or the session's PostCompact hook says it compacted.
      // A wobble of a few tokens, or an idle session with no reading from before, proves nothing: a
      // cancelled /compact leaves the session idle at the same size.
      const recorded = confirmation({ agentId, state: "sent", settledAt: watch.deliveredAt, confirmedAt: null, postTokens: null }, events);
      if (!landed(watch.preTokens, agent.usedTokens) && recorded === null) continue;
      await queue.update(watch.requestId, { postTokens: agent.usedTokens, confirmedAt: recorded ?? new Date().toISOString() });
      grading.delete(agentId);

      const continuation = continuationInstructions(watch);
      if (continuation === null) {
        console.log(`[smart-session] compacted ${agentId.slice(0, 8)} without a continuation, as requested`);
        continue;
      }

      // A manual /compact leaves the session idle with the task abandoned: no hook
      // fires afterwards that can start a turn. Send one only when the requesting
      // agent explicitly or implicitly chose to continue.
      try {
        await sendToAgent(client, agentId, continuation);
        await queue.update(watch.requestId, { resumedAt: new Date().toISOString() });
        console.log(`[smart-session] sent ${agentId.slice(0, 8)} its continuation after compacting`);
      } catch (error) {
        // The compaction itself succeeded; failing to restart the task is worth a
        // line in the log, not a failed request.
        console.error(`[smart-session] could not continue ${agentId.slice(0, 8)}`, String(error));
      }
    }

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

      // Claim before sending, so a crash cannot produce a second /compact.
      const claimed = await queue.update(item.id, { state: "sending", preTokens: agent.usedTokens });
      try {
        await sendToAgent(client, item.agentId, compactionInstructions(claimed ?? item));
        const deliveredAt = new Date().toISOString();
        await queue.update(item.id, { state: "sent", settledAt: deliveredAt });
        grading.set(item.agentId, {
          requestId: item.id,
          deliveredAt,
          preTokens: agent.usedTokens,
          statePath: item.statePath,
          continueAfterCompaction: item.continueAfterCompaction,
          continuationMessage: item.continuationMessage,
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

function startGovernor(): void {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await flush();
    } catch (error) {
      console.error("[smart-session] governor tick failed", String(error));
    } finally {
      running = false;
    }
  };

  void queue
    .recoverInterrupted()
    .then((count) => {
      if (count > 0) console.error(`[smart-session] failed ${count} compaction(s) interrupted by a restart`);
    })
    .catch((error: unknown) => console.error("[smart-session] recovery failed", String(error)))
    .then(tick);

  const timer = setInterval(() => void tick(), TICK_MS);

  lifecycle.teardowns.push(() => {
    stopped = true;
    clearInterval(timer);
    grading.clear();
  });
}

startGovernor();
