/**
 * Reconstructing token spend from Claude Code's own transcripts.
 *
 * The recorder can only know what it has watched. Everything before it was
 * installed — and everything that happens while the daemon is down — is still
 * recoverable in token terms, because every assistant message in
 * `~/.claude/projects/**\/*.jsonl` carries its own usage. That gives the attribution
 * the utilization percentages cannot: which model, which project, and main thread
 * versus subagent.
 *
 * Transcripts are append-only, so the scan is incremental: each file is re-read only
 * from where the last scan stopped.
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { dataDir } from "./store.ts";

/** One hour of spend, split the ways that let you act on it. */
export interface SpendBucket {
  /** ISO hour, e.g. "2026-09-05T12". */
  readonly hour: string;
  readonly model: string;
  readonly project: string;
  /** Subagent work, which is where a fan-out's cost actually lands. */
  readonly sidechain: boolean;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  thinking: number;
  messages: number;
}

interface Index {
  version: 1;
  /** Per transcript: how far we have read, so a re-scan reads only what is new. */
  files: Record<string, { offset: number; size: number }>;
  buckets: Record<string, SpendBucket>;
  /** Request ids already counted, so a forked or resumed session is not double-counted. */
  seen: string[];
}

const EMPTY: Index = { version: 1, files: {}, buckets: {}, seen: [] };

/**
 * How many request ids to remember.
 *
 * A resumed or forked session replays earlier lines verbatim, so deduplication has
 * to be by request id rather than by position. Keeping every id ever seen would grow
 * without bound; keeping the most recent slice covers replays, which are always of
 * recent history.
 */
const SEEN_LIMIT = 200_000;
const MAX_TRANSCRIPT_READ_BYTES = 16 * 1024 * 1024;

function projectsRoot(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return join(configDir !== undefined && configDir !== "" ? configDir : join(homedir(), ".claude"), "projects");
}

/**
 * Where subagent transcripts live: `/tmp/claude-<uid>/<project>/<session>/tasks/<agent>.output`.
 *
 * They are not in `~/.claude/projects` at all, which means any accounting that reads
 * only that directory — the usual approach — misses subagent spend entirely. In a
 * fan-out-heavy workflow that is not a rounding error; it is most of the bill.
 *
 * They live in the temp directory, so they are purged periodically. Whatever is
 * there is worth counting; what has already gone is unrecoverable, and the recorder
 * exists so that stops mattering.
 */
function tasksRoot(): string | null {
  const override = process.env.SMART_SESSION_TASKS_ROOT;
  if (override !== undefined && override !== "") return override;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return uid === null ? null : join("/tmp", `claude-${uid}`);
}

/** Every transcript worth reading, with the project directory it belongs to. */
async function collectTranscripts(): Promise<{ path: string; directory: string }[]> {
  const found: { path: string; directory: string }[] = [];

  const root = projectsRoot();
  try {
    for (const directory of await readdir(root)) {
      let names: string[];
      try {
        names = await readdir(join(root, directory));
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.endsWith(".jsonl")) found.push({ path: join(root, directory, name), directory });
      }
    }
  } catch {
    // No transcripts on this machine.
  }

  const tasks = tasksRoot();
  if (tasks !== null) {
    try {
      for (const directory of await readdir(tasks)) {
        let sessions: string[];
        try {
          sessions = await readdir(join(tasks, directory));
        } catch {
          continue;
        }
        for (const session of sessions) {
          const taskDir = join(tasks, directory, session, "tasks");
          let names: string[];
          try {
            names = await readdir(taskDir);
          } catch {
            continue;
          }
          for (const name of names) {
            if (name.endsWith(".output")) found.push({ path: join(taskDir, name), directory });
          }
        }
      }
    } catch {
      // No subagent transcripts, or the temp directory has been cleared.
    }
  }

  return found;
}

const indexPath = () => join(dataDir(), "spend-index.json");

async function readIndex(): Promise<Index> {
  try {
    const raw = JSON.parse(await readFile(indexPath(), "utf8")) as Index;
    if (raw.version !== 1) return { ...EMPTY };
    return { version: 1, files: raw.files ?? {}, buckets: raw.buckets ?? {}, seen: raw.seen ?? [] };
  } catch {
    return { ...EMPTY };
  }
}

async function writeIndex(index: Index): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  const target = indexPath();
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(index), "utf8");
  await rename(temp, target);
}

/**
 * The project a transcript belongs to.
 *
 * Directory names are the cwd with every non-alphanumeric character replaced, so the
 * original path is not recoverable — but the tail is still the most useful label a
 * person can read, and worktree names carry it.
 */
function projectLabel(dirName: string, cwd: string | null): string {
  if (cwd !== null && cwd !== "") return basename(cwd);
  const parts = dirName.split("-").filter((part) => part !== "");
  return parts.slice(-2).join("-") || dirName;
}

function bucketKey(bucket: Omit<SpendBucket, keyof Totals>): string {
  return `${bucket.hour}|${bucket.model}|${bucket.project}|${bucket.sidechain ? "sub" : "main"}`;
}

