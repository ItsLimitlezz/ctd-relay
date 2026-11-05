# CTD Relay API: quick start (for CTD Overlay and other apps)

Full reference: [API.md](API.md). Everything below is JSON over HTTP.

## Connect

| Where | Base URL |
|---|---|
| Same LAN / same NAS | `http://10.20.30.40:30080/api/v1` (plain HTTP, LAN clients only) |
| HTTPS | `https://10.20.30.40:30443/api/v1` |

Every request: `Authorization: Bearer ctd_pat_…`

**Get a token**, either way:
- **Manual:** in CTD Relay, go to **Settings → API → New token**, pick scopes (and a profile), and copy the secret. It is shown once.
- **Pairing** (v1.2, no copying):
  1. Your app sends `POST /pairing` with `{ "appName": "CTD Overlay", "kind": "ctd-overlay", "scopes": ["status:read","chat:read","apps:read","apps:write"], "profileId": null }`. It gets back `{ pairingId, pollSecret, code, approveUrl, interval }`.
  2. Your app shows `code`; the user approves it in **Settings → API**.
  3. Every `interval` seconds, poll `POST /pairing/{pairingId}/token` with `{ "pollSecret": "…" }`. The token arrives once.

**Scopes:**
- `chat:read`: chat and alerts.
- `status:read`: streams, profiles.
- `ingest:read`: OBS keys.
- `apps:read` / `apps:write`: the hub.
- `obs:write`: send OBS events (the CTD OBS plugin only).

## Read

| Call | Returns |
|---|---|
| `GET /status?profile=<id>` | session (live/offline, title, testMode), feeds (bitrate), destinations (`phase`, `live`, `down` + `message`, `viewers`), `platforms[]` |
| `GET /chat?profile=<id>&limit=200&after=<id>` | recent chat, oldest first: `{ items, next }` |
| `GET /events?profile=<id>&types=chat.*,alert.*` | live stream (SSE), resumable with `Last-Event-ID` |
| `GET /events/poll?profile=<id>&after=<id>` | the same events by polling: `{ items, next, reset }` |
| `GET /profiles` | profiles with live status (v1.2) |
| `GET /profiles/<id>/obs` | latest OBS state (sources, outputs, scenes) from the CTD OBS plugin (v1.4) |
| `GET /profiles/<id>/previews/landscape` (or `vertical`) | JPEG preview of the feed, 640 px, poll every 3–5 s; `?access_token=` works for image loaders (v1.4) |
| `GET /clock?profile=<id>&t0=<your epoch ms>` | shared timecode clock (v1.3): server time for NTP-style sync, `timecode.run` / `utc` / `local` as `HH:MM:SS:FF` (see API.md §4) |

A token limited to one profile only ever sees that profile; you don't need `?profile=` with it.

**Every event looks like this:**
```json
{ "id": "01JA…", "type": "chat.message", "ts": 1791830000123,
  "src": { "connector": "ctd-multi-stream", "connection": "<destinationId>", "platform": "twitch", "profile": "<profileId>" },
  "data": { … } }
```

**Event types:**
- `chat.message`: `data` = `{ id, platform, channel, user { id, login, name, color, avatar, badges, roles }, text, fragments, action, kind, join, ts }`. `join: true` = a "<name> joined" line (Instagram, TikTok), not a comment.
- `stream.status`: the session, including `viewers` = **total viewers across all platforms** (v1.3; sent whenever it changes).
- `chat.message.deleted` / `chat.user.cleared` / `chat.cleared`: remove the matching messages.
- `alert.<kind>`: subscription, gift, cheer, raid, membership, superchat. Money is `{ unit: "currency", value: "5.00", currency: "USD" }`.
- `stream.status`, `destination.status`, `destination.down` / `destination.up`, `feed.status`, `system.notice`.
- `profile.status` and `profiles.changed` (v1.2).
- `system.reset`: refetch `/status` and `/chat`.

## Hub (v1.2): register your overlays

Re-send this at least every 60 s as a heartbeat:
```http
PUT /apps/ctd-overlay-dprtmnt
{ "name": "CTD Overlay", "kind": "ctd-overlay", "version": "1.0.0",
  "baseUrl": "http://10.20.30.40:4850", "capabilities": ["overlays", "overlay.create"],
  "resources": [
    { "type": "overlay", "id": "ovl_h", "name": "Takeover — landscape", "profileId": "<profileId>",
      "url": "http://10.20.30.40:4850/o/takeover-h?key=…", "width": 1920, "height": 1080,
      "meta": { "canvas": "landscape", "slot": "takeover-landscape", "transparent": true } } ] }
```
- Use one app id per connection: `ctd-overlay-<profile slug>`, or `ctd-overlay` for a token that covers every profile.
- `meta.canvas`: `landscape` or `vertical`.
- `meta.slot`: the same value for the same overlay role in every profile.

**Messages from other apps** (e.g. the OBS plugin) arrive on `/events` as `app.message`:
```json
{ "id": "01JB…", "from": "ctd-obs-plugin-studio", "to": "ctd-overlay-dprtmnt", "type": "overlay.create",
  "profileId": "<profileId>", "replyTo": null, "data": { "template": "takeover", "canvas": "vertical" } }
```
Reply with `POST /messages`:
```json
{ "to": "<from>", "type": "overlay.created", "profileId": "<profileId>", "replyTo": "<id>",
  "data": { "ok": true, "resource": { … } } }
```
Always reply, including refusals (`{ "ok": false, "reason": "…" }`).

## Errors and limits

- Errors are `application/problem+json`: `{ title, status, detail, code }`. `401` means a bad token, `403 missing_scope` means the token lacks a scope, `429` means slow down (honour `Retry-After`).
- Limits: 600 requests/min, 5 event streams per token, 120 messages/min.

> **Status:** v1.3 is live on the NAS. v1.4 (OBS events, previews) ships with the next update.
