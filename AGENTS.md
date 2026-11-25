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

- **Invariant: Smart Session never loses session data, and changes only the files it means to.** Before it changes a
  Claude transcript it writes a full copy, checks the copy's sha256, and never deletes a backup, used or not; only the
  user removes one (a source scan in `history-shed.test.ts` holds every `unlink` to temp names, the lock, second
  names of one file, and subagent files verified in the backup; there is no `rm`). The only files that may change are
  the transcript resolved from the agent's persisted session id and the subagent files that were backed up with it.
  Ambiguity (two records, two transcripts, an unreadable plan) means no change, and nothing is ever deleted by pattern.
  `history-shed.test.ts` fingerprints every file around each step.
- **Invariant: a line written at any moment of a shed or a restore is in the result, or the change is undone with the
  line in place.** A writer the holder scan can't see (a terminal `claude -c`, which opens the file only while it
  writes) may append at any point. The original stays open and keeps a second name until the swap proves quiet; the
  size, mtime and inode check is the last thing before the rename, with no `await` between them; after the rename the
  old file must have no holder and no new byte, or it goes back under its name and anything written to the new file is
  appended after it. Tested by writing through an fd opened before the commit at every step.
- `$PASEO_HOME/plugin-data/smart-session/` holds the only copy of plan-utilization history that
  exists anywhere. `/usage` is a snapshot, Paseo's quota fetcher keeps no store, and Claude Code
  overwrites its cache in place — a percentage of a plan limit cannot be reconstructed after the
  fact. Append, never rewrite; one JSON line per observation; read back defensively so one corrupt
  line cannot cost a month of history.
- The data path is fixed and deliberately decoupled from the install id, so a second install under
  `--id something-else` cannot start a second history. It also means a second install runs a second
  recorder and a second governor over the same files.
- Preserve the on-disk shapes: `usage-YYYY-MM.jsonl`, `context-YYYY-MM.jsonl`, `accounts-YYYY-MM.jsonl`, the account-use
  logs below (`placement-`, `holds-`, `moves-`, `credits-YYYY-MM.jsonl`), `settings.json`,
  `enrolment.json`, `compactions.json`, `state/<agentId>.md`. Migrate rather than break them.
- **Invariant: every usage reading says whose it is (`usage-account-identity`).** The recorder reads only the CLI's own
  Claude login: its `~/.claude` credentials (upstream), its cache (`.claude.json`), and that login's report out of the
  daemon's listing. Paseo 0.16 lists one built-in report per login a session runs on, so under ZeroSub the seats'
  reports sit beside the CLI login's; `cliListing` (`shared/builtin-usage.ts`) picks it by the email's SHA-256 (ZeroSub's
  main Claude account), and with nothing to match only a listing with one built-in report is read. Root cause it fixes
  (2026-11): `legacyListing` named every login's report `claude` and `fromPaseoProviderUsage` took the first, so `paseo`
  rows were sometimes a seat's (weekly resets interleaved between two logins) and every row said `account: null`.
  Each row now carries `login: "cli"` and `accountId` (ZeroSub's id, `claude-main`; null without ZeroSub). Rows from
  before 3.8.0-beta.9 have neither: readers treat them as unknown, never as another account (`account-log.test.ts`).
- **Invariant: a window's reset is never shown as the next reset once it has passed (`past-reset`).** A reading with
  no reset after the held window's reset is a new window not yet started (`segmentBlocks` seals the old block; the
  row says "starts at first use"); a reset that passed with no newer reading is past tense with "no reading since"
  (`windowResetText`); a moment six days or more away names its date (`formatMoment`). Root cause it fixes
  (2026-11): ZeroSub's fresh `five_hour {pct: 0, resetsAt: null}` joined Wednesday's block, so a fresh reading read
  "5h reset · was Wed 3:59 PM", and next Friday's weekly reset read "resets Fri 4:00 AM" on a Friday morning.
- **Invariant: a pace is never measured over less than `MIN_RATE_SPAN_MS` (10 min), and a window's opening counts as
  a 0% reading** (`burnRatePctPerHour`). Whole percents a minute apart read as 20-60%/h, so an account at 1% "ran out"
  within the hour in the pool forecast (`blocks.test.ts`).
- The pool headline names each account once in its hand-off chain, at the first moment it takes work over
  (`poolHeadline`); the simulation still keeps every stream's takeover for the per-account sentences.
- A plan whose readings carry windows but no 5-hour one (Codex here reports only its week) shows "only a weekly
  limit" in place of the session-window blocks (`sessionWindowState` `none`), not "none recorded yet".
- **Invariant: every account shows everything the main account shows (`account-parity`).** One per-account model,
  `Subscription` (`shared/subscriptions.ts`), carries every window under the recorder's ids (`claudeWindowId`: ZeroSub's
  `seven_day_opus` is `weekly_model:opus`), the open window's chart points, 14 days of earlier session windows, Extra
  usage and where the history comes from (`recorded`). The server builds it the same way for every account
  (`buildView`: the main account from `usage-*.jsonl`, the others from `accounts-*.jsonl`); without ZeroSub the CLI
  login becomes the same model (`recordedAccount`). The overview draws every account through one row and one details
  fold (`AccountRow`/`AccountDetails` in `client/subscriptions-view.tsx`); main is just the account with the Main
  name or chip, pinned first. A section with no data says so instead of disappearing. Root cause it fixes (2026-11):
  the chart, earlier windows and per-model caps were drawn only in a "CLI login · history" section fed by
  `budget_status`, while a seat's row had two mini meters though its history sat in `accounts-*.jsonl`.
  `subscriptions.test.ts` holds every account to the main account's `accountSections`. Never "CLI login" in user copy:
  the main account is "Main" (`subscriptionName`), or the person's name with a Main chip (`showsMainChip`).
- Session Guard reads Paseo's listing through `cliOnlyUsage` (`server/guard/usage.ts`): Paseo 0.16 lists every login's
  Claude report as `claude`, and the guard took the first, so a main session could be held or released on a seat's
  numbers (`guard-usage.test.ts`). The CLI login's hash comes from `server/cli-login.ts`, which has no side effects:
  importing the recorder from the guard kept test processes alive.
