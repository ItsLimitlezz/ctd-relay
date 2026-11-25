# SRT: ingest and pull links over UDP

Relay's bundled MediaMTX also listens for **SRT** on one UDP port (`SRT_PORT`, default **8890**).
It carries the same feeds with the same keys as RTMP:

- **Ingest:** OBS (or FFmpeg, Larix, …) sends a profile's Landscape/Vertical feed or a guest feed
  over SRT instead of RTMP.
- **Pull link:** an OBS Media Source (or FFmpeg/VLC) reads a feed over SRT with that feed's Pull link
  read key.

Everything after ingest works the same whichever protocol published the feed. Feed state, the codec
guard, thumbnails, the live preview (LL-HLS), destination pushes and guest routes all read from
MediaMTX. Media: H.264 + AAC in MPEG-TS, passed through (nothing is transcoded).

## Server setup

1. **Map the UDP port** in the app's port mapping, 1:1:
   - **TrueNAS:** Apps → CTD Relay → Edit, add `8890:8890/udp` under ports. The YAML in
     `deploy/truenas/` already has it.
   - **Docker Compose:** `"8890:8890/udp"` (already in `docker-compose.yml`).
2. **Router:** forward UDP 8890 to the server **only** if a sender or reader is outside your LAN (a
   remote guest, a second studio). On a LAN, forward nothing.
3. To use another port, set `SRT_PORT` and map that port instead. `SRT_PORT=0` turns SRT off.

When SRT can't work, Relay says so in plain words wherever it would show an SRT address (OBS setup,
guest ingest details, Pull link), and RTMP works as before:

- `SRT_PORT=0`: "SRT is turned off on this server".
- The UDP port is already taken on the machine: Relay checks at start, turns SRT off and logs a
  warning. MediaMTX, and with it RTMP, still starts.
- The port is not mapped in Docker: Relay can't see this from inside the container. The addresses
  are shown, but nothing outside reaches them. If OBS can't connect, check the mapping first.

## Addresses

The key goes inside SRT's `streamid`. Placeholder: `relay.example.com` stands for your server's
address. The SRT addresses use **the same host as the RTMP ones**: the Ingest host setting (Settings →
General → Ingest host) when it is set, else the host your browser used to open Relay. When the
sender or the player is on another network, that has to be the public name. Open Relay through its
public name, or set the Ingest host to it, and forward the UDP port on the router.

| What | Address |
| --- | --- |
| OBS → Relay, profile feed | `srt://relay.example.com:8890?streamid=publish:live/landscape:key=<landscape key>&latency=500000` |
| another profile | `…streamid=publish:live/<slug>/landscape:key=<its key>…` |
| a guest | `…streamid=publish:guest/<slot>:key=<guest key>…` |
| Pull link (read) | `srt://relay.example.com:8890?streamid=read:<path>:key=<read key>&latency=500000` |

You don't have to build these by hand. Relay shows them with your keys in:

- Settings → OBS setup → "Low delay: SRT"
- a guest's **Copy ingest details**
- the Pull link panel → "SRT pull link"

### OBS: send over SRT

Settings → Stream → Service **Custom…** → **Server** = the SRT address. Leave **Stream Key** empty.

### OBS: watch a pull link over SRT

1. Sources → + → **Media Source**, then untick **Local File**.
2. Paste the SRT pull link into **Input**.
3. Set **Input Format** to `mpegts`.

### Latency

`latency=` is SRT's receive buffer. FFmpeg's libsrt, and OBS which uses the same URL options, read it
in **microseconds**, so `latency=500000` means 500 ms. SRT holds each packet that long so lost
packets can be resent. The rule of thumb is about 4× the round trip.

- **Internet:** `500000` (500 ms), the default in every address Relay shows. Senders and players
  are often on another network, through a forwarded UDP port. On a good link (low round trip, no
  loss) you can go lower, e.g. `300000`. Raise it toward `800000` if the picture breaks up.
