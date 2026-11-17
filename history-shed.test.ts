/**
 * Moving a Claude transcript's history from before its last compaction into a backup (2026-11-17).
 *
 * Root cause: Paseo replays an agent's whole Claude transcript into its chat on every load, and a
 * compaction only adds a row, so a long-lived agent's chat opens slower after each one (a 436 MB
 * transcript took up to 191 s after a restart). 94 to 100% of those bytes are history from before the
 * last compaction, which Claude itself never reads again.
 *
 * Invariants:
 * - No data is lost: a full copy, verified by sha256, is written before any change, and Smart Session
 *   never deletes it.
 * - Only the intended files change: the transcript resolved from the agent's persisted session id, and
 *   the subagent transcripts the plan moves. Every other file in the transcript folder, the subagents
 *   folder and the Paseo agent record stays byte-identical.
 * - An agent's id and its post-compaction context survive a shed: same path, same session id, and the
 *   chain Claude rebuilds is the same, record for record.
 * - Off unless the person turns it on; no install, upgrade or size turns it on.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, writeSync } from "node:fs";
import { appendFile, chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildFixture } from "./history-shed-fixture.ts";
import {
  DEFAULT_SHED_THRESHOLDS,
  indexRecord,
  isDue,
  liveChain,
  MIN_MOVED_BYTES,
  normalizeShedThresholds,
  planCut,
  type IndexedRecord,
} from "./shared/history-shed.ts";
import {
  commit,
  indexTranscript,
  linuxProcesses,
  persistedSession,
  prepare,
  type ProcessView,
  readPlan,
  resolveTranscript,
  restore,
  settle,
  type ShedEnv,
  tempNames,
  sideNames,
  markNoted,
  requestRestore as requestRestoreFor,
  unnoted,
} from "./server/history-shed.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const FAR = () => Date.now() + 60_000;
const idle: ProcessView = { holders: async () => [] };

function indexText(text: string): IndexedRecord[] {
  const out: IndexedRecord[] = [];
  let offset = 0;
  const parts = text.split("\n");
  parts.forEach((line, i) => {
    const last = i === parts.length - 1;
    if (last && line === "") return;
    const length = Buffer.byteLength(line) + (last ? 0 : 1);
    out.push(indexRecord(line, offset, length));
    offset += length;
  });
  return out;
}

// ---------------------------------------------------------------------------------------------- the cut

test("no compact_boundary: nothing is cut", () => {
  const f = buildFixture({ compactions: 0, tailTurns: 3 });
  assert.deepEqual(planCut(indexText(f.text)), { ok: false, why: "no-boundary" });
});

test("a boundary on the last line (a compaction still being written): nothing is cut", () => {
  const f = buildFixture({ compactions: 2, endAtBoundary: true });
  assert.deepEqual(planCut(indexText(f.text)), { ok: false, why: "boundary-last" });
});

test("the cut keeps the preserved segment and every record of the live chain, byte for byte", () => {
  const f = buildFixture({ compactions: 4, fill: 400 });
  const records = indexText(f.text);
  const plan = planCut(records);
  assert.ok(plan.ok);
  // The newest boundary preserves its last two messages, which sit before it: the cut is earlier.
  assert.ok(plan.cut < plan.boundary, "cut moves before the boundary to keep the preserved segment");
  const before = liveChain(records);
  assert.equal(before.stop, "root");
  for (const i of before.indexes) assert.ok(i >= plan.cut, "no chain record is cut");
  // The new file: kept metadata records, then the tail from the cut, exactly.
  const buf = Buffer.from(f.text);
  const result = Buffer.concat(plan.ranges.map(([o, l]) => buf.subarray(o, o + l)));
  assert.equal(result.length, plan.newSize);
  assert.ok(result.toString().endsWith(buf.subarray(records[plan.cut]!.offset).toString()), "tail is the original's from the cut");
  const after = liveChain(indexText(result.toString()));
  assert.deepEqual(after.uuids, before.uuids, "same chain");
  // Metadata stays; old conversation and request logs leave.
  const kept = indexText(result.toString()).slice(0, plan.keptBefore.length).map((r) => r.type);
  for (const t of kept) assert.ok(!["user", "assistant", "attachment", "system", "progress", "api-request"].includes(t!), `kept ${t}`);
  assert.ok(kept.includes("custom-title") && kept.includes("session-owner") && kept.includes("file-history-snapshot") && kept.includes("attribution-snapshot"));
  assert.equal(plan.compactions, 4);
});

test("without a preserved segment the cut is at the boundary", () => {
  const f = buildFixture({ compactions: 2, preserve: false });
  const plan = planCut(indexText(f.text));
  assert.ok(plan.ok);
  assert.equal(plan.cut, plan.boundary);
});

test("a chain with a missing parent is never cut", () => {
  const f = buildFixture({ compactions: 2 });
  const lines = f.text.trimEnd().split("\n");
  const leaf = JSON.parse(lines.findLast((l) => /"type":"assistant"/.test(l) && !/isSidechain":true/.test(l))!);
  lines[lines.findIndex((l) => l.includes(leaf.uuid))] = JSON.stringify({ ...leaf, parentUuid: randomUUID() });
  assert.deepEqual(planCut(indexText(`${lines.join("\n")}\n`)), { ok: false, why: "chain-broken" });
});

test("thresholds: size or compactions make it due; tiny moves never are", () => {
  const plan = planCut(indexText(buildFixture({ compactions: 2, fill: 2000 }).text));
  assert.ok(plan.ok);
  const MB = 1024 * 1024;
  const big = { ...plan, movedBytes: MIN_MOVED_BYTES };
  assert.deepEqual(isDue(49 * MB, { ...big, compactions: 9 }, DEFAULT_SHED_THRESHOLDS), { due: false, why: "too-small" });
  assert.deepEqual(isDue(50 * MB, { ...big, compactions: 1 }, DEFAULT_SHED_THRESHOLDS), { due: true });
  assert.deepEqual(isDue(1 * MB, { ...big, compactions: 10 }, DEFAULT_SHED_THRESHOLDS), { due: true });
  assert.deepEqual(isDue(500 * MB, { ...big, movedBytes: MIN_MOVED_BYTES - 1 }, DEFAULT_SHED_THRESHOLDS), { due: false, why: "too-little-to-move" });
  assert.deepEqual(normalizeShedThresholds({ minMb: -5, minCompactions: 1e9 }), { minMb: 1, minCompactions: 10_000 });
  assert.deepEqual(normalizeShedThresholds(undefined), DEFAULT_SHED_THRESHOLDS);
});

test("indexing: a last line without a newline, blank and broken lines, and lines longer than a read chunk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shed-index-"));
  const long = JSON.stringify({ type: "user", uuid: randomUUID(), message: { content: "x".repeat(3 * 1024 * 1024) } });
  const text = `{"type":"mode"}\n\nnot json\n${long}\n{"type":"custom-title"}`;
  await writeFile(join(dir, "t.jsonl"), text);
  const { records, stamp } = await indexTranscript(join(dir, "t.jsonl"));
  assert.equal(stamp.sha256, sha(text));
  assert.deepEqual(records.map((r) => r.type), ["mode", null, null, "user", "custom-title"]);
  assert.equal(records.reduce((s, r) => s + r.length, 0), Buffer.byteLength(text));
  await rm(dir, { recursive: true });
});

// ---------------------------------------------------------------------------------------------- a world on disk

interface World {
  root: string;
  configDir: string;
  projectDir: string;
  transcript: string;
  sessionDir: string;
  paseoHome: string;
  agentId: string;
  sessionId: string;
  env: ShedEnv;
  fixture: ReturnType<typeof buildFixture>;
}

async function world(options: Parameters<typeof buildFixture>[0] = {}, processes: ProcessView = idle): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "shed-world-"));
  const configDir = join(root, "claude");
  const projectDir = join(configDir, "projects", "-work-example");
  const fixture = buildFixture({ compactions: 3, fill: 3000, ...options });
  const sessionId = fixture.sessionId;
  await mkdir(projectDir, { recursive: true });
  const transcript = join(projectDir, `${sessionId}.jsonl`);
  await writeFile(transcript, fixture.text);
  const sessionDir = join(projectDir, sessionId);
  await mkdir(join(sessionDir, "subagents"), { recursive: true });
  for (const [name, { lines, meta }] of Object.entries(fixture.subagents)) {
    await writeFile(join(sessionDir, "subagents", name), `${lines.join("\n")}\n`);
    await writeFile(join(sessionDir, "subagents", name.replace(/\.jsonl$/, ".meta.json")), meta);
  }
  // Neighbours that must never change: another session, its folder, a todo, tool results.
  await writeFile(join(projectDir, `${randomUUID()}.jsonl`), '{"type":"user"}\n');
  await mkdir(join(sessionDir, "tool-results"), { recursive: true });
  await writeFile(join(sessionDir, "tool-results", "r1.txt"), "result");
  const paseoHome = join(root, "paseo");
  const agentId = randomUUID();
  await mkdir(join(paseoHome, "agents", "work-example"), { recursive: true });
  await writeFile(join(paseoHome, "agents", "work-example", `${agentId}.json`), JSON.stringify({ id: agentId, provider: "claude", persistence: { provider: "claude", sessionId } }));
  const env: ShedEnv = { dataDir: join(paseoHome, "plugin-data", "smart-session"), configDirs: async () => [configDir], processes };
  return { root, configDir, projectDir, transcript, sessionDir, paseoHome, agentId, sessionId, env, fixture };
}

/** sha256 of every file under the transcript's project folder and the agent record. */
async function fingerprint(w: World): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else out.set(p, sha(await readFile(p)));
    }
  };
  await walk(w.projectDir);
  await walk(join(w.paseoHome, "agents"));
  return out;
}

