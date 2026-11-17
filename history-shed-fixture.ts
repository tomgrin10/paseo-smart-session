/**
 * Synthetic Claude transcripts shaped like real long-lived ones, for history-shed tests: many
 * compactions, each preserving a segment of recent messages (`compactMetadata.preservedSegment`),
 * tool calls whose result lands after the boundary, progress records inside the chain, images,
 * per-request logs, metadata records, old-style sidechain records and subagent transcripts. No real
 * content: every text is generated.
 */
import { randomUUID } from "node:crypto";

export interface FixtureOptions {
  readonly sessionId?: string;
  readonly compactions?: number;
  readonly turnsPerSegment?: number;
  /** Bytes of filler per tool result, to make the file big. */
  readonly fill?: number;
  /** Whether the newest boundary preserves a segment (real Claude Code does). */
  readonly preserve?: boolean;
  /** Turns after the last compaction. */
  readonly tailTurns?: number;
  /** End the file with the boundary itself (a compaction still being written). */
  readonly endAtBoundary?: boolean;
  readonly start?: number;
}

export interface Fixture {
  readonly sessionId: string;
  readonly lines: string[];
  /** Subagent transcripts by file name, each `[jsonl lines, meta json]`. */
  readonly subagents: Record<string, { lines: string[]; meta: string }>;
  /** The uuids Claude's chain must keep, newest first. */
  readonly facts: { lastSummaryUuid: string | null; tailUuids: string[] };
  readonly text: string;
}

