---
name: Smart Session (Paseo native surface)
description: Plan usage, session context and pauses at the limit read as moments, drawn in Paseo's own theme.
typography:
  headline:
    fontSize: "22px"
    fontWeight: 600
    lineHeight: "29px"
  headline-compact:
    fontSize: "19px"
    fontWeight: 600
    lineHeight: "25px"
  figure-lead:
    fontSize: "22px"
    fontWeight: 600
    lineHeight: "28px"
  figure-moment:
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "26px"
    fontFeature: "tnum"
  figure-row:
    fontSize: "17px"
    fontWeight: 600
    lineHeight: "22px"
  title:
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "21px"
  body:
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "19px"
  label:
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "18px"
  meta:
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "17px"
    fontFeature: "tnum"
  group:
    fontSize: "12px"
    fontWeight: 600
    lineHeight: "16px"
    fontFeature: "tnum"
  small:
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "15px"
    fontFeature: "tnum"
  axis:
    fontSize: "10px"
    fontWeight: 400
    lineHeight: "14px"
    fontFeature: "tnum"
rounded:
  hairline: "2px"
  control: "6px"
  control-compact: "8px"
  card: "10px"
  chat-card: "12px"
  pill: "999px"
spacing:
  hit-slop: "4px"
  row-x: "14px"
  row-y: "12px"
  section: "8px"
  block: "26px"
  block-compact: "20px"
  screen: "32px"
  screen-compact: "16px"
components:
  button:
    rounded: "{rounded.control}"
    height: "32px"
    padding: "0 11px"
    typography: "{typography.label}"
  button-small:
    rounded: "{rounded.control}"
    height: "28px"
    padding: "0 9px"
  button-compact:
    rounded: "{rounded.control-compact}"
    height: "44px"
    padding: "0 14px"
  icon-button:
    rounded: "{rounded.control}"
    size: "28px"
  icon-button-compact:
    rounded: "{rounded.control}"
    size: "44px"
  chip:
    rounded: "{rounded.pill}"
    padding: "1px 7px"
  card:
    rounded: "{rounded.card}"
  card-row:
    padding: "12px 14px"
  chat-card:
    rounded: "{rounded.chat-card}"
    padding: "11px 14px"
  switch:
    rounded: "{rounded.card}"
    width: "34px"
    height: "20px"
  meter:
    height: "8px"
  meter-context:
    height: "6px"
  popover:
    width: "340px"
    padding: "14px"
---

# Design System: Smart Session (Paseo native surface)

## Overview

**Creative North Star: "Usage is a time, not a number"**

Smart Session extends Paseo's interface and adds no visual world of its own. It inherits the host theme, system sans, icon names and platform layout, and shares Follow-up and Defer's kit (`client/kit.tsx`, `client/theme.ts`, `client/motion.tsx`): raised cards, tinted chips, 97% press. Its one signature is that every meter is paired with the moment it matters. A plan window shows its reset and when it runs out at this pace ("Session runs out around 4:58 PM · 42m before the 5:41 PM reset"). A session's context shows its compact line. A pause shows the clock it resumes at. Visitor mode: Operate.

Two objects carry that signature. The window chart draws the open session window from start to reset, with recorded use in ink, the projection at this pace faint, and the stretch with nothing left in amber. The context ring is a 24-unit SVG arc (`contextRing` in `shared/forecast.ts`) with a tick at the compact line. It is the composer pill's icon, the popover's 40px gauge and the 16px mark on each context row.

Density is dashboard-quiet: one status headline and one meta sentence, then cards of hairline-divided rows. Settings live in Paseo's Settings → Plugins, not on the dashboard. Feature rows link to them.

**Key Characteristics:**
- Host tokens only. Every colour is one of the host's 11 theme colours, or one of them at an alpha.
- Magnitude is neutral ink. Amber and red are forecast state.
- Times and percentages are semibold tabular.
- Hairline grids, a "now" rule and threshold ticks. There are no chart frames, legends-as-boxes or gradients.
- Motion is the family's: ease-out, opacity and transform only, and none under reduced motion.

## Colors

The palette is the host's. Smart Session owns no hex values, so the frontmatter carries no colour tokens. Values change with the user's Paseo theme, and hard-coding one would split the source of truth. Use only `theme.colors.surface0`, `surface1`, `surface2`, `border`, `foreground`, `foregroundMuted`, `accent`, `accentForeground`, `statusSuccess`, `statusWarning` and `statusDanger`, through `client/theme.ts`:

- `ink(colors, strength)` (`client/charts.tsx`) is `foreground` at a stepped alpha, ×1.1 on light grounds. It is the only colour for magnitude.
- `withAlpha`, `tint` (12% light / 16% dark chip fill), `raised` and `toneColor`.
- `isLight` decides light or dark from `surface0`'s luminance (> 0.4).

