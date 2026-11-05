// /api/v1 since v1.2: profile binding, profiles, ingest, connected apps, overlays, messages, pairing.

import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE_ID, type ChatMessage, type Profile } from '../../../shared/types.js';
import { PROBLEM_TYPE, addressBucket } from './http.js';
import { createTestApi, dstate, session, type TestApi } from './test-helpers.js';
import type { Envelope } from './types.js';
import { MESSAGES_PER_MINUTE, PAIRINGS_PER_MINUTE_PER_IP, webUiBase } from './v1-hub.js';

let t: TestApi;
let dprtmnt: Profile;
let all: string;

beforeEach(async () => {
  t = await createTestApi();
  dprtmnt = t.addProfile('DPRTMNT', '#E11D48');
  all = t.token(['chat:read', 'status:read', 'ingest:read', 'apps:read', 'apps:write'], 'every profile');
});
afterEach(async () => {
  await t.close();
});

type Body = Record<string, unknown> | string | undefined;
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token?: string | null, body?: Body, headers: Record<string, string> = {}) =>
  t.app.inject({
    method,
    url,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
const get = (url: string, token?: string | null, headers?: Record<string, string>) => call('GET', url, token, undefined, headers);

function expectProblem(res: LightMyRequestResponse, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(res.json()).toEqual({ type: PROBLEM_TYPE, title: expect.any(String), status, detail: expect.any(String), code });
}

function chat(id: string, destinationId: string, profileId: string): ChatMessage {
  return { id: `twitch:${id}`, platform: 'twitch', destinationId, profileId, author: { name: 'v' }, text: id, ts: new Date().toISOString(), kind: 'message' };
}

const makeDest = (profileId: string, name: string) =>
  t.repos.destinations.create({ profileId, platform: 'twitch', accountId: null, name, feed: 'landscape', enabled: true, options: {}, ingestUrl: null });

describe('profile binding', () => {
  it('GET / reports the token’s profile', async () => {
    const limited = t.token(['status:read'], 'dock', dprtmnt.id);
    expect((await get('/api/v1/', limited)).json().token).toEqual({ name: 'dock', scopes: ['status:read'], profileId: dprtmnt.id });
    expect((await get('/api/v1/', all)).json().token.profileId).toBeNull();
  });

  it('/status: every-profile tokens default to the default profile and pick one with ?profile=; limited tokens see only theirs', async () => {
    const a = makeDest(DEFAULT_PROFILE_ID, 'Main Twitch');
    const b = makeDest(dprtmnt.id, 'Club Twitch');
    t.state.current = session({ title: 'Miami or Bust', destinations: [dstate(a.id, 'live')] });
    t.states.set(dprtmnt.id, session({ profileId: dprtmnt.id, title: 'DPRTMNT Saturday', destinations: [dstate(b.id, 'error', { message: 'boom' })] }));

    const def = (await get('/api/v1/status', all)).json();
    expect(def.session.title).toBe('Miami or Bust');
    expect(def.destinations.map((d: { id: string }) => d.id)).toEqual([a.id]);
    const club = (await get(`/api/v1/status?profile=${dprtmnt.id}`, all)).json();
    expect(club.session.title).toBe('DPRTMNT Saturday');
    expect(club.destinations).toEqual([expect.objectContaining({ id: b.id, down: true })]);
    expectProblem(await get('/api/v1/status?profile=nope', all), 404, 'unknown_profile');

    const limited = t.token(['status:read', 'chat:read'], 'club dock', dprtmnt.id);
    expect((await get('/api/v1/status', limited)).json().session.title).toBe('DPRTMNT Saturday');
    expect((await get(`/api/v1/status?profile=${dprtmnt.id}`, limited)).statusCode).toBe(200);
    expectProblem(await get(`/api/v1/status?profile=${DEFAULT_PROFILE_ID}`, limited), 403, 'profile_forbidden');
  });

  it('/chat and /events/poll per profile', async () => {
    const a = makeDest(DEFAULT_PROFILE_ID, 'A');
    const b = makeDest(dprtmnt.id, 'B');
    const limited = t.token(['chat:read'], 'club overlay', dprtmnt.id);
    const startAll = (await get('/api/v1/events/poll', all)).json().next;
    t.bus.emit('chat', chat('1', a.id, DEFAULT_PROFILE_ID));
    t.bus.emit('chat', chat('2', b.id, dprtmnt.id));

    const ids = (res: LightMyRequestResponse) => res.json().items.map((e: Envelope<{ id: string }>) => e.data.id);
    expect(ids(await get('/api/v1/chat', all))).toEqual(['twitch:1']);
    expect(ids(await get(`/api/v1/chat?profile=${dprtmnt.id}`, all))).toEqual(['twitch:2']);
    expect(ids(await get('/api/v1/chat', limited))).toEqual(['twitch:2']);
    expectProblem(await get('/api/v1/chat?profile=default', limited), 403, 'profile_forbidden');

    const poll = (q: string, token: string) => get(`/api/v1/events/poll?after=${startAll}&types=chat.*${q}`, token);
    expect(ids(await poll('', all))).toEqual(['twitch:1']); // old clients: the default profile
    expect(ids(await poll(`&profile=${dprtmnt.id}`, all))).toEqual(['twitch:2']);
    // ?profile=* (or all): every profile the token can see.
    expect(ids(await poll('&profile=*', all))).toEqual(['twitch:1', 'twitch:2']);
    expect(ids(await poll('&profile=all', all))).toEqual(['twitch:1', 'twitch:2']);
    expect(ids(await poll('&profile=*', limited))).toEqual(['twitch:2']);
    const own = (await poll('', limited)).json();
    expect(own.items.map((e: Envelope) => e.src.profile)).toEqual([dprtmnt.id]);
    expect(own.next).toBe(t.hub.cursor());
    // Only the event routes take it: /status and /chat are about one profile.
    expectProblem(await get('/api/v1/chat?profile=*', all), 404, 'unknown_profile');
  });
});

describe('profiles', () => {
  it('GET /profiles and /profiles/{id}', async () => {
    const res = await get('/api/v1/profiles', all);
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items.map((p: { id: string }) => p.id)).toEqual([DEFAULT_PROFILE_ID, dprtmnt.id]);
    expect(items[1]).toEqual({
      id: dprtmnt.id,
      name: 'DPRTMNT',
      slug: dprtmnt.slug,
      color: '#E11D48',
      status: 'offline',
      startedAt: null,
      testMode: false,
      destinations: 0,
      live: 0,
      down: 0,
      createdAt: dprtmnt.createdAt,
      updatedAt: dprtmnt.updatedAt,
    });
    expect((await get(`/api/v1/profiles/${dprtmnt.id}`, all)).json()).toEqual(items[1]);
    expectProblem(await get('/api/v1/profiles/nope', all), 404, 'unknown_profile');

    const limited = t.token(['status:read'], 'x', dprtmnt.id);
    expect((await get('/api/v1/profiles', limited)).json().items.map((p: { id: string }) => p.id)).toEqual([dprtmnt.id]);
    expectProblem(await get(`/api/v1/profiles/${DEFAULT_PROFILE_ID}`, limited), 403, 'profile_forbidden');
    expectProblem(await get('/api/v1/profiles', t.token(['chat:read'])), 403, 'missing_scope');
  });

  it('GET /profiles/{id}/ingest needs ingest:read; the default profile keeps its keys', async () => {
    expectProblem(await get(`/api/v1/profiles/${DEFAULT_PROFILE_ID}/ingest`, t.token(['status:read'])), 403, 'missing_scope');
    const res = await get(`/api/v1/profiles/${DEFAULT_PROFILE_ID}/ingest`, all, { host: '10.20.30.40:30080' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      profileId: DEFAULT_PROFILE_ID,
      serverUrl: 'rtmp://10.20.30.40:1936/live',
      feeds: [
        { feed: 'landscape', streamKey: 'landscape?key=Lkeydefault', fullUrl: 'rtmp://10.20.30.40:1936/live/landscape?key=Lkeydefault' },
        { feed: 'vertical', streamKey: 'vertical?key=Vkeydefault', fullUrl: 'rtmp://10.20.30.40:1936/live/vertical?key=Vkeydefault' },
      ],
    });
    const club = (await get(`/api/v1/profiles/${dprtmnt.id}/ingest`, all, { host: '10.20.30.40:30080' })).json();
    expect(club.feeds[0].streamKey).toBe(`${dprtmnt.slug}/landscape?key=Lkey${dprtmnt.id.replace(/-/g, '')}`);
    expect(club.feeds[1].fullUrl).toBe(`rtmp://10.20.30.40:1936/live/${club.feeds[1].streamKey}`);

    // The OBS host from Settings wins, then LAN_HTTP_HOST, then the host the app called.
    const before = process.env.LAN_HTTP_HOST;
    try {
      process.env.LAN_HTTP_HOST = 'truenas.lan';
      expect((await get(`/api/v1/profiles/${dprtmnt.id}/ingest`, all, { host: '203.0.113.7' })).json().serverUrl).toBe('rtmp://truenas.lan:1936/live');
      t.settings.ingestHost = 'http://10.0.0.5:8443/';
      expect((await get(`/api/v1/profiles/${dprtmnt.id}/ingest`, all)).json().serverUrl).toBe('rtmp://10.0.0.5:1936/live');
    } finally {
      if (before === undefined) delete process.env.LAN_HTTP_HOST;
      else process.env.LAN_HTTP_HOST = before;
    }

    const limited = t.token(['ingest:read'], 'obs', dprtmnt.id);
    expect((await get(`/api/v1/profiles/${dprtmnt.id}/ingest`, limited)).statusCode).toBe(200);
    expectProblem(await get(`/api/v1/profiles/${DEFAULT_PROFILE_ID}/ingest`, limited), 403, 'profile_forbidden');
  });
});

describe('connected apps', () => {
  const overlayBody = (profileId: string | null) => ({
    name: 'CTD Overlay',
    kind: 'ctd-overlay',
    version: '1.4.0',
    baseUrl: 'http://10.20.30.40:30200',
    capabilities: ['overlays', 'overlay.create'],
    resources: [
      { type: 'overlay', id: 'ovl_h', name: 'DPRTMNT takeover — landscape', profileId, url: 'http://10.20.30.40:30200/o/takeover-h?key=k', width: 1920, height: 1080, meta: { canvas: 'landscape' } },
      { type: 'overlay', id: 'ovl_any', name: 'Chat', profileId: null, url: 'http://10.20.30.40:30200/o/chat?key=k' },
    ],
  });

  it('register, list per profile, overlays per profile, heartbeat, unregister', async () => {
    const put = await call('PUT', '/api/v1/apps/ctd-overlay', all, overlayBody(dprtmnt.id));
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ id: 'ctd-overlay', kind: 'ctd-overlay', profileId: null, online: true });
    expect(put.json()).not.toHaveProperty('tokenId');

    const reader = t.token(['apps:read'], 'obs');
    const listed = (await get('/api/v1/apps', reader)).json().items;
    expect(listed).toHaveLength(1);
    expect(listed[0].resources).toHaveLength(2);
    const forDefault = (await get(`/api/v1/apps?profile=${DEFAULT_PROFILE_ID}`, reader)).json().items;
    expect(forDefault[0].resources.map((r: { id: string }) => r.id)).toEqual(['ovl_any']);
    expectProblem(await get('/api/v1/apps?profile=nope', reader), 404, 'unknown_profile');

    const overlays = (await get(`/api/v1/profiles/${dprtmnt.id}/overlays`, reader)).json();
    expect(overlays).toEqual({
      items: [
        {
          appId: 'ctd-overlay',
          appName: 'CTD Overlay',
          appOnline: true,
          id: 'ovl_h',
          name: 'DPRTMNT takeover — landscape',
          url: 'http://10.20.30.40:30200/o/takeover-h?key=k',
          width: 1920,
          height: 1080,
          meta: { canvas: 'landscape' },
        },
      ],
    });
    expect((await get(`/api/v1/profiles/${DEFAULT_PROFILE_ID}/overlays`, reader)).json()).toEqual({ items: [] });
    expectProblem(await get(`/api/v1/profiles/${dprtmnt.id}/overlays`, t.token(['status:read'])), 403, 'missing_scope');

    // Only the registering token may touch it.
    const other = t.token(['apps:read', 'apps:write'], 'other');
    expectProblem(await call('PUT', '/api/v1/apps/ctd-overlay', other, overlayBody(null)), 409, 'app_owned');
    expectProblem(await call('POST', '/api/v1/apps/ctd-overlay/heartbeat', other), 409, 'app_owned');
    expectProblem(await call('DELETE', '/api/v1/apps/ctd-overlay', other), 409, 'app_owned');
    expectProblem(await call('PUT', '/api/v1/apps/ctd-overlay', reader, overlayBody(null)), 403, 'missing_scope');

    // Heartbeat: no body, or an empty JSON body.
    expect((await call('POST', '/api/v1/apps/ctd-overlay/heartbeat', all)).statusCode).toBe(200);
    const hb = await call('POST', '/api/v1/apps/ctd-overlay/heartbeat', all, '');
    expect(hb.statusCode, hb.body).toBe(200);
    expect(hb.json()).toMatchObject({ id: 'ctd-overlay', online: true });
    expectProblem(await call('POST', '/api/v1/apps/nope/heartbeat', all), 404, 'not_found');

    const del = await call('DELETE', '/api/v1/apps/ctd-overlay', all);
    expect(del.statusCode).toBe(204);
    expect((await get('/api/v1/apps', reader)).json().items).toEqual([]);
    expectProblem(await call('DELETE', '/api/v1/apps/ctd-overlay', all), 404, 'not_found');
  });

  it('a token limited to a profile registers only for it; revoking a token removes its apps', async () => {
    const club = t.token(['apps:read', 'apps:write'], 'overlay (club)', dprtmnt.id);
    expectProblem(await call('PUT', '/api/v1/apps/ctd-overlay-dprtmnt', club, overlayBody(DEFAULT_PROFILE_ID)), 403, 'profile_forbidden');
    const ok = await call('PUT', '/api/v1/apps/ctd-overlay-dprtmnt', club, overlayBody(dprtmnt.id));
    expect(ok.json().profileId).toBe(dprtmnt.id);
    // Its view is always its profile; an every-profile reader of the default profile doesn't list it.
    expect((await get('/api/v1/apps', club)).json().items.map((a: { id: string }) => a.id)).toEqual(['ctd-overlay-dprtmnt']);
    expect((await get('/api/v1/apps?profile=*', club)).json().items.map((a: { id: string }) => a.id)).toEqual(['ctd-overlay-dprtmnt']);
    expect((await get(`/api/v1/apps?profile=${DEFAULT_PROFILE_ID}`, all)).json().items).toEqual([]);
    expect((await get('/api/v1/apps?profile=*', all)).json().items.map((a: { id: string }) => a.id)).toEqual(['ctd-overlay-dprtmnt']);

    const id = t.repos.apiTokens.list().find((x) => x.name === 'overlay (club)')!.id;
    t.apps.removeByToken(id);
    expect(t.apps.list()).toEqual([]);
  });

  it('rejects invalid registrations as problem documents', async () => {
    expectProblem(await call('PUT', '/api/v1/apps/Not_Valid', all, overlayBody(null)), 400, 'invalid');
    expectProblem(await call('PUT', '/api/v1/apps/x', all, { name: 'x', kind: 'Bad Kind' }), 400, 'invalid');
    expectProblem(await call('PUT', '/api/v1/apps/x', all, '{"name":'), 400, 'invalid');
    expectProblem(await call('PUT', '/api/v1/apps/x', all, '{"__proto__":{"a":1},"name":"x","kind":"k"}'), 400, 'invalid');
    const huge = { name: 'x', kind: 'k', resources: [{ type: 'note', id: 'n', name: 'n', profileId: null, meta: { s: 'x'.repeat(300 * 1024) } }] };
    expectProblem(await call('PUT', '/api/v1/apps/x', all, huge), 413, 'invalid');
  });
});

