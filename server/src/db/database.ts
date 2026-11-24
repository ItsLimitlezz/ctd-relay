// SQLite via node:sqlite (synchronous). Schema migrations are keyed by PRAGMA user_version.
// API: https://nodejs.org/docs/latest-v24.x/api/sqlite.html

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

/** Each entry migrates from user_version = index to index + 1. Append only; never edit a shipped step. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE users (
    id                  TEXT PRIMARY KEY,
    username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash       TEXT NOT NULL,
    role                TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
    totp_secret         TEXT,
    totp_pending_secret TEXT,
    totp_enabled        INTEGER NOT NULL DEFAULT 0,
    failed_logins       INTEGER NOT NULL DEFAULT 0,
    locked_until        TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    last_login_at       TEXT
  );

  CREATE TABLE auth_sessions (
    id           TEXT PRIMARY KEY, -- sha256 hex of the raw cookie token
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    ip           TEXT,
    user_agent   TEXT
  );
  CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
  CREATE INDEX auth_sessions_expires ON auth_sessions(expires_at);

  CREATE TABLE accounts (
    id             TEXT PRIMARY KEY,
    platform       TEXT NOT NULL,
    label          TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    status_message TEXT,
    options        TEXT NOT NULL DEFAULT '{}',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE destinations (
    id             TEXT PRIMARY KEY,
    platform       TEXT NOT NULL,
    account_id     TEXT, -- no FK: DestinationsRepo.detachAccount clears it
    name           TEXT NOT NULL,
    feed           TEXT NOT NULL,
    enabled        INTEGER NOT NULL DEFAULT 1,
    options        TEXT NOT NULL DEFAULT '{}',
    ingest_url     TEXT,
    has_stream_key INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX destinations_account ON destinations(account_id);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL -- JSON
  );

  CREATE TABLE secrets (
    scope      TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL, -- SecretBox ciphertext
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope, key)
  );

  CREATE TABLE audit (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    user_id  TEXT,
    username TEXT,
    action   TEXT NOT NULL,
    detail   TEXT,
    ip       TEXT
  );
  `,
  // v2: personal access tokens for the external API (/api/v1). Only a SHA-256 of the secret is stored.
  `
  CREATE TABLE api_tokens (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    scopes       TEXT NOT NULL DEFAULT '[]', -- JSON array of ApiScope
    prefix       TEXT NOT NULL,              -- first 12 characters of the secret, to recognise it
    secret_hash  TEXT NOT NULL UNIQUE,       -- sha256 hex of the secret
    created_at   TEXT NOT NULL,
    created_by   TEXT,
    last_used_at TEXT
  );
  `,
  // v3: profiles (independent streaming set-ups that can be live at once) and the hub's connected
  // apps. Everything that existed joins the default profile ('default'), which keeps the legacy
  // settings keys and secret scopes; existing API tokens stay "every profile" (NULL).
  `
  CREATE TABLE profiles (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE, -- OBS stream key prefix for non-default profiles; never changes
    color      TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO profiles (id, name, slug, color, created_at, updated_at)
  VALUES ('default', 'Main', 'main', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

  ALTER TABLE accounts ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default';
  ALTER TABLE destinations ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default';
  ALTER TABLE api_tokens ADD COLUMN profile_id TEXT; -- NULL = every profile
  CREATE INDEX accounts_profile ON accounts(profile_id);
  CREATE INDEX destinations_profile ON destinations(profile_id);

  CREATE TABLE connected_apps (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL,
    version       TEXT,
    base_url      TEXT,
    capabilities  TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
    resources     TEXT NOT NULL DEFAULT '[]', -- JSON array of AppResource
    token_id      TEXT NOT NULL,              -- API token that registered the app (only it may change it)
    profile_id    TEXT,                       -- that token's profile (NULL = every profile)
    registered_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL
  );
  CREATE INDEX connected_apps_token ON connected_apps(token_id);
  `,
  // v4: show profiles (one versioned OBS/overlay bundle per Relay profile), their revisions, the
  // content-addressed blob index and the shared asset library. Blob bytes live on disk, not here.
  `
  CREATE TABLE show_profiles (
    id            TEXT PRIMARY KEY,
    profile_id    TEXT NOT NULL UNIQUE, -- exactly one show profile per Relay profile
    name          TEXT NOT NULL,
    head_revision INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX show_profiles_profile ON show_profiles(profile_id);

  CREATE TABLE show_revisions (
    show_profile_id TEXT NOT NULL REFERENCES show_profiles(id) ON DELETE CASCADE,
    revision        INTEGER NOT NULL,
    parent_revision INTEGER,
    manifest        TEXT NOT NULL, -- manifest JSON (<= 1 MB)
    bundle_sha256   TEXT NOT NULL, -- blob: the bundle's JSON files as one tar
    size            INTEGER NOT NULL,
    saved_by_app    TEXT,
    saved_by_token  TEXT,
    note            TEXT,
    pinned          INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (show_profile_id, revision)
  );

  CREATE TABLE blobs (
    sha256      TEXT PRIMARY KEY,
    size        INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    last_ref_at TEXT NOT NULL
  );

  CREATE TABLE revision_blobs (
    show_profile_id TEXT NOT NULL,
    revision        INTEGER NOT NULL,
    sha256          TEXT NOT NULL,
    PRIMARY KEY (show_profile_id, revision, sha256),
    FOREIGN KEY (show_profile_id, revision) REFERENCES show_revisions ON DELETE CASCADE
  );
  CREATE INDEX revision_blobs_sha ON revision_blobs(sha256);

  CREATE TABLE asset_library (
    id          TEXT PRIMARY KEY,
    sha256      TEXT NOT NULL REFERENCES blobs(sha256),
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    profile_id  TEXT, -- NULL = every profile
    uploaded_by TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX asset_library_sha ON asset_library(sha256);
  `,
];

/** Run `fn` inside a transaction (BEGIN IMMEDIATE), rolling back on error. Not reentrant. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}

export function migrate(db: Db, migrations: readonly string[] = MIGRATIONS): void {
  const from = schemaVersion(db);
  if (from > migrations.length) {
    throw new Error(`Database schema v${from} is newer than this app supports (v${migrations.length}); upgrade the app`);
  }
  for (let v = from; v < migrations.length; v++) {
    transaction(db, () => {
      db.exec(migrations[v] ?? '');
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Open (or create) the database, apply pragmas and migrations. Accepts ':memory:' for tests. */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file, { timeout: 5000, enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL'); // safe with WAL
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
