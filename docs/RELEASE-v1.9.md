# Release runbook: CTD Relay 0.2.0 (API v1.9, schema v4)

Updates a TrueNAS install from build **36b40e5** (Nov 5) to **0.2.0**. Follows [INSTALL-TRUENAS.md](INSTALL-TRUENAS.md) → Backups / Updating; this page adds what is specific to this release.

Placeholders: `<pool>` is your pool, `<NAS-IP>` the NAS's LAN address, `<app>` the app name in TrueNAS (`ctd-relay`, or `ctd-multi-stream` for installs from before the rename). Never paste real addresses or keys into notes, tickets or chats.

## What changes

| Area | Change | Effect on an existing install |
|---|---|---|
| Database | Migration **v3 → v4**: five new tables (`show_profiles`, `show_revisions`, `blobs`, `revision_blobs`, `asset_library`) | Additive only. No existing table or row is changed. Runs once, automatically, on first start. |
| Disk | New folder `<DATA_DIR>/blobs/` (in the container `/data/blobs/`, on TrueNAS `/mnt/<pool>/apps/ctd-relay/blobs/`) | Empty until someone uploads an asset or CTD OBS saves a show profile. Capped at **20 GB** by default (`ASSETS_QUOTA_BYTES` env var to lower it). A daily job deletes files nothing has referenced for 7 days. |
| External API | v1.9: `/api/v1/profiles/{id}/show…`, `/api/v1/blobs…`, `/api/v1/library`; new token scopes `show:read`, `show:write`, `show:secrets` | Existing tokens do **not** get the new scopes; every new route needs a token with them. Profile objects gain a `show` field. |
| Web UI | **Assets** page (LUT upload): list for any signed-in user, upload/rename/delete for admins | None until used. |
| Ingest (#15) | `GET /api/v1/profiles/{id}/ingest` hands OBS the host the app used when that host is public, else the LAN host | Only matters when **Settings → General → Ingest host** is empty and an app reaches Relay through a public name. RTMP (1935) is never forwarded, so set **Settings → General → Ingest host** if you see this. |
| Profiles | Deleting a profile also deletes its show profile and its library entries | Nothing exists yet, so no effect on update. |

Destinations, accounts, stream keys, Twitch Dual Format and test mode are untouched: no code or schema for them changed in this release.

## Is migration v4 reversible?

**No. Migrations are forward-only.** Each step runs in one transaction (`BEGIN IMMEDIATE`) together with `PRAGMA user_version`, so:

- **If v4 fails mid-run**, SQLite rolls the whole step back: the database stays at **v3**, untouched, and the new container exits and restarts in a loop. Switching the image back to `sha-36b40e5` is then enough (restore the backup anyway if in doubt).
- **Once v4 has run**, build 36b40e5 refuses to start: *"Database schema v4 is newer than this app supports (v3); upgrade the app"*. There is no down migration. Going back means restoring the pre-update backup, so **the backup below is mandatory**.

Anything changed after the update (new destinations, settings, audit entries, uploaded assets, new API tokens) is lost on rollback.

## 1. Before the update

Do it when you're not live: the update restarts the container and ends any session.

1. **Note the current image.** **Apps → Installed → `<app>` → Edit**, and write down the `image:` line (expected: `ghcr.io/itslimitlezz/ctd-relay:sha-36b40e5`, `:main`, or the same under `ctd-multi-stream`). This is the rollback tag; if it is `:main`, use `sha-36b40e5` for rollback.
2. **Check free space.** **Storage** → the pool must have room for the assets you plan to upload (up to 20 GB by default) plus snapshots.
3. **Stop the app** (**Apps → Installed → `<app>` → Stop**) so the database is closed and the copy is clean.
4. **Snapshot the dataset.** **Datasets → `<pool>/apps/ctd-relay` → Data Protection → Create Snapshot**, name `pre-0.2.0`. Shell equivalent:

   ```sh
   zfs snapshot <pool>/apps/ctd-relay@pre-0.2.0
   ```

5. **Copy the database and key off the dataset** as a second backup (a snapshot lives on the same pool):

   ```sh
   mkdir -p /mnt/<pool>/backups/ctd-relay-pre-0.2.0
   cp -a /mnt/<pool>/apps/ctd-relay/app.db* /mnt/<pool>/apps/ctd-relay/master.key \
         /mnt/<pool>/backups/ctd-relay-pre-0.2.0/
   chmod 700 /mnt/<pool>/backups/ctd-relay-pre-0.2.0
   ```

   `app.db` + `master.key` together decrypt every stream key and token: keep this folder private. (If you set `MASTER_KEY` in the app's environment instead of using the file, make sure you have that value.)
6. Optional: confirm the database is at v3 before you start (read-only):

   ```sh
   sqlite3 -readonly /mnt/<pool>/apps/ctd-relay/app.db 'PRAGMA user_version;'   # 3
   ```

## 2. Switch to the new image

The image `ghcr.io/itslimitlezz/ctd-relay:0.2.0` exists once the `v0.2.0` tag is pushed and the **Docker image** workflow has finished (Actions tab, both `amd64` and `arm64`).

1. **Apps → Installed → `<app>` → Edit**.
2. Change the `image:` line to `ghcr.io/itslimitlezz/ctd-relay:0.2.0` (pre-rename installs: `ghcr.io/itslimitlezz/ctd-multi-stream:0.2.0`). Pin the version rather than `latest` so the next update is a decision too. Change nothing else.
3. **Save**. TrueNAS pulls the image and starts the app; the migration runs on this first start (well under a second).

## 3. Verify

1. **Container healthy:** **Apps → Installed → `<app>`** shows *Running*; **Workloads → View Logs** shows the server listening and no `newer than this app supports` or migration error.
2. **Health and version:**

   ```sh
   curl -sk https://<NAS-IP>:30443/healthz        # {"ok":true,"version":"0.2.0"}
   ```

   (`http://` if `TLS_MODE` is `"off"`.) Signed in, the footer of every page shows `0.2.0`, the commit of the tag and API revision **1.9**.
3. **Migration applied:**

   ```sh
   sqlite3 -readonly /mnt/<pool>/apps/ctd-relay/app.db 'PRAGMA user_version;'   # 4
   ```

   Or from inside the container: `docker exec $(docker ps -qf name=<app>) node -e "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync('/data/app.db',{readOnly:true}).prepare('PRAGMA user_version').get())"` → `{ user_version: 4 }`.
4. **Data intact** (compare with what you had before):
   - **Profiles**: every profile still listed, same names.
   - **Destinations**: same count per profile, each still enabled/disabled as before, stream keys still shown as set; Twitch destinations still on Dual Format where they were.
   - **Accounts**: same status as before (no new "reconnect" prompts).
   - **Settings → API**: existing tokens and connected apps still listed; the OBS plugin and CTD Live still connect.
5. **Test mode still on:** the **Dashboard** shows the **Test mode** banner for each profile that had it on (switch profiles in the header).
6. **New feature smoke test:** **Assets** opens, shows `0 B` used of 20 GB. Optionally upload a small `.cube` LUT, then delete it.
7. **Ingest host (#15):** in OBS (or the CTD OBS plugin), the RTMP server Relay hands out is still the LAN host. If it shows the public name, set **Settings → General → Ingest host** to the NAS's LAN address.
8. **A short test stream** with test mode on: both feeds come in, every destination goes live and stops cleanly.

Keep the `pre-0.2.0` snapshot and backup folder until you've streamed on 0.2.0 at least once.

## 4. Rollback (to 36b40e5)

Use this if verification fails or a stream breaks and can't be fixed forward. It loses every change made since the update.

1. **Stop the app.**
2. **Restore the data**, either way:
   - **Snapshot:** **Datasets → `<pool>/apps/ctd-relay` → Data Protection → Manage Snapshots → `pre-0.2.0` → Rollback**, or `zfs rollback <pool>/apps/ctd-relay@pre-0.2.0`. If newer snapshots exist (periodic tasks), ZFS only rolls back with `-r`, which **destroys** them; in that case use the copy below instead.
   - **Copy:** put the backed-up files back and make them the app's again:

     ```sh
     cd /mnt/<pool>/apps/ctd-relay
     rm -f app.db-wal app.db-shm
     cp -a /mnt/<pool>/backups/ctd-relay-pre-0.2.0/app.db* /mnt/<pool>/backups/ctd-relay-pre-0.2.0/master.key .
     chown 568:568 app.db* master.key
     ```

     The leftover `blobs/` folder is harmless to 36b40e5 (it never reads it); delete it if you want the space back.
3. **Edit** the app, set `image:` back to the tag noted in step 1.1 (`ghcr.io/itslimitlezz/ctd-relay:sha-36b40e5`), **Save**.
4. Check `PRAGMA user_version` is **3**, `/healthz` answers, and repeat the data checks in section 3.
5. Report what failed (logs from **Workloads → View Logs**, no keys or addresses) so it can be fixed before the next try.

## For the release owner

After the version-bump PR is merged into `main`:

```sh
git checkout main && git pull
git tag v0.2.0 && git push origin v0.2.0
```

The tag triggers `.github/workflows/docker.yml`, which publishes `:0.2.0`, `:0.2` and `:latest` (both image names, amd64 + arm64). Only then start section 1.
