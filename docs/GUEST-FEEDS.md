# Guest feeds

**Roadmap: Relay F1 / CTD OBS F1.** A remote camera operator or a guest sends video to Relay over the
internet; CTD OBS on the production machine pulls it in as a source (**CTD Relay Feed**). Relay is
the hub: the guest never connects to the production machine, and CTD OBS never connects to the
guest.

```
guest (OBS, Larix, vMix…) ──RTMP──▶ Relay: MediaMTX guest/<slot> ──LL-HLS (Relay auth, feeds:watch)──▶ CTD OBS source
                                         │
                                         ├── never pushed to Twitch / YouTube / … by itself: only OBS's program output is
                                         └── or, if an admin sets a route (Routing, below), passthrough to a custom
                                             RTMP(S) server, or into a profile as its Landscape / Vertical feed
```

The API contract (JSON shapes, URLs, events, issues) is [API.md §18](API.md#18-guest-feeds-remote-video-into-ctd-obs-v117).
This page is for whoever runs the server.

## Slots

Each Relay profile has up to **4** guest feed slots (`GUEST_FEEDS_MAX`). A slot has a name, an id
(10 characters, fixed, never reused) and its own ingest key. In the web UI the **Extra feeds** card (the web UI calls guest feeds *extra feeds*, since they also fit your own extra inputs) on
the dashboard (the selected profile's page, under its feed cards) lists them with their state, a
thumbnail and **Watch**; admins also see:

- **Add guest feed** (a name; empty = "Guest n").
- **Copy ingest details**: server, stream key and full URL on the clipboard, to send to the guest
  privately. The key works like a password.
- **Rename**, **Rotate key** (a new key; the guest is disconnected at once and the old key stops
  working), **Revoke key** (no key at all until you rotate; the guest is disconnected) and **Remove**.

Each of these is in the audit log (`guest.create`, `guest.rename`, `guest.rotate`, `guest.revoke`,
`guest.delete`) with the slot id, never the key. Keys are stored encrypted like the OBS keys (secrets
scope `guest:<profileId>`) and never logged. Deleting a profile removes its slots and keys and
disconnects its guests.

## How a guest sends video

The card's **How a guest sends video** help says the same. Placeholders: `<relay host>` is the address
the guest reaches Relay at, `<RTMP port>` its RTMP port (1935 by default), `<slot>` and `<key>` come
from **Copy ingest details**.

| | |
|---|---|
| Server | `rtmp://<relay host>:<RTMP port>/guest` |
| Stream key | `<slot>?key=<key>` |
| Full URL (one-field apps) | `rtmp://<relay host>:<RTMP port>/guest/<slot>?key=<key>` |

- **OBS:** Settings → Stream → Service *Custom…*, the server and stream key above. Output: x264 or a
  hardware H.264 encoder, **CBR**, 2500–6000 kbps, keyframe interval **2 s**; audio AAC 160 kbps,
  48 kHz.
- **Larix Broadcaster (iOS/Android):** Settings → Connections → New connection, paste the full URL.
  Video codec **H.264** (not HEVC), audio AAC.
- **Anything else** with a custom RTMP output (vMix, Wirecast, Streamlabs, a hardware encoder): the
  server and stream key, or the full URL.

**H.264 + AAC only** (the 0.2.40 codec guard): an HEVC or AV1 guest shows "HEVC ⚠" and can't be
watched (`guest.feed.codec` alert); Opus audio plays but may have no sound in players. Nothing is
transcoded.

### Reaching Relay's RTMP port from the internet

The guest has to reach Relay's RTMP port. [SECURITY.md](SECURITY.md) says **never forward 1935**
(RTMP ingest) to the internet, and that holds for guests too: the port is shared with OBS's own
feeds, so forwarding it would expose them to port scans and connection floods even though every
publish needs a key.

**Use a VPN into your network.** Give the guest a VPN account (WireGuard, Tailscale or your router's
VPN) and send them Relay's address on the VPN. Nothing is exposed to the internet.

RTMPS and SRT ingest for guests are not in this release.

## How CTD OBS reads it

`GET /api/v1/profiles/{id}/guest-feeds/{slot}/live.m3u8` with a token that has **`feeds:watch`**:
the 0.2.60 live preview machinery (LL-HLS from the loopback MediaMTX, proxied behind Relay's auth,
passthrough, a viewer cap, muxing only while someone watches, stopping ~30 s after the last request).
CTD OBS pairs with `status:read` + `feeds:watch`, lists the slots (`GET …/guest-feeds`) and follows
`guest.feed.status` / `guest.feeds.changed` on `/events`.

**Latency target for v1: about 2 s** behind the guest's encoder with an LL-HLS player (hls.js
`liveSyncDuration: 2`); about 3–4 s with a player that only knows whole segments (FFmpeg's `hls`
demuxer: use `-live_start_index -1`). Measured here: the first playlist answers in about 2.4 s (the
muxer starting).

**Later: SRT.** An SRT read path would get under 1 s, but needs a UDP port forwarded to Relay and its
own per-reader credentials, so it is out of scope for v1. The contract leaves room for it (API.md
§18.7): it will be an additive field and route; the LL-HLS routes stay.

## Limits (a weak, CPU-only server)

Guest feeds must never starve the main feeds. What keeps them cheap:

- **No transcoding**, and no ffprobe of guest feeds (the main feeds' frame-rate/keyframe probe isn't
  run for them).
- **On-demand muxing:** LL-HLS for a guest runs only while a player is open (no muxer otherwise).
- **Viewer cap per guest feed:** `GUEST_FEED_MAX_VIEWERS`, default **2** (CTD OBS plus one person in
  the web UI). Each player pulls the guest's full bitrate from Relay, over your upload when watched
  from outside.
- **Slot cap:** `GUEST_FEEDS_MAX` per profile, default **4**.
- **Bitrate:** each slot shows its inbound bitrate and resolution; above `GUEST_FEED_WARN_KBPS`
  (default **8000**) the card warns. Above `GUEST_FEED_MAX_KBPS` (default **20000**; `0` = no limit)
  for 10 s Relay **disconnects** the guest and shows when (`limitedAt`); a guest that reconnects and
  stays over is disconnected again.

| Variable | Default | |
|---|---|---|
| `GUEST_FEEDS_MAX` | `4` | Slots per profile (0–16). `0` turns guest feeds off: no slots, no guest can publish. |
| `GUEST_FEED_MAX_VIEWERS` | `2` | Players per guest feed (0–20). `0` = guest feeds can't be watched (`503 live_off`). |
| `GUEST_FEED_WARN_KBPS` | `8000` | Bitrate warning threshold (kbps). |
| `GUEST_FEED_MAX_KBPS` | `20000` | Hard limit (kbps), `0` = none. |

### What we measured

`npm run e2e:guests` (scripts/guest-feeds-e2e.ts) runs the real MediaMTX v1.21.2 and FFmpeg n8.1.3:
two main feeds (1080p 6 Mbps + 1080×1920 4 Mbps) read by two `-c copy` readers (what a destination
push does), then 4 guests at 1080p 8 Mbps, then 2 LL-HLS players per guest through Relay's proxy
code. Publishers send a pre-encoded clip with `-c copy`, so they cost nothing measurable. On a 4-vCPU
cloud VM (Xeon 2.1 GHz), 40 s per phase, CPU in % of one core:

| Phase | MediaMTX | Relay (Node) | Main copy readers | Landscape bitrate |
|---|---|---|---|---|
| Main feeds + 2 copy readers | 3.1 % | 0.3 % | 1.07× / 1.07× | 6079–7362 kbps |
| + 4 guests at 8 Mbps, nobody watching | 6.2 % | 0.4 % | 1.03× / 1.03× | 6097–7358 kbps |
| + 2 LL-HLS players per guest (8 players) | 8.6 % | 8.2 % | 1.02× / 1.02× | 6093–7262 kbps |

(Copy-reader speed is FFmpeg's running average since the reader started, so it settles toward 1.00×;
anything at or above 1.00× is real time.)

- 32 Mbit/s of guest ingest costs MediaMTX about **3 % of a core**; the main feeds' readers stay at real
  time and the landscape feed's bitrate doesn't move.
- The real cost is **players**: about **1 % of a core per player** at 8 Mbit/s in Relay's proxy, and
  each player's bitrate on the network. That is why the default cap is 2 per guest feed.
- On the production server (an older desktop CPU, Twitch Dual Format at 0.80× through Relay already) these
  percentages will be higher. Network is the tighter limit there: guest ingest uses your download,
  players outside the LAN use your upload, the same upload your destinations push over. With
  destinations live, keep guests at 6 Mbit/s or less and watch them only from CTD OBS on the LAN.

## Routing: sending a guest feed on

"Stream from my MacBook and relay it somewhere else, or to a profile." On the **Extra feeds** card,
each guest feed has **Send this feed to…** (admins) with two options:

- **A custom server (RTMP/RTMPS)**: a server URL and an optional stream key, up to **3** per guest
  feed. For a second restreamer, a recording box on the LAN, a platform Relay has no driver for.
- **A profile's feed**: the guest becomes that profile's **Landscape** or **Vertical** feed (its own
  profile or another). The profile then treats it exactly like a feed from OBS: its feed card (with
  **Source: extra feed <name>**), the codec guard, **Go live**, test mode, destinations, reports and
  alerts.

Everyone signed in sees each route's state (Stopped, Waits for the guest, Starting, Sending, Retrying,
Blocked, Failed) and its reason; admins **Start**/**Stop** it, switch **When the feed is online** (it
then starts whenever the guest sends) and **Remove** it. Every change is in the audit log
(`guest.route.*`), never the key.

**Passthrough only.** A route copies the guest's video and audio as they come (FFmpeg `-c copy`, on
the same push, retry and backoff code as destinations): nothing is transcoded, so the CPU cost is a
copy. The guest must send what the target takes (H.264 + AAC for anything RTMP).

**A route runs only while the guest sends**, and stops when they stop (or their key is rotated or
revoked). A manual route then stays stopped; an automatic one starts again when the guest is back.

**Custom servers.** `rtmp://` or `rtmps://` only. Relay refuses loopback (`localhost`, `127.0.0.1`,
`::1`), link-local (`169.254.x.x`, `fe80::`) and multicast hosts, a user name or password in the URL,
and **this Relay's own RTMP port** (a route can't feed Relay back into itself: to put a guest into a
profile, use "A profile's feed"). LAN servers (192.168.x.x, 10.x.x.x, 172.16–31.x.x, Tailscale's
100.64.x.x) are allowed by default; the owner can turn that off (`PUT /api/guest-routes/settings
{"allowLan": false}`, admin). The stream key is stored encrypted (secrets scope
`guest-route:<routeId>`), never shown again, never logged, and scrubbed from error messages.

**Into a profile: the rules.**

- **OBS always wins.** Relay refuses to route into an input while that profile's own OBS feed is on
  it, with "OBS is already sending Landscape to …". If OBS starts sending that input while a route
  holds it, OBS gets it and the route stops as **Blocked**, saying why. Never a silent switch.
- **One route per input** at a time.
- **Not while live.** Starting, stopping or removing a profile route by hand is refused while that
  profile is live (it would cut every destination). End the live first. If the guest drops during a
  live, the profile's feed goes offline exactly as if OBS stopped (destinations retry, `feed.offline`
  is raised); no automatic switching to anything else. An automatic route resumes when the guest is
  back, like OBS reconnecting, but only into an input it was the last to feed: if OBS published on
  that input since (or an admin stopped the route), an automatic route doesn't start while the profile
  is live (state *Blocked*), so a live profile whose OBS feed drops for a moment never gets a guest.
- **A route never starts Go live**, even with auto go-live on: auto go-live only counts OBS's own
  feeds.

How it works: Relay's FFmpeg reads `guest/<slot>` and republishes it on the loopback MediaMTX into
the profile's feed path (`live/<slug>/<feed>`) with a one-time key that only lives in memory and that
the auth hook accepts from loopback only.

## Pull link: watch a feed in OBS or VLC without a server

> **Lower delay over SRT:** the Pull link panel also shows an SRT pull link. In OBS's Media Source:
> untick Local File, paste the link into Input, set Input Format to `mpegts`. Guests can also send
> over SRT (their ingest details include the SRT address). See [SRT.md](./SRT.md) for setup, the
> UDP port to map, latency, and measured delay.
>
> **Bonded cellular (SRTLA, 0.2.110):** a guest on BELABOX or Moblin sends with the SRTLA lines of
> the ingest details (Moblin: the `srtla://` URL; BELABOX: address, port 5000, streamid). See
> [SRTLA.md](./SRTLA.md).

Delay: Relay adds next to nothing; the OBS Media Source settings decide most of it. Numbers and
the best settings: [PULL-LINK.md](PULL-LINK.md).

A guest feed (or a profile's own Landscape or Vertical feed) can have a **Pull link**: a plain
address you paste into an OBS **Media Source** or VLC. No MediaMTX or other server is needed on the
PC: OBS plays straight from Relay's bundled MediaMTX, on the RTMP port ingest already uses (so it
works wherever ingest works, and needs no new port).

- **Off by default.** Turn it on from the switch on the card, under "Pull link (OBS, VLC)". Turning
  it on makes a **read key** for that feed. The read key is separate from the ingest key: the read
  key only reads and never publishes, and the ingest key never reads.
- **The link:** `rtmp://relay.example.com:1935/guest/<slot>?key=<read key>` (a profile's own feeds:
  `…/live/landscape?key=…`, or `…/live/<slug>/vertical?key=…`). It's the same `?key=` form as ingest,
  and real OBS/VLC/FFmpeg (`ffmpeg -i <link> -t 3 -f null -`) play it. The host is Settings →
  Ingest host, else the address you opened Relay at.
- **In OBS:** Sources → + (Add) → Media Source → untick "Local File" → paste the link into "Input".
  **VLC:** Media → Open Network Stream.
- **Keep it private.** Anyone with the link can watch. **Rotate key** gives a new link. Switching
  it off revokes the key. Both disconnect everyone reading with the old link at once.
- **Limits:** at most `PULL_LINK_MAX_READERS` players per feed at once (default 2; `0` turns pull
  links off on the server). A reader that slips past the cap in a race is disconnected within a
  second. The card shows how many are watching. Relay's own readers (thumbnails, Watch, routes) are
  not counted.
- **Passthrough only:** MediaMTX hands out the packets as they arrive (no transcoding, no CPU cost
  beyond the network). Like ingest, a guest feed is still never restreamed to a platform.
- SRT isn't enabled in Relay's MediaMTX, so the link is RTMP only.
- **Keys:** stored encrypted (secret scope `pull`), shown only to admins (web UI or a `system:admin`
  token), never logged, and never in the audit log. API: docs/API.md §18.9.

## Alerts

On the suite's alert contract (API.md §17): **`guest.feed.offline`** (warning) when a guest stops for
5 s while the profile's session is running (not when you rotate, revoke or remove it), cleared when
the guest is back, the session ends or the slot goes; **`guest.feed.codec`** (warning) while a guest
sends video that isn't H.264. A guest feed on program in CTD OBS is reported by the CTD OBS plugin
(its own `obs.issue`, with `onProgram`).

## Database

Two tables, `guest_feeds` (g1) and `guest_routes` (g2), on their own migration track
(`guest_feeds_meta`), like the report tables: `PRAGMA user_version` stays **4**, so 0.2.80 opens the
database after a rollback and ignores both tables (verified with 0.2.80's code; deleting a profile
there removes its slots, their routes and the routes into it, by cascade). Keys are in the encrypted
secrets, scopes `guest:<profileId>` (ingest keys) and `guest-route:<routeId>` (custom servers'
stream keys).
