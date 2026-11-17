/**
 * Moving a Claude transcript's history from before its last compaction into a backup (the I/O part).
 * Off unless the person turns it on (`shedHistory`); see `shared/history-shed.ts` for what is cut.
 *
 * Invariants (AGENTS.md, tests in history-shed.test.ts):
 * - No data is lost. A full copy of the transcript, and of every subagent transcript that leaves
 *   `subagents/`, is written and verified by sha256 before anything changes. Smart Session never
 *   deletes a backup, used or not; only the person can. Backups live in Smart Session's own data
 *   folder, outside Claude Code's retention and out of sight of transcript scanners.
 * - A line written at any moment of a shed or a restore ends up in the result, or the change is
 *   undone with it in place. The original stays open and keeps a second name until the swap is
 *   proven quiet: its size and mtime are checked last, with nothing between that check and the
 *   rename, and after the rename the old file must have no holder and no new byte, or it goes back.
 * - Only the intended files change: the one transcript resolved from the agent's own persisted
 *   session id, and the subagent transcripts the plan names (never one the kept history mentions).
 *   Nothing is globbed; anything ambiguous refuses.
 * - The transcript is replaced only by an atomic rename, and only while no Claude process can be
 *   writing it: inside Paseo's `agent.open.before` for an agent that is not loaded. A reload
 *   (`refresh`) still has its old runtime alive, so it never sheds there.
 * - An agent's id and its post-compaction context survive: same file path, same session id, and the
 *   chain Claude rebuilds is byte-identical (`planCut` refuses otherwise).
 *
 * Two phases. `prepare` runs while an agent is not loaded and only reads its files, writing the
 * backup and a plan. `commit` runs at the agent's next open: it re-verifies everything against the
 * plan, writes the new file to a temp name, checks its hash, and renames it over the transcript.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, fstatSync, renameSync, statSync } from "node:fs";
import { type FileHandle, link, mkdir, open, readdir, readFile, readlink, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type CutPlan,
  type IndexedRecord,
  indexRecord,
  isSessionId,
  isSubagentFile,
  planCut,
} from "../shared/history-shed.ts";

const CHUNK = 1 << 20;
/** Unused backups (plans the transcript moved past before their commit) an agent may collect before it waits. */
export const MAX_UNUSED_BACKUPS = 2;

// ---------------------------------------------------------------------------------------------- types

export interface FileStamp {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
  readonly sha256: string;
}

interface OpenStamp extends FileStamp {
  readonly dev: number;
  readonly mode: number;
}

export interface SubagentEntry extends FileStamp {
  readonly name: string;
  /** The `.meta.json` beside it, when there is one. */
  readonly meta: (FileStamp & { readonly name: string }) | null;
  /** Leaves `subagents/` at the commit (its whole run predates the cut, and nothing kept names it). */
  readonly move: boolean;
}

export type PlanState = "prepared" | "committing" | "committed" | "restoring" | "restored" | "discarded";

/** What `prepare` decided, kept in Smart Session's data folder until the commit or its discard. */
export interface ShedPlan {
  readonly version: 1;
  readonly id: string;
  readonly agentId: string;
  readonly sessionId: string;
  /** The transcript, as its real path. */
  readonly path: string;
  readonly original: FileStamp;
  readonly cut: Pick<CutPlan, "ranges" | "newSize" | "movedBytes" | "compactions" | "chainLength" | "boundaryTimestamp"> & { movedRecords: number; keptBefore: number };
  readonly expectedSha256: string;
  backupDir: string;
  readonly subagents: readonly SubagentEntry[];
  readonly preparedAt: string;
  state: PlanState;
  committedAt?: string;
  /** Subagent transcripts already removed from `subagents/` after their backup was re-verified. */
  movedSubagents?: string[];
  restoredAt?: string;
  /** When the chat row saying where the history went was added. A commit that outlived its process gets it later. */
  notedAt?: string;
  /** The person asked for the full history back; done at the agent's next safe open. */
  restoreRequested?: boolean;
  /** Why it was discarded; its backup stays. */
  discardedWhy?: string;
  /** An open that worked on this plan was canceled by Paseo (its hook timed out): the next open leaves it. */
  overranAt?: string;
  /** Where a 3.8.0-beta.1 backup was before it was copied into the data folder (left there as it was). */
  migratedFrom?: string;
  /** A rollback under way: saved before its first step, so a settle after a kill finishes it from the files. */
  rollback?: RollbackRecord;
}

/**
 * Undoing a swap whose replaced file was written to. `replacementSize`: the replacement's size as written (bytes
 * past it are lines written into it, copied after the original). `origSize`: the replaced file's size when last
 * verified (copied bytes are looked for only past it). `copied`: how many bytes past `replacementSize` are back.
 */
export interface RollbackRecord {
  readonly kind: "shed" | "restore";
  readonly replacementSize: number;
  readonly origSize: number;
  copied: number;
  readonly startedAt: string;
}

export type Refusal =
  | "off"
  | "not-claude"
  | "no-session"
  | "no-transcript"
  | "ambiguous-transcript"
  | "busy"
  | "no-proc"
  | "changed"
  | "backup-mismatch"
  | "subagents-changed"
  | "deadline"
  | "aborted"
  | "late-write"
  | "unsafe-open"
  | "restore-mismatch"
  | "nothing-to-restore"
  | "unreadable-plan"
  | "unused-backups"
  | `cut:${string}`
  | `due:${string}`
  | `error:${string}`;

export type Outcome =
  | { readonly ok: true; readonly plan: ShedPlan }
  | { readonly ok: false; readonly why: Refusal; readonly plan?: ShedPlan };

/**
 * Which processes hold a file open or name a session id on their command line. Null: unknown.
 * With `inode`, a holder is matched by that file's identity instead of its path: after a rename the
 * old file has no name a path comparison would find.
 */
export interface ProcessView {
  holders(path: string, sessionId: string, inode?: { readonly dev: number; readonly ino: number }): Promise<string[] | null>;
}

export interface ShedEnv {
  /** Smart Session's data folder (plans, backups, run log). */
  readonly dataDir: string;
  /** Claude config folders to look in: CLAUDE_CONFIG_DIR, ~/.claude, ZeroSub account homes. */
  readonly configDirs: () => Promise<string[]>;
  readonly processes: ProcessView;
  readonly now?: () => number;
  /** Test seam: called before each step; a throw there stands in for a crash at that point. */
  readonly step?: (name: string) => void | Promise<void>;
}

const at = (env: ShedEnv) => new Date((env.now ?? Date.now)()).toISOString();
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------------------------- files

async function hashHandle(handle: FileHandle, length?: number): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK);
  let position = 0;
  for (;;) {
    const want = length === undefined ? buffer.length : Math.min(buffer.length, length - position);
    if (want <= 0) break;
    const { bytesRead } = await handle.read(buffer, 0, want, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return { sha256: hash.digest("hex"), size: position };
}

/** sha256 and size of an open file, with the identity it had when the read began. */
async function stampHandle(handle: FileHandle): Promise<OpenStamp> {
  const before = await handle.stat();
  const { sha256, size } = await hashHandle(handle);
  return { size, mtimeMs: before.mtimeMs, ino: before.ino, dev: before.dev, mode: before.mode & 0o7777, sha256 };
}

/** sha256 and size of a file, read in chunks; also the stamp it had when the read began. */
export async function stampFile(path: string): Promise<FileStamp> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    const { size, mtimeMs, ino, sha256 } = await stampHandle(handle);
    return { size, mtimeMs, ino, sha256 };
  } finally {
    await handle.close();
  }
}

/** sha256 of the first `length` bytes; null when the file is shorter. */
async function prefixShaOf(handle: FileHandle, length: number): Promise<string | null> {
  if ((await handle.stat()).size < length) return null;
  const { sha256, size } = await hashHandle(handle, length);
  return size === length ? sha256 : null;
}

async function prefixSha(path: string, length: number): Promise<string | null> {
  const handle = await open(path, constants.O_RDONLY);
  try { return await prefixShaOf(handle, length); } finally { await handle.close(); }
}

