# Pause at the limit

Pause at the limit (formerly the Session Guard plugin, and still called Session Guard in the code and data paths) pauses agents at their provider's session limit and continues the same conversations after the window resets, even while the Paseo app is closed. It began as the standalone [paseo-session-guard](https://github.com/tomgrin10/paseo-session-guard) plugin and now ships inside Smart Session. See the [README](../README.md) for installation.

## Turning it on

It is **off by default**. Turn it on with the **Pause at the limit** switch on the Smart Session overview, or in **Settings → Plugins → Smart Session**. Off, it holds no lock, writes nothing and adds nothing to the pill.

### Moving from the standalone plugin

Smart Session never runs Session Guard while the standalone plugin is configured **and enabled** on the host, even when it could. Released versions of the standalone plugin resume every suspended session in the shared state when they are disabled or removed, whichever plugin paused it, so two enabled copies cannot share a host safely. Both keep their state in `$PASEO_HOME/plugin-data/session-guard/` and take the same `governor.lock` there, so a disabled copy that is still shutting down is waited out too.

- While the standalone plugin is enabled, Smart Session's Session Guard pauses nothing. Settings, the pill's popover and the overview say so in one line, and pauses in the overview's list are marked read-only, with no controls.
- **Disable or uninstall Session Guard** (**Settings → Plugins**, `paseo plugin disable paseo-session-guard` or `paseo plugin remove paseo-session-guard`). Smart Session takes over on its next check, about 15 seconds later. Per-session choices and waiting pauses carry over, because they are the same file. The standalone plugin releases native workers when it stops; if the quota is still full, Smart Session normally pauses that work again on its first check.
- Smart Session's settings start from defaults: the standalone plugin's settings belong to that installation and are deleted with it. Re-apply any custom threshold, timing or continuation message.
- If the standalone plugin is enabled again while Smart Session is protecting the host, Smart Session releases the sessions it suspended, keeps their confirmed waits, gives up the lock and stops. The standalone plugin does not retry its lock, so reload it to let it take over, or disable it again to hand back to Smart Session. Between enabling it and Smart Session's next check (up to the check interval) both are loaded; avoid disabling it again within that window.

Turning Session Guard off releases suspended workers immediately. A message continuation that is still waiting keeps the lock until you cancel it or turn Session Guard back on. With nothing left waiting, Smart Session releases the lock.

## Use

There is no separate pill. Each session's Smart Session pill (the context ring) carries its protection, and says nothing about it while the session is simply protected. Press it for the **Pause at the limit** switch for that session: it shows whether the session follows your default or was changed, with **Use default** to go back. Turning the switch to match the default removes the override.

