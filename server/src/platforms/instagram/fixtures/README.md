# Instagram chat reader fixtures

Hand-written HTML used by `chat-fixtures.test.ts`. They are **synthetic**: the structure imitates
kinds of markup the comments reader has to cope with, but nothing here was saved from a real live.
Every user name (`fixture_user_a`, `fixture_host`, ...) and every comment is made up.

Do not paste markup, names or comments from real streams into this folder. To describe what the
real page looks like, use the sanitised debug capture (`docs/PLATFORMS.md` → Instagram → "Tuning
the chat reader live"), which carries structure only.

| File | What it imitates |
|---|---|
| `comments-panel.html` | A labelled "Comments" tab panel: avatars with `…'s profile picture` alts, mentions, emoji, a pinned copy, system notices, join lines, labels such as "Reply" and "2m". The built-in pack reads it. |
| `comments-obfuscated.html` | A page after a redesign: hashed class names, no tab panel or labels, a different avatar alt, comment ids in a data attribute. The built-in pack finds nothing; `pack-obfuscated.json` reads it. |
| `comments-footer-composer.html` | The layout met in a live run (November 2026), rebuilt from the sanitised debug capture's sizes: a 400x600 box holding a tab list (tabs that do not say which is selected), a section of comment rows and a 76 px footer with the comment box four parents down. No tab panel, no labels. `builtin-2` stopped at the footer and read nothing; `builtin-3` reads it. |
| `comments-presence.html` | Presence lines in a labelled panel: "<name> joined", "… joined the live video", "<name> and 3 others joined" with singular, plural, "more" and a thousands separator, one with the name as a link and no avatar, one that is a single piece of text, and two comments that only look like presence lines. |
| `pack-obfuscated.json` | The selector pack override for `comments-obfuscated.html` (an example of live tuning). |
