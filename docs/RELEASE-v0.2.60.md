# Release runbook: CTD Relay 0.2.60 (feed previews)

Updates a TrueNAS install from **0.2.50** (`:0.2.50`, schema v4, reports r1, API v1.13) to **0.2.60**. Follows [INSTALL-TRUENAS.md](INSTALL-TRUENAS.md) → Backups / Updating, like the [0.2.50 runbook](RELEASE-v0.2.50.md); this page adds what is specific to this release.

0.2.60 contains all of 0.2.50 (Stream Reports). The expected path is 0.2.40 → 0.2.50 (its own runbook) → 0.2.60. If the server is still on 0.2.40, do the 0.2.50 runbook first, so that the rollback below (to `:0.2.50`) goes back to a version that has already run on this server.

Placeholders: `<pool>` is your pool, `<NAS-IP>` the NAS's LAN address, `<app>` the app name in TrueNAS (`ctd-relay`, or `ctd-multi-stream` for installs from before the rename), `<relay-address>` the address you open the web UI at (through Caddy, or the port forward). Never paste real addresses, keys, tokens, token prefixes, viewer or account names, or pairing codes into notes, tickets or chats.

Version: **`0.2.50` → `0.2.60`** (tag `v0.2.60`). Never a Major bump.

## What changes