- **The account-use logs** (`shared/account-log.ts` rules, `server/account-log.ts` writer), append-only monthly JSONL
  beside the others, ids only (agent ids, ZeroSub account ids, flags, times, numbers; never a title, prompt, email,
  generated label or path). Written on the recorder's minute tick from the agent listing and the ZeroSub snapshot it
  already reads once a tick; nothing else is read after the first tick.
  - `placement-YYYY-MM.jsonl`, one row a minute while any Claude/Codex agent is open:
    `{at, accounts: {<accountId>: {running, idle, other?}}, running: [agentId], agents?: {agentId: accountId}}`.
    `agents` (the full map) is written only when it changed and on a process's first row; carry the last one forward.
    Without ZeroSub the key is `claude-cli`/`codex-cli`; an agent ZeroSub can't place is `<family>-unknown`.
  - `holds-YYYY-MM.jsonl`, when Session Guard saves a hold starting or ending (the guard `Store`'s observer, so every
    path that writes a pause is logged): `{at, event: "start"|"end", pauseId, agentId, provider, accountId, windowId,
    reason: limit|quota-failure|idle|demo, pausedAt, resetsAt, nextRoomAt, outcome?, phase}`. After a reload an open
    hold is logged as a start again: dedupe by `pauseId`.
  - `moves-YYYY-MM.jsonl`, when ZeroSub's `state.json` shows an agent's session on another account than a minute ago
    (read only; we don't own ZeroSub): `{at, agentId, family, from, to, reason, openedAt}`; `from` null is a new
    placement; `reason` is ZeroSub's binding source (`pace`, `auto`, `balance[:<selectionReason>]`, `thread`, `user`),
    else `limit` when `from` was limited, else `unknown`. A process's first tick is a baseline, so a move during a
    reload gap is missed.
  - `credits-YYYY-MM.jsonl`, per ZeroSub account (the CLI login included) when its Extra usage, credits or limit state
    changes: `{at, accountId, family, fetchedAt, extraUsage: {enabled, spend, limit, currency}|null, credits: {balance,
    unlimited}|null, limitedUntil, limitKind, signedIn, disabled}`; money in minor units.
  - `decisions-YYYY-MM.jsonl`, the placement rule's decisions while `placement.mode` isn't `off` (written by
    `server/placement.ts`, rules in `shared/placement-shadow.ts`), each with `{at, kind, mode, agentId}`: `place` (a
    new session: ZeroSub's `actual` and the rule's `pick`), `move` (`from`, `to`, `reason`, `gain`, `cost`, live only
    `outcome`), `forced` (a limit move: `from`, `to`, `foreseen` when the rule flagged it in the hour before).
  - Read back with `readAccountLog`, which skips a torn line or a row without a valid `at`.
- **The Accounts report: how well the accounts were used (`accounts-report`).** `shared/accounts-report.ts` is pure and
  deterministic (no clock, file or setting inside; `accounts-report.test.ts` uses small fictional histories);
  `server/accounts-report.ts` reads the logs, `smart-session.accounts.report` serves it (cached 5 min) and
  `smart_accounts_report` gives an agent the same report as text (`reportLines`). Rules:
  - Demand is counted in points, 1% of one standard account's week (`settings.accountsReport.sizes` scales a bigger
    plan): each account's weekly increase × its size, plus Session Guard hold time × the burn rate before the hold, plus
    Extra usage time × the burn rate before the limit. Whose readings are whose follows `usage-account-identity`: the
    main account is only `login: "cli"` rows, or `src: "upstream"` rows from before the labels (`trustedMainRow`);
    the `paseo` source mixed logins and is never read here.
  - The replay places that demand on N-1, N and N+1 accounts through a `PlacementPolicy` (a pure function: accounts
    in, preference order out). Add, drop and keep are judged against the accounts there now, each present for the whole
    window (`presentAllAlong`; an account added mid-window counts as there all along). `replay.historical` replays the
    accounts as they joined and only describes what happened; it never drives a suggestion. Today's behaviour is `paceWithGate` (pace score, the 5-hour gate at 80%); a new placement
    rule is scored by adding it to `POLICIES` and replaying the same demand. The replay is fluid (work splits and moves
    for free), so it is a lower bound on waiting for every account count alike; compare counts, not absolutes.
  - A reading stands for 6 h (`CARRY_MS`); past that an account is unknown, never at a limit, never room. An account
    added later is not room before its first reading. Waiting exists only since the holds log began, and the page says
    so ("waiting measured since"). A misplaced stretch from before the moves log has cause `not-logged`, never a guess.
  - An account with fewer than two full weekly windows is never suggested for dropping; it shows "verdict on <date>".
    It is "new" only when its first reading came after the family's history began (more than `CARRY_MS` later); one
    there from the first readings just lacks history ("Not enough history yet"). The verdict date lives in the
    suggestion's title, never repeated in its body. Every span the report names (the replay, the page's basis line,
    the text header) is `historyDays`, the days the readings cover, so a history younger than 14 days reads alike.
  - **Invariant: the page and `smart_accounts_report` say the same words.** Suggestions, the basis line
    (`reportBasis`) and the placement line (`placementFacts`, which `placementLine` wraps) are built in `shared/`
    and only drawn by the client. Root cause it fixes (2026-11): the client had its own placement sentence, which
    said "placed 0 of 0 new sessions elsewhere" and left out the rebalances the text reported.
    While one added mid-window awaits its verdict, "add" never fires: the report says how much of the waiting that
    account alone would have covered and its verdict date. Every suggestion carries its numbers and its data window.
    One is shown: add, then use-better, then drop, then keep.
- **Placing sessions (`placement`).** `shared/placement.ts` is pure like the report; `docs/placement.md` has the math
  and the benchmark (`placement-bench.ts`, fictional scenarios only). The shipped rule is `expiring-first`: the pace
  score, with an account whose 5-hour wall comes within `WALL_HOURS` (1 h, by `forecastWindow`) behind the rest, and
  the pace score deciding again when none passes. Moves: a session ahead of an imminent wall (gain beats the cost),
  otherwise today's 1.5x rebalance, under today's guards. Rules:
  - A new rule or variant is scored in both replays before it ships: the fluid `replay` (free moves, a lower bound)
    and `replaySessions` (sessions stay put; a session its account can't serve is cut off and moved, a forced move
    costing Session Guard's grace). Compare against `pace-5h-gate` with the 1.5x rebalance, on fictional scenarios in
    tests and on the real logs locally; real numbers never go into the repository.
  - **Invariant: a 5-hour wall never outranks expiring weekly budget.** The 5-hour check only reorders accounts
    within the pace score's tiers, and only for a wall within `WALL_HOURS`; the strict check (any wall before the
    window resets) kept work off expiring budget and lost far more waiting than the moves it saved
    (`placement.test.ts`).
  - **Invariant: the replay never counts an account as room before its first reading** (`ReplaySpec.from`). Root
    cause it fixes (2026-11): `specOf` started an account added mid-period as empty and usable from the period's
    start, so with a seat added two days ago the report replayed 14 days with it and showed no waiting.
  - The rule runs beside ZeroSub on the recorder's minute tick (`server/placement.ts`), `settings.placement.mode`
    `off`, `shadow` (default) or `live`. The Accounts section and `smart_accounts_report` set its decisions beside
    what happened over the report's window (`placementSummary`): turns cut off at a limit, forced moves and how many
    the rule saw coming, waiting.
  - **Invariant: shadow mode changes nothing.** It reads the snapshot and the agent listing it is given and writes
    only `decisions-*.jsonl`; no RPC, no pin, no ZeroSub file (`placement-shadow.test.ts`).
  - **Invariant: live acts only through `move_before_limit`, one agent at a time, under the same guards, never a
    default flip or a reconcile.** New sessions keep ZeroSub's pick (Paseo's create config carries no metadata).
    Live is refused (the setting keeps its old value and says why) unless the installed ZeroSub has the lever, found
    by its RPC name in its files, not by version, and ZeroSub's own pacing is off (the fork's `paceWeeklyUsage`,
    default on; upstream's `balanceNewAgents`, "Spread new agents across accounts", default off): two rebalancers would fight. A refusal found later runs the tick as shadow.
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
- **Invariant: every way an agent or a hook runs a daemon-backed script reaches the daemon on the desktop app.**
  `launcherFor` (`server/hook-path.ts`) is the one rule for that runtime: `mcpDefinition` registers the MCP server
  with it, and `pointShimsAt` records it in `current.json` (`runtime: {command, env}`, only under Electron). The shims
  of `NEEDS_DAEMON` (`mcp.mjs`, `publish-as.mjs`) started by plain `node` run their script on it instead (same args,
  stdio and exit code; `SMART_SESSION_ON_RUNTIME` stops a loop; a runtime that is gone runs in-process as before), and
  the detached notice prints `bridgeCommand` (`server/hooklib/runtime.mjs`): `ELECTRON_RUN_AS_NODE=1 '<app runtime>'
  '<shim>'`, single-quoted, or `node '<shim>'` elsewhere. Other hooks stay in-process. Root cause it fixes (3.7.0): the
  notice said `node "<shim>" call ...`, which can't load the app's client, so every daemon-backed tool failed through
  the bridge, and the `publish-as` hook failed the same way (`bridge-runtime.test.ts`, a fake app layout).
