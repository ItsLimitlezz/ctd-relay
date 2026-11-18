# Changelog

Versions follow the hub's CONVENTIONS.md → Versioning. Each release that ships to a TrueNAS install has a runbook in `docs/RELEASE-*.md` (backup, update, verify, rollback).

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
