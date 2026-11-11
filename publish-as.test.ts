import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseZeroSub, type ZeroSubSnapshot } from "./shared/guard/zerosub.ts";
import {
  classify,
  decide,
  failureReason,
  helperPrompt,
  ownerName,
  parseHelperReply,
  successReason,
  type ArtifactInput,
  type HookInput,
  type OwnedPage,
} from "./shared/publish-as.ts";
import { runHelper, stage, type HelperOps } from "./server/publish-as.ts";
import { publishAsHook } from "./server/hooklib/publish-as.mjs";

const SEAT = "seat-agent";
const MAIN = "main-agent";
const URL = "https://claude.ai/artifact/AbC123";

const STATE = {
  accounts: [
    { id: "claude-main", family: "claude", kind: "main", label: "tom@example.com", autoLabel: true, signedIn: true, createdAt: "2026-01-01T00:00:00Z" },
    { id: "claude-seat", family: "claude", kind: "managed", label: "seat@example.com", autoLabel: true, signedIn: true, createdAt: "2026-02-01T00:00:00Z" },
    { id: "codex-main", family: "codex", kind: "main", label: "tom@example.com", signedIn: true },
  ],
  sessions: { [SEAT]: { accountId: "claude-seat" }, [MAIN]: { accountId: "claude-main" } },
};
const snapshot = (state: unknown = STATE): ZeroSubSnapshot => parseZeroSub(state, {}, {})!;

const base = (input: ArtifactInput, extra: Partial<HookInput> = {}): HookInput => ({
  callerAgentId: SEAT, provider: "claude", input, isHelper: false, pages: [],
  settings: { enabled: true, accountId: null }, zerosub: snapshot(), ...extra,
});
const ours: OwnedPage = { url: URL, callerAgentId: SEAT, filePath: "/work/page.html", accountId: "claude-main", at: "2026-11-11T00:00:00Z" };

test("classify: only a publish creates or changes a page", () => {
  assert.deepEqual(classify({ file_path: "/a.html" }), { kind: "create", filePath: "/a.html" });
  assert.deepEqual(classify({ action: "publish", files: { "a.css": "a.css" } }), { kind: "create", filePath: null });
  assert.deepEqual(classify({ type_url: "https://claude.ai/type/x", title: "Deck" }), { kind: "create", filePath: null });
  assert.deepEqual(classify({ file_path: "/a.html", url: `${URL}/` }), { kind: "update", url: URL });
  assert.deepEqual(classify({ asset: true, url: URL, file_path: "/a.png" }), { kind: "update", url: URL });
  for (const action of ["read", "list", "open", "quickstart", "delete", "pin", "unpin"]) {
    assert.deepEqual(classify({ action, url: URL }), { kind: "other" }, action);
  }
  assert.deepEqual(classify({ asset: true, file_path: "/a.png" }), { kind: "other" });
});

