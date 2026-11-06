# Module contracts and build conventions

This is the implementation guide for contributors. The design lives in [ARCHITECTURE.md](ARCHITECTURE.md).

## Stack and layout

- Node **24.7+** (uses built-in `node:sqlite` and `crypto.argon2`), TypeScript **7** (`tsc`), ESM (`"type": "module"`).
- Server imports use **`.js` extensions** (NodeNext resolution), e.g. `import { x } from './foo.js'`.
- `shared/` — types + API contract used by both server and web (no runtime deps).
- `server/src/` — Fastify backend. Entry: `index.ts` → `main.ts` (composition root).
- `web/` — React 19 + Vite 8 SPA. Imports shared code as `@shared/types`, `@shared/api`.
- Tests: Vitest, colocated as `*.test.ts` next to the code (`server/src/**`).

```
shared/types.ts            domain types (Feed, PlatformId, Destination, SessionState, ...)
shared/api.ts              REST + WebSocket contract (request/response types, routes in comments)
server/src/config.ts       env config (AppConfig)
server/src/events.ts       EventBus (typed events: feed, push, session, destination, chat, account, ...)
server/src/services.ts     service interfaces + AppServices
server/src/platforms/types.ts  PlatformDriver, DriverContext, PushPlan, PreparedLive, DriverError
server/src/http/guards.ts  RouteOptions, requireUser/requireAdmin, sendError, audit()
server/src/http/app.ts     Fastify app: plugins + route registration + static web
server/src/main.ts         builds AppServices, starts everything
```

**Contract files** (above list + `web/src/api.ts`) are owned by the maintainer. Do not edit them in a feature change; propose changes instead.

## Module ownership and exports

