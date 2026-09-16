# paseo-smart-session

[![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.8.0-8A63D2?style=for-the-badge)](https://paseo.sh)
[![Release](https://img.shields.io/github/v/release/tomgrin10/paseo-smart-session?display_name=tag&sort=semver&style=for-the-badge&label=release&color=6366f1)](https://github.com/tomgrin10/paseo-smart-session/releases/latest)
[![License](https://img.shields.io/github/license/tomgrin10/paseo-smart-session?style=for-the-badge&color=2563eb)](LICENSE)

Give Paseo agents a safe way to manage long-running work.

Smart Session lets an agent see how full its context is, save durable task state, and compact itself when it is ready. It also records session and plan-usage statistics, so you can understand where tokens are going and when limits reset.

![A Smart Session compaction handoff: the requested compact preserves the task state, then the resumed session is told to re-read its state file and continue](docs/screenshots/smart-compact-handoff.png)

## What it does

### Lets agents compact themselves

An agent can check how much context it has used, checkpoint the work that must survive a reset, and request compaction when it reaches a safe stopping point. The agent also decides whether another turn should start afterwards and can write the exact follow-up message. A completed task can compact and stop; work in progress can resume from its saved state.

The saved state captures the goal, the current step, decisions already made, and approaches that have already failed. That prevents a resumed agent from redoing work or asking a person how to continue.

Smart Session never chooses to compact an agent by itself. It can let an agent know that context is filling, but the agent decides whether to checkpoint, compact, or defer.

### Shows session and plan usage

Smart Session keeps a local history of:

- Context-window usage for each agent session
- Claude plan usage, burn rate, and reset times
- Token spend by model, workspace, and main agent versus subagent
- Compaction requests and their before/after context sizes

That history remains useful after an individual session ends or a provider cache changes.

## Install

Requires Paseo 0.8.0 or newer with plugins enabled (**Settings → Plugins**).

```sh
paseo plugin add tomgrin10/paseo-smart-session --ref v1.2.0
```

Omit `--ref` to follow `main`.

```sh
paseo plugin ls                    # confirm it is running
paseo plugin update smart-session
paseo plugin remove smart-session
```

On first load, Smart Session registers its Claude Code hooks and MCP server. It only manages entries that point at its own scripts; other Claude Code configuration is left alone.

## How an agent uses it

Smart Session exposes these MCP tools to Paseo agents:

| Tool | What it does |
| --- | --- |
| `context_status` | Shows current context usage, filling rate, and relevant thresholds. |
| `checkpoint` | Writes durable task state for the current session. |
| `request_compaction` | Queues compaction and chooses whether and how to continue afterwards. |
| `defer_compaction` | Defers a compaction request and records why. |
| `budget_status` | Shows plan usage, burn rate, and reset times. |

The usual flow is:

```text
context_status → checkpoint → request_compaction → stop, or re-read state and continue
```

`request_compaction` refuses when the state file is missing or stale. The agent can checkpoint and request again in the same turn.

## Smart Compact

Smart Compact is the session-control feature. As a session fills, hooks can provide context notices at useful thresholds. When the compact threshold is reached at the end of a turn, the agent is asked whether it wants to compact.

There is no forced compaction. An agent can compact immediately, defer with a reason, or keep working. A request is delivered only when the agent is idle and its state file is current.

Every request sends the `/compact` command. The agent can also set:

- `continue_after_compaction: false` to finish without starting another turn.
- `continue_after_compaction: true` to start another turn after compaction.
- `continue_message` to choose the exact follow-up; when omitted, the default tells the agent to re-read the state file and continue from its **Current step**.

Omitting the new options preserves the earlier behavior: Smart Session continues with the default state-aware prompt. The durable state wins if it disagrees with the automatic summary. A `/compact` entered by a person never receives a plugin continuation.

### The composer pill

The composer pill shows whether the current session is enrolled:

| State | Meaning |
| --- | --- |
| **Smart Compact on** | The session can receive context notices and request compaction. |
| **Smart Compact off** | The session is not enrolled. |

If Smart Compact is disabled globally, the pill is not shown.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| **Smart Compact** | On | Enables context notices and agent-requested compaction. |
| **Large-window compact threshold** | 30% | Sets when Smart Compact asks on context windows of 400k tokens or more. |
| **Small-window compact threshold** | 85% | Sets when Smart Compact asks on smaller context windows. |
| **Enrol sessions automatically** | On | Enrols a session after it writes task state. |
| **Show the pill on every agent** | On | Shows the Smart Compact control in the composer. |
| **Register the hooks with Claude Code** | On | Keeps the context and compaction hooks installed. |

The remaining settings apply only while Smart Compact is enabled. Thresholds accept whole percentages from 1% to 99%; lowering one also moves its earlier notice bands down when needed.

## Usage history and state

Smart Session stores its data under:

```text
$PASEO_HOME/plugin-data/smart-session/
```

| File | Contains |
| --- | --- |
| `usage-YYYY-MM.jsonl` | Plan-usage observations and reset times. |
| `context-YYYY-MM.jsonl` | Context-window usage changes. |
| `compactions.json` | Compaction requests, continuation choices, and context sizes. |
| `spend-index.json` | Hourly token spend by model, workspace, and agent type. |
| `state/<agentId>.md` | Durable task state for one agent. |
| `settings.json`, `enrolment.json` | Plugin settings and per-session enrolment. |

Usage and context observations are append-only. A damaged line is skipped rather than putting the rest of the history at risk. Existing compaction rows are read as “continue with the default prompt,” so upgrading requires no data migration.

## Password-protected daemons

When the Paseo daemon requires a password, Smart Session resolves it in this order:

1. `PASEO_PASSWORD`
2. The file named by `PASEO_PASSWORD_FILE`
3. `~/paseo-hub/secrets/daemon-password`

The secret is used only to connect to the daemon. It is never written or logged.

## Develop locally

```sh
git clone https://github.com/tomgrin10/paseo-smart-session.git
cd paseo-smart-session
npm ci
npm run verify
paseo plugin install "$PWD"
```

After editing:

```sh
npm run verify
paseo plugin reload smart-session
```

Reloading the plugin is enough. Do not restart the Paseo daemon: that interrupts every running agent.

## Data and privacy

Smart Session reads local Claude Code usage information and communicates with the local Paseo daemon. Its usage history, settings, and task state stay under `$PASEO_HOME`. Apart from narrowly maintaining its own Claude Code hook and MCP entries, it does not modify user configuration.

## License

[MIT](LICENSE) © 2026 Tom Gringauz.