test("decision table: account × action", () => {
  const cases: [string, HookInput, string][] = [
    ["seat publishes a new page", base({ file_path: "/work/page.html" }), "redirect"],
    ["seat makes a page from a type", base({ type_url: "https://claude.ai/type/slides", title: "Deck" }), "redirect"],
    ["seat updates a page we made", base({ file_path: "/work/page.html", url: URL }, { pages: [ours] }), "redirect"],
    ["seat uploads an asset to a page we made", base({ asset: true, url: URL, file_path: "/work/a.png" }, { pages: [ours] }), "redirect"],
    ["seat updates an older seat page (unknown url)", base({ file_path: "/work/page.html", url: "https://claude.ai/artifact/Old" }), "pass:unknown-url"],
    ["seat uploads an asset to an unknown page", base({ asset: true, url: "https://claude.ai/artifact/Old", file_path: "/a.png" }), "pass:unknown-url"],
    ["seat reads", base({ action: "read", url: URL }, { pages: [ours] }), "pass:not-a-publish"],
    ["seat lists", base({ action: "list" }), "pass:not-a-publish"],
    ["seat starts from quickstart", base({ action: "quickstart", intent: "other" }), "pass:not-a-publish"],
    ["seat deletes a page we made", base({ action: "delete", url: URL }, { pages: [ours] }), "pass:not-a-publish"],
    ["main session publishes", base({ file_path: "/p.html" }, { callerAgentId: MAIN }), "pass:on-target"],
    ["a session ZeroSub never routed (CLI login)", base({ file_path: "/p.html" }, { callerAgentId: "unknown" }), "pass:on-target"],
    ["setting off", base({ file_path: "/p.html" }, { settings: { enabled: false, accountId: null } }), "pass:setting-off"],
    ["no ZeroSub", base({ file_path: "/p.html" }, { zerosub: "absent" }), "pass:no-zerosub"],
    ["ZeroSub unreadable", base({ file_path: "/p.html" }, { zerosub: "unreadable" }), "pass:zerosub-unreadable"],
    ["the helper itself", base({ file_path: "/p.html" }, { isHelper: true }), "pass:helper"],
    ["not a Paseo agent", base({ file_path: "/p.html" }, { callerAgentId: null }), "pass:no-agent"],
    ["main session, target set to the seat", base({ file_path: "/p.html" }, { callerAgentId: MAIN, settings: { enabled: true, accountId: "claude-seat" } }), "redirect"],
  ];
  for (const [name, input, expected] of cases) {
    const result = decide(input);
    assert.equal(result.decision === "pass" ? `pass:${result.why}` : result.decision, expected, name);
    if (result.decision === "redirect") assert.equal(result.target.id, name.includes("target set") ? "claude-seat" : "claude-main", name);
  }
});

test("zerosub unreadable passes through with a note that says so", () => {
  const result = decide(base({ file_path: "/p.html" }, { zerosub: "unreadable" }));
  assert.equal(result.decision, "pass");
  assert.match((result as { note: string }).note, /couldn't read ZeroSub's account registry/);
});

test("a signed-out target passes through and says why", () => {
  const state = structuredClone(STATE);
  (state.accounts[0] as Record<string, unknown>).signedIn = false;
  const result = decide(base({ file_path: "/p.html" }, { zerosub: snapshot(state) }));
  assert.equal(result.decision === "pass" && result.why, "target-unusable");
  assert.match((result as { note: string }).note, /signed out/);
});

test("republishing the same file updates the same page, only for the caller that made it", () => {
  const same = decide(base({ file_path: "/work/page.html" }, { pages: [ours] }));
  assert.equal(same.decision === "redirect" && same.input.url, URL);
  const other = decide(base({ file_path: "/work/page.html" }, { pages: [{ ...ours, callerAgentId: "someone-else" }] }));
  assert.equal(other.decision === "redirect" && other.input.url, undefined);
});

test("owner names never repeat an email or a generated label", () => {
  const view = snapshot();
  assert.equal(ownerName(view.accounts.find((account) => account.id === "claude-main")!), "the main Claude account (CLI login)");
  const named = snapshot({ ...STATE, accounts: [{ ...STATE.accounts[0], label: "Tom", autoLabel: false }] });
  assert.equal(ownerName(named.accounts[0]!), "Tom (the main Claude account)");
});

test("the success wording leads with the result and says not to retry (pinned)", () => {
  const text = successReason({ url: URL, owner: "the main Claude account (CLI login)" });
  assert.equal(
    text.split("\n")[0],
    `Published as the main Claude account (CLI login): ${URL}. This is the finished publish, not an error; do not retry or republish.`,
  );
  assert.match(text, /Owner: the main Claude account \(CLI login\) \(via helper\)\./);
  assert.match(text, new RegExp(`To update this page later, call Artifact again with url ${URL}`));
  assert.doesNotMatch(text, /fail|error:|denied/i);
  assert.match(failureReason("boom", "X", true), /^Not published: .*\(boom\)\.\nNothing was published\. To try again, call smart_publish_as /);
  assert.match(failureReason("boom", "X", false), /call publish_as /);
});

