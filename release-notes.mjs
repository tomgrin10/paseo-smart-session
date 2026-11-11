#!/usr/bin/env node
/**
 * Every GitHub release of Smart Session carries the same body, built here from git at its tag.
 * The layout is shared with Tom's other plugins (Follow-up's `scripts/release-body.mjs`):
 *
 *     ## What's new
 *     <notes>
 *
 *     ## Install
 *     `paseo plugin install npm:paseo-smart-session@X`, or `paseo plugin update smart-session --version X` if it's installed. …
 *
 *     This release passed plugin verification and npm registry integrity verification before these notes were published.
 *
 * Where the notes come from:
 * - **Beta** (any prerelease except an rc): the `changes/*.md` fragments the tag added since the
 *   previous release tag, as "- " bullets. A beta that changed nothing a user runs says exactly
 *   MAINTENANCE; one that changed runtime code without adding a fragment refuses.
 * - **rc and stable**: the version's curated `## X.Y.Z` section of CHANGELOG.md, written by hand
 *   from the fragments (`prepare`), grouped by what a user gets. `X.Y.Z-rc.N` carries X.Y.Z's.
 *
 * An empty or boilerplate-only body refuses, so the publish workflow stops before npm.
 *
 *     node release-notes.mjs check                 lint CHANGELOG.md and pending changes/ (npm run verify)
 *     node release-notes.mjs body <tag> [--pinned] print the release body, or exit 1 with why
 *     node release-notes.mjs title <tag>           print the release title
 *     node release-notes.mjs prepare <version>     fold changes/ into a new CHANGELOG section to curate
 *
 * Dependency-free; `release-notes.test.ts` holds the rules.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
const HEADING = /^##\s+v?(\S+)(?:\s+\((\d{4}-\d{2}-\d{2})\))?\s*$/;

export const DISPLAY_NAME = "Smart Session";
export const MAINTENANCE = "Maintenance release; no user-visible changes.";
export const VERIFIED = "This release passed plugin verification and npm registry integrity verification before these notes were published.";
/** Paths a user runs. A beta that changes any of them owes a changes/ fragment. */
export const RUNTIME = ["client/", "server/", "shared/", "hooks/", "index.client.tsx", "index.server.ts", "mcp.mjs"];
/** Runtime paths a release bump changes on its own. */
const BUMP_ONLY = ["shared/version.ts"];
/** Lines that say nothing: a body made only of these is boilerplate. */
const BOILERPLATE = [
  /^(small |minor |various |misc(ellaneous)? )?(bug ?fixes|fixes|improvements|changes|updates|tweaks)( and (small )?(bug ?fixes|fixes|improvements|changes|updates|tweaks))?\.?$/i,
  /^see (the )?(commits?|diff|changelog|pull requests?|prs?)\b/i,
  /^(no|none|n\/a|tbd|todo|wip|-)\.?$/i,
  /^(beta|prerelease|release) v?\d[\w.-]*\.?$/i,
];

// ---------------------------------------------------------------- versions

export function parseVersion(version) {
  const m = SEMVER.exec(String(version).replace(/^v/, ""));
  if (!m) throw new Error(`Not a release version: ${JSON.stringify(version)}`);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}
export const isPrerelease = (version) => parseVersion(version).pre !== null;
/** The CHANGELOG section a version carries: X.Y.Z-rc.N carries X.Y.Z's. */
export function notesVersion(version) {
  const v = parseVersion(version);
  return v.pre !== null && /^rc(\.|$)/.test(v.pre) ? `${v.major}.${v.minor}.${v.patch}` : String(version).replace(/^v/, "");
}
/** A beta takes its notes from fragments; an rc or stable takes a curated section. */
export const isBeta = (version) => isPrerelease(version) && notesVersion(version) === String(version).replace(/^v/, "");

export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const p = x.pre.split("."), q = y.pre.split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const n = /^\d+$/.test(p[i]), m = /^\d+$/.test(q[i]);
    if (n && m && +p[i] !== +q[i]) return +p[i] - +q[i];
    if (n !== m) return n ? -1 : 1;
    if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

