import { z } from "zod";

/**
 * Smart Session's agent tools and plugin-sent messages as they appear in a chat,
 * reduced to what a one-line row or a small card needs. Pure, so the transformer and
 * the tests read the same rules.
 */
export const TOOL_ROW_KIND = "smart-session-tool";
export const PROMPT_CARD_KIND = "smart-session-prompt";

export const SMART_SESSION_TOOLS = ["context_status", "checkpoint", "request_compaction", "defer_compaction", "budget_status", "publish_as", "publish_as_settings"] as const;
export type SmartSessionTool = (typeof SMART_SESSION_TOOLS)[number];

export const ToolRowSchema = z.object({
  tool: z.enum(SMART_SESSION_TOOLS),
  state: z.enum(["running", "done", "refused", "failed"]),
  /** The one line, e.g. "Checked its context · 32% of 1M · compacts at 30%". */
  line: z.string(),
  /** What opens under it: the call's own words, trimmed. Empty when there is nothing more. */
  detail: z.string(),
});
export type ToolRow = z.infer<typeof ToolRowSchema>;

export const PromptCardSchema = z.object({
  kind: z.enum(["compact", "continue", "guard-continue", "guard-resume"]),
  /** compact: the reason the agent gave. */
  reason: z.string(),
  /** compact / continue: the state file it re-reads, when named. */
  statePath: z.string(),
  /** compact: n when this is the governor's nth retry of a /compact a message cancelled (`retryLine`). */
  retry: z.number().optional(),
  text: z.string(),
});
export type PromptCard = z.infer<typeof PromptCardSchema>;

/**
 * Claude records mcp__smart-session__context_status and Codex smart-session.context_status from the
 * stdio server; served natively through Paseo's MCP they are mcp__paseo__smart_context_status and
 * paseo.smart_context_status.
 */
export function smartSessionTool(name: string): SmartSessionTool | null {
  const match = /^(?:mcp__)?(?:smart-session(?:__|\.|\/|:)|paseo(?:__|\.|\/|:)smart_)([a-z_]+)$/.exec(name);
  return match && (SMART_SESSION_TOOLS as readonly string[]).includes(match[1]!) ? (match[1] as SmartSessionTool) : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text a tool result carries, however the provider wrapped it. */
export function readText(value: unknown): string | undefined {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map((part) => (typeof part === "string" ? part : record(part) && typeof part.text === "string" ? part.text : undefined));
    return parts.every((part) => part !== undefined) ? parts.join("\n") : undefined;
  }
  if (!record(value)) return undefined;
  const key = ["content", "output", "text", "message", "result"].find((name) => name in value);
  return key ? readText(value[key]) : undefined;
}

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

/** "1,000,000" → "1M", "200,000" → "200k". */
function size(raw: string): string {
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return raw;
  return n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(1))}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function contextLine(output: string): string {
  if (/^No context reading/i.test(output)) return "Checked its context · no reading yet";
  const m = /\(([\d.]+)% of a ([\d,]+)-token window\)\. Worth compacting from (\d+)%/.exec(output);
  if (!m) return "Checked its context";
  const past = /already past that point/i.test(output);
  return `Checked its context · ${Math.round(Number(m[1]))}% of ${size(m[2]!)} · ${past ? `past its ${m[3]}% line` : `compacts at ${m[3]}%`}`;
}

function budgetLine(output: string): string {
  if (/^Could not read plan usage/i.test(output)) return "Couldn't read plan usage";
  const parts: string[] = [];
  for (const m of output.matchAll(/^- (Session \(5h\)|Week|[^:]+): (\d+)% used/gm)) {
    const name = m[1] === "Session (5h)" ? "session" : m[1] === "Week" ? "week" : m[1]!;
    parts.push(`${name} ${m[2]}%`);
  }
  return parts.length === 0 ? "Checked plan usage" : `Checked plan usage · ${parts.slice(0, 2).join(" · ")}`;
}

