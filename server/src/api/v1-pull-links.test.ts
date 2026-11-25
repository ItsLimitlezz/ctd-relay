// /api/v1 pull links (docs/API.md §18.9) through the real routes: scopes, the key only for admins.

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE_ID } from '../../../shared/types.js';
import { PullLinks } from '../media/pull-links.js';
import { bindPullLinks } from './pull-links.js';
import { createTestApi, type TestApi } from './test-helpers.js';

let t: TestApi;
let pull: PullLinks;
const P = `/api/v1/profiles/${DEFAULT_PROFILE_ID}`;

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string | null, payload?: unknown) =>
  t.app.inject({ method, url, headers: { host: 'relay.example.com', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });

beforeEach(async () => {
  t = await createTestApi();
  pull = new PullLinks({
    secrets: t.services.repos.secrets,
    log: t.services.log,
    maxReaders: 2,
    guestProfileOf: (slot) => t.guests.profileOf(slot),
    slugOf: (id) => (id === DEFAULT_PROFILE_ID ? null : t.services.repos.profiles.get(id)?.slug),
    profileOfSlug: (slug) => (slug === null ? DEFAULT_PROFILE_ID : (t.services.repos.profiles.getBySlug(slug)?.id ?? null)),
  });
  await pull.load();
  bindPullLinks(t.services, pull);
});

describe('v1 pull links', () => {
  it('system:admin turns a guest feed link on, rotates and revokes it; status:read sees state, never the key', async () => {
    const g = await t.guests.create(DEFAULT_PROFILE_ID, 'Cam');
    const admin = t.token(['system:admin', 'status:read'], 'ops');
    const reader = t.token(['status:read'], 'ctd obs');
    const base = `${P}/guest-feeds/${g.slot}/pull`;

    expect((await call('PUT', base, reader, { enabled: true })).statusCode).toBe(403);
    expect((await call('GET', base, reader)).statusCode).toBe(403);
    expect((await call('PUT', base, t.token(['system:admin'], 'one', DEFAULT_PROFILE_ID), { enabled: true })).statusCode).toBe(403);
    expect((await call('PUT', base, admin, { enabled: 'yes' })).statusCode).toBe(400);

    const on = await call('PUT', base, admin, { enabled: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.headers['cache-control']).toBe('no-store');
    const info = on.json();
    expect(info).toMatchObject({ enabled: true, readers: 0, maxReaders: 2, serverUrl: `rtmp://relay.example.com:${t.services.config.rtmpPort}/guest/${g.slot}` });
    const key = /\?key=([A-Za-z0-9_-]{24})$/.exec(info.url)![1]!;
    expect(key).not.toBe(await t.guests.ingestKey(DEFAULT_PROFILE_ID, g.slot));

    const state = await call('GET', `${P}/pull-links`, reader);
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({ profileId: DEFAULT_PROFILE_ID, maxReaders: 2, guestFeeds: { [g.slot]: { enabled: true, readers: 0 } }, feeds: { landscape: { enabled: false } } });
    expect(state.body).not.toContain(key);
    expect((await call('GET', `${P}/pull-links`, t.token(['chat:read']))).statusCode).toBe(403);

    const rotated = await call('POST', `${base}/rotate`, admin);
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().url).not.toContain(key);

    expect((await call('DELETE', base, admin)).statusCode).toBe(204);
    expect((await call('GET', base, admin)).json()).toMatchObject({ enabled: false, url: null });

    const audit = t.services.repos.audit.list({ limit: 20 }).filter((e) => e.action.startsWith('pull.'));
    expect(audit.map((e) => e.action).sort()).toEqual(['pull.enable', 'pull.revoke', 'pull.rotate']);
    expect(JSON.stringify(audit)).not.toContain(key);

    expect((await call('GET', `${P}/guest-feeds/aaaaaaaaaa/pull`, admin)).statusCode).toBe(404);
  });

  it("a profile's own feeds have their own links", async () => {
    const admin = t.token(['system:admin'], 'ops');
    const on = await call('PUT', `${P}/feeds/vertical/pull`, admin, { enabled: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().url).toMatch(/^rtmp:\/\/relay\.example\.com:\d+\/live\/vertical\?key=[A-Za-z0-9_-]{24}$/);
    expect((await call('GET', `${P}/feeds/landscape/pull`, admin)).json()).toMatchObject({ enabled: false, url: null });
    expect((await call('GET', `${P}/feeds/sideways/pull`, admin)).statusCode).toBe(404);
  });
});
