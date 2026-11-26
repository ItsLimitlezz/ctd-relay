# External API (v1)

> **CTD Relay** was called **CTD Multi-Stream** until October 2026. Only the name changed: the API's
> identifiers keep the old spelling so existing apps keep working — the envelope `src.connector`
> and `GET /api/v1/` `name` are `"ctd-multi-stream"`, the `WWW-Authenticate` realm too, and tokens
> start with `ctd_pat_`.

API for other apps: **CTD Overlay** (merged chat, stream status, overlays per profile), the **CTD
OBS plugin** (OBS settings per profile, bitrates, which streams are down, chat, overlays), bots and
scripts. It is separate from the web UI's own session-cookie API.

- Base path: `/api/v1`. Breaking changes ship as `/api/v2`.
- JSON, UTF-8, `camelCase`. Times: ISO 8601 UTC in resources, epoch milliseconds in live envelopes.
- Machine-readable description: `GET /api/v1/openapi.json` (no auth).
- Reading is `GET`. Since v1.2 apps also write to **the hub** (§9.2: register themselves and what
  they offer, message each other) and can **pair** (§9.3). Nothing in v1 changes the stream (going
  live, titles, test mode): the web UI does that.

## 1. Where to connect

| From | URL | Notes |
|---|---|---|
| Same LAN / same NAS (CTD Overlay, OBS) | `http://<NAS-IP>:<HTTP_PORT>/api/v1` — TrueNAS: `http://<NAS-IP>:30080/api/v1` | Plain HTTP, served **only to private-network clients** (10/8, 172.16/12, 192.168/16, 100.64/10, loopback, fc00::/7, link-local). Internet clients on this port are redirected to HTTPS. Simplest for LAN apps: no certificate to trust. |
| Anywhere | `https://<public IP or host>/api/v1`, or on the LAN `https://<NAS-IP>:30443/api/v1` | The certificate is Let's Encrypt for the public IP/host, or self-signed. Self-signed: pin the SHA-256 fingerprint shown in **Settings → API** (`tlsFingerprint256`). |

`/dock` and `/overlay/*` follow the same rule (LAN HTTP or HTTPS).

"Private-network client" means the TCP peer address (never `X-Forwarded-For`). Where a NAT or proxy
hop replaces the client's address with a private one, internet clients look private too: Docker
Desktop (Windows/macOS), rootless Docker/Podman, IPv6 published into an IPv4-only Docker network,
or ports forwarded from a VPS through a tunnel. On such installs set `LAN_HTTP=off` (this port only
answers ACME challenges and redirects to HTTPS) or `LAN_HTTP_CIDRS=192.168.1.0/24,…` (only peers in
those ranges count as LAN; it replaces the built-in private ranges).

**Settings → API** shows both URLs. The LAN URL uses `LAN_HTTP_HOST` when set, else the address you
opened the web UI with when it is a LAN IP or a LAN-only name (`nas.local`, `truenas.lan`, a
single-label name). Inside a container nothing else is guessed (the container's own address is not
the NAS address), so the LAN URL is empty until you open the web UI by its LAN address or set
`LAN_HTTP_HOST`. It assumes `HTTP_PORT` is mapped like the HTTPS port (Docker `443 → 80`, TrueNAS
`30443 → 30080`). If your port mapping differs, set the `LAN_HTTP_PORT` environment variable to
the HTTP port as seen from the LAN. With `LAN_HTTP=off` the LAN URL is the HTTPS one.

## 2. Authentication

Create a token in the web UI: **Settings → API → New token** (admin), or let the app ask for one
with **pairing** (§9.3: the admin only approves a code). The secret is shown once:

```
ctd_pat_3fK9wQ1v…        (ctd_pat_ + 43 base64url characters)
```

Send it on every request:

```http
Authorization: Bearer ctd_pat_3fK9wQ1v…
```

| Scope | Grants |
|---|---|
| `chat:read` | `GET /chat`, `chat.*` and `alert.*` events |
| `status:read` | `GET /status`, `GET /profiles`, `stream.*`, `feed.*`, `destination.*`, `issue.*` (v1.16), `profile.status`, `profiles.changed`, `system.notice` events; guest feed lists, previews and `guest.*` events (§18, v1.17); guest feed routes and their state, without keys (§18.8) |
| `ingest:read` | `GET /profiles/{id}/ingest`: OBS server URL and **stream keys** (only for apps that configure OBS) |
| `apps:read` | `GET /apps`, `GET /profiles/{id}/overlays`, `GET /profiles/{id}/overlay-summary` (§9.5), `apps.changed` and `app.message` events |
| `apps:write` | `PUT`/`DELETE /apps/{id}`, `POST /apps/{id}/heartbeat`, `POST /messages` |
| `obs:write` | `POST /apps/{id}/events`: OBS events into the hub (the CTD OBS plugin; v1.4, §10) |
| `obs:control` | `GET /obs/socket`: control OBS through Relay's OBS socket relay (CTD Live mobile; v1.6, §12) |
| `show:read` | Show profiles (§14): `GET /profiles/{id}/show…` (manifests, bundles), `GET /blobs/{sha256}`, `GET /library`, `show.changed` and `library.changed` events (v1.9) |
| `show:write` | `POST /profiles/{id}/show/revisions`, `POST /blobs/check`, `PUT /blobs/{sha256}`: save revisions and upload files (v1.9) |
| `show:secrets` | `GET /profiles/{id}/show/revisions/{rev}/secrets`: third-party secrets (URL keys, passwords) saved with a show profile. Grant it per trusted machine only (v1.9) |
| `show:read` | Show profiles (§14): `GET /profiles/{id}/show…` (manifests, bundles), `GET /blobs/{sha256}`, `GET /library`, `show.changed` and `library.changed` events (v1.9) |
| `show:write` | `POST /profiles/{id}/show/revisions`, `POST /blobs/check`, `PUT /blobs/{sha256}`: save revisions and upload files (v1.9) |
| `show:secrets` | `GET /profiles/{id}/show/revisions/{rev}/secrets`: third-party secrets (URL keys, passwords) saved with a show profile. Grant it per trusted machine only (v1.9) |
| `system:admin` | Operator tools (§15): read, replace and revert the Instagram chat reader's selector pack, and take its sanitised debug capture; manage guest feed routes (§18.8, v1.17). Only for a token an admin creates for **every profile**; pairing never grants it (v1.11) |
| `reports:read` | Stream reports (§16): `GET /reports/…` past streams, viewers over time, chat counts, events, leaderboards and exports. Holds viewers' names: give it only to apps you trust with your audience (v1.13) |
| `feeds:watch` | Live preview (§10): `GET /profiles/{id}/feeds/{feed}/live.m3u8` and `…/live/{file}`, the feeds as live video **with sound**. Each player pulls the feed's full bitrate. The JPEG previews stay under `status:read` (v1.14). Also guest feeds live (§18, v1.17): `…/guest-feeds/{slot}/live.m3u8` and `…/live/{file}` |

A token may also be **limited to one profile** (§9.1). `/`, `/events` and `/events/poll` return
whatever the token's scopes allow. Browser-only fallback: `GET /events` also accepts
`?access_token=` (prefer the header; query strings can end up in proxy logs). Tokens are stored
hashed; revoking one in Settings → API takes effect immediately (open streams are closed within
30 s) and removes the apps it registered.

Limits: 600 requests/minute per token (`429` + `Retry-After`), 5 concurrent event streams per token
(a 6th gets `429` with `Retry-After: 30`), 120 `POST /messages` per minute per token. Without a
token: `POST /pairing` 10 per minute and `POST /pairing/{id}/token` 120 per minute per address
(an IPv6 address counts by its /64).

Responses carry `Access-Control-Allow-Origin: *` and the API never uses or sets cookies, so a
browser app on another origin can call it with the `Authorization` header (preflight allows `GET`,
`POST`, `PUT`, `DELETE`). Request bodies are JSON (`Content-Type: application/json`; an empty body
counts as none).

### Errors

