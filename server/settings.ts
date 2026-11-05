/**
 * Plugin settings, on disk next to the data.
 *
 * Paseo has no plugin-settings API, so preferences are our own file — the same
 * approach paseo-defer takes.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";

import { dataDir } from "./store.ts";
import { DEFAULT_THRESHOLDS, normalizeThresholds, type Thresholds } from "../shared/thresholds.ts";

export interface Settings {
  /**
   * The master switch: whether Smart Compact runs at all.
   *
   * Off means the `Stop` hook never asks, the pill is not drawn, and a queued
   * compaction is not delivered. It is the one control that has to be
   * unambiguous, because everything else here only qualifies it.
   *
   * On by default. It was safe to make it so once the plugin lost the ability to
   * compact a session that had not asked: the worst it can now do is put a
   * question to an agent that ignores it.
   */
  readonly enabled: boolean;
  /**
   * When a context counts as too full, per window size.
   *
   * The `Stop` hook asks at the `compact` band of whichever profile applies, so a
   * 1M session is asked at 300k rather than being left to drift to 850k.
   */
  readonly thresholds: Thresholds;
  /** A state file older than this is treated as not describing the current work. */
  readonly freshStateMinutes: number;
  /**
   * Whether every agent's composer carries the smart-compact pill.
   *
   * On by default. Enrolment is otherwise invisible — it is a file on disk — and a
   * governor you cannot see the state of is one you stop trusting.
   */
  readonly showPill: boolean;
  /**
   * Whether a session that checkpoints is enrolled without being asked.
   *
   * This is the on-by-default-or-opt-in choice. On, an agent that has used the
   * checkpoint tool has shown it knows this system exists, and that is taken as
   * consent. Off, nothing is inferred and a session is governed only when someone
   * presses its pill. An explicit answer outranks either way round.
   */
  readonly autoEnrol: boolean;
  /**
   * Whether the plugin keeps its hooks registered in Claude Code for us.
   *
   * On by default, because the `Stop` hook is the only thing that ever asks a
   * session to compact itself: without it this plugin records and shows charts and
   * otherwise does nothing, which is a worse failure than an unexpected write —
   * it looks like it is working. Off removes every entry it added.
   *
   * See `server/install.ts` for what it will and will not touch.
   */
  readonly installHooks: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  thresholds: DEFAULT_THRESHOLDS,
  freshStateMinutes: 30,
  showPill: true,
  autoEnrol: true,
  installHooks: true,
};

const filePath = () => join(dataDir(), "settings.json");

let cached: Settings | null = null;

export async function readSettings(): Promise<Settings> {
  if (cached !== null) return cached;
  try {
    const raw = JSON.parse(await readFile(filePath(), "utf8")) as Partial<Settings>;
    cached = {
      // Absent in every file written before v0.3. Those installs had `autopilot`,
      // which meant "compact without being asked" and no longer exists; the
      // feature they are upgrading into can only ask, so it starts on.
      enabled: raw.enabled !== false,
      thresholds: normalizeThresholds(raw.thresholds),
      freshStateMinutes: clamp(raw.freshStateMinutes ?? DEFAULT_SETTINGS.freshStateMinutes, 1, 24 * 60),
      showPill: raw.showPill !== false,
      autoEnrol: raw.autoEnrol !== false,
      installHooks: raw.installHooks !== false,
    };
  } catch {
    cached = DEFAULT_SETTINGS;
  }
  return cached;
}

export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const next: Settings = { ...(await readSettings()), ...patch };
  const settings: Settings = {
    enabled: next.enabled !== false,
    thresholds: normalizeThresholds(next.thresholds),
    freshStateMinutes: clamp(next.freshStateMinutes, 1, 24 * 60),
    showPill: next.showPill !== false,
    autoEnrol: next.autoEnrol !== false,
    installHooks: next.installHooks !== false,
  };
  await mkdir(dataDir(), { recursive: true });
  const target = filePath();
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(settings, null, 2), "utf8");
  await rename(temp, target);
  cached = settings;
  return settings;
}

export function clearSettingsCache(): void {
  cached = null;
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

/** Where an agent's durable task state lives; mirrors the agent-facing tool. */
export function statePathFor(agentId: string): string {
  return join(dataDir(), "state", `${agentId}.md`);
}

/** When an agent last wrote its task state, or null when it never has. */
export function stateWrittenAt(agentId: string): string | null {
  try {
    return new Date(statSync(statePathFor(agentId)).mtimeMs).toISOString();
  } catch {
    return null;
  }
}


/**
 * Whether the governor may speak to one agent, and who decided.
 *
 * Implicit by default: an agent that has written a state file has used the
 * checkpoint tool, and so knows this system exists. One that has not is never
 * spoken to, however full it gets. `autoEnrol` turns that inference off entirely,
 * which is the difference between on-by-default and opt-in. A person can override
 * either way — that is what the pill on the composer writes — and an explicit
 * answer always outranks the inferred one.
 */
export interface AgentEnrolment {
  readonly agentId: string;
  readonly enrolled: boolean;
  /** True when a person said so, false when it was inferred from a state file. */
  readonly explicit: boolean;
}

const overridesPath = () => join(dataDir(), "enrolment.json");

/** One writer at a time: a toggle is read-modify-write over a shared file. */
let tail: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  tail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function readOverrides(): Promise<Record<string, boolean>> {
  try {
    const raw = JSON.parse(await readFile(overridesPath(), "utf8")) as Record<string, unknown>;
    const overrides: Record<string, boolean> = {};
    for (const [agentId, value] of Object.entries(raw)) {
      if (typeof value === "boolean") overrides[agentId] = value;
    }
    return overrides;
  } catch {
    // No file, or one we cannot read: nobody has overridden anything.
    return {};
  }
}

async function agentsWithState(): Promise<string[]> {
  try {
    const names = await readdir(join(dataDir(), "state"));
    return names.filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -".md".length));
  } catch {
    return [];
  }
}

/** Sets, or reverses, one agent's enrolment by hand. */
export function setEnrolled(agentId: string, enrolled: boolean): Promise<AgentEnrolment> {
  return serialize(async () => {
    const overrides = await readOverrides();
    overrides[agentId] = enrolled;
    await mkdir(dataDir(), { recursive: true });
    const target = overridesPath();
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(overrides, null, 2), "utf8");
    await rename(temp, target);
    return { agentId, enrolled, explicit: true };
  });
}

/**
 * Every agent this plugin has an opinion about.
 *
 * An agent absent from this list is simply not enrolled: it has never checkpointed
 * and nobody has asked for it.
 */
export async function listEnrolment(): Promise<AgentEnrolment[]> {
  const { autoEnrol } = await readSettings();
  const resolved = new Map<string, AgentEnrolment>();
  if (autoEnrol) {
    for (const agentId of await agentsWithState()) {
      resolved.set(agentId, { agentId, enrolled: true, explicit: false });
    }
  }
  for (const [agentId, enrolled] of Object.entries(await readOverrides())) {
    resolved.set(agentId, { agentId, enrolled, explicit: true });
  }
  return [...resolved.values()];
}

/** How many agents the governor would speak to. */
export async function countEnrolled(): Promise<number> {
  return (await listEnrolment()).filter((agent) => agent.enrolled).length;
}
