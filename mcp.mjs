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

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import { readSettings } from "./hooks/context.mjs";
import { defer, readLedger } from "./hooks/asks.mjs";
import { resolveDaemonPassword } from "./server/daemon-password.mjs";

const PLUGIN_ID = "smart-session";
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
const AGENT_SCOPED = new Set(["context_status", "checkpoint", "request_compaction", "defer_compaction"]);

function availableTools() {
  if (AGENT_ID !== null) return Object.keys(TOOLS);
  if (process.env.SMART_SESSION_MCP_SCOPE === "paseo") return [];
  return Object.keys(TOOLS).filter((name) => !AGENT_SCOPED.has(name));
}

/** stdout carries protocol only; anything else corrupts the stream. */
const log = (...args) => console.error("[smart-session mcp]", ...args);

/**
 * Paseo's daemon client, loaded only when something actually needs it.
 *
 * A top-level import would make this whole server fail to start wherever
 * `@getpaseo/client` cannot be resolved — which is every Claude Code session that
 * is not a Paseo agent, since the plugin ships with no installed dependencies. The
 * tools that need it are already hidden outside Paseo by `availableTools()`; this
 * makes the ones that do not need it work there too.
 *
 * This process is spawned directly by Claude Code from the plugin's own checkout,
 * not by Paseo, so unlike `server/daemon.ts` it has no module graph to borrow from
 * and a bare specifier resolves only in a dev checkout with `node_modules`
 * installed. On a managed Git install the fallback instead finds the `paseo` CLI
 * on `PATH` and resolves the client from its own installed dependencies — the
 * same package the running daemon was built with.
 *
 * The desktop app is the exception. Its client lives inside `app.asar`, which
 * only Electron can read, and its `paseo` is a shell wrapper with no
 * `node_modules` beside it. `server/install.ts` therefore registers this server
 * to run on the app's own Electron runtime in node mode, and from there the
 * client resolves through `process.resourcesPath`.
 */
let daemonClientModule = null;

const CLIENT_SPECIFIER = ["@getpaseo", "client", "internal", "daemon-client"].join("/");

async function loadDaemonClient() {
  if (daemonClientModule !== null) return daemonClientModule;
  const failures = [];
  for (const { label, resolve } of clientCandidates()) {
    try {
      daemonClientModule = await import(resolve());
      return daemonClientModule;
    } catch (error) {
      failures.push(`${label} (${error.message})`);
    }
  }
  throw new Error(`Cannot resolve ${CLIENT_SPECIFIER} ${failures.join(" or ")}${desktopHint()}`);
}

/** Every place the client can come from, cheapest first. */
function clientCandidates() {
  const fromEntry = (entry) => () => pathToFileURL(createRequire(entry).resolve(CLIENT_SPECIFIER)).href;
  const candidates = [{ label: "directly", resolve: () => CLIENT_SPECIFIER }];
  // Set only under Electron, where the bundled CLI inside app.asar is readable.
  if (typeof process.resourcesPath === "string") {
    const entry = join(process.resourcesPath, "app.asar", "node_modules", "@getpaseo", "cli", "dist", "index.js");
    candidates.push({ label: `from the Paseo app bundle at ${process.resourcesPath}`, resolve: fromEntry(entry) });
  }
  const cliPath = findPaseoCli();
  if (cliPath !== null) candidates.push({ label: `via the paseo CLI at ${cliPath}`, resolve: fromEntry(cliPath) });
  return candidates;
}

/** Explains the one failure a person can fix without reading the code. */
function desktopHint() {
  if (process.versions.electron !== undefined) return "";
  const cliPath = findPaseoCli();
  if (cliPath === null || !existsSync(join(dirname(cliPath), "..", "app.asar"))) return "";
  return ". The paseo CLI is the desktop app's, whose client only its own runtime can load: reload the smart-session plugin so it re-registers this MCP server on that runtime, then restart the Claude Code session";
}

/** Finds `paseo` on PATH and resolves symlinks, the way a shell's `which` would. */
function findPaseoCli() {
  const name = process.platform === "win32" ? "paseo.cmd" : "paseo";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      statSync(candidate);
      return realpathSync(candidate);
    } catch {
      // Not here; keep looking.
    }
  }
  return null;
}

async function callPlugin(method, input) {
  const { DaemonClient } = await loadDaemonClient();
  const password = await resolveDaemonPassword();
  const client = new DaemonClient({
    url: process.env.PASEO_DAEMON_URL ?? "ws://127.0.0.1:6767/ws",
    clientId: "smart-session-mcp",
    clientType: "cli",
    reconnect: { enabled: false },
    connectTimeoutMs: 10_000,
    suppressSendErrors: true,
    ...(password === undefined ? {} : { password }),
  });
  await client.connect();
  try {
    return await client.invokePluginRpc(PLUGIN_ID, method, input);
  } finally {
    try {
      await client.close();
    } catch {
      /* Teardown must not mask the result. */
    }
  }
}