type Totals = { input: number; cacheRead: number; cacheWrite: number; output: number; thinking: number; messages: number };

/** Reads one transcript from `offset`, returning complete lines only. */
async function readFrom(
  path: string,
  offset: number,
  size: number,
): Promise<{ text: string; end: number; truncated: boolean }> {
  if (size <= offset) return { text: "", end: offset, truncated: false };
  const handle = await open(path, "r");
  try {
    const end = Math.min(size, offset + MAX_TRANSCRIPT_READ_BYTES);
    const length = end - offset;
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, offset);
    return { text: buffer.toString("utf8"), end, truncated: end < size };
  } finally {
    await handle.close();
  }
}

export interface ScanResult {
  readonly filesScanned: number;
  readonly bytesRead: number;
  readonly messagesCounted: number;
  readonly buckets: SpendBucket[];
}

/**
 * Scans every transcript for spend not yet counted.
 *
 * Safe to call repeatedly: only bytes appended since the last call are read, and a
 * file that shrank (a rewrite, or a machine that lost the file) is read from the
 * start again rather than trusted.
 */
export async function scanSpend(): Promise<ScanResult> {
  const index = await readIndex();
  const seen = new Set(index.seen);

  let filesScanned = 0;
  let bytesRead = 0;
  let messagesCounted = 0;

  {
    for (const { path, directory } of await collectTranscripts()) {
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch {
        continue;
      }

      const previous = index.files[path] ?? { offset: 0, size: 0 };
      // A file smaller than last time was replaced, not appended to.
      const offset = size < previous.size ? 0 : previous.offset;
      if (size === offset) continue;

      let read: Awaited<ReturnType<typeof readFrom>>;
      try {
        read = await readFrom(path, offset, size);
      } catch {
        continue;
      }
      const chunk = read.text;
      filesScanned += 1;
      bytesRead += chunk.length;

      // The final line may be half-written; leave it for the next scan.
      const lastNewline = chunk.lastIndexOf("\n");
      const complete = lastNewline === -1 ? "" : chunk.slice(0, lastNewline);
      if (lastNewline === -1 && read.truncated) {
        console.error(
          `[smart-session] skipped ${read.end - offset} bytes from an overlong transcript line`,
        );
      }
      index.files[path] = {
        offset: lastNewline === -1 ? (read.truncated ? read.end : offset) : offset + lastNewline + 1,
        size,
      };

      for (const line of complete.split("\n")) {
        if (line === "" || !line.includes('"usage"')) continue;
        let entry: {
          type?: string;
          timestamp?: string;
          requestId?: string;
          cwd?: string;
          isSidechain?: boolean;
          message?: { model?: string; usage?: Record<string, unknown> };
        };
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.type !== "assistant") continue;
        const usage = entry.message?.usage;
        if (usage === undefined || typeof entry.timestamp !== "string") continue;

        // One API request can produce several transcript lines (one per content
        // block); its usage belongs to the request, not to each line.
        const requestId = entry.requestId;
        if (typeof requestId === "string") {
          if (seen.has(requestId)) continue;
          seen.add(requestId);
        }

        const hour = entry.timestamp.slice(0, 13);
        const key = bucketKey({
          hour,
          model: entry.message?.model ?? "unknown",
          project: projectLabel(directory, entry.cwd ?? null),
          sidechain: entry.isSidechain === true,
        });

        const bucket =
          index.buckets[key] ??
          (index.buckets[key] = {
            hour,
            model: entry.message?.model ?? "unknown",
            project: projectLabel(directory, entry.cwd ?? null),
            sidechain: entry.isSidechain === true,
            input: 0,
            cacheRead: 0,
            cacheWrite: 0,
            output: 0,
            thinking: 0,
            messages: 0,
          });

        const details = usage.output_tokens_details as { thinking_tokens?: number } | undefined;
        bucket.input += Number(usage.input_tokens ?? 0);
        bucket.cacheRead += Number(usage.cache_read_input_tokens ?? 0);
        bucket.cacheWrite += Number(usage.cache_creation_input_tokens ?? 0);
        bucket.output += Number(usage.output_tokens ?? 0);
        bucket.thinking += Number(details?.thinking_tokens ?? 0);
        bucket.messages += 1;
        messagesCounted += 1;
      }
    }
  }

  // Keep the most recent ids; replays are always of recent history.
  index.seen = seen.size > SEEN_LIMIT ? [...seen].slice(-SEEN_LIMIT) : [...seen];
  await writeIndex(index);

  return { filesScanned, bytesRead, messagesCounted, buckets: Object.values(index.buckets) };
}

/** The buckets already computed, without touching the filesystem beyond the index. */
export async function readSpend(sinceMs: number | null = null): Promise<SpendBucket[]> {
  const index = await readIndex();
  const buckets = Object.values(index.buckets);
  if (sinceMs === null) return buckets;
  const floor = new Date(sinceMs).toISOString().slice(0, 13);
  return buckets.filter((bucket) => bucket.hour >= floor);
}