/** ">=0.14.0" → "0.14"; "0.7.2" stays. */
export function paseoFloor(requirement) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(requirement ?? ""));
  if (!m) return null;
  return m[3] && m[3] !== "0" ? `${m[1]}.${m[2]}.${m[3]}` : `${m[1]}.${m[2]}`;
}

// ---------------------------------------------------------------- notes

/** Style rules for user-facing notes; returns the problems with one bullet. */
export function lintBullet(text) {
  const problems = [];
  if (!text.trim()) problems.push("empty");
  if (/—/.test(text)) problems.push("em dash");
  if (/\p{Extended_Pictographic}/u.test(text)) problems.push("emoji");
  if (/(^|[\s(])#\d+\b|\bPRs? ?#?\d|\bpull request\b/i.test(text)) problems.push("PR jargon");
  if (text.length > 240) problems.push("longer than 240 characters");
  return problems;
}

/** Bullets from one fragment, continuation lines joined. Throws on anything that isn't a bullet. */
export function fragmentBullets(name, text) {
  const out = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) continue;
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) out.push(bullet[1].trim());
    else if (/^\s+\S/.test(line) && out.length) out[out.length - 1] += ` ${line.trim()}`;
    else throw new Error(`${name}: only "- " bullets are allowed, found: ${line}`);
  }
  if (!out.length) throw new Error(`${name}: no bullets`);
  return out;
}