describe('POST /messages', () => {
  async function register(token: string, id: string) {
    const res = await call('PUT', `/api/v1/apps/${id}`, token, { name: id, kind: 'custom' });
    expect(res.statusCode, res.body).toBe(200);
  }

  it('delivers to the recipient’s token only; broadcasts to everyone; replies go back', async () => {
    const overlay = t.token(['apps:read', 'apps:write'], 'overlay');
    const obs = t.token(['apps:read', 'apps:write'], 'obs');
    const bystander = t.token(['apps:read'], 'bystander');
    await register(overlay, 'ctd-overlay');
    await register(obs, 'ctd-obs-plugin-studio');
    const start = (await get('/api/v1/events/poll', obs)).json().next;

    const sent = await call('POST', '/api/v1/messages', obs, { to: 'ctd-overlay', type: 'overlay.create', profileId: dprtmnt.id, data: { template: 'takeover', canvas: 'vertical' } });
    expect(sent.statusCode, sent.body).toBe(201);
    const { id } = sent.json();
    expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

    const inbox = async (token: string, profile = '') => (await get(`/api/v1/events/poll?after=${start}&types=app.*${profile}`, token)).json().items as Envelope<Record<string, unknown>>[];
    // The overlay token reads every profile? Its poll defaults to the default profile: the message is about DPRTMNT.
    expect(await inbox(overlay)).toEqual([]);
    const got = await inbox(overlay, `&profile=${dprtmnt.id}`);
    expect(got).toHaveLength(1);
    expect(got[0]!.data).toEqual({
      id,
      from: 'ctd-obs-plugin-studio',
      to: 'ctd-overlay',
      type: 'overlay.create',
      profileId: dprtmnt.id,
      replyTo: null,
      data: { template: 'takeover', canvas: 'vertical' },
      ts: expect.any(Number),
    });
    expect(await inbox(bystander, `&profile=${dprtmnt.id}`)).toEqual([]);
    expect(await inbox(obs, `&profile=${dprtmnt.id}`)).toEqual([]);

    // Reply, then a broadcast without a profile.
    const reply = await call('POST', '/api/v1/messages', overlay, { to: 'ctd-obs-plugin-studio', type: 'overlay.created', replyTo: id.toLowerCase(), profileId: dprtmnt.id, data: { id: 'ovl_v' } });
    expect(reply.statusCode).toBe(201);
    expect((await inbox(obs, `&profile=${dprtmnt.id}`))[0]!.data).toMatchObject({ from: 'ctd-overlay', replyTo: id });
    await call('POST', '/api/v1/messages', obs, { to: null, type: 'hello' });
    expect((await inbox(bystander)).map((e) => e.data.type)).toEqual(['hello']);
  });

  it('profile rules, unknown recipients, validation and the rate limit', async () => {
    const club = t.token(['apps:read', 'apps:write'], 'club', dprtmnt.id);
    const main = t.token(['apps:read', 'apps:write'], 'main', DEFAULT_PROFILE_ID);
    await register(club, 'club-app');
    await register(main, 'main-app');
    expectProblem(await call('POST', '/api/v1/messages', club, { to: null, type: 'x', profileId: DEFAULT_PROFILE_ID }), 403, 'profile_forbidden');
    expectProblem(await call('POST', '/api/v1/messages', all, { to: 'main-app', type: 'x', profileId: dprtmnt.id }), 400, 'invalid');
    expectProblem(await call('POST', '/api/v1/messages', all, { to: 'nobody', type: 'x' }), 404, 'not_found');
    expectProblem(await call('POST', '/api/v1/messages', all, { type: 'x' }), 400, 'invalid'); // `to` is required (null = everyone)
    expectProblem(await call('POST', '/api/v1/messages', all, { to: null, type: 'Bad Type' }), 400, 'invalid');
    expectProblem(await call('POST', '/api/v1/messages', all, { to: null, type: 'x', replyTo: 'nope' }), 400, 'invalid');
    expectProblem(await call('POST', '/api/v1/messages', all, { to: null, type: 'x', profileId: 'nope' }), 404, 'unknown_profile');
    expectProblem(await call('POST', '/api/v1/messages', all, { to: null, type: 'x', from: 'club-app' }), 400, 'invalid');
    // "from": null is the same as leaving it out.
    expect((await call('POST', '/api/v1/messages', club, { to: null, type: 'x', from: null })).statusCode).toBe(201);
    expectProblem(await call('POST', '/api/v1/messages', all, { to: null, type: 'x', data: { s: 'x'.repeat(65 * 1024) } }), 400, 'invalid');
    expectProblem(await call('POST', '/api/v1/messages', t.token(['apps:read']), { to: null, type: 'x' }), 403, 'missing_scope');

    // A club-limited sender's message defaults to its profile: the main-limited app never gets it.
    const start = (await get('/api/v1/events/poll', main)).json().next;
    expect((await call('POST', '/api/v1/messages', club, { to: null, type: 'ping' })).statusCode).toBe(201);
    expect((await get(`/api/v1/events/poll?after=${start}&types=app.message`, main)).json().items).toEqual([]);

    // Every attempt counts (the refused one above included): 3 so far.
    for (let i = 0; i < MESSAGES_PER_MINUTE - 3; i++) expect((await call('POST', '/api/v1/messages', club, { to: null, type: 'ping' })).statusCode).toBe(201);
    const limited = await call('POST', '/api/v1/messages', club, { to: null, type: 'ping' });
    expectProblem(limited, 429, 'rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });
});

describe('pairing', () => {
  const request = { appName: 'CTD OBS plugin (Studio PC)', kind: 'ctd-obs-plugin', scopes: ['status:read', 'chat:read', 'ingest:read', 'apps:read', 'apps:write', 'future:scope'], profileId: null };

  it('pair → pending → approved (token once) → expired; the token works and is bound to the chosen profile', async () => {
    const started = await call('POST', '/api/v1/pairing', null, request, { host: '10.20.30.40:30080' });
    expect(started.statusCode, started.body).toBe(201);
    const body = started.json();
    expect(body).toEqual({
      pairingId: expect.any(String),
      pollSecret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code: expect.stringMatching(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/),
      expiresIn: 600,
      interval: 3,
      approveUrl: `https://10.20.30.40:30443/settings?tab=api&pair=${body.pairingId}`,
    });
    // Known scopes only, in canonical order.
    expect(t.pairings.list()[0]).toMatchObject({ code: body.code, requestedScopes: ['chat:read', 'status:read', 'ingest:read', 'apps:read', 'apps:write'], ip: expect.any(String) });

    const poll = (secret = body.pollSecret) => call('POST', `/api/v1/pairing/${body.pairingId}/token`, null, { pollSecret: secret });
    const pending = await poll();
    expect(pending.statusCode).toBe(202);
    expect(pending.json()).toEqual({ status: 'pending' });

    t.pairings.approve(body.pairingId, { scopes: ['status:read', 'ingest:read', 'apps:read'], profileId: dprtmnt.id, approvedBy: 'admin' });
    const approved = await poll();
    expect(approved.statusCode).toBe(200);
    expect(approved.headers['cache-control']).toBe('no-store');
    const { token, profileId, scopes, status } = approved.json();
    expect({ status, profileId, scopes }).toEqual({ status: 'approved', profileId: dprtmnt.id, scopes: ['status:read', 'ingest:read', 'apps:read'] });
    expect((await get('/api/v1/', token)).json().token).toEqual({ name: 'CTD OBS plugin (Studio PC)', scopes: ['status:read', 'ingest:read', 'apps:read'], profileId: dprtmnt.id });
    expect((await get(`/api/v1/profiles/${dprtmnt.id}/ingest`, token)).statusCode).toBe(200);

    expectProblem(await poll(), 410, 'expired');
  });

  it('denied → 403; wrong secret or unknown id → 410; bad bodies → 400', async () => {
    const body = (await call('POST', '/api/v1/pairing', null, request)).json();
    expect(body.approveUrl).toBe(`https://localhost/settings?tab=api&pair=${body.pairingId}`);
    expectProblem(await call('POST', `/api/v1/pairing/${body.pairingId}/token`, null, { pollSecret: 'wrong' }), 410, 'expired');
    expectProblem(await call('POST', '/api/v1/pairing/nope/token', null, { pollSecret: 'x' }), 410, 'expired');
    expectProblem(await call('POST', `/api/v1/pairing/${body.pairingId}/token`, null, {}), 400, 'invalid');
    t.pairings.deny(body.pairingId);
    expectProblem(await call('POST', `/api/v1/pairing/${body.pairingId}/token`, null, { pollSecret: body.pollSecret }), 403, 'denied');

    expectProblem(await call('POST', '/api/v1/pairing', null, { ...request, scopes: ['nope'] }), 400, 'invalid');
    expectProblem(await call('POST', '/api/v1/pairing', null, { ...request, kind: 'Has Spaces' }), 400, 'invalid');
    expectProblem(await call('POST', '/api/v1/pairing', null, { ...request, scopes: [] }), 400, 'invalid');
    expectProblem(await call('POST', '/api/v1/pairing', null, { ...request, scopes: 'chat:read' }), 400, 'invalid');
    expectProblem(await call('POST', '/api/v1/pairing', null, { ...request, profileId: 'nope' }), 404, 'unknown_profile');
    expectProblem(await call('POST', '/api/v1/pairing', null, { ...request, appName: 'bad\u0007name' }), 400, 'invalid');
  });

  it('ignores scopes it does not know, whatever their shape', async () => {
    const res = await call('POST', '/api/v1/pairing', null, { ...request, scopes: ['chat:read', 'x'.repeat(100), 42, null, { a: 1 }, ...Array.from({ length: 30 }, (_, i) => `future:${i}`)] });
    expect(res.statusCode, res.body).toBe(201);
    expect(t.pairings.list()[0]!.requestedScopes).toEqual(['chat:read']);
  });

  it(`at most ${PAIRINGS_PER_MINUTE_PER_IP} requests a minute per address`, async () => {
    // Pending requests are capped at 10 too: deny them as they come so only the address limit applies.
    for (let i = 0; i < PAIRINGS_PER_MINUTE_PER_IP; i++) {
      const res = await call('POST', '/api/v1/pairing', null, request);
      expect(res.statusCode).toBe(201);
      t.pairings.deny(res.json().pairingId);
    }
    const limited = await call('POST', '/api/v1/pairing', null, request);
    expectProblem(limited, 429, 'rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('webUiBase maps the LAN plain-HTTP port back to the HTTPS web UI', () => {
    const config = { tlsMode: 'self-signed' as const, webPort: 8443, httpPort: 8080 };
    expect(webUiBase(config, '10.20.30.40:30080', false, 'https://x')).toBe('https://10.20.30.40:30443');
    expect(webUiBase(config, '10.20.30.40', false, 'https://x')).toBe('https://10.20.30.40');
    expect(webUiBase(config, '10.20.30.40:8080', false, 'https://x')).toBe('https://10.20.30.40:8443');
    expect(webUiBase(config, 'nas.lan:30443', true, 'https://x')).toBe('https://nas.lan:30443');
    expect(webUiBase({ ...config, tlsMode: 'off' }, 'nas.lan:8443', false, 'https://x')).toBe('http://nas.lan:8443');
    expect(webUiBase(config, 'bad host/../', false, 'https://203.0.113.7/')).toBe('https://203.0.113.7');
    // LAN_HTTP_PORT override: the HTTPS port can't be derived from it; the public web UI address is used.
    expect(webUiBase(config, '10.20.30.40:9080', false, 'https://203.0.113.7:30443/', 9080)).toBe('https://203.0.113.7:30443');
    expect(webUiBase(config, '10.20.30.40:30080', false, 'https://x', 9080)).toBe('https://10.20.30.40:30443');
    expect(webUiBase(config, '10.20.30.40:8080', false, 'https://x', 8080)).toBe('https://10.20.30.40:8443');
  });

  it('the per-address limits count an IPv6 /64 as one address', () => {
    expect(addressBucket('2001:db8:1:2::1')).toBe(addressBucket('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(addressBucket('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(addressBucket('2001:db8:1:3::1')).not.toBe(addressBucket('2001:db8:1:2::1'));
    expect(addressBucket('::1')).toBe('0:0:0:0::/64');
    expect(addressBucket('::ffff:192.168.1.5')).toBe('192.168.1.5');
    expect(addressBucket('192.168.1.5')).toBe('192.168.1.5');
    expect(addressBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(addressBucket(undefined)).toBe('unknown');
    expect(addressBucket('nope')).toBe('unknown');
  });
});

describe('the route table', () => {
  it('OpenAPI documents every /api/v1 route, and nothing else', async () => {
    const doc = (await get('/api/v1/openapi.json')).json();
    const documented = new Set<string>();
    for (const [path, ops] of Object.entries(doc.paths as Record<string, Record<string, unknown>>)) {
      for (const method of Object.keys(ops)) documented.add(`${method.toUpperCase()} ${path}`);
    }
    const served = new Set(
      t.routes
        .filter((r) => !r.startsWith('OPTIONS ') && !r.startsWith('HEAD '))
        .map((r) => r.replace('/api/v1', '').replace(/:(\w+)/g, '{$1}'))
        .map((r) => (r.endsWith(' ') ? `${r}/` : r)),
    );
    expect([...served].sort()).toEqual([...documented].sort());
    // Every operation names its responses, and every $ref resolves.
    const refs = JSON.stringify(doc).match(/#\/components\/schemas\/\w+/g) ?? [];
    for (const r of refs) expect(doc.components.schemas[r.split('/').at(-1)!], r).toBeDefined();
  });

  it('CORS preflight allows the write methods', async () => {
    const pre = await t.app.inject({ method: 'OPTIONS', url: '/api/v1/apps/x', headers: { origin: 'https://overlay.example', 'access-control-request-method': 'PUT' } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-methods']).toMatch(/PUT/);
    expect(pre.headers['access-control-allow-methods']).toMatch(/DELETE/);
  });
});
