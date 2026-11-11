/**
 * Smart Session as one of Paseo's usage sources (Paseo 0.16+), so its forecast and
 * every ZeroSub account show in Paseo's own usage popover, Usage screen and summary.
 *
 * Registered only when the host has `registerUsageSource`; on 0.14/0.15 nothing
 * happens. It reads what Smart Session already holds: the subscriptions view (ZeroSub's
 * usage and state files plus Smart Session's own account history, cached 10 s) and the
 * recorder's history. It polls nothing and opens no credential file; Paseo caches each
 * report for five minutes on top.
 *
 * The id must never be Paseo's own `claude`: a taken id throws, and the daemon then
 * stops the whole plugin.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { capture, captured, noteBuilt, readBuiltin, realign } from "./builtin-usage.ts";
import type { DaemonClient } from "./daemon.ts";
import { zerosubInstallId } from "./guard/zerosub.ts";
import { readUsage } from "./store.ts";
import { subscriptionsView, windowsFrom } from "./subscriptions.ts";
import { effectiveAt } from "../shared/usage.ts";
import {
  USAGE_SOURCE_ID,
  USAGE_SOURCE_LABEL,
  buildReport,
  discoverAccounts,
  emailHashOf,
  hideableCards,
  parseExtras,
  withBuiltin,
  type SourceState,
  type UsageScopeIn,
} from "../shared/usage-source.ts";
import type { PluginServerContext } from "@getpaseo/plugin/server";

const DAY = 24 * 60 * 60_000;
const CACHE_MS = 10_000;

const paseoHome = () => process.env.PASEO_HOME ?? join(homedir(), ".paseo");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** The recorder's own reading of the CLI login: windows with pace, when it was read, extra usage. */
async function recordedLogin(now: number): Promise<SourceState["recorded"]> {
  const samples = await readUsage({ sinceMs: now - 8 * DAY });
  const newest = samples[samples.length - 1];
  if (!newest) return null;
  const readAt = effectiveAt(newest);
  const { windows } = windowsFrom(samples, readAt, now);
  return { windows, readAt, extraUsage: newest.credits ? newest.credits.enabled : null };
}

let cached: { at: number; state: SourceState } | null = null;

/** Everything the source answers from, read at most every ten seconds. */
export async function sourceState(now = Date.now()): Promise<SourceState> {
  if (cached && now - cached.at < CACHE_MS) return cached.state;
  const [view, recorded] = await Promise.all([subscriptionsView(now), recordedLogin(now).catch(() => null)]);
  let zerosub: SourceState["zerosub"] = null;
  if (view.zerosub) {
    const home = paseoHome();
    const id = await zerosubInstallId(home).catch(() => null);
    const dir = join(home, "zerosub");
    const [state, usage] = id === null ? [undefined, undefined] : await Promise.all([readJson(join(dir, "state.json")), readJson(join(dir, "usage.json"))]);
    const parsed = parseExtras(state, usage, sha256);
    // The CLI login's extra usage comes from the recorder, which reads its usage response.
    const main = view.accounts.find((a) => a.family === "claude" && a.kind === "main");
    if (main && recorded?.extraUsage != null && parsed.extras[main.id]?.extraUsage == null) {
      parsed.extras[main.id] = { ...(parsed.extras[main.id] ?? { emailHash: null, plan: null, windowLabels: {} }), extraUsage: recorded.extraUsage };
    }
    zerosub = { accounts: view.accounts, autoSwitch: view.autoSwitch, ...parsed };
  }
  const state: SourceState = { zerosub, recorded };
  cached = { at: now, state };
  return state;
}

export function forgetSourceState(): void {
  cached = null;
}

const InputSchema = z.object({ account: z.string().min(1), lead: z.boolean() });

/** The host's `registerUsageSource`, when it has one (Paseo 0.16+). */
type WithUsage = PluginServerContext & { registerUsageSource?: (source: unknown) => void };

/** Registers the source when the host supports usage sources. Returns whether it did. */
export function contributeUsageSource(server: PluginServerContext): boolean {
  const register = (server as WithUsage).registerUsageSource;
  if (typeof register !== "function") return false;
  try {
    register.call(server, {
      id: USAGE_SOURCE_ID,
      label: USAGE_SOURCE_LABEL,
      icon: "assets/icon.svg",
      input: InputSchema,
      discover: async (scope: UsageScopeIn) => discoverAccounts(await sourceState(), scope),
      fetch: async (input: z.infer<typeof InputSchema>) => {
        const state = await sourceState();
        const hash = state.zerosub?.extras[input.account]?.emailHash ?? null;
        // Paseo's own card for this login, from the daemon's cache or the fetch in flight beside ours.
        const reading = await readBuiltin(hash);
        const report = buildReport(withBuiltin(state, captured), input, Date.now());
        noteBuilt(hash, reading);
        return report;
      },
    });
    return true;
  } catch (error) {
    // Never let the usage card take the rest of Smart Session down with it.
    console.warn("[smart-session] usage source not registered:", error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** For the client's hide: which of our cards may stand in for Paseo's own Claude card right now. */
export async function usageCards(now = Date.now()) {
  return { cards: hideableCards(withBuiltin(await sourceState(now), captured), now, captured) };
}

/**
 * The recorder's minute tick, with the daemon's whole usage listing in hand: keep the
 * built-in readings, then refresh any report of ours built from an older one.
 */
export async function onUsageListing(client: DaemonClient, entries: readonly unknown[]): Promise<void> {
  const state = await sourceState();
  capture(entries, (key) => emailHashOf(state, key));
  await realign(client);
}
