# Repository instructions

## Project

- This is the trusted, unsandboxed Paseo plugin `smart-session` — note the id is `smart-session`
  while the repository and package are `paseo-smart-session`. Minimum supported Paseo is 0.14.0.
- It is three parts in one daemon process: a **meter** that records plan-usage history, a
  **governor** that reads each agent's context occupancy and compacts a session on request, and
  **Session Guard**, which pauses agents at a provider's session limit and continues them after the
  reset. Session Guard was folded in from the standalone `paseo-session-guard` plugin; see its
  section below.
- Check the current plugin docs at `https://paseo.sh/docs/plugins.md` and
  `https://paseo.sh/docs/plugins/reference.md` before changing runtime code.
- `RESEARCH.md` is the evidence base — every capability claim in `PLAN.md` and in the code comments
  points at a section of it. If you discover something that contradicts it, correct it there rather
  than working around it in code.
- Never commit credentials, plan-usage samples, transcripts, task state, daemon configuration, logs,
  or local paths.

## The data is the point

- `$PASEO_HOME/plugin-data/smart-session/` holds the only copy of plan-utilization history that
  exists anywhere. `/usage` is a snapshot, Paseo's quota fetcher keeps no store, and Claude Code
  overwrites its cache in place — a percentage of a plan limit cannot be reconstructed after the
  fact. Append, never rewrite; one JSON line per observation; read back defensively so one corrupt
  line cannot cost a month of history.
- The data path is fixed and deliberately decoupled from the install id, so a second install under
  `--id something-else` cannot start a second history. It also means a second install runs a second
  recorder and a second governor over the same files.
- Preserve the on-disk shapes: `usage-YYYY-MM.jsonl`, `context-YYYY-MM.jsonl`, `accounts-YYYY-MM.jsonl`, `settings.json`,
  `enrolment.json`, `compactions.json`, `state/<agentId>.md`. Migrate rather than break them.
- `server/store.ts` owns the one-time v0.1 `super-session` to `smart-session` directory migration.
  The old name is allowed only in that migration, its regression tests, and upgrade documentation.

## Code boundaries

- Keep `index.client.tsx` and `index.server.ts` focused on contribution wiring.
- `client/`: React Native UI and client hooks. Use `theme.colors` for text and backgrounds and
  `layout.compact` for responsive spacing.
- `server/`: Node APIs, filesystem access, daemon connections, backend behaviour.
- `shared/`: Zod RPC contracts and plain values safe in both runtimes.
- Paseo compiles the two runtime entries independently. `check-bundles.mjs` guards those directory
  boundaries and registration contracts.
- Add nothing to `dependencies`. The server bundle must compile with no installed packages or
  `paseo plugin add` breaks; `server/daemon.ts` assembles its specifier at runtime and borrows
  Paseo's own daemon client from the host for exactly that reason — which also keeps the protocol
  version identical to the daemon's. `check-gitinstall.mjs` enforces it.
- Every direct daemon connection, including `server/daemon.ts`, `server/hooklib/daemon.mjs` (what `mcp.mjs` and
  `hooks/publish-as.mjs` use), and `probe.mjs`, must pass
  the password from `server/daemon-password.mjs`. Resolution order is `PASEO_PASSWORD`, then
  `PASEO_PASSWORD_FILE`, then `~/paseo-hub/secrets/daemon-password`. Never put the password, its file
  contents, or an underlying filesystem error into logs or error messages.
- `mcp.mjs` is spawned directly by Claude Code from the plugin's own Git checkout, not by Paseo, so
  it has no module graph to borrow `@getpaseo/client` from the way `server/daemon.ts` does. Its
  `loadDaemonClient()` falls back to resolving the client from the `paseo` CLI found on `PATH`, since
  that install always has it. `check-mcp-resolve.mjs` proves this against a Git install with no
  `node_modules` of its own — this broke in production on the VM before that check existed.
- The desktop app keeps `@getpaseo/client` inside `app.asar`, which plain `node` cannot read, and its
  `paseo` is a shell wrapper with nothing to resolve from. So when the plugin runs under Electron,
  `server/install.ts` registers `mcp.mjs` on that same executable (`$APPIMAGE` for an AppImage)
  with `ELECTRON_RUN_AS_NODE=1`, and `mcp.mjs` resolves the client through `process.resourcesPath`.
  This broke on macOS after an app update; `check-mcp-resolve.mjs` covers that layout too.
