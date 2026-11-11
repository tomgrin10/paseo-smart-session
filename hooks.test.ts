import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { managedFor } from "./server/install.ts";
import { resumeInstructions } from "./shared/governor.ts";
import { DEFAULT_THRESHOLDS, profileFor } from "./shared/thresholds.ts";

const execFileAsync = promisify(execFile);

/** A transcript whose last assistant message occupies `used` tokens. */
function transcript(dir: string, used: number, model: string): string {
  const path = join(dir, "transcript.jsonl");
  const line = JSON.stringify({
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-09-05T12:00:00.000Z",
    message: {
      model,
      usage: { input_tokens: 2, cache_read_input_tokens: used - 2, cache_creation_input_tokens: 0, output_tokens: 0 },
    },
  });
  writeFileSync(path, `${line}\n`, "utf8");
  return path;
}

async function runHook(
  script: string,
  event: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<string> {
  const child = execFileAsync(process.execPath, [script], {
    env: { ...process.env, PASEO_HOME: env.PASEO_HOME ?? mkdtempSync(join(tmpdir(), "ss-hook-")), ...env },
  });
  child.child.stdin?.end(JSON.stringify(event));
  const { stdout } = await child;
  return stdout.trim();
}

async function adviceFrom(output: string): Promise<string> {
  const parsed = JSON.parse(output) as { hookSpecificOutput: { additionalContext: string } };
  return parsed.hookSpecificOutput.additionalContext;
}

test("a 1M session is measured against its real window, not a guessed 200k one", async () => {
  // The bug this exists for: assuming 200k on a 1M session reported 195% full and
  // negative headroom.
  const dir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const path = transcript(dir, 390_000, "claude-opus-5");
  const advice = await adviceFrom(
    await runHook("hooks/context-threshold.mjs", { session_id: "s1", transcript_path: path, cwd: dir }),
  );
  assert.match(advice, /1,000,000-token window/);
  assert.match(advice, /39%/);
  // Specifically a negative token count — the old bug printed "-193,009".
  // A bare /-\d/ would also match the hyphens in a UUID in the state-file path.
  assert.doesNotMatch(advice, /-\d{1,3},\d{3}/, "never negative headroom");
});

test("a big window asks for compaction far earlier, in percentage terms", async () => {
  // 300k is the point on a 1M window; 300k is not even reachable on a 200k one,
  // which is why the bands cannot be one set of percentages.
  const dir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const large = await adviceFrom(
    await runHook("hooks/context-threshold.mjs", {
      session_id: "big",
      transcript_path: transcript(dir, 310_000, "claude-opus-5"),
      cwd: dir,
    }),
  );
  assert.match(large, /worth compacting now/, "31% of a million is already the moment");

  const smallDir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const small = await adviceFrom(
    await runHook("hooks/context-threshold.mjs", {
      session_id: "small",
      transcript_path: transcript(smallDir, 130_000, "claude-haiku-4-5-20251001"),
      cwd: smallDir,
    }),
  );
  // 65% of 200k is 130k — more than a third of the window used, and still fine.
  assert.match(small, /Nothing is wrong yet/);
});

test("a small window is left alone until it is genuinely full", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const advice = await adviceFrom(
    await runHook("hooks/context-threshold.mjs", {
      session_id: "s2",
      transcript_path: transcript(dir, 175_000, "claude-haiku-4-5-20251001"),
      cwd: dir,
    }),
  );
  assert.match(advice, /87% of a 200,000-token window/);
  assert.match(advice, /recall degrades/);
});

test("each band fires once, then stays quiet", async () => {
  const home = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const dir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const path = transcript(dir, 700_000, "claude-opus-5");
  const event = { session_id: "s3", transcript_path: path, cwd: dir };

  const first = await runHook("hooks/context-threshold.mjs", event, { PASEO_HOME: home });
  assert.match(first, /70% of a 1,000,000-token window/);
  const second = await runHook("hooks/context-threshold.mjs", event, { PASEO_HOME: home });
  assert.equal(second, "", "the same band does not fire twice");
});

