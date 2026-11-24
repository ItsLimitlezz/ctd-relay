# Development

How to run, test and extend CTD Relay from source on Windows or Linux. The design is in [ARCHITECTURE.md](ARCHITECTURE.md). Module boundaries, interfaces and coding rules are in [CONTRACTS.md](CONTRACTS.md).

## Requirements

- **Node.js 24.7 or newer** (`node --version`). The server uses the built-in `node:sqlite` and `crypto.argon2`.
- npm (bundled with Node) and Git.
- Windows 10/11 or Linux, x64 or arm64. macOS works for most things, but `setup-tools` has no pinned builds there: run `brew install ffmpeg mediamtx` and point `MEDIAMTX_BIN` / `FFMPEG_BIN` at them.

## First-time setup

```bash
npm ci
npm run setup-tools                 # pinned, checksum-verified MediaMTX + FFmpeg/ffprobe into ./tools
npx playwright install chromium     # Linux: npx playwright install --with-deps chromium
```

`./tools`, `./data` and `./dist` are git-ignored.

## Run locally

Run the server with HTTPS off, so it serves plain HTTP on port 8443:

```powershell
# Windows PowerShell
$env:TLS_MODE = 'off'; npm run dev
```

```bash
# Linux
TLS_MODE=off npm run dev
```

- The server restarts on changes (`tsx watch`). Data goes to `./data` (database, `master.key`, MediaMTX config).
- On the first start the terminal prints a setup code: look for `setupCode`. You need it to create the admin account.
- RTMP ingest listens on `rtmp://127.0.0.1:1935/live`. Point OBS on the same machine there.
- Locked out of a local instance: `npm run cli -- list-users` and `npm run cli -- reset-password <username>` (same `DATA_DIR` as the server; it can keep running). In the image the same commands are `node dist/server/src/cli.js …`.

For the web UI, run the Vite dev server in a second terminal:

```bash
npm run dev:web     # http://localhost:5173
```

It proxies `/api` and `/overlay` (including WebSockets) to `http://127.0.0.1:8443`. Set `CTD_DEV_API` to use another backend address. Alternatively, `npm run build:web` once and open `http://localhost:8443`: the server serves `dist/web` when it exists.

Useful environment variables while developing (all in [`.env.example`](../.env.example)):

| Variable | Use |
|---|---|
| `TLS_MODE=off` | Plain HTTP, no certificate handling |
| `TLS_MODE=self-signed` | Test the HTTPS path without Let's Encrypt (`https://localhost:8443`) |
| `BROWSER_HEADLESS=false` | Show the automation browser's window, handy when writing selectors |
| `LOG_LEVEL=debug` | More detail, including MediaMTX output |
| `DATA_DIR` | Use another data folder, e.g. a throwaway one |

`npm run dev` doesn't read `.env` files. Set variables in the shell, or run `node --env-file=.env …` yourself.

### Going live locally without OBS or a platform

`npm run dev:sim` (scripts/dev-sim.mts) turns a running dev server into a complete live rig:

- **Fake OBS:** it publishes FFmpeg test patterns to the landscape (1920x1080@60) and vertical (1080x1920@30) feeds, with 2 s keyframes, and restarts them if they stop.
- **Fake platform:** it starts a fake RTMP platform on `127.0.0.1:19400` and points a Custom RTMP destination, "Local sink (dev-sim)", at it.

Start a session in the web UI (or turn on auto go-live) and Relay goes live end to end: the feed cards, destination cards and stats all move. Press Ctrl+C to stop everything.

It signs in with `SIM_USER` / `SIM_PASS`, else with `data-dev/TEST-CREDENTIALS.txt` (git-ignored). `SIM_BASE` sets the server address (default `http://localhost:8443`), `SIM_SINK_PORT` the fake platform's port, and `SIM_VERTICAL=0` sends landscape only.

## Tests and checks

