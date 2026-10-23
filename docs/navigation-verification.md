# Navigation verification

Verified the actual plugin in an isolated Paseo 0.12.0 daemon with synthetic workspace and provider data, using the app web runtime at 1440×1000 and 390×844.

- Sidebar main view → Display settings → Overview opens the plugin surfaces directly.
- Compact settings have no horizontal overflow and preserve accessible native switches.
- Existing saved sidebar preferences retain their values. Button-bearing plugins expose independent positive enable_ preferences; hiding a button does not stop its feature.
- Graphite and Transfer header hiding/restoration were exercised through the UI; Transfer settings remained reachable from Command-K while its sidebar was hidden. Follow-up's choice survived a full page reload.
- Button lifecycle regressions cover registrations discovered while hidden, retaining the latest descriptor, duplicate prevention, restoration and teardown.

Screenshots: [desktop](screenshots/display-settings-desktop.png), [compact](screenshots/display-settings-mobile.png). Screenshots contain synthetic data. No main daemon restart or real-agent messages were used.