function requireAgent() {
  if (AGENT_ID === null) {
    throw new Error(
      "PASEO_AGENT_ID is not set, so this tool cannot tell which session it belongs to. It only works inside a Paseo agent.",
    );
  }
  return AGENT_ID;
}

const HOURS = (ms) => ms / 3_600_000;

/**
 * Where this session's durable task state lives.
 *
 * Outside the working tree on purpose: a state file inside the repo gets committed
 * by accident, or vanishes with the worktree it was describing. Keyed by agent id,
 * so it survives compaction, `/clear`, and the model forgetting the path.
 */
function statePath() {
  const override = process.env.SMART_SESSION_STATE_FILE;
  if (override !== undefined && override !== "") return override;
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(home, "plugin-data", "smart-session", "state", `${requireAgent()}.md`);
}

/** A deferral is an answer with a deadline, not an escape hatch; hence the cap. */
const DEFAULT_DEFER_MINUTES = 20;
const MAX_DEFER_MINUTES = 60;

const SECTIONS = ["Goal", "Plan", "Current step", "Decisions", "Dead ends", "Key facts"];

/** Sections that accumulate rather than being replaced. */
const APPEND_ONLY = new Set(["Decisions", "Dead ends", "Key facts"]);

function parseState(text) {
  const sections = new Map(SECTIONS.map((name) => [name, []]));
  let current = null;
  for (const line of text.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      current = sections.has(heading[1]) ? heading[1] : null;
      continue;
    }
    if (current !== null) sections.get(current).push(line);
  }
  for (const [name, lines] of sections) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    while (lines.length > 0 && lines[0].trim() === "") lines.shift();
    sections.set(name, lines);
  }
  return sections;
}

function renderState(sections) {
  const parts = [`# Task state`, `_Updated ${new Date().toISOString()}_`, ""];
  for (const name of SECTIONS) {
    const lines = sections.get(name) ?? [];
    parts.push(`## ${name}`, lines.length === 0 ? "_(empty)_" : lines.join("\n"), "");
  }
  return parts.join("\n");
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, "utf8");
  renameSync(temp, path);
}

function stateAgeSeconds(path) {
  try {
    return Math.round((Date.now() - statSync(path).mtimeMs) / 1000);
  } catch {
    return null;
  }
}

function describeRelative(iso) {
  if (iso === null || iso === undefined) return "unknown";
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return "unknown";
  const minutes = Math.round(Math.abs(ms) / 60_000);
  const text = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return ms >= 0 ? `in ${text}` : `${text} ago`;
}

