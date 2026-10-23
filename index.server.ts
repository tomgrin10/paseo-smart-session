import { displayPreferences } from "./shared/display";
import type { PluginServerContext } from "@getpaseo/plugin/server";

import { readAgents, withDaemon } from "./server/daemon.ts";
import { contextGrowth, projectFull } from "./server/growth.ts";
import { install } from "./server/install.ts";
import { summarizeSpend } from "./server/spend.ts";
import { countEnrolled, listEnrolment, readSettings, setEnrolled, writeSettings } from "./server/settings.ts";
import { dataDir, newestUsage, readUsage } from "./server/store.ts";
import {
  budgetStatus,
  contextStatus,
  getSettings,
  installStatus,
  setSettings,
  spendSummary,
} from "./shared/smart-session.ts";

import {
  cancelCompaction,
  enrolmentState,
  listCompactions,
  requestCompaction,
  setEnrolment,
} from "./shared/governor.ts";
import { burnRatePctPerHour, projectedExhaustion, segmentBlocks } from "./shared/blocks.ts";
import { lifecycle } from "./shared/lifecycle.ts";
import { profileFor } from "./shared/thresholds.ts";
import { effectiveAt } from "./shared/usage.ts";

// Importing the recorder for its side effect: it starts on load and records
// whether or not anything is looking at it. See server/recorder.ts.
import "./server/recorder.ts";
// Same: the governor owns the compaction queue and its delivery timer.
import { queue } from "./server/governor.ts";
// Same again: this one registers the plugin's hooks with Claude Code on load. The
// `Stop` hook is what asks a session to compact itself, so an install without it
// reports "on" and does nothing at all.
import "./server/install-on-load.ts";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(displayPreferences);
  server.handle(budgetStatus, async () => {
    try {
      const since = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const samples = await readUsage({ sinceMs: since });
      const newest = await newestUsage();

      // One row per window, taken from its currently open block.
      const open = new Map<string, ReturnType<typeof segmentBlocks>[number]>();
      for (const block of segmentBlocks(samples)) open.set(block.windowId, block);

      const windows = [...open.values()]
        .map((block) => ({
          id: block.windowId,
          pct: block.finalPct,
          resetsAt: block.resetsAt,
          burnPctPerHour: burnRatePctPerHour(block),
          projectedFullAt: projectedExhaustion(block),
        }))
        .sort((a, b) => b.pct - a.pct);

      const newestInstant = newest === null ? null : effectiveAt(newest);
      return {
        windows,
        recorder: {
          newestAt: newestInstant,
          ageSeconds:
            newestInstant === null ? null : Math.round((Date.now() - Date.parse(newestInstant)) / 1000),
          source: newest?.src ?? null,
          samplesHeld: samples.length,
          firstSampleAt: samples.length === 0 ? null : effectiveAt(samples[0]!),
          dataDir: dataDir(),
        },
        error: null,
      };
    } catch (error) {
      return {
        windows: [],
        recorder: {
          newestAt: null,
          ageSeconds: null,
          source: null,
          samplesHeld: 0,
          firstSampleAt: null,
          dataDir: dataDir(),
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  server.handle(contextStatus, async ({ agentId }) => {
    try {
      const rows = await withDaemon((client) => readAgents(client));
      const growth = await contextGrowth();
      const { thresholds } = await readSettings();
      const agents = rows
        .filter((row) => agentId === undefined || row.id === agentId)
        .filter((row) => row.usedTokens !== null && row.maxTokens !== null && row.maxTokens > 0)
        .map((row) => ({
          agentId: row.id,
          title: row.title,
          provider: row.provider,
          model: row.model,
          status: row.status,
          usedTokens: row.usedTokens!,
          maxTokens: row.maxTokens!,
          usedPct: Math.round((row.usedTokens! / row.maxTokens!) * 1000) / 10,
          costUsd: row.costUsd,
          growthTokensPerHour: growth.get(row.id) ?? null,
          projectedFullAt: projectFull(row.usedTokens!, row.maxTokens!, growth.get(row.id) ?? null, thresholds),
          compactAtPct: profileFor(row.maxTokens!, thresholds).compact,
        }))
        .sort((a, b) => b.usedPct - a.usedPct);
      return { agents, error: null };
    } catch (error) {
      return { agents: [], error: error instanceof Error ? error.message : String(error) };
    }
  });

  server.handle(spendSummary, async ({ days }) => {
    try {
      return { summary: await summarizeSpend({ days }), error: null };
    } catch (error) {
      return {
        summary: {
          byDay: [], heatmap: [], byProject: [], byModel: [],
          totalTokens: 0, subagentTokens: 0, cacheHitPct: 0,
          firstHour: null, lastHour: null, bucketCount: 0,
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  server.handle(getSettings, async () => ({
    settings: await readSettings(),
    enrolledAgents: await countEnrolled(),
  }));

  server.handle(setSettings, async (patch) => {
    const settings = await writeSettings(patch);
    // Reconciled here as well as on load, so turning the switch off removes the
    // hooks immediately rather than at the next reload.
    if (patch.installHooks !== undefined) void install().catch(() => undefined);
    return { settings };
  });

  server.handle(installStatus, async () => ({ report: await install() }));

  server.handle(
    requestCompaction,
    async ({ agentId, reason, statePath, continueAfterCompaction, continuationMessage }) => ({
      request: await queue.add({
        agentId,
        reason,
        statePath: statePath ?? null,
        continueAfterCompaction: continueAfterCompaction ?? true,
        continuationMessage: continueAfterCompaction === false ? null : (continuationMessage ?? null),
      }),
    }),
  );

  server.handle(listCompactions, async ({ agentId }) => {
    const items = await queue.list();
    return {
      items: (agentId === undefined ? items : items.filter((item) => item.agentId === agentId)).sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      ),
    };
  });

  server.handle(cancelCompaction, async ({ id }) => {
    const updated = await queue.update(id, {
      state: "cancelled",
      settledAt: new Date().toISOString(),
    });
    return { ok: updated !== null };
  });

  server.handle(enrolmentState, async () => {
    const settings = await readSettings();
    return { showPill: settings.showPill, enabled: settings.enabled, agents: await listEnrolment() };
  });

  server.handle(setEnrolment, async ({ agentId, enrolled }) => ({
    agent: await setEnrolled(agentId, enrolled),
  }));

  // The recorder and governor register their timers in this shared lifecycle.
  // Paseo waits for this cleanup before stopping the plugin subprocess.
  return async () => {
    const teardowns = lifecycle.teardowns.splice(0);
    for (const teardown of teardowns) await teardown();
  };
}
