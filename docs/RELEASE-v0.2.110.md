# Release runbook: CTD Relay 0.2.110 (SRTLA: bonded SRT from BELABOX and Moblin)

Updates a TrueNAS install from **0.2.100** (`:0.2.100`, schema v4, reports r1, guest feed track g2,
issue history h1, API 1.18) to **0.2.110**. Follows [INSTALL-TRUENAS.md](INSTALL-TRUENAS.md) →
Backups / Updating, like the [0.2.100 runbook](RELEASE-v0.2.100.md); this page adds what is specific
to this release. If the server isn't on 0.2.100 yet, do the 0.2.100 runbook first.

Placeholders: `<pool>` is your pool, `<NAS-IP>` the NAS's LAN address, `<app>` the app name in
TrueNAS, `relay.example.com` your Relay host. Never paste real addresses, keys, tokens or pairing
codes into notes, tickets or chats.

Version: **`0.2.100` → `0.2.110`** (tag `v0.2.110`). Never a Major bump.

## What changes

| Area | Change | Effect on an existing install |
|---|---|---|
| SRTLA | Relay runs `srtla_rec` (BELABOX/srtla, pinned, AGPL-3.0) on **one more UDP port** (`SRTLA_PORT`, default 5000) and forwards bonded senders into its SRT listener, with the same keys ([SRTLA.md](SRTLA.md)). At most `SRTLA_MAX_GROUPS` (4) bonded senders at once. | Nothing changes for RTMP or SRT. SRTLA works only once UDP 5000 is mapped on the app and forwarded on the router. Without the mapping, Relay shows the SRTLA addresses but nothing outside reaches them. |
| External API | Revision **1.18 → 1.19** (additive): `srtla` (`{ host, port, streamId, url }`) next to every `srtUrl`, and `srtlaStatus`. | Nothing to pair again. The footer shows **API 1.19**. |
| SRT auth | Relay's internal reader password and guest route keys are refused over SRT, even from loopback (SRTLA forwards remote senders from 127.0.0.1). | None: Relay never used SRT for either. SRT publish keys and Pull link read keys work as before. |
| Web UI | Settings → OBS setup → **Bonded cellular: SRTLA**; extra feeds' ingest details carry SRTLA lines. | Shows "isn't available" with the reason until SRTLA is on. |

**Database:** no change. Schema stays **v4**, reports **r1**, guest feeds **g2**, issue history
**h1**. Rollback = change the image back to `:0.2.100` (or `:0.2.90`, `:0.2.80`); all open the
database.

**Default behaviour:** nothing transcodes; SRTLA is a UDP relay (no decoding). It adds no CPU load
worth measuring.

## 1. Before the update

Do it when you're not live: the update restarts the container and ends any session.

1. **Apps → Installed → `<app>` → Edit**: write down the `image:` line (expected
   `ghcr.io/itslimitlezz/ctd-relay:0.2.100`). That is the rollback tag.
2. **Stop** the app.
3. **Snapshot** `<pool>/apps/ctd-relay` (Data Protection → Create Snapshot), name `pre-0.2.110`.
4. Copy `app.db*` and `master.key` to a private backup folder, as in the 0.2.90 runbook §1.5.

## 2. Switch the image and map the SRTLA port (Apps page only)

1. **Apps → Installed → `<app>` → Edit**.
2. Set `image:` to `ghcr.io/itslimitlezz/ctd-relay:0.2.110`.
3. **Ports:** add **5000 → 5000, UDP** (in the YAML: `- "5000:5000/udp"`). Keep `8890:8890/udp`
   (SRTLA needs SRT on). Don't change the other ports. To go without SRTLA, skip this and set
   `SRTLA_PORT: "0"` under `environment:`.
4. **Save**. Start it if it stays stopped.
5. **Router:** forward **UDP 5000** to the NAS (bonded senders are on cellular). Forward UDP 8890
   only if someone outside also sends plain SRT. Never forward 1935 (RTMP).

## 3. Verify

1. `/healthz` shows `"version":"0.2.110"`. The footer shows `v0.2.110` and **API 1.19**.
2. **Workloads → View Logs:** "MediaMTX started", then "srtla_rec started". No "SRTLA port is in
   use" or "srtla_rec was not found" warning (if the port is taken on the NAS, pick another
   `SRTLA_PORT` and map that).
3. `PRAGMA user_version` is still **4**.
4. **RTMP and SRT as before:** OBS's feeds come in; thumbnails, Watch, destinations, Pull links work
   as on 0.2.100.
5. **SRTLA, in test mode only:**
   - **Settings → OBS setup → Bonded cellular: SRTLA** shows a Moblin URL and a BELABOX streamid per
     feed.
   - Moblin (phone on cellular, Wi-Fi off or on): Settings → Streams → URL = the SRTLA URL → Go live.
     Or BELABOX: manual relay server, address `relay.example.com`, port 5000, streamid from Relay.
     The feed card goes **Online** with H.264 + AAC.
   - Change one character of the key in the app: it is refused and the feed stays offline. The log
     shows "Rejected media publish request" without the key.
6. Optional: an extra feed's **Copy ingest details** includes the SRTLA lines; publish it from
   Moblin the same way.

## 4. Rollback

1. **Apps → Installed → `<app>` → Edit**, set `image:` back to the tag from step 1.1 (`:0.2.100`),
   **Save**. The 5000/udp mapping can stay; 0.2.100 doesn't listen on it.
2. `/healthz` answers `0.2.100`, the footer shows API **1.18**, `PRAGMA user_version` is **4**.
3. Restore the `pre-0.2.110` snapshot only if the database itself is damaged (this release doesn't
   touch it).

## For the release owner

- The image build compiles `srtla_rec` per architecture in the `srtla` stage (arm64 under QEMU in
  `docker.yml`, like `prod-deps`). It fetches `github.com/BELABOX/srtla` at build time and checks the
  commit id.
- After the 0.2.110 PRs are merged into `main`, tag the merge commit named in the report:

```sh
git checkout <commit> && grep '"version"' package.json   # 0.2.110
git tag v0.2.110 && git push origin v0.2.110
```

The tag builds `:0.2.110`, `:0.2`, `:latest` and `:sha-<commit>` (amd64 + arm64). Only then start
section 1.
