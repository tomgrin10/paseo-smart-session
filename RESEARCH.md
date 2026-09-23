# Research: what the platform actually exposes

Verified 2026-09-05 against Claude Code **2.1.261** (`~/.local/share/claude/versions/2.1.261`,
strings-extracted from the compiled bundle), the Paseo checkout at
`~/Projects/paseo-later/paseo` (`fa1f01ebb`, post-0.5.2 — installed Paseo is newer, re-verify
before coding), and the working `paseo-defer` plugin at `~/Projects/paseo-later/paseo-defer`.

Everything below is a *checked* fact with its evidence. Anything I could not verify is in
§8 Still open, not asserted here.

---

## 1. Plan usage (the 5-hour / weekly windows)

### 1.1 Upstream source
Claude Code calls **`GET /api/oauth/usage?at_wall=1&skip_spend=1`** (string present in the 2.1.261
bundle). Auth is the OAuth access token from macOS keychain service **`Claude Code-credentials`**,
with beta header `oauth-2025-04-20`.

Response shape (Paseo's parser, `packages/server/src/services/quota-fetcher/providers/claude.ts:38-70`):

```jsonc
{
  "five_hour":        { "utilization": <num>, "resets_at": "<iso>" },
  "seven_day":        { ... },
  "seven_day_opus":   { ... },
  "seven_day_omelette": { ... },
  "limits": [ { "kind": "weekly_scoped", "percent": <num>, "resets_at": "<iso>",
                "scope": { "model": {...}, "surface": {...} } } ],
  "extra_usage": { "is_enabled": <bool> }
}
```

The live payload on this machine (below) also carries `seven_day_sonnet`, `seven_day_cowork`,
`seven_day_oauth_apps`, `nimbus_quill`, `tangelo`, `omelette_promotional`, and per-window
`limit_dollars` / `used_dollars` / `remaining_dollars` / `locked_reason`.
**Store the window map generically — do not hardcode two windows.**

### 1.2 Three local read paths, no history in any of them

| # | Source | Freshness | Works when | Cost |
|---|---|---|---|---|
| A | `~/.claude.json` → `cachedUsageUtilization` | `fetchedAtMs` stamped; refreshed by any running Claude Code | any CC session, Paseo or not | free, `fs.watch`-able |
| B | Paseo daemon `client.listProviderUsage()` | on demand, daemon fetches upstream | Paseo daemon running | one upstream call, cache it |
| C | statusline JSON `rate_limits` | every statusline render | interactive TUI only | free |

Live sample of A on this machine:
```jsonc
{ "fetchedAtMs": 1788558890772, "accountUuid": "…",
  "utilization": { "five_hour": { "utilization": 26, "resets_at": "2026-09-05T01:09:59.873850+00:00",
                                  "limit_dollars": null, … },
                   "seven_day": { "utilization": 3, … }, … } }
```

**Scale warning:** this file reports `26` / `3` (0–100), while the statusline builder computes
`five_hour.used_percentage = utilization * 100` (0–1). Normalize at ingest and clamp; don't trust
one convention.

**None of these persist history.** `packages/server/src/services/quota-fetcher/` has
`manifest / provider / providers / service / usage` and no store. `/usage` is a snapshot.
→ *History has to be recorded from now on. Every day without a recorder is a day permanently lost.*

### 1.3 What can be backfilled
`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` — one JSON object per line. Assistant lines carry:

```jsonc
{ "type":"assistant", "timestamp":"…Z", "sessionId":"…", "requestId":"req_…", "uuid":"…",
  "cwd":"…", "gitBranch":"…", "version":"2.1.261", "entrypoint":"sdk-cli", "effort":"high",
  "isSidechain":false, "apiBlockIndex":0,
  "message": { "model":"…", "usage": { "input_tokens", "cache_creation_input_tokens",
      "cache_read_input_tokens", "output_tokens",
      "output_tokens_details": { "thinking_tokens" },
      "cache_creation": { "ephemeral_1h_input_tokens", "ephemeral_5m_input_tokens" },
      "service_tier", "speed" } } }
```

So token spend is reconstructible per minute / session / model / workspace, and
`isSidechain: true` separates subagent burn from main-thread burn. Dedupe on `requestId`
(resumed and forked sessions replay lines). This gives *tokens* retroactively, not *utilization %* —
those two are joined by calibration (see PLAN §2.3).

`~/.claude/stats-cache.json` has daily message/session/tool counts back to 2026-05 — coarse, but a
free sanity check for the backfill.

---

## 2. Context-window telemetry

### 2.1 Paseo already computes it
- `AgentUsage` in `packages/protocol/src/messages.ts:422-429` carries **`contextWindowUsedTokens`**
  and **`contextWindowMaxTokens`** alongside token/cost fields.
- It is projected onto the agent record as `lastUsage`
  (`packages/server/src/server/agent/agent-projections.ts:484`;
  `daemon-e2e/claude-live-usage.e2e.test.ts:169` asserts `snapshot.lastUsage.contextWindowUsedTokens`).
- Produced by `ClaudeContextUsageState` in `providers/claude/agent.ts` (`buildStreamUsageEvent`,
  `buildResultUsage`, `buildCompactionUsageEvent`).

→ A daemon-side plugin can read live context fill **per agent** without parsing a single transcript.
`PluginAgentSnapshot` in the public plugin SDK does **not** expose it (`paseo-plugin.d.ts:172-190`),
so this needs the same borrowed-daemon-client trick `paseo-defer` already uses for
`provider.usage.list` (`paseo-defer/daemon.server.ts:9-40`).

### 2.2 Claude Code's own numbers
Statusline stdin JSON (built in the 2.1.261 bundle) contains:
```jsonc
{ "session_id", "model", "workspace", "agent": {"name"}, "output_style",
  "cost": { "total_cost_usd", "total_duration_ms", "total_api_duration_ms",
            "total_lines_added", "total_lines_removed" },
  "context_window": { "total_input_tokens", "total_output_tokens", "context_window_size",
                      "current_usage", "used_percentage", "remaining_percentage" },
  "exceeds_200k_tokens": <bool>,
  "prompt_cache": { "warm", "ttl", "expires_at", "requests", "misses", "hit_ratio",
                    "cache_write_tokens", "miss_recache_tokens", "last_miss_cause": {"causes": […]},
                    "miss_causes", "recache_tokens_if_cold" },
  "rate_limits": { "five_hour": {"used_percentage","resets_at"},
                   "seven_day": {…}, "spend_limit": {…} } }
```
`last_miss_cause.causes` is drawn from a labelled set: `system_prompt_changed`, `tools_changed`,
`model_changed`, `fast_mode_changed`, `cache_scope_or_ttl_changed`, `betas_changed`,
`effort_changed`, `auto_mode_changed`, `overage_changed`, `extra_body_changed`. That is a
ready-made "why did my cache die" diagnostic.

Statusline is a TUI surface; Paseo-driven sessions run `entrypoint: "sdk-cli"` (confirmed in this
session's own transcript), so **do not build the core on statusline** — treat it as a bonus source
for hand-run terminal sessions.

### 2.3 Transcript fallback (provider-agnostic, always available)
Last assistant line's `usage`: `input_tokens + cache_read_input_tokens +
cache_creation_input_tokens (+ output_tokens)` ≈ current context occupancy. `SessionStart` describes
exactly this formula for its `context_tokens` field (§3.2), so it is the sanctioned arithmetic.

### 2.4 Client → CLI control requests (for whoever drives the CLI)
Control-request subtypes in the bundle include **`get_context_usage`** (`detail: "summary" | "full"`
— "'full' counts each category with the token-count API; 'summary' answers from the last response's
usage"), **`get_usage`** ("structured /usage data … plus claude.ai plan rate-limit utilization",
`skip_behaviors` to skip the 7-day transcript scan), `get_session_cost`, plus `interrupt`,
`set_model`, `set_permission_mode`, `stop_task`, `background_tasks`, `rewind_files`, `get_plan`.

**There is no `compact` control request.** Compaction is reached by the slash command (§4).

---

## 3. Claude Code hooks — the full surface in 2.1.261

_§3.1–3.3 were measured against 2.1.261; §3.4 re-checks the parts that matter against 2.1.263._

### 3.1 Events (33, well beyond the public docs)
`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `UserPromptSubmit`,
`UserPromptExpansion`, `Notification`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`,
`PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `Setup`, `TaskCreated`, `TaskCompleted`,
`TeammateIdle`, `PreModelSwitch`, `PostModelSwitch`, `PermissionRequest`, `PermissionDenied`,
`Elicitation`, `ElicitationResult`, `ConfigChange`, `InstructionsLoaded`, `FileChanged`,
`DirectoryAdded`, `CwdChanged`, `WorktreeCreate`, `WorktreeRemove`, `MessageDisplay`.

### 3.2 Payloads that matter here
Every hook gets the base object: `session_id`, `transcript_path`, `cwd`, `prompt_id` (correlates all
events from one user prompt; matches the OTel `prompt.id`), `permission_mode`, `agent_id`
(*present only inside a subagent*).

- **`PreCompact`** — `{ trigger: "manual"|"auto", custom_instructions: string|null }`
- **`PostCompact`** — `{ trigger, compact_summary }` ← the summary text itself
- **`SessionStart`** — `{ source: "startup"|"resume"|"clear"|"compact"|"fork", agent_type?, model?,
  session_title?, seconds_since_last_response?, context_tokens?, prompt_cache_likely_expired? }`
  `context_tokens` = "the resumed transcript's last response input + cache_read + cache_creation +
  output tokens". **A session restarted by compaction announces itself here.**
- **`Stop`** — `{ stop_hook_active, last_assistant_message?, background_tasks[], session_crons[] }`
  (`background_tasks` distinguishes "done" from "paused waiting on background work" — the governor
  must not compact while work is in flight)
- **`SubagentStop`** — `{ agent_id, agent_transcript_path, agent_type, last_assistant_message?, … }`
- **`TaskCompleted`**, **`PostToolBatch`** — natural task boundaries.

### 3.3 Hook output contract
```jsonc
{ "systemMessage": "shown to the user",
  "continue": false, "stopReason": "…",
  "suppressOutput": false,
  "decision": "block", "reason": "…",          // PostToolUse / Stop / UserPromptSubmit
  "hookSpecificOutput": { "hookEventName": "PostToolUse",
                          "additionalContext": "text injected into model context",
                          "permissionDecision": "allow|deny|ask",   // PreToolUse
                          "updatedInput": {…} } }                   // PreToolUse
```
`additionalContext` is the injection channel: **this is how the agent gets told how full it is.**
`decision:"block"` on `Stop` forces the model to keep going with `reason` as its instruction.

**Not every event can inject, and the event list is not the output list.** `hookSpecificOutput` is a
discriminated union and `hookEventName` is validated against it; an unlisted name fails the *whole*
output, so the hook silently injects nothing. Extracted from the 2.1.261 binary
(`hookEventName:k("…")`), the union is: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
`PostToolBatch`, `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `Setup`, `Stop`,
`SubagentStart`, `SubagentStop`, `Notification`, `MessageDisplay`, `PermissionRequest`,
`PermissionDenied`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`,
`FileChanged`, `CwdChanged`, `WorktreeCreate`. **`PreCompact` and `PostCompact` are absent** — they
fire, and they can record, but they cannot speak to the model. Observed in production as
`Hook JSON output validation failed`.

The way in after a compaction is therefore `SessionStart`, whose output variant is
`{ additionalContext, initialUserMessage, sessionTitle, watchPaths, reloadSkills }` and whose matcher
matches `source` (`case "SessionStart": return e.source`). **Measured on two real compactions:**
`SessionStart` with `source: "compact"` does fire on in-session compaction, ~55ms *before*
`PostCompact` (07:52:18.574 vs .629), and its `additionalContext` lands in the transcript as
`hook_success` + `hook_additional_context`.

---

### 3.4 Asking, and resuming — measured against 2.1.263 (2026-09-07)

Everything here was checked twice: extracted from the binary's Zod schemas, then run against a
throwaway session with logging hooks. Three of the four answers were the opposite of what the
schema alone suggested, which is why the second half matters.

**`Stop` can ask, and it does not need `decision: "block"` to do it.** The `Stop` variant of
`hookSpecificOutput` carries `additionalContext` and describes itself:

> "Hook-specific output for the `Stop` event. `additionalContext` is non-error feedback delivered to
> the model; **the conversation continues so the model can act on it**."

Confirmed live: a `Stop` hook returning `additionalContext` of *"say exactly
ACKNOWLEDGED-CONTEXT-87"* produced a session whose final result was `ACKNOWLEDGED-CONTEXT-87`. So the
ask rides the agent's own turn, arrives at a real boundary, and costs no separate message.

**`stop_hook_active` is real and required.** Observed `false` on the first call and `true` on the
continuation the hook itself caused. Claude Code enforces a ceiling independently:
`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? 8`, after which it ends the turn with *"a hook blocked the turn
from ending N consecutive times — overriding … check `stop_hook_active` in the input"*.

**`initialUserMessage` on `SessionStart` cannot resume a compacted session.** The field exists on the
schema, but the only consumer is the CLI bootstrap — `let qr = WVn(); if (qr) le.prependUserMessage(qr)`
— and `WVn()` reads a `pendingInitialUserMessage` that nothing else touches. Live test: the hook fired
with `source: "compact"`, returned `initialUserMessage`, and the run reported `num_turns: 0` with an
empty result. Its `additionalContext` from the same output *did* land. So the pointer works; the
resume does not.

**`Stop` does not fire after a `/compact`.** With all four hooks installed, a compaction produced
`SessionStart:compact` and then `PostCompact`, and no `Stop` at all — a command runs no model turn, so
there is no turn end to fire on.

Taken together: **no hook can restart a task after a compaction.** `PostCompact` cannot inject,
`SessionStart:compact` injects but starts nothing, `Stop` never runs. The resume has to be a message
from the plugin, and that is the only reason one exists.

**And the task really does stop.** Across 190 compactions in this machine's own transcripts (189 of
them `trigger: "manual"`), 163 halted and waited for a person; only 16 continued on their own.

**`compact_boundary.trigger` is `"manual" | "auto"` and nothing else** — a `/compact` Paseo sent is
indistinguishable from one a person typed. Telling an agent-mandated compaction from a human one
therefore has to be done by correlating against the plugin's own queue, not by reading the trigger.


## 4. Triggering compaction

- `/compact [instructions]` is a **root-only** command; Paseo knows it and forwards it:
  `CLAUDE_ROOT_ONLY_COMMANDS = { clear, compact, context, debug, extra-usage, heapdump, init, loop,
  schedule, usage }` — `packages/server/src/server/agent/providers/claude/agent.ts:353-363`.
  Paseo parses slash invocations (`SlashCommandInvocation { commandName, args, rawInput }`, same file).
- `paseo-defer` already delivers arbitrary message text to a chosen agent **when that agent goes idle**
  (`engine.server.ts`, `send`/deliver path). Sending `/compact <instructions>` is the same operation
  with different text. **This is the mechanism that lets an agent compact itself.**
- Paseo observes the result: `compact_boundary` system message → `{ trigger: manual|auto, preTokens,
  postTokens }`, surfaced as a `compaction` timeline item and a context-usage event
  (`providers/claude/agent.ts:4248-4270`). So the plugin can measure every compaction's
  before/after and score its own policy.

### 4.1 Auto-compact controls (worth owning rather than fighting)
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW=<tokens>` env var, or the **`autoCompactWindow`** setting —
  "Auto-compact summarizes the conversation when context usage approaches this limit. The actual
  threshold is the minimum of this setting and your model's maximum context window."
- Related: `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_DISABLE_1M_CONTEXT`, and the bundle's note
  that you "append `[1m]` to the model name for 1M" (this account runs `opus[1m]`).
- Claude Code already detects the pathology the plan is meant to prevent:
  > "Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous
  > compact, 3 times in a row."
  and warns "Autocompact will trigger soon, which discards older messages. Use /compact now to
  control what gets kept."

---

## 5. Paseo plugin capabilities (from `paseo-defer`'s working code)

Contribution points in `paseo-plugin.d.ts`: `handle(contract, handler)` (daemon RPC),
`addSurface`, `addSidebarItem`, `addWorkspacePanel` (`context: "workspace" | "agent"`),
`addCommandCenterItem`, `addAttachmentSource`, `addTheme`, composer pills, timeline renderers
(`PluginTimelineItem` / `PluginTimelineRendererContribution`), `useAgent` / `useWorkspace` /
`useRpc` / `usePaseo` hooks, `PluginIcon`, `Modal`, `useToast`.

Bundle split: `*.server.ts` (daemon) / `*.client.tsx` (app) / `*.shared.ts`, AST-stripped at compile.
Plugin data goes to `$PASEO_HOME/plugin-data/<id>/` (defaults `~/.paseo`).
Plugins are **trusted, unsandboxed** code on the daemon machine.

The public SDK exposes neither `provider.usage.list` nor agent context usage; `paseo-defer` borrows
the host's own daemon client at runtime (`daemon.server.ts:9-40`, with an explicit error message when
the host doesn't expose it). That keeps the protocol version identical to the daemon's and avoids
bundling deps — and it is the known-brittle seam to isolate behind one module.

### 5.1 Agent-directory observations (Paseo 0.9)

`client.paseo.agents.subscribe()` is only a local listener over observations the same API instance
already owns. A plain `agents.list()` is a snapshot and creates no observation, so it cannot discover
agents created afterward. A directory-following contribution must call
`agents.list({ subscribe: {}, signal })`, consume the returned subscription's replacement snapshots
and updates, and abort or release it at teardown. The pinned v0.8 client returns no owned handle, but
does emit the subscribed directory through the local listener; keeping that listener until a handle
is returned preserves compatibility. Source: Paseo's SDK events reference and local-plugin example,
checked 2026-09-23.

---

## 6. Facts that shape the design

1. **Utilization history does not exist anywhere.** Recording must start before analysis can.
2. **Tokens are backfillable; percentages are not.** They join by calibration.
3. **Context fill is already computed by Paseo per agent** — no transcript parsing needed on the hot path.
4. **The agent cannot run `/compact` itself, but something else can send it one** — and Paseo already
   has both the delivery path and the wait-for-idle logic.
5. **`additionalContext` is a zero-cost-until-needed channel** for telling the agent its own state.
6. **This account runs `opus[1m]`.** Every threshold must come from `contextWindowMaxTokens`
   (1M), never a hardcoded 200k. At 1M, the failure mode isn't "context runs out" — it's that every
   turn re-reads a giant cached prefix and quality decays long before the ceiling.
7. **`compact_boundary` gives pre/post token counts**, so the system can grade its own compactions.

---

## 7. Verified by experiment, 2026-09-05 (Paseo 0.7.2)

**1. `/compact` sent through Paseo really compacts a live agent — confirmed.**
A scratch agent (`claude/claude-sonnet-5`) was driven to 39,325 context tokens, then sent
`client.sendMessage(agentId, "/compact Keep the poems' filenames …")`. Its transcript recorded

```text
<command-name>/compact</command-name>
<command-args>Keep the poems' filenames and the fact that both were written. Discard their text.</command-args>
<local-command-stdout>Compacted </local-command-stdout>
```

followed by "This session is being continued from a previous conversation…". Context went
**39,325 → 6,160 tokens**. Custom instructions are honoured, so compaction can be *steered* by
whatever queues it. This was the load-bearing assumption of the whole Governor half; it holds.

**2. Per-agent context usage is readable from a plugin — confirmed.**
`client.fetchAgents()` -> `entries[].agent.lastUsage`:
```json
{"inputTokens":16,"cachedInputTokens":285979,"outputTokens":1862,"totalCostUsd":0.1302038,
 "contextWindowMaxTokens":1000000,"contextWindowUsedTokens":39325}
```
`lastUsage` rides on the agent **snapshot** (`entries[].agent`), not on the leaner list-item shape,
which carries no usage at all. Post-compaction it reported 6,160 — so a compaction can be *graded*
by the same call that triggered it.

**3. The daemon client is reachable the same way in 0.7.2.**
`@getpaseo/client@0.7.2` inside `/Applications/Paseo.app/Contents/Resources/app.asar` still exports
the `./internal/daemon-client` subpath; `paseo-defer`'s assembled-specifier `require` works unchanged.

**4. `listProviderUsage()` returns `{ requestId, fetchedAt, providers[] }`.**
Windows are `{ id, label, usedPct (0-100, nullable), remainingPct, resetsAt, runsOutAt, shortfallPct,
tone }` — **there is no `utilization` field on this path**; the upstream fraction is converted by
`windowFromUsedPct` before it reaches a client. Claude window ids: `five_hour` ("Session"),
**`weekly`** (renamed from upstream `seven_day`), and scoped `weekly_model_<id>` /
`weekly_surface_<id>`. So the plan week has three names across three sources — `seven_day`,
`weekly_all`, `weekly` — and they must be folded onto one id or a week of history splits in three.

**5. The daemon caches provider usage for 5 minutes and stamps it.**
`ProviderUsageService.listUsage()` refetches upstream past a 5-minute TTL and returns the instant it
fetched. There is no `forceRefresh` on the wire. So this path is never more than 5 minutes stale and
always says how stale it is — which is what makes it the authoritative source rather than
`~/.claude.json`, whose cache only refreshes when a Claude Code session refreshes it (in practice,
when someone runs `/usage`; observed 14h stale here).

**6. Paseo persists no usage history on disk.**
`~/.paseo/agents/<cwd-slug>/<uuid>.json` holds agent metadata only — no `lastUsage`, no token counts,
no event log — and `agent-timeline-store` is purely in-memory. Backfill must come from Claude's own
transcripts, joined via each agent record's `persistence.sessionId`.

**7. Paseo's local web UI is off by default.** The daemon mounts it on the same listener
(`http://127.0.0.1:6767`) but gates it behind `features.webUi.enabled`; unset here, so `/` returns
404. Enabling it means editing daemon config, which needs the user's say-so.

## 7a. Freshness, measured (2026-09-05)

The user's instinct was right: what Paseo *displays* can be stale well beyond its
5-minute TTL, and Claude Code's cache is far worse.

| Source | five_hour | seven_day | age at read |
|---|---|---|---|
| Direct `GET /api/oauth/usage` | 32% | 10% | 0s |
| Paseo daemon `listProviderUsage()` | 32% | 10% | **4m32s** |
| `~/.claude.json` → `cachedUsageUtilization` | 26% | 3% | **14h09m** |

- **The daemon is honest but bounded.** `DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS = 5 * 60 * 1000`;
  `fetchedAt` is the instant of the *upstream* fetch, not the cache read, so it is a truthful age
  marker. On a failed fetch it returns an `unavailable` marker and caches *that* — it never serves a
  stale-but-plausible number. Nothing refreshes on a timer: a second probe 165s later showed
  `fetchedAt` advancing by exactly 300.007s, i.e. the probe itself triggered the refetch.
- **`forceRefresh` exists in the service but is unreachable.** It is not in
  `ProviderUsageListRequestMessageSchema`, and the handler calls `listUsage()` with no arguments.
  A client cannot ask for a fresh reading.
- **The unbounded staleness is in Paseo's UI, not the daemon.** `useProviderUsage` sets
  `staleTime: 3e5` with **no `refetchInterval`**, `refetchOnWindowFocus: false` and
  `refetchOnReconnect: false`. A mounted usage panel never refetches on its own — the number is
  frozen at mount time indefinitely. That is the answer to "sometimes it's not the freshest", and it
  is worth reporting upstream: the fix is a `refetchInterval` on that hook.
- **Consequence for this plugin:** it fetches `https://api.anthropic.com/api/oauth/usage` itself
  (credentials from `~/.claude/.credentials.json`, else keychain `Claude Code-credentials`), keeps
  Paseo as the free secondary, and only falls back to Claude Code's cache when nothing live has
  answered for 15 minutes.

## 7b. Subagent spend is not in `~/.claude/projects`

Zero transcripts under `~/.claude/projects` contain `"isSidechain":true`. Subagent transcripts live
at `/tmp/claude-<uid>/<project-slug>/<session-id>/tasks/<agentId>.output` — same JSONL shape, with
`isSidechain: true`, `agentId`, and full per-message `usage`.

Any token accounting that reads only `~/.claude/projects` — which is the usual approach — therefore
**misses subagent spend entirely**. Measured here: 5.0M tokens across 20 hourly buckets that would
otherwise be invisible. And because they live in the temp directory they are periodically purged,
so this history is shallow and getting shallower — another reason the live recorder matters.

## 7c. Scoping an MCP server to Paseo sessions

- Paseo drives Claude Code through `@anthropic-ai/claude-agent-sdk` and passes `mcpServers` as an SDK
  option, which the SDK lowers to `--mcp-config <inline JSON>`. It sets
  `settingSources: ["user","project","local"]` and **never sets `strictMcpConfig`**, so user-scope
  servers from `~/.claude.json` *are* loaded inside Paseo agents.
- **`~/.paseo/config.json` → `agents.providers.claude.command`** replaces the argv entirely
  (`ProviderOverrideSchema`; the old `mode:"append"` form is now silently dropped). A wrapper script
  that appends `--mcp-config` is therefore the one genuinely Paseo-scoped mechanism. It needs a
  daemon restart, and it must pass `--version` through untouched, because Paseo probes the binary
  that way.
- **No env var adds MCP servers** to Claude Code, `settings.json` has no `mcpServers` key, and
  `managedMcpServers` accepts only `http`/`sse` — never a stdio program.
- **A zero-tool MCP server costs no tokens.** 2.1.261 defers MCP tool loading: tools appear as bare
  names until something asks for a schema, and the `# MCP Server Instructions` block is emitted only
  for servers that return `instructions` at initialize. So gating `tools/list` on the environment is
  a real scoping mechanism, not a compromise — the residual cost is one node process per session.

## 8. Still open

1. Whether `client.waitForFinish(agentId, timeout)` is a better idle-wait than polling agent status
   (paseo-defer polls on a 15s tick; the blocking call exists but is unexercised here).
2. Do statusline commands run at all under `entrypoint: "sdk-cli"`? (assumed no)
3. Whether long-context (>200k) requests carry a pricing/limit premium on `opus[1m]` —
   `exceeds_200k_tokens` exists as a signal; the economics behind it are unconfirmed. Don't build a
   policy on it until measured against real utilization deltas.
