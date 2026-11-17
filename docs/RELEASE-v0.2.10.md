# Release runbook: CTD Relay 0.2.10 (stale connections after pairing again)

Updates a TrueNAS install from **0.2.0** (`sha-de8d2ab`, schema v4, API v1.9) to **0.2.10**. Follows [INSTALL-TRUENAS.md](INSTALL-TRUENAS.md) → Backups / Updating, like the [0.2.0 runbook](RELEASE-v1.9.md); this page adds what is specific to this release.

Placeholders: `<pool>` is your pool, `<NAS-IP>` the NAS's LAN address, `<app>` the app name in TrueNAS (`ctd-relay`, or `ctd-multi-stream` for installs from before the rename), `<machine>` the computer name CTD OBS runs on. Never paste real addresses, keys, token prefixes or pairing codes into notes, tickets or chats.

Version: a bug fix, so **+00.00.10** per the hub's CONVENTIONS.md → Versioning: `0.2.0` → **`0.2.10`** (tag `v0.2.10`). The copy fix below rides along without a second bump.

## What changes

| Area | Change | Effect on an existing install |
|---|---|---|
| Hub: pairing again (#21) | When an app pairs again (e.g. CTD OBS for new scopes) and registers its **same app id** with the same kind and name, the new connection replaces the old one, even while the old one still looks online. Before, it got `409 app_owned` and CTD OBS moved to a new id (`ctd-obs-plugin-<machine>-xxxxxx`), so entries piled up. | Pairing CTD OBS again leaves **one** entry in **Settings → API → Connected apps**. |
| Hub: clean-up | When an app registers, offline entries the same app left under its renewed ids (same kind, name and profile, older token) are removed. | The entries already piled up in prod go on CTD OBS's first heartbeat after the update (within 30 s). |
| API tokens | The old token of an app that paired again is revoked **3 minutes** later, unless it was used in the meantime (then another live app holds it, and it is kept). Audited as `api_token.superseded`. | The old **CTD OBS plugin (`<machine>`)** tokens from earlier pairings disappear from **Settings → API → API tokens** about 3 minutes after the update. |
| Dashboard | The vertical feed's hint reads "Start the vertical stream in CTD OBS." (was "…in OBS (Aitum Vertical)"). | Text only. |

**No database migration:** the schema stays at **v4**, and the API revision stays **1.9** (no new fields or routes). Ingest, destinations, accounts, stream keys, Twitch Dual Format, test mode and show profiles are untouched: no code for them changed in this release.

Only apps that register in the hub (`apps:write`) are affected. CTD Live mobile phones (QR connection: `chat:read`, `status:read`, `obs:control`) never register there, so their tokens can't be superseded. A CTD Overlay connection is only replaced by a newer CTD Overlay connection registering its same id (one id per profile: `ctd-overlay`, `ctd-overlay-<profile slug>`).

## Rollback safety

Since the schema doesn't change, **switching the image back to `sha-de8d2ab` is enough**: no restore is needed to start 0.2.0 again. Two things don't come back by themselves:

- Removed **Connected apps** entries. They were stale; every live app registers again on its next heartbeat.
- **Revoked tokens.** By design these are tokens no app was using. If an app does show "pair again" / `401` afterwards, pair it again, or restore the backup below.

The backup is still the first step: it is the only way to get a revoked token back without pairing again.

## 1. Before the update

Do it when you're not live: the update restarts the container and ends any session.

1. **Note the current image.** **Apps → Installed → `<app>` → Edit**, and write down the `image:` line (expected: `ghcr.io/itslimitlezz/ctd-relay:sha-de8d2ab`). That is the rollback tag.
2. **Note what Settings → API shows** (keep it on your machine, not in a chat): under **API tokens**, each token's name, profile and "Last used"; under **Connected apps**, each app's name, id and Online/Offline. Expect one or more **CTD OBS plugin (`<machine>`)** tokens and entries for the same computer; those are what this release cleans up.
3. **Stop the app** (**Apps → Installed → `<app>` → Stop**) so the database is closed and the copy is clean.
4. **Snapshot the dataset.** **Datasets → `<pool>/apps/ctd-relay` → Data Protection → Create Snapshot**, name `pre-0.2.10`. Shell equivalent:

   ```sh
   zfs snapshot <pool>/apps/ctd-relay@pre-0.2.10
   ```

5. **Copy the database and key off the dataset** as a second backup:

   ```sh
   mkdir -p /mnt/<pool>/backups/ctd-relay-pre-0.2.10
   cp -a /mnt/<pool>/apps/ctd-relay/app.db* /mnt/<pool>/apps/ctd-relay/master.key \
         /mnt/<pool>/backups/ctd-relay-pre-0.2.10/
   chmod 700 /mnt/<pool>/backups/ctd-relay-pre-0.2.10
   ```

   `app.db` + `master.key` together decrypt every stream key and token: keep this folder private.
6. Optional: confirm the database is at v4 (read-only):

   ```sh
   sqlite3 -readonly /mnt/<pool>/apps/ctd-relay/app.db 'PRAGMA user_version;'   # 4
   ```

## 2. Switch to the new image

The image `ghcr.io/itslimitlezz/ctd-relay:0.2.10` exists once the `v0.2.10` tag is pushed and the **Docker image** workflow has finished (Actions tab, both `amd64` and `arm64`).

1. **Apps → Installed → `<app>` → Edit**.
2. Change the `image:` line to `ghcr.io/itslimitlezz/ctd-relay:0.2.10` (pre-rename installs: `ghcr.io/itslimitlezz/ctd-multi-stream:0.2.10`). Pin the version rather than `latest`. Change nothing else.
3. **Save**. TrueNAS pulls the image and starts the app. If it stays stopped, **Start** it.

Don't restart the app again within the first 5 minutes: the 3-minute revocation of old tokens lives in memory, and a restart skips it (the token is then kept, see step 3.5).

## 3. Verify

1. **Container healthy:** **Apps → Installed → `<app>`** shows *Running*; **Workloads → View Logs** shows the server listening and no errors.
2. **Health and version:**

   ```sh
   curl -sk https://<NAS-IP>:30443/healthz        # {"ok":true,"version":"0.2.10"}
   ```

   (`http://` if `TLS_MODE` is `"off"`.) Signed in, the page footer shows `0.2.10` and API revision **1.9**.
3. **Schema unchanged:** `sqlite3 -readonly /mnt/<pool>/apps/ctd-relay/app.db 'PRAGMA user_version;'` → `4`.
4. **Old entries gone after a heartbeat.** With CTD OBS open on the show PC (already paired, nothing to do), wait 30 s and reload **Settings → API**. Under **Connected apps** there is exactly **one** CTD OBS plugin (`<machine>`) entry for that PC, *Online*. The *Offline* ones for the same PC (ids ending in `-` plus 6 characters, or the plain `ctd-obs-plugin-<machine>`) are gone.
   - An *Offline* entry for that PC that stays was made for another profile (or by a token newer than the current one): remove it with its **Remove** button. That's harmless.
5. **Old tokens revoked after about 3 minutes.** Reload **Settings → API** after 3–4 minutes. Under **API tokens**, only one **CTD OBS plugin (`<machine>`)** token is left for that PC, "Last used just now". **Settings → Audit** shows one `api_token.superseded` line per old token.
   - Any other old CTD OBS plugin token for that PC still there after 5 minutes (e.g. the app restarted meanwhile): if its "Last used" is from before the update, revoke it by hand.
   - Every other token (CTD Overlay, CTD Live mobile phones, bots/scripts) is still listed.
6. **Pair CTD OBS again: still one entry.** In CTD OBS (the CTD Relay dock, or **Settings ▸ CTD**), click **Disconnect**, then **Connect**, and approve the new code in **Settings → API**. Give it the **same profile** as the current CTD OBS token (usually *Every profile*). Then:
   - **Connected apps** still shows **one** entry for that PC, with the **same id** as in step 4, *Online*. No new `-xxxxxx` entry.
   - The dock is *Connected* again, on the right profile ("This PC streams to"), with status and chat.
   - **API tokens:** on **Disconnect**, CTD OBS unregisters its entry with the old token itself, so Relay has nothing to replace, and the **old token stays listed** (as on 0.2.0: no app can revoke its own token yet). Revoke it by hand: it's the older **CTD OBS plugin (`<machine>`)** token, "Last used" before you clicked Disconnect. Relay revokes an old token by itself (step 5) only when the old entry was still registered, i.e. CTD OBS couldn't reach Relay to unregister. That case is what piled up the `-xxxxxx` entries, and the automated tests cover it.
7. **CTD Live mobile:** open it on the phone; it still connects through Relay (status, chat), and OBS control works. Right after step 6, OBS control may say "OBS isn't shared…" until CTD OBS is connected again and has sent its OBS WebSocket settings with the new token (seconds); it recovers by itself.
8. **CTD Overlay:** **Connected apps** still lists **CTD Overlay** (*Online* if the overlay server is running), and the CTD OBS dock still lists its overlays.
9. **Dashboard:** with the vertical output stopped, the **Vertical feed** card says "Start the vertical stream in CTD OBS."
10. Optional (nothing in streaming changed): a short test stream with **test mode on**. Both feeds come in, every destination goes live and stops cleanly.

Keep the `pre-0.2.10` snapshot and backup folder until you've streamed on 0.2.10 at least once.

## 4. Rollback (to `sha-de8d2ab`)

Use this if verification fails or something breaks that can't be fixed forward.

1. **Apps → Installed → `<app>` → Edit**, set `image:` back to `ghcr.io/itslimitlezz/ctd-relay:sha-de8d2ab` (the tag noted in step 1.1), **Save**.
2. `/healthz` answers `"version":"0.2.0"`, and `PRAGMA user_version` is still **4**.
3. Check **Settings → API**: CTD OBS, CTD Overlay and the phones still connect. Pair again any app that asks to (on 0.2.0, pairing again brings back the old behaviour: a new `-xxxxxx` entry next to the old one).
4. **Only if** you need tokens back that 0.2.10 revoked, and pairing again isn't an option: **Stop** the app, restore the backup (**Datasets → `<pool>/apps/ctd-relay` → Data Protection → Manage Snapshots → `pre-0.2.10` → Rollback**, or copy the files back as in the [0.2.0 runbook](RELEASE-v1.9.md) §4 and `chown 568:568 app.db* master.key`), then **Start** it. This loses every change made since the update.
5. Report what failed (logs from **Workloads → View Logs**, no keys or addresses) so it can be fixed before the next try.

## Known limits

- **Two computers with the same computer name**, both paired: their CTD OBS entries share an id and a name. Each keeps working, since a token in use is never revoked. But when the one paired first stays switched off for a few minutes while the other runs, its entry is cleaned up and its token revoked, so it has to pair again. Give each computer its own name.
- A Relay restart during a 3-minute grace period keeps that old token (see step 3.5).

## For the release owner

After the SR check PR and #21 are merged into `main`:

```sh
git checkout main && git pull
git tag v0.2.10 && git push origin v0.2.10
```

The tag triggers `.github/workflows/docker.yml`, which publishes `:0.2.10`, `:0.2` and `:latest` (both image names, amd64 + arm64). Only then start section 1.
