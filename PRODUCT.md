# Smart Session

<!-- impeccable:product-schema 1 -->

> Written during the November 2026 UI polish pass without a live interview. Facts come from the
> README, AGENTS.md, RESEARCH.md, the code and the owner's written brief; lines marked *(inferred)*
> are assumptions to confirm.

## Platform

adaptive

## Users

Developers who run several long Paseo coding sessions at once on a Claude (or Codex) plan with a
rolling 5-hour window and a weekly cap. They want to know, at a glance, how much of the plan is left
and when it runs out, which sessions are getting heavy, and that a session hitting the limit will
pick up again by itself. The agents are users too: they call Smart Session's tools to read their own
context and budget, checkpoint, and ask to be compacted.

## Product Purpose

Three parts in one plugin. A recorder keeps the only history of plan-usage percentages that exists
(the provider and Paseo keep none). Smart Compact lets an agent compact itself at a safe stopping
point, never forced, with its task state on disk first. Pause at the limit (Session Guard) pauses sessions at the
provider's session limit and continues the same conversations after the reset. Success is a developer
who never loses work to a full context or a spent window, and never has to babysit either.

## Positioning

The only Paseo plugin that turns recorded usage history into a forecast ("runs out at 5:40 PM"),
lets agents manage their own context, and pauses and resumes work around the limit, all in one
place. *(inferred)* Neighbours show a usage snapshot (usage-monitor, zerosub) or auto-resume
(usage-auto-resume); none keep history or involve the agent.

## Operating Context

- Entry points: the Smart Session sidebar screen (plan limits, paused sessions, agent context,
  spend history, feature switches), one Smart Session composer pill per session (the context ring;
  it becomes the pause while a session waits for the reset), timeline cards for pauses, Command
  Center items, and one settings screen, Settings → Plugins → Smart Session.
- Agents reach it through MCP tools (`context_status`, `checkpoint`, `request_compaction`,
  `defer_compaction`, `budget_status`) and Claude Code hooks; those calls show in the chat.
- Used on desktop, web and phones; composer pill popovers become bottom sheets on phones.

## Capabilities and Constraints

- Recorder samples every minute (Anthropic directly every 3 minutes, Paseo's cache, Claude Code's
  cache as fallback); append-only monthly JSONL under `$PASEO_HOME/plugin-data/smart-session/`.
- Compaction is always agent-mandated; the plugin never decides to compact. It sends at most the
  requested `/compact` and one optional continuation.
- Pause at the limit is off by default; its state format, lock and hand-off with the standalone plugin
  are frozen. It freezes provider processes with SIGSTOP on Linux.
- Paseo ≥ 0.14, no runtime dependencies, host theme tokens only, no react-native-svg (inline SVG
  only through the host `Icon`).

## Brand Commitments

Part of Tom Gringauz's Paseo plugin family (Follow-up, Defer, Transfer, Vitals, …): native to
Paseo, host theme tokens only, the shared slate icon tile, plain short copy. User-facing copy says
**Smart Compact**, never "auto-compact".

## Evidence on Hand

Screenshots and media use synthetic usage history, sessions and spend from an isolated harness.
There are no user quotes, metrics or testimonials; none may be invented.

## Product Principles

- Say when, not just how much. A percentage is paired with the moment it matters: when the window
  resets, when it runs out at this pace, when a paused session resumes.
- The agent decides, the person can see. Nothing compacts unasked; every agent call and every
  plugin-sent message reads as what it is in the chat.
- History is the asset. Show what was recorded, honestly: gaps stay gaps, stale readings say so.
- Calm until it matters. Neutral ink by default; amber and red only when a limit is near or work
  is stuck.
