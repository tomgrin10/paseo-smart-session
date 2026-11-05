# Navigation verification

Verified in an isolated Paseo 0.15 daemon with synthetic workspaces, usage history and sessions, using the app's web runtime at 1440×900 and 390×844, light and dark.

- The sidebar row **Smart Session** opens the overview screen; its header reads **Smart Session**, not a raw id. The row trails the session window's use, or how many sessions are paused.
- Paused sessions are a section of the overview, right under its headline. ⌘K **Smart Session: paused sessions**, a pause card, the pill's popover and settings open the overview at that list; the old `paused-sessions` screen id still resolves to it.
- One settings screen, **Settings → Plugins → Smart Session → Settings** (id `smart-compact`, which the old first page used), opens from the overview's gear, the feature rows, the pill's popover and Command Center.
- **Display** in that screen hides the sidebar row or the pill; hiding either never turns a feature off, a paused session keeps its pill, and Command Center still opens the overview.
- Compact settings have no horizontal overflow and keep accessible native switches.

Screenshots: [settings](media/smart-session-settings.png), [phone](media/smart-session-mobile.png). Screenshots contain synthetic data. No main daemon restart or real-agent messages were used.
