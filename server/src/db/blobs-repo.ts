// Blob index and the shared asset library. Only metadata lives here (the bytes are files on disk);
// a blob is in use while a revision or a library entry references it.

import crypto from 'node:crypto';
import type { AssetLibraryRepo, BlobRecord, BlobUsage, BlobsRepo, LibraryAsset } from '../services.js';
import { NotFoundError, int, nowIso, str, strOrNull, type Row, type Stmt } from './rows.js';

const BLOB_COLUMNS = 'sha256, size, kind, created_at, last_ref_at';

function toBlob(row: Row): BlobRecord {
  return {
    sha256: str(row, 'sha256'),
    size: int(row, 'size'),
    kind: str(row, 'kind'),
    createdAt: str(row, 'created_at'),
    lastRefAt: str(row, 'last_ref_at'),
  };
}

export function createBlobsRepo(stmt: Stmt): BlobsRepo {
  const get = (sha256: string): BlobRecord | null => {
    const row = stmt(`SELECT ${BLOB_COLUMNS} FROM blobs WHERE sha256 = ?`).get(sha256);
    return row ? toBlob(row) : null;
  };

  return {
    get,

    upsert({ sha256, size, kind }) {
      const now = nowIso();
      stmt(
        `INSERT INTO blobs (${BLOB_COLUMNS}) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sha256) DO UPDATE SET last_ref_at = excluded.last_ref_at`,
      ).run(sha256, size, kind, now, now);
      const blob = get(sha256);
      if (!blob) throw new Error('Blob upsert failed');
      return blob;
    },

    touch(sha256s) {
      const now = nowIso();
      for (const sha of new Set(sha256s)) stmt('UPDATE blobs SET last_ref_at = ? WHERE sha256 = ?').run(now, sha);
    },

    delete(sha256) {
      stmt('DELETE FROM blobs WHERE sha256 = ?').run(sha256);
    },

    missing(sha256s) {
      return [...new Set(sha256s)].filter((sha) => get(sha) === null);
    },

    listUnreferenced(beforeIso) {
      return stmt(
        `SELECT ${BLOB_COLUMNS} FROM blobs b
         WHERE b.last_ref_at < ?
           AND NOT EXISTS (SELECT 1 FROM revision_blobs r WHERE r.sha256 = b.sha256)
           AND NOT EXISTS (SELECT 1 FROM asset_library a WHERE a.sha256 = b.sha256)
         ORDER BY b.last_ref_at, b.rowid`,
      )
        .all(beforeIso)
        .map(toBlob);
    },

    totalSize() {
      const row = stmt('SELECT COALESCE(SUM(size), 0) AS total FROM blobs').get();
      return row ? int(row, 'total') : 0;
    },

    isVisible(sha256, profileId) {
      const inRevision =
        profileId === null
          ? stmt('SELECT 1 AS x FROM revision_blobs WHERE sha256 = ? LIMIT 1').get(sha256)
          : stmt(
              `SELECT 1 AS x FROM revision_blobs r JOIN show_profiles s ON s.id = r.show_profile_id
               WHERE r.sha256 = ? AND s.profile_id = ? LIMIT 1`,
            ).get(sha256, profileId);
      if (inRevision) return true;
      const inLibrary =
        profileId === null
          ? stmt('SELECT 1 AS x FROM asset_library WHERE sha256 = ? LIMIT 1').get(sha256)
          : stmt('SELECT 1 AS x FROM asset_library WHERE sha256 = ? AND (profile_id IS NULL OR profile_id = ?) LIMIT 1').get(sha256, profileId);
      return !!inLibrary;
    },

    usage(sha256) {
      return stmt(
        `SELECT s.profile_id AS profile_id, s.id AS show_profile_id, r.revision AS revision, (r.revision = s.head_revision) AS is_head
         FROM revision_blobs r JOIN show_profiles s ON s.id = r.show_profile_id
         WHERE r.sha256 = ? ORDER BY s.profile_id, r.revision DESC`,
      )
        .all(sha256)
        .map(
          (row): BlobUsage => ({
            profileId: str(row, 'profile_id'),
            showProfileId: str(row, 'show_profile_id'),
            revision: int(row, 'revision'),
            isHead: int(row, 'is_head') !== 0,
          }),
        );
    },
  };
}

const ASSET_SELECT = `SELECT a.id, a.sha256, a.name, a.kind, a.profile_id, a.uploaded_by, a.created_at, b.size
  FROM asset_library a JOIN blobs b ON b.sha256 = a.sha256`;

function toAsset(row: Row): LibraryAsset {
  return {
    id: str(row, 'id'),
    sha256: str(row, 'sha256'),
    name: str(row, 'name'),
    kind: str(row, 'kind'),
    profileId: strOrNull(row, 'profile_id'),
    uploadedBy: strOrNull(row, 'uploaded_by'),
    createdAt: str(row, 'created_at'),
    size: int(row, 'size'),
  };
}

export function createAssetLibraryRepo(stmt: Stmt): AssetLibraryRepo {
  const get = (id: string): LibraryAsset | null => {
    const row = stmt(`${ASSET_SELECT} WHERE a.id = ?`).get(id);
    return row ? toAsset(row) : null;
  };

  return {
    list(opts = {}) {
      const where: string[] = [];
      const params: string[] = [];
      if (opts.profileId !== undefined) {
        where.push('(a.profile_id IS NULL OR a.profile_id = ?)');
        params.push(opts.profileId);
      }
      if (opts.kind !== undefined) {
        where.push('a.kind = ?');
        params.push(opts.kind);
      }
      const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
      return stmt(`${ASSET_SELECT}${clause} ORDER BY a.created_at DESC, a.rowid DESC`)
        .all(...params)
        .map(toAsset);
    },

    get,

    create({ sha256, name, kind, profileId, uploadedBy }) {
      const id = crypto.randomUUID();
      stmt('INSERT INTO asset_library (id, sha256, name, kind, profile_id, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id,
        sha256,
        name,
        kind,
        profileId,
        uploadedBy,
        nowIso(),
      );
      const created = get(id);
      if (!created) throw new Error('Library insert failed');
      return created;
    },

    update(id, patch) {
      if (!get(id)) throw new NotFoundError('Library asset not found');
      if (patch.name !== undefined) stmt('UPDATE asset_library SET name = ? WHERE id = ?').run(patch.name, id);
      if (patch.profileId !== undefined) stmt('UPDATE asset_library SET profile_id = ? WHERE id = ?').run(patch.profileId, id);
      const updated = get(id);
      if (!updated) throw new NotFoundError('Library asset not found');
      return updated;
    },

    delete(id) {
      stmt('DELETE FROM asset_library WHERE id = ?').run(id);
    },

    deleteByProfile(profileId) {
      stmt('DELETE FROM asset_library WHERE profile_id = ?').run(profileId);
    },
  };
}
