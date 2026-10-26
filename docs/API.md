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
| `status:read` | `GET /status`, `GET /profiles`, `stream.*`, `feed.*`, `destination.*`, `profile.status`, `profiles.changed`, `system.notice` events |
| `ingest:read` | `GET /profiles/{id}/ingest`: OBS server URL and **stream keys** (only for apps that configure OBS) |
| `apps:read` | `GET /apps`, `GET /profiles/{id}/overlays`, `apps.changed` and `app.message` events |
| `apps:write` | `PUT`/`DELETE /apps/{id}`, `POST /apps/{id}/heartbeat`, `POST /messages` |
| `obs:write` | `POST /apps/{id}/events`: OBS events into the hub (the CTD OBS plugin; v1.4, §10) |
| `obs:control` | `GET /obs/socket`: control OBS through Relay's OBS socket relay (CTD Live mobile; v1.6, §12) |

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
| 409 | `app_owned` | The app id was registered by another token (that token is revoked, or its app is offline and yours is newer and of the same kind: `PUT /apps/{id}` takes the id over, v1.6) |
| 409 | `limit` | Too many apps registered (100 in all, 20 per token) |
| 403 / 410 | `denied` / `expired` | Pairing poll: denied by the admin / expired, collected or unknown (§9.3) |
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
  ]
}
```

- `session.viewers` (v1.3): **total viewers across every platform** of the profile — the sum of the
  destinations whose count is known (`null` when none is). It rides on `stream.status`, which is
  sent whenever the total changes, so an overlay's "watching now" counter needs only that event.
  Per platform: `platforms[].viewers`; per destination: `destinations[].viewers`.
- `phase`: `idle`, `disabled`, `waiting-for-feed`, `preparing`, `connecting`, `confirming`, `live`,
  `retrying`, `recovering`, `ending`, `error`. `live` = phase is `live`.
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
| `alert.follow`, `alert.kicks`, `alert.tip` | Reserved for the CTD Overlay kinds; no chat source sends them yet | — |

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

### `profile.status`, `profiles.changed` — `status:read`
A profile's summary changed / profiles were created, renamed or deleted (§9.1).

### `apps.changed`, `app.message` — `apps:read`
Connected apps changed / a message from another app (§9.2).

### `system.reset`
`data: {}` — events you would have received after your cursor are no longer buffered (or the
cursor is from before a restart); refetch `/status` and `/chat`.

## 6. Not in v1 (yet)

- Changing the stream (sending chat, changing the title, going live, test mode). The web UI does
  that; apps only write to the hub (§9.2).
- Follows, Kick KICKs and tips as alerts (`alert.follow`, `alert.kicks` and `alert.tip` are
  reserved: no chat source sends them yet).
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
(red when down, with the reason), viewers, and the merged chat. The token stays in the URL
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
  "serverUrl": "rtmp://192.168.1.50:1936/live",
  "feeds": [
    { "feed": "landscape", "streamKey": "dprtmnt/landscape?key=Xb3…", "fullUrl": "rtmp://192.168.1.50:1936/live/dprtmnt/landscape?key=Xb3…" },
    { "feed": "vertical",  "streamKey": "dprtmnt/vertical?key=Q9k…",  "fullUrl": "rtmp://192.168.1.50:1936/live/dprtmnt/vertical?key=Q9k…" }
  ] }
```
The default profile keeps its pre-profiles keys (`landscape?key=…`). `serverUrl` uses the RTMP
port and the LAN address: the OBS host set in Settings (the one the web UI's OBS setup shows) when
there is one, else `LAN_HTTP_HOST`, else the host the app called the API with. **Stream keys are
secrets**: grant `ingest:read` only to apps that configure OBS (responses carry
`Cache-Control: no-store`).
Each profile needs its own OBS output: two OBS (or two outputs) can stream two profiles at once.

### 9.2 Connected apps (the hub)

Apps register themselves and what they offer so other apps can find them through CTD Relay
instead of being configured with each other's addresses. Example: CTD Overlay registers its
overlays with the profile each is assigned to; the CTD OBS plugin, connected only to CTD
Relay, lists the overlays for its profile and adds them as browser sources.

#### `PUT /api/v1/apps/{appId}` — `apps:write`
Register or update this app; call again at least every 60 s as a heartbeat (or
`POST /api/v1/apps/{appId}/heartbeat`). `appId`: `[a-z0-9-]`, ≤ 40, unique; only the token that
first registered an id may update or delete it (`409 app_owned`).
```json
{ "name": "CTD Overlay", "kind": "ctd-overlay", "version": "1.4.0",
  "baseUrl": "http://192.168.1.50:30200",
  "capabilities": ["overlays", "overlay.create"],
  "resources": [
    { "type": "overlay", "id": "ovl_h", "name": "DPRTMNT takeover — landscape", "profileId": "6f1d…",
      "url": "http://192.168.1.50:30200/o/takeover-h?key=…", "width": 1920, "height": 1080 },
    { "type": "overlay", "id": "ovl_v", "name": "DPRTMNT takeover — vertical", "profileId": "6f1d…",
      "url": "http://192.168.1.50:30200/o/takeover-v?key=…", "width": 1080, "height": 1920 }
  ] }
```
Response: `200` with the `ConnectedApp` (below). Limits: 200 resources, `meta` ≤ 4 KB each, body
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

#### `GET /api/v1/apps?profile=<id>` — `apps:read`
```json
{ "items": [
  { "id": "ctd-overlay", "name": "CTD Overlay", "kind": "ctd-overlay", "version": "1.4.0",
    "baseUrl": "http://192.168.1.50:30200", "capabilities": ["overlays", "overlay.create"],
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
  "url": "http://192.168.1.50:30200/o/takeover-h?key=…", "width": 1920, "height": 1080,
  "meta": { "canvas": "landscape", "slot": "takeover-landscape" } } ] }
```
`url`, `width`, `height` and `meta` are left out when the app didn't send them.

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
   "approveUrl": "https://192.168.1.50:30443/settings?tab=api&pair=…" }`.
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

Requests expire after 10 minutes, and an approved token must be collected within 10 minutes of the
approval (otherwise it is revoked). `410 expired` also answers an unknown `pairingId`, a wrong
`pollSecret`, a second collection, and a token an admin revoked before the app collected it; requests live in memory, so after a server restart the app
gets `410` and simply starts over. Store the token: it never expires (until revoked in
Settings → API).

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
| `obs.issue.raised` | `{ id: "<rule>\|<subject>", rule, severity: info \| warning \| critical, source, path?, title, cause?, firstSeen }` | an open issue, until cleared |
| `obs.issue.cleared` | `{ id, rule? }` | removes the open issue |

Issue rules from the plugin so far: `camera-offline`, `upstream-loss`, `upstream-slow`,
`bitrate-collapsed`, `frequent-snaps`, `av-drift`, `audio-rate`, `audio-missing` — raised after a
hold time, cleared 10 s after the condition ends (low volume); show `title` to people.

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
vertical one from Aitum Vertical). 640 px wide, one keyframe, made on request and cached 5 s, so
poll every 3–5 s while showing it. `?access_token=<token>` works too, for image loaders that can't
set headers. Headers: `Content-Type: image/jpeg`, `Cache-Control: no-store`, `X-Preview-At` (when
the frame was taken). `404 feed_offline` while OBS isn't sending that feed; `503 unavailable` (with
`Retry-After`) when a frame couldn't be taken — retry.

### Typical set-up: CTD Live mobile

Connect with the QR code (§11) → `GET /profiles` → per profile: `/events?profile=<id>` for
`stream.status` (live, total viewers), `destination.down/up`, `obs.*` and chat → `GET
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
- The share counts only while the app that made it is registered. `DELETE /apps/{appId}` (the
  plugin disconnecting) drops it, password included.
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

## Changelog

`apiVersion` stays `1`: every change below is additive, so clients written for an earlier v1
keep working (ignore event types and fields you don't know). `GET /api/v1/openapi.json` reports
the revision in `info.version`.

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
