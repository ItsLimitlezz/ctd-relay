# OBS setup

CTD Relay takes two feeds from OBS on your LAN:

| Feed | Sent by | Goes to (defaults) |
|---|---|---|
| **landscape** | OBS main output | Twitch, YouTube, Kick, Facebook, X, custom RTMP |
| **vertical** | [Aitum Vertical](https://aitum.tv/) plugin | Instagram, TikTok, YouTube (Shorts), Twitch Dual Format |

Each destination is bound to one feed, and you can change the routing per destination. You don't need both feeds: with only the main output, everything bound to `landscape` still works.

## Get the server and stream keys

In CTD Relay, open **Settings → OBS setup** (admins only). It shows:

- **Server:** `rtmp://<NAS-IP>:1935/live`. The host is the address you used to open the web UI. If you opened it through your public address, set **Settings → General → Ingest host** to the NAS's LAN IP so OBS uses the LAN address.
- **Stream key (landscape):** `landscape?key=…`
- **Stream key (vertical):** `vertical?key=…`

Copy them with the copy buttons rather than typing them. Each feed has its own random key, and only the right key can publish. Treat the keys like passwords. If one leaks, **rotate** it on the same page and paste the new key into OBS.

RTMP is LAN-only by design: never port-forward 1935. OBS must run on the same network as the server (or reach it over a VPN).

## Main output (landscape)

**Settings → Stream**

| Field | Value |
|---|---|
| Service | **Custom…** |
| Server | `rtmp://<NAS-IP>:1935/live` |
| Stream Key | `landscape?key=…` |
| Use authentication | off |

**Settings → Output** (Output Mode: **Advanced**) **→ Streaming**

| Setting | Recommended |
|---|---|
| Encoder | H.264: NVIDIA NVENC H.264, QuickSync H.264, AMD HW H.264 or x264. Not HEVC or AV1. |
| Rate control | **CBR** |
| Bitrate | **6000 Kbps or less** (4500 is a safe choice for 720p60) |
| Keyframe interval | **2 s** |
| Profile | high |

**Settings → Video:** output resolution **1920×1080** or **1280×720**, **60** or **30** fps.

**Settings → Audio:** sample rate **48 kHz**. **Settings → Output → Audio:** track bitrate **160** kbps (AAC).

## Vertical output (Aitum Vertical)

1. Install the free [Aitum Vertical](https://obsproject.com/forum/resources/aitum-vertical.1715/) plugin and restart OBS. It adds a second, vertical canvas with its own docks.
2. Open the plugin's settings (the gear icon in the **Vertical** dock) and its stream settings.
3. Add a stream output with server `rtmp://<NAS-IP>:1935/live` and stream key `vertical?key=…`.
4. Use these settings:

| Setting | Recommended |
|---|---|
| Canvas / output | **1080×1920** or **720×1280** |
| FPS | **30** |
| Encoder | H.264, **CBR**, about **4000 Kbps** |
| Keyframe interval | **2 s** |
| Audio | AAC **160** kbps, **48 kHz** |

Start the vertical stream from the Vertical dock's stream button. Aitum Vertical can also start it together with the main output; see its settings.

## Why these settings

The app **does not re-encode**: it copies video and audio to every platform as-is (`-c copy`). That keeps CPU use near zero, but each OBS output must suit the strictest platform bound to that feed:

- H.264 video with AAC audio is accepted everywhere. Other codecs are rejected by some platforms.
- A **2-second keyframe interval** is required or recommended by Twitch, YouTube, Kick, Facebook and the vertical platforms.
- **CBR at 6 Mbps or less** is within what Twitch recommends for most channels and is fine for the other landscape platforms.
- Upload bandwidth: the server sends one copy per destination. 6 Mbps to four landscape destinations plus 4 Mbps to three vertical ones is about 36 Mbps of upload from the server.

| Feed | Resolution | FPS | Video | Keyframe | Audio |
|---|---|---|---|---|---|
| Landscape | 1920×1080 or 1280×720 | 60 or 30 | H.264 CBR ≤ 6 Mbps | 2 s | AAC 160 kbps, 48 kHz |
| Vertical | 1080×1920 or 720×1280 | 30 | H.264 CBR ~4 Mbps | 2 s | AAC 160 kbps, 48 kHz |

## Going live

By default the app **goes live automatically when OBS starts streaming** (the **Auto go-live** switch on the dashboard). When a feed arrives, every enabled destination bound to it starts with the title currently set on the dashboard.

- Turn **Auto go-live** off to start and stop the session yourself with **Go live** / **End stream**.
- The dashboard shows each feed's state (resolution, fps, codec, bitrate) and each destination's phase: waiting for feed, preparing, connecting, confirming, live, retrying or error.
- If OBS drops for a moment, the app waits before ending anything (**Settings → General → Disconnect grace**, 15 s by default) and resumes the same lives when the feed returns.
- Platforms driven by the built-in browser (Instagram, TikTok) create a new live with a new key every time, wait for the preview to arrive and then click "Go live". That takes a little longer than API platforms.
- A failing destination retries on its own and never blocks the others.

## Test mode

To rehearse without going public, turn on **Test mode** on the dashboard (next to **Go live**) before you start. While it is on, every destination streams with its platform's private or test setting, and destinations whose platform has none are skipped, so nothing goes out publicly:

| Platform | In test mode |
|---|---|
| Twitch | Bandwidth test: Twitch receives the stream, but nobody sees it |
| YouTube | Private broadcast: only you can see it |
| Instagram | Practice audience: only you can see it |
| Facebook Page | Only you can see it |
| Facebook profile, Kick, TikTok, X, custom RTMP | Skipped (not started at all) |

- The switch can only change while no session runs: end the stream first, then switch.
- The dashboard shows an orange **TEST MODE** banner with what happens on each destination, and skipped destinations say "Skipped — *platform* has no test mode".
- Auto go-live still applies: if test mode is on when OBS starts streaming, the session starts in test mode. Turn it off before the real show.
- While test mode is on, the app never changes a channel title (Twitch, Kick): a channel title is public even during a Twitch bandwidth test. Your title is saved and used when you go live outside test mode. YouTube, Instagram and Facebook Page test lives get the title as usual, since only you can see them.
- Twitch in **OBS sends Dual Format directly** mode is not covered: OBS streams to Twitch itself, so the app can't make it private. For a private Twitch test in that mode, add `?bandwidthtest=true` to the end of the stream key in OBS's own Twitch settings (if your OBS version lets you edit it), or don't start OBS's Twitch output.

## OBS dock

The app's status and the merged chat can live inside OBS as a dock:

1. In CTD Relay, open **Settings → API** (admins) and use **OBS dock**. It creates a read-only API token (`status:read` + `chat:read`) named "OBS dock" and shows the dock URL, like `http://192.168.1.20:30080/dock#token=ctd_pat_…`. Copy it.
2. In OBS: **Docks → Custom Browser Docks…** (older OBS versions: **View → Docks → Custom Browser Docks…**). Enter a name (for example `CTD`), paste the URL and click **Apply**.
3. Place the dock where you like. It shows the session (with a TEST badge in test mode), feed bitrates, every destination (red when it is down, with the reason; tick **Alert** to also flash and beep), viewers, and the chat from every platform.

- The URL contains a token: treat it like a password. If it leaks, revoke the "OBS dock" token in **Settings → API** and create a new dock.
- The dock uses the NAS's LAN address over plain HTTP (no certificate needed in OBS). If **Settings → API** has no LAN address, open the web UI through the NAS's LAN IP (for example `https://192.168.1.20:30443`) or set the `LAN_HTTP_HOST` environment variable, then create the dock again.
- With `LAN_HTTP=off` the dock URL is HTTPS. With a self-signed certificate OBS's browser may refuse to load it, so prefer the LAN HTTP URL where it is safe (see [SECURITY.md](SECURITY.md#lan-plain-http)).

## Twitch Dual Format

Twitch can show viewers a landscape and a vertical version of the same stream ("Dual Format"). It uses Enhanced Broadcasting: several video tracks in one connection. Check your Twitch dashboard's stream settings to see whether Dual Format is available for your channel. Each Twitch destination has a **Dual Format** option with three modes. For Dual Format, either OBS sends it directly, or the app encodes it from your two feeds ("Relay both feeds").

### Relay one feed (default)

The app relays this destination's feed (normally landscape) to Twitch as a regular stream. Nothing special to set up in OBS.

### OBS sends Dual Format directly

OBS sends Dual Format straight to Twitch. CTD Relay sends **no video** to Twitch: it only keeps the Twitch title in sync and reads Twitch chat, and relays your feeds to every other platform.

1. In OBS **Settings → Stream**, set **Service: Twitch**, connect your account, turn on **Enhanced Broadcasting**, and pick the Aitum Vertical canvas as the additional canvas. Follow Twitch's and Aitum's current Dual Format instructions for your OBS version.
2. Your main output now goes to Twitch, so the app needs the landscape feed from an extra output. Add one with a multistream plugin, for example the free Aitum Multistream: Custom server `rtmp://<NAS-IP>:1935/live`, key `landscape?key=…`.
3. Point the Aitum Vertical canvas's stream output at the app as described above (`vertical?key=…`).
4. In the Twitch destination, set **Dual Format** to "OBS sends Dual Format directly".

Your PC uploads the Twitch stream itself. The extra outputs to the app stay on your LAN.

### Relay both feeds as Dual Format (Relay encodes them)

OBS only sends its two feeds to the app, and the app does what OBS's Enhanced Broadcasting would do:

1. It asks Twitch's Enhanced Broadcasting service for a configuration, with the same request OBS sends. Twitch insists on a supported encoding GPU, so the app describes one and, by default, says it is OBS Studio. You can change both on the Twitch destination: **GPU reported to Twitch** (or a **Custom GPU**) and **Client reported to Twitch**. The stream is still encoded on the server with x264, following the settings Twitch returns for that GPU.
2. It encodes the tracks Twitch asks for on the server with x264. Twitch requires at least two tracks per feed; the app asks for that minimum, typically 1080p60 + 360p30 for each feed.
3. It keeps the keyframes aligned across all tracks and adds the broadcast performance metrics Twitch requires before every keyframe.
4. It publishes the result to Twitch itself.

Expect about 12 Mbps of upload and a good share of the server's CPU while live. Both feeds must be online. Set the destination's **Landscape feed format** and **Vertical feed format** fields to what OBS sends (for example `1920x1080@60` and `1080x1920@60`); Twitch picks the tracks from them.

If Twitch refuses the configuration, the destination streams the landscape feed alone, with a warning on its card, and tries Dual Format again on the next live. Session test mode (a bandwidth test) is the safe way to try it first.

Reporting a GPU you don't have and a different client name is a workaround Twitch doesn't document. We don't know how Twitch treats it, so decide whether you're comfortable with that for your channel.

## Troubleshooting

| Problem | Check |
|---|---|
| OBS: "Failed to connect to server" | The server URL uses the NAS's LAN IP, port 1935 is mapped in the container, and no firewall blocks it. |
| OBS connects, then disconnects immediately | The stream key is wrong, was rotated, or was pasted into the wrong output (`landscape` vs `vertical`). |
| Feed shows offline on the dashboard | That OBS output isn't streaming. The vertical stream is started separately in the Vertical dock. |
| A platform rejects the stream | Video must be H.264 with a 2-second keyframe interval and AAC audio at 48 kHz. Lower the bitrate if the platform has a limit. |
| Destination stuck in "waiting for feed" | It is bound to a feed that isn't streaming. Change its feed or start that output. |
