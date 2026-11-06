import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecretBox } from '../security/secretbox.js';
import type { Repos } from '../services.js';
import { openDatabase, type Db } from './database.js';
import { ConflictError, NotFoundError, RevisionConflictError, createRepos } from './repos.js';

let db: Db;
let repos: Repos;
let profileId: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
  profileId = repos.profiles.create({ name: 'DPRTMNT', color: null }).id;
});
afterEach(() => {
  db.close();
});

const sha = (n: number | string) => crypto.createHash('sha256').update(String(n)).digest('hex');

function save(parentRevision: number, extra: Partial<{ profileId: string; blobs: string[]; bundle: string }> = {}, keep?: number) {
  return repos.showProfiles.addRevision(
    {
      profileId: extra.profileId ?? profileId,
      name: 'Show',
      parentRevision,
      manifest: '{"v":1}',
      bundleSha256: extra.bundle ?? sha(`bundle-${parentRevision}`),
      size: 10,
      blobs: extra.blobs ?? [],
      savedByApp: 'obs',
      savedByToken: 'tok',
      note: null,
    },
    keep,
  );
}

const revisionBlobs = () => db.prepare('SELECT revision, sha256 FROM revision_blobs ORDER BY revision, sha256').all();

describe('addRevision', () => {
  it('the first save creates the show profile at revision 1', () => {
    const rev = save(0);
    expect(rev).toMatchObject({ revision: 1, parentRevision: null, manifest: '{"v":1}', savedByApp: 'obs', savedByToken: 'tok', note: null, pinned: false });
    const show = repos.showProfiles.getByProfile(profileId)!;
    expect(show).toMatchObject({ id: rev.showProfileId, profileId, name: 'Show', headRevision: 1 });
    expect(repos.showProfiles.get(show.id)).toEqual(show);
    expect(repos.showProfiles.list()).toEqual([show]);
    expect(repos.showProfiles.list(profileId)).toEqual([show]);
    expect(repos.showProfiles.list('other')).toEqual([]);
  });

  it('adds head + 1 when the parent is the head, and updates name and head', () => {
    save(0);
    const second = repos.showProfiles.addRevision({
      profileId, name: 'Renamed', parentRevision: 1, manifest: '{}', bundleSha256: sha('b2'), size: 5,
      blobs: [], savedByApp: null, savedByToken: null, note: 'n',
    });
    expect(second).toMatchObject({ revision: 2, parentRevision: 1, note: 'n', savedByApp: null });
    expect(repos.showProfiles.getByProfile(profileId)).toMatchObject({ name: 'Renamed', headRevision: 2 });
    expect(repos.showProfiles.getRevision(second.showProfileId, 2)).toEqual(second);
    expect(repos.showProfiles.getRevision(second.showProfileId, 3)).toBeNull();
  });

  it('throws RevisionConflictError with the head for a stale parent, and writes nothing', () => {
    save(0);
    save(1);
    const before = revisionBlobs();
    let err: unknown;
    try {
      save(1, { blobs: [sha('x')] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RevisionConflictError);
    expect(err).toMatchObject({ head: 2, statusCode: 409, code: 'revision_conflict' });
    expect(repos.showProfiles.listRevisions(repos.showProfiles.getByProfile(profileId)!.id)).toHaveLength(2);
    expect(revisionBlobs()).toEqual(before);
  });

  it('a second "first save" conflicts with head 1; a parent beyond a missing profile conflicts with head 0', () => {
    save(0);
    expect(() => save(0)).toThrow(RevisionConflictError);
    expect(() => save(0)).toThrowError(expect.objectContaining({ head: 1 }));

    const other = repos.profiles.create({ name: 'Other', color: null }).id;
    expect(() => save(3, { profileId: other })).toThrowError(expect.objectContaining({ head: 0 }));
    expect(repos.showProfiles.getByProfile(other)).toBeNull();
  });

  it('records revision_blobs (deduped, bundle included) and touches existing blobs', () => {
    const [a, b, bundle] = [sha('a'), sha('b'), sha('bundle')];
    repos.blobs.upsert({ sha256: a, size: 1, kind: 'image' });
    db.prepare('UPDATE blobs SET last_ref_at = ?').run('2020-01-01T00:00:00.000Z');
    save(0, { blobs: [a, b, a], bundle });
    expect(revisionBlobs()).toEqual([a, b, bundle].sort().map((s) => ({ revision: 1, sha256: s })));
    expect(repos.blobs.get(a)!.lastRefAt > '2020-01-01T00:00:00.000Z').toBe(true);
  });
});

describe('pruning and deleting revisions', () => {
  it('keeps the newest 50 plus pinned, never the head', () => {
    for (let i = 0; i < 52; i++) save(i);
    const id = repos.showProfiles.getByProfile(profileId)!.id;
    // addRevision pruned along the way: revisions 1 and 2 are gone, 3..52 stay.
    expect(repos.showProfiles.listRevisions(id).map((r) => r.revision)).toEqual(Array.from({ length: 50 }, (_, i) => 52 - i));

    repos.showProfiles.setPinned(id, 3, true);
    save(52); // revision 53 pushes 3 out of the newest 50, but it is pinned
    const kept = repos.showProfiles.listRevisions(id).map((r) => r.revision);
    expect(kept).toContain(3);
    expect(kept[0]).toBe(53);
    expect(kept).toHaveLength(51);

    expect(repos.showProfiles.prune(id, 0)).toBe(49);
    expect(repos.showProfiles.listRevisions(id).map((r) => r.revision)).toEqual([53, 3]);
  });

  it('prune removes the revision_blobs rows of removed revisions', () => {
    save(0, { blobs: [sha('old')] });
    save(1);
    const id = repos.showProfiles.getByProfile(profileId)!.id;
    expect(repos.showProfiles.prune(id, 1)).toBe(1);
    expect(revisionBlobs().every((r) => r.revision === 2)).toBe(true);
  });

  it('setPinned and deleteRevision', () => {
    save(0);
    save(1);
    const id = repos.showProfiles.getByProfile(profileId)!.id;
    repos.showProfiles.setPinned(id, 1, true);
    expect(repos.showProfiles.getRevision(id, 1)!.pinned).toBe(true);
    repos.showProfiles.setPinned(id, 1, false);
    expect(repos.showProfiles.getRevision(id, 1)!.pinned).toBe(false);
    expect(() => repos.showProfiles.setPinned(id, 9, true)).toThrow(NotFoundError);

    expect(() => repos.showProfiles.deleteRevision(id, 2)).toThrow(ConflictError);
    expect(() => repos.showProfiles.deleteRevision(id, 9)).toThrow(NotFoundError);
    repos.showProfiles.deleteRevision(id, 1);
    expect(repos.showProfiles.listRevisions(id).map((r) => r.revision)).toEqual([2]);
  });
});

describe('deleteByProfile', () => {
  it('removes the show profile with its revisions and revision_blobs, and only that', () => {
    const other = repos.profiles.create({ name: 'Other', color: null }).id;
    save(0, { blobs: [sha('a')] });
    save(1);
    save(0, { profileId: other, blobs: [sha('z')] });
    repos.showProfiles.deleteByProfile(profileId);
    expect(repos.showProfiles.getByProfile(profileId)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM show_revisions').get()?.n).toBe(1);
    expect(revisionBlobs().length).toBe(2); // other's bundle + z
    // A later first save starts over at revision 1.
    expect(save(0).revision).toBe(1);
  });

  it('deleting a Relay profile through the profiles repo is not blocked by it (FK-free link)', () => {
    save(0);
    repos.showProfiles.deleteByProfile(profileId);
    repos.profiles.delete(profileId);
    expect(repos.showProfiles.list()).toEqual([]);
  });
});
