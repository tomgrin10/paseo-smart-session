import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_THRESHOLDS, normalizeProfile, withCompactThreshold } from "./shared/thresholds.ts";

test("the requested compact percentage is authoritative when normalizing a profile", () => {
  assert.deepEqual(normalizeProfile({ ...DEFAULT_THRESHOLDS.small, compact: 25 }, DEFAULT_THRESHOLDS.small), {
    notice: 25,
    closing: 25,
    compact: 25,
  });
});

test("lowering a compact threshold keeps useful earlier notice bands", () => {
  assert.deepEqual(withCompactThreshold(DEFAULT_THRESHOLDS.small, 25), {
    notice: 18,
    closing: 22,
    compact: 25,
  });
  assert.deepEqual(withCompactThreshold(DEFAULT_THRESHOLDS.large, 25), {
    notice: 15,
    closing: 22,
    compact: 25,
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
