# Release notes

What changed in each version of Smart Session, newest first.

## 3.6.2 (2026-11-10)

- Smart Session's own tool calls (saving task state, context and budget checks, compaction requests) stay inside Paseo's grouped tool-call rows in chat instead of splitting each group into loose lines.

## 3.6.1 (2026-11-09)

- Claude Code hooks keep working across plugin updates. After the 3.6.0 update every hook could fail until the plugin was reloaded, because they pointed at the install folder Paseo had just deleted.
- Hooks now run through small launchers in Smart Session's data folder that always find the current install, and do nothing if it is missing.
- Hook entries left by older versions are moved to the launchers on load, and a stale pointer is repaired within 10 minutes.

## 3.6.0 (2026-11-09)

Smart Session's agent tools no longer start a separate Node process (about 50 MB each) for every open Claude or Codex session. On Paseo 0.15 and newer, Paseo serves them.

### Agent tools

- On Paseo 0.15+, sessions get `smart_context_status`, `smart_budget_status`, `smart_checkpoint`, `smart_request_compaction` and `smart_defer_compaction`, run inside the plugin.
- On Paseo 0.14, or with Paseo's agent MCP turned off, each session still gets its own Smart Session MCP server, as before.
- Smart Compact's asks name the tools the session actually has. Sessions opened before the update keep the old names until they reopen.
- A plugin update no longer strands a running turn: until the session reopens, the asks and any failed tool call point the agent to a one-call fallback command.
- Chat rows recognise the new tool names.

### Cleanup

- An older version's machine-wide `smart-session` MCP entry made every Claude session start (or fail to start) the MCP server. It is removed on first load from every Claude and Codex home Paseo uses, including ZeroSub's account homes.
- Each file is backed up beside the original before that removal. MCP entries you added yourself are left alone.

### Upgrading from 3.5

- Requires Paseo 0.14 or newer; the native tools need 0.15.
- Agents open during the update keep working. Their tools return when each session reopens, which Paseo does before the agent's next prompt.
- No saved data changes shape.

## 3.5.0 (2026-11-08)

Smart Compact has two lines per window size instead of one, so an agent that keeps filling its context is asked to stop mid-turn, not only at the end of a turn.

### Smart Compact

- End-of-turn line (the old compact line; default 30% of a 1M window, 85% of a smaller one): past it, the agent is asked at the end of a turn whether to compact, as before.
- Mid-turn line (new; default 40% and 90%): past it, the agent is asked straight away to finish its step, save its task state, request a compaction that continues afterwards, and end its turn.
- The agent can still defer, but it is told this is the line where it should not push on. Compaction is still always the agent's own request.

### What you see

- The pill ring and context meters show both lines: amber past the end-of-turn line, red past the mid-turn line.
- The popover, overview and pill title say which line a session is past and when it reaches each.
- Settings has both lines for large and small windows, and keeps the mid-turn line above the end-of-turn line.
- `context_status` names both lines.

### Upgrading from 3.4

- Your existing compact line becomes the end-of-turn line, and the mid-turn line keeps the default gap above it. Nothing is rewritten on disk.

## 3.4.0 (2026-11-08)

With ZeroSub installed, Smart Session shows all your subscriptions together as time: how long the pool lasts and which account takes over next.

### Subscriptions

- Overview → Subscriptions: one card per provider with a 12-hour runway chart (in use, room, at the limit), when the pool runs out and which account takes over next.
- Each card has per-account 5-hour and weekly meters with their resets.
- The overview's lead line reads, for example, "Claude · 3 subscriptions last until about 9:40 PM", or when every account is out, when the first one is back.
- The sidebar shows a short pool summary ("3 of 3", "out 9:40 PM", "back 5:58 PM").
- The pill popover says which account the session runs on and what happens when it runs out ("ZeroSub moves it to Account 3" or "Smart Session pauses it until its reset").
- `budget_status` gains an optional pool summary for agents.
- Accounts are named by your ZeroSub label, else "CLI login" or "Account N". Email addresses never reach Smart Session, and ZeroSub's files are only read.
- Without ZeroSub, or with a single login, nothing changes.

### Naming

- The feature is called "Pause at the limit (Session Guard)" everywhere in the app and docs.

### Upgrading from 3.3

- Account history is stored in new monthly files beside the existing ones. Older history loads unchanged.

## 3.3.0 (2026-11-05)

With ZeroSub, a session pauses when every subscription is out and continues as soon as any one account has room again.

### Pause at the limit with ZeroSub

