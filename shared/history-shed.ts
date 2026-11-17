/**
 * Moving a Claude transcript's history from before its last compaction into a backup (the pure part).
 *
 * Paseo replays a Claude agent's whole transcript into its chat on every load, and `/compact` only adds a
 * row, so a long-lived agent's chat opens slower with every compaction. Claude itself never reads the
 * history before the last compaction again: the model's context is the chain of records that ends at the
 * last `compact_boundary`. This module works out which records that chain needs and which can leave the
 * file, and checks that the chain is unchanged by the cut. `server/history-shed.ts` does the I/O.
 *
 * The chain, as Claude Code's SDK rebuilds it on resume: from the newest record, follow `parentUuid`
 * back. A boundary may preserve a segment of recent messages from before it (`compactMetadata.
 * preservedSegment {headUuid, anchorUuid, tailUuid}`): the segment's head hangs off the anchor (the
 * compact summary, after the boundary), and the first later record hanging off the anchor hangs off
 * the segment's tail instead. The walk stops at a record with no parent, which is the boundary.
 *
 * Invariant (AGENTS.md): an agent's id and its post-compaction context survive a shed. Every record
 * on that chain stays, byte for byte, and `planCut` refuses whenever the chain after the cut would
 * differ from the chain before it.
 */

/** What the planner needs to know about one line of the transcript; nothing else of its content. */
export interface IndexedRecord {
  /** Byte offset of the line and its length, newline included. */
  readonly offset: number;
  readonly length: number;
  /** Null when the line is not a JSON object. */
  readonly type: string | null;
  readonly subtype: string | null;
  readonly uuid: string | null;
  readonly parentUuid: string | null;
  readonly isSidechain: boolean;
  readonly timestamp: string | null;
  /** Only on compact boundaries. */
  readonly preserved?: PreservedShape;
}

export interface PreservedShape {
  readonly segment: { headUuid: string | null; anchorUuid: string | null; tailUuid: string | null } | null;
  readonly messageUuids: readonly string[];
}

/** One parsed line, reduced to the fields an `IndexedRecord` keeps. */
export function indexRecord(line: string, offset: number, length: number): IndexedRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    value = null;
  }
  const r = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const base = {
    offset,
    length,
    type: str(r?.type),
    subtype: str(r?.subtype),
    uuid: str(r?.uuid),
    parentUuid: str(r?.parentUuid),
    isSidechain: r?.isSidechain === true,
    timestamp: str(r?.timestamp),
  };
  if (base.type === "system" && base.subtype === "compact_boundary") {
    const meta = (r?.compactMetadata ?? null) as Record<string, any> | null;
    const segment = meta?.preservedSegment && typeof meta.preservedSegment === "object"
      ? { headUuid: str(meta.preservedSegment.headUuid), anchorUuid: str(meta.preservedSegment.anchorUuid), tailUuid: str(meta.preservedSegment.tailUuid) }
      : null;
    const messages = meta?.preservedMessages && typeof meta.preservedMessages === "object" && Array.isArray(meta.preservedMessages.uuids)
      ? (meta.preservedMessages.uuids as unknown[]).filter((u): u is string => typeof u === "string")
      : [];
    return { ...base, preserved: { segment, messageUuids: messages } };
  }
  return base;
}

const isBoundary = (r: IndexedRecord) => r.type === "system" && r.subtype === "compact_boundary";

/** Records Claude chains by uuid. The newest of these that is not a sidechain is where the chain starts. */
const CHAIN_TYPES = new Set(["user", "assistant", "attachment", "system", "progress"]);

/**
 * Record types that may leave the file when they sit before the cut: the conversation itself and the
 * per-request logs. Anything else (titles, modes, file-history snapshots, attribution, types a newer
 * Claude Code adds) stays where it is, so nothing Claude reads outside the chain goes missing.
 */
export const MOVABLE_TYPES: ReadonlySet<string> = new Set([
  ...CHAIN_TYPES,
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "queue-operation",
  "last-prompt",
]);

