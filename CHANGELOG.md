# Changelog

Versions follow the hub's CONVENTIONS.md → Versioning. Each release that ships to a TrueNAS install has a runbook in `docs/RELEASE-*.md` (backup, update, verify, rollback).

## 0.2.100 (unreleased)

**SRT, the Pull link delay, and stream issues in the dashboard.** API revision **1.18** (additive). Database: one new table on its own track (`issue_history`, `issue_history_meta` h1); schema stays **v4**, reports **r1**, guest feeds **g2**, so 0.2.90 and 0.2.80 still open `app.db` after a rollback. Runbook: [docs/RELEASE-v0.2.100.md](docs/RELEASE-v0.2.100.md).

### Added
- **SRT** ingest and SRT pull links (ctd-relay#37, docs/SRT.md) on one UDP port of the bundled MediaMTX (`SRT_PORT`, default **8890/udp**; `0` = off; `EXPOSE 8890/udp`, compose and the TrueNAS YAML map it). The same keys and rules as RTMP: ingest keys publish (profile feeds and extra feeds), only a feed's Pull link read key reads, and the Pull link reader cap counts RTMP and SRT readers together; rotating or turning a link off disconnects SRT readers too. If the UDP port is taken at start, SRT turns off with a plain reason and RTMP works as before; an unmapped port breaks nothing. Addresses carry the internet latency (`latency=500000`, 500 ms); the LAN value (150 ms) is shown as the alternative. Passthrough only (MPEG-TS, H.264 + AAC).
- **API 1.18:** `srtUrl` and `srt` (SrtStatus) on the ingest details, guest ingest details and Pull link admin objects.
- **Stream issues in the web dashboard.** An **issues strip** at the top of the dashboard, and on each profile's row in Profiles: plain-language title, what it affects (feed, destination, OBS source, extra feed), how long it has been open; it appears and clears live (`issue.raised` / `issue.cleared`). **Badges** on the affected feed and destination cards. A **7-day history** (Reports → Issues), bounded: kept 7 days after an issue cleared, 5,000 rows at most, pruned at start and hourly; issues left open by a restart close as `restarted`. A Stream Report lists the issues open during that stream, and its .xlsx/CSV export has an **Issues** sheet (last, so existing CSV numbering is unchanged).
- **API 1.18:** `GET /api/v1/issues/history?profile=<id>|*&limit=` (`status:read`; a profile-limited token sees only its profile), docs/API.md §17.7; a Stream Report session gains `issues`. No existing field or event changes.
- **Scope upgrades (API 1.18, docs/API.md §9.3.1):** a paired app asks for more permissions with the token it already has (`POST /api/v1/pairing/upgrade`, poll `GET /api/v1/pairing/upgrade/{id}`); an admin approves or denies in **Settings → API** (a banner on every page, live). Approving adds exactly the listed scopes to the same token: same secret, same profile, no pairing again. Sensitive scopes are marked with why; `system:admin` is never granted this way. Audited (`scope_upgrade.*`). No database change (the token's existing scopes column).
- `npm run e2e:srt`: SRT end to end with the real MediaMTX/FFmpeg, and the delay measurement (steady state and how old a joining reader's first frame is, with low-delay and default reader settings).

### Docs
- [docs/PULL-LINK.md](docs/PULL-LINK.md): where the ~4 s Pull link delay comes from. Relay adds about nothing (136 ms through Relay against 137 ms direct, loopback), a player with FFmpeg's default settings starts 1.35 s (RTMP) or 5.5 s (SRT) behind and keeps it; the best OBS Media Source settings, a VLC Video Source alternative, and a five-minute test to find the rest.

## 0.2.90 (2026-11-25)

**Guest feeds (Relay F1 / CTD OBS F1)**, shown in the web UI as **Extra feeds**, with routing and Pull links. A remote camera operator or guest sends video to Relay over RTMP; CTD OBS pulls it in as a source (CTD Relay Feed) over LL-HLS behind Relay's auth. Guest feeds are **never restreamed** to destinations. API revision **1.17** (additive; the read uses the existing `feeds:watch` scope). Database: two new tables on their own track (`guest_feeds`, `guest_routes`, `guest_feeds_meta`); schema stays **v4**, reports **r1**, so 0.2.80 still opens `app.db` after a rollback. Runbook: [docs/RELEASE-v0.2.90.md](docs/RELEASE-v0.2.90.md). Guide: [docs/GUEST-FEEDS.md](docs/GUEST-FEEDS.md).

### Added
- **Guest feed slots per profile** (default 4, `GUEST_FEEDS_MAX`): a name and an own ingest key each. Guests publish to `rtmp://<relay host>:<RTMP port>/guest` with stream key `<slot>?key=<key>`, on the same MediaMTX, port and key check as OBS's feeds. Keys are encrypted (secrets scope `guest:<profileId>`), never logged, and can be rotated (the guest is disconnected, the old key stops at once) or revoked from the web UI.
- **Web UI: Extra feeds card** (the guest feeds; labelled so it also fits your own extra inputs, like a second camera) on the dashboard, under the feed cards: add, rename and remove slots, **Copy ingest details**, rotate/revoke keys (admins); state, codec, resolution, bitrate, a thumbnail and **Watch** (everyone signed in). A **How to send video to an extra feed** help covers OBS, Larix and other RTMP apps.
- **External API 1.17** (docs/API.md §18): `GET /profiles/{id}/guest-feeds` and `…/guest-feeds/{slot}/preview` (`status:read`); `…/guest-feeds/{slot}/live.m3u8` and `…/live/{file}` (`feeds:watch`): the 0.2.60 live preview machinery (LL-HLS on demand, passthrough, proxied, a viewer cap, an idle stop). Events `guest.feed.status` and `guest.feeds.changed`; issue kinds `guest.feed.offline` and `guest.feed.codec` (subject `guest.feed`) on the 0.2.80 alert contract. Problem code `unknown_guest_feed`.
- **Limits for a weak CPU-only server:** no transcoding or probing of guest feeds; muxing only while watched; `GUEST_FEED_MAX_VIEWERS` (default 2) players per guest feed; a bitrate warning above `GUEST_FEED_WARN_KBPS` (8000); a guest above `GUEST_FEED_MAX_KBPS` (20000) for 10 s is disconnected. H.264 + AAC only (the codec guard, `problem`).
- `npm run e2e:guests`: guest feeds with the real MediaMTX/FFmpeg, and the starvation measurement (docs/GUEST-FEEDS.md → What we measured).
- **Guest feed routing** (docs/GUEST-FEEDS.md → Routing, docs/API.md §18.8): **Send this feed to…** on the Extra feeds card. A guest feed can go, passthrough only (`-c copy`, never transcoded), to up to 3 **custom RTMP/RTMPS servers** (URL + stream key; keys encrypted in secrets scope `guest-route:<id>`, write-only, never logged) or into a **profile's Landscape or Vertical feed** (its own or another's), where it works exactly like a feed from OBS (feed card with "Source: extra feed <name>", codec guard, Go live, test mode, destinations, reports, alerts). Started by hand or **when the feed is online**; stopped when the guest stops. Guards: OBS's own feed always wins (routing into an input OBS is sending is refused; OBS coming back stops the route), one route per input, no manual start/stop of a profile route while that profile is live, a route never starts Go live, custom servers can't be loopback, link-local or this Relay (LAN hosts allowed unless the owner turns them off). External API (additive): `GET /profiles/{id}/guest-routes`, `…/guest-feeds/{slot}/routes` (`status:read`); `POST`/`PATCH`/`DELETE`/`start`/`stop` (`system:admin`); problem codes `unknown_route`, `invalid_target`, `input_busy`, `session_live`, `route_active`, `exists`. Database: table `guest_routes` (g2 on the guest feeds' own track; schema stays v4).

- **Pull link** (docs/GUEST-FEEDS.md → Pull link): a guest feed, or a profile's own Landscape or Vertical feed, can have an RTMP address with its **own read key** to paste into an OBS Media Source or VLC (no extra server). Off until an admin turns it on; the read key only reads (it never publishes, and an ingest key never reads), is encrypted (secrets scope `pull`), and rotating it or turning the link off disconnects its readers. At most `PULL_LINK_MAX_READERS` players per feed (default 2; `0` turns pull links off). Passthrough, never transcoded.

### Changed
- `LivePreviewService` and `PreviewService` take any stream key (a feed or a guest slot); the feed routes behave as before.
- MediaMTX's LL-HLS server also starts when `LIVE_PREVIEW_MAX_VIEWERS=0` but guest feeds can be watched.

### Changed (VP check)
- An **automatic** profile route ("when the feed is online") no longer takes the input of a live profile that OBS was feeding. Before, if a live profile's OBS feed dropped for a moment and the guest came online, the route could take that input and the guest would reach the live destinations; now it waits (state *Blocked*, "… is live"). A route that was itself the input's source still resumes when its guest comes back, like OBS reconnecting.
- The web UI says **Extra feeds** instead of Guest feeds (card title, help, Watch label, "Source: extra feed …" on a feed card, Pull link label). The RTMP address (`/guest/<slot>`), the API (`/guest-feeds`, `guest.feed.*` events) and the database are unchanged.

### Not in this release
- **SRT** ingest and SRT pull links (ctd-relay#37): not finished or measured yet (delay numbers, tests, docs); planned for the next release. It needs one UDP port mapped on the app.
- The Pull link shows about 4 s of delay in a second OBS (RTMP read + OBS Media Source buffering); parked, to be measured hop by hop before anything changes.
- An SRT read path (lower latency) needs a UDP port: out of scope, room left in the contract (API.md §18.7).
- RTMPS/SRT ingest for guests. Guests outside the network connect through a VPN; the RTMP port is never forwarded (docs/SECURITY.md, docs/GUEST-FEEDS.md).

## 0.2.80 (2026-11-24)

**Alerts and transcoding.** One alert contract for the suite, `issue.raised` / `issue.cleared` (Relay F2), that CTD Live and the CTD OBS plugin build on; and per-destination transcoding (Relay F3, #1), CPU-first and **off by default**, with a CPU guard. Includes everything in 0.2.70 (overlay summaries). API revision **1.16** (additive, no new scope). No database change: schema **v4**, reports **r1** (a destination's transcoding profile is one settings row, `transcode.profile.<id>`), so 0.2.70 still opens `app.db` after a rollback. Runbook: [docs/RELEASE-v0.2.80.md](docs/RELEASE-v0.2.80.md).

### Added
- **Issues: one alert contract for the suite (Relay F2).** Two new events on `/api/v1/events`, `issue.raised` and `issue.cleared` (`status:read`), tell every CTD app that something is wrong and when it is fixed. Relay raises `feed.offline` (a live session's feed from OBS went away and OBS didn't stop on purpose), `destination.down` (a destination stayed down 5 s; critical once Relay gave up), `stream.down` (every destination is down) and `obs.output.down` (OBS reconnecting), and passes on the CTD OBS plugin's issues as `obs.issue`. Each issue has a stable `id`, a `severity` (`info` / `warning` / `critical`), a `subject`, and a `resolution` when it clears (`recovered`, `ended`, `removed`, `stale`). Hold times keep one-second blips from becoming alerts, an OBS stream stopped on purpose is not one, and a show still being set up (a session waiting for its first feed) gets 30 s before anything is said. `GET /api/v1/status` carries the open ones in `issues`. Kept in memory only. See docs/API.md §17 and docs/CONTRACTS.md → Alert contract.
- **`obs.failover`**: a new OBS event type the CTD OBS plugin sends when it switches program away from a dead feed. Relay re-emits it on `/events` and keeps no state. `obs.issue.raised` may carry `onProgram` and `scene`.
- **OBS dock:** lists the open issues that aren't a down destination, and flashes and beeps for a new critical one when Alert is ticked.
- **Transcoding (#1).** A destination can get a re-encoded version of the feed instead of the copy: send one high-quality H.264 feed from OBS (for example ultrawide, or 1080p60) and let Relay make what the platform accepts. The feed must be H.264: Relay reads feeds over classic RTMP, so an HEVC/AV1 feed is held by the feed codec guard for transcoding destinations too. Off by default twice over: **Settings → Transcoding → Allow transcoding on this server**, then **Destinations → Edit → Transcoding** per destination (codec, frame size, frame rate, bitrate, encoder, audio). Only what the platform takes and this server can encode is offered. Built around CPU encoders (`libx264`, `libx265`, `libsvtav1`); a GPU encoder is used where it passed the startup test.
- The dashboard card shows what a destination encodes, with which encoder and how fast. If the encode runs slower than real time it warns; after 30 s (or when the encoder keeps failing) the destination sends the original feed instead when the platform accepts it, keeps transcoding with the warning when it doesn't, or stops if set to. Other destinations are never affected, and a destination without transcoding is pushed exactly as before.
- **Settings → Transcoding** also lists every encoder with its test result and has **Check again**. At most 2 destinations transcode at once by default (1 to 8).
- **CPU guard.** A CPU encode the server's own test puts at 100 % or more of real time is refused on save, with what to lower (on a 3.07× libx264: 1080p60 refused, 1080p30 and 720p60 allowed). At every start, a CPU encode doesn't start while Twitch Dual Format through Relay or another CPU transcode is already behind, or when it and the CPU transcodes already running would reach 100 %: the destination sends the original feed (or stops, or transcodes with a "may stutter" warning when the platform can't take the original). The destination form shows a CPU warning for every CPU encode, and Settings → Transcoding a "CPU only" warning when no GPU encoder works.

### Changed (SR check)
- The alert contract is **API 1.16 / docs/API.md §17**: it was written as 1.12 / §16, which 0.2.40 and 0.2.50 took in the meantime. Event names, fields, kinds, severities, hold times and resolutions are as documented in PR #25.
- `obs.output.down` is raised for an OBS output that keeps reconnecting while its feed never reached Relay this session (no `feed.offline` covers it then), as §17.2 says; it is still folded into a lost feed's `feed.offline`.
- Transcoding stores its profile in the settings table instead of migration v5's `destinations.transcode_json`, so the schema stays v4 and the rollback is "change the image back".

### Docs
- [docs/TRANSCODING.md](docs/TRANSCODING.md) §0: what the first version does, where it differs from the design, the CPU guard, and why the feed must be H.264.
- docs/DEVELOPMENT.md: `scripts/transcode-cpu.ts`, transcoding's CPU check (copy vs libx264 through MediaMTX, next to the guard's estimate).

### Not in this release
- Transcoding an HEVC or AV1 feed: Relay reads feeds over classic RTMP, so the feed codec guard holds those for every destination, transcoding ones included (a read path that carries HEVC/AV1 is a follow-up).
- Issues in the web dashboard (it keeps its toasts); open issues are in memory only.
- CTD Overlay's two addresses (`meta.addresses`, ctd-overlay#23) need no Relay change: overlay `meta` is stored and passed to `apps:read` as sent.

## 0.2.70 (2026-11-21)

**Overlay summaries** for the CTD OBS plugin's **CTD Overlays** dock: CTD Overlay's version and its templates' updates, through Relay (Relay is the hub: the plugin never talks to CTD Overlay). Includes everything in 0.2.60 (feed previews). API revision **1.15** (additive, no new scope). No database change: schema **v4**, reports **r1**, so 0.2.60 still opens `app.db` after a rollback. Runbook: [docs/RELEASE-v0.2.70.md](docs/RELEASE-v0.2.70.md).

### Added
- **API (1.15):** `PUT /api/v1/apps/{appId}/summary` (`apps:write`, only the token that registered the app: `404 not_found` before registration, `409 app_owned` for another token) and `GET /api/v1/profiles/{id}/overlay-summary` (`apps:read`; a token limited to a profile reads only that one, `403 profile_forbidden`). docs/API.md §9.5, OpenAPI schemas `OverlaySummary`, `OverlaySummaryTemplate`, `OverlaySummaryOverlay`.
- The summary (`ctd-overlay-summary/1`): the server's version, the admin UI's address (origin only: no credentials, query or fragment), each template's installed, oldest-in-use and newest version, its source (`owner/name` and release tag prefix: one repository can hold several templates), whether updates move by themselves, the update kind (patch / minor / major), a problem **code** (never the message), up to 8 plain lines of release notes, and the overlays that wait for the operator and why.
- Kept apart from the registration, so an overlay resource's `meta` stays within its 4 KB. At most 64 KB per app (200 templates, 500 overlays), **in memory only**, every field the schema doesn't name is dropped before it is stored (an overlay's URL or key, a token, an error's stack), control and bidi-override characters are refused. A profile's view holds only the overlays the app registered for that profile and the templates they use (plus templates no overlay uses). Forgotten when the app unregisters or another token takes its id.

## 0.2.60 (2026-11-21)

**Feed previews**: see what OBS sends to Relay without leaving the web UI. Includes everything in 0.2.50 (Stream Reports). API revision **1.14** (additive). No database change: schema **v4**, reports **r1**, so 0.2.50 still opens `app.db` after a rollback. See [docs/PREVIEW.md](docs/PREVIEW.md). Runbook: [docs/RELEASE-v0.2.60.md](docs/RELEASE-v0.2.60.md).

### Added
- **Feed thumbnails** on the dashboard's Landscape and Vertical feed cards and on every profile's row in **Profiles**: a frame of each feed in its own shape (16:9, 9:16), refreshed while the page is on screen and the feed is online (asked for 3 s after the last frame arrived: about every 5–6 s with 2 s keyframes); an "Offline" placeholder otherwise. Nothing is fetched from a background tab.
- **Watch:** a live player for a feed, about 2 s behind (2.1 s measured), muted until you turn the sound on, with volume (remembered per browser) and an audio level meter. It is the bundled MediaMTX's Low-Latency HLS, passed through unchanged (no transcoding), muxed only while someone watches (stops ~30–40 s after the last player closes), and proxied through Relay's own HTTPS server with the same login as the web UI. MediaMTX's HLS server listens on loopback only. At most 4 players per feed at once (`LIVE_PREVIEW_MAX_VIEWERS`; `0` turns Watch off). Played with hls.js 1.7.4 (bundled, loaded only when you press Watch) or Safari's own HLS player.
- An **HEVC/AV1 feed** shows the codec warning in place of the thumbnail and has no Watch button (the feed codec guard's message says what to change in OBS).
- **API (1.14):** `GET /api/v1/profiles/{id}/feeds/{feed}/live.m3u8` (+ `live/{file}`) with a new scope, **`feeds:watch`** ("Watch the feeds live"), header auth only, for CTD Live Studio, CTD Live mobile and the CTD OBS Producer. Existing tokens and paired apps don't get it; the JPEG previews stay under `status:read`. New problem codes `feed_codec`, `viewer_cap`, `live_off`, `live_ended`. docs/API.md §10.
- Web UI routes `GET /api/profiles/{id}/feeds/{feed}/preview.jpg`, `…/live.m3u8`, `…/live/{file}` (any signed-in user).
- `npm run e2e:preview`: the previews end to end in Chromium with the real Relay, MediaMTX and FFmpeg, including the CPU/RAM they cost. `npm run smoke` also checks LL-HLS against the real MediaMTX.

### Changed
- The JPEG preview is cached 2.5 s instead of 5 s, so a 3 s refresh always gets a new frame (still at most one grab per feed per 2.5 s, however many clients ask).
- Content-Security-Policy: `media-src 'self' blob:` (the player's Media Source).
- New settings `LIVE_PREVIEW_MAX_VIEWERS` (default 4) and `MEDIAMTX_HLS_PORT` (default 9996, loopback; never map it). `.env.example`, docs/SECURITY.md → Live preview.

### Changed (Senior check)
- **Viewer cap:** a player holds its place from the moment it asks for the playlist, not from when MediaMTX answers. Before, players opening at the same moment all passed the check (12 logins opening at once on a cold feed all got a player with a cap of 4), and a request abandoned while MediaMTX started the muxer still took a place for 15 s. Now an abandoned request gives its place back (the abort reaches MediaMTX too).
- **Live video has its own API scope, `feeds:watch`,** instead of `status:read`: every paired app holds `status:read`, and live video with sound (and a feed's full bitrate per player, out of the upload the restreams use) is more than status and still frames.
- **Watch plays about 2 s behind instead of ~1 s** (hls.js `liveSyncDuration: 2`): at MediaMTX's own target hls.js kept under a second buffered and rebuffered in 3 of 3 one-minute runs on the dashboard (3–6 frozen seconds each, then catching up at 1.2× into the next stall); at 2 s none did.
- **Safari's own HLS player** (Safari without Media Source, e.g. iOS before 17.1) plays the sound through the `<video>` element without the level meter: WebKit gives a Web Audio graph silence for an HLS `<video>`, which would have muted it.
- docs/PREVIEW.md: reverse proxy notes for Caddy (nothing to add; leave `flush_interval` out; `encode` is fine; HTTP/2) and nginx, measured resource safety. `scripts/preview-stress.ts` repeats the SR measurements (restream with and without 4 players, also on one CPU; cap; opens abandoned during a cold start; killed tab; frozen network; 100 open/close cycles; hidden page).

### Cost
- Thumbnails: about 5 % of one core while a page shows them; a player: a few percent more on Relay and MediaMTX, ~35 MB RAM per feed being watched; nothing while no preview is shown. Each player uses the feed's bitrate in bandwidth (upload, when watched from outside). Measured numbers in docs/PREVIEW.md → What it costs.

## 0.2.50 (2026-11-20)

**Stream reports**: every stream's viewers per platform over time, chat per minute, what went wrong and when, and who in your audience chats, joins and watches the most, on a new **Reports** page with **Excel (.xlsx)**, CSV and JSON export. API revision **1.13** (additive). Database schema stays at **v4**: the report tables have their own schema track (`reports_meta`, r1), so 0.2.40 still opens `app.db` after a rollback and ignores them. See [docs/REPORTS.md](docs/REPORTS.md). Runbook: [docs/RELEASE-v0.2.50.md](docs/RELEASE-v0.2.50.md).

### Added
- **Reports page** (main menu, every signed-in user): every stream of a profile (session start to end) with duration, peak and average concurrent viewers, viewer-minutes (labelled as such, not unique viewers), chat messages and chat per 1k viewer-minutes, unique chatters, recoveries, errors and uptime, per platform and in total; date-range totals; a stream page with viewers over time per platform + total, chat per minute, the per-platform table, destinations (canvas, Dual Format), titles, feeds and the event timeline. Charts are built in (SVG, no new dependency), keyboard-readable and have a table view.
- **Recording** from Relay's own events, never in the go-live path: titles with change times, test mode, destinations, live periods, recoveries, errors and blocked feeds, viewers every 30 s and on every change (unknown stays unknown, never 0), chat per platform per minute, feed codec/resolution/fps/bitrate/keyframe interval per minute and offline periods.
- **Audience** (on your self-hosted Relay): per person and stream, messages, joins, other chat events and first/last message time; never message text. Leaderboards per stream or date range, all platforms or one: Top chatters, Most loyal, Longest watch time, Newest regulars; a page per viewer. Watch time only where the platform says who is there: Twitch's chatters list, read every 5 minutes (new optional Twitch permission `moderator:read:chatters`; reconnect the account once). Elsewhere "attended" means chatted or joined. Instagram's "and N others joined" counts as N anonymous joins.
- **Privacy**: Reports → Recording and privacy (admin): turn recording or audience tracking off, keep reports for 90 or 365 days or everything, and **Forget this user** (audited without the name).
- **Export**: **Excel (.xlsx)** by default, written by Relay itself (no add-ons or macros): sheets Summary, Per platform, Viewers (30 s samples, a column per platform + Total, with a native line chart), Chat per minute, Events, Top chatters, Audience, Anonymous joins, Feeds; frozen headers, real dates, durations and numbers, column widths, times in your time zone. Also CSV (a .zip, one file per sheet) and JSON. Per stream or date range.
- **API**: scope `reports:read` ("Read stream reports" in Settings → API, shown as sensitive) and `GET /api/v1/reports/sessions`, `/reports/sessions/{id}`, `/reports/sessions/{id}/export?format=xlsx|csv|json`, `/reports/summary`, `/reports/export?from&to&format`, `/reports/audience`, `/reports/audience/users/{id}` (docs/API.md §16).

### Changed (Senior check)
- Recording does no database work while chat and status events are passed on: writes are queued and written together right after, chat counts and people every 30 s with the viewer sample. Settings are read once per sample, not per chat line.
- **Forget this user** also forgets what the recorder holds in memory during a live, overwrites the deleted rows and empties the write-ahead log, so the name is not left in `app.db` or `app.db-wal` (backups and snapshots keep theirs). Turning audience tracking off during a live drops what was added up since the last write.
- Retention deletes 20 streams per transaction and pauses every 50 ms.
- The Reports list and date ranges read one stream at a time and keep the numbers of streams that have ended (worked out in the background after start-up), instead of reading every viewer sample on every look.
- Exports: a name or detail cut in the middle of an emoji no longer makes an invalid .xlsx; event details never keep a URL's path or query or a key.
- `scripts/report-sample.ts` writes a sample report (.xlsx, CSV, JSON) from a simulated stream with synthetic names.

### Notes
- Defaults: recording **on**, audience tracking **on** (names, counts and times per stream, never message text; the leaderboards of who chats, joins and watches the most), reports kept for **365 days**. All three are in Reports → Recording and privacy (admin), with **Forget this user** on each viewer's page.
- Past streams are not backfilled: Relay kept no viewer or chat counts before this version.
- Reconnect Twitch accounts once for watch time (new optional permission `moderator:read:chatters`); without it Twitch reports chatters and joins only, like the other platforms.

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