- `mcp.mjs` refuses arguments a tool's schema doesn't take, and missing required ones (`argumentProblem` in
  `server/agent-tools.mjs`; exit 2 for `call`, a tool error over stdio): `{"continue": false}` to `request_compaction`
  was ignored, so it compacted and then started another turn. Native tools are checked by Paseo.
- **Invariant: one held daemon connection per process, closed in teardown (one-held-daemon-connection).** Every
  daemon call goes through `withDaemon`, which runs on `sharedDaemon`'s one connection (`server/daemon.ts`;
  `openDaemon` is the only place a `DaemonClient` is built). It reopens only after a real drop (the client's
  connection status, or a failed call on a socket no longer `connected`), with backoff after a failed open, and is
  replaced after `SHARED_CLIENT_MAX_MS`. Session Guard holds its own (opened on its first call for quota
  protection or an observed turn eligible for transient recovery), so its teardown can't cut a governor delivery.
  A held socket keeps the event loop alive, so `closeDaemon` runs last in `index.server.ts`'s teardown; otherwise "Stopping plugin" hangs and reload wedges for the life of the
  daemon. Every other timer and resource is released through `shared/lifecycle.ts`; `check-teardown.mjs` enforces
  both. 2026-11-18 live: a WebSocket per call meant about 13-17 hellos a minute; `daemon-connection.test.ts` pins 20
  calls to one connection.
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
  stream that moves to ZeroSub's pick (an account under its 5-hour gate first, then the lowest peak, then the default,
  the CLI login, the oldest) when it fills, resets refilling windows, and stale readings (> 30 min)
  adding no pace. Rows, the lead, the runway and the popover all read their times from that one
  simulation, so they never disagree. `client/subscriptions.ts` is the one poll; without ZeroSub
  (or with a single login) every view stays as it was.
