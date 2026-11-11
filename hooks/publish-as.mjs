#!/usr/bin/env node
/**
 * A `PreToolUse` hook on the Artifact tool: publishes a page from a session on another Claude
 * account as the main account instead. What it does and why is in `server/hooklib/publish-as.mjs`.
 */

import { toolsMode } from "../server/hooklib/context.mjs";
import { callPlugin } from "../server/hooklib/daemon.mjs";
import { publishAsHook } from "../server/hooklib/publish-as.mjs";

async function main() {
  const raw = await new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => resolve(input));
  });
  let event;
  try { event = JSON.parse(raw); } catch { return; }
  const result = await publishAsHook(event, { env: process.env, call: callPlugin, native: toolsMode() === "native" });
  if (result !== null) process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main().catch(() => undefined);
