/**
 * The compaction queue on disk (`compactions.json`): read, written and settled through one serializer.
 *
 * Kept apart from `governor.ts`, which starts its timer on import, so the rules that write here can
 * be tested against real files.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { cancelledError, confirmation, retryRequest, retryVerdict, type Cancellation, type CompactionRequest, type RetryVerdict } from "../shared/governor.ts";
import { dataDir } from "./store.ts";

const queuePath = () => join(dataDir(), "compactions.json");

let tail: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  tail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Fills in fields added after a row was written.
 *
 * The queue is validated against `CompactionRequestSchema` on its way out over the
 * RPC boundary, so a row from an older version missing a key would fail there
 * rather than here. Defaulting on read is the migration.
 */
function normalize(item: CompactionRequest): CompactionRequest {
  return {
    ...item,
    continueAfterCompaction: item.continueAfterCompaction ?? true,
    continuationMessage: item.continuationMessage ?? null,
    resumedAt: item.resumedAt ?? null,
    confirmedAt: item.confirmedAt ?? null,
    attempt: item.attempt ?? 0,
    retryOf: item.retryOf ?? null,
    retriedBy: item.retriedBy ?? null,
    cancelledAt: item.cancelledAt ?? null,
    cancelCause: item.cancelCause ?? null,
  };
}

async function readAll(): Promise<CompactionRequest[]> {
  try {
    const raw = await readFile(queuePath(), "utf8");
    const parsed = JSON.parse(raw) as { version?: number; items?: CompactionRequest[] };
    return (parsed.items ?? []).map(normalize);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") console.error("[smart-session] could not read the compaction queue", String(error));
    return [];
  }
}

async function writeAll(items: CompactionRequest[]): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  const target = queuePath();
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ version: 1, items }, null, 2), "utf8");
  await rename(temp, target);
}

export const queue = {
  list: (): Promise<CompactionRequest[]> => serialize(readAll),

  add: (input: {
    agentId: string;
    reason: string;
    statePath: string | null;
    continueAfterCompaction: boolean;
    continuationMessage: string | null;
  }): Promise<CompactionRequest> =>
    serialize(async () => {
      const items = await readAll();
      const request: CompactionRequest = {
        id: randomUUID(),
        agentId: input.agentId,
        reason: input.reason,
        statePath: input.statePath,
        continueAfterCompaction: input.continueAfterCompaction,
        continuationMessage: input.continuationMessage,
        createdAt: new Date().toISOString(),
        state: "pending",
        settledAt: null,
        confirmedAt: null,
        error: null,
        preTokens: null,
        postTokens: null,
        resumedAt: null,
        attempt: 0,
        retryOf: null,
        retriedBy: null,
        cancelledAt: null,
        cancelCause: null,
      };
      items.push(request);
      await writeAll(items);
      return request;
    }),

  update: (id: string, patch: Partial<CompactionRequest>): Promise<CompactionRequest | null> =>
    serialize(async () => {
      const items = await readAll();
      const found = items.find((item) => item.id === id);
      if (found === undefined) return null;
      Object.assign(found, patch);
      await writeAll(items);
      return found;
    }),

  /**
   * Settles a delivered `/compact` that Claude Code cancelled, and queues its retry when
   * `retryVerdict` says so, in one write.
   *
   * This is not the governor deciding to compact: the retry is the same request the agent made,
   * queued again because the session reported that none ran ("Compaction canceled."). Unlike a
   * send cut off by a restart (below), there is no doubt here about whether it ran.
   */
  settleCancelled: (id: string, cancel: Cancellation, now = Date.now()): Promise<{ verdict: RetryVerdict; retry: CompactionRequest | null } | null> =>
    serialize(async () => {
      const items = await readAll();
      const item = items.find((candidate) => candidate.id === id);
      if (item === undefined || item.state !== "sent" || item.cancelledAt !== null || confirmation(item) !== null) return null;
      const verdict = retryVerdict(items, item, cancel.cause, now);
      const retry = verdict === "retry" ? retryRequest(item, randomUUID(), new Date(now).toISOString()) : null;
      if (retry !== null) items.push(retry);
      Object.assign(item, { cancelledAt: cancel.at, cancelCause: cancel.cause, error: cancelledError(verdict), retriedBy: retry?.id ?? null });
      await writeAll(items);
      return { verdict, retry };
    }),

  /**
   * A request interrupted mid-send is failed, never retried.
   *
   * `/compact` is destructive and not idempotent: sending a second one after a
   * restart could discard a context the first one already summarized. Failing
   * closed costs one compaction; retrying could cost the task.
   */
  recoverInterrupted: (): Promise<number> =>
    serialize(async () => {
      const items = await readAll();
      let count = 0;
      for (const item of items) {
        if (item.state !== "sending") continue;
        item.state = "failed";
        item.error = "The plugin stopped while sending; not retried, because a second /compact is destructive.";
        item.settledAt = new Date().toISOString();
        count += 1;
      }
      if (count > 0) await writeAll(items);
      return count;
    }),
};
