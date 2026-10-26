# CTD Live mobile × CTD Relay — integration brief

For the CTD Live mobile team (iOS `CTDLiveMobile/` + `Packages/CTDLiveCore`, and the Android app).
Relay side: API revision **1.6**. Full API reference: [`docs/API.md`](API.md) (§11 QR connect, §12 OBS socket).

## Goal

Scan one QR code in CTD Relay and control OBS from the phone **from anywhere**: the same Wi-Fi or
**mobile data**, with the deck, PGM/PVW, scene tiles and **live multiview previews** working exactly
as they do on the LAN today.

- OBS's WebSocket port is never exposed to the internet, and **OBS's password never reaches the
  phone**. The phone signs in to Relay with its own revocable token; Relay holds the OBS password
  and relays the session to OBS on the LAN.
- Relay speaks **obs-websocket 5 unchanged** on the relayed socket, so `OBSWebSocketClient`,
  requests, batches, events and `GetSourceScreenshot` previews need no protocol changes. Only *how
  you open the socket* changes: a different URL, a bearer header, and no OBS password.

```
 phone ──(Wi-Fi or mobile data)──▶ wss://<relay public address>/api/v1/obs/socket   Authorization: Bearer ctd_pat_…
                                    │  CTD Relay (TrueNAS): checks the token, opens OBS with OBS's password
                                    ▼
                                   ws://<OBS PC on the LAN>:4455   (obs-websocket 5, as today)
```

## Why scanning fails today

`MobileQRScanSheet` only accepts `OBSConnectURL.parse` (`obsws://`, `ws://`, `wss://`). Relay's
QR code is `ctdrelay://connect?…`, so the scanner shows "That QR isn't an OBS connect code" and
keeps scanning.

## What the app needs to implement

1. **Scanner:** also accept `ctdrelay://connect?…` (parse below) next to the OBS codes, and update
   the hint text: "Scan the OBS connect code, or the code in CTD Relay → Settings → API → Connect a
   phone". Optionally register the `ctdrelay` URL scheme (`CFBundleURLTypes`) so the system
   Camera app can open it too.
2. **Claim:** exchange the one-time code for a token (`POST /connect/claim`), and store the token in
   the Keychain (Keystore on Android).
3. **A new connection kind, "CTD Relay"**, saved next to the OBS-direct profiles. It holds the
   server name, `api` URL, optional `lan` URL, optional `fp` fingerprint, `profileId`, and the
   token's Keychain reference.
4. **OBS over Relay:** open the OBS client on `…/api/v1/obs/socket` with the bearer header (no OBS
   password, no OBS host or port), with LAN-first then public fallback, and reconnect on network
   changes.
5. **Error display:** show Relay's close reasons (table below). Each one tells the user what to fix.
6. **Previews on mobile data:** the same `GetSourceScreenshot` loop, made adaptive (§ Live previews).
7. *(Optional, later)* Relay screens: live status, total viewers, destinations, chat, and the
   program feed previews (§ Relay extras).

---

## 1. The QR code

```
ctdrelay://connect?v=1&api=https%3A%2F%2F203.0.113.7%2Fapi%2Fv1&lan=http%3A%2F%2F192.168.1.20%3A30080%2Fapi%2Fv1&fp=AB%3ACD%3A…&code=ctd_pat_…
```

| Param | Required | Meaning |
|---|---|---|
| `v` | yes | Format version. Accept `1`. For a higher number, say "Update CTD Live mobile to use this code". |
| `api` | yes | Public API base, always `https://…/api/v1`. Used on mobile data, and anywhere when `lan` fails. |
| `lan` | no | LAN API base, often plain `http://<NAS-IP>:30080/api/v1`. Faster on the same Wi-Fi. |
| `fp` | no | SHA-256 fingerprint of the certificate on `api` (`AB:CD:…`, uppercase hex with colons). Only for self-signed setups (§ TLS). |
| `code` | yes | One-time secret, valid **5 minutes**, usable **once**. Treat it like a password: never log it. |

Parse with `URLComponents`. Scheme `ctdrelay`, host `connect`. Reject an `api` that isn't `https`.
`lan` may be `http` or `https`.

## 2. Claim the token

```http
POST {api}/connect/claim            (try {lan} first when on Wi-Fi; no token yet)
Content-Type: application/json

{ "code": "<code from the QR>", "deviceName": "CTD Live mobile (iPhone)" }
```

`200`:

```json
{ "token": "ctd_pat_…", "tokenId": "…", "name": "CTD Live mobile (iPhone)",
  "scopes": ["chat:read", "status:read", "obs:control"], "profileId": "6f1d…" | null,
  "server": { "name": "CTD Relay", "version": "0.1.0", "apiRevision": "1.6" } }
```