function diff(before: Map<string, string>, after: Map<string, string>) {
  const changed = [...before].filter(([p, h]) => after.has(p) && after.get(p) !== h).map(([p]) => p);
  const missing = [...before.keys()].filter((p) => !after.has(p));
  const added = [...after.keys()].filter((p) => !before.has(p));
  return { changed, missing, added };
}

const due = () => true as const;

async function prepared(w: World) {
  const out = await prepare(w.env, w.agentId, w.sessionId, due);
  assert.ok(out.ok, `prepare: ${out.ok ? "" : out.why}`);
  return out.plan;
}

// ---------------------------------------------------------------------------------------------- prepare + commit

test("prepare only adds files; commit changes the transcript and moves only old subagents", async () => {
  const w = await world();
  const original = await readFile(w.transcript);
  const before = await fingerprint(w);
  const plan = await prepared(w);
  const afterPrepare = diff(before, await fingerprint(w));
  assert.deepEqual(afterPrepare.changed, [], "prepare changes nothing");
  assert.deepEqual(afterPrepare.missing, []);
  assert.ok(afterPrepare.added.every((p) => p.startsWith(plan.backupDir)), "prepare adds only the backup");
  assert.equal(sha(await readFile(join(plan.backupDir, "transcript.jsonl"))), sha(original), "backup is the full original");

  const out = await commit(w.env, plan, FAR());
  assert.ok(out.ok, out.ok ? "" : out.why);
  const after = diff(before, await fingerprint(w));
  assert.deepEqual(after.changed, [w.transcript], "only the transcript changed");
  const moved = plan.subagents.filter((s) => s.move).flatMap((s) => [s.name, s.meta?.name]).filter(Boolean).map((n) => join(w.sessionDir, "subagents", n!));
  assert.ok(moved.length >= 2, "old subagents planned to move");
  assert.deepEqual(after.missing.sort(), moved.sort(), "only the planned subagents left subagents/");
  for (const p of moved) assert.equal(sha(await readFile(join(plan.backupDir, "subagents", p.split("/").pop()!))), before.get(p), "each moved subagent is in the backup");
  const kept = plan.subagents.filter((s) => !s.move);
  assert.ok(kept.length >= 1 && kept.every((s) => existsSync(join(w.sessionDir, "subagents", s.name))), "the newest subagent stays");
  // The new transcript is exactly the planned cut of the original.
  const now = await readFile(w.transcript);
  const expected = Buffer.concat(plan.cut.ranges.map(([o, l]) => original.subarray(o, o + l)));
  assert.ok(now.equals(expected));
  assert.deepEqual(liveChain(indexText(now.toString())).uuids, liveChain(indexText(original.toString())).uuids);
  assert.ok(now.length < original.length / 2);
  assert.equal((await readPlan(w.env, w.agentId))?.state, "committed");
  // Same session id and path; the agent record is untouched.
  assert.equal((await persistedSession(w.paseoHome, w.agentId))?.sessionId, w.sessionId);
  await rm(w.root, { recursive: true });
});

test("commit refuses, changing nothing, when anything moved since prepare", async (t) => {
  const cases: [string, (w: World) => Promise<unknown>, string, ProcessView?][] = [
    ["a line appended", (w) => appendFile(w.transcript, '{"type":"user"}\n'), "changed"],
    ["a subagent transcript grew", async (w) => { const n = readdirSync(join(w.sessionDir, "subagents")).find((x) => x.endsWith(".jsonl"))!; await appendFile(join(w.sessionDir, "subagents", n), "{}\n"); }, "subagents-changed"],
    ["a new subagent transcript", (w) => writeFile(join(w.sessionDir, "subagents", "agent-new.jsonl"), "{}\n"), "subagents-changed"],
    ["the backup was altered", async (w) => { const p = (await readPlan(w.env, w.agentId))!; await appendFile(join(p.backupDir, "transcript.jsonl"), "x"); }, "backup-mismatch"],
    ["a second copy in another config folder", async (w) => { const other = join(w.root, "claude2", "projects", "-x"); await mkdir(other, { recursive: true }); await writeFile(join(other, `${w.sessionId}.jsonl`), "{}\n"); (w.env as { configDirs: () => Promise<string[]> }).configDirs = async () => [w.configDir, join(w.root, "claude2")]; }, "ambiguous-transcript"],
    ["a process holds it", async () => undefined, "busy", { holders: async () => ["123:fd"] }],
    ["processes can't be read", async () => undefined, "no-proc", { holders: async () => null }],
  ];
  for (const [name, mutate, why, processes] of cases) {
    await t.test(name, async () => {
      const w = await world();
      const plan = await prepared(w);
      if (processes) {
        // A holder at prepare time is refused there too.
        const held = await prepare({ ...w.env, processes }, w.agentId, w.sessionId, due);
        assert.equal(!held.ok && held.why, why);
        (w.env as { processes: ProcessView }).processes = processes;
      }
      await mutate(w);
      const before = await fingerprint(w);
      const out = await commit(w.env, plan, FAR());
      assert.equal(out.ok, false);
      assert.equal(!out.ok && out.why, why);
      assert.deepEqual(diff(before, await fingerprint(w)), { changed: [], missing: [], added: [] });
      await rm(w.root, { recursive: true });
    });
  }
  await t.test("a deadline already past", async () => {
    const w = await world();
    const plan = await prepared(w);
    const before = await fingerprint(w);
    const out = await commit(w.env, plan, Date.now() - 1);
    assert.equal(!out.ok && out.why, "deadline");
    assert.deepEqual(diff(before, await fingerprint(w)), { changed: [], missing: [], added: [] });
    await rm(w.root, { recursive: true });
  });
});

