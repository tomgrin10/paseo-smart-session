# Navigation verification

Verified in an isolated Paseo 0.15 daemon with synthetic workspaces, usage history and sessions, using the app's web runtime at 1440×900 and 390×844, light and dark.

- The sidebar row **Smart Session** opens the overview screen; its header reads **Smart Session**, not a raw id. The row trails the session window's use, or how many sessions are paused.
- **Paused sessions** is its own screen with its own title, opened from the overview, the Session Guard pill's menu, a pause card or Command Center.
- Smart Compact, Session Guard and Display settings live in **Settings → Plugins → Smart Session** and open from the overview's gear, the feature cards and Command Center.
- **Display** hides the sidebar row or the composer pills; hiding either never turns a feature off, and Command Center still opens the overview.
- Compact settings have no horizontal overflow and keep accessible native switches.

Screenshots: [desktop](screenshots/display-settings-desktop.png), [compact](screenshots/display-settings-mobile.png). Screenshots contain synthetic data. No main daemon restart or real-agent messages were used.
