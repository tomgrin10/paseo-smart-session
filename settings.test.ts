import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_THRESHOLDS, normalizeProfile, withCompactThreshold } from "./shared/thresholds.ts";

test("the requested compact percentage is authoritative when normalizing a profile", () => {
  assert.deepEqual(normalizeProfile({ ...DEFAULT_THRESHOLDS.small, compact: 25 }, DEFAULT_THRESHOLDS.small), {
    notice: 25,
    closing: 25,
    compact: 25,
    now: 90,
  });
});

test("lowering a compact threshold keeps useful earlier notice bands", () => {
  assert.deepEqual(withCompactThreshold(DEFAULT_THRESHOLDS.small, 25), {
    notice: 18,
    closing: 22,
    compact: 25,
    now: 90,
  });
  assert.deepEqual(withCompactThreshold(DEFAULT_THRESHOLDS.large, 25), {
    notice: 15,
    closing: 22,
    compact: 25,
    now: 40,
  });
});

test("a custom compact threshold is persisted in settings.json", async () => {
  const home = mkdtempSync(join(tmpdir(), "ss-settings-"));
  process.env.PASEO_HOME = home;
  const settings = (await import(`./server/settings.ts?case=${home}`)) as typeof import("./server/settings.ts");
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    large: withCompactThreshold(DEFAULT_THRESHOLDS.large, 25),
  };

  const saved = await settings.writeSettings({ thresholds });
  assert.equal(saved.thresholds.large.compact, 25);
  assert.deepEqual(
    JSON.parse(readFileSync(join(home, "plugin-data", "smart-session", "settings.json"), "utf8")).thresholds,
    thresholds,
  );
});

test("a settings file saved before the upper line existed is migrated additively", async () => {
  const home = mkdtempSync(join(tmpdir(), "ss-settings-"));
  process.env.PASEO_HOME = home;
  const dir = join(home, "plugin-data", "smart-session");
  mkdirSync(dir, { recursive: true });
  // Exactly what v3.4 wrote: one compact line per profile, the large one raised.
  const old = {
    enabled: true,
    thresholds: { largeWindowFrom: 400_000, large: { notice: 15, closing: 22, compact: 45 }, small: { notice: 60, closing: 75, compact: 85 } },
    freshStateMinutes: 20,
    showPill: false,
    autoEnrol: true,
    installHooks: true,
  };
  writeFileSync(join(dir, "settings.json"), JSON.stringify(old), "utf8");
  const settings = (await import(`./server/settings.ts?case=${home}`)) as typeof import("./server/settings.ts");
  const read = await settings.readSettings();
  assert.deepEqual(read.thresholds.large, { notice: 15, closing: 22, compact: 45, now: 55 });
  assert.deepEqual(read.thresholds.small, { ...DEFAULT_THRESHOLDS.small });
  assert.equal(read.freshStateMinutes, 20, "everything else is untouched");
  assert.equal(read.showPill, false);
  // Reading never rewrites the file.
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")), old);
});