- **LAN** (sender and Relay, or Relay and player, on the same network): `150000` (150 ms) is
  enough.

Each end can set its own value. The sender → Relay hop and the Relay → player hop are separate, so
use the LAN value only on the hop that is really on the LAN.

Each SRT hop has its own buffer (sender → Relay, Relay → reader). MediaMTX keeps a floor of about
120 ms on its side, so values below that don't lower the delay much through Relay (see below).

## Security

- The key in the `streamid` is the credential, exactly like RTMP's `?key=`. Every SRT publish and
  read goes through Relay's auth hook with the same rules:
  - Ingest keys publish (profile feeds and guest slots).
  - Only a feed's Pull link read key reads, and only while that link is on.
  - An ingest key never reads, and a read key never publishes. Every other read is Relay's own
    (loopback only).
- The Pull link reader cap (`PULL_LINK_MAX_READERS`) counts RTMP and SRT readers together. Rotating
  the key or turning the link off disconnects SRT readers too.
- There is no SRT passphrase, so packets travel unencrypted, like RTMP. Treat a link with a key like
  a password. For internet use over untrusted networks, prefer a VPN.
- Never forward 1935 (RTMP). Forward 8890/udp only when someone outside your LAN needs it.

## Measured delay (2026-11-25)

`npm run e2e:srt` measures how late each frame arrives. The publisher writes the frame number into
the picture as 16 black/white bands and stamps the time it sends the frame. The reader decodes the
number and stamps the arrival.

Test setup: x264 `zerolatency`, no B-frames, 1 s keyframes, 30 fps. All on one machine (loopback,
no packet loss). The numbers are the steady-state median.

The RTMP rows don't use the SRT latency; their small differences between columns are run-to-run
noise.

| Path | latency=500 ms (default) | latency=150 ms (LAN) | latency=20 ms |
| --- | --- | --- | --- |
| RTMP → RTMP, direct, no Relay (baseline) | 137 ms | 137 ms | 107 ms |
| **RTMP → Relay → RTMP pull** | **137 ms** | **137 ms** | **139 ms** |
| SRT → SRT, direct, no Relay (baseline) | 704 ms | 353 ms | 223 ms |
| **SRT → Relay → SRT pull** | **1242 ms** | **544 ms** | **485 ms** |
| RTMP → Relay → SRT pull | 704 ms | 353 ms | 324 ms |
| SRT → Relay → RTMP pull | 676 ms | 293 ms | 297 ms |

Over the internet, add the network's own transit time to each hop. With SRT on both hops (sender →
Relay → player), the delay is about two latency buffers plus about 0.2 s. At the default 500 ms that
is about 1.2 s. With `latency=300000` on a good link, expect roughly 0.8 s.

What this says:

- **Relay itself adds almost nothing.** RTMP through Relay is as fast as RTMP straight from the
  publisher to the reader. MediaMTX copies packets and doesn't buffer.
- **On a clean network SRT is not faster than RTMP.** Each SRT hop adds its latency buffer, and
  MPEG-TS adds a little on top. SRT pays off on lossy links (Wi-Fi, the internet). There TCP-based
  RTMP stalls and builds up delay that never goes away, while SRT's delay stays at what you set.
- So **seconds of delay in an OBS Media Source come from the player or the network**, not from
  Relay. The player buffers at start-up and never drops to catch up; RTMP over a lossy internet link
  adds its own build-up. Things to try on the reading OBS:
  - keep **Network Buffering** at 0 MB;
  - send 1 s keyframes (a reader starts at a keyframe);
  - restart the Media Source after the feed is up (it starts closer to live);
  - if your OBS's Media Source has an **FFmpeg Options** field, try
    `fflags=nobuffer analyzeduration=500000 probesize=500000`.

Glass-to-glass (camera to screen) can't be measured from the cloud. Measure it on the LAN with a
clock on screen.
