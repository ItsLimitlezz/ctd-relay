# Release runbook: CTD Relay 0.2.40 (Instagram comments: built-in pack `builtin-3`, no burst of old comments)

Updates a TrueNAS install from **0.2.30** (`:0.2.30`, schema v4, API v1.11) to **0.2.40**. Follows [INSTALL-TRUENAS.md](INSTALL-TRUENAS.md) → Backups / Updating, like the [0.2.30 runbook](RELEASE-v0.2.30.md); this page adds what is specific to this release.

Placeholders: `<pool>` is your pool, `<NAS-IP>` the NAS's LAN address, `<app>` the app name in TrueNAS (`ctd-relay`, or `ctd-multi-stream` for installs from before the rename). Never paste real addresses, keys, tokens, token prefixes, Instagram user names or pairing codes into notes, tickets or chats.

Version: **`0.2.30` → `0.2.40`** (tag `v0.2.40`), one **+00.00.10** bug-fix batch per the hub's CONVENTIONS.md → Versioning. Never a Major bump.

## What changes

| Area | Change | Effect on an existing install |
|---|---|---|
| Built-in selector pack | `builtin-2` → **`builtin-3`**: from the comment box the reader climbs up to 10 parents (was 4) and stops at one at least 320 px tall (was 200). These are the values of the override `live-1-climb` that made comments readable during the 2026-11-19 live. | Instagram comments are read without an override. A stored override stays active on top of `builtin-3` (see *The stored override* below). |
| Container choice | When the box around the comment box holds no comment rows and a parent a little further up does, that parent is the container (`container.climbPreferRows`, on). | Only matters when Instagram changes the layout around the comment box. |
| Old comments | Comments already on screen when the reader first gets to read them are history, not delivered: when a pack change makes the panel readable, when the reader starts during a live, when the panel opens late. A live younger than 60 s delivers what is on screen (`timing.backlogAsHistory`, `timing.liveStartGraceMs`). | No more 25 comments in one second after a pack change. In the first minute of a live, comments that were on screen before the reader's first read are now delivered (0.2.30 skipped them). |
| Log when Instagram ends a live | `Instagram ended the live` carries the full notice text, its buttons, the rule, the live's length, and the page's state. Unknown dialogs during a live are logged once. | More to read in the log after an Instagram-side end. Nothing is clicked that was not clicked before. |
| External API | Revision **1.11 → 1.12** (additive): three optional pack settings, `reader.backlog` in the debug capture ([API.md §15](API.md#15-operator-tools-the-instagram-chat-reader-v111)). | Existing tokens and apps keep working. The footer shows **API 1.12**. |

**No database migration:** the schema stays at **v4**. Ingest, destinations, accounts, stream keys, the other platforms' chat, show profiles, pairing and the hub are untouched: only files under `server/src/platforms/instagram/` and the API description changed.

### The stored override (`live-1-climb`)

The prod server has a selector pack override stored from the live run: `container.climbLevels` 10 and `climbMinHeight` 320, version `live-1-climb`. On 0.2.40:

- It **still loads and works**. It is put on top of `builtin-3`, sets two values `builtin-3` already has, and so changes nothing but the version label. Settings → Advanced shows `live-1-climb` with the **Override** badge and built-in pack `builtin-3`. When the comments reader starts for a live, the log says: `the stored selector pack override only repeats built-in values; it can be deleted`.
- **Delete it once you stay on 0.2.40** (step 3.5): **Settings → Advanced → Revert to built-in**, or `DELETE …/platforms/instagram/chat/selector-pack` with an Operator tools token. It is safe during a live: the settings are the same, so no comment is delivered again. Left in place it does no harm today, but it would hold `climbLevels` and `climbMinHeight` at these values when a later built-in pack changes them.
- **Keep it until the first stream on 0.2.40 went well.** 0.2.30's built-in pack cannot read Instagram's current page without it, so a rollback needs it (see *Rollback safety*).

## Rollback safety

The schema doesn't change, so **switching the image back to `:0.2.30` is enough**, and no restore is needed. After a rollback:

- **0.2.30 needs the override `live-1-climb` to read Instagram comments.** If it is still stored, it is active again at start-up and nothing else is needed. If you deleted it on 0.2.40, store it again on 0.2.30 (Operator tools token, [PLATFORMS.md](PLATFORMS.md) → "Tuning the chat reader live"):

  ```sh
  curl -sk -X PUT -H "Authorization: Bearer <token>" -H 'content-type: application/json' \
       -d '{"schema":1,"version":"live-1-climb","container":{"climbLevels":10,"climbMinHeight":320}}' \
       https://<NAS-IP>:30443/api/v1/platforms/instagram/chat/selector-pack
  ```

- **An override stored on 0.2.40 that uses a new setting** (`timing.backlogAsHistory`, `timing.liveStartGraceMs`, `container.climbPreferRows`) is not accepted by 0.2.30: it is ignored with the log line `stored Instagram chat selector pack ignored; using the built-in one`, and `builtin-2` runs. It is not deleted. Store one without those settings, as above.
- The burst is back: on 0.2.30, a pack change during a live delivers everything on screen at once.
- The API revision goes back to **1.11**. Tokens and paired apps are untouched.

The backup is still the first step.

## 1. Before the update

Do it when you're not live: the update restarts the container and ends any session.

1. **Note the current image.** **Apps → Installed → `<app>` → Edit**, and write down the `image:` line. Expected: `ghcr.io/itslimitlezz/ctd-relay:0.2.30`. That is the rollback tag.
2. **Note what Settings → Advanced → Instagram chat reader shows** (expected: version `live-1-climb`, **Override**) and what **Settings → API → Connected apps** shows (each app's name and Online/Offline; keep it on your machine, not in a chat).
3. **Stop the app** (**Apps → Installed → `<app>` → Stop**) so the database is closed and the copy is clean.
4. **Snapshot the dataset.** **Datasets → `<pool>/apps/ctd-relay` → Data Protection → Create Snapshot**, name `pre-0.2.40`. Shell equivalent:

   ```sh
   zfs snapshot <pool>/apps/ctd-relay@pre-0.2.40
   ```

5. **Copy the database and key off the dataset** as a second backup:

   ```sh
   mkdir -p /mnt/<pool>/backups/ctd-relay-pre-0.2.40
   cp -a /mnt/<pool>/apps/ctd-relay/app.db* /mnt/<pool>/apps/ctd-relay/master.key \
         /mnt/<pool>/backups/ctd-relay-pre-0.2.40/
   chmod 700 /mnt/<pool>/backups/ctd-relay-pre-0.2.40
   ```

   `app.db` + `master.key` together decrypt every stream key and token: keep this folder private.

## 2. Switch to the new image

The image `ghcr.io/itslimitlezz/ctd-relay:0.2.40` exists once the `v0.2.40` tag is pushed and the **Docker image** workflow has finished (Actions tab, both `amd64` and `arm64`). GHCR tags have no `v`: `:0.2.40`, not `:v0.2.40`.

1. **Apps → Installed → `<app>` → Edit**.
2. Change the `image:` line to `ghcr.io/itslimitlezz/ctd-relay:0.2.40` (pre-rename installs: `ghcr.io/itslimitlezz/ctd-multi-stream:0.2.40`). Pin the version rather than `latest`. Change nothing else.
3. **Save**. TrueNAS pulls the image and starts the app. If it stays stopped, **Start** it.

## 3. Verify

1. **Container healthy:** **Apps → Installed → `<app>`** shows *Running*. **Workloads → View Logs** shows the server listening, no errors, and `Instagram chat selector pack: operator override active` with version `live-1-climb` (the stored override was accepted). `stored Instagram chat selector pack ignored` would mean it was not: then the built-in `builtin-3` runs, which reads the same page, so carry on and report the line.
2. **Health and version:**

   ```sh
   curl -sk https://<NAS-IP>:30443/healthz        # {"ok":true,"version":"0.2.40"}
   ```

   (`http://` if `TLS_MODE` is `"off"`.)
3. **Settings → About:** **Version** shows **`0.2.40`**. Signed in, the page footer shows `0.2.40` and **API 1.12**. **Settings → Advanced → Instagram chat reader:** version `live-1-climb`, **Override**, built-in pack **`builtin-3`**.
4. **Schema unchanged:** `sqlite3 -readonly /mnt/<pool>/apps/ctd-relay/app.db 'PRAGMA user_version;'` → `4`. **Connected apps** (Settings → API) matches step 1.2 within 30 s; the CTD OBS dock is still *Connected*.
5. **Instagram, with test mode on:** start a **Practice** live.
   - The log shows `Instagram chat test comment posted`, then `the comment reached the chat`, and the test comment appears **once** in the Relay chat. There is no `no Instagram comment rows found yet` line.
   - Write two or three comments from the account: each arrives once.
   - The log shows `the stored selector pack override only repeats built-in values; it can be deleted`. Press **Settings → Advanced → Revert to built-in** while the live runs. The card shows `builtin-3` with the **Built-in** badge, the log shows `selector pack changed`, **no comment arrives again**, and the next comment you write arrives once. (If you'd rather keep the rollback simple, do this after the first real stream instead; see *The stored override*.)
   - Optional, the burst check: with an Operator tools token and a few comments on screen, store any override (for example the `PUT` from *Rollback safety*) at least a minute into the live. The log shows `comments already on screen taken as history (not delivered)` or nothing at all (the pack was reading, so the rows are a new baseline), and no old comment arrives again. Revert it.
6. End the Practice live. Optional: a short test stream with **test mode on** to the other destinations (nothing in streaming changed).

Keep the `pre-0.2.40` snapshot and backup folder until you've streamed on 0.2.40 at least once.

## 4. Rollback (to `:0.2.30`)

Use this if verification fails or something breaks that can't be fixed forward. A chat problem on Instagram is first a selector pack matter ([PLATFORMS.md](PLATFORMS.md) → "Tuning the chat reader live"): `timing.backlogAsHistory: false` and `container.climbPreferRows: false` switch the two new behaviours off without a rollback.

1. **Apps → Installed → `<app>` → Edit**, set `image:` back to the tag noted in step 1.1 (expected `ghcr.io/itslimitlezz/ctd-relay:0.2.30`), **Save**.
2. `/healthz` answers `"version":"0.2.30"`, the footer shows API **1.11**, and `PRAGMA user_version` is still **4**.
3. **Settings → Advanced:** the card must show `live-1-climb` with the **Override** badge. If it shows `builtin-2`, store the override again (*Rollback safety*), or Instagram comments will not be read.
4. Check **Settings → API → Connected apps**: CTD OBS, CTD Overlay and the phones still connect.
5. **Only if** the database itself is damaged (it shouldn't be: this release doesn't migrate or rewrite anything): **Stop** the app, restore the backup (**Datasets → `<pool>/apps/ctd-relay` → Data Protection → Manage Snapshots → `pre-0.2.40` → Rollback**, or copy the files back as in the [0.2.0 runbook](RELEASE-v1.9.md) §4 and `chown 568:568 app.db* master.key`), then **Start** it. This loses every change made since the update.
6. Report what failed (logs from **Workloads → View Logs**, no keys, user names or addresses) so it can be fixed before the next try.

## Known limits

- **The reader's new rules were tested on synthetic pages**, rebuilt from the sizes in the live run's sanitised debug capture. `builtin-3`'s two numbers are the ones that worked in that run; the rest is new code that has not seen the real page yet. Step 3.5 is that check.
- **History instead of a burst can cost a comment.** When the reader starts during a live that is older than a minute, or the panel opens late, everything on screen at its first read with rows is history, including a comment written in that same moment. A panel must be seen empty for 5 seconds before the reader trusts that there was no backlog. In the first minute of a live everything on screen is delivered. `timing.liveStartGraceMs` and `timing.backlogAsHistory` change this without a release.
- **`climbPreferRows` is a guess with guards** (within the climb, same column, at least two rows with an avatar). If a page puts two people with text next to the comments column, they could be read as comments while the real list is empty; `container.climbPreferRows: false` switches it off, and `container.css` names the container outright.
- **Why Instagram ended the 2026-11-19 live after 70 minutes is not known.** Nothing in Relay runs on such a timer, and the page Relay keeps open is not throttled. Third-party help pages say Instagram ends stream-key broadcasts at about one hour. This release only makes the next occurrence explain itself: send the `Instagram ended the live` log line (it holds Instagram's notice text and the page state, no names or addresses) with the report. Auto-recover starts a new live, as it did.
- A stored pack that no longer validates after an update is ignored with a log line, not deleted: the built-in pack runs.

## For the release owner

After this PR is merged into `main` and the Senior check passed:

```sh
git checkout main && git pull
git tag v0.2.40 && git push origin v0.2.40
```

The tag triggers `.github/workflows/docker.yml`, which publishes `:0.2.40`, `:0.2`, `:latest` and `:sha-<commit>` (both image names, amd64 + arm64). Only then start section 1.