- Store `token` in the Keychain. It never expires; the admin can revoke it in Relay (Settings → API).
- `deviceName`: what the admin sees in Relay's token list, at most 60 characters. Since iOS 16,
  `UIDevice.name` is just "iPhone" without an entitlement, so something like
  `"CTD Live mobile (iPhone)"` is fine.
- Errors (RFC 9457 JSON, with a `code` field):
  - `410 expired`: the code was used, expired or is unknown. Say "Show a new QR code in CTD Relay".
  - `429 rate_limited`: honor `Retry-After`.
  - `400 invalid`: a bad request body.
- The app should check that `scopes` contains `obs:control`. Relay builds older than 1.6 don't grant
  it; say "Update CTD Relay".

## 3. OBS over Relay — `GET {api}/obs/socket` (WebSocket)

**URL:** take the API base and replace `https`/`http` with `wss`/`ws`, then append `/obs/socket`:
`https://203.0.113.7/api/v1` → `wss://203.0.113.7/api/v1/obs/socket`.

**Opening request.** It must carry the bearer header, so build a `URLRequest` instead of a bare URL:

```swift
var request = URLRequest(url: socketURL)
request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
request.setValue("obswebsocket.json", forHTTPHeaderField: "Sec-WebSocket-Protocol")
let task = session.webSocketTask(with: request)
```

On Android (OkHttp): `Request.Builder().url(…).header("Authorization", "Bearer $token")
.header("Sec-WebSocket-Protocol", "obswebsocket.json")`.

**Handshake.** This is standard obs-websocket 5 with one difference: **the `Hello` (op 0) never has an
`authentication` field**. The bearer token already signed the phone in, so the existing code path
sends `Identify` (op 1) without `authentication`. In detail:

- Relay sends `Hello` only once it has reached OBS, usually within a second and always within 5 s.
  After your `Identify`, OBS's `Identified` follows within 3 s, or Relay closes with 4101. The worst
  case, 8 s in all, fits a client's 10 s wait.
- `Hello.d.obsWebSocketVersion` and `rpcVersion` are the real OBS values.
- Your `Identify.eventSubscriptions` and `rpcVersion` are passed through to OBS as they are, including
  high-volume subscriptions such as `InputVolumeMeters`.
- After `Identified`, every message goes through unchanged in both directions: requests, batches,
  events and `Reidentify`.

**Rejected before the upgrade** (HTTP status, problem JSON body):

| Status | `code` | Meaning / what to show |
|---|---|---|
| 401 | `unauthenticated` | Unknown or revoked token: "This phone was removed in CTD Relay. Scan a new code." Drop the saved token. |
| 403 | `missing_scope` | A token from before Relay 1.6 (no `obs:control`): "Scan a new code in CTD Relay". |
| 429 | `rate_limited` | Too many sockets for this token (max 4) or too many attempts. Honor `Retry-After`. |

**Closed after the upgrade.** Relay's own close codes are in the `41xx` range so they never collide
with OBS's `40xx` codes. The close **reason** is a short English sentence, ready to show; display it.
For example: `CTD Relay can't reach OBS at 192.168.1.50:4455. Is OBS open, with its WebSocket server on?`

| Code | Meaning | App behaviour |
|---|---|---|
| 4100 | OBS isn't set up in Relay yet (no OBS address known) | Show the reason. Don't auto-retry; offer a Retry button. |
| 4101 | Relay can't reach OBS (OBS closed, WebSocket server off, PC asleep) | Show the reason and retry with backoff (2, 4, 8 … 30 s). |
| 4102 | OBS rejected Relay's OBS password | Show the reason (it points to Relay's settings). Don't auto-retry. |
| 4103 | OBS went away mid-session | Same as a dropped LAN connection: reconnect with backoff. |
| 4011 | This phone was disconnected in Relay (token revoked) | Drop the token and go to "scan a new code". |
| 4007 | Something other than `Identify` was sent after `Hello` | A bug in the app. |
| 1001 | Relay is restarting or updating | Reconnect with backoff. |
| 1006 / network loss | Mobile data or Wi-Fi changed | Reconnect (see § LAN or internet). |
| any `40xx` | Forwarded from OBS as is (e.g. 4010 UnsupportedRpcVersion) | Handle as today. |

**Keep-alive:** keep pinging every 15 s as today. Relay pings too and closes a socket that has been
silent for 60 s.

**Limits:**
- Frames from the phone are at most 1 MB.
- Frames to the phone have no limit (screenshots).
- At most 4 sockets per token.

**Which OBS:** one OBS per Relay, set in Relay (Settings → API → *OBS on your computer*). A token
limited to a profile still controls that same OBS.

## 4. LAN or internet