- Every account out now pauses. Claude ends a turn at the limit with a normal "You've hit your limit" reply, which the guard used to miss; it now recognises that reply and records one waiting pause.
- A waiting pause continues when its own account resets, or when another account of the same provider shows room in a reading taken after the pause.
- When the room is on another account, ZeroSub moves the session there and carries on. You may see both plugins' continuation messages, but the work runs once.
- More limits count as out: limits ZeroSub recorded on the CLI login, and full weekly windows. A lagging reading below 100% no longer hides them.
- No double pause when the guard interrupts at the same moment the limit reply ends the turn.
- Without ZeroSub, nothing changes.

## 3.2.0 (2026-11-05)

Session Guard is now part of Smart Session rather than a second plugin inside it, with one pill, one settings screen and one overview. In the app it is called "Pause at the limit".

### One pill

- The context ring is the only Smart Session pill. A protected session adds nothing to it.
- A paused session turns the ring into an amber pause showing "Resumes 6:27 AM", visible even if you hide the pill.
- The popover has a per-session Pause at the limit switch with Use default. While a session is paused, the popover leads with Resume now and Dismiss pause.

### One settings screen and one overview

- Settings is one screen, in this order: Smart Compact, When to ask, Pause at the limit, Display, Claude Code, Limit timing. Limit timing sits behind Edit.
- Paused sessions moved into the overview. While anything is paused, its headline says when work resumes, with the list underneath.
- Every Command Center item starts with "Smart Session". The old keywords (quota, limit, pause, guard, session guard) still find them.
- The paused-session chat card matches Smart Session's other chat cards.

### Upgrading from 3.1

- The separate Session Guard and Display settings pages are gone; their options are on the one Settings screen. Old links to the paused-sessions screen open the overview at that list.
- Dismiss pause replaces Cancel continuation. It lets the session go without a message and stops pausing that session at the limit.
- No data or settings changes.

## 3.1.0 (2026-11-05)

Session Guard works with ZeroSub, which runs agents on several Claude and ChatGPT subscriptions and switches accounts at the limit.

### Pause at the limit with ZeroSub

- Each agent is measured on the account it actually runs on, not on the CLI login. Smart Session reads this from ZeroSub's files without writing to them.
- ZeroSub switches first: while another account of the same provider has room, Session Guard leaves the agent alone, and releases one it already froze so ZeroSub can move it.
- An agent ZeroSub moved continues as soon as its new account has room.
- A Codex task that ZeroSub already continued in another tab is not continued twice.
- `budget_status` tells each agent which account it is on and gives that account's numbers.
- When every account is out, Session Guard pauses and resumes as before. Without ZeroSub, nothing changes.
- Smart Session never opens credential files and never stores or reports email addresses.

## 3.0.0 (2026-11-05)

- Same features as 2.2.0, published again as a major version a few minutes later. See 2.2.0 for what changed.

## 2.2.0 (2026-11-05)

Smart Session says when your session runs out, not just how much is left.

### Forecast

- The Smart Session screen leads with a forecast from recorded usage, for example "Session runs out around 5:17 PM, 40m before the 5:58 PM reset."
- Plan-limit meters show the projection to the reset and an even-pace tick, with a chart of the open session window and the last 14 days of session windows.
- The session forecast uses the last half hour; the week uses its own average, so a short burst no longer says the week runs out tonight.
- The sidebar row shows when the session window runs out ("out 5:17 PM"), or how many sessions are paused.

### Context ring

- The composer pill is a ring of the session's context with a tick at its compact line and the percentage as its label.
- Pressing it opens a popover with tokens, the compact line, task state age, the last compaction and the enrolment switch.

### Chat

- Smart Session's tool calls read as one-line rows, such as "Saved task state" or "Compaction not queued · task state is out of date".
- The compaction request, the continuation and Session Guard's messages become cards with the full text one press away.

### Session Guard and settings

- Paused sessions is a titled screen whose headline is the moment ("2 sessions resume at 5:58 PM").
- The pause card leads with the reset time and a countdown and folds into one line once the pause ends. The pill reads "Paused · reset due" instead of a past time.
- Settings → Plugins → Smart Session gains a Smart Compact screen (thresholds, auto-enrol, pill, hooks). Display options are "Sidebar row" and "Composer pills".

## 2.1.0 (2026-11-03)

Session Guard is built in: Smart Session can pause agents at the provider's session limit and continue them after the window resets.

### Session Guard

