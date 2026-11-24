# Release runbook: CTD Relay 0.2.50 (stream reports)

Updates a TrueNAS install from **0.2.40** (`:0.2.40`, schema v4, API v1.12) to **0.2.50**. Follows [INSTALL-TRUENAS.md](INSTALL-TRUENAS.md) → Backups / Updating, like the [0.2.40 runbook](RELEASE-v0.2.40.md); this page adds what is specific to this release.

Placeholders: `<pool>` is your pool, `<NAS-IP>` the NAS's LAN address, `<app>` the app name in TrueNAS (`ctd-relay`, or `ctd-multi-stream` for installs from before the rename). Never paste real addresses, keys, tokens, token prefixes, viewer or account names, or pairing codes into notes, tickets or chats. That now includes **report exports**: they hold your viewers' names.

Version: **`0.2.40` → `0.2.50`** (tag `v0.2.50`). Never a Major bump.

## What changes

| Area | Change | Effect on an existing install |
|---|---|---|
| Reports page | New **Reports** entry in the main menu: every stream of a profile with duration, peak and average viewers, viewer-minutes, chat, unique chatters, uptime, recoveries and errors, per platform and in total; a page per stream (viewers over time, chat per minute, destinations, titles, feeds, event timeline) and per viewer; leaderboards (Top chatters, Most loyal, Longest watch time, Newest regulars). | Empty at first: **past streams are not backfilled** (Relay kept no viewer or chat counts before). The first report is the first stream after the update. |
| Recording | Relay records every stream from its own events: titles, test mode, destinations, live periods, recoveries, errors, blocked feeds, viewers every 30 s, chat per minute, feed stats per minute. Never message text. Writes are queued and written together right after an event, chat every 30 s, so streaming and chat are not slowed. | **On by default.** About 25–30 KiB of `app.db` per destination per hour (docs/REPORTS.md → Storage). |
| Audience | Per viewer per stream: messages, joins, other chat events, first/last message time; Twitch watch time from its chatters list every 5 minutes. Instagram "*name* and N others joined": *name* is a join, N are anonymous joins. | **On by default**: reports then hold viewer names and ids. Turn it off in Reports → Recording and privacy if you don't want that. |
| Privacy | Reports → **Recording and privacy** (admin): Record stream reports, Audience tracking, **Keep reports for** (everything / 90 / 365 days), and **Forget this user** on a viewer's page (overwrites their rows, audited without the name). Reports are kept for **365 days** by default (90 days or keep everything are the other choices). |
| Export | **Excel (.xlsx)** by default (written by Relay, no macros or formulas), CSV (.zip) and JSON, per stream or date range; times in the browser's time zone. | Nothing to install. |
| Twitch | Connecting or reconnecting a Twitch account also asks for `moderator:read:chatters` (watch time). | Accounts keep working without it. Reconnect once (Accounts) to get watch time; until then Twitch counts chatters and joins like every other platform. |
| External API | Revision **1.12 → 1.13** (additive): scope `reports:read` ("Read stream reports", shown as sensitive) and `GET /api/v1/reports/…` ([API.md §16](API.md)). | Existing tokens and paired apps keep working and do **not** get `reports:read`; create or pair a token with it on purpose. The footer shows **API 1.13**. |

**Database:** the main schema stays at **v4** (`PRAGMA user_version` 4). At its first start 0.2.50 **adds** new tables (`report_*`, `audience_*`, `reports_meta`, report schema **r1**) in one short transaction: a few milliseconds, measured at 2 ms on a 42 MB database. Nothing that exists is rewritten or migrated. Settings get one new key, `reports`, when you change the recording settings.

## Rollback safety

The main schema doesn't change, so **switching the image back to `:0.2.40` is enough**, and no restore is needed. Checked with the 0.2.40 code on a database written by 0.2.50: it starts, `PRAGMA integrity_check` and `foreign_key_check` are clean, and destinations can be added and deleted. After a rollback:

