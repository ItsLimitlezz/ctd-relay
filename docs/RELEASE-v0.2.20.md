# Release runbook: CTD Relay 0.2.20 (overlay scenes, transcoding capability check)

Updates a TrueNAS install from **0.2.10** (`:0.2.10` = `sha-ff98605`, schema v4, API v1.9) to **0.2.20**. Follows [INSTALL-TRUENAS.md](INSTALL-TRUENAS.md) → Backups / Updating, like the [0.2.10 runbook](RELEASE-v0.2.10.md); this page adds what is specific to this release.

Placeholders: `<pool>` is your pool, `<NAS-IP>` the NAS's LAN address, `<app>` the app name in TrueNAS (`ctd-relay`, or `ctd-multi-stream` for installs from before the rename). Never paste real addresses, keys, token prefixes, overlay keys or pairing codes into notes, tickets or chats.

Version: **`0.2.10` → `0.2.20`** (tag `v0.2.20`), one **+00.00.10** batch per the Head of Development's call on the hub's CONVENTIONS.md → Versioning (the changes are small, additive and read-only on the streaming side). Never a Major bump.

## What changes

| Area | Change | Effect on an existing install |
|---|---|---|
| Hub: overlay scenes (#23) | An overlay resource may list its scenes in `meta.scenes` (`[{ "id", "name", "url" }]`), so the CTD Relay dock in CTD OBS can add **one scene** as its own browser source. Relay validates them: `http(s)` URLs ≤ 2048 characters, ≤ 50 scenes, unique ids, ≤ 16 KB in all, on a budget **separate** from the 4 KB of the rest of `meta`. A bad `scenes` refuses the registration (`400 invalid`, naming the field). `meta` is stored and returned exactly as sent. | None until CTD Overlay sends `meta.scenes`. Overlays without scenes register exactly as before. An overlay whose `meta.scenes` was malformed (wrong types, a non-http URL) was passed through on 0.2.10 and is now refused. CTD Overlay builds that send `scenes` are written for this check. |
| Transcoding capability check (#20, TC-1) | Once at startup, in the background: `ffmpeg -version`, `-hwaccels`, `-encoders`, `-decoders`, then one short **test encode** per candidate encoder (30 synthetic 720p frames to FFmpeg's null output: nothing written to disk, nothing sent anywhere), one at a time at low CPU priority (nice 10), each capped at 15 s. Result kept in memory. | **Settings → About** gains a **Transcoding** line. One log line at startup. Read-only: **no stream is transcoded**, every destination still gets the stream as OBS sends it. |
| External API | Revision **1.9 → 1.10** (additive): `GET /api/v1/system/transcode-capabilities` (`status:read`) and the `meta.scenes` rules. Web UI: `GET /api/system/transcode-capabilities` (any signed-in user). | Existing tokens keep working and no scope was added. The footer shows **API 1.10**. |
| Docs (#19) | [TRANSCODING.md](TRANSCODING.md), the per-destination transcoding design. Only §4 (capability detection) is built. | None. |

**No database migration:** the schema stays at **v4**. Ingest, destinations, accounts, stream keys, Twitch Dual Format, test mode, show profiles and pairing are untouched: no code for them changed in this release.

### The capability check on this server

The TrueNAS YAML passes **no GPU** into the container (no `devices:`), and this server's GPU (an AMD HD 7870) isn't a transcoding target anyway. Expect, within a few seconds of startup:

- Every hardware encoder fails in milliseconds without touching a GPU: NVENC "Cannot load libcuda.so.1", QSV "Error creating a MFX session", AMF "DLL libamfrt64.so.1 failed to open", and VAAPI "no /dev/dri render node", for which FFmpeg isn't even started.
- The three software encoders (`libx264`, `libx265`, `libsvtav1`) pass, each test well under 15 s on the CPU at nice 10. In a GPU-less container on 4 threads with the same FFmpeg build, the whole check took 1.3–1.6 s.
- One log line: `transcode capabilities probed` with `working: ["libx264 …x", "libx265 …x", "libsvtav1 …x"]` and the hardware encoders under `failed`.

**Don't pass the GPU through for this release.** Nothing uses it yet, and the check only re-runs when the app restarts.

## Rollback safety

The schema doesn't change, so **switching the image back to `:0.2.10` (`sha-ff98605`) is enough**, and no restore is needed. After a rollback:

- The **Transcoding** line in Settings → About and the API route disappear, and the API revision goes back to **1.9**.
- **Overlay scenes** stay stored as last registered (0.2.10 reads stored rows without re-checking them). But on 0.2.10 `meta.scenes` counts against the 4 KB `meta` limit again, so a CTD Overlay whose `meta` with scenes is over 4 KB gets `400 invalid` on its next registration. Its overlays stay listed as last registered, without updates, until CTD Overlay stops sending scenes. The CTD OBS dock can still add the whole overlay (main `url`).

The backup is still the first step.

## 1. Before the update

Do it when you're not live: the update restarts the container and ends any session.

1. **Note the current image.** **Apps → Installed → `<app>` → Edit**, and write down the `image:` line. Expected: `ghcr.io/itslimitlezz/ctd-relay:0.2.10` (or `:sha-ff98605`, the same image). That is the rollback tag.
   - If it still shows **`:sha-de8d2ab` (0.2.0)**, 0.2.10 was never deployed. This update then also brings 0.2.10's pairing-again clean-up: do steps 3.4–3.6 of the [0.2.10 runbook](RELEASE-v0.2.10.md) as well, and roll back to `sha-de8d2ab` (the tag you noted), not to 0.2.10.
2. **Note what Settings → API → Connected apps shows** (keep it on your machine, not in a chat): each app's name, id and Online/Offline, and the overlays CTD OBS lists in its dock.
3. **Stop the app** (**Apps → Installed → `<app>` → Stop**) so the database is closed and the copy is clean.
4. **Snapshot the dataset.** **Datasets → `<pool>/apps/ctd-relay` → Data Protection → Create Snapshot**, name `pre-0.2.20`. Shell equivalent:

   ```sh
   zfs snapshot <pool>/apps/ctd-relay@pre-0.2.20
   ```

5. **Copy the database and key off the dataset** as a second backup:

   ```sh
   mkdir -p /mnt/<pool>/backups/ctd-relay-pre-0.2.20
   cp -a /mnt/<pool>/apps/ctd-relay/app.db* /mnt/<pool>/apps/ctd-relay/master.key \
         /mnt/<pool>/backups/ctd-relay-pre-0.2.20/
   chmod 700 /mnt/<pool>/backups/ctd-relay-pre-0.2.20
   ```

   `app.db` + `master.key` together decrypt every stream key and token: keep this folder private.
6. Optional: confirm the database is at v4 (read-only):

   ```sh
   sqlite3 -readonly /mnt/<pool>/apps/ctd-relay/app.db 'PRAGMA user_version;'   # 4
   ```

## 2. Switch to the new image

The image `ghcr.io/itslimitlezz/ctd-relay:0.2.20` exists once the `v0.2.20` tag is pushed and the **Docker image** workflow has finished (Actions tab, both `amd64` and `arm64`). The same run also tags it `:sha-<commit>` (the tagged commit's short hash): either tag is the same image.

1. **Apps → Installed → `<app>` → Edit**.
2. Change the `image:` line to `ghcr.io/itslimitlezz/ctd-relay:0.2.20` (pre-rename installs: `ghcr.io/itslimitlezz/ctd-multi-stream:0.2.20`). Pin the version rather than `latest`. Change nothing else; in particular, add no GPU `devices:`.
3. **Save**. TrueNAS pulls the image and starts the app. If it stays stopped, **Start** it.

## 3. Verify

1. **Container healthy:** **Apps → Installed → `<app>`** shows *Running*. **Workloads → View Logs** shows the server listening and no errors.
2. **Health and version:**

   ```sh
   curl -sk https://<NAS-IP>:30443/healthz        # {"ok":true,"version":"0.2.20"}
   ```

   (`http://` if `TLS_MODE` is `"off"`.)
3. **Settings → About:** **Version** shows **`0.2.20`**. Signed in, the page footer shows `0.2.20` and **API 1.10**.
4. **Transcoding line** (same page). Right after startup it may read "Checking which encoders work…" and updates by itself within seconds. Then:
   - Expected here: `Supported encoders — H.264: libx264 (CPU, …×) · HEVC: libx265 (CPU, …×) · AV1: libsvtav1 (CPU, …×)`, then "Tested on this machine at startup (N CPU threads). Read-only for now: every destination still gets the stream as OBS sends it."
   - In **Workloads → View Logs**: exactly **one** `transcode capabilities probed` line since the start, no repeats. NVENC/QSV/VAAPI/AMF under `failed` is normal here.
   - "Unavailable: FFmpeg can't run…" would mean the image's FFmpeg doesn't start. Streaming uses the same binary, so treat it as a failed update: check step 9 at once, then report the line.
5. **Schema unchanged:** `sqlite3 -readonly /mnt/<pool>/apps/ctd-relay/app.db 'PRAGMA user_version;'` → `4`.
6. **Connected apps** (Settings → API) matches step 1.2 within 30 s: CTD OBS and CTD Overlay *Online* (when they're running), no new entries, no app missing.
7. **CTD OBS dock:** still *Connected*, on the right profile ("This PC streams to"), with status and chat, and it still lists the profile's overlays. Once CTD Overlay sends scenes and the CTD OBS dock reads them (their scene-support builds), the dock offers that overlay's single scenes. Add one, and check the browser source shows only that scene.
   - If CTD Overlay shows a registration error after the update, note the field it names (e.g. `resources.0.meta.scenes.1.url`, never the URL itself) and report it: that's CTD Overlay sending a malformed `scenes`.
8. **CTD Live mobile:** open it on the phone. It still connects through Relay (status, chat), and OBS control works.
9. Optional (nothing in streaming changed): a short test stream with **test mode on**. Both feeds come in, and every destination goes live and stops cleanly.

Keep the `pre-0.2.20` snapshot and backup folder until you've streamed on 0.2.20 at least once.

## 4. Rollback (to `:0.2.10`)

Use this if verification fails or something breaks that can't be fixed forward.

1. **Apps → Installed → `<app>` → Edit**, set `image:` back to the tag noted in step 1.1 (expected `ghcr.io/itslimitlezz/ctd-relay:0.2.10`, i.e. `sha-ff98605`), **Save**.
2. `/healthz` answers `"version":"0.2.10"`, the footer shows API **1.9**, and `PRAGMA user_version` is still **4**.
3. Check **Settings → API → Connected apps**: CTD OBS, CTD Overlay and the phones still connect. If CTD Overlay can't register (`400` about `meta`, see *Rollback safety*), its overlays stay listed as last registered. Update CTD Overlay to a build that doesn't send scenes, or move forward to 0.2.20 again once the problem is fixed.
4. **Only if** the database itself is damaged (it shouldn't be: this release doesn't migrate or rewrite anything): **Stop** the app, restore the backup (**Datasets → `<pool>/apps/ctd-relay` → Data Protection → Manage Snapshots → `pre-0.2.20` → Rollback**, or copy the files back as in the [0.2.0 runbook](RELEASE-v1.9.md) §4 and `chown 568:568 app.db* master.key`), then **Start** it. This loses every change made since the update.
5. Report what failed (logs from **Workloads → View Logs**, no keys, overlay URLs or addresses) so it can be fixed before the next try.

## Known limits

- The capability check runs **once per start**. Restart the app to check again (e.g. after passing a GPU through on another machine).
- If a GPU driver hangs inside the kernel during a test encode, the killed FFmpeg may never exit. The Transcoding line then stays at "Checking which encoders work…" until the next restart. Streaming isn't affected. That can't happen on this install, which has no GPU passed through, so no hardware test reaches a driver.
- Scene URLs must be `http(s)`, like an overlay's main URL. Each scene URL is expected to show only that scene, at the overlay's canvas and size. Relay checks the format, not what the page shows.

## For the release owner

After this PR is merged into `main`:

```sh
git checkout main && git pull
git tag v0.2.20 && git push origin v0.2.20
```

The tag triggers `.github/workflows/docker.yml`, which publishes `:0.2.20`, `:0.2`, `:latest` and `:sha-<commit>` (both image names, amd64 + arm64). Only then start section 1.
