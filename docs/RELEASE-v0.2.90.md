# Release runbook: CTD Relay 0.2.90 (guest feeds)

Updates a TrueNAS install from **0.2.80** (`:0.2.80`, schema v4, reports r1, API v1.16) to **0.2.90**. Follows [INSTALL-TRUENAS.md](INSTALL-TRUENAS.md) → Backups / Updating, like the [0.2.80 runbook](RELEASE-v0.2.80.md); this page adds what is specific to this release.

0.2.90 contains all of 0.2.80 (alerts, transcoding). If the server is still on 0.2.70, do the 0.2.80 runbook first, so that the rollback below (to `:0.2.80`) goes back to a version that has already run on this server.

Placeholders: `<pool>` is your pool, `<NAS-IP>` the NAS's LAN address, `<app>` the app name in TrueNAS (`ctd-relay`, or `ctd-multi-stream` for installs from before the rename), `<relay-address>` the address you open the web UI at. Never paste real addresses, keys, tokens, token prefixes, viewer or account names, or pairing codes into notes, tickets or chats.

Version: **`0.2.80` → `0.2.90`** (tag `v0.2.90`). Never a Major bump.

## What changes

| Area | Change | Effect on an existing install |
|---|---|---|
| Guest feeds | Per profile up to 4 **guest feed slots** (name + own ingest key). A guest sends to `rtmp://<relay host>:<RTMP port>/guest`, stream key `<slot>?key=<key>`; CTD OBS pulls it back over LL-HLS ([GUEST-FEEDS.md](GUEST-FEEDS.md)). **Never sent to a destination.** | Nothing happens until an admin adds a slot. The dashboard shows a new **Guest feeds** card (empty). |
| External API | Revision **1.16 → 1.17** (additive; reading uses the existing `feeds:watch`): `GET /profiles/{id}/guest-feeds`, `…/{slot}/preview`, `…/{slot}/live.m3u8`, `…/{slot}/live/{file}`, events `guest.feed.status` / `guest.feeds.changed`, issue kinds `guest.feed.offline` / `guest.feed.codec` ([API.md §18](API.md)). | Nothing to pair again. The footer shows **API 1.17**. CTD OBS's CTD Relay Feed source needs a pairing with `feeds:watch`. |
| Guest feed routing | **Send this feed to…** on the Guest feeds card: a guest feed can be copied (passthrough) to up to 3 custom RTMP/RTMPS servers, or set as a profile's Landscape or Vertical feed, where it works like OBS's feed ([GUEST-FEEDS.md](GUEST-FEEDS.md) → Routing). External API: guest route routes (`status:read` to read, `system:admin` to manage, API.md §18.8). | Nothing happens until an admin adds a route. Custom servers on the LAN are allowed by default (`PUT /api/guest-routes/settings {"allowLan": false}` to refuse them). |
| MediaMTX | One more path in the generated config (`~^guest/[a-z0-9]{10}$`); its LL-HLS server (loopback) also starts when only guest feeds can be watched. | No new port to map. The RTMP port is the same. |
| Limits | New optional environment variables `GUEST_FEEDS_MAX` (4), `GUEST_FEED_MAX_VIEWERS` (2), `GUEST_FEED_WARN_KBPS` (8000), `GUEST_FEED_MAX_KBPS` (20000). | Not needed. `GUEST_FEEDS_MAX: "0"` under `environment:` turns guest feeds off. |

**Database:** two new tables, `guest_feeds` (g1) and `guest_routes` (g2), on their own track (`guest_feeds_meta`, like the report tables). The main schema stays **v4** and the report track **r1**; guest ingest keys and custom servers' stream keys go into the encrypted secrets (scopes `guest:<profileId>`, `guest-route:<routeId>`).

**Network:** a guest on the internet has to reach the RTMP port. SECURITY.md's rule stands: **never forward it**; give guests a VPN into your network.

## Rollback safety

Nothing in the main schema changes (the release only **adds tables**), so **switching the image back to `:0.2.80` is enough**. Verified for this release with 0.2.80's own code (a `main` worktree, `package.json` 0.2.80) on a database 0.2.90 wrote with routes (two guest slots on two profiles, track g2, three routes: one custom server, one from the default profile's guest into the other profile, one from the other profile's guest into the default profile): 0.2.80 opened it (schema 4, foreign keys on), deleted the second profile (its slot, its guest's route and the route into it went with it, by cascade), and 0.2.90 opened it again (schema 4, g2) with the other slot and its custom server route intact. After a rollback:

- The Guest feeds card and the `/guest-feeds` and `/guest-routes` routes are gone (`404`), so CTD OBS's CTD Relay Feed sources show their error state; MediaMTX refuses guest publishes (no `guest/…` path in its config), and no route runs (a profile that had a guest as its feed gets nothing on that input until OBS sends it). The API revision goes back to **1.16**.
- The tables and keys stay in the database untouched and come back after updating to 0.2.90 again. A profile deleted while on 0.2.80 leaves its guest keys and its routes' stream keys in the secrets (scopes `guest:<profileId>`, `guest-route:<routeId>`), unused; 0.2.90 never attaches them to anything.

