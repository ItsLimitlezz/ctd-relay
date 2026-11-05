# AGENTS.md — ctd-relay
> Team rules live in the hub: github.com/ItsLimitlezz/CTD-Software-Suite → AGENTS.md (read it first). This file is repo-specific.

## What this is
**CTD Relay** (package `ctd-relay` v0.1.0, status "early"): self-hosted multistreaming server. OBS sends a landscape and a vertical RTMP feed; Relay copies each (no re-encode) to Twitch, YouTube, Kick, Facebook, X, Instagram, TikTok and custom RTMP, keeps one title, merges chat, and is the API hub the other CTD apps (OBS plugin, Overlay, Live mobile) connect through.
Runs as one multi-arch Docker image (amd64/arm64; TrueNAS or Docker Compose) or from source on Windows/Linux. Public repo, AGPL-3.0 (open-source).

## Layout
| Path | What |
| --- | --- |
| `server/src/` | Fastify + TypeScript backend: `main.ts` (composition root), `media/` (MediaMTX + FFmpeg push), `orchestrator/` (go-live), `platforms/<id>/` (one driver per platform), `browser/` (Playwright), `chat/`, `music/`, `db/` (node:sqlite), `security/`, `tls/`, `http/`, `api/` |
| `shared/` | `types.ts`, `api.ts`: contract shared by server and web |
| `web/` | React 19 + Vite SPA (talks to the server only via `web/src/api.ts`) |
| `scripts/` | `setup-tools.mjs` (pinned MediaMTX + FFmpeg), `smoke-test.ts`, `dev-sim.mts`, `healthcheck.mjs` |
| `deploy/truenas/` | TrueNAS "Install via YAML" file |
| `Dockerfile`, `docker-compose.yml`, `.env.example` | Image and run config |
| `docs/` | API, ARCHITECTURE, CONTRACTS, DEVELOPMENT, PLATFORMS, SECURITY, install/OBS guides |

## Build & test
All non-Apple, so test builds run on the **PC**. Needs Node >= 24.7 (built-in `node:sqlite`, `crypto.argon2`). From `docs/DEVELOPMENT.md`:
- Setup: `npm ci` · `npm run setup-tools` · `npx playwright install chromium`
- Checks: `npm run typecheck` · `npm test` (Vitest, projects `server` and `web`) · `npm run build` · `npm run smoke` (end-to-end with real MediaMTX/FFmpeg in `./tools`)
- Run locally: `TLS_MODE=off npm run dev` (PowerShell: `$env:TLS_MODE='off'; npm run dev`), web UI `npm run dev:web`, fake rig `npm run dev:sim`. Server is at http://localhost:8443; setup code is printed in the log.
- Docker: `docker build -t ctd-relay .` / `docker compose up -d --build` (whether the PC has Docker: TBD (owner to confirm)).
- Cloud sessions can run typecheck/tests if Node 24 and Chromium are available (`CI_NO_BROWSER=1` skips browser tests); otherwise tag the PR `needs-build:pc`.

## Release
Open-source (AGPL-3.0), so prod builds may use GitHub Actions. Per `docs/DEVELOPMENT.md` → Releasing: bump `version` in `package.json`, tag `vX.Y.Z`, push the tag; `.github/workflows/docker.yml` builds linux/amd64 + arm64 and pushes `ghcr.io/itslimitlezz/ctd-relay:X.Y.Z`, `:X.Y`, `:latest` (also under the pre-rename name `ctd-multi-stream`). First publish creates the GHCR package private; make it public. Release needs the hub's Senior check first.

## Conventions & gotchas
- Workflows run beyond tags/dispatch: `ci.yml` on every push to any branch and every PR; `docker.yml` publishes `:main` and `:sha-<commit>` images on every push to `main`. This differs from the hub's build policy; TBD (owner to confirm).
- Contract files (`shared/types.ts`, `shared/api.ts`, `server/src/services.ts`, `server/src/platforms/types.ts`, `server/src/http/guards.ts`, `web/src/api.ts`, etc., full list in `docs/CONTRACTS.md`) are owned by the maintainer: propose changes, don't edit in a feature change.
- Server imports use `.js` extensions (NodeNext). TypeScript 7, ESM.
- Never log secrets (stream keys, ingest URLs with keys, tokens, cookies). Validate bodies with zod; admin routes use `requireAdmin`; audit state changes.
- Platform drivers: only ever set the title, never the category/game. Browser-automated platforms (Instagram, TikTok, X, Facebook profile) are experimental. Keep selectors in `selectors.ts`.
- Never forward port 1935 (RTMP ingest) to the internet.
- Tests never touch the network or real platform accounts.
- `.claude/launch.json` is a PowerShell dev launch config (port 8443) for Windows.
- Old name was "CTD Multi-Stream": `ctd-multi-stream` still appears in compose service names and image tags.
- Other apps depend on the Relay API (`docs/API.md`): API changes need a hub AGENT-REQUESTS.md entry.

## Required reading
- `docs/DEVELOPMENT.md` and `docs/CONTRACTS.md` (before any code change)
- `docs/ARCHITECTURE.md`; `docs/SECURITY.md` (security-sensitive work); `docs/PLATFORMS.md` (drivers); `docs/API.md` (API changes)
- Lessons file: none yet.
