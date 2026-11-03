/**
 * The recorder: the one piece that has to be running before anything else is worth
 * building.
 *
 * Plan-utilization history is not kept anywhere — `/usage` is a snapshot, Paseo's
 * quota fetcher has no store, and Claude Code's on-disk copy is overwritten in
 * place. Tokens can be reconstructed from transcripts after the fact; percentages
 * of a plan limit cannot. Every hour this is not running is an hour of history that
 * cannot be recovered later, which is why it starts on import and does its own
 * thing whether or not any UI is open.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { scanSpend } from "./backfill.ts";
import { readAgents, readProviderUsage, withDaemon } from "./daemon.ts";
import { lifecycle } from "../shared/lifecycle.ts";
import {
  appendContext,
  appendUsage,
  clearCaches,
  newestUsage,
  noteAcceptedReading,
  noteNewestUsage,
  type ContextSample,
} from "./store.ts";
import { fetchUpstreamUsage } from "./upstream.ts";
import {
  acceptReading,
  effectiveAt,
  fromClaudeJson,
  fromPaseoProviderUsage,
  fromUpstream,
  isWorthRecording,
  type UsageSample,
} from "../shared/usage.ts";

const TICK_MS = 60_000;

/**
 * How often to ask Anthropic directly.
 *
 * Paseo's reading is free but bounded at five minutes old, and there is no way to
 * force it to refresh — `forceRefresh` exists in the daemon but is not in the wire
 * schema, so a client cannot ask for it. Fetching upstream ourselves is what makes
 * the history actually true rather than approximately true. Three minutes keeps the
 * worst-case error under half of Paseo's, without asking more often than a Claude
 * Code session would on its own.
 */
const UPSTREAM_TICK_MS = 3 * 60_000;

/**
 * How stale things must get before Claude Code's on-disk cache is worth reading.
 *
 * It only refreshes when a session refreshes it — in practice when someone runs
 * `/usage` — and has been measured 14 hours behind, understating a weekly window by
 * 7 points. It is a fallback for when both live sources fail, nothing more.
 */
const CACHE_FALLBACK_AFTER_MS = 15 * 60_000;

/**
 * How often to fold new transcript lines into the spend index.
 *
 * The scan is incremental, so this is cheap after the first pass; ten minutes keeps
 * the attribution current without re-reading the world.
 */
const SPEND_SCAN_MS = 10 * 60_000;

/** Where Claude Code keeps the usage payload it last fetched. */
function claudeJsonPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return configDir !== undefined && configDir !== ""
    ? join(configDir, ".claude.json")
    : join(homedir(), ".claude.json");
}

/**
 * Records a reading if it is both new and credible.
 *
 * Two of the three sources are caches that can hand back something hours old, so
 * "did this actually happen after what I already have" is asked before "is this
 * different from what I already have".
 */
async function record(sample: UsageSample): Promise<boolean> {
  const newest = await newestUsage();
  const verdict = acceptReading(newest, sample);
  if (!verdict.ok) return false;
  noteAcceptedReading(sample);
  if (!isWorthRecording(newest, sample)) return false;
  await appendUsage(sample);
  noteNewestUsage(sample);
  return true;
}

/**
 * Claude Code's cache, read only when it has actually changed.
 *
 * It refreshes only when a Claude Code session refreshes it — in practice when
 * someone runs `/usage` — so most ticks find it untouched and skip the read
 * entirely. When it does move it is free extra resolution between daemon polls,
 * never a substitute for them: `acceptReading` throws it out if it turns out to be
 * older than what the daemon already told us.
 */
let lastClaudeJsonMtimeMs = 0;

async function pollClaudeJson(): Promise<void> {
  // Only when nothing live has answered for a while: a stale reading that gets
  // rejected still costs a file read, and one that gets accepted is only better
  // than nothing.
  const newest = await newestUsage();
  if (newest !== null && Date.now() - Date.parse(effectiveAt(newest)) < CACHE_FALLBACK_AFTER_MS) return;

  const path = claudeJsonPath();
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    return; // No Claude Code on this machine, or no config yet.
  }
  if (mtimeMs === lastClaudeJsonMtimeMs) return;
  lastClaudeJsonMtimeMs = mtimeMs;

  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { cachedUsageUtilization?: unknown };
    const sample = fromClaudeJson(parsed.cachedUsageUtilization);
    if (sample !== null) await record(sample);
  } catch (error) {
    console.error("[smart-session] could not read Claude's usage cache", String(error));
  }
}