- Keep daemon connections short-lived. A long-lived socket in the plugin subprocess keeps the event
  loop alive and hangs Paseo's "Stopping plugin" step, which wedges reload for the life of the
  daemon. Every timer and resource must be released through `shared/lifecycle.ts`;
  `check-teardown.mjs` enforces it.
- `server/install.ts` writes to `~/.claude/settings.json`, which the plugin does not own. It may only
  add, update or remove entries whose command points at one of our `hooks/*.mjs`; it must never
  write a path it has not confirmed exists, must not write at all when reconciling changes nothing,
  and must leave a malformed file alone rather than rewriting it from a partial parse. A symlinked settings.json is
  written through to its target (`writeTarget`), never replaced by a copy (`install.test.ts`). MCP
  attachment goes through `server.before("agent.session_open")`. Never register globally: a user-scope
  entry starts `mcp.mjs` in every Claude session on the machine. `server/mcp-registrations.ts` removes an
  older version's entry from every Claude and Codex home Paseo launches with (defaults, provider `env`,
  ZeroSub's homes), backing each file up first, and only from an install Paseo actually loads (never from a
  check's sandbox). Never edit `~/.claude.json`, which holds credentials: removal goes through
  `claude mcp remove` with `CLAUDE_CONFIG_DIR` pointing at the home.
- Nothing outside the plugin names an install directory: Paseo installs every update into a fresh
  one and deletes the old, which on 2026-11-09 left every hook failing with MODULE_NOT_FOUND for
  hours. `server/hook-path.ts` writes shims into `plugin-data/smart-session/hooks/` (the three hooks
  and `mcp.mjs`) that read `current.json` beside them and `import()` the real script, exiting 0
  silently when it is missing; `settings.json` names only those shims, each behind `if [ -f … ]`.
  The stdio MCP server and the bridge the asks name use the same shims. `resolvePluginDir()` picks
  the install whose `package.json` version is the running bundle's (`shared/version.ts`), because
  the bundle is evaluated from a string with no path of its own and `config.json` can still name the
  previous install mid-update. `install-on-load.ts` re-checks the pointer every ten minutes (stats
  only). `hook-path.test.ts` simulates the update.
- The load-time call lives in `server/install-on-load.ts`, not in `server/install.ts`. Importing the
  reconciler must stay free of side effects, or a test that imports it writes to the machine's real
  Claude Code settings — which is not hypothetical; it happened, and `install.test.ts` has the
  regression test for it.
- `hooks/*.mjs` and `mcp.mjs` are dependency-free Node scripts run by Claude Code, not by Paseo. The libraries
  they share with the server bundle (`context.mjs`, `asks.mjs`, `pointer.mjs`) live in `server/hooklib/`,
  because Paseo's compiler only bundles `client/`, `server/` and `shared/`; `hooks/` keeps re-export shims.
  They must stay runnable with no `node_modules` and must never fail the turn they are describing:
  wrap bookkeeping in `try`/`catch` and stay silent rather than erroring.
- `server/hooklib/pointer.mjs` owns the exactly-once handoff between `PostCompact` and `SessionStart`.
  `PostCompact` is **not** in Claude Code's `hookSpecificOutput` union, so anything it returns there
  is rejected wholesale and injects nothing (`RESEARCH.md` §3.3); it records and queues, and
  `SessionStart` with `source: "compact"` speaks. The two fire milliseconds apart for the same
  compaction, so the delivered-marker check is load-bearing, not defensive.
- Enrolment is resolved in `server/settings.ts`: an explicit answer in `enrolment.json` outranks the
  state-file inference in both directions. Toggling is read-modify-write over one file, so it goes
  through the serializer — concurrent toggles otherwise lose one another.
- `client/agents.ts` owns the one agent directory every composer pill reads. It must be an owned
  `agents.list({ subscribe: {}, signal })` observation; bare `agents.subscribe()` only listens
  locally and does not discover new agents (`RESEARCH.md` §5.1). Do not open a second one for a new
  pill: `check-bundles.mjs` asserts the observation is released exactly once.
