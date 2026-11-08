/**
 * Smart Compact's two lines: the lower one asks at the end of a turn (`Stop`), the
 * upper one asks right away, mid-turn (`PostToolUse`).
 *
 * Every case drives the real hook scripts over stdin, against a throwaway
 * `$PASEO_HOME`, on a 1M window whose defaults put the lines at 30% and 40%.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { DEFAULT_THRESHOLDS, defaultNowFor, linesProblem, normalizeProfile, normalizeThresholds, withCompactThreshold } from "./shared/thresholds.ts";
// @ts-expect-error -- a dependency-free hook module with no type declarations.
import { withUpperLine } from "./hooks/context.mjs";

const execFileAsync = promisify(execFile);
const AGENT = "agent-two-lines";

function home(options: { enrolled?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "ss-lines-"));
  const dir = join(root, "plugin-data", "smart-session");
  mkdirSync(join(dir, "state"), { recursive: true });
  if (options.enrolled !== false) writeFileSync(join(dir, "state", `${AGENT}.md`), "# Task state\n", "utf8");
  return root;
}

const data = (root: string, ...parts: string[]) => join(root, "plugin-data", "smart-session", ...parts);

function transcriptAt(used: number): string {
  const path = join(mkdtempSync(join(tmpdir(), "ss-lines-tx-")), "t.jsonl");
  const usage = { input_tokens: 2, cache_read_input_tokens: used - 2, cache_creation_input_tokens: 0, output_tokens: 0 };
  writeFileSync(path, `${JSON.stringify({ type: "assistant", isSidechain: false, message: { model: "claude-opus-5", usage } })}\n`);
  return path;
}

async function run(script: string, root: string, used: number, event: Record<string, unknown> = {}): Promise<string> {
  const child = execFileAsync(process.execPath, [script], {
    env: { ...process.env, PASEO_HOME: root, PASEO_AGENT_ID: AGENT, SMART_SESSION_CONTEXT_WINDOW: "1000000" },
  });
  child.child.stdin?.end(JSON.stringify({ session_id: "s1", transcript_path: transcriptAt(used), cwd: root, ...event }));
  return (await child).stdout.trim();
}

const toolCall = (root: string, used: number, event: Record<string, unknown> = {}) =>
  run("hooks/context-threshold.mjs", root, used, { hook_event_name: "PostToolUse", ...event });
const turnEnd = (root: string, used: number) =>
  run("hooks/ask-compact.mjs", root, used, { hook_event_name: "Stop", stop_hook_active: false });

function said(output: string): string {
  if (output === "") return "";
  return (JSON.parse(output) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
}

/** Whether a PostToolUse output is the upper line's mid-turn question. */
const askedNow = (output: string) => /past its upper line/.test(said(output));

function ledger(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(data(root, "asks", `${AGENT}.json`), "utf8")) as Record<string, unknown>;
}

function patchLedger(root: string, patch: Record<string, unknown>): void {
  writeFileSync(data(root, "asks", `${AGENT}.json`), JSON.stringify({ ...ledger(root), ...patch }), "utf8");
}

function queue(root: string, items: Array<Record<string, unknown>>): void {
  writeFileSync(data(root, "compactions.json"), JSON.stringify({ version: 1, items }), "utf8");
}

test("below both lines neither hook asks", async () => {
  const root = home();
  assert.equal(askedNow(await toolCall(root, 250_000)), false);
  assert.equal(await turnEnd(root, 250_000), "");
});

test("between the lines: no mid-turn ask, but the turn-end ask", async () => {
  const root = home();
  const mid = said(await toolCall(root, 350_000));
  assert.doesNotMatch(mid, /past its upper line|request_compaction/, "only the descriptive band line");
  const end = said(await turnEnd(root, 350_000));
  assert.match(end, /request_compaction/);
  assert.match(end, /defer_compaction/);
});

