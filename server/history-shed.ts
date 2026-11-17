/**
 * Moving a Claude transcript's history from before its last compaction into a backup (the I/O part).
 * Off unless the person turns it on (`shedHistory`); see `shared/history-shed.ts` for what is cut.
 *
 * Invariants (AGENTS.md, tests in history-shed.test.ts):
 * - No data is lost. A full copy of the transcript, and of every subagent transcript that leaves
 *   `subagents/`, is written and verified by sha256 before anything changes. Smart Session never
 *   deletes a backup; only the person can.
 * - Only the intended files change: the one transcript resolved from the agent's own persisted
 *   session id, and the subagent transcripts the plan names. Nothing is globbed; anything ambiguous
 *   (several candidate files, a size or hash that moved, a process holding the file) refuses.
 * - The transcript is replaced only by an atomic rename, and only while no Claude process can be
 *   writing it: inside Paseo's `agent.open.before` for an agent that is not loaded (a resume, an
 *   import, or a history-only open). A reload (`refresh`) still has its old runtime alive, so it
 *   never sheds there.
 * - An agent's id and its post-compaction context survive: same file path, same session id, and the
 *   chain Claude rebuilds is byte-identical (`planCut` refuses otherwise).
 *
 * Two phases. `prepare` runs while an agent is not loaded and only reads its files, writing the
 * backup and a plan. `commit` runs at the agent's next open: it re-verifies everything against the
 * plan, writes the new file to a temp name, checks its hash, and renames it over the transcript.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, readlink, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
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

// ---------------------------------------------------------------------------------------------- types

export interface FileStamp {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
  readonly sha256: string;
}

export interface SubagentEntry extends FileStamp {
  readonly name: string;
  /** The `.meta.json` beside it, when there is one. */
  readonly meta: (FileStamp & { readonly name: string }) | null;
  /** Leaves `subagents/` at the commit (its whole run predates the cut). */
  readonly move: boolean;
}

export type PlanState = "prepared" | "committing" | "committed" | "restored" | "discarded";

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
  readonly backupDir: string;
  readonly subagents: readonly SubagentEntry[];
  readonly preparedAt: string;
  state: PlanState;
  committedAt?: string;
  /** Subagent transcripts already removed from `subagents/` after their backup was re-verified. */
  movedSubagents?: string[];
  restoredAt?: string;
  /** The person asked for the full history back; done at the agent's next safe open. */
  restoreRequested?: boolean;
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
  | "unsafe-open"
  | "restore-mismatch"
  | "nothing-to-restore"
  | `cut:${string}`
  | `due:${string}`
  | `error:${string}`;

export type Outcome =
  | { readonly ok: true; readonly plan: ShedPlan }
  | { readonly ok: false; readonly why: Refusal; readonly plan?: ShedPlan };

/** Which processes hold a file open or name a session id on their command line. Null: unknown. */
export interface ProcessView {
  holders(path: string, sessionId: string): Promise<string[] | null>;
}

export interface ShedEnv {
  /** Smart Session's data folder (plans, run log). */
  readonly dataDir: string;
  /** Claude config folders to look in: CLAUDE_CONFIG_DIR, ~/.claude, ZeroSub account homes. */
  readonly configDirs: () => Promise<string[]>;
  readonly processes: ProcessView;
  readonly now?: () => number;
  /** Test seam: called before each step; a throw there stands in for a crash at that point. */
  readonly step?: (name: string) => void | Promise<void>;
}

const at = (env: ShedEnv) => new Date((env.now ?? Date.now)()).toISOString();

// ---------------------------------------------------------------------------------------------- files

/** sha256 and size of a file, read in chunks; also the stamp it had when the read began. */
export async function stampFile(path: string): Promise<FileStamp> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    const before = await handle.stat();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return { size: position, mtimeMs: before.mtimeMs, ino: before.ino, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

/** sha256 of a file's first `length` bytes; null when it is shorter. */
async function prefixSha(path: string, length: number): Promise<string | null> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    if ((await handle.stat()).size < length) return null;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK);
    let position = 0;
    while (position < length) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, length - position), position);
      if (bytesRead === 0) return null;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
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