- `client/pill.tsx` owns Smart Session's one composer pill, `client/pill-view.ts` what it says (plain
  functions, tested in `pill.test.ts`), `client/pill-store.ts` its Smart Compact state and
  `client/guard/status.ts` its protection state (one `smart-session.guard.status` poll per bundle). Pill state lives in
  a module-level store because the pill, its popover, the Command Center item and the screens are
  all in the one client bundle; that is what makes a toggle redraw immediately instead of waiting out
  a poll. A registration bakes in the workspace and cannot be patched, so an agent that moves
  workspace needs a new one, and one that closes must be dropped. The pill is a context ring (the
  arc is the session's context, the ticks its two compact lines, muted when the session is not enrolled)
  with the percentage as its label; context comes from the shared agent directory's `lastUsage`, so
  it moves every turn without a poll of its own. Pressing it opens `client/popover.tsx`: context,
  compact lines, task state, last compaction, the enrolment switch and the per-session **Pause at the
  limit** switch. While this process governs a pending pause for the session, the pill becomes the
  pause (amber glyph, "Resumes 5:58 PM") and its popover leads with it; that pill is registered even
  when the pill is hidden, so it goes on the host's own client, not through `button-visibility`.
  Only update `label`/`title` on change; a new `behavior` remounts an open popover. The label is a
  clock, not a countdown, for the same reason. There is no second pill: `check-bundles.mjs` refuses one.
- Views are screens, not surfaces: `addScreen("overview")` titled **Smart Session**, which holds the
  paused sessions (`params.focus = "paused"` opens it at that list), plus `paused-sessions`, kept as
  the overview opened at that list so old links still land, and the `addSidebarHeaderItem` row
  (trailing the session window's use, or the paused count from the status poll through
  `client/live.ts`). Settings are one screen, id `smart-compact` (the old first page's id, so links
  to it still land), titled **Settings**; ids live in `client/screens.ts`. `check-bundles.mjs` refuses
  `addSurface`, whose header shows the raw id, and a second settings screen.
- The feature keeps its name: where it is named as a feature (the settings section and its main
  switch, the overview's feature row, the popover's protection part, README and docs headings) it is
  **Pause at the limit (Session Guard)**; tight spots (pill title, chat card, toasts) may say
  "Pause at the limit", but the popover's protection part always shows "Session Guard". Don't call
  it "formerly" anything. Command Center items all start with "Smart Session"
  (`client/commands.ts`) and keep the old keywords ("guard", "session guard").
- Every ZeroSub subscription: `server/subscriptions.ts` keeps each new ZeroSub reading of an
  account other than the CLI's Claude login (which the recorder already measures) in
  `accounts-YYYY-MM.jsonl`, shaped like a usage sample plus `accountId`/`family`, keyed by ZeroSub's
  account id and never an email; it serves `smart-session.subscriptions` and `budget_status`'s
  optional `pool`. `shared/subscriptions.ts` holds the rules (`subscriptions.test.ts`): neutral names
  ("CLI login", "Account N") unless the person named the account, each account's work as its own
  stream that moves to ZeroSub's pick (the usable account with the lowest peak, then the default,
  the CLI login, the oldest) when it fills, resets refilling windows, and stale readings (> 30 min)
  adding no pace. Rows, the lead, the runway and the popover all read their times from that one
  simulation, so they never disagree. `client/subscriptions.ts` is the one poll; without ZeroSub
  (or with a single login) every view stays as it was.
- Paseo 0.16's usage card (`shared/usage-source.ts`, `server/usage-source.ts`): one source, `smart-session`, never
  `claude`. Invariant: **Paseo's own Claude card is hidden only while ours, for the same login, shows the same
  numbers beside it.** Ours takes the built-in's current reading for the login (`shared/builtin-usage.ts`; read from the
  daemon's cache in our fetch, never `forceRefresh` on a `claude:*` id; logins matched by email SHA-256 in memory only),
  and the recorder's minute listing refreshes our report when the built-in moved on. The hide (`client/usage-hide.ts`,
  rule in `shared/usage-hide.ts`) never waits on an RPC: a CSS grace animation holds the built-in back ≤1.5 s, then it is
  decided synchronously from the DOM. Prove a change frame by frame (requestAnimationFrame), cold and from cache.
