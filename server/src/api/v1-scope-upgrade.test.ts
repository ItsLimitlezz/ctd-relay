// /api/v1 scope upgrade (v1.18, docs/API.md §9.3.1): POST /pairing/upgrade + GET /pairing/upgrade/{id}.

import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Profile } from '../../../shared/types.js';
import { PROBLEM_TYPE } from './http.js';
import { createTestApi, type TestApi } from './test-helpers.js';

let t: TestApi;
let club: Profile;

beforeEach(async () => {
  t = await createTestApi();
  club = t.addProfile('DPRTMNT', '#E11D48');
});
afterEach(async () => {
  await t.close();
});

type Body = Record<string, unknown>;
const call = (method: 'GET' | 'POST', url: string, token: string | null, body?: Body) =>
  t.app.inject({
    method,
    url,
    headers: { host: 'relay.example.com', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
const upgrade = (token: string | null, body: Body) => call('POST', '/api/v1/pairing/upgrade', token, body);
const poll = (token: string | null, id: string) => call('GET', `/api/v1/pairing/upgrade/${id}`, token);
const get = (url: string, token: string) => call('GET', url, token);

function expectProblem(res: LightMyRequestResponse, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(res.json()).toEqual({ type: PROBLEM_TYPE, title: expect.any(String), status, detail: expect.any(String), code });
}

describe('POST /pairing/upgrade', () => {
  it('needs a token; nothing new is 200 (no request); nothing valid or a bad body is 400', async () => {
    expectProblem(await upgrade(null, { scopes: ['feeds:watch'] }), 401, 'unauthenticated');
    const dock = t.token(['status:read', 'chat:read'], 'dock');
    const same = await upgrade(dock, { scopes: ['status:read', 'nope'] });
    expect(same.statusCode).toBe(200);
    expect(same.json()).toEqual({ status: 'approved', scopes: ['chat:read', 'status:read'] });
    expect(t.scopeUpgrades.list()).toEqual([]);
    expectProblem(await upgrade(dock, { scopes: ['system:admin'] }), 400, 'invalid');
    expectProblem(await upgrade(dock, { scopes: [] }), 400, 'invalid');
    expectProblem(await upgrade(dock, { scopes: ['feeds:watch'], reason: 'a\u0007b' }), 400, 'invalid');
    expectProblem(await upgrade(dock, { scopes: ['feeds:watch'], appName: 'x'.repeat(61) }), 400, 'invalid');
    expectProblem(await upgrade(dock, { scopes: ['feeds:watch'], reason: 'x'.repeat(201) }), 400, 'invalid');
  });

  it('202 → poll 202 → approved: the same token works for the new scope on the very next request', async () => {
    const dock = t.token(['status:read'], 'dock', club.id);
    expectProblem(await get('/api/v1/apps', dock), 403, 'missing_scope');
    const res = await upgrade(dock, { scopes: ['apps:read', 'system:admin'], appName: 'CTD OBS plugin', reason: 'List overlays' });
    expect(res.statusCode, res.body).toBe(202);
    const body = res.json();
    expect(body).toEqual({
      upgradeId: expect.any(String),
      status: 'pending',
      adding: ['apps:read'],
      expiresIn: 600,
      interval: 3,
      approveUrl: `https://relay.example.com/settings?tab=api&upgrade=${body.upgradeId}`,
    });
    expect(res.body).not.toContain('ctd_pat_');
    expect((await poll(dock, body.upgradeId)).statusCode).toBe(202);

    const other = t.token(['status:read'], 'other');
    expectProblem(await poll(other, body.upgradeId), 404, 'not_found');
    expectProblem(await poll(dock, 'nope'), 404, 'not_found');
    expectProblem(await poll(null, body.upgradeId), 401, 'unauthenticated');

    t.scopeUpgrades.approve(body.upgradeId);
    const done = await poll(dock, body.upgradeId);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ status: 'approved', scopes: ['status:read', 'apps:read'] });
    expect((await get('/api/v1/apps', dock)).statusCode).toBe(200);
    expect((await get('/api/v1/', dock)).json().token).toEqual({ name: 'dock', scopes: ['status:read', 'apps:read'], profileId: club.id });
  });

  it('denied is 403, expired (here: replaced by a newer request) is 410', async () => {
    const dock = t.token(['status:read'], 'dock');
    const first = (await upgrade(dock, { scopes: ['chat:read'] })).json();
    const second = (await upgrade(dock, { scopes: ['apps:read'] })).json();
    expectProblem(await poll(dock, first.upgradeId), 410, 'expired');
    t.scopeUpgrades.deny(second.upgradeId);
    expectProblem(await poll(dock, second.upgradeId), 403, 'denied');
    expect((await get('/api/v1/', dock)).json().token.scopes).toEqual(['status:read']);
  });

  it('rate-limited per token', async () => {
    const dock = t.token(['status:read'], 'dock');
    let last: LightMyRequestResponse | null = null;
    for (let i = 0; i < 11; i++) last = await upgrade(dock, { scopes: ['chat:read'] });
    expectProblem(last as LightMyRequestResponse, 429, 'rate_limited');
    expect((last as LightMyRequestResponse).headers['retry-after']).toBeDefined();
    // Another token is not affected.
    expect((await upgrade(t.token(['status:read'], 'other'), { scopes: ['chat:read'] })).statusCode).toBe(202);
  });
});