- Off by default. Turn it on in Settings → Plugins → Smart Session → Session Guard.
- Protected sessions are paused at your threshold (100% by default). On Linux, Claude and Codex processes and their subagents are frozen in place and resumed once a fresh usage reading confirms the reset.
- Timeline cards with Resume now and Dismiss pause, an amber Paused workspace label, a Paused sessions screen, a per-session composer pill and Command Center entries.
- For Claude, the reset is confirmed from whichever reading is newer, Paseo's or Smart Session's own, so resumes are usually confirmed sooner.
- `budget_status` tells the calling agent whether its session is protected and paused.

### Also

- The plugin has an icon in Paseo's plugin list.

### Upgrading from 2.0

- Smart Session never guards while the standalone Session Guard plugin is installed and enabled, so sessions are never paused twice.
- To switch, turn Session Guard on in Smart Session, then disable or uninstall the standalone plugin. Per-session choices and waiting pauses carry over.
- The standalone plugin's settings (threshold, timing, continuation message) are not imported; set them again if you changed them.
- Agents that called `session_guard_status` use `budget_status` once the standalone plugin is removed.

## 2.0.0 (2026-10-29)

Smart Session's agent tools attach to each Claude or Codex session on its own, instead of through a machine-wide MCP registration.

### Agent tools

- The Smart Session MCP attaches automatically when an interactive Claude or Codex session opens, including on resume, refresh and import.
- Normal plugin startup no longer registers a global Claude MCP. Existing global entries are left in place.
- The connection respects a custom daemon listen address.

### Navigation

- The Smart Session screen and its settings link to each other, and settings open directly from the Command Center.
- Settings → Display can hide the header button and the composer pill separately.

### Upgrading from 1.2

- Requires Paseo 0.14 or newer.
- Usage history, checkpoints and settings are preserved.

## 1.2.6 (2026-09-27)

- Smart Session's agent tools work on the Paseo desktop app, where every call used to fail with "Cannot resolve @getpaseo/client/internal/daemon-client".
- On the desktop app, the MCP server runs on the app's own runtime, and AppImage installs use their stable path. If it still cannot start, the error says how to fix it.

### Upgrading from 1.2

- Reload the plugin so it registers the MCP server again, then start a new Claude Code session. A running session keeps the MCP command it started with.

## 1.2.5 (2026-09-23)

- Composer pills appear on agents created after the plugin loaded, and disappear from agents that are gone.

## 1.2.4 (2026-09-23)

- README only: npm version badge and links to the other published Paseo plugins.

## 1.2.3 (2026-09-22)

- The Claude MCP registration follows the plugin to its current install path after an npm or Git update, so agent tools no longer disconnect while the plugin looks healthy.

## 1.2.2 (2026-09-22)

- README only: install examples follow the latest published version instead of pinning one.

## 1.2.1 (2026-09-22)

- Smart Session is published on npm: `paseo plugin install npm:paseo-smart-session`. Installing from npm needs Paseo 0.9 or newer; Paseo 0.8 can keep installing from Git.
- Rebuilding usage history from transcripts reads oversized transcript records in bounded chunks, so a large unread tail no longer uses unbounded memory.

## 1.2.0 (2026-09-16)

Smart Compact thresholds are configurable, so large and small context windows can each compact at a percentage that fits your work.

- Separate compact thresholds for large and small windows, in whole percentages from 1% to 99%.
- Changes save immediately and refresh the live context readings.
- The compact threshold always wins; earlier notice bands move down when needed.

## 1.1.0 (2026-09-11)

The agent asking for a compaction decides whether work continues afterwards, and with what message.

- `request_compaction` takes `continue_after_compaction`, so a finished task can compact without an unneeded continue turn.
- `continue_message` replaces the default follow-up with the agent's own text.
- Leaving both out keeps the previous behaviour: continue and re-read the task state.
- Smart Compact's hook guidance, settings and docs explain the choice.

## 1.0.4 (2026-09-10)

- User-facing text says "Smart Compact" consistently: pill label, toast, settings section, agent tool text and hooks.

## 1.0.3 (2026-09-10)

- Agent tools that need the daemon, such as `budget_status`, work on a managed `paseo plugin add` install. They used to fail with "Cannot find package '@getpaseo/client'".

## 1.0.2 (2026-09-10)

- Smart Session works on password-protected Paseo daemons: usage recording, Smart Compact, context readings, agent tools and the development probe.
- The password is read from `PASEO_PASSWORD`, `PASEO_PASSWORD_FILE` or the standard daemon password file, and is never logged or stored.

## 1.0.1 (2026-09-10)

- Installs correctly from Paseo's Git installer, which could reject 1.0.0.

## 1.0.0 (2026-09-10)

