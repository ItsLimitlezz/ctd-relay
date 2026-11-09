# CTD Relay: Architecture

> Status: **draft**. Agreed in design discussion on 2026-10-11. Items marked _(verify)_ get confirmed during Phase 0.

CTD Relay is a self-hosted, open-source alternative to Restream. It receives a landscape and a vertical feed from OBS and relays each one to the platforms that accept it. It also sets one shared stream title everywhere and combines every platform's chat into one view. It ships as a single Docker image that installs on TrueNAS.

License: **AGPL-3.0**.

---

## 1. Requirements

| # | Requirement |
|---|---|
| R1 | Accept two feeds from OBS: **landscape** (OBS main output) and **vertical** (Aitum Vertical plugin). |
| R2 | Relay to Twitch, YouTube, Kick, Facebook, X, Instagram and TikTok, each bound to the right feed. |
| R3 | Twitch receives both feeds (Dual Format). Instagram and TikTok receive vertical only. |
| R4 | One shared stream title, pushed to every platform. **Never change the category.** |
| R5 | Built-in Playwright handles platforms without an API: login sessions, per-stream keys, the "Go Live" click. |
| R6 | Read-only combined chat view across all platforms. |
| R7 | The web UI is exposed to the internet through a port forward, so secure login is mandatory. |
| R8 | Built for one user or a small organization. |
| R9 | Easy install on TrueNAS (Docker image plus "Install via YAML"). No domain name required. |

Non-goals for now: replying to chat, re-encoding (transcoding), multi-tenant SaaS.

---

## 2. Platform matrix

Every destination is bound to exactly one feed. The defaults are below; the user can change routing per destination.

| Platform | Feed(s) | Stream key | Title | Chat (read) | Notes |
|---|---|---|---|---|---|
| Twitch | landscape + vertical | Official API | Official API | Official API (EventSub/IRC) | Dual Format runs on Enhanced Broadcasting (multitrack). See §5.3. |
| YouTube | landscape + vertical | Official API (two broadcasts) | Official API | Official API | Chat polling uses daily quota _(verify)_. |
| Kick | landscape | Static, pasted once | Official API | Official webhooks or public websocket _(verify)_ | |
| Facebook (Page) | landscape | Persistent key, pasted once | Graph API _(verify)_ | Graph API | |
| Facebook (profile) | landscape | Persistent key, pasted once | Browser | Browser | |
| X | landscape | Reusable "source", pasted once | Browser | Browser | Needs X Premium / Live Studio (region-limited). |
| Instagram | vertical | Browser, **new key each stream** | Browser | Browser | Use "Practice" audience for testing. |
| TikTok | vertical | Browser, **new key each stream** | Browser | Unofficial library or browser | Stream key gated (~1,000 followers, 18+). |

"Browser" means a Playwright driver (§6).

---

## 3. System overview

```
 OBS main output  ──RTMP──┐                      ┌─► FFmpeg ─► Twitch, YouTube, Kick, Facebook, X
                          ├─► MediaMTX (ingest) ─┤
 Aitum Vertical   ──RTMP──┘        │ hooks       └─► FFmpeg ─► Instagram, TikTok, YouTube (vertical)
                                   ▼
                     ┌──────── Control plane (Node / TypeScript) ────────┐
                     │  Web UI + REST + WebSocket   (HTTPS, auth)        │
                     │  Session & go-live orchestrator                   │
                     │  Platform drivers: API │ Browser (Playwright)     │
                     │  FFmpeg process supervisor                        │
                     │  Chat aggregator                                  │
                     │  SQLite + encrypted secrets  (/data)              │
                     └───────────────────────────────────────────────────┘
```

All of this runs in **one container**. The control plane supervises MediaMTX, the FFmpeg children and Chromium.

### Components

| Component | Responsibility |
|---|---|
| **MediaMTX** | Receives RTMP (and later SRT) from OBS on paths `live/landscape` and `live/vertical`. Publish auth and publish/unpublish events go to the control plane via HTTP hooks. |
| **FFmpeg supervisor** | Runs one FFmpeg process per active destination. Copies video and audio through untouched (`-c copy`). Restarts with backoff on failure and reports bitrate, fps and dropped frames. |
| **Orchestrator** | Runs the go-live / end sequence across destinations (§4). |
| **Platform drivers** | One module per platform behind a common interface (§6). |
| **Browser worker** | Playwright Chromium with one persistent profile per connected account. Streams a live view to the web UI for manual login. |
| **Chat aggregator** | Normalizes chat from every platform into one message stream and delivers it over WebSocket. |
| **Web UI** | Dashboard, destinations and routing, title, account connections, chat view, users, settings. |
| **Storage** | SQLite at `/data/app.db`. Browser profiles at `/data/browser/`. Secrets encrypted at rest (§7). |

