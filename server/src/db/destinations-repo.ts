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
  'id, profile_id, platform, account_id, name, feed, enabled, options, ingest_url, has_stream_key, transcode_json, created_at, updated_at';

/** Stored transcoding profile; unreadable JSON counts as none (copy), never as an error. */
function transcodeOf(row: Row): TranscodeProfile | null {
  const raw = strOrNull(row, 'transcode_json');
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as TranscodeProfile) : null;
  } catch {
    return null;
  }
}

function toDestination(row: Row): Destination {
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
    transcode: transcodeOf(row),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

const flag = (v: boolean | undefined) => (v === undefined ? undefined : v ? 1 : 0);

export function createDestinationsRepo(stmt: Stmt): DestinationsRepo {
  const get = (id: string): Destination | null => {
    const row = stmt(`SELECT ${COLUMNS} FROM destinations WHERE id = ?`).get(id);
    return row ? toDestination(row) : null;
  };

  return {
    list(profileId) {
      if (profileId === undefined) {
        return stmt(`SELECT ${COLUMNS} FROM destinations ORDER BY created_at, rowid`).all().map(toDestination);
      }
      return stmt(`SELECT ${COLUMNS} FROM destinations WHERE profile_id = ? ORDER BY created_at, rowid`)
        .all(profileId)
        .map(toDestination);
    },

    get,

    create(input) {
      const id = crypto.randomUUID();
      const now = nowIso();
      stmt(`INSERT INTO destinations (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(
        id,
        input.profileId || DEFAULT_PROFILE_ID,
        input.platform,
        input.accountId,
        input.name,
        input.feed,
        input.enabled ? 1 : 0,
        JSON.stringify(input.options ?? {}),
        input.ingestUrl,
        input.transcode ? JSON.stringify(input.transcode) : null,
        now,
        now,
      );
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
        transcode_json: patch.transcode === undefined ? undefined : patch.transcode ? JSON.stringify(patch.transcode) : null,
      });
      const updated = changes > 0 ? get(id) : null;
      if (!updated) throw new NotFoundError('Destination not found');
      return updated;
    },

    delete(id) {
      stmt('DELETE FROM destinations WHERE id = ?').run(id);
    },

    detachAccount(accountId) {
      stmt('UPDATE destinations SET account_id = NULL, updated_at = ? WHERE account_id = ?').run(nowIso(), accountId);
    },
  };
}