/** Last context reading per agent, so only movement is written. */
const lastContext = new Map<string, number>();

let lastUpstreamMs = 0;
let lastSpendScanMs = 0;
let authWarned = false;

async function pollSpend(): Promise<void> {
  if (Date.now() - lastSpendScanMs < SPEND_SCAN_MS) return;
  lastSpendScanMs = Date.now();
  try {
    const result = await scanSpend();
    if (result.messagesCounted > 0) {
      console.log(`[smart-session] folded ${result.messagesCounted} message(s) into the spend index`);
    }
  } catch (error) {
    console.error("[smart-session] spend scan failed", String(error));
  }
}

/**
 * Asks Anthropic directly, on its own slower cadence.
 *
 * Failure here is not an error worth stopping for: the daemon poll still runs, and
 * an expired credential is something only the user can fix, so it is said once
 * rather than every three minutes.
 */
async function pollUpstream(): Promise<void> {
  if (Date.now() - lastUpstreamMs < UPSTREAM_TICK_MS) return;
  lastUpstreamMs = Date.now();

  const result = await fetchUpstreamUsage();
  if (result.kind === "needs-auth") {
    if (!authWarned) {
      authWarned = true;
      console.error(
        "[smart-session] Claude credentials are expired or unreadable; falling back to Paseo's cached usage, which can be up to five minutes old. Log in with the Claude CLI to restore direct readings.",
      );
    }
    return;
  }
  if (result.kind === "unavailable") {
    console.error("[smart-session] upstream usage unavailable", result.reason);
    return;
  }

  authWarned = false;
  const sample = fromUpstream(result.body);
  if (sample !== null) await record(sample);
}

async function pollDaemon(): Promise<void> {
  await withDaemon(async (client) => {
    const at = new Date().toISOString();

    const usage = fromPaseoProviderUsage(await readProviderUsage(client));
    if (usage !== null) await record(usage);

    for (const agent of await readAgents(client)) {
      if (agent.usedTokens === null || agent.maxTokens === null) continue;
      if (lastContext.get(agent.id) === agent.usedTokens) continue;
      lastContext.set(agent.id, agent.usedTokens);
      const row: ContextSample = {
        at,
        agentId: agent.id,
        usedTokens: agent.usedTokens,
        maxTokens: agent.maxTokens,
        costUsd: agent.costUsd,
        provider: agent.provider,
        model: agent.model,
        status: agent.status,
        title: agent.title,
      };
      await appendContext(row);
    }
  });
}

/**
 * Starts the recorder as an import side effect and registers its teardown.
 *
 * `contribute()` cannot call this: Paseo strips `*.server` imports from the client
 * bundle while keeping the surrounding statements, so a server identifier in that
 * shared body becomes a ReferenceError that aborts every registration. Teardown
 * still has to run from `contribute()`'s cleanup, or the interval keeps the
 * subprocess alive and Paseo's stop step hangs, which wedges reload. The shared
 * `lifecycle` object bridges the two safely.
 */
function startRecorder(): void {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return; // One tick at a time; a slow daemon must not pile up.
    running = true;
    try {
      // Order matters: the freshest source first, so the acceptance gate has the
      // best reading to compare the others against.
      await pollUpstream();
      await pollDaemon();
      await pollClaudeJson();
      await pollSpend();
    } catch (error) {
      // A daemon restart, a lost socket, a machine asleep — none of these should
      // end the recorder. The gap is visible in the data, which is the honest
      // outcome; a dead timer would not be.
      console.error("[smart-session] tick failed", String(error));
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  void tick();

  lifecycle.teardowns.push(() => {
    stopped = true;
    clearInterval(timer);
    lastContext.clear();
    clearCaches();
  });
}

startRecorder();
