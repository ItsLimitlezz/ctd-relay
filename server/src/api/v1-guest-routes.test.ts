// /api/v1 guest feed routing (docs/API.md §18.8) through the real routes: scopes, no keys, conflicts.

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE_ID, type Profile } from '../../../shared/types.js';
import { guestRouteSecretScope } from '../media/guest-routes.js';
import { createTestApi, type TestApi } from './test-helpers.js';

const KEY = 'live_sk_APIKEY00000000000xyz';
let t: TestApi;
let club: Profile;
const P = `/api/v1/profiles/${DEFAULT_PROFILE_ID}`;

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token: string | null, payload?: unknown) =>
  t.app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });

beforeEach(async () => {
  t = await createTestApi();
  club = t.services.repos.profiles.create({ name: 'Club', color: null });
});

describe('v1 guest routes', () => {
  it('admin token manages routes; status:read reads them without keys or server paths', async () => {
    const g = await t.guests.create(DEFAULT_PROFILE_ID, 'Cam');
    const admin = t.token(['system:admin', 'status:read'], 'ops');
    const reader = t.token(['status:read'], 'ctd obs');
    const base = `${P}/guest-feeds/${g.slot}/routes`;

    // Managing needs system:admin, on a token not limited to one profile.
    expect((await call('POST', base, reader, { kind: 'rtmp', url: 'rtmp://live.example.com/app' })).statusCode).toBe(403);
    expect((await call('POST', base, t.token(['system:admin'], 'one', DEFAULT_PROFILE_ID), { kind: 'rtmp', url: 'rtmp://live.example.com/app' })).statusCode).toBe(403);

    const created = await call('POST', base, admin, { kind: 'rtmp', url: 'rtmps://live.example.com/app/secretpath', streamKey: KEY, auto: true });
    expect(created.statusCode, created.body).toBe(201);
    const route = created.json();
    expect(route).toMatchObject({ slot: g.slot, auto: true, active: false, state: 'idle', target: { kind: 'rtmp', host: 'rtmps://live.example.com', hasKey: true } });
    expect(created.body).not.toContain(KEY);
    expect(created.body).not.toContain('secretpath');
    expect(await t.services.repos.secrets.scoped(guestRouteSecretScope(route.id)).get('streamKey')).toBe(KEY);

    const listed = await call('GET', base, reader);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().routes).toHaveLength(1);
    expect(listed.body).not.toContain(KEY);
    expect(listed.body).not.toContain('secretpath');
    expect((await call('GET', base, t.token(['chat:read']))).statusCode).toBe(403);

    // Bad targets: file/pipe schemes, loopback, link-local.
    for (const url of ['file:///etc/passwd', 'pipe:1', 'rtmp://127.0.0.1/live', 'rtmp://169.254.169.254/x']) {
      const res = await call('POST', base, admin, { kind: 'rtmp', url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().code).toBe('invalid_target');
    }

    // Profile input route; the target profile sees it as inbound.
    const p = await call('POST', base, admin, { kind: 'profile', profileId: club.id, feed: 'landscape' });
    expect(p.statusCode, p.body).toBe(201);
    const inbound = await call('GET', `/api/v1/profiles/${club.id}/guest-routes`, reader);
    expect(inbound.json().inbound.map((r: { id: string }) => r.id)).toEqual([p.json().id]);

    // Start while the guest is offline: refused.
    const start = await call('POST', `${base}/${p.json().id}/start`, admin);
    expect(start.statusCode).toBe(409);
    expect(start.json().code).toBe('feed_offline');

    const patched = await call('PATCH', `${base}/${route.id}`, admin, { name: 'Backup', streamKey: '' });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ name: 'Backup', target: { hasKey: false } });
    expect((await call('DELETE', `${base}/${route.id}`, admin)).statusCode).toBe(204);
    expect((await call('DELETE', `${base}/${route.id}`, admin)).statusCode).toBe(404);
    expect((await call('GET', `${P}/guest-feeds/aaaaaaaaaa/routes`, reader)).statusCode).toBe(404);
  });
});
