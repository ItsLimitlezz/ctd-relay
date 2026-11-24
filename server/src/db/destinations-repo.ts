import crypto from 'node:crypto';
import { DEFAULT_PROFILE_ID, type Destination, type Feed, type PlatformId, type TranscodeProfile } from '../../../shared/types.js';
import type { DestinationsRepo } from '../services.js';
import {
  NotFoundError,
  bool,
  jsonObject,
  nowIso,
  str,
  strOrNull,
  updateById,
  type Row,
  type Stmt,
} from './rows.js';

const COLUMNS =
  'id, profile_id, platform, account_id, name, feed, enabled, options, ingest_url, has_stream_key, created_at, updated_at';

/**
 * A destination's transcoding profile is one row of the settings table, `transcode.profile.<id>`, not a
 * column: the schema stays at v4, so a rollback to 0.2.70 (which refuses a newer schema) opens the
 * database as it is and simply ignores these rows (docs/TRANSCODING.md §2, docs/CONTRACTS.md).
 */
export const TRANSCODE_PROFILE_KEY_PREFIX = 'transcode.profile.';
const profileKey = (destinationId: string) => `${TRANSCODE_PROFILE_KEY_PREFIX}${destinationId}`;

/** Stored transcoding profile; unreadable JSON counts as none (copy), never as an error. */
function parseProfile(raw: unknown): TranscodeProfile | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as TranscodeProfile) : null;
  } catch {
    return null;
  }
}

function toDestination(row: Row, transcode: TranscodeProfile | null): Destination {
  return {
    id: str(row, 'id'),
    profileId: str(row, 'profile_id'),
    platform: str(row, 'platform') as PlatformId,
    accountId: strOrNull(row, 'account_id'),
    name: str(row, 'name'),
    feed: str(row, 'feed') as Feed,
    enabled: bool(row, 'enabled'),
    options: jsonObject(row, 'options'),
    ingestUrl: strOrNull(row, 'ingest_url'),
    hasStreamKey: bool(row, 'has_stream_key'),
    transcode,
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

const flag = (v: boolean | undefined) => (v === undefined ? undefined : v ? 1 : 0);

export function createDestinationsRepo(stmt: Stmt): DestinationsRepo {
  const profileOf = (id: string): TranscodeProfile | null =>
    parseProfile(stmt('SELECT value FROM settings WHERE key = ?').get(profileKey(id))?.value);

  /** Every stored profile at once (one query for a list, not one per destination). */
  const allProfiles = (): Map<string, TranscodeProfile> => {
    const out = new Map<string, TranscodeProfile>();
    // An exact prefix match, not LIKE.
    const rows = stmt('SELECT key, value FROM settings WHERE substr(key, 1, ?) = ?').all(TRANSCODE_PROFILE_KEY_PREFIX.length, TRANSCODE_PROFILE_KEY_PREFIX);
    for (const row of rows) {
      const profile = parseProfile(row.value);
      if (profile && typeof row.key === 'string') out.set(row.key.slice(TRANSCODE_PROFILE_KEY_PREFIX.length), profile);
    }
    return out;
  };

  const setProfile = (id: string, profile: TranscodeProfile | null): void => {
    if (profile) {
      stmt('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(profileKey(id), JSON.stringify(profile));
    } else {
      stmt('DELETE FROM settings WHERE key = ?').run(profileKey(id));
    }
  };

  const get = (id: string): Destination | null => {
    const row = stmt(`SELECT ${COLUMNS} FROM destinations WHERE id = ?`).get(id);
    return row ? toDestination(row, profileOf(id)) : null;
  };

  const many = (rows: Row[]): Destination[] => {
    const profiles = rows.length > 0 ? allProfiles() : new Map<string, TranscodeProfile>();
    return rows.map((row) => toDestination(row, profiles.get(str(row, 'id')) ?? null));
  };

  return {
    list(profileId) {
      if (profileId === undefined) {
        return many(stmt(`SELECT ${COLUMNS} FROM destinations ORDER BY created_at, rowid`).all());
      }
      return many(stmt(`SELECT ${COLUMNS} FROM destinations WHERE profile_id = ? ORDER BY created_at, rowid`).all(profileId));
    },

    get,

    create(input) {
      const id = crypto.randomUUID();
      const now = nowIso();
      stmt(`INSERT INTO destinations (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(
        id,
        input.profileId || DEFAULT_PROFILE_ID,
        input.platform,
        input.accountId,
        input.name,
        input.feed,
        input.enabled ? 1 : 0,
        JSON.stringify(input.options ?? {}),
        input.ingestUrl,
        now,
        now,
      );
      if (input.transcode) setProfile(id, input.transcode);
      const created = get(id);
      if (!created) throw new Error('Destination insert failed');
      return created;
    },

    update(id, patch) {
      const changes = updateById(stmt, 'destinations', id, {
        account_id: patch.accountId,
        name: patch.name,
        feed: patch.feed,
        enabled: flag(patch.enabled),
        options: patch.options === undefined ? undefined : JSON.stringify(patch.options),
        ingest_url: patch.ingestUrl,
        has_stream_key: flag(patch.hasStreamKey),
      });
      if (changes > 0 && patch.transcode !== undefined) setProfile(id, patch.transcode);
      const updated = changes > 0 ? get(id) : null;
      if (!updated) throw new NotFoundError('Destination not found');
      return updated;
    },

    delete(id) {
      stmt('DELETE FROM destinations WHERE id = ?').run(id);
      setProfile(id, null);
    },

    detachAccount(accountId) {
      stmt('UPDATE destinations SET account_id = NULL, updated_at = ? WHERE account_id = ?').run(nowIso(), accountId);
    },
  };
}
