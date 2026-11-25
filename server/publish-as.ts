/**
 * Publishing an artifact as another Claude account, through a short-lived helper agent.
 *
 * The helper is a normal Paseo agent (Haiku, background, no prompt yet) created with an id chosen
 * here. ZeroSub routes a new session as soon as it opens, so the helper is then pinned to the target
 * account with ZeroSub's own `zerosub.agents.account` RPC and reopened with this plugin's daemon
 * connection. ZeroSub's own reopen shells out to `paseo agent reload`, which doesn't find a brand-new
 * background agent. Only once ZeroSub's session record says the helper runs on the target does it get
 * its one prompt: publish this input, reply with the url. It is archived afterwards whatever
 * happened. Nothing here opens a credential file; the helper is just a session on that account.
 *
 * A republish is two turns of one helper: it reads the live version (without loading the page), and
 * only when that is the version the caller last saw does it publish. Otherwise the caller gets the
 * live copy to merge, so a helper never overwrites a change nobody merged. What the helper did is
 * read from its tool calls on the daemon's timeline, not from what it said last.
 *
 * One helper runs at a time. The decisions (what is taken over, which account, what the model is
 * told) are in `shared/publish-as.ts`.
 */
import { randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { parseZeroSub, type ZeroSubAccount, type ZeroSubSnapshot } from "../shared/guard/zerosub.ts";
import {
  HELPER_ENV,
  HELPER_LABEL,
  accessPrompt,
  accessReason,
  conflictReason,
  decide,
  failureReason,
  isNoAccess,
  normalizeUrl,
  ownerName,
  publishPrompt,
  readPrompt,
  readTurn,
  recordFrom,
  successReason,
  type ArtifactInput,
  type HookDecision,
  type OwnedPage,
  type TurnItem,
} from "../shared/publish-as.ts";

export type { TurnItem } from "../shared/publish-as.ts";
import { withDaemon, type DaemonClient } from "./daemon.ts";
import { zerosubInstallId } from "./guard/zerosub.ts";
import { readSettings } from "./settings.ts";
import { dataDir } from "./store.ts";

/** Cheapest model with the Artifact tool. */
export const HELPER_MODEL = "claude-haiku-5-5";
/** The helper's whole turn, from prompt to reply. */
export const HELPER_TURN_MS = 100_000;
/** How long a publish may wait for the helper before it, so the hook's own deadline holds. */
export const QUEUE_WAIT_MS = 30_000;
/** The longest one `wait` call holds, well inside a plugin RPC's 60 s timeout. */
export const MAX_WAIT_MS = 25_000;

const paseoHome = () => process.env.PASEO_HOME ?? join(homedir(), ".paseo");
const dir = () => join(dataDir(), "publish-as");

export interface PublishResult {
  readonly ok: boolean;
  readonly url: string | null;
  /** A readable name for the account that owns the page; never an email. */
  readonly owner: string;
  readonly ownerAccountId: string;
  readonly helperId: string | null;
  readonly ms: number;
  readonly outcome: "published" | "done" | "conflict" | "not-owner" | "auth" | "failed" | "timeout" | "wrong-account" | "busy";
  readonly error: string | null;
  /** For a page made from a type: the publish result, which says how to fill it. For an access call: its result. */
  readonly resultText: string | null;
  /** The version a publish made, or for a conflict the live version the caller must merge. */
  readonly versionId?: string | null;
  /** A copy of the live page the caller can read (a routed read, or a conflict). */
  readonly livePath?: string | null;
  /** The routed tool, for what the model is told. */
  readonly tool?: string;
}

/** Everything the helper run needs from the outside world, so tests can stand in for the daemon. */
export interface HelperOps {
  create(agentId: string, cwd: string): Promise<void>;
  /**
   * ZeroSub's binding for the agent; ZeroSub's own reopen is not relied on. `allowLimited` keeps it
   * on a limited account (ZeroSub 1.5.1-pace.12+), for a publish on that account's Extra usage.
   */
  pin(agentId: string, accountId: string, allowLimited: boolean): Promise<void>;
  reload(agentId: string): Promise<void>;
  /** The account ZeroSub's session record says the agent's live session runs on. */
  sessionAccount(agentId: string): Promise<string | null>;
  send(agentId: string, prompt: string): Promise<void>;
  wait(agentId: string, ms: number): Promise<{ status: string; error: string | null; lastMessage: string | null }>;
  /** The helper's last turn, from its prompt on: what each tool call got back. */
  turn(agentId: string): Promise<TurnItem[]>;
  archive(agentId: string): Promise<void>;
}

/** One helper job. */
export interface HelperJob {
  readonly target: ZeroSubAccount;
  readonly input: ArtifactInput;
  readonly cwd: string;
  readonly extraUsage?: boolean;
  /** `publish` (the default) or `access`: run a call on an existing page as given. */
  readonly mode?: "publish" | "access";
  readonly tool?: string;
  /** For a republish: the version the caller last saw (null: never saw it; undefined: don't check). */
  readonly expectedVersion?: string | null;
  /** Where a copy of the live page goes for the caller to read. */
  readonly liveDir?: string;
}

/** The pause before a second helper after a sign-in failure, so it picks up the refreshed login. */
let authRetryMs = 10_000;
/** For tests. */
export function setAuthRetryMs(ms: number): void { authRetryMs = ms; }

async function keepLiveCopy(savedPath: string | null, liveDir: string | undefined, url: string, version: string | null): Promise<string | null> {
  if (!savedPath || !liveDir) return null;
  try {
    await mkdir(liveDir, { recursive: true });
    const id = normalizeUrl(url).split("/").at(-1) ?? "page";
    const copy = join(liveDir, `${id}-${version ?? randomUUID()}.html`);
    await copyFile(savedPath, copy);
    return copy;
  } catch {
    return null;
  }
}

/**
 * One helper run, retried once in a fresh helper when the first couldn't sign in: Claude's refresh
 * tokens rotate, so a helper that lost a refresh race fails, and one started a few seconds later
 * reads the token the winner wrote.
 */
export async function runHelper(
  ops: HelperOps,
  job: HelperJob,
  options: { turnMs?: number; newId?: () => string; now?: () => number } = {},
): Promise<PublishResult> {
  const first = await runHelperOnce(ops, job, options);
  if (first.outcome !== "auth") return first;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, authRetryMs));
  const second = await runHelperOnce(ops, job, options);
  return second.outcome === "auth" ? { ...second, ms: second.ms + first.ms } : second;
}

