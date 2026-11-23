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

import { readAgents, sendToAgent, withDaemon } from "./daemon.ts";
import { flush, resetTick } from "./compaction-tick.ts";
import { queue } from "./compaction-queue.ts";
import { lifecycle } from "../shared/lifecycle.ts";

export { queue };

const TICK_MS = 15_000;

function startGovernor(): void {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await flush({ withDaemon, readAgents, sendToAgent });
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
    resetTick();
  });
}

startGovernor();
