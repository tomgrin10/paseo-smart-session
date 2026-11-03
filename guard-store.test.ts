import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardDataDir, LockHeldError, Store } from "./server/guard/store.ts";

test("state is atomic, private, and corruption is preserved instead of reset", async t => {
  const dir = await mkdtemp(join(tmpdir(), "guard-store-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir); assert.deepEqual(await store.read(), { version: 1, overrides: {}, pauses: [] });
  await store.write({ version: 1, overrides: { a: false }, pauses: [] }); assert.equal((await store.read()).overrides.a, false);
  assert.equal((await stat(join(dir, "state.json"))).mode & 0o777, 0o600);
  await writeFile(join(dir, "state.json"), "broken"); await assert.rejects(store.read(), /could not be read/);
  assert.equal(await readFile(join(dir, "state.json"), "utf8"), "broken");
});
test("duplicate installs cannot acquire the same governor; clean teardown releases ownership", async t => {
  const dir = await mkdtemp(join(tmpdir(), "guard-lock-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir); const release = await store.lock();
  await assert.rejects(new Store(dir).lock(), /already running/); await release();
  await (await new Store(dir).lock())();
});

test("a VM restart or reused PID cannot retain a stale governor or interrupted recovery lock", { skip: process.platform !== "linux" }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "guard-reboot-lock-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const stale = `${process.pid}:old-token:previous-boot:previous-process-birth`;
  await writeFile(join(dir, "governor.lock"), stale);
  await writeFile(join(dir, "governor.lock.recovery"), stale);
  const release = await new Store(dir).lock();
  assert.notEqual(await readFile(join(dir, "governor.lock"), "utf8"), stale);
  await assert.rejects(new Store(dir).lock(), /already running/);
  await release();
});

test("a lock held by a live governor is reported as held, so a second plugin defers instead of failing", async t => {
  const dir = await mkdtemp(join(tmpdir(), "guard-held-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const release = await new Store(dir).lock();
  await assert.rejects(new Store(dir).lock(), (error: unknown) => error instanceof LockHeldError);
  await release();
});
test("state lives in the standalone plugin's directory, so both share one lock and one record", () => {
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = "/paseo-home";
  try { assert.equal(guardDataDir(), join("/paseo-home", "plugin-data", "session-guard")); }
  finally { if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous; }
});