test("the hook and the plugin agree on where the bands are", async () => {
  // The hook is a standalone script and cannot import the shared module, so it
  // carries its own copy of the defaults. This is what stops the two drifting.
  const dir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  for (const [max, model] of [
    [1_000_000, "claude-opus-5"],
    [200_000, "claude-haiku-4-5-20251001"],
  ] as const) {
    const profile = profileFor(max, DEFAULT_THRESHOLDS);
    // Just below the first band: silent. Just above: speaks.
    const below = await runHook("hooks/context-threshold.mjs", {
      session_id: `below-${max}`,
      transcript_path: transcript(dir, Math.floor(max * (profile.notice / 100)) - 5_000, model),
      cwd: dir,
    });
    assert.equal(below, "", `silent below ${profile.notice}% of ${max}`);

    const above = await runHook("hooks/context-threshold.mjs", {
      session_id: `above-${max}`,
      transcript_path: transcript(dir, Math.ceil(max * (profile.notice / 100)) + 5_000, model),
      cwd: dir,
    });
    assert.notEqual(above, "", `speaks above ${profile.notice}% of ${max}`);
  }
});

test("settings on disk override the hook's built-in bands", async () => {
  const home = mkdtempSync(join(tmpdir(), "ss-hook-"));
  mkdirSync(join(home, "plugin-data", "smart-session"), { recursive: true });
  writeFileSync(
    join(home, "plugin-data", "smart-session", "settings.json"),
    JSON.stringify({ thresholds: { large: { notice: 5, closing: 6, compact: 7 } } }),
    "utf8",
  );
  const dir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const advice = await adviceFrom(
    await runHook(
      "hooks/context-threshold.mjs",
      { session_id: "cfg", transcript_path: transcript(dir, 100_000, "claude-opus-5"), cwd: dir },
      { PASEO_HOME: home },
    ),
  );
  assert.match(advice, /worth compacting now/, "10% of a million, under a 7% compact band");
});

test("a subagent's usage is not mistaken for the main thread's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const path = join(dir, "transcript.jsonl");
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "assistant",
        isSidechain: false,
        message: { model: "claude-opus-5", usage: { input_tokens: 1000 } },
      }),
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        message: { model: "claude-opus-5", usage: { input_tokens: 950_000 } },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  const output = await runHook("hooks/context-threshold.mjs", { session_id: "s4", transcript_path: path, cwd: dir });
  assert.equal(output, "", "the subagent's near-full window is its own, not ours");
});

test("the hook says nothing about a session it cannot read", async () => {
  const output = await runHook("hooks/context-threshold.mjs", {
    session_id: "s5",
    transcript_path: "/nonexistent/transcript.jsonl",
    cwd: "/tmp",
  });
  assert.equal(output, "");
});

test("PostCompact records and leaves a pointer, but never speaks itself", async () => {
  // Claude Code's hook-output schema has no PostCompact variant: anything this
  // returns in hookSpecificOutput is rejected wholesale, taking the pointer with
  // it. Verified in production — the compaction that fired this hook printed
  // "Hook JSON output validation failed" and injected nothing.
  const home = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const output = await runHook(
    "hooks/post-compact.mjs",
    { hook_event_name: "PostCompact", session_id: "s6", transcript_path: "/tmp/x", cwd: "/tmp", trigger: "manual", compact_summary: "..." },
    { PASEO_HOME: home, PASEO_AGENT_ID: "agent-1" },
  );
  assert.equal(output, "", "PostCompact must stay silent rather than emit output the host rejects");

  const pending = JSON.parse(readFileSync(join(home, "plugin-data", "smart-session", "pointers", "agent-1.json"), "utf8")) as {
    text: string;
  };
  assert.match(pending.text, /No durable state file exists yet/);
  assert.match(pending.text, /agent-1\.md/);

  const events = readFileSync(join(home, "plugin-data", "smart-session", "compaction-events.jsonl"), "utf8").trim();
  assert.match(events, /"event":"PostCompact"/);
});

test("SessionStart on compact delivers the pointer and consumes it", async () => {
  const home = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const statePath = join(home, "state.md");
  writeFileSync(statePath, "# Task state\n", "utf8");

  const advice = await adviceFrom(
    await runHook(
      "hooks/post-compact.mjs",
      { hook_event_name: "SessionStart", session_id: "s7", transcript_path: "/tmp/x", cwd: "/tmp", source: "compact" },
      { PASEO_HOME: home, PASEO_AGENT_ID: "agent-2", SMART_SESSION_STATE_FILE: statePath },
    ),
  );
  assert.match(advice, /Durable task state for this session is at/);
  assert.match(advice, /the file is correct/);
  // Not deleted but marked: PostCompact fires just after and must know this was
  // already said.
  const note = JSON.parse(readFileSync(join(home, "plugin-data", "smart-session", "pointers", "agent-2.json"), "utf8")) as {
    delivered?: boolean;
  };
  assert.equal(note.delivered, true);
});