### Primary
- **Host Accent** (`accent`, `accentForeground`): fills the "on" state of a switch, and nothing else in this build. The kit's primary button also takes accent. No Smart Session view uses one.

### Neutral
- **Ground** (`surface0`): screen background and card fill.
- **Lifted** (`surface1`): chat cards, pause cards, inputs, hover fill of ghost controls and rows.
- **Pressed** (`surface2`): pressed fill, the switch's off track, skeletons.
- **Hairline** (`border`): row dividers, chart top and baseline. At 60% it draws the chart midline, at 50% day ticks, at 55–80% empty cells and zero bars.
- **Ink** (`foreground`): text, figures, the "now" rule, the compact tick on a meter. At 82% it is the used fill and the current bar, at 42% past bars, at 16% the projection, at 13% projected bars, and at 10% the meter track.
- **Muted Ink** (`foregroundMuted`): meta, axes, the even-pace tick, the pause-at-the-limit threshold dash, idle icons, a not-enrolled ring.

### Status
- **Amber** (`statusWarning`): a forecast says a limit will bite before the reset, a session is past its compact line, or a session is paused and waiting. On the chart it fills the "nothing left" bars at 42%.
- **Red** (`statusDanger`): a limit was reached (≥ 99.5%), a session will run out soon, context ≥ 90%, a pause needs attention, or something failed. A past window that hit the limit is a red bar.
- **Green** (`statusSuccess`): reserved by `toneColor` for a finished outcome. This build draws none.

### Named Rules
**The Neutral Magnitude Rule.** How much is always ink at a stepped opacity, so a chart reads the same in light and dark. Hue on a chart means state, never series.

**The Forecast Earns Colour Rule.** Amber and red appear only where `shared/forecast.ts` returns a `warning` or `danger` tone: below 90% with no shortfall, a window stays ink however full it is. A meter's fill, pace line, headline icon, ring and sidebar chip all take the same tone.