/** Every line's index entry and the whole file's hash, in one pass. */
export async function indexTranscript(path: string): Promise<{ records: IndexedRecord[]; stamp: FileStamp }> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    const before = await handle.stat();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK);
    const records: IndexedRecord[] = [];
    let carry: Buffer[] = [];
    let carryLength = 0;
    let lineStart = 0;
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let from = 0;
      let newline = chunk.indexOf(10, from);
      while (newline !== -1) {
        const piece = chunk.subarray(from, newline);
        const line = carryLength > 0 ? Buffer.concat([...carry, piece], carryLength + piece.length) : piece;
        const length = line.length + 1;
        if (line.length > 0) records.push(indexRecord(line.toString("utf8"), lineStart, length));
        else records.push({ offset: lineStart, length, type: null, subtype: null, uuid: null, parentUuid: null, isSidechain: false, timestamp: null });
        lineStart += length;
        carry = [];
        carryLength = 0;
        from = newline + 1;
        newline = chunk.indexOf(10, from);
      }
      if (from < chunk.length) {
        carry.push(Buffer.from(chunk.subarray(from)));
        carryLength += chunk.length - from;
      }
      position += bytesRead;
    }
    if (carryLength > 0) {
      const line = Buffer.concat(carry, carryLength);
      records.push(indexRecord(line.toString("utf8"), lineStart, line.length));
    }
    return { records, stamp: { size: position, mtimeMs: before.mtimeMs, ino: before.ino, sha256: hash.digest("hex") } };
  } finally {
    await handle.close();
  }
}

async function fsyncDir(dir: string) {
  try {
    const handle = await open(dir, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  } catch { /* Not every filesystem allows it; the rename is still atomic. */ }
}

/** A part of a new file: a byte range of an open file or of a path. */
type Part = readonly [FileHandle | string, number, number];

/** Writes `parts` into a new file (never an existing one) with `mode`, synced; returns its sha256. */
async function writeParts(target: string, parts: readonly Part[], mode = 0o600): Promise<string> {
  const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const hash = createHash("sha256");
  try {
    await output.chmod(mode);
    const buffer = Buffer.allocUnsafe(CHUNK);
    for (const [source, offset, length] of parts) {
      const input = typeof source === "string" ? await open(source, constants.O_RDONLY) : source;
      try {
        let done = 0;
        while (done < length) {
          const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, length - done), offset + done);
          if (bytesRead === 0) throw new Error("source ended early");
          const slice = buffer.subarray(0, bytesRead);
          hash.update(slice);
          await output.write(slice, 0, slice.length);
          done += bytesRead;
        }
      } finally {
        if (typeof source === "string") await input.close();
      }
    }
    await output.sync();
  } finally {
    await output.close();
  }
  return hash.digest("hex");
}

/** A verified copy into a new file. Throws unless the copy's own hash equals `expect`. */
async function copyVerified(source: FileHandle | string, target: string, expect: FileStamp): Promise<void> {
  const written = await writeParts(target, [[source, 0, expect.size]]);
  if (written !== expect.sha256) throw new Error("copy differs from its source");
  const reread = await stampFile(target);
  if (reread.sha256 !== expect.sha256 || reread.size !== expect.size) throw new Error("copy did not read back");
}

/** Which of `needles` occur in the given byte ranges of a file. */
async function rangesMention(handle: FileHandle, ranges: readonly (readonly [number, number])[], needles: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (needles.length === 0) return found;
  const longest = Math.max(...needles.map((n) => Buffer.byteLength(n)));
  const buffer = Buffer.allocUnsafe(CHUNK + longest);
  for (const [offset, length] of ranges) {
    let carry = 0;
    let done = 0;
    while (done < length) {
      const { bytesRead } = await handle.read(buffer, carry, Math.min(CHUNK, length - done), offset + done);
      if (bytesRead === 0) break;
      const window = buffer.subarray(0, carry + bytesRead);
      for (const needle of needles) if (!found.has(needle) && window.includes(needle)) found.add(needle);
      carry = Math.min(longest - 1, window.length);
      window.copy(buffer, 0, window.length - carry);
      done += bytesRead;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------- locating

/** The one transcript for this session id, across every Claude config folder, by real path. */
export async function resolveTranscript(sessionId: string, configDirs: readonly string[]): Promise<{ path: string } | { why: "no-transcript" | "ambiguous-transcript" }> {
  const found = new Set<string>();
  for (const configDir of new Set(configDirs)) {
    const projects = join(configDir, "projects");
    let entries: string[];
    try { entries = await readdir(projects); } catch { continue; }
    for (const entry of entries) {
      const candidate = join(projects, entry, `${sessionId}.jsonl`);
      try {
        const info = await stat(candidate);
        if (info.isFile()) found.add(await realpath(candidate));
      } catch { /* absent */ }
    }
  }
  if (found.size === 0) return { why: "no-transcript" };
  if (found.size > 1) return { why: "ambiguous-transcript" };
  return { path: [...found][0]! };
}

/** The Paseo agent record's persisted Claude session id, read from Paseo's own files. */
export async function persistedSession(paseoHome: string, agentId: string): Promise<{ provider: string; sessionId: string; title: string | null } | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) return null;
  const root = join(paseoHome, "agents");
  let dirs: string[];
  try { dirs = await readdir(root); } catch { return null; }
  const matches: string[] = [];
  for (const dir of dirs) {
    const file = join(root, dir, `${agentId}.json`);
    if (existsSync(file)) matches.push(file);
  }
  if (existsSync(join(root, `${agentId}.json`))) matches.push(join(root, `${agentId}.json`));
  if (matches.length !== 1) return null;
  try {
    const record = JSON.parse(await readFile(matches[0]!, "utf8"));
    const persistence = record?.persistence;
    const provider = typeof persistence?.provider === "string" ? persistence.provider : record?.provider;
    const sessionId = persistence?.sessionId;
    const title = typeof record?.title === "string" && record.title.trim() ? record.title.trim() : null;
    return typeof provider === "string" && isSessionId(sessionId) ? { provider, sessionId, title } : null;
  } catch {
    return null;
  }
}

/** Linux: processes that hold `path` (or, with `inode`, that file) open, or carry `sessionId` on their command line. */
export const linuxProcesses: ProcessView = {
  async holders(path, sessionId, inode) {
    let pids: string[];
    try { pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name)); } catch { return null; }
    const own = String(process.pid);
    const folder = `${dirname(path)}/`;
    const out: string[] = [];
    const check = async (pid: string) => {
      if (pid === own) return;
      try {
        const cmdline = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ");
        if (cmdline.includes(sessionId)) { out.push(`${pid}:cmdline`); return; }
      } catch { return; }
      let fds: string[];
      try { fds = await readdir(`/proc/${pid}/fd`); } catch { return; }
      for (const fd of fds) {
        try {
          const target = await readlink(`/proc/${pid}/fd/${fd}`);
          if (inode) {
            // A renamed-over file reads as "<path> (deleted)" or as its second name; same folder either way.
            if (!target.startsWith(folder)) continue;
            const info = await stat(`/proc/${pid}/fd/${fd}`);
            if (info.ino === inode.ino && info.dev === inode.dev) { out.push(`${pid}:fd`); return; }
          } else if (target === path) { out.push(`${pid}:fd`); return; }
        } catch { /* gone */ }
      }
    };
    // Many processes, each read independently: a few at a time keeps it quick on a busy machine.
    let next = 0;
    await Promise.all(Array.from({ length: 16 }, async () => {
      while (next < pids.length) await check(pids[next++]!);
    }));
    return out;
  },
};

// ---------------------------------------------------------------------------------------------- plans

const shedRoot = (env: ShedEnv) => join(env.dataDir, "history-shed");
const planRoot = (env: ShedEnv) => join(shedRoot(env), "plans");
const backupRoot = (env: ShedEnv) => join(shedRoot(env), "backups");
const safeId = (agentId: string) => (/^[A-Za-z0-9_-]+$/.test(agentId) ? agentId : null);

/**
 * Where a plan's backup goes: Smart Session's data folder, by the transcript's real folder (which
 * names its Claude config folder and project) and its session id. Not under `~/.claude/projects`,
 * where Claude Code's cleanup, a removed ZeroSub account home or a transcript search would reach it.
 */
export function backupDirFor(env: ShedEnv, transcript: string, sessionId: string, planId: string): string {
  const folder = dirname(transcript);
  const key = `${basename(folder).slice(-80)}-${createHash("sha256").update(folder).digest("hex").slice(0, 8)}`;
  return join(backupRoot(env), key, sessionId, planId);
}

function isPlan(value: unknown, agentId: string): value is ShedPlan {
  const p = value as Partial<ShedPlan> | null;
  return !!p && p.version === 1 && typeof p.id === "string" && p.agentId === agentId && isSessionId(p.sessionId)
    && typeof p.path === "string" && typeof p.backupDir === "string" && typeof p.state === "string"
    && !!p.original && typeof p.original.sha256 === "string" && !!p.cut && Array.isArray(p.cut.ranges) && Array.isArray(p.subagents);
}

const reportedUnreadable = new Set<string>();