---

## 4. Go-live sequence

Default behavior, matching Restream: **go live automatically when OBS starts streaming**, using the title already set in the UI. A "manual arm" mode is available as a setting.

1. OBS starts. MediaMTX accepts `live/landscape` and/or `live/vertical` and fires a publish hook.
2. For each enabled destination bound to that feed, the orchestrator runs:
   - **prepare**: set the title (API or browser) and get ingest URL + key. A browser platform creates the live here and reads the new key.
   - **push**: start FFmpeg from the MediaMTX path to the ingest URL.
   - **confirm**: browser platforms wait for the platform's preview to appear, then click "Go Live".
3. While live: monitor health. A failed push restarts with backoff without affecting other destinations.
4. Title changes mid-stream go to every platform that supports live title edits.
5. OBS stops (unpublish hook). The orchestrator stops the pushes and ends lives where an explicit end is needed (browser platforms, YouTube).

Destinations fail independently. One platform failing never blocks the others. The UI shows the state of each destination.

---

## 5. Media

### 5.1 Ingest
- RTMP on port 1935, **LAN only** (not port-forwarded). Each feed has its own randomly generated key.
- SRT with a passphrase later, for remote org members.

### 5.2 Output
- Default: passthrough (`-c copy`). Near-zero CPU.
- RTMPS where the platform supports it.
- Because nothing is re-encoded, each OBS output must suit the strictest platform on that feed. Starting points _(verify in Phase 0)_:

| Feed | Resolution | FPS | Video | Keyframe | Audio |
|---|---|---|---|---|---|
| Landscape | 1920×1080 or 1280×720 | 60 or 30 | H.264 CBR ≤ 6 Mbps | 2 s | AAC 160 kbps, 48 kHz |
| Vertical | 1080×1920 or 720×1280 | 30 | H.264 CBR ~4 Mbps | 2 s | AAC 160 kbps, 48 kHz |

- Later: optional per-destination transcoding, hardware-gated (design: [TRANSCODING.md](TRANSCODING.md)).

### 5.3 Twitch Dual Format
Twitch Dual Format uses **Enhanced Broadcasting**: several video tracks (landscape and vertical) inside one Enhanced-RTMP connection, negotiated through Twitch's client configuration endpoint. Restream does not appear to support it, so supporting it would set this project apart.

- **Approach A (built, Oct 2026):** the server does what OBS's Enhanced Broadcasting does:
  1. It calls GetClientConfiguration with the same request as OBS, describing a supported GPU (Twitch refuses clients without one). The reported GPU and client are options on the destination (`platforms/twitch/reported-gpus.ts`).
  2. It encodes the returned tracks from the two feeds with x264 (constant bitrate, IDRs aligned on a shared clock). That is at least two per canvas, Twitch's minimum.
  3. It publishes the Enhanced FLV with its own RTMP client (`media/rtmp-publisher.ts`), inserting the broadcast performance metrics SEI that IVS requires before every IDR (`media/bpm.ts`, `media/ivs-forwarder.ts`).

  Twitch's requirements and the probes behind them are in `platforms/twitch/multitrack.ts`.
- **Approach B:** OBS + Aitum send Dual Format straight to Twitch. CTD Relay still manages Twitch's title and chat and relays to everything else.

---

## 6. Platform drivers

Common interface (sketch):

```ts
interface PlatformDriver {
  id: PlatformId;
  feeds: Feed[];                       // which feeds this platform accepts
  connect(): Promise<ConnectFlow>;     // device code, paste-back, or browser login
  status(): Promise<AccountStatus>;
  prepare(title: string, feed: Feed): Promise<Ingest>;   // { url, key }
  confirm?(): Promise<void>;           // e.g. click "Go Live"
  setTitle(title: string): Promise<void>;
  end?(): Promise<void>;
  chat?(): AsyncIterable<ChatMessage>;
}
```

### 6.1 Account connection without a domain
Open-source self-hosted apps can't ship shared API secrets, so each user registers a free developer app per platform. A guided setup page walks through it.

| Platform | Connection method |
|---|---|
| Twitch | OAuth **device code flow**. The user enters a code at twitch.tv/activate. No redirect URL needed. |
| YouTube | Google OAuth **device flow** (`youtube` scope is supported). The app must be set to "In production", or refresh tokens expire after 7 days. |
| Kick | OAuth with PKCE and a paste-back of the redirect URL _(verify)_. |
| Facebook Page | Graph API token via paste-back _(verify)_. |
| Facebook profile, X, Instagram, TikTok | Browser login (§6.2). |