/** Copy `ranges` of `source` into a new file (never an existing one), synced; returns its sha256. */
async function writeRanges(source: string, ranges: readonly (readonly [number, number])[], target: string): Promise<string> {
  const input = await open(source, constants.O_RDONLY);
  const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK);
    for (const [offset, length] of ranges) {
      let done = 0;
      while (done < length) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, length - done), offset + done);
        if (bytesRead === 0) throw new Error("source ended early");
        const slice = buffer.subarray(0, bytesRead);
        hash.update(slice);
        await output.write(slice, 0, slice.length);
        done += bytesRead;
      }
    }
    await output.sync();
    return hash.digest("hex");
  } finally {
    await input.close();
    await output.close();
  }
}

/** A verified copy into a new file. Throws unless the copy's own hash equals `expect`. */
async function copyVerified(source: string, target: string, expect: FileStamp): Promise<void> {
  const written = await writeRanges(source, [[0, expect.size]], target);
  if (written !== expect.sha256) throw new Error("copy differs from its source");
  const reread = await stampFile(target);
  if (reread.sha256 !== expect.sha256 || reread.size !== expect.size) throw new Error("copy did not read back");
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
export async function persistedSession(paseoHome: string, agentId: string): Promise<{ provider: string; sessionId: string } | null> {
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
    return typeof provider === "string" && isSessionId(sessionId) ? { provider, sessionId } : null;
  } catch {
    return null;
  }
}

/** Linux: processes that hold `path` open, or carry `sessionId` on their command line. */
export const linuxProcesses: ProcessView = {
  async holders(path, sessionId) {
    let pids: string[];
    try { pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name)); } catch { return null; }
    const own = String(process.pid);
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
        try { if ((await readlink(`/proc/${pid}/fd/${fd}`)) === path) { out.push(`${pid}:fd`); return; } } catch { /* gone */ }
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

const planRoot = (env: ShedEnv) => join(env.dataDir, "history-shed", "plans");
const safeId = (agentId: string) => (/^[A-Za-z0-9_-]+$/.test(agentId) ? agentId : null);

/** Every plan for an agent, newest first (one file per shed, so restore can walk back through all). */
export async function agentPlans(env: ShedEnv, agentId: string): Promise<ShedPlan[]> {
  const id = safeId(agentId);
  if (!id) return [];
  let names: string[];
  try { names = (await readdir(join(planRoot(env), id))).filter((n) => n.endsWith(".json")); } catch { return []; }
  const plans: ShedPlan[] = [];
  for (const name of names) {
    try { plans.push(JSON.parse(await readFile(join(planRoot(env), id, name), "utf8")) as ShedPlan); } catch { /* skip */ }
  }
  return plans.sort((a, b) => (a.preparedAt < b.preparedAt ? 1 : a.preparedAt > b.preparedAt ? -1 : a.id < b.id ? 1 : -1));
}

/** The newest plan that still matters (not a discarded one). */
export async function readPlan(env: ShedEnv, agentId: string): Promise<ShedPlan | null> {
  return (await agentPlans(env, agentId)).find((p) => p.state !== "discarded") ?? null;
}

export async function listPlans(env: ShedEnv): Promise<ShedPlan[]> {
  let ids: string[];
  try { ids = await readdir(planRoot(env)); } catch { return []; }
  const out: ShedPlan[] = [];
  for (const id of ids) {
    const latest = await readPlan(env, id);
    if (latest) out.push(latest);
  }
  return out;
}

