// Overlay summaries (docs/API.md §9.5): PUT /apps/{appId}/summary and GET /profiles/{id}/overlay-summary.

import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE_ID, type Profile } from '../../../shared/types.js';
import { PROBLEM_TYPE } from './http.js';
import { createSummaryStore, summaryForProfile, SUMMARY_BODY_LIMIT, SUMMARY_SCHEMA, type OverlaySummary } from './overlay-summary.js';
import { createTestApi, type TestApi } from './test-helpers.js';

let t: TestApi;
let club: Profile;
let overlayToken: string;

beforeEach(async () => {
  t = await createTestApi();
  club = t.addProfile('Club', '#E11D48');
  overlayToken = t.token(['chat:read', 'status:read', 'apps:read', 'apps:write'], 'CTD Overlay');
});
afterEach(async () => {
  await t.close();
});

type Body = Record<string, unknown> | string | undefined;
const call = (method: 'GET' | 'PUT', url: string, token?: string | null, body?: Body) =>
  t.app.inject({
    method,
    url,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });

function expectProblem(res: LightMyRequestResponse, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.json()).toEqual({ type: PROBLEM_TYPE, title: expect.any(String), status, detail: expect.any(String), code });
}

const overlayUrl = (id: string) => `http://overlay.test:4848/o/${id}?key=skp_ovl_SECRET`;

/** CTD Overlay following every profile: "lower" fed by the default profile, "club-bug" by Club. */
const registration = () => ({
  name: 'CTD Overlay',
  kind: 'ctd-overlay',
  version: '0.4.0',
  baseUrl: 'http://overlay.test:4848',
  capabilities: ['overlays', 'overlay.create'],
  resources: [
    { type: 'overlay', id: `ovl_lower:h:${DEFAULT_PROFILE_ID}`, name: 'lower — h', profileId: DEFAULT_PROFILE_ID, url: overlayUrl('lower'), width: 1920, height: 1080, meta: { canvas: 'landscape' } },
    { type: 'overlay', id: `ovl_lower:v:${DEFAULT_PROFILE_ID}`, name: 'lower — v', profileId: DEFAULT_PROFILE_ID, url: overlayUrl('lower-v'), width: 1080, height: 1920, meta: { canvas: 'vertical' } },
    { type: 'overlay', id: `ovl_club:h:${club.id}`, name: 'club-bug — h', profileId: club.id, url: overlayUrl('club'), width: 1920, height: 1080, meta: { canvas: 'landscape' } },
  ],
});

const summary = (): OverlaySummary & Record<string, unknown> => ({
  schema: SUMMARY_SCHEMA,
  server: { name: 'CTD Overlay', version: '0.4.0' },
  ui: 'http://overlay.test:4848',
  templates: [
    {
      id: 'com.ctd.lower',
      name: 'Lower third',
      installed: '1.3.0',
      oldestInUse: '1.3.0',
      latest: '1.3.0',
      source: { kind: 'github', repo: 'someone/lower-third' },
      auto: true,
      update: 'none',
      notes: [{ version: '1.3.0', text: 'New: a darker style\nFix: long names wrap' }],
    },
    { id: 'com.ctd.clubbug', name: 'Club bug', installed: '2.0.0', oldestInUse: '1.4.0', latest: '2.0.0', source: { kind: 'github', repo: 'someone/club-bug' }, auto: true, update: 'major' },
    { id: 'com.ctd.unused', name: 'Not used yet', installed: '1.0.0', source: { kind: 'none' } },
  ],
  overlays: [
    { id: 'ovl_lower', slug: 'lower', show: 'Miami Or Bust', template: { id: 'com.ctd.lower', name: 'Lower third', version: '1.3.0' } },
    { id: 'ovl_club', slug: 'club-bug', show: 'Club Night', template: { id: 'com.ctd.clubbug', version: '1.4.0' }, waiting: { to: '2.0.0', major: true, why: 'a major version' } },
  ],
});

async function registerAndSend(token = overlayToken) {
  expect((await call('PUT', '/api/v1/apps/ctd-overlay', token, registration())).statusCode).toBe(200);
  const res = await call('PUT', '/api/v1/apps/ctd-overlay/summary', token, summary());
  expect(res.statusCode, res.body).toBe(204);
}