test("an fd opened before the shed is seen, and the shed waits (Linux /proc)", { skip: process.platform !== "linux" }, async () => {
  const w = await world({}, linuxProcesses);
  const plan = await prepared(w);
  // Another process opens the transcript for append and keeps it open.
  const child = spawn(process.execPath, ["-e", `const fs=require("fs");const fd=fs.openSync(${JSON.stringify(w.transcript)},"a");process.stdout.write("open\\n");setTimeout(()=>{fs.writeSync(fd,'{"type":"user","late":true}\\n');process.exit(0)},6000)`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
  const out = await commit(w.env, plan, FAR());
  assert.equal(!out.ok && out.why, "busy");
  await new Promise((resolve) => child.once("exit", resolve));
  // The late line landed in the transcript, which is intact.
  assert.ok((await readFile(w.transcript, "utf8")).endsWith('{"type":"user","late":true}\n'));
  // And with the appended line the old plan is stale: the next prepare starts over.
  assert.equal(await settle(w.env, plan), "discarded");
  await rm(w.root, { recursive: true });
});

test("a process naming the session on its command line blocks the shed (Linux /proc)", { skip: process.platform !== "linux" }, async () => {
  const w = await world({}, linuxProcesses);
  const plan = await prepared(w);
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)", "--", "--resume", w.sessionId], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 200));
  const out = await commit(w.env, plan, FAR());
  child.kill();
  assert.equal(!out.ok && out.why, "busy");
  await rm(w.root, { recursive: true });
});

test("two sheds racing: one commits, the other refuses, nothing is half-done", async () => {
  const w = await world();
  const plan = await prepared(w);
  const copy = JSON.parse(JSON.stringify(plan));
  const [a, b] = await Promise.all([commit(w.env, plan, FAR()), commit(w.env, copy, FAR())]);
  assert.equal([a, b].filter((o) => o.ok).length, 1);
  const original = await readFile(join(plan.backupDir, "transcript.jsonl"));
  const expected = Buffer.concat(plan.cut.ranges.map(([o, l]) => original.subarray(o, o + l)));
  assert.ok((await readFile(w.transcript)).equals(expected));
  for (const temp of tempNames(plan)) assert.equal(existsSync(temp), false);
  await rm(w.root, { recursive: true });
});

// ---------------------------------------------------------------------------------------------- crashes

const STEPS = ["commit:verify-original", "commit:verify-backup", "commit:write-temp", "commit:holders", "commit:link", "commit:rename", "commit:after-rename", "commit:verify-new", "commit:finish-save"];

test("a crash at any step leaves the transcript either whole or fully shed, and the next try finishes", async (t) => {
  for (const step of [...STEPS, "commit:subagent"]) {
    await t.test(step, async () => {
      const w = await world();
      const original = await readFile(w.transcript);
      const plan = await prepared(w);
      const expected = Buffer.concat(plan.cut.ranges.map(([o, l]) => original.subarray(o, o + l)));
      const crashing: ShedEnv = { ...w.env, step: (name) => { if (name.startsWith(step)) throw new Error(`crash at ${name}`); } };
      const out = await commit(crashing, plan, FAR());
      assert.equal(out.ok, false);
      const now = await readFile(w.transcript);
      assert.ok(now.equals(original) || now.equals(expected), "whole or fully shed, never half");
      assert.equal(sha(await readFile(join(plan.backupDir, "transcript.jsonl"))), sha(original), "backup intact");
      // Recovery: settle, then commit if it is still to do.
      const fresh = (await readPlan(w.env, w.agentId))!;
      await settle(w.env, fresh);
      const again = (await readPlan(w.env, w.agentId))!;
      if (again.state === "prepared") assert.ok((await commit(w.env, again, FAR())).ok);
      assert.ok((await readFile(w.transcript)).equals(expected), "finished after recovery");
      const final = (await readPlan(w.env, w.agentId))!;
      assert.equal(final.state, "committed");
      for (const s of final.subagents.filter((s) => s.move)) assert.equal(existsSync(join(w.sessionDir, "subagents", s.name)), false);
      for (const temp of [...tempNames(plan), ...sideNames(plan)]) assert.equal(existsSync(temp), false, "no temp file left");
      await rm(w.root, { recursive: true });
    });
  }
});

test("a crash during prepare changes nothing and the plan is not used", async () => {
  const w = await world();
  const before = await fingerprint(w);
  const crashing: ShedEnv = { ...w.env, step: (name) => { if (name === "prepare:backup") throw new Error("crash"); } };
  await assert.rejects(prepare(crashing, w.agentId, w.sessionId, due));
  const after = diff(before, await fingerprint(w));
  assert.deepEqual([after.changed, after.missing], [[], []]);
  assert.equal(await readPlan(w.env, w.agentId), null);
  await rm(w.root, { recursive: true });
});

// ---------------------------------------------------------------------------------------------- restore

test("restore puts the full original back, plus every line written since, and keeps the shed file too", async () => {
  const w = await world();
  const original = await readFile(w.transcript);
  const before = await fingerprint(w);
  const plan = await prepared(w);
  assert.ok((await commit(w.env, plan, FAR())).ok);
  const appended = '{"type":"user","message":{"content":"after the shed"}}\n';
  await appendFile(w.transcript, appended);
  const shedNow = await readFile(w.transcript);
  const committed = (await readPlan(w.env, w.agentId))!;
  const out = await restore(w.env, committed, FAR());
  assert.ok(out.ok, out.ok ? "" : out.why);
  assert.ok((await readFile(w.transcript)).equals(Buffer.concat([original, Buffer.from(appended)])));
  // Every subagent is back where it was.
  for (const [p, h] of before) if (p.includes("/subagents/")) assert.equal(sha(await readFile(p)), h, p);
  // The transcript as it was before the restore is kept.
  const keptCurrent = readdirSync(plan.backupDir).find((n) => n.startsWith("before-restore-"))!;
  assert.ok((await readFile(join(plan.backupDir, keptCurrent))).equals(shedNow));
  assert.equal((await readPlan(w.env, w.agentId))?.state, "restored");
  await rm(w.root, { recursive: true });
});

test("restore refuses when the transcript is not the shed file it expects", async () => {
  const w = await world();
  const plan = await prepared(w);
  assert.ok((await commit(w.env, plan, FAR())).ok);
  await writeFile(w.transcript, "something else entirely\n");
  const before = await fingerprint(w);
  const out = await restore(w.env, (await readPlan(w.env, w.agentId))!, FAR());
  assert.equal(!out.ok && out.why, "restore-mismatch");
  assert.deepEqual(diff(before, await fingerprint(w)), { changed: [], missing: [], added: [] });
  await rm(w.root, { recursive: true });
});

test("a crash during restore leaves either the shed file or the restored one", async (t) => {
  for (const step of ["restore:backup-current", "restore:write-temp", "restore:rename"]) {
    await t.test(step, async () => {
      const w = await world();
      const original = await readFile(w.transcript);
      const plan = await prepared(w);
      assert.ok((await commit(w.env, plan, FAR())).ok);
      const shed = await readFile(w.transcript);
      const crashing: ShedEnv = { ...w.env, step: (name) => { if (name === step) throw new Error("crash"); } };
      assert.equal((await restore(crashing, (await readPlan(w.env, w.agentId))!, FAR())).ok, false);
      const now = await readFile(w.transcript);
      assert.ok(now.equals(shed) || now.equals(original));
      assert.ok((await restore(w.env, (await readPlan(w.env, w.agentId))!, FAR())).ok, "a second restore succeeds");
      assert.ok((await readFile(w.transcript)).equals(original));
      await rm(w.root, { recursive: true });
    });
  }
});

// ---------------------------------------------------------------------------------------------- again

test("after more compactions the shed runs again; restoring the newest undoes only that one", async () => {
  const w = await world({ compactions: 3 });
  const first = await prepared(w);
  assert.ok((await commit(w.env, first, FAR())).ok);
  const afterFirst = await readFile(w.transcript);
  // More work and two more compactions, written as Claude would append them.
  const more = buildFixture({ sessionId: w.sessionId, compactions: 2, fill: 3000, start: Date.parse("2026-11-01T00:00:00Z") });
  const lines = more.text.trimEnd().split("\n");
  // Hang the new history off the current leaf.
  const leaf = liveChain(indexText(afterFirst.toString())).uuids[0]!;
  const firstChained = lines.findIndex((l) => l.includes('"parentUuid":null') && !l.includes("compact_boundary") && !l.includes("isSidechain\":true"));
  lines[firstChained] = lines[firstChained]!.replace('"parentUuid":null', `"parentUuid":"${leaf}"`);
  await appendFile(w.transcript, `${lines.join("\n")}\n`);
  const grown = await readFile(w.transcript);
  assert.equal(await settle(w.env, (await readPlan(w.env, w.agentId))!), "none");
  const second = await prepared(w);
  assert.notEqual(second.backupDir, first.backupDir);
  assert.ok((await commit(w.env, second, FAR())).ok);
  assert.ok((await readFile(w.transcript)).length < grown.length);
  assert.ok((await restore(w.env, (await readPlan(w.env, w.agentId))!, FAR())).ok);
  assert.ok((await readFile(w.transcript)).equals(grown), "back to the state before the second shed");
  assert.ok(existsSync(join(first.backupDir, "transcript.jsonl")), "the first backup is still there");
  await rm(w.root, { recursive: true });
});

// ---------------------------------------------------------------------------------------------- locating

test("the transcript is found by its session id across config folders, once, by real path", async () => {
  const w = await world();
  // A ZeroSub-style account home whose projects/ is a link to the main one: the same file, not two.
  const home = join(w.root, "account");
  await mkdir(home, { recursive: true });
  await import("node:fs/promises").then((fs) => fs.symlink(join(w.configDir, "projects"), join(home, "projects")));
  const found = await resolveTranscript(w.sessionId, [w.configDir, home]);
  assert.deepEqual(found, { path: w.transcript });
  assert.deepEqual(await resolveTranscript(randomUUID(), [w.configDir]), { why: "no-transcript" });
  await rm(w.root, { recursive: true });
});

test("the session id comes from the agent's own Paseo record, and only one", async () => {
  const w = await world();
  assert.deepEqual(await persistedSession(w.paseoHome, w.agentId), { provider: "claude", sessionId: w.sessionId, title: null });
  await mkdir(join(w.paseoHome, "agents", "other"), { recursive: true });
  await writeFile(join(w.paseoHome, "agents", "other", `${w.agentId}.json`), "{}");
  assert.equal(await persistedSession(w.paseoHome, w.agentId), null, "two records: refuse");
  assert.equal(await persistedSession(w.paseoHome, "../etc"), null);
  await rm(w.root, { recursive: true });
});

test("the planner reads no content it keeps: an indexed record carries only ids, types and offsets", () => {
  const r = indexRecord(JSON.stringify({ type: "user", uuid: "u", parentUuid: "p", message: { content: "secret" } }), 0, 10);
  assert.ok(!JSON.stringify(r).includes("secret"));
});


// ---------------------------------------------------------------------------------------------- off by default

/** readSettings in a fresh process with this PASEO_HOME, optionally after a patch. */
async function settingsIn(home: string, patch?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const script = `const s = await import(${JSON.stringify(new URL("./server/settings.ts", import.meta.url).href)});
${patch ? `await s.writeSettings(${JSON.stringify(patch)});` : ""}
process.stdout.write(JSON.stringify(await s.readSettings()));`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env: { ...process.env, PASEO_HOME: home }, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  await new Promise((r) => child.once("exit", r));
  return JSON.parse(out);
}

test("a fresh install leaves moving history off, and so does an upgrade from 3.7.0", async () => {
  const fresh = await mkdtemp(join(tmpdir(), "shed-fresh-"));
  assert.equal((await settingsIn(fresh)).shedHistory, false);
  const upgraded = await mkdtemp(join(tmpdir(), "shed-upgrade-"));
  await mkdir(join(upgraded, "plugin-data", "smart-session"), { recursive: true });
  // A settings file as 3.7.0 wrote it, with every switch it had turned on.
  await writeFile(join(upgraded, "plugin-data", "smart-session", "settings.json"), JSON.stringify({ enabled: true, thresholds: {}, freshStateMinutes: 30, showPill: true, autoEnrol: true, installHooks: true, publishAsMain: true, publishAsAccount: null, publishAsExtraUsage: true }));
  assert.equal((await settingsIn(upgraded)).shedHistory, false);
  // Changing any other setting never turns it on.
  assert.equal((await settingsIn(upgraded, { showPill: false, enabled: true })).shedHistory, false);
  // Only turning it on does.
  assert.equal((await settingsIn(upgraded, { shedHistory: true })).shedHistory, true);
  assert.deepEqual((await settingsIn(upgraded)).shedThresholds, { minMb: 50, minCompactions: 10 });
  await rm(fresh, { recursive: true });
  await rm(upgraded, { recursive: true });
});

test("only an open with no live runtime may commit: never a create or a reload", async () => {
  const { openIsSafe } = await import("./server/history-shed.ts");
  assert.equal(openIsSafe({ reason: "resume", purpose: "interactive" }), true);
  assert.equal(openIsSafe({ reason: "resume", purpose: "history" }), true);
  assert.equal(openIsSafe({ reason: "import", purpose: "interactive" }), true);
  assert.equal(openIsSafe({ reason: "refresh", purpose: "interactive" }), false, "a reload opens before the old runtime closes");
  assert.equal(openIsSafe({ reason: "create", purpose: "interactive" }), false);
});

test("restore walks back through every shed, newest first, to the very first original", async () => {
  const { requestRestore, restoreRequested, agentPlans } = await import("./server/history-shed.ts");
  const w = await world({ compactions: 3 });
  const first = await readFile(w.transcript);
  assert.ok((await commit(w.env, await prepared(w), FAR())).ok);
  const leaf = liveChain(indexText((await readFile(w.transcript)).toString())).uuids[0]!;
  const more = buildFixture({ sessionId: w.sessionId, compactions: 2, fill: 3000, start: Date.parse("2026-11-01T00:00:00Z") }).text.trimEnd().split("\n");
  const at = more.findIndex((l) => l.includes('"parentUuid":null') && !l.includes("compact_boundary") && !l.includes('isSidechain":true'));
  more[at] = more[at]!.replace('"parentUuid":null', `"parentUuid":"${leaf}"`);
  await appendFile(w.transcript, `${more.join("\n")}\n`);
  const appendedBetween = Buffer.from(`${more.join("\n")}\n`);
  assert.ok((await commit(w.env, await prepared(w), FAR())).ok);
  const tail = '{"type":"user","message":{"content":"latest"}}\n';
  await appendFile(w.transcript, tail);
  assert.equal((await requestRestore(w.env, w.agentId))?.length, 2);
  const results = await restoreRequested(w.env, w.agentId, FAR());
  assert.deepEqual(results.map((r) => r.ok), [true, true]);
  assert.ok((await readFile(w.transcript)).equals(Buffer.concat([first, appendedBetween, Buffer.from(tail)])), "the very first original, then everything since");
  assert.ok((await agentPlans(w.env, w.agentId)).every((p) => p.state === "restored"));
  await rm(w.root, { recursive: true });
});

test("a commit whose process died before its chat row gets the row at the next open, once", async () => {
  const w = await world();
  assert.equal(await unnoted(w.env, w.agentId), null, "nothing committed yet");
  const plan = await prepared(w);
  assert.equal(await unnoted(w.env, w.agentId), null, "prepared is not committed");
  assert.ok((await commit(w.env, plan, FAR())).ok);
  const missing = await unnoted(w.env, w.agentId);
  assert.equal(missing?.id, plan.id, "committed without a row");
  await markNoted(w.env, missing!);
  assert.ok((await readPlan(w.env, w.agentId))?.notedAt, "the row is recorded");
  assert.equal(await unnoted(w.env, w.agentId), null, "never a second row");
  // A shed waiting for its restore gets no row.
  const w2 = await world();
  const p2 = await prepared(w2);
  assert.ok((await commit(w2.env, p2, FAR())).ok);
  await requestRestoreFor(w2.env, w2.agentId);
  assert.equal(await unnoted(w2.env, w2.agentId), null);
  await rm(w.root, { recursive: true });
  await rm(w2.root, { recursive: true });
});

// ---------------------------------------------------------------------------------------------- review of 3.8.0-beta.1

const LINE = '{"type":"user","message":{"content":"written during the shed"}}\n';
const sideFiles = (plan: { path: string; id: string }) => [...tempNames(plan as never), ...sideNames(plan as never)];

const COMMIT_WINDOW = ["commit:verify-original", "commit:verify-backup", "commit:write-temp", "commit:holders", "commit:link", "commit:rename", "commit:after-rename", "commit:drop-original"];

test("a line written at any point from the first read to the rename is in the result, or the commit is refused", async (t) => {
  // A writer the holder scan can't see (a terminal `claude -c` opens the file only while it writes, and its
  // command line doesn't name the session) has the file open already and writes at each step in turn.
  for (const step of COMMIT_WINDOW) {
    await t.test(step, async () => {
      const w = await world();
      const original = await readFile(w.transcript);
      const plan = await prepared(w);
      const fd = openSync(w.transcript, "a");
      const env: ShedEnv = { ...w.env, step: (name) => { if (name === step) writeSync(fd, LINE); } };
      const out = await commit(env, plan, FAR());
      closeSync(fd);
      const now = await readFile(w.transcript);
      if (out.ok) assert.ok(now.includes(LINE), "a commit that went through kept the line");
      else assert.ok(now.equals(Buffer.concat([original, Buffer.from(LINE)])), `refused (${out.why}): the original plus the line, byte for byte`);
      assert.equal(sha(await readFile(join(plan.backupDir, "transcript.jsonl"))), sha(original), "backup intact");
      for (const f of sideFiles(plan)) assert.equal(existsSync(f), false, `no ${f} left`);
      await rm(w.root, { recursive: true });
    });
  }
});

test("a process still holding the old file after the rename puts the original back", async () => {
  // Seen only by inode: after the rename the old file has no name a path scan would match.
  let originalIno = -1;
  const w = await world({}, { holders: async (_path, _sid, inode) => (inode?.ino === originalIno ? ["4242:fd"] : []) });
  originalIno = (await stat(w.transcript)).ino;
  const original = await readFile(w.transcript);
  const plan = await prepared(w);
  const out = await commit(w.env, plan, FAR());
  assert.equal(!out.ok && out.why, "late-write");
  assert.ok((await readFile(w.transcript)).equals(original));
  assert.equal((await readPlan(w.env, w.agentId))?.state ?? "discarded", "discarded");
  for (const f of sideFiles(plan)) assert.equal(existsSync(f), false, `no ${f} left`);
  await rm(w.root, { recursive: true });
});

test("a commit stops before the rename once its open is canceled", async () => {
  const w = await world();
  const before = await fingerprint(w);
  const plan = await prepared(w);
  const controller = new AbortController();
  const env: ShedEnv = { ...w.env, step: (name) => { if (name === "commit:write-temp") controller.abort(); } };
  const out = await commit(env, plan, FAR(), controller.signal);
  assert.equal(!out.ok && out.why, "aborted");
  const after = diff(before, await fingerprint(w));
  assert.deepEqual([after.changed, after.missing, after.added], [[], [], []]);
  assert.equal((await readPlan(w.env, w.agentId))?.state, "prepared");
  await rm(w.root, { recursive: true });
});

test("a crash after the rename, then new lines: the next open finishes the shed, and restore still works", async (t) => {
  for (const step of ["commit:after-rename", "commit:verify-new", "commit:finish-save"]) {
    await t.test(step, async () => {
      const { requestRestore, restoreRequested } = await import("./server/history-shed.ts");
      const w = await world();
      const original = await readFile(w.transcript);
      const plan = await prepared(w);
      const crashing: ShedEnv = { ...w.env, step: (name) => { if (name === step) throw new Error(`crash at ${name}`); } };
      assert.equal((await commit(crashing, plan, FAR())).ok, false);
      await appendFile(w.transcript, LINE);
      await settle(w.env, (await readPlan(w.env, w.agentId))!);
      assert.equal((await readPlan(w.env, w.agentId))?.state, "committed", "finished, though the file grew since");
      assert.equal((await requestRestore(w.env, w.agentId))?.length, 1);
      const results = await restoreRequested(w.env, w.agentId, FAR());
      assert.deepEqual(results.map((r) => r.ok), [true]);
      assert.ok((await readFile(w.transcript)).equals(Buffer.concat([original, Buffer.from(LINE)])));
      for (const f of sideFiles(plan)) assert.equal(existsSync(f), false, `no ${f} left`);
      await rm(w.root, { recursive: true });
    });
  }
});

test("Smart Session never deletes a backup: a plan whose transcript moved on keeps its files", async () => {
  const w = await world();
  const plan = await prepared(w);
  const files = new Map<string, string>();
  const walk = async (dir: string) => { for (const e of await readdir(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) await walk(p); else files.set(p, sha(await readFile(p))); } };
  await walk(plan.backupDir);
  await appendFile(w.transcript, LINE);
  assert.equal(await settle(w.env, plan), "discarded");
  assert.equal((await readPlan(w.env, w.agentId)), null, "no plan in use");
  for (const [p, h] of files) assert.equal(sha(await readFile(p)), h, `${p} kept`);
  await rm(w.root, { recursive: true });
});

test("the module removes nothing but its own temp names, its lock, and subagent files it verified in the backup", async () => {
  const source = await readFile(new URL("./server/history-shed.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\brm(dir)?(Sync)?\(|\brm\b.*from "node:fs/, "no rm or rmdir anywhere");
  const removals = source.split("\n").filter((l) => /\bunlink(Sync)?\(/.test(l));
  assert.ok(removals.length > 0);
  for (const line of removals) {
    assert.doesNotMatch(line, /backup/i, `never a backup path: ${line.trim()}`);
    assert.match(line, /\bunlink(Sync)?\((temp|lockFile|second|movedSource|movedMeta)\b/, `only an allowed name: ${line.trim()}`);
  }
});

test("backups live in Smart Session's data folder, keyed by the transcript's folder and session id", async () => {
  const w = await world();
  const before = await fingerprint(w);
  const plan = await prepared(w);
  assert.ok(plan.backupDir.startsWith(join(w.env.dataDir, "history-shed", "backups") + "/"), plan.backupDir);
  assert.ok(plan.backupDir.includes(`/${w.sessionId}/`));
  const after = diff(before, await fingerprint(w));
  assert.deepEqual([after.changed, after.missing, after.added], [[], [], []], "nothing added beside the transcript");
  await rm(w.root, { recursive: true });
});

test("a backup in the 3.8.0-beta.1 place is copied over, verified, and the old copy is left as it was", async () => {
  const { migrateBackups, savePlanForTest } = await import("./server/history-shed.ts");
  const w = await world();
  const original = await readFile(w.transcript);
  const plan = await prepared(w);
  assert.ok((await commit(w.env, plan, FAR())).ok);
  // Where beta.1 kept it: beside the transcript.
  const old = join(w.sessionDir, "shed", plan.id);
  await mkdir(join(old, "subagents"), { recursive: true });
  const copied = new Map<string, string>();
  const copyDir = async (from: string, to: string) => { for (const e of await readdir(from, { withFileTypes: true })) { if (e.isDirectory()) { await mkdir(join(to, e.name), { recursive: true }); await copyDir(join(from, e.name), join(to, e.name)); } else { const b = await readFile(join(from, e.name)); await writeFile(join(to, e.name), b); copied.set(join(to, e.name), sha(b)); } } };
  await copyDir(plan.backupDir, old);
  await rm(plan.backupDir, { recursive: true });
  const committed = (await readPlan(w.env, w.agentId))!;
  await savePlanForTest(w.env, { ...committed, backupDir: old });
  assert.equal(await migrateBackups(w.env), 1);
  const moved = (await readPlan(w.env, w.agentId))!;
  assert.ok(moved.backupDir.startsWith(join(w.env.dataDir, "history-shed", "backups")));
  assert.equal(sha(await readFile(join(moved.backupDir, "transcript.jsonl"))), sha(original));
  for (const [p, h] of copied) assert.equal(sha(await readFile(p)), h, `old ${p} left as it was`);
  assert.equal(await migrateBackups(w.env), 0, "once");
  await requestRestoreFor(w.env, w.agentId);
  const { restoreRequested } = await import("./server/history-shed.ts");
  assert.deepEqual((await restoreRequested(w.env, w.agentId, FAR())).map((r) => r.ok), [true]);
  assert.ok((await readFile(w.transcript)).equals(original));
  await rm(w.root, { recursive: true });
});

test("a subagent the kept history still names stays in subagents/", async () => {
  const w = await world();
  const first = await prepared(w);
  const moving = first.subagents.filter((s) => s.move);
  assert.ok(moving.length >= 2);
  const byId = moving[0]!.name.replace(/^agent-|\.jsonl$/g, "");
  const toolUseId = JSON.parse(w.fixture.subagents[moving[1]!.name]!.meta).toolUseId as string;
  assert.ok(toolUseId);
  // A kept record mentions one by its agent id and another by the Task call that started it.
  await appendFile(w.transcript, `${JSON.stringify({ type: "pr-link", sessionId: w.sessionId, note: `see ${byId} and ${toolUseId}` })}\n`);
  await settle(w.env, first);
  const second = await prepared(w);
  const moves = new Map(second.subagents.map((s) => [s.name, s.move]));
  assert.equal(moves.get(moving[0]!.name), false, "named by agent id");
  assert.equal(moves.get(moving[1]!.name), false, "named by its tool_use id");
  assert.equal(moves.get(moving[2]?.name ?? moving[0]!.name) ?? false, moving[2] ? true : false);
  await rm(w.root, { recursive: true });
});

const RESTORE_WINDOW = ["restore:backup-current", "restore:write-temp", "restore:holders", "restore:link", "restore:rename", "restore:after-rename", "restore:drop-original"];

test("a line written at any point of a restore is in the result, or the restore is refused", async (t) => {
  for (const step of RESTORE_WINDOW) {
    await t.test(step, async () => {
      const w = await world();
      const original = await readFile(w.transcript);
      const plan = await prepared(w);
      assert.ok((await commit(w.env, plan, FAR())).ok);
      const shed = await readFile(w.transcript);
      const fd = openSync(w.transcript, "a");
      const env: ShedEnv = { ...w.env, step: (name) => { if (name === step) writeSync(fd, LINE); } };
      const out = await restore(env, (await readPlan(w.env, w.agentId))!, FAR());
      closeSync(fd);
      const now = await readFile(w.transcript);
      if (out.ok) assert.ok(now.equals(Buffer.concat([original, Buffer.from(LINE)])), "restored, with the line");
      else assert.ok(now.equals(Buffer.concat([shed, Buffer.from(LINE)])), `refused (${out.why}): the shed file plus the line`);
      for (const f of sideFiles(plan)) assert.equal(existsSync(f), false, `no ${f} left`);
      await rm(w.root, { recursive: true });
    });
  }
});

test("the transcript keeps its file mode through a shed and a restore", async () => {
  const w = await world();
  await chmod(w.transcript, 0o640);
  const plan = await prepared(w);
  assert.ok((await commit(w.env, plan, FAR())).ok);
  assert.equal((await stat(w.transcript)).mode & 0o777, 0o640);
  assert.ok((await restore(w.env, (await readPlan(w.env, w.agentId))!, FAR())).ok);
  assert.equal((await stat(w.transcript)).mode & 0o777, 0o640);
  await rm(w.root, { recursive: true });
});

test("an unreadable plan is reported, and that agent is left alone until it is fixed", async () => {
  const { readPlans } = await import("./server/history-shed.ts");
  const w = await world();
  const plan = await prepared(w);
  await writeFile(join(w.env.dataDir, "history-shed", "plans", w.agentId, "broken.json"), "{ not json");
  const { unreadable } = await readPlans(w.env, w.agentId);
  assert.deepEqual(unreadable, ["broken.json"]);
  const before = await fingerprint(w);
  const out = await commit(w.env, plan, FAR());
  assert.equal(!out.ok && out.why, "unreadable-plan");
  const again = await prepare(w.env, w.agentId, w.sessionId, due);
  assert.equal(!again.ok && again.why, "unreadable-plan");
  assert.deepEqual(diff(before, await fingerprint(w)).changed, []);
  const log = await readFile(join(w.env.dataDir, "history-shed", `runs-${new Date().toISOString().slice(0, 7)}.jsonl`), "utf8");
  assert.match(log, /"event":"plan-unreadable"/);
  await rm(w.root, { recursive: true });
});

test("after two unused backups an agent is not prepared again until they are dealt with", async () => {
  const w = await world();
  for (let i = 0; i < 2; i++) {
    const plan = await prepared(w);
    await appendFile(w.transcript, LINE);
    assert.equal(await settle(w.env, plan), "discarded");
  }
  const out = await prepare(w.env, w.agentId, w.sessionId, due);
  assert.equal(!out.ok && out.why, "unused-backups");
  await rm(w.root, { recursive: true });
});

// ---------------------------------------------------------------------------------------------- the open hook

async function opener(w: World, settings: { shedHistory: boolean }, extra: Partial<ShedEnv> = {}) {
  const { openHandler } = await import("./server/history-shed-open.ts");
  const noted: string[] = [];
  const open = openHandler({
    env: () => ({ ...w.env, ...extra }),
    settings: async () => settings,
    session: (agentId) => persistedSession(w.paseoHome, agentId),
    note: (plan) => { noted.push(plan.id); },
  });
  const request = { agentId: w.agentId, provider: "claude", reason: "resume" as const, purpose: "interactive" as const, env: {} };
  return { open: (signal?: AbortSignal, enteredAt?: number) => open(request, signal, enteredAt), noted };
}

test("the open hook's budget counts from the hook's start, not from after its own reads", async () => {
  const w = await world();
  await prepared(w);
  const { open } = await opener(w, { shedHistory: true });
  await open(undefined, Date.now() - 20_000);
  assert.equal((await readPlan(w.env, w.agentId))?.state, "prepared", "too late to start: nothing changed");
  await open();
  assert.equal((await readPlan(w.env, w.agentId))?.state, "committed");
  await rm(w.root, { recursive: true });
});

test("after an open was canceled, the next open doesn't commit, and the one after does", async () => {
  const w = await world();
  const original = await readFile(w.transcript);
  await prepared(w);
  const controller = new AbortController();
  const { open } = await opener(w, { shedHistory: true }, { step: (name) => { if (name === "commit:write-temp") controller.abort(); } });
  await open(controller.signal);
  assert.ok((await readFile(w.transcript)).equals(original));
  const plain = await opener(w, { shedHistory: true });
  await plain.open();
  assert.equal((await readPlan(w.env, w.agentId))?.state, "prepared", "Claude may be starting from the canceled open: wait");
  await plain.open();
  assert.equal((await readPlan(w.env, w.agentId))?.state, "committed");
  await rm(w.root, { recursive: true });
});

test("a second open while the first is still working stops the first and commits nothing", async () => {
  const w = await world();
  const original = await readFile(w.transcript);
  await prepared(w);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const atGate = new Promise<void>((r) => (reached = r));
  const { open } = await opener(w, { shedHistory: true }, { step: async (name) => { if (name === "commit:write-temp") { reached(); await gate; } } });
  const first = open(new AbortController().signal);
  await atGate;
  const second = open();
  setTimeout(release, 50);
  await Promise.all([first, second]);
  assert.ok((await readFile(w.transcript)).equals(original));
  assert.equal((await readPlan(w.env, w.agentId))?.state, "prepared");
  await rm(w.root, { recursive: true });
});

test("a requested restore runs at the next open even with moving history turned off", async () => {
  const w = await world();
  const original = await readFile(w.transcript);
  assert.ok((await commit(w.env, await prepared(w), FAR())).ok);
  await requestRestoreFor(w.env, w.agentId);
  const { open } = await opener(w, { shedHistory: false });
  await open();
  assert.ok((await readFile(w.transcript)).equals(original));
  assert.equal((await readPlan(w.env, w.agentId))?.state, "restored");
  // And with it off, a prepared plan is never committed.
  const w2 = await world();
  const before = await readFile(w2.transcript);
  await prepared(w2);
  await (await opener(w2, { shedHistory: false })).open();
  assert.ok((await readFile(w2.transcript)).equals(before));
  await rm(w.root, { recursive: true });
  await rm(w2.root, { recursive: true });
});

test("a line Claude appends to the restored file right after the rename is fine: the restore still completes", async () => {
  const w = await world();
  const original = await readFile(w.transcript);
  assert.ok((await commit(w.env, await prepared(w), FAR())).ok);
  const shedNow = await readFile(w.transcript);
  // Written through the path after the rename, so into the restored file (found by the real-process race check).
  const env: ShedEnv = { ...w.env, step: async (name) => { if (name === "restore:after-rename") await appendFile(w.transcript, LINE); } };
  const out = await restore(env, (await readPlan(w.env, w.agentId))!, FAR());
  assert.ok(out.ok, out.ok ? "" : out.why);
  assert.ok((await readFile(w.transcript)).equals(Buffer.concat([original, shedNow.subarray((await agentPlansOf(w))[0]!.cut.newSize), Buffer.from(LINE)])));
  assert.equal((await readPlan(w.env, w.agentId))?.state, "restored");
  await rm(w.root, { recursive: true });
});

async function agentPlansOf(w: World) {
  const { agentPlans } = await import("./server/history-shed.ts");
  return agentPlans(w.env, w.agentId);
}


// ---------------------------------------------------------------------------------------------- 3.8.0-beta.2 review

const LATE = '{"type":"user","message":{"content":"late, into the original"}}\n';
const INTO_NEW = '{"type":"user","message":{"content":"written into the shed file"}}\n';

/** A commit killed right after its rename while a writer still had the original open, then a line into the shed file. */
async function swappedWithLateWrite(w: World) {
  const plan = await prepared(w);
  const fd = openSync(w.transcript, "a");
  const killed: ShedEnv = { ...w.env, step: (name) => { if (name === "commit:after-rename") { writeSync(fd, LATE); throw new Error("killed"); } } };
  assert.equal((await commit(killed, plan, FAR())).ok, false);
  closeSync(fd);
  await appendFile(w.transcript, INTO_NEW);
  return plan;
}

const storedPlan = async (w: World, id: string) => (await agentPlansOf(w)).find((p) => p.id === id)!;

test("a rollback killed after any of its steps is finished by the next settle, every line exactly once", async (t) => {
  // N1: killed after linking the replacement, every later settle hit EEXIST, which the lock took for contention.
  // N2: killed after the rename, settle saw the original grown, discarded the plan, and stranded the shed file's lines.
  for (const killedAfter of ["nothing", "link", "rename", "append"]) {
    await t.test(killedAfter, async () => {
      const w = await world();
      const original = await readFile(w.transcript);
      const plan = await swappedWithLateWrite(w);
      const [orig, spare] = sideNames(plan);
      if (killedAfter !== "nothing") await link(w.transcript, spare!);
      if (killedAfter === "rename" || killedAfter === "append") await rename(orig!, w.transcript);
      if (killedAfter === "append") await appendFile(w.transcript, INTO_NEW);
      await settle(w.env, await storedPlan(w, plan.id));
      assert.ok((await readFile(w.transcript)).equals(Buffer.concat([original, Buffer.from(LATE), Buffer.from(INTO_NEW)])),
        "the original, its late line, then the line written into the shed file, once each");
      assert.equal((await storedPlan(w, plan.id)).state, "discarded");
      for (const f of sideFiles(plan)) assert.equal(existsSync(f), false, `no ${f} left`);
      await rm(w.root, { recursive: true });
    });
  }
});

test("a rollback killed at each of its own steps, in a commit and in a restore, is finished by the next settle", async (t) => {
  for (const kind of ["commit", "restore"] as const) {
    for (const step of ["rollback:link", "rollback:rename", "rollback:append", "rollback:appended", "rollback:drop"]) {
      await t.test(`${kind} ${step}`, async () => {
        let busyIno = -1;
        const w = await world({}, { holders: async (_path, _sid, inode) => (inode?.ino === busyIno ? ["4242:fd"] : []) });
        if (kind === "restore") assert.ok((await commit(w.env, await prepared(w), FAR())).ok);
        const before = await readFile(w.transcript);
        const plan = kind === "commit" ? await prepared(w) : (await readPlan(w.env, w.agentId))!;
        busyIno = (await stat(w.transcript)).ino;
        const fd = openSync(w.transcript, "a");
        const env: ShedEnv = { ...w.env, step: async (name) => {
          if (name === `${kind}:after-rename`) { writeSync(fd, LATE); await appendFile(w.transcript, INTO_NEW); }
          if (name === step) throw new Error(`killed at ${name}`);
        } };
        const out = kind === "commit" ? await commit(env, plan, FAR()) : await restore(env, plan, FAR());
        closeSync(fd);
        assert.equal(out.ok, false);
        busyIno = -1;
        await settle(w.env, await storedPlan(w, plan.id));
        assert.ok((await readFile(w.transcript)).equals(Buffer.concat([before, Buffer.from(LATE), Buffer.from(INTO_NEW)])),
          "what was there, its late line, then the line written into the replacement, once each");
        assert.equal((await storedPlan(w, plan.id)).state, kind === "commit" ? "discarded" : "committed");
        assert.equal((await storedPlan(w, plan.id)).rollback, undefined);
        for (const f of sideFiles(plan)) assert.equal(existsSync(f), false, `no ${f} left`);
        await rm(w.root, { recursive: true });
      });
    }
  }
});

test("a rollback copies whole lines from the shed file, never a torn one", async () => {
  // N4a: a line half-written into the replacement must not be glued to the lines that follow it.
  const w = await world();
  const original = await readFile(w.transcript);
  const plan = await swappedWithLateWrite(w);
  const TORN = '{"type":"user","mess';
  await appendFile(w.transcript, TORN);
  await settle(w.env, await storedPlan(w, plan.id));
  assert.ok((await readFile(w.transcript)).equals(Buffer.concat([original, Buffer.from(LATE), Buffer.from(INTO_NEW)])));
  const spare = sideNames(plan)[1]!;
  assert.ok(existsSync(spare) && (await readFile(spare)).toString().endsWith(TORN), "the torn bytes are kept, not dropped");
  await rm(w.root, { recursive: true });
});

test("a second name a commit failed to drop is recovered by settle: dropped when it is the backup, rolled back when it grew", async (t) => {
  // N4b: 3.8.0-beta.2 ignored a failed drop, so lines written to the original in that window sat only in `.orig`.
  for (const grew of [false, true]) {
    await t.test(grew ? "grew" : "same", async () => {
      const w = await world();
      const original = await readFile(w.transcript);
      const subagentsBefore = await readdir(join(w.sessionDir, "subagents"));
      const plan = await prepared(w);
      assert.ok((await commit(w.env, plan, FAR())).ok);
      const [orig] = sideNames(plan);
      await writeFile(orig!, grew ? Buffer.concat([original, Buffer.from(LATE)]) : original);
      await appendFile(w.transcript, INTO_NEW);
      const shedNow = await readFile(w.transcript);
      await settle(w.env, await storedPlan(w, plan.id));
      if (grew) {
        assert.ok((await readFile(w.transcript)).equals(Buffer.concat([original, Buffer.from(LATE), Buffer.from(INTO_NEW)])));
        assert.equal((await storedPlan(w, plan.id)).state, "discarded");
        assert.deepEqual((await readdir(join(w.sessionDir, "subagents"))).sort(), subagentsBefore.sort(), "moved subagents are back");
      } else {
        assert.ok((await readFile(w.transcript)).equals(shedNow));
        assert.equal((await storedPlan(w, plan.id)).state, "committed");
      }
      for (const f of sideFiles(plan)) assert.equal(existsSync(f), false, `no ${f} left`);
      await rm(w.root, { recursive: true });
    });
  }
});

test("off means off: an open reads no transcript and moves no subagent, but still finishes an interrupted commit", async () => {
  // N4c. A commit whose subagent moves were cut short, and a prepared plan beside it in another agent.
  const w = await world();
  const plan = await prepared(w);
  const moving = plan.subagents.find((s) => s.move);
  assert.ok(moving, "the fixture has a subagent to move");
  const killed: ShedEnv = { ...w.env, step: (name) => { if (name === `commit:subagent:${moving.name}`) throw new Error("killed"); } };
  await commit(killed, plan, FAR());
  assert.equal((await storedPlan(w, plan.id)).state, "committed");
  const before = await fingerprint(w);
  const steps: string[] = [];
  await (await opener(w, { shedHistory: false }, { step: (name) => { steps.push(name); } })).open();
  const after = diff(before, await fingerprint(w));
  assert.deepEqual([after.changed, after.missing, after.added], [[], [], []], "nothing changed");
  assert.deepEqual(steps, [], "nothing read");
  // A commit killed after its rename is finished with it off, so no line is stranded; its subagents wait.
  const w2 = await world();
  const plan2 = await prepared(w2);
  await commit({ ...w2.env, step: (name) => { if (name === "commit:after-rename") throw new Error("killed"); } }, plan2, FAR());
  const subs = await readdir(join(w2.sessionDir, "subagents"));
  await (await opener(w2, { shedHistory: false })).open();
  assert.equal((await storedPlan(w2, plan2.id)).state, "committed");
  assert.deepEqual(await readdir(join(w2.sessionDir, "subagents")), subs, "no subagent moved");
  for (const f of sideFiles(plan2)) assert.equal(existsSync(f), false, `no ${f} left`);
  await rm(w.root, { recursive: true });
  await rm(w2.root, { recursive: true });
});

test("leftover second names beside a transcript are listed for the status", async () => {
  const shed = await import("./server/history-shed.ts") as Record<string, unknown>;
  assert.equal(typeof shed.leftoverFiles, "function");
  const leftoverFiles = shed.leftoverFiles as (env: ShedEnv) => Promise<{ agentId: string; file: string; size: number }[]>;
  const w = await world();
  const plan = await swappedWithLateWrite(w);
  const list = await leftoverFiles(w.env);
  assert.deepEqual(list.map((l) => [l.agentId, l.file]), [[w.agentId, sideNames(plan)[0]]]);
  await settle(w.env, await storedPlan(w, plan.id));
  assert.deepEqual(await leftoverFiles(w.env), []);
  await rm(w.root, { recursive: true });
});

// ---------------------------------------------------------------------------------------------- 3.8.0-beta.3 review

const NEW_B = '{"type":"user","message":{"content":"a second line into the shed file"}}\n';

/** A commit's rollback killed at `rollback:append` (before its write), with the plan as stored. */
async function rollbackAtAppend(w: World) {
  const plan = await prepared(w);
  let busyIno = (await stat(w.transcript)).ino;
  const fd = openSync(w.transcript, "a");
  const env: ShedEnv = {
    ...w.env,
    processes: { holders: async (_p, _s, inode) => (inode?.ino === busyIno ? ["4242:fd"] : []) },
    step: async (name) => {
      if (name === "commit:after-rename") { writeSync(fd, LATE); await appendFile(w.transcript, INTO_NEW); }
      if (name === "rollback:append") throw new Error("killed before the append");
    },
  };
  assert.equal((await commit(env, plan, FAR())).ok, false);
  closeSync(fd);
  busyIno = -1;
  return storedPlan(w, plan.id);
}

test("a rollback killed after its append, before saving it, never appends a line twice, even once the replacement grew", async () => {
  // R2: the next pass looked for the whole, now bigger, chunk, didn't find it, and appended all of it again.
  const w = await world();
  const before = (await stat(w.transcript)).size;
  const stored = await rollbackAtAppend(w);
  assert.ok(stored.rollback, "a rollback is under way");
  const spare = sideNames(stored)[1]!;
  // The write happened; then the kill; then a writer still on the replacement adds a line.
  await appendFile(w.transcript, INTO_NEW);
  await appendFile(spare, NEW_B);
  await settle(w.env, await storedPlan(w, stored.id));
  const text = (await readFile(w.transcript)).toString();
  assert.equal(text.split(INTO_NEW).length - 1, 1, "the first line once");
  assert.equal(text.split(NEW_B).length - 1, 1, "the second line once");
  assert.ok(text.endsWith(INTO_NEW + NEW_B));
  assert.ok((await stat(w.transcript)).size > before);
  await rm(w.root, { recursive: true });
});

test("a torn tail the rollback can't prove its own is never cut: the rollback waits and says so", async () => {
  const w = await world();
  const stored = await rollbackAtAppend(w);
  await appendFile(w.transcript, INTO_NEW.slice(0, 20));
  const size = (await stat(w.transcript)).size;
  await settle(w.env, await storedPlan(w, stored.id));
  assert.equal((await stat(w.transcript)).size, size, "nothing cut, nothing appended after a torn line");
  assert.ok((await storedPlan(w, stored.id)).rollback, "still under way");
  await rm(w.root, { recursive: true });
});

// ---------------------------------------------------------------------------------------------- 3.8.0-beta.4 review

type RequestShed = (env: ShedEnv, agentId: string, options: { session: { provider: string; sessionId: string } | null; closed: boolean }) =>
  Promise<{ ok: true; plan: ShedPlanLike; reused: boolean } | { ok: false; why: string }>;
type ShedPlanLike = { id: string; state: string; requested?: boolean; original: { size: number; sha256: string }; cut: { newSize: number }; backupDir: string };

async function requestShedFn(): Promise<RequestShed> {
  const shed = await import("./server/history-shed.ts") as Record<string, unknown>;
  assert.equal(typeof shed.requestShed, "function", "requestShed exists");
  return shed.requestShed as RequestShed;
}

test("a requested prepare works with the setting off, and only that plan commits at the next open while it is off", async () => {
  const requestShed = await requestShedFn();
  const w = await world();
  const original = await readFile(w.transcript);
  const session = await persistedSession(w.paseoHome, w.agentId);
  const out = await requestShed(w.env, w.agentId, { session, closed: true });
  assert.ok(out.ok, out.ok ? "" : out.why);
  assert.equal(out.plan.requested, true);
  assert.equal(out.plan.state, "prepared");
  assert.equal(out.plan.original.sha256, sha(original));
  assert.equal(sha(await readFile(join(out.plan.backupDir, "transcript.jsonl"))), sha(original), "the backup is written and verified");
  const { open, noted } = await opener(w, { shedHistory: false });
  await open();
  assert.equal((await readPlan(w.env, w.agentId))?.state, "committed", "a requested plan commits with the setting off");
  assert.equal((await stat(w.transcript)).size, out.plan.cut.newSize);
  assert.deepEqual(noted, [out.plan.id]);
  // A sweep plan, with the setting off, still never commits.
  const w2 = await world();
  const before = await readFile(w2.transcript);
  const sweepPlan = await prepared(w2);
  assert.notEqual(sweepPlan.requested, true);
  await (await opener(w2, { shedHistory: false })).open();
  assert.ok((await readFile(w2.transcript)).equals(before));
  await rm(w.root, { recursive: true });
  await rm(w2.root, { recursive: true });
});

test("a requested prepare refuses what a sweep refuses, and an agent that is not closed", async () => {
  const requestShed = await requestShedFn();
  const w = await world();
  const before = await fingerprint(w);
  const session = await persistedSession(w.paseoHome, w.agentId);
  assert.deepEqual(await requestShed(w.env, w.agentId, { session, closed: false }), { ok: false, why: "not-closed" });
  assert.deepEqual(await requestShed(w.env, w.agentId, { session: null, closed: true }), { ok: false, why: "no-session" });
  assert.deepEqual(await requestShed(w.env, w.agentId, { session: { provider: "codex", sessionId: w.sessionId }, closed: true }), { ok: false, why: "not-claude" });
  const busy = { ...w.env, processes: { holders: async () => ["4242:fd"] } };
  assert.deepEqual(await requestShed(busy, w.agentId, { session, closed: true }), { ok: false, why: "busy" });
  assert.deepEqual(diff(before, await fingerprint(w)), { changed: [], missing: [], added: [] }, "a refusal writes nothing beside the transcript");
  assert.equal(await readPlan(w.env, w.agentId), null);
  await rm(w.root, { recursive: true });
});

test("asking for a plan the sweep already made marks that plan requested instead of writing a second backup", async () => {
  const requestShed = await requestShedFn();
  const w = await world();
  const sweepPlan = await prepared(w);
  const out = await requestShed(w.env, w.agentId, { session: await persistedSession(w.paseoHome, w.agentId), closed: true });
  assert.ok(out.ok, out.ok ? "" : out.why);
  assert.equal(out.reused, true);
  assert.equal(out.plan.id, sweepPlan.id);
  assert.equal((await readPlan(w.env, w.agentId))?.requested, true);
  assert.equal((await agentPlansOf(w)).length, 1);
  // With a restore pending, a new request is refused rather than undoing it.
  assert.ok((await commit(w.env, (await readPlan(w.env, w.agentId))!, FAR())).ok);
  await requestRestoreFor(w.env, w.agentId);
  const again = await requestShed(w.env, w.agentId, { session: await persistedSession(w.paseoHome, w.agentId), closed: true });
  assert.deepEqual(again, { ok: false, why: "restore-pending" });
  await rm(w.root, { recursive: true });
});

test("another writer's torn line that looks like the start of the rollback's chunk is never cut (a kill before the write)", async () => {
  // beta.4 review item 3: appendFloor saved, killed before the write landed; then another writer's torn line, a
  // prefix of the chunk's first line, ends the file. Without proof the bytes are this rollback's own, nothing is cut.
  const w = await world();
  const stored = await rollbackAtAppend(w);
  const { savePlanForTest } = await import("./server/history-shed.ts");
  const floor = (await stat(w.transcript)).size;
  stored.rollback = { ...stored.rollback!, appendFloor: floor } as typeof stored.rollback;
  await savePlanForTest(w.env, stored);
  await appendFile(w.transcript, INTO_NEW.slice(0, 20));
  const size = (await stat(w.transcript)).size;
  await settle(w.env, await storedPlan(w, stored.id));
  assert.equal((await stat(w.transcript)).size, size, "nothing cut, nothing appended after the torn line");
  assert.ok((await readFile(w.transcript)).toString().endsWith(INTO_NEW.slice(0, 20)));
  assert.ok((await storedPlan(w, stored.id)).rollback, "still under way");
  const log = (await readdir(join(w.env.dataDir, "history-shed"))).filter((f) => f.startsWith("runs-"));
  const lines = (await Promise.all(log.map((f) => readFile(join(w.env.dataDir, "history-shed", f), "utf8")))).join("");
  assert.match(lines, /"event":"rollback-pending"/);
  await rm(w.root, { recursive: true });
});

test("a short append (no space left) is cut back to its last whole line, by the record of what that write wrote", async () => {
  const w = await world();
  const stored = await rollbackAtAppend(w);
  // The append's one write reaches the file only in part, then the pass stops.
  let short = true;
  const env: ShedEnv = {
    ...w.env,
    appendWrite: async (fd: number, data: Buffer) => {
      if (!short) return writeSync(fd, data);
      short = false;
      return writeSync(fd, data.subarray(0, 20));
    },
  } as ShedEnv;
  await settle(env, await storedPlan(w, stored.id)).catch(() => "threw");
  assert.ok((await storedPlan(w, stored.id)).rollback, "still under way after the short write");
  assert.ok((await readFile(w.transcript)).toString().endsWith(INTO_NEW.slice(0, 20)), "the torn bytes are there");
  await settle(env, await storedPlan(w, stored.id));
  const text = (await readFile(w.transcript)).toString();
  assert.equal(text.split(INTO_NEW).length - 1, 1, "the line once, whole");
  assert.ok(!text.includes(INTO_NEW.slice(0, 20) + INTO_NEW.slice(0, 20)), "no torn copy left");
  assert.ok(text.endsWith(INTO_NEW));
  assert.equal((await storedPlan(w, stored.id)).rollback, undefined);
  await rm(w.root, { recursive: true });
});
