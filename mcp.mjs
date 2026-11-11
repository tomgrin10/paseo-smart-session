#!/usr/bin/env node
/**
 * A stdio MCP server that lets an agent see its own context and ask to be compacted.
 *
 * This is the half of Smart Session that the *model* talks to, and it is where the
 * decision to compact is actually taken. The plugin records and delivers; nothing
 * in it ever decides that a session should be compacted. These tools are how the
 * session decides for itself: how full am I, how much plan budget is left, write
 * down what I know, compact me, not yet.
 *
 * Identity comes from `PASEO_AGENT_ID`, which Paseo sets in every agent process, so
 * "my context" needs no argument and cannot be pointed at the wrong session.
 *
 * No dependencies beyond Paseo's own client: MCP over stdio is newline-delimited
 * JSON-RPC, which is small enough to speak directly.
 */

import { AGENT_SCOPED, agentTools } from "./server/agent-tools.mjs";
import { callPlugin } from "./server/hooklib/daemon.mjs";

const AGENT_ID = process.env.PASEO_AGENT_ID ?? null;

/**
 * Which tools this session gets.
 *
 * All but one are about *this* session — its context, its state file, compacting
 * it, putting that off — and they need the `PASEO_AGENT_ID` that only Paseo sets.
 * Outside Paseo they cannot work, so they are not offered: a tool that exists and
 * always fails is worse than one that is absent.
 *
 * `budget_status` needs no session identity and is useful anywhere, so it stays.
 * Set SMART_SESSION_MCP_SCOPE=paseo to offer nothing at all outside Paseo.
 *
 * This is the cheap half of scoping. Claude Code 2.1.261 defers MCP tool loading —
 * tools appear as bare names until something asks for their schema — so an empty
 * or short list costs no tokens, only the node process. For true Paseo-only
 * registration, see the wrapper described in the README.
 */

function availableTools() {
  if (AGENT_ID !== null) return Object.keys(TOOLS);
  if (process.env.SMART_SESSION_MCP_SCOPE === "paseo") return [];
  return Object.keys(TOOLS).filter((name) => !AGENT_SCOPED.has(name));
}

/** stdout carries protocol only; anything else corrupts the stream. */
const log = (...args) => console.error("[smart-session mcp]", ...args);

const TOOLS = agentTools({ agentId: AGENT_ID, call: callPlugin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

async function handle(request) {
  const { id, method, params } = request;
  // Notifications carry no id and must not be answered.
  if (id === undefined || id === null) return;

  if (method === "initialize") {
    respond(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "smart-session", version: "0.3.0" },
    });
    return;
  }

  if (method === "tools/list") {
    respond(id, {
      tools: availableTools().map((name) => ({
        name,
        description: TOOLS[name].description,
        inputSchema: TOOLS[name].inputSchema,
      })),
    });
    return;
  }

  if (method === "tools/call") {
    const tool = TOOLS[params?.name];
    if (tool === undefined || !availableTools().includes(params.name)) {
      fail(id, `Unknown tool: ${params?.name}`);
      return;
    }
    try {
      const text = await tool.run(params.arguments ?? {});
      respond(id, { content: [{ type: "text", text }] });
    } catch (error) {
      // Reported as a tool result, not a protocol error, so the model can read it
      // and decide what to do rather than seeing the call vanish.
      respond(id, {
        content: [{ type: "text", text: `Failed: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      });
    }
    return;
  }

  if (method === "ping") {
    respond(id, {});
    return;
  }

  fail(id, `Unsupported method: ${method}`);
}

/**
 * In-flight calls, so a closed stdin does not kill work already started.
 *
 * A client that writes its requests and closes the pipe is a normal shape (and how
 * this server is tested); exiting on "end" would answer none of them.
 */
let pending = 0;
let inputEnded = false;

function exitWhenDrained() {
  if (inputEnded && pending === 0) process.exit(0);
}

/**
 * `node mcp.mjs call <tool> '<json>'`: one call, its text on stdout. The hooks point an agent here when a plugin
 * update has detached its native smart_* tools mid-turn (Paseo reattaches them when the session reopens, before
 * its next prompt). Identity is the agent's own PASEO_AGENT_ID, as for the stdio server.
 */
if (process.argv[2] === "call") {
  const name = process.argv[3];
  const tool = TOOLS[name];
  if (tool === undefined || !availableTools().includes(name)) {
    console.error(`Unknown tool: ${name}. Tools: ${availableTools().join(", ")}`);
    process.exit(2);
  }
  let args = {};
  try { args = JSON.parse(process.argv[4] ?? "{}"); } catch { console.error("The arguments must be one JSON object."); process.exit(2); }
  tool.run(args).then(
    (text) => { process.stdout.write(`${text}\n`); process.exit(0); },
    (error) => { console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); },
  );
} else {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "") {
        try {
          const message = JSON.parse(line);
          pending += 1;
          void handle(message).finally(() => {
            pending -= 1;
            exitWhenDrained();
          });
        } catch (error) {
          log("could not parse a message", String(error));
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  process.stdin.on("end", () => {
    inputEnded = true;
    exitWhenDrained();
  });
  log(`ready${AGENT_ID === null ? " (no PASEO_AGENT_ID; context tools will not work)" : ` for agent ${AGENT_ID.slice(0, 8)}`}`);
}
