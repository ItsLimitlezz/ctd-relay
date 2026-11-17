// Re-pairing the same app over /api/v1 (stale connections): the CTD OBS plugin pairs again (e.g.
// for the show-profile scopes) and registers the same app id with the new token. The new pairing
// replaces the old entry instead of leaving it behind, and the old token is revoked once unused.

import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPERSEDED_GRACE_MS } from './hub.js';
import { createTestApi, type TestApi } from './test-helpers.js';

let t: TestApi;

beforeEach(async () => {
  // Only the clock: token times (createdAt, lastUsedAt) and presence follow it.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-11-16T20:00:00.000Z'));
  t = await createTestApi({ now: () => Date.now() });
});
afterEach(async () => {
  await t.close();
  vi.useRealTimers();
});

type Body = Record<string, unknown>;
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token?: string | null, body?: Body) =>
  t.app.inject({
    method,
    url,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });

const SCOPES = ['status:read', 'chat:read', 'ingest:read', 'apps:read', 'apps:write', 'obs:write', 'show:read', 'show:write', 'show:secrets'];
const APP_ID = 'ctd-obs-plugin-studio';
// What the plugin sends (src/multistream.c heartbeat()).
const registration = { name: 'CTD OBS plugin (studio)', kind: 'ctd-obs-plugin', version: '0.9.0', capabilities: ['obs.ingest', 'obs.overlays'], resources: [] };

/** The plugin's pairing: ask, the admin approves, the plugin collects its token. */
async function pair(): Promise<string> {
  const started = await call('POST', '/api/v1/pairing', null, { appName: 'CTD OBS plugin (studio)', kind: 'ctd-obs-plugin', scopes: SCOPES, profileId: null });
  expect(started.statusCode, started.body).toBe(201);
  const { pairingId, pollSecret } = started.json();
  t.pairings.approve(pairingId, { scopes: t.pairings.list()[0]!.requestedScopes, profileId: null, approvedBy: 'admin' });
  const collected = await call('POST', `/api/v1/pairing/${pairingId}/token`, null, { pollSecret });
  expect(collected.statusCode, collected.body).toBe(200);
  return collected.json().token as string;
}

const register = (token: string, id = APP_ID) => call('PUT', `/api/v1/apps/${id}`, token, registration);
const appIds = async (token: string) => ((await call('GET', '/api/v1/apps', token)).json().items as { id: string }[]).map((a) => a.id);
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
const ok = (res: LightMyRequestResponse) => expect(res.statusCode, res.body).toBe(200);

describe('re-pairing the CTD OBS plugin', () => {
  it('re-registering with the same token (OBS restarted with its saved pairing) keeps one entry', async () => {
    const a = await pair();
    ok(await register(a));
    for (let i = 0; i < 4; i++) {
      advance(30_000);
      ok(await register(a));
      ok(await call('POST', `/api/v1/apps/${APP_ID}/heartbeat`, a));
    }
    // OBS closed and opened again within the online window: same token, same id.
    advance(5_000);
    ok(await register(a));
    advance(SUPERSEDED_GRACE_MS);
    t.apps.checkSuperseded();
    expect(await appIds(a)).toEqual([APP_ID]);
    expect(t.repos.apiTokens.list()).toHaveLength(1);
  });

  it('pairing again from the same OBS replaces its entry (no "-xxxxxx" id) and revokes the old token', async () => {
    const a = await pair();
    ok(await register(a));
    advance(20_000);
    ok(await register(a)); // still online when the user pairs again

    advance(10_000);
    const b = await pair();
    // Was 409 app_owned while the old entry looked online, which made the plugin move to a new id.
    const taken = await register(b);
    ok(taken);
    expect(taken.json()).toMatchObject({ id: APP_ID, online: true });
    expect(await appIds(b)).toEqual([APP_ID]);
    // Owned by the newest token (the list is oldest first).
    expect(t.apps.get(APP_ID)?.tokenId).toBe(t.repos.apiTokens.list().at(-1)!.id);

    // The old token can't take the id back, and is revoked after the grace period.
    expect((await register(a)).statusCode).toBe(409);
    ok(await call('GET', '/api/v1/', a));
    advance(SUPERSEDED_GRACE_MS + 1_000);
    ok(await register(b));
    t.apps.checkSuperseded();
    expect((await call('GET', '/api/v1/', a)).statusCode).toBe(401);
    ok(await call('GET', '/api/v1/', b));
    expect(t.repos.apiTokens.list()).toHaveLength(1);
    expect(t.repos.audit.list({ limit: 10 }).map((e) => e.action)).toContain('api_token.superseded');
  });

  it('the entries an earlier pairing left behind go when the plugin registers its saved id', async () => {
    // Production state from before the fix: the first pairing's entry, then the "-d705a3" one.
    const a = await pair();
    ok(await register(a));
    advance(10_000);
    const b = await pair();
    ok(await register(b, `${APP_ID}-d705a3`));
    advance(120_000);
    expect((await appIds(b)).sort()).toEqual([APP_ID, `${APP_ID}-d705a3`]);

    ok(await register(b, `${APP_ID}-d705a3`));
    expect(await appIds(b)).toEqual([`${APP_ID}-d705a3`]);
    advance(SUPERSEDED_GRACE_MS);
    t.apps.checkSuperseded();
    expect((await call('GET', '/api/v1/', a)).statusCode).toBe(401);
    ok(await call('GET', '/api/v1/', b));
  });
});
