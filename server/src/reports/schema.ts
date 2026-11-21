// Stream report tables (docs/REPORTS.md). They live in app.db next to everything else but have
// their own migration track: the version is kept in `reports_meta`, NOT in PRAGMA user_version.
//
// Why: db/database.ts refuses to open a database whose user_version is newer than the app knows.
// Bumping it for reports would stop an older Relay (0.2.40 and earlier) from starting after a
// rollback. With a separate track the main schema stays at v4, an older version opens the file
// and simply never looks at these tables, and a newer one picks up where it left off.
//
// Append only; never edit a shipped step. Every table is prefixed `report_` or `audience_`.

import { transaction, type Db } from '../db/database.js';

export const REPORT_MIGRATIONS: readonly string[] = [
  // r1: sessions, what happened during them, viewer samples, per-minute chat and feed stats, audience.
  `
  CREATE TABLE report_sessions (
    id               TEXT PRIMARY KEY, -- the orchestrator's session id
    profile_id       TEXT NOT NULL,
    started_at       TEXT NOT NULL,
    ended_at         TEXT,             -- NULL while live
    last_seen_at     TEXT NOT NULL,    -- last time the recorder wrote for it (end after a crash)
    ended_by_restart INTEGER NOT NULL DEFAULT 0,
    test_mode        INTEGER NOT NULL DEFAULT 0,
    audience         INTEGER NOT NULL DEFAULT 0 -- audience tracking was on for (part of) it
  );
  CREATE INDEX report_sessions_started ON report_sessions(started_at);
  CREATE INDEX report_sessions_profile ON report_sessions(profile_id, started_at);

  CREATE TABLE report_titles (
    session_id TEXT NOT NULL REFERENCES report_sessions(id) ON DELETE CASCADE,
    ts         TEXT NOT NULL,
    title      TEXT NOT NULL
  );
  CREATE INDEX report_titles_session ON report_titles(session_id, ts);

  CREATE TABLE report_destinations (
    session_id     TEXT NOT NULL REFERENCES report_sessions(id) ON DELETE CASCADE,
    destination_id TEXT NOT NULL,
    platform       TEXT NOT NULL,
    name           TEXT NOT NULL,
    feed           TEXT NOT NULL,
    dual_format    TEXT,
    PRIMARY KEY (session_id, destination_id)
  );

  CREATE TABLE report_live_periods (
    session_id     TEXT NOT NULL REFERENCES report_sessions(id) ON DELETE CASCADE,
    destination_id TEXT NOT NULL,
    started_at     TEXT NOT NULL,
    ended_at       TEXT
  );
  CREATE INDEX report_live_periods_session ON report_live_periods(session_id, destination_id);

  CREATE TABLE report_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     TEXT NOT NULL REFERENCES report_sessions(id) ON DELETE CASCADE,
    ts             TEXT NOT NULL,
    kind           TEXT NOT NULL,
    destination_id TEXT,
    platform       TEXT,
    detail         TEXT
  );
  CREATE INDEX report_events_session ON report_events(session_id, ts);

  CREATE TABLE report_viewer_samples (
    session_id     TEXT NOT NULL REFERENCES report_sessions(id) ON DELETE CASCADE,
    destination_id TEXT NOT NULL,
    ts             TEXT NOT NULL,
    viewers        INTEGER -- NULL = unknown, never 0 for unknown
  );
  CREATE INDEX report_viewer_samples_session ON report_viewer_samples(session_id, ts);

  CREATE TABLE report_chat_minutes (
    session_id      TEXT NOT NULL REFERENCES report_sessions(id) ON DELETE CASCADE,
    platform        TEXT NOT NULL,
    minute          TEXT NOT NULL, -- ISO time of the minute's start (UTC)
    messages        INTEGER NOT NULL DEFAULT 0,
    events          INTEGER NOT NULL DEFAULT 0,
    joins           INTEGER NOT NULL DEFAULT 0,
    unique_chatters INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, platform, minute)
  );

  CREATE TABLE report_chat_totals (
    session_id      TEXT NOT NULL REFERENCES report_sessions(id) ON DELETE CASCADE,
    platform        TEXT NOT NULL,
    messages        INTEGER NOT NULL DEFAULT 0,
    events          INTEGER NOT NULL DEFAULT 0,
    joins           INTEGER NOT NULL DEFAULT 0,
    anonymous_joins INTEGER NOT NULL DEFAULT 0,
    unique_chatters INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, platform)
  );

  CREATE TABLE report_feed_minutes (
    session_id   TEXT NOT NULL REFERENCES report_sessions(id) ON DELETE CASCADE,
    feed         TEXT NOT NULL,
    minute       TEXT NOT NULL,
    online       INTEGER NOT NULL,
    codec        TEXT,
    width        INTEGER,
    height       INTEGER,
    fps          REAL,
    bitrate_kbps REAL,
    keyframe_sec REAL,
    PRIMARY KEY (session_id, feed, minute)
  );

  CREATE TABLE report_presence (
    session_id     TEXT NOT NULL REFERENCES report_sessions(id) ON DELETE CASCADE,
    platform       TEXT NOT NULL,
    samples        INTEGER NOT NULL DEFAULT 0,
    last_sample_at TEXT,
    PRIMARY KEY (session_id, platform)
  );

  CREATE TABLE audience_users (
    id               TEXT PRIMARY KEY, -- <platform>:<id> or <platform>:name:<display name>
    platform         TEXT NOT NULL,
    platform_user_id TEXT,
    display_name     TEXT NOT NULL,
    login            TEXT,
    first_seen_at    TEXT NOT NULL,
    last_seen_at     TEXT NOT NULL
  );
  CREATE INDEX audience_users_platform ON audience_users(platform);

  CREATE TABLE audience_stream (
    session_id       TEXT NOT NULL REFERENCES report_sessions(id) ON DELETE CASCADE,
    user_id          TEXT NOT NULL REFERENCES audience_users(id) ON DELETE CASCADE,
    platform         TEXT NOT NULL,
    messages         INTEGER NOT NULL DEFAULT 0,
    events           INTEGER NOT NULL DEFAULT 0,
    joins            INTEGER NOT NULL DEFAULT 0,
    first_message_at TEXT,
    last_message_at  TEXT,
    first_seen_at    TEXT NOT NULL,
    last_seen_at     TEXT NOT NULL,
    presence_samples INTEGER NOT NULL DEFAULT 0,
    watch_sec        INTEGER, -- NULL unless the platform reports presence
    PRIMARY KEY (session_id, user_id)
  );
  CREATE INDEX audience_stream_user ON audience_stream(user_id);
  `,
];

export function reportSchemaVersion(db: Db): number {
  const exists = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'reports_meta'").get();
  if (!exists) return 0;
  const row = db.prepare("SELECT value FROM reports_meta WHERE key = 'schema'").get();
  return Number(row?.value ?? 0);
}

/** Create or upgrade the report tables. Leaves PRAGMA user_version alone. */
export function migrateReports(db: Db, migrations: readonly string[] = REPORT_MIGRATIONS): void {
  db.exec('CREATE TABLE IF NOT EXISTS reports_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const from = reportSchemaVersion(db);
  if (from > migrations.length) {
    throw new Error(`Report tables are r${from}, newer than this app supports (r${migrations.length})`);
  }
  for (let v = from; v < migrations.length; v++) {
    transaction(db, () => {
      db.exec(migrations[v] ?? '');
      db.prepare("INSERT INTO reports_meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
        String(v + 1),
      );
    });
  }
}
