# Release runbook: CTD Relay 0.2.80 (alerts and transcoding)

Updates a TrueNAS install from **0.2.70** (`:0.2.70`, schema v4, reports r1, API v1.15) to **0.2.80**. Follows [INSTALL-TRUENAS.md](INSTALL-TRUENAS.md) → Backups / Updating, like the [0.2.70 runbook](RELEASE-v0.2.70.md); this page adds what is specific to this release.

0.2.80 contains all of 0.2.70 (overlay summaries), 0.2.60 (feed previews) and 0.2.50 (Stream Reports). The expected path is 0.2.60 → 0.2.70 (its own runbook) → 0.2.80. If the server is still on 0.2.60, do the 0.2.70 runbook first, so that the rollback below (to `:0.2.70`) goes back to a version that has already run on this server.

Placeholders: `<pool>` is your pool, `<NAS-IP>` the NAS's LAN address, `<app>` the app name in TrueNAS (`ctd-relay`, or `ctd-multi-stream` for installs from before the rename), `<relay-address>` the address you open the web UI at. Never paste real addresses, keys, tokens, token prefixes, viewer or account names, or pairing codes into notes, tickets or chats.

Version: **`0.2.70` → `0.2.80`** (tag `v0.2.80`). Never a Major bump.

## What changes