/**
 * One helper: create, pin, reopen, confirm the account, run, archive. The archive is in a
 * `finally`, so a helper never outlives its job, whether it worked, failed or timed out.
 */
async function runHelperOnce(
  ops: HelperOps,
  job: HelperJob,
  options: { turnMs?: number; newId?: () => string; now?: () => number },
): Promise<PublishResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const helperId = (options.newId ?? randomUUID)();
  const owner = ownerName(job.target);
  const tool = job.tool ?? "Artifact";
  const turnMs = options.turnMs ?? HELPER_TURN_MS;
  const done = (outcome: PublishResult["outcome"], fields: Partial<PublishResult>): PublishResult => ({
    ok: false, url: null, owner, ownerAccountId: job.target.id, helperId, ms: now() - started, outcome,
    error: null, resultText: null, tool, ...fields,
  });
  let created = false;
  try {
    await ops.create(helperId, job.cwd);
    created = true;
    const extraUsage = job.extraUsage === true;
    try { await ops.pin(helperId, job.target.id, extraUsage); }
    catch (error) {
      // ZeroSub 1.31+ refuses a pin to an account at the quota maximum set in its Accounts, with or
      // without `allowLimited`: Extra usage doesn't lift the person's own ceiling. Its message names
      // the account by label, so the reason is said here in our words.
      if (/quota maximum/i.test(error instanceof Error ? error.message : String(error))) {
        return done("failed", { error: `${owner} reached the quota maximum set in ZeroSub's Accounts, so nothing was published. Extra usage doesn't lift that ceiling: raise it in ZeroSub's Accounts, or publish after the window resets.` });
      }
      throw error;
    }
    if ((await ops.sessionAccount(helperId)) !== job.target.id) await ops.reload(helperId);
    const on = await ops.sessionAccount(helperId);
    // Never let the helper publish anywhere but the target: that would only make another seat page.
    if (on !== job.target.id) {
      const why = extraUsage ? ". Publishing on a limited account's Extra usage needs ZeroSub 1.5.1-pace.12 or later" : "";
      return done("wrong-account", { error: `the helper opened on another account (${on ?? "unknown"}), so nothing was published${why}` });
    }
    /** One prompt, one turn, read back from its tool calls. Null when the turn ran out of time or moved. */
    type Finished = Awaited<ReturnType<HelperOps["wait"]>>;
    const step = async (prompt: string): Promise<{ stop: PublishResult } | { finished: Finished; reading: ReturnType<typeof readTurn> }> => {
      await ops.send(helperId, prompt);
      const finished = await ops.wait(helperId, turnMs);
      if (finished.status === "timeout") return { stop: done("timeout", { error: `the helper didn't finish within ${Math.round(turnMs / 1000)} s` }) };
      // Moved off the owner mid-turn (ZeroSub failing it over): whatever it made isn't the owner's page.
      const after = await ops.sessionAccount(helperId);
      if (after !== job.target.id) return { stop: done("wrong-account", { error: `the helper was moved to another account (${after ?? "unknown"}) during the publish, so it isn't published as the owner` }) };
      const items = await ops.turn(helperId).catch(() => [] as TurnItem[]);
      const reading = readTurn(items, tool, finished.lastMessage);
      if (reading.auth || (finished.error && readTurn([], tool, finished.error).auth)) {
        return { stop: done("auth", { error: `the helper couldn't sign in to ${owner} (${(reading.error ?? finished.error ?? finished.lastMessage ?? "").slice(0, 200)})` }) };
      }
      return { finished, reading };
    };

    const url = typeof job.input.url === "string" ? job.input.url : null;
    if (job.mode === "access") {
      const ran = await step(accessPrompt(tool, job.input));
      if ("stop" in ran) return ran.stop;
      const { finished, reading } = ran;
      if (reading.output === null) return done("failed", { error: reading.error ?? finished.error ?? "the helper didn't make the call" });
      if (reading.error && isNoAccess(reading.output)) return done("not-owner", { error: reading.error, resultText: reading.output });
      const livePath = reading.savedPath && url ? await keepLiveCopy(reading.savedPath, job.liveDir, url, reading.liveVersion) : null;
      const output = livePath && reading.savedPath ? reading.output.split(reading.savedPath).join(livePath) : reading.output;
      return done("done", { ok: true, url, resultText: output, versionId: reading.liveVersion, livePath });
    }

    if (url) {
      // View the live version first: that is what lets the publish through, and the check against
      // the version the caller last saw is what keeps a concurrent change.
      const viewed = await step(readPrompt(url));
      if ("stop" in viewed) return viewed.stop;
      const { reading } = viewed;
      if (reading.liveVersion === null) {
        const error = reading.error ?? "the helper couldn't read the live page";
        return done(isNoAccess(reading.output ?? reading.error) ? "not-owner" : "failed", { error });
      }
      if (job.expectedVersion !== undefined && reading.liveVersion !== job.expectedVersion) {
        const livePath = await keepLiveCopy(reading.savedPath, job.liveDir, url, reading.liveVersion);
        return done("conflict", { url, versionId: reading.liveVersion, livePath, error: "the page changed since this session last saw it" });
      }
    }
    const ran = await step(publishPrompt(job.input));
    if ("stop" in ran) return ran.stop;
    const { finished, reading } = ran;
    if (!reading.url) {
      if (url && isNoAccess(reading.error)) return done("not-owner", { error: reading.error });
      return done("failed", { error: reading.error ?? finished.error ?? (finished.status === "permission" ? "the helper was asked for a permission" : "the helper reported no url") });
    }
    const typed = typeof job.input.type_url === "string";
    return done("published", { ok: true, url: reading.url, versionId: reading.versionId, resultText: typed ? (reading.output?.slice(0, 6000) ?? null) : null });
  } catch (error) {
    return done("failed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (created) await ops.archive(helperId).catch(() => undefined);
  }
}