/** Every plan for an agent, newest first, and the plan files that could not be read (reported once each). */
export async function readPlans(env: ShedEnv, agentId: string): Promise<{ plans: ShedPlan[]; unreadable: string[] }> {
  const id = safeId(agentId);
  if (!id) return { plans: [], unreadable: [] };
  let names: string[];
  try { names = (await readdir(join(planRoot(env), id))).filter((n) => n.endsWith(".json")).sort(); } catch { return { plans: [], unreadable: [] }; }
  const plans: ShedPlan[] = [];
  const unreadable: string[] = [];
  for (const name of names) {
    try {
      const value = JSON.parse(await readFile(join(planRoot(env), id, name), "utf8"));
      if (isPlan(value, agentId)) plans.push(value);
      else unreadable.push(name);
    } catch {
      unreadable.push(name);
    }
  }
  for (const name of unreadable) {
    const key = join(planRoot(env), id, name);
    if (reportedUnreadable.has(key)) continue;
    reportedUnreadable.add(key);
    await logRun(env, { event: "plan-unreadable", agentId, file: name, note: "This agent is left alone until the file is readable again or removed." });
  }
  plans.sort((a, b) => (a.preparedAt < b.preparedAt ? 1 : a.preparedAt > b.preparedAt ? -1 : a.id < b.id ? 1 : -1));
  return { plans, unreadable };
}

/** Every plan for an agent, newest first (one file per shed, so restore can walk back through all). */
export async function agentPlans(env: ShedEnv, agentId: string): Promise<ShedPlan[]> {
  return (await readPlans(env, agentId)).plans;
}

/** The newest plan that still matters (not a discarded one). */
export async function readPlan(env: ShedEnv, agentId: string): Promise<ShedPlan | null> {
  return (await agentPlans(env, agentId)).find((p) => p.state !== "discarded") ?? null;
}

async function agentIds(env: ShedEnv): Promise<string[]> {
  try { return (await readdir(planRoot(env))).filter((id) => safeId(id) !== null); } catch { return []; }
}

export async function listPlans(env: ShedEnv): Promise<ShedPlan[]> {
  const out: ShedPlan[] = [];
  for (const id of await agentIds(env)) {
    const latest = await readPlan(env, id);
    if (latest) out.push(latest);
  }
  return out;
}

/** Plan files that can't be read, by agent: shown in the status, and those agents are left alone. */
export async function unreadablePlans(env: ShedEnv): Promise<{ agentId: string; file: string }[]> {
  const out: { agentId: string; file: string }[] = [];
  for (const id of await agentIds(env)) for (const file of (await readPlans(env, id)).unreadable) out.push({ agentId: id, file });
  return out;
}

/** Written to a temp name, synced, renamed, and the folder synced: a plan survives a power cut whole or not at all. */
async function savePlan(env: ShedEnv, plan: ShedPlan): Promise<void> {
  const id = safeId(plan.agentId);
  if (!id) throw new Error("bad agent id");
  const dir = join(planRoot(env), id);
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${plan.id}.json`);
  const temp = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(JSON.stringify(plan, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, target);
  await fsyncDir(dir);
}

/** For tests that need a plan as an older version wrote it. */
export const savePlanForTest = savePlan;

/** The newest committed shed of this agent whose chat row was never added, if any. */
export async function unnoted(env: ShedEnv, agentId: string): Promise<ShedPlan | null> {
  const newest = (await agentPlans(env, agentId)).find((p) => p.state !== "discarded");
  return newest && newest.state === "committed" && !newest.notedAt && !newest.restoreRequested ? newest : null;
}

/** Changes a stored plan under its lock, only if `when` still holds for the stored copy. */
async function updatePlan(env: ShedEnv, plan: ShedPlan, when: (current: ShedPlan) => boolean, change: (current: ShedPlan) => void): Promise<void> {
  await withLock(env, plan, async () => {
    const current = (await agentPlans(env, plan.agentId)).find((p) => p.id === plan.id);
    if (!current || !when(current)) return;
    change(current);
    await savePlan(env, current);
  }, () => undefined);
}

/** Records that the chat row was added. Under the plan's lock, and only while it is still committed. */
export async function markNoted(env: ShedEnv, plan: ShedPlan): Promise<void> {
  await updatePlan(env, plan, (c) => c.state === "committed" && !c.notedAt, (c) => { c.notedAt = at(env); });
}

/** Records that Paseo canceled an open that worked on this plan: the next open leaves it alone. */
export async function markOverrun(env: ShedEnv, plan: ShedPlan): Promise<void> {
  await updatePlan(env, plan, () => true, (c) => { c.overranAt = at(env); });
}

export async function clearOverrun(env: ShedEnv, plan: ShedPlan): Promise<void> {
  await updatePlan(env, plan, (c) => c.overranAt !== undefined, (c) => { delete c.overranAt; });
}

/** Marks every shed of this agent for restoring at its next safe open. Null when there is none. */
export async function requestRestore(env: ShedEnv, agentId: string): Promise<ShedPlan[] | null> {
  const plans = (await agentPlans(env, agentId)).filter((p) => p.state === "committed" || p.state === "committing" || p.state === "restoring");
  if (plans.length === 0) return null;
  for (const plan of plans) await updatePlan(env, plan, (c) => c.state === plan.state, (c) => { c.restoreRequested = true; });
  return plans;
}

/** Restores every requested shed, newest first, while time allows. Settles a crashed commit or restore first. */
export async function restoreRequested(env: ShedEnv, agentId: string, deadline: number, signal?: AbortSignal): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const plan of (await agentPlans(env, agentId)).filter((p) => p.restoreRequested && (p.state === "committed" || p.state === "committing" || p.state === "restoring"))) {
    const result = await restore(env, plan, deadline, signal);
    out.push(result);
    if (!result.ok) break;
  }
  return out;
}

/** One line per prepare, commit, restore or refusal (`history-shed/runs-YYYY-MM.jsonl`). */
export async function logRun(env: ShedEnv, entry: Record<string, unknown>): Promise<void> {
  try {
    const dir = shedRoot(env);
    await mkdir(dir, { recursive: true });
    const now = at(env);
    await writeFile(join(dir, `runs-${now.slice(0, 7)}.jsonl`), `${JSON.stringify({ at: now, ...entry })}\n`, { flag: "a" });
  } catch { /* The log never fails a shed. */ }
}

// ---------------------------------------------------------------------------------------------- prepare

async function subagentStamps(sessionDir: string): Promise<{ name: string; stamp: FileStamp; meta: (FileStamp & { name: string }) | null }[]> {
  const dir = join(sessionDir, "subagents");
  let names: string[];
  try { names = (await readdir(dir)).filter(isSubagentFile).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    const stamp = await stampFile(join(dir, name));
    const metaName = name.replace(/\.jsonl$/, ".meta.json");
    const meta = existsSync(join(dir, metaName)) ? { name: metaName, ...(await stampFile(join(dir, metaName))) } : null;
    out.push({ name, stamp, meta });
  }
  return out;
}

/** The newest timestamp in a subagent transcript, or null when it has none. */
async function newestTimestamp(path: string): Promise<number | null> {
  const { records } = await indexTranscript(path);
  let newest: number | null = null;
  for (const r of records) {
    const t = r.timestamp === null ? NaN : Date.parse(r.timestamp);
    if (Number.isFinite(t)) newest = newest === null ? t : Math.max(newest, t);
  }
  return newest;
}

/** The ids a kept record would use to point at a subagent: its agent id and the Task call that started it. */
async function subagentIds(dir: string, name: string, metaName: string | null): Promise<string[]> {
  const ids = [name.replace(/^agent-/, "").replace(/\.jsonl$/, "")];
  if (metaName) {
    try {
      const toolUseId = JSON.parse(await readFile(join(dir, metaName), "utf8"))?.toolUseId;
      if (typeof toolUseId === "string") ids.push(toolUseId);
    } catch { /* No usable meta: the agent id alone. */ }
  }
  return ids.filter((id) => id.length >= 8);
}

/**
 * Reads the transcript, plans the cut, and writes and verifies the backup. Touches no existing file.
 * `isDue` decides from the size and plan whether it is worth it.
 */
export async function prepare(
  env: ShedEnv,
  agentId: string,
  sessionId: string,
  isDueFor: (size: number, plan: CutPlan) => true | string,
): Promise<Outcome> {
  if (!isSessionId(sessionId)) return { ok: false, why: "no-session" };
  const { plans, unreadable } = await readPlans(env, agentId);
  if (unreadable.length > 0) return { ok: false, why: "unreadable-plan" };
  // Never deleted, so bounded instead: an agent whose transcript keeps moving on before each commit waits.
  const unused = plans.filter((p) => p.state === "discarded" && existsSync(join(p.backupDir, "transcript.jsonl"))).length;
  if (unused >= MAX_UNUSED_BACKUPS) return { ok: false, why: "unused-backups" };
  const located = await resolveTranscript(sessionId, await env.configDirs());
  if ("why" in located) return { ok: false, why: located.why };
  const path = located.path;
  const holders = await env.processes.holders(path, sessionId);
  if (holders === null) return { ok: false, why: "no-proc" };
  if (holders.length > 0) return { ok: false, why: "busy" };
  await env.step?.("prepare:index");
  const { records, stamp } = await indexTranscript(path);
  const cut = planCut(records);
  if (!cut.ok) return { ok: false, why: `cut:${cut.why}` };
  const due = isDueFor(stamp.size, cut);
  if (due !== true) return { ok: false, why: `due:${due}` };
  const handle = await open(path, constants.O_RDONLY);
  try {
    // The file must not have changed while it was read.
    const recheck = await handle.stat();
    if (recheck.size !== stamp.size || recheck.mtimeMs !== stamp.mtimeMs || recheck.ino !== stamp.ino) return { ok: false, why: "changed" };
    const expectedSha256 = await shaOfRanges(handle, cut.ranges);
    const sessionDir = join(dirname(path), basename(path, ".jsonl"));
    const subagentsDir = join(sessionDir, "subagents");
    const id = `${new Date((env.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const backupDir = backupDirFor(env, path, sessionId, id);
    // Which old subagents could leave: their whole run predates the cut, and no kept record names them.
    const boundaryAt = cut.boundaryTimestamp === null ? NaN : Date.parse(cut.boundaryTimestamp);
    const found = await subagentStamps(sessionDir);
    const candidates = new Map<string, string[]>();
    for (const { name, meta } of found) {
      const newest = await newestTimestamp(join(subagentsDir, name));
      if (Number.isFinite(boundaryAt) && newest !== null && newest < boundaryAt) candidates.set(name, await subagentIds(subagentsDir, name, meta?.name ?? null));
    }
    const mentioned = await rangesMention(handle, cut.ranges, [...candidates.values()].flat());
    await env.step?.("prepare:backup");
    await mkdir(join(backupDir, "subagents"), { recursive: true });
    await copyVerified(handle, join(backupDir, "transcript.jsonl"), stamp);
    const subagents: SubagentEntry[] = [];
    for (const { name, stamp: sub, meta } of found) {
      const ids = candidates.get(name);
      const move = ids !== undefined && !ids.some((x) => mentioned.has(x));
      if (move) {
        await copyVerified(join(subagentsDir, name), join(backupDir, "subagents", name), sub);
        if (meta) await copyVerified(join(subagentsDir, meta.name), join(backupDir, "subagents", meta.name), meta);
      }
      subagents.push({ name, ...sub, meta, move });
    }
    const after = await stampHandle(handle);
    if (after.sha256 !== stamp.sha256 || after.size !== stamp.size) return { ok: false, why: "changed" };
    const plan: ShedPlan = {
      version: 1,
      id,
      agentId,
      sessionId,
      path,
      original: stamp,
      cut: {
        ranges: cut.ranges,
        newSize: cut.newSize,
        movedBytes: cut.movedBytes,
        compactions: cut.compactions,
        chainLength: cut.chainLength,
        boundaryTimestamp: cut.boundaryTimestamp,
        movedRecords: cut.moved.length,
        keptBefore: cut.keptBefore.length,
      },
      expectedSha256,
      backupDir,
      subagents,
      preparedAt: at(env),
      state: "prepared",
    };
    await writeFile(join(backupDir, "manifest.json"), JSON.stringify({ ...plan, note: "Full copy of the transcript before Smart Session moved its older history aside. Smart Session never deletes this folder." }, null, 2), { flag: "wx", mode: 0o600 });
    await fsyncDir(join(backupDir, "subagents"));
    await fsyncDir(backupDir);
    await fsyncDir(dirname(backupDir));
    await savePlan(env, plan);
    await logRun(env, { event: "prepared", agentId, sessionId, size: stamp.size, newSize: cut.newSize, movedBytes: cut.movedBytes, compactions: cut.compactions, subagentsMoving: subagents.filter((s) => s.move).length, subagentsKeptAsNamed: [...candidates.keys()].filter((n) => !subagents.find((s) => s.name === n)?.move).length, backupDir });
    return { ok: true, plan };
  } finally {
    await handle.close();
  }
}

/** sha256 of the given ranges of an open file. */
async function shaOfRanges(handle: FileHandle, ranges: readonly (readonly [number, number])[]): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK);
  for (const [offset, length] of ranges) {
    let done = 0;
    while (done < length) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, length - done), offset + done);
      if (bytesRead === 0) throw new Error("file ended early");
      hash.update(buffer.subarray(0, bytesRead));
      done += bytesRead;
    }
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------------------------- lock