export function buildFixture(options: FixtureOptions = {}): Fixture {
  const sessionId = options.sessionId ?? randomUUID();
  const compactions = options.compactions ?? 3;
  const turns = options.turnsPerSegment ?? 4;
  const fill = options.fill ?? 200;
  const preserve = options.preserve ?? true;
  let clock = options.start ?? Date.parse("2026-10-01T00:00:00Z");
  const ts = () => new Date((clock += 1000)).toISOString();
  const lines: string[] = [];
  const subagents: Record<string, { lines: string[]; meta: string }> = {};
  const base = { isSidechain: false, userType: "external", cwd: "/work/example", sessionId, version: "2.9.0", gitBranch: "main" };
  const push = (record: Record<string, unknown>) => { lines.push(JSON.stringify(record)); return record; };
  const meta = (type: string, extra: Record<string, unknown> = {}) => push({ type, sessionId, ...extra });
  let parent: string | null = null;
  const chain = (record: Record<string, unknown>) => {
    const uuid = randomUUID();
    push({ parentUuid: parent, ...base, ...record, uuid, timestamp: ts() });
    parent = uuid;
    return uuid;
  };
  const filler = (n: number) => "lorem ipsum ".repeat(Math.ceil(n / 12)).slice(0, n);

  meta("session-owner", { owner: "example" });
  meta("mode", { mode: "default" });
  meta("custom-title", { customTitle: "Example task" });

  let subagentCount = 0;
  const turn = (i: number, opts: { image?: boolean; subagent?: boolean } = {}) => {
    chain({ type: "user", message: { role: "user", content: `Step ${i}: ${filler(40)}` } });
    meta("last-prompt", { lastPrompt: `Step ${i}` });
    meta("api-request", { request: { body: filler(fill * 2) } });
    const toolId = `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    chain({ type: "assistant", message: { id: `msg_${randomUUID().slice(0, 8)}`, role: "assistant", model: "claude-example", content: [{ type: "text", text: filler(60) }, { type: "tool_use", id: toolId, name: opts.subagent ? "Agent" : "Bash", input: { command: "ls" } }] } });
    chain({ type: "progress", data: { type: "bash_progress", output: filler(30) } });
    const result: unknown[] = [{ type: "tool_result", tool_use_id: toolId, content: filler(fill) }];
    if (opts.image) result.push({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo".padEnd(fill, "A") } });
    chain({ type: "user", message: { role: "user", content: result }, toolUseResult: { stdout: filler(fill) } });
    chain({ type: "attachment", attachment: { type: "hook_success", content: "" } });
    if (opts.subagent) {
      const agentId = `a${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const sub: string[] = [];
      let p: string | null = null;
      for (let k = 0; k < 3; k++) {
        const uuid = randomUUID();
        sub.push(JSON.stringify({ parentUuid: p, ...base, isSidechain: true, agentId, type: k % 2 ? "assistant" : "user", message: { role: k % 2 ? "assistant" : "user", content: filler(80) }, uuid, timestamp: ts() }));
        p = uuid;
      }
      subagents[`agent-${agentId}.jsonl`] = { lines: sub, meta: JSON.stringify({ agentType: "general-purpose", description: `Subagent ${++subagentCount}` }) };
      // Old-style sidechain record in the main file too.
      push({ parentUuid: null, ...base, isSidechain: true, agentId, type: "user", message: { role: "user", content: "subagent prompt" }, uuid: randomUUID(), timestamp: ts() });
    }
    chain({ type: "assistant", message: { id: `msg_${randomUUID().slice(0, 8)}`, role: "assistant", model: "claude-example", content: [{ type: "text", text: `Done ${i}. ${filler(50)}` }] } });
  };

  let lastSummary: string | null = null;
  for (let c = 0; c < compactions; c++) {
    for (let t = 0; t < turns; t++) turn(c * 100 + t, { image: t === 1, subagent: t === 2 });
    meta("api-request-blob", { blob: filler(fill) });
    meta("file-history-snapshot", { messageId: randomUUID(), snapshot: { trackedFileBackups: {} } });
    // The preserved segment: the last user message and an assistant reply with an open tool call.
    const head = chain({ type: "user", message: { role: "user", content: `Keep going ${c}` } });
    const openTool = `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const tail = chain({ type: "assistant", message: { id: `msg_${randomUUID().slice(0, 8)}`, role: "assistant", model: "claude-example", content: [{ type: "tool_use", id: openTool, name: "Bash", input: { command: "make" } }] } });
    const before = parent;
    const boundaryUuid = randomUUID();
    const summaryUuid = randomUUID();
    const isLast = c === compactions - 1;
    const compactMetadata: Record<string, unknown> = { trigger: "auto", preTokens: 150000 };
    if (preserve) {
      compactMetadata.preservedSegment = { headUuid: head, anchorUuid: summaryUuid, tailUuid: tail };
      compactMetadata.preservedMessages = { anchorUuid: summaryUuid, uuids: [head, tail], allUuids: [head, tail, randomUUID()] };
    }
    push({ parentUuid: null, logicalParentUuid: before, ...base, type: "system", subtype: "compact_boundary", content: "Conversation compacted", compactMetadata, uuid: boundaryUuid, timestamp: ts() });
    if (isLast && options.endAtBoundary) {
      return { sessionId, lines, subagents, facts: { lastSummaryUuid: null, tailUuids: [] }, text: `${lines.join("\n")}\n` };
    }
    push({ parentUuid: boundaryUuid, ...base, type: "user", isCompactSummary: true, message: { role: "user", content: `Summary ${c}: ${filler(300)}` }, uuid: summaryUuid, timestamp: ts() });
    lastSummary = summaryUuid;
    parent = summaryUuid;
    // The open tool call's result lands after the boundary, hanging off the anchor (relinked to the tail on load).
    chain({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: openTool, content: filler(fill) }] } });
    meta("attribution-snapshot", { files: {} });
  }
  const tailUuids: string[] = [];
  for (let t = 0; t < (options.tailTurns ?? 2); t++) {
    turn(9000 + t, { subagent: t === 0 });
    tailUuids.push(parent!);
  }
  meta("custom-title", { customTitle: "Example task" });
  return { sessionId, lines, subagents, facts: { lastSummaryUuid: lastSummary, tailUuids }, text: `${lines.join("\n")}\n` };
}