When a session is paused, its pill becomes the pause: an amber pause glyph and the moment it resumes (**Resumes 5:58 PM**, **Paused · reset due**, or **Check session** in red when it needs a look). It stays on the composer while paused even if the pill is hidden in settings. Its popover leads with what happened and when it continues, with **Cancel continuation** (for an interrupted turn) or **Release and turn off** (for frozen native workers, which also opts the session out so the next check doesn't pause it again), and a link to all paused sessions.

The Smart Session overview leads with paused sessions while there are any ("2 sessions resume at 5:58 PM"), and lists them right under the headline, each with the session title, provider, whether native subagents are frozen or the turn was interrupted, **Open session** and the release action. Uncertain stops sort first. Search appears when the list is busy. ⌘K **Smart Session: paused sessions**, a pause card and the settings screen all open the overview at this list. Sessions changed from your default are listed under the **Pause at the limit** row, each with **Use default**. While anything is paused, the Smart Session sidebar row shows the count. Paused workspaces get an amber **Paused** label in the left sidebar until the last paused session in them is released. Turn it off with **Label paused workspaces** in settings; other workspace labels stay intact.

Confirmed pauses write a **Paused at the session limit** timeline entry: the reset time with a live countdown, the provider and how much of the window was used, and whether native subagents are covered. When the pause ends, the entry folds into one line ("Paused at 7:57 PM · resumed 9:41 PM"), so the chat keeps the history without a stale card. Resume, release, and uncertain-stop entries make the recovery history clear. Existing confirmed waits are backfilled when upgrading. Timeline events use the host-owned plugin IPC identity, stay outside model messages, and never start a new turn. Delivery is journaled and retried; a lost acknowledgement is checked against timeline IDs before another append. Timeline delivery failures do not undo pauses and are shown in the overview/settings.

Choose **Dismiss pause** on an active pause or restart-recovery timeline item to release it **without sending a message**. This cancels its scheduled continuation, turns protection off for that session, clears its active pause from the overview and workspace label when applicable, and collapses the original card to a short acknowledgement. Existing suspended workers are released and may continue their current work. The dismissal is saved before release so it survives restarts; partial release retries without sending. Historical cards cannot dismiss a newer pause. **Resume now** remains available when you want Guard to continue interrupted work immediately.

Settings live in the **Pause at the limit** and **Limit timing** sections of **Settings → Plugins → Smart Session** (⌘K **Smart Session: settings**). **Sessions** can be changed from **Every session** to **Only ones I turn on**. Explicit overrides survive that change. Native subagents inherit their parent session's protection and opt-out. Paseo-created child sessions have their own protection and pill, like every other session.

| Setting | Default | Range / meaning |
|---|---|---|
| Enabled | No | Off releases suspended workers; message continuations stay on hold |
| Default protection | All sessions | Can switch to opt in |
| Automatic continuation | Yes | Off lets you continue manually |
| Include native subagents | Yes | Linux Claude/Codex process-tree suspension; off uses foreground interruption |
| Pause threshold | 100% | 1–100% |
| Check interval | 15 seconds | 5–300 seconds |
| Grace after reset | 30 seconds | 0–600 seconds |
| Continuation spacing | 5 seconds | 0–300 seconds; delivered on scheduler checks |
| Providers | All reporting session usage | Optional comma-separated provider IDs |
| Session windows | `five_hour, session` | IDs in preference order |
| Continuation message | Resume unfinished work from conversation and workspace | Editable, 1–8,000 characters |

With native coverage enabled on Linux, the plugin suspends the session's Claude or Codex provider process and its nested workers/tools using `SIGSTOP`. This preserves the current parent turn and native subagents, including background work under an idle parent. After a confirmed reset, `SIGCONT` resumes that same process tree; no new message is needed. A quota rejection already in flight can still finish the original turn after resumption; that matching failed turn gets one recovery message after reset.

Other providers, and Claude/Codex with native coverage turned off, use foreground interruption followed by one continuation message in the existing conversation. The plugin never compacts, clears context, switches models, or creates replacement agents. Interrupted tools may need recovery; the default continuation asks the agent to inspect their state before retrying.

Native coverage currently requires **Linux**, access to `/proc`, and a uniquely identified provider child of the connected local daemon. Ownership is checked using the daemon PID and its injected `PASEO_AGENT_ID`; each signal rechecks the process birth identity to avoid PID reuse. Other sessions, the daemon, the plugin, and workers already stopped by a person are excluded. Ambiguous ownership is reported in settings and retried, without claiming native protection succeeded. Turn off native coverage on an unsupported host to use foreground protection. Native work running in external services outside the provider's process tree cannot be suspended.

Suspension does not undo an API request or external action already sent. Network calls can time out while paused, and tools can retain locks. Resumption preserves local process state, but a provider's ordinary network/tool error still requires normal recovery; Session Guard automatically recovers only matching quota failures. Outstanding permission prompts remain for the person to answer.

The pill's icon carries the pause: the context ring normally, an amber pause while paused, and a red warning when the session needs a look. A confirmed pause timeline entry offers **Resume now** while that exact pause is still waiting. This resumes owned native workers in place, or sends one manual continuation for an interrupted turn, and opts that session out so a still-full quota cannot immediately pause it again. Restore protection from the pill when ready. Resuming does not restore provider capacity: requests can still be rejected before reset. Historical entries cannot resume a newer pause, and unconfirmed message delivery is left for inspection without a blind retry.

A disposable, empty session labelled `session_guard_demo=true` can exercise the real native pause/release path through the `smart-session.guard.demo-pause` RPC (`node probe.mjs rpc smart-session.guard.demo-pause '{"agentId":"…"}'`). It must have no user messages, active turn, or pending permissions. Its timeline explicitly says **Test pause**, makes no quota claim, and waits for your action even when capacity resets. The demo never sends a task or changes provider quota reports.

## Timing and persistence

The governor reads `provider.usage.list` through Paseo's own daemon client. For Claude it also uses Smart Session's recorder, which asks Anthropic directly every three minutes: whichever reading the provider produced more recently wins, so a reset is usually confirmed before Paseo's cache refreshes. Claude's `five_hour` and Codex's `session` windows work by default; any other provider reporting a matching window also qualifies. A percentage of remaining capacity is converted when a used percentage is absent. Weekly usage alone does not pause work under the defaults.

Paseo caches upstream quota reports (the current service defaults to five minutes). The check interval cannot force an upstream refresh: for providers other than Claude, pause detection and reset confirmation follow the reports Paseo actually exposes. A quota rejection can also register interrupted work if the session window is reported at the threshold. Ordinary errors and sessions stopped by a person do not register continuations.

Reset requires a **newer usage observation below the threshold**, plus the configured grace. Millisecond differences in reset timestamps are treated as the same window, using Defer's 60-second tolerance. If the reset time is missing, fresh below-threshold usage after the grace period releases the pause. If usage is unavailable, work waits and checks retry automatically.

Confirmed pauses and session overrides persist in `$PASEO_HOME/plugin-data/session-guard/state.json`; host settings use Paseo's versioned settings API. Native process identities are journaled before signals. A plugin crash/restart preserves confirmed suspension; recovery releases an unconfirmed partial freeze, and safely retries an interrupted process release. Graceful plugin unload releases suspended workers immediately and preserves the confirmed wait on disk. A full daemon or VM restart ends the old workers, but keeps the paused session in the overview, its original reset schedule, and the same conversation. Once fresh provider usage confirms the reset, Session Guard sends one continuation to that conversation. Its timeline explains the recovery; Resume now remains available. New user messages, an explicit stop, closed sessions, and opt-outs cancel automatic recovery. In-memory native subagents cannot survive a full restart; the parent conversation resumes its unfinished task. Foreground message continuations also survive reloads and daemon restarts. Confirmed state writes are flushed to disk before actions. Governor ownership uses the VM boot and process birth identity, so a reboot or reused PID does not retain a stale lock. Only one governor can own this data path, whether it is Smart Session, the standalone plugin, or either installed twice under different IDs. Gracefully closed snapshots reopen only when the saved daemon identity changes; closing a session in the same daemon cancels its continuation.

A new user message, another running turn, closing/archiving/removing the agent, a provider change, or opting out cancels the old continuation and releases owned suspended workers. Pending permissions are left for the person to answer. Message continuations are sent only into idle sessions, or a quota-error session that the plugin registered. Rechecks immediately precede interruption, suspension, and delivery; Paseo 0.10.1 has no conditional atomic “send only if this turn is unchanged” operation, so a simultaneous user action can still race that final recheck.

If a reload or connection loss interrupts an unconfirmed stop/send, the pill reads **Check session**. Delivery acceptance may be ambiguous, so the plugin leaves that session for manual inspection instead of retrying a message that might already have arrived. Confirmed waiting work continues automatically.

## With ZeroSub

[ZeroSub](https://github.com/kapybara-org/zerosub) runs Claude and Codex agents on several subscription accounts. When an account hits a limit, ZeroSub moves the agent to another account and continues it. It switches only on the CLI's own limit notice, so an agent the guard interrupts or freezes first never switches. Paseo and the recorder also measure only the CLI's own login. When ZeroSub is enabled on the host, Pause at the limit reads ZeroSub's registry and usage readings from `$PASEO_HOME/zerosub/` and changes its behaviour as follows:

- **Each agent is measured on its own account.**
  - An agent on an account ZeroSub added is paused only when *that* account reaches the threshold.
  - The CLI login keeps Paseo's and the recorder's reading.
- **ZeroSub goes first.** The guard doesn't pause an agent while ZeroSub's automatic switching is on and another account of the same provider has room. Room means signed in, not disabled, no recorded limit, and a reading under 30 minutes old that is below the threshold.
  - A session the guard already froze is released when such an account appears, so the CLI reaches the limit and ZeroSub can switch it.
  - Once no account has room, the guard pauses and continues as before.
- **A moved session continues sooner.** An interrupted session that ZeroSub moves to an account with room is continued as soon as that account's reading confirms the room. It doesn't wait for the old account's reset.
- **Codex tasks aren't continued twice.** When ZeroSub carries a Codex task on in another tab, the old tab's waiting continuation is cancelled.

The guard only reads account ids, flags, timestamps and percentages. It never writes ZeroSub's files and never opens an account's credential home. Without ZeroSub, or when its files can't be read, nothing changes.

## Daemon authentication

For password-protected daemons, Smart Session reads `PASEO_PASSWORD`, then `PASEO_PASSWORD_FILE`, then `~/paseo-hub/secrets/daemon-password`. It never logs or stores the password. Provider usage comes through Paseo; provider credentials are not read directly.

## Client API limits

Workspace labels support text and color. Session Guard uses the short amber label **Paused**; a vector pause icon in that label needs Paseo client support. The normal desktop/mobile composer Send action cannot currently be intercepted by a plugin. Automatic “send after reset or unpause?” confirmation is not implemented in this version; adding it requires a Paseo composer send hook. Existing pause, resume, timeline, and workspace-label behavior does not depend on such a hook.

## Agents

Inside Paseo, the `budget_status` tool adds one line about the calling session: whether it pauses at the limit and continues afterwards, or whether it is paused now. It covers only the caller, never other sessions or continuation text, and it cannot turn protection off or resume a pause. Under ZeroSub, `budget_status` names the Claude account the session runs on. For an account ZeroSub added, it reports ZeroSub's reading of that account in place of the CLI login's history, and it says when ZeroSub has another account with room.