### 6.2 Browser automation
- One persistent Chromium profile per account at `/data/browser/<platform>/<account>/`.
- **Manual login only.** The web UI shows a live view of the Playwright browser (CDP screencast plus input relay). The user logs in by hand, including 2FA and captchas. **Passwords are never stored or typed by the app.** When a session expires, the UI asks the user to log in again.
- Selectors and flows live in each driver so a platform UI change is a small, contained fix.
- Testing uses non-public modes wherever they exist: Instagram "Practice", Twitch `?bandwidthtest=true`, YouTube private broadcasts.

---

## 7. Security

The web UI is port-forwarded to the internet, so security is a core requirement, not polish.

- **HTTPS without a domain.** Automatic Let's Encrypt **IP address certificate** for the public IP. These are short-lived (about 6 days) and renew automatically. They are re-issued when the home IP changes. Validation uses HTTP-01, so public port 80 must reach the app's HTTP port (TLS-ALPN-01 on 443 only is a possible later improvement). Optional: bring your own domain or reverse proxy. Fallback: a self-signed certificate with a visible fingerprint.
- **Only the web port is forwarded.** RTMP ingest (1935) stays on the LAN.
- **Authentication:** username + password with Argon2id hashing, per-IP and per-account rate limiting with lockout, `HttpOnly` + `Secure` + `SameSite=Strict` session cookies, CSRF protection, strict CSP. TOTP 2FA is **optional, off by default**, as a setting for users who want it.
- **First-run claim:** creating the admin account needs a one-time setup code printed in the container logs, so nobody who finds the port first can claim the instance.
- **Roles:** `admin` (users, account connections, browser login view, settings) and `operator` (go live, title, chat, health).
- **Secrets at rest:** stream keys, OAuth tokens and browser profiles are encrypted with AES-256-GCM. The master key comes from an env var / Docker secret, or is generated on first run.
- **Audit log** of logins, connection changes and go-live actions.
- The browser login view is the most sensitive surface (it holds platform sessions) and is admin-only.

---

## 8. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Ingest | MediaMTX | Proven, small, RTMP/SRT, auth and event hooks. |
| Relay | FFmpeg | Industry standard, passthrough, E-RTMP support improving. |
| Backend | Node.js + TypeScript | Playwright works best in Node. One language for the whole app. |
| Browser | Playwright (Chromium) | Persistent contexts, CDP screencast for the login view. |
| Database | SQLite | One file on the NAS dataset, trivial backup. |
| Frontend | TypeScript SPA served by the backend | Single port, single image. |
| Packaging | One Docker image (GHCR) | TrueNAS "Install via YAML"; also runs on any Docker host or VPS. |

---

## 9. Deployment (TrueNAS)

- Image: `ghcr.io/itslimitlezz/ctd-relay:<version>` (also published as `ctd-multi-stream`, the pre-rename name).
- Volume: `/data` (database, browser profiles, certificates, logs) on a TrueNAS dataset.
- Ports: `443` web (forwarded), `80` optional for HTTP-01 (forwarded), `1935` RTMP (LAN only).
- Install: TrueNAS → Apps → Discover → **Install via YAML** with the compose file from the repo. Later: submit to the TrueNAS community app catalog.

---

## 10. Phases

### Phase 0: de-risk (spikes, run on a dev PC)
1. **Twitch Dual Format through the relay** (Approach A vs B, §5.3).
2. **Instagram go-live end to end:** browser login, create live with title, read key, push a test pattern, click Go Live, end. Uses "Practice" audience.
3. **TikTok:** deferred until an account with stream key access is available for testing.

### Phase 1: core relay
Both feeds in. Destinations and routing UI. Paste-a-key platforms. Twitch and YouTube via device flow. Kick title. Shared title. Live health view. Secure login + HTTPS. Docker image + TrueNAS YAML.

### Phase 2: browser automation
Browser login view. Instagram, TikTok, X and Facebook-profile drivers (keys, titles, Go Live, End).

### Phase 3: chat aggregation
Read-only combined chat view across all platforms.

### Phase 4: extras
Twitch Dual Format through the relay (if Phase 0 succeeds), GPU transcoding, SRT ingest for remote members, TrueNAS catalog submission.

---

## 11. Open risks

| Risk | Impact | Mitigation |
|---|---|---|
| Twitch refuses Relay's configuration request or drops its multitrack stream | No server-side Dual Format | The destination falls back to the landscape feed alone; Approach B (OBS sends to Twitch directly). |
| Instagram/TikTok/X UI changes | Browser drivers break | Contained selectors per driver, clear error states, fast patch releases. |
| Bot detection on browser platforms | Session flagged | Manual login only, persistent profiles, human-paced actions. |
| YouTube chat quota | Chat stops mid-stream | Evaluate streaming chat endpoint; adaptive polling. |
| TikTok/X access gated | Can't test locally | Community testers; mark drivers experimental. |
| Let's Encrypt IP certs need 443/80 forwarded | No auto-HTTPS | Self-signed fallback or user's own reverse proxy. |
