# Changelog

Versions follow the hub's CONVENTIONS.md → Versioning. Each release that ships to a TrueNAS install has a runbook in `docs/RELEASE-*.md` (backup, update, verify, rollback).

## 0.2.40 (2026-11-19)

Instagram comments: fixes from the first live run on 0.2.30. API revision **1.12** (additive). Database schema stays at **v4** (no migration). Runbook: [docs/RELEASE-v0.2.40.md](docs/RELEASE-v0.2.40.md).

### Fixed (Instagram comments)
- **No comments were read on Instagram's current page.** The comment box sits in a 76 px footer, four parents down from the box that holds the tabs, the comment rows and that footer. The reader climbed four parents, stopped at the footer and found no rows ("no Instagram comment rows found yet" in the log). The built-in pack, now **`builtin-3`**, climbs up to 10 parents and stops at one at least 320 px tall (`container.climbLevels`, `climbMinHeight`): the values of the override that fixed it during the live.
- **A small change around the comment box no longer empties the chat.** When the box the climb stops at holds no comment rows but a parent a little further up does (within the climb, in the same column, at least two rows with an avatar), that parent is the container. Pack setting `container.climbPreferRows`, on by default; `false` switches it off.
- **No burst of old comments.** When a changed pack made the panel readable during a live, everything on screen was delivered in the same second (25 comments at once). Comments already on screen when the reader first gets to read them are now history: remembered, never delivered later, not delivered now. This also covers a reader that starts during a live and a panel that opens or renders late. A live younger than 60 seconds has no history, so what is on screen then is delivered, also at the reader's very first read (0.2.30 skipped those). A panel the reader saw empty for 5 seconds has no backlog either. Pack settings `timing.backlogAsHistory` (on by default; off = 0.2.30's behaviour) and `timing.liveStartGraceMs` (60000). The log counts the rows taken as history, and the debug capture has `reader.backlog`.

### Added
- **What Instagram shows when it ends a live.** The `Instagram ended the live` log line now carries the full text of every notice on the page (up to 600 characters, with its buttons), which rule fired, how long the live ran, the viewer count, and whether the page was visible, focused and online and its preview still playing. It is read before the notice is closed. Never comments, addresses or cookies.
- **Unknown dialogs during a live** are logged once per wording, with their buttons (`Instagram shows a dialog the health watcher does not know (not answered)`). Nothing is clicked. A dialog that holds a field, an avatar or a link is never logged.
- The reader says in the log when a stored selector pack override only repeats built-in values and can be deleted.

### Changed
- A selector pack override stored on 0.2.30 keeps working and is put on top of `builtin-3`. The override `live-1-climb` from the live run sets values `builtin-3` now has: **delete it after updating** (Settings → Advanced → Revert to built-in). See docs/PLATFORMS.md → Instagram → "After an update".
- docs/PLATFORMS.md → Instagram → "When Instagram ends the live by itself": what is known about Instagram ending Live Producer broadcasts (third-party help pages say about one hour), and what the app logs.

## 0.2.30 (2026-11-19)

API revision **1.11**. Database schema stays at **v4** (no migration; the selector pack override is one row in the settings table). Runbook: [docs/RELEASE-v0.2.30.md](docs/RELEASE-v0.2.30.md).

### Added
- **Instagram chat reader: live-tunable selector pack.** Everything the comments reader knows about Instagram's page (CSS selectors, attribute names, text patterns, timings) is now a JSON "selector pack". The built-in pack is the default. An operator can store an override through the API (`GET` / `PUT` / `DELETE /api/v1/platforms/instagram/chat/selector-pack`); the running reader uses it on its next poll and it is kept across restarts. A pack is data only: it is schema-checked, capped at 16 KB, takes plain CSS selectors and attribute names, and refuses patterns that are slow on long input. See docs/PLATFORMS.md → Instagram → "Tuning the chat reader live" and docs/API.md §15.
- **Instagram chat debug capture.** `POST /api/v1/platforms/instagram/chat/debug` returns, during a live, the structure of the comments panel with every text replaced by its length (class names, roles and attribute names kept; no user names, comment text, addresses or cookies), how many elements each pack selector matches, and the last parse decisions (kept or dropped, and why).
- **`system:admin` API scope** ("Operator tools") for those routes. Only for a token an admin creates in Settings → API for every profile. Pairing never grants it. Every pack change, revert and capture is audited.
- **Settings → Advanced**, a new tab with an "Instagram chat reader" card: the active pack's version, whether it is the built-in one or an operator override, who changed it, and **Revert to built-in**.

