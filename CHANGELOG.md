# Changelog

Versions follow the hub's CONVENTIONS.md → Versioning. Each release that ships to a TrueNAS install has a runbook in `docs/RELEASE-*.md` (backup, update, verify, rollback).

## Unreleased: stream reports

Feature added (version number set at release). API revision **1.13** (additive; 1.12 is the Instagram revision of 0.2.40). Database schema stays at **v4**: the report tables have their own schema track (`reports_meta`, r1), so an older Relay still opens `app.db` after a rollback and ignores them. See [docs/REPORTS.md](docs/REPORTS.md).

### Added
- **Reports page** (main menu, every signed-in user): every stream of a profile (session start to end) with duration, peak and average concurrent viewers, viewer-minutes (labelled as such, not unique viewers), chat messages and chat per 1k viewer-minutes, unique chatters, recoveries, errors and uptime, per platform and in total; date-range totals; a stream page with viewers over time per platform + total, chat per minute, the per-platform table, destinations (canvas, Dual Format), titles, feeds and the event timeline. Charts are built in (SVG, no new dependency), keyboard-readable and have a table view.
- **Recording** from Relay's own events, never in the go-live path: titles with change times, test mode, destinations, live periods, recoveries, errors and blocked feeds, viewers every 30 s and on every change (unknown stays unknown, never 0), chat per platform per minute, feed codec/resolution/fps/bitrate/keyframe interval per minute and offline periods.
- **Audience** (on your self-hosted Relay): per person and stream, messages, joins, other chat events and first/last message time; never message text. Leaderboards per stream or date range, all platforms or one: Top chatters, Most loyal, Longest watch time, Newest regulars; a page per viewer. Watch time only where the platform says who is there: Twitch's chatters list, read every 5 minutes (new optional Twitch permission `moderator:read:chatters`; reconnect the account once). Elsewhere "attended" means chatted or joined. Instagram's "and N others joined" counts as N anonymous joins.
- **Privacy**: Reports → Recording and privacy (admin): turn recording or audience tracking off, keep reports for 90 or 365 days or everything, and **Forget this user** (audited without the name).
- **Export**: **Excel (.xlsx)** by default, written by Relay itself (no add-ons or macros): sheets Summary, Per platform, Viewers (30 s samples, a column per platform + Total, with a native line chart), Chat per minute, Events, Top chatters, Audience, Anonymous joins, Feeds; frozen headers, real dates, durations and numbers, column widths, times in your time zone. Also CSV (a .zip, one file per sheet) and JSON. Per stream or date range.
- **API**: scope `reports:read` ("Read stream reports" in Settings → API, shown as sensitive) and `GET /api/v1/reports/sessions`, `/reports/sessions/{id}`, `/reports/sessions/{id}/export?format=xlsx|csv|json`, `/reports/summary`, `/reports/export?from&to&format`, `/reports/audience`, `/reports/audience/users/{id}` (docs/API.md §16).

### Notes
- Past streams are not backfilled: Relay kept no viewer or chat counts before this version.

## 0.2.40 (2026-11-20)

Feeds in HEVC/AV1 are blocked with a clear message instead of retrying forever, and Instagram comments get the fixes from the first live run on 0.2.30. API revision **1.12** (additive). Database schema stays at **v4** (no migration). Runbook: [docs/RELEASE-v0.2.40.md](docs/RELEASE-v0.2.40.md).

### Fixed (Instagram comments)
- **No comments were read on Instagram's current page.** The comment box sits in a 76 px footer, four parents down from the box that holds the tabs, the comment rows and that footer. The reader climbed four parents, stopped at the footer and found no rows ("no Instagram comment rows found yet" in the log). The built-in pack, now **`builtin-3`**, climbs up to 10 parents and stops at one at least 320 px tall (`container.climbLevels`, `climbMinHeight`): the values of the override that fixed it during the live.
- **A small change around the comment box no longer empties the chat.** When the box the climb stops at holds no comment rows but a parent a little further up does (within the climb, in the same column, at least two rows with an avatar), that parent is the container. Pack setting `container.climbPreferRows`, on by default; `false` switches it off.
- **No burst of old comments.** When a changed pack made the panel readable during a live, everything on screen was delivered in the same second (25 comments at once). Comments already on screen when the reader first gets to read them are now history: remembered, never delivered later, not delivered now. This also covers a reader that starts during a live and a panel that opens or renders late. A live younger than 60 seconds has no history, so what is on screen then is delivered, also at the reader's very first read (0.2.30 skipped those). A panel the reader saw empty for 5 seconds has no backlog either. Pack settings `timing.backlogAsHistory` (on by default; off = 0.2.30's behaviour) and `timing.liveStartGraceMs` (60000). The log counts the rows taken as history, and the debug capture has `reader.backlog`.

