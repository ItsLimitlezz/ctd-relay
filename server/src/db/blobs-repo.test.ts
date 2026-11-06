import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecretBox } from '../security/secretbox.js';
import type { Repos } from '../services.js';
import { openDatabase, type Db } from './database.js';
import { NotFoundError, createRepos } from './repos.js';

let db: Db;
let repos: Repos;
let club: string;
let other: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
  club = repos.profiles.create({ name: 'Club', color: null }).id;
  other = repos.profiles.create({ name: 'Other', color: null }).id;
});
afterEach(() => {
  db.close();
});

const sha = (n: string) => crypto.createHash('sha256').update(n).digest('hex');
const OLD = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

function saveWith(profileId: string, parent: number, blobs: string[]) {
  return repos.showProfiles.addRevision({
    profileId, name: 'S', parentRevision: parent, manifest: '{}', bundleSha256: sha(`bundle-${profileId}-${parent}`), size: 1,
    blobs, savedByApp: null, savedByToken: null, note: null,
  });
}

describe('blobs', () => {
  it('upserts, keeps the original row and refreshes last_ref_at', () => {
    const first = repos.blobs.upsert({ sha256: sha('a'), size: 5, kind: 'image' });
    expect(first).toMatchObject({ sha256: sha('a'), size: 5, kind: 'image' });
    db.prepare('UPDATE blobs SET last_ref_at = ?').run(OLD);
    const again = repos.blobs.upsert({ sha256: sha('a'), size: 99, kind: 'video' });
    expect(again).toMatchObject({ size: 5, kind: 'image', createdAt: first.createdAt });
    expect(again.lastRefAt > OLD).toBe(true);
    expect(repos.blobs.get(sha('a'))).toEqual(again);
    expect(repos.blobs.get(sha('nope'))).toBeNull();
  });

  it('reports missing hashes in input order, deduped; totals sizes; touch and delete', () => {
    repos.blobs.upsert({ sha256: sha('a'), size: 5, kind: 'image' });
    repos.blobs.upsert({ sha256: sha('b'), size: 7, kind: 'image' });
    expect(repos.blobs.missing([sha('z'), sha('a'), sha('y'), sha('z')])).toEqual([sha('z'), sha('y')]);
    expect(repos.blobs.totalSize()).toBe(12);
    db.prepare('UPDATE blobs SET last_ref_at = ?').run(OLD);
    repos.blobs.touch([sha('a'), sha('nope')]);
    expect(repos.blobs.get(sha('a'))!.lastRefAt > OLD).toBe(true);
    expect(repos.blobs.get(sha('b'))!.lastRefAt).toBe(OLD);
    repos.blobs.delete(sha('b'));
    expect(repos.blobs.totalSize()).toBe(5);
  });

  it('listUnreferenced: old and unreferenced only (not by a revision, not by the library)', () => {
    for (const n of ['rev', 'lib', 'free', 'fresh']) repos.blobs.upsert({ sha256: sha(n), size: 1, kind: 'image' });
    saveWith(club, 0, [sha('rev')]);
    repos.assetLibrary.create({ sha256: sha('lib'), name: 'Logo', kind: 'image', profileId: null, uploadedBy: null });
    db.prepare('UPDATE blobs SET last_ref_at = ? WHERE sha256 <> ?').run(OLD, sha('fresh'));
    const cutoff = '2021-01-01T00:00:00.000Z';
    expect(repos.blobs.listUnreferenced(cutoff).map((b) => b.sha256)).toEqual([sha('free')]);
    // The fresh one only qualifies once the cutoff passes its last_ref_at.
    expect(repos.blobs.listUnreferenced(FUTURE).map((b) => b.sha256).sort()).toEqual([sha('free'), sha('fresh')].sort());
  });

  it('isVisible follows revisions of the profile and library scope', () => {
    for (const n of ['mine', 'theirs', 'shared', 'scoped', 'orphan']) repos.blobs.upsert({ sha256: sha(n), size: 1, kind: 'image' });
    saveWith(club, 0, [sha('mine')]);
    saveWith(other, 0, [sha('theirs')]);
    repos.assetLibrary.create({ sha256: sha('shared'), name: 's', kind: 'image', profileId: null, uploadedBy: null });
    repos.assetLibrary.create({ sha256: sha('scoped'), name: 'c', kind: 'image', profileId: other, uploadedBy: null });

    expect(repos.blobs.isVisible(sha('mine'), club)).toBe(true);
    expect(repos.blobs.isVisible(sha('mine'), other)).toBe(false);
    expect(repos.blobs.isVisible(sha('theirs'), club)).toBe(false);
    expect(repos.blobs.isVisible(sha('shared'), club)).toBe(true);
    expect(repos.blobs.isVisible(sha('scoped'), club)).toBe(false);
    expect(repos.blobs.isVisible(sha('scoped'), other)).toBe(true);
    expect(repos.blobs.isVisible(sha('orphan'), club)).toBe(false);
    // null = any profile / any entry
    for (const n of ['mine', 'theirs', 'shared', 'scoped']) expect(repos.blobs.isVisible(sha(n), null), n).toBe(true);
    expect(repos.blobs.isVisible(sha('orphan'), null)).toBe(false);
  });

  it('usage lists the revisions that reference a blob, flagging the head', () => {
    repos.blobs.upsert({ sha256: sha('a'), size: 1, kind: 'image' });
    const r1 = saveWith(club, 0, [sha('a')]);
    saveWith(club, 1, [sha('a')]);
    saveWith(club, 2, []);
    const o1 = saveWith(other, 0, [sha('a')]);
    expect(repos.blobs.usage(sha('a'))).toEqual(
      [
        { profileId: club, showProfileId: r1.showProfileId, revision: 2, isHead: false },
        { profileId: club, showProfileId: r1.showProfileId, revision: 1, isHead: false },
        { profileId: other, showProfileId: o1.showProfileId, revision: 1, isHead: true },
      ].sort((x, y) => x.profileId.localeCompare(y.profileId) || y.revision - x.revision),
    );
    expect(repos.blobs.usage(sha('none'))).toEqual([]);
  });
});

