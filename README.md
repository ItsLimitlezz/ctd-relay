<p align="center">
  <img src="web/public/favicon.svg" alt="CTD Relay icon" width="112" height="112">
</p>

<h1 align="center">CTD Relay</h1>

<p align="center"><strong>One OBS in, every platform out — self-hosted multistreaming you run on your own server.</strong></p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/INSTALL-TRUENAS.md">Install on TrueNAS</a> ·
  <a href="docs/API.md">API</a> ·
  <a href="LICENSE">AGPL-3.0</a>
</p>

<p align="center">
  <img src="docs/images/dashboard.png" alt="CTD Relay dashboard while live: both OBS feeds online with bitrates, the shared stream title and the combined chat" width="900">
</p>

An open-source alternative to Restream that you run yourself. OBS sends a **landscape** feed (its main output) and a **vertical** feed (the Aitum Vertical plugin) to your own server, which relays each one to the platforms that want it: Twitch, YouTube, Kick, Facebook, X, Instagram, TikTok and any custom RTMP server. One stream title is kept in sync everywhere, and every platform's chat lands in one combined view. It ships as a single Docker image that installs on TrueNAS in a few minutes, and no domain name is needed.

> [!NOTE]
> **Status: early.** The core relay, the API-based platforms and the web UI are the focus of the first releases. Browser-automated platforms (Instagram, TikTok, X, Facebook profile) are **experimental** and may break when those sites change. Relaying both feeds to Twitch as Dual Format is experimental too, and Twitch currently refuses it. Feedback and testers are very welcome.

## Features

