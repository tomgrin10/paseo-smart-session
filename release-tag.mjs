#!/usr/bin/env node
/**
 * Which npm dist-tag a release goes to. The publish workflow asks this before anything
 * else and passes the answer to `npm publish --tag`.
 *
 * - A prerelease (any version with a `-`, e.g. `3.7.0-beta.1`) goes to `beta`. Never
 *   `latest`: users installing `paseo-smart-session` without a version must not get one.
 * - A stable version goes to `latest` only when a person asked for it: the workflow's
 *   manual `allow_latest` input. A tag push alone refuses, so moving `latest` is always
 *   an explicit human step.
 *
 * `node release-tag.mjs <version> [--allow-latest]` prints the tag, or exits 1 with why.
 * Dependency-free; `release-tag.test.ts` holds the rules.
 */

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function distTag(version, { allowLatest = false } = {}) {
  const match = SEMVER.exec(String(version));
  if (!match) throw new Error(`Not a release version: ${JSON.stringify(version)}`);
  if (match[4] !== undefined) return "beta";
  if (!allowLatest) {
    throw new Error(`${version} is a stable version and would move npm's latest tag. Release a prerelease (e.g. ${version}-beta.1), or run the publish workflow by hand with allow_latest=true.`);
  }
  return "latest";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [version, ...flags] = process.argv.slice(2);
  try {
    process.stdout.write(`${distTag(version, { allowLatest: flags.includes("--allow-latest") })}\n`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