test("the helper's reply is read defensively", () => {
  assert.deepEqual(parseHelperReply(`Done.\n{"url": "${URL}", "error": null}`), { url: URL, error: null, resultText: null });
  assert.equal(parseHelperReply(`Published at ${URL} for you`).url, URL);
  assert.deepEqual(parseHelperReply('{"url": null, "error": "refused"}'), { url: null, error: "refused", resultText: null });
  assert.equal(parseHelperReply(null).url, null);
  assert.match(helperPrompt({ action: "publish", file_path: "a/p.html", url: URL }), /action "read" and url https/);
  assert.doesNotMatch(helperPrompt({ action: "publish", file_path: "a/p.html" }), /action "read"/);
});

// ------------------------------------------------------------------ the helper's lifecycle

function fakeOps(options: { onTarget?: "at-once" | "after-reload" | "never"; reply?: string | null; status?: string; failOn?: keyof HelperOps } = {}) {
  const calls: string[] = [];
  let reloaded = false;
  const fail = (step: keyof HelperOps) => { if (options.failOn === step) throw new Error(`${step} failed`); };
  const ops: HelperOps = {
    async create(id) { calls.push(`create:${id}`); fail("create"); },
    async pin(_id, account) { calls.push(`pin:${account}`); fail("pin"); },
    async reload() { calls.push("reload"); reloaded = true; fail("reload"); },
    async sessionAccount() {
      const mode = options.onTarget ?? "after-reload";
      return mode === "at-once" || (mode === "after-reload" && reloaded) ? "claude-main" : "claude-seat";
    },
    async send() { calls.push("send"); fail("send"); },
    async wait() { calls.push("wait"); fail("wait"); return { status: options.status ?? "idle", error: null, lastMessage: options.reply === undefined ? `{"url": "${URL}", "error": null}` : options.reply }; },
    async archive(id) { calls.push(`archive:${id}`); },
  };
  return { ops, calls };
}
const job = () => ({ target: snapshot().accounts.find((account) => account.id === "claude-main")!, input: { file_path: "p.html" }, cwd: "/stage" });

test("helper: pinned, reopened, confirmed on the target, then prompted, then archived", async () => {
  const { ops, calls } = fakeOps();
  const result = await runHelper(ops, job(), { newId: () => "h1" });
  assert.equal(result.ok, true);
  assert.equal(result.url, URL);
  assert.equal(result.ownerAccountId, "claude-main");
  assert.deepEqual(calls, ["create:h1", "pin:claude-main", "reload", "send", "wait", "archive:h1"]);
});

test("helper: never prompted while it runs on another account, and still archived", async () => {
  const { ops, calls } = fakeOps({ onTarget: "never" });
  const result = await runHelper(ops, job(), { newId: () => "h2" });
  assert.equal(result.outcome, "wrong-account");
  assert.ok(!calls.includes("send"), "the prompt must not reach a helper on the wrong account");
  assert.equal(calls.at(-1), "archive:h2");
});

test("helper: archived on failure and on timeout", async () => {
  for (const failOn of ["pin", "reload", "send", "wait"] as const) {
    const { ops, calls } = fakeOps({ failOn });
    const result = await runHelper(ops, job(), { newId: () => "h3" });
    assert.equal(result.ok, false, failOn);
    assert.equal(calls.at(-1), "archive:h3", `archived after ${failOn} failed`);
  }
  const timed = fakeOps({ status: "timeout" });
  const result = await runHelper(timed.ops, job(), { newId: () => "h4" });
  assert.equal(result.outcome, "timeout");
  assert.equal(timed.calls.at(-1), "archive:h4");
  const noUrl = fakeOps({ reply: '{"url": null, "error": "refused"}' });
  assert.equal((await runHelper(noUrl.ops, job(), { newId: () => "h5" })).error, "refused");
});

test("helper: a create that fails leaves nothing to archive", async () => {
  const { ops, calls } = fakeOps({ failOn: "create" });
  const result = await runHelper(ops, job(), { newId: () => "h6" });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ["create:h6"]);
});

