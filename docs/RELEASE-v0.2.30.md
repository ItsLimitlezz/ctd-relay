# Release runbook: CTD Relay 0.2.30 (Instagram chat reader: selector pack, debug capture)

Updates a TrueNAS install from **0.2.20** (`:0.2.20`, schema v4, API v1.10) to **0.2.30**. Follows [INSTALL-TRUENAS.md](INSTALL-TRUENAS.md) → Backups / Updating, like the [0.2.20 runbook](RELEASE-v0.2.20.md); this page adds what is specific to this release.

Placeholders: `<pool>` is your pool, `<NAS-IP>` the NAS's LAN address, `<app>` the app name in TrueNAS (`ctd-relay`, or `ctd-multi-stream` for installs from before the rename). Never paste real addresses, keys, tokens, token prefixes, Instagram user names or pairing codes into notes, tickets or chats.

Version: **`0.2.20` → `0.2.30`** (tag `v0.2.30`), one **+00.00.10** batch per the hub's CONVENTIONS.md → Versioning. Never a Major bump.

## What changes

| Area | Change | Effect on an existing install |
|---|---|---|
| Instagram comments reader | Rewritten ([PLATFORMS.md](PLATFORMS.md) → Instagram). A re-rendered list, a tab switch, a page reload or a restarted chat source no longer deliver the comments on screen again; the Comments tab is opened when it is not showing; pinned copies and Instagram's own notices are dropped; emoji shown as images are read. | Only Instagram lives. The built-in pack `builtin-2` keeps the selectors 0.2.20 used, so a page 0.2.20 could read is read the same way. **Not yet checked against the real Instagram**: step 3.7 is that check. |
| Selector pack | Everything the reader knows about Instagram's page (CSS selectors, attribute names, text patterns, timings) is JSON. An operator can store an override (`PUT …/platforms/instagram/chat/selector-pack`); the running reader uses it on its next read, and it is kept across restarts. | None until someone stores an override. Nothing is stored by the update. |
| Debug capture | `POST …/platforms/instagram/chat/debug`: the structure of the comments panel during a live, text replaced by its length, plus how many elements each selector matches and the last parse decisions. | None until someone asks for one. |
| `system:admin` scope ("Operator tools") | Needed for the two routes above through the external API. Only an admin can put it on a token, in **Settings → API**, on a token for every profile. Pairing never grants it. | No existing token has it, and no existing token gains anything. |
| Settings → Advanced | New tab with an "Instagram chat reader" card: the active pack, built-in or operator override, who changed it, **Revert to built-in**. | A new tab for admins. |
| External API | Revision **1.10 → 1.11** (additive): the four operator routes ([API.md §15](API.md#15-operator-tools-the-instagram-chat-reader-v111)). | Existing tokens keep working. The footer shows **API 1.11**. |

**No database migration:** the schema stays at **v4**. A stored override is one row in the `settings` table (key `instagram.chatPack`). Ingest, destinations, accounts, stream keys, the other platforms' chat, show profiles, pairing and the hub are untouched: no code for them changed in this release.

## Rollback safety

The schema doesn't change, so **switching the image back to `:0.2.20` is enough**, and no restore is needed. After a rollback:

- **A stored selector pack stays in the database, unused.** 0.2.20 never reads the `instagram.chatPack` row and reads comments with the selectors it shipped with. The row does no harm there. Moving forward to 0.2.30 again makes the stored pack active again at start-up: if the pack was the reason for the rollback, **revert it before rolling back** (Settings → Advanced → Revert to built-in), or right after moving forward.
- **A token with Operator tools keeps working for its other scopes.** 0.2.20 does not know `system:admin` and leaves it out when it reads the token; the stored token is not rewritten, so the scope is back after moving forward. A token that has only that scope can't do anything on 0.2.20. Revoke operator tokens you no longer need before rolling back.
- The **Advanced** tab and the four operator routes disappear, and the API revision goes back to **1.10**. The audit log keeps its `instagram.chat_pack.update`, `instagram.chat_pack.revert` and `instagram.chat_debug` entries.
- The reader's fixes are gone with it: Instagram comments can repeat after a re-render or reload, as on 0.2.20.

The backup is still the first step.

## 1. Before the update

Do it when you're not live: the update restarts the container and ends any session.

1. **Note the current image.** **Apps → Installed → `<app>` → Edit**, and write down the `image:` line. Expected: `ghcr.io/itslimitlezz/ctd-relay:0.2.20`. That is the rollback tag.
2. **Note what Settings → API → Connected apps shows** (keep it on your machine, not in a chat): each app's name, id and Online/Offline.
3. **Stop the app** (**Apps → Installed → `<app>` → Stop**) so the database is closed and the copy is clean.
4. **Snapshot the dataset.** **Datasets → `<pool>/apps/ctd-relay` → Data Protection → Create Snapshot**, name `pre-0.2.30`. Shell equivalent:

   ```sh
   zfs snapshot <pool>/apps/ctd-relay@pre-0.2.30
   ```

5. **Copy the database and key off the dataset** as a second backup:

   ```sh
   mkdir -p /mnt/<pool>/backups/ctd-relay-pre-0.2.30
   cp -a /mnt/<pool>/apps/ctd-relay/app.db* /mnt/<pool>/apps/ctd-relay/master.key \
         /mnt/<pool>/backups/ctd-relay-pre-0.2.30/
   chmod 700 /mnt/<pool>/backups/ctd-relay-pre-0.2.30
   ```

   `app.db` + `master.key` together decrypt every stream key and token: keep this folder private.

## 2. Switch to the new image

The image `ghcr.io/itslimitlezz/ctd-relay:0.2.30` exists once the `v0.2.30` tag is pushed and the **Docker image** workflow has finished (Actions tab, both `amd64` and `arm64`).

1. **Apps → Installed → `<app>` → Edit**.
2. Change the `image:` line to `ghcr.io/itslimitlezz/ctd-relay:0.2.30` (pre-rename installs: `ghcr.io/itslimitlezz/ctd-multi-stream:0.2.30`). Pin the version rather than `latest`. Change nothing else.
3. **Save**. TrueNAS pulls the image and starts the app. If it stays stopped, **Start** it.

## 3. Verify

1. **Container healthy:** **Apps → Installed → `<app>`** shows *Running*. **Workloads → View Logs** shows the server listening and no errors. There is **no** line about a selector pack: nothing is stored yet. (`stored Instagram chat selector pack ignored` or `operator override active` would mean a pack is stored.)
2. **Health and version:**

   ```sh
   curl -sk https://<NAS-IP>:30443/healthz        # {"ok":true,"version":"0.2.30"}
   ```

   (`http://` if `TLS_MODE` is `"off"`.)
3. **Settings → About:** **Version** shows **`0.2.30`**. Signed in, the page footer shows `0.2.30` and **API 1.11**.
4. **Settings → Advanced → Instagram chat reader:** version `builtin-2` with the **Built-in** badge, and **Revert to built-in** greyed out.
5. **Schema unchanged:** `sqlite3 -readonly /mnt/<pool>/apps/ctd-relay/app.db 'PRAGMA user_version;'` → `4`.
6. **Connected apps** (Settings → API) matches step 1.2 within 30 s. The CTD OBS dock is still *Connected* with status and chat; CTD Live mobile still connects and controls OBS. **Settings → API → New token** lists **Operator tools** among the scopes, and existing tokens show the scopes they had.
7. **Instagram, with test mode on** (the part no automated test covers): start a **Practice** live.
   - The log shows `Instagram chat test comment posted`, then `the comment reached the chat`, and the test comment appears **once** in the Relay chat.
   - Write two or three comments from the account: each arrives once. Switch the producer to another tab and back, then reload the producer page: nothing already delivered arrives again.
   - Settings → Advanced still shows the built-in pack, and **Reading now** says `1 Instagram live`.
   - If comments don't arrive: that is what the selector pack is for. Take a debug capture (step 8) and tune the pack ([PLATFORMS.md](PLATFORMS.md) → "Tuning the chat reader live"). It is not a reason to roll back unless something else broke: 0.2.20 reads the same page with the same selectors.
8. **Optional, operator route:** create a token with **Operator tools** for **every profile**, then during the Practice live:

   ```sh
   curl -sk -H "Authorization: Bearer <token>" https://<NAS-IP>:30443/api/v1/platforms/instagram/chat/selector-pack   # "source":"builtin"
   curl -sk -X POST -H "Authorization: Bearer <token>" -H 'content-type: application/json' -d '{}' \
        https://<NAS-IP>:30443/api/v1/platforms/instagram/chat/debug
   ```

   The capture holds tag names, class names, lengths and counts, and **no** user name, comment text or address. **Settings → Audit log** shows `instagram.chat_debug` with the token's name. **Revoke the token** when done: treat it like the admin login ([SECURITY.md](SECURITY.md) → Operator tools).
9. End the Practice live. Optional: a short test stream with **test mode on** to the other destinations (nothing in streaming changed).

Keep the `pre-0.2.30` snapshot and backup folder until you've streamed on 0.2.30 at least once.

## 4. Rollback (to `:0.2.20`)

Use this if verification fails or something breaks that can't be fixed forward.

1. If a selector pack override is active, **revert it first** (Settings → Advanced → Revert to built-in), so it isn't waiting in the database for the next update.
2. **Apps → Installed → `<app>` → Edit**, set `image:` back to the tag noted in step 1.1 (expected `ghcr.io/itslimitlezz/ctd-relay:0.2.20`), **Save**.
3. `/healthz` answers `"version":"0.2.20"`, the footer shows API **1.10**, and `PRAGMA user_version` is still **4**.
4. Check **Settings → API → Connected apps**: CTD OBS, CTD Overlay and the phones still connect. Tokens work as before the update (see *Rollback safety* for a token with Operator tools).
5. **Only if** the database itself is damaged (it shouldn't be: this release doesn't migrate or rewrite anything): **Stop** the app, restore the backup (**Datasets → `<pool>/apps/ctd-relay` → Data Protection → Manage Snapshots → `pre-0.2.30` → Rollback**, or copy the files back as in the [0.2.0 runbook](RELEASE-v1.9.md) §4 and `chown 568:568 app.db* master.key`), then **Start** it. This loses every change made since the update.
6. Report what failed (logs from **Workloads → View Logs**, no keys, user names or addresses) so it can be fixed before the next try.

## Known limits

- **The reader was tested against synthetic pages only.** The built-in pack keeps 0.2.20's selectors; the new ones (pinned copies, Instagram notices, "and N others joined") are best guesses, which is why they can now be changed without a release. Step 3.7 is the first run against the real page.
- A pack only changes **where the reader looks** and what counts as a label, event or notice. A redesign that needs new logic still needs a release.
- When a pack changes while comments are being read, the rows on screen become the new baseline: a comment arriving in that same second can be missed.
- **Text patterns are timed before they are accepted, not proven fast.** The check catches the usual slow patterns (nested repetitions, also written with escapes or behind a literal start). A pattern built to get past it could keep the Instagram page busy until the live is restarted: comments, viewer count and "End live" for Instagram would stop answering, the stream would go on. Reverting the pack doesn't free a page that is already stuck. Only an admin, or a token with Operator tools, can store a pack.
- A stored pack that no longer validates after an update (a later schema) is ignored with a log line, not deleted: the built-in pack runs.

## For the release owner

After this PR is merged into `main`:

```sh
git checkout main && git pull
git tag v0.2.30 && git push origin v0.2.30
```

The tag triggers `.github/workflows/docker.yml`, which publishes `:0.2.30`, `:0.2`, `:latest` and `:sha-<commit>` (both image names, amd64 + arm64). Only then start section 1.
