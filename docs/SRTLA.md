# SRTLA: bonded SRT from BELABOX and Moblin

**SRTLA** is SRT link aggregation: an IRL encoder or phone app sends one SRT stream over several
links at once (two or three cellular modems, Wi-Fi, Ethernet), and the receiver puts it back
together. A drop on one link costs nothing while the others carry on. BELABOX and Moblin speak it.

Since 0.2.110 Relay runs the upstream receiver, **`srtla_rec`** from
[BELABOX/srtla](https://github.com/BELABOX/srtla) (AGPL-3.0, pinned to commit
`37862da3d0c13b46956efd3f88877053293d97d6`, unmodified), on its own UDP port (`SRTLA_PORT`, default
**5000**). It forwards the reassembled SRT to Relay's own SRT listener (`127.0.0.1:SRT_PORT`,
[SRT.md](SRT.md)). A bonded sender therefore publishes into the same feeds, with the same keys, as an
SRT sender:

- a profile's **Landscape** or **Vertical** feed (`live/landscape`, `live/<slug>/vertical`, …);
- an **extra feed** (`guest/<slot>`, [GUEST-FEEDS.md](GUEST-FEEDS.md)).

Everything after ingest is the same as for SRT and RTMP: feed state and the codec guard, thumbnails,
the live preview, destination pushes, guest routes, Pull links. Media: H.264 + AAC in MPEG-TS,
passed through. `srtla_rec` is a UDP relay: it decodes nothing, and Relay transcodes nothing.

## Server setup

1. **SRT must be on** (`SRT_PORT`, default 8890). SRTLA rides on it.
2. **Map the SRTLA UDP port** in the app, 1:1:
   - **TrueNAS:** Apps → CTD Relay → Edit, add `5000:5000/udp` under ports. The YAML in
     `deploy/truenas/` already has it.
   - **Docker Compose:** `"5000:5000/udp"` (already in `docker-compose.yml`).
3. **Router:** forward **UDP 5000** to the server. Bonded senders are on cellular, so this is the
   one port that has to reach the internet. Forward UDP 8890 too only if someone also sends plain
   SRT (or reads a Pull link over SRT) from outside. **Never forward 1935** (RTMP).
4. Another port: set `SRTLA_PORT` and map that one instead. `SRTLA_PORT=0` turns SRTLA off.
5. `SRTLA_MAX_GROUPS` (default 4): bonded senders that may publish at once (see Limits).

The Docker image has `srtla_rec` (built from source per architecture, amd64 and arm64). From
source, `npm run setup-tools` builds it into `./tools` when a C compiler, `make` and `git` are
installed (Linux only; it uses epoll), and says so plainly when it skips it.

When SRTLA can't work, Relay starts and behaves exactly as without it, and says why in plain words
where the SRTLA address would be (Settings → OBS setup, the extra feeds' ingest details,
`srtlaStatus.reason` in the API):

- `SRTLA_PORT=0`: "SRTLA is turned off on this server".
- SRT is off (`SRT_PORT=0`, or its port was taken): "SRTLA needs SRT, and SRT is off: …".
- `SRTLA_PORT` equals `SRT_PORT`.
- `srtla_rec` is missing (a source install without a C compiler): "srtla_rec was not found …".
- The UDP port is already taken on the machine: Relay checks at start, keeps SRTLA off, logs a
  warning. SRT and RTMP work as usual.
- The port isn't mapped in Docker, or not forwarded: Relay can't see this from inside the container.
  BELABOX/Moblin then never connect; check the mapping first.

Relay supervises `srtla_rec` like MediaMTX and FFmpeg: it starts after MediaMTX, restarts with
backoff (1 s doubling to 30 s) if it exits, and stops with Relay. Its output goes to Relay's log
through the same redactor as MediaMTX's (it prints sender addresses and group ids, never the
streamid: it doesn't read it).

## Addresses

Settings → OBS setup → **Bonded cellular: SRTLA** shows, per feed, the two things the apps ask for
(hidden until revealed; they hold the key). An extra feed's **Copy ingest details** carries the same
lines. The API returns them as `srtla: { host, port, streamId, url }` next to `srtUrl`
([API.md](API.md) → v1.19).

| | Value |
|---|---|
| SRTLA address | your Relay host, e.g. `relay.example.com` (Settings → General → Ingest host) |
| SRTLA port | `5000` (UDP, `SRTLA_PORT`) |
| SRT streamid | `publish:live/landscape:key=<key>` (`live/<slug>/vertical`, `guest/<slot>`, …) |
| Moblin URL | `srtla://relay.example.com:5000?streamid=publish:live/landscape:key=<key>` |

