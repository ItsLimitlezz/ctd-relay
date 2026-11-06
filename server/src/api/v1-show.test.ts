// /api/v1 show profiles and blobs (v1.9).

import crypto from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE_ID, type Profile } from '../../../shared/types.js';
import { PROBLEM_TYPE } from './http.js';
import { createTestApi, type TestApi } from './test-helpers.js';
import { parseManifest, parseRange, safeRelativePath, showSecretScope } from './v1-show.js';

let t: TestApi;
let club: Profile;
/** Every-profile token with show read + write. */
let all: string;

const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');
const CUBE = Buffer.from('TITLE "Warm"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
const BUNDLE = Buffer.from('collection.json\u0000{"scenes":[]}');

beforeEach(async () => {
  t = await createTestApi();
  club = t.addProfile('DPRTMNT');
  all = t.token(['status:read', 'show:read', 'show:write'], 'studio');
});
afterEach(async () => {
  await t.close();
});

type Body = Record<string, unknown> | undefined;
const call = (method: 'GET' | 'POST' | 'PUT', url: string, token: string | null, body?: Body, headers: Record<string, string> = {}) =>
  t.app.inject({
    method,
    url,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
const get = (url: string, token: string | null, headers?: Record<string, string>) => call('GET', url, token, undefined, headers);
const put = (token: string, data: Buffer, kind = 'other', hash = sha(data)) =>
  t.app.inject({
    method: 'PUT',
    url: `/api/v1/blobs/${hash}?kind=${kind}`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    payload: data,
  });

function expectProblem(res: LightMyRequestResponse, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(res.json()).toMatchObject({ type: PROBLEM_TYPE, status, code });
}

const manifest = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  name: 'DPRTMNT',
  savedBy: { appId: 'ctd-obs-plugin-studio', os: 'windows' },
  files: { collection: 'collection.json', profile: ['profile/basic.ini'] },
  assets: [{ sha256: sha(CUBE), size: CUBE.length, kind: 'lut', name: 'warm.cube', refs: [] }],
  ...over,
});

async function uploadAll(token: string) {
  expect((await put(token, BUNDLE, 'bundle')).statusCode).toBe(201);
  expect((await put(token, CUBE, 'lut')).statusCode).toBe(201);
}

const save = (token: string, profileId: string, parentRevision: number, extra: Record<string, unknown> = {}) =>
  call('POST', `/api/v1/profiles/${profileId}/show/revisions`, token, { parentRevision, manifest: manifest(), bundleSha256: sha(BUNDLE), ...extra });

describe('saving revisions', () => {
  it('the first save creates the show profile; the next needs the head as parent (409 with head)', async () => {
    expectProblem(await get(`/api/v1/profiles/${club.id}/show`, all), 404, 'not_found');
    await uploadAll(all);

    const first = await save(all, club.id, 0, { note: 'first' });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ profileId: club.id, revision: 1, parentRevision: null, note: 'first', savedBy: { appId: 'ctd-obs-plugin-studio' } });
    expect(first.json().size).toBe(BUNDLE.length + CUBE.length);

    expect((await save(all, club.id, 1)).json().revision).toBe(2);
    const stale = await save(all, club.id, 1);
    expectProblem(stale, 409, 'revision_conflict');
    expect(stale.json().head).toBe(2);
    expectProblem(await save(all, club.id, 0), 409, 'revision_conflict');

    const show = (await get(`/api/v1/profiles/${club.id}/show`, all)).json();
    expect(show).toMatchObject({ profileId: club.id, name: 'DPRTMNT', headRevision: 2, savedBy: { appId: 'ctd-obs-plugin-studio' } });
    const history = (await get(`/api/v1/profiles/${club.id}/show/revisions`, all)).json();
    expect(history.items.map((r: { revision: number }) => r.revision)).toEqual([2, 1]);
    const one = (await get(`/api/v1/profiles/${club.id}/show/revisions/1`, all)).json();
    expect(one.manifest).toMatchObject({ schema: 1, name: 'DPRTMNT' });
    expectProblem(await get(`/api/v1/profiles/${club.id}/show/revisions/9`, all), 404, 'not_found');
  });

  it('400 missing_blobs lists what to upload first', async () => {
    const res = await save(all, club.id, 0);
    expectProblem(res, 400, 'missing_blobs');
    expect(res.json().missing.sort()).toEqual([sha(BUNDLE), sha(CUBE)].sort());
    expect(t.repos.showProfiles.getByProfile(club.id)).toBeNull();
  });

  it('rejects unknown schemas and unsafe paths', async () => {
    await uploadAll(all);
    const body = (m: Record<string, unknown>) => ({ parentRevision: 0, manifest: m, bundleSha256: sha(BUNDLE) });
    expectProblem(await call('POST', `/api/v1/profiles/${club.id}/show/revisions`, all, body(manifest({ schema: 2 }))), 400, 'invalid');
    expectProblem(
      await call('POST', `/api/v1/profiles/${club.id}/show/revisions`, all, body(manifest({ files: { collection: '../../evil.json' } }))),
      400,
      'invalid',
    );
  });

  it('emits show.changed to show:read tokens only', async () => {
    const reader = t.token(['show:read'], 'reader');
    const statusOnly = t.token(['status:read'], 'status');
    const start = (await get('/api/v1/events/poll?profile=*', reader)).json().next;
    const startStatus = (await get('/api/v1/events/poll?profile=*', statusOnly)).json().next;
    await uploadAll(all);
    await save(all, club.id, 0);

    const items = (await get(`/api/v1/events/poll?profile=*&after=${start}`, reader)).json().items;
    const changed = items.filter((e: { type: string }) => e.type === 'show.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0].data).toEqual({ profileId: club.id, revision: 1, parentRevision: null, byAppId: 'ctd-obs-plugin-studio' });
    const other = (await get(`/api/v1/events/poll?profile=*&after=${startStatus}`, statusOnly)).json().items;
    expect(other.some((e: { type: string }) => e.type === 'show.changed')).toBe(false);
    expectProblem(await get('/api/v1/events/poll?types=show.*', statusOnly), 403, 'missing_scope');
  });

  it('GET /profiles lists the show state', async () => {
    await uploadAll(all);
    await save(all, club.id, 0);
    const items = (await get('/api/v1/profiles', all)).json().items;
    expect(items.find((p: { id: string }) => p.id === club.id).show).toMatchObject({ headRevision: 1, savedBy: { appId: 'ctd-obs-plugin-studio' } });
    expect(items.find((p: { id: string }) => p.id === DEFAULT_PROFILE_ID).show).toBeNull();
  });
});