describe('PUT /apps/{appId}/summary', () => {
  it('needs a token with apps:write', async () => {
    expectProblem(await call('PUT', '/api/v1/apps/ctd-overlay/summary', null, summary()), 401, 'unauthenticated');
    const reader = t.token(['apps:read'], 'reader');
    expectProblem(await call('PUT', '/api/v1/apps/ctd-overlay/summary', reader, summary()), 403, 'missing_scope');
  });

  it('is only for a registered app, by the token that registered it', async () => {
    expectProblem(await call('PUT', '/api/v1/apps/ctd-overlay/summary', overlayToken, summary()), 404, 'not_found');
    expect((await call('PUT', '/api/v1/apps/ctd-overlay', overlayToken, registration())).statusCode).toBe(200);
    const other = t.token(['apps:read', 'apps:write'], 'another app');
    expectProblem(await call('PUT', '/api/v1/apps/ctd-overlay/summary', other, summary()), 409, 'app_owned');
    expectProblem(await call('PUT', '/api/v1/apps/NOT VALID/summary', overlayToken, summary()), 400, 'invalid');
  });

  it('refuses a body that is not a summary', async () => {
    expect((await call('PUT', '/api/v1/apps/ctd-overlay', overlayToken, registration())).statusCode).toBe(200);
    expectProblem(await call('PUT', '/api/v1/apps/ctd-overlay/summary', overlayToken, { ...summary(), schema: 'something-else' }), 400, 'invalid');
    const bad = summary();
    bad.templates[0]!.installed = 'latest';
    expectProblem(await call('PUT', '/api/v1/apps/ctd-overlay/summary', overlayToken, bad), 400, 'invalid');
    expectProblem(await call('PUT', '/api/v1/apps/ctd-overlay/summary', overlayToken, { ...summary(), ui: 'http://user:pass@overlay.test' }), 400, 'invalid');
    const tooMany = summary();
    tooMany.templates[0]!.notes = [{ version: '1.3.0', text: Array(9).fill('line').join('\n') }];
    expectProblem(await call('PUT', '/api/v1/apps/ctd-overlay/summary', overlayToken, tooMany), 400, 'invalid');
    const control = summary();
    control.templates[0]!.notes = [{ version: '1.3.0', text: 'bell\u0007' }];
    expectProblem(await call('PUT', '/api/v1/apps/ctd-overlay/summary', overlayToken, control), 400, 'invalid');
    const big = { ...summary(), padding: 'x'.repeat(SUMMARY_BODY_LIMIT) };
    expect((await call('PUT', '/api/v1/apps/ctd-overlay/summary', overlayToken, big)).statusCode).toBe(413);
  });
});