test("stage copies the page and its files and keeps published paths", async () => {
  const work = mkdtempSync(join(tmpdir(), "ss-stage-work-"));
  const root = mkdtempSync(join(tmpdir(), "ss-stage-root-"));
  writeFileSync(join(work, "page.html"), "<p>hi</p>");
  mkdirSync(join(work, "assets"));
  writeFileSync(join(work, "assets", "a.css"), "p{}");
  const staged = await stage({ file_path: join(work, "page.html"), files: { "assets/a.css": "assets/a.css", "b.js": { from: join(work, "assets", "a.css"), contentType: "text/javascript" }, gone: null } }, work, root, "job1");
  assert.equal(staged.file_path, join("job1", "0", "page.html"));
  assert.equal(readFileSync(join(root, staged.file_path as string), "utf8"), "<p>hi</p>");
  const files = staged.files as Record<string, unknown>;
  assert.equal(readFileSync(join(root, files["assets/a.css"] as string), "utf8"), "p{}");
  assert.deepEqual(Object.keys(files), ["assets/a.css", "b.js", "gone"], "published paths are kept");
  assert.equal((files["b.js"] as { contentType: string }).contentType, "text/javascript");
  assert.equal(files.gone, null);
});

// ------------------------------------------------------------------ through the hook, end to end

async function setupHost(state: unknown | "corrupt" | "none") {
  const home = mkdtempSync(join(tmpdir(), "ss-publish-"));
  process.env.PASEO_HOME = home;
  writeFileSync(join(home, "config.json"), JSON.stringify({ plugins: state === "none" ? {} : { zerosub: { enabled: true } } }));
  mkdirSync(join(home, "zerosub"), { recursive: true });
  if (state !== "none") writeFileSync(join(home, "zerosub", "state.json"), state === "corrupt" ? "{not json" : JSON.stringify(state));
  const work = join(home, "work");
  mkdirSync(work);
  writeFileSync(join(work, "page.html"), "<!doctype html><title>t</title>");
  const settings = (await import("./server/settings.ts")) as typeof import("./server/settings.ts");
  settings.clearSettingsCache();
  const server = (await import("./server/publish-as.ts")) as typeof import("./server/publish-as.ts");
  const helpers: string[][] = [];
  server.setOpsFactory(async (_zerosub, run) => {
    const { ops, calls } = fakeOps();
    helpers.push(calls);
    return run(ops);
  });
  // The hook reaches the plugin over the daemon; here it calls the same handlers in-process.
  const call = async (method: string, input: any) => {
    if (method === "smart-session.publish_as.start") return server.startPublish({ ...input, account: input.account ?? null });
    if (method === "smart-session.publish_as.wait") {
      const waited = await server.waitPublish(input.jobId, input.waitMs);
      return waited.done ? { ...waited, text: server.describeResult(waited.result, input.native === true) } : waited;
    }
    throw new Error(`unexpected ${method}`);
  };
  return { home, work, call, helpers };
}
const event = (work: string, input: ArtifactInput) => ({ hook_event_name: "PreToolUse", tool_name: "Artifact", cwd: work, tool_input: input });

test("seat session → hook → helper on main → deny with the url", async () => {
  const { home, work, call, helpers } = await setupHost(STATE);
  const out = await publishAsHook(event(work, { file_path: "page.html", icon: "doc" }), { env: { PASEO_AGENT_ID: SEAT }, call, native: true }) as any;
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(`^Published as the main Claude account \\(CLI login\\): ${URL}\\. This is the finished publish, not an error; do not retry or republish\\.`));
  assert.equal(helpers.length, 1);
  assert.equal(helpers[0]!.at(-1)?.startsWith("archive:"), true, "the helper is archived");
  const pages = JSON.parse(readFileSync(join(home, "plugin-data", "smart-session", "publish-as", "pages.json"), "utf8"));
  assert.deepEqual(pages.map((page: OwnedPage) => [page.url, page.callerAgentId, page.filePath]), [[URL, SEAT, join(work, "page.html")]]);
  const logs = readdirSync(join(home, "plugin-data", "smart-session", "publish-as")).filter((name) => name.startsWith("runs-"));
  const run = JSON.parse(readFileSync(join(home, "plugin-data", "smart-session", "publish-as", logs[0]!), "utf8").trim());
  assert.equal(run.outcome, "published");
  assert.equal(run.caller, SEAT);
  assert.equal(typeof run.ms, "number");
  assert.equal(typeof run.helperId, "string");

  // The same file again updates that page: the helper gets its url.
  const again = await publishAsHook(event(work, { file_path: join(work, "page.html") }), { env: { PASEO_AGENT_ID: SEAT }, call, native: true }) as any;
  assert.equal(again.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(helpers.length, 2);
});