test("SessionStart for any other reason says nothing", async () => {
  for (const source of ["startup", "resume", "clear", "fork"]) {
    const output = await runHook(
      "hooks/post-compact.mjs",
      { hook_event_name: "SessionStart", session_id: "s8", transcript_path: "/tmp/x", cwd: "/tmp", source },
      { PASEO_AGENT_ID: "agent-3" },
    );
    assert.equal(output, "", `SessionStart:${source} is not a compaction`);
  }
});

test("a pointer PostCompact could not deliver is delivered by the next tool call", async () => {
  const home = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const env = { PASEO_HOME: home, PASEO_AGENT_ID: "agent-4" };
  await runHook(
    "hooks/post-compact.mjs",
    { hook_event_name: "PostCompact", session_id: "s9", transcript_path: "/tmp/x", cwd: "/tmp", trigger: "auto" },
    env,
  );

  // An empty window: the threshold hook has nothing of its own to say, so this
  // proves the pointer rides the PostToolUse channel on its own.
  const dir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const path = transcript(dir, 1_000, "claude-opus-5");
  const event = { session_id: "s9", transcript_path: path, cwd: dir };
  const advice = await adviceFrom(await runHook("hooks/context-threshold.mjs", event, env));
  assert.match(advice, /No durable state file exists yet/);

  // And exactly once: a pointer repeated every tool call would be noise.
  assert.equal(await runHook("hooks/context-threshold.mjs", event, env), "");
});

test("the two compaction events deliver the pointer once between them", async () => {
  // Measured ordering on a real compaction: SessionStart:compact fires ~55ms
  // before PostCompact. Without the delivered marker the later event queues a
  // note the next tool call repeats, so the agent hears it twice.
  const home = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const statePath = join(home, "state.md");
  writeFileSync(statePath, "# Task state\n", "utf8");
  const env = { PASEO_HOME: home, PASEO_AGENT_ID: "agent-5", SMART_SESSION_STATE_FILE: statePath };
  const base = { session_id: "s10", transcript_path: "/tmp/x", cwd: "/tmp" };

  const spoken = await runHook("hooks/post-compact.mjs", { ...base, hook_event_name: "SessionStart", source: "compact" }, env);
  assert.match(await adviceFrom(spoken), /Durable task state/);

  await runHook("hooks/post-compact.mjs", { ...base, hook_event_name: "PostCompact", trigger: "manual" }, env);

  const dir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const transcriptPath = transcript(dir, 1_000, "claude-opus-5");
  const repeat = await runHook("hooks/context-threshold.mjs", { ...base, transcript_path: transcriptPath, cwd: dir }, env);
  assert.equal(repeat, "", "the pointer must not be said a second time");
});

/* -------------------------------------------------------------------------- *
 * The Stop hook: the only thing that ever asks a session to compact itself.
 * -------------------------------------------------------------------------- */

const AGENT = "agent-under-test";

/** A `$PASEO_HOME` holding one enrolled agent with task state of a given age. */
function enrolledHome(options: { stateAgeMinutes?: number | null } = {}): string {
  const home = mkdtempSync(join(tmpdir(), "ss-ask-"));
  const dir = join(home, "plugin-data", "smart-session");
  mkdirSync(join(dir, "state"), { recursive: true });
  const age = options.stateAgeMinutes;
  if (age !== null) {
    const path = join(dir, "state", `${AGENT}.md`);
    writeFileSync(path, "# Task state\n## Current step\nWiring the hook.\n", "utf8");
    if (age !== undefined && age > 0) {
      const when = new Date(Date.now() - age * 60_000);
      utimesSync(path, when, when);
    }
  }
  return home;
}

function settingsFile(home: string, settings: Record<string, unknown>): void {
  writeFileSync(
    join(home, "plugin-data", "smart-session", "settings.json"),
    JSON.stringify(settings),
    "utf8",
  );
}

