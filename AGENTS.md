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
- Every direct daemon connection, including `server/daemon.ts`, `mcp.mjs`, and `probe.mjs`, must pass
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
  add, update or remove entries whose command points at this checkout's `hooks/*.mjs`; it must never
  write a path it has not confirmed exists, must not write at all when reconciling changes nothing,
  and must leave a malformed file alone rather than rewriting it from a partial parse. MCP
  attachment goes through `server.before("agent.session_open")`. Global registration is an explicit
  legacy operation through `claude mcp add-json`; never edit `~/.claude.json`, which holds credentials.
- The load-time call lives in `server/install-on-load.ts`, not in `server/install.ts`. Importing the
  reconciler must stay free of side effects, or a test that imports it writes to the machine's real
  Claude Code settings — which is not hypothetical; it happened, and `install.test.ts` has the
  regression test for it.
- `hooks/*.mjs` and `mcp.mjs` are dependency-free Node scripts run by Claude Code, not by Paseo.
  They must stay runnable with no `node_modules` and must never fail the turn they are describing:
  wrap bookkeeping in `try`/`catch` and stay silent rather than erroring.
- `hooks/pointer.mjs` owns the exactly-once handoff between `PostCompact` and `SessionStart`.
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
  arc is the session's context, the tick its compact line, muted when the session is not enrolled)
  with the percentage as its label; context comes from the shared agent directory's `lastUsage`, so
  it moves every turn without a poll of its own. Pressing it opens `client/popover.tsx`: context,
  compact line, task state, last compaction, the enrolment switch and the per-session **Pause at the
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
- `shared/forecast.ts` turns a window reading into its moment: when it resets, when it runs out at
  this pace (the last half hour for the session, the window's own average for a week), and the
  per-hour pace that would last. Every view and `forecast.test.ts` read the same rules. Charts in
  `client/charts.tsx` are drawn with Views (plugins get no SVG library; the host `Icon` draws the
  square ring); magnitude is neutral ink, and amber/red mean a limit will bite or did.
- `client/chat.tsx` turns Smart Session's own MCP calls (`mcp__smart-session__*`, `smart-session.*`)
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
  lives in `hooks/ask-compact.mjs` on `Stop`, where it rides the agent's own turn.
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
- Agents see it only through `budget_status` in `mcp.mjs`, which asks
  `smart-session.guard.agent` about the calling `PASEO_AGENT_ID`. It is read-only: no agent-facing
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
paseo plugin reload smart-session
paseo plugin ls
paseo plugin logs smart-session | tail -20
```

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
- Update the version in `package.json` and its lockfile, plus the pinned npm and Git versions in the
  README install section. Keep badge styles consistent; update the Paseo minimum only when
  compatibility changes.
- Release notes must include a short summary, user-visible changes, the npm install
  command, the minimum Paseo version, and any breaking, migration, security, or upgrade
  considerations. Omit empty sections.
- Before pushing the release tag, require a clean current `main`, verified GitHub and npm ownership,
  passing checks, `npm pack --dry-run`, a successful plugin reload, clean logs, and a secret audit
  of the exact release snapshot.
- Tag the exact release commit as `vX.Y.Z` and push the tag. `.github/workflows/publish-npm.yml`
  verifies that the tag matches `package.json`, reruns the release checks, inspects the package,
  and publishes through npm Trusted Publishing; do not run `npm publish` manually except to
  recover from a diagnosed workflow failure.
- Wait for the publish workflow and npm registry propagation, then verify installation with
  `paseo plugin install npm:paseo-smart-session@X.Y.Z` on Paseo 0.9 or newer. Title the GitHub
  release `paseo-smart-session vX.Y.Z`, and test the public tag-pinned installer and badge URLs.

Never move or rewrite a published tag. Ship corrections as a new patch release.

## Automated publishing recovery

The npm release workflow supports `workflow_dispatch` with an existing `tag` for recovery without rewriting tags. It checks that the checked-out tag is on `main` and matches package versions. Use Node 24 and npm 11.20.0 with GitHub OIDC; do not set `registry-url` on setup-node or configure token-placeholder authentication. Retrying an already-published package requires its registry integrity to match the packed snapshot. A new publish is verified against the registry before downstream release steps continue.

## Paseo 0.14 session tools

`server/session-mcp.ts` attaches the MCP only to interactive Claude/Codex sessions. Preserve the caller identity and other launch contributions. Do not register a global MCP during load. Tests cover history opens, opt-out, disabled settings and all open reasons.
