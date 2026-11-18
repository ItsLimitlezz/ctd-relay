# Changelog

Versions follow the hub's CONVENTIONS.md → Versioning. Each release that ships to a TrueNAS install has a runbook in `docs/RELEASE-*.md` (backup, update, verify, rollback).

## Unreleased

API revision **1.11**. Database schema stays at **v4** (no migration).

### Added
- **Issues: one alert contract for the suite (Relay F2).** Two new events on `/api/v1/events`, `issue.raised` and `issue.cleared` (`status:read`), tell every CTD app that something is wrong and when it is fixed. Relay raises `feed.offline` (a live session's feed from OBS went away and OBS didn't stop on purpose), `destination.down` (a destination stayed down 5 s; critical once Relay gave up), `stream.down` (every destination is down) and `obs.output.down` (OBS reconnecting), and passes on the CTD OBS plugin's issues as `obs.issue`. Each issue has a stable `id`, a `severity` (`info` / `warning` / `critical`), a `subject`, and a `resolution` when it clears (`recovered`, `ended`, `removed`, `stale`). Hold times keep one-second blips from becoming alerts. `GET /api/v1/status` carries the open ones in `issues`. Kept in memory only. See docs/API.md §15 and docs/CONTRACTS.md → Alert contract.
- **`obs.failover`**: a new OBS event type the CTD OBS plugin sends when it switches program away from a dead feed. Relay re-emits it on `/events` and keeps no state. `obs.issue.raised` may carry `onProgram` and `scene`.
- **OBS dock:** lists the open issues that aren't a down destination, and flashes and beeps for a new critical one when Alert is ticked.

## 0.2.20 (2026-11-18)

API revision **1.10**. Database schema stays at **v4** (no migration). Runbook: [docs/RELEASE-v0.2.20.md](docs/RELEASE-v0.2.20.md).

### Added
- **Overlay scenes (#23).** An overlay resource can list its scenes in `meta.scenes` (`[{ "id", "name", "url" }]`), so the CTD Relay dock in CTD OBS can add a single scene as its own browser source. Relay checks them: `http(s)` URLs of at most 2048 characters, at most 50 scenes, unique ids, 16 KB of JSON in all, and that budget is separate from the 4 KB limit on the rest of `meta`. A malformed `scenes` refuses the registration with `400 invalid` and names the field. `meta` is stored and returned exactly as sent (`GET /apps`, `GET /profiles/{id}/overlays`, `apps.changed`). See docs/API.md §9.2.
- **Transcoding capability check (#20, TC-1).** Once at startup, in the background, Relay asks its FFmpeg which hardware acceleration methods, encoders and decoders it has. Then it runs one short test encode per candidate encoder: 30 synthetic 720p frames to FFmpeg's null output, at low CPU priority, each capped at 15 s. The result is kept in memory and shown in **Settings → About → Transcoding**, and also at `GET /api/system/transcode-capabilities` (signed-in users) and `GET /api/v1/system/transcode-capabilities` (`status:read`). It is read-only: Relay still sends every destination the stream as OBS sends it, and nothing is transcoded.

### Docs
- **Transcoding design (#19):** [docs/TRANSCODING.md](docs/TRANSCODING.md), per-destination transcoding (opt-in, hardware-gated). Only §4, capability detection, is built so far.

## 0.2.10 (2026-11-17)

Bug fix. Schema v4, API 1.9. Runbook: [docs/RELEASE-v0.2.10.md](docs/RELEASE-v0.2.10.md).

- **Pairing again (#21):** an app that pairs again and registers its same id replaces its old connection instead of piling up `-xxxxxx` entries. Stale entries are cleaned up, and the superseded token is revoked 3 minutes later unless it is still in use.
- Dashboard: the vertical feed hint reads "Start the vertical stream in CTD OBS."

## 0.2.0 (2026-11-09)

Show profiles. Schema v4 (migration v3 → v4), API 1.9. Runbook: [docs/RELEASE-v1.9.md](docs/RELEASE-v1.9.md).

- Show profiles (OBS set-ups saved as revisions), content-addressed blobs, asset library and the **Assets** page.
- The ingest host given to OBS follows the public host when the app reached Relay through one (#15).
- "Waiting for <feed>" status instead of idle; fixed destination count (#16).