### Added
- **What Instagram shows when it ends a live.** The `Instagram ended the live` log line now carries every notice and heading on the page (up to 600 characters, with its buttons), which rule fired, how long the live ran, the viewer count, and whether the page was visible, focused and online and its preview still playing. It is read before the notice is closed. A notice the watcher acts on (live ended, removed, interrupted, a warning) is Instagram's own wording and is logged in full; any other text keeps only its interface words and its length, every other word becomes `#` marks, so a name never reaches the log. Never comments, addresses or cookies.
- **Unknown dialogs during a live** are logged once per wording, with their buttons (`Instagram shows a dialog the health watcher does not know (not answered)`): interface words and the length only, as above. Nothing is clicked. A dialog that holds a field, an avatar or a link is never logged.
- The reader says in the log when a stored selector pack override only repeats built-in values and can be deleted.
- **Joins with others.** Instagram's aggregated presence lines ("<name> and 3 others joined", "… and 1 other joined", "… and 12 more joined the live video") are join events (`join: true`) by the named user with a new field **`othersCount`** (`3`) in `chat.message` (API 1.12, docs/API.md). The built-in `classify.join` pattern captures the number in group 1; an override's pattern may do the same. A presence line with no avatar or link to take the name from ("<name> joined the live") is now a join by its first word instead of a comment by "Instagram".

### Changed
- A selector pack override stored on 0.2.30 keeps working and is put on top of `builtin-3`. The override `live-1-climb` from the live run sets values `builtin-3` now has: **delete it after updating** (Settings → Advanced → Revert to built-in). See docs/PLATFORMS.md → Instagram → "After an update".
- docs/PLATFORMS.md → Instagram → "When Instagram ends the live by itself": what is known about Instagram ending Live Producer broadcasts (third-party help pages say about one hour), and what the app logs.

### Fixed (feeds Relay cannot send)
- **A feed in HEVC or AV1 no longer leaves every destination retrying with errors nobody can act on.** Relay passes each feed on unchanged over classic RTMP, which carries H.264 video and AAC audio only. With an HEVC feed, FFmpeg found no video to send and every destination looped in *Retrying* with "Error opening output files: Invalid argument" (YouTube, Kick…) or "Error binding filtergraph inputs/outputs: Invalid argument" (Twitch Dual Format), so the stream reached no one. Now Relay reads each feed's codec from the ingest server's track list and, for a feed it can't send, prepares no live, starts no relay and retries nothing. The destination is **blocked** with what to change: "Landscape feed is HEVC. YouTube gets the stream unchanged and needs H.264. In CTD OBS: Relay dock → Send stream (switches to H.264), or Settings → Output → Video encoder: H.264. It starts by itself once the feed is H.264." And it does: when OBS switches to H.264 the blocked destinations go live without anyone touching Relay. Destinations on the other feed are not affected.
- The same check when a feed's tracks change mid-stream: a live that was running is paused like a lost feed (grace period, then a new live when the feed is H.264 again).
- **Twitch Dual Format through Relay** is also blocked when the landscape feed has no AAC audio, which made FFmpeg fail the same way.
- If a relay does start on such a feed, FFmpeg's two "Invalid argument" errors are shown as the same clear message.

### Added (codec guard)
- **Where you see it:** the dashboard's feed card (`HEVC ⚠` and the fix) and destination cards (`Blocked: HEVC feed`); the Relay dock in CTD OBS (`Landscape: HEVC ⚠`, destinations DOWN with the message, one notice per feed); and the API: `feeds[].problem`, `destinations[].blocked` (phase stays `waiting-for-feed`, `down` is true) and `system.notice` with `kind: "feed.codec"`. `feeds[].video.codec` was already there. See docs/API.md §4, §5.
- A feed whose audio isn't AAC (for example Opus) is sent without sound; Relay now says so on the feed card and in a notice.
- `npm run smoke` publishes an HEVC feed to the real MediaMTX and checks both facts.

### Docs (codec guard)
- docs/PLATFORMS.md: "What every platform receives: H.264 video, AAC audio". docs/OBS-SETUP.md: troubleshooting row.

### Not in this release
- Sending HEVC or AV1 on to platforms that accept it (Enhanced RTMP) and converting a feed on Relay (docs/TRANSCODING.md).

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