### BELABOX

1. In the BELABOX web UI, set the relay server to **manual**.
2. **SRTLA receiver address:** `relay.example.com`. **SRTLA receiver port:** `5000`.
3. **SRT streamid:** the *SRT streamid* from Relay (`publish:live/landscape:key=…`).
4. **SRT latency:** set it there. On cellular, 1500–2000 ms rides out link drops; lower costs
   picture breakups.
5. Encoder: H.264, AAC. Start: the feed goes online in Relay like any other.

### Moblin

1. Settings → Streams → your stream → **URL:** the *SRTLA URL* from Relay
   (`srtla://relay.example.com:5000?streamid=publish:live/landscape:key=…`). The `srtla://` scheme is
   what makes Moblin bond its links.
2. Video codec **H.264** (not H.265: the codec guard flags it), audio AAC.
3. Go live.

## Limits

- **CPU:** `srtla_rec` relays UDP packets; it costs next to nothing. Nothing is decoded or encoded.
- **Group cap (`SRTLA_MAX_GROUPS`, default 4).** `srtla_rec` has no option for it (its own limits
  are compiled in: 200 groups, 8 links per group). Relay enforces the cap in its auth hook: every
  SRT publish that comes from loopback came through `srtla_rec`, so once a valid-key bonded publish
  is let in, its path holds a slot; the next bonded sender on another path is refused while
  `SRTLA_MAX_GROUPS` paths hold one (logged as a warning). A slot is held while MediaMTX lists the
  publisher, and 15 s after, so a sender that reconnects keeps it. A sender that registers with
  `srtla_rec` but never sends SRT with a good key takes no slot; `srtla_rec` drops it after 10 s.
- **Link counts:** Relay can't show how many links a sender bonds. `srtla_rec` has no stats output,
  and its log names a group by a memory address, never by stream, so links can't be tied to a feed.
  `srtlaStatus.linkCounts` is always `false`. The feed's own state (online, bitrate, codec) is shown
  as for every feed; BELABOX and Moblin show their links themselves.
- A local SRT sender on the server itself (127.0.0.1 straight to `SRT_PORT`) also counts as bonded
  while SRTLA is on.

## Security

- The key in the `streamid` is the credential, exactly as with SRT ([SRT.md](SRT.md) → Security):
  `srtla_rec` passes the SRT handshake through unchanged, so Relay's auth hook sees the path and the
  key and applies the same rules. A wrong, missing or other feed's key is refused. Verified with the
  real binaries by `npm run e2e:srtla`.
- **Loopback grants nothing over SRT.** MediaMTX sees every bonded publish as coming from
  127.0.0.1. Relay's loopback-only grants therefore never apply to SRT:
  - Relay's internal reads need the internal reader password **and** RTMP or HLS (Relay itself never
    reads over SRT), so `read:<path>:internal:<password>` over SRT is refused even from loopback.
  - A guest route's one-time publish key works only over RTMP from loopback (Relay's own FFmpeg),
    never over SRT.
- No key reaches Relay's logs: `srtla_rec` doesn't print the streamid, and its lines go through the
  redactor anyway.
- There is no SRT passphrase, so packets travel unencrypted, as with SRT and RTMP. Treat the streamid
  like a password; rotate the key in Relay if it leaks (the sender is disconnected at once).
- `srtla_rec` upstream calls itself unsupported and not meant for production. Relay pins one commit,
  runs it unprivileged inside the container, and only lets SRT with a valid key through to MediaMTX.
- Never forward 1935. Forward 5000/udp for bonded senders; 8890/udp only if someone needs plain SRT
  from outside.

## Testing

- `npm run e2e:srtla`: FFmpeg publishes SRT into a local `srtla_send` (from the same pinned commit,
  built by `npm run setup-tools`) with two links (127.0.0.1 and 127.0.0.2), which bonds to the real
  `srtla_rec`, which forwards to the real MediaMTX through Relay's media server. Checks: the feed comes
  online as H.264 + AAC; the auth hook saw the streamid's path and key; MediaMTX lists the publisher
  at 127.0.0.1; both links registered; a wrong or missing key is refused; the group cap refuses a
  second sender; no key in Relay's log lines (trace level).
- Unit tests: `server/src/media/srtla.test.ts` (config, supervisor, wiring, auth matrix, cap).