- `shared/forecast.ts` turns a window reading into its moment: when it resets, when it runs out at
  this pace (the last half hour for the session, the window's own average for a week), and the
  per-hour pace that would last. Every view and `forecast.test.ts` read the same rules. Charts in
  `client/charts.tsx` are drawn with Views (plugins get no SVG library; the host `Icon` draws the
  square ring); magnitude is neutral ink, and amber/red mean a limit will bite or did.
- `client/chat.tsx` turns Smart Session's own MCP calls (`mcp__smart-session__*`, `smart-session.*`, and natively
  `mcp__paseo__smart_*`, `paseo.smart_*`)
  into one-line rows and the messages it sends (the agent's `/compact`, the continuation, Session
  Guard's continuation and Resume now) into cards. The parsing is in `shared/chat.ts` and tested in
  `chat.test.ts`; change it with the strings in `shared/governor.ts`, `mcp.mjs` and the guard engine.
- Command Center and sidebar icons go through Paseo's `resolvePluginIcon`, which **throws** on an
  unknown Lucide name and takes the whole contribution with it. Verify a name exists before using it.
- User-facing copy calls this **Smart Compact**, never "auto-compact". Claude Code ships a feature by
  that name with its own thresholds, and borrowing it makes the pill read as a switch for that one.
  `RESEARCH.md` §4.1 and `PLAN.md` do mean Claude Code's feature when they say auto-compact; leave
  those alone.
- **Compaction is always agent-mandated.** Nothing in this plugin may decide that a session should be
  compacted; `queue.add` is reached only from an agent's `request_compaction` or a person. The ask
  lives in the hooks and rides the agent's own turn. There are two lines per window profile
  (`compact` and `now` in `shared/thresholds.ts`, mirrored in `server/hooklib/context.mjs`): past the lower,
  end-of-turn line `hooks/ask-compact.mjs` asks on `Stop`; past the upper, mid-turn line
  `hooks/context-threshold.mjs` asks on `PostToolUse`, mid-turn, once per compaction epoch and again
  only after a deferral runs out. Both go through `hooks/ask.mjs` (text and guards) and
  `server/hooklib/asks.mjs` (ledger), so they never disagree about whether to speak. A saved settings file
  without `now` keeps its `compact` as the lower line and gains the default distance above it.
  User-facing words for both lines live in `shared/compact-lines.ts`.
- Smart Compact sends an agent at most two things, and `sendToAgent` has exactly two call sites: the
  `/compact` the agent asked for, and, when that agent requests one, a continuation message after it
  lands. Anything else it needs to hear comes from a hook. Adding a third is a design change, not a
  patch — if you think you need one, check `RESEARCH.md` §3.4 first, because it probably records why
  the hook route you are about to reimplement does not work. Session Guard's messages are separate
  and are listed in its own section.
- The optional continuation exists because no hook can restart a task after a compaction. The agent
  chooses whether to send it and may supply its exact text; omission preserves the state-aware
  default for compatibility. It is sent only for queue-originated compactions, so a `/compact` a
  person typed is never overridden.
- Deliver only at a turn boundary, only when task state on disk is current, and never retry an
  interrupted `/compact` — it is destructive and not idempotent.
- **A compaction counts only once it is confirmed.** Delivering `/compact` is not a compaction: the person or the
  client can cancel it ("Compaction canceled.") or it can fail, and the request stays `sent`. Confirmed means the
  context really emptied after delivery (under 60% of `preTokens`; the governor sets `confirmedAt`) or the session's
  PostCompact/SessionStart:compact hook recorded one after delivery (`compaction-events.jsonl`). Everything that reads
  "last compaction" goes through `confirmation` in `shared/governor.ts` (the hooks' mirror is `confirmedAt` in
  `hooks/ask.mjs`, pinned to it in `compaction.test.ts`): the thrash advice, the continuation, the popover's Last
  compaction. A delivery that never lands is settled with `NOT_COMPACTED` when its watch runs out. 2026-11-11: a
  cancelled `/compact` was read as a compaction and the Stop hook told the session compacting again "would not help".
- `settings.enabled` is the master switch; `showPill` and `autoEnrol` qualify it and mean nothing
  while it is off. There is no third pill state — a session is enrolled or it is not. With Smart
  Compact off the pill is drawn only while Pause at the limit runs here (muted ring, no tick).
- Do not log secrets, tokens, task-state contents, or message bodies. Credentials are read-only.

## Session Guard

- Code lives in `server/guard/`, `client/guard/` and `shared/guard/`; `server/guard/index.ts` is its
  wiring, `server/guard/engine.ts` decides what to pause and when to continue. The behaviour guide
  for users is `docs/session-guard.md`.
- It is **off by default** (`shared/guard/policy.ts`). Off, it holds no lock, creates no directory,
  draws no pill and touches no session. Do not change that default: an upgrade must never start
  freezing processes.
- Its state deliberately stays in `$PASEO_HOME/plugin-data/session-guard/`, the standalone plugin's
  directory, not under `plugin-data/smart-session/`. Both plugins take the same `governor.lock` there,
  which is the only thing that stops a host running both from pausing a session twice; and the
  standalone plugin's per-session overrides and confirmed waits carry over because they are the same
  `state.json`. Keep `StateSchema`, `PauseSchema`, the lock token format, the notification ids and the
  `quota-pause` timeline kind identical to the standalone plugin's while it can still be installed:
  its Zod parse strips unknown fields on every write.
- Never govern while the standalone plugin is configured and enabled, even with the lock free
  (`server/guard/standalone.ts`, matched by id, npm package, Git remote, manifest id or package
  name). Its released versions call `engine.stop()` on disable or uninstall without checking the
  lock, which resumes every suspended session in the shared state and rewrites it. A disabled copy
  has already run that teardown and is safe. If it becomes enabled while this process governs,
  `handBack()` releases suspended workers (keeping confirmed waits), gives up the lock and defers.
  If the plugin list cannot be read, do not take the lock.
- Exactly one process governs. Otherwise `server/guard/index.ts` takes the lock; a `LockHeldError`
  means another live governor and is a deferral, retried every 15 s, never a failure. Turned off,
  it gives the lock back only once no pause is pending. A deferring process must never call
  `engine.stop()` or otherwise touch the other governor's pauses or workers, and the UI must not
  offer actions on pauses it does not govern.
- Teardown must always give the lock back and must never stop other features' teardowns:
  `engine.releaseWorkers()` releases each pause independently, and `index.server.ts` runs every
  teardown through `runTeardowns`.
- Session Guard does speak to agents, separately from Smart Compact: it interrupts a turn
  (`cancelAgent`), suspends and resumes provider process trees with `SIGSTOP`/`SIGCONT` on Linux, and
  sends exactly two kinds of message — the configured continuation after a confirmed reset, and the
  **Resume now** message a person asked for. It never compacts, never retries an unconfirmed send,
  and never sends into a session whose user message or turn changed.
- Process signals are identity-checked by PID birth time and limited to direct children of this
  daemon carrying the agent's `PASEO_AGENT_ID`. Never widen that.
- Usage comes from Paseo's `provider.usage.list`, merged for Claude with the recorder's freshest
  accepted reading (`server/guard/usage.ts`). Only a reading with a provider `fetchedAt` may be
  merged: `resetReady` relies on it to prove a report is newer than the pause.
- Both of those measure only the CLI's own login. When ZeroSub is enabled, `shared/guard/zerosub.ts`
  measures each agent on its ZeroSub account and lets ZeroSub fail over first while another account
  has room (`docs/session-guard.md`, "With ZeroSub"). ZeroSub only switches on the CLI's limit
  notice, so a guard interrupt or SIGSTOP that comes first starves it. ZeroSub's files are read-only
  and parsed defensively. Never copy an email or a generated (`autoLabel`) label out of them, and
  never open an account home.
- The pill shows protection only while this process is the active governor; a pending pause keeps
  a session's pill up (even with the pill hidden) only while this process governs it.
- Agents see it only through `budget_status` (`server/agent-tools.mjs`), which asks
  `smart-session.guard.agent` about the calling agent (the daemon's caller id natively, `PASEO_AGENT_ID` in `mcp.mjs`). It is read-only: no agent-facing
  path may opt a session out or resume a pause.

## Verify changes

Never restart the Paseo daemon; it kills every running agent, including the one doing the work.
Reloading the plugin is safe.

### 1. Local checks

```sh
npm ci
npm run verify
```

`verify` is typecheck, the unit tests, and three structural checks, each guarding something typecheck
cannot see.

| Check | Guards |
| --- | --- |
| `check-bundles.mjs` | The dual-bundle boundary, plus the app's own registration validation, so a contribution Paseo would reject at install time fails here instead. |
| `check-gitinstall.mjs` | That both bundles still compile with no installed dependencies, which is what `paseo plugin add` does. |
| `check-teardown.mjs` | That the subprocess actually exits after cleanup, with defaults and with Session Guard on. A leaked timer wedges plugin reload. |
| `check-mcp-resolve.mjs` | That `mcp.mjs` can still reach the daemon client on a managed Git install, where `@getpaseo/client` exists only inside the global `paseo` CLI's own dependencies, not in this checkout's (nonexistent) `node_modules` — and inside the desktop app, where it exists only under `app.asar`. |

Hook behaviour is verified against the Claude Code binary *and* a live session, never against the
public docs — `RESEARCH.md` §3.4 records four answers the schemas alone got wrong. Extract with
`strings` on `~/.local/share/claude/versions/<v>`, then confirm with a throwaway `claude -p` session
under `--settings` pointing at logging hooks.

Tests run on Node's own runner with type stripping (`node --test --experimental-strip-types`). A new
test must fail on the unfixed code for the reason it claims — delete the line it covers and watch it
fail before believing it.

### 2. Load it

```sh
~/paseo-harness/tools/reload-gate run smart-session -- paseo plugin reload smart-session
paseo plugin ls
paseo plugin logs smart-session | tail -20
```

On Tom's VM every live `paseo plugin update|reload|install|enable` goes through `~/paseo-harness/tools/reload-gate`
(Tom's rule, 2026-11-11: at most one live reload window every 30 min, machine-wide, because each reload makes every
live agent pay a close+resume on its next message). Installing a published beta:
`~/paseo-harness/tools/reload-gate npm-beta smart-session paseo-smart-session` (exit 10 = already on it). Bypass only
with `RELOAD_GATE_BYPASS="<Tom's words>, <when>"`. Harness daemons (temp `PASEO_HOME`) are exempt.

Clean logs means no `[paseo]` error lines and no stack traces around the reload.

### 3. Backend, over the protocol

`probe.mjs` calls any plugin RPC without a UI, against the running daemon:

```sh
node probe.mjs rpc smart-session.budget '{}'
node probe.mjs rpc smart-session.context '{}'
node probe.mjs rpc smart-session.settings.get '{}'
node probe.mjs rpc smart-session.enrolment.state '{}'
node probe.mjs rpc smart-session.guard.status '{}'
node probe.mjs agents            # id, status and lastUsage for every agent
```

Round-trip anything that writes, and put the setting back afterwards. Nothing here should be run
against a daemon whose agents you do not own.

### 4. The agent-facing side

Hooks are plain stdin/stdout programs, so exercise them directly rather than by waiting for a
session to hit a threshold:

```sh
echo '{"session_id":"s1","transcript_path":"/tmp/t.jsonl","cwd":"/tmp"}' \
  | PASEO_HOME=$(mktemp -d) node hooks/context-threshold.mjs
```

`hooks.test.ts` drives every hook this way. Remember that Claude Code validates
`hookSpecificOutput.hookEventName` against a *smaller* union than its list of events, and rejects the
whole output on a name outside it.

### 5. The UI

The screens, the pills, the chat rows and the Command Center items can only be checked by looking. Say so plainly
when you have not looked, and never describe a screenshot you did not take.

## Create a release

- Release user-facing features, bug fixes, compatibility changes, data migrations, or installer
  changes. Documentation-only edits normally do not need a release.
- Use SemVer: patch for compatible fixes, minor for backward-compatible features, major for breaking
  behaviour, storage, or compatibility changes. Anything that changes an on-disk shape is major
  unless it migrates.
- Update the version in `package.json` and its lockfile, `PLUGIN_VERSION` in `shared/version.ts`
  (`version.test.ts` fails until they match), plus the pinned npm and Git versions in the README
  install section. Keep badge styles consistent; update the Paseo minimum only when
  compatibility changes.
- **Release notes: one format for every GitHub release**, shared with Tom's other plugins (Follow-up). The publish
  workflow builds the body with `release-notes.mjs` from git at the tag and creates (or rewrites) the GitHub release,
  titled `Smart Session vX.Y.Z`, after npm is verified. Never write a release body by hand. The layout:
  `## What's new` (the notes), `## Install` (install and update commands; a prerelease also names npm's `beta`
  dist-tag and the current stable; then the Paseo minimum), and one line saying the release passed verification.
  - **A PR that changes something users see adds `changes/<branch>.md`**: "- " bullets saying what the user gets
    (rules in `changes/README.md`; `npm run verify` lints them: no em dash, emoji, PR numbers, or bullet over 240
    characters).
  - **A beta's notes** are the fragments its tag added since the previous release tag. A beta that changes nothing a
    user runs says "Maintenance release; no user-visible changes."; one that changes runtime code with no fragment
    fails the release.
  - **rc and stable notes are curated, never a dump.** Before an rc or stable, run `node release-notes.mjs prepare
    X.Y.Z`: it moves the pending fragments into a new `## X.Y.Z (date)` section of `CHANGELOG.md` and deletes them.
    Then rewrite that section by hand: a one- or two-sentence lead, bullets grouped under `### <what the user gets>`,
    biggest first, and a closing `### Upgrading from X.Y` for breaking changes, migrations, security notes or manual
    steps. Every `X.Y.Z-rc.N` carries X.Y.Z's section. Ask Tom to read it with the permission request.
  - The workflow refuses, before anything reaches npm, when the notes are missing, empty or boilerplate only ("Bug
    fixes", "See commits"). `node release-notes.mjs body vX.Y.Z` prints the body it will publish; `release-notes.test.ts`
    holds the rules and pins the workflow to them.
  - In-app What's new stays for majors only; the GitHub release always carries the notes.
- Before pushing the release tag, require a clean current `main`, verified GitHub and npm ownership,
  passing checks, `npm pack --dry-run`, a successful plugin reload, clean logs, and a secret audit
  of the exact release snapshot.
- Tag the exact release commit as `vX.Y.Z` and push the tag. `.github/workflows/publish-npm.yml`
  verifies that the tag matches `package.json`, reruns the release checks, inspects the package,
  and publishes through npm Trusted Publishing; do not run `npm publish` manually except to
  recover from a diagnosed workflow failure.
- **Betas only by default.** `release-tag.mjs` picks the npm dist-tag before anything else: a
  prerelease version (`X.Y.Z-beta.N`) publishes to `beta`, and a stable version fails the workflow
  unless someone runs it by hand (`workflow_dispatch`) with `allow_latest=true`. Moving `latest` is
  always an explicit human step. The workflow then checks that the release sits on its tag and that
  a beta never moved `latest`. `release-tag.test.ts` holds the rules and pins the workflow to them.
  A prerelease's GitHub release is marked pre-release.
- **A release needs Tom's manual permission, every time.** No agent releases on its own. Features and fixes ship to a
  beta by default (`X.Y.Z-beta.N`, npm `beta` dist-tag). Anything else needs Tom's explicit OK for that exact version
  before it's tagged: an rc (`X.Y.Z-rc.N`), a stable version, npm `latest` (the workflow's `allow_latest` run), or a
  hotfix (a hotfix skips the beta, not the permission). Ask him, and quote his OK in the release commit body.
- Wait for the publish workflow and npm registry propagation, then verify installation with
  `paseo plugin install npm:paseo-smart-session@X.Y.Z` on Paseo 0.9 or newer. Check the GitHub release the
  workflow published, and test the public tag-pinned installer and badge URLs.

Never move or rewrite a published tag. Ship corrections as a new patch release.

## Automated publishing recovery

The npm release workflow supports `workflow_dispatch` with an existing `tag` for recovery without rewriting tags. It checks that the checked-out tag is on `main` and matches package versions. Use Node 24 and npm 11.20.0 with GitHub OIDC; do not set `registry-url` on setup-node or configure token-placeholder authentication. Retrying an already-published package requires its registry integrity to match the packed snapshot. A new publish is verified against the registry before downstream release steps continue.

## Agent tools

The tools live in `server/agent-tools.mjs`, shared by both transports. `server/session-mcp.ts` attaches them only to
interactive Claude/Codex sessions:

- **Native (Paseo 0.15+).** `server/native-tools.ts` puts them on `request.tools` as `smart_*`; the daemon serves them
  through the agent's own Paseo MCP and calls them in this process (`index.server.ts` records every RPC handler so
  they run in-process). The caller's id is the daemon's. Names keep the `smart_` prefix: a collision with Paseo's own
  tools fails the agent's whole Paseo tool list.
- **Stdio fallback** for this launch only, when `request.tools` is absent (0.14), the daemon's MCP or its injection
  is off, or the provider's `paseoTools` disables them.
- `SMART_SESSION_TOOLS=native|stdio` in the agent env tells the hooks which names to use (`named`/`forTools` in
  `server/hooklib/context.mjs`); sessions opened before the change keep the bare names.
- **Updates detach native tools.** A plugin reload drops them from open sessions until each reopens, which Paseo 0.15.2
  does only before the agent's next prompt. The worker records its instance (`tools-instance.json`) and each attach its
  instance (`tools/native-<agentId>.json`); a mismatch is "detached", and the asks and a failed `smart_*` call point
  the agent at `node mcp.mjs call <tool> '<json>'` meanwhile.

`check-native-tools.mjs` (`npm run test:native`, in CI) proves it against an isolated daemon: no per-agent server,
the tools answer as the calling agent, and across a plugin reload the native call fails mid-turn, the bridge works,
and the native call works again after the next prompt. `--start-time` measures opening an unloaded Claude agent with
no tools, the stdio server and native tools (local only; needs a logged-in `claude`).

## Publishing as the main account

- An artifact belongs to the account of the session that publishes it. `hooks/publish-as.mjs` (a `PreToolUse` hook,
  matcher `Artifact`, timeout 180 s; logic in `server/hooklib/publish-as.mjs`) asks the plugin
  (`smart-session.publish_as.start`/`.wait`) whether to take a publish over, and when it does answers "deny" with the
  link. That reason leads with the success and says not to retry; `publish-as.test.ts` pins the wording.
- The decisions are pure, in `shared/publish-as.ts`: only a publish that creates a page, a `type_url` create, or an
  update/asset upload to a url in `publish-as/pages.json` is taken over, and only for a caller on another Claude account
  than the target. Everything else, and every url we didn't make, passes through. ZeroSub unreadable: pass, with a note.
- `server/publish-as.ts` runs the helper: create (background, Haiku, chosen id, label `smart-session.helper=publish-as`,
  env `SMART_SESSION_PUBLISH_HELPER=1`), pin with ZeroSub's `zerosub.agents.account`, reopen with our own
  `refreshAgent` (ZeroSub's CLI reload doesn't find a new background agent), confirm ZeroSub's session record says the
  target, then prompt, wait (capped), and archive in a `finally`. One at a time; each run is logged. Never prompt a
  helper that isn't confirmed on the target, and never read a credential file.
- Hooks follow features (`managedFor` in `server/install.ts`): the compaction hooks are registered while Smart Compact is
  on, `PreToolUse(Artifact)` while publishing as the main account is on, and each is removed when its feature is turned
  off. So "Register the hooks" stays usable with Smart Compact off, and a fresh install with Smart Compact off still gets
  the Artifact hook (`install.test.ts`).
- Owner names come from `ownerName`: the person's own label or a neutral name, never an email or a generated label.
- A seat session reads its ZeroSub home's `settings.json`, which ZeroSub links to the main one. Never write into
  those homes: per-home copies are how a hook silently stops reaching seat sessions (2026-11-10).
  `server/settings-links.ts` only checks the links (read-only) and `install()` reports a broken one in `homes`,
  shown on the settings page and by `publish_as_settings`.

## Chat timeline

Timeline transforms must not break Paseo's grouping. Paseo groups only tool_call and thought items, and a transform can
only return plugin items, so a transformed call always leaves the group and renders loose. Every agent tool is
classified in `TOOL_PRESENTATION` (`shared/chat.ts`); routine bookkeeping returns null and stays Paseo's own call, and
only a moment the developer must see becomes a row. Classify a new tool there (`chat-grouping.test.ts` fails otherwise).