function checkpointDetail(input: Record<string, unknown>): string {
  const lines: string[] = [];
  const add = (label: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) lines.push(`${label}: ${value.trim()}`);
    else if (Array.isArray(value)) for (const item of value) if (typeof item === "string" && item.trim()) lines.push(`${label}: ${item.trim()}`);
  };
  add("Goal", input.goal); add("Plan", input.plan); add("Current step", input.current_step);
  add("Decision", input.decisions); add("Dead end", input.dead_ends); add("Key fact", input.key_facts);
  return clip(lines.join("\n"), 4000);
}

/**
 * How each agent tool shows in a chat. Paseo 0.15.2 groups a run only from tool_call and thought items, and a timeline
 * transform can only return plugin items, so a transformed call always leaves Paseo's group and sits loose. All of
 * Smart Session's tools are bookkeeping (Paseo shows the compaction itself), so they stay Paseo's own tool calls. A new
 * tool must be classified here (chat-grouping.test.ts fails otherwise); only a moment the developer must see becomes a row.
 */
export const TOOL_PRESENTATION: Record<SmartSessionTool, "routine" | "moment"> = {
  context_status: "routine", budget_status: "routine", checkpoint: "routine", request_compaction: "routine", defer_compaction: "routine",
  // The agent reports the link itself; the call stays in Paseo's own group.
  publish_as: "routine", publish_as_settings: "routine",
};

/** The chat row for a tool call, or null to leave it as Paseo's own grouped tool call. */
export function chatToolRow(name: string, status: string, detail: unknown, error: unknown): ToolRow | null {
  const tool = smartSessionTool(name);
  return tool !== null && TOOL_PRESENTATION[tool] === "moment" ? toolRow(name, status, detail, error) : null;
}