test("unknown url → passthrough; main session → passthrough; helper env → passthrough", async () => {
  const { work, call, helpers } = await setupHost(STATE);
  const unknown = await publishAsHook(event(work, { file_path: "page.html", url: "https://claude.ai/artifact/SeatOwned" }), { env: { PASEO_AGENT_ID: SEAT }, call, native: true });
  assert.equal(unknown, null, "an older seat page is updated by the seat, untouched");
  assert.equal(await publishAsHook(event(work, { file_path: "page.html" }), { env: { PASEO_AGENT_ID: MAIN }, call, native: true }), null);
  assert.equal(await publishAsHook(event(work, { file_path: "page.html" }), { env: { PASEO_AGENT_ID: SEAT, SMART_SESSION_PUBLISH_HELPER: "1" }, call, native: true }), null);
  assert.equal(await publishAsHook(event(work, { action: "read", url: URL }), { env: { PASEO_AGENT_ID: SEAT }, call: () => { throw new Error("no daemon call for a read"); }, native: true }), null);
  assert.equal(helpers.length, 0);
});

test("zerosub unreadable → passthrough, with a note; daemon unreachable → passthrough, with a note", async () => {
  const { work, call, helpers } = await setupHost("corrupt");
  const out = await publishAsHook(event(work, { file_path: "page.html" }), { env: { PASEO_AGENT_ID: SEAT }, call, native: true }) as any;
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined, "the call goes through");
  assert.match(out.hookSpecificOutput.additionalContext, /couldn't read ZeroSub's account registry/);
  const down = await publishAsHook(event(work, { file_path: "page.html" }), { env: { PASEO_AGENT_ID: SEAT }, call: async () => { throw new Error("ECONNREFUSED"); }, native: true }) as any;
  assert.equal(down.hookSpecificOutput.permissionDecision, undefined);
  assert.match(down.hookSpecificOutput.additionalContext, /couldn't reach Paseo/);
  assert.equal(helpers.length, 0);
  const none = await setupHost("none");
  assert.equal(await publishAsHook(event(none.work, { file_path: "page.html" }), { env: { PASEO_AGENT_ID: SEAT }, call: none.call, native: true }), null, "without ZeroSub nothing changes");
});

test("one helper at a time: concurrent publishes run one after the other", async () => {
  const { work, call } = await setupHost(STATE);
  const server = (await import("./server/publish-as.ts")) as typeof import("./server/publish-as.ts");
  let running = 0;
  let peak = 0;
  server.setOpsFactory(async (_zerosub, run) => {
    running += 1;
    peak = Math.max(peak, running);
    const { ops } = fakeOps();
    const slow: HelperOps = { ...ops, wait: async (id, ms) => { await new Promise((resolve) => setTimeout(resolve, 30)); return ops.wait(id, ms); } };
    try { return await run(slow); } finally { running -= 1; }
  });
  const results = await Promise.all([1, 2, 3].map(() => publishAsHook(event(work, { file_path: "page.html" }), { env: { PASEO_AGENT_ID: SEAT }, call, native: true }) as Promise<any>));
  assert.equal(peak, 1);
  for (const result of results) assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
});

test("the tool says plainly when there is nothing to switch to", async () => {
  const single = { accounts: [STATE.accounts[0]], sessions: { [SEAT]: { accountId: "claude-main" } } };
  await setupHost(single);
  const server = (await import("./server/publish-as.ts")) as typeof import("./server/publish-as.ts");
  const started = await server.startPublish({ callerAgentId: SEAT, cwd: "/", input: { file_path: "/x.html" }, via: "tool" });
  assert.equal(started.decision, "pass");
  assert.match((started as { note: string }).note, /only one Claude account/);
  await setupHost("none");
  const absent = await server.startPublish({ callerAgentId: SEAT, cwd: "/", input: { file_path: "/x.html" }, via: "tool" });
  assert.match((absent as { note: string }).note, /ZeroSub isn't enabled/);
});