/** The body of `## <version>` in a changelog, up to the next `## ` heading or `<details>`; null when absent. */
export function changelogSection(changelog, version) {
  const lines = changelog.replace(/\r\n?/g, "\n").split("\n");
  const at = lines.findIndex((l) => HEADING.exec(l)?.[1] === version);
  if (at < 0) return null;
  let end = at + 1;
  while (end < lines.length && !/^##\s/.test(lines[end]) && !/^\s*<details/i.test(lines[end])) end++;
  return lines.slice(at + 1, end).join("\n").trim();
}

/** Why a release's notes can't be published; empty when they can. */
export function notesProblems(version, notes) {
  const problems = [];
  const text = String(notes ?? "").trim();
  if (text === "") return [`${version}: no release notes`];
  if (text === MAINTENANCE) return isBeta(version) ? [] : [`${version}: an rc or stable release needs curated notes, not "${MAINTENANCE}"`];
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !/^#{1,6}\s/.test(l) && !/^!\[/.test(l) && !/^<\/?(details|summary)/i.test(l));
  const bullets = lines.filter((l) => /^[-*]\s+/.test(l)).map((l) => l.replace(/^[-*]\s+/, ""));
  for (const b of bullets) for (const p of lintBullet(b)) problems.push(`${version}: ${p}: ${b}`);
  const said = lines.map((l) => l.replace(/^[-*]\s+/, "").replace(/[*_`]/g, "").trim());
  if (said.every((l) => BOILERPLATE.some((re) => re.test(l)))) problems.push(`${version}: the notes are boilerplate only; say what changed for the user`);
  if (bullets.length === 0) problems.push(`${version}: the notes have no "- " bullets`);
  return problems;
}

// ---------------------------------------------------------------- the body

/**
 * The Install section. A prerelease pins its version; the newest stable doesn't (`latest` is it);
 * an older stable rendered later is pinned (`pinned`). A version that predates npm passes its own
 * documented `install` command.
 */
export function installLine({ pkg, pluginId, version, stable, paseo, pinned = false, install = null }) {
  const needs = paseo ? ` Needs Paseo ${paseo} or newer.` : "";
  if (install) return `\`${install}\`.${needs}`;
  if (isPrerelease(version)) {
    const tail = stable ? ` The stable release is ${stable}.` : "";
    return `\`paseo plugin install npm:${pkg}@${version}\`, or \`paseo plugin update ${pluginId} --version ${version}\` if it's installed. Prereleases are on npm's \`beta\` dist-tag.${tail}${needs}`;
  }
  if (pinned) return `\`paseo plugin install npm:${pkg}@${version}\`, or \`paseo plugin update ${pluginId} --version ${version}\` if it's installed.${needs}`;
  return `\`paseo plugin install ${pkg}\`, or \`paseo plugin update ${pluginId}\` if it's installed.${needs}`;
}

export function releaseBody({ notes, install, verified = true }) {
  return [`## What's new`, "", notes.trim(), "", `## Install`, "", install, ...(verified ? ["", VERIFIED] : []), ""].join("\n");
}

export const releaseTitle = (version) => `${DISPLAY_NAME} v${String(version).replace(/^v/, "")}`;

// ---------------------------------------------------------------- git at the tag

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const showAt = (ref, path, cwd) => {
  try {
    return git(["show", `${ref}:${path}`], cwd);
  } catch {
    return null;
  }
};
const versionTags = (args, cwd) => git(["tag", "-l", "v*", ...args], cwd).split("\n").map((t) => t.trim()).filter((t) => SEMVER.test(t.replace(/^v/, "")));

/** The release tag this one follows: the newest version tag below it among the tag's ancestors. */
export function previousTag(tag, cwd = ROOT) {
  const below = versionTags(["--merged", tag], cwd).filter((t) => compareVersions(t, tag) < 0).sort(compareVersions);
  return below.at(-1) ?? null;
}
/** The newest stable version below this one: what `latest` was when it shipped. */
export function previousStable(tag, cwd = ROOT) {
  const below = versionTags([], cwd).filter((t) => !isPrerelease(t) && compareVersions(t, tag) < 0).sort(compareVersions);
  return below.at(-1)?.replace(/^v/, "") ?? null;
}

/** A beta's notes: the fragments its tag added since the previous release tag. */
export function betaNotes(tag, cwd = ROOT) {
  const prev = previousTag(tag, cwd);
  const changed = prev ? git(["diff", "--name-only", prev, tag], cwd).split("\n").filter(Boolean) : [];
  const added = prev ? git(["diff", "--name-only", "--diff-filter=A", prev, tag, "--", "changes/"], cwd).split("\n").filter(Boolean) : [];
  // Top level only: changes/shipped/ holds notes for betas that shipped before fragments existed.
  const fragments = added.filter((p) => /^changes\/[^/]+\.md$/.test(p) && p !== "changes/README.md").sort();
  const bullets = fragments.flatMap((p) => fragmentBullets(p, showAt(tag, p, cwd) ?? ""));
  if (bullets.length > 0) return { notes: bullets.map((b) => `- ${b}`).join("\n"), problems: [] };
  const runtime = changed.filter((p) => RUNTIME.some((r) => p === r || p.startsWith(r)) && !BUMP_ONLY.includes(p));
  if (runtime.length > 0) {
    return { notes: "", problems: [`${tag}: changes ${runtime.length} runtime file(s) since ${prev} (${runtime.slice(0, 3).join(", ")}${runtime.length > 3 ? ", …" : ""}) but adds no changes/*.md fragment. Add one saying what the user gets.`] };
  }
  return { notes: MAINTENANCE, problems: [] };
}

/** Everything the release body needs, read from git at the tag. */
export function renderAt(tag, { cwd = ROOT, pinned = false, verified = true } = {}) {
  const version = tag.replace(/^v/, "");
  parseVersion(version);
  let notes, problems;
  if (isBeta(version)) ({ notes, problems } = betaNotes(tag, cwd));
  else {
    const changelog = showAt(tag, "CHANGELOG.md", cwd);
    const target = notesVersion(version);
    notes = changelog === null ? null : changelogSection(changelog, target);
    problems = notes === null ? [`${tag}: CHANGELOG.md has no "## ${target}" section. Curate one (node release-notes.mjs prepare ${target}).`] : [];
  }
  if (problems.length === 0) problems = notesProblems(version, notes);
  const manifest = JSON.parse(showAt(tag, "paseo-plugin.json", cwd) ?? "{}");
  const pkg = JSON.parse(showAt(tag, "package.json", cwd) ?? "{}");
  const install = installLine({
    pkg: pkg.name,
    pluginId: manifest.id,
    version,
    stable: previousStable(tag, cwd),
    paseo: paseoFloor(manifest.requirements?.paseo),
    pinned,
  });
  return { title: releaseTitle(version), body: problems.length ? null : releaseBody({ notes, install, verified }), problems };
}

// ---------------------------------------------------------------- the working tree

/** Fragments waiting for the next rc or stable: changes/*.md, then changes/shipped/*.md (betas already out). */
function pendingFragments(dir) {
  const read = (sub) => {
    const at = join(dir, "changes", sub);
    if (!existsSync(at)) return [];
    return readdirSync(at)
      .filter((n) => n.endsWith(".md") && n !== "README.md")
      .sort()
      .map((n) => {
        const name = sub ? `${sub}/${n}` : n;
        return { name, path: join(at, n), bullets: fragmentBullets(`changes/${name}`, readFileSync(join(at, n), "utf8")) };
      });
  };
  return [...read("shipped"), ...read("")];
}

/** CHANGELOG.md and pending fragments, linted. */
export function checkTree(dir = ROOT) {
  const problems = [];
  const path = join(dir, "CHANGELOG.md");
  if (existsSync(path)) {
    const changelog = readFileSync(path, "utf8");
    const seen = new Set();
    for (const line of changelog.split("\n")) {
      const h = HEADING.exec(line);
      if (!h) continue;
      if (!SEMVER.test(h[1])) problems.push(`CHANGELOG.md: bad version heading "${line}"`);
      else if (isBeta(h[1])) problems.push(`CHANGELOG.md: ${h[1]} is a beta; betas take their notes from changes/`);
      if (seen.has(h[1])) problems.push(`CHANGELOG.md: ${h[1]} appears twice`);
      seen.add(h[1]);
      if (SEMVER.test(h[1])) problems.push(...notesProblems(h[1], changelogSection(changelog, h[1])).map((p) => `CHANGELOG.md ${p}`));
    }
  }
  try {
    for (const f of pendingFragments(dir)) for (const b of f.bullets) for (const p of lintBullet(b)) problems.push(`changes/${f.name}: ${p}: ${b}`);
  } catch (error) {
    problems.push(error.message);
  }
  return problems;
}

/** Starts X.Y.Z's CHANGELOG section from the pending fragments and deletes them. Curate it before tagging. */
export function prepare(version, { dir = ROOT, date = new Date().toISOString().slice(0, 10) } = {}) {
  if (isPrerelease(version)) throw new Error(`${version} is a prerelease. Betas take their notes from changes/; an rc carries ${notesVersion(version)}'s section.`);
  const path = join(dir, "CHANGELOG.md");
  const changelog = existsSync(path) ? readFileSync(path, "utf8") : "# Release notes\n\nWhat changed in each version of Smart Session, newest first.\n";
  if (changelogSection(changelog, version) !== null) throw new Error(`CHANGELOG.md already has ${version}.`);
  const fragments = pendingFragments(dir);
  if (fragments.length === 0) throw new Error("No changes/*.md fragments to fold.");
  const section = [`## ${version} (${date})`, "", ...fragments.flatMap((f) => f.bullets.map((b) => `- ${b}`)), ""].join("\n");
  const lines = changelog.split("\n");
  const first = lines.findIndex((l) => HEADING.test(l));
  const at = first < 0 ? lines.length : first;
  writeFileSync(path, [...lines.slice(0, at), section, ...lines.slice(at)].join("\n").replace(/\n{3,}/g, "\n\n"));
  for (const f of fragments) unlinkSync(f.path);
  return fragments.length;
}

// ---------------------------------------------------------------- CLI

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, arg, ...flags] = process.argv.slice(2);
  const fail = (problems) => {
    for (const p of problems) console.error(`::error::${p}`);
    process.exit(1);
  };
  try {
    if (command === "check") {
      const problems = checkTree();
      if (problems.length) fail(problems);
      console.log("Release notes: CHANGELOG.md and changes/ are clean.");
    } else if (command === "body" && arg) {
      const { body, problems } = renderAt(arg, { pinned: flags.includes("--pinned") });
      if (problems.length) fail(problems);
      process.stdout.write(body);
    } else if (command === "title" && arg) {
      process.stdout.write(`${releaseTitle(arg)}\n`);
    } else if (command === "prepare" && arg) {
      const n = prepare(arg.replace(/^v/, ""));
      console.log(`Folded ${n} fragment(s) into CHANGELOG.md's ${arg} section. Curate it: a short lead, grouped by what a user gets, biggest first.`);
    } else {
      fail(["usage: node release-notes.mjs check | body <tag> [--pinned] | title <tag> | prepare <version>"]);
    }
  } catch (error) {
    fail([error.message]);
  }
}