| Module | Files | Must export |
|---|---|---|
| DB + security | `server/src/db/database.ts`, `server/src/db/repos.ts` (+ `db/*`), `server/src/security/*`, `server/src/http/auth-plugin.ts`, routes `setup.ts`, `auth.ts`, `users.ts`, `audit.ts` | `openDatabase(file): Db`; `createRepos(db, box): Repos`; `loadMasterKey(config): Buffer`; `createSecretBox(key): SecretBox`; `announceSetupCodeIfNeeded(repos, log)`; auth plugin = default export `FastifyPluginAsync<RouteOptions>` wrapped with `fastify-plugin` |
| TLS | `server/src/tls/*` | `createTlsManager({ config, log, settings }): TlsManager` |
| Media | `server/src/media/*`, routes `ingest.ts`, `scripts/setup-tools.mjs`, `scripts/smoke-test.ts` | `createMediaServer({ config, bus, log, secrets }): MediaServer`; `createPushSupervisor({ config, bus, log, media }): PushSupervisor` |
| Orchestrator | `server/src/orchestrator/*`, routes `session.ts`, `ws.ts` | `createOrchestrator(services: AppServices): Orchestrator` |
| Config API | routes `platforms.ts` (platforms + platform-apps), `accounts.ts`, `destinations.ts`, `settings.ts` | default-export route plugins |
| Browser | `server/src/browser/*`, route `browser.ts` | `createBrowserManager({ config, log, secrets }): BrowserManager`; helpers for drivers in `browser/helpers.ts` |
| Chat | `server/src/chat/*`, route `chat.ts` (also serves `/overlay/*`) | `createChatHub({ bus, log, secrets }): ChatHub` |
| Platform drivers | `server/src/platforms/<id>/*` | `export const <id>Driver: PlatformDriver` from `<id>/index.ts` (`twitchDriver`, `youtubeDriver`, `kickDriver`, `facebookDriver`, `xDriver`, `instagramDriver`, `tiktokDriver`, `customDriver`) |
| Web UI | `web/**` except `web/src/api.ts` | — |
| Packaging | `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `deploy/**`, `.github/**`, docs | — |

Every route file default-exports `FastifyPluginAsync<RouteOptions>` and receives `{ services }`.

## Storage conventions

- **Settings** (`repos.settings`, JSON): `'app'` → `Partial<AppSettings>`; `'session.title'` → string; `'session.autoGoLive'` → boolean (default `true`); `'session.testMode'` → boolean (default `false`, changeable only while offline); `'tls.acme'` → `{ identifier, failures, nextAttemptAt, lastError }` (Let's Encrypt backoff, survives restarts); `'assets.limits'` → `Partial<BlobLimits>` (v1.9: overrides the blob size limits, quota and revision count; read on every upload; defaults < `ASSETS_QUOTA_BYTES` < this setting).
- **Secrets** (`repos.secrets.scoped(scope)`, AES-256-GCM encrypted):

| Scope | Key | Value |
|---|---|---|
| `app:<platform>` | `values` | JSON `Record<string,string>` of developer-app fields (e.g. `{ clientId, clientSecret }`) |
| `account:<id>` | `oauth` | JSON `{ accessToken, refreshToken?, expiresAt?, scope? , ... }` (driver-defined) |
| `account:<id>` | `device` | JSON pending device-code state (driver-defined) |
| `account:<id>` | `pkce` | JSON pending PKCE state (driver-defined) |
| `browser:<accountId>` | `storageState` | Playwright storage state JSON (cookies, localStorage, IndexedDB) |
| `destination:<id>` | `streamKey` | manual stream key |
| `ingest` | `landscape`, `vertical`, `internalReader` | OBS stream keys, internal read password |
| `chat` | `overlayToken` | overlay token |
| `show:<showProfileId>` | `rev:<n>` | JSON `[{source,key,value}]`: the third-party secrets of revision `n` of a show profile (v1.9) |

Deleting an account must delete scopes `account:<id>` and `browser:<id>`; deleting a destination deletes `destination:<id>`.

## Security rules (all modules)

- Never log secrets: stream keys, full ingest URLs (they embed keys), tokens, cookies, passwords. Log `redactUrl(url)` style (scheme + host only).
- Validate every request body with zod. Return errors via `sendError(reply, status, message, code)`.
- Admin-only routes: `preHandler: requireAdmin`. Other routes: `preHandler: requireUser`.
- State-changing requests are CSRF-checked by the auth plugin (`x-csrf-token` header must equal the session's `csrfToken`). WebSocket upgrades are checked by session cookie + `Origin` must match `Host`.
- Write audit entries (`audit(services, req, action, detail)`) for: login/logout/failed login, user changes, account connect/delete, destination create/update/delete, go-live start/stop, title change, ingest key rotation, settings change.

### OAuth redirect landing

`GET /oauth/callback/:platform` completes `oauth-paste` connects when the user's browser can reach the app at the
registered redirect URI. The session cookie is `SameSite=Strict`, so it isn't sent on the cross-site redirect back
from Kick/Facebook; the route answers such requests with a tiny same-origin meta-refresh page that re-requests the
URL with the cookie. Because of that bounce, **drivers must verify the full `state` (`<accountId>.<random>`) against
the value they stored** — it's the CSRF defense for this endpoint.

### Ordering

- Deleting a destination: the route calls `orchestrator.destinationRemoved(id)` before deleting the row.
- Deleting an account: detach destinations, `await orchestrator.destinationChanged` for each (ends their lives),
  then `browser.close` + `browser.clear(id)` (not just deleting the secret scope, or an open context's auto-save
  recreates it), delete scopes `account:<id>` / `browser:<id>`, then delete the account.
- WebSockets (`/api/ws`, browser viewer) re-check the session every 30 s and close with code **4401** when it was
  logged out, expired, the user deleted or (viewer) demoted. Clients treat 4401 as "signed out".

## Media flow

- OBS publishes to `rtmp://<host>:1935/live/landscape?key=<k>` and `.../live/vertical?key=<k>` (server `rtmp://<host>:1935/live`, stream key `landscape?key=<k>`).
- MediaMTX (`authMethod: http`) calls a loopback-only HTTP endpoint run by the media module itself. It allows `publish` only with the right key and `read` only from loopback with the internal reader password.
- FFmpeg reads `media.readUrl(feed)` and pushes `-c copy` to the platform.

## Driver rules

- Drivers are stateless singletons. Per-account state goes in `ctx.accountSecrets`; per-destination state in `ctx.destinationSecrets`.
- Use `ctx.app` for developer-app credentials and throw `DriverError('...', 'misconfigured')` when missing.
- Throw `DriverError` for user-fixable problems; messages are shown in the UI verbatim.
- Browser drivers: get pages via `ctx.browser.page(accountId)`, prefer role/text locators (`getByRole`, `getByText`) over CSS classes, keep selectors in one `selectors.ts` per platform, save the session after successful flows (`ctx.browser.save(accountId)`), and throw `DriverError(..., 'needs-login')` when the session is gone.
- Never change a platform's category/game. Only the title.

## Commands

```bash
npm run setup-tools      # download MediaMTX + FFmpeg into ./tools
npm run dev              # server (TLS_MODE=off recommended locally: http://localhost:8443)
npm run dev:web          # Vite dev server with /api proxy (set CTD_DEV_API)
npm test                 # vitest
npm run typecheck
npm run build
npm run smoke            # local end-to-end media relay test
```
