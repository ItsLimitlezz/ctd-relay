# Feed previews: thumbnails and "Watch"

What OBS sends to Relay, seen in the web UI: a still frame of each feed that refreshes by itself, and a
live player with sound. Apps (CTD Live Studio, CTD Live mobile, the CTD OBS Producer) get the same
through the external API ([API.md §10](API.md#10-obs-events-and-feed-previews-v14)).

## What you see

- **Dashboard → Landscape feed / Vertical feed:** a thumbnail in the feed's own shape (16:9, 9:16),
  refreshed every 3 s while the page is on screen and the feed is online. Offline: a placeholder.
  Nothing is fetched while the tab is in the background.
- **Profiles:** each profile's row shows both feeds the same way, so you can see what every profile's
  OBS sends without switching to it.
- **Watch** (on a thumbnail): the feed live in a player, about **1–3 s behind** Relay (1.0–1.1 s in
  the test below). It starts **muted**; the speaker button turns the sound on, the slider sets the
  volume (remembered in this browser), and the bar next to it is the audio level (peak, shown once the
  sound has been turned on). The player says how far behind it is. Closing the player stops it. A
  muted player in a background tab stops too, and starts again when you come back.
- **HEVC or AV1 feed:** the thumbnail shows the codec warning and there is no Watch button; the card
  says what to change in OBS (the same message as the [feed codec guard](PLATFORMS.md)). Relay can't
  take a frame of such a feed, and a browser can't be counted on to play it.

Every signed-in user (admin or operator) can see the previews.

## How it works

```
OBS ──RTMP──▶ MediaMTX ──(only while someone watches)──▶ LL-HLS muxer, 127.0.0.1:9996
                 │                                            │  internal reader password
                 └─RTMP─▶ FFmpeg: one keyframe → JPEG          ▼
                                   │                 Relay's own HTTPS server (same login)
                                   ▼                 /api/profiles/{id}/feeds/{feed}/preview.jpg
                           thumbnails (every 3 s)    /api/profiles/{id}/feeds/{feed}/live.m3u8 + live/*
                                                              │
                                                              ▼
                                                 hls.js (Chrome, Edge, Firefox, Safari 17+)
                                                 or Safari's own HLS player
```

- **Thumbnails** are the existing JPEG preview: FFmpeg reads the feed from MediaMTX, decodes only the
  first keyframe, scales it to 640 px wide and stops. A frame is reused for 2.5 s, so however many
  pages and apps show a feed, it gets at most one grab per 2.5 s.
- **Watch** is Low-Latency HLS from the bundled MediaMTX: the H.264 video and AAC audio are **copied**
  into fMP4 parts of 200 ms, never re-encoded (Relay's server has no GPU encoder to spare, and copying
  costs almost nothing). Segments follow the feed's keyframes, so OBS's 2 s keyframe interval gives 2 s
  segments; latency comes from the 200 ms parts, not the segments.
- **On demand.** MediaMTX starts muxing a feed when the first player asks for it (the first picture
  takes about 2–3 s) and stops 30 s after the last request; in practice the muxer is gone 35–40 s
  after the last player closed. A player that has asked for nothing for 15 s counts as gone.
- **Viewer cap.** At most `LIVE_PREVIEW_MAX_VIEWERS` players per feed at once (default **4**). The
  next one gets "4 players are already open on the landscape feed (the most at once)". If you open
  another player yourself while the feed is full (another tab, a reload), it replaces your own
  oldest one, so you never lock yourself out.
- **Only through Relay.** MediaMTX's HLS server listens on loopback only and wants the internal
  reader password; Relay's proxy sends it. MediaMTX's per-reader session ids never leave the server:
  Relay swaps them for its own viewer ids, which only work with the login (or token) that opened the
  player. No key, password, token or cookie is ever in a preview URL. See
  [SECURITY.md → Live preview](SECURITY.md#live-preview).

## Behind a reverse proxy or port forward

Nothing to set up: the previews are ordinary HTTPS requests to the same address as the web UI, so they
work wherever the web UI works (port forward, Caddy, nginx, a tunnel). Low-Latency HLS holds a
playlist request open until the next 200 ms part is ready, so a proxy should not buffer whole
responses: Caddy streams by default; with nginx, `proxy_buffering off;` on the Relay location keeps
the delay at 1–3 s (with buffering it still plays, a little later). MediaMTX's HLS port (9996) is never
exposed and must not be mapped.

## What it costs

Each player pulls the **whole feed** from Relay at its bitrate (a 6 Mbps feed = 6 Mbps per player).
Watching from outside your network uses your **upload**: keep that in mind on a live with a tight
upload, or lower `LIVE_PREVIEW_MAX_VIEWERS`. On the LAN it doesn't matter.

CPU and RAM, measured with `npm run e2e:preview` (real Relay, MediaMTX v1.21.2 and FFmpeg n8.1.3; two
FFmpeg test patterns as OBS: 1920×1080 and 1080×1920, 30 fps, H.264 4.5 Mbps with 2 s keyframes, AAC
128 kbit/s) on a 4-vCPU Xeon @ 2.1 GHz VM. Percent of one core, 20 s per row; "Relay" includes the
FFmpeg grabs it runs for the thumbnails:

| Situation | Relay | MediaMTX |
| --- | --- | --- |
| Both feeds coming in, nothing shown (baseline) | 0.3 %, 202 MB | 1.3 %, 45 MB |
| Dashboard open: 2 thumbnails refreshing every 3 s | 5.2 %, 202 MB | 2.2 %, 45 MB |
| 1 player (Watch) + thumbnails | 9.1 %, 235 MB | 2.8 %, 82 MB |
| 3 players (2 on landscape, 1 on vertical) | 8.0 %, 288 MB | 3.2 %, 110 MB |

So: thumbnails cost about 5 % of one core while a page shows them (one keyframe decode per feed every
few seconds), a player a few percent more on Relay (passing parts on) and on MediaMTX (copying into
fMP4, ~35 MB per muxed feed for 7 segments in RAM). Nothing is spent while no page shows a preview.

## Settings

| Variable | Default | What |
| --- | --- | --- |
| `LIVE_PREVIEW_MAX_VIEWERS` | `4` | Players per feed at once (1–50). `0` turns Watch off (MediaMTX's HLS server isn't started; thumbnails stay). |
| `MEDIAMTX_HLS_PORT` | `9996` | Loopback port of MediaMTX's HLS server. Change it only if something else in the container uses 9996. |

## Not included

- **WebRTC (WHEP)** for sub-second viewing on the LAN. It needs UDP ports mapped through Docker and
  ICE settings, and doesn't pass through a plain HTTPS reverse proxy; LL-HLS at 1–3 s covers checking
  the feed. Possible later.
- **HEVC/AV1 playback**, and any re-encoding (a lower-bitrate preview would need it).

## Testing

`npm test` covers the proxy (auth, viewer ids, rewriting, cap, idle expiry) with a fake MediaMTX;
`npm run smoke` checks LL-HLS against the real MediaMTX (on-demand start, nothing without the reader
password, the muxer stopping); `npm run e2e:preview` drives the web UI in Chromium. See
[DEVELOPMENT.md](DEVELOPMENT.md).