/** A Stop event for `used` tokens of a 1M window, against an enrolled agent. */
async function stopHook(
  home: string,
  used: number,
  event: Record<string, unknown> = {},
  env: Record<string, string> = {},
): Promise<string> {
  const path = transcript(mkdtempSync(join(tmpdir(), "ss-tx-")), used, "claude-opus-5");
  return runHook(
    "hooks/ask-compact.mjs",
    { session_id: "s1", transcript_path: path, cwd: home, hook_event_name: "Stop", stop_hook_active: false, ...event },
    { PASEO_HOME: home, PASEO_AGENT_ID: AGENT, SMART_SESSION_CONTEXT_WINDOW: "1000000", ...env },
  );
}

test("below the compact band the Stop hook says nothing at all", async () => {
  // Everything the agent needs to hear on the way up is already said mid-turn by
  // the PostToolUse hook. Stopping a turn to repeat it would be pure noise.
  assert.equal(await stopHook(enrolledHome(), 200_000), "");
});

test("at the compact band it asks, names the tools, and leaves the choice open", async () => {
  const advice = await adviceFrom(await stopHook(enrolledHome(), 340_000));
  assert.match(advice, /340,000 tokens \(34%/);
  assert.match(advice, /request_compaction/);
  assert.match(advice, /defer_compaction/);
  // The whole point of the redesign: the plugin asks, it does not announce.
  assert.match(advice, /your call/i);
  assert.doesNotMatch(advice, /you will be compacted/i);
});

test("the ask names the tools the session actually has", async () => {
  // Opened on Paseo 0.15+: Smart Session's tools come through Paseo's MCP as smart_*.
  const native = await adviceFrom(await stopHook(enrolledHome({ stateAgeMinutes: 90 }), 340_000, {}, { SMART_SESSION_TOOLS: "native" }));
  assert.match(native, /Call smart_checkpoint/);
  assert.match(native, /call smart_request_compaction/);
  assert.match(native, /call smart_defer_compaction/);
  // Opened before the upgrade, or on the stdio fallback: the bare names it still has.
  const stdio = await adviceFrom(await stopHook(enrolledHome({ stateAgeMinutes: 90 }), 340_000, {}, { SMART_SESSION_TOOLS: "stdio" }));
  assert.match(stdio, /Call checkpoint/);
  assert.doesNotMatch(stdio, /smart_/);
});

test("after a plugin update mid-turn, a detached session is pointed at the bridge, with plain tool names", async () => {
  const home = enrolledHome({ stateAgeMinutes: 90 });
  const dir = join(home, "plugin-data", "smart-session");
  mkdirSync(join(dir, "tools"), { recursive: true });
  // This session's tools were attached by worker "old"; the update started worker "new".
  writeFileSync(join(dir, "tools-instance.json"), JSON.stringify({ instance: "new" }));
  writeFileSync(join(dir, "tools", `native-${AGENT}.json`), JSON.stringify({ instance: "old" }));
  const detached = await adviceFrom(await stopHook(home, 340_000, {}, { SMART_SESSION_TOOLS: "native" }));
  assert.match(detached, /smart_\* tools are detached/);
  assert.match(detached, /mcp\.mjs" call <tool>/);
  assert.match(detached, /Call checkpoint/);
  assert.doesNotMatch(detached, /Call smart_checkpoint/);
  // Reopened under the new worker: native names, no notice.
  writeFileSync(join(dir, "tools", `native-${AGENT}.json`), JSON.stringify({ instance: "new" }));
  writeFileSync(join(dir, "asks", `${AGENT}.json`), "{}");
  const attached = await adviceFrom(await stopHook(home, 340_000, {}, { SMART_SESSION_TOOLS: "native" }));
  assert.match(attached, /Call smart_checkpoint/); assert.doesNotMatch(attached, /detached/);
});

/** A home whose session `AGENT` was attached by worker `attachedBy` while worker `current` runs. */
function workerHome(attachedBy: string, current: string): string {
  const home = enrolledHome({ stateAgeMinutes: 1 });
  const dir = join(home, "plugin-data", "smart-session");
  mkdirSync(join(dir, "tools"), { recursive: true });
  writeFileSync(join(dir, "tools-instance.json"), JSON.stringify({ instance: current }));
  writeFileSync(join(dir, "tools", `native-${AGENT}.json`), JSON.stringify({ instance: attachedBy }));
  return home;
}

/** Runs whatever script the installer registers for `event` on `toolName`, as Claude Code would. */
async function fire(home: string, event: string, payload: Record<string, unknown> = {}): Promise<string[]> {
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const scripts = managedFor({ compact: true, publish: false })
    .filter((managed) => managed.event === event && new RegExp(`^(?:${managed.matcher || ".*"})$`).test(toolName))
    .map((managed) => managed.script);
  const out = [];
  for (const script of scripts) {
    const stdout = await runHook(`hooks/${script}`, { session_id: "s1", transcript_path: join(home, "none.jsonl"), cwd: home, hook_event_name: event, ...payload }, { PASEO_HOME: home, PASEO_AGENT_ID: AGENT, SMART_SESSION_TOOLS: "native" });
    if (stdout === "") continue;
    const parsed = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(parsed.hookSpecificOutput.hookEventName, event, "the output names the event it answers");
    out.push(parsed.hookSpecificOutput.additionalContext);
  }
  return out.filter((text) => /tools are detached/.test(text));
}

// Claude Code 2.1.322, verified end to end: a smart_* call that fails ("Tool smart_x not found", as an isError
// result or a JSON-RPC error) raises PostToolUseFailure with these fields, and never PostToolUse.
const FAILED_SMART_CALL = { tool_name: "mcp__paseo__smart_checkpoint", tool_input: {}, tool_use_id: "toolu_1", error: "MCP error -32602: Tool smart_checkpoint not found", is_interrupt: false, mcp_server: "paseo" };

test("a detached session is told once per worker instance, through a hook that actually fires", async () => {
  // The failing smart_* call itself: the event Claude Code really raises for it.
  let home = workerHome("old", "new");
  const told = await fire(home, "PostToolUseFailure", FAILED_SMART_CALL);
  assert.equal(told.length, 1, "a failed smart_* call is answered with the notice");
  assert.equal((await fire(home, "PostToolUseFailure", FAILED_SMART_CALL)).length, 0, "once per worker instance");
  assert.equal((await fire(home, "PostToolUse", { tool_name: "Bash", tool_response: {} })).length, 0);
  assert.equal((await fire(home, "UserPromptSubmit", { prompt: "next" })).length, 0);

  // A busy agent that never calls smart_* (its client may have dropped them from the list) hears it on any tool.
  home = workerHome("old", "new");
  assert.equal((await fire(home, "PostToolUse", { tool_name: "Bash", tool_response: {} })).length, 1);
  assert.equal((await fire(home, "PostToolUse", { tool_name: "Read", tool_response: {} })).length, 0);

  // Or on the next prompt.
  home = workerHome("old", "new");
  assert.equal((await fire(home, "UserPromptSubmit", { prompt: "next" })).length, 1);

  // Another update while still detached: a new instance, told again.
  writeFileSync(join(home, "plugin-data", "smart-session", "tools-instance.json"), JSON.stringify({ instance: "newer" }));
  assert.equal((await fire(home, "UserPromptSubmit", { prompt: "again" })).length, 1);

  // Reattached under the current worker: nothing.
  home = workerHome("new", "new");
  for (const [event, payload] of [["PostToolUseFailure", FAILED_SMART_CALL], ["PostToolUse", { tool_name: "Bash" }], ["UserPromptSubmit", { prompt: "x" }]] as const) {
    assert.equal((await fire(home, event, payload)).length, 0, `${event} stays quiet when attached`);
  }
});

test("the detached notice is true for a busy agent", async () => {
  const [notice] = await fire(workerHome("old", "new"), "UserPromptSubmit", { prompt: "next" });
  // Paseo reopens a session only for a prompt that arrives while the agent is idle; mid-turn messages don't.
  assert.doesNotMatch(notice, /before your next prompt/);
  assert.match(notice, /until this session reopens/);
  assert.match(notice, /prompt that arrives while you are idle/);
  assert.match(notice, /mcp\.mjs" call <tool>/, "the bridge works meanwhile");
});

test("the bridge runs one tool call as the calling agent", async () => {
  const home = mkdtempSync(join(tmpdir(), "ss-bridge-"));
  const { stdout } = await execFileAsync(process.execPath, ["mcp.mjs", "call", "checkpoint", JSON.stringify({ goal: "Synthetic goal", current_step: "Synthetic step" })], { env: { ...process.env, PASEO_HOME: home, PASEO_AGENT_ID: "agent-bridge", SMART_SESSION_STATE_FILE: "" } });
  assert.match(stdout, /Task state written to .*agent-bridge\.md/);
  await assert.rejects(execFileAsync(process.execPath, ["mcp.mjs", "call", "no_such_tool", "{}"], { env: { ...process.env, PASEO_HOME: home, PASEO_AGENT_ID: "a" } }), /Unknown tool/);
});

test("a stale state file is named, so the agent checkpoints before it asks", async () => {
  const advice = await adviceFrom(await stopHook(enrolledHome({ stateAgeMinutes: 120 }), 340_000));
  assert.match(advice, /120 minutes ago/);
  assert.match(advice, /checkpoint/);
});

test("a session enrolled by hand with no state file is told to write one first", async () => {
  // Reachable only through the pill: with nothing on disk there is nothing to infer
  // enrolment from, so someone said so explicitly. It must not be told to compact
  // before it has written down anything to compact around.
  const home = enrolledHome({ stateAgeMinutes: null });
  writeFileSync(
    join(home, "plugin-data", "smart-session", "enrolment.json"),
    JSON.stringify({ [AGENT]: true }),
    "utf8",
  );
  const advice = await adviceFrom(await stopHook(home, 340_000));
  assert.match(advice, /no task state on disk/);
  assert.match(advice, /checkpoint/);
  assert.match(advice, /is gone after the compaction/);
});

test("an agent nobody enrolled is never spoken to, however full it is", async () => {
  const home = enrolledHome({ stateAgeMinutes: null });
  assert.equal(await stopHook(home, 900_000), "");
});

test("the master switch silences it completely", async () => {
  const home = enrolledHome();
  settingsFile(home, { enabled: false });
  assert.equal(await stopHook(home, 900_000), "");
});

test("turning off automatic enrolment silences a session that only checkpointed", async () => {
  const home = enrolledHome();
  settingsFile(home, { autoEnrol: false });
  assert.equal(await stopHook(home, 900_000), "");
});

test("a turn this hook already extended is never extended again", async () => {
  // Claude Code overrides a hook that keeps a turn alive too many times in a row
  // and tells you to check exactly this flag.
  const home = enrolledHome();
  assert.equal(await stopHook(home, 900_000, { stop_hook_active: true }), "");
});

test("a session waiting on background work is not asked to compact", async () => {
  // "Stopped" and "paused until that finishes" are different states, and compacting
  // through the second discards the context the work reports into.
  const home = enrolledHome();
  const busy = await stopHook(home, 900_000, {
    background_tasks: [{ id: "t1", status: "running" }],
  });
  assert.equal(busy, "");
  // Same session, same occupancy, nothing in flight: now it asks.
  assert.notEqual(await stopHook(home, 900_000), "");
});

test("the ask is latched, and re-armed by growth rather than by asking again", async () => {
  const home = enrolledHome();
  assert.notEqual(await stopHook(home, 310_000), "", "asks the first time");
  assert.equal(await stopHook(home, 320_000), "", "one more percent is not new information");
  // Ten points of the window later it is a materially different situation.
  assert.notEqual(await stopHook(home, 420_000), "", "asks again once it has really moved");
});

test("a deferral is honoured, and expires", async () => {
  const home = enrolledHome();
  assert.notEqual(await stopHook(home, 310_000), "");

  const ledger = join(home, "plugin-data", "smart-session", "asks", `${AGENT}.json`);
  const held = JSON.parse(readFileSync(ledger, "utf8")) as Record<string, unknown>;
  writeFileSync(
    ledger,
    JSON.stringify({
      ...held,
      askedAtPct: 31,
      deferredUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
    }),
    "utf8",
  );
  assert.equal(await stopHook(home, 900_000), "", "the agent said not yet, and meant it");

  writeFileSync(
    ledger,
    JSON.stringify({ ...held, askedAtPct: 31, deferredUntil: new Date(Date.now() - 1000).toISOString() }),
    "utf8",
  );
  assert.notEqual(await stopHook(home, 900_000), "", "and the deferral runs out");
});

test("a queued compaction is not asked for twice", async () => {
  const home = enrolledHome();
  writeFileSync(
    join(home, "plugin-data", "smart-session", "compactions.json"),
    JSON.stringify({ version: 1, items: [{ agentId: AGENT, state: "pending", settledAt: null }] }),
    "utf8",
  );
  assert.equal(await stopHook(home, 900_000), "");
});

/** Writes the governor's queue and, optionally, the PostCompact hook's own records. */
function compactionHistory(home: string, items: Array<Record<string, unknown>>, events: Array<Record<string, unknown>> = []): void {
  const dir = join(home, "plugin-data", "smart-session");
  writeFileSync(join(dir, "compactions.json"), JSON.stringify({ version: 1, items }), "utf8");
  if (events.length > 0) writeFileSync(join(dir, "compaction-events.jsonl"), events.map((event) => `${JSON.stringify(event)}\n`).join(""), "utf8");
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

test("a window that refilled within minutes of a confirmed compaction is told to stop compacting", async () => {
  const home = enrolledHome();
  compactionHistory(home, [{ agentId: AGENT, state: "sent", settledAt: minutesAgo(3), confirmedAt: minutesAgo(2), postTokens: 40_000 }]);
  const advice = await adviceFrom(await stopHook(home, 340_000));
  assert.match(advice, /refilled/);
  assert.doesNotMatch(advice, /request_compaction/);
});

test("a /compact that was delivered and then cancelled is not a compaction", async () => {
  // 2026-11-11: compaction f01c50e2 was delivered, Claude Code printed "Compaction canceled.",
  // and the next Stop said the session "refilled within minutes of its last compaction" and
  // that compacting again would not help. No compaction had run: only PostCompact (or the
  // context shrinking after delivery) proves one did.
  const home = enrolledHome();
  compactionHistory(home, [{ agentId: AGENT, state: "sent", settledAt: minutesAgo(2), confirmedAt: null, preTokens: 307_740, postTokens: null }]);
  const ask = await adviceFrom(await stopHook(home, 340_000));
  assert.doesNotMatch(ask, /refilled/);
  assert.match(ask, /request_compaction/);
});

test("PostCompact's own record confirms a delivered compaction before the governor does", async () => {
  const home = enrolledHome();
  compactionHistory(
    home,
    [{ agentId: AGENT, state: "sent", settledAt: minutesAgo(2), confirmedAt: null, postTokens: null }],
    [{ at: minutesAgo(1), event: "PostCompact", sessionId: "s1", agentId: AGENT, trigger: "manual" }],
  );
  assert.match(await adviceFrom(await stopHook(home, 340_000)), /refilled/);
});

test("a PostCompact from before the delivery confirms nothing", async () => {
  const home = enrolledHome();
  compactionHistory(
    home,
    [{ agentId: AGENT, state: "sent", settledAt: minutesAgo(2), confirmedAt: null, postTokens: null }],
    [{ at: minutesAgo(5), event: "PostCompact", sessionId: "s1", agentId: AGENT, trigger: "manual" }],
  );
  assert.doesNotMatch(await adviceFrom(await stopHook(home, 340_000)), /refilled/);
});

test("the Stop hook labels its output as Stop, or Claude Code rejects all of it", async () => {
  // hookEventName is validated against a union; a name outside it fails the whole
  // output and injects nothing.
  const parsed = JSON.parse(await stopHook(enrolledHome(), 340_000)) as {
    hookSpecificOutput: { hookEventName: string };
  };
  assert.equal(parsed.hookSpecificOutput.hookEventName, "Stop");
});

test("a compaction clears the ask ledger, so the next fill is asked about again", async () => {
  const home = enrolledHome();
  await stopHook(home, 310_000);
  const ledger = join(home, "plugin-data", "smart-session", "asks", `${AGENT}.json`);
  assert.equal(JSON.parse(readFileSync(ledger, "utf8")).askCount, 1);

  await runHook(
    "hooks/post-compact.mjs",
    { session_id: "s1", hook_event_name: "PostCompact", trigger: "manual", compact_summary: "..." },
    { PASEO_HOME: home, PASEO_AGENT_ID: AGENT },
  );
  assert.notEqual(await stopHook(home, 320_000), "", "a new epoch is asked about from scratch");
});

test("the resume names the state file and tells the continuation to carry on", () => {
  // Nothing in Claude Code restarts a task after a manual /compact, so this is the
  // one message the plugin sends that the agent did not ask for.
  const text = resumeInstructions({ statePath: "/tmp/state.md" });
  assert.match(text, /\/tmp\/state\.md/);
  assert.match(text, /Current step/);
  assert.match(text, /the file is correct/);
  assert.doesNotMatch(resumeInstructions({ statePath: null }), /re-read null/i);
});
