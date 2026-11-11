import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { brokenHomeLinks, describeHomeLinks } from "./server/settings-links.ts";

test("ZeroSub homes that stopped linking the main settings are flagged, and nothing is written", async () => {
  const root = mkdtempSync(join(tmpdir(), "ss-links-"));
  const paseo = join(root, "paseo");
  const main = join(root, "claude", "settings.json");
  mkdirSync(join(root, "claude"), { recursive: true });
  writeFileSync(main, "{}");
  const other = join(root, "other.json");
  writeFileSync(other, "{}");
  const home = (id: string) => join(paseo, "zerosub", "homes", id);
  for (const id of ["linked", "copy", "elsewhere", "missing", "codex"]) mkdirSync(home(id), { recursive: true });
  symlinkSync(main, join(home("linked"), "settings.json"));
  writeFileSync(join(home("copy"), "settings.json"), "{\"copy\":true}");
  symlinkSync(other, join(home("elsewhere"), "settings.json"));
  writeFileSync(join(home("codex"), "settings.json"), "{}");
  const account = (id: string, family = "claude") => ({ id, family, kind: "managed", home: home(id) });
  writeFileSync(join(paseo, "zerosub", "state.json"), JSON.stringify({
    accounts: [
      { id: "claude-main", family: "claude", kind: "main", home: null },
      account("linked"), account("copy"), account("elsewhere"), account("missing"), account("codex", "codex"),
      { ...account("never-opened"), home: home("never-opened") },
    ],
  }));
  const before = statSync(join(home("copy"), "settings.json")).mtimeMs;

  const links = await brokenHomeLinks(main, paseo);
  assert.deepEqual(links.map((link) => [link.accountId, link.problem]), [["copy", "copy"], ["elsewhere", "elsewhere"], ["missing", "missing"]]);
  // Read-only: the copy is still a copy, untouched, and no file appeared.
  assert.equal(statSync(join(home("copy"), "settings.json")).mtimeMs, before);
  assert.equal(readFileSync(join(home("copy"), "settings.json"), "utf8"), "{\"copy\":true}");
  assert.ok(lstatSync(join(home("elsewhere"), "settings.json")).isSymbolicLink());
  assert.throws(() => lstatSync(join(home("missing"), "settings.json")));

  const [line] = describeHomeLinks(links, main);
  assert.match(line!, /ZeroSub account copy: .* is its own copy, not a link to .*settings\.json, so hooks installed there don't reach that account's sessions\. Fix: .*ln -sf /);
});

test("without ZeroSub there is nothing to say", async () => {
  const root = mkdtempSync(join(tmpdir(), "ss-links-none-"));
  assert.deepEqual(await brokenHomeLinks(join(root, "settings.json"), root), []);
});
