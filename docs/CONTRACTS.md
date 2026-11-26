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

## Alert contract (`issue.*`, v1.16)

One event pair carries every alert in the CTD suite: **`issue.raised`** / **`issue.cleared`** on
`/api/v1/events` (`status:read`). The wire format, kinds, hold times and client rules are in
[API.md §17](API.md#17-issues-alerts-when-a-feed-a-stream-or-a-scene-has-a-problem-v116); this is
who does what.

| Link | Role | Does |
|---|---|---|
| **Relay F2** (`server/src/api/issues.ts`, fed by `event-hub.ts`) | Detector + router | Raises `feed.offline`, `destination.down`, `stream.down`, `obs.output.down` from its own state; turns the plugin's `obs.issue.*` into `obs.issue` issues; applies hold times; keeps the open set (`GET /status` → `issues`); clears with a `resolution`; forgets what an OBS app reported when it goes offline or unregisters (its next report starts fresh) |
| **CTD OBS F2** (`ctd-obs-plugin`) | Producer | Sends `obs.issue.raised` / `obs.issue.cleared` with `onProgram` / `scene`; makes failovers locally (never waits on Relay) and reports them as `obs.failover` |
| **Live F2** (`CTDRemoteLive`: `CTDLiveCore`, Live Mobile, Live Studio) | Consumer | Reads `/status` → `issues` on connect, follows `issue.*`, keys by `id`, notifies on `update: false` (and a severity raise), at most once a minute per `id` |

Rules that keep the three in step:

- **Identity:** an issue's `id` is `<kind>|<subject key>` and is the only key for raise, update,
  clear and dedupe. Clients never parse it. The plugin's own issue id (`<rule>|<subject>`) appears
  inside Relay's as `obs.issue|<appId>|<plugin id>`.
- **Severity** is `info` / `warning` / `critical` everywhere (the plugin's `ISSUE_INFO/WARNING/CRITICAL`).
- **New detectors add a `kind`** (and, for the plugin, a `rule`); they don't add event types. Clients
  treat unknown kinds by `severity` and `title`.
- **Relay doesn't switch scenes** and the plugin doesn't wait for Relay: failover is local to OBS,
  alerts are for people.
- Additive only within `apiVersion` 1: new fields and kinds are fine, renaming or removing one is a
  v2 change.

## Storage conventions

- **Settings** (`repos.settings`, JSON): `'app'` → `Partial<AppSettings>`; `'session.title'` → string; `'session.autoGoLive'` → boolean (default `true`); `'session.testMode'` → boolean (default `false`, changeable only while offline); `'tls.acme'` → `{ identifier, failures, nextAttemptAt, lastError }` (Let's Encrypt backoff, survives restarts); `'assets.limits'` → `Partial<BlobLimits>` (v1.9: overrides the blob size limits, quota and revision count; read on every upload; defaults < `ASSETS_QUOTA_BYTES` < this setting); `'instagram.chatPack'` → `{ override, updatedAt, updatedBy }` (the operator's override of the Instagram chat reader's selector pack, `platforms/instagram/chat-pack.ts`; loaded at start-up and validated again, an invalid one is ignored); `'reports'` → `ReportSettings` (`shared/reports.ts`: `{ recording, audience, retentionDays }`, defaults on / on / 365 days, `retentionDays: 0` = keep all; docs/REPORTS.md). `'transcode'` → `{ enabled: boolean, maxWorkers: number }` (default `{ enabled: false, maxWorkers: 2 }`): the server-wide transcoding switch, read every time a push starts (docs/TRANSCODING.md §0). `'transcode.profile.<destinationId>'` → `TranscodeProfile` (one row per destination with a transcoding profile, written only by `destinations-repo.ts`; a settings row rather than a column so the schema stays v4 and 0.2.70 still opens the database).
- **Guest feed slots** (`guest_feeds` in app.db, v1.17) have their own migration track in `server/src/db/guest-feeds-repo.ts`, versioned in `guest_feeds_meta`, like the report tables: the main schema stays v4 and 0.2.80 still opens the database. `profile_id` cascades on profile delete.
- **Issue history** (`issue_history` in app.db, v1.18) has its own migration track in `server/src/db/issue-history-repo.ts`, versioned in `issue_history_meta` (h1), like the guest feed and report tables: the main schema stays v4, and 0.2.80 / 0.2.90 still open the database. Rows: one per issue from `issue.raised` to `issue.cleared` (`api/issue-history.ts` records them from the API event hub); kept 7 days after clearing, 5,000 rows at most (pruned at start-up and hourly); open rows left by a restart close as `restarted`. `profile_id` cascades on profile delete.
- **Report tables** (`report_*`, `audience_*` in app.db) have their own migration track in `server/src/reports/schema.ts`, versioned in `reports_meta`, not in `PRAGMA user_version`, so older versions can still open the database. Append-only like the main migrations.
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
| `guest:<profileId>` | `<slot id>` | A guest feed slot's ingest key (v1.17, docs/GUEST-FEEDS.md); absent while the key is revoked |
| `guest-route:<routeId>` | `streamKey` | A guest feed route's custom server stream key (v1.17, docs/GUEST-FEEDS.md → Routing); write-only |

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
- **Guest feeds** (docs/GUEST-FEEDS.md): guests publish to `rtmp://<host>:1935/guest/<slot>?key=<k>` on the same MediaMTX (path regex `~^guest/[a-z0-9]{10}$`). The auth hook (`authorize.ts`) allows `publish` only with that slot's key and `read` only by Relay itself (loopback, internal reader). A guest path is never a feed path (`parseFeedPath` → null), so no push plan, destination or `feed` event can name one: guest feeds are **never restreamed**. Relay reads them back for LL-HLS (`media.guestHlsSource`), thumbnails (`media.guestReadUrl`), and for **guest feed routes** an admin sets up (`media/guest-routes.ts`): passthrough to a custom RTMP(S) server, or a republish into a profile's feed path with a one-time key the auth hook (`routeKey`) accepts over RTMP from loopback only. Routes run on their own push supervisor and bus, so no destination or orchestrator sees their push events. Rows in `guest_routes` (g2 on the guest feeds' track), cascading with their slot and their target profile.
- **SRTLA** (docs/SRTLA.md, 0.2.110): `media/srtla.ts` supervises `srtla_rec` (`SRTLA_PORT`, `SRTLA_BIN`, `SRTLA_MAX_GROUPS`), started by `createMediaServer` after MediaMTX and exposed as `MediaServer.srtlaStatus()` (`shared/srtla.ts`). It forwards bonded senders to the SRT listener from 127.0.0.1, so the auth hook never treats loopback as proof over SRT (internal reader: RTMP/HLS only; route keys: RTMP only) and caps loopback SRT publishes with `IngestAuthState.srtlaAdmit`.

## Driver rules

- Drivers are stateless singletons. Per-account state goes in `ctx.accountSecrets`; per-destination state in `ctx.destinationSecrets`.
- Use `ctx.app` for developer-app credentials and throw `DriverError('...', 'misconfigured')` when missing.
- Throw `DriverError` for user-fixable problems; messages are shown in the UI verbatim.
- Browser drivers: get pages via `ctx.browser.page(accountId)`, prefer role/text locators (`getByRole`, `getByText`) over CSS classes, keep selectors in one `selectors.ts` per platform, save the session after successful flows (`ctx.browser.save(accountId)`), and throw `DriverError(..., 'needs-login')` when the session is gone.
- Instagram's chat reader keeps its selectors in a **selector pack** (`platforms/instagram/chat-pack.ts`: built-in pack, schema, the active-pack store) instead of constants in `selectors.ts`, so they can be replaced on a running server. Page scripts (`chat-scan.ts`) are fixed strings that take the pack as JSON: never build script source from pack content. A new selector or pattern for the comments reader goes into the pack and its schema, with a fixture under `platforms/instagram/fixtures/` (synthetic markup only).
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
