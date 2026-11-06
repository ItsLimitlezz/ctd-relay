import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER, SESSION_COOKIE, type ApiError, type AssetItem, type AssetsResponse } from '../../../../shared/api.js';
import type { Role } from '../../../../shared/types.js';
import { createTestApi, type TestApi } from '../../api/test-helpers.js';

let t: TestApi;

beforeEach(async () => {
  t = await createTestApi();
});
afterEach(async () => {
  await t.close();
});

function login(role: Role = 'admin', username = role) {
  const user = t.repos.users.create({ username, passwordHash: 'x', role });
  const { record, token } = t.repos.authSessions.create(user.id, { ip: null, userAgent: null });
  return { cookie: `${SESSION_COOKIE}=${token}`, csrf: record.csrfToken };
}
type Session = ReturnType<typeof login>;

const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const CUBE = Buffer.from('TITLE "x"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');

function call(s: Session | null, method: 'GET' | 'PATCH' | 'DELETE', url: string, payload?: unknown, opts: { csrf?: boolean } = {}) {
  const headers: Record<string, string> = { host: '192.168.1.20:30443' };
  if (s) headers.cookie = s.cookie;
  if (s && opts.csrf !== false) headers[CSRF_HEADER] = s.csrf;
  return t.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

function upload(
  s: Session | null,
  body: Buffer = CUBE,
  opts: { name?: string; kind?: string; profile?: string; sha?: string; csrf?: boolean } = {},
) {
  const qs = new URLSearchParams({ name: opts.name ?? 'Warm', kind: opts.kind ?? 'lut', profile: opts.profile ?? '' });
  const headers: Record<string, string> = {
    host: '192.168.1.20:30443',
    'content-type': 'application/octet-stream',
    'x-content-sha256': opts.sha ?? sha256(body),
  };
  if (s) headers.cookie = s.cookie;
  if (s && opts.csrf !== false) headers[CSRF_HEADER] = s.csrf;
  return t.app.inject({ method: 'PUT', url: `/api/assets?${qs.toString()}`, headers, payload: body });
}

function pinToHead(sha: string, profileId = 'default') {
  const bundle = sha256(`bundle-${sha}`);
  t.repos.blobs.upsert({ sha256: bundle, size: 1, kind: 'bundle' });
  t.repos.showProfiles.addRevision({
    profileId,
    name: 'Show',
    parentRevision: 0,
    manifest: '{}',
    bundleSha256: bundle,
    size: 1,
    blobs: [sha],
    savedByApp: null,
    savedByToken: null,
    note: null,
  });
}

describe('/api/assets', () => {
  it('admin uploads a .cube: stored, listed with its size, audited, announced', async () => {
    const admin = login();
    const events: unknown[] = [];
    t.bus.on('library-changed', (e) => events.push(e));

    const res = await upload(admin);
    expect(res.statusCode).toBe(200);
    const item = res.json<AssetItem>();
    expect(item).toMatchObject({ name: 'Warm', kind: 'lut', profileId: null, size: CUBE.length, sha256: sha256(CUBE), uploadedBy: 'admin', usage: [] });
    expect(t.services.blobStore.has(item.sha256)).toBe(true);

    const list = (await call(admin, 'GET', '/api/assets')).json<AssetsResponse>();
    expect(list.items).toEqual([item]);
    expect(list.usedBytes).toBe(CUBE.length);
    expect(list.quotaBytes).toBeGreaterThan(0);

    expect(t.repos.audit.list({ limit: 5 })[0]).toMatchObject({ action: 'asset.upload', username: 'admin' });
    expect(events).toEqual([{ profileId: null }]);
  });

  it('assigns an upload to a profile; an unknown profile is 404 and nothing is stored', async () => {
    const admin = login();
    const p = t.addProfile('Club');
    expect((await upload(admin, CUBE, { profile: p.id })).json<AssetItem>().profileId).toBe(p.id);
    const other = Buffer.from(CUBE.toString() + '# other\n');
    const res = await upload(admin, other, { profile: 'nope' });
    expect(res.statusCode).toBe(404);
    expect(t.services.blobStore.has(sha256(other))).toBe(false);
  });

  it('validates name and kind', async () => {
    const admin = login();
    expect((await upload(admin, CUBE, { name: '' })).statusCode).toBe(400);
    expect((await upload(admin, CUBE, { name: 'a\u0007b' })).statusCode).toBe(400);
    expect((await upload(admin, CUBE, { name: 'x'.repeat(101) })).statusCode).toBe(400);
    expect((await upload(admin, CUBE, { kind: 'bundle' })).statusCode).toBe(400);
    expect(t.repos.assetLibrary.list()).toEqual([]);
  });

  it('a hash mismatch is 400 and nothing is stored or listed', async () => {
    const admin = login();
    const res = await upload(admin, CUBE, { sha: sha256('something else') });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiError>().code).toBe('hash_mismatch');
    expect(t.services.blobStore.has(sha256('something else'))).toBe(false);
    expect(t.services.blobStore.has(sha256(CUBE))).toBe(false);
    expect(t.services.blobStore.usedBytes()).toBe(0);
    expect(t.repos.assetLibrary.list()).toEqual([]);
  });

  it('rejects a missing or malformed hash header', async () => {
    const admin = login();
    expect((await upload(admin, CUBE, { sha: 'ABC' })).statusCode).toBe(400);
  });

  it('operators can list but not upload, edit or delete', async () => {
    const admin = login();
    const item = (await upload(admin)).json<AssetItem>();
    const op = login('operator');
    const list = await call(op, 'GET', '/api/assets');
    expect(list.statusCode).toBe(200);
    expect(list.json<AssetsResponse>().items).toHaveLength(1);
    expect((await upload(op, Buffer.from('LUT_3D_SIZE 2\n'))).statusCode).toBe(403);
    expect((await call(op, 'PATCH', `/api/assets/${item.id}`, { name: 'x' })).statusCode).toBe(403);
    expect((await call(op, 'DELETE', `/api/assets/${item.id}`)).statusCode).toBe(403);
    expect(t.repos.assetLibrary.list()).toHaveLength(1);
  });

  it('requires a login and the CSRF header', async () => {
    expect((await call(null, 'GET', '/api/assets')).statusCode).toBe(401);
    expect((await upload(null)).statusCode).toBe(401);
    const admin = login();
    const res = await upload(admin, CUBE, { csrf: false });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(t.repos.assetLibrary.list()).toEqual([]);
    expect(t.services.blobStore.has(sha256(CUBE))).toBe(false);
    const item = (await upload(admin)).json<AssetItem>();
    expect((await call(admin, 'DELETE', `/api/assets/${item.id}`, undefined, { csrf: false })).statusCode).toBeGreaterThanOrEqual(400);
    expect(t.repos.assetLibrary.list()).toHaveLength(1);
  });

  it('renames and reassigns (PATCH), audited', async () => {
    const admin = login();
    const p = t.addProfile('Club');
    const item = (await upload(admin)).json<AssetItem>();
    const res = await call(admin, 'PATCH', `/api/assets/${item.id}`, { name: ' Cool ', profileId: p.id });
    expect(res.statusCode).toBe(200);
    expect(res.json<AssetItem>()).toMatchObject({ id: item.id, name: 'Cool', profileId: p.id });
    expect(t.repos.audit.list({ limit: 5 })[0]).toMatchObject({ action: 'asset.update' });
    expect((await call(admin, 'PATCH', `/api/assets/${item.id}`, { profileId: 'nope' })).statusCode).toBe(404);
    expect((await call(admin, 'PATCH', `/api/assets/missing`, { name: 'x' })).statusCode).toBe(404);
    expect((await call(admin, 'PATCH', `/api/assets/${item.id}`, { name: '' })).statusCode).toBe(400);
    const back = await call(admin, 'PATCH', `/api/assets/${item.id}`, { profileId: null });
    expect(back.json<AssetItem>().profileId).toBeNull();
  });

  it('delete is blocked (409) while a head revision references the asset, allowed otherwise', async () => {
    const admin = login();
    const events: unknown[] = [];
    const item = (await upload(admin)).json<AssetItem>();
    pinToHead(item.sha256);

    const listed = (await call(admin, 'GET', '/api/assets')).json<AssetsResponse>().items[0]!;
    expect(listed.usage).toEqual([{ profileId: 'default', revision: 1, isHead: true }]);

    t.bus.on('library-changed', (e) => events.push(e));
    const blocked = await call(admin, 'DELETE', `/api/assets/${item.id}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<ApiError>().code).toBe('asset_in_use');
    expect(t.repos.assetLibrary.get(item.id)).not.toBeNull();
    expect(events).toEqual([]);

    // Another, unreferenced asset can go; the blob file is left to the GC.
    const free = (await upload(admin, Buffer.from(CUBE.toString() + '# free\n'), { name: 'Free' })).json<AssetItem>();
    events.length = 0;
    const ok = await call(admin, 'DELETE', `/api/assets/${free.id}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({});
    expect(t.repos.assetLibrary.get(free.id)).toBeNull();
    expect(t.services.blobStore.has(free.sha256)).toBe(true);
    expect(t.repos.audit.list({ limit: 5 })[0]).toMatchObject({ action: 'asset.delete', username: 'admin' });
    expect(events).toEqual([{ profileId: null }]);

    expect((await call(admin, 'DELETE', `/api/assets/${free.id}`)).statusCode).toBe(404);
  });

  it('delete is allowed when only an older (non-head) revision references the asset', async () => {
    const admin = login();
    const item = (await upload(admin)).json<AssetItem>();
    pinToHead(item.sha256);
    const show = t.repos.showProfiles.getByProfile('default')!;
    const bundle2 = sha256('bundle-2');
    t.repos.blobs.upsert({ sha256: bundle2, size: 1, kind: 'bundle' });
    t.repos.showProfiles.addRevision({
      profileId: 'default', name: 'Show', parentRevision: show.headRevision, manifest: '{}', bundleSha256: bundle2, size: 1,
      blobs: [], savedByApp: null, savedByToken: null, note: null,
    });
    const listed = (await call(admin, 'GET', '/api/assets')).json<AssetsResponse>().items[0]!;
    expect(listed.usage).toEqual([{ profileId: 'default', revision: 1, isHead: false }]);
    expect((await call(admin, 'DELETE', `/api/assets/${item.id}`)).statusCode).toBe(200);
  });
});
