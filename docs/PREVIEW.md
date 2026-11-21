# Feed previews: thumbnails and "Watch"

What OBS sends to Relay, seen in the web UI: a still frame of each feed that refreshes by itself, and a
live player with sound. Apps (CTD Live Studio, CTD Live mobile, the CTD OBS Producer) get the same
through the external API ([API.md §10](API.md#10-obs-events-and-feed-previews-v14)): the still frames
with `status:read`, the live player only with its own scope, `feeds:watch`.

## What you see

- **Dashboard → Landscape feed / Vertical feed:** a thumbnail in the feed's own shape (16:9, 9:16),
  refreshed while the page is on screen and the feed is online: the next frame is asked for 3 s after
  the last one arrived, and a frame takes up to a keyframe interval to grab, so with OBS's 2 s
  keyframes a thumbnail changes about every 5–6 s. Offline: a placeholder.
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
                           thumbnails (every ~5 s)   /api/profiles/{id}/feeds/{feed}/live.m3u8 + live/*
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
  oldest one, so you never lock yourself out. A player holds its place from the moment it asks (while
  MediaMTX starts the muxer), so players opening at the same moment can't pass the cap together, and
  a request abandoned before its answer gives its place back.
- **Only through Relay.** MediaMTX's HLS server listens on loopback only and wants the internal
  reader password; Relay's proxy sends it. MediaMTX's per-reader session ids never leave the server:
  Relay swaps them for its own viewer ids, which only work with the login (or token) that opened the
  player. No key, password, token or cookie is ever in a preview URL. See
  [SECURITY.md → Live preview](SECURITY.md#live-preview).

## Browsers

The player prefers **hls.js** whenever the browser has Media Source (MSE, or Safari's Managed Media
Source) and uses the browser's own HLS player only where there is none. Keep that order: recent
Chrome (157 in the test) also answers "maybe" to `canPlayType('application/vnd.apple.mpegurl')`, and
hls.js is the path that was measured.

| Browser | Path | Checked |
| --- | --- | --- |
| Chrome, Edge, Chromium | hls.js over MSE | **Yes** (Chromium 157, automated: 1920×1080 H.264 High + AAC, 1.0–1.1 s behind, sound and meter) |
| Firefox | hls.js over MSE, the same code path | Not run. H.264/AAC come from the system's decoders (Windows, macOS: built in; Linux: needs FFmpeg's libavcodec, OpenH264 alone can't play OBS's High profile) |
| Safari 17.1+ (macOS, iPadOS, iOS) | hls.js over Managed Media Source (hls.js turns off AirPlay for it) | Not run |
| Safari before 17.1, iOS before 17.1 | Safari's own HLS player, same-origin with the session cookie | Not run. No audio level bar there: WebKit gives a Web Audio graph silence for an HLS `<video>`, so the sound goes through the element directly |

The player starts muted and inline (`muted`, `playsInline`), which every browser allows without a
click; the sound needs the click on the speaker button, as browsers require.

## Behind a reverse proxy or port forward

The previews are ordinary same-origin HTTPS `GET`s, so they work wherever the web UI works (port
forward, Caddy, nginx, a tunnel). Two things matter for Low-Latency HLS: the proxy has to pass each
response on as soon as Relay sends it (Relay holds a playlist request until the next 200 ms part
exists, then answers it whole), and it should speak HTTP/2 to browsers. MediaMTX's HLS port (9996)
is never exposed: don't map it, don't forward it, don't point a proxy at it.

**Caddy.** Nothing to add: the `reverse_proxy` you already use for Relay (with `TLS_MODE: "off"` and
`TRUST_PROXY: "true"` on Relay, [INSTALL-TRUENAS.md](INSTALL-TRUENAS.md) → HTTPS) plays at 1–3 s.

```caddy
relay.example.com {
	encode zstd gzip
	reverse_proxy <NAS-IP>:30443
}
```

- **Buffering / flushing.** Caddy buffers a response only "partially, for wire efficiency" and writes
  it out as soon as it is complete. Every playlist and part Relay sends is complete when it leaves
  Relay (a few KB to a few hundred KB, the moment MediaMTX has it), and a response whose length isn't
  known up front is flushed right away by Caddy anyway. So the default adds no delay.
- **Leave `flush_interval` out.** `flush_interval -1` ("low-latency mode") buys nothing here, and in
  that mode Caddy no longer cancels the request to Relay when the browser goes away, so a closed
  player's last requests run on until Relay's own limit (20 s). If it is already in your Caddyfile for
  something else, the preview still works.
- **`encode` is fine.** Caddy doesn't compress `video/mp4` (the parts) or
  `application/vnd.apple.mpegurl` (the playlists) with its default match list.
- **HTTP/2 and HTTP/3.** Caddy speaks both to browsers, so the dashboard, its thumbnails and several
  players share one connection. (Relay's own HTTPS, used with a plain port forward, is HTTP/1.1: a
  browser opens at most 6 connections to one address and a playing player keeps 2–4 of them busy.
  Measured: 4 players in one browser over HTTP/1.1 kept playing, but HTTP/2 through Caddy is the
  more comfortable setup.)
- **No timeouts to change.** Caddy's `reverse_proxy` has no response timeout by default, and no
  preview request lasts long: a blocked playlist request waits about one part (200 ms); Relay gives
  up on any request after 20 s.

**nginx.** Add `proxy_buffering off;` to the Relay `location` (otherwise nginx buffers whole responses:
it still plays, a little later), keep the WebSocket upgrade headers you already need for the web UI,
and turn on `http2` on the `listen` line. The default `proxy_read_timeout` (60 s) is enough.

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
| Dashboard open: 2 thumbnails refreshing | 5.2 %, 202 MB | 2.2 %, 45 MB |
| 1 player (Watch) + thumbnails | 9.1 %, 235 MB | 2.8 %, 82 MB |
| 3 players (2 on landscape, 1 on vertical) | 8.0 %, 288 MB | 3.2 %, 110 MB |

So: thumbnails cost about 5 % of one core while a page shows them (one keyframe decode per feed every
few seconds), a player a few percent more on Relay (passing parts on) and on MediaMTX (copying into
fMP4, ~35 MB per muxed feed for 7 segments in RAM). Nothing is spent while no page shows a preview.

### Resource safety (0.2.60 Senior check)

Measured with `scripts/preview-stress.ts` on the same kind of VM (4 vCPU Xeon @ 2.1 GHz), real Relay,
MediaMTX v1.21.2 and FFmpeg; OBS stand-ins 1920×1080 and 1080×1920, 30 fps, H.264 6/4 Mbit/s CBR, 2 s
keyframes, AAC; a Custom RTMP destination on the landscape feed to a local fake platform. The 4 players
are 4 Chromium tabs on the dashboard (so their thumbnails are on too).

**The outgoing restream while people watch**, 30 s per row, measured at the platform:

| Relay, MediaMTX and FFmpeg on | Players | Video at the platform | Bitrate | Longest gap between frames | FFmpeg fps (min) / speed (min) |
| --- | --- | --- | --- | --- | --- |
| 4 CPUs | 0 | 30.0 fps | 6.18 Mbit/s | 104 ms | 31.2 / 1.06× |
| 4 CPUs | 4 | 30.0 fps | 6.18 Mbit/s | 129 ms | 30.5 / 1.03× |
| 1 CPU | 0 | 30.0 fps | 6.19 Mbit/s | 106 ms | 31.2 / 1.07× |
| 1 CPU | 4 | 30.0 fps | 6.16 Mbit/s | 119 ms | 30.5 / 1.03× |
| 1 CPU, kept busy by an x264 1080p60 encode | 0 | 30.0 fps | 6.18 Mbit/s | 103 ms | 31.2 / 1.07× |
| 1 CPU, kept busy by an x264 1080p60 encode | 4 | 30.0 fps | 6.16 Mbit/s | 186 ms | 30.5 / 1.03× |

The copied restream doesn't notice the players, even on one busy CPU. What they cost (Relay 6–11 %,
MediaMTX 2–4 % of one core with 4 players and their thumbnails) is taken from whatever else needs the
CPU: on a server where a re-encode (Twitch Dual Format) already runs below real time, that re-encode
loses it. Watch one player at a time during such a show, or lower `LIVE_PREVIEW_MAX_VIEWERS`.

**Start and stop:**

- Muxing stops 35–39 s after the last request, whether the player was closed (35–38 s), the browser
  was killed (37 s), or the network froze with no FIN or RST (37 s). Relay keeps no connection to
  MediaMTX's HLS server afterwards. After the network came back, the player recovered by itself
  (7–21 s).
- **Viewer cap.** A 5th player from another login gets `429`. 12 logins opening at once on a cold feed:
  4 get a player, 8 get `429` (before the Senior check fix all 12 got one). 20 logins giving up 0.3 s
  into a cold start keep no place: 4 other logins asking 4 s later all get a player (before the fix
  all 4 got `429`).
- **300 open → play → close cycles** in the web UI: every one played; afterwards no muxer, no
  connection left to MediaMTX, Relay's file descriptors 33 → 29 and MediaMTX's 17 → 14. Relay's
  memory was flat (251 MB after 50 cycles, 255 MB after 300) and MediaMTX's levelled off at ~130 MB
  (its muxer buffers).
- **Hidden page:** 0 thumbnail requests in 20 s (6 in 20 s while visible, 2 feeds).
- Relay's log held no stream key, HLS session id, token or cookie.

**Playback.** At the default ~1 s delay hls.js keeps about 0.8 s of video buffered. On a steady link
it plays at 1.0–1.1 s for minutes; a hiccup longer than that (a slow network, a busy machine) makes it
buffer, and it then settles a few seconds further behind (2.5–4 s) and catches up at 1.2× speed. With
heavy simulated jitter (0–300 ms on every request, 1 s on 3 %) it rebuffered about 5 times in 90 s
and played 4–7 s behind, the same with a target latency of 1.5 or 2 s, so the player keeps
MediaMTX's own target.

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
password, the muxer stopping); `npm run e2e:preview` drives the web UI in Chromium;
`npx tsx scripts/preview-stress.ts` repeats the resource safety checks above (about 15 minutes;
`STRESS_CPUS=0` pins Relay, MediaMTX and FFmpeg to one CPU, `STRESS_PHASES=restream,cap` runs only
some). See [DEVELOPMENT.md](DEVELOPMENT.md).