const held = new Set<string>();

/**
 * One commit, restore or settle per plan at a time, across processes: an exclusive lock file beside
 * the plan, holding the owner's pid. A lock whose pid is gone (a crash) is taken over.
 */
async function withLock<T>(env: ShedEnv, plan: ShedPlan, work: () => Promise<T>, busy: () => T): Promise<T> {
  const id = safeId(plan.agentId);
  if (!id) return busy();
  const dir = join(planRoot(env), id);
  const lockFile = join(dir, `${plan.id}.lock`);
  if (held.has(lockFile)) return busy();
  held.add(lockFile);
  try {
    await mkdir(dir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      let handle: FileHandle;
      try {
        handle = await open(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      } catch (error) {
        // Only this open's EEXIST means another holder. An EEXIST from inside the work is the work's error.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = Number((await readFile(lockFile, "utf8").catch(() => "")).trim());
        let alive = false;
        if (Number.isInteger(owner) && owner > 0) { try { process.kill(owner, 0); alive = true; } catch (e) { alive = (e as NodeJS.ErrnoException).code === "EPERM"; } }
        if (alive && owner !== process.pid) return busy();
        await unlink(lockFile).catch(() => undefined);
        continue;
      }
      try { await handle.writeFile(`${process.pid}`); } finally { await handle.close(); }
      try { return await work(); } finally { await unlink(lockFile).catch(() => undefined); }
    }
    return busy();
  } finally {
    held.delete(lockFile);
  }
}

// ---------------------------------------------------------------------------------------------- the swap

/** What the open was: only an open with no live runtime may commit. */
export interface OpenKind {
  readonly reason: "create" | "resume" | "refresh" | "import";
  readonly purpose: "interactive" | "history";
}

export function openIsSafe(open: OpenKind): boolean {
  if (open.reason === "create" || open.reason === "refresh") return false;
  return true;
}

/** The temp files a commit or restore of this plan writes beside the transcript, by exact name. */
export function tempNames(plan: Pick<ShedPlan, "path" | "id">): string[] {
  return [
    join(dirname(plan.path), `.${basename(plan.path)}.shed-${plan.id}.tmp`),
    join(dirname(plan.path), `.${basename(plan.path)}.restore-${plan.id}.tmp`),
  ];
}

/**
 * The second names a swap gives files beside the transcript while it proves itself: the file being
 * replaced (`.orig`) and, while undoing, the replacement (`.new`). Shed first, then restore.
 */
export function sideNames(plan: Pick<ShedPlan, "path" | "id">): string[] {
  const base = join(dirname(plan.path), `.${basename(plan.path)}`);
  return [`${base}.shed-${plan.id}.orig`, `${base}.shed-${plan.id}.new`, `${base}.restore-${plan.id}.orig`, `${base}.restore-${plan.id}.new`];
}

/** A temp file this module names after its own plan id: removed only by that exact name. */
async function clearOwnTemp(temp: string): Promise<void> {
  if (!/\.(shed|restore)-[0-9A-Za-z-]+\.tmp$/.test(temp)) return;
  await unlink(temp).catch(() => undefined);
}

/**
 * Removes a second name, only while it is still the file expected (same inode, same size) and, for the
 * replaced original, while its every byte is in a verified backup. The same bytes stay reachable.
 */
async function dropSecondName(second: string, expect: { readonly ino: number; readonly size: number }): Promise<boolean> {
  if (!/\.(shed|restore)-[0-9A-Za-z-]+\.(orig|new)$/.test(second)) return false;
  const info = await stat(second).catch(() => null);
  if (!info) return true;
  if (info.ino !== expect.ino || info.size !== expect.size) return false;
  await unlink(second);
  return true;
}

/** Removes a second name while both names are still one and the same file: nothing becomes unreachable. */
async function dropSameFile(second: string, path: string): Promise<void> {
  if (!/\.(shed|restore)-[0-9A-Za-z-]+\.(orig|new)$/.test(second)) return;
  const [a, b] = await Promise.all([stat(second).catch(() => null), stat(path).catch(() => null)]);
  if (a && b && a.ino === b.ino && a.dev === b.dev) await unlink(second);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The last look and the rename, with nothing in between: no await, so no other work of this process
 * runs there, and the size and mtime of the open original and the inode at the path are what was
 * verified. Returns why not, or null once renamed.
 */
function swapNow(handle: FileHandle, path: string, temp: string, was: OpenStamp, stop: () => Refusal | null): Refusal | null {
  const open = fstatSync(handle.fd);
  if (open.size !== was.size || open.mtimeMs !== was.mtimeMs) return "changed";
  const named = statSync(path);
  if (named.ino !== was.ino || named.dev !== was.dev) return "changed";
  const why = stop();
  if (why) return why;
  renameSync(temp, path);
  return null;
}

/**
 * After a rename: the replaced file (still open in `handle`) must have no holder and no new byte. A writer
 * that had it open before the rename would otherwise write into a file with no name.
 */
async function quiet(env: ShedEnv, plan: ShedPlan, handle: FileHandle, was: OpenStamp): Promise<boolean> {
  const inode = { dev: was.dev, ino: was.ino };
  for (let attempt = 0; ; attempt++) {
    const holders = await env.processes.holders(plan.path, plan.sessionId, inode);
    if (holders === null) return false;
    if (holders.length === 0) break;
    if (attempt === 4) return false;
    await sleep(100);
  }
  const now = await handle.stat();
  return now.size === was.size && now.mtimeMs === was.mtimeMs;
}

/** Whether `needle` occurs in `path` at or after byte `from`. */
async function occursFrom(path: string, from: number, needle: Buffer): Promise<boolean> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    const size = (await handle.stat()).size;
    if (size - from < needle.length) return false;
    const tail = Buffer.allocUnsafe(size - from);
    const { bytesRead } = await handle.read(tail, 0, tail.length, from);
    return tail.subarray(0, bytesRead).includes(needle);
  } finally {
    await handle.close();
  }
}

