import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_PRESENTATION, chatToolRow } from "./shared/chat.ts";
import { agentTools } from "./server/agent-tools.mjs";

/*
 * Paseo 0.15.2 groups a run only from tool_call and thought items; a timeline transform can only return plugin items,
 * which seal the run and render loose. So Smart Session's bookkeeping stays Paseo's own tool call, and only a moment on
 * an explicit list may become a row. Every agent tool must be classified.
 */
const TOOLS = Object.keys(agentTools({ agentId: null, call: async () => ({}) }));

test("every Smart Session agent tool is classified as routine or a moment", () => {
  assert.deepEqual(TOOLS.filter((t) => !(t in TOOL_PRESENTATION)), [], "classify each new tool in TOOL_PRESENTATION (shared/chat.ts)");
  assert.deepEqual(Object.keys(TOOL_PRESENTATION).filter((t) => !TOOLS.includes(t)), []);
});

test("routine calls stay groupable tool calls under every name and status", () => {
  for (const tool of TOOLS.filter((t) => TOOL_PRESENTATION[t as keyof typeof TOOL_PRESENTATION] === "routine"))
    for (const name of [`mcp__smart-session__${tool}`, `smart-session.${tool}`, `mcp__paseo__smart_${tool}`, `paseo.smart_${tool}`])
      for (const status of ["running", "completed", "failed", "canceled"])
        assert.equal(chatToolRow(name, status, { type: "unknown", input: {}, output: "Not queued: x" }, status === "failed" ? "boom" : null), null, `${name} ${status}`);
});
