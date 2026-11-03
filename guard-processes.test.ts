import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { LinuxProcessControl, type Suspension } from "./server/guard/processes.ts";

async function state(pid: number) {
  const raw = await readFile(`/proc/${pid}/stat`, "utf8");
  return raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/)[0];
}
async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail("Test process did not reach the expected state.");
}
async function tree(t: { after(fn: () => Promise<void>): void }) {
  // A synthetic daemon owns one provider, an unrelated worker, and a provider
  // with the wrong owner. Never discover or signal a real Paseo process.
  const workerCode = `
    const {spawn}=require('node:child_process');
    const tool=spawn(process.execPath,['-e',"const {spawn}=require('node:child_process');const leaf=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(leaf.pid);setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
    const paused=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    process.kill(paused.pid,'SIGSTOP');
    tool.stdout.once('data',chunk=>console.log(JSON.stringify({root:process.pid,tool:tool.pid,leaf:Number(chunk.toString()),paused:paused.pid})));
    setInterval(()=>{},1000);
  `;
  const ownerCode = `
    const {spawn}=require('node:child_process');
    const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    const wrong=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',env:{...process.env,PASEO_AGENT_ID:'different'}});
    const root=spawn(process.execPath,['-e',${JSON.stringify(workerCode)}],{stdio:['ignore','pipe','ignore'],env:{...process.env,PASEO_AGENT_ID:'test-native'}});
    root.stdout.once('data',chunk=>console.log(JSON.stringify({...JSON.parse(chunk.toString()),unrelated:unrelated.pid,wrong:wrong.pid})));
    setInterval(()=>{},1000);
  `;
  const owner = spawn(process.execPath, ["-e", ownerCode], { stdio: ["ignore", "pipe", "pipe"] });
  let pids: number[] = [];
  t.after(async () => {
    for (const pid of pids) try { process.kill(pid, "SIGCONT"); process.kill(pid, "SIGKILL"); } catch {}
    if (owner.exitCode === null) owner.kill("SIGKILL");
    if (owner.exitCode === null) await once(owner, "exit");
  });
  const output = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic owner timed out")), 5000);
    owner.stdout!.once("data", data => { clearTimeout(timer); resolve(data.toString()); });
    owner.once("error", error => { clearTimeout(timer); reject(error); });
  });
  const parsed = JSON.parse(output) as { root: number; tool: number; leaf: number; paused: number; unrelated: number; wrong: number };
  pids = Object.values(parsed);
  return { ...parsed, owner: owner.pid! };
}

test("Linux ownership, whole-tree freeze, exact resume, and unrelated/pre-stopped workers", { skip: process.platform !== "linux" }, async t => {
  const pids = await tree(t); const control = new LinuxProcessControl(pids.owner);
  const suspension = await control.discover({ id: "test-native", provider: "codex", status: "running" }, pids.owner);
  assert.equal(suspension?.rootPid, pids.root);
  assert.equal(await control.discover({ id: "missing", provider: "codex", status: "running" }, pids.owner), null);
  assert.equal(await control.discover({ id: "test-native", provider: "claude", status: "running" }, process.pid), null);
  const journaled: Suspension[] = [structuredClone(suspension!)];
  await control.freeze(suspension!, async () => { journaled.push(structuredClone(suspension!)); });
  assert.ok(journaled.some(record => record.processes.some(p => p.pid === pids.tool)));
  await waitFor(async () => (await state(pids.root)) === "T" && (await state(pids.tool)) === "T" && (await state(pids.leaf)) === "T");
  assert.equal(await control.stopped(suspension!), true);
  assert.equal(await control.alive(suspension!), true);
  assert.equal(await control.owned(suspension!), true);
  assert.equal(await new LinuxProcessControl(process.pid).owned(suspension!), false);
  assert.ok(!suspension!.processes.some(p => p.pid === pids.paused), "pre-existing stopped tool must not be owned for release");
  assert.notEqual(await state(pids.unrelated), "T"); assert.notEqual(await state(pids.wrong), "T");
  await control.resume(suspension!);
  await waitFor(async () => (await state(pids.root)) !== "T" && (await state(pids.tool)) !== "T" && (await state(pids.leaf)) !== "T");
  assert.equal(await state(pids.paused), "T"); assert.equal(await control.stopped(suspension!), false);
});

test("PID birth identity mismatch never resumes a different process", { skip: process.platform !== "linux" }, async t => {
  const pids = await tree(t); const control = new LinuxProcessControl(pids.owner);
  await control.resume({ rootPid: pids.paused, processes: [{ pid: pids.paused, startTime: "wrong-birth-time" }] });
  assert.equal(await state(pids.paused), "T");
  assert.equal(await control.alive({ rootPid: pids.paused, processes: [{ pid: pids.paused, startTime: "wrong-birth-time" }] }), false);
  await assert.rejects(() => control.resume({ rootPid: process.pid, processes: [{ pid: process.pid, startTime: "irrelevant" }] }), /could not be released/);
});

test("failed durable journal rolls back every already-suspended worker", { skip: process.platform !== "linux" }, async t => {
  const pids = await tree(t); const control = new LinuxProcessControl(pids.owner);
  const suspension = (await control.discover({ id: "test-native", provider: "claude", status: "running" }, pids.owner))!;
  await assert.rejects(() => control.freeze(suspension, async () => { throw new Error("disk full"); }), /disk full/);
  await control.resume(suspension);
  await waitFor(async () => (await state(pids.root)) !== "T" && (await state(pids.tool)) !== "T");
  assert.equal(await state(pids.paused), "T");
});