test("above the upper line it asks mid-turn, once, with what to do", async () => {
  const root = home();
  const first = await toolCall(root, 450_000);
  const text = said(first);
  assert.equal((JSON.parse(first) as { hookSpecificOutput: { hookEventName: string } }).hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(text, /past its upper line of 40%/);
  assert.match(text, /Finish only the atomic step/);
  assert.match(text, /continue_after_compaction set to true/);
  assert.match(text, /End your turn/);
  assert.match(text, /defer_compaction/, "still refusable");
  assert.equal(ledger(root).nowAskCount, 1);

  // Latched: the next tool call, and one well past it, stay quiet.
  assert.equal(askedNow(await toolCall(root, 460_000)), false);
  assert.equal(askedNow(await toolCall(root, 700_000)), false, "growth alone does not repeat it");
});

test("the mid-turn ask is re-armed by a compaction", async () => {
  const root = home();
  assert.equal(askedNow(await toolCall(root, 450_000)), true);
  await run("hooks/post-compact.mjs", root, 450_000, { hook_event_name: "PostCompact", trigger: "manual", compact_summary: "..." });
  // The next fill is a new epoch.
  assert.equal(askedNow(await toolCall(root, 120_000)), false);
  assert.equal(askedNow(await toolCall(root, 450_000)), true);
});

test("a deferral holds the mid-turn ask off, and it comes back when it runs out", async () => {
  const root = home();
  assert.equal(askedNow(await toolCall(root, 450_000)), true);

  patchLedger(root, { deferredUntil: new Date(Date.now() + 30 * 60_000).toISOString(), deferredAt: new Date().toISOString(), deferReason: "mid-refactor" });
  assert.equal(askedNow(await toolCall(root, 500_000)), false, "not while the deferral holds");

  patchLedger(root, { deferredUntil: new Date(Date.now() - 1000).toISOString() });
  assert.equal(askedNow(await toolCall(root, 500_000)), true, "asked again once it runs out");
  assert.equal(ledger(root).nowAskCount, 2);
  assert.equal(askedNow(await toolCall(root, 510_000)), false, "and latched again");
});

test("a deferral from before the mid-turn ask does not earn a second one", async () => {
  const root = home();
  // Deferred at the lower line, long expired, then crossed the upper line.
  await turnEnd(root, 320_000);
  patchLedger(root, { deferredAt: new Date(Date.now() - 60 * 60_000).toISOString(), deferredUntil: new Date(Date.now() - 30 * 60_000).toISOString() });
  assert.equal(askedNow(await toolCall(root, 450_000)), true);
  assert.equal(askedNow(await toolCall(root, 460_000)), false);
});

test("the mid-turn ask stops after the same number of deferrals as the turn-end one", async () => {
  const root = home();
  for (let round = 0; round < 3; round += 1) {
    assert.equal(askedNow(await toolCall(root, 450_000 + round * 10_000)), true, `round ${round + 1}`);
    patchLedger(root, { deferredAt: new Date(Date.now() + 1000).toISOString(), deferredUntil: new Date(Date.now() - 1).toISOString() });
  }
  assert.equal(askedNow(await toolCall(root, 600_000)), false, "three asks, then it is the agent's call");
});

test("a live deferral from the turn-end ask also holds the mid-turn one", async () => {
  const root = home();
  await turnEnd(root, 320_000);
  patchLedger(root, { deferredUntil: new Date(Date.now() + 30 * 60_000).toISOString(), deferredAt: new Date().toISOString() });
  assert.equal(askedNow(await toolCall(root, 450_000)), false);
});

test("a queued compaction is not asked for again mid-turn", async () => {
  const root = home();
  queue(root, [{ agentId: AGENT, state: "pending", settledAt: null }]);
  assert.equal(askedNow(await toolCall(root, 450_000)), false);
});

test("a window that refilled within minutes hears the thrashing advice instead", async () => {
  const root = home();
  queue(root, [{ agentId: AGENT, state: "sent", settledAt: new Date().toISOString() }]);
  const text = said(await toolCall(root, 450_000));
  assert.match(text, /refilled/);
  assert.doesNotMatch(text, /request_compaction/);
  assert.equal(said(await toolCall(root, 460_000)).includes("refilled"), false, "said once");
});

test("a subagent is never asked", async () => {
  const root = home();
  assert.equal(await toolCall(root, 450_000, { agent_id: "sub-1" }), "");
});

test("a session nobody enrolled is never asked mid-turn", async () => {
  const root = home({ enrolled: false });
  const text = said(await toolCall(root, 450_000));
  assert.doesNotMatch(text, /past its upper line|request_compaction/);
});

test("with Smart Compact off nothing asks mid-turn", async () => {
  const root = home();
  writeFileSync(data(root, "settings.json"), JSON.stringify({ enabled: false }), "utf8");
  assert.equal(askedNow(await toolCall(root, 450_000)), false);
  assert.equal(await turnEnd(root, 450_000), "");
});

test("the upper line comes from settings on disk", async () => {
  const root = home();
  writeFileSync(
    data(root, "settings.json"),
    JSON.stringify({ thresholds: { largeWindowFrom: 400_000, large: { notice: 10, closing: 15, compact: 20, now: 25 } } }),
    "utf8",
  );
  assert.equal(askedNow(await toolCall(root, 240_000)), false);
  assert.match(said(await toolCall(root, 260_000)), /past its upper line of 25%/);
});

test("a settings file from before the upper line keeps its lower line and gains an upper one", async () => {
  // Saved by v3.4: one compact line, raised to 50%. The upper line keeps the
  // default's distance above it rather than landing at 40%, below it.
  const root = home();
  writeFileSync(
    data(root, "settings.json"),
    JSON.stringify({ thresholds: { largeWindowFrom: 400_000, large: { notice: 15, closing: 22, compact: 50 }, small: { notice: 60, closing: 75, compact: 85 } } }),
    "utf8",
  );
  assert.equal(askedNow(await toolCall(root, 550_000)), false, "55% is between 50% and 60%");
  assert.notEqual(await turnEnd(root, 550_000), "", "the lower line still asks at turn end");
  assert.match(said(await toolCall(root, 610_000)), /upper line of 60%/);
});

/* -------------------------------------------------------------------------- */

test("the shared rules and the hook's copy agree on the migrated upper line", () => {
  for (const which of ["large", "small"] as const) {
    const fallback = DEFAULT_THRESHOLDS[which];
    for (const compact of [1, 10, 25, 30, 50, 85, 90, 95, 98, 99]) {
      const legacy = { notice: Math.min(compact, fallback.notice), closing: Math.min(compact, fallback.closing), compact };
      const shared = normalizeProfile(legacy, fallback);
      const hook = withUpperLine(legacy, fallback) as { now: number };
      assert.equal(hook.now, shared.now, `${which} at ${compact}%`);
      assert.ok(shared.now > compact || compact === 99, `upper stays above lower at ${compact}%`);
      assert.ok(shared.now <= 99);
    }
  }
});

test("migration is additive: a saved lower line is kept and the default upper line added", () => {
  const migrated = normalizeThresholds({
    largeWindowFrom: 400_000,
    large: { notice: 15, closing: 22, compact: 30 },
    small: { notice: 60, closing: 75, compact: 85 },
  } as never);
  assert.deepEqual(migrated, DEFAULT_THRESHOLDS);
  assert.equal(defaultNowFor(50, DEFAULT_THRESHOLDS.large), 60);
  assert.equal(defaultNowFor(20, DEFAULT_THRESHOLDS.large), 40, "never below the default");
  assert.equal(defaultNowFor(95, DEFAULT_THRESHOLDS.small), 99, "capped at 99");
});

test("a saved upper line at or below the lower one is pushed back above it", () => {
  assert.equal(normalizeProfile({ ...DEFAULT_THRESHOLDS.large, compact: 30, now: 20 }, DEFAULT_THRESHOLDS.large).now, 31);
});

test("moving the lower line carries the upper one with it unless it is given", () => {
  assert.equal(withCompactThreshold(DEFAULT_THRESHOLDS.large, 50).now, 60);
  assert.equal(withCompactThreshold(DEFAULT_THRESHOLDS.large, 20).now, 40);
  assert.equal(withCompactThreshold(DEFAULT_THRESHOLDS.large, 30, 70).now, 70);
});

test("settings validation refuses an upper line that is not above the lower one", () => {
  assert.equal(linesProblem(30, 40), null);
  assert.match(linesProblem(40, 40) ?? "", /above/);
  assert.match(linesProblem(50, 40) ?? "", /above/);
  assert.match(linesProblem(null, 40) ?? "", /whole number/);
});

/* -------------------------------------------------------------------------- */
/* What the views say: forecast, copy and the ring.                            */

import { linesSummary, outlookSentence, outlookShort } from "./shared/compact-lines.ts";
import { contextOutlook, contextRing } from "./shared/forecast.ts";

const reading = (used: number, growth: number | null = null) =>
  contextOutlook({ usedTokens: used, maxTokens: 1_000_000, compactAtPct: 30, compactNowAtPct: 40, growthTokensPerHour: growth });

test("the forecast says when each line arrives", () => {
  const below = reading(200_000, 50_000);
  assert.equal(below.untilCompactMs, 2 * 3_600_000);
  assert.equal(below.untilNowMs, 4 * 3_600_000);
  const between = reading(350_000, 50_000);
  assert.equal(between.past, true);
  assert.equal(between.untilCompactMs, null);
  assert.equal(between.untilNowMs, 3_600_000);
  const above = reading(450_000, 50_000);
  assert.equal(above.pastNow, true);
  assert.equal(above.untilNowMs, null);
});

test("amber past the end-of-turn line, red past the right-away line", () => {
  assert.equal(reading(200_000).tone, "default");
  assert.equal(reading(350_000).tone, "warning");
  assert.equal(reading(450_000).tone, "danger");
});

test("an older daemon without the upper line still reads as one line", () => {
  const old = contextOutlook({ usedTokens: 350_000, maxTokens: 1_000_000, compactAtPct: 30 });
  assert.equal(old.nowAt, null);
  assert.equal(old.pastNow, false);
  assert.equal(outlookSentence(old, { enrolled: true, compactOn: true, growthPerHour: null }).line, "Past its end-of-turn line: asked at the end of a turn whether to compact.");
  assert.equal(linesSummary(30, undefined), "asks at 30%");
});

test("the popover tells the two lines apart", () => {
  const on = { enrolled: true, compactOn: true, growthPerHour: 50_000 };
  assert.match(outlookSentence(reading(350_000, 50_000), on).line, /^Past its end-of-turn line: asked at the end of a turn.*right-away line in about 1h/);
  assert.match(outlookSentence(reading(450_000, 50_000), on).line, /^Past its right-away line\. .*mid-turn/);
  assert.match(outlookSentence(reading(200_000, 50_000), on).line, /end-of-turn line in about 2h and its right-away line in about 4h at \+50k\/h/);
  assert.match(outlookSentence(reading(450_000), { ...on, enrolled: false }).line, /not enrolled/);
  assert.match(outlookSentence(reading(450_000), { ...on, enrolled: false, compactOn: false }).line, /Smart Compact is off/);
});

test("the overview's short line names the line it is past", () => {
  assert.equal(outlookShort(reading(450_000), true), "Past its right-away line · asked mid-turn");
  assert.equal(outlookShort(reading(350_000), true), "Past its end-of-turn line · asked at the end of a turn");
  assert.equal(outlookShort(reading(350_000), false), "Past its compact line · not enrolled");
  assert.match(outlookShort(reading(200_000, 50_000), true) ?? "", /^30% in ~2h · 40% in ~4h$/);
});

test("the ring carries a tick at each line", () => {
  const ticks = (svg: string) => (svg.match(/stroke-width="1\.8"/g) ?? []).length;
  assert.equal(ticks(contextRing(0.35, 0.3, 0.28, 0.4)), 2);
  assert.equal(ticks(contextRing(0.35, 0.3)), 1, "one line when there is no upper one");
  assert.equal(ticks(contextRing(0.35, null, 0.28, 0.4)), 0, "a muted ring has no ticks");
});