- The **report tables stay in `app.db`, unused**: 0.2.40 never looks at them. Reports recorded on 0.2.50 are back after updating again; a stream that was being recorded when you rolled back is closed at the last moment 0.2.50 recorded it ("Relay restarted during this stream").
- A token or paired app given **`reports:read`** on 0.2.50 keeps its other scopes on 0.2.40 (unknown scopes are skipped when read) and gets `reports:read` back after updating again.
- Twitch accounts reconnected with `moderator:read:chatters` keep working on 0.2.40; the extra permission is unused.
- The API revision goes back to **1.12**; `/api/v1/reports/…` answers 404.
- Updating to 0.2.50 again needs nothing: the report tables are already there (r1).

The backup is still the first step.

## Decide before updating

- **Audience tracking** is on by default: it is what the leaderboards of who chats, joins and watches the most are made from, and it stores viewer names and ids per stream (never message text). Turn it off in step 3.6 only if you don't want that; one person can be forgotten on their page.
- **Retention** is **365 days** by default: about 220 MB of `app.db` at most if you stream about 4 hours a day to 5 destinations. Choose 90 days for less, or keep everything (it keeps growing) in step 3.6.

## 1. Before the update

Do it when you're not live: the update restarts the container and ends any session.

1. **Note the current image.** **Apps → Installed → `<app>` → Edit**, and write down the `image:` line. Expected: `ghcr.io/itslimitlezz/ctd-relay:0.2.40`. That is the rollback tag.
2. **Note what Settings → API → Connected apps shows** (each app's name and Online/Offline; keep it on your machine, not in a chat).
3. **Stop the app** (**Apps → Installed → `<app>` → Stop**) so the database is closed and the copy is clean.
4. **Snapshot the dataset first.** **Datasets → `<pool>/apps/ctd-relay` → Data Protection → Create Snapshot**, name `pre-0.2.50`. Shell equivalent:

   ```sh
   zfs snapshot <pool>/apps/ctd-relay@pre-0.2.50
   ```

5. **Copy the database and key off the dataset** as a second backup:

   ```sh
   mkdir -p /mnt/<pool>/backups/ctd-relay-pre-0.2.50
   cp -a /mnt/<pool>/apps/ctd-relay/app.db* /mnt/<pool>/apps/ctd-relay/master.key \
         /mnt/<pool>/backups/ctd-relay-pre-0.2.50/
   chmod 700 /mnt/<pool>/backups/ctd-relay-pre-0.2.50
   ```

   `app.db` + `master.key` together decrypt every stream key and token: keep this folder private. From this release on, snapshots and backups also hold report data, including viewer names: **Forget this user** can't reach them, so delete old snapshots you no longer need.

## 2. Switch to the new image (Apps page)

The image `ghcr.io/itslimitlezz/ctd-relay:0.2.50` exists once the `v0.2.50` tag is pushed and the **Docker image** workflow has finished (Actions tab, both `amd64` and `arm64`). GHCR tags have no `v`: `:0.2.50`, not `:v0.2.50`.

1. **Apps → Installed → `<app>` → Edit**.
2. Change the `image:` line to `ghcr.io/itslimitlezz/ctd-relay:0.2.50` (pre-rename installs: `ghcr.io/itslimitlezz/ctd-multi-stream:0.2.50`). Pin the version rather than `latest`. Change nothing else.
3. **Save**. TrueNAS pulls the image and starts the app. If it stays stopped, **Start** it.

## 3. Verify

1. **Container healthy:** **Apps → Installed → `<app>`** shows *Running*. **Workloads → View Logs** shows the server listening and no errors. There must be **no** `reports: the report tables cannot be used` line (that would mean the tables were made by a newer Relay; reports are then off and everything else runs).
2. **Health and version:**

   ```sh
   curl -sk https://<NAS-IP>:30443/healthz        # {"ok":true,"version":"0.2.50"}
   ```

   (`http://` if `TLS_MODE` is `"off"`.)
3. **Settings → About:** **Version** shows **`0.2.50`**. Signed in, the page footer shows `v0.2.50` and **API 1.13**.
4. **Schema:** the main schema is unchanged and the report track is r1:

   ```sh
   sqlite3 -readonly /mnt/<pool>/apps/ctd-relay/app.db 'PRAGMA user_version; SELECT value FROM reports_meta;'   # 4, then 1
   ```

   **Connected apps** (Settings → API) matches step 1.2 within 30 s; the CTD OBS dock is still *Connected*.
5. **Reports page:** **Reports** is in the main menu and opens with **No streams in this period** (nothing is backfilled). No error banner.
6. **Reports → Recording and privacy:** shows **Record stream reports** on, **Audience tracking** on (its one-line explanation under it), **Keep reports for** **365 days**. Change them only if decided above; a change saves at once and stays after a reload. (Admins only; the audit log shows `reports.settings`.)
7. **A test-mode stream, about 5 minutes** (Twitch test mode, as for any Relay test): go live, write a few chat messages, end it. Then:
   - **Reports** with **Include test-mode streams** on lists the stream (test-mode streams are left out of date-range totals unless included).
   - The stream page shows the duration, the destinations with their live periods, the event timeline (stream started, live, stream ended) and your chat messages in Chat per minute. Viewer counts may be empty in a Twitch bandwidth test: empty means "not reported", never 0.
   - **Export: Excel (.xlsx)** downloads a file that opens in Excel or Numbers without a repair prompt, with the sheets Summary, Per platform, Viewers, Chat per minute, Events, Top chatters, Audience, Anonymous joins, Feeds.
8. **Optional, watch time:** reconnect the Twitch account (**Accounts**, the Twitch account's **Reconnect**) and allow the new permission. On the next stream, people in Twitch's chatters list get a watch time from the second sample on (5–10 minutes in).

Keep the `pre-0.2.50` snapshot and backup folder until you've streamed on 0.2.50 at least once.

## 4. Rollback (to `:0.2.40`)

Use this if verification fails or something breaks that can't be fixed forward. A reports-only problem can also be switched off without a rollback: Reports → Recording and privacy → **Record stream reports** off.

1. **Apps → Installed → `<app>` → Edit**, set `image:` back to the tag noted in step 1.1 (expected `ghcr.io/itslimitlezz/ctd-relay:0.2.40`), **Save**.
2. `/healthz` answers `"version":"0.2.40"`, the footer shows API **1.12**, and `PRAGMA user_version` is still **4**. The **Reports** menu entry is gone; the report tables stay in `app.db` unused (see *Rollback safety*).
3. Check **Settings → API → Connected apps**: CTD OBS, CTD Overlay and the phones still connect.
4. **Only if** the database itself is damaged (it shouldn't be: this release only adds tables): **Stop** the app, restore the backup (**Datasets → `<pool>/apps/ctd-relay` → Data Protection → Manage Snapshots → `pre-0.2.50` → Rollback**, or copy the files back as in the [0.2.0 runbook](RELEASE-v1.9.md) §4 and `chown 568:568 app.db* master.key`), then **Start** it. This loses every change made since the update.
5. Report what failed (logs from **Workloads → View Logs**, no keys, viewer names or addresses) so it can be fixed before the next try.

## Known limits

- **Not yet checked on a real stream:** Twitch's chatters list filling in watch time on a real channel, and Instagram's "and N others joined" on the real page. Both were checked with synthetic data (the report test rig and `npx tsx scripts/report-sample.ts`).
- **The total dips when a platform stops reporting viewers** (a recovery, a platform that gives no count for a while): the total adds the platforms that reported at that moment. The page says so under the chart.
- **Watch time is Twitch only.** Elsewhere a viewer "attended" when they chatted or joined; nobody gets a made-up watch time.
- **Viewer-minutes are not unique viewers**; platforms don't say how many different people watched.
- **The first look at Reports after a restart** works out the recent streams' numbers (about 5 ms per long stream, done in the background right after start-up; until then a long list can take up to half a second once).
- If Relay stops abruptly, up to the last 30 s of chat counts can be missing from that stream's report.
- **Exports and `reports:read` tokens hold viewer names.** Forgetting a viewer can't reach exports already downloaded, backups or dataset snapshots.

## For the release owner

After this PR is merged into `main` and the Senior check passed:

```sh
git checkout main && git pull
git tag v0.2.50 && git push origin v0.2.50
```

The tag triggers `.github/workflows/docker.yml`, which publishes `:0.2.50`, `:0.2`, `:latest` and `:sha-<commit>` (both image names, amd64 + arm64). Only then start section 1.