| Area | Change | Effect on an existing install |
|---|---|---|
| Alerts (external API) | Revision **1.15 → 1.16** (additive, `status:read`, no new scope): events `issue.raised` / `issue.cleared` and `GET /status` → `issues` ([API.md §17](API.md)). Relay raises `feed.offline` (a live session's feed from OBS gone 5 s, unless OBS stopped on purpose), `destination.down` (down 5 s; critical once Relay gave up), `stream.down` (every destination down 5 s), `obs.output.down` (OBS reconnecting 3 s) and passes on the CTD OBS plugin's issues as `obs.issue`. New OBS event type `obs.failover`. | Nothing to pair again. CTD Live (F2 alerts) and the CTD OBS plugin read them as they are paired now; older builds ignore them. The footer shows **API 1.16**. |
| OBS dock | Lists the open issues that aren't a down destination; flashes and beeps for a new critical one when **Alert** is ticked. | Nothing to set up. |
| Transcoding | **Settings → Transcoding** (new tab): "Allow transcoding on this server" (**off**), how many destinations may transcode at once (2), each encoder with its test result. **Destinations → Edit → Transcoding**, per destination (**off**). On this server it shows **"CPU only"**: no GPU encoder works, so an encode runs on the CPU, next to Twitch Dual Format. | **Nothing changes until an admin turns both on.** Every destination keeps `-c copy`, launched with the same arguments as on 0.2.70. |
| CPU guard | A CPU encode that the server's own test puts at 100 % or more of real time is **refused on save**, with what to lower (here, with libx264 at about 3×: 1080p60 refused, 1080p30 and 720p60 allowed). At every start a CPU encode **doesn't start** while Dual Format or another CPU transcode is already behind real time, or when it and the CPU transcodes already running would reach 100 %: that destination then sends the original feed (or stops, as set). | Only matters once transcoding is turned on. |

**Database:** no migration. The main schema stays at **v4**, the report track at **r1**. Two kinds of settings rows are new: `transcode` (the server switch) and `transcode.profile.<destination id>` (one per destination that has transcoding settings). 0.2.70 ignores both.

No new environment variable, port or volume.

## Rollback safety

Nothing is migrated, so **switching the image back to `:0.2.70` is enough**. Verified for this release with the real servers on one data directory: 0.2.80 wrote two destinations with transcoding profiles, 0.2.70 started on it (schema 4, no errors), read both, renamed one and deleted the other, and 0.2.80 then started on it again with the remaining destination's profile intact. After a rollback:

- `issue.raised` / `issue.cleared` stop and `GET /status` has no `issues`, so CTD Live and the CTD OBS plugin get no Relay alerts (the OBS dock reads a missing `issues` as none). The API revision goes back to **1.15**.
- Every destination sends the original feed (`-c copy`), whatever its transcoding settings. The settings stay in the database and apply again after updating to 0.2.80 again. The Settings → Transcoding tab is gone.
- A destination deleted while on 0.2.70 leaves its `transcode.profile.<id>` row behind; 0.2.80 never attaches it to anything (ids are not reused).

The backup is still the first step.

## 1. Before the update

Do it when you're not live: the update restarts the container and ends any session.

1. **Note the current image.** **Apps → Installed → `<app>` → Edit**, and write down the `image:` line. Expected: `ghcr.io/itslimitlezz/ctd-relay:0.2.70`. That is the rollback tag.
2. **Note what Settings → API → Connected apps shows** (each app's name and Online/Offline; keep it on your machine, not in a chat).
3. **Stop the app** (**Apps → Installed → `<app>` → Stop**) so the database is closed and the copy is clean.
4. **Snapshot the app's dataset first.** **Datasets → `<pool>/apps/ctd-relay` → Data Protection → Create Snapshot**, name `pre-0.2.80`. Shell equivalent:

   ```sh
   zfs snapshot <pool>/apps/ctd-relay@pre-0.2.80
   ```

5. **Copy the database and key off the dataset** as a second backup:

   ```sh
   mkdir -p /mnt/<pool>/backups/ctd-relay-pre-0.2.80
   cp -a /mnt/<pool>/apps/ctd-relay/app.db* /mnt/<pool>/apps/ctd-relay/master.key \
         /mnt/<pool>/backups/ctd-relay-pre-0.2.80/
   chmod 700 /mnt/<pool>/backups/ctd-relay-pre-0.2.80
   ```

   `app.db` + `master.key` together decrypt every stream key and token, and the report tables hold viewer names: keep this folder private.

## 2. Switch to the new image (Apps page)

Change the image **only on the TrueNAS Apps page**, not with `docker` on the shell (TrueNAS would put its own YAML back). The image `ghcr.io/itslimitlezz/ctd-relay:0.2.80` exists once the `v0.2.80` tag is pushed and the **Docker image** workflow has finished (Actions tab, both `amd64` and `arm64`). GHCR tags have no `v`: `:0.2.80`, not `:v0.2.80`.

1. **Apps → Installed → `<app>` → Edit**.
2. Change the `image:` line to `ghcr.io/itslimitlezz/ctd-relay:0.2.80` (pre-rename installs: `ghcr.io/itslimitlezz/ctd-multi-stream:0.2.80`). Pin the version rather than `latest`. Change nothing else.
3. **Save**. TrueNAS pulls the image and starts the app. If it stays stopped, **Start** it.

## 3. Verify

1. **Container healthy:** **Apps → Installed → `<app>`** shows *Running*. **Workloads → View Logs** shows the server listening, `transcode capabilities probed` with the working encoders, and no errors.
2. **Health and version:**

   ```sh
   curl -sk https://<NAS-IP>:30443/healthz        # {"ok":true,"version":"0.2.80"}
   ```

   (`http://` if `TLS_MODE` is `"off"`.)
3. **Settings → About:** **Version** shows **`0.2.80`**. Signed in, the page footer shows `v0.2.80` and **API 1.16**.
4. **Schema unchanged:**

   ```sh
   sqlite3 -readonly /mnt/<pool>/apps/ctd-relay/app.db 'PRAGMA user_version; SELECT value FROM reports_meta;'   # 4, then 1
   ```

   **Connected apps** (Settings → API) matches step 1.2 within 30 s; the CTD OBS dock is still *Connected*.
5. **Transcoding is off:** **Settings → Transcoding** shows "Allow transcoding on this server" **off**, the **CPU only** warning, and libx264 / libx265 / SVT-AV1 as working with their speed. **Destinations**: no destination says "Transcoded".
6. **Alerts, in test mode** (dashboard → Test mode on, or auto go-live off, as for every Relay test), with OBS sending both feeds and the session live:
   - Nothing is raised while it starts: `GET /api/v1/status` (a token with `status:read`, typed on the NAS) has `"issues": []`, and CTD Live / the OBS dock show no alert.
   - In OBS, stop **only the vertical output** for 10 s: within about 5 s CTD Live and the OBS dock show **"Vertical feed lost"** (critical). Start it again: the alert clears.
   - Stop OBS's stream normally (the CTD OBS plugin running): **no** "feed lost" alert.

Keep the `pre-0.2.80` snapshot and backup folder until you've streamed on 0.2.80 at least once.

## 4. The first live on 0.2.80

What to watch on the first real show (transcoding stays off for it):

- **Every destination goes live as on 0.2.70**, with the same bitrate and fps on its card and no "Transcoding" line. Twitch Dual Format behaves as before (its own speed warning, if this server shows it, is the existing 0.80× one: it is why transcoding stays off here while Dual Format runs through Relay).
- **Alerts are quiet and true:** no alert while the show starts and none when it ends on purpose. If one fires, check that it names a real problem (a feed, a platform, OBS reconnecting). Note any alert that wasn't real, with its title and what was happening (no names or addresses), so its hold time can be tuned.
- **After the show:** the session ends with no alert left open (`GET /api/v1/status` → `"issues": []`).

Trying transcoding is for a later test-mode session, never during a show: turn on Settings → Transcoding, give one destination 1280×720 at 30 fps, and watch its card's speed stay at 1.00× for a few minutes with everything else running. `npx tsx scripts/transcode-cpu.ts` (from a checkout with `npm run setup-tools`) measures the CPU of copy against each encode size on any Linux machine.

## 5. Rollback (to `:0.2.70`)

Use this if verification fails or something breaks that can't be fixed forward. A transcoding-only problem can also be switched off without a rollback: **Settings → Transcoding → Allow transcoding on this server** off (it applies from each destination's next start).

1. **Apps → Installed → `<app>` → Edit**, set `image:` back to the tag noted in step 1.1 (expected `ghcr.io/itslimitlezz/ctd-relay:0.2.70`), **Save**.
2. `/healthz` answers `"version":"0.2.70"`, the footer shows API **1.15**, and `PRAGMA user_version` is still **4**. CTD Live and the OBS dock show no Relay alerts; every destination sends the original feed.
3. Check **Settings → API → Connected apps**: CTD OBS, CTD Overlay and the phones still connect.
4. **Only if** the database itself is damaged (it shouldn't be: this release adds settings rows only): **Stop** the app, restore the backup (**Datasets → `<pool>/apps/ctd-relay` → Data Protection → Manage Snapshots → `pre-0.2.80` → Rollback**, or copy the files back as in the [0.2.0 runbook](RELEASE-v1.9.md) §4 and `chown 568:568 app.db* master.key`), then **Start** it. This loses every change made since the update.
5. Report what failed (logs from **Workloads → View Logs**, no keys, viewer names or addresses) so it can be fixed before the next try.

## Known limits

- Open issues live in memory: after a Relay restart the list starts empty, and the CTD OBS plugin's next state resend (at most 60 s) raises its issues again.
- Transcoding needs an **H.264** feed: an HEVC or AV1 feed is held by the feed codec guard for every destination, transcoding ones included (Relay reads feeds over classic RTMP).
- The CPU estimate comes from a 30-frame test and reads high: measured through MediaMTX on a 4-core test machine, the real CPU was 40–75 % of the estimate (docs/TRANSCODING.md §0). The guard only refuses what even that estimate can't keep up with, and the live speed check (§7.2) still decides while streaming.
- GPU encoder arguments have not run on real hardware (no working GPU encoder here).

## For the release owner

After PR #25, PR #26 and the release PR are merged into `main` and the Senior check passed:

```sh
git checkout main && git pull
git tag v0.2.80 && git push origin v0.2.80
```

The tag triggers `.github/workflows/docker.yml`, which publishes `:0.2.80`, `:0.2`, `:latest` and `:sha-<commit>` (both image names, amd64 + arm64). Only then start section 1. If 0.2.70 is not deployed yet, deploy it first with its own runbook (tag `v0.2.70` on #32's merge), then this one.
