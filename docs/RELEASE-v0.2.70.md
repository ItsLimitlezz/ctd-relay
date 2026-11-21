# Release runbook: CTD Relay 0.2.70 (overlay summaries)

Updates a TrueNAS install from **0.2.60** (`:0.2.60`, schema v4, reports r1, API v1.14) to **0.2.70**. Follows [INSTALL-TRUENAS.md](INSTALL-TRUENAS.md) → Backups / Updating, like the [0.2.60 runbook](RELEASE-v0.2.60.md); this page adds what is specific to this release.

0.2.70 contains all of 0.2.60 (feed previews) and 0.2.50 (Stream Reports). The expected path is 0.2.50 → 0.2.60 (its own runbook) → 0.2.70. If the server is still on 0.2.50, do the 0.2.60 runbook first, so that the rollback below (to `:0.2.60`) goes back to a version that has already run on this server.

Placeholders: `<pool>` is your pool, `<NAS-IP>` the NAS's LAN address, `<app>` the app name in TrueNAS (`ctd-relay`, or `ctd-multi-stream` for installs from before the rename), `<relay-address>` the address you open the web UI at. Never paste real addresses, keys, tokens, token prefixes, viewer or account names, or pairing codes into notes, tickets or chats.

Version: **`0.2.60` → `0.2.70`** (tag `v0.2.70`). Never a Major bump.

## What changes