// ------------------------------------------------------------------ staging

/**
 * Copies the files a publish names into the helper's working directory and rewrites the input to
 * point at the copies. The Artifact tool only publishes files under its session's working directory
 * (or its own scratchpad), and the caller's file can be anywhere, often in the caller's scratchpad.
 * Published paths (the keys of `files`) are kept, so the page's own references still work.
 */
export async function stage(input: ArtifactInput, callerCwd: string, stageRoot: string, jobId: string): Promise<ArtifactInput> {
  const base = typeof input.root === "string" ? resolve(callerCwd, input.root) : callerCwd;
  let count = 0;
  const copy = async (source: string, from = base): Promise<string> => {
    const absolute = isAbsolute(source) ? source : resolve(from, source);
    const relative = join(jobId, String(count++), basename(absolute));
    await mkdir(join(stageRoot, jobId, String(count - 1)), { recursive: true });
    await copyFile(absolute, join(stageRoot, relative));
    return relative;
  };
  const next: ArtifactInput = { ...input };
  delete next.root;
  // `file_path` is relative to the working directory, never to `root`.
  if (typeof input.file_path === "string" && input.file_path !== "") next.file_path = await copy(input.file_path, callerCwd);
  if (Array.isArray(input.file_paths)) next.file_paths = await Promise.all(input.file_paths.map((path) => (typeof path === "string" ? copy(path, callerCwd) : path)));
  if (Array.isArray(input.files)) {
    const map: Record<string, unknown> = {};
    for (const entry of input.files as { path?: unknown; contentType?: unknown }[]) {
      if (typeof entry?.path !== "string") continue;
      map[entry.path] = { from: await copy(entry.path), ...(typeof entry.contentType === "string" ? { contentType: entry.contentType } : {}) };
    }
    next.files = map;
  } else if (input.files && typeof input.files === "object") {
    const map: Record<string, unknown> = {};
    for (const [published, source] of Object.entries(input.files as Record<string, unknown>)) {
      if (typeof source === "string") map[published] = await copy(source);
      else if (source && typeof source === "object" && typeof (source as { from?: unknown }).from === "string") {
        map[published] = { ...(source as object), from: await copy((source as { from: string }).from) };
      } else map[published] = source; // Another artifact's file, or a removal: nothing to copy.
    }
    next.files = map;
  }
  return next;
}