/** Whether the file's last byte ends a line (an empty file does). */
async function endsLine(path: string): Promise<boolean> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    const size = (await handle.stat()).size;
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

/** Copies the moved subagent transcripts back from the backup where their place is free. */
async function putSubagentsBack(plan: ShedPlan): Promise<void> {
  if ((plan.movedSubagents ?? []).length === 0) return;
  const subagentsDir = join(dirname(plan.path), basename(plan.path, ".jsonl"), "subagents");
  await mkdir(subagentsDir, { recursive: true });
  for (const name of plan.movedSubagents ?? []) {
    const sub = plan.subagents.find((s) => s.name === name)!;
    for (const file of [sub, ...(sub.meta ? [sub.meta] : [])]) {
      const target = join(subagentsDir, file.name);
      if (existsSync(target)) continue;
      await copyVerified(join(plan.backupDir, "subagents", file.name), target, file);
    }
  }
  await fsyncDir(subagentsDir);
}

/**
 * Starts undoing a swap whose replaced file was written to. The record is saved first, so a kill at any
 * later point leaves a plan the next settle finishes from the files (`finishRollback`).
 */
async function startRollback(env: ShedEnv, plan: ShedPlan, kind: "shed" | "restore", replacementSize: number, origSize: number): Promise<"done" | "pending"> {
  plan.rollback = { kind, replacementSize, origSize, copied: 0, startedAt: at(env) };
  await savePlan(env, plan);
  return finishRollback(env, plan);
}

/**
 * Undoes a swap, each step safe to repeat after a kill: the replaced file (with every late byte, in order)
 * goes back under its name, and the whole lines written into the replacement meanwhile are appended after
 * it, in one write. The replacement keeps a second name (`.new`) until that copy is done and no process
 * holds it; one that is still held, or that ends in a torn line, stays and the run log and status say so.
 * Then the plan's state is what it was before the swap: a shed is discarded (its backup stays), a restore
 * is committed again.
 */
async function finishRollback(env: ShedEnv, plan: ShedPlan): Promise<"done" | "pending"> {
  const record = plan.rollback!;
  const names = sideNames(plan);
  const original = names[record.kind === "shed" ? 0 : 2]!;
  const spare = names[record.kind === "shed" ? 1 : 3]!;
  const pending = async (why: string): Promise<"pending"> => {
    await logRun(env, { event: "rollback-pending", kind: record.kind, agentId: plan.agentId, why, ...(existsSync(spare) ? { keptReplacementAs: spare } : {}) });
    return "pending";
  };
  let named = await stat(plan.path).catch(() => null);
  if (!named) return pending("no transcript");
  let replacement = await stat(spare).catch(() => null);
  const replaced = await stat(original).catch(() => null);
  if (replaced) {
    // Not renamed back yet: the transcript's name is still the replacement's.
    if (replaced.ino === named.ino && replaced.dev === named.dev) return pending("the replaced file is already back under its name and still has a second name");
    await env.step?.("rollback:link");
    if (!replacement) {
      await link(plan.path, spare);
      replacement = await stat(spare);
    } else if (replacement.ino !== named.ino || replacement.dev !== named.dev) {
      return pending("the replacement's second name holds another file");
    }
    await env.step?.("rollback:rename");
    renameSync(original, plan.path);
    await fsyncDir(dirname(plan.path));
    named = await stat(plan.path);
  }
  let torn = 0;
  if (replacement) {
    if (replacement.ino === named.ino && replacement.dev === named.dev) return pending("the replacement is under the transcript's name and the replaced file is gone");
    const spareHandle = await open(spare, constants.O_RDONLY);
    try {
      let held = true;
      for (let attempt = 0; attempt < 5; attempt++) {
        const holders = await env.processes.holders(plan.path, plan.sessionId, { dev: replacement.dev, ino: replacement.ino });
        held = holders === null || holders.length > 0;
        if (!held) break;
        await sleep(100);
      }
      const size = (await spareHandle.stat()).size;
      const from = record.replacementSize + record.copied;
      if (size > from) {
        const segment = Buffer.allocUnsafe(size - from);
        const { bytesRead } = await spareHandle.read(segment, 0, segment.length, from);
        // Whole lines only: a line still being written stays in the replacement for now.
        const whole = segment.subarray(0, segment.subarray(0, bytesRead).lastIndexOf(0x0a) + 1);
        torn = bytesRead - whole.length;
        if (whole.length > 0) {
          await env.step?.("rollback:append");
          // Already there (killed after the write, before the record was saved): not again.
          if (!(await occursFrom(plan.path, record.origSize, whole))) {
            let ready = await endsLine(plan.path);
            for (let attempt = 0; !ready && attempt < 5; attempt++) { await sleep(100); ready = await endsLine(plan.path); }
            if (!ready) return pending("the transcript ends in a line still being written");
            // One write: an O_APPEND write of a regular file is not interleaved with another writer's.
            const target = await open(plan.path, constants.O_WRONLY | constants.O_APPEND);
            try {
              const { bytesWritten } = await target.write(whole, 0, whole.length);
              if (bytesWritten !== whole.length) throw new Error("short append");
              await target.sync();
            } finally {
              await target.close();
            }
          }
          record.copied += whole.length;
          await savePlan(env, plan);
        }
      }
      if (held) return pending("a process still holds the replacement");
      if (torn === 0) {
        await env.step?.("rollback:drop");
        if (!(await dropSecondName(spare, { ino: replacement.ino, size }))) return pending("the replacement changed while it was copied");
      }
    } finally {
      await spareHandle.close();
    }
  }
  if (record.kind === "shed") {
    await putSubagentsBack(plan);
    plan.state = "discarded";
    plan.discardedWhy = "late-write";
  } else {
    plan.state = "committed";
  }
  const copied = record.copied;
  delete plan.rollback;
  await savePlan(env, plan);
  await logRun(env, { event: "rolled-back", kind: record.kind, agentId: plan.agentId, why: "the replaced file was written to after the last check", appendedFromReplacement: copied, ...(torn > 0 ? { tornLineKeptIn: spare, tornBytes: torn } : {}) });
  return "done";
}

// ---------------------------------------------------------------------------------------------- commit

/**
 * Replaces the transcript with the planned cut, after re-verifying everything. Call only where no
 * Claude process can be writing it (see `openIsSafe`). Never throws; a refusal leaves every file as
 * it was, plus whatever was written meanwhile. It stops before the rename once `deadline` (an absolute
 * time) passes or `signal` aborts.
 */