export interface ChainWalk {
  /** Indexes into the records, newest first. */
  readonly indexes: readonly number[];
  /** The uuids in the same order. */
  readonly uuids: readonly string[];
  /** Why the walk stopped: `root` at a record with no parent; anything else is a broken chain. */
  readonly stop: "root" | "missing-parent" | "cycle" | "no-leaf";
}

/** The chain Claude rebuilds from these records, by the rules in this file's header. */
export function liveChain(records: readonly IndexedRecord[]): ChainWalk {
  const byUuid = new Map<string, number>();
  records.forEach((r, i) => {
    if (r.uuid !== null && !byUuid.has(r.uuid)) byUuid.set(r.uuid, i);
  });
  let leaf = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if (r.uuid !== null && !r.isSidechain && r.type !== null && CHAIN_TYPES.has(r.type)) {
      leaf = i;
      break;
    }
  }
  if (leaf < 0) return { indexes: [], uuids: [], stop: "no-leaf" };
  // Relinks for the newest boundary's preserved segment.
  const relink = new Map<string, string>();
  let last = -1;
  for (let i = records.length - 1; i >= 0; i--) if (isBoundary(records[i]!)) { last = i; break; }
  const segment = last >= 0 ? records[last]!.preserved?.segment ?? null : null;
  if (segment?.headUuid && segment.anchorUuid && segment.tailUuid) {
    relink.set(segment.headUuid, segment.anchorUuid);
    for (let i = last + 1; i < records.length; i++) {
      const r = records[i]!;
      if (!r.isSidechain && r.parentUuid === segment.anchorUuid && r.uuid !== segment.headUuid && r.uuid !== null) {
        relink.set(r.uuid, segment.tailUuid);
        break;
      }
    }
  }
  const indexes: number[] = [];
  const uuids: string[] = [];
  const seen = new Set<string>();
  let at = leaf;
  for (;;) {
    const r = records[at]!;
    if (seen.has(r.uuid!)) return { indexes, uuids, stop: "cycle" };
    seen.add(r.uuid!);
    indexes.push(at);
    uuids.push(r.uuid!);
    const parent = relink.get(r.uuid!) ?? r.parentUuid;
    if (parent === null) return { indexes, uuids, stop: "root" };
    const next = byUuid.get(parent);
    if (next === undefined) return { indexes, uuids, stop: "missing-parent" };
    at = next;
  }
}

export type CutRefusal =
  | "no-boundary"
  | "boundary-last"
  | "chain-broken"
  | "chain-not-at-boundary"
  | "nothing-to-move"
  | "chain-changed";

export interface CutPlan {
  readonly ok: true;
  /** Index of the first record kept whole: everything from here on stays. */
  readonly cut: number;
  readonly boundary: number;
  /** Records before the cut that stay (their indexes, in file order). */
  readonly keptBefore: readonly number[];
  /** Records before the cut that move to the backup only. */
  readonly moved: readonly number[];
  readonly movedBytes: number;
  /** Byte ranges of the new file, in order: the kept records before the cut, then the tail from the cut. */
  readonly ranges: readonly (readonly [offset: number, length: number])[];
  readonly newSize: number;
  readonly compactions: number;
  readonly boundaryTimestamp: string | null;
  readonly chainLength: number;
}

/**
 * Where to cut, or why not. The cut is at the last boundary, or earlier when the chain (its preserved
 * segment, say) reaches back before it, so every chain record stays. Refuses when there is no
 * boundary, the boundary is the last line (a compaction still being written), the chain does not end
 * at that boundary, nothing would move, or the chain of the result differs from the original's.
 */