The backup is still the first step.

## 1. Before the update

Do it when you're not live: the update restarts the container and ends any session.

1. **Note the current image.** **Apps → Installed → `<app>` → Edit**, and write down the `image:` line. Expected: `ghcr.io/itslimitlezz/ctd-relay:0.2.80`. That is the rollback tag.
2. **Note what Settings → API → Connected apps shows** (each app's name and Online/Offline; keep it on your machine, not in a chat).
3. **Stop the app** (**Apps → Installed → `<app>` → Stop**) so the database is closed and the copy is clean.
4. **Snapshot the app's dataset first.** **Datasets → `<pool>/apps/ctd-relay` → Data Protection → Create Snapshot**, name `pre-0.2.90`. Shell equivalent:

   ```sh
   zfs snapshot <pool>/apps/ctd-relay@pre-0.2.90
   ```

5. **Copy the database and key off the dataset** as a second backup:

   ```sh
   mkdir -p /mnt/<pool>/backups/ctd-relay-pre-0.2.90
   cp -a /mnt/<pool>/apps/ctd-relay/app.db* /mnt/<pool>/apps/ctd-relay/master.key \
         /mnt/<pool>/backups/ctd-relay-pre-0.2.90/
   chmod 700 /mnt/<pool>/backups/ctd-relay-pre-0.2.90
   ```

   `app.db` + `master.key` together decrypt every stream key and token, and the report tables hold viewer names: keep this folder private.

## 2. Switch to the new image (Apps page only)

Change the image **only on the TrueNAS Apps page**, not with `docker` on the shell (TrueNAS would put its own YAML back). The image `ghcr.io/itslimitlezz/ctd-relay:0.2.90` exists once the `v0.2.90` tag is pushed and the **Docker image** workflow has finished (Actions tab, both `amd64` and `arm64`). GHCR tags have no `v`: `:0.2.90`, not `:v0.2.90`.

1. **Apps → Installed → `<app>` → Edit**.
2. Change the `image:` line to `ghcr.io/itslimitlezz/ctd-relay:0.2.90` (pre-rename installs: `ghcr.io/itslimitlezz/ctd-multi-stream:0.2.90`). Pin the version rather than `latest`. Change nothing else. **Don't add a `ports:` line** for guests.
3. **Save**. TrueNAS pulls the image and starts the app. If it stays stopped, **Start** it.

## 3. Verify

1. **Container healthy:** **Apps → Installed → `<app>`** shows *Running*. **Workloads → View Logs** shows the server listening and MediaMTX started, no errors.
2. **Health and version:**

   ```sh
   curl -sk https://<NAS-IP>:30443/healthz        # {"ok":true,"version":"0.2.90"}
   ```

3. **Settings → About:** **Version** shows **`0.2.90`**. The footer shows `v0.2.90` and **API 1.17**.
4. **Schema unchanged, one table added:**

   ```sh
   sqlite3 -readonly /mnt/<pool>/apps/ctd-relay/app.db \
     'PRAGMA user_version; SELECT value FROM reports_meta; SELECT value FROM guest_feeds_meta;'   # 4, 1, 2
   ```

   **Connected apps** matches step 1.2 within 30 s; the CTD OBS dock is still *Connected*.
5. **Main feeds as before:** OBS sends both feeds; their cards, thumbnails and Watch work as on 0.2.80.
6. **Guest feeds, in test mode** (dashboard → Test mode on, as for every Relay test), from the LAN or a VPN:
   - Dashboard → **Guest feeds** → add "Test guest" → **Copy ingest details**.
   - On a second machine (or a phone with Larix on the LAN/VPN), stream to it (H.264 + AAC). Within a few seconds the slot shows **Online**, its resolution and bitrate, and a thumbnail; **Watch** plays it about 2 s behind.
   - With a session live in test mode, check that **no destination** receives the guest: their cards show only the landscape/vertical feeds' bitrate, as before.
   - **Routing, into a profile** (a second, test-mode profile with no OBS on its Landscape feed): on the test guest, **Send this feed to…** → *A profile's feed* → that profile, Landscape → **Add route** → **Start**. Within a few seconds the route shows **Sending**, and that profile's Landscape card shows **Online** with **Source: guest feed Test guest**. Its session does **not** start by itself. Start OBS on that profile's Landscape: the route turns **Blocked** ("OBS started sending…") and OBS's feed is shown. Stop OBS, start the route again, then stop the guest: the route stops and the card goes offline.
   - **Routing, to a custom server** (only a test server you own, e.g. a second MediaMTX on the LAN): *A custom server* → `rtmp://<test server>/<app>` + key → **Start**: **Sending**, and the test server receives the guest. `rtmp://127.0.0.1/…` and Relay's own address on its RTMP port are refused with a reason.
   - **Rotate key**: the guest is disconnected within a second or two and can't reconnect with the old details; its routes stop. **Remove** the test slot (its routes go with it).

Keep the `pre-0.2.90` snapshot and backup folder until you've streamed on 0.2.90 at least once.

## 4. The first live on 0.2.90

- Destinations go live exactly as on 0.2.80; guest slots, if any, change nothing about them.
- If a guest is on: watch the slot's bitrate (warning above 8000 kbps) and keep players to CTD OBS on the LAN. Guest ingest uses your download, every player outside the LAN your upload.
- After the show: rotate or revoke the keys of guests you won't use again.

## 5. Rollback (to `:0.2.80`)

Use this if verification fails or something breaks that can't be fixed forward. A guest-only problem can also be switched off without a rollback: `GUEST_FEEDS_MAX: "0"` under `environment:` (Apps page → Edit → Save) refuses every guest and hides the card.

1. **Apps → Installed → `<app>` → Edit**, set `image:` back to the tag noted in step 1.1 (expected `ghcr.io/itslimitlezz/ctd-relay:0.2.80`), **Save**.
2. `/healthz` answers `"version":"0.2.80"`, the footer shows API **1.16**, and `PRAGMA user_version` is still **4**.
3. Check **Settings → API → Connected apps**: CTD OBS, CTD Overlay and the phones still connect.
4. **Only if** the database itself is damaged (it shouldn't be: this release only adds a table): **Stop** the app, restore the backup (**Datasets → `<pool>/apps/ctd-relay` → Data Protection → Manage Snapshots → `pre-0.2.90` → Rollback**, or copy the files back and `chown 568:568 app.db* master.key`), then **Start** it. This loses every change made since the update.
5. Report what failed (logs from **Workloads → View Logs**, no keys, viewer names or addresses) so it can be fixed before the next try.

## Known limits

- Guests on the internet need a VPN into the network; the RTMP port is never forwarded (a later RTMPS/SRT ingest may change how guests connect).
- Routes copy only (no transcoding): the guest must send what the target takes (H.264 + AAC). A profile route can't be switched by hand while that profile is live.
- Loop protection covers routes' own targets (never this Relay). A profile's *destinations* pointing back at this Relay's guest ingest are not checked; don't set one up.
- LL-HLS latency is about 2 s; an SRT read path (under 1 s) needs a UDP port and is a later release (API.md §18.7).
- Each player costs about 1 % of a core in Relay's proxy at 8 Mbit/s on the test VM, plus its bitrate on the network ([GUEST-FEEDS.md](GUEST-FEEDS.md) → What we measured); the default cap is 2 per guest feed.

## Contract changes (for the maintainer's sign-off)

docs/CONTRACTS.md makes these files the maintainer's: a feature change proposes, the maintainer
signs off. This release proposes, all additive (nothing existing changes shape or meaning):

| File | Change |
|---|---|
| `shared/api.ts` | WS messages `guest-feed` and `guest-feeds-changed` (the web UI's live updates of the Guest feeds card) |
| `server/src/services.ts` | Optional `MediaServer.guestHlsSource(slot)` and `guestReadUrl(slot)` |
| `server/src/events.ts` | Bus events `guest-feed` and `guest-feeds-changed` |
| `server/src/http/app.ts`, `server/src/main.ts` | Register the guest feed and guest route plugins; build `GuestFeeds` and `GuestRoutes` |
| `web/src/api.ts` | Guest feed and guest route calls |

Not contract files, listed because others build on them: `server/src/media/authorize.ts` (optional
`routeKey` / `obsPublished` on the auth state), `server/src/api/http.ts` (problem codes), and the
external API itself (docs/API.md §18, §18.8; the hub's AGENT-REQUESTS.md entry below).

### Hub AGENT-REQUESTS.md entry (to post on the hub)

> **Relay API 1.17 (0.2.90): guest feeds and guest feed routes, additive.** For the CTD OBS plugin
> (CTD Relay Feed source) and CTD Live (read-only state). Read: `GET /api/v1/profiles/{id}/guest-feeds`,
> `…/{slot}/preview` (`status:read`), `…/{slot}/live.m3u8` + `…/live/{file}` (`feeds:watch`, LL-HLS);
> events `guest.feed.status`, `guest.feeds.changed`; issue kinds `guest.feed.offline`,
> `guest.feed.codec` (subject `guest.feed`). Routes (§18.8): `GET …/guest-routes`,
> `…/guest-feeds/{slot}/routes` (`status:read`, no keys); managing them needs `system:admin`. Guest
> feed JSON is stable for CTD OBS. Contract: ctd-relay `docs/API.md` §18. Nothing to change for apps
> that don't use guest feeds.

## For the release owner

After the guest feeds PR is merged into `main` and the Senior check passed:

```sh
git checkout main && git pull
git tag v0.2.90 && git push origin v0.2.90
```

The tag triggers `.github/workflows/docker.yml`, which publishes `:0.2.90`, `:0.2`, `:latest` and `:sha-<commit>` (both image names, amd64 + arm64). Only then start section 1.
