import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { PLUGIN_VERSION } from "./shared/version.ts";

test("the compiled-in version matches package.json", () => {
  // resolvePluginDir() finds the running install by this version. A release that bumps
  // package.json alone would point every hook back at whatever config.json names.
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(PLUGIN_VERSION, pkg.version);
});
