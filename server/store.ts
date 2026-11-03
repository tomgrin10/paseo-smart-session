/**
 * Append-only logs under `$PASEO_HOME/plugin-data/smart-session/`.
 *
 * Plan-usage history exists nowhere else — not in Claude Code, not in Paseo — so
 * these files are the only copy. That shapes every choice here: append rather than
 * rewrite, one line per observation, never rewrite a line once written, and read
 * back defensively so one corrupt line cannot cost a month of history.
 */

import { existsSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { effectiveAt, type UsageSample } from "../shared/usage.ts";

const DATA_DIRECTORY = "smart-session";
const LEGACY_DATA_DIRECTORY = "super-session";
const migratedHomes = new Set<string>();

/**
 * Move the pre-v0.2 data directory before any new file is opened.
 *
 * The two directories are siblings on the same filesystem, so rename is atomic.
 * An empty destination can be left behind by an eager hook and is safe to remove;
 * a non-empty destination is never merged because guessing between two histories
 * would risk duplicating or overwriting the only plan-usage record.
 */
export function migrateLegacyData(home: string): void {
  const parent = join(home, "plugin-data");
  const legacy = join(parent, LEGACY_DATA_DIRECTORY);
  const current = join(parent, DATA_DIRECTORY);
  if (!existsSync(legacy)) return;

  try {
    if (existsSync(current)) {
      if (readdirSync(current).length > 0) {
        console.error(
          `[smart-session] both ${legacy} and ${current} contain data; leaving both untouched`,
        );
        return;
      }
      rmdirSync(current);
    }
    renameSync(legacy, current);
    console.log(`[smart-session] migrated plugin data from ${legacy} to ${current}`);
  } catch (error) {
    console.error(`[smart-session] could not migrate ${legacy} to ${current}`, String(error));
  }
}

export function dataDir(): string {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  if (!migratedHomes.has(home)) {
    migrateLegacyData(home);
    migratedHomes.add(home);
  }
  // A fixed folder name, deliberately decoupled from the install id: a second
  // install under `--id something-else` must not start a second history.
  return join(home, "plugin-data", DATA_DIRECTORY);
}

/** A per-agent context-window reading. */
export interface ContextSample {
  readonly at: string;
  readonly agentId: string;
  readonly usedTokens: number;
  readonly maxTokens: number;
  readonly costUsd: number | null;
  readonly provider: string;
  readonly model: string | null;
  readonly status: string;
  readonly title: string | null;
}

type LogKind = "usage" | "context";

/** Monthly files: small enough to read whole, coarse enough to stay few. */
function logPath(kind: LogKind, at: string): string {
  return join(dataDir(), `${kind}-${at.slice(0, 7)}.jsonl`);
}

/**
 * One writer at a time.
 *
 * The poll tick, the file watcher and any RPC handler share one process, and two
 * concurrent appends can interleave a partial line.
 */
let tail: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  // Keep the chain alive even when a caller rejects.
  tail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function append(kind: LogKind, at: string, row: unknown): Promise<void> {
  await serialize(async () => {
    await mkdir(dataDir(), { recursive: true });
    await appendFile(logPath(kind, at), `${JSON.stringify(row)}\n`, "utf8");
  });
}

export async function appendUsage(sample: UsageSample): Promise<void> {
  await append("usage", sample.at, sample);
}

export async function appendContext(sample: ContextSample): Promise<void> {
  await append("context", sample.at, sample);
}

/**
 * Reads a log back.
 *
 * A truncated last line (a crash mid-append) or a line from a future schema is
 * skipped rather than thrown on: partial history beats no history, and this is the
 * only copy.
 */
async function readLog<T>(kind: LogKind, sinceMs: number | null): Promise<T[]> {
  let names: string[];
  try {
    names = (await readdir(dataDir())).filter((name) => name.startsWith(`${kind}-`) && name.endsWith(".jsonl"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[smart-session] could not list the data directory", String(error));
    }
    return [];
  }
  names.sort();

  if (sinceMs !== null) {
    // Month files are named by their month, so anything older than the month
    // containing `since` cannot hold a row we want.
    const floor = `${kind}-${new Date(sinceMs).toISOString().slice(0, 7)}.jsonl`;
    // eslint-disable-next-line no-param-reassign
    names = names.filter((name) => name >= floor);
  }

  const rows: T[] = [];
  let skipped = 0;
  for (const name of names) {
    let raw: string;
    try {
      raw = await readFile(join(dataDir(), name), "utf8");
    } catch (error) {
      console.error(`[smart-session] could not read ${name}`, String(error));
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line === "") continue;
      try {
        rows.push(JSON.parse(line) as T);
      } catch {
        skipped += 1;
      }
    }
  }
  if (skipped > 0) console.error(`[smart-session] skipped ${skipped} unparseable line(s)`);
  return rows;
}

export async function readUsage(options: { sinceMs?: number } = {}): Promise<UsageSample[]> {
  const since = options.sinceMs ?? null;
  const rows = await readLog<UsageSample>("usage", since);
  return since === null ? rows : rows.filter((row) => Date.parse(row.at) >= since);
}

export async function readContext(options: { sinceMs?: number } = {}): Promise<ContextSample[]> {
  const since = options.sinceMs ?? null;
  const rows = await readLog<ContextSample>("context", since);
  return since === null ? rows : rows.filter((row) => Date.parse(row.at) >= since);
}

/**
 * The newest usage reading on record, for the freshness gate.
 *
 * Held in memory after the first read: the gate runs on every tick, and re-reading
 * a month of history sixty times an hour to answer it would be absurd.
 */
let newestCache: { value: UsageSample | null } | null = null;

export async function newestUsage(): Promise<UsageSample | null> {
  if (newestCache !== null) return newestCache.value;
  const rows = await readUsage({ sinceMs: Date.now() - 45 * 24 * 60 * 60 * 1000 });
  const newest = rows.length === 0 ? null : rows[rows.length - 1]!;
  newestCache = { value: newest };
  return newest;
}

export function noteNewestUsage(sample: UsageSample): void {
  newestCache = { value: sample };
}

/**
 * The newest reading that passed the acceptance gate, whether or not it was written.
 *
 * Most readings are refused by `isWorthRecording` only because nothing moved, so the
 * newest *line* can be minutes older than the newest *fact*. Session Guard wants the
 * fact — a fresh report below its threshold is what confirms a reset.
 */
let latestAccepted: UsageSample | null = null;

export function noteAcceptedReading(sample: UsageSample): void {
  if (latestAccepted === null || Date.parse(effectiveAt(sample)) >= Date.parse(effectiveAt(latestAccepted))) {
    latestAccepted = sample;
  }
}

/** The freshest Claude plan-usage reading this process knows of, recorded or not. */
export async function freshestUsage(): Promise<UsageSample | null> {
  const newest = await newestUsage();
  if (latestAccepted === null) return newest;
  if (newest === null) return latestAccepted;
  return Date.parse(effectiveAt(latestAccepted)) >= Date.parse(effectiveAt(newest)) ? latestAccepted : newest;
}

/** Drops in-memory state so a reload starts clean. */
export function clearCaches(): void {
  newestCache = null;
  latestAccepted = null;
}
