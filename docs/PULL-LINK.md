# Pull link delay: where it comes from and the best OBS settings

A Pull link (docs/GUEST-FEEDS.md → Pull link) lets a second OBS watch a feed through Relay. In a
test on 2026-11-25 the picture in the second OBS was about **4 s** behind the sender. This page says
what was measured, what Relay adds, and what to set in OBS.

## What we measured (2026-11-26)

`npm run e2e:srt` runs the real MediaMTX and FFmpeg that Relay ships. The publisher writes a frame
number into the picture and notes when it sends each frame; the reader decodes the number and notes
when the frame arrives. All on one machine, so the network adds nothing. The numbers are accurate
to about ±0.1 s.

Two numbers per path:

- **Steady:** how late frames arrive once the reader is running.
- **First frame:** how old the first frame is when a reader that joins a running feed shows it. A
  player that then plays at the frame timestamps (an OBS Media Source does) **keeps this delay for
  as long as it plays**. It never catches up.

| Path | Reader | Steady | First frame |
| --- | --- | --- | --- |
| RTMP → RTMP, no Relay (baseline) | low delay | 137 ms | n/a |
| **RTMP → Relay → RTMP pull** | low delay | **136 ms** | **≈0 s** |
| **RTMP → Relay → RTMP pull** | **FFmpeg defaults** (a Media Source with no options) | 202–236 ms | **1.35 s** |
| SRT → Relay → SRT pull (latency 500 ms) | low delay | 1.24 s | 1.1 s |
| SRT → Relay → SRT pull (latency 500 ms) | **FFmpeg defaults** | 1.3 s | **5.5 s** |

"Low delay" means `-fflags nobuffer -flags low_delay`.

What this says:

1. **Relay adds nothing you can see.** RTMP through Relay (136 ms) is as fast as RTMP straight from
   the publisher to the reader (137 ms). MediaMTX copies packets; it keeps no picture buffer (no
   GOP cache) and starts a new reader at the next keyframe. Its write queue only fills when a reader
   can't keep up. **There is nothing to fix in Relay.**
2. **A player with default settings starts behind and stays there.** FFmpeg's defaults read up to
   5 s of the stream to work out what's in it before playing. On RTMP that cost 1.35 s here; on SRT
   it cost 5.5 s. So **SRT in a Media Source with no options is worse than RTMP.**
3. **SRT is not faster than RTMP on a good network.** Each SRT hop holds its latency buffer (500 ms
   by default for the internet). SRT pays off on a lossy link (Wi-Fi, a bad uplink). There RTMP
   stalls and keeps the delay it built up, while SRT's delay stays at what you set.

The rest of the 4 s happens in the sending OBS (encoder and output) or in the receiving OBS's Media
Source. It can't be measured from the cloud; the test below splits the two in five minutes.

## Best settings in the receiving OBS

### Media Source (RTMP Pull link)

1. Sources → **+** → **Media Source**.
2. Untick **Local File**. Paste the Pull link into **Input**. Leave **Input Format** empty.
3. **Network Buffering: 0 MB.**
4. Untick **Restart playback when source becomes active**.
5. **FFmpeg Options:** `fflags=nobuffer flags=low_delay probesize=32 analyzeduration=0`
6. After the sender is live, **right-click the source → Restart**, or toggle its eye off and on.
   The player then joins close to live instead of where it was when OBS opened it.

### Media Source (SRT pull link)

Same as above, with **Input Format** `mpegts` and the SRT pull link in **Input**. For SRT the FFmpeg
Options from step 5 matter most: without them the player starts about 5 s behind.

### VLC Video Source (the alternative)

1. Sources → **+** → **VLC Video Source** (needs VLC installed on that machine).
2. **+** → **Add Path/URL** → paste the RTMP Pull link.
3. If it shows **Network caching**, set it to `300` ms. VLC's own default is about 1 s.

VLC plays at a fixed buffer behind live and doesn't drift. If the Media Source keeps sitting
seconds behind with the settings above, use this.

## Find where the rest of the delay is

1. Put a running clock with tenths of a second on the **sending** OBS's canvas (for example a
   Browser Source with an online stopwatch page). It goes out with the feed.
2. On the receiving machine, open the same Pull link in two players next to each other:
   - the Media Source with the settings above;
   - `ffplay -fflags nobuffer -flags low_delay -framedrop "<pull link>"` (or VLC with 300 ms
     caching).
3. Take one phone photo that shows the sending OBS's preview and the receiving screen together.
   Compare the clocks.

How to read the photo:

- **ffplay is close (under 1 s) but the Media Source is seconds behind:** the Media Source is
  buffering. Use the VLC Video Source, or restart the Media Source after the feed is up.
- **ffplay is also seconds behind:** the delay is before Relay, in the sending OBS's encoder or
  output, or in the upload. Try these on the sender:
  - keyframe interval 1 s;
  - no B-frames;
  - the Apple VT H.264 encoder's **Real-time** option if your OBS shows it, or x264 `veryfast`
    with `zerolatency`;
  - a wired connection instead of Wi-Fi.

Send the photo and the settings used. The numbers are enough to decide the next step. Never send
the link itself: its key works like a password.