**The Accent Is A Switch Rule.** Accent green marks a switch that is on (and the kit's primary button). It never means "fine", never fills a bar and never marks selection.

## Typography

**Body Font:** the host's system sans (no `fontFamily` set; inherited from Paseo)
**Label/Mono Font:** platform monospace (`ui-monospace, SFMono-Regular, Menlo` on web), only for verbatim text: a sent message's full text in a chat card, and the recorder's data path.

**Character:** Paseo's own voice at Paseo's sizes. Weight carries the hierarchy, and there is no display face.

### Hierarchy
- **Headline** (600, 22/29; 19/25 compact): the status title on the overview ("Session runs out around 4:58 PM", or "2 sessions resume at 6:27 AM" while anything is paused here). It is followed by a 13/19 muted meta sentence.
- **Lead figure** (600, 22/28): the context percentage in the popover. **Moment** (600, 20/26; 18/24 compact, tabular) is the resume clock on a pause card. **Row figure** (600, 17/22) is a plan window's percentage. Context rows use 15/20 tabular.
- **Title** (600, 15/21): a paused-session row's name, and a pause row's own time.
- **Body** (13/19): sentences and card text. **Label** (600, 13/18): row names and chat-card titles.
- **Meta** (12/17, muted, tabular): reset, pace and budget lines, and facts. **Group** (600, 12/16, muted): section heads and chart group titles.
- **Small** (11/15, tabular): keys and hints. Chart captions are 11/14. **Axis** (10/14, muted, tabular) is used for chart ends and "now".
- Tool rows in chat are 14px, matching Paseo's own tool rows.

### Named Rules
**The Tabular Moment Rule.** Every clock, countdown, percentage and token count is tabular and goes through `formatClock` / `formatMoment` (`shared/format.ts`, `shared/forecast.ts`), which follow the device's 12- or 24-hour convention. A figure that matters is semibold. Its explanation sits beside it in muted meta.

## Layout

The overview is a host screen, centred at 860px, with 32px padding (16px compact) and 48px at the bottom. Blocks are 26px apart (20px compact). A section is a group head 8px above one card. The first viewport is the headline with its icon and gear; while anything is paused, the Paused sessions section comes next (and ⌘K "paused sessions" opens the overview there), then Plan limits (session row with meter, chart and earlier windows, then week rows and the meter key), then Session context rows, then the Smart Compact and Pause at the limit feature rows (sessions changed from the default listed under the latter). Tokens (last 30 days) follows. Settings are one host settings screen in the order a session meets them: Smart Compact, When to ask, Pause at the limit, Display, Claude Code, Limit timing (folded behind Edit).

Rows pad 12×14 with 6px internal gaps. Under a row's icon or status mark, secondary lines indent 22–25px to the text edge. In compact layouts, feature-row links drop to their own indented line, ranked totals stack, the window chart drops to 40 columns (from 60) and 60px tall (from 76), and controls grow to 44px. The popover is 340px (full-width sheet on phones), with 14px padding (16px compact) and 12px gaps, and hairlines between its parts. Chat cards sit right-aligned up to 560px wide, full width when compact.

## Elevation & Depth

Depth is a ring, not a shadow stack. `raised(colors)` gives a light theme a hairline ring plus a soft lift, and a dark theme one 8% white ring. Everything else is flat tonal layering: ground, then `surface1` for cards in chat, then `surface2` on press.

### Shadow Vocabulary
- **Raised, light** (`box-shadow: 0 0 0 1px rgba(0,0,0,.07), 0 1px 2px -1px rgba(0,0,0,.06), 0 2px 6px rgba(0,0,0,.04)`): cards, chat cards, the waiting pause card, secondary buttons.
- **Raised, dark** (`box-shadow: 0 0 0 1px rgba(255,255,255,.08)`): the same, on dark grounds.

### Named Rules
**The Alarm Replaces Depth Rule.** A card in trouble swaps `raised` for a 1px `statusDanger` border at 60%: a pause that needs attention, or a failed event.

## Shapes

Corners are soft and few. Cards are 10px, chat and pause cards 12px. Controls are 6px (8px compact), inputs 8px, and chips, meters and the switch fully round. Chart bars carry 2px top corners (3px on daily bars), and heatmap cells 2px. Ticks are 2px wide with 1px rounding and overhang the meter by 3px each side. The ring is a round-capped 2.6-unit stroke on a 24-unit box, with its track at 28% (50% at pill size, so it reads as a gauge and not as the host spinner). Its arc is quantised to 1/48, and its compact tick is a 1.8-unit radial stroke crossing the ring.

## Components

### Buttons
- **Shape:** gently rounded (6px; 8px compact).
- **Secondary (default):** `surface1` with `raised` depth, 13px medium text, 32px tall (28px small), 4px hit slop. Hover and press go to `surface2`.
- **Ghost:** transparent. Hover goes to `surface1`, press to `surface2`. Used for Dismiss pause and release actions.
- **Icon button:** 28px square (44px compact), with a muted 15px icon and an accessible label. Used for the gear.
- **Press:** every button scales to 97% over 140ms. Disabled is 45% opacity. Loading swaps the icon for the spinner.

### Chips
- **Style:** a pill filled with its own hue at 12% (light) or 16% (dark), with 11px semibold tabular text, optionally with an 11px icon. Used for counts, "Smart Compact", provider names, "2 paused" and the sidebar's "out 4:58 PM".
- **State:** the hue is the tone: muted by default, amber or red only from a forecast or a pause.

### Cards / Containers
- **Corner Style:** 10px (12px in chat).
- **Background:** `surface0` on screens, `surface1` in chat.
- **Shadow Strategy:** `raised` (see Elevation & Depth).
- **Border:** none. Rows divide with 1px `border` hairlines. A pressable row tints `surface1` on hover and `surface2` on press.
- **Internal Padding:** 12×14.

### Inputs / Fields
- **Style:** `surface1`, 1px `border`, 8px corners, 34px tall (44px compact). Used for the Paused sessions filter.

### Navigation
- **Sidebar row:** Paseo's sidebar header item, named Smart Session. It trails the session window's use in 12px tabular muted text, or a toned chip when a forecast or pause applies.
- **Text link:** 12px muted text with a 12px ArrowUpRight. Hover turns the text `foreground` and underlines it. Used for "Settings", "Paused sessions", "All paused sessions" and "Use default".

### Meter
An 8px track (6px for context) in ink at 10%. The fill is ink at 82%, amber or red by tone. A faint projection continues to where the reset lands (ink at 16%, or the tone at 24%). A muted 2px tick marks even pace, and a `foreground` tick marks the compact line. It carries a progressbar role and a spoken label. One key under the plan card names Used, By the reset at this pace and Even pace.

### Window chart (signature)
The open session window from start to reset, in 60 columns (40 compact). It has a hairline top at 100%, a 60% midline, a dashed muted line at the pause threshold when below 100%, and a 1px `foreground` "now" rule. Past bars are ink at 42% and the current bar ink at 82% (red when the forecast is danger). Projected bars are ink at 13%. Bars past the run-out moment are amber at 42%, at full height. Hover on web replaces the caption with a readout ("4:12 PM · ~68% at this pace"). The whole chart is one accessible summary sentence.

### Context ring and pill (signature)
The composer pill keeps the host's chrome. Its icon is the ring, and its label is the percentage ("34%"). The ring is `foreground` when the session is enrolled and muted when it is not, takes its tone colour when past the line, and shows the tick only when the session is enrolled. Pressing it opens the popover: a 40px ring with a 22px figure, a meta line of tokens and compact line, a 6px meter with the compact tick, one sentence in tone, a fact table (112px label column), and the per-session switch. A text link ends it. There is one pill per session. Protection adds nothing to it while a session is simply protected; an excluded session says so only in the pill's title. While a session is paused at the limit (and this process governs the pause) the icon becomes the host Pause glyph in amber (TriangleAlert in red when it needs a look), the label becomes the moment it resumes ("Resumes 6:27 AM": a clock, so the label rarely changes), and the pill stays up even when hidden in settings. The popover then leads with the pause: amber Pause icon and label, the moment at 20/26 semibold tabular, a meta line with the countdown and coverage, a bordered small release button and an "All paused sessions" link, then the context shrunk to a 28px ring and 15px figure. Below Smart Compact's switch sits the **Pause at the limit (Session Guard)** switch with a meta line and a small "Your default" / "Changed for this session" note plus a RotateCcw "Use default" link. When protection does not run here it is one muted ShieldOff line.

### Pause card
In chat it uses the same shell as Smart Session's message cards: `surface1`, 12px corners, `raised`, a title row (14px amber Pause icon, 13px semibold "Paused at the session limit", the time it paused in meta at the right), then the resume moment at 18/24 semibold tabular with a 13px muted countdown, then one meta line of facts. Then come a small secondary **Resume now** (Play), a ghost **Dismiss pause**, a right-aligned "Paused sessions" link and a small hint. When it settles it folds to one quiet line sized like the tool rows (14px text, 12px icon in a 22px slot) ("Paused at 3:28 PM · resumed 5:16 PM"). When stuck it swaps to the red border with "Pause needs attention".

### Chat rows and cards
Smart Session's tool calls are one 14px muted line with a 12px icon. Hover and expand swap the icon for a rotating chevron. Expanding opens a bordered `surface1` box up to 240px tall. A refused call is amber and a failed one red, with TriangleAlert. Messages the plugin sent become `raised` `surface1` cards (12px corners, 11/14px padding): a 14px icon, a 13px semibold title, a "Full message" toggle, the body, and a 12/17 muted provenance line. The full text expands in mono, up to 300px.

### Feature row
A 15px icon (`foreground` when on), a label and one meta line pairing the feature's state with its moment ("Pauses sessions at ~4:58 PM · resumes after the 5:41 PM reset"), then text links and a switch. The switch is 34×20 with a 14px thumb, accent when on, `surface2` with a `border` ring when off, and a mixed state while it loads.

### Charts below the fold
Daily bars use one ink series at 42%, with the peak and the hovered day at 82%. A heatmap of hour by weekday uses a five-step ink ramp (12/26/44/64/88%) on 2px-rounded cells, with a Less–More key. Past windows are 4–6px peak bars, ink at 42% or red at the limit. Ranked totals are rows with a 4px share bar in ink at 50% over 8%.

### Motion
Motion uses the ease-out curve `bezier(0.16, 1, 0.3, 1)` on opacity and transform only, and every animation checks reduced motion. Presses scale to 97% over 140ms. Content arriving after load rises 6px over 280ms (`Reveal`). An icon swap grows in from 40% over 260ms. Skeletons breathe between 55% and 100% over 800ms and stay static under reduced motion. Views re-render every 30s for relative times. Context polls every 15s and plan usage every 30s.

## Do's and Don'ts

### Do:
- **Do** pair every meter with its moment: the reset, run-out, compact line or resume time, through `formatClock` / `formatMoment`.
- **Do** draw magnitude with `ink()` at the established strengths (82 used, 42 past, 16 projection, 13 projected, 10 track) on `border` hairlines.
- **Do** take amber and red only from a `shared/forecast.ts` tone, and apply that tone to the fill, line, icon and chip together.
- **Do** use the kit's `Card`/`CardRow`, `Chip`, `Button`, `Switch`, `TextLink` and `raised`/`tint` rather than new chrome. Use 44px targets in compact layouts.
- **Do** give every chart an accessible summary sentence, and keep hover readouts to web.

### Don't:
- **Don't** introduce a colour outside the host's 11 tokens, or a hex value.
- **Don't** colour a bar green to mean "fine", or use accent anywhere but a switch that is on and the primary button.
- **Don't** give a chart series its own hue. A second hue on a chart always means state.
- **Don't** put settings prose or settings controls on the dashboard beyond a feature's switch and its Settings link.
- **Don't** animate layout properties or ignore reduced motion.
