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

// ------------------------------------------------------------------ a limited owner (Extra usage)
//
// The invariant: the helper never runs on an account other than the publish owner, and it only runs
// on a limited owner when "Use the main account's Extra usage when it's out" is on and credits remain.
// Otherwise nothing starts: no helper is spent learning that ZeroSub put it on another account.

const LIMITED_UNTIL = "2026-11-15T04:00:00.120Z";
const NOW_13 = Date.parse("2026-11-13T09:00:00Z");
const limitedState = (limitKind: "window" | "budget" = "window") => ({
  ...STATE,
  accounts: STATE.accounts.map((account) => account.id === "claude-main" ? { ...account, limitedUntil: LIMITED_UNTIL, limitKind } : account),
});
const reading = (extraUsage: unknown) => ({
  "claude-main": { fetchedAt: "2026-11-13T08:59:00Z", windows: [{ id: "seven_day", usedPercent: 100, resetsAt: LIMITED_UNTIL }], ...(extraUsage === undefined ? {} : { extraUsage }) },
});
const ON = { enabled: true, spend: 13_752, limit: 22_000, currency: "USD" };

test("invariant: a limited owner takes a publish only with the setting on and credits left", () => {
  const cases: [string, unknown, boolean, "window" | "budget", string][] = [
    ["setting off", ON, false, "window", "refuse:extra-usage-setting-off"],
    ["setting on, credits left", ON, true, "window", "redirect:extra"],
    ["setting on, no spend limit reported", { ...ON, limit: null }, true, "window", "redirect:extra"],
    ["setting on, Extra usage off", { ...ON, enabled: false }, true, "window", "refuse:extra-usage-off"],
    ["setting on, monthly limit reached", { ...ON, spend: 22_000 }, true, "window", "refuse:extra-usage-spent"],
    ["setting on, Claude said out of extra usage", ON, true, "budget", "refuse:extra-usage-spent"],
    ["setting on, no reading of Extra usage", undefined, true, "window", "refuse:extra-usage-unknown"],
  ];
  for (const [name, extra, useExtraUsage, kind, expected] of cases) {
    const zerosub = parseZeroSub(limitedState(kind), reading(extra), {})!;
    const result = decide(base({ file_path: "/p.html" }, { zerosub, now: NOW_13, settings: { enabled: true, accountId: null, useExtraUsage } }) as HookInput) as any;
    const got = result.decision === "redirect" ? `redirect:${result.extraUsage ? "extra" : "room"}` : result.decision === "refuse" ? `refuse:${result.why}` : `pass:${result.why}`;
    assert.equal(got, expected, name);
    if (result.decision !== "pass") assert.equal(result.target.id, "claude-main", name);
  }
  // Not limited: as before, and never on Extra usage.
  const fine = decide(base({ file_path: "/p.html" }, { now: NOW_13, settings: { enabled: true, accountId: null, useExtraUsage: true } }) as HookInput) as any;
  assert.equal(fine.decision, "redirect");
  assert.equal(fine.extraUsage, false);
  // A limit that has passed is room again.
  const passed = decide(base({ file_path: "/p.html" }, { zerosub: parseZeroSub(limitedState(), reading(ON), {})!, now: Date.parse(LIMITED_UNTIL) + 1, settings: { enabled: true, accountId: null } }) as HookInput) as any;
  assert.equal(passed.decision, "redirect");
  // An unknown url still passes through first: only its owner can update it.
  const unknown = decide(base({ file_path: "/p.html", url: "https://claude.ai/artifact/Old" }, { zerosub: parseZeroSub(limitedState(), reading(ON), {})!, now: NOW_13 }) as HookInput);
  assert.equal(unknown.decision, "pass");
});