// ------------------------------------------------------------------ records

/** Pages this feature published, so updates go back to their owner. Bounded; newest last. */
export async function readPages(): Promise<OwnedPage[]> {
  try {
    const raw = JSON.parse(await readFile(join(dir(), "pages.json"), "utf8")) as unknown;
    return Array.isArray(raw) ? raw.filter((page): page is OwnedPage => typeof page?.url === "string" && typeof page?.callerAgentId === "string") : [];
  } catch {
    return [];
  }
}

/** Records who owns a page and which version this caller last saw. One row per (url, caller). */
let recordTail: Promise<unknown> = Promise.resolve();
function remember(page: OwnedPage): Promise<void> {
  // Read-modify-write over one file: the hook's records and the helper's would otherwise race.
  const next = recordTail.then(async () => {
    const previous = await readPages();
    const same = previous.find((candidate) => normalizeUrl(candidate.url) === normalizeUrl(page.url) && candidate.callerAgentId === page.callerAgentId);
    const pages = previous.filter((candidate) => candidate !== same);
    // A read doesn't know the caller's file; keep the one it published from.
    pages.push({ ...page, filePath: page.filePath ?? same?.filePath ?? null });
    await mkdir(dir(), { recursive: true });
    const target = join(dir(), "pages.json");
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(pages.slice(-1000), null, 2), "utf8");
    await rename(temp, target);
  });
  recordTail = next.then(() => undefined, () => undefined);
  return next;
}

/**
 * Records a direct Artifact publish or read from a session (the `PostToolUse` hook), with the
 * account the session ran on, so a later call on that page goes back to that account wherever the
 * session runs by then. Silent and cheap: without ZeroSub, or for anything else, it records nothing.
 */
