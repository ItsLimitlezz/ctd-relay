// Show profiles: one versioned bundle per Relay profile. Saves are optimistic: a revision is only
// added when its parent is the current head, otherwise RevisionConflictError carries the real head.

import crypto from 'node:crypto';
import type { ShowProfileRecord, ShowProfilesRepo, ShowRevisionRecord, ShowRevisionSummary } from '../services.js';
import { transaction, type Db } from './database.js';
import { ConflictError, NotFoundError, RevisionConflictError, bool, int, nowIso, str, strOrNull, type Row, type Stmt } from './rows.js';

export const DEFAULT_KEEP_REVISIONS = 50;

const PROFILE_COLUMNS = 'id, profile_id, name, head_revision, created_at, updated_at';
const SUMMARY_COLUMNS =
  'show_profile_id, revision, parent_revision, bundle_sha256, size, saved_by_app, saved_by_token, note, pinned, created_at';

function toShowProfile(row: Row): ShowProfileRecord {
  return {
    id: str(row, 'id'),
    profileId: str(row, 'profile_id'),
    name: str(row, 'name'),
    headRevision: int(row, 'head_revision'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

function toSummary(row: Row): ShowRevisionSummary {
  return {
    showProfileId: str(row, 'show_profile_id'),
    revision: int(row, 'revision'),
    parentRevision: row.parent_revision === null || row.parent_revision === undefined ? null : int(row, 'parent_revision'),
    bundleSha256: str(row, 'bundle_sha256'),
    size: int(row, 'size'),
    savedByApp: strOrNull(row, 'saved_by_app'),
    savedByToken: strOrNull(row, 'saved_by_token'),
    note: strOrNull(row, 'note'),
    pinned: bool(row, 'pinned'),
    createdAt: str(row, 'created_at'),
  };
}

export function createShowProfilesRepo(db: Db, stmt: Stmt): ShowProfilesRepo {
  const get = (id: string): ShowProfileRecord | null => {
    const row = stmt(`SELECT ${PROFILE_COLUMNS} FROM show_profiles WHERE id = ?`).get(id);
    return row ? toShowProfile(row) : null;
  };
  const getByProfile = (profileId: string): ShowProfileRecord | null => {
    const row = stmt(`SELECT ${PROFILE_COLUMNS} FROM show_profiles WHERE profile_id = ?`).get(profileId);
    return row ? toShowProfile(row) : null;
  };
  const getRevision = (showProfileId: string, revision: number): ShowRevisionRecord | null => {
    const row = stmt(`SELECT ${SUMMARY_COLUMNS}, manifest FROM show_revisions WHERE show_profile_id = ? AND revision = ?`).get(
      showProfileId,
      revision,
    );
    return row ? { ...toSummary(row), manifest: str(row, 'manifest') } : null;
  };

  /** Not transactional by itself: callers wrap it (addRevision) or run a single statement. */
  const pruneRows = (showProfileId: string, keep: number): number => {
    const head = get(showProfileId)?.headRevision ?? 0;
    const result = stmt(
      `DELETE FROM show_revisions
       WHERE show_profile_id = ? AND pinned = 0 AND revision <> ?
         AND revision NOT IN (SELECT revision FROM show_revisions WHERE show_profile_id = ? ORDER BY revision DESC LIMIT ?)`,
    ).run(showProfileId, head, showProfileId, Math.max(0, Math.floor(keep)));
    return Number(result.changes);
  };

  return {
    list(profileId) {
      const rows = profileId
        ? stmt(`SELECT ${PROFILE_COLUMNS} FROM show_profiles WHERE profile_id = ? ORDER BY created_at, rowid`).all(profileId)
        : stmt(`SELECT ${PROFILE_COLUMNS} FROM show_profiles ORDER BY created_at, rowid`).all();
      return rows.map(toShowProfile);
    },

    get,
    getByProfile,

    addRevision(input, keep = DEFAULT_KEEP_REVISIONS) {
      return transaction(db, () => {
        const now = nowIso();
        let show = getByProfile(input.profileId);
        const head = show?.headRevision ?? 0;
        if (input.parentRevision !== head) throw new RevisionConflictError(head);
        if (!show) {
          const id = crypto.randomUUID();
          stmt(`INSERT INTO show_profiles (${PROFILE_COLUMNS}) VALUES (?, ?, ?, 0, ?, ?)`).run(id, input.profileId, input.name, now, now);
          show = get(id);
          if (!show) throw new Error('Show profile insert failed');
        }
        const revision = head + 1;
        stmt(`INSERT INTO show_revisions (${SUMMARY_COLUMNS}, manifest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(
          show.id,
          revision,
          head === 0 ? null : head,
          input.bundleSha256,
          input.size,
          input.savedByApp,
          input.savedByToken,
          input.note,
          now,
          input.manifest,
        );
        stmt('UPDATE show_profiles SET head_revision = ?, name = ?, updated_at = ? WHERE id = ?').run(revision, input.name, now, show.id);
        for (const sha of new Set([...input.blobs, input.bundleSha256])) {
          stmt('INSERT OR IGNORE INTO revision_blobs (show_profile_id, revision, sha256) VALUES (?, ?, ?)').run(show.id, revision, sha);
          stmt('UPDATE blobs SET last_ref_at = ? WHERE sha256 = ?').run(now, sha);
        }
        pruneRows(show.id, keep);
        const saved = getRevision(show.id, revision);
        if (!saved) throw new Error('Revision insert failed');
        return saved;
      });
    },

    listRevisions(showProfileId) {
      return stmt(`SELECT ${SUMMARY_COLUMNS} FROM show_revisions WHERE show_profile_id = ? ORDER BY revision DESC`)
        .all(showProfileId)
        .map(toSummary);
    },

    getRevision,

    setPinned(showProfileId, revision, pinned) {
      const result = stmt('UPDATE show_revisions SET pinned = ? WHERE show_profile_id = ? AND revision = ?').run(
        pinned ? 1 : 0,
        showProfileId,
        revision,
      );
      if (Number(result.changes) === 0) throw new NotFoundError('Revision not found');
    },

    deleteRevision(showProfileId, revision) {
      if (!getRevision(showProfileId, revision)) throw new NotFoundError('Revision not found');
      if (get(showProfileId)?.headRevision === revision) throw new ConflictError('The current revision cannot be deleted');
      stmt('DELETE FROM show_revisions WHERE show_profile_id = ? AND revision = ?').run(showProfileId, revision);
    },

    prune(showProfileId, keep = DEFAULT_KEEP_REVISIONS) {
      return pruneRows(showProfileId, keep);
    },

    deleteByProfile(profileId) {
      stmt('DELETE FROM show_profiles WHERE profile_id = ?').run(profileId);
    },
  };
}