- The usage source registers only the Claude provider hint, since it discovers only Claude accounts. Reports preserve their reading time in `observedAt`; known session and weekly windows carry `durationSeconds`.
- Paseo 0.16's usage card (`shared/usage-source.ts`, `server/usage-source.ts`): one source, `smart-session`, never
  `claude`. Invariant: **Paseo's own Claude card is shown only when it may know something ours doesn't.** Ours takes
  the newer of ZeroSub's reading and the built-in's for the login (`shared/builtin-usage.ts`; read from the daemon's
  cache in our fetch, never `forceRefresh` on a `claude:*` id; logins matched by email SHA-256 in memory only), and the
  recorder's minute listing refreshes our report when the built-in moved on. Beside ours, the built-in card steps
  aside when both show the same numbers, or when it shows a reading the server knows ours is at least as new as
  (`supersedes`: a 429's last good reading, a window whose reset passed). 2026-11-11: an errored built-in card stayed
  beside ours because only equal numbers hid it. The hide (`client/usage-hide.ts`,
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
- Smart Compact sends an agent at most two things, and `sendToAgent` has exactly two call sites (both in
  `server/compaction-tick.ts`, through the tick's `io`): the `/compact` the agent asked for, and, when that agent
  requests one, a continuation message after it lands. Anything else it needs to hear comes from a hook. Adding a third is a design change, not a
  patch — if you think you need one, check `RESEARCH.md` §3.4 first, because it probably records why
  the hook route you are about to reimplement does not work. Session Guard's messages are separate
  and are listed in its own section.
- The optional continuation exists because no hook can restart a task after a compaction. The agent
  chooses whether to send it and may supply its exact text; omission preserves the state-aware
  default for compatibility. It is sent only for queue-originated compactions, so a `/compact` a
  person typed is never overridden.
- **Invariant: a confirmed compaction's continuation is never silently dropped.** A compaction the session's
  PostCompact/SessionStart:compact hook recorded after delivery is confirmed at once, whatever the agent is doing (the
  token-drop check still needs idle). From then its continuation is owed (`continuationOwed`, read from the queue, so
  a reload or a long turn doesn't lose it) until one of three things: the governor sends it at the next idle moment;
  a prompt that reached the session first carries it as `additionalContext` (`hooks/continuation.mjs`, on
  `UserPromptSubmit` through `detached.mjs`: "answer this message first, then carry on"); or `CONTINUATION_CAP_MS`
  (2 h) after the compaction passes, when it is dropped and logged. Whoever creates
  `continuations/<requestId>.json` (exclusive create, `server/hooklib/continuation.mjs`) delivers it, so the hook and
  the governor never both do; only the agent's newest delivered compaction can owe one (`supersededBy`; an older owed
  row is dropped as `stale`: beta.19 sent an agent two after its install); the queue records which (`resumedVia`: `sent`, `prompt`, `stale`) and the popover's
  Last compaction says it (`continuationNote`). Only queue rows owe one: a `/compact` a person typed is followed by
  nothing, and a hook record more than `LANDS_WITHIN_MS` after a delivery the governor never saw land doesn't confirm
  it. Root cause it fixes (2026-11-23): landing was checked only while the agent was idle, within 5 minutes of
  delivery; a person's message right after the compaction kept it busy, the watch ran out, `settleUnlanded`
  confirmed it from the hook's record and the continuation was never sent (`continuation.test.ts`).
- Deliver only at a turn boundary, only when task state on disk is current, and never retry a `/compact` whose send
  a restart interrupted (`recoverInterrupted`): it is destructive and not idempotent, and nobody knows whether it ran.
  A `/compact` Claude Code reports cancelled is different: no compaction ran, so it is retried (below).
- **A compaction counts only once it is confirmed.** Delivering `/compact` is not a compaction: the person or the
  client can cancel it ("Compaction canceled.") or it can fail, and the request stays `sent`. Confirmed means the
  context really emptied after delivery (under 60% of `preTokens`; the governor sets `confirmedAt`) or the session's
  PostCompact/SessionStart:compact hook recorded one after delivery (`compaction-events.jsonl`). Everything that reads
  "last compaction" goes through `confirmation` in `shared/governor.ts` (the hooks' mirror is `confirmedAt` in
  `hooks/ask.mjs`, pinned to it in `compaction.test.ts`): the thrash advice, the continuation, the popover's Last
  compaction. A delivery that never lands is settled with `NOT_COMPACTED` when its watch runs out. 2026-11-11: a
  cancelled `/compact` was read as a compaction and the Stop hook told the session compacting again "would not help".
- **Invariant: a requested compaction either lands, or is retried and visibly reported; never silently dropped.**
  Paseo (0.16) can't steer a message into a slash-command turn, so a message that reaches an agent while its
  `/compact` runs (an agent notification, a person's message) replaces the turn and Claude Code writes
  "Compaction canceled." (`RESEARCH.md` §3.6). No hook fires for the cancel and Paseo offers plugins no way to hold a
  prompt, so it can't be prevented from here. `hooks/cancelled.mjs`, on `UserPromptSubmit` (the replacing prompt) and
  `Stop`, finds the line in the transcript while the agent has a delivered, unconfirmed `/compact`, records
  `CompactCanceled` (request id, `replaced` or `stopped`) in `compaction-events.jsonl` once, and tells the agent on the
  prompt. The governor settles that request (`queue.settleCancelled`, `server/compaction-queue.ts`) by `retryVerdict`:
  a replaced one is re-queued as the same request (`attempt`, `retryOf`; `retryLine` marks the `/compact`), at most
  `RETRY_LIMIT` (2) per agent per hour and not when another is queued; a Stop is never retried. Every ending has its
  own `compactionLine` in the popover and the card says "retry n" (`compact-retry.test.ts` walks them). A retry is the
  agent's own request again, not the plugin deciding to compact. 2026-11-11 11:27: a notification cancelled a
  delivered `/compact` nine seconds in; nothing retried it and the agent read it as a person cancelling.
- **Invariant: no agent ends a turn idle while a job the restart killed was never rerun or reported.** Paseo (0.16)
  closes the Claude process on every session reopen (the first prompt after a plugin reload, any refresh such as a
  ZeroSub account move), and that kills its `run_in_background` shells and Monitors (`RESEARCH.md` §3.7). Claude Code's
  "killed" notice dies with the process; the next one says "didn't finish before the previous session ended" once.
  `hooks/killed-jobs.mjs` reads that notice and, on `UserPromptSubmit` (`detached.mjs`) or `Stop` (`ask-compact.mjs`,
  before its background-tasks check, as `additionalContext` so the turn goes on), names each job not started again since,
  once per job (latch `killed-jobs/<agentId>.json`), with "rerun it now or report why not". `Stop` therefore rides any
  feature, not only Smart Compact. A refresh with no prompt fires no hook at all; that gap is closed only by not
  reopening busy agents (reload-gate's `background-busy` check, ZeroSub). 2026-11-11: a render job died in a ZeroSub
  refresh and its agent sat idle 25 minutes (`killed-jobs.test.ts`).
- `settings.enabled` is the master switch; `showPill` and `autoEnrol` qualify it and mean nothing
  while it is off. There is no third pill state — a session is enrolled or it is not. With Smart
  Compact off the pill is drawn only while Pause at the limit runs here (muted ring, no tick).
- Do not log secrets, tokens, task-state contents, or message bodies. Credentials are read-only.
- **Report a bug** (`docs/report-issue.md`). `server/report-issue/` is vendored from paseo-plugin-kit: never edit it
  here (`npm run check` runs `paseo-kit vendor --check`); change the kit, bump the pin, run `paseo-kit vendor
  report-issue server/report-issue`. Invariant `report-issue-never-carries-secrets`: diagnostics rows are switches and
  counts, never an account name, email, path or title, and everything an issue carries passes the module's
  `Redactor` (`report-issue.test.ts` feeds it an account email, the hostname, home and a private repo). Invariant
  `report-issue-files-only-after-confirm`: nothing is posted before the agent's confirm with the dry run's `planId`,
  and the caller comes from the transport, never the arguments. Invariant `report-issue-costs-no-standing-context`:
  `report_issue`'s description is the kit's one line and no hook mentions reporting. The sheet's Send and
  `report_send` deliver the person's own words to an agent through the host API; that is neither Smart Compact's
  `sendToAgent` nor a Session Guard message, and it runs only from a person's Send or an agent's `report_send`.

## Session Guard

- Code lives in `server/guard/`, `client/guard/` and `shared/guard/`; `server/guard/index.ts` is its
  wiring, `server/guard/engine.ts` decides what to pause and when to continue. The behaviour guide
  for users is `docs/session-guard.md`.
- Quota pausing is **off by default** (`shared/guard/policy.ts`). Off, it holds no quota lock, creates no quota directory,
  draws no quota pill and touches no session for quota protection. Do not change that default: an upgrade must never start
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
  sends the configured continuation after a confirmed reset, the **Resume now** message a person
  asked for, and a short continuation after a confirmed transient API failure of an observed working
  turn. It never compacts, never retries an unconfirmed send,
  and never sends into a session whose user message or turn changed.
- **Invariant: while a protected session's account is at or over the pause threshold, no turn runs
  in it unless a person explicitly resumes it** (Resume now, Release, Release and turn off, the
  pill's switch, or turning Session Guard off). So a pause is a hold: idle live sessions are held as
  well as running ones (`shared/guard/hold.ts`); a person's message joins a waiting hold instead of
  cancelling it (foreground: its turn is interrupted at once; frozen Claude: the message waits in the
  stopped CLI, RESEARCH.md "Messages to a stopped provider"); a session whose native ownership can't
  be confirmed falls back to the foreground, never to no pause (the 2026-11-11 bug: two provider
  processes with one `PASEO_AGENT_ID`, the session ran on Extra usage); and room on another ZeroSub
  account never releases a hold by running a turn on the full account (it releases it to ZeroSub to move). Never wake, open or signal a closed or dormant agent to hold it.
  Every new path that skips a protected session at the limit is a bug against this invariant.
- Every hold, release, resume and protection change is traced to the daemon log (`Engine.trace`,
  `docs/session-guard.md` "Trace"), and a protection change names the control that sent it (`source`
  on `smart-session.guard.protection`): the daemon doesn't tell a plugin who called. Keep new paths
  that change a hold or an override traced, with ids only.
- A shared-resource run marked by `HARNESS_SLOT_HELD` or a `harness-slot` ancestor,
  including descendants that clear the marker, must stay runnable during a quota pause so it
  can finish and release its lock. Never journal excluded workers as suspended or resume them.
- **Invariant: a transient API error never strands a working agent; nothing dormant is woken.**
  `retryTransientErrors` is on by default and independent of quota pausing. Only a matching live
  turn-start/failed-turn pair establishes unfinished work. `shared/guard/transient.ts` owns ordered
  classification (real auth and usage limits excluded), delays of 1, 3 and 10 minutes, and the
  three-send cap per incident. `server/guard/transient.ts` rechecks error status, user-message
  identity, permissions and quota holds before sending, spaces sends by 5 seconds, never retries
  unconfirmed delivery, and cancels timers on disable/unload. A separate lazy lock under
  `session-guard/transient-recovery/` prevents duplicate installs from retrying together. Pending
  incidents live only in this process; a reload never scans or wakes old errored agents.
- Process signals are identity-checked by PID birth time and limited to direct children of this
  daemon carrying the agent's `PASEO_AGENT_ID`. Never widen that.
- Usage comes from Paseo's `provider.usage.list`, merged for Claude with the recorder's freshest
  accepted reading (`server/guard/usage.ts`). Only a reading with a provider `fetchedAt` may be
  merged: `resetReady` relies on it to prove a report is newer than the pause.
- Both of those measure only the CLI's own login. When ZeroSub is enabled, `shared/guard/zerosub.ts`
  measures each agent on its ZeroSub account (`docs/session-guard.md`, "With ZeroSub"). **Switch
  first, hold as the fallback: the guard never holds a Claude session ZeroSub can move to an account
  with room** (`failsOver`) until `ZEROSUB_MOVE_GRACE_MS` (`shared/guard/hold.ts`) has passed with it
  still on the full account; then it holds as usual. Within the grace an idle session is left alone and
  a running turn is interrupted in the foreground (a SIGSTOPped process can't be reopened elsewhere),
  then continued once ZeroSub has reopened it on an account with room (`movedSince`). With no room
  anywhere, autoSwitch off, Codex, native background work or without ZeroSub the hold is unchanged.
  **Invariant (seam C): the guard never holds a session at its threshold while ZeroSub could move it.** Below
  100% ZeroSub sees no limit and moves nothing, so the guard asks: `Engine.askMove` calls
  `zerosub.agents.move_before_limit` (ZeroSub 1.5.1-pace.13+) with `moveTarget` (another account with room by the
  guard's rule, lowest usage), after the turn is stopped, and again by `moveAskDue` (`move-contract` below). Never when ZeroSub has recorded a limit on
  the agent's account: ZeroSub moves it itself, and asking too would move it twice. An older ZeroSub fails the call
  and the grace and hold stay as they were (`guard-zerosub-limits.test.ts`, "seam C").
  **Invariant (seam D): a continuation says what ended the hold.** A pause records the ZeroSub account it was held
  on (`accountId`, optional); a continuation sent on another account leads with `MOVED_LEAD` ("…moved to another
  account with room"), never "the usage window has now reset" (`continuationText`, `shared/guard/hold.ts`), and the
  chat shows it as "Continue on another account". After a reset it is the configured continuation, unchanged.
  ZeroSub (pace.10+) moves agents off an account its own reading finds full, not only on the CLI's
  limit notice, which never comes while Extra usage is on. **A hold shows the closest reset and lands
  there** (Tom, 2026-11-12): a hold's displayed reset (`heldUntil`) is the earliest moment any account
  the session could move to has room again (`nextRoom`/`roomAt`), named (`resetAccount`); at that reset
  the account has room (a rolled-over window counts as empty in `hasRoom`), so the switch-first path
  above releases it to ZeroSub, which moves it there (pace.11 ranks the just-reset account first), and
  it continues there, never on the account still out. `nextRoomAt` and `resetAccount` are display only:
  `anchorResetsAt` stays the session's own account's reset, because `resetReady` reads it to tell its
  own window rolled over; pointing it at another account let a stale low reading release a hold.
  Resume now moves first too while an account has room (`resumeOnMove`), else resumes in place. ZeroSub's files are read-only
  and parsed defensively. Never copy an email or a generated (`autoLabel`) label out of them, and
  never open an account home.
- **Invariant (`held-background-work`): a held session's move waits for background work only while that's short.**
  ZeroSub defers a move while the agent has background jobs (a reload would end them). Root cause (2026-11-22): two
  held sessions with one job each sat stopped up to 43 min while another account had room, the sidebar showing
  Paseo's "running" beside a bare "Held". Now `Engine.moveHeld` learns why from `move_before_limit`'s reply
  (`waitingFor`, `backgroundWork`; asked again each `ASK_AGAIN_MS`), keeps the plan on the hold (`Pause.moveWait`,
  `moveWaitPlan` in `shared/guard/hold.ts`): wait for the own account's reset when it comes within the grace
  (`stopBackgroundWorkAfterMinutes`, default 10) of the move; otherwise move at `since + grace` (at once when every
  job is a `monitor`) with `stopBackgroundWork: true`, and the continuation names every stopped job
  (`stoppedJobsLine`, secrets masked by `jobName`). Never for a frozen, idle, closed or archived session, a ZeroSub
  pin (`source: user`), a protection override, automatic switching off, or the setting at 0. ZeroSub's option is
  feature-detected from its reply (`waitingFor` present), never by version; without it the hold waits and says so
  (`why: unsupported`). The label is one of `HELD_LABELS` (Paseo labels are named host-wide entities, so never a
  time in a name); the page row (`moveWaitLine`), Move now (`smart-session.guard.move-now`) and `guard_move_now`
  carry the rest. Tests: "held-background-work" in `guard-zerosub-limits.test.ts` and `guard-labels.test.ts`.
- **Invariant (`move-contract`): the guard asks again while it still wants a move, bounded by the answer, and never
  shows a move that landed elsewhere as moved.** ZeroSub 1.31.0+ (and the fork's 1.31.0-pace.16) queues NOTHING on
  `waiting`, answers `pending` for a reload still in flight, and says `reason`, `retryable` and `accountId` (where the
  live session runs). Every reply goes through `readMoveReply` (`shared/guard/move-reply.ts`): `moved`/`already` with
  another `accountId` is `refused` + `landed_elsewhere`; an unknown outcome or `reason` is a refusal not worth retrying.
  `moveAskDue` paces the next ask: a turn ZeroSub waited for, on the next pass once it isn't running (10 s apart at
  least); background work each minute, during a `move` plan too (so "unless its job ends first" stays true); `pending`
  and `in_progress` after 2 min (ZeroSub's state shows the landing, `movedSince`); `switch_guard` after 5 min; a final
  refusal to the same account after 10 min; another target at once. An idle hold is let go only when ZeroSub says it
  moves (`moved`, `already`, `pending`). An older ZeroSub (no `retryable`: pace.15's `waiting` queued the move, and a
  repeat ask is the same move, with no second pin, switch-guard count or row) keeps today's cadence. Root cause
  (2026-11-25): ZeroSub's reviewed contract stopped queueing, so a held session the guard thought "moves when the
  turn ends" would have stayed put. Tests: "move-contract" in `guard-zerosub-limits.test.ts`.
- **Row badges (`row-badges`, Paseo 0.17.1+).** `client/row-badges.tsx` registers two `addWorkspaceRowBadgeItem` items,
  `held` (icon `Pause`) and `account` (icon `UserRound`); their words are pure in `shared/guard/row-badge.ts`
  (`row-badge.test.ts`). Held: pending pauses this process governs, by the agent directory's workspace (else the
  pause's `workspaceId`): one hold says when it ends ("Held · 5:58 PM", "Held · moves 5:06 PM", `HELD_LABELS` where
  there's no time), several say "2 held · <first end>", a hold in `attention` turns it `danger`. Account: with ZeroSub
  and more than one account, the open sessions' accounts by `subscriptionName` ("Main", "2 accounts"), never an email.
  No new poll: both read the guard status poll, the subscriptions poll and the agent directory. Feature-detected (the
  method and `WorkspaceRowBadge`): on an older host nothing registers. **Invariant: a held workspace says it once.**
  On a daemon whose `server_info.version` is 0.17.1 or later (`supportsRowBadges`, read once in `WorkspaceLabels` and
  only while something is held) no held label is assigned and the labels in our own record (`labelledWorkspaces`) come
  off; a label we never journaled is never touched. Unknown version, a 0.17.1 prerelease or an older daemon keep the
  label. Trade-off: an app older than 0.17.1 on a newer daemon shows neither (`guard-labels.test.ts`, "row-badges").
  `check-bundles.mjs` runs the client as an old and a 0.17.1+ host and pins the ids and icons.
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

**A harness run never shares a live login: no symlink, hard link, copy or env var.** Claude keeps its refresh lock
in its config dir, so two processes with different `CLAUDE_CONFIG_DIR`s that share one login can refresh at the same
time. The refresh token is single-use, so one of them burns it and the live session is signed out. This happened on
2026-11-17. A temp config dir with `.credentials.json` symlinked in: the harness Claude refreshed, wrote its own file
over the link, and the real file was left with a dead token. A live run (real Claude or Codex agents) waits for a
harness-only login that Tom makes (e.g. `claude setup-token`) and approves first.
`~/paseo-harness/tools/no-shared-login.mjs` refuses a run whose temp dirs hold a link to, a hard link of, or a
possible copy of a real login file, or whose env carries a login. It uses stat only and never opens a login file.
Never read a login file's contents, not even to check this.

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
- **Updates detach native tools.** A plugin reload drops them from open sessions until each reopens. Paseo (0.15-0.16)
  reopens a session only for a prompt that arrives while the agent is idle; messages to a busy agent run on the
  detached session, so a busy agent can stay detached for hours (the cause is Paseo's: tools are bound to the worker
  instance and re-bound only by a session open). The worker records its instance
  (`tools-instance.json`) and each attach its instance (`tools/native-<agentId>.json`); a mismatch is "detached", and the
  agent is pointed at the bridge (`bridgeCommand` ... `mcp.mjs call <tool> '<json>'`, on the desktop app's runtime there) meanwhile.
- **Invariant: a detached session is told once per worker instance, through a hook that actually fires.**
  `detachedOnce`/`markDetachedTold` (`server/hooklib/context.mjs`, latch `tools/told-<agentId>.json`) gate it; it rides
  `PostToolUse` on any tool (`context-threshold.mjs`), `PostToolUseFailure` on `mcp__paseo__smart_.*` and
  `UserPromptSubmit` (`hooks/detached.mjs`). A failed MCP call raises `PostToolUseFailure`, never `PostToolUse`
  (`RESEARCH.md` §3.5), and a client that re-listed its tools never calls `smart_*` at all. The asks still append the
  notice, since they name the tools. 2026-11-11: the notice sat on `PostToolUse` for a failed `smart_*` call and never
  reached a session.

`check-native-tools.mjs` (`npm run test:native`, in CI) proves it against an isolated daemon: no per-agent server,
the tools answer as the calling agent, and across a plugin reload the native call fails mid-turn, the bridge works,
and the native call works again after the next prompt. `--start-time` measures opening an unloaded Claude agent with
no tools, the stdio server and native tools (local only; needs a logged-in `claude`).

## Publishing as the main account

- An artifact belongs to the account of the session that publishes it. `hooks/publish-as.mjs` (a `PreToolUse` hook,
  matcher `Artifact|ArtifactData|ArtifactComments`, timeout 180 s; logic in `server/hooklib/publish-as.mjs`) asks the
  plugin (`smart-session.publish_as.start`/`.wait`) whether to take a call over, and when it does answers "deny" with
  the result. That reason leads with the success and says not to retry; `publish-as.test.ts` pins the wording. The same
  script as a `PostToolUse` hook on `Artifact` (timeout 15 s) sends every direct publish and read to
  `smart-session.publish_as.record`, which writes the session's account and the version into `publish-as/pages.json`.
- The decisions are pure, in `shared/publish-as.ts`. A new page goes to the target when the caller is on another
  account. A call on an existing page (a republish or asset upload, an Artifact `read` or `list` of files/assets, any
  ArtifactData or ArtifactComments call) goes to the page's recorded owner, which may be the target or a seat. A url
  nobody recorded, from a caller off the target, is a guess at the target; if the target can't see it (`not-owner`) the
  wait answers `allow` and the original call runs on the caller's account. Everything else passes through.
  ZeroSub unreadable: pass, with a note.
- **Invariant: a page a session published stays editable from whatever account the session moves to.** Every publish
  and read has an owner row (helper, `PostToolUse` record), and routing goes by the newest row for the url, never by
  the caller's current account. Root cause it fixes (2026-11-10 to 11-17, the most common failure): a session published
  directly on main, pace or a limit moved it to a seat, and its next update failed with "deleted or no write access"
  because only helper-made pages were recorded. `publish-as-routing.test.ts` (class 1) runs that move.
- **Invariant: a seat never publishes a page meant for the main account.** A signed-out or set-aside target is a
  refusal (`target-unusable`) with the reason and the fix, not a pass-through onto the seat; a guess is the only call
  that may fall back, and only once the target said it can't see the page. A sign-in failure in the helper (`auth`) is
  retried once in a fresh helper after 10 s (Claude's refresh tokens rotate; the loser of a refresh race fails and a
  later process reads the winner's token), then reported as such (class 5).
- **Invariant: a helper never overwrites a version its caller didn't see.** A republish is two turns of one helper:
  `readPrompt` (view the live version, never Read the saved page), then `publishPrompt` only when the live version is
  the one the caller last published or read (`versionId` on its row). Otherwise the outcome is `conflict`: the live copy
  is saved under `publish-as/live/` and the caller is told to merge and publish again; its row then holds the live
  version, so the next publish goes through, and the helper's own viewed version keeps Artifact's native guard for a
  change between the two turns. Rows without `versionId` (older ones) aren't checked. Root cause (2026-11-17): the old
  prompt read the page in full first, which marked the newest version viewed and switched the native guard off, so two
  helpers overwrote a concurrent change within a minute (class 3).
- **Invariant: a publish-as helper runs none of Smart Session.** Every hook returns at once for
  `SMART_SESSION_PUBLISH_HELPER=1` (`isPublishHelper` in `server/hooklib/context.mjs`); `session_open` gives a helper
  (by label or env) no tools, and the helper is created with `plugin-tools/enabled=false`. What a helper did is read
  from its tool calls on the daemon timeline (`turnItems`, `readTurn`), not from its last message. Root cause
  (2026-11-17): the context hooks fired inside a helper at 97% after it read a whole page, it asked for compaction, its
  last message was prose, and a real publish was logged as "reported no url" (class 4).
- `server/publish-as.ts` runs the helper: create (background, Haiku, chosen id, label `smart-session.helper=publish-as`,
  env `SMART_SESSION_PUBLISH_HELPER=1`), pin with ZeroSub's `zerosub.agents.account`, reopen with our own
  `refreshAgent` (ZeroSub's CLI reload doesn't find a new background agent), confirm ZeroSub's session record says the
  target, then prompt, wait (capped), and archive in a `finally`. One at a time; each run is logged. Never prompt a
  helper that isn't confirmed on the target, and never read a credential file.
- **Invariant: the helper never runs on an account other than the publish owner, and it only runs on a limited owner
  when "Use the main account's Extra usage when it's out" (`publishAsExtraUsage`, off by default) is on and credits
  remain** (`publish-as.test.ts`). `limitedTarget` decides from ZeroSub's `limitedUntil`/`limitKind` and the reading's
  `extraUsage`. Refused (setting off, Extra usage off, or used up) means no helper starts: the hook denies
  with `refuseReason` (reason and fix, pinned), the run log records `refused`. Allowed means the pin carries
  `allowLimited`, which ZeroSub 1.5.1-pace.12+ honours for one-shot helpers only (no routing swap, no failover move or
  continue); an older ZeroSub ignores it and the account check fails with `wrong-account`. The account is checked again
  after the turn, so a helper moved mid-turn is never a success. With the setting on and no Extra usage reading yet, the
  helper tries (a publish is worth a dollar; ZeroSub turns a spent account into a budget limit), and each run logs
  `extraUsage`. `publish-as-zerosub-e2e.test.ts` runs ZeroSub's real routing and pin schema against our pin when
  `ZEROSUB_DIR` names a ZeroSub install (skipped in CI). Root cause it fixes (2026-11-13): with the owner
  limited, ZeroSub's routing swapped the pin for the seat and every publish failed with `wrong-account` after a spent
  helper.
- Hooks follow features (`managedFor` in `server/install.ts`): the compaction hooks are registered while Smart Compact is
  on (except `Stop`, which also names killed background jobs and rides any feature), the publish-as `PreToolUse` and `PostToolUse(Artifact)` while publishing as the main account is on, and each is removed when its feature is turned
  off. So "Register the hooks" stays usable with Smart Compact off, and a fresh install with Smart Compact off still gets
  the Artifact hook (`install.test.ts`).
- A hook is ours only when it runs a shim in this load's own data directory (or an old install's `hooks/`). Another
  Paseo home's shims are that home's: a sandbox load (temp `PASEO_HOME`, real `HOME`) once stripped the real
  install's hooks from `~/.claude/settings.json` with `installHooks` off (2026-11-17). `install.test.ts` pins it.
- **Invariant: the default home always ends with exactly its own hook set; a sandbox never writes the person's
  settings.** `ownsSettings`: the default Paseo home (the account's `~/.paseo`, from the passwd entry, not `$HOME`)
  owns the Claude settings it naturally uses. Any other home writes only a settings file named inside its own `HOME`
  or `CLAUDE_CONFIG_DIR`, and never one whose real path is in the person's `~/.claude` (a link included). The owner
  manages its own entries whatever else is there, keeps a live home's, and removes a gone home's (shim folder
  missing): it never defers to another home. 3.8.0-beta.3 deferred to any other home's entries, so a file holding
  only a sandbox's got none of the real home's, and with both, features off then on left the real home with none.
  `install.test.ts` checks the three cases and 400 random sequences of loads, sandbox loads and feature toggles.
- **Invariant: a load never removes working hooks it doesn't own, its own included; a single custom home is the
  owner.** A non-owner changes nothing in the file (the report says `managedBy`). When `~/.paseo` has no Smart
  Session (no `plugin-data/smart-session/hooks`), any home owns the person's settings: a custom `PASEO_HOME` such as
  `/data/paseo` is then the only home there is. A sandbox on such a machine may add guarded entries (a missing shim is a
  no-op) that the owner removes once their shim folder is gone. Real paths are resolved by hand through a link whose
  target doesn't exist yet (`realOr`), so a sandbox's `settings.json` linked to the person's not-yet-written file is
  still the person's. 3.8.0-beta.4 made a custom home a non-owner that took its own entries out: an upgrade from 3.7.0
  went from 7 hooks to 0. `install.test.ts` runs that upgrade with and without Smart Session in `~/.paseo`.
- Owner names come from `ownerName`: the person's own label or a neutral name, never an email or a generated label.
- A seat session reads its ZeroSub home's `settings.json`, which ZeroSub links to the main one. Never write into
  those homes: per-home copies are how a hook silently stops reaching seat sessions (2026-11-10).
  `server/settings-links.ts` only checks the links (read-only) and `install()` reports a broken one in `homes`,
  shown on the settings page and by `publish_as_settings`.

## Moving old history aside (`shedHistory`, off by default)

A long-lived Claude agent's chat replays its whole transcript (`transcript-history.js` reads `<sid>.jsonl` and
`<sid>/subagents/**`), although Claude itself reads only what follows the last compaction. With the setting on, the
records before that point move into a backup and the transcript keeps the rest, in place, under the same session id.

- **Invariant: an agent's id and its post-compaction context survive a shed.** Same agent record, same session id,
  same file path; the chain Claude loads (leaf back to the newest boundary, with the preserved segment relinked) is
  byte-for-byte what it was. `planCut` (`shared/history-shed.ts`) recomputes the chain on the planned result and
  refuses on any difference.
- **Opt-in only.** `shedHistory` is true only when the stored value is exactly `true`. No migration, default flip or
  prompt turns it on; fresh installs and upgrades stay off (`history-shed.test.ts`). Codex and other providers are
  never touched.
- **The cut** (`planCut`): the earliest of the newest `compact_boundary`, the live chain's records and the boundary's
  `preservedMessages`. Only chain and per-request types move (`MOVABLE_TYPES`); metadata records before the cut stay.
  Refuses with no boundary, a boundary as the last line, a broken chain, or less than 1 MB to move.
- **Two phases.** `prepare` (agent closed, 5 s after `agent.closed` and in a 15 min sweep over closed agents; never
  wakes one; refuses while anything holds the file) indexes, plans, and writes a verified full copy to
  `$PASEO_HOME/plugin-data/smart-session/history-shed/backups/<project folder>-<hash>/<sid>/<plan>/`, plus subagent
  files older than the boundary. Backups never go under `~/.claude/projects`: Claude Code's `cleanupPeriodDays`, a
  removed ZeroSub account home and recursive `.jsonl` scanners all reach there. 3.8.0-beta.1 kept them at
  `<project>/<sid>/shed/`; `migrateBackups` copies those over, verifies each file, repoints the plan, and leaves the old
  folder as it was. `commit` runs only in `agent.session_open` for a resume, import or history view (`openIsSafe`;
  never on create or refresh, where the old runtime is still alive).
- **Invariant: a subagent the kept history names stays.** A subagent file leaves `subagents/` only when its newest
  record predates the boundary and neither its agent id nor its `.meta.json` `toolUseId` occurs in the kept bytes.
- **The open hook** (`server/history-shed-open.ts`): Paseo gives a hook 30 s, then sends `hook.cancel` (the hook's
  `signal` aborts) and fails the open. The budget (12 s before any rename) counts from the hook's entry, and the
  signal is checked up to the rename. One piece of work per agent: an open that arrives while an earlier one is still
  working aborts it, waits, and changes nothing. After a canceled open (`overranAt`), the next open leaves the files
  alone. It never throws.
- **Invariant: off means off.** With `shedHistory` false an open reads no transcript and moves no subagent. It only
  runs what the person asked for (a restore, or a shed requested for that agent), or finishes a commit, restore or
  rollback a kill interrupted (`needsRecovery`: the plan's state, its rollback record, or a stat of its second
  names), so no line is stranded. For those no subagent moves (`settle(..., { moveSubagents: false })`). The sweep
  doesn't run at all.
- **Invariant: only a requested plan commits while the setting is off.** `history_shed.prepare { agentId }`
  (`requestShed`) prepares one closed Claude agent whatever the setting says: the same refusals as the sweep, plus
  `not-closed` (Paseo's row) and `restore-pending`, and no size thresholds (still 1 MB moved at least). Its plan is
  marked `requested`; a plan the sweep already made for that session is marked instead of a second backup. At the
  agent's next safe open a requested plan commits like a sweep plan with the setting on; a sweep plan with it off
  never does. The status gives each plan's `origin` (`requested` or `sweep`). Pinned by the beta.4 review tests in
  `history-shed.test.ts`.
- **Commit checks, under a lock file beside the plan**: no unreadable plan for the agent; the resolved path is the
  planned one; no process holds the file open or carries the session id on its command line (Linux `/proc`; elsewhere
  it refuses); the open file matches the original stamp (size, mtime, inode, sha256); the backup and every moved
  subagent's backup still verify; no subagent file changed or appeared. It writes a temp file with the transcript's
  mode from the open file, checks its sha256, checks holders again, saves the plan as `committing`, links the
  original to `.<sid>.jsonl.shed-<plan>.orig`, then does the last look and the rename synchronously (`swapNow`).
  After the rename, holders of the old inode (matched by inode through `/proc/*/fd`) and its size decide: quiet
  drops the second name, otherwise a rollback. A drop that fails (the original changed after the check) is a late
  write too, never ignored: those bytes would sit only under the second name. Subagent sources go one by one, each
  after re-verifying its copy.
- **Invariant: a rollback killed at any step is finished by the next settle.** `startRollback` saves a record on the
  plan (`rollback`: kind, the replacement's size, the original's verified size, bytes copied) before its first step.
  `finishRollback` works from the files and the record, each step safe to repeat: it links the replacement as `.new`,
  or reuses a `.new` that has the transcript's inode; renames the original back; appends the replacement's whole
  lines past its planned size in one `O_APPEND` write (not interleaved with another writer's), exactly once
  (`appendOnce`): the record notes the transcript's size before each write (`appendFloor`); the next pass finds an
  earlier write by the chunk's first line, compares byte by byte and appends only the rest. 3.8.0-beta.3 looked for
  the whole chunk, so a replacement that grew after a kill between write and record got its first lines twice.
- **Invariant: a torn tail is cut only with proof it is the rollback's own short write.** A torn tail is waited on
  first (half a second: another writer may be mid-line). It is cut back to its last whole line only when the pass
  whose write came back short recorded where its bytes landed (`shortWrite`: start, length, offset in the chunk;
  recorded only when the file then ended exactly there) and those bytes are still exactly the file's end. Anything
  else torn (another writer's line that looks like the chunk's start, a write a kill interrupted) is never cut: the
  rollback stays pending, the log says why and `.new` keeps every line. 3.8.0-beta.4 took `appendFloor` as proof, so
  after a kill before the write it cut another writer's torn line. Then it drops `.new` once
  no process holds it. A torn last line stays in `.new` and the log says so. Only then is a shed discarded or a
  restore committed again. Before 3.8.0-beta.3, a rollback killed after its link made every later settle fail on
  `link()` with EEXIST, which the lock took for contention (stuck in `committing`), and one killed after its rename
  stranded the replacement's lines when settle discarded the grown original.
- **The lock**: an exclusive file beside the plan with the owner's pid; only the lock's own `open()` EEXIST means
  another holder. An error from the work inside is the work's.
- **Crash recovery** (`settle`) first finishes a rollback (a record, or a `.new` 3.8.0-beta.2 left without one),
  before any other decision. A committed plan with a second name beside the transcript drops it when it is the backup
  byte for byte, and rolls back when it is the backup grown (moved subagents are copied back). Then it reads the files to decide: two names of one file lose the second; the planned result
  (by prefix: Claude may have appended since) means finish, or roll back if the old file was written to; the original
  means try again later; the original plus new lines discards the plan and keeps its backup. Anything else is left
  alone. A restore interrupted after its rename is finished the same way. `env.step` is the crash seam at every step.
- **Bounded, since nothing is deleted:** an agent with two unused backups (plans its transcript moved past before the
  commit) is not prepared again (`unused-backups`) until the user removes one.
- **Restore** (settings, per agent; also a `committing` plan) runs at the agent's next safe open: it copies the current
  file aside first, writes backup plus everything appended since, and swaps it in exactly as a commit does, last look
  and rollback included. Moved subagents are copied back. A restored agent is not shed again. Every check after a
  rename is by prefix: Claude, or a stray writer, may append to the new file at once (`race-check.mjs` in the harness
  found restore comparing the whole file).
- Plans are written to a temp name, synced, renamed, and the folder synced; backup folders are synced too. A plan file
  that doesn't parse is logged (`plan-unreadable`), listed in the status RPC, and its agent is left alone.
- The status RPC lists `leftovers` (`leftoverFiles`: `.shed-*` / `.restore-*` second names beside any planned
  transcript, by stat) and `rollbackPending` per plan. A canary checks both are empty first.
- The gain is load time and chat length. Disk use goes up by the moved part, because the copy stays.
- Runs log to `history-shed/runs-YYYY-MM.jsonl`, plans live in `history-shed/plans/<agentId>/`.
- The chat row goes through the host API only an RPC handler receives (the plugin calls its own status RPC once, as the
  guard does). `notedAt` records it; a commit that outlived its process gets the row at the next open. Paseo keeps a
  Claude agent's plugin rows in memory only, so the row is gone after a daemon restart; the settings list is the record.

## Chat timeline

Timeline transforms must not break Paseo's grouping. Paseo groups only tool_call and thought items, and a transform can
only return plugin items, so a transformed call always leaves the group and renders loose. Every agent tool is
classified in `TOOL_PRESENTATION` (`shared/chat.ts`); routine bookkeeping returns null and stays Paseo's own call, and
only a moment the developer must see becomes a row. Classify a new tool there (`chat-grouping.test.ts` fails otherwise).

## Public repo: no real identifiers

This repository is public, and so is everything built from it: npm packages, release files, PR and issue text. A name that lands in a commit stays in git history and in every published package, and removing it later takes a history rewrite, npm unpublishes and GitHub Support. Keep real-world identifiers out of everything you write here.

- **Never write** the developer's employer or its domain, GitHub org or repo names, Slack or Linear workspace URLs, cloud project, service, registry or deploy-label names, customer names, colleagues' GitHub logins, work email addresses, real machine hostnames, or absolute home paths. This covers code, defaults, tests, fixtures, docs, screenshots, commit messages, PR titles and descriptions, review replies and issues.
- **Use fictional stand-ins:** org `example`, repo `example/app`, project `acme`, host `dev-box`, email `alice@example.com`, path `/home/user`. Ticket keys such as `ABC-123` and first names on their own are fine.
- **Machine-specific values live on the machine.** Which services to watch, who reviews, local paths: read them from local settings. Never ship them as defaults in the code.
- **Output from real data stays local.** Logs, sample results and screenshots from a run on the developer's real setup don't go into a commit or PR as-is. Describe them, or swap every real value for a fictional one first.
- **Commit only source.** Never commit symlinks, `node_modules`, or anything that points into the local machine. Before every commit, read `git diff --cached` for absolute paths and real names.
- **Found one already in the repo?** Fix it in a commit whose message doesn't quote the value (for example "replace a real name with a fictional one"), and tell the developer so they can decide whether history and npm need cleaning too.
