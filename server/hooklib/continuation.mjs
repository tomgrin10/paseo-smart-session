/**
 * The exactly-once handoff of a compaction's continuation, between the governor and the next prompt.
 *
 * Once a queued compaction is confirmed, its continuation is owed (`continuationOwed` in `shared/governor.ts`). Two
 * things may deliver it: the governor, as a message at the next idle moment, or `hooks/continuation.mjs`, as
 * `additionalContext` on a prompt that reached the session first (a person's message, an agent notification). Both
 * run in different processes, so neither reads the other's state: whoever creates `continuations/<requestId>.json`
 * (an exclusive create, `wx`) delivers it, and the other sees the file and stays quiet. The governor also claims it
 * to drop a stale one, so a late prompt can't carry it either.
 *
 * Shared with the server bundle (the governor), so it stays dependency-free like the rest of `server/hooklib/`.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { pluginDir } from "./pointer.mjs";

function claimPath(requestId) {
  if (typeof requestId !== "string" || requestId === "") return null;
  return join(pluginDir(), "continuations", `${requestId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

/**
 * Claims the continuation of `requestId` for `by` ("governor", "queued", "prompt" or "stale"). True only for the one caller
 * that created the claim; false when someone already has it or the claim could not be written (then nobody
 * delivers it from here, which is better than twice).
 */
export function claimContinuation(requestId, by, now = Date.now()) {
  const path = claimPath(requestId);
  if (path === null) return false;
  try {
    mkdirSync(join(pluginDir(), "continuations"), { recursive: true });
    writeFileSync(path, JSON.stringify({ by, at: new Date(now).toISOString() }), { encoding: "utf8", flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** Who claimed it and when, or null when nobody has. A claim that can't be read still counts as taken. */
export function readClaim(requestId) {
  const path = claimPath(requestId);
  if (path === null) return null;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const claim = JSON.parse(raw);
    return { by: typeof claim?.by === "string" ? claim.by : "unknown", at: typeof claim?.at === "string" ? claim.at : null };
  } catch {
    return { by: "unknown", at: null };
  }
}

/** Gives a claim back, only after the governor's send failed, so the next prompt can still carry it. */
export function releaseClaim(requestId) {
  const path = claimPath(requestId);
  if (path === null) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // A claim left in place costs the continuation, never a second one.
  }
}