| Area | Change | Effect on an existing install |
|---|---|---|
| External API | Revision **1.14 → 1.15** (additive): `PUT /api/v1/apps/{appId}/summary` (`apps:write`, only the token that registered the app) and `GET /api/v1/profiles/{id}/overlay-summary` (`apps:read`, limited to the token's profile) ([API.md §9.5](API.md)). | **No new scope.** CTD Overlay (which holds `apps:write`) and the CTD OBS plugin (which holds `apps:read`) use it as they are paired now: nothing to pair again. The footer shows **API 1.15**. |
| Overlay summaries | CTD Overlay **0.10.0** sends a summary of its versions and template updates (installed and newest version per template, patch / minor / major, overlays waiting for the operator, a few lines of release notes) beside the overlays it registers. Relay keeps it **in memory only**, at most 64 KB per app, drops every field it doesn't know (an overlay's URL or key, a token, an error's text never reach other apps), and forgets it when the app unregisters or another token takes its id. The CTD OBS plugin's **CTD Overlays** dock reads it. | Nothing to set up. Older CTD Overlay builds don't send one: the dock says there is no summary. CTD Overlay sends again at least every 5 minutes, so a Relay restart forgets it only until then. |

**Database:** no change. The main schema stays at **v4**, the report track at **r1**, and no settings key or environment variable is added.

## Rollback safety

Nothing is stored or migrated, so **switching the image back to `:0.2.60` is enough**. After a rollback:

- `PUT /api/v1/apps/{appId}/summary` and `GET /api/v1/profiles/{id}/overlay-summary` answer 404. CTD Overlay 0.10.0 takes a 404 as "this Relay has no summaries", keeps registering its overlays as before and asks again an hour later. The dock's Updates page says to update CTD Relay; its Overlays page (add to scene, copy URL) keeps working.
- The API revision goes back to **1.14**.

The backup is still the first step.

## 1. Before the update

Do it when you're not live: the update restarts the container and ends any session.

1. **Note the current image.** **Apps → Installed → `<app>` → Edit**, and write down the `image:` line. Expected: `ghcr.io/itslimitlezz/ctd-relay:0.2.60`. That is the rollback tag.
2. **Note what Settings → API → Connected apps shows** (each app's name and Online/Offline; keep it on your machine, not in a chat).
3. **Stop the app** (**Apps → Installed → `<app>` → Stop**) so the database is closed and the copy is clean.
4. **Snapshot the app's dataset first.** **Datasets → `<pool>/apps/ctd-relay` → Data Protection → Create Snapshot**, name `pre-0.2.70`. Shell equivalent:

   ```sh
   zfs snapshot <pool>/apps/ctd-relay@pre-0.2.70
   ```

5. **Copy the database and key off the dataset** as a second backup:

   ```sh
   mkdir -p /mnt/<pool>/backups/ctd-relay-pre-0.2.70
   cp -a /mnt/<pool>/apps/ctd-relay/app.db* /mnt/<pool>/apps/ctd-relay/master.key \
         /mnt/<pool>/backups/ctd-relay-pre-0.2.70/
   chmod 700 /mnt/<pool>/backups/ctd-relay-pre-0.2.70
   ```

   `app.db` + `master.key` together decrypt every stream key and token, and the report tables hold viewer names: keep this folder private.

## 2. Switch to the new image (Apps page)

Change the image **only on the TrueNAS Apps page**, not with `docker` on the shell (TrueNAS would put its own YAML back). The image `ghcr.io/itslimitlezz/ctd-relay:0.2.70` exists once the `v0.2.70` tag is pushed and the **Docker image** workflow has finished (Actions tab, both `amd64` and `arm64`). GHCR tags have no `v`: `:0.2.70`, not `:v0.2.70`.

1. **Apps → Installed → `<app>` → Edit**.
2. Change the `image:` line to `ghcr.io/itslimitlezz/ctd-relay:0.2.70` (pre-rename installs: `ghcr.io/itslimitlezz/ctd-multi-stream:0.2.70`). Pin the version rather than `latest`. Change nothing else.
3. **Save**. TrueNAS pulls the image and starts the app. If it stays stopped, **Start** it.

## 3. Verify

1. **Container healthy:** **Apps → Installed → `<app>`** shows *Running*. **Workloads → View Logs** shows the server listening and no errors.
2. **Health and version:**

   ```sh
   curl -sk https://<NAS-IP>:30443/healthz        # {"ok":true,"version":"0.2.70"}
   ```

   (`http://` if `TLS_MODE` is `"off"`.)
3. **Settings → About:** **Version** shows **`0.2.70`**. Signed in, the page footer shows `v0.2.70` and **API 1.15**.
4. **Schema unchanged:**

   ```sh
   sqlite3 -readonly /mnt/<pool>/apps/ctd-relay/app.db 'PRAGMA user_version; SELECT value FROM reports_meta;'   # 4, then 1
   ```

   **Connected apps** (Settings → API) matches step 1.2 within 30 s; the CTD OBS dock is still *Connected*.
5. **0.2.60 still works:** a dashboard feed thumbnail and **Watch** on one feed (test mode, as for every Relay test), as in the 0.2.60 runbook §3.7–3.8.
6. **Overlay summaries** (once CTD Overlay 0.10.0 is deployed; before that, the dock's Updates page says CTD Overlay sent none, which is right):
   - Within 5 minutes of CTD Overlay connecting, the CTD OBS **CTD Overlays** dock → **Updates** shows CTD Overlay's version (**0.10.0**) and each template with its installed and newest version.
   - Optional, with a token that has `apps:read` (Settings → API; type it on the NAS, never into a chat or a ticket): `GET /api/v1/profiles/<profile-id>/overlay-summary` lists one item per CTD Overlay with `server.version` and no `url` or `key` field anywhere in it.

Keep the `pre-0.2.70` snapshot and backup folder until you've streamed on 0.2.70 at least once.

## 4. Rollback (to `:0.2.60`)

Use this if verification fails or something breaks that can't be fixed forward.

1. **Apps → Installed → `<app>` → Edit**, set `image:` back to the tag noted in step 1.1 (expected `ghcr.io/itslimitlezz/ctd-relay:0.2.60`), **Save**.
2. `/healthz` answers `"version":"0.2.60"`, the footer shows API **1.14**, and `PRAGMA user_version` is still **4**. The dock's Updates page says to update CTD Relay; everything else works as on 0.2.60.
3. Check **Settings → API → Connected apps**: CTD OBS, CTD Overlay and the phones still connect.
4. **Only if** the database itself is damaged (it shouldn't be: this release writes nothing new to it): **Stop** the app, restore the backup (**Datasets → `<pool>/apps/ctd-relay` → Data Protection → Manage Snapshots → `pre-0.2.70` → Rollback**, or copy the files back as in the [0.2.0 runbook](RELEASE-v1.9.md) §4 and `chown 568:568 app.db* master.key`), then **Start** it. This loses every change made since the update.
5. Report what failed (logs from **Workloads → View Logs**, no keys, viewer names or addresses) so it can be fixed before the next try.

## Known limits

- Summaries live in memory: after a Relay restart the dock shows none until each CTD Overlay sends again (at most 5 minutes).
- Upgrades stay in CTD Overlay: the dock links to an overlay's upgrade screen there; there is no API for another app to upgrade an overlay.

## For the release owner

After PR #31 (0.2.60) and then this PR are merged into `main` and the Senior check passed:

```sh
git checkout main && git pull
git tag v0.2.70 && git push origin v0.2.70
```

The tag triggers `.github/workflows/docker.yml`, which publishes `:0.2.70`, `:0.2`, `:latest` and `:sha-<commit>` (both image names, amd64 + arm64). Only then start section 1. If 0.2.60 is not deployed yet, deploy it first with its own runbook (tag `v0.2.60` on #31's merge), then this one.