test("a refused publish names the reason and the fix (pinned)", () => {
  const note = (extra: unknown, useExtraUsage: boolean, kind: "window" | "budget" = "window") =>
    (decide(base({ file_path: "/p.html" }, { zerosub: parseZeroSub(limitedState(kind), reading(extra), {})!, now: NOW_13, settings: { enabled: true, accountId: null, useExtraUsage } }) as HookInput) as any).note as string;
  const off = note(ON, false);
  assert.match(off, /^Not published: the main Claude account \(CLI login\) is out of usage until Sun 15 Nov, 04:00 UTC/);
  assert.match(off, /Nothing was published and no helper was started\./);
  assert.match(off, /turn on "Use the main account's Extra usage when it's out" in Smart Session's settings/);
  assert.match(note({ ...ON, enabled: false }, true), /Extra usage is off for that account.*turn on Extra usage for that account at claude\.ai/);
  assert.match(note({ ...ON, spend: 22_000 }, true), /Extra usage is used up \(\$220\.00 of its \$220\.00 monthly limit\).*raise that account's Extra usage limit/);
  assert.match(note(undefined, true), /hasn't reported whether it has Extra usage left.*Try again in a few minutes/);
  for (const text of [off, note(ON, true, "budget")]) assert.doesNotMatch(text, /@/, "never an email");
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

function fakeOps(options: { onTarget?: "at-once" | "after-reload" | "never" | "moved-during-turn"; reply?: string | null; status?: string; failOn?: keyof HelperOps } = {}) {
  const calls: string[] = [];
  let reloaded = false;
  const fail = (step: keyof HelperOps) => { if (options.failOn === step) throw new Error(`${step} failed`); };
  const ops: HelperOps = {
    async create(id) { calls.push(`create:${id}`); fail("create"); },
    async pin(_id, account, allowLimited) { calls.push(`pin:${account}${allowLimited ? "+limited" : ""}`); fail("pin"); },
    async reload() { calls.push("reload"); reloaded = true; fail("reload"); },
    async sessionAccount() {
      const mode = options.onTarget ?? "after-reload";
      if (mode === "moved-during-turn") return calls.includes("wait") ? "claude-seat" : "claude-main";
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

test("helper: on Extra usage the pin allows the limited owner; without it, it doesn't", async () => {
  const extra = fakeOps();
  await runHelper(extra.ops, { ...job(), extraUsage: true }, { newId: () => "h7" });
  assert.equal(extra.calls[1], "pin:claude-main+limited");
  const plain = fakeOps();
  await runHelper(plain.ops, job(), { newId: () => "h8" });
  assert.equal(plain.calls[1], "pin:claude-main");
});

test("helper: moved off the owner during its turn is not a publish", async () => {
  const { ops, calls } = fakeOps({ onTarget: "moved-during-turn" });
  const result = await runHelper(ops, job(), { newId: () => "h9" });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "wrong-account");
  assert.equal(result.url, null);
  assert.equal(calls.at(-1), "archive:h9");
});

test("helper: an old ZeroSub that ignores the limited pin says what to update", async () => {
  const { ops } = fakeOps({ onTarget: "never" });
  const result = await runHelper(ops, { ...job(), extraUsage: true }, { newId: () => "h10" });
  assert.equal(result.outcome, "wrong-account");
  assert.match(result.error ?? "", /ZeroSub 1\.5\.1-pace\.12 or later/);
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

async function setupHost(state: unknown | "corrupt" | "none", usage?: unknown) {
  const home = mkdtempSync(join(tmpdir(), "ss-publish-"));
  process.env.PASEO_HOME = home;
  writeFileSync(join(home, "config.json"), JSON.stringify({ plugins: state === "none" ? {} : { zerosub: { enabled: true } } }));
  mkdirSync(join(home, "zerosub"), { recursive: true });
  if (state !== "none") writeFileSync(join(home, "zerosub", "state.json"), state === "corrupt" ? "{not json" : JSON.stringify(state));
  if (usage !== undefined) writeFileSync(join(home, "zerosub", "usage.json"), JSON.stringify(usage));
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

test("limited main, setting off → deny with the reason, no helper, a refused run logged", async () => {
  const { home, work, call, helpers } = await setupHost(limitedState(), reading(ON));
  const out = await publishAsHook(event(work, { file_path: "page.html" }), { env: { PASEO_AGENT_ID: SEAT }, call, native: true }) as any;
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^Not published: .* is out of usage until .*Use the main account's Extra usage when it's out/s);
  assert.equal(helpers.length, 0, "no helper is spent on a publish that can't land");
  const dir = join(home, "plugin-data", "smart-session", "publish-as");
  const log = readdirSync(dir).find((name) => name.startsWith("runs-"))!;
  const run = JSON.parse(readFileSync(join(dir, log), "utf8").trim());
  assert.equal(run.outcome, "refused");
  assert.equal(run.why, "extra-usage-setting-off");
  assert.equal(run.helperId, null);
  // The tool says the same, and starts nothing either.
  const server = (await import("./server/publish-as.ts")) as typeof import("./server/publish-as.ts");
  const started = await server.startPublish({ callerAgentId: SEAT, cwd: work, input: { file_path: join(work, "page.html") }, via: "tool" });
  assert.equal(started.decision, "refused");
  assert.match((started as { note: string }).note, /Nothing was published and no helper was started/);
  assert.equal(helpers.length, 0);
});

test("limited main, setting on with credits left → the helper runs on main's Extra usage", async () => {
  const { work, call, helpers } = await setupHost(limitedState(), reading(ON));
  const settings = (await import("./server/settings.ts")) as typeof import("./server/settings.ts");
  await settings.writeSettings({ publishAsExtraUsage: true });
  const out = await publishAsHook(event(work, { file_path: "page.html" }), { env: { PASEO_AGENT_ID: SEAT }, call, native: true }) as any;
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^Published as /);
  assert.equal(helpers.length, 1);
  assert.equal(helpers[0]![1], "pin:claude-main+limited");
});

test("the Extra usage setting is off by default and survives a round trip", async () => {
  await setupHost(STATE);
  const settings = (await import("./server/settings.ts")) as typeof import("./server/settings.ts");
  assert.equal(settings.DEFAULT_SETTINGS.publishAsExtraUsage, false);
  assert.equal((await settings.readSettings()).publishAsExtraUsage, false);
  assert.equal((await settings.writeSettings({ publishAsExtraUsage: true })).publishAsExtraUsage, true);
  settings.clearSettingsCache();
  assert.equal((await settings.readSettings()).publishAsExtraUsage, true);
});
