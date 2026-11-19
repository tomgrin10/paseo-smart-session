# Report a bug

Someone asks an agent to "report a Smart Session bug" (or an idea, or feedback), and the agent files a detailed issue
in [tomgrin10/paseo-smart-session](https://github.com/tomgrin10/paseo-smart-session) through their own GitHub sign-in
(`gh`). The agent interviews them, inspects or reproduces the problem, dry-runs, shows the exact issue, and files only
after an explicit yes. It works the same way as Follow-up's Report a bug, with the same words.

## Where people find it

- **Settings → Help → Report a bug**, **⌘K → Smart Session: Report a bug, idea or feedback**, and
  **/report-smart-session** in a chat. The first two open a small sheet: Bug, Idea or Feedback, a text box, and
  **Send to**: an agent (this workspace's first) or a new agent in the workspace. The sheet files nothing itself; it
  hands the words to that agent, which takes it from there. With no workspace at all, **Open on GitHub** opens a
  prefilled issue with the versions block instead.
- `/report-smart-session what happened` sends the words straight to the agent of that chat; with no words, the sheet
  opens with that agent picked.

## Agent tools

| Tool (native / stdio) | What it does |
| --- | --- |
| `smart_report_issue` / `report_issue` | The kit module's three calls: `{ kind, summary }` returns the procedure; `{ kind, fields }` is the dry run (exact title, labels, body, likely duplicates, what was redacted, a `planId`); `{ confirm: true, planId, screenshot_consent }` files it, or returns a prefilled link and the markdown when `gh` isn't signed in. |
| `smart_report_send` / `report_send` | The sheet's Send for agents (agent parity): with no target it lists where a report can go; with `agentId` or `newAgentWorkspaceId` and the person's words in `text`, it hands them over. It refuses to send to itself. |

The caller is the transport's agent id, never an argument, and a plan only confirms for the agent that made it. The
description is one line (`REPORT_DESCRIPTION`, the kit's `reportToolDescription("Smart Session")`); the procedure
comes back in the first reply, so reporting costs no standing context. Nothing in the hooks mentions it.

## The module: `server/report-issue/` (vendored)

The procedure, redaction, rendering and GitHub calls are the plugin-agnostic module in
[paseo-plugin-kit](https://github.com/tomgrin10/paseo-plugin-kit#report-issue), copied in by `paseo-kit vendor
report-issue server/report-issue`. Don't edit the copy: change the kit, release it, bump the pin in
`devDependencies`, and vendor again. `npm run check` runs `paseo-kit vendor --check` and fails on any drift.

Smart Session's side:

| File | What it does |
| --- | --- |
| `server/report-issue-adapter.ts` | The repository, tool name and assets folder; `gh api` as the person's GitHub; diagnostics; the redaction context; the words sent to an agent. |
| `server/report-send.ts` | The sheet's targets and Send (the person's words to an agent, or a new agent in a workspace). |
| `shared/report-issue.ts` | The four RPCs: `report.issue`, `report.targets`, `report.send`, `report.link`. |
| `client/report-issue.tsx`, `client/report-request.ts` | The sheet, and its open request (no JSX, so ⌘K and Settings can open it). |

### Diagnostics

A bug carries versions (Smart Session), the environment (OS, Node, `gh` and whether it's signed in, the Paseo, Claude
Code and Codex CLIs), Smart Session's state and the last 20 `[smart-session]` warnings and errors (kept in memory
only). The state rows are switches and counts: Smart Compact and its pill, Pause at the limit (Session Guard) with its
threshold, governor and pending pauses, the number of ZeroSub accounts per provider, the usage source's newest
reading, the Claude Code integration, and the worker's uptime and memory. Never an account's name or email.

### Redaction

Everything the agent writes, every row and every log line goes through the module's `Redactor`: tokens, emails
(`<email>`), IP addresses, the hostname (`<host>`), home paths (`~`), the GitHub repositories of Paseo's projects
(`repo-N`, read from each project's `origin` while a report is prepared), and workspace, project and agent titles
(`PR-N`). `report-issue.test.ts` holds it for Smart Session's own diagnostics.

## Renders

`docs/evidence/report-issue/` (an isolated Paseo 0.15.4 harness with fictional workspaces; not shipped in the
package): Settings → Help on desktop and phone, the sheet with words typed, and the Send to picker, light and dark.
The harness had no agent provider that could start, so the picker shows only "A new agent" and there is no render of
the sent state.