/** Builds a row from a tool call, or null when the call is not one of Smart Session's. */
export function toolRow(name: string, status: string, detail: unknown, error: unknown): ToolRow | null {
  const tool = smartSessionTool(name);
  if (tool === null) return null;
  const input = record(detail) && record(detail.input) ? detail.input : {};
  const output = record(detail) && "output" in detail ? (readText(detail.output) ?? "") : "";
  const failedOutput = record(detail) && record(detail.output) && detail.output.isError === true;
  const failed = status === "failed" || failedOutput || /^Failed: /.test(output);
  const running = !failed && status !== "completed";
  if (failed) {
    const why = clip(oneLine(readText(error) || output.replace(/^Failed: /, "") || ""), 500);
    return { tool, state: "failed", line: `Smart Session couldn't ${tool === "checkpoint" ? "save task state" : tool === "request_compaction" ? "queue the compaction" : tool === "defer_compaction" ? "put off compacting" : tool === "budget_status" ? "read plan usage" : tool === "publish_as" ? "publish the artifact" : tool === "publish_as_settings" ? "read the publishing setting" : "read the context"}`, detail: why };
  }
  switch (tool) {
    case "context_status":
      return { tool, state: running ? "running" : "done", line: running ? "Checking its context…" : contextLine(output), detail: clip(output, 2000) };
    case "budget_status":
      return { tool, state: running ? "running" : "done", line: running ? "Checking plan usage…" : budgetLine(output), detail: clip(output, 2000) };
    case "checkpoint": {
      const step = str(input.current_step);
      const added = /\((\d+) new entr/.exec(output)?.[1];
      const line = running ? "Saving task state…" : `Saved task state${step ? ` · ${clip(oneLine(step), 90)}` : added ? ` · ${added} new ${added === "1" ? "entry" : "entries"}` : ""}`;
      return { tool, state: running ? "running" : "done", line, detail: checkpointDetail(input) };
    }
    case "request_compaction": {
      const reason = clip(oneLine(str(input.reason)), 110);
      const continues = input.continue_after_compaction !== false;
      const message = str(input.continue_message);
      const detailText = [
        reason ? `Reason: ${str(input.reason)}` : "",
        continues ? (message ? `Then: ${message}` : "Then: re-read the task state and carry on") : "Then: stop, the task is done",
      ].filter(Boolean).join("\n");
      if (running) return { tool, state: "running", line: "Asking to compact…", detail: detailText };
      if (/^Not queued|switched off/i.test(output)) {
        const why = /switched off/i.test(output) ? "Smart Compact is off" : /no task state/i.test(output) ? "no task state saved yet" : /last written/i.test(output) ? "task state is out of date" : "refused";
        return { tool, state: "refused", line: `Compaction not queued · ${why}`, detail: clip(output, 1500) };
      }
      return { tool, state: "done", line: `Asked to compact${continues ? "" : " and stop"}${reason ? ` · ${reason}` : ""}`, detail: detailText };
    }
    case "defer_compaction": {
      const reason = clip(oneLine(str(input.reason)), 110);
      const minutes = /Deferred for (\d+) minutes/.exec(output)?.[1] ?? (typeof input.minutes === "number" ? String(input.minutes) : null);
      return { tool, state: running ? "running" : "done", line: running ? "Putting off compacting…" : `Put off compacting${minutes ? ` for ${minutes}m` : ""}${reason ? ` · ${reason}` : ""}`, detail: clip(output, 1500) };
    }
    case "publish_as": {
      if (running) return { tool, state: "running", line: "Publishing as the main account…", detail: "" };
      const url = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/.exec(output)?.[0];
      return url && /^Published as /.test(output)
        ? { tool, state: "done", line: `Published as the main account · ${url}`, detail: clip(output, 1500) }
        : { tool, state: "refused", line: "Not published", detail: clip(output, 1500) };
    }
    case "publish_as_settings":
      return { tool, state: running ? "running" : "done", line: running ? "Reading the publishing setting…" : clip(oneLine(output.split("\n")[0] ?? ""), 120), detail: clip(output, 1500) };
  }
}

const COMPACT_PREFIX = "/compact Preserve: the current goal";
const CONTINUE_PREFIX = "That compaction was the one you asked for.";
const GUARD_DEFAULT_PREFIX = "Your previous turn was paused because the provider's session usage limit was reached.";
const GUARD_RESUME_PREFIX = "You explicitly chose Resume now while Session Guard was waiting";

/**
 * Recognises the messages Smart Session itself sends into a chat: the /compact an
 * agent asked for, the continuation after it, and Session Guard's continuation and
 * Resume now. Anything else, including a person's own /compact, is left alone.
 */
export function promptCard(text: string): PromptCard | null {
  const body = text.trim();
  if (body.startsWith(COMPACT_PREFIX)) {
    const reason = /Reason for compacting now: ([\s\S]*?)(?: Authoritative state lives at | Retry \d+: the previous \/compact |$)/.exec(body)?.[1]?.trim() ?? "";
    const statePath = /Authoritative state lives at (.+?)\. Re-read that file/.exec(body)?.[1]?.trim() ?? "";
    const retry = Number(/ Retry (\d+): the previous \/compact was cancelled/.exec(body)?.[1] ?? 0);
    return retry > 0 ? { kind: "compact", reason, statePath, retry, text: body } : { kind: "compact", reason, statePath, text: body };
  }
  if (body.startsWith(CONTINUE_PREFIX)) {
    const statePath = /^That compaction was the one you asked for\. Re-read (.+?) and continue from/.exec(body)?.[1]?.trim() ?? "";
    return { kind: "continue", reason: "", statePath, text: body };
  }
  if (body.startsWith(GUARD_DEFAULT_PREFIX)) return { kind: "guard-continue", reason: "", statePath: "", text: body };
  if (body.startsWith(GUARD_RESUME_PREFIX)) return { kind: "guard-resume", reason: "", statePath: "", text: body };
  return null;
}

/** The last path segment, for a state file named in a card. */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
