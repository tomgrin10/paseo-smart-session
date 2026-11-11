# Release-note fragments

- `changes/<branch>.md`: one file per user-visible pull request, named after its branch (`feat-usage-source.md` for `feat/usage-source`). A beta's notes are the fragments its tag added.
- `changes/shipped/`: notes for betas that shipped before fragments existed. They are not part of any later beta's notes.
- Both are folded into the stable version's curated `CHANGELOG.md` section by `node release-notes.mjs prepare X.Y.Z`, which then deletes them. That section is then rewritten by hand.

Rules for a fragment:

- Only "- " bullets, one line each, at most 240 characters.
- Say what the user sees or gets, in plain words. Name settings as the app does (Settings → Display → ...).
- No em dashes, no emoji, no issue or change numbers, no emails, account names, local paths or credentials.
- No tests, CI, refactors or README-only edits.
