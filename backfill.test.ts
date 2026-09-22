import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { scanSpend } from "./server/backfill.ts";

test("the spend scan bounds one transcript read and progresses past an overlong line", async () => {
  const root = await mkdtemp(join(tmpdir(), "smart-session-backfill-"));
  const config = join(root, "claude");
  const project = join(config, "projects", "project-1");
  const previousHome = process.env.PASEO_HOME;
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const previousTasks = process.env.SMART_SESSION_TASKS_ROOT;
  process.env.PASEO_HOME = join(root, "paseo");
  process.env.CLAUDE_CONFIG_DIR = config;
  process.env.SMART_SESSION_TASKS_ROOT = join(root, "no-tasks");
  try {
    await mkdir(project, { recursive: true });
    const valid = JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-21T12:00:00.000Z",
      requestId: "request-after-large-line",
      message: { model: "claude", usage: { input_tokens: 10, output_tokens: 5 } },
    });
    const oversized = `${"x".repeat(16 * 1024 * 1024 + 1)}\n${valid}\n`;
    await writeFile(join(project, "session.jsonl"), oversized);

    const first = await scanSpend();
    assert.equal(first.bytesRead, 16 * 1024 * 1024);
    assert.equal(first.messagesCounted, 0);

    const second = await scanSpend();
    assert.equal(second.messagesCounted, 1);
    assert.equal(second.buckets[0]?.messages, 1);
  } finally {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    if (previousTasks === undefined) delete process.env.SMART_SESSION_TASKS_ROOT;
    else process.env.SMART_SESSION_TASKS_ROOT = previousTasks;
    await rm(root, { recursive: true });
  }
});
