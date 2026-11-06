# Security

CTD Relay is meant to be reachable from the internet through a port forward, and it holds the keys to your streaming accounts. This page explains what is exposed, how it is protected, and what to do if something goes wrong.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub: the repository's **Security** tab → **Report a vulnerability**. Include the version (shown in **Settings → About**), what you found, and steps to reproduce. You'll get an acknowledgement as soon as possible, and a fix will be released before the details are made public. Only the latest release receives security fixes.

## What is exposed

| Port (container → typical host) | Exposure | What it serves |
|---|---|---|
| 8443 → 443 / 30443 | **Internet** (port-forwarded) | Web UI, REST API and WebSockets, over HTTPS |
| 8080 → 80 / 30080 | Internet (port-forwarded) | Let's Encrypt HTTP-01 challenge responses and a redirect to HTTPS. For LAN clients only, also `/api/v1`, `/dock` and `/overlay/*` over plain HTTP (see [LAN plain HTTP](#lan-plain-http)) |
| 1935 → 1935 | **LAN only** (never forward it) | RTMP ingest from OBS |
| MediaMTX API, auth hook | Loopback inside the container | Internal only |

Public paths that work without logging in:

- The login and first-run setup pages, and `GET /healthz`.
- The OBS chat overlay `/overlay/chat?token=…`. It needs a long random token and only shows chat. Rotate the token if the URL leaks.
- `/oauth/callback/<platform>`, which completes an OAuth connection only for a logged-in admin.
- The external API `/api/v1` for other apps (CTD Overlay, the OBS dock, bots; see [API.md](API.md)). Every route except the API description (`/api/v1/openapi.json`) needs a **personal access token** (`Authorization: Bearer ctd_pat_…`). The OBS dock page `/dock` is a static page; it reads data with the token kept in its URL fragment.

## External API tokens

- An admin creates tokens in **Settings → API**. A token has scopes (`chat:read`, `status:read`, …) and cannot start or stop a stream, change the title or touch settings. The write scopes only let an app register itself, message other apps, send OBS events, relay OBS control, or (v1.9) save show profiles and upload files.
- The secret is shown once and stored only as a SHA-256 hash. Revoking a token takes effect immediately (open event streams close within 30 s). Creating and revoking tokens is in the audit log.
- Each token is limited to 600 requests per minute and 5 open event streams. The API never sets or reads cookies.
- A token holder can read your chat and stream status (titles, destination names, watch URLs, error messages). Stream keys, account tokens and settings are never part of the API.
- Treat a token like a password: give each app its own, and revoke it when an app is retired or a dock URL (`/dock#token=…`) may have leaked.

### Show profiles and uploaded files (v1.9)