describe('asset library', () => {
  beforeEach(() => {
    repos.blobs.upsert({ sha256: sha('a'), size: 42, kind: 'image' });
    repos.blobs.upsert({ sha256: sha('v'), size: 8, kind: 'video' });
  });

  it('creates with the blob size, gets, updates and deletes', () => {
    const a = repos.assetLibrary.create({ sha256: sha('a'), name: 'Logo', kind: 'image', profileId: null, uploadedBy: 'Owner' });
    expect(a).toMatchObject({ sha256: sha('a'), name: 'Logo', kind: 'image', profileId: null, uploadedBy: 'Owner', size: 42 });
    expect(repos.assetLibrary.get(a.id)).toEqual(a);
    expect(repos.assetLibrary.get('nope')).toBeNull();
    expect(repos.assetLibrary.update(a.id, { name: 'Logo 2', profileId: club })).toMatchObject({ name: 'Logo 2', profileId: club });
    expect(repos.assetLibrary.update(a.id, { profileId: null })).toMatchObject({ name: 'Logo 2', profileId: null });
    expect(() => repos.assetLibrary.update('nope', { name: 'x' })).toThrow(NotFoundError);
    repos.assetLibrary.delete(a.id);
    expect(repos.assetLibrary.get(a.id)).toBeNull();
  });

  it('filters by profile (including global entries) and kind, newest first', () => {
    const g = repos.assetLibrary.create({ sha256: sha('a'), name: 'g', kind: 'image', profileId: null, uploadedBy: null });
    const c = repos.assetLibrary.create({ sha256: sha('v'), name: 'c', kind: 'video', profileId: club, uploadedBy: null });
    const o = repos.assetLibrary.create({ sha256: sha('a'), name: 'o', kind: 'image', profileId: other, uploadedBy: null });
    expect(repos.assetLibrary.list().map((x) => x.id)).toEqual([o.id, c.id, g.id]);
    expect(repos.assetLibrary.list({ profileId: club }).map((x) => x.id)).toEqual([c.id, g.id]);
    expect(repos.assetLibrary.list({ profileId: club, kind: 'image' }).map((x) => x.id)).toEqual([g.id]);
    expect(repos.assetLibrary.list({ kind: 'video' }).map((x) => x.id)).toEqual([c.id]);
  });

  it('requires an existing blob', () => {
    expect(() => repos.assetLibrary.create({ sha256: sha('missing'), name: 'x', kind: 'image', profileId: null, uploadedBy: null })).toThrow(/FOREIGN KEY/);
  });

  it('deleteByProfile removes only that profile\'s entries', () => {
    const g = repos.assetLibrary.create({ sha256: sha('a'), name: 'g', kind: 'image', profileId: null, uploadedBy: null });
    repos.assetLibrary.create({ sha256: sha('a'), name: 'c', kind: 'image', profileId: club, uploadedBy: null });
    repos.assetLibrary.deleteByProfile(club);
    expect(repos.assetLibrary.list().map((x) => x.id)).toEqual([g.id]);
  });
});
