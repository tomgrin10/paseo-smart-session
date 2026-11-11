import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// @ts-expect-error: a dependency-free .mjs script, untyped on purpose
import { distTag } from "./release-tag.mjs";

test("a prerelease always goes to beta, even when latest is allowed", () => {
  assert.equal(distTag("3.7.0-beta.1"), "beta");
  assert.equal(distTag("3.7.0-rc.2"), "beta");
  assert.equal(distTag("4.0.0-alpha"), "beta");
  assert.equal(distTag("3.7.0-beta.1", { allowLatest: true }), "beta");
});

test("a stable version refuses unless latest was explicitly allowed", () => {
  assert.throws(() => distTag("3.7.0"), /would move npm's latest tag/);
  assert.equal(distTag("3.7.0", { allowLatest: true }), "latest");
});

test("anything that is not a version refuses", () => {
  for (const bad of ["", "v3.7.0", "3.7", "latest", undefined]) assert.throws(() => distTag(bad), /Not a release version/);
});

test("the CLI prints the tag, and exits 1 for a stable version without --allow-latest", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ["release-tag.mjs", ...args], { encoding: "utf8" });
  assert.equal(run("3.7.0-beta.1").stdout.trim(), "beta");
  const refused = run("3.7.0");
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  assert.equal(run("3.7.0", "--allow-latest").stdout.trim(), "latest");
});

test("the publish workflow chooses the tag first and never publishes without --tag", () => {
  const workflow = readFileSync(".github/workflows/publish-npm.yml", "utf8");
  // Every npm publish passes the chosen dist-tag.
  const publishes = workflow.match(/\["publish",[^\]]*\]/g) ?? [];
  assert.ok(publishes.length > 0, "the workflow publishes");
  for (const call of publishes) assert.match(call, /"--tag", distTag/);
  assert.doesNotMatch(workflow, /npm publish(?![^\n]*--tag)/, "no shell `npm publish` without --tag");
  // The tag comes from release-tag.mjs, before the release checks run.
  const choose = workflow.indexOf("node release-tag.mjs");
  assert.ok(choose > 0 && choose < workflow.indexOf("npm run verify"), "dist-tag chosen before verify");
  // allow_latest is a manual input defaulting to false; a tag push can't set it.
  assert.match(workflow, /allow_latest:\n\s+description: [^\n]+\n\s+required: false\n\s+default: false\n\s+type: boolean/);
  // After publishing, a beta must not sit on latest.
  assert.match(workflow, /distTag === "beta" && tags\.latest === pkg\.version/);
});