export async function commit(env: ShedEnv, plan: ShedPlan, deadline: number, signal?: AbortSignal): Promise<Outcome> {
  return withLock(env, plan, () => commitLocked(env, plan, deadline, signal), () => ({ ok: false, why: "busy", plan }));
}

async function commitLocked(env: ShedEnv, plan: ShedPlan, deadline: number, signal?: AbortSignal): Promise<Outcome> {
  const now = () => (env.now ?? Date.now)();
  const stop = (): Refusal | null => (signal?.aborted ? "aborted" : now() > deadline ? "deadline" : null);
  const [temp] = tempNames(plan);
  const [kept] = sideNames(plan);
  let handle: FileHandle | null = null;
  try {
    if ((await readPlans(env, plan.agentId)).unreadable.length > 0) return { ok: false, why: "unreadable-plan", plan };
    if (plan.state !== "prepared") return { ok: false, why: "changed", plan };
    const located = await resolveTranscript(plan.sessionId, await env.configDirs());
    if ("why" in located) return { ok: false, why: located.why, plan };
    if (located.path !== plan.path) return { ok: false, why: "ambiguous-transcript", plan };
    const holders = await env.processes.holders(plan.path, plan.sessionId);
    if (holders === null) return { ok: false, why: "no-proc", plan };
    if (holders.length > 0) return { ok: false, why: "busy", plan };
    await env.step?.("commit:verify-original");
    // Held open to the end: every later read is of this file, and its growth after the rename is seen.
    handle = await open(plan.path, constants.O_RDONLY);
    const current = await stampHandle(handle);
    if (current.sha256 !== plan.original.sha256 || current.size !== plan.original.size || current.ino !== plan.original.ino) {
      return { ok: false, why: "changed", plan };
    }
    if (stop()) return { ok: false, why: stop()!, plan };
    await env.step?.("commit:verify-backup");
    const backup = await stampFile(join(plan.backupDir, "transcript.jsonl"));
    if (backup.sha256 !== plan.original.sha256 || backup.size !== plan.original.size) return { ok: false, why: "backup-mismatch", plan };
    const sessionDir = join(dirname(plan.path), basename(plan.path, ".jsonl"));
    const nowSubs = await subagentStamps(sessionDir);
    const planned = new Map(plan.subagents.map((s) => [s.name, s]));
    if (nowSubs.length !== plan.subagents.length) return { ok: false, why: "subagents-changed", plan };
    for (const { name, stamp, meta } of nowSubs) {
      const was = planned.get(name);
      if (!was || was.sha256 !== stamp.sha256 || was.size !== stamp.size || (was.meta?.sha256 ?? null) !== (meta?.sha256 ?? null)) {
        return { ok: false, why: "subagents-changed", plan };
      }
    }
    for (const sub of plan.subagents.filter((s) => s.move)) {
      const copy = await stampFile(join(plan.backupDir, "subagents", sub.name));
      if (copy.sha256 !== sub.sha256) return { ok: false, why: "backup-mismatch", plan };
    }
    if (stop()) return { ok: false, why: stop()!, plan };
    // The new file goes to a temp name beside the transcript, never over anything, with the transcript's mode.
    await clearOwnTemp(temp!);
    await env.step?.("commit:write-temp");
    const written = await writeParts(temp!, plan.cut.ranges.map(([o, l]) => [handle!, o, l] as const), current.mode);
    const tempStamp = await stampFile(temp!);
    if (written !== plan.expectedSha256 || tempStamp.sha256 !== plan.expectedSha256 || tempStamp.size !== plan.cut.newSize) {
      await clearOwnTemp(temp!);
      return { ok: false, why: "backup-mismatch", plan };
    }
    if (stop()) { await clearOwnTemp(temp!); return { ok: false, why: stop()!, plan }; }
    await env.step?.("commit:holders");
    const late = await env.processes.holders(plan.path, plan.sessionId);
    if (late === null || late.length > 0) {
      await clearOwnTemp(temp!);
      return { ok: false, why: late === null ? "no-proc" : "busy", plan };
    }
    plan.state = "committing";
    await savePlan(env, plan);
    // The original gets a second name until the swap proves quiet, so nothing written to it can be lost.
    await env.step?.("commit:link");
    await link(plan.path, kept!);
    await env.step?.("commit:rename");
    const why = swapNow(handle, plan.path, temp!, current, stop);
    if (why) {
      await dropSameFile(kept!, plan.path);
      await clearOwnTemp(temp!);
      plan.state = "prepared";
      await savePlan(env, plan);
      return { ok: false, why, plan };
    }
    await fsyncDir(dirname(plan.path));
    await env.step?.("commit:after-rename");
    // Quiet: the original is exactly the verified backup, so its second name can go. A drop that fails means
    // the original changed after the check: undone like any late write, never left only under the second name.
    const calm = await quiet(env, plan, handle, current);
    await env.step?.("commit:drop-original");
    if (!calm || !(await dropSecondName(kept!, current))) {
      await startRollback(env, plan, "shed", plan.cut.newSize, current.size);
      return { ok: false, why: "late-write", plan };
    }
    await env.step?.("commit:verify-new");
    return await finishCommit(env, plan);
  } catch (error) {
    await logRun(env, { event: "error", stage: "commit", agentId: plan.agentId, error: message(error) });
    return { ok: false, why: `error:${message(error)}`, plan };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * After the rename: the transcript must start with exactly the planned file (Claude may have appended
 * since). Then the subagent transcripts that leave `subagents/` go, each only once its backup reads
 * back with the same hash. Also the recovery path when a crash interrupted a commit.
 */
async function finishCommit(env: ShedEnv, plan: ShedPlan, moveSubagents = true): Promise<Outcome> {
  if ((await prefixSha(plan.path, plan.cut.newSize)) !== plan.expectedSha256) {
    await logRun(env, { event: "error", stage: "verify-new", agentId: plan.agentId });
    return { ok: false, why: "error:new file differs from the plan", plan };
  }
  await env.step?.("commit:finish-save");
  plan.state = "committed";
  plan.committedAt = plan.committedAt ?? at(env);
  plan.movedSubagents = plan.movedSubagents ?? [];
  await savePlan(env, plan);
  await writeFile(join(plan.backupDir, "committed.json"), JSON.stringify({ committedAt: plan.committedAt, newSha256: plan.expectedSha256, newSize: plan.cut.newSize }, null, 2), { mode: 0o600 }).catch(() => undefined);
  const subagentsDir = join(dirname(plan.path), basename(plan.path, ".jsonl"), "subagents");
  for (const sub of plan.subagents.filter((s) => moveSubagents && s.move && !plan.movedSubagents!.includes(s.name))) {
    await env.step?.(`commit:subagent:${sub.name}`);
    const movedSource = join(subagentsDir, sub.name);
    const copy = await stampFile(join(plan.backupDir, "subagents", sub.name)).catch(() => null);
    const live = await stampFile(movedSource).catch(() => null);
    if (!copy || copy.sha256 !== sub.sha256) continue;
    if (live && live.sha256 !== sub.sha256) continue;
    if (sub.meta) {
      const movedMeta = join(subagentsDir, sub.meta.name);
      const metaCopy = await stampFile(join(plan.backupDir, "subagents", sub.meta.name)).catch(() => null);
      const metaLive = await stampFile(movedMeta).catch(() => null);
      if (!metaCopy || metaCopy.sha256 !== sub.meta.sha256 || (metaLive && metaLive.sha256 !== sub.meta.sha256)) continue;
      if (metaLive) await unlink(movedMeta);
    }
    if (live) await unlink(movedSource);
    plan.movedSubagents!.push(sub.name);
    await savePlan(env, plan);
  }
  await fsyncDir(subagentsDir);
  await logRun(env, { event: "committed", agentId: plan.agentId, sessionId: plan.sessionId, from: plan.original.size, to: plan.cut.newSize, movedSubagents: plan.movedSubagents!.length, backupDir: plan.backupDir });
  return { ok: true, plan };
}

// ---------------------------------------------------------------------------------------------- settle

/**
 * Settles a plan a crash or a change left behind. A rollback under way is finished first, before any other
 * decision. A commit or restore interrupted after its rename is finished (or undone, when the replaced file
 * was written to); a plan whose transcript moved on is discarded, and its backup stays. Smart Session never
 * deletes a backup. `moveSubagents: false` (the setting off) finishes what must be finished so no line is
 * stranded, and moves no subagent.
 */
export async function settle(env: ShedEnv, plan: ShedPlan, options: { readonly moveSubagents?: boolean } = {}): Promise<"none" | "finished" | "discarded" | "kept"> {
  return withLock(env, plan, () => settleLocked(env, plan, options.moveSubagents ?? true), () => "kept" as const);
}

/** Whether a plan has work a crash left: a rollback, a swap after its rename, or a second name beside the transcript. */
export function needsRecovery(plan: ShedPlan): boolean {
  return plan.rollback !== undefined || plan.state === "committing" || plan.state === "restoring" || sideNames(plan).some((name) => existsSync(name));
}

async function settleRollback(env: ShedEnv, plan: ShedPlan): Promise<"discarded" | "kept"> {
  const kind = plan.rollback!.kind;
  const out = await finishRollback(env, plan);
  return out === "done" && kind === "shed" ? "discarded" : "kept";
}

async function settleLocked(env: ShedEnv, plan: ShedPlan, moveSubagents = true): Promise<"none" | "finished" | "discarded" | "kept"> {
  if ((await readPlans(env, plan.agentId)).unreadable.length > 0) return "kept";
  const stored = (await agentPlans(env, plan.agentId)).find((p) => p.id === plan.id);
  if (stored) Object.assign(plan, stored);
  if (plan.rollback) return settleRollback(env, plan);
  const [temp] = tempNames(plan);
  const [kept, spare] = sideNames(plan);
  if (plan.state === "committing" || plan.state === "committed") {
    // A rollback 3.8.0-beta.2 began without a record (its replacement's second name is there): finish it.
    if (existsSync(spare!)) {
      await env.step?.("settle:read");
      return startRollback(env, plan, "shed", plan.cut.newSize, plan.original.size).then((out) => (out === "done" ? "discarded" : "kept"));
    }
  }
  if (plan.state === "committed") {
    const named = await stat(plan.path).catch(() => null);
    const old = await stat(kept!).catch(() => null);
    if (named && old && !(old.ino === named.ino && old.dev === named.dev)) {
      // A second name a commit failed to drop (3.8.0-beta.2 ignored that): the backup itself, or grown with late lines.
      await env.step?.("settle:read");
      const holders = await env.processes.holders(plan.path, plan.sessionId);
      if (holders === null || holders.length > 0) return "kept";
      if (old.size === plan.original.size && (await stampFile(kept!)).sha256 === plan.original.sha256) {
        await dropSecondName(kept!, { ino: old.ino, size: old.size });
      } else if (old.size > plan.original.size && (await prefixSha(kept!, plan.original.size)) === plan.original.sha256) {
        return (await startRollback(env, plan, "shed", plan.cut.newSize, plan.original.size)) === "done" ? "discarded" : "kept";
      } else {
        await logRun(env, { event: "kept", agentId: plan.agentId, why: "a second name beside the transcript matches neither the backup nor the backup grown", file: kept });
        return "kept";
      }
    }
    const pending = plan.subagents.some((s) => s.move && !(plan.movedSubagents ?? []).includes(s.name));
    if (!pending || !moveSubagents) return "none";
    const holders = await env.processes.holders(plan.path, plan.sessionId);
    if (holders === null || holders.length > 0) return "kept";
    await finishCommit(env, plan);
    return "finished";
  }
  if (plan.state === "restoring") return settleRestore(env, plan);
  if (plan.state !== "prepared" && plan.state !== "committing") return "none";
  const holders = await env.processes.holders(plan.path, plan.sessionId);
  if (holders === null || holders.length > 0) return "kept";
  const named = await stat(plan.path).catch(() => null);
  if (!named) return "kept";
  await env.step?.("settle:read");
  // Linked but not renamed: one file under two names.
  await dropSameFile(kept!, plan.path);
  // Shed already? The transcript starts with the planned new file.
  if ((await prefixSha(plan.path, plan.cut.newSize).catch(() => null)) === plan.expectedSha256 && named.ino !== plan.original.ino) {
    const old = await stat(kept!).catch(() => null);
    if (old) {
      const oldHolders = await env.processes.holders(plan.path, plan.sessionId, { dev: old.dev, ino: old.ino });
      if (oldHolders === null || oldHolders.length > 0 || old.size !== plan.original.size) {
        return (await startRollback(env, plan, "shed", plan.cut.newSize, plan.original.size)) === "done" ? "discarded" : "kept";
      }
      if (!(await dropSecondName(kept!, { ino: old.ino, size: plan.original.size }))) {
        return (await startRollback(env, plan, "shed", plan.cut.newSize, plan.original.size)) === "done" ? "discarded" : "kept";
      }
    }
    await clearOwnTemp(temp!);
    await finishCommit(env, plan, moveSubagents);
    return "finished";
  }
  // Not shed: the transcript still starts with the backed-up original.
  if ((await prefixSha(plan.path, plan.original.size).catch(() => null)) === plan.original.sha256) {
    await clearOwnTemp(temp!);
    if (named.size === plan.original.size) {
      // Untouched (a crash before the rename at most): the plan still holds.
      if (plan.state !== "prepared") { plan.state = "prepared"; await savePlan(env, plan); }
      return "none";
    }
    plan.state = "discarded";
    plan.discardedWhy = "moved-on";
    await savePlan(env, plan);
    await logRun(env, { event: "discarded", agentId: plan.agentId, why: "transcript moved on before the commit; its backup stays", backupDir: plan.backupDir });
    return "discarded";
  }
  await logRun(env, { event: "kept", agentId: plan.agentId, why: "transcript matches neither the original nor the cut" });
  return "kept";
}

/** A restore that crashed: finished when its rename happened (or undone, if the shed file was written to), else back to committed. */
async function settleRestore(env: ShedEnv, plan: ShedPlan): Promise<"finished" | "kept" | "none"> {
  const [, restoreTemp] = tempNames(plan);
  const [, , kept] = sideNames(plan);
  const holders = await env.processes.holders(plan.path, plan.sessionId);
  if (holders === null || holders.length > 0) return "kept";
  const named = await stat(plan.path).catch(() => null);
  if (!named) return "kept";
  await dropSameFile(kept!, plan.path);
  const restored = (await prefixSha(plan.path, plan.original.size).catch(() => null)) === plan.original.sha256;
  if (restored) {
    const old = await stat(kept!).catch(() => null);
    if (old) {
      const oldHolders = await env.processes.holders(plan.path, plan.sessionId, { dev: old.dev, ino: old.ino });
      const keptCopy = (await readdir(plan.backupDir).catch(() => [] as string[])).filter((n) => n.startsWith("before-restore-")).sort().pop();
      const copied = keptCopy ? (await stat(join(plan.backupDir, keptCopy))).size : -1;
      if (oldHolders === null || oldHolders.length > 0 || old.size !== copied) {
        // The restored file's size is only known by a record; without one (3.8.0-beta.2) it stays for a person.
        await logRun(env, { event: "kept", stage: "restore", agentId: plan.agentId, why: "the shed file was written to after a restore's last check", file: kept });
        return "kept";
      }
      await dropSecondName(kept!, { ino: old.ino, size: old.size });
    }
    await clearOwnTemp(restoreTemp!);
    await finishRestore(env, plan, null);
    return "finished";
  }
  await clearOwnTemp(restoreTemp!);
  plan.state = "committed";
  await savePlan(env, plan);
  return "none";
}

// ---------------------------------------------------------------------------------------------- restore

/**
 * Puts the full history back: the backup, then every line written since the shed. The current
 * transcript is itself backed up first. Same safety rules as `commit`, the last look included.
 * Subagent transcripts come back when their place is free.
 */
export async function restore(env: ShedEnv, plan: ShedPlan, deadline: number, signal?: AbortSignal): Promise<Outcome> {
  return withLock(env, plan, async () => {
    if (plan.state === "committing" || plan.state === "restoring" || plan.rollback) await settleLocked(env, plan);
    return restoreLocked(env, plan, deadline, signal);
  }, () => ({ ok: false, why: "busy", plan }));
}

async function restoreLocked(env: ShedEnv, plan: ShedPlan, deadline: number, signal?: AbortSignal): Promise<Outcome> {
  const now = () => (env.now ?? Date.now)();
  const stop = (): Refusal | null => (signal?.aborted ? "aborted" : now() > deadline ? "deadline" : null);
  const [, temp] = tempNames(plan);
  const [, , kept] = sideNames(plan);
  let handle: FileHandle | null = null;
  try {
    if ((await readPlans(env, plan.agentId)).unreadable.length > 0) return { ok: false, why: "unreadable-plan", plan };
    if (plan.rollback) return { ok: false, why: "busy", plan };
    if (plan.state !== "committed") return { ok: false, why: "nothing-to-restore", plan };
    const located = await resolveTranscript(plan.sessionId, await env.configDirs());
    if ("why" in located) return { ok: false, why: located.why, plan };
    if (located.path !== plan.path) return { ok: false, why: "ambiguous-transcript", plan };
    const holders = await env.processes.holders(plan.path, plan.sessionId);
    if (holders === null) return { ok: false, why: "no-proc", plan };
    if (holders.length > 0) return { ok: false, why: "busy", plan };
    handle = await open(plan.path, constants.O_RDONLY);
    const current = await stampHandle(handle);
    if ((await prefixShaOf(handle, plan.cut.newSize)) !== plan.expectedSha256) return { ok: false, why: "restore-mismatch", plan };
    const backup = join(plan.backupDir, "transcript.jsonl");
    const backupStamp = await stampFile(backup);
    if (backupStamp.sha256 !== plan.original.sha256) return { ok: false, why: "backup-mismatch", plan };
    if (stop()) return { ok: false, why: stop()!, plan };
    // The transcript as it is now is kept too, so a restore loses nothing either.
    await env.step?.("restore:backup-current");
    const before = join(plan.backupDir, `before-restore-${Date.now()}.jsonl`);
    await copyVerified(handle, before, current);
    await fsyncDir(plan.backupDir);
    await clearOwnTemp(temp!);
    await env.step?.("restore:write-temp");
    // Backup, then what was appended after the cut, read from the file as verified.
    const appended = current.size - plan.cut.newSize;
    const restoredSha = await writeParts(temp!, [[backup, 0, backupStamp.size], [handle, plan.cut.newSize, appended]], current.mode);
    const restored = await stampFile(temp!);
    if (restored.sha256 !== restoredSha || restored.size !== backupStamp.size + appended) {
      await clearOwnTemp(temp!);
      return { ok: false, why: "backup-mismatch", plan };
    }
    if (stop()) { await clearOwnTemp(temp!); return { ok: false, why: stop()!, plan }; }
    await env.step?.("restore:holders");
    const late = await env.processes.holders(plan.path, plan.sessionId);
    if (late === null || late.length > 0) {
      await clearOwnTemp(temp!);
      return { ok: false, why: late === null ? "no-proc" : "busy", plan };
    }
    plan.state = "restoring";
    await savePlan(env, plan);
    await env.step?.("restore:link");
    await link(plan.path, kept!);
    await env.step?.("restore:rename");
    const why = swapNow(handle, plan.path, temp!, current, stop);
    if (why) {
      await dropSameFile(kept!, plan.path);
      await clearOwnTemp(temp!);
      plan.state = "committed";
      await savePlan(env, plan);
      return { ok: false, why, plan };
    }
    await fsyncDir(dirname(plan.path));
    await env.step?.("restore:after-rename");
    const calm = await quiet(env, plan, handle, current);
    await env.step?.("restore:drop-original");
    if (!calm || !(await dropSecondName(kept!, current))) {
      await startRollback(env, plan, "restore", restored.size, current.size);
      return { ok: false, why: "late-write", plan };
    }
    // By prefix: Claude may already have appended to the restored file.
    if ((await prefixSha(plan.path, restored.size)) !== restoredSha) return { ok: false, why: "error:restored file differs", plan };
    await finishRestore(env, plan, { size: restored.size, appended, keptCurrentAs: basename(before) });
    return { ok: true, plan };
  } catch (error) {
    await logRun(env, { event: "error", stage: "restore", agentId: plan.agentId, error: message(error) });
    return { ok: false, why: `error:${message(error)}`, plan };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function finishRestore(env: ShedEnv, plan: ShedPlan, done: { size: number; appended: number; keptCurrentAs: string } | null): Promise<void> {
  await putSubagentsBack(plan);
  plan.state = "restored";
  plan.restoredAt = at(env);
  await savePlan(env, plan);
  await writeFile(join(plan.backupDir, "restored.json"), JSON.stringify({ restoredAt: plan.restoredAt, keptCurrentAs: done?.keptCurrentAs ?? null }, null, 2), { mode: 0o600 }).catch(() => undefined);
  await logRun(env, { event: "restored", agentId: plan.agentId, sessionId: plan.sessionId, ...(done ? { size: done.size, appended: done.appended } : { recovered: true }) });
}

// ---------------------------------------------------------------------------------------------- leftovers

const SIDE_NAME = /^\.(.+\.jsonl)\.(shed|restore)-([0-9A-Za-z-]+)\.(orig|new)$/;

/**
 * Second names (`.shed-*.orig`, `.shed-*.new`, and the restore ones) beside any transcript a plan names: what a
 * kill, or a writer still holding a file, left. Stat only, no transcript is read. For the status.
 */
export async function leftoverFiles(env: ShedEnv): Promise<{ agentId: string | null; planId: string; file: string; size: number }[]> {
  const owners = new Map<string, string>();
  const dirs = new Set<string>();
  for (const id of await agentIds(env)) {
    for (const plan of (await readPlans(env, id)).plans) { owners.set(plan.id, plan.agentId); dirs.add(dirname(plan.path)); }
  }
  const out: { agentId: string | null; planId: string; file: string; size: number }[] = [];
  for (const dir of dirs) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const match = SIDE_NAME.exec(name);
      if (!match) continue;
      const info = await stat(join(dir, name)).catch(() => null);
      if (info) out.push({ agentId: owners.get(match[3]!) ?? null, planId: match[3]!, file: join(dir, name), size: info.size });
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------- 3.8.0-beta.1 backups

/**
 * Copies every backup 3.8.0-beta.1 kept beside its transcript (`<session>/shed/<plan>/`) into the data
 * folder, verifying each file by sha256, then points the plan at the copy. The old folder is left
 * exactly as it was, plus a note saying where the copy went. Returns how many moved.
 */
export async function migrateBackups(env: ShedEnv): Promise<number> {
  let moved = 0;
  for (const id of await agentIds(env)) {
    for (const plan of (await readPlans(env, id)).plans) {
      if (plan.backupDir.startsWith(`${backupRoot(env)}/`) || !existsSync(plan.backupDir)) continue;
      const done = await withLock(env, plan, async () => {
        const target = backupDirFor(env, plan.path, plan.sessionId, plan.id);
        await copyTree(plan.backupDir, target);
        const from = plan.backupDir;
        plan.migratedFrom = from;
        plan.backupDir = target;
        await savePlan(env, plan);
        await writeFile(join(from, "moved-to.json"), JSON.stringify({ movedTo: target, at: at(env), note: "Smart Session copied this backup there and verified it. This folder was left as it was." }, null, 2), { flag: "wx", mode: 0o600 }).catch(() => undefined);
        await logRun(env, { event: "migrated", agentId: plan.agentId, from, to: target });
        return true;
      }, () => false).catch(async (error) => {
        await logRun(env, { event: "error", stage: "migrate", agentId: plan.agentId, error: message(error) });
        return false;
      });
      if (done) moved++;
    }
  }
  return moved;
}

/** Copies a folder's files, each verified; an earlier, interrupted copy of the same file is replaced by a new one. */
async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) { await copyTree(source, target); continue; }
    if (!entry.isFile() || entry.name === ".lock" || entry.name === "moved-to.json") continue;
    const stamp = await stampFile(source);
    const there = await stampFile(target).catch(() => null);
    if (there && there.sha256 === stamp.sha256 && there.size === stamp.size) continue;
    const partial = `${target}.copy-${randomUUID().slice(0, 8)}`;
    await copyVerified(source, partial, stamp);
    await rename(partial, target);
  }
  await fsyncDir(to);
}

// ---------------------------------------------------------------------------------------------- config dirs

/** CLAUDE_CONFIG_DIR, ~/.claude and every ZeroSub account home. */
export async function claudeConfigDirs(paseoHome: string, extra: readonly (string | undefined)[] = []): Promise<string[]> {
  const dirs = [...extra.filter((d): d is string => typeof d === "string" && d.length > 0), process.env.CLAUDE_CONFIG_DIR, join(homedir(), ".claude")]
    .filter((d): d is string => typeof d === "string" && d.length > 0);
  try {
    const state = JSON.parse(await readFile(join(paseoHome, "zerosub", "state.json"), "utf8"));
    for (const account of Array.isArray(state?.accounts) ? state.accounts : []) {
      if (account?.family === "claude" && typeof account.home === "string" && account.home.length > 0) dirs.push(account.home);
    }
  } catch { /* No ZeroSub. */ }
  return [...new Set(dirs)];
}
