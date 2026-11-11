import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  MAINTENANCE,
  VERIFIED,
  changelogSection,
  checkTree,
  compareVersions,
  installLine,
  isBeta,
  lintBullet,
  notesProblems,
  notesVersion,
  paseoFloor,
  prepare,
  previousStable,
  previousTag,
  releaseBody,
  releaseTitle,
  renderAt,
  // @ts-expect-error: a dependency-free .mjs script, untyped on purpose
} from "./release-notes.mjs";

/** A throwaway repo holding a release history, so the rules run against real git. */
function repo(): { dir: string; commit: (files: Record<string, string | null>, tag?: string) => void; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "release-notes-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  const commit = (files: Record<string, string | null>, tag?: string) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) rmSync(join(dir, path));
      else {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
    }
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", tag ?? "change");
    if (tag) git("tag", tag);
  };
  const manifest = JSON.stringify({ id: "smart-session", requirements: { paseo: ">=0.14.0" } });
  const pkg = (version: string) => JSON.stringify({ name: "paseo-smart-session", version });
  commit({ "paseo-plugin.json": manifest, "package.json": pkg("3.6.2"), "CHANGELOG.md": "# Release notes\n\n## 3.6.2 (2026-11-10)\n\n- The forecast reads the right window after a reset.\n" }, "v3.6.2");
  return { dir, commit, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("versions: betas, rcs and stables are told apart and ordered", () => {
  assert.equal(isBeta("3.7.0-beta.4"), true);
  assert.equal(isBeta("3.7.0-rc.1"), false);
  assert.equal(isBeta("3.7.0"), false);
  assert.equal(notesVersion("3.7.0-rc.2"), "3.7.0");
  assert.equal(notesVersion("4.0.0-rc.0"), "4.0.0");
  assert.equal(notesVersion("3.7.0-beta.2"), "3.7.0-beta.2");
  const sorted = ["3.7.0", "3.7.0-beta.10", "3.6.2", "3.7.0-rc.1", "3.7.0-beta.2"].sort(compareVersions);
  assert.deepEqual(sorted, ["3.6.2", "3.7.0-beta.2", "3.7.0-beta.10", "3.7.0-rc.1", "3.7.0"]);
  assert.equal(paseoFloor(">=0.14.0"), "0.14");
  assert.equal(paseoFloor(">=0.7.2"), "0.7.2");
});

test("lint: no em dash, emoji, PR jargon or overlong bullets", () => {
  assert.deepEqual(lintBullet("The pool row names the limit that runs out."), []);
  assert.deepEqual(lintBullet("Faster — and safer"), ["em dash"]);
  assert.deepEqual(lintBullet("New card 🎉"), ["emoji"]);
  assert.deepEqual(lintBullet("Usage card (#24)"), ["PR jargon"]);
  assert.deepEqual(lintBullet("See pull request 24"), ["PR jargon"]);
  assert.deepEqual(lintBullet("x".repeat(241)), ["longer than 240 characters"]);
});

test("boilerplate and empty notes refuse; real notes and a beta's maintenance line pass", () => {
  assert.match(notesProblems("3.7.0-beta.6", "").join(), /no release notes/);
  assert.match(notesProblems("3.7.0-beta.6", "- Bug fixes and improvements.").join(), /boilerplate/);
  assert.match(notesProblems("3.7.0-beta.6", "- Small fixes and improvements").join(), /boilerplate/);
  assert.match(notesProblems("3.7.0", "See the commits for details.").join(), /boilerplate/);
  assert.match(notesProblems("3.7.0", "A paragraph and no bullets.").join(), /no "- " bullets/);
  assert.deepEqual(notesProblems("3.7.0-beta.6", MAINTENANCE), []);
  assert.match(notesProblems("3.7.0", MAINTENANCE).join(), /needs curated notes/);
  assert.deepEqual(notesProblems("3.7.0", "Smart Session shows up in Paseo's usage card.\n\n### Usage card\n\n- Each window says when it runs out."), []);
});

test("a changelog section ends at the next version or an archived <details>", () => {
  const log = "# Release notes\n\n## 3.7.0 (2026-11-12)\n\nLead.\n\n### Usage\n\n- One.\n\n<details><summary>betas</summary>\n\n## 3.6.2\n\n- Two.\n";
  assert.equal(changelogSection(log, "3.7.0"), "Lead.\n\n### Usage\n\n- One.");
  assert.equal(changelogSection(log, "3.6.2"), "- Two.");
  assert.equal(changelogSection(log, "3.5.0"), null);
});

test("the body has one layout: What's new, Install, verification", () => {
  const install = installLine({ pkg: "paseo-smart-session", pluginId: "smart-session", version: "3.7.0-beta.5", stable: "3.6.2", paseo: "0.14" });
  assert.equal(install, "`paseo plugin install npm:paseo-smart-session@3.7.0-beta.5`, or `paseo plugin update smart-session --version 3.7.0-beta.5` if it's installed. Prereleases are on npm's `beta` dist-tag. The stable release is 3.6.2. Needs Paseo 0.14 or newer.");
  assert.equal(installLine({ pkg: "paseo-smart-session", pluginId: "smart-session", version: "3.7.0", paseo: "0.14" }), "`paseo plugin install paseo-smart-session`, or `paseo plugin update smart-session` if it's installed. Needs Paseo 0.14 or newer.");
  assert.match(installLine({ pkg: "paseo-smart-session", pluginId: "smart-session", version: "3.5.0", paseo: "0.14", pinned: true }), /@3\.5\.0`, or `paseo plugin update smart-session --version 3\.5\.0`/);
  assert.equal(releaseBody({ notes: "- One.", install }), `## What's new\n\n- One.\n\n## Install\n\n${install}\n\n${VERIFIED}\n`);
  assert.equal(releaseTitle("v3.7.0-beta.5"), "Smart Session v3.7.0-beta.5");
});

test("a beta's notes are the fragments its tag added; the stable is the one before it", () => {
  const r = repo();
  try {
    r.commit({ "changes/feat-usage.md": "- Smart Session shows up in Paseo's usage card.\n", "server/usage.ts": "x", "package.json": JSON.stringify({ name: "paseo-smart-session", version: "3.7.0-beta.1" }) }, "v3.7.0-beta.1");
    r.commit({ "changes/fix-hide.md": "- Paseo's own card no longer flashes\n  before ours appears.\n", "changes/shipped/feat-old.md": "- Shipped in an earlier beta.\n", "client/hide.ts": "x", "package.json": JSON.stringify({ name: "paseo-smart-session", version: "3.7.0-beta.2" }) }, "v3.7.0-beta.2");
    assert.equal(previousTag("v3.7.0-beta.2", r.dir), "v3.7.0-beta.1");
    assert.equal(previousStable("v3.7.0-beta.2", r.dir), "3.6.2");
    const { title, body, problems } = renderAt("v3.7.0-beta.2", { cwd: r.dir });
    assert.deepEqual(problems, []);
    assert.equal(title, "Smart Session v3.7.0-beta.2");
    assert.match(body, /^## What's new\n\n- Paseo's own card no longer flashes before ours appears\.\n\n## Install\n\n`paseo plugin install npm:paseo-smart-session@3\.7\.0-beta\.2`/);
    assert.doesNotMatch(body, /usage card/, "only this beta's own changes");
    assert.doesNotMatch(body, /earlier beta/, "changes/shipped/ is never a beta's notes");
    assert.match(body, /The stable release is 3\.6\.2\. Needs Paseo 0\.14 or newer\./);
  } finally {
    r.done();
  }
});

test("a beta that changes runtime code without a fragment refuses; one that doesn't says maintenance", () => {
  const r = repo();
  try {
    r.commit({ "server/usage.ts": "x", "shared/version.ts": "3.7.0-beta.1" }, "v3.7.0-beta.1");
    assert.match(renderAt("v3.7.0-beta.1", { cwd: r.dir }).problems.join(), /adds no changes\/\*\.md fragment/);
    r.commit({ "README.md": "docs", "shared/version.ts": "3.7.0-beta.2" }, "v3.7.0-beta.2");
    const { body, problems } = renderAt("v3.7.0-beta.2", { cwd: r.dir });
    assert.deepEqual(problems, []);
    assert.match(body, new RegExp(`^## What's new\\n\\n${MAINTENANCE.replace(/[.;]/g, "\\$&")}\\n`));
  } finally {
    r.done();
  }
});

test("an rc and a stable carry the curated section, and refuse without one", () => {
  const r = repo();
  try {
    r.commit({ "package.json": JSON.stringify({ name: "paseo-smart-session", version: "3.7.0-rc.0" }) }, "v3.7.0-rc.0");
    assert.match(renderAt("v3.7.0-rc.0", { cwd: r.dir }).problems.join(), /no "## 3\.7\.0" section/);
    const log = readFileSync(join(r.dir, "CHANGELOG.md"), "utf8").replace("## 3.6.2", "## 3.7.0 (2026-11-12)\n\nSmart Session joins Paseo's usage card.\n\n- Each window says when it runs out.\n\n## 3.6.2");
    r.commit({ "CHANGELOG.md": log }, "v3.7.0-rc.1");
    const rc = renderAt("v3.7.0-rc.1", { cwd: r.dir });
    assert.deepEqual(rc.problems, []);
    assert.match(rc.body, /^## What's new\n\nSmart Session joins Paseo's usage card\.\n\n- Each window says when it runs out\.\n\n## Install/);
    assert.match(rc.body, /Prereleases are on npm's `beta` dist-tag\. The stable release is 3\.6\.2\./);
    r.commit({}, "v3.7.0");
    assert.match(renderAt("v3.7.0", { cwd: r.dir }).body, /`paseo plugin install paseo-smart-session`, or `paseo plugin update smart-session` if it's installed\./);
  } finally {
    r.done();
  }
});

test("the working-tree check lints the changelog and pending fragments; prepare folds them", () => {
  const r = repo();
  try {
    assert.deepEqual(checkTree(r.dir), []);
    r.commit({ "changes/bad.md": "- Shipped — finally (#12)\n", "changes/README.md": "Rules." });
    const problems = checkTree(r.dir);
    assert.ok(problems.some((p: string) => /em dash/.test(p)) && problems.some((p: string) => /PR jargon/.test(p)), problems.join("\n"));
    r.commit({ "changes/bad.md": "- The pool row names the limit.\n", "changes/two.md": "- Resets keep their own row.\n" });
    r.commit({ "CHANGELOG.md": "# Release notes\n\n## 3.7.0-beta.1\n\n- x\n" });
    assert.match(checkTree(r.dir).join(), /is a beta/);
    r.commit({ "CHANGELOG.md": "# Release notes\n\n## 3.6.2 (2026-11-10)\n\n- Fix.\n" });
    r.commit({ "changes/shipped/feat-usage.md": "- Smart Session joins Paseo's usage card.\n" });
    assert.equal(prepare("3.7.0", { dir: r.dir, date: "2026-11-12" }), 3);
    assert.equal(changelogSection(readFileSync(join(r.dir, "CHANGELOG.md"), "utf8"), "3.7.0"), "- Smart Session joins Paseo's usage card.\n- The pool row names the limit.\n- Resets keep their own row.");
    assert.throws(() => prepare("3.7.0-beta.1", { dir: r.dir }), /prerelease/);
  } finally {
    r.done();
  }
});

test("the CLI refuses with exit 1 and prints nothing on stdout", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ["release-notes.mjs", ...args], { encoding: "utf8" });
  const refused = run("body", "v0.0.0-no-such-tag");
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  assert.equal(run("title", "v3.7.0-beta.6").stdout, "Smart Session v3.7.0-beta.6\n");
  assert.equal(run("check").status, 0, run("check").stderr);
});

test("the publish workflow checks the notes before npm and publishes the GitHub release from them", () => {
  const workflow = readFileSync(".github/workflows/publish-npm.yml", "utf8");
  const check = workflow.indexOf("node release-notes.mjs body");
  const publish = workflow.indexOf('["publish",');
  assert.ok(check > 0 && check < publish, "the notes are checked before npm publish");
  const release = workflow.slice(workflow.indexOf("\n  release:"));
  assert.match(release, /needs: publish/);
  assert.match(release, /node release-notes\.mjs body "\$RELEASE_TAG" > "\$notes"/);
  assert.match(release, /gh release create "\$RELEASE_TAG" --verify-tag --title "\$title" --notes-file "\$notes"/);
  assert.match(release, /gh release edit "\$RELEASE_TAG" --title "\$title" --notes-file "\$notes"/);
  assert.match(release, /--prerelease --latest=false/);
  assert.match(readFileSync("package.json", "utf8"), /node release-notes\.mjs check/, "verify lints the notes");
});
