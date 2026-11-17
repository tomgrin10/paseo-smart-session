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
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, appendFile } from "node:fs/promises";
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
      const w = await world({}, processes ?? idle);
      const plan = await prepared(w);
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

const STEPS = ["commit:verify-original", "commit:verify-backup", "commit:write-temp", "commit:rename", "commit:verify-new"];

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
      for (const temp of tempNames(plan)) assert.equal(existsSync(temp), false, "no temp file left");
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
