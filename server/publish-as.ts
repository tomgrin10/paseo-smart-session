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
  decide,
  failureReason,
  helperPrompt,
  normalizeUrl,
  ownerName,
  parseHelperReply,
  successReason,
  type ArtifactInput,
  type HookDecision,
  type OwnedPage,
} from "../shared/publish-as.ts";
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
  readonly outcome: "published" | "failed" | "timeout" | "wrong-account" | "busy";
  readonly error: string | null;
  /** For a page made from a type: the publish result, which says how to fill it. */
  readonly resultText: string | null;
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
  archive(agentId: string): Promise<void>;
}

/**
 * One helper run: create, pin, reopen, confirm the account, publish, archive. The archive is in a
 * `finally`, so a helper never outlives its publish, whether it worked, failed or timed out.
 */
export async function runHelper(
  ops: HelperOps,
  job: { target: ZeroSubAccount; input: ArtifactInput; cwd: string; extraUsage?: boolean },
  options: { turnMs?: number; newId?: () => string; now?: () => number } = {},
): Promise<PublishResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const helperId = (options.newId ?? randomUUID)();
  const owner = ownerName(job.target);
  const done = (outcome: PublishResult["outcome"], fields: Partial<PublishResult>): PublishResult => ({
    ok: false, url: null, owner, ownerAccountId: job.target.id, helperId, ms: now() - started, outcome,
    error: null, resultText: null, ...fields,
  });
  let created = false;
  try {
    await ops.create(helperId, job.cwd);
    created = true;
    const extraUsage = job.extraUsage === true;
    await ops.pin(helperId, job.target.id, extraUsage);
    if ((await ops.sessionAccount(helperId)) !== job.target.id) await ops.reload(helperId);
    const on = await ops.sessionAccount(helperId);
    // Never let the helper publish anywhere but the target: that would only make another seat page.
    if (on !== job.target.id) {
      const why = extraUsage ? ". Publishing on a limited account's Extra usage needs ZeroSub 1.5.1-pace.12 or later" : "";
      return done("wrong-account", { error: `the helper opened on another account (${on ?? "unknown"}), so nothing was published${why}` });
    }
    await ops.send(helperId, helperPrompt(job.input));
    const finished = await ops.wait(helperId, options.turnMs ?? HELPER_TURN_MS);
    if (finished.status === "timeout") return done("timeout", { error: `the helper didn't finish within ${Math.round((options.turnMs ?? HELPER_TURN_MS) / 1000)} s` });
    // Moved off the owner mid-turn (ZeroSub failing it over): whatever it made isn't the owner's page.
    const after = await ops.sessionAccount(helperId);
    if (after !== job.target.id) return done("wrong-account", { error: `the helper was moved to another account (${after ?? "unknown"}) during the publish, so it isn't published as the owner` });
    const reply = parseHelperReply(finished.lastMessage);
    if (finished.status !== "idle" || !reply.url) {
      return done("failed", { error: reply.error ?? finished.error ?? (finished.status === "permission" ? "the helper was asked for a permission" : "the helper reported no url") });
    }
    return done("published", { ok: true, url: reply.url, resultText: reply.resultText });
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

async function remember(page: OwnedPage): Promise<void> {
  const pages = (await readPages()).filter((candidate) => normalizeUrl(candidate.url) !== normalizeUrl(page.url) || candidate.callerAgentId !== page.callerAgentId);
  pages.push(page);
  await mkdir(dir(), { recursive: true });
  const target = join(dir(), "pages.json");
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(pages.slice(-500), null, 2), "utf8");
  await rename(temp, target);
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

export function daemonOps(client: DaemonClient, zerosubId: string): HelperOps {
  return {
    async create(agentId, cwd) {
      await client.createAgent({
        agentId, provider: "claude", model: HELPER_MODEL, modeId: "bypassPermissions", cwd,
        title: "Publish as main account (helper)", background: true,
        env: { [HELPER_ENV]: "1" }, labels: { [HELPER_LABEL.key]: HELPER_LABEL.value },
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
    callerAgentId: request.callerAgentId, provider: "claude", input, isHelper, pages, zerosub: view,
    // The tool publishes whatever the setting says; it is the explicit path.
    settings: {
      enabled: tool || settings.publishAsMain,
      accountId: (tool ? request.account : null) ?? settings.publishAsAccount,
      useExtraUsage: settings.publishAsExtraUsage,
    },
  });
  if (plan.decision === "refuse") {
    await logRun({ caller: request.callerAgentId, via: request.via, helperId: null, ms: 0, outcome: "refused", why: plan.why, account: plan.target.id });
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
      const go = (ops: HelperOps) => runHelper(ops, { target, input: staged, cwd: stageRoot, extraUsage: plan.extraUsage }, {
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
    if (result.ok && result.url && request.callerAgentId) {
      await remember({ url: result.url, callerAgentId: request.callerAgentId, filePath, accountId: target.id, at: new Date().toISOString() }).catch(() => undefined);
    }
    await logRun({ caller: request.callerAgentId, via: request.via, helperId: result.helperId, ms: result.ms, outcome: result.outcome, account: target.id, ...(result.url ? { url: result.url } : {}), ...(result.error ? { error: result.error } : {}) });
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
    case "unknown-url": return `That url wasn't published through Smart Session, so another account can't update it: only the account that owns a page can. ${none}`;
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
  return result.ok && result.url
    ? successReason({ url: result.url, owner: result.owner, resultText: result.resultText })
    : failureReason(result.error ?? result.outcome, result.owner, native);
}
