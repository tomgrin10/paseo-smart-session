/**
 * Smart Session's agent tools, independent of how they reach the agent.
 *
 * Two transports share this: Paseo 0.15+ serves them natively through each agent's own Paseo
 * MCP (server/native-tools.ts, calls run in the plugin process and the caller's id comes from the
 * daemon), and `mcp.mjs` is the per-launch stdio fallback (identity from `PASEO_AGENT_ID`).
 * `context.call` reaches the plugin's RPCs: in-process for the first, over the daemon for the second.
 *
 * Dependency-free, like the hooks: `mcp.mjs` runs it from a checkout with no node_modules.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { named, readSettings } from "./hooklib/context.mjs";
export { named };
import { defer, readLedger } from "./hooklib/asks.mjs";

/** The tools that act on the calling session and need its agent id. */
export const AGENT_SCOPED = new Set(["context_status", "checkpoint", "request_compaction", "defer_compaction"]);

/**
 * @param {{ agentId: string | null, call: (method: string, input: unknown) => Promise<any>, home?: string, stateFile?: string }} context
 */
export function agentTools(context) {
  const AGENT_ID = context.agentId;
  const callPlugin = context.call;
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
    const override = context.stateFile ?? process.env.SMART_SESSION_STATE_FILE;
    if (override !== undefined && override !== "") return override;
    const home = context.home ?? process.env.PASEO_HOME ?? join(homedir(), ".paseo");
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

  /**
   * Which account `budget_status` describes, when ZeroSub runs agents on several.
   *
   * Without ZeroSub the RPC sends no `account`, and nothing changes. A label is shown
   * only when the person chose it; ZeroSub's generated labels come from the email.
   */
  function accountLines(account) {
    if (account === undefined || account === null) return { head: [], tail: [], fromRecorder: true };
    const name = account.label === null ? "" : ` "${account.label}"`;
    const head = [
      account.kind === "main"
        ? `Account: the CLI's own Claude login${name} (ZeroSub routes this session there).`
        : `Account: a Claude account ZeroSub added${name}, not the CLI login. These numbers are ZeroSub's reading of it${
            account.readAt === null ? " (none yet)" : `, taken ${describeRelative(account.readAt)}`
          }; there is no pace history for it.`,
    ];
    const tail = [];
    const others = account.otherAccountsWithRoom;
    if (account.autoSwitch && others > 0) {
      tail.push(
        `ZeroSub has ${others} other Claude account${others === 1 ? "" : "s"} with room and moves this session to one when this account hits a limit, so a full window here is not a reason to stop early.`,
      );
    }
    return { head, tail, fromRecorder: account.kind === "main" };
  }

  /**
   * All of this provider's ZeroSub subscriptions together, when there are several:
   * how long they last at this pace and which takes over next. Names are the person's
   * own or neutral ("CLI login", "Account 2"); the RPC never carries an email.
   */
  function poolLines(pool) {
    if (pool === undefined || pool === null) return [];
    const fam = pool.family === "codex" ? "Codex" : "Claude";
    const stale = pool.staleReadings > 0 ? ` (${pool.staleReadings} reading${pool.staleReadings === 1 ? " is" : "s are"} over 30 min old, so this is rough)` : "";
    const head = `All ${pool.accounts} ${fam} subscriptions: ${pool.withRoom} with room now`;
    if (pool.runsOutAt !== null && Date.parse(pool.runsOutAt) <= Date.now()) {
      return [`${head}. Every one is at a limit${pool.back ? `; ${pool.back.name} is back ${describeRelative(pool.back.at)}` : ""}${stale}.`];
    }
    const next = pool.next ? ` ${pool.next.name} takes over ${describeRelative(pool.next.at)}.` : "";
    if (pool.runsOutAt !== null) {
      return [`${head}. At the current pace (${pool.pacePctPerHour}%/h of a session window) they run out ${describeRelative(pool.runsOutAt)}${pool.back ? `, and ${pool.back.name} is back ${describeRelative(pool.back.at)}` : ""}.${next}${stale}`];
    }
    if (pool.pacePctPerHour !== null) return [`${head}. At the current pace they last the next 24 hours.${next}${stale}`];
    return [`${head}${stale}.`];
  }

  /**
   * Session Guard's word on this session, for `budget_status`.
   *
   * Read-only, and only for the session asking: the plugin resolves it from
   * `PASEO_AGENT_ID`, never from anything the model passes. A failure here costs the
   * extra line, not the budget answer.
   */
  async function guardSummary() {
    if (AGENT_ID === null) return [];
    try {
      const result = await callPlugin("smart-session.guard.agent", { agentId: AGENT_ID });
      return Array.isArray(result?.summary) ? result.summary.filter((line) => typeof line === "string") : [];
    } catch {
      return [];
    }
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
        const upper = typeof mine.compactNowAtPct === "number" ? mine.compactNowAtPct : null;
        if (upper !== null) {
          lines.push(
            `Its upper line is ${upper}% (${Math.round((upper / 100) * mine.maxTokens).toLocaleString()} tokens): past that, Smart Compact asks right away, mid-turn, and you should not start new work before compacting.`,
          );
        }
        if (upper !== null && mine.usedPct >= upper) {
          lines.push(
            "You are past the upper line. Finish only the step you are on, call checkpoint, call request_compaction with continue_after_compaction true, and end your turn.",
          );
        } else if (mine.usedPct >= mine.compactAtPct) {
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
        "How much of the Claude plan's rolling 5-hour and weekly limits is already consumed, how fast, and when each window resets — and, inside Paseo, whether Session Guard will pause this session at the session limit and continue it after the reset. Call this before spawning several subagents, before a long autonomous run, or when deciding whether to use a more expensive model.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() {
        const result = await callPlugin("smart-session.budget", AGENT_ID === null ? {} : { agentId: AGENT_ID });
        if (result.error) return `Could not read plan usage: ${result.error}`;
        const guard = await guardSummary();
        const account = accountLines(result.account);
        account.tail.push(...poolLines(result.pool));
        const interesting = (result.windows ?? []).filter(
          (window) => window.id === "five_hour" || window.id === "seven_day" || window.pct > 0,
        );
        if (interesting.length === 0) return [...account.head, "No plan-usage reading recorded yet.", ...account.tail, ...guard].join("\n");

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

        lines.unshift(...account.head);
        lines.push(...account.tail);
        const recorder = result.recorder;
        if (account.fromRecorder && recorder?.ageSeconds !== null && recorder?.ageSeconds !== undefined && recorder.ageSeconds > 900) {
          lines.push(
            `(Newest reading is ${Math.round(HOURS(recorder.ageSeconds * 1000) * 10) / 10}h old — treat these as a floor, not a current number.)`,
          );
        }
        lines.push(...guard);
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
          return "Smart Compact is switched off for this Paseo install, so nothing would deliver this request. Compact by hand if you need to, or ask the user to turn Smart Compact on in the Smart Session screen or Settings → Plugins → Smart Session.";
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
        const until = defer(null, minutes, reason, AGENT_ID);
        const ledger = readLedger(null, AGENT_ID);
        return [
          `Deferred for ${minutes} minutes (until ${until}). You will not be asked again before then.`,
          ledger.askCount >= 2
            ? "This is not the first time this session has put it off, and the window has kept filling the whole while. If the moment does not arrive soon, checkpoint and compact anyway — the alternative is Claude Code's own auto-compact firing with no instructions and no pointer to your state file."
            : "When the step you are on is finished, call checkpoint and then request_compaction.",
        ].join("\n");
      },
    },
  };

  return TOOLS;
}

/** Name, description and JSON Schema of each tool, for listing. */
export const TOOL_SHAPES = Object.entries(agentTools({ agentId: null, call: async () => ({}) }))
  .map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema }));