```bash
npm run typecheck                       # server + shared (tsconfig.test.json) and web (web/tsconfig.json)
npm test                                # Vitest, two projects (vitest.config.ts):
                                        #   server: server/src/**/*.test.ts, shared/**/*.test.ts, scripts/**/*.test.{ts,mjs}
                                        #   web:    web/src/**/*.test.{ts,tsx}
npx vitest run server/src/media         # one folder
npx vitest run --project web            # one project
npx vitest list --filesOnly             # which files each project collects
npm run build                           # dist/server + dist/web
npm run smoke                           # end-to-end media relay test with the real binaries in ./tools
npm run e2e:preview                     # feed previews in the real web UI (Chromium), real Relay + binaries
npx tsx scripts/preview-stress.ts       # live preview resource safety (~15 min): restream with 4 players, cap, killed tab, frozen network, 100 cycles
npx tsx scripts/transcode-cpu.ts        # transcoding CPU cost (~4 min): copy vs libx264 720p30/720p60/1080p30/1080p60 through MediaMTX, next to the CPU guard's estimate
```

- Tests never touch the network or real platform accounts. Platform drivers are tested with stubbed `fetch` and local HTML fixtures.
- Browser tests drive a real headless Chromium. Set `CI_NO_BROWSER=1` to skip them on machines without it.
- The smoke test starts MediaMTX and FFmpeg on non-default ports, publishes a test pattern, checks that a wrong key is rejected, relays to a local fake platform and prints PASS or FAIL.
- `npm run e2e:preview` builds the web UI, starts Relay (TLS off, temp data dir, free ports) with its MediaMTX, publishes two FFmpeg test patterns, and drives the dashboard in Playwright's Chromium: thumbnails (aspect, refresh), **Watch** (LL-HLS through Relay, muted, delay), sound and meter, the muxer stopping after the player closes, the HEVC warning and the Profiles page. It also prints the CPU and RAM Relay and MediaMTX use with nobody watching, thumbnails, and 1 and 3 players (`--quick` skips that). `PREVIEW_E2E_SHOTS=<dir>` saves screenshots; `CHROMIUM_PATH=<binary>` uses another Chromium (it needs H.264, which Playwright's builds have).
- `scripts/transcode-cpu.ts` (Linux) is transcoding's CPU check from the 0.2.80 Senior check: the pinned MediaMTX with a 1080p60 H.264 test feed, then a copy push and four libx264 transcodes built exactly as Relay builds them, each measured from /proc over `TC_SECONDS` (default 30), printed next to this machine's capability probe and the CPU guard's estimate (docs/TRANSCODING.md §0). Run it on the server itself for its own numbers.
- `scripts/preview-stress.ts` (Linux) is the live preview's resource-safety check from the 0.2.60 Senior check: the outgoing restream's fps, bitrate and longest stall at a fake platform with no player and with 4 players; the viewer cap with 12 logins opening at once; 20 opens abandoned during a cold start; the browser killed and the network frozen (no FIN/RST) while playing; 100 open/play/close cycles with file descriptors and sockets compared before and after; no thumbnail requests from a hidden page. `STRESS_CPUS=0` pins Relay and its children to CPU 0 (a weak server), `STRESS_PHASES=restream,cap,…` picks phases, `STRESS_CYCLES` sets the cycle count.
- `server/src/media/transcode.integration.test.ts` transcodes small test feeds with a real FFmpeg (software encoders) and checks what the fake platform received with ffprobe. It is part of `npm test` and skips itself when there is no `./tools/ffmpeg` (after `npm run setup-tools` it runs); `FFMPEG_BIN=/path/to/ffmpeg npm test` uses another build (ffprobe must sit next to it).
- CI (`.github/workflows/ci.yml`) runs the same typecheck, tests and build on every push and pull request.

## Production build without Docker

```bash
npm ci && npm run build
npm start      # node dist/server/src/index.js
```

Set `DATA_DIR`, `MEDIAMTX_BIN`, `FFMPEG_BIN` and `WEB_DIR` as needed. The image sets them for you (see the `Dockerfile`).

## Docker

```bash
docker build -t ctd-relay .
docker compose up -d --build                  # build from this checkout and run (see docker-compose.yml)
docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/itslimitlezz/ctd-relay .
```

The `Dockerfile` is multi-stage: build on the host's architecture, install production dependencies and Playwright Chromium for the target architecture, and download the pinned MediaMTX/FFmpeg builds with `scripts/setup-tools.mjs`. The runtime image runs as uid/gid 568 with `tini` as PID 1, and its health check is `scripts/healthcheck.mjs`.