[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details, `Content-Type: application/problem+json`:

```json
{
  "type": "https://github.com/ItsLimitlezz/ctd-multi-stream/blob/main/docs/API.md#errors",
  "title": "Missing scope",
  "status": 403,
  "detail": "This token needs the chat:read scope. Edit it in Settings → API.",
  "code": "missing_scope"
}
```

| Status | `code` | When |
|---|---|---|
| 401 | `unauthenticated` | No/unknown/revoked token |
| 403 | `missing_scope` | Token lacks the scope |
| 403 | `profile_forbidden` | Token limited to a profile asked for (or wrote about) another one |
| 400 | `invalid` | Bad query parameter or body (`413` when the body is too large) |
| 404 | `not_found` | Unknown `/api/v1` path, or no app registered under that id |
| 404 | `unknown_profile` | No profile with that id |
| 404 | `unknown_guest_feed` | No guest feed slot with that id on that profile (v1.17, §18) |
| 404 | `unknown_route` | No route with that id on that guest feed (v1.17, §18.8) |
| 400 | `invalid_target` | A route's custom server URL is refused (scheme, loopback/link-local, this Relay, LAN off) (v1.17, §18.8) |
| 409 | `input_busy` | OBS's own feed, or another route, is on the profile input a route wants (v1.17, §18.8) |
| 409 | `session_live` | A profile route can't be started, stopped or removed while that profile is live (v1.17, §18.8) |
| 409 | `route_active` | Stop the route before changing its server or key (v1.17, §18.8) |
| 409 | `exists` | This guest feed already feeds that profile input (v1.17, §18.8) |
| 409 | `app_owned` | The app id was registered by another token (`PUT /apps/{id}` takes the id over when that token is revoked, or when yours is newer, the app is of the same kind and it is offline (v1.6) or has the same `name` and your token covers that token's profile (the same app paired again; see §9.3)) |
| 409 | `limit` | Too many apps registered (100 in all, 20 per token) |
| 403 / 410 | `denied` / `expired` | Pairing poll: denied by the admin / expired, collected or unknown (§9.3) |
| 409 | `revision_conflict` | Saving a show-profile revision on a `parentRevision` that is no longer the head; carries `head` (v1.9, §14) |
| 400 | `missing_blobs` | A save names files that are not uploaded yet; carries `missing` (v1.9, §14) |
| 400 | `hash_mismatch` | The uploaded bytes do not hash to the SHA-256 in the path (v1.9, §14) |
| 413 | `quota_exceeded` | The upload would take the blob storage over its total quota (v1.9, §14). A file over its kind's size limit is `413 limit` |
| 409 | `revision_conflict` | Saving a show-profile revision on a `parentRevision` that is no longer the head; carries `head` (v1.9, §14) |
| 400 | `missing_blobs` | A save names files that are not uploaded yet; carries `missing` (v1.9, §14) |
| 400 | `hash_mismatch` | The uploaded bytes do not hash to the SHA-256 in the path (v1.9, §14) |
| 413 | `quota_exceeded` | The upload would take blob storage over its total quota (v1.9, §14). A file over its kind's size limit is `413 limit` |
| 429 | `rate_limited` | Over the limit (`Retry-After` seconds) |

Treat a `code` you don't know by its HTTP status.

## 3. Envelope

Every live item (event stream, poll, chat backfill) is an envelope, compatible with the CTD Overlay
(SKP) envelope:

```json
{
  "id": "01JA7Q8M9X2V4C6B8N0P2R4T6W",
  "type": "chat.message",
  "ts": 1791830000123,
  "src": { "connector": "ctd-multi-stream", "connection": "5b1c…destination id…", "platform": "twitch", "profile": "default" },
  "data": { }
}
```

| Field | Meaning |
|---|---|
| `id` | ULID: unique and sortable by time. Doubles as the stream/poll cursor. |
| `type` | Event type (§5). |
| `ts` | Server epoch ms when the event happened. |
| `src.connection` | Destination id the event belongs to, or `core` for session-wide events. |
| `src.platform` | `twitch`, `youtube`, `kick`, `facebook`, `x`, `instagram`, `tiktok`, `custom`, or `core`. (CTD Overlay maps the ones its standard doesn't list to `custom`.) |
| `src.profile` | Profile the event belongs to (§9.1), or `null` for events about no single profile: `profiles.changed`, `apps.changed`, `app.message` without a profile, server-wide `system.notice`, `system.reset`. (v1.2) |

## 4. Routes

### `GET /api/v1/`
Who am I. Any valid token. `token.profileId` is the profile the token is limited to, or `null`
(every profile; §9.1).
```json
{ "name": "ctd-multi-stream", "version": "0.2.0", "apiVersion": 1,
  "token": { "name": "CTD Overlay", "scopes": ["chat:read", "status:read"], "profileId": null } }
```

### `GET /api/v1/status?profile=<id>` — `status:read`
Everything a dashboard or the OBS plugin needs in one call, for one profile (§9.1: the token's
profile, else `?profile=`, else the default profile). Poll it (every 2 s is fine) or use the
event stream.

```json
{
  "session": {
    "status": "live",
    "startedAt": "2026-10-17T03:00:04Z",
    "title": "DPRTMNT Saturday",
    "testMode": false,
    "autoGoLive": true,
    "viewers": 214
  },
  "feeds": [
    { "feed": "landscape", "online": true, "since": "2026-10-17T02:59:58Z",
      "video": { "codec": "H264", "width": 1920, "height": 1080 },
      "audio": { "codec": "MPEG-4 Audio", "sampleRate": 48000, "channels": 2 },
      "bitrateKbps": 6012 },
    { "feed": "vertical", "online": true, "since": "2026-10-17T02:59:59Z",
      "video": { "codec": "H264", "width": 1080, "height": 1920 },
      "audio": { "codec": "MPEG-4 Audio", "sampleRate": 48000, "channels": 2 },
      "bitrateKbps": 4010 }
  ],
  "destinations": [
    { "id": "5b1c…", "name": "Twitch", "platform": "twitch", "feed": "landscape", "enabled": true,
      "phase": "live", "live": true, "down": false, "message": null,
      "stats": { "bitrateKbps": 6010, "fps": 60, "speed": 1, "uptimeSec": 3605 },
      "viewers": 214, "watchUrl": "https://www.twitch.tv/dprtmnttoronto",
      "recoveries": 0, "lastRecovery": null, "since": "2026-10-17T03:00:09Z" },
    { "id": "9e2f…", "name": "Instagram", "platform": "instagram", "feed": "vertical", "enabled": true,
      "phase": "recovering", "live": false, "down": true,
      "message": "Instagram ended the live (copyright). Starting a new one…",
      "stats": null, "viewers": null, "watchUrl": null,
      "recoveries": 1, "lastRecovery": { "at": "2026-10-17T04:12:40Z", "reason": "copyright" },
      "since": "2026-10-17T04:12:40Z" }
  ],
  "platforms": [
    { "platform": "twitch", "destinations": ["5b1c…"], "live": true, "title": "DPRTMNT Saturday",
      "startedAt": 1791831609000, "viewers": 214, "error": null },
    { "platform": "instagram", "destinations": ["9e2f…"], "live": false, "title": "DPRTMNT Saturday",
      "startedAt": null, "viewers": null, "error": "Instagram ended the live (copyright). Starting a new one…" }
  ],
  "issues": [
    { "id": "destination.down|9e2f…", "kind": "destination.down", "rule": null, "severity": "warning",
      "title": "Instagram is down", "message": "Instagram ended the live (copyright). Starting a new one…",
      "subject": { "type": "destination", "destinationId": "9e2f…", "platform": "instagram", "name": "Instagram" },
      "onProgram": null, "scene": null, "firstSeen": 1791836365000, "updatedAt": 1791836365000 }
  ]
}
```

- `issues` (v1.16): the profile's open issues, oldest first (§17.1). Empty `[]` when all is well.
- `session.viewers` (v1.3): **total viewers across every platform** of the profile — the sum of the
  destinations whose count is known (`null` when none is). It rides on `stream.status`, which is
  sent whenever the total changes, so an overlay's "watching now" counter needs only that event.
  Per platform: `platforms[].viewers`; per destination: `destinations[].viewers`.
- `phase`: `idle`, `disabled`, `waiting-for-feed`, `preparing`, `connecting`, `confirming`, `live`,
  `retrying`, `recovering`, `ending`, `error`. `live` = phase is `live`.
- `waiting-for-feed` (an enabled destination of a running session whose OBS feed is offline) is
  never reported as `idle`. `waitingFor` (additive) lists the missing feeds (`["vertical"]`,
  `["landscape"]` or both); it is `[]` in every other phase. `message` reads "Waiting for vertical
  feed", "Waiting for landscape feed" or "Waiting for both feeds". Twitch Dual Format (relay) needs
  both feeds; a vertical-only platform needs only the vertical one.
- `blocked` (additive, v1.12): set when the feed is **online but can't be sent**, because Relay passes
  feeds on as classic RTMP (H.264 video, AAC audio):
  `{ "reason": "feed-video-codec", "feed": "landscape", "codec": "hevc" }`. `reason` is
  `feed-video-codec` (HEVC, AV1…), or for Twitch Dual Format through Relay `feed-audio-codec` /
  `feed-audio-missing` (`codec` is `null` when there is no audio). While it is set Relay prepares no
  live, starts no relay and retries nothing; `phase` is `waiting-for-feed` (no new phase value),
  `waitingFor` names that feed, `down` is `true`, and `message` says what to change, for example
  "Landscape feed is HEVC. YouTube gets the stream unchanged and needs H.264. In CTD OBS: Relay dock
  → Send stream (switches to H.264), or Settings → Output → Video encoder: H.264. It starts by itself
  once the feed is H.264." It goes back to `null` and the destination starts by itself when OBS sends
  H.264. `null` in every other case.
- `feeds[].video.codec` / `feeds[].audio.codec`: what OBS sends, from the ingest server's track list
  (`h264`, `hevc`, `av1`, `aac`, `opus`…). `feeds[].problem` (additive, v1.12) is Relay's verdict on
  it, or `null`: `{ "reason": "feed-video-codec", "codec": "hevc", "label": "HEVC", "blocking": true,
  "message": "Landscape feed is HEVC. …" }`. `blocking: true` = no destination can send this feed;
  `false` = it is sent without sound (audio that isn't AAC, `reason: "feed-audio-codec"`). Show it as
  "Landscape: HEVC ⚠". It is `null` while the feed is offline or its tracks aren't known yet.
- `down` = the session is running, the destination is enabled (and not skipped by test mode), and
  it isn't reaching the platform right now (`error`, `retrying`, `recovering`, or `waiting-for-feed`,
  and also `preparing` / `connecting` / `confirming` while a retry works its way back — it stays down
  until the destination is actually `live`, so `destination.up` only fires on a real live).
  This is the field to light up red.
- `session.testMode`: the session streams in **test mode** (the dashboard switch; it can only change
  while no session runs). Every destination uses its platform's private/test setting: Twitch
  bandwidth test, YouTube private broadcast, Instagram Practice, Facebook Page "only me".
  Destinations whose platform (or account) has none are not started at all: `phase: "disabled"`,
  `message: "Skipped — Kick has no test mode"`, never `down`. Test mode never changes a channel
  title (Twitch, Kick), which is public even during a bandwidth test; `session.title` is applied
  when the stream goes live outside test mode.
- `viewers`: current viewers while live, as the platform reports them: Twitch, Kick and Facebook Page
  (polled every 30 s), YouTube (every 60 s), Instagram and TikTok (read from the live page). `null`
  when unknown: not live, not reported yet, hidden by the platform, or never reported (X, custom
  RTMP). Never `0` for "unknown".
- `platforms[]`: per-platform rollup. `live` if any of its destinations is live; `viewers` is the sum
  of known counts (null if none known); `error` is the message of the first down destination that
  has one (`null` if none does; check `destinations[].down` for the down state itself).

### `GET /api/v1/clock?t0=<your time>&profile=<id>` — `status:read` (v1.3)

A shared **timecode clock**: every app syncs to this server's clock, so overlays, recordings and
videos on different machines — on the LAN or across the internet — land on the same time code.
```json
{ "t0": 1791830000123.4, "receivedAt": 1791830000161, "sentAt": 1791830000162,
  "iso": "2026-10-12T18:33:20.162Z", "utcOffsetMinutes": -240, "profileId": "default",
  "session": { "status": "live", "startedAt": 1791829865000, "elapsedMs": 135162 },
  "fps": 30, "fpsSource": "landscape",
  "timecode": { "run": "00:02:15:04", "utc": "18:33:20:04", "local": "14:33:20:04" } }
```
- **Sync (NTP-style).** Send your own clock as `t0` (epoch ms, fractions allowed) and note when the
  reply arrives (`t3`, same clock). Then `offset = ((receivedAt − t0) + (sentAt − t3)) / 2` (add it
  to your clock to get server time) and `delay = (t3 − t0) − (sentAt − receivedAt)` (the round
  trip). Take 4–8 samples a second apart, keep the one with the smallest `delay` (its offset is
  the most accurate, typically within a few ms even over the internet), then **run the clock
  locally** and re-sync every few minutes. Don't poll it for every frame (600 requests/minute).
- **Timecodes** are `HH:MM:SS:FF`, non-drop-frame, at `fps`: the nominal integer rate of the
  profile's landscape feed (else vertical, else 30; 29.97 → 30, 59.94 → 60).
  `run` = session run time (from `session.startedAt`; `null` while offline; hours keep counting
  past 24) — the same on every machine for the same stream. `utc` = time of day in UTC — use it
  across time zones. `local` = time of day in the server's time zone (`utcOffsetMinutes`).
- To compute them yourself from server time `s`: run = `s − session.startedAt`; frames =
  `floor((ms mod 1000) × fps / 1000)`.

### `GET /api/v1/system/transcode-capabilities` — `status:read` (v1.10)

Which video encoders work on the machine Relay runs on (server-wide, no `profile`). Relay probes this
once in the background at startup: FFmpeg's hwaccels, encoders and decoders, then a short test encode
(30 frames of 1280×720) per candidate encoder. Until that ends, `state` is `probing`. Read-only:
Relay doesn't transcode yet; this is the first step of per-destination transcoding
([TRANSCODING.md](TRANSCODING.md)).

```json
{
  "state": "ready",
  "probedAt": "2026-11-09T12:00:03.120Z",
  "durationMs": 2840,
  "ffmpegVersion": "ffmpeg version n8.1.3-9-g29e619e767-20260930 Copyright (c) 2000-2026 the FFmpeg developers",
  "hwaccels": ["cuda", "vaapi", "qsv", "drm", "opencl", "vulkan", "amf"],
  "decoders": { "h264": ["h264", "h264_qsv", "h264_cuvid"], "hevc": ["hevc", "hevc_cuvid"], "av1": ["libdav1d", "av1", "av1_cuvid"] },
  "encoders": [
    { "encoder": "h264_nvenc", "codec": "h264", "backend": "nvenc", "ok": false, "speed": null, "device": null, "error": "Cannot load libcuda.so.1" },
    { "encoder": "h264_vaapi", "codec": "h264", "backend": "vaapi", "ok": true, "speed": 7.5, "device": "/dev/dri/renderD128", "error": null },
    { "encoder": "libx264", "codec": "h264", "backend": "software", "ok": true, "speed": 2.2, "device": null, "error": null }
  ],
  "supported": { "h264": true, "hevc": false, "av1": false },
  "cpu": { "cores": 4, "model": "…" },
  "devices": { "renderNodes": ["/dev/dri/renderD128"], "nvidia": false },
  "error": null
}
```

- `encoders`: every candidate the FFmpeg build has (hardware first: NVENC, QSV, VAAPI, AMF; then
  `libx264`, `libx265`, `libsvtav1`), with `ok` from the test encode. `speed` is a rough multiple of
  real time at 720p30; `error` is the first FFmpeg error line when the test failed.
- `supported`: at least one encoder of that codec passed.
- `state: "unavailable"`: FFmpeg couldn't run; `error` says why.

The web UI shows the same as Settings → About → Transcoding (`GET /api/system/transcode-capabilities`, any signed-in user).

### `GET /api/v1/chat?limit=200&after=<id>&profile=<id>` — `chat:read`
Recent chat of one profile (chosen like `/status`) still visible after moderation, **oldest
first**, as `chat.message` envelopes. `limit` 1–500 (default 200). With `after`, only messages
newer than that envelope id (incremental polling). Session-scoped: the buffer holds the last 500
messages per profile.

```json
{ "items": [ { "id": "01JA…", "type": "chat.message", "ts": 1791830000123, "src": { … }, "data": { … } } ],
  "next": "01JA7Q8M9X2V4C6B8N0P2R4T6W" }
```
`next` is the id of the last item (pass it as `after` next time), or the `after` you sent when there
was nothing new.

### `GET /api/v1/events?types=chat.*,destination.*` — Server-Sent Events
`Content-Type: text/event-stream`. Every frame:

```
id: 01JA7Q8M9X2V4C6B8N0P2R4T6W
event: chat.message
data: {"id":"01JA7Q8M9X2V4C6B8N0P2R4T6W","type":"chat.message","ts":1791830000123,"src":{…},"data":{…}}

```

- `types`: comma-separated globs (`chat.*`, `destination.down`, …); default = everything the
  token's scopes allow.
- `profile`: a token limited to a profile always streams that profile. A token for every profile
  streams the profile named by `?profile=<id>`; without it, the **default profile** (as before
  profiles existed, like `/status`, `/chat` and `/events/poll`); with `?profile=*` (or `all`),
  **every** profile (tell them apart by `src.profile`). Events about no single profile
  (`src.profile: null`) reach every stream.
- **Resume:** send `Last-Event-ID: <id>` (or `?cursor=<id>`). The server replays buffered events
  after it (buffer: last 2000 events or 15 minutes). If an event you would receive (by `types`,
  scopes and profile) after that id has already left the buffer, or the id is from before a server
  restart, the server first sends `event: system.reset` — refetch `/chat` and `/status`, then
  continue. Events your filter skips never cause a reset.
- On connect without a cursor, the stream starts, for each profile it covers (one, unless
  `?profile=*`), with one
  `stream.status` and one `destination.status` per destination (current state), then live
  events. Chat backfill is not replayed — call `GET /chat` for that.
- Heartbeat comment `: ping` every 15 s. `retry: 3000` is sent once.
- A client that stops reading (more than about 1 MB of live events queued for it) is disconnected;
  it resumes with `Last-Event-ID` like after any disconnect.

### `GET /api/v1/events/poll?after=<id>&types=…&profile=<id>` — polling alternative
For clients that can't hold a stream open (e.g. a C plugin). Same envelopes and buffer as `/events`,
for one profile chosen like `/status` (default: the default profile, as before profiles existed;
`?profile=*` for every profile, like `/events`) plus the events about no single profile.
```json
{ "items": [ … ], "next": "01JA…", "reset": false }
```
`reset: true` means an event you would receive after `after` has left the buffer, or `after` is from
before a server restart (refetch `/status` and `/chat`).
Without `after`: returns nothing but the current cursor (`next`), so you can start polling from now.
`next` is the id of the last item; with `types` it also moves past events the filter skipped.

## 5. Event types

### `chat.message` — `chat:read`
```json
{
  "id": "twitch:9d0a7c1e-…",
  "platform": "twitch",
  "channel": "Twitch",
  "destinationId": "5b1c…",
  "platformMessageId": "9d0a7c1e-…",
  "user": {
    "id": "twitch:144552210",
    "login": "djfan",
    "name": "DJFan",
    "color": "#1E90FF",
    "avatar": null,
    "badges": [ { "id": "subscriber/12", "label": "subscriber" } ],
    "roles": ["subscriber"]
  },
  "text": "this set is fire Kappa https://kick.com/dprtmnttoronto",
  "fragments": [
    { "type": "text", "text": "this set is fire " },
    { "type": "emote", "text": "Kappa", "image": "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0" },
    { "type": "text", "text": " " },
    { "type": "link", "text": "https://kick.com/dprtmnttoronto", "url": "https://kick.com/dprtmnttoronto" }
  ],
  "reply": null,
  "highlighted": false,
  "action": false,
  "kind": "message",
  "join": false,
  "othersCount": null,
  "ts": 1791830000123
}
```
- `id` is stable for the message (prefixed with the platform) — use it to apply deletions.
- `user.id` is `<platform>:<id>` when the chat source gives the platform's user id (Twitch,
  YouTube, Kick; Facebook Page when Facebook shares the commenter), otherwise
  `<platform>:name:<display name>` (browser-read chat on Instagram, TikTok, X and Facebook profile).
  Treat it as opaque: compare it, don't parse it.
- `roles` ⊆ `broadcaster`, `moderator`, `vip`, `subscriber`, `member`, `verified`, `founder`,
  `artist`, `bot`; the raw platform badges stay in `badges`.
- `fragments`: joining every fragment's `text` always equals `text`: `text` fragments, `link`
  fragments for URLs, and `emote` fragments (with an `https` `image`) where the chat source
  resolves emotes: Twitch emotes and Kick emote codes (an emote fragment's `text` is how the emote
  reads in `text`, e.g. its name). Twitch cheers (Bits) also get `cheermote` fragments: `text` as
  written (e.g. `Cheer100`) and an integer `amount` of bits, no `image`. `mention` is reserved: no
  chat source sends it yet. Treat a fragment type you don't know as text.
- `action` is `true` for `/me` messages (Twitch, Kick); `highlighted` for highlighted or paid
  messages.
- `kind: "event"` = a platform notice shown in chat (sub, raid, Super Chat…), `text` is its
  human-readable line. When the notice is a structured alert, an `alert.<kind>` event (below)
  follows it.
- `join: true` (v1.3) marks a **presence line**, not a comment: someone joined / started watching
  (Instagram's and TikTok's live chat show "dj_fan joined" between the comments). Always with
  `kind: "event"`; `user.name` is who joined, `text` the line as shown ("dj_fan joined"). A chat box
  that should show only comments drops `join` lines (or shows them as a light "👋 joined" toast);
  they can be frequent at a busy live.
- `othersCount` (v1.12) is set on a `join` line that names one user and a number of others:
  Instagram shows "dj_fan and 3 others joined" (also "and 1 other", "and 12 more", "… joined the
  live video"). `user.name` is the named user (`dj_fan`), `othersCount` the number (`3`), `text`
  the line as shown. So that line stands for `othersCount + 1` people. `null` on every other line,
  including a plain "dj_fan joined". An integer from 1.
- `color` is `#RRGGBB` or `null`; `avatar` is an `https` URL or `null`. `channel` is the
  destination name.
- `platformMessageId` and `user.login` are `null` when the chat source doesn't provide them
  (browser-read chat). `reply`
  is `null` or `{ "messageId", "userName", "text" }` (`messageId` in the same prefixed form as
  `id`; any of them may be `null`).

### `chat.message.deleted` — `chat:read`
```json
{ "messageId": "twitch:9d0a7c1e-…", "platformMessageId": "9d0a7c1e-…", "platform": "twitch", "destinationId": "5b1c…" }
```
`messageId` is the deleted message's `id` (for a message the server never saw: `<platform>:<platformMessageId>`).
### `chat.user.cleared` — `chat:read` (ban / timeout: remove that user's messages)
```json
{ "userId": "twitch:144552210", "userName": "DJFan", "platform": "twitch", "destinationId": "5b1c…" }
```
`userId` has the `user.id` form (`<platform>:name:<name>` when the platform only names the user);
either field may be `null`.
### `chat.cleared` — `chat:read` (whole chat cleared on one platform)
```json
{ "platform": "twitch", "destinationId": "5b1c…" }
```
Moderation is reported where the platform exposes it: Twitch (deleted messages, bans and
timeouts, `/clear`), YouTube (deleted messages, bans and timeouts) and Kick (deleted messages,
bans and timeouts, cleared chat). Browser-read chat (Instagram, TikTok, X, Facebook profile) has no
deletion events. `GET /chat` already leaves removed messages out.

### `alert.<kind>` — `chat:read`
Structured platform alerts, in the CTD Overlay alert shape. Each one is also a `chat.message`
(`kind: "event"`, a readable `text`), sent right before it; `messageId` is that message's `id`.
Alerts are live events only: `GET /chat` returns the chat line, not the alert. Subscribe with
`types=alert.*` (note that `chat.*` does not include them).

| Type | From | `amount` |
|---|---|---|
| `alert.subscription` | Twitch sub / resub, Kick subscription | `months` (cumulative), `tier` = `1000` / `2000` / `3000` / `Prime` on Twitch |
| `alert.gift` | Twitch gifted subs (single and mystery), Kick gifted subscriptions, YouTube gifted memberships | `count` (subs gifted), `gift.recipients` when known |
| `alert.cheer` | Twitch Bits | `bits` |
| `alert.raid` | Twitch raid, Kick host | `viewers` |
| `alert.membership` | YouTube new member (`months: 1`), member milestone | `months` |
| `alert.superchat` | YouTube Super Chat and Super Sticker | `currency` |
| `alert.follow` | Twitch follow (v1.7; needs the Twitch account connected with follow access, see below) | — |
| `alert.kicks`, `alert.tip` | Reserved for the CTD Overlay kinds; no chat source sends them yet | — |

**Twitch follows** come from Twitch EventSub (`channel.follow`), not chat, while the Twitch
destination is live. They need the `moderator:read:followers` permission: accounts connected
before v1.7 keep working without follows and show "Reconnect this account to turn on follow
alerts" in Accounts until they are reconnected once. A user who unfollows and follows again
within 6 hours gets no second alert. The chat line is `"<name> followed"` (`kind: "event"`).

Kick Kicks and YouTube paid gifts (Jewels) are `chat.message` event lines only
(`kind: "event"`), with no alert.

```json
{
  "kind": "subscription",
  "user": { "id": "twitch:144552210", "name": "DJFan" },
  "amount": { "unit": "months", "value": 12 },
  "tier": "1000",
  "message": { "text": "a year of DPRTMNT!" },
  "platform": "twitch",
  "destinationId": "5b1c…",
  "messageId": "twitch:3f1d7c2a-…",
  "ts": 1791830000123
}
```
```json
{
  "kind": "follow",
  "user": { "id": "twitch:52174911", "name": "NightOwl" },
  "platform": "twitch",
  "destinationId": "5b1c…",
  "messageId": "twitch:follow-befa7b53-…",
  "ts": 1791830005000
}
```
```json
{
  "kind": "superchat",
  "user": { "id": "youtube:UCx9…", "name": "Night Owl", "avatar": "https://yt3.ggpht.com/…" },
  "amount": { "unit": "currency", "value": "5.00", "currency": "USD" },
  "message": { "text": "play the remix!" },
  "platform": "youtube",
  "destinationId": "7c4e…",
  "messageId": "youtube:LCC.Cg8KDQ…",
  "ts": 1791830012456
}
```
```json
{
  "kind": "gift",
  "user": { "name": "Anonymous", "anonymous": true },
  "amount": { "unit": "count", "value": 5 },
  "gift": { "total": 5 },
  "platform": "twitch",
  "destinationId": "5b1c…",
  "messageId": "twitch:9a0b…",
  "ts": 1791830020789
}
```
- Fields that don't apply are left out (not `null`): `amount`, `tier`, `message`, `gift`,
  `user.id` (anonymous users), `user.avatar`, `user.anonymous`.
- `user.id` has the `chat.message` `user.id` form, so it can be matched with chat authors.
- `amount.value` is an integer for `months`, `count`, `bits`, `kicks` and `viewers`. Money
  (`unit: "currency"`) is a **decimal string** with an ISO 4217 `currency` (`"5.00"` `USD`,
  `"1000"` `JPY`) — never a float; format it with the currency's own rules.
- `gift`: `{ "recipients"?: [names], "total"?: integer }` (for a gift bomb `total` is the number of
  subs; recipients may be missing or partial).

### `stream.status` — `status:read`
`data` = the `session` object from `/status`. Sent when status, title, test mode or auto go-live change.

### `feed.status` — `status:read`
`data` = one `feeds[]` item. Sent on online/offline/codec changes and at most every 2 s for bitrate.

### `destination.status` — `status:read`
`data` = one `destinations[]` item. Sent on every phase change, and at most every 2 s for stats/viewers.

### `destination.down` / `destination.up` — `status:read`
Edge-triggered, once per transition of the `down` flag (§4 `/status`):
```json
{ "destinationId": "9e2f…", "name": "Instagram", "platform": "instagram", "phase": "recovering",
  "reason": "Instagram ended the live (copyright). Starting a new one…" }
```
```json
{ "destinationId": "9e2f…", "name": "Instagram", "platform": "instagram", "downForSec": 41, "recoveries": 1 }
```
`reason` is the destination's `message` (may be `null`). Stopping the session also clears `down`
(you get `destination.up`), and so does deleting a down destination (its last event is that
`destination.up`; refetch `/status` for the current list).

### `system.notice` — `status:read`
Messages the web UI shows as toasts (takedown detected, live again, session stopped…):
```json
{ "level": "warn", "message": "Instagram ended the live (copyright). Starting a new one…" }
```

`src.profile` is the profile concerned, or `null` for server-wide notices.

A notice may say what it is about (additive, v1.12): `kind` and `subject`, named like the fields of
an issue so the same problem can become one. Today there is one kind:
```json
{ "level": "warn", "kind": "feed.codec", "subject": { "type": "feed", "feed": "landscape" }, "codec": "hevc",
  "message": "Landscape feed is HEVC. Twitch, YouTube, Kick and the other platforms get the stream unchanged and need H.264. In CTD OBS: Relay dock → Send stream (switches to H.264), or Settings → Output → Video encoder: H.264. It starts by itself once the feed is H.264." }
```
`feed.codec` with `level: "warn"` is sent once per feed and OBS connection when a destination can't
send the feed (HEVC, AV1) or will send it without sound (`codec: "opus"`). `level: "info"` with the
same `subject` (`codec: "h264"`) follows when the feed can be sent again. Notices are events, not
state: read `feeds[].problem` and `destinations[].blocked` from `/status` for what is true now.

### `issue.raised` / `issue.cleared` — `status:read` (v1.16)
Something is wrong with a feed, a destination, the whole stream, an OBS output or a source inside
OBS / it is fixed. One stable `id` per problem, a `severity`, a `subject` and, on clear, a
`resolution`. **The alert contract of the suite: §17.** Open issues are in `GET /status` → `issues`.

### `profile.status`, `profiles.changed` — `status:read`
A profile's summary changed / profiles were created, renamed or deleted (§9.1).

### `apps.changed`, `app.message` — `apps:read`
Connected apps changed / a message from another app (§9.2).

### `music.nowplaying` — `status:read` (v1.8)
What the profile's Spotify plays changed: another song, play/pause or a seek (§13).

### `music.request` — `chat:read` (v1.8)
A chat song request (`!sr`) was queued or refused (§13).

### `show.changed` — `show:read` (v1.9)
A revision of a profile's show profile was saved (§14). `src.profile` is that profile.
`data: { "profileId", "revision", "parentRevision", "byAppId" }` (`byAppId` is the saving app, or `null`).

### `library.changed` — `show:read` (v1.9)
An entry of the asset library was added, renamed, reassigned or removed (§14.7).
`data: {}` — refetch `GET /library`. `src.profile` is the entry's profile, or `null` for an entry shared by every profile.

### `system.reset`
`data: {}` — events you would have received after your cursor are no longer buffered (or the
cursor is from before a restart); refetch `/status` and `/chat`.

## 6. Not in v1 (yet)

- Changing the stream (sending chat, changing the title, going live, test mode). The web UI does
  that; apps only write to the hub (§9.2).
- Kick KICKs and tips as alerts (`alert.kicks` and `alert.tip` are reserved: no chat source
  sends them yet). Follows on platforms other than Twitch.
- Viewer counts for X (not exposed by X) and custom RTMP servers.

## 7. Example clients

```bash
curl -H "Authorization: Bearer $CTD_TOKEN" http://192.168.1.20:30080/api/v1/status
```

```bash
curl -N -H "Authorization: Bearer $CTD_TOKEN" "http://192.168.1.20:30080/api/v1/events?types=chat.*"
```

Node (no dependencies, resumes after disconnects):

```js
let cursor = null;
async function run() {
  for (;;) {
    try {
      const res = await fetch('http://192.168.1.20:30080/api/v1/events', {
        headers: { authorization: `Bearer ${process.env.CTD_TOKEN}`, ...(cursor ? { 'last-event-id': cursor } : {}) },
      });
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (!data) continue; // heartbeat
          const env = JSON.parse(data);
          cursor = env.id ?? cursor;
          console.log(env.type, env.data);
        }
      }
    } catch (err) { console.error(err.message); }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
run();
```

## 8. OBS dock

**Settings → API → OBS dock** creates a token (`status:read` + `chat:read`) and gives a URL like
`http://192.168.1.20:30080/dock#token=ctd_pat_…`. In OBS: **Docks → Custom Browser Docks**, paste
it. The dock shows live status (with a TEST badge in test mode), feed bitrates, every destination
(red when down, with the reason), viewers, and the merged chat. Since v1.16 it also lists the open
issues that aren't a down destination — a lost feed, the whole stream down, a source or output in
OBS (§17) — and flashes and beeps for a new critical one when **Alert** is ticked. The token stays in the URL
fragment, so it is never sent to the server in the URL — the page sends it as a header.

**Profiles (v1.2):** the dock shows one profile, with its name and colour in the header: the
token's profile when the token is limited to one, else the profile named in the fragment
(`/dock#token=ctd_pat_…&profile=<profile id>`), else the default profile. Settings → API gives a
dock link per profile.

## 9. Profiles and the hub (v1.2)

### 9.1 Profiles

A **profile** is an independent streaming set-up — its own accounts, destinations, title, OBS
stream keys, test mode and chat — e.g. "Miami or Bust" (personal) and "DPRTMNT" (the club).
Profiles can be **live at the same time**. Developer apps, users and API tokens are shared.

- **Tokens limited to a profile** (`profileId` set when the token is created or the pairing is
  approved — recommended for overlays and docks) only ever see that profile: `/status`, `/chat`,
  `/events` and the hub routes are filtered to it, and `?profile=` (or a `{id}` in the path) must
  be omitted or equal (`403 profile_forbidden` otherwise); `?profile=*` means that profile too.
- **Tokens for every profile** (`profileId: null`, including tokens created before v1.2) pass
  `?profile=<id>` on `/status`, `/chat`, `/events` and `/events/poll` (default: the default
  profile, so old clients keep their behaviour). To read **every** profile at once, pass
  `?profile=*` (or `all`) on `/events` and `/events/poll`. `/apps` without `?profile=` (or with
  `*`) lists every app with every resource.
- An unknown profile id is `404 unknown_profile` (in a query, a path or a request body). The
  default profile's id is `default`.
- Every envelope's `src` now has `"profile"`: the profile id, or `null` for events about no single
  profile (§3), which every reader gets. `GET /api/v1/` reports the token's `profileId`.

#### `GET /api/v1/profiles` — `status:read`
```json
{ "items": [
  { "id": "default", "name": "Miami or Bust", "slug": "main", "color": "#3B82F6",
    "status": "offline", "startedAt": null, "testMode": false, "destinations": 4, "live": 0, "down": 0,
    "createdAt": "2026-10-11T18:00:00Z", "updatedAt": "2026-10-15T14:00:00Z" },
  { "id": "6f1d…", "name": "DPRTMNT", "slug": "dprtmnt", "color": "#E11D48",
    "status": "live", "startedAt": "2026-10-18T03:00:04Z", "testMode": false, "destinations": 3, "live": 3, "down": 0,
    "createdAt": "2026-10-15T14:05:00Z", "updatedAt": "2026-10-15T14:05:00Z" }
] }
```
A profile-limited token gets only its own profile. `GET /api/v1/profiles/{id}` returns one item.
`destinations` counts enabled destinations; `live` / `down` count those live / down right now
(`down` as in `/status`). Event `profile.status` (`status:read`, `src.profile` = that profile)
carries one item whenever a profile's session status, test mode, counts, name or colour change;
`profiles.changed` (`data: {}`, `src.profile: null`) when profiles are created, renamed or deleted
(refetch `GET /profiles`).

#### `GET /api/v1/profiles/{id}/ingest` — `ingest:read`
What OBS needs to stream into this profile — lets the CTD OBS plugin set OBS's stream output when the
user picks a profile:
```json
{ "profileId": "6f1d…",
  "serverUrl": "rtmp://10.20.30.40:1936/live",
  "feeds": [
    { "feed": "landscape", "streamKey": "dprtmnt/landscape?key=Xb3…", "fullUrl": "rtmp://10.20.30.40:1936/live/dprtmnt/landscape?key=Xb3…" },
    { "feed": "vertical",  "streamKey": "dprtmnt/vertical?key=Q9k…",  "fullUrl": "rtmp://10.20.30.40:1936/live/dprtmnt/vertical?key=Q9k…" }
  ] }
```
The default profile keeps its pre-profiles keys (`landscape?key=…`). `serverUrl` uses the RTMP
port and the LAN address: the OBS host set in Settings (the one the web UI's OBS setup shows) when
there is one, else `LAN_HTTP_HOST`, else the host the app called the API with. **Stream keys are
secrets**: grant `ingest:read` only to apps that configure OBS (responses carry
`Cache-Control: no-store`).
Each profile needs its own OBS output: two OBS (or two outputs) can stream two profiles at once.

v1.18 (additive): each feed also has `srtUrl`, the same feed over SRT
(`srt://<host>:<srtPort>?streamid=publish:<path>:key=<key>&latency=500000`, the OBS Server field with
the Stream Key left empty; `null` when SRT is off). The top level gains
`srt: { enabled, port, latencyMs, lanLatencyMs, reason }`, which never carries a key; `reason`
says in plain words why SRT is off. `latency=` is in microseconds. The links carry `latencyMs`, the
internet value (500 ms); it can go lower on a good link, and `lanLatencyMs` (150 ms) is enough on a LAN.
The SRT address uses the same host as `serverUrl`. See docs/SRT.md.

### 9.2 Connected apps (the hub)

Apps register themselves and what they offer so other apps can find them through CTD Relay
instead of being configured with each other's addresses. Example: CTD Overlay registers its
overlays with the profile each is assigned to; the CTD OBS plugin, connected only to CTD
Relay, lists the overlays for its profile and adds them as browser sources.

#### `PUT /api/v1/apps/{appId}` — `apps:write`
Register or update this app; call again at least every 60 s as a heartbeat (or
`POST /api/v1/apps/{appId}/heartbeat`). `appId`: `[a-z0-9-]`, ≤ 40, unique; only the token that
first registered an id may update or delete it (`409 app_owned`), except for the same app paired
again (§9.3, *Pairing again*).
```json
{ "name": "CTD Overlay", "kind": "ctd-overlay", "version": "1.4.0",
  "baseUrl": "http://10.20.30.40:30200",
  "capabilities": ["overlays", "overlay.create"],
  "resources": [
    { "type": "overlay", "id": "ovl_h", "name": "DPRTMNT takeover — landscape", "profileId": "6f1d…",
      "url": "http://10.20.30.40:30200/o/takeover-h?key=…", "width": 1920, "height": 1080 },
    { "type": "overlay", "id": "ovl_v", "name": "DPRTMNT takeover — vertical", "profileId": "6f1d…",
      "url": "http://10.20.30.40:30200/o/takeover-v?key=…", "width": 1080, "height": 1920 }
  ] }
```
Response: `200` with the `ConnectedApp` (below). Limits: 200 resources, `meta` ≤ 4 KB each (plus
an overlay's `meta.scenes`, below), body
≤ 256 KB (`413`), 100 apps in all and 20 per token (`409 limit`). A profile-limited token may only
assign resources to its own profile (or `null`; `403 profile_forbidden`). A resource assigned to
a profile that doesn't exist (e.g. one deleted since — deleting a profile also removes the resources
assigned to it) is left out of the saved registration rather than refusing the whole `PUT`: the
response shows what was kept.

| Field | Rules |
|---|---|
| `name` | required, ≤ 80 characters |
| `kind` | required, `[a-z0-9-]`, ≤ 40 (`ctd-overlay`, `ctd-obs-plugin`, `custom`…) |
| `version`, `baseUrl` | optional (`null`); `baseUrl` is an `http(s)` URL of the app itself |
| `capabilities` | optional, ≤ 50 of `[a-z0-9_.:-]`, ≤ 64 each |
| `resources[]` | `type` (`overlay` or your own `[a-z0-9-]`), `id` (unique in the app, ≤ 100), `name` (≤ 120), `profileId` (or `null`/omitted), `url` (`http(s)`, **required for overlays**), `width`/`height` (integers), `meta` (object) |

Fields not listed are ignored. Each `PUT` replaces the whole registration (send every resource).

- **One app id per connection.** An app connected several times (e.g. CTD Overlay with one
  profile-limited token per profile) registers each connection under its own id, e.g.
  `ctd-overlay-<profile slug>` (and plain `ctd-overlay` for an every-profile token). Other apps find
  recipients by `kind` + profile through `GET /apps?profile=…`, not by a fixed id.
- **Recommended overlay `meta` keys:** `canvas`: `"landscape"` | `"vertical"` (which OBS canvas it
  belongs on — main output vs Aitum Vertical), `fps` (number), `transparent` (boolean), and **`slot`**:
  a stable role key that is the same for the equivalent overlay in every profile (e.g. `"chat-box"`,
  `"takeover-lower-third"`; `[a-z0-9-]`, ≤ 64 — typically the template id plus the canvas). The OBS
  plugin uses `canvas` (falling back to width > height) to place the source, and `slot` + `canvas` to
  re-point existing browser sources when the user switches profile ("Switch existing").
- **Overlay scenes: `meta.scenes`.** An overlay with several scenes lists them so the OBS plugin
  can add one scene as its own browser source instead of the whole overlay:
  ```json
  "meta": { "canvas": "landscape", "slot": "takeover-landscape",
    "scenes": [
      { "id": "scn_intro", "name": "Intro", "url": "http://10.20.30.40:30200/o/takeover-h?key=…&scene=scn_intro" },
      { "id": "scn_brb", "name": "Be right back", "url": "http://10.20.30.40:30200/o/takeover-h?key=…&scene=scn_brb" }
    ] }
  ```
  Each scene `url` shows only that scene (pinned), for the same canvas and size as the overlay's
  main `url` (an overlay per canvas lists the scene URLs of its own canvas). Rules, for resources of
  type `overlay`: `scenes` is an array of ≤ 50 objects, each with `id` (string, 1 to 100, unique
  within the overlay), `name` (string, 1 to 120) and `url` (`http(s)`, ≤ 2048, like the main `url`);
  ≤ 16 KB of JSON in all, **not** counted in the 4 KB of the rest of `meta`. Other keys on a scene
  are kept. A malformed `scenes` refuses the `PUT` (`400 invalid`, naming the field, e.g.
  `resources.0.meta.scenes.1.url`). Relay stores `meta` and returns it exactly as sent in
  `GET /apps`, `GET /profiles/{id}/overlays` and the `apps.changed` event; leave `scenes` out (or
  send `[]`) for an overlay without separate scenes. Readers should treat a missing `scenes` as
  "main URL only". On other resource types `meta.scenes` is free-form like the rest of `meta`.

#### `GET /api/v1/apps?profile=<id>` — `apps:read`
```json
{ "items": [
  { "id": "ctd-overlay", "name": "CTD Overlay", "kind": "ctd-overlay", "version": "1.4.0",
    "baseUrl": "http://10.20.30.40:30200", "capabilities": ["overlays", "overlay.create"],
    "resources": [ … only resources assigned to that profile or unassigned … ],
    "profileId": null, "registeredAt": "…", "lastSeenAt": "…", "online": true }
] }
```
`online` = seen in the last 90 s. With a profile (always, for profile-limited tokens): the apps
connected for that profile or for every profile — apps connected with a token limited to another
profile are left out — each with only the resources assigned to that profile or unassigned.
Without one, or with `?profile=*` (every-profile tokens): every app and resource. `profileId` is the profile of the
token that registered the app (`null` = every profile).

#### `POST /api/v1/apps/{appId}/heartbeat` — `apps:write`
No body. Keeps the app online without re-sending its registration → `200` with the
`ConnectedApp`; `404 not_found` when it isn't registered (register with `PUT`, e.g. after it was
removed in Settings → API), `409 app_owned` for another token's app.

#### `GET /api/v1/profiles/{id}/overlays` — `apps:read`
Shortcut for the OBS plugin: every `overlay` resource assigned to that profile (`profileId` equal
to it; unassigned ones are listed by `GET /apps`), from every app, with its `meta`:
```json
{ "items": [ { "appId": "ctd-overlay", "appName": "CTD Overlay", "appOnline": true,
  "id": "ovl_h", "name": "DPRTMNT takeover — landscape",
  "url": "http://10.20.30.40:30200/o/takeover-h?key=…", "width": 1920, "height": 1080,
  "meta": { "canvas": "landscape", "slot": "takeover-landscape",
    "scenes": [ { "id": "scn_intro", "name": "Intro",
      "url": "http://10.20.30.40:30200/o/takeover-h?key=…&scene=scn_intro" } ] } } ] }
```
`url`, `width`, `height` and `meta` are left out when the app didn't send them. `meta` is returned
as the app registered it; `meta.scenes` (when present: `[{ "id", "name", "url" }]`, see
`PUT /apps/{appId}`) are the overlay's single-scene browser-source URLs.

#### `DELETE /api/v1/apps/{appId}` — `apps:write`
Unregister (the owning token only) → `204`. Revoking a token removes its apps; an admin can also
remove an app in Settings → API.

#### `POST /api/v1/messages` — `apps:write`
Send a message to another app (or every app) through the hub. To reach e.g. the CTD Overlay
connection for a profile, find it with `GET /apps?profile=<id>` (`kind: "ctd-overlay"`, and
`capabilities` containing what you need, such as `overlay.create`) and use its `id` as `to`:
```json
{ "to": "ctd-overlay", "type": "overlay.create", "profileId": "6f1d…",
  "replyTo": null, "data": { "template": "takeover", "canvas": "vertical" } }
```
→ `201 { "id": "01JA…" }`. `to` is required: an app id, or `null` = every app (`404 not_found`
when no app is registered under it). `type`: `[a-z0-9_.-]`, ≤ 64; `data`: an object ≤ 64 KB
(default `{}`). `profileId`: the profile it concerns (default: the sending token's profile, or
`null`; an unknown id is `404 unknown_profile`); a profile-limited token may only name its own
profile or `null`, and a message about a profile can't go to an app connected for another one
(`400`). `from` (optional; `null` = omitted): which of your registered app ids sends it (default:
the one you registered or refreshed last; `null` when you registered none). Delivered as an `app.message` event (below) to tokens with `apps:read` — to
everyone for broadcasts, else only to the token that registered `to` — and never to tokens limited
to another profile; like every event, a reader viewing one profile (`?profile=`, or a
profile-limited token) gets messages about that profile or about none. Reply by sending a message
with `replyTo` = the original `id` and `to` = its `from`. 120 messages/minute per token.
Messages are not stored beyond the event buffer (15 minutes): an app that was away resumes with
its cursor like for any event.

#### Hub events (`apps:read`)
- `app.message` — `data` = `{ "id", "from", "to", "type", "profileId", "replyTo", "data", "ts" }`
  (`ts` in epoch ms; `src.profile` = `profileId`).
- `apps.changed` — `data: { "apps": [ConnectedApp…] }` (filtered like `GET /apps` for the
  profile you read) whenever an app registers, updates its registration, unregisters, or goes
  online/offline (noticed within 15 s).

### 9.3 Pairing ("connect to CTD Relay")

So an app can connect without the user copying tokens: the app asks, the user approves in the web
UI, the app receives its own token.

1. `POST /api/v1/pairing` — **no auth** (10 requests/minute per address, at most 10 pending; see
   the limits below):
   ```json
   { "appName": "CTD OBS plugin (Studio PC)", "kind": "ctd-obs-plugin",
     "scopes": ["status:read", "chat:read", "ingest:read", "apps:read", "apps:write"], "profileId": null }
   ```
   → `201 { "pairingId": "…", "pollSecret": "…", "code": "KQ7-2MX", "expiresIn": 600, "interval": 3,
   "approveUrl": "https://10.20.30.40:30443/settings?tab=api&pair=…" }`.
   The app shows `code` (and `approveUrl`) to the user; `pollSecret` is a secret, never shown.
   `appName` ≤ 60 characters, `kind` `[a-z0-9-]` ≤ 40; scopes this server doesn't know (any
   entry, whatever its shape) are ignored (`400` if none is left); `profileId` is a wish, the admin
   decides (an id that doesn't exist: `404 unknown_profile`; ask for every profile with `null`).
   Over a pending limit: `429` with `Retry-After` (seconds until the oldest request that counts
   against it expires). `approveUrl` uses the host you called (the web UI's HTTPS address when you
   called the LAN plain-HTTP port; the server's public address when that port is a `LAN_HTTP_PORT`
   override, whose HTTPS counterpart can't be derived).

   **Pending limits** (the endpoint needs no auth and is reachable from the internet): at most 10
   requests wait at once; at most **3 per address** (an IPv4 address, or an IPv6 /64); and at most
   **5 from peers outside the LAN**, so requests from the internet can never take the slots the
   OBS plugin or CTD Overlay pair with from the LAN. "LAN" is decided like the plain-HTTP access in
   §1: private ranges, or only `LAN_HTTP_CIDRS` when set, nobody with `LAN_HTTP=off`. Behind a
   reverse proxy or a NAT hop that replaces client addresses (see §1), every client has the same
   address: set `TRUST_PROXY=true` when a trusted proxy sends `X-Forwarded-For`, and
   `LAN_HTTP_CIDRS` / `LAN_HTTP=off` so internet clients aren't counted as LAN.
2. The admin opens **Settings → API** (a banner says an app wants to connect), checks the code,
   picks the profile (or every profile) and the scopes, and approves or denies.
3. The app polls `POST /api/v1/pairing/{pairingId}/token` with `{ "pollSecret": "…" }` every
   `interval` s: `202 { "status": "pending" }` → `200 { "status": "approved", "token": "ctd_pat_…",
   "profileId": "6f1d…" | null, "scopes": [ … ] }` (returned **once**) | `403 { "code": "denied" }` |
   `410 { "code": "expired" }` (problem documents).

**Pairing again** (e.g. for new scopes) gives the app a new token. When the app then registers
(`PUT /apps/{id}`) the **same app id** with the same `kind` and `name`, the new registration
replaces the old one, even while the old one still looks online; entries the same app left under
renewed ids (its id plus `-<6 hex>`, same `kind`, `name` and profile, offline) are removed. The old
token is then revoked 3 minutes later (audit `api_token.superseded`), unless it was used in the
meantime (it then belongs to another live app and is kept) or still has other apps registered.
This needs a new token that covers the old one's profile (every profile, or the same profile). A
token limited to one profile never supersedes the token of a connection made for every profile or
for another profile: while that connection is online its id answers `409 app_owned`, and its token
is never revoked.
Apps that pair again should keep their app id and `name` (put the machine in it).

Requests expire after 10 minutes, and an approved token must be collected within 10 minutes of the
approval (otherwise it is revoked). `410 expired` also answers an unknown `pairingId`, a wrong
`pollSecret`, a second collection, and a token an admin revoked before the app collected it; requests live in memory, so after a server restart the app
gets `410` and simply starts over. Store the token: it never expires (until revoked in
Settings → API).

### 9.5 Overlay summaries: versions and template updates (v1.15)

CTD Overlay tells the CTD OBS plugin's **CTD Overlays** dock its version, its templates' versions
against their followed GitHub releases, which overlays wait for a major upgrade, and short
release notes. This is kept apart from the registration (§9.2) so an overlay's `meta` stays within
its 4 KB: the summary is sent on its own, when it changes and every few minutes.

#### `PUT /api/v1/apps/{appId}/summary` — `apps:write`

Only for a registered app, by the token that registered it (`404 not_found` before the app is
registered, `409 app_owned` for another token). Body (at most 64 KB; `204` when stored):

```json
{
  "schema": "ctd-overlay-summary/1",
  "server": { "name": "CTD Overlay", "version": "0.4.0" },
  "ui": "http://overlay.local:4848",
  "templates": [
    { "id": "com.example.lower", "name": "Lower third", "installed": "1.3.0", "oldestInUse": "1.2.0",
      "latest": "1.3.0", "source": { "kind": "github", "repo": "owner/lower-third", "tagPrefix": "v" },
      "auto": true, "update": "minor", "checkedAt": "2026-11-21T18:00:00Z",
      "notes": [{ "version": "1.3.0", "text": "New: a darker style\nFix: long names wrap" }] }
  ],
  "overlays": [
    { "id": "ovl_…", "slug": "lower", "name": "Lower third", "show": "Miami Or Bust",
      "template": { "id": "com.example.lower", "name": "Lower third", "version": "1.2.0" },
      "waiting": { "to": "2.0.0", "major": true, "why": "a major version" } }
  ]
}
```

- `update`: from `oldestInUse` (else `installed`) to `latest`. `patch` and `minor` move overlays by
  themselves (when `auto`); `major` waits for the operator (before 1.0.0 a minor bump counts as
  major). `problem`: the last check failed, as a short code only (`rate-limited`, `no-release`…).
- `source.tagPrefix`: the release tag prefix it follows (`tn-v` for `tn-v1.2.0`). One repository can hold
  several templates, one per prefix: show a source as `owner/name · tn-v`, never by `repo` alone.
- `notes`: at most 5 releases; `text` is at most 8 plain lines of 200 characters joined with `\n` (a
  string, not an array: the OBS plugin's JSON reader drops arrays of strings).
- `ui`: the admin UI's address (no credentials, query or fragment). The dock opens
  `<ui>/#/overlays/<slug>` (control panel) and `<ui>/#/overlays/<slug>?tab=version` (upgrade).
- Overlay ids are the part of each registered overlay resource's id before the first `:`.
- Fields not listed here are **dropped** (an overlay's URL or key, a token, an error's text never
  reach other apps). Kept in memory: a restart of CTD Relay forgets it until the app sends again;
  it is forgotten when the app unregisters or another token takes its id.

#### `GET /api/v1/profiles/{id}/overlay-summary` — `apps:read`

`{ items: [ { appId, appName, appOnline, receivedAt, schema, server, ui, templates, overlays } ] }`:
one item per app visible from the profile that sent a summary. `overlays` holds only those the app
registered for this profile; `templates` those they use, plus templates no overlay uses. A token
limited to a profile reads only its own (`403 profile_forbidden`). An older CTD Relay answers
`404`: show no version information.

### 9.4 Typical set-ups

- **CTD OBS plugin:** pair → the user picks a profile in the plugin → `GET /profiles/{id}/ingest`
  to set OBS's stream server/key (main output + Aitum Vertical) → `GET /profiles/{id}/overlays` to
  add overlays as browser sources → `/events` (`?profile=`) for chat, `destination.down/up` and
  bitrates in its dock. Register itself (`PUT /apps/ctd-obs-plugin-<machine>`) so other apps can
  message it.
- **CTD Overlay:** pair (limited to a profile, or every profile) → read chat/alerts per profile
  (`/events?profile=<id>`, or one stream for every profile with `/events?profile=*`, split by
  `src.profile`) →
  register its overlays with their assigned `profileId` (`PUT /apps/ctd-overlay`) → listen for
  `app.message` (e.g. `overlay.create` from the OBS plugin) and reply.

## 10. OBS events and feed previews (v1.4)

CTD Relay relays what OBS knows — sources losing or regaining signal, outputs starting and
stopping, scene changes — and previews of the feeds, to apps that connect over the internet with a
token (e.g. **CTD Live mobile**). Nothing here is public: every route needs a token, like the rest
of the API (use the HTTPS address from outside your network).

### `POST /api/v1/apps/{appId}/events` — `obs:write`

The CTD OBS plugin sends batches of events. `appId` is the id it registered (`PUT /apps/{appId}`);
only the token that registered it may send for it (`409 app_owned`), an unregistered id is `404
not_found` (register first). Sending also counts as the app's heartbeat. The profile is the token's,
else `?profile=<id>`, else the default profile.
```json
{ "events": [
  { "id": "a1b2", "type": "obs.feed.state", "ts": 1791830000123,
    "data": { "source": { "name": "Club cam", "path": "live/club", "server": "srt://…" },
              "state": "NO_SIGNAL", "previous": "LIVE", "gapMs": 0 } },
  { "id": "a1b3", "type": "obs.output", "ts": 1791830000200,
    "data": { "output": "main", "canvas": "landscape", "state": "live" } }
] }
```
→ `202 { "accepted": 2, "ignored": 0 }`. Limits: ≤ 50 events per request, `data` ≤ 8 KB each, body
≤ 64 KB, 120 requests/minute per token (one batch a second fits). **Unknown types, malformed events
and duplicate `id`s (seen in the last 10 minutes) are ignored and counted, never refused**, so a
newer plugin keeps working with an older server. `id` ≤ 64 characters, unique per app. `ts` is
epoch ms on the hub's clock (use your `/clock` offset); one more than 5 minutes off is replaced by
the server's time.

| Type | `data` | Kept as |
|---|---|---|
| `obs.feed.state` | `{ source: { name, path?, server? }, state: CONNECTING \| LIVE \| STALLED \| RECONNECTING \| NO_SIGNAL, previous?, gapMs? }` | the source's state |
| `obs.feed.stats` | `{ source: { name }, fps, width, height, latenessMs, resyncs, reconnects, decoder }` | the source's `stats` (re-emitted at most every 5 s per source) |
| `obs.output` | `{ output: "main" \| "vertical" \| "record" \| <name>, canvas?, state: starting \| live \| reconnecting \| stopped, error? }` | the output's state |
| `obs.scene` | `{ canvas: "landscape" \| "vertical", scene, sceneUuid?, previous?, atMs?, scenes?: [{ name, uuid }] }` — `previous` only on a real change; `atMs` = the OBS host's clock, for ordering; `scenes` = the canvas's full scene list in OBS order | the canvas's program scene, and its scene list (kept when an event leaves it out) |
| `obs.sync.status` | `{ group, sourceName, state, previous?, lost?, offsetMs?, delayMs? }` | the sync group member's status |
| `obs.issue.raised` | `{ id: "<rule>\|<subject>", rule, severity: info \| warning \| critical, source, path?, title, cause?, firstSeen, onProgram?, scene? }` — `onProgram` / `scene` since v1.16 (§17.6) | an open issue, until cleared; also an `obs.issue` issue (§17) |
| `obs.issue.cleared` | `{ id, rule? }` | removes the open issue |
| `obs.failover` | `{ canvas, from, to, reason, issueId?, source?, mode: target \| list \| return, title? }` (v1.16, §17.6) | nothing: re-emitted as it is |

Issue rules from the plugin so far: `camera-offline`, `upstream-loss`, `upstream-slow`,
`bitrate-collapsed`, `frequent-snaps`, `av-drift`, `audio-rate`, `audio-missing` — raised after a
hold time, cleared 10 s after the condition ends (low volume); show `title` to people. Since v1.16
Relay also raises each one as an `issue.raised` of kind `obs.issue` (§17): apps that only want
alerts can follow `issue.*` alone.

**Overlays that follow the OBS scene** (CTD Overlay): subscribe to `/events?types=obs.scene`
(`status:read`). The plugin sends a scene change within ~100 ms (a transition counts from its
start) and Relay re-emits it at once, per canvas, whenever the scene (name or `sceneUuid`) or
the scene list changed (a list-only change has the same scene and no `previous`) — use
`previous` / `atMs` to order changes from several OBS machines. "obs.feed" is a source *inside OBS* (e.g. a remote camera), not CTD's own ingest feeds,
which are `feed.status`.

**On `/events`** (`status:read`): the same types, `src` = `{ connection: <appId>, platform: "obs",
profile }`, `data` = what the app sent plus `appId`, `eventId` and `at` (its `ts`). Only changes are
re-emitted: the plugin resends its full state every 60 s, which refreshes the state below without
repeating events (obs.feed.stats: at most every 5 s per source). The plugin polls OBS once a second,
so `obs.output` states are `live` / `reconnecting` / `stopped` (no `starting`); Aitum Vertical's
output arrives under its own name ("Aitum Stream Suite Output Vertical Stream", `canvas: "vertical"`).

### `GET /api/v1/profiles/{id}/obs` — `status:read`

The latest OBS state of a profile, per connected app (apps that unregistered are left out):
```json
{ "apps": [ { "appId": "ctd-obs-plugin-studio", "online": true, "updatedAt": 1791830000200,
  "feeds": [ { "source": "Club cam", "state": "NO_SIGNAL", "previous": "LIVE", "gapMs": 0,
               "stats": { "fps": 59.94, "width": 1920, "height": 1080 },
               "info": { "name": "Club cam", "path": "live/club" }, "updatedAt": 1791830000123 } ],
  "outputs": [ { "output": "main", "canvas": "landscape", "state": "live", "updatedAt": 1791830000200 } ],
  "scenes": [ { "canvas": "vertical", "scene": "Takeover", "updatedAt": 1791829990000 } ],
  "issues": [ { "id": "camera-offline|Club cam", "rule": "camera-offline", "severity": "critical",
                "source": "Club cam", "title": "Camera offline", "firstSeen": 1791829990000, "updatedAt": 1791829995000 } ] } ] }
```
`online` follows the hub's presence rule (seen in the last 90 s); treat an offline app's state as
stale. Kept in memory: after a server restart it is empty until the plugin sends again.

### `GET /api/v1/profiles/{id}/previews/{feed}` — `status:read`

A JPEG of what OBS sends on the profile's `landscape` or `vertical` feed — OBS's program output (the
vertical one from Aitum Vertical). 640 px wide, one keyframe, made on request and cached 2.5 s
(5 s before v1.14), so poll every 3–5 s while showing it. `?access_token=<token>` works too, for image loaders that can't
set headers. Headers: `Content-Type: image/jpeg`, `Cache-Control: no-store`, `X-Preview-At` (when
the frame was taken). `404 feed_offline` while OBS isn't sending that feed; `503 unavailable` (with
`Retry-After`) when a frame couldn't be taken — retry.

### `GET /api/v1/profiles/{id}/feeds/{feed}/live.m3u8` — `feeds:watch` (v1.14)

The feed **live**, as Low-Latency HLS: about 1–3 s behind, H.264 video and AAC audio passed through
unchanged (no transcoding) in fMP4 parts of 200 ms. Play it with any LL-HLS player (hls.js with
`lowLatencyMode`, AVPlayer, ExoPlayer/Media3); a plain HLS player works too, further behind. How it
works and what it costs: [PREVIEW.md](PREVIEW.md).

- **Scope:** `feeds:watch`, its own scope: live video and sound is more than the status and still
  frames every paired app gets with `status:read`. Pair (or create a token) with it on purpose.
- **Auth:** `Authorization: Bearer` on this request **and on every request the player makes** for the
  playlists and parts (hls.js `xhrSetup`/`fetchSetup`, `AVURLAsset` HTTP header fields, Media3
  `DefaultHttpDataSource.Factory().setDefaultRequestProperties`). `?access_token=` is refused here: a
  token in a URL ends up in logs and caches.
- **Each `live.m3u8` request opens a player** (a "viewer"). Its URIs are relative, `live/<file>?v=<viewer>`:
  request them as given (the player adds `_HLS_msn` / `_HLS_part` / `_HLS_skip`). A viewer id only
  works with the token that opened it, on that profile and feed. A player that asked for nothing for
  15 s has left; then (or after MediaMTX closed the stream) its requests answer `410 live_ended`:
  request `live.m3u8` again. Don't keep a player open while nothing shows it.
- **At most 4 players per feed** at once by default (the server's `LIVE_PREVIEW_MAX_VIEWERS`).
  Over it: `429 viewer_cap` with `Retry-After`. A token that opens another player while the feed is
  full replaces its own oldest one. A player counts from the moment it asks for `live.m3u8`, so
  players that open at the same moment never pass the cap together.
- **Rate limit:** `live.m3u8` counts like any request; the `live/{file}` requests have their own budget
  of 1000 per 10 s per token (a playing LL-HLS player makes about 20 a second), so a player never
  eats into the 600 a minute of the rest of the API.
- **Muxing starts with the first player** (the first answer takes about 2–3 s) and stops about 30 s
  after the last request.
- **Errors** (problem+json): `404 feed_offline` (OBS isn't sending it), `409 feed_codec` (the feed is
  HEVC/AV1; `detail` is the codec guard's message, show it instead of a player), `429 viewer_cap`,
  `503 live_off` (Watch turned off on this server) or `503 unavailable` (retry after `Retry-After`),
  plus the usual `401`/`403`/`404 unknown_profile`.
- Headers: `Content-Type: application/vnd.apple.mpegurl` (playlists) or `video/mp4` (parts),
  `Cache-Control: no-store`. CORS is open like the rest of `/api/v1`.

```js
import Hls from 'hls.js';
const hls = new Hls({
  lowLatencyMode: true,
  liveSyncDuration: 2, // ~2 s behind; at MediaMTX's own ~1 s target hls.js rebuffers at the first hiccup
  xhrSetup: (xhr) => xhr.setRequestHeader('Authorization', `Bearer ${token}`),
});
hls.loadSource(`${base}/api/v1/profiles/${profileId}/feeds/landscape/live.m3u8`);
hls.attachMedia(video); // start muted: browsers block autoplay with sound
```

### `GET /api/v1/profiles/{id}/feeds/{feed}/live/{file}?v=<viewer>` — `feeds:watch` (v1.14)

The live preview's media playlists and fMP4 init/part/segment files, as the playlists name them.
`410 live_ended`: open `live.m3u8` again. `404 not_found`: a part the player fell behind on.

### Typical set-up: CTD Live mobile

Connect with the QR code (§11) → `GET /profiles` → per profile: `/events?profile=<id>` for
`stream.status` (live, total viewers), `destination.down/up`, `issue.*` (alerts, §17), `obs.*` and chat → `GET
/profiles/{id}/obs` once on start → poll `/profiles/{id}/previews/landscape|vertical` every few
seconds while the screen shows them.

## 11. Connect a phone with a QR code (v1.5)

So CTD Live mobile connects in one scan — on the same Wi-Fi or on **mobile data** — without typing
an address or a token. In **Settings → API → Connect a phone** an admin picks the profile (or every
profile) and gets a QR code holding:

```
ctdrelay://connect?v=1&api=<public API URL>&lan=<LAN API URL>&fp=<certificate SHA-256>&code=<one-time code>
```

| Parameter | |
|---|---|
| `api` | The public HTTPS address of the API (`https://<public IP or domain>/api/v1`): what a phone on mobile data uses. The router must forward port 443 to CTD Relay. |
| `lan` | The LAN address (optional): try it first on the same network, it's faster. |
| `fp` | SHA-256 fingerprint of the certificate (optional). With a self-signed certificate, pin it: accept the server only if its certificate matches. |
| `code` | One-time secret, valid **5 minutes**, works **once**. |

The app then calls (no token):

#### `POST /api/v1/connect/claim`
```json
{ "code": "<code from the QR>", "deviceName": "Juan's iPhone" }
```
→ `200 { "token": "ctd_pat_…", "tokenId", "name", "scopes": ["chat:read", "status:read", "obs:control"],
"profileId": "6f1d…" | null, "server": { "name": "CTD Relay", "version", "apiRevision" } }`.
Store the token securely (Keychain / Keystore); it never expires until revoked in Settings → API,
where the phone shows up under its `deviceName`. A used, expired or unknown code is `410 expired`
(show a new QR code); 10 attempts/minute per address. The token reads status, viewers, chat, OBS
state and previews, and controls OBS through the OBS socket relay (§12, since v1.6; phones
connected with v1.5 lack `obs:control` and need a new code) — never stream keys or settings.

Use `api` from anywhere; when `lan` answers (same Wi-Fi), prefer it. Both reach the same server,
so the same token works on both.

## 12. Control OBS from anywhere: the OBS socket relay (v1.6)

CTD Live mobile drives OBS with obs-websocket 5. On mobile data it can't reach OBS on your LAN (and
OBS's WebSocket port should never be forwarded to the internet), so it connects to Relay instead and
Relay relays the session to OBS:

```
phone ──wss://<public address>/api/v1/obs/socket + token──▶ CTD Relay ──ws + OBS's password──▶ OBS :4455 (LAN)
```

**Set up:** the CTD OBS plugin reports OBS's WebSocket settings itself (below), so normally there
is nothing to type. Without it: Settings → API → **OBS on your computer**: OBS's address (empty =
detected automatically), port (4455) and the password from OBS → Tools → WebSocket Server
Settings. **Test connection** checks them. The password stays on the server.

### `PUT /api/v1/apps/{appId}/obs-websocket` — `obs:write`

For the CTD OBS plugin (only the token that registered `appId`):
```json
{ "enabled": true, "port": 4455, "authRequired": true, "password": "…", "addresses": ["192.168.1.42"] }
```
→ `200 { "host": "192.168.1.42", "port": 4455, "hasPassword": true, "manualHost": false }`.

- `enabled`, `port`, `authRequired` and `password` are OBS's WebSocket server settings (OBS 28+
  keeps them in `plugin_config/obs-websocket/config.json`).
- `addresses` are the OBS machine's LAN IPs, best first. The first private one is used; else the
  request's own address, if private.
- `password` omitted keeps the saved one; `authRequired: false` removes a password the plugin
  shared (one typed in Settings stays).
- `enabled: false` means OBS's WebSocket server is off, or the user turned sharing off in the
  plugin. Relay forgets the shared password and refuses phones with 4100 ("OBS isn't shared with
  CTD Relay…") instead of connecting.
- The share counts only while the app that made it is registered to the same token. `DELETE
  /apps/{appId}` (the plugin disconnecting), revoking its token, or another token taking the id over
  drops it at once, password included. Re-registering the id never brings an old share back.
- Relay stores the password encrypted and never logs it; the audit log only records that it
  changed.
- An address set by hand in Settings wins over `addresses`, and connects even while sharing is off.
- Send it on start, whenever the settings change, and every few minutes. Repeating the same values
  is cheap and doesn't touch the audit log.

### `GET /api/v1/obs/socket` — `obs:control` (WebSocket)

Upgrade with `Authorization: Bearer ctd_pat_…` and subprotocol `obswebsocket.json` (on the LAN,
`ws://<NAS-IP>:30080/api/v1/obs/socket` works too, §1). Refused before the upgrade with `401
unauthenticated`, `403 missing_scope` or `429 rate_limited` (at most 4 sockets per token).

Then it is obs-websocket 5, exactly as OBS speaks it, with one difference: the **`Hello` has no
`authentication`** (the token signed the phone in), so send `Identify` without it. Relay answers
OBS's challenge with the saved password and passes your `rpcVersion` and `eventSubscriptions` on.
After `Identified`, every message goes through unchanged both ways — requests, batches, events,
`GetSourceScreenshot` previews, `Reidentify`. Frames to Relay are at most 1 MB.

Relay's own close codes (the reason is a sentence to show people):

| Code | Meaning |
|---|---|
| 4100 | OBS's address isn't known yet (no address set, OBS never streamed to Relay), or the CTD OBS plugin says OBS isn't shared |
| 4101 | Relay can't reach OBS (closed, WebSocket server off, PC asleep) or OBS didn't answer in time; retry with backoff |
| 4102 | OBS rejected the OBS password saved in Relay (or asks for one and none is saved) |
| 4103 | OBS went away mid-session; reconnect with backoff |
| 4011 | The token was revoked: connect again with a new QR code |
| 4007 | Something other than `Identify` was sent after `Hello` |
| 1001 | Relay is restarting |

OBS's own `40xx` close codes pass through as they are. Relay pings every 15 s and drops a socket
silent for 60 s. One OBS per Relay: a token limited to a profile reaches the same OBS. Integration
guide for the app: [`LIVE-MOBILE-INTEGRATION.md`](LIVE-MOBILE-INTEGRATION.md).

## 13. Spotify: now playing and song requests (v1.8)

Each profile can connect a Spotify account (**Settings → Spotify**, setup in
[`SPOTIFY.md`](SPOTIFY.md)). Relay then reads what it plays, and viewers can add songs to its
queue from any platform's chat. Relay never controls playback (no skip, pause or volume).

### `GET /api/v1/music?profile=<id>` — `status:read`
```json
{
  "nowPlaying": {
    "playing": true,
    "track": {
      "id": "4uLU6hMCjMI75M1A2tKUQC",
      "uri": "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
      "title": "One More Time",
      "artists": ["Daft Punk"],
      "album": "Discovery",
      "artUrl": "https://i.scdn.co/image/ab67616d00001e02…",
      "durationMs": 320357,
      "explicit": false,
      "url": "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"
    },
    "progressMs": 61234,
    "at": 1791830000123
  }
}
```
- `nowPlaying` is `null` when the profile has no Spotify connected (or Relay hasn't read it yet).
  `track` is `null` when nothing plays (podcasts and ads aren't shown).
- `music.nowplaying` events carry the same `nowPlaying` object. They're sent for another song,
  play/pause and seeks, not for steady progress: while `playing`, show
  `progressMs + (now − at)`, capped at `durationMs`.
- Relay reads Spotify every 5 s while the profile is live, every 30 s otherwise.

### `music.request` data
```json
{
  "at": 1791830000123,
  "user": "NightOwl",
  "platform": "twitch",
  "query": "one more time daft punk",
  "ok": true,
  "track": { "id": "4uLU6hMCjMI75M1A2tKUQC", "title": "One More Time", "artists": ["Daft Punk"], "…": "…" },
  "reason": null
}
```
Refused or failed requests have `"ok": false`, a `reason` written for viewers (`"song requests
are for subscribers, VIPs and moderators"`, `"wait 42 s before requesting again"`, `"explicit
songs are turned off"`, `"no song found"`, `"Spotify is not playing on any device right now"`),
and `track` when one was found. `src.connection` / `src.platform` are the chat it came from.

**Chat commands:** `!sr <song name or Spotify track link>` (also `!songrequest`) and `!song` (what
plays). With "chat replies" on, Relay adds an event line to that chat (`"🎵 NightOwl added One
More Time — Daft Punk"`, or why not), sent as a normal `chat.message` (`kind: "event"`), attributed
to the viewer. Relay can't post in the platforms' own chats. Settings per profile: on/off, who may
request (everyone / subscribers / VIPs / moderators; moderators always may and have no cooldown),
cooldown per viewer, longest song, explicit songs.

## 14. Show profiles (v1.9)

A **show profile** is a profile's OBS set-up (scene collection, OBS profile, vertical canvas,
LUTs, images, media), saved by the CTD OBS plugin so another machine can load it. Relay stores it
and never reads OBS files itself.

- Each Relay profile has **at most one** show profile, so the routes hang off the profile
  (`/profiles/{id}/show`). The first save creates it.
- Every save is a numbered **revision** (1, 2, 3, …). Revisions are immutable. A save names the
  `parentRevision` it was built on, so two machines can't overwrite each other silently.
- A revision is a **bundle** (one tar of small JSON files: scene collection, OBS profile, canvases)
  plus **assets** (big files). Both are **blobs**: files addressed by their SHA-256, stored once
  and shared by every revision and profile that uses them.
- Stream keys never go into a bundle. Overlay URLs are replaced by `{slot, canvas}` references.

The examples use `http://192.168.1.20:30080/api/v1` and a token with `show:read` and `show:write`
(add `show:secrets` for §14.5).

### 14.1 Manifest (schema 1)

The manifest describes a revision. Relay stores it as sent and checks only what it relies on
(below); the rest is the plugin's business. Abridged:

```json
{
  "schema": 1,
  "name": "DPRTMNT",
  "savedBy": { "appId": "ctd-obs-plugin-studio", "os": "windows" },
  "versions": { "obs": "33.0.1", "ctdObs": "x.y.z" },
  "files": { "collection": "collection.json", "profile": ["profile/basic.ini"],
             "canvases": { "vertical": { "adapter": "ctd-vertical-canvas", "file": "canvases/vertical.json" } },
             "plugins": { "ctd-live-source": "plugins/ctd-live-source.json" } },
  "assets":   [ { "sha256": "9f2c…", "size": 1234, "kind": "lut", "name": "warm.cube",
                  "refs": [ { "source": "uuid", "filter": "uuid|null", "key": "image_path" } ] } ],
  "devices":  [ { "slot": "<source uuid>", "sourceType": "dshow_input", "class": "video", "label": "Club cam" } ],
  "overlays": [ { "source": "uuid", "slot": "chat-box", "canvas": "landscape" } ],
  "secrets":  [ { "source": "uuid", "key": "url" } ]
}
```

In the bundle's JSON files, placeholders stand for values that are not stored in the bundle:

| Placeholder | Meaning |
|---|---|
| `"${ctd-asset:<sha256>}"` | A file path: the asset with that hash (`assets[]`), downloaded with `GET /blobs/{sha256}` and placed on this machine |
| `"${ctd-secret}"` | A value held encrypted on Relay: the entry of `secrets[]` with the same `source` and `key` (§14.5) |

What Relay checks on a save: `schema` is a number this server reads (`1`; another gets `400 invalid`
telling the user to update CTD Relay), `name` is 1–100 characters, every path in `files` is relative
(no `..`, no leading `/`, no `\`, no drive letter), `assets` has at most 2000 entries, each with a
lowercase hex `sha256`. `savedBy.appId` is recorded as the revision's `savedBy`.

**Secrets are not in the bundle.** The values travel in the save body's `secrets` and come back from a
separate route (§14.5), so the bundle stays byte-identical to its `bundleSha256`. A reader without
`show:secrets` gets the placeholders and lists those sources as "needs re-entry".

### 14.2 Save flow

1. Build the bundle and hash it and every asset file (SHA-256, lowercase hex).
2. `POST /blobs/check` with all the hashes. The answer lists the ones Relay still needs.
3. `PUT /blobs/{sha256}?kind=<kind>` for each missing blob (at most 2 at a time).
4. `POST /profiles/{id}/show/revisions` with the manifest, `bundleSha256` and the `parentRevision`
   you loaded (`0` for the first save).

Two answers to handle on step 4:

- `409 revision_conflict` with `head`: someone saved meanwhile. Nothing was stored. Load revision
  `head` (§14.3), merge, and save again with `parentRevision: head`.
- `400 missing_blobs` with `missing: [sha256…]`: those blobs are not stored (or not visible to the
  token, §14.6). Upload them and repeat step 4.

### 14.3 Load flow

1. `GET /profiles` (`status:read`): each item has `show`, `{ "headRevision", "updatedAt", "savedBy": { "appId" } }`,
   or `null` before the first save. One call lists the profiles and their show state.
2. `GET /profiles/{id}/show`: name and head. `GET /profiles/{id}/show/revisions` for the history.
3. `GET /profiles/{id}/show/revisions/{rev}`: the revision with its manifest.
4. `GET …/revisions/{rev}/bundle`: the tar.
5. `GET /blobs/{sha256}` for every `assets[]` entry you don't have yet. Cache by hash: a hash never changes.
6. `GET …/revisions/{rev}/secrets` with `show:secrets` (§14.5).

### 14.4 Routes

#### `GET /api/v1/profiles/{id}/show` — `show:read`
```json
{ "id": "5c0e…", "profileId": "default", "name": "DPRTMNT", "headRevision": 7,
  "createdAt": "2026-11-05T20:00:00Z", "updatedAt": "2026-11-12T19:40:00Z", "savedBy": { "appId": "ctd-obs-plugin-studio" } }
```
`404 not_found` before the first save. `404 unknown_profile` / `403 profile_forbidden` as in §9.1:
a profile-limited token reads its own profile only.

#### `GET /api/v1/profiles/{id}/show/revisions` — `show:read`
Newest first. Revisions beyond the retention limit (§14.8) are gone; a pinned one stays.
```json
{ "head": 7, "items": [
  { "profileId": "default", "revision": 7, "parentRevision": 6, "bundleSha256": "4b1d…",
    "size": 48211093, "savedBy": { "appId": "ctd-obs-plugin-studio" }, "note": "new lower third",
    "pinned": false, "savedAt": "2026-11-12T19:40:00Z" }
] }
```
`size` is the bundle plus every asset it references, in bytes. `parentRevision` is `null` for the first.

#### `GET /api/v1/profiles/{id}/show/revisions/{rev}` — `show:read`
One item as above plus `"manifest": { … }` exactly as saved. `404 not_found` for a revision that
doesn't exist or was pruned.

#### `GET /api/v1/profiles/{id}/show/revisions/{rev}/bundle` — `show:read`
The bundle (a tar of JSON files), downloaded as in §14.6. Byte-identical to `bundleSha256`.

#### `GET /api/v1/profiles/{id}/show/revisions/{rev}/secrets` — `show:secrets`
```json
{ "items": [ { "source": "8a1f…", "key": "url", "value": "https://example.invalid/widget?key=…" } ] }
```
The values the manifest's `secrets[]` stand for, `Cache-Control: no-store`. `items` is empty when the
revision saved none. Every read is written to the audit log (`show.secrets.read`).

#### `POST /api/v1/profiles/{id}/show/revisions` — `show:write`
```json
{ "parentRevision": 7, "bundleSha256": "4b1d…", "note": "new lower third",
  "manifest": { "schema": 1, "name": "DPRTMNT", "files": { }, "assets": [ ] },
  "secrets": [ { "source": "8a1f…", "key": "url", "value": "…" } ] }
```
- `parentRevision`: the head you built on; `0` creates the show profile.
- `note`: optional, up to 500 characters. `secrets`: optional, up to 200 entries
  (`source` ≤ 64, `key` ≤ 128, `value` ≤ 8 KB), stored encrypted (see [SECURITY.md](SECURITY.md)).
- The bundle and every `assets[].sha256` must be stored already and usable by the token (§14.6).
- `201` with the new revision (same shape as in the list). Relay numbers it.

| Status | `code` | When |
|---|---|---|
| 400 | `invalid` | Bad body or manifest (§14.1) |
| 400 | `missing_blobs` | Not uploaded yet: `{ …, "missing": ["<sha256>", …] }` |
| 409 | `revision_conflict` | `parentRevision` is not the head: `{ …, "head": 8 }` |
| 413 | `limit` | Manifest over 1 MB, bundle over 16 MB, or `secrets` too large (the whole body is limited to about 3 MB) |

#### `POST /api/v1/blobs/check` — `show:write`
```json
{ "items": [ { "sha256": "4b1d…", "size": 18320 }, { "sha256": "9f2c…", "size": 1234 } ] }
```
→ `{ "missing": ["9f2c…"] }`. Up to 1000 items. A token limited to a profile is told `missing` for
every blob it can't see (§14.6), so the answer never reveals what other profiles hold.

#### `PUT /api/v1/blobs/{sha256}?kind=<kind>` — `show:write`
Body: the raw file (`Content-Type: application/octet-stream`), streamed to disk. The 1 MB JSON limit
of other routes doesn't apply; the kind's limit (§14.8) does. `{sha256}` is the lowercase hex SHA-256
of the body: Relay hashes while it receives and keeps the file only if they match. Send
`Content-Length` so a too-large file is refused before it is sent.

`kind` is one of `lut`, `image`, `video`, `audio`, `font`, `html`, `bundle`, `other` (default `other`).
It selects the size limit and the content check: a `lut` is a text `.cube` file (with a
`LUT_3D_SIZE` or `LUT_1D_SIZE` line) or a PNG (HaldCLUT). Native executables (Windows PE, ELF,
Mach-O) and `#!` scripts are refused for every kind.

```json
{ "sha256": "9f2c…", "size": 1234, "kind": "lut", "created": true }
```
`201` when stored; `200` with `created: false` when Relay already had the blob (the upload was
still checked against the hash, which proves you hold the bytes). At most **2 uploads at once per
token**; a third gets `429 rate_limited` with `Retry-After: 5`. After a refused upload the server may
close the connection instead of reading the rest of the body.

| Status | `code` | When |
|---|---|---|
| 400 | `invalid` | Not a lowercase hex hash, unknown `kind`, or the upload broke off |
| 400 | `hash_mismatch` | The body doesn't hash to `{sha256}` |
| 413 | `limit` | Over the kind's size limit |
| 413 | `quota_exceeded` | Over the total storage quota |
| 415 | `invalid` | The content doesn't fit the kind, or is an executable |

#### `GET /api/v1/blobs/{sha256}` — `show:read`
The file, downloaded as in §14.6. `404 not_found` when no revision or library entry visible to the
token references the blob and the token didn't upload it recently, and also when the hash doesn't
exist at all: the two cases look the same.

#### `GET /api/v1/library?profile=<id>&kind=<kind>` — `show:read`
The **asset library**: files an admin uploaded on the web UI's Assets page (LUTs, images) to share
between machines.
```json
{ "items": [ { "id": "c3d4…", "sha256": "9f2c…", "name": "warm.cube", "kind": "lut",
               "profileId": null, "size": 1234, "createdAt": "2026-11-05T20:00:00Z" } ] }
```
`profileId: null` means the entry is shared by every profile. With `?profile=` you get the shared
entries plus those assigned to that profile; a token limited to a profile always gets its own
profile's view. Without `?profile=`, a token for every profile gets every entry. `kind` filters by
kind (`400 invalid` for an unknown one). Download an entry with `GET /blobs/{sha256}`.

### 14.5 Secrets

Third-party secrets found in a profile (a key in a browser-source URL, a plugin password) are not
stored in the bundle or the manifest. The plugin sends them in the save as `secrets[]`, one entry
per `{source, key}` named in the manifest's `secrets[]`, and the bundle holds `"${ctd-secret}"`
instead. Relay keeps them encrypted per revision. Only a token with `show:secrets` can read them,
with `GET …/revisions/{rev}/secrets`, and fills the placeholders in. A machine without the scope
still loads everything else. Stream keys are not secrets of this kind: they come from
`GET /profiles/{id}/ingest` (`ingest:read`).

### 14.6 Downloads and who sees which blob

Bundle and blob downloads send `Content-Type: application/octet-stream`,
`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `ETag: "<sha256>"`,
`Accept-Ranges: bytes` and `Cache-Control: private, max-age=31536000, immutable` (the content never
changes). They support one `Range: bytes=…` range (`206`; `416` when it can't be satisfied; a
malformed or multi-range header gets the whole file) and `If-None-Match` (`304`), so a big file can
resume. Verify the hash after downloading.

Blobs are shared by hash across profiles, so access is checked per token:

- A token for every profile may read any blob that a revision or library entry references and
  build a save on any stored blob.
- A token limited to a profile sees a blob only when a revision of its profile, or a library entry
  visible to it, references it, or when it uploaded the blob itself within the last 24 hours.
  For anything else `POST /blobs/check` says `missing` and `GET /blobs/{sha256}` says `404`.
  Uploading then proves possession and makes the blob usable for that token. Nothing tells a token
  whether another profile has a file.

### 14.7 Events

`show.changed` (`show:read`, `src.profile` = the profile) after every saved revision, with
`{ profileId, revision, parentRevision, byAppId }`. Compare `revision` with the one you have loaded
and offer the update. `library.changed` (`show:read`, `data: {}`) when the asset library changes:
refetch `GET /library`. Both are in §5.

### 14.8 Limits

| What | Limit |
|---|---|
| LUT (`kind=lut`) | 64 MB |
| Image | 50 MB |
| Video, audio | 2 GB each |
| Font, HTML, bundle kind, other | 200 MB |
| Bundle of a revision | 16 MB |
| Manifest | 1 MB; at most 2000 assets |
| Check request | 1000 items |
| Total blob storage | 20 GB. Set `ASSETS_QUOTA_BYTES` to change it; the `assets.limits` setting can override any limit above |
| Revisions kept per show profile | 50, plus pinned ones; a save beyond that removes the oldest unpinned revision (and its secrets) |
| Concurrent uploads | 2 per token |

A daily clean-up deletes blobs that no revision or library entry references once they are 7 days
old (an upload never followed by a save, a pruned revision's files). The rate limit in §2 applies
as usual.

## 15. Operator tools: the Instagram chat reader (v1.11)

Instagram's live comments are read from its page in Relay's browser, and that page changes often.
What the reader knows about the page is a **selector pack**: JSON with CSS selectors, attribute
names, text patterns and timings. These routes let an operator, or a remote agent the operator
trusts, see what the reader sees and change the pack **while a live is running**, without a new
release. The guide with examples is docs/PLATFORMS.md → Instagram → "Tuning the chat reader live".

All four routes need **`system:admin`** and a token that is **not limited to one profile**
(`403 profile_forbidden` otherwise). The scope can only be put on a token in **Settings → API**; a
pairing request that asks for it gets the other scopes it asked for, and approving a pairing can
never add it. Every change and every capture is written to the audit log with the token's name.
The web UI has the same four operations for signed-in admins under
`/api/platforms/instagram/chat/…` (Settings → Advanced uses them).

#### `GET /api/v1/platforms/instagram/chat/selector-pack` — `system:admin`

```json
{
  "source": "override",
  "version": "2026-11-20 a",
  "builtinVersion": "builtin-3",
  "note": "comment rows moved to data-comment-id",
  "updatedAt": "2026-11-20T10:00:00.000Z",
  "updatedBy": "token Support agent",
  "readers": 1,
  "maxBytes": 16384,
  "pack": { "schema": 1, "version": "2026-11-20 a", "tab": { "…": "…" }, "container": { "…": "…" }, "row": { "…": "…" }, "text": { "…": "…" }, "classify": { "…": "…" }, "composer": { "…": "…" }, "timing": { "…": "…" }, "limits": { "…": "…" } },
  "override": { "schema": 1, "version": "2026-11-20 a", "row": { "css": ["[data-comment-id]"] } }
}
```

- `source`: `builtin` (the pack shipped with this version) or `override`.
- `pack`: what the reader runs with, every setting: the built-in pack with the override on top.
- `override`: the override as stored, `null` on the built-in pack.
- `readers`: how many Instagram lives are being read right now.

#### `PUT /api/v1/platforms/instagram/chat/selector-pack` — `system:admin`

The body is an override: `schema` (`1`), `version` (your label, at most 40 characters), an optional
`note`, and **any subset** of the pack's sections (`tab`, `container`, `row`, `text`, `classify`,
`composer`, `timing`, `limits`) with any subset of their settings. A list replaces the built-in list
whole. What each setting does: docs/PLATFORMS.md. The exact shape: `InstagramChatPackOverride` in
`openapi.json`. Answers like `GET`.

A pack is **data only** and the server checks it before storing it (`400 invalid`, the detail
lists every problem with its path, e.g. `row.css.0: CSS selector: …`):

| Rule | Limit |
|---|---|
| Size | 16 KB of JSON (`413` when the request body is over 32 KB) |
| Settings | Only the known ones. An unknown key is refused |
| CSS selectors | Plain CSS, at most 200 characters, at most 12 per list. No selector engine prefixes (`xpath=`, `text=`), no `>>` chains, no `{ } ; @ <` or comments |
| Attribute names | `[A-Za-z_][A-Za-z0-9_.:-]*`, at most 64 characters |
| Patterns | Regular-expression source, at most 300 characters, at most 24 per list, compiled with the `i` flag. No backreferences. A pattern that is slow on long input (catastrophic backtracking) is refused. Capture group 1 has a meaning in `row.avatarAlt` (the user name) and `classify.join` (the number of others, v1.12) |
| Numbers | `timing.pollMs` 500–10000, `timing.tabRetryMs` 3000–120000, `timing.backoffMaxMs` 1000–60000, `timing.liveStartGraceMs` 0–600000 (v1.12), `limits.maxRows` 20–500, `limits.history` 50–2000, `row.maxAvatars` 1–4, `container.climbLevels` 0–12, `container.climbMinHeight` 0–2000 |
| Switches (v1.12) | `timing.backlogAsHistory`, `container.climbPreferRows`: `true` or `false` |

Nothing in a pack is run as code: selectors go to `querySelectorAll`, attribute names to
`getAttribute`, and patterns are tested against at most 400 characters of text. A selector the
browser cannot use is skipped and reported in the debug capture (`reader.bad`).

The running reader uses the new pack on its **next poll**. It is stored in the database and loaded
again at start-up; a stored pack that a later version no longer accepts is ignored (the built-in
pack runs and the log says why).

#### `DELETE /api/v1/platforms/instagram/chat/selector-pack` — `system:admin`

Back to the built-in pack. Answers like `GET`. Idempotent.

#### `POST /api/v1/platforms/instagram/chat/debug` — `system:admin`

A **sanitised** picture of what each running reader sees. Optional JSON body:

| Field | Default | |
|---|---|---|
| `scope` | `container` | `page`: the whole page (also used when no comments container is found) |
| `up` | `0` | Start this many parents above the container (0–6) |
| `decisions` | `50` | How many of the last parse decisions to return (0–200) |
| `maxNodes` | `400` | Size of the tree (20–1500) |

```json
{
  "capturedAt": "2026-11-20T10:05:00.000Z",
  "pack": { "source": "builtin", "version": "builtin-3", "builtinVersion": "builtin-3" },
  "readers": [
    {
      "reader": { "packVersion": "builtin-3", "container": "tabpanel", "rows": 12, "truncated": 0, "failures": 0, "tab": "selected", "tabClicks": 1, "kept": 41, "dropped": 9, "backlog": 0, "newestFirst": false, "bad": [], "lastReadAt": "2026-11-20T10:04:59.400Z" },
      "tab": { "matches": 1, "visible": true, "ariaSelected": "true" },
      "composer": { "matches": 1 },
      "snapshot": {
        "page": { "host": "www.instagram.com", "pathSegments": 2, "ready": true, "title": 9 },
        "container": { "strategy": "tabpanel", "tag": "div", "role": "tabpanel", "box": [380, 520], "rows": 12 },
        "root": "container",
        "tree": {
          "tag": "div", "ctd": "container", "attrs": { "role": "tabpanel" }, "box": [380, 520],
          "children": [
            { "tag": "div", "ctd": "row", "class": ["x9f619"], "box": [380, 40], "children": [
              { "tag": "img", "class": ["xpdipgo"], "labels": { "alt": { "len": 31, "is": ["avatarAlt"] } }, "data": { "src": "https" }, "box": [20, 20] },
              { "tag": "span", "children": [{ "text": 14 }] },
              { "tag": "span", "children": [{ "text": 27 }] },
              { "tag": "span", "children": [{ "text": 5, "is": ["meta"] }] }
            ] }
          ]
        },
        "nodes": 86, "truncated": false,
        "selectors": { "row.avatarCss[0]": { "page": 13, "container": 12, "visible": 13 }, "row.css[0]": "invalid" },
        "patterns": { "container.panelLabel": 1, "container.composerHint": 1, "row.avatarAlt": 13, "tab.name": 1 },
        "bad": []
      },
      "decisions": [
        { "at": "2026-11-20T10:04:58.400Z", "row": 57, "verdict": "kept", "reason": "new", "kind": "message", "join": false, "authorLength": 14, "textLength": 27, "hasAvatar": true, "hasId": false, "restored": false }
      ]
    }
  ]
}
```

`readers` is empty when no Instagram live is being read. What the capture **never** contains: user
names, comment text, link targets, image addresses, cookies, the page's address beyond its host,
or anything typed into a field. What it keeps, so a pack can be written from it:

- **Tree:** tag names, class names, roles and other structural attributes (`role`, `type`,
  `aria-selected`, …) with their values, every attribute's **name**, each visible element's size,
  and `"ctd": "container" | "row"` on the elements the reader tagged.
- **Text nodes:** only their length, and which pack patterns they match (`"is": ["meta"]`).
- **Labels** (`alt`, `aria-label`, `placeholder`, `title`): their length and which pack patterns
  they match. Words from a fixed list of interface words ("comment", "reply", "pinned", "profile",
  "picture", …) are shown, every other word is replaced by `#` marks of its length
  (`"profile photo of ##########"`). An avatar alt that the pack recognises is never shown.
- **Other attribute values** (`data-*`, `id`, `href`, `src`, …): a shape — `digits/5`, `hex/8`,
  `word/12`, `text/30`, `path/1` (a relative link one level deep), `https`, `data`, `empty`. A
  value made only of interface words is shown with a leading `=` (`"=live-comments"`), never for
  links, `value` or `style`.
- **`selectors`:** per pack selector, how many elements match in the page, in the container, and
  how many of them are visible; `"invalid"` when the browser rejects it.
- **`decisions`:** newest last. `verdict` `kept` (`reason` `new`, or `late`: a row that was not at
  the newest end of the list) or `dropped` (`baseline`: already on screen when the reader first
  read the comments of this live; `rerender`: a re-created row of a comment already delivered;
  `duplicate-id`; `pinned`; `system`; `pack-changed`: on screen at the first read with rows under
  a new pack). Lengths only. `reader.backlog` (v1.12) counts the `baseline` and `pack-changed`
  rows: comments taken as history instead of delivered.

The capture reads the page; it does not click or change anything.

## 16. Stream reports (v1.13)

Every stream (a profile's session, start to end) is recorded: titles, destinations, live periods,
events, viewers every 30 s per destination (unknown = `null`, never 0), chat per platform per
minute, feed stats per minute and, with audience tracking on, per-person counts (never message
text). What is recorded and how the numbers are worked out: [REPORTS.md](REPORTS.md).

All routes need **`reports:read`** and are read-only. A token limited to one profile sees that
profile's streams only (another profile's stream answers `404 not_found`); an every-profile token
sees every profile unless it passes `?profile=<id>`. `?profile=*` asks for every profile the token
can see.

Common query parameters (list, summary, leaderboard and range export):

| Parameter | Meaning |
|---|---|
| `from`, `to` | A day `YYYY-MM-DD` (in `tz`; `to` includes that day) or an ISO time. Streams that **started** in the range |
| `tz` | IANA time zone for days and for times in .xlsx/CSV (default `UTC`) |
| `platform` | One platform id |
| `test` | `include` or `exclude` test-mode streams (default `include` for `/reports/sessions`, `exclude` for the others) |

| Route | Returns |
|---|---|
| `GET /reports/sessions?limit=100` | `{ sessions: ReportSessionSummary[] }`, newest first (1–1000) |
| `GET /reports/sessions/{id}` | the stream: `titles`, `destinations` (canvas, Dual Format, live periods), `stats` (per platform, `total` last), `viewers` (`[{ ts, total, byPlatform }]`), `chatMinutes`, `feedMinutes`, `events`, `presence`, `audienceTracked`, `leaderboards` |
| `GET /reports/sessions/{id}/export?format=xlsx\|csv\|json&tz=` | a file (`Content-Disposition: attachment`); `xlsx` is the default |
| `GET /reports/summary?limit=25` | over the range: `streams`, `stats`, `sessions`, the four `leaderboards` |
| `GET /reports/export?from&to&format&tz` | the range as one file |
| `GET /reports/audience?board=chatters\|loyal\|watch\|newest&session=<id>&limit=25` | one leaderboard over the range or one stream (1–500 rows) |
| `GET /reports/audience/users/{userId}` | one person: `user`, `totals`, `streams`. `userId` is the `chat.message` `user.id` form, URL-encoded |

`ReportStats` (per platform and `total`): `durationSec`, `liveSec`, `uptime` (0–1), `peakViewers`,
`peakViewersAt`, `avgViewers` (time-weighted over the known time), `viewerMinutes` (viewers ×
minutes, **not** unique viewers), `viewersKnownMinutes`, `chatMessages`, `chatEvents`, `joins`,
`anonymousJoins` (Instagram "and N others joined"), `uniqueChatters`, `chatPer1kViewerMinutes`,
`recoveries`, `errors`. Numbers Relay could not know are `null`.

Leaderboard rows: `id`, `platform`, `displayName`, `login`, `firstSeenAt`, `lastSeenAt`,
`messages`, `streams` (attended: chatted, joined or present), `joins`, `watchSec` (`null` unless
the person's platform reports presence: today Twitch's chatters list).

Errors: `400 invalid` (bad `from`/`to`/`platform`/`board`/`limit`/`format`), `404 not_found`,
`503 unavailable` (the report tables were made by a newer Relay).

The web UI uses the same routes under `/api/reports` (session cookie), plus, for admins,
`GET`/`PUT /api/reports/settings` (`{ recording, audience, retentionDays: 0|90|365 }`) and
`DELETE /api/reports/audience/users/{userId}` ("forget this user"). Those two are not in v1.

## 17. Issues: alerts when a feed, a stream or a scene has a problem (v1.16)

One event pair tells every CTD app that something is wrong and when it is fixed: **`issue.raised`**
and **`issue.cleared`** (`status:read`). Relay raises them from what it sees itself (its ingest
feeds, its destinations) and from what the CTD OBS plugin reports (sources inside OBS, OBS outputs).
CTD Live Studio and Live Mobile show them as alerts; the CTD OBS plugin reports its own issues and
the failovers it makes (`obs.failover`, §10). This is the one alert contract of the suite: new
detectors add a `kind`, not a new event.

### 17.1 The issue object

```json
{
  "id": "feed.offline|landscape",
  "kind": "feed.offline",
  "rule": null,
  "severity": "critical",
  "title": "Landscape feed lost",
  "message": "OBS stopped sending the landscape feed to Relay during the live.",
  "subject": { "type": "feed", "feed": "landscape" },
  "onProgram": null,
  "scene": null,
  "firstSeen": 1791830000123,
  "updatedAt": 1791830000123
}
```

| Field | Meaning |
|---|---|
| `id` | Stable key of the problem, unique among the profile's open issues: `<kind>\|<subject key>` (table below). **The raise/clear pair and every dedupe use it.** Opaque: don't parse it, use `kind` and `subject`. |
| `kind` | What kind of problem (table below). Treat a kind you don't know by its `severity` and `title`. |
| `rule` | `obs.issue` only: the plugin's rule (`camera-offline`, `upstream-loss`, …, `image-match`); `null` otherwise. |
| `severity` | `info`, `warning` or `critical`. **critical** = viewers are (or are about to be) affected: alert loudly. **warning** = something is degraded or recovering: show it. **info** = for the record. |
| `title` | Short text for people ("Twitch is down"). English, ≤ 120 characters. |
| `message` | One more line of detail (the platform's reason, the plugin's cause), or `null`. |
| `subject` | What the problem is about (below). |
| `onProgram` | OBS subjects: `true` when the source is visible on a program scene, `false` when it isn't, `null` when unknown or not an OBS source. |
| `scene` | The program scene the source is on when `onProgram` is `true`, else `null`. |
| `firstSeen` | Epoch ms the problem started (after its hold time). Unchanged by updates. |
| `updatedAt` | Epoch ms of the latest change. |

`subject`, by `type`:

| `type` | Fields | Means |
|---|---|---|
| `feed` | `feed`: `landscape` \| `vertical` | One of Relay's ingest feeds (what OBS sends Relay; `feed.status`) |
| `destination` | `destinationId`, `platform`, `name` | One destination (`destination.status`) |
| `stream` | — | The profile's whole live session |
| `obs.output` | `appId`, `output`, `canvas` (or `null`) | An OBS output (`obs.output`, §10) |
| `obs.source` | `appId`, `source`, `path` (or `null`) | A source inside OBS: a camera, a CTD Live Source feed, a media source (`obs.feed.state`, §10) |

### 17.2 Kinds (v1.16)

| `kind` | `id` | Severity | Raised when | Cleared when |
|---|---|---|---|---|
| `feed.offline` | `feed.offline\|<feed>` | critical; **warning** when every feed went quiet and no CTD OBS app is there to say why | A running session's (`starting`/`live`) ingest feed goes from online to offline and stays offline **5 s** — unless OBS stopped that stream on purpose (below) | The feed is back (`recovered`), the session ends, or OBS reports a clean stop late (`ended`) |
| `destination.down` | `destination.down\|<destinationId>` | warning; **critical** once the phase is `error` (Relay gave up) | The destination's `down` flag (§4) stays set **5 s**. While it only waits for a feed: **30 s** when that feed hasn't come yet (a show being set up), never when this session lost it (that is `feed.offline`'s) | `destination.up` (`recovered`), the session ends (`ended`), the destination is deleted (`removed`) |
| `stream.down` | `stream.down` | critical | A running session has at least one counted destination (enabled, not skipped by test mode) and **every** one is down, for **5 s**. Not while every one only waits for a feed: this is for platforms failing | Any of them is up again (`recovered`), or the session ends (`ended`) |
| `obs.output.down` | `obs.output.down\|<appId>\|<output>` | warning | An OBS output reports `reconnecting` for **3 s**, and no `feed.offline` already tells it (OBS streams elsewhere, Relay isn't live, or the feed never reached Relay this session) | It reports `live` (`recovered`) or `stopped` (`ended`); its app goes away (`removed` / `stale`) |
| `obs.issue` | `obs.issue\|<appId>\|<plugin issue id>` | the plugin's | The plugin sends `obs.issue.raised` (it applies its own hold time) | The plugin sends `obs.issue.cleared` (`recovered`); its app unregisters (`removed`) or goes offline (`stale`) |

Hold times keep a blip (OBS reconnecting in a second, a platform retry) from becoming an alert.
They are fixed in v1.16.

**Stopping on purpose is not an alert.** When the CTD OBS plugin reports that OBS stopped a stream
cleanly — that output's `obs.output` going from `live` to `stopped` without `error`, within 15 s of
the feed going offline, before or after — Relay raises no `feed.offline` (one already raised clears
as `ended`), and the destinations that then wait for that feed raise nothing either while the
session runs out its grace period. Any other `stopped` (with an `error`, from an output that wasn't
live, or long after the loss) changes nothing. While an OBS app that reports on the profile is
online and there is no such report, a lost feed is `critical` ("OBS stopped sending without stopping
its stream": a crash or the network); when the plugin reports `reconnecting`, the message says so.
With no OBS app online Relay can't tell a stop from a crash: one feed lost while the other stays is
`critical`, every feed gone is a `warning`.

At most 100 `obs.issue` issues are open per app; reports beyond that are dropped until some clear. `obs.issue` carries the plugin's `onProgram` / `scene` when the plugin
sends them (CTD OBS F2 and later): that is how a dead source **on program** — a scene problem —
becomes visible to the Live apps.

### 17.3 Events

**`issue.raised`** — `status:read`. `data` = the issue object plus `"update"`:

- `update: false` — a new problem. **This is the one to notify on.**
- `update: true` — the open issue with the same `id` changed: `severity`, `title`, `message`,
  `onProgram` or `scene` (or, rarely, `rule` or `subject`: a destination renamed). Replace what you
  show. Notify again only if `severity` went up.

Relay sends at most one `issue.raised` per change; the plugin's 60 s state resend never repeats one.

**`issue.cleared`** — `status:read`:

```json
{ "id": "feed.offline|landscape", "kind": "feed.offline", "rule": null,
  "subject": { "type": "feed", "feed": "landscape" }, "title": "Landscape feed lost",
  "firstSeen": 1791830000123, "durationMs": 4100, "resolution": "recovered" }
```

| `resolution` | Means |
|---|---|
| `recovered` | The thing works again (feed back, destination live, source has signal) |
| `ended` | It no longer applies: the session or the output stopped. **A `feed.offline` that clears as `ended` means OBS's stream is over without the feed coming back**: the session ended (OBS stopped or crashed and the grace period ran out), or OBS reported, a little late, that it stopped on purpose. |
| `removed` | Its destination, app or profile was deleted |
| `stale` | The OBS app that reported it went offline (§9.2's 90 s rule); its state is unknown. Relay forgets what that app reported. When it returns, its own next report raises whatever is still wrong (`update: false`, a new `firstSeen`); a problem that ended while it was away never comes back |

`src` is the usual envelope source: `core` for `feed` and `stream` subjects, the destination for
`destination`, and `{ connection: <appId>, platform: "obs" }` for OBS subjects. `src.profile` is
the profile.

### 17.4 What is open right now

`GET /status` (§4) carries `issues`: the profile's open issues, oldest first, in the issue-object
shape (without `update`). The stream's opening snapshot doesn't repeat open issues.

**Connecting without a gap:** open `/events` first, then read `/status` and take its `issues` as the
open set, then apply the stream's events in the order they came. An `issue.raised` for an `id` you
already hold with the same `firstSeen` is the same issue: replace it, don't notify. After
`system.reset`, read `/status` again. Open issues live in memory: a Relay restart starts with none,
and the plugin's next state resend raises its issues again.

### 17.5 Rules for clients (Live Studio, Live Mobile, anything else)

1. Key everything by `id`. `issue.raised` with `update: false` adds (or replaces), `update: true`
   replaces, `issue.cleared` removes. An `issue.cleared` for an id you don't have is fine: ignore it.
2. Notify (sound, banner, haptic, system notification) on `update: false`, and on an update whose
   `severity` went up. Not on `issue.cleared`, except that a `feed.offline` / `stream.down` cleared
   as `ended` is worth one "stream ended" line.
3. Don't notify the same `id` more than once a minute: a camera that drops every 20 s is one
   alert, not three. Keep showing it while it is open. A rise in severity is told even right after
   the first alert, but also at most once a minute per `id`.
4. Order by `severity`, then `firstSeen`. Show `title` (and `message` when there is room).
5. Filter by `kind` / `subject` only for what your app can act on; show the rest.

### 17.6 For the CTD OBS plugin (producer)

- Keep sending `obs.issue.raised` / `obs.issue.cleared` as in §10. Since v1.16 the plugin may add
  `onProgram` (boolean) and `scene` (the program scene's name) to `obs.issue.raised`, and should
  resend the issue (same plugin `id`) when either changes, e.g. after a failover takes the source off
  program.
- **`obs.failover`** (new OBS event type, v1.16): the plugin switched program away from a dead
  feed. Relay keeps no state for it and re-emits it on `/events` (`status:read`) like the other
  `obs.*` events.

```json
{ "id": "f-17", "type": "obs.failover", "ts": 1791830004000,
  "data": { "canvas": "landscape", "from": "Club cam", "to": "BRB", "reason": "camera-offline",
            "issueId": "camera-offline|Club cam", "source": "Club cam", "mode": "target",
            "title": "Switched to BRB: Club cam lost its signal" } }
```

| Field | Meaning |
|---|---|
| `canvas` | `landscape` (main) or `vertical` |
| `from`, `to` | Program scene before and after |
| `reason` | The rule that triggered it (`camera-offline`, `image-match`, …) |
| `issueId` | The plugin issue id that triggered it (its `obs.issue` id is `obs.issue\|<appId>\|<issueId>`) |
| `source` | The dead source |
| `mode` | `target` (a set scene), `list` (the next healthy scene of a fallback list) or `return` (back to the original scene once the source recovered) |
| `title` | Text for people |


## 18. Guest feeds: remote video into CTD OBS (v1.17)

A **guest feed** is a video feed someone else sends to Relay over the internet — a remote camera
operator, a guest on a laptop, a phone running Larix — that the production machine pulls into CTD OBS
as a source (the CTD OBS plugin's **CTD Relay Feed** source). Each Relay profile has up to
`maxSlots` guest feed **slots** (default 4, the server's `GUEST_FEEDS_MAX`); each slot has a name and
its own ingest key.

What Relay does with a guest feed, and doesn't:

- It takes the guest's RTMP stream on the same RTMP ingest as OBS's landscape and vertical feeds
  (MediaMTX, the same port, the same key check), under its own path (`guest/<slot>`).
- It passes it on **unchanged** (no transcoding) as Low-Latency HLS to players that hold
  `feeds:watch`, exactly like the live preview of §10.
- It **never restreams** a guest feed to a destination (Twitch, YouTube…) by itself. A guest feed
  reaches the platforms only through OBS's program output, like any other source, or through a
  **route** an admin sets up (§18.8): passthrough to a custom RTMP(S) server, or into a profile as
  its Landscape or Vertical feed.
- H.264 video and AAC audio only, like the main feeds (the codec guard, `problem` below).

Slots are made, renamed and removed, and keys rotated and revoked, by an admin in the web UI
(dashboard → **Extra feeds**, the web UI's name for guest feeds). The external API only **reads** them: there is no route that
returns a guest's ingest key.

### 18.1 The guest feed object

```json
{
  "slot": "q7m2x9k4tb",
  "name": "Remote cam 1",
  "key": "active",
  "online": true,
  "since": "2026-11-24T20:00:01.000Z",
  "video": { "codec": "h264", "width": 1280, "height": 720 },
  "audio": { "codec": "aac", "sampleRate": 48000, "channels": 2 },
  "bitrateKbps": 3480,
  "bitrateWarning": false,
  "problem": null,
  "limitedAt": null
}
```

| Field | Meaning |
|---|---|
| `slot` | The slot's id: 10 characters `[a-z0-9]`, fixed for the slot's life (renaming keeps it), never reused. The `{slot}` in every route below. |
| `name` | Name for people, set in the web UI ("Remote cam 1"). 1–60 characters. |
| `key` | `active`: the slot has an ingest key and accepts a guest. `revoked`: an admin revoked the key; nobody can send until a new key is made (rotating gives a revoked slot a new key). |
| `online` | The guest is sending right now. |
| `since` | When the guest started sending (ISO 8601), `null` while offline. |
| `video`, `audio` | What the guest sends, from the ingest server's track list, like `feeds[]` in `/status` (§4): `codec` (`h264`, `hevc`, `av1`; `aac`, `opus`…), `width`/`height`, `sampleRate`/`channels`. `null` while offline or not known yet; `audio` is `null` when the guest sends no sound. |
| `bitrateKbps` | Inbound bitrate, measured over the last ~2.5 s. `null` while offline. |
| `bitrateWarning` | `true` while `bitrateKbps` is above the server's `warnAboveKbps`: show a warning (the guest should lower their bitrate). Nothing is cut at this level. |
| `problem` | The codec guard's verdict (same shape as `feeds[].problem`, §4), or `null`: `{ "reason": "feed-video-codec", "codec": "hevc", "label": "HEVC", "blocking": true, "message": "Guest feed \"Remote cam 1\" is HEVC. …" }`. `blocking: true`: it can't be watched (`409 feed_codec`); show `message` instead of a player. `blocking: false`: the audio isn't AAC; it plays, players may get no sound. |
| `limitedAt` | When Relay last **disconnected** this guest for sending more than the server's `maxKbps` for 10 s (ISO 8601), kept for 10 minutes, else `null`. See §18.6. |

New fields may be added (ignore what you don't know). A later revision may add a read path over SRT
(§18.7) as a new field.

### 18.2 `GET /api/v1/profiles/{id}/guest-feeds` — `status:read`

The profile's guest feed slots, in the order they were made, and the server's limits.

```json
{
  "profileId": "default",
  "maxSlots": 4,
  "maxViewers": 2,
  "warnAboveKbps": 8000,
  "maxKbps": 20000,
  "guestFeeds": [
    { "slot": "q7m2x9k4tb", "name": "Remote cam 1", "key": "active", "online": true,
      "since": "2026-11-24T20:00:01.000Z",
      "video": { "codec": "h264", "width": 1280, "height": 720 },
      "audio": { "codec": "aac", "sampleRate": 48000, "channels": 2 },
      "bitrateKbps": 3480, "bitrateWarning": false, "problem": null, "limitedAt": null },
    { "slot": "c4n8w1p6zd", "name": "Guest laptop", "key": "active", "online": false,
      "since": null, "video": null, "audio": null, "bitrateKbps": null,
      "bitrateWarning": false, "problem": null, "limitedAt": null }
  ]
}
```

| Field | Meaning |
|---|---|
| `maxSlots` | Most slots per profile (`GUEST_FEEDS_MAX`, default 4). `0`: guest feeds are off on this server (the list is empty and no guest can send). |
| `maxViewers` | Players per guest feed at once (`GUEST_FEED_MAX_VIEWERS`, default 2). `0`: guest feeds can't be watched on this server (`503 live_off`). |
| `warnAboveKbps` | `bitrateWarning` threshold (`GUEST_FEED_WARN_KBPS`, default 8000). |
| `maxKbps` | Hard limit (`GUEST_FEED_MAX_KBPS`, default 20000; `0` = none): a guest above it for 10 s is disconnected. |

Errors: `404 unknown_profile`, `403 profile_forbidden`.

### 18.3 `GET /api/v1/profiles/{id}/guest-feeds/{slot}/live.m3u8` — `feeds:watch`

The guest feed live, as Low-Latency HLS. **It works exactly like a main feed's live preview (§10):**
same scope, same rules, same player set-up. Only the URL differs:

```
GET /api/v1/profiles/{id}/guest-feeds/{slot}/live.m3u8            → opens a player ("viewer"):
                                                                      multivariant playlist
GET /api/v1/profiles/{id}/guest-feeds/{slot}/live/{file}?v=<viewer> → its media playlists and fMP4
                                                                      init/part/segment files
```

- **Auth:** `Authorization: Bearer <token with feeds:watch>` on `live.m3u8` **and on every request
  the player makes**. `?access_token=` is refused here.
- **URIs in the playlists are relative** (`live/<file>?v=<viewer>` in `live.m3u8`, `<file>?v=<viewer>` in
  the media playlists): resolve them against the playlist's URL and request them as given; LL-HLS
  players add `_HLS_msn` / `_HLS_part` / `_HLS_skip`. `{file}` is `[A-Za-z0-9_-]{1,128}.(m3u8|mp4)`.
- **A viewer** only works with the token that opened it, on that profile and slot. It ends 15 s after
  its last request, or when the muxer stops; then requests answer `410 live_ended`: request
  `live.m3u8` again.
- **At most `maxViewers` players per guest feed** (default 2: CTD OBS plus one person watching in the
  web UI). Over it: `429 viewer_cap` with `Retry-After`; a token that opens another player while the
  feed is full replaces its own oldest one.
- **On demand:** the first `live.m3u8` starts muxing (the first answer takes about 2–3 s); it stops
  about 30 s after the last request. A guest feed nobody watches costs nothing beyond its ingest.
- **Passthrough:** H.264 + AAC in fMP4, 200 ms parts, 1 s segments, unchanged from what the guest
  sends (resolution, frame rate, bitrate).
- **Rate limit:** `live.m3u8` counts like any request; `live/{file}` shares the live budget of §10
  (1000 per 10 s per token, for every feed and guest feed the token plays).
- **Errors** (problem+json): `404 unknown_guest_feed` (no such slot on this profile), `404
  feed_offline` (the guest isn't sending, or the key is revoked), `409 feed_codec` (HEVC/AV1:
  `detail` is the guard's message), `429 viewer_cap`, `503 live_off` (`maxViewers` is 0), `503
  unavailable` (retry after `Retry-After`), `410 live_ended` (on `live/{file}`), plus `401`/`403`/`404
  unknown_profile`.
- Headers: `Content-Type: application/vnd.apple.mpegurl` (playlists) or `video/mp4` (parts),
  `Cache-Control: no-store`.

**Latency (v1 target: about 2 s).** An LL-HLS player that follows the parts plays about 1.5–2.5 s
behind the guest's encoder (hls.js: `lowLatencyMode: true, liveSyncDuration: 2`). A player that only
knows plain HLS (whole segments) works too, about 3–4 s behind. FFmpeg's `hls` demuxer (what a media
source built on libavformat uses) is a plain HLS player: pass the header with `-headers
"Authorization: Bearer <token>\r\n"` (it is sent on every playlist and segment request) and start at
the newest segment with `-live_start_index -1`.

```
ffplay -headers $'Authorization: Bearer ctd_pat_…\r\n' -live_start_index -1 \
  "https://<relay host>/api/v1/profiles/default/guest-feeds/q7m2x9k4tb/live.m3u8"
```

### 18.4 `GET /api/v1/profiles/{id}/guest-feeds/{slot}/preview` — `status:read`

A JPEG of the guest feed, like the feed previews of §10: 640 px wide, one keyframe, made on request
and cached 2.5 s; poll every 3–5 s while you show it. `?access_token=` works too.
`404 feed_offline` while the guest isn't sending, `404 unknown_guest_feed`, `503 unavailable` (with
`Retry-After`).

### 18.5 Events

On `/events` and `/events/poll` (§4), `status:read`, `src` = `core` with `src.profile` = the profile:

- **`guest.feed.status`**: `data` = one guest feed object (§18.1). Sent at once when a guest starts
  or stops sending, or its codec, resolution, `problem`, `key` or `name` changes; when only
  `bitrateKbps` (and `bitrateWarning`) change, at most every 2 s.
- **`guest.feeds.changed`**: `data` = the whole list, as `GET /profiles/{id}/guest-feeds` returns
  it. Sent when a slot is added, renamed or removed, or its key rotated or revoked. Replace what you
  hold.

Keep a profile's guest feeds by `slot`: take the list from `GET …/guest-feeds` (open `/events`
first, as in §17.4), replace it on `guest.feeds.changed`, replace one entry on `guest.feed.status`.

**Issues (§17).** Two kinds report a guest feed's problems with the suite's one alert contract,
`subject` = `{ "type": "guest.feed", "slot": "q7m2x9k4tb", "name": "Remote cam 1" }`:

| `kind` | `id` | Severity | Raised when | Cleared when |
|---|---|---|---|---|
| `guest.feed.offline` | `guest.feed.offline\|<slot>` | warning | During a running session (`starting`/`live`), a guest feed that was sending stops and stays stopped **5 s**. Not when an admin removed the slot or rotated or revoked its key (on purpose) | The guest is back (`recovered`), the session ends (`ended`), the slot is removed or its key rotated or revoked (`removed`) |
| `guest.feed.codec` | `guest.feed.codec\|<slot>` | warning | A guest sends video that isn't H.264 (as soon as its tracks are known, session or not) | The guest sends H.264 (`recovered`), stops sending (`ended`), the slot is removed (`removed`) |

A guest feed on program in CTD OBS is the plugin's to report (its `obs.issue`, with `onProgram`):
Relay can't see what is on program.

### 18.6 Sending video (for the people setting it up)

Not part of the API (keys never are), here so the whole flow is in one place. The admin copies a
slot's **ingest details** from the web UI and gives them to the guest:

| | |
|---|---|
| Server | `rtmp://<relay host>:<RTMP port>/guest` |
| Stream key | `<slot>?key=<key>` |
| Full URL (apps with one field, e.g. Larix) | `rtmp://<relay host>:<RTMP port>/guest/<slot>?key=<key>` |

H.264 video, AAC audio, keyframe every 1–2 s, CBR. A slot takes one guest at a time; a new connection
with the same key replaces the old one. Rotating a key disconnects the guest at once (the old key
stops working); revoking it does too and leaves the slot without a key. The web UI's "How a guest
sends video" help covers OBS, Larix and other apps; the operator guide is
[GUEST-FEEDS.md](GUEST-FEEDS.md).

Limits that keep guests from starving the main feeds (measured in GUEST-FEEDS.md): no transcoding or
probing of guest feeds, muxing only while someone watches, `maxViewers` players per guest feed,
`maxSlots` per profile, and the hard `maxKbps` limit — a guest above it for 10 s is disconnected and
`limitedAt` is set (it can reconnect, and is disconnected again if it stays over).

### 18.7 Later: an SRT read path

v1.17 reads guest feeds over LL-HLS (TCP, through Relay's HTTPS port, behind its auth). A later
revision may add an SRT read path for lower latency (under 1 s): MediaMTX can serve each guest path
over SRT, but that needs a **UDP port** forwarded to Relay and its own per-reader credentials, so it
is out of scope now. When it comes it will be additive: a new field on the guest feed object and a
route that hands out a short-lived SRT `streamid`; the LL-HLS routes above stay.

### 18.8 Routes: sending a guest feed on (v1.17, additive)

A **route** sends a guest feed on, **passthrough only** (FFmpeg `-c copy`; never transcoded):

- **`rtmp`**: to a custom RTMP or RTMPS server ("somewhere else"), at most **3** per guest feed.
- **`profile`**: into a profile (its own or another) as that profile's **Landscape** or **Vertical**
  feed, at most **3** per guest feed. Relay republishes the guest into the profile's feed path, so to
  that profile it is exactly a feed from OBS: `feed` events and `feeds[]` in `/status`, the codec
  guard, test mode, destinations, reports and `feed.offline` issues.

A route runs only while its guest sends: started by hand (`POST …/start`), or by itself whenever the
guest sends when `auto` is true ("when the feed is online"). It stops when the guest stops (or the key
is revoked or rotated). Routes are kept with the guest feed; the JSON of §18.1–18.2 is unchanged.

**The route object:**

```json
{ "id": "k3n8p2w7qa", "slot": "q7m2x9k4tb", "profileId": "default", "name": "Club · Landscape",
  "target": { "kind": "profile", "profileId": "club", "profileName": "Club", "feed": "landscape" },
  "auto": true, "active": true, "state": "running", "message": null,
  "since": "2026-11-25T20:00:03.000Z", "bitrateKbps": 3480 }
```

A custom server's `target` is `{ "kind": "rtmp", "host": "rtmps://live.example.com", "hasKey": true }`:
the scheme and host only, never the path or the stream key (both are write-only).

| Field | |
|---|---|
| `id` | `[a-z0-9]{10}`, fixed |
| `slot`, `profileId` | The guest feed it sends, and the profile that owns that guest feed |
| `auto` | Starts by itself whenever the guest sends |
| `active` | Started (by hand or by `auto`) and not stopped since |
| `state` | `idle` (not running), `starting`, `running`, `retrying` (the push failed and is retried with backoff, like a destination), `blocked` (it should run but may not: `message` says why), `failed` (it can't run at all) |
| `message` | Why it is blocked, failed or retrying, or a warning; never holds a key |
| `since`, `bitrateKbps` | While `running` |

**Routes (reading: `status:read`; managing: `system:admin` on a token for every profile):**

| | |
|---|---|
| `GET /profiles/{id}/guest-routes` | `{ profileId, outbound: [route…], inbound: [route… + "guestName"] }`: routes of this profile's guest feeds, and routes into this profile's inputs (a feed card's "Source: extra feed …") |
| `GET /profiles/{id}/guest-feeds/{slot}/routes` | `{ profileId, slot, routes: [route…] }` |
| `POST /profiles/{id}/guest-feeds/{slot}/routes` | `{ "kind": "rtmp", "url": "rtmps://live.example.com/app", "streamKey": "…", "auto": false, "name"?: "…" }` or `{ "kind": "profile", "profileId": "club", "feed": "landscape", "auto": true }` → `201` route |
| `PATCH …/routes/{route}` | `{ name?, auto?, url?, streamKey? }` (`streamKey`: omitted = keep, `""`/`null` = clear); the server and key only while stopped (`409 route_active`) |
| `DELETE …/routes/{route}` | `204` |
| `POST …/routes/{route}/start`, `…/stop` | → route |

**Custom servers.** `rtmp://` or `rtmps://` only (no `file:`, `pipe:`, `srt:`…), no user or password
in the URL. Refused (`400 invalid_target`): loopback, `localhost`, link-local (`169.254.0.0/16`,
`fe80::/10`), unspecified and multicast addresses, and this Relay's own RTMP port (a route can't feed
Relay back into itself). Private LAN hosts (RFC 1918, CGNAT, IPv6 ULA) are allowed unless the owner
turns them off (web UI setting, `PUT /api/guest-routes/settings {"allowLan": false}`). Host names are
resolved when the route is saved and again when it starts.

**Profile inputs: the guards.**

- `409 input_busy` on start while OBS's own feed is on that input, or another route holds it. Relay
  never replaces OBS's feed. If OBS starts sending that input while a route holds it, OBS gets it and
  the route stops (`state` `blocked`, with the reason).
- `409 session_live`: a profile route can't be started, stopped or removed by hand while the target
  profile's session is `starting`, `live` or `stopping` (that would cut every destination). The guest
  stopping still stops it: the profile's feed then goes offline exactly as if OBS stopped
  (`feed.offline` while live). No automatic switching.
- A route **never starts a profile's Go live**: auto go-live ignores routed inputs.
- `409 feed_offline` on start while the guest isn't sending. Other errors: `404 unknown_route`,
  `unknown_guest_feed`, `unknown_profile`; `409 limit`, `409 exists` (this guest already feeds that
  input).

### 18.9 Pull links: an RTMP address for OBS Media Source / VLC (v1.17, additive)

A guest feed, and each of a profile's own two feeds, can have a pull link: a read key of its own and
the address `rtmp://<host>:<rtmpPort>/<path>?key=<read key>`, played straight from Relay's MediaMTX
on the RTMP ingest port. Off by default. The read key only reads; the ingest key never reads. At most
`maxReaders` players per feed (`PULL_LINK_MAX_READERS`, default 2; 0 = off). Passthrough only. See
docs/GUEST-FEEDS.md → Pull link.

| Method and path | Scope | What |
| --- | --- | --- |
| `GET /api/v1/profiles/{id}/pull-links` | `status:read` | `{ profileId, maxReaders, guestFeeds: { <slot>: State }, feeds: { landscape: State, vertical: State } }`; State = `{ enabled, readers, maxReaders }`. Never a key. |
| `GET …/guest-feeds/{slot}/pull`, `GET …/feeds/{feed}/pull` | `system:admin` | `State` + `url` (the link with the key; null while off) + `serverUrl` (without the key). `Cache-Control: no-store`. |
| `PUT` same, body `{ "enabled": true\|false }` | `system:admin` | On: a new read key (kept if already on). Off: no key; current readers are disconnected. → the same object. |
| `DELETE` same | `system:admin` | Revoke (= off). `204`. |
| `POST` same + `/rotate` | `system:admin` | A new read key (turns it on); the old link stops working and its readers are disconnected. → the same object. |

`system:admin` must be a token not limited to one profile (`403 profile_forbidden`). Errors:
`404 unknown_profile | unknown_guest_feed | not_found` (a feed other than landscape/vertical),
`409 limit` (pull links off on this server), `503 unavailable`. Every change is audited
(`pull.enable`, `pull.disable`, `pull.revoke`, `pull.rotate`) without the key. Readers are counted
from MediaMTX's connection list once a second; Relay's own readers are not counted.

**SRT (additive):** the admin objects also carry `srtUrl`, the same pull link over SRT
(`srt://<host>:<srtPort>?streamid=read:<path>:key=<read key>&latency=500000`; null while off or when
SRT is off), and `srt` (the SRT status, as in `/ingest`). For an OBS Media Source: untick Local File,
paste the link into Input, set Input Format to `mpegts`. The same read key, cap, rotate and revoke
apply, and SRT readers count against the same `maxReaders`. See docs/SRT.md.

## Changelog

`apiVersion` stays `1`: every change below is additive, so clients written for an earlier v1
keep working (ignore event types and fields you don't know). `GET /api/v1/openapi.json` reports
the revision in `info.version`.

### v1.18

- **SRT (docs/SRT.md, additive):** MediaMTX's SRT listener on one UDP port (`SRT_PORT`, default 8890;
  0 = off) for ingest and pull links, with the same keys and rules as RTMP.
  - `GET /profiles/{id}/ingest` feeds gain `srtUrl`, and the object gains `srt` (SrtStatus).
  - Guest feed ingest details (admin) gain `srtUrl` + `srt`.
  - Pull link admin objects gain `srtUrl` + `srt`.

### v1.17

- **Guest feeds (§18):** remote video into CTD OBS. Per profile up to `GUEST_FEEDS_MAX` (default
  4) guest feed slots, each with a name and its own ingest key, managed in the web UI. Read-only
  routes: `GET /profiles/{id}/guest-feeds` and `…/guest-feeds/{slot}/preview` (`status:read`),
  `…/guest-feeds/{slot}/live.m3u8` and `…/live/{file}` (`feeds:watch`, LL-HLS passthrough like the
  live preview). Events `guest.feed.status` and `guest.feeds.changed` (`status:read`); issue kinds
  `guest.feed.offline` and `guest.feed.codec` with subject type `guest.feed` (§17). New problem code
  `unknown_guest_feed` (404). Guest feeds are never restreamed to destinations by themselves.
- **Guest feed routes (§18.8, additive):** send a guest feed on, passthrough only, to a custom
  RTMP(S) server or into a profile as its Landscape or Vertical feed (then treated exactly like OBS's
  feed). `GET /profiles/{id}/guest-routes` and `…/guest-feeds/{slot}/routes` (`status:read`, no keys);
  `POST …/routes`, `PATCH`/`DELETE …/routes/{route}`, `POST …/{route}/start|stop` (`system:admin`).
  Problem codes `unknown_route`, `invalid_target`, `input_busy`, `session_live`, `route_active`,
  `exists`. The guest feed objects and lists are unchanged.

- **Pull links (§18.9, additive):** a per-feed read key and an RTMP address for an OBS Media Source
  or VLC (guest feeds and a profile's own feeds), off by default. `GET /profiles/{id}/pull-links`
  (`status:read`, no keys); `GET|PUT|DELETE …/guest-feeds/{slot}/pull` and `…/feeds/{feed}/pull`,
  `POST …/pull/rotate` (`system:admin`). Env `PULL_LINK_MAX_READERS` (default 2).
### v1.16

- **Issues (§17):** one alert contract for the suite. `issue.raised` / `issue.cleared`
  (`status:read`): Relay raises `feed.offline`, `destination.down` and `stream.down` from its own
  feeds and destinations, `obs.output.down` from OBS outputs, and `obs.issue` from the plugin's
  `obs.issue.*`, with a stable `id`, `severity`, `subject`, hold times, and a `resolution` on clear.
  `GET /status` carries `issues` (open issues). `obs.issue.raised` may carry `onProgram` and
  `scene`; new OBS event type `obs.failover` (§10, §17.6).

### v1.15

- **Overlay summaries (§9.5):** `PUT /apps/{appId}/summary` (`apps:write`, the registering token)
  and `GET /profiles/{id}/overlay-summary` (`apps:read`): an overlay server's version, its
  templates' installed and latest versions, update kind (patch / minor / major), overlays waiting
  for a major upgrade and trimmed release notes, for the CTD OBS plugin's CTD Overlays dock. In
  memory; unknown fields are dropped. No new scope: paired apps that hold `apps:read` (the CTD
  OBS plugin) and `apps:write` (CTD Overlay) use it as they are.

### v1.14

- **Live preview (§10):** `GET /profiles/{id}/feeds/{feed}/live.m3u8` and `…/live/{file}`: the feed as
  Low-Latency HLS (~1–3 s, passthrough, no transcoding), with the new scope **`feeds:watch`** in the
  `Authorization` header only (`status:read` is not enough). New problem codes `feed_codec` (409, HEVC/AV1 feed), `viewer_cap` (429), `live_off` (503) and
  `live_ended` (410).
- The JPEG preview (`/profiles/{id}/previews/{feed}`) is now cached 2.5 s instead of 5 s.

### v1.13

- **Stream reports (§16):** a new scope, `reports:read`, and `GET /reports/sessions`,
  `/reports/sessions/{id}`, `/reports/sessions/{id}/export`, `/reports/summary`,
  `/reports/export` and `/reports/audience`, `/reports/audience/users/{userId}`. Exports are
  `.xlsx` (default), CSV in a .zip, or JSON. Pairing can ask for `reports:read`; the approve form
  shows it as sensitive.
- **Twitch:** connecting (or reconnecting) a Twitch account also asks for
  `moderator:read:chatters`, for reports' watch time. Accounts connected earlier keep working
  without it; their reports have no watch time until they reconnect.

### v1.12

- **Feed codec guard:** `destinations[].blocked`, `feeds[].problem` and `kind` / `subject` / `codec`
  on `system.notice` (§4, §5). A feed that is online but HEVC or AV1 no longer leaves its
  destinations in `retrying` with FFmpeg's "Invalid argument": they are `waiting-for-feed` with
  `blocked` set and a `message` that says what to change in OBS, and they start by themselves when
  the feed is H.264. No new `phase` value and no new event type.
- **Instagram selector pack (§15):** three more optional settings in a pack override:
  `timing.backlogAsHistory` and `timing.liveStartGraceMs` (comments already on screen when the
  reader first gets to read them are history, not delivered, unless the live is younger than the
  grace), and `container.climbPreferRows`. The built-in pack is `builtin-3` (`builtinVersion`).
  The debug capture's `reader` has `backlog`. An override stored on v1.11 is still accepted.
  `classify.join` patterns may capture the number of others in group 1 (the built-in ones do).
- **Joins with others** (`chat.message`): a new field, `othersCount`. On a `join` line that names
  one user and a number of others (Instagram's "dj_fan and 3 others joined"), `user.name` is the
  named user and `othersCount` the number (`3`); `null` otherwise. A chat box that counts people
  joining adds `othersCount + 1` for such a line.
- **Instagram comments** (`chat.message` from `instagram`): when the reader starts during a live,
  or a changed pack makes the comments readable, the comments on screen are no longer delivered
  all at once. A presence line that is one piece of text with no avatar or link ("dj_fan joined
  the live") is a `join` event by `dj_fan`, no longer a comment. Apps that read the chat need no
  change; `othersCount` is there for those that want it.

### v1.11

- **Operator tools for the Instagram chat reader (§15):** a new scope, `system:admin`, and four
  routes: `GET` / `PUT` / `DELETE /platforms/instagram/chat/selector-pack` (the reader's selectors
  and patterns as a JSON pack that can be replaced while a live runs) and
  `POST /platforms/instagram/chat/debug` (a sanitised capture of what the reader sees). The scope
  is only for tokens created in Settings → API for every profile; pairing never grants it.
- **Instagram comments** (`chat.message` from `instagram`): a re-rendered or re-mounted comment
  list, a tab switch and a page reload no longer deliver comments twice; pinned copies and
  Instagram's own notices are no longer delivered; "and 3 others joined" lines are `join` events.
  When the page exposes a comment id (a pack setting), `platformMessageId` carries it. No change to
  the shape of any event.

### v1.10

- **Transcoding capabilities:** `GET /system/transcode-capabilities` (`status:read`): which video
  encoders (H.264, HEVC, AV1; hardware and software) work on the Relay machine, from a test encode
  at startup. Read-only groundwork for per-destination transcoding (docs/TRANSCODING.md).
- **Overlay scenes:** an overlay resource may list its scenes in `meta.scenes`
  (`[{ "id", "name", "url" }]`, single-scene browser-source URLs; §9.2). Relay validates them
  (`http(s)` URLs, ≤ 50 scenes, ≤ 16 KB, outside the 4 KB `meta` limit) and returns `meta` as sent in
  `GET /apps`, `GET /profiles/{id}/overlays` and `apps.changed`. Earlier revisions also passed
  `meta.scenes` through, but unchecked and inside the 4 KB limit.

### v1.9

- **Show profiles (§14):** a profile's OBS set-up saved as numbered revisions with content-addressed
  bundles and assets. New scopes `show:read`, `show:write`, `show:secrets`. New routes
  `GET /profiles/{id}/show`, `…/show/revisions`, `…/show/revisions/{rev}` (+ `/bundle`, `/secrets`),
  `POST …/show/revisions`, `POST /blobs/check`, `PUT`/`GET /blobs/{sha256}` and `GET /library`.
  `GET /profiles` items gain `show`. New events `show.changed` and `library.changed`. New problem
  codes `revision_conflict`, `missing_blobs`, `hash_mismatch`, `quota_exceeded`.
- **Pairing again (§9.3, no new fields):** a newer token registering the same app id with the same
  `kind` and `name` (and a token covering the old one's profile) takes the id over even while the
  old entry looks online (was `409 app_owned`),
  removes that app's offline entries under renewed ids, and supersedes the old token (revoked after
  3 minutes unless still used).

### v1.8

- **Spotify (§13):** `GET /music` and the `music.nowplaying` event (`status:read`): what the
  profile's Spotify plays. `music.request` (`chat:read`): chat `!sr` song requests, queued or
  refused. Relay's answers also appear as `chat.message` event lines.

### v1.7

- **Twitch follows:** `alert.follow` is now sent for Twitch follows (EventSub `channel.follow`),
  with a `chat.message` event line `"<name> followed"` right before it. Twitch accounts connected
  earlier need one reconnect in Accounts to allow it (`moderator:read:followers`).

### v1.6

- **OBS socket relay (§12):** new scope `obs:control`; `GET /obs/socket` relays obs-websocket 5 to
  OBS on the LAN, so CTD Live mobile controls OBS (scenes, multiview previews, outputs) from
  anywhere. QR-connected phones get `obs:control` (`POST /connect/claim`).
  `PUT /apps/{appId}/obs-websocket` (`obs:write`): the CTD OBS plugin reports OBS's WebSocket port,
  password and LAN address, so nobody types them.
- **Re-paired apps keep their id:** `PUT /apps/{id}` takes over an id whose token was revoked, or
  whose app is offline when the new token is newer and the app is of the same `kind` (instead of
  `409 app_owned`).
- `obs.scene` may carry `scenes: [{name, uuid}]` (the canvas's scene list); `GET /profiles/{id}/obs`
  keeps it per canvas in `scenes[].scenes`, and a changed list is re-emitted on `/events`.

### v1.5

- **Connect a phone (§11):** QR code in Settings → API (`ctdrelay://connect?…`) and
  `POST /connect/claim` → a read-only token for CTD Live mobile, over the LAN or mobile data.
- `obs.scene` carries `sceneUuid`, `previous` and `atMs` and is re-emitted on a scene (name or uuid)
  change; new `obs.sync.status`; `GET /profiles/{id}/obs` adds `scenes[].sceneUuid/atMs` and `sync`.
- `obs.issue.raised` / `obs.issue.cleared` (open issues in `GET /profiles/{id}/obs` → `issues`).

### v1.4

- **OBS events (§10):** new scope `obs:write`; `POST /apps/{appId}/events` (the CTD OBS plugin sends
  `obs.feed.state`, `obs.feed.stats`, `obs.output`, `obs.scene`, `obs.issue.raised` / `obs.issue.cleared`), re-emitted on `/events`
  (`status:read`, `src.platform: "obs"`), latest state at `GET /profiles/{id}/obs`.
- **Feed previews (§10):** `GET /profiles/{id}/previews/landscape|vertical` → JPEG (also with
  `?access_token=`).
- New problem codes `feed_offline` and `unavailable`.
- `GET /api/v1/` also reports `build` (`{ commit, date }`) and `apiRevision`.

### v1.3

- **Timecode clock (§4, `GET /clock`):** the server's clock as a shared timecode reference so apps
  on other machines (LAN or internet) line up on the same time code: NTP-style timestamps
  (`t0` / `receivedAt` / `sentAt`), session run time, and `HH:MM:SS:FF` run / UTC / local timecodes
  at the feed's frame rate.
- `destination.down` / `destination.up`: a retry stays down until the destination is live again
  (no down → up → down flapping while a platform keeps refusing).
- **Total viewers:** `session.viewers` in `/status` and on `stream.status` (sent when the total
  changes) = viewers across every platform added up.
- **Joins:** `chat.message` gets `join` — `true` on "<name> joined" presence lines (Instagram,
  TikTok) so chat boxes can keep them apart from comments.

### v1.2

- **Profiles (§9.1):** several independent streaming set-ups that can be live at once.
  `GET /profiles`, `GET /profiles/{id}`, `GET /profiles/{id}/ingest` (new scope `ingest:read`),
  `profile.status` / `profiles.changed` events, `src.profile` on every envelope, tokens optionally
  limited to one profile, `?profile=` on `/status`, `/chat`, `/events`, `/events/poll`, and
  `?profile=*` (or `all`) on `/events` / `/events/poll` for every profile at once. Existing tokens
  and clients keep their behaviour: without `?profile=`, `/status`, `/chat`, `/events` and
  `/events/poll` read the default profile.
- **Hub (§9.2):** apps register themselves and their resources (`PUT /apps/{id}`, new scopes
  `apps:read` / `apps:write`), `GET /apps`, `GET /profiles/{id}/overlays`, app-to-app messages
  (`POST /messages`, `app.message` events), `apps.changed` events.
- **Pairing (§9.3):** `POST /pairing` + `POST /pairing/{id}/token`, approved in Settings → API;
  pending requests limited per address and for peers outside the LAN.
- **Write methods** (`PUT`, `POST`, `DELETE`, JSON bodies) for the hub and pairing, allowed by the
  CORS preflight. New problem codes: `unknown_profile`, `profile_forbidden`, `app_owned`, `limit`,
  `denied`, `expired`.
- The OBS dock shows one profile (the token's, or `&profile=<id>` in its link).

### v1.1

- **Alerts:** `alert.<kind>` events (`subscription`, `gift`, `cheer`, `raid`, `membership`,
  `superchat`; `follow`, `kicks`, `tip` reserved) under the `chat:read` scope, sent after the
  `chat.message` event line that carries them (§5). Money is a decimal string + ISO 4217 currency.
- **Viewers:** `destinations[].viewers` (and the `platforms[].viewers` sum of known counts) are now
  filled for Twitch, Kick, YouTube, Facebook Page, Instagram and TikTok.
- **Test mode:** `session.testMode` is live: the dashboard switch streams privately where the
  platform allows it and skips the rest (`phase: "disabled"`, "Skipped — … has no test mode").
- **Chat details** for Twitch, YouTube, Kick and Facebook Page: real platform user ids
  (`user.id` = `<platform>:<id>`), `user.login`, `platformMessageId`; Twitch emote and Kick
  emote-code `emote` fragments, Twitch `cheermote` fragments (with `amount`); `action` for `/me`;
  `chat.message.deleted`, `chat.user.cleared` and `chat.cleared` from Twitch, YouTube and Kick.

### v1.0

First release: tokens and scopes, `/status`, `/chat`, `/events` (SSE) and `/events/poll`, `chat.*`,
`stream.status`, `feed.status`, `destination.*` and `system.*` events, the OBS dock.