export async function recordCall(request: { callerAgentId: string | null; tool?: string; input: ArtifactInput; response: unknown; isHelper?: boolean }): Promise<{ recorded: boolean }> {
  if (!request.callerAgentId || request.isHelper || helpers.has(request.callerAgentId) || (request.tool ?? "Artifact") !== "Artifact") return { recorded: false };
  const found = recordFrom(request.input, request.response);
  if (!found) return { recorded: false };
  const { view } = await zerosubView();
  if (typeof view === "string") return { recorded: false };
  // A session ZeroSub never routed runs on the CLI login, the main account.
  const accountId = (await sessionAccountOf(request.callerAgentId))
    ?? view.accounts.find((account) => account.family === "claude" && account.kind === "main")?.id;
  if (!accountId) return { recorded: false };
  const filePath = found.via === "direct" && typeof request.input.file_path === "string" && isAbsolute(request.input.file_path) ? request.input.file_path : null;
  await remember({ url: found.url, callerAgentId: request.callerAgentId, filePath, accountId, at: new Date().toISOString(), versionId: found.versionId, via: found.via });
  return { recorded: true };
}

/** The newest runs from this month's and last month's logs, newest first; a torn line is skipped. */
export async function readRuns(limit = 8, now = Date.now()): Promise<{ at: string; outcome: string; via: string | null; tool: string | null; ms: number | null; account: string | null }[]> {
  const month = (ms: number) => new Date(ms).toISOString().slice(0, 7);
  const thisMonth = month(now);
  const lastMonth = month(Date.parse(`${thisMonth}-01T00:00:00Z`) - 1);
  const rows: { at: string; outcome: string; via: string | null; tool: string | null; ms: number | null; account: string | null }[] = [];
  for (const m of [lastMonth, thisMonth]) {
    const textOf = await readFile(join(dir(), `runs-${m}.jsonl`), "utf8").catch(() => "");
    for (const line of textOf.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (typeof row.at !== "string" || typeof row.outcome !== "string") continue;
        const str = (v: unknown) => (typeof v === "string" ? v : null);
        rows.push({ at: row.at, outcome: row.outcome, via: str(row.via), tool: str(row.tool), ms: typeof row.ms === "number" ? row.ms : null, account: str(row.account) });
      } catch { /* a torn line */ }
    }
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** One line per helper run, for auditing: who asked, which helper, how long, what happened. */
async function logRun(entry: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(dir(), { recursive: true });
    const month = new Date().toISOString().slice(0, 7);
    await appendFile(join(dir(), `runs-${month}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
  } catch {
    // An audit line is not worth failing a publish over.
  }
}

// ------------------------------------------------------------------ ZeroSub

type ZeroSubView = ZeroSubSnapshot | "absent" | "unreadable";

/**
 * ZeroSub's registry, telling "not enabled" apart from "enabled but unreadable", with its usage
 * readings (Extra usage lives there). A missing or broken `usage.json` only means "no readings".
 */
export async function zerosubView(home = paseoHome()): Promise<{ view: ZeroSubView; pluginId: string | null }> {
  const pluginId = await zerosubInstallId(home).catch(() => null);
  if (pluginId === null) return { view: "absent", pluginId };
  try {
    const state = JSON.parse(await readFile(join(home, "zerosub", "state.json"), "utf8")) as unknown;
    const usage = await readFile(join(home, "zerosub", "usage.json"), "utf8").then((raw) => JSON.parse(raw) as unknown, () => ({}));
    return { view: parseZeroSub(state, usage, {}) ?? "unreadable", pluginId };
  } catch {
    return { view: "unreadable", pluginId };
  }
}

/** The account ZeroSub's session record names for an agent, read fresh. */
async function sessionAccountOf(agentId: string, home = paseoHome()): Promise<string | null> {
  try {
    const state = JSON.parse(await readFile(join(home, "zerosub", "state.json"), "utf8")) as { sessions?: Record<string, { accountId?: unknown }> };
    const id = state.sessions?.[agentId]?.accountId;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/** The last turn of a timeline page (from its last user message on), as turn items. */
export function turnItems(page: unknown): TurnItem[] {
  const entries = (page as { entries?: { item?: Record<string, unknown> }[] } | null)?.entries ?? [];
  const items = entries.map((entry) => entry.item).filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  const lastPrompt = items.map((item) => item.type).lastIndexOf("user_message");
  const out: TurnItem[] = [];
  for (const item of items.slice(lastPrompt + 1)) {
    if (item.type === "assistant_message" && typeof item.text === "string") out.push({ kind: "text", text: item.text });
    if (item.type !== "tool_call" || typeof item.name !== "string") continue;
    const detail = (item.detail ?? {}) as { input?: unknown; output?: unknown };
    const output = detail.output as { output?: unknown } | string | null | undefined;
    const textOut = typeof output === "string" ? output : typeof output?.output === "string" ? output.output : output == null ? "" : JSON.stringify(output);
    const error = typeof item.error === "string" ? item.error : item.error ? JSON.stringify(item.error) : null;
    out.push({
      kind: "tool", name: item.name,
      input: detail.input && typeof detail.input === "object" ? (detail.input as Record<string, unknown>) : {},
      output: textOut || error || "", failed: item.status === "failed" || error !== null,
    });
  }
  return out;
}

export function daemonOps(client: DaemonClient, zerosubId: string): HelperOps {
  return {
    async create(agentId, cwd) {
      await client.createAgent({
        agentId, provider: "claude", model: HELPER_MODEL, modeId: "bypassPermissions", cwd,
        title: "Publish as main account (helper)", background: true,
        env: { [HELPER_ENV]: "1" },
        // No plugin tools: the helper only needs Claude's own Artifact tools, and every tool it is
        // handed is context it pays for, on Extra usage too.
        labels: { [HELPER_LABEL.key]: HELPER_LABEL.value, "plugin-tools/enabled": "false" },
      });
    },
    async pin(agentId, accountId, allowLimited) {
      // ZeroSub's own reopen fails for a new background agent; its binding is what counts here.
      await client.invokePluginRpc(zerosubId, "zerosub.agents.account", { agentId, accountId, ...(allowLimited ? { allowLimited: true } : {}) });
    },
    async reload(agentId) { await client.refreshAgent(agentId); },
    sessionAccount: (agentId) => sessionAccountOf(agentId),
    async send(agentId, prompt) { await client.sendAgentMessage(agentId, prompt); },
    wait: (agentId, ms) => client.waitForFinish(agentId, ms),
    async turn(agentId) { return turnItems(await client.fetchAgentTimeline(agentId, { direction: "tail", limit: 60, projection: "canonical" })); },
    async archive(agentId) { await client.archiveAgent(agentId); },
  };
}

// ------------------------------------------------------------------ jobs

export interface PublishRequest {
  readonly callerAgentId: string | null;
  readonly cwd: string;
  readonly input: ArtifactInput;
  /** The tool's account argument; the hook leaves it to the setting. */
  readonly account?: string | null;
  readonly via: "hook" | "tool";
  /** The caller is itself a helper (the hook knows from its environment). */
  readonly isHelper?: boolean;
  /** The tool the hook caught: Artifact (the default), ArtifactData or ArtifactComments. */
  readonly tool?: string;
}

export type StartResult =
  | { decision: "pass"; note: string | null; why: string }
  | { decision: "queued"; jobId: string; owner: string }
  /** The target is out of usage and may not be used; no helper started. The hook denies with `note`. */
  | { decision: "refused"; why: string; note: string };

interface Job { readonly promise: Promise<PublishResult>; result: PublishResult | null; readonly at: number }
const jobs = new Map<string, Job>();
const helpers = new Set<string>();
let tail: Promise<unknown> = Promise.resolve();

/** For tests: replaces how a helper run reaches the daemon. */
let opsFactory: ((zerosubId: string, run: (ops: HelperOps) => Promise<PublishResult>) => Promise<PublishResult>) | null = null;
export function setOpsFactory(factory: typeof opsFactory): void { opsFactory = factory; }

/**
 * Decides, and when the call is taken over, queues the helper run and returns at once. The hook
 * and the tools then `wait` for it in steps, since one plugin RPC may not outlast 60 s.
 */
export async function startPublish(request: PublishRequest): Promise<StartResult> {
  const settings = await readSettings();
  const { view, pluginId } = await zerosubView();
  const isHelper = request.isHelper === true || (request.callerAgentId !== null && helpers.has(request.callerAgentId));
  const pages = await readPages();
  // Paths compared with recorded pages are absolute, as they are stored.
  const input: ArtifactInput = typeof request.input.file_path === "string" && request.input.file_path !== ""
    ? { ...request.input, file_path: resolve(request.cwd, request.input.file_path) }
    : request.input;
  const tool = request.via === "tool";
  const plan = decide({
    callerAgentId: request.callerAgentId, provider: "claude", input, isHelper, pages, zerosub: view, tool: request.tool ?? "Artifact",
    // The tool publishes whatever the setting says; it is the explicit path.
    settings: {
      enabled: tool || settings.publishAsMain,
      accountId: (tool ? request.account : null) ?? settings.publishAsAccount,
      useExtraUsage: settings.publishAsExtraUsage,
    },
  });
  if (plan.decision === "refuse") {
    await logRun({ caller: request.callerAgentId, via: request.via, tool: request.tool ?? "Artifact", helperId: null, ms: 0, outcome: "refused", why: plan.why, account: plan.target.id });
    return { decision: "refused", why: plan.why, note: plan.note };
  }
  if (plan.decision === "pass" && tool) return { decision: "pass", why: plan.why, note: toolNote(plan, view, request.account ?? null) };
  if (plan.decision === "pass") return { decision: "pass", why: plan.why, note: plan.note };

  const target = plan.target;
  const jobId = randomUUID();
  const queuedAt = Date.now();
  const filePath = plan.filePath === null ? null : resolve(request.cwd, plan.filePath);
  const run = async (): Promise<PublishResult> => {
    const owner = ownerName(target);
    if (Date.now() - queuedAt > QUEUE_WAIT_MS) {
      return { ok: false, url: null, owner, ownerAccountId: target.id, helperId: null, ms: 0, outcome: "busy", error: "another publish held the helper for too long", resultText: null };
    }
    const stageRoot = join(dir(), "stage");
    await mkdir(stageRoot, { recursive: true });
    try {
      const staged = await stage(plan.input, request.cwd, stageRoot, jobId);
      const go = (ops: HelperOps) => runHelper(ops, {
        target, input: staged, cwd: stageRoot, extraUsage: plan.extraUsage, mode: plan.mode, tool: plan.tool,
        expectedVersion: plan.expectedVersion, liveDir: join(dir(), "live"),
      }, {
        newId: () => { const id = randomUUID(); helpers.add(id); return id; },
      });
      return opsFactory ? await opsFactory(pluginId ?? "zerosub", go) : await withDaemon((client) => go(daemonOps(client, pluginId ?? "zerosub")));
    } catch (error) {
      return { ok: false, url: null, owner, ownerAccountId: target.id, helperId: null, ms: Date.now() - queuedAt, outcome: "failed", error: error instanceof Error ? error.message : String(error), resultText: null };
    } finally {
      await rm(join(stageRoot, jobId), { recursive: true, force: true }).catch(() => undefined);
    }
  };
  const promise = tail.then(run, run).then(async (result) => {
    if (result.helperId) helpers.delete(result.helperId);
    const at = new Date().toISOString();
    if (request.callerAgentId && result.url) {
      const row = { url: result.url, callerAgentId: request.callerAgentId, accountId: target.id, at };
      // What the caller has now seen: the version it made, the live version it was handed to merge,
      // or the version it read.
      if (result.outcome === "published") await remember({ ...row, filePath, versionId: result.versionId ?? null, via: "helper" }).catch(() => undefined);
      else if (result.outcome === "conflict") await remember({ ...row, filePath, versionId: result.versionId ?? null, via: "read" }).catch(() => undefined);
      else if (result.outcome === "done" && plan.tool === "Artifact" && result.versionId) await remember({ ...row, filePath: null, versionId: result.versionId, via: "read" }).catch(() => undefined);
    }
    await logRun({
      caller: request.callerAgentId, via: request.via, tool: plan.tool, mode: plan.mode, helperId: result.helperId, ms: result.ms, outcome: result.outcome,
      account: target.id, extraUsage: plan.extraUsage, ...(plan.guess ? { guess: true } : {}),
      ...(result.url ? { url: result.url } : {}), ...(result.versionId ? { version: result.versionId } : {}), ...(result.error ? { error: result.error } : {}),
    });
    job.result = result;
    return result;
  });
  tail = promise.then(() => undefined, () => undefined);
  const job: Job = { promise, result: null, at: queuedAt };
  pruneJobs();
  jobs.set(jobId, job);
  return { decision: "queued", jobId, owner: ownerName(target) };
}

/** Why the tool published nothing, in words the model can act on. */
function toolNote(plan: Extract<HookDecision, { decision: "pass" }>, view: ZeroSubView, account: string | null): string {
  const none = "Nothing was published.";
  switch (plan.why) {
    case "helper": return `A publishing helper can't start another one. ${none}`;
    case "not-a-publish": return `Give a file_path (or files) to publish, optionally with the url of a page published through Smart Session. ${none}`;
    case "no-agent": return `This only works inside a Paseo agent. ${none}`;
    case "no-zerosub": return `ZeroSub isn't enabled on this host, so this session's own account is the only one to publish as. ${none} Call Artifact directly.`;
    case "zerosub-unreadable": return `ZeroSub's account registry couldn't be read, so Smart Session can't tell which account to publish as. ${none}`;
    case "no-target": return account
      ? `No Claude account matches "${account}". Use "main", an account id, or a name the person gave an account. ${none}`
      : `ZeroSub has no main Claude account here. ${none}`;
    case "on-target": {
      const single = typeof view !== "string" && view.accounts.filter((candidate) => candidate.family === "claude").length < 2;
      return single
        ? `ZeroSub has only one Claude account here, so there is nothing to switch to. ${none} Call Artifact directly.`
        : `This session already runs on that account, so call Artifact directly. ${none}`;
    }
    case "owner": return `This session runs on the account that owns that page, so call Artifact directly. ${none}`;
    case "owner-unusable": return `The account that owns that page can't take it right now, so call Artifact directly from this session. ${none}`;
    default: return plan.note ?? none;
  }
}

function pruneJobs(): void {
  const cutoff = Date.now() - 15 * 60_000;
  for (const [id, job] of jobs) if (job.result !== null && job.at < cutoff) jobs.delete(id);
}

/** Waits up to `waitMs` for a queued publish. Unknown ids read as done with an error. */
export async function waitPublish(jobId: string, waitMs: number): Promise<{ done: false } | { done: true; result: PublishResult }> {
  const job = jobs.get(jobId);
  if (!job) return { done: true, result: { ok: false, url: null, owner: "the target account", ownerAccountId: "", helperId: null, ms: 0, outcome: "failed", error: "no such publish (the plugin may have reloaded)", resultText: null } };
  if (job.result) return { done: true, result: job.result };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(null), Math.max(0, Math.min(waitMs, MAX_WAIT_MS))); });
  try {
    const result = await Promise.race([job.promise, timeout]);
    return result ? { done: true, result } : { done: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Start and wait until done, for callers in this process (the native tool). */
export async function publishNow(request: PublishRequest): Promise<StartResult | { decision: "done"; result: PublishResult }> {
  const started = await startPublish(request);
  if (started.decision !== "queued") return started;
  for (;;) {
    const waited = await waitPublish(started.jobId, MAX_WAIT_MS);
    if (waited.done) return { decision: "done", result: waited.result };
  }
}

/** What the model reads for a finished publish, by the same rules the hook uses. */
export function describeResult(result: PublishResult, native: boolean): string {
  return describeWait(result, native).text;
}

/**
 * What the model reads for a finished job, and whether the original call should run after all:
 * a guess at the owner that the target couldn't see runs as it was, on the caller's own account.
 */
export function describeWait(result: PublishResult, native: boolean): { text: string; allow: boolean } {
  if (result.outcome === "not-owner") {
    return { allow: true, text: `Smart Session tried this on ${result.owner}, but it isn't a page the main Claude account can open, so it runs on this session's own account as asked.` };
  }
  if (result.outcome === "conflict" && result.url) {
    return { allow: false, text: conflictReason({ owner: result.owner, url: result.url, livePath: result.livePath ?? null, liveVersion: result.versionId ?? null }) };
  }
  if (result.outcome === "done") {
    return { allow: false, text: accessReason({ owner: result.owner, tool: result.tool ?? "Artifact", output: result.resultText ?? "", savedPath: result.livePath ?? null }) };
  }
  if (result.outcome === "auth") {
    return { allow: false, text: failureReason(`Smart Session couldn't sign in to ${result.owner === "the main Claude account (CLI login)" ? "the main Claude account" : result.owner}, twice, ten seconds apart. ${result.error ?? ""}`.trim(), result.owner, native) };
  }
  return {
    allow: false,
    text: result.ok && result.url
      ? successReason({ url: result.url, owner: result.owner, resultText: result.resultText })
      : failureReason(result.error ?? result.outcome, result.owner, native),
  };
}