Smart Session runs on Paseo 0.8. Use 1.0.1 instead: Paseo's Git installer can reject this version.

- Built for Paseo 0.8's separate app and daemon plugin entries.
- Usage history, settings, enrolment, hook ownership and compaction records carry over.

### Upgrading from 0.3

- Requires Paseo 0.8 or newer; Paseo 0.7 is no longer supported. Upgrade Paseo before updating the plugin. No data migration.

## 0.3.0 (2026-09-07)

Compaction is always the agent's own decision. Smart Session only asks, at a moment when acting is safe, and the agent answers with its own tool call.

### Smart Compact

- The ask comes from a Claude Code Stop hook, at the agent's own turn boundary rather than mid-work.
- It asks once per session, asks again after another 10 points of growth, and at most three times between compactions.
- It stays quiet while background tasks run, while a compaction is queued, or just after a compaction.
- After a queued compaction lands, the session gets its task state back and carries on. A `/compact` you type yourself is never followed up.
- `defer_compaction` lets an agent decline with a reason and not be asked again for a while.
- `request_compaction` refuses when task state is missing or stale and tells the agent to call `checkpoint` first, which it can do in the same turn.

### Settings and pill

- A master Smart Compact switch, with Enrol sessions automatically, Show the pill and Register the hooks under it, dimmed when it is off.
- The pill has two states, enrolled or not, and is not drawn with Smart Compact off.

### Automatic setup

- On load the plugin adds its four hook entries to Claude Code's settings and registers its MCP server through Claude Code's own CLI.
- It only touches entries that point at its own hooks, never writes a path it has not checked, and leaves a malformed settings file alone.
- It backs up Claude Code's settings file before the first change and never touches the file that holds Claude Code's credentials.
- Turning off Register the hooks removes every entry it added. Without the Stop hook, nothing asks a session to compact.

### Upgrading from 0.2

- The autopilot is gone. The plugin no longer compacts a session on its own when it crosses a threshold; the Stop hook asks and the agent decides.
- Settings migrate on read (the autopilot switch becomes the Smart Compact switch). No other data changes.
- On a managed install, the MCP registration is only written when absent; re-register it after an update if agent tools stop connecting.

## 0.2.0 (2026-09-06)

Super Session is renamed Smart Session. The meter, governor, pill, thresholds and stored history carry on under the new name.

- The sidebar, package, plugin id (`smart-session`), MCP server, environment variables and repository (`tomgrin10/paseo-smart-session`) all use the new name.
- On first start, the plugin moves its data folder from `super-session` to `smart-session`. If both already hold data, it leaves both alone and logs the conflict.

### Upgrading from 0.1

- Remove the old plugin with `paseo plugin remove super-session`, then install `tomgrin10/paseo-smart-session`.
- Replace the Claude MCP registration with `smart-session`, update hook paths to the renamed checkout, and rename any `SUPER_SESSION_*` variables to `SMART_SESSION_*`.
- The old repository URL redirects, and the 0.1 tags stay available.

## 0.1.2 (2026-09-06)

- The composer pill is called Smart compact instead of Auto-compact, so it no longer reads as a switch for Claude Code's own auto-compact. Its tooltip reads Smart compact on, paused or off.

## 0.1.1 (2026-09-06)

- The pill's tooltip shows when you point anywhere on the pill, not only over its icon.

## 0.1.0 (2026-09-06)

First release, then called Super Session: a meter that keeps the plan-usage history nothing else keeps, and a governor that lets an agent see how full its context is and be compacted when it will not lose work.

### Meter

- Records the 5-hour and weekly plan windows every minute from load, whether or not anything is open, because no other tool keeps that history.
- Reads plan usage directly from Anthropic rather than from a cached copy that can be minutes or hours behind.
- Rebuilds 30 days of token spend from transcripts, including subagent transcripts: tokens per day, by hour of the week, by workspace and by model, plus the cache hit ratio.

### Governor

- Three agent tools: how full is my context, what does the plan budget look like, and compact me. Each acts only on the calling agent's own session.
- Claude Code hooks show the agent the same information without it asking, and carry its task state across a compaction.
- Compaction thresholds depend on the window size, not one percentage: 30% of a 1M window is already heavier than 85% of a 200k one.
- Autopilot is off by default. When on, it acts only at a turn boundary, above the threshold, and only when the session's task state is current. A request interrupted by a restart is dropped, never retried.
- A composer pill shows whether the governor is watching the session and switches it on or off. Hide it from the Command Center.

### Data

- Everything is stored under Paseo's plugin data folder, one line per observation, never rewritten. Nothing leaves the machine.