async function savePlan(env: ShedEnv, plan: ShedPlan): Promise<void> {
  const id = safeId(plan.agentId);
  if (!id) throw new Error("bad agent id");
  const dir = join(planRoot(env), id);
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${plan.id}.json`);
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(plan, null, 2), { mode: 0o600 });
  await rename(temp, target);
}

/** Marks every shed of this agent for restoring at its next safe open. Null when there is none. */
export async function requestRestore(env: ShedEnv, agentId: string): Promise<ShedPlan[] | null> {
  const plans = (await agentPlans(env, agentId)).filter((p) => p.state === "committed");
  if (plans.length === 0) return null;
  for (const plan of plans) {
    plan.restoreRequested = true;
    await savePlan(env, plan);
  }
  return plans;
}

/** Restores every requested shed, newest first, while time allows. */
export async function restoreRequested(env: ShedEnv, agentId: string, deadline: number): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const plan of (await agentPlans(env, agentId)).filter((p) => p.state === "committed" && p.restoreRequested)) {
    const result = await restore(env, plan, deadline);
    out.push(result);
    if (!result.ok) break;
  }
  return out;
}

/** One line per prepare, commit, restore or refusal (`history-shed/runs-YYYY-MM.jsonl`). */
export async function logRun(env: ShedEnv, entry: Record<string, unknown>): Promise<void> {
  try {
    const dir = join(env.dataDir, "history-shed");
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
  const located = await resolveTranscript(sessionId, await env.configDirs());
  if ("why" in located) return { ok: false, why: located.why };
  const path = located.path;
  await env.step?.("prepare:index");
  const { records, stamp } = await indexTranscript(path);
  const cut = planCut(records);
  if (!cut.ok) return { ok: false, why: `cut:${cut.why}` };
  const due = isDueFor(stamp.size, cut);
  if (due !== true) return { ok: false, why: `due:${due}` };
  // The file must not have changed while it was read.
  const recheck = await stat(path);
  if (recheck.size !== stamp.size || recheck.mtimeMs !== stamp.mtimeMs || recheck.ino !== stamp.ino) return { ok: false, why: "changed" };
  const expectedSha256 = await shaOfRanges(path, cut.ranges);
  const sessionDir = join(dirname(path), basename(path, ".jsonl"));
  const id = `${new Date((env.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const backupDir = join(sessionDir, "shed", id);
  await env.step?.("prepare:backup");
  await mkdir(join(backupDir, "subagents"), { recursive: true });
  await copyVerified(path, join(backupDir, "transcript.jsonl"), stamp);
  const boundaryAt = cut.boundaryTimestamp === null ? NaN : Date.parse(cut.boundaryTimestamp);
  const subagents: SubagentEntry[] = [];
  for (const { name, stamp: sub, meta } of await subagentStamps(sessionDir)) {
    const newest = await newestTimestamp(join(sessionDir, "subagents", name));
    const move = Number.isFinite(boundaryAt) && newest !== null && newest < boundaryAt;
    if (move) {
      await copyVerified(join(sessionDir, "subagents", name), join(backupDir, "subagents", name), sub);
      if (meta) await copyVerified(join(sessionDir, "subagents", meta.name), join(backupDir, "subagents", meta.name), meta);
    }
    subagents.push({ name, ...sub, meta, move });
  }
  const after = await stampFile(path);
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
  await savePlan(env, plan);
  await logRun(env, { event: "prepared", agentId, sessionId, size: stamp.size, newSize: cut.newSize, movedBytes: cut.movedBytes, compactions: cut.compactions, subagentsMoving: subagents.filter((s) => s.move).length, backupDir });
  return { ok: true, plan };
}

async function shaOfRanges(path: string, ranges: readonly (readonly [number, number])[]): Promise<string> {
  const handle = await open(path, constants.O_RDONLY);
  try {
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
  } finally {
    await handle.close();
  }
}


// ---------------------------------------------------------------------------------------------- lock

const held = new Set<string>();

/**
 * One commit, restore or settle per plan at a time, across processes: an exclusive lock file in the
 * plan's backup folder, holding the owner's pid. A lock whose pid is gone (a crash) is taken over.
 */
async function withLock<T>(plan: ShedPlan, work: () => Promise<T>, busy: () => T): Promise<T> {
  const file = join(plan.backupDir, ".lock");
  if (held.has(file)) return busy();
  held.add(file);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        await handle.writeFile(`${process.pid}`);
        await handle.close();
        try { return await work(); } finally { await unlink(file).catch(() => undefined); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = Number((await readFile(file, "utf8").catch(() => "")).trim());
        let alive = false;
        if (Number.isInteger(owner) && owner > 0) { try { process.kill(owner, 0); alive = true; } catch (e) { alive = (e as NodeJS.ErrnoException).code === "EPERM"; } }
        if (alive && owner !== process.pid) return busy();
        await unlink(file).catch(() => undefined);
      }
    }
    return busy();
  } finally {
    held.delete(file);
  }
}

// ---------------------------------------------------------------------------------------------- commit

/** What the open was: only an open with no live runtime may commit. */
export interface OpenKind {
  readonly reason: "create" | "resume" | "refresh" | "import";
  readonly purpose: "interactive" | "history";
}

export function openIsSafe(open: OpenKind): boolean {
  if (open.reason === "create" || open.reason === "refresh") return false;
  return true;
}

/**
 * Replaces the transcript with the planned cut, after re-verifying everything. Call only where no
 * Claude process can be writing it (see `openIsSafe`). Never throws; a refusal leaves every file as
 * it was. `deadline` is an absolute time after which it stops before the rename.
 */
export async function commit(env: ShedEnv, plan: ShedPlan, deadline: number): Promise<Outcome> {
  return withLock(plan, () => commitLocked(env, plan, deadline), () => ({ ok: false, why: "busy", plan }));
}

async function commitLocked(env: ShedEnv, plan: ShedPlan, deadline: number): Promise<Outcome> {
  try {
    const now = () => (env.now ?? Date.now)();
    if (plan.state !== "prepared") return { ok: false, why: "changed", plan };
    const located = await resolveTranscript(plan.sessionId, await env.configDirs());
    if ("why" in located) return { ok: false, why: located.why, plan };
    if (located.path !== plan.path) return { ok: false, why: "ambiguous-transcript", plan };
    const holders = await env.processes.holders(plan.path, plan.sessionId);
    if (holders === null) return { ok: false, why: "no-proc", plan };
    if (holders.length > 0) return { ok: false, why: "busy", plan };
    await env.step?.("commit:verify-original");
    const current = await stampFile(plan.path);
    if (current.sha256 !== plan.original.sha256 || current.size !== plan.original.size || current.ino !== plan.original.ino) {
      return { ok: false, why: "changed", plan };
    }
    if (now() > deadline) return { ok: false, why: "deadline", plan };
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
    if (now() > deadline) return { ok: false, why: "deadline", plan };
    // The new file goes to a temp name beside the transcript, never over anything.
    const temp = join(dirname(plan.path), `.${basename(plan.path)}.shed-${plan.id}.tmp`);
    await clearOwnTemp(temp);
    await env.step?.("commit:write-temp");
    const written = await writeRanges(plan.path, plan.cut.ranges, temp);
    const tempStamp = await stampFile(temp);
    if (written !== plan.expectedSha256 || tempStamp.sha256 !== plan.expectedSha256 || tempStamp.size !== plan.cut.newSize) {
      await unlink(temp).catch(() => undefined);
      return { ok: false, why: "backup-mismatch", plan };
    }
    // Last look before the rename: the transcript is still exactly what was backed up.
    const last = await stat(plan.path);
    if (last.size !== plan.original.size || last.mtimeMs !== current.mtimeMs || last.ino !== plan.original.ino || now() > deadline) {
      await unlink(temp).catch(() => undefined);
      return { ok: false, why: now() > deadline ? "deadline" : "changed", plan };
    }
    const held = await env.processes.holders(plan.path, plan.sessionId);
    if (held === null || held.length > 0) {
      await unlink(temp).catch(() => undefined);
      return { ok: false, why: held === null ? "no-proc" : "busy", plan };
    }
    plan.state = "committing";
    await savePlan(env, plan);
    await env.step?.("commit:rename");
    await rename(temp, plan.path);
    await fsyncDir(dirname(plan.path));
    await env.step?.("commit:verify-new");
    return await finishCommit(env, plan);
  } catch (error) {
    await logRun(env, { event: "error", stage: "commit", agentId: plan.agentId, error: error instanceof Error ? error.message : String(error) });
    return { ok: false, why: `error:${error instanceof Error ? error.message : String(error)}`, plan };
  }
}

/**
 * After the rename: the transcript must be exactly the planned file. Then the subagent transcripts
 * that leave `subagents/` go, each only once its backup reads back with the same hash. Also the
 * recovery path when a crash interrupted a commit.
 */
async function finishCommit(env: ShedEnv, plan: ShedPlan): Promise<Outcome> {
  const now = await stampFile(plan.path);
  if (now.sha256 !== plan.expectedSha256 || now.size !== plan.cut.newSize) {
    await logRun(env, { event: "error", stage: "verify-new", agentId: plan.agentId, size: now.size });
    return { ok: false, why: "error:new file differs from the plan", plan };
  }
  plan.state = "committed";
  plan.committedAt = plan.committedAt ?? at(env);
  plan.movedSubagents = plan.movedSubagents ?? [];
  await savePlan(env, plan);
  await writeFile(join(plan.backupDir, "committed.json"), JSON.stringify({ committedAt: plan.committedAt, newSha256: plan.expectedSha256, newSize: plan.cut.newSize }, null, 2), { mode: 0o600 }).catch(() => undefined);
  const subagentsDir = join(dirname(plan.path), basename(plan.path, ".jsonl"), "subagents");
  for (const sub of plan.subagents.filter((s) => s.move && !plan.movedSubagents!.includes(s.name))) {
    await env.step?.(`commit:subagent:${sub.name}`);
    const source = join(subagentsDir, sub.name);
    const copy = await stampFile(join(plan.backupDir, "subagents", sub.name)).catch(() => null);
    const live = await stampFile(source).catch(() => null);
    if (!copy || copy.sha256 !== sub.sha256) continue;
    if (live && live.sha256 !== sub.sha256) continue;
    if (sub.meta) {
      const metaCopy = await stampFile(join(plan.backupDir, "subagents", sub.meta.name)).catch(() => null);
      const metaLive = await stampFile(join(subagentsDir, sub.meta.name)).catch(() => null);
      if (!metaCopy || metaCopy.sha256 !== sub.meta.sha256 || (metaLive && metaLive.sha256 !== sub.meta.sha256)) continue;
      if (metaLive) await unlink(join(subagentsDir, sub.meta.name));
    }
    if (live) await unlink(source);
    plan.movedSubagents!.push(sub.name);
    await savePlan(env, plan);
  }
  await fsyncDir(subagentsDir);
  await logRun(env, { event: "committed", agentId: plan.agentId, sessionId: plan.sessionId, from: plan.original.size, to: plan.cut.newSize, movedSubagents: plan.movedSubagents!.length, backupDir: plan.backupDir });
  return { ok: true, plan };
}

/**
 * Settles a plan a crash or a change left behind. A commit interrupted after the rename is finished;
 * a plan whose transcript moved on (the agent ran again) is discarded, and only then may its unused
 * backup folder go, by exact name. Never removes a backup a commit relied on.
 */
export async function settle(env: ShedEnv, plan: ShedPlan): Promise<"none" | "finished" | "discarded" | "kept"> {
  if (!existsSync(plan.backupDir)) return "kept";
  return withLock(plan, () => settleLocked(env, plan), () => "kept" as const);
}

async function settleLocked(env: ShedEnv, plan: ShedPlan): Promise<"none" | "finished" | "discarded" | "kept"> {
  if (plan.state === "committed") {
    const pending = plan.subagents.some((s) => s.move && !(plan.movedSubagents ?? []).includes(s.name));
    if (!pending) return "none";
    const holders = await env.processes.holders(plan.path, plan.sessionId);
    if (holders === null || holders.length > 0) return "kept";
    await finishCommit(env, plan);
    return "finished";
  }
  if (plan.state !== "prepared" && plan.state !== "committing") return "none";
  // Shed already? The transcript starts with the planned new file.
  if ((await prefixSha(plan.path, plan.cut.newSize).catch(() => null)) === plan.expectedSha256) {
    const holders = await env.processes.holders(plan.path, plan.sessionId);
    if (holders === null || holders.length > 0) {
      plan.state = "committed";
      plan.committedAt = plan.committedAt ?? at(env);
      plan.movedSubagents = plan.movedSubagents ?? [];
      await savePlan(env, plan);
      return "kept";
    }
    await finishCommit(env, plan);
    return "finished";
  }
  // Not shed: the transcript still starts with the backed-up original.
  if ((await prefixSha(plan.path, plan.original.size).catch(() => null)) === plan.original.sha256) {
    const same = await stampFile(plan.path).catch(() => null);
    if (same && same.sha256 === plan.original.sha256) {
      // Untouched (a crash before the rename at most): the plan still holds.
      for (const temp of tempNames(plan)) await clearOwnTemp(temp);
      if (plan.state !== "prepared") { plan.state = "prepared"; await savePlan(env, plan); }
      return "none";
    }
    plan.state = "discarded";
    await savePlan(env, plan);
    await discardBackup(plan);
    await logRun(env, { event: "discarded", agentId: plan.agentId, why: "transcript moved on before the commit" });
    return "discarded";
  }
  await logRun(env, { event: "kept", agentId: plan.agentId, why: "transcript matches neither the original nor the cut" });
  return "kept";
}

/** Removes an unused backup folder by the exact names `prepare` wrote. */
async function discardBackup(plan: ShedPlan): Promise<void> {
  if (existsSync(join(plan.backupDir, "committed.json"))) return;
  const names = ["transcript.jsonl", "manifest.json"];
  for (const name of names) await unlink(join(plan.backupDir, name)).catch(() => undefined);
  for (const sub of plan.subagents.filter((s) => s.move)) {
    await unlink(join(plan.backupDir, "subagents", sub.name)).catch(() => undefined);
    if (sub.meta) await unlink(join(plan.backupDir, "subagents", sub.meta.name)).catch(() => undefined);
  }
  await rmdir(join(plan.backupDir, "subagents")).catch(() => undefined);
  await rmdir(plan.backupDir).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------- restore

/**
 * Puts the full history back: the backup, then every line written since the shed. The current
 * transcript is itself backed up first. Same safety rules as `commit`. Subagent transcripts come
 * back when their place is free.
 */
export async function restore(env: ShedEnv, plan: ShedPlan, deadline: number): Promise<Outcome> {
  return withLock(plan, () => restoreLocked(env, plan, deadline), () => ({ ok: false, why: "busy", plan }));
}

async function restoreLocked(env: ShedEnv, plan: ShedPlan, deadline: number): Promise<Outcome> {
  try {
    const now = () => (env.now ?? Date.now)();
    if (plan.state !== "committed") return { ok: false, why: "nothing-to-restore", plan };
    const located = await resolveTranscript(plan.sessionId, await env.configDirs());
    if ("why" in located) return { ok: false, why: located.why, plan };
    if (located.path !== plan.path) return { ok: false, why: "ambiguous-transcript", plan };
    const holders = await env.processes.holders(plan.path, plan.sessionId);
    if (holders === null) return { ok: false, why: "no-proc", plan };
    if (holders.length > 0) return { ok: false, why: "busy", plan };
    const current = await stampFile(plan.path);
    if ((await prefixSha(plan.path, plan.cut.newSize)) !== plan.expectedSha256) return { ok: false, why: "restore-mismatch", plan };
    const backup = join(plan.backupDir, "transcript.jsonl");
    const backupStamp = await stampFile(backup);
    if (backupStamp.sha256 !== plan.original.sha256) return { ok: false, why: "backup-mismatch", plan };
    if (now() > deadline) return { ok: false, why: "deadline", plan };
    // The transcript as it is now is kept too, so a restore loses nothing either.
    const before = join(plan.backupDir, `before-restore-${Date.now()}.jsonl`);
    await env.step?.("restore:backup-current");
    await copyVerified(plan.path, before, current);
    const temp = join(dirname(plan.path), `.${basename(plan.path)}.restore-${plan.id}.tmp`);
    await env.step?.("restore:write-temp");
    await clearOwnTemp(temp);
    // Backup, then what was appended after the cut.
    const appended = current.size - plan.cut.newSize;
    const restoredSha = await concatInto(temp, [[backup, 0, backupStamp.size], [plan.path, plan.cut.newSize, appended]]);
    const restored = await stampFile(temp);
    if (restored.sha256 !== restoredSha || restored.size !== backupStamp.size + appended) {
      await unlink(temp).catch(() => undefined);
      return { ok: false, why: "backup-mismatch", plan };
    }
    const last = await stat(plan.path);
    if (last.size !== current.size || last.mtimeMs !== current.mtimeMs || now() > deadline) {
      await unlink(temp).catch(() => undefined);
      return { ok: false, why: now() > deadline ? "deadline" : "changed", plan };
    }
    await env.step?.("restore:rename");
    await rename(temp, plan.path);
    await fsyncDir(dirname(plan.path));
    const after = await stampFile(plan.path);
    if (after.sha256 !== restoredSha) return { ok: false, why: "error:restored file differs", plan };
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
    plan.state = "restored";
    plan.restoredAt = at(env);
    await savePlan(env, plan);
    await writeFile(join(plan.backupDir, "restored.json"), JSON.stringify({ restoredAt: plan.restoredAt, keptCurrentAs: basename(before) }, null, 2), { mode: 0o600 }).catch(() => undefined);
    await logRun(env, { event: "restored", agentId: plan.agentId, sessionId: plan.sessionId, size: after.size, appended });
    return { ok: true, plan };
  } catch (error) {
    await logRun(env, { event: "error", stage: "restore", agentId: plan.agentId, error: error instanceof Error ? error.message : String(error) });
    return { ok: false, why: `error:${error instanceof Error ? error.message : String(error)}`, plan };
  }
}

async function concatInto(target: string, parts: readonly (readonly [string, number, number])[]): Promise<string> {
  const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const hash = createHash("sha256");
  try {
    const buffer = Buffer.allocUnsafe(CHUNK);
    for (const [source, offset, length] of parts) {
      const input = await open(source, constants.O_RDONLY);
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
        await input.close();
      }
    }
    await output.sync();
  } finally {
    await output.close();
  }
  return hash.digest("hex");
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

/** The temp files a commit or restore of this plan may leave behind after a crash, by exact name. */
export function tempNames(plan: ShedPlan): string[] {
  return [
    join(dirname(plan.path), `.${basename(plan.path)}.shed-${plan.id}.tmp`),
    join(dirname(plan.path), `.${basename(plan.path)}.restore-${plan.id}.tmp`),
  ];
}

/** A temp file this module names after its own plan id: removed only by that exact name. */
async function clearOwnTemp(temp: string): Promise<void> {
  if (!/\.(shed|restore)-[0-9A-Za-z-]+\.tmp$/.test(temp)) return;
  await unlink(temp).catch(() => undefined);
}