### Fixed (Instagram comments)
- **Duplicates.** A re-rendered or re-mounted comment list, switching away from the Comments tab and back, a long list dropping and re-creating rows, a page reload, and a restart of the chat source no longer deliver the comments on screen again. Repeats of the same words are still delivered when they are new comments.
- **Comments tab not selected.** The reader now knows whether the comments panel is showing instead of guessing from "no rows yet", reopens the tab when a re-render moved the producer to another tab, and delivers what was written before the tab opened. A Comments control that does not say whether it is selected is no longer clicked again and again (it could close the panel).
- **Wrong container.** A container guessed from a "Comments" heading before the panel opened is replaced by the real panel when it opens. A list wrapper that looked like a comment row while it held one comment is no longer kept as a row.
- **Pinned comments and notices.** A pinned copy of a comment is not delivered a second time, and the "Pinned" label no longer ends up in comment text. Instagram's own notices in the list are dropped. "… and 3 others joined" is a join event.
- **Text.** Emoji shown as images are read. A mention followed by punctuation keeps its spacing ("@name, hi"). A comment that reads like a label ("now", "like", "pinned") is no longer swallowed. A "more" link is not appended to long comments.
- **Privacy of the log.** When no comments were found, the reader logged short texts from the page, which could include viewers' names and comment text. It now logs counts and names of its own state only.
- **Timing.** While the page cannot be read (reloading), the reader slows its retries (up to 10 s apart) and says so once, instead of retrying every second without a word. A chat source started with an already-cancelled signal now stops at once.

### Changed
- Built-in pack `builtin-2` holds the reader's earlier selectors and patterns, plus: join lines with "and N others", patterns for pinned copies and Instagram notices, "see original" and "more" as labels.

## 0.2.20 (2026-11-18)

API revision **1.10**. Database schema stays at **v4** (no migration). Runbook: [docs/RELEASE-v0.2.20.md](docs/RELEASE-v0.2.20.md).

### Added
- **Overlay scenes (#23).** An overlay resource can list its scenes in `meta.scenes` (`[{ "id", "name", "url" }]`), so the CTD Relay dock in CTD OBS can add a single scene as its own browser source. Relay checks them: `http(s)` URLs of at most 2048 characters, at most 50 scenes, unique ids, 16 KB of JSON in all, and that budget is separate from the 4 KB limit on the rest of `meta`. A malformed `scenes` refuses the registration with `400 invalid` and names the field. `meta` is stored and returned exactly as sent (`GET /apps`, `GET /profiles/{id}/overlays`, `apps.changed`). See docs/API.md §9.2.
- **Transcoding capability check (#20, TC-1).** Once at startup, in the background, Relay asks its FFmpeg which hardware acceleration methods, encoders and decoders it has. Then it runs one short test encode per candidate encoder: 30 synthetic 720p frames to FFmpeg's null output, at low CPU priority, each capped at 15 s. The result is kept in memory and shown in **Settings → About → Transcoding**, and also at `GET /api/system/transcode-capabilities` (signed-in users) and `GET /api/v1/system/transcode-capabilities` (`status:read`). It is read-only: Relay still sends every destination the stream as OBS sends it, and nothing is transcoded.

### Docs
- **Transcoding design (#19):** [docs/TRANSCODING.md](docs/TRANSCODING.md), per-destination transcoding (opt-in, hardware-gated). Only §4, capability detection, is built so far.

## 0.2.10 (2026-11-17)

Bug fix. Schema v4, API 1.9. Runbook: [docs/RELEASE-v0.2.10.md](docs/RELEASE-v0.2.10.md).

- **Pairing again (#21):** an app that pairs again and registers its same id replaces its old connection instead of piling up `-xxxxxx` entries. Stale entries are cleaned up, and the superseded token is revoked 3 minutes later unless it is still in use.
- Dashboard: the vertical feed hint reads "Start the vertical stream in CTD OBS."

## 0.2.0 (2026-11-09)

Show profiles. Schema v4 (migration v3 → v4), API 1.9. Runbook: [docs/RELEASE-v1.9.md](docs/RELEASE-v1.9.md).

- Show profiles (OBS set-ups saved as revisions), content-addressed blobs, asset library and the **Assets** page.
- The ingest host given to OBS follows the public host when the app reached Relay through one (#15).
- "Waiting for <feed>" status instead of idle; fixed destination count (#16).
