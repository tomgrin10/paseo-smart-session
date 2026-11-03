import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { isStandalone, standaloneEnabled } from "./server/guard/standalone.ts";
import { runTeardowns } from "./shared/lifecycle.ts";

const files = (entries: Record<string, unknown>) => async (path: string) => {
  if (!(path in entries)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
  return JSON.stringify(entries[path]);
};

test("the standalone plugin is recognised by id, npm package, Git remote, manifest or package name", async () => {
  const none = files({});
  assert.equal(await isStandalone({ id: "paseo-session-guard", enabled: true }, none), true);
  assert.equal(await isStandalone({ id: "guard", enabled: true, npm: { packageName: "paseo-session-guard" } }, none), true);
  assert.equal(await isStandalone({ id: "guard", enabled: true, remote: "https://github.com/tomgrin10/paseo-session-guard.git" }, none), true);
  assert.equal(await isStandalone({ id: "guard", enabled: true, remote: "git@github.com:tomgrin10/paseo-session-guard" }, none), true);
  assert.equal(await isStandalone({ id: "guard", enabled: true, path: "/p" }, files({ [join("/p", "paseo-plugin.json")]: { id: "paseo-session-guard" } })), true);
  assert.equal(await isStandalone({ id: "guard", enabled: true, path: "/p" }, files({ [join("/p", "package.json")]: { name: "paseo-session-guard" } })), true);
});

test("Smart Session and unrelated plugins are not mistaken for it", async () => {
  const read = files({ [join("/s", "paseo-plugin.json")]: { id: "smart-session" }, [join("/s", "package.json")]: { name: "paseo-smart-session" } });
  assert.equal(await isStandalone({ id: "smart-session", enabled: true, path: "/s" }, read), false);
  assert.equal(await isStandalone({ id: "defer", enabled: true, path: "/missing", remote: "https://github.com/tomgrin10/paseo-defer" }, read), false);
});

test("only an enabled standalone plugin blocks governing; a disabled one already ran its teardown", async () => {
  const none = files({});
  assert.equal(await standaloneEnabled([{ id: "smart-session", enabled: true }, { id: "paseo-session-guard", enabled: false }], none), false);
  assert.equal(await standaloneEnabled([{ id: "smart-session", enabled: true }, { id: "paseo-session-guard", enabled: true }], none), true);
  assert.equal(await standaloneEnabled([], none), false);
});

test("every teardown runs even when an earlier one fails, and the first failure is reported", async () => {
  const ran: string[] = [];
  await assert.rejects(runTeardowns([
    () => { ran.push("mcp"); },
    async () => { ran.push("guard"); throw new Error("guard failed"); },
    () => { ran.push("recorder"); },
    async () => { ran.push("governor"); throw new Error("second failure"); },
  ]), /guard failed/);
  assert.deepEqual(ran, ["mcp", "guard", "recorder", "governor"]);
  await runTeardowns([]);
});