- **On Wi-Fi, with `lan` saved:** try `lan` first with a short connect timeout (about 1.5 s), then
  fall back to `api`. A phone on the home Wi-Fi often can't reach the router's public address (no
  NAT hairpin), and `lan` avoids that.
- **On cellular:** go straight to `api`.
- **Network changes:** watch them with `NWPathMonitor`. When the interface type changes, reconnect
  the same way. A Wi-Fi ↔ cellular switch kills the socket anyway, so reconnect right away instead
  of waiting for the backoff.
- **Plain `ws://` to the LAN address:** this is allowed for LAN clients only. The app already does
  `ws://` to OBS on the LAN, so ATS (`NSAllowsLocalNetworking`) and the Local Network permission
  are already in place.
- **Same token everywhere:** both addresses reach the same Relay.

## 5. TLS and the `fp` pin

- Normally `api` has a **Let's Encrypt** certificate (for the public IP or a domain), so the system
  trust check passes and nothing special is needed. **Don't pin these certificates:** Let's Encrypt
  IP certificates are renewed every few days, so their fingerprint changes.
- Only when **system trust fails** and the profile has an `fp`: accept the server if the SHA-256 of
  its **leaf certificate (DER)** equals `fp` (compare uppercase hex without the colons). Do this in
  `urlSession(_:didReceive:completionHandler:)`, for both `URLSession` HTTP and the WebSocket task.
- If neither check passes, say "CTD Relay's certificate changed. Scan a new code" and don't connect.

## 6. Live previews

### A. Scene tiles and PGM/PVW (from OBS, through the relay)

The multiview's `GetSourceScreenshot` loop works through the relay as is, from anywhere. Relay only
forwards bytes: it doesn't re-encode or cache. On mobile data, bandwidth is the limit (the phone's
link and the home connection's upload), so adapt:

- **One request in flight per tile.** Ask for the next frame of a tile only after its previous one
  arrived. That alone matches the frame rate to the available bandwidth, and a slow link never builds
  a queue (queued frames would be stale by the time they arrive).
- **When `NWPath.isExpensive` or `.isConstrained`** (cellular, Low Data Mode):
  - use `imageFormat: "jpg"` with `imageCompressionQuality` 50–60;
  - keep `imageWidth` at the tile's drawn pixel size (already done) and cap it at 640;
  - target PGM/PVW at about 5 fps and other tiles at 1–2 fps;
  - pause tiles that aren't visible.
- **Rough cost:** a 640 px JPEG at quality 55 is about 25–40 KB. PGM + PVW at 5 fps plus six tiles at
  1 fps is roughly 0.5–0.7 MB/s (4–6 Mbit/s). Offer a "Data saver" toggle in Settings that halves the
  rates.
- **On Wi-Fi or the LAN:** keep today's rates.

### B. Program feeds (what OBS actually sends to Relay)

`GET {api}/profiles/{profileId}/previews/landscape` (or `/vertical`) returns a JPEG of the stream
Relay receives. It needs `status:read`, which the token already has.
- The frame is 640 px wide and cached 5 s, so poll every 3–5 s.
- Every response has `X-Preview-At`.
- `404 feed_offline`: OBS isn't streaming that feed.
- `503 unavailable`: retry after `Retry-After`.

This is the right "is my stream actually going out" view (Aitum Vertical included), as opposed to
the OBS canvas. When the token's `profileId` is null, use the default profile from `GET {api}/profiles`.

## 7. Relay extras (optional, same token)

All of these are documented in `docs/API.md` and need scopes the token already has:
- `GET {api}/status`: live state and destinations.
- `GET {api}/events` (Server-Sent Events): `stream.status` carries total viewers across platforms;
  also `destination.down`/`destination.up` and `chat.message`.
- `GET {api}/profiles/{id}/obs`: OBS issues reported by the CTD OBS plugin.
- `GET {api}/clock`: shared timecode.

## 8. Test checklist

1. Show the QR code in Relay → scan → the profile appears as "CTD Relay"; Relay shows "connected".
2. On the home Wi-Fi: the deck and multiview work (through `lan`).
3. Turn Wi-Fi off: the app reconnects over mobile data within a few seconds; previews keep updating
   at the reduced rate; switching scenes works.
4. Quit OBS: the phone shows 4101 "Relay can't reach OBS…" and reconnects by itself when OBS is back.
5. Put a wrong OBS password in Relay: 4102, with a message pointing to Relay's settings.
6. Revoke the phone in Relay (Settings → API): 4011, and the app asks for a new code.
7. Scan the same QR code again after it was used: `410`, "show a new code".
8. Turn on Low Data Mode: the preview rate drops; nothing stalls.
9. Android: the same checklist.
