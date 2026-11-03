# paseo-smart-session

[![npm version](https://img.shields.io/npm/v/paseo-smart-session?style=for-the-badge&color=cb3837)](https://www.npmjs.com/package/paseo-smart-session)
[![npm downloads](https://img.shields.io/npm/dm/paseo-smart-session?style=for-the-badge&color=cb3837)](https://www.npmjs.com/package/paseo-smart-session)
[![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.14.0-8A63D2?style=for-the-badge)](https://paseo.sh)
[![License](https://img.shields.io/github/license/tomgrin10/paseo-smart-session?style=for-the-badge&color=2563eb)](LICENSE)

Let agents manage their own long-running work. Smart Session shows an agent how full its context is, lets it save durable task state, and lets it compact itself at a safe stopping point. It also keeps a history of context, plan usage and token spend.

![A Smart Session compaction handoff: the requested compact preserves the task state, then the resumed session is told to re-read its state file and continue](docs/screenshots/smart-compact-handoff.png)

## Install

```sh
paseo plugin install paseo-smart-session
```

On first load it registers its Claude Code hooks, touching only entries that point at its own scripts. Paseo attaches its MCP server when an interactive session opens.

## Use

Agents get these tools:

| Tool | What it does |
| --- | --- |
| `context_status` | Current context usage, fill rate and thresholds |
| `checkpoint` | Save durable task state for this session |
| `request_compaction` | Queue `/compact`, and choose whether and how to continue afterwards |
| `defer_compaction` | Put off a compaction and record why |
| `budget_status` | Plan usage, burn rate and reset times, and whether Session Guard will pause this session |

The usual flow is `context_status → checkpoint → request_compaction`, then stop or re-read the state and continue. Saved state holds the goal, current step, decisions made and approaches that failed, so a resumed agent neither redoes work nor asks how to continue.

The composer pill shows whether a session is enrolled in **Smart Compact**.

## How Smart Compact works

As a session fills, hooks send context notices. At the compact threshold, the agent is asked at the end of its turn whether it wants to compact. Nothing is forced: the agent can compact, defer with a reason, or keep working. A request is delivered only when the agent is idle and its state file is current; `request_compaction` refuses a missing or stale one.

After compaction, the agent chooses to stop (`continue_after_compaction: false`), continue with the default prompt to re-read its state, or continue with its own `continue_message`. A `/compact` typed by a person never gets a plugin continuation.

| Setting | Default | |
| --- | --- | --- |
| Smart Compact | On | Context notices and agent-requested compaction |
| Large-window compact threshold | 30% | Context windows of 400k tokens or more |
| Small-window compact threshold | 85% | Smaller context windows |
| Enrol sessions automatically | On | Enrol a session once it writes task state |
| Show the pill on every agent | On | Composer pill visibility |
| Register the hooks with Claude Code | On | Keep the context and compaction hooks installed |

## Session Guard

Session Guard pauses agents at the provider's session limit and continues the same conversations after the reset, even with the app closed. It is the [Session Guard](https://github.com/tomgrin10/paseo-session-guard) plugin folded into Smart Session, and it is **off by default**: turn it on from the overview or **Settings → Plugins → Smart Session → Session Guard**.

On Linux, Claude and Codex sessions pause in place together with their native subagents; elsewhere the turn is interrupted and one continuation is sent after the reset. Each session gets a pill to opt out or release it, and each pause gets a timeline card with **Resume now** and **Dismiss pause**. For Claude, a reset is confirmed from whichever is fresher, Paseo's cached usage or Smart Session's own recorder.

While the standalone plugin is enabled, Smart Session leaves session protection to it, so a session is never paused twice. Disable or uninstall Session Guard to hand over; per-session choices and waiting pauses in `$PASEO_HOME/plugin-data/session-guard/` carry over. See the [Session Guard guide](docs/session-guard.md) for settings and limits.

## Data and access

Everything lives in `$PASEO_HOME/plugin-data/smart-session/`: monthly usage and context logs, compaction records, an hourly spend index by model, workspace and agent type, and one `state/<agentId>.md` per agent. Logs are append-only, and a damaged line is skipped rather than risking the rest.

Paseo plugins run trusted, unsandboxed code on the daemon host. Smart Session reads local Claude Code usage data and talks only to the local daemon. For password-protected daemons it reads `PASEO_PASSWORD`, then `PASEO_PASSWORD_FILE`, then `~/paseo-hub/secrets/daemon-password`, and never writes or logs it.

## Development

```sh
npm ci
npm run verify
paseo plugin install .
paseo plugin reload smart-session   # after changes
```

## License

[MIT](LICENSE) © 2026 Tom Gringauz.

## Other plugins

- [Defer](https://github.com/tomgrin10/paseo-defer) — Schedule messages for later delivery.
- [Follow-up](https://github.com/tomgrin10/paseo-follow-up) — Track workspace PRs, remaining tasks and completion.
- [Graphite](https://github.com/tomgrin10/paseo-graphite) — Graphite stacks and PR status.
- [Send to Paseo](https://github.com/tomgrin10/send-to-paseo) — Send GitHub and Graphite PRs to Paseo from Chrome.
- [Session Guard](https://github.com/tomgrin10/paseo-session-guard) — Pause at session limits and continue after reset.
- [Transcript Search](https://github.com/tomgrin10/paseo-transcript-search) — Search conversations across connected hosts.
- [Transfer](https://github.com/tomgrin10/paseo-transfer) — Copy or move workspaces between hosts.
- [Vitals](https://github.com/tomgrin10/paseo-vitals) — Host, process, agent and Docker monitoring.
- [Workspace Switcher](https://github.com/tomgrin10/paseo-switcher) — Arc-style Ctrl+Tab between recent workspaces.