## Releasing

1. Bump `version` in `package.json` (the app reports it in **Settings → About** and `/healthz`).
2. Tag the commit `vX.Y.Z` and push the tag.
3. `.github/workflows/docker.yml` builds `linux/amd64` and `linux/arm64` and pushes `ghcr.io/itslimitlezz/ctd-relay:X.Y.Z` (and the same tags under the pre-rename `ctd-multi-stream`), `:X.Y` and `:latest`. Every push to `main` publishes `:main` and `:sha-<commit>`.

The first time the workflow publishes, GitHub creates the package as **private**. Make it public (the package's **Package settings → Change visibility**) so TrueNAS and Docker hosts can pull it without logging in.

## Project layout

```
shared/                 types + REST/WebSocket contract shared by server and web
server/src/
  index.ts, main.ts     entry point and composition root
  config.ts             environment variables
  services.ts           service interfaces (AppServices)
  events.ts             typed event bus
  db/                   SQLite (node:sqlite) repositories
  security/             secret box, passwords, TOTP, setup code, login guard
  tls/                  Let's Encrypt (IP + domain), self-signed, HTTP-01 listener
  media/                MediaMTX ingest, FFmpeg push supervisor
  orchestrator/         go-live engine (prepare -> push -> confirm -> live -> end)
  browser/              Playwright manager, login viewer, driver helpers
  chat/                 chat hub and OBS overlay
  platforms/<id>/       one driver per platform; common/ has HTTP and OAuth helpers
  http/                 Fastify app, auth plugin, routes
web/src/                React 19 SPA (talks to the server only through web/src/api.ts)
scripts/                setup-tools, smoke test, container health check
deploy/truenas/         TrueNAS "Install via YAML" file
```

[CONTRACTS.md](CONTRACTS.md) lists who owns which module, the storage conventions (settings keys, secret scopes) and the security rules every module follows.

## Adding a platform

A platform is a **driver**: a stateless object implementing `PlatformDriver` from `server/src/platforms/types.ts`.

1. Add the id to `PlatformId` and `PLATFORM_IDS` in `shared/types.ts`.
2. Create `server/src/platforms/<id>/index.ts` exporting `export const <id>Driver: PlatformDriver`, and register it in `server/src/platforms/registry.ts`.
3. Describe the platform in `info` (`PlatformInfo`): accepted `feeds` and `defaultFeed`, `connectMethod`, `accountFields`, `destinationFields` (with `target: 'ingestUrl' | 'streamKey'` for server URLs and keys), `developerApp` (console URL, fields, numbered setup steps), `titleSupport`, `chatSupport`, `keyPerSession`, `experimental` and short `notes`. The web UI renders all forms from this, so no UI code is needed.
4. Implement the connection: `startConnect` / `pollConnect` (device code) or `completeConnect` (OAuth paste-back, token paste, browser login), plus `checkAccount`. Use the helpers in `platforms/common/oauth.ts`. Store tokens only through `ctx.accountSecrets`.
5. Implement `prepare(dest, account, title, ctx)`: set the title (**only** the title, never the category or game), get the ingest URL and key, create the live if the platform needs one, and return a `PreparedLive`: `push` (`{ url, mode: 'copy', feeds }`), and optionally `watchUrl`, `confirm` (e.g. click "Go live" once video arrives), `setTitle`, `end` and `chat`.
6. Browser-driven platforms: get pages from `ctx.browser.page(account.id)`, use the helpers in `server/src/browser/helpers.ts`, keep every selector in `selectors.ts`, prefer role and text locators, save the session after successful flows, and throw `DriverError(…, 'needs-login')` when logged out.
7. Rules: throw `DriverError` with the right code for anything the user must fix (the message is shown verbatim); pass `ctx.signal` to every request and wait; never log stream keys, tokens or URLs that contain them.
8. Tests in the driver folder: stub `fetch` for API flows, serve HTML fixtures from a local `node:http` server for browser flows.
9. Document it in [PLATFORMS.md](PLATFORMS.md) and the README's platform table.