- **Two feeds, many platforms.** Landscape and vertical from one OBS, each destination bound to the feed it needs, routing editable per destination.
- **No re-encoding.** Video and audio are copied as-is, so CPU use stays near zero even on a NAS.
- **Goes live when OBS does.** Auto go-live when the feed arrives (or manual), per-destination health and stats, automatic retries, and short OBS disconnects ridden out without ending the lives.
- **One title everywhere.** Set it once and it's pushed to every platform, before and during the stream. The category or game is never touched.
- **Combined chat** (read-only) from all platforms, plus a chat overlay for an OBS browser source.
- **Twitch Dual Format**: relay one feed, or let OBS send Dual Format directly while the app manages title and chat (the recommended way to get Dual Format). Relaying both feeds as Dual Format is experimental: Twitch currently refuses it, so use OBS direct.
- **Built-in browser automation** for platforms without an API: you log in by hand in a live view of the app's browser, and the app creates the live, reads the per-stream key and clicks "Go live".
- **Profiles.** Independent set-ups (your own channel, a club night…), each with its own accounts, destinations, title and OBS keys, and several can be live at once.
- **Stream Guard** for Instagram: notices when a live is taken down, starts a fresh one automatically and rotates the link you attach to each live.
- **A hub for your other apps.** An API with live events, chat, viewers, OBS state and feed previews, plus a shared timecode clock, so [CTD Overlay](https://github.com/ItsLimitlezz/ctd-overlay), the CTD OBS plugin and CTD Live mobile work together through Relay. Phones connect by scanning a QR code, on Wi-Fi or mobile data.
- **OBS dock**: status, bitrates, destinations and chat in a panel inside OBS.
- **Secure by default** for a web UI on the internet: automatic HTTPS (Let's Encrypt certificate for your IP, no domain needed), first-run setup code, Argon2id passwords, lockout, CSRF protection, encrypted secrets, roles, audit log, optional 2FA.
- **Easy to host**: one multi-arch image (amd64 and arm64), TrueNAS "Install via YAML", or Docker Compose anywhere.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/images/profiles.png" alt="Profiles: independent streaming set-ups that can be live at the same time"><br><sub><b>Profiles</b>: separate set-ups, live at the same time</sub></td>
    <td width="50%"><img src="docs/images/destinations.png" alt="Destinations grouped by the OBS feed they use"><br><sub><b>Destinations</b>: each one bound to the landscape or vertical feed</sub></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/images/connect-phone.png" alt="Connect a phone: a one-time QR code for CTD Live mobile" width="760"><br><sub><b>Connect a phone</b>: CTD Live mobile scans a one-time QR code and connects over Wi-Fi or mobile data</sub></td>
  </tr>
</table>

## How it fits

<p align="center"><img src="docs/images/ctd-family.png" alt="The CTD app family" width="900"></p>

CTD Relay sits in the middle: OBS streams to it, it streams to every platform, and the other CTD apps connect to it instead of to each other.

- **[CTD Overlay](https://github.com/ItsLimitlezz/ctd-overlay)** reads chat, alerts and viewers from Relay and registers its overlays per profile; overlays can follow the OBS scene.
- **CTD OBS plugin** sets up OBS from Relay (stream keys per profile), adds overlays as browser sources and reports OBS's state back.
- **CTD Live mobile** controls OBS from your phone from anywhere (Relay relays its OBS connection, so OBS is never exposed to the internet), and shows status, chat, OBS issues and feed previews.

All of them use the same documented API: [docs/API.md](docs/API.md) ([quick start](docs/API-QUICKSTART.md)).

## Platforms

| Platform | Feed(s) | Stream key | Title | Chat (read) | Notes |
|---|---|---|---|---|---|
| Twitch | landscape (+ vertical via Dual Format) | Official API | Official API | Twitch chat | Dual Format: OBS direct (relaying both feeds is experimental; Twitch currently refuses it) |
| YouTube | landscape and/or vertical | Official API (a broadcast per stream) | Official API | Official API | Chat polling uses the daily API quota |
| Kick | landscape | Pasted once | Official API | Public chat feed | |
| Facebook Page | landscape | Official API | Official API | Official API | Your own Meta app in development mode |
| Facebook profile | landscape | Persistent key, pasted once | Browser | Browser | Experimental |
| X | landscape | Live Studio source, pasted once | Browser | Browser | Experimental. Needs X Premium, select regions |
| Instagram | vertical | Browser, new key every stream | Browser | Browser | Experimental. Public account with 1,000+ followers |
| TikTok | vertical | Browser, new key every stream | Browser | Browser | Experimental. Needs LIVE stream key access |
| Custom RTMP | either | Pasted once | — | — | Trovo, Owncast, another restreamer… |

"Browser" means a Playwright-driven Chromium inside the container. Twitch, YouTube, Kick and Facebook Page need a free developer app that you register once; [PLATFORMS.md](docs/PLATFORMS.md) walks through each one.

## Quick start

### TrueNAS

Follow **[docs/INSTALL-TRUENAS.md](docs/INSTALL-TRUENAS.md)**. In short: create a dataset, then **Apps → Discover Apps → ⋮ → Install via YAML** with [`deploy/truenas/ctd-relay.yaml`](deploy/truenas/ctd-relay.yaml), and forward public ports 443 → 30443 and 80 → 30080 on your router.

### Docker Compose (any Linux host)

```bash
git clone https://github.com/ItsLimitlezz/ctd-relay.git && cd ctd-relay
cp .env.example .env                           # set CTD_IMAGE=ghcr.io/itslimitlezz/ctd-relay:latest,
                                               # or leave it unset to build from source
mkdir -p data && sudo chown 568:568 data       # the container runs as uid/gid 568
docker compose up -d
docker compose logs | grep setupCode           # one-time code to create the admin account
```

Open `https://<server-ip>` (accept the self-signed certificate on first start), enter the setup code and create your admin account. Forward public TCP 443 → server 443 and 80 → server 80 for remote access and an automatic Let's Encrypt certificate. **Never forward 1935.**

Forgot a password or lost your 2FA authenticator, and no other admin can reset it in **Settings → Users**? Run the recovery command inside the container. It prints a new password once, turns off 2FA and signs the user out everywhere; then change the password under **Profile**:

```bash
docker compose exec ctd-multi-stream node dist/server/src/cli.js list-users
docker compose exec ctd-multi-stream node dist/server/src/cli.js reset-password <username>
# plain Docker: docker exec -it <container> node dist/server/src/cli.js reset-password <username>
```

TrueNAS: see [Account recovery](docs/INSTALL-TRUENAS.md#account-recovery).

### Then

1. [Set up OBS](docs/OBS-SETUP.md): main output and Aitum Vertical to `rtmp://<server-ip>:1935/live`.
2. [Connect platforms](docs/PLATFORMS.md) and create destinations.
3. Set a title on the dashboard and start streaming in OBS.

## Documentation

| Document | For |
|---|---|
| [INSTALL-TRUENAS.md](docs/INSTALL-TRUENAS.md) | Installing, port forwarding, HTTPS options, backups, updates |
| [OBS-SETUP.md](docs/OBS-SETUP.md) | OBS and Aitum Vertical settings, going live, Twitch Dual Format |
| [PLATFORMS.md](docs/PLATFORMS.md) | What each platform supports and how to connect it, including developer apps |
| [SPOTIFY.md](docs/SPOTIFY.md) | Now playing on stream and `!sr` song requests from chat |
| [SECURITY.md](docs/SECURITY.md) | What is exposed, how it's protected, reporting vulnerabilities |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | Running from source, tests, releasing, adding a platform |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Design and roadmap |
| [CONTRACTS.md](docs/CONTRACTS.md) | Module contracts and conventions for contributors |
| [API.md](docs/API.md) · [API-QUICKSTART.md](docs/API-QUICKSTART.md) | The external API for other apps: events, chat, status, OBS state, previews, pairing, phones |

## Third-party software

The Docker image bundles [MediaMTX](https://github.com/bluenviron/mediamtx) (MIT), static [FFmpeg](https://ffmpeg.org/) builds from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (GPL), and [Chromium](https://www.chromium.org/) via [Playwright](https://playwright.dev/) (Apache-2.0 and BSD-style licenses). Their licenses apply to those components.

## License

[AGPL-3.0](LICENSE). If you run a modified version as a service, you must publish your source code under the same license.