const TOOLS = {
  context_status: {
    description:
      "How full this session's context window is right now, how fast it is filling, and when it will reach the point where quality starts to suffer. Call this when you are deep into a long task, before starting a large new step, or whenever you are deciding whether to keep going or checkpoint.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const agentId = requireAgent();
      const result = await callPlugin("smart-session.context", { agentId });
      const mine = result.agents?.[0];
      if (mine === undefined) {
        return "No context reading for this session yet — it reports one after its first completed turn.";
      }
      const lines = [
        `Context holds ${mine.usedTokens.toLocaleString()} tokens (${mine.usedPct}% of a ${mine.maxTokens.toLocaleString()}-token window). Worth compacting from ${mine.compactAtPct}% (${Math.round(
          (mine.compactAtPct / 100) * mine.maxTokens,
        ).toLocaleString()} tokens).`,
      ];
      if (mine.growthTokensPerHour !== null) {
        lines.push(`Filling at roughly ${Math.round(mine.growthTokensPerHour).toLocaleString()} tokens/hour.`);
      }
      if (mine.usedPct >= mine.compactAtPct) {
        // Already past it: a projection of when it will arrive reads as nonsense.
        lines.push(
          "You are already past that point. Check your task state is on disk and current, then compact at the next clean boundary — call request_compaction when the step you are on is finished.",
        );
      } else if (mine.projectedFullAt !== null) {
        lines.push(
          `At that rate you reach it ${describeRelative(mine.projectedFullAt)}. On a large window that arrives long before the ceiling does: what costs you is the prefix re-read on every turn, not running out of room.`,
        );
      }
      if (mine.costUsd !== null) lines.push(`Session cost so far: $${mine.costUsd.toFixed(2)}.`);

      const path = statePath();
      const age = stateAgeSeconds(path);
      if (age === null) {
        lines.push(
          `No durable task state on disk yet. Call checkpoint before you need it — compacting without it is what loses work.`,
        );
      } else {
        lines.push(`Task state last written ${Math.round(age / 60)}m ago (${path}).`);
      }
      return lines.join("\n");
    },
  },

  budget_status: {
    description:
      "How much of the Claude plan's rolling 5-hour and weekly limits is already consumed, how fast, and when each window resets. Call this before spawning several subagents, before a long autonomous run, or when deciding whether to use a more expensive model.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const result = await callPlugin("smart-session.budget", {});
      if (result.error) return `Could not read plan usage: ${result.error}`;
      const interesting = (result.windows ?? []).filter(
        (window) => window.id === "five_hour" || window.id === "seven_day" || window.pct > 0,
      );
      if (interesting.length === 0) return "No plan-usage reading recorded yet.";

      const lines = interesting.map((window) => {
        const name = window.id === "five_hour" ? "Session (5h)" : window.id === "seven_day" ? "Week" : window.id;
        const parts = [`${name}: ${Math.round(window.pct)}% used`];
        if (window.resetsAt !== null) parts.push(`resets ${describeRelative(window.resetsAt)}`);
        if (window.burnPctPerHour !== null && window.burnPctPerHour > 0) {
          parts.push(`burning ${window.burnPctPerHour.toFixed(1)}%/h`);
        }
        if (window.projectedFullAt !== null) parts.push(`would hit 100% ${describeRelative(window.projectedFullAt)}`);
        return `- ${parts.join(", ")}`;
      });

      const recorder = result.recorder;
      if (recorder?.ageSeconds !== null && recorder?.ageSeconds !== undefined && recorder.ageSeconds > 900) {
        lines.push(
          `(Newest reading is ${Math.round(HOURS(recorder.ageSeconds * 1000) * 10) / 10}h old — treat these as a floor, not a current number.)`,
        );
      }
      return lines.join("\n");
    },
  },

  checkpoint: {
    description:
      "Write this session's durable task state to disk, so that compaction — or a crash, or a handoff — costs nothing. Call it after finishing a plan step, after a subagent returns, and whenever you learn something you would hate to rediscover. Record POINTERS, not payloads: 'src/foo.ts:120 is where the retry lives', never the file's contents. Re-reading a file after compaction is cheap; re-deriving a conclusion is not. Decisions, dead ends and key facts accumulate; goal, plan and current step are replaced.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The task's objective. Set once; only change it if the task itself changed." },
        plan: { type: "string", description: "The steps, with their status. Replaces the previous plan." },
        current_step: {
          type: "string",
          description: "What you are doing right now AND the exact next action, so a fresh reader could continue without guessing.",
        },
        decisions: {
          type: "array",
          items: { type: "string" },
          description: "Decisions made and WHY. Appended, dated. The reason matters more than the decision.",
        },
        dead_ends: {
          type: "array",
          items: { type: "string" },
          description:
            "Approaches tried that did not work, and why. Appended, dated. This is the highest-value section: without it a compacted agent confidently redoes failed work.",
        },
        key_facts: {
          type: "array",
          items: { type: "string" },
          description: "Pointers worth keeping: file:line locations, commands, gotchas. Appended. Pointers, not contents.",
        },
      },
      additionalProperties: false,
    },
    async run(args) {
      const path = statePath();
      const sections = parseState(existsSync(path) ? readFileSync(path, "utf8") : "");
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");

      const replacements = { Goal: args.goal, Plan: args.plan, "Current step": args.current_step };
      for (const [name, value] of Object.entries(replacements)) {
        if (typeof value === "string" && value.trim() !== "") sections.set(name, [value.trim()]);
      }

      const additions = { Decisions: args.decisions, "Dead ends": args.dead_ends, "Key facts": args.key_facts };
      let added = 0;
      for (const [name, values] of Object.entries(additions)) {
        if (!Array.isArray(values)) continue;
        const lines = sections.get(name) ?? [];
        for (const value of values) {
          const text = String(value).trim();
          if (text === "") continue;
          // Key facts are pointers and repeat naturally; a duplicate is noise.
          if (name === "Key facts" && lines.some((line) => line.endsWith(text))) continue;
          lines.push(APPEND_ONLY.has(name) && name !== "Key facts" ? `- [${stamp}] ${text}` : `- ${text}`);
          added += 1;
        }
        sections.set(name, lines);
      }

      writeAtomic(path, renderState(sections));

      const missing = ["Goal", "Current step"].filter((name) => (sections.get(name) ?? []).length === 0);
      const lines = [`Task state written to ${path} (${added} new entr${added === 1 ? "y" : "ies"}).`];
      if (missing.length > 0) {
        lines.push(
          `Still empty: ${missing.join(" and ")}. A state file without those cannot be continued from — fill them on your next checkpoint.`,
        );
      }
      return lines.join(" ");
    },
  },

  request_compaction: {
    description:
      "Ask for this session to be compacted. Nothing compacts a session that has not asked, so this is the only way it happens. The request is delivered as a real /compact once this session goes idle — never mid-turn — with instructions steering what the summary must keep. Choose whether Paseo should start another turn afterwards: continue when work remains, or do not continue when the task is finished. Write your durable task state with checkpoint FIRST: this refuses to queue anything while the state on disk is missing or older than the work it describes.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why compacting now is the right call, in one sentence. This is quoted into the instructions.",
        },
        state_path: {
          type: "string",
          description:
            "Absolute path to the file holding this task's durable state (goal, current step, decisions, dead ends). Strongly recommended.",
        },
        continue_after_compaction: {
          type: "boolean",
          description:
            "Whether Paseo should send a follow-up that starts another model turn after compaction. Defaults to true for compatibility. Set false when the task is finished.",
        },
        continue_message: {
          type: "string",
          description:
            "Exact follow-up message to send after compaction when continuing. Omit to use the default instruction to re-read the state file and carry on.",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    async run(args) {
      const agentId = requireAgent();
      const settings = readSettings();
      if (!settings.enabled) {
        return "Smart Compact is switched off for this Paseo install, so nothing would deliver this request. Compact by hand if you need to, or ask the user to turn Smart Compact on in the Smart Session surface.";
      }

      // Default to this session's own state file: the whole point is that the
      // continuation has something authoritative to read, and the agent should not
      // have to remember a path to get that.
      const path = args.state_path === undefined ? statePath() : String(args.state_path);

      // Persist, then compact. The other order is how you lose the work — so this
      // refuses rather than queueing, because refusing costs one tool call and the
      // agent can fix it in the same turn, where the old design spent a whole extra
      // turn on the plugin asking for the same thing.
      const age = stateAgeSeconds(path);
      if (age === null) {
        return [
          `Not queued: there is no task state at ${path}, and compacting without it is exactly how a task gets lost.`,
          "Call checkpoint first — goal, the step in progress and its exact next action, decisions and why, and every approach already tried and rejected — then call request_compaction again.",
        ].join(" ");
      }
      if (age > settings.freshStateMinutes * 60) {
        return [
          `Not queued: ${path} was last written ${Math.round(age / 60)} minutes ago, so it probably predates the work you are about to discard.`,
          "Call checkpoint to bring it up to date, then call request_compaction again.",
        ].join(" ");
      }

      const continueAfterCompaction = args.continue_after_compaction !== false;
      const continueMessage = typeof args.continue_message === "string" ? args.continue_message : "";
      const result = await callPlugin("smart-session.compact.request", {
        agentId,
        reason: String(args.reason ?? "no reason given"),
        statePath: path,
        continueAfterCompaction,
        continuationMessage: continueAfterCompaction && continueMessage.trim() !== "" ? continueMessage : null,
      });
      const queued = result.request;
      const lines = [
        `Compaction queued (${queued.id.slice(0, 8)}). It will be delivered as soon as this session is idle — so finish the turn you are in and stop.`,
      ];
      if (!queued.continueAfterCompaction) {
        lines.push("No follow-up will be sent after the compaction lands.");
      } else if (queued.continuationMessage !== null) {
        lines.push("After it lands, the continuation message you supplied will start the next turn.");
      } else {
        lines.push(
          `The continuation will be told to re-read ${queued.statePath} and to trust it over the summary, and to carry on from its "Current step" section.`,
        );
      }
      return lines.join("\n");
    },
  },

  defer_compaction: {
    description:
      "Decline to compact for now, and say why. Use this when Smart Compact has asked and this is the wrong moment — a refactor half applied, a tool sequence not finished, an answer the user is waiting on. You will not be asked again until the deferral runs out. This is a real answer, not a way of ignoring the question: the context keeps growing while it is in force.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why now is the wrong moment, in one sentence. Recorded as your answer.",
        },
        minutes: {
          type: "number",
          description: `How long to hold off, in minutes. Capped at ${MAX_DEFER_MINUTES}; defaults to ${DEFAULT_DEFER_MINUTES}.`,
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    async run(args) {
      requireAgent();
      const asked = Number(args.minutes);
      const minutes = Math.min(
        MAX_DEFER_MINUTES,
        Math.max(1, Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_DEFER_MINUTES),
      );
      const reason = String(args.reason ?? "no reason given");
      const until = defer(null, minutes, reason);
      const ledger = readLedger(null);
      return [
        `Deferred for ${minutes} minutes (until ${until}). You will not be asked again before then.`,
        ledger.askCount >= 2
          ? "This is not the first time this session has put it off, and the window has kept filling the whole while. If the moment does not arrive soon, checkpoint and compact anyway — the alternative is Claude Code's own auto-compact firing with no instructions and no pointer to your state file."
          : "When the step you are on is finished, call checkpoint and then request_compaction.",
      ].join("\n");
    },
  },
};

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
