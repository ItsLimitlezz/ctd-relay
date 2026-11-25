// Guest feed slots (docs/API.md §18): one row per slot, keys in the encrypted secrets (scope
// `guest:<profileId>`, one entry per slot id), never here.
//
// Like the report tables (reports/schema.ts), the table has its own migration track, versioned in
// `guest_feeds_meta`, NOT in PRAGMA user_version: db/database.ts refuses a database whose
// user_version is newer than it knows, so bumping it would stop 0.2.80 from starting after a
// rollback. With a separate track the main schema stays v4, 0.2.80 opens the file and never looks
// at these tables, and deleting a profile there still removes its slots (ON DELETE CASCADE).
// Append only; never edit a shipped step.

import { randomBytes } from 'node:crypto';
import { GUEST_SLOT_RE } from '../../../shared/guest-feeds.js';
import { transaction, type Db } from './database.js';
import { int, isUniqueViolation, nowIso, str, type Row } from './rows.js';

export const GUEST_FEED_MIGRATIONS: readonly string[] = [
  // g1: slots.
  `
  CREATE TABLE guest_feeds (
    id         TEXT PRIMARY KEY,            -- the slot id ([a-z0-9]{10}): the RTMP path guest/<id>
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    revoked    INTEGER NOT NULL DEFAULT 0,  -- 1 = the key was revoked (no key in the secrets)
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX guest_feeds_profile ON guest_feeds(profile_id, created_at);
  `,
];

export function guestFeedSchemaVersion(db: Db): number {
  const exists = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'guest_feeds_meta'").get();
  if (!exists) return 0;
  const row = db.prepare("SELECT value FROM guest_feeds_meta WHERE key = 'schema'").get();
  return Number(row?.value ?? 0);
}

/** Create or upgrade the guest feed table. Leaves PRAGMA user_version alone. */
export function migrateGuestFeeds(db: Db, migrations: readonly string[] = GUEST_FEED_MIGRATIONS): void {
  db.exec('CREATE TABLE IF NOT EXISTS guest_feeds_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const from = guestFeedSchemaVersion(db);
  if (from > migrations.length) {
    throw new Error(`Guest feed tables are g${from}, newer than this app supports (g${migrations.length})`);
  }
  for (let v = from; v < migrations.length; v++) {
    transaction(db, () => {
      db.exec(migrations[v] ?? '');
      db.prepare("INSERT INTO guest_feeds_meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
        String(v + 1),
      );
    });
  }
}

export interface GuestSlotRow {
  id: string;
  profileId: string;
  name: string;
  revoked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GuestFeedsRepo {
  /** Every slot of every profile, oldest first. */
  all(): GuestSlotRow[];
  list(profileId: string): GuestSlotRow[];
  get(id: string): GuestSlotRow | null;
  count(profileId: string): number;
  /** New slot with a fresh, unused id. */
  create(profileId: string, name: string): GuestSlotRow;
  rename(id: string, name: string): GuestSlotRow | null;
  setRevoked(id: string, revoked: boolean): GuestSlotRow | null;
  delete(id: string): boolean;
  deleteProfile(profileId: string): string[];
}

const COLUMNS = 'id, profile_id, name, revoked, created_at, updated_at';
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 10 random characters of [a-z0-9] (~51 bits: ids are names, not secrets; the key is the secret). */
export function newSlotId(): string {
  const bytes = randomBytes(10);
  let id = '';
  for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
  return id;
}

function toRow(row: Row): GuestSlotRow {
  return {
    id: str(row, 'id'),
    profileId: str(row, 'profile_id'),
    name: str(row, 'name'),
    revoked: int(row, 'revoked') === 1,
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

export function createGuestFeedsRepo(db: Db, newId: () => string = newSlotId): GuestFeedsRepo {
  migrateGuestFeeds(db);
  const get = (id: string): GuestSlotRow | null => {
    const row = db.prepare(`SELECT ${COLUMNS} FROM guest_feeds WHERE id = ?`).get(id);
    return row ? toRow(row) : null;
  };
  const touch = (sql: string, ...args: (string | number)[]) => db.prepare(sql).run(...args).changes > 0;

  return {
    all: () => db.prepare(`SELECT ${COLUMNS} FROM guest_feeds ORDER BY created_at, rowid`).all().map(toRow),
    list: (profileId) => db.prepare(`SELECT ${COLUMNS} FROM guest_feeds WHERE profile_id = ? ORDER BY created_at, rowid`).all(profileId).map(toRow),
    get,
    count: (profileId) => Number(db.prepare('SELECT COUNT(*) AS n FROM guest_feeds WHERE profile_id = ?').get(profileId)?.n ?? 0),
    create(profileId, name) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const id = newId();
        if (!GUEST_SLOT_RE.test(id)) throw new Error('invalid guest slot id');
        const now = nowIso();
        try {
          db.prepare(`INSERT INTO guest_feeds (${COLUMNS}) VALUES (?, ?, ?, 0, ?, ?)`).run(id, profileId, name, now, now);
          return get(id)!;
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
      }
      throw new Error('Could not pick a free guest slot id');
    },
    rename: (id, name) => (touch('UPDATE guest_feeds SET name = ?, updated_at = ? WHERE id = ?', name, nowIso(), id) ? get(id) : null),
    setRevoked: (id, revoked) => (touch('UPDATE guest_feeds SET revoked = ?, updated_at = ? WHERE id = ?', revoked ? 1 : 0, nowIso(), id) ? get(id) : null),
    delete: (id) => touch('DELETE FROM guest_feeds WHERE id = ?', id),
    deleteProfile(profileId) {
      const ids = db.prepare('SELECT id FROM guest_feeds WHERE profile_id = ?').all(profileId).map((r) => str(r, 'id'));
      db.prepare('DELETE FROM guest_feeds WHERE profile_id = ?').run(profileId);
      return ids;
    },
  };
}