| Area | Change | Effect on an existing install |
|---|---|---|
| Thumbnails | The dashboard's **Landscape** and **Vertical** feed cards and every row in **Profiles** show a still frame of the feed in its own shape (16:9, 9:16), refreshed every few seconds (about every 5–6 s with OBS's 2 s keyframes) while the page is on screen and the feed is online. "Offline" otherwise; the codec warning on an HEVC/AV1 feed. | Nothing to set up. About 5 % of one core on Relay while a page shows them; nothing while no page does (or the tab is in the background). |
| Watch | A **Watch** button on each thumbnail opens a live player of the feed, about 2 s behind, muted until you turn the sound on (volume, audio level). Low-Latency HLS from the bundled MediaMTX, **copied, never re-encoded**, muxed only while someone watches (stops ~35–40 s after the last player closes), through Relay's own HTTPS server with the web UI login. | Nothing to set up. Each player pulls the feed's **full bitrate**: from outside your network that is your **upload**, which the live restreams also use. At most **4 players per feed** at once. |
| MediaMTX | Its HLS server is on, on **127.0.0.1:9996 inside the container only**, and only answers with Relay's internal reader password. | **Don't add a port for 9996** to the app's YAML. Nothing else changes. |
| External API | Revision **1.13 → 1.14** (additive): `GET /api/v1/profiles/{id}/feeds/{feed}/live.m3u8` (+ `live/{file}`) with a **new scope, `feeds:watch`** ("Watch the feeds live" in Settings → API). The JPEG previews (`…/previews/{feed}`) stay under `status:read`, now cached 2.5 s instead of 5 s. | Existing tokens and paired apps keep working and do **not** get `feeds:watch`: an app that wants to show live video (CTD Live Studio, CTD Live mobile, the CTD OBS Producer) pairs again with it. The footer shows **API 1.14**. |
| Settings | New optional environment variables `LIVE_PREVIEW_MAX_VIEWERS` (default `4`; `0` turns Watch off and keeps MediaMTX's HLS off) and `MEDIAMTX_HLS_PORT` (default `9996`, loopback). | Not needed. Add `LIVE_PREVIEW_MAX_VIEWERS` under `environment:` only to lower the cap (a tight upload) or turn Watch off. |
| Web | Content-Security-Policy adds `media-src 'self' blob:` (the player). | None. |

**Database:** no change. The main schema stays at **v4**, the report track at **r1**, and no settings key is added.

## Rollback safety

Nothing is migrated, so **switching the image back to `:0.2.50` is enough**. After a rollback:

- Thumbnails and Watch are gone from the web UI; MediaMTX starts without its HLS server again (its config is rewritten on every start).
- A token or paired app given **`feeds:watch`** on 0.2.60 keeps its other scopes on 0.2.50 (unknown scopes are skipped when read) and gets `feeds:watch` back after updating again.
- The API revision goes back to **1.13**; `/api/v1/profiles/{id}/feeds/{feed}/live.m3u8` answers 404.

The backup is still the first step.

## Decide before updating

- **Cap and upload.** Watching from outside the LAN costs one feed's bitrate of your upload per player (e.g. 6 Mbit/s per player on a 6 Mbit/s landscape feed). If your upload is tight during a show, set `LIVE_PREVIEW_MAX_VIEWERS` to `1` or `2` (or `0` to turn Watch off) in step 2.2. On the LAN it doesn't matter.
- **Your reverse proxy.** Caddy needs nothing: no `flush_interval`, no new route, no new port ([PREVIEW.md → Behind a reverse proxy](PREVIEW.md#behind-a-reverse-proxy-or-port-forward)). nginx needs `proxy_buffering off;` for the 1–3 s delay.

## 1. Before the update

Do it when you're not live: the update restarts the container and ends any session.

1. **Note the current image.** **Apps → Installed → `<app>` → Edit**, and write down the `image:` line. Expected: `ghcr.io/itslimitlezz/ctd-relay:0.2.50`. That is the rollback tag.
2. **Note what Settings → API → Connected apps shows** (each app's name and Online/Offline; keep it on your machine, not in a chat).
3. **Stop the app** (**Apps → Installed → `<app>` → Stop**) so the database is closed and the copy is clean.
4. **Snapshot the dataset first.** **Datasets → `<pool>/apps/ctd-relay` → Data Protection → Create Snapshot**, name `pre-0.2.60`. Shell equivalent:

   ```sh
   zfs snapshot <pool>/apps/ctd-relay@pre-0.2.60
   ```

5. **Copy the database and key off the dataset** as a second backup:

   ```sh
   mkdir -p /mnt/<pool>/backups/ctd-relay-pre-0.2.60
   cp -a /mnt/<pool>/apps/ctd-relay/app.db* /mnt/<pool>/apps/ctd-relay/master.key \
         /mnt/<pool>/backups/ctd-relay-pre-0.2.60/
   chmod 700 /mnt/<pool>/backups/ctd-relay-pre-0.2.60
   ```

   `app.db` + `master.key` together decrypt every stream key and token, and the report tables hold viewer names: keep this folder private.

## 2. Switch to the new image (Apps page)

Change the image **only on the TrueNAS Apps page**, not with `docker` on the shell (TrueNAS would put its own YAML back). The image `ghcr.io/itslimitlezz/ctd-relay:0.2.60` exists once the `v0.2.60` tag is pushed and the **Docker image** workflow has finished (Actions tab, both `amd64` and `arm64`). GHCR tags have no `v`: `:0.2.60`, not `:v0.2.60`.

1. **Apps → Installed → `<app>` → Edit**.
2. Change the `image:` line to `ghcr.io/itslimitlezz/ctd-relay:0.2.60` (pre-rename installs: `ghcr.io/itslimitlezz/ctd-multi-stream:0.2.60`). Pin the version rather than `latest`. Change nothing else, except, if you decided to, `LIVE_PREVIEW_MAX_VIEWERS: "2"` (quoted) under `environment:`. **Don't add a `ports:` line for 9996.**
3. **Save**. TrueNAS pulls the image and starts the app. If it stays stopped, **Start** it.

## 3. Verify

1. **Container healthy:** **Apps → Installed → `<app>`** shows *Running*. **Workloads → View Logs** shows the server listening and no errors (no `MediaMTX` restart loop).
2. **Health and version:**

   ```sh
   curl -sk https://<NAS-IP>:30443/healthz        # {"ok":true,"version":"0.2.60"}
   ```

   (`http://` if `TLS_MODE` is `"off"`.)
3. **Settings → About:** **Version** shows **`0.2.60`**. Signed in, the page footer shows `v0.2.60` and **API 1.14**.
4. **Schema unchanged:**

   ```sh
   sqlite3 -readonly /mnt/<pool>/apps/ctd-relay/app.db 'PRAGMA user_version; SELECT value FROM reports_meta;'   # 4, then 1
   ```

   **Connected apps** (Settings → API) matches step 1.2 within 30 s; the CTD OBS dock is still *Connected*.
5. **MediaMTX's HLS port is not reachable from the LAN** (it listens inside the container only):

   ```sh
   curl -m 3 -s -o /dev/null -w '%{http_code}\n' http://<NAS-IP>:9996/    # 000 (refused / no answer), never 401 or 200
   ```

6. **Put the profile in test mode before OBS sends anything** (dashboard → Test mode on, or check that auto go-live is off), as for every Relay test. Then start OBS's stream into Relay (both feeds).
7. **Thumbnails:** within a few seconds both feed cards show a frame in their own shape, and it changes every few seconds. **Profiles** shows the same per profile. Switch to another tab for a minute and back: they pick up again.
8. **Watch, on the LAN:** **Watch** on the Landscape card. Within ~3 s the picture plays, muted, and the status line says **Live · about 2 s behind**. The speaker button turns the sound on and the level bar moves; the slider changes the volume. Close it. Repeat for Vertical.
9. **Watch, through your reverse proxy** (open the web UI at `<relay-address>`, e.g. from a phone on mobile data): same as step 8; the delay stays at 1–3 s. A player stuck on "Starting the live preview…" means the proxy blocks or buffers it: see [PREVIEW.md → Behind a reverse proxy](PREVIEW.md#behind-a-reverse-proxy-or-port-forward).
10. **It stops by itself:** about 40 s after the last player closed, nothing is muxed any more. In the app's **Shell** (**Apps → Installed → `<app>` → Shell**):

    ```sh
    node -e "fetch('http://127.0.0.1:9997/v3/hlsmuxers/list').then(r=>r.json()).then(j=>console.log(j.itemCount))"   # 0
    ```

11. **The restreams don't notice:** with a test-mode stream live (Twitch test mode, as for any Relay test), open Watch on the landscape feed for a minute: the destination cards keep their fps and bitrate, no destination goes to *retrying*. End the stream and stop OBS when done.

Keep the `pre-0.2.60` snapshot and backup folder until you've streamed on 0.2.60 at least once.

## 4. Rollback (to `:0.2.50`)

Use this if verification fails or something breaks that can't be fixed forward. A Watch-only problem can also be switched off without a rollback: `LIVE_PREVIEW_MAX_VIEWERS: "0"` under `environment:` (Apps page → Edit → Save), which turns Watch and MediaMTX's HLS off and keeps the thumbnails.

1. **Apps → Installed → `<app>` → Edit**, set `image:` back to the tag noted in step 1.1 (expected `ghcr.io/itslimitlezz/ctd-relay:0.2.50`), remove `LIVE_PREVIEW_MAX_VIEWERS` if you added it, **Save**.
2. `/healthz` answers `"version":"0.2.50"`, the footer shows API **1.13**, and `PRAGMA user_version` is still **4**. The thumbnails and the Watch button are gone.
3. Check **Settings → API → Connected apps**: CTD OBS, CTD Overlay and the phones still connect.
4. **Only if** the database itself is damaged (it shouldn't be: this release doesn't write anything new to it): **Stop** the app, restore the backup (**Datasets → `<pool>/apps/ctd-relay` → Data Protection → Manage Snapshots → `pre-0.2.60` → Rollback**, or copy the files back as in the [0.2.0 runbook](RELEASE-v1.9.md) §4 and `chown 568:568 app.db* master.key`), then **Start** it. This loses every change made since the update.
5. Report what failed (logs from **Workloads → View Logs**, no keys, viewer names or addresses) so it can be fixed before the next try.

## Known limits

- **Browsers checked:** Chromium (hls.js) end to end, in the automated tests. Firefox (the same hls.js path), Safari 17.1+ (hls.js over Managed Media Source) and older Safari/iOS (Safari's own HLS player) were not run: try Watch once on the Mac, the iPhone and in Firefox. Safari's own player has no audio level bar.
- **Each player costs upload** when watched from outside (the feed's bitrate). Lower `LIVE_PREVIEW_MAX_VIEWERS` if the upload is tight.
- **No WebRTC**: 1–3 s is the delay, not sub-second.
- **HEVC/AV1 feeds** can't be previewed (the card says what to change in OBS), as they can't be restreamed either.
- A Relay restart ends open players; they reconnect by themselves, or show **Try again** if the restart takes longer than about half a minute.

## For the release owner

After PR #30 and then this PR are merged into `main` and the Senior check passed:

```sh
git checkout main && git pull
git tag v0.2.60 && git push origin v0.2.60
```

The tag triggers `.github/workflows/docker.yml`, which publishes `:0.2.60`, `:0.2`, `:latest` and `:sha-<commit>` (both image names, amd64 + arm64). Only then start section 1.