The CTD OBS plugin saves OBS set-ups ("show profiles", [API.md §14](API.md#14-show-profiles-v19)) through three more scopes:

- `show:read` reads saved show profiles, their files and the asset library. `show:write` saves revisions and uploads files. Neither reads stream keys or settings.
- `show:secrets` is different: it hands out the **third-party secrets** saved with a show profile (keys in browser-source URLs, plugin passwords). Grant it only to a token on a machine you trust, one token per machine, and not to profile-limited tokens you hand to others. A token without it still loads everything else; the sources that need a secret show "needs re-entry". Every read is audited.
- The secrets are encrypted at rest (AES-256-GCM, secret scope `show:<id>`, one entry per revision) like other tokens and keys. They are never part of a bundle, a manifest or a log line. Stream keys are not stored in show profiles at all.
- **Uploaded files are plain files** under `DATA_DIR/blobs/` (named by their SHA-256), not encrypted: they are LUTs, images, video and bundles of settings that hold no secrets, can be gigabytes large and are streamed, and the data folder is already the thing to protect. Back them up and protect them like the rest of the data folder.
- Downloads check access: a token limited to one profile can fetch a file only when a revision of its profile (or a library entry visible to it) uses it. For any other hash, `POST /blobs/check` says "missing" and the download says 404, so a token can't tell whether another profile has a file; uploading the exact bytes is what proves it holds them.
- Downloads are sent as `Content-Disposition: attachment` with `X-Content-Type-Options: nosniff` and a generic content type, so an uploaded HTML file can't run in the web UI's origin.
- Uploads are hashed while they arrive (a mismatch is refused), counted against a size limit per kind and a total storage quota, and the first bytes are checked against the declared kind (a LUT must be a `.cube` text or PNG). Windows, Linux and macOS executables and `#!` scripts are refused. At most 2 uploads run at once per token.
- The audit log records `show.save` (a revision saved), `show.blob.upload` (a new file stored) and `show.secrets.read`.

## LAN plain HTTP

So apps on your network (the OBS dock, CTD Overlay) work without trusting a certificate, the HTTP port also serves `/api/v1`, `/dock` and `/overlay/*` over plain HTTP, **but only to LAN clients**. Everyone else gets the redirect to HTTPS. A LAN client is decided by the TCP peer address of the connection (never by `X-Forwarded-For`): by default the private ranges 10/8, 172.16/12, 192.168/16, CGNAT 100.64/10, loopback, IPv6 ULA fc00::/7 and link-local. On plain HTTP the token travels unencrypted on your LAN, like the overlay token.

Environment variables (in `.env` for Docker, `environment:` in the TrueNAS app YAML):

| Variable | Effect |
|---|---|
| `LAN_HTTP` | `on` (default) or `off`. With `off` the HTTP port only answers Let's Encrypt and redirects everything to HTTPS; LAN apps then use the HTTPS URL (and pin the certificate fingerprint shown in **Settings → API** when it is self-signed). Other values are logged as a warning and treated as `on`. |
| `LAN_HTTP_CIDRS` | Comma-separated ranges or single addresses, e.g. `192.168.1.0/24,fd00::/8`. Only peers inside them count as LAN; this **replaces** the built-in private ranges. Invalid entries are ignored with a warning at startup; if none is valid, LAN plain HTTP is off. |
| `LAN_HTTP_HOST` | The NAS's LAN address (IP or name such as `nas.local`) used to build the LAN URL and the OBS dock URL in **Settings → API**, when it can't be guessed (inside a container it can't). Display only: it doesn't change who gets plain HTTP. |
| `LAN_HTTP_PORT` | The HTTP port as seen from the LAN, when it isn't mapped like the HTTPS port (e.g. `443 → 80`, `30443 → 30080`). Display only. |

**Turn it off (or narrow it) where internet clients can look private.** Wherever a NAT or proxy hop replaces the client's address with a private one, every internet visitor looks like a LAN client: Docker Desktop on Windows/macOS, rootless Docker or Podman, IPv6 published into an IPv4-only Docker network, ports forwarded from a VPS through a tunnel, or your own reverse proxy in front of the HTTP port. There set `LAN_HTTP=off`, or `LAN_HTTP_CIDRS` to your real LAN only (leaving out the gateway/proxy address). Exposure would be limited to token-protected, read-only data, but plain HTTP across the internet should never happen. With `TLS_MODE=off` (your own HTTPS proxy in front) there is no separate HTTP port and these variables do nothing.

RTMP publishing requires a random per-feed key. Reading a feed is only possible from inside the container with an internal password, so nobody on your LAN can pull your stream from the server.

## Protections

- **HTTPS by default.** A Let's Encrypt certificate for your public IP (or domain), renewed automatically, with a self-signed fallback. HSTS is sent when HTTPS is on. See [HTTPS](INSTALL-TRUENAS.md#https).
- **First-run claim.** Creating the first admin requires a one-time setup code that is only printed in the container log, so whoever finds the port first can't claim your instance.
- **Passwords** are hashed with Argon2id and must be at least 10 characters.
- **Brute-force protection.** Five wrong passwords from one address lock the account for that address for 15 minutes, so a stranger can't lock you out from elsewhere. 50 failures across all addresses lock the account for 15 minutes for any address that hasn't logged in to it recently. Repeated failures from one IP address are rate-limited. Unknown usernames are locked the same way, so errors never reveal whether a username exists.
- **Sessions** use random tokens stored only as hashes, in `HttpOnly`, `SameSite=Strict` cookies marked `Secure` under HTTPS. Sessions expire after 30 days of inactivity (90 days at most). Changing your password logs out your other sessions.
- **CSRF protection.** Every state-changing API request must carry a per-session token, and WebSocket connections must come from the app's own origin.
- **Strict Content-Security-Policy** (same-origin scripts only, no framing) and the usual security headers.
- **Optional two-factor authentication** (TOTP, off by default): **Profile → Two-factor authentication**. Recommended for admins. An admin can turn it off for another user in **Settings → Users**.
- **Recovery needs container access.** A locked-out user (forgotten password, lost authenticator) is recovered with `node dist/server/src/cli.js reset-password <username>` run inside the container (`docker compose exec ctd-multi-stream …`, or the TrueNAS app **Shell**; see [Account recovery](INSTALL-TRUENAS.md#account-recovery)). It prints a new password once, turns off 2FA and signs the user out everywhere. This means shell access to the container or host is equivalent to admin access.
- **Roles.** `admin` manages users, developer apps, accounts, destinations, settings and the browser login view. `operator` can only go live, end the stream, change the title, toggle destinations and read chat.
- **Secrets encrypted at rest** with AES-256-GCM: platform stream keys, OAuth tokens, developer-app secrets, browser sessions and TOTP secrets. The master key is `master.key` in the data folder (created on first run, readable only by the app's user) or the `MASTER_KEY` environment variable.
- **Secrets stay on the server.** Platform stream keys and developer-app secrets are write-only in the UI. Logs never contain stream keys, tokens, passwords, cookies or full RTMP URLs.
- **Audit log** (**Settings → Audit log**): logins and failed logins, user changes, account and destination changes, going live and stopping, title changes, key rotations, settings changes and use of the browser login view.
- **Manual browser login.** For Instagram, TikTok, X and Facebook profile you log in yourself in a live view of the app's browser. Passwords are never stored or typed by the app.
- **Container hardening.** The app runs as an unprivileged user (uid 568) with all Linux capabilities dropped and `no-new-privileges` (as in the provided compose files). The built-in Chromium runs without its own sandbox inside the container, so the container is the isolation boundary for the browser. It only visits the platforms you connect.

## If someone gets in

Be clear about what an account on your instance is worth:

- An **admin** can stream anything to every connected platform, read and change all settings, point destinations at their own server (which hands them the video and the platform's stream key), and use the **browser login view**: that is a logged-in browser on your Instagram, TikTok, X or Facebook account, so they could act as you there.
- An **operator** can start and stop streams, change the title on every platform, turn destinations on and off, and read chat.
- Someone with a copy of your **data folder** (`app.db` plus `master.key`) can decrypt every stored token, key and browser session.

So:

- Use a **long, unique password** (a passphrase from a password manager) for every user, and turn on **2FA** for admins.
- Give people who only run streams the **operator** role.
- Keep the image **up to date**.
- Forward only the web port (and port 80 for Let's Encrypt). Never forward 1935, and never expose the TrueNAS admin UI.
- Protect backups of the data folder like passwords.

### If you suspect a compromise

1. Change every user's password (this ends their other sessions) and review the users list.
2. Check **Settings → Audit log** for logins and changes you don't recognize.
3. Revoke the app's access on each platform (Twitch: Connections; Google account: third-party access; Kick, Facebook: app settings), then reconnect the accounts.
4. Reset your stream keys on every platform that has one, rotate the OBS ingest keys and the chat overlay token in the app, and revoke every API token in **Settings → API** (create new ones for the apps you still use).
5. Log out of all sessions on Instagram, TikTok, X and Facebook from their security settings, then log in again through the app.
6. If the data folder may have leaked, also regenerate your developer-app secrets (Twitch, Google, Kick, Meta).