describe('GET /profiles/{id}/overlay-summary', () => {
  it('needs a token with apps:read; an admin-only token without it is refused', async () => {
    await registerAndSend();
    expectProblem(await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/overlay-summary`), 401, 'unauthenticated');
    const statusOnly = t.token(['status:read', 'chat:read'], 'status only');
    expectProblem(await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/overlay-summary`, statusOnly), 403, 'missing_scope');
    const admin = t.token(['system:admin'], 'operator tools');
    expectProblem(await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/overlay-summary`, admin), 403, 'missing_scope');
    expectProblem(await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/overlay-summary`, 'ctd_pat_not_a_real_token'), 401, 'unauthenticated');
  });

  it('lists the summary with the overlays of that profile, and nothing the summary did not declare', async () => {
    await registerAndSend();
    const plugin = t.token(['status:read', 'apps:read', 'apps:write'], 'CTD OBS plugin');
    const res = await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/overlay-summary`, plugin);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { items } = res.json();
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item).toMatchObject({ appId: 'ctd-overlay', appName: 'CTD Overlay', appOnline: true, schema: SUMMARY_SCHEMA, server: { version: '0.4.0' }, ui: 'http://overlay.test:4848' });
    expect(item.overlays.map((o: { slug: string }) => o.slug)).toEqual(['lower']);
    // its template, and the one no overlay uses; not the club's
    expect(item.templates.map((x: { id: string }) => x.id)).toEqual(['com.ctd.lower', 'com.ctd.unused']);
    expect(item.templates[0].notes).toEqual([{ version: '1.3.0', text: 'New: a darker style\nFix: long names wrap' }]);
    // no token ids, no overlay keys or URLs
    const text = res.body;
    expect(text).not.toContain('tokenId');
    expect(text).not.toContain('skp_ovl_');
    expect(text).not.toContain('key=');
  });

  it('drops fields the schema does not know (a key, a URL, a stack) before storing', async () => {
    expect((await call('PUT', '/api/v1/apps/ctd-overlay', overlayToken, registration())).statusCode).toBe(200);
    const leaky = summary() as Record<string, unknown> & { overlays: Record<string, unknown>[]; templates: Record<string, unknown>[] };
    leaky.githubToken = 'ghp_SECRET';
    leaky.overlays[0]!.url = overlayUrl('lower');
    leaky.overlays[0]!.key = 'skp_ovl_SECRET';
    leaky.templates[0]!.error = { message: 'boom', stack: 'at /data/secret/path' };
    expect((await call('PUT', '/api/v1/apps/ctd-overlay/summary', overlayToken, leaky)).statusCode).toBe(204);
    const res = await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/overlay-summary`, overlayToken);
    expect(res.statusCode).toBe(200);
    for (const s of ['ghp_SECRET', 'skp_ovl_', '/data/secret/path', '"url"', '"key"']) expect(res.body).not.toContain(s);
  });

  it('a token limited to one profile sees only that profile', async () => {
    await registerAndSend();
    const clubDock = t.token(['apps:read'], 'club dock', club.id);
    const mine = await call('GET', `/api/v1/profiles/${club.id}/overlay-summary`, clubDock);
    expect(mine.statusCode).toBe(200);
    const item = mine.json().items[0];
    expect(item.overlays).toEqual([expect.objectContaining({ slug: 'club-bug', waiting: { to: '2.0.0', major: true, why: 'a major version' } })]);
    expect(item.templates.map((x: { id: string }) => x.id)).toEqual(['com.ctd.clubbug', 'com.ctd.unused']);
    expectProblem(await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/overlay-summary`, clubDock), 403, 'profile_forbidden');
    expectProblem(await call('GET', '/api/v1/profiles/nope/overlay-summary', overlayToken), 404, 'unknown_profile');
  });

  it('is empty before a summary arrives, and forgets it when the app unregisters', async () => {
    expect((await call('PUT', '/api/v1/apps/ctd-overlay', overlayToken, registration())).statusCode).toBe(200);
    expect((await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/overlay-summary`, overlayToken)).json()).toEqual({ items: [] });
    expect((await call('PUT', '/api/v1/apps/ctd-overlay/summary', overlayToken, summary())).statusCode).toBe(204);
    expect((await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/overlay-summary`, overlayToken)).json().items).toHaveLength(1);
    const del = await t.app.inject({ method: 'DELETE', url: '/api/v1/apps/ctd-overlay', headers: { authorization: `Bearer ${overlayToken}` } });
    expect(del.statusCode).toBe(204);
    expect((await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/overlay-summary`, overlayToken)).json()).toEqual({ items: [] });
  });
});

describe('summary store and profile view', () => {
  it('drops a summary once another token owns the app id', () => {
    const store = createSummaryStore();
    store.put('ctd-overlay', 'tok_a', summary(), '2026-11-21T00:00:00.000Z');
    expect(store.get({ id: 'ctd-overlay', tokenId: 'tok_a' })?.summary.server.version).toBe('0.4.0');
    expect(store.get({ id: 'ctd-overlay', tokenId: 'tok_b' })).toBeNull();
    expect(store.size()).toBe(0);
  });

  it('prunes summaries of apps that are gone', () => {
    const store = createSummaryStore();
    store.put('a', 't', summary(), 'x');
    store.put('b', 't', summary(), 'x');
    store.prune(new Set(['b']));
    expect(store.size()).toBe(1);
  });

  it('keeps an app-wide resource out of a profile view (only resources assigned to the profile count)', () => {
    const view = summaryForProfile(summary(), { resources: [{ type: 'overlay', id: 'ovl_lower:h', name: 'x', profileId: null }] }, DEFAULT_PROFILE_ID);
    expect(view.overlays).toEqual([]);
    expect(view.templates.map((x) => x.id)).toEqual(['com.ctd.unused']);
  });
});