describe('scopes and profile-limited tokens', () => {
  it('needs show:read / show:write', async () => {
    const status = t.token(['status:read'], 'status');
    expectProblem(await get(`/api/v1/profiles/${club.id}/show`, status), 403, 'missing_scope');
    expectProblem(await put(status, CUBE, 'lut'), 403, 'missing_scope');
    const reader = t.token(['show:read'], 'reader');
    expectProblem(await save(reader, club.id, 0), 403, 'missing_scope');
    expectProblem(await call('POST', '/api/v1/blobs/check', reader, { items: [] }), 403, 'missing_scope');
  });

  it('a profile-limited token only reaches its own profile', async () => {
    const mainOnly = t.token(['show:read', 'show:write'], 'main dock', DEFAULT_PROFILE_ID);
    expectProblem(await get(`/api/v1/profiles/${club.id}/show`, mainOnly), 403, 'profile_forbidden');
    expectProblem(await save(mainOnly, club.id, 0), 403, 'profile_forbidden');
  });

  it('blob visibility: another profile’s blob is "missing" to /blobs/check and 404 to GET, until the token uploads it', async () => {
    const clubToken = t.token(['show:read', 'show:write'], 'club dock', club.id);
    const mainToken = t.token(['show:read', 'show:write'], 'main dock', DEFAULT_PROFILE_ID);
    await uploadAll(clubToken);
    expect((await save(clubToken, club.id, 0)).statusCode).toBe(201);

    // The club token sees its own blobs.
    const check = await call('POST', '/api/v1/blobs/check', clubToken, { items: [{ sha256: sha(CUBE), size: CUBE.length }] });
    expect(check.json()).toEqual({ missing: [] });
    expect((await get(`/api/v1/blobs/${sha(CUBE)}`, clubToken)).statusCode).toBe(200);

    // The main token is told nothing: same answers as for a hash that doesn't exist.
    const unknown = sha(Buffer.from('never uploaded'));
    const mainCheck = await call('POST', '/api/v1/blobs/check', mainToken, {
      items: [
        { sha256: sha(CUBE), size: CUBE.length },
        { sha256: unknown, size: 1 },
      ],
    });
    expect(mainCheck.json()).toEqual({ missing: [sha(CUBE), unknown] });
    const hidden = await get(`/api/v1/blobs/${sha(CUBE)}`, mainToken);
    const absent = await get(`/api/v1/blobs/${unknown}`, mainToken);
    expectProblem(hidden, 404, 'not_found');
    expect(hidden.json()).toEqual(absent.json());

    // Referencing it in a save without uploading fails…
    const res = await call('POST', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/show/revisions`, mainToken, {
      parentRevision: 0,
      manifest: manifest(),
      bundleSha256: sha(BUNDLE),
    });
    expectProblem(res, 400, 'missing_blobs');
    // …uploading proves it holds the bytes (deduplicated: nothing new stored), then the save works.
    const up = await put(mainToken, CUBE, 'lut');
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ created: false });
    await put(mainToken, BUNDLE, 'bundle');
    expect((await save(mainToken, DEFAULT_PROFILE_ID, 0)).statusCode).toBe(201);
    expect((await get(`/api/v1/blobs/${sha(CUBE)}`, mainToken)).statusCode).toBe(200);
  });

  it('library entries: shared ones are visible to every profile, assigned ones only to theirs', async () => {
    await put(all, CUBE, 'lut');
    t.repos.assetLibrary.create({ sha256: sha(CUBE), name: 'Warm', kind: 'lut', profileId: club.id, uploadedBy: 'admin' });
    const mainToken = t.token(['show:read'], 'main', DEFAULT_PROFILE_ID);
    const clubToken = t.token(['show:read'], 'club', club.id);
    expect((await get('/api/v1/library', mainToken)).json().items).toEqual([]);
    expect((await get('/api/v1/library?kind=lut', clubToken)).json().items).toEqual([
      expect.objectContaining({ name: 'Warm', kind: 'lut', profileId: club.id, size: CUBE.length }),
    ]);
    expectProblem(await get(`/api/v1/blobs/${sha(CUBE)}`, mainToken), 404, 'not_found');
    expect((await get(`/api/v1/blobs/${sha(CUBE)}`, clubToken)).statusCode).toBe(200);
    expectProblem(await get(`/api/v1/library?profile=${club.id}`, mainToken), 403, 'profile_forbidden');
  });

  it('secrets: stored on save, returned only with show:secrets', async () => {
    await uploadAll(all);
    const secrets = [{ source: 'src-1', key: 'url', value: 'https://overlay.example/?key=placeholder' }];
    await save(all, club.id, 0, { secrets });
    expectProblem(await get(`/api/v1/profiles/${club.id}/show/revisions/1/secrets`, all), 403, 'missing_scope');
    const trusted = t.token(['show:read', 'show:secrets'], 'trusted');
    expect((await get(`/api/v1/profiles/${club.id}/show/revisions/1/secrets`, trusted)).json()).toEqual({ items: secrets });
    // The bundle itself never contains them and stays identical to its hash.
    const bundle = await get(`/api/v1/profiles/${club.id}/show/revisions/1/bundle`, all);
    expect(sha(bundle.rawPayload)).toBe(sha(BUNDLE));
    const show = t.repos.showProfiles.getByProfile(club.id);
    expect(await t.repos.secrets.scoped(showSecretScope(show?.id ?? '')).getJson('rev:1')).toEqual(secrets);
  });
});

describe('blobs', () => {
  it('PUT checks the hash and the content', async () => {
    expectProblem(await put(all, CUBE, 'lut', sha(Buffer.from('other'))), 400, 'hash_mismatch');
    expectProblem(await put(all, Buffer.from([0, 1, 2, 3]), 'lut'), 415, 'invalid');
    expectProblem(await put(all, CUBE, 'nope'), 400, 'invalid');
    expect(t.repos.blobs.totalSize()).toBe(0);
  });

  it('PUT over the quota answers 413 quota_exceeded', async () => {
    await t.close();
    t = await createTestApi({ blobLimits: () => ({ lutBytes: 1e6, imageBytes: 1e6, mediaBytes: 1e6, otherBytes: 1e6, bundleBytes: 1e6, manifestBytes: 1e6, quotaBytes: 10, maxRevisions: 50 }) });
    club = t.addProfile('DPRTMNT');
    all = t.token(['show:read', 'show:write'], 'studio');
    expectProblem(await put(all, CUBE, 'lut'), 413, 'quota_exceeded');
  });

  it('GET serves the bytes as a download, with Range support', async () => {
    await uploadAll(all);
    await save(all, club.id, 0);
    const whole = await get(`/api/v1/blobs/${sha(CUBE)}`, all);
    expect(whole.statusCode).toBe(200);
    expect(whole.rawPayload.equals(CUBE)).toBe(true);
    expect(whole.headers['content-type']).toBe('application/octet-stream');
    expect(whole.headers['content-disposition']).toMatch(/^attachment/);
    expect(whole.headers['x-content-type-options']).toBe('nosniff');
    expect(whole.headers['accept-ranges']).toBe('bytes');

    const part = await get(`/api/v1/blobs/${sha(CUBE)}`, all, { range: 'bytes=6-11' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 6-11/${CUBE.length}`);
    expect(part.body).toBe(CUBE.subarray(6, 12).toString());
    expect((await get(`/api/v1/blobs/${sha(CUBE)}`, all, { range: 'bytes=9999-' })).statusCode).toBe(416);
  });

  it('a blob nothing references is not served, even to an every-profile token', async () => {
    await put(all, CUBE, 'lut');
    // Uploaded by this token: visible to it while it builds the save.
    expect((await get(`/api/v1/blobs/${sha(CUBE)}`, all)).statusCode).toBe(200);
    const other = t.token(['show:read'], 'other');
    expectProblem(await get(`/api/v1/blobs/${sha(CUBE)}`, other), 404, 'not_found');
  });
});

describe('helpers', () => {
  it('safeRelativePath', () => {
    expect(safeRelativePath('profile/basic.ini')).toBe(true);
    for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'C:/x', 'a\\b', 'a//b', './a']) expect(safeRelativePath(bad)).toBe(false);
  });

  it('parseManifest', () => {
    expect(parseManifest(manifest())).toMatchObject({ name: 'DPRTMNT', appId: 'ctd-obs-plugin-studio' });
    expect(parseManifest(manifest({ assets: [{ sha256: 'xyz' }] }))).toMatch(/sha256/);
    expect(parseManifest(manifest({ name: '' }))).toMatch(/name/);
  });

  it('parseRange', () => {
    expect(parseRange(undefined, 10)).toBeUndefined();
    expect(parseRange('bytes=0-4', 10)).toEqual({ start: 0, end: 4 });
    expect(parseRange('bytes=5-', 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=0-99', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=10-', 10)).toBeNull();
    expect(parseRange('bytes=0-1,3-4', 10)).toBeUndefined();
  });
});
