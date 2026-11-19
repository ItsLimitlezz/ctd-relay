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
| `pack-obfuscated.json` | The selector pack override for `comments-obfuscated.html` (an example of live tuning). |
