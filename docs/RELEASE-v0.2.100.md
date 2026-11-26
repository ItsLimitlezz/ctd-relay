# Release runbook: CTD Relay 0.2.100 (SRT, Pull link delay)

Updates a TrueNAS install from **0.2.90** (`:0.2.90`, schema v4, reports r1, guest feed track g2,
API 1.17) to **0.2.100**. Follows [INSTALL-TRUENAS.md](INSTALL-TRUENAS.md) → Backups / Updating, like
the [0.2.90 runbook](RELEASE-v0.2.90.md); this page adds what is specific to this release. If the
server isn't on 0.2.90 yet, do the 0.2.90 runbook first.

Placeholders: `<pool>` is your pool, `<NAS-IP>` the NAS's LAN address, `<app>` the app name in
TrueNAS. Never paste real addresses, keys, tokens or pairing codes into notes, tickets or chats.

Version: **`0.2.90` → `0.2.100`** (tag `v0.2.100`). Never a Major bump.

## What changes

| Area | Change | Effect on an existing install |
|---|---|---|
| SRT | MediaMTX listens for SRT on **one UDP port** (`SRT_PORT`, default 8890) for ingest and pull links, with the same keys as RTMP ([SRT.md](SRT.md)). | Nothing changes for RTMP. SRT works only once the UDP port is mapped on the app (and forwarded on the router for a sender or player outside the LAN). Without the mapping, Relay shows the SRT addresses but nothing outside reaches them. |
| External API | Revision **1.17 → 1.18** (additive): `srtUrl` + `srt` on ingest details, guest ingest details and Pull link admin objects. | Nothing to pair again. The footer shows **API 1.18**. |
| Stream issues | An issues strip on the dashboard and Profiles, badges on feed and destination cards, a 7-day history (Reports → Issues), issues in the Stream Report and its export. | Shows only when something is wrong. New table `issue_history` on its own track. |
| Docs | [PULL-LINK.md](PULL-LINK.md): the measured Pull link delay and the best OBS settings. | None. |

**Database:** one new table, `issue_history`, on its own track (`issue_history_meta` → 1). The main
schema stays **v4**, reports **r1**, guest feeds **g2**. Rollback = change the image back to `:0.2.90`,
or to `:0.2.80`; both open the database and ignore the new table.

**Default behaviour:** nothing transcodes, passthrough stays the path, and SRT is passthrough too
(MPEG-TS). SRT adds no CPU load until someone sends or reads over it.

## 1. Before the update

Do it when you're not live: the update restarts the container and ends any session.

1. **Apps → Installed → `<app>` → Edit**: write down the `image:` line (expected
   `ghcr.io/itslimitlezz/ctd-relay:0.2.90`). That is the rollback tag.
2. **Stop** the app.
3. **Snapshot** `<pool>/apps/ctd-relay` (Data Protection → Create Snapshot), name `pre-0.2.100`.
4. Copy `app.db*` and `master.key` to a private backup folder, as in the 0.2.90 runbook §1.5.

## 2. Switch the image and map the SRT port (Apps page only)

1. **Apps → Installed → `<app>` → Edit**.
2. Set `image:` to `ghcr.io/itslimitlezz/ctd-relay:0.2.100`.
3. **Ports:** add **8890 → 8890, UDP** (in the YAML: `- "8890:8890/udp"`). Don't change the other
   ports. To go without SRT, skip this and set `SRT_PORT: "0"` under `environment:`.
4. **Save**. Start it if it stays stopped.
5. **Router:** forward **UDP 8890** to the NAS **only** if a sender or player outside the LAN will
   use SRT. Never forward 1935 (RTMP).

## 3. Verify

1. `/healthz` shows `"version":"0.2.100"`. The footer shows `v0.2.100` and **API 1.18**.
2. **Workloads → View Logs:** MediaMTX started; no "SRT is off" warning (if there is one, the UDP
   port is taken on the NAS: pick another `SRT_PORT` and map that).
3. `PRAGMA user_version` is still **4**; `guest_feeds_meta` is still **2**; `SELECT value FROM
   issue_history_meta` is **1**.
4. **RTMP as before:** OBS's feeds come in over RTMP; thumbnails, Watch and destinations work as on
   0.2.90.
5. **SRT, in test mode only:**
   - **Settings → OBS setup → Low delay: SRT**. In a test OBS profile, set Settings → Stream →
     Custom…, Server = the SRT address, Stream Key empty → Start Streaming. The feed card goes
     **Online**.
   - On an extra feed (or a profile feed), turn its **Pull link** on and open the **SRT pull link**
     in a second OBS's Media Source with the settings from [PULL-LINK.md](PULL-LINK.md) (Input
     Format `mpegts`). It plays. **Rotate** the link: that OBS disconnects.
6. **Issues, in test mode:** with a test session live, stop OBS's Landscape output. Within a few
   seconds the dashboard shows an issues strip row ("feed offline", Landscape feed, open N s) and a
   badge on the Landscape card. Start the output again: both clear. **Reports → Issues** lists it with
   how it ended.
7. Optional: the clock test in [PULL-LINK.md](PULL-LINK.md) → "Find where the rest of the delay is",
   to see where the remaining Pull link delay is.

## 4. Rollback

1. **Apps → Installed → `<app>` → Edit**, set `image:` back to the tag from step 1.1 (`:0.2.90`),
   **Save**. The SRT port mapping can stay; 0.2.90 doesn't listen on it.
2. `/healthz` answers `0.2.90`, the footer shows API **1.17**, `PRAGMA user_version` is **4**.
3. Restore the `pre-0.2.100` snapshot only if the database itself is damaged (this release only adds
   a table; the issue history stays in the file, unused, and comes back on 0.2.100).

## For the release owner

After the 0.2.100 PRs are merged into `main`, tag the merge commit named in the report:

```sh
git checkout <commit> && grep '"version"' package.json   # 0.2.100
git tag v0.2.100 && git push origin v0.2.100
```

The tag builds `:0.2.100`, `:0.2`, `:latest` and `:sha-<commit>` (amd64 + arm64). Only then start
section 1.