export function planCut(records: readonly IndexedRecord[]): CutPlan | { ok: false; why: CutRefusal } {
  let boundary = -1;
  let compactions = 0;
  for (let i = 0; i < records.length; i++) if (isBoundary(records[i]!)) { boundary = i; compactions++; }
  if (boundary < 0) return { ok: false, why: "no-boundary" };
  if (boundary === records.length - 1) return { ok: false, why: "boundary-last" };
  const chain = liveChain(records);
  if (chain.stop !== "root") return { ok: false, why: "chain-broken" };
  if (chain.indexes[chain.indexes.length - 1] !== boundary) return { ok: false, why: "chain-not-at-boundary" };
  let cut = boundary;
  for (const i of chain.indexes) cut = Math.min(cut, i);
  const byUuid = new Map<string, number>();
  records.forEach((r, i) => { if (r.uuid !== null && !byUuid.has(r.uuid)) byUuid.set(r.uuid, i); });
  for (const uuid of records[boundary]!.preserved?.messageUuids ?? []) {
    const i = byUuid.get(uuid);
    if (i !== undefined) cut = Math.min(cut, i);
  }
  const keptBefore: number[] = [];
  const moved: number[] = [];
  let movedBytes = 0;
  for (let i = 0; i < cut; i++) {
    const r = records[i]!;
    if (r.type !== null && MOVABLE_TYPES.has(r.type)) {
      moved.push(i);
      movedBytes += r.length;
    } else keptBefore.push(i);
  }
  if (moved.length === 0) return { ok: false, why: "nothing-to-move" };
  const ranges: [number, number][] = [];
  const push = (offset: number, length: number) => {
    const prev = ranges[ranges.length - 1];
    if (prev && prev[0] + prev[1] === offset) prev[1] += length;
    else ranges.push([offset, length]);
  };
  for (const i of keptBefore) push(records[i]!.offset, records[i]!.length);
  const tailStart = records[cut]!.offset;
  const last = records[records.length - 1]!;
  push(tailStart, last.offset + last.length - tailStart);
  const result = [...keptBefore.map((i) => records[i]!), ...records.slice(cut)];
  const after = liveChain(result);
  if (after.stop !== "root" || after.uuids.length !== chain.uuids.length || after.uuids.some((u, i) => u !== chain.uuids[i])) {
    return { ok: false, why: "chain-changed" };
  }
  const newSize = ranges.reduce((sum, [, length]) => sum + length, 0);
  return {
    ok: true,
    cut,
    boundary,
    keptBefore,
    moved,
    movedBytes,
    ranges,
    newSize,
    compactions,
    boundaryTimestamp: records[boundary]!.timestamp,
    chainLength: chain.uuids.length,
  };
}

export interface ShedThresholds {
  /** Shed once the transcript is at least this big (MB). */
  readonly minMb: number;
  /** …or has at least this many compactions. */
  readonly minCompactions: number;
}

export const DEFAULT_SHED_THRESHOLDS: ShedThresholds = { minMb: 50, minCompactions: 10 };

/** Below this much movable history a shed is not worth a backup copy. */
export const MIN_MOVED_BYTES = 1024 * 1024;

export type DueRefusal = "too-small" | "too-little-to-move";

/** Whether a planned cut is worth doing under these thresholds. */
export function isDue(size: number, plan: CutPlan, thresholds: ShedThresholds): { due: true } | { due: false; why: DueRefusal } {
  if (size < thresholds.minMb * 1024 * 1024 && plan.compactions < thresholds.minCompactions) return { due: false, why: "too-small" };
  if (plan.movedBytes < MIN_MOVED_BYTES) return { due: false, why: "too-little-to-move" };
  return { due: true };
}

export function normalizeShedThresholds(raw: unknown): ShedThresholds {
  const r = (raw ?? {}) as Partial<ShedThresholds>;
  const num = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
  return {
    minMb: num(r.minMb, DEFAULT_SHED_THRESHOLDS.minMb, 1, 100_000),
    minCompactions: num(r.minCompactions, DEFAULT_SHED_THRESHOLDS.minCompactions, 1, 10_000),
  };
}

/** A Claude session id, as Claude Code names its transcript files. Anything else is refused. */
export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** A subagent transcript file Claude Code writes under `<session>/subagents/`. */
export function isSubagentFile(name: string): boolean {
  return /^agent-[A-Za-z0-9_-]+\.jsonl$/.test(name);
}
