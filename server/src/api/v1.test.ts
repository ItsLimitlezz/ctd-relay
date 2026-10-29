import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../../shared/api.js';
import { DEFAULT_PROFILE_ID, type ChatMessage } from '../../../shared/types.js';
import { PROBLEM_TYPE } from './http.js';
import { createTestApi, dstate, session, type TestApi } from './test-helpers.js';
import { RATE_LIMIT_PER_MINUTE } from './v1.js';

let t: TestApi;
let both: string;

beforeEach(async () => {
  t = await createTestApi();
  both = t.token();
});
afterEach(async () => {
  await t.close();
});

const get = (url: string, token?: string | null, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

function expectProblem(res: LightMyRequestResponse, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const body = res.json();
  expect(body).toEqual({ type: PROBLEM_TYPE, title: expect.any(String), status, detail: expect.any(String), code });
  return body as { detail: string };
}

function chat(i: number): ChatMessage {
  return {
    id: `twitch:${i}`,
    platform: 'twitch',
    destinationId: 'd1',
    author: { name: `viewer${i}`, id: String(i) },
    text: `hello ${i}`,
    ts: new Date().toISOString(),
    kind: 'message',
  };
}

describe('auth', () => {
  it('GET / identifies the token', async () => {
    const res = await get('/api/v1/', both);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: 'ctd-multi-stream',
      version: '9.9.9',
      build: { commit: null, date: null },
      apiRevision: '1.8',
      apiVersion: 1,
      token: { name: 'test', scopes: ['chat:read', 'status:read'], profileId: null },
    });
    expect((await get('/api/v1', both)).statusCode).toBe(200);
  });

  it('401 problem for missing, malformed, unknown and revoked tokens', async () => {
    const missing = await get('/api/v1/status');
    expect(expectProblem(missing, 401, 'unauthenticated').detail).toMatch(/Settings → API/);
    expect(missing.headers['www-authenticate']).toBe('Bearer realm="ctd-multi-stream"');
    expectProblem(await get('/api/v1/status', null, { authorization: 'Basic abc' }), 401, 'unauthenticated');
    expectProblem(await get('/api/v1/status', null, { authorization: `Bearer ${both} extra` }), 401, 'unauthenticated');
    expectProblem(await get('/api/v1/status', `ctd_pat_${'x'.repeat(43)}`), 401, 'unauthenticated');

    const id = t.repos.apiTokens.list()[0]!.id;
    expect((await get('/api/v1/status', both)).statusCode).toBe(200);
    t.repos.apiTokens.delete(id);
    expectProblem(await get('/api/v1/status', both), 401, 'unauthenticated');
  });

  it('accepts ?access_token= only on /events', async () => {
    expectProblem(await get(`/api/v1/status?access_token=${both}`), 401, 'unauthenticated');
    expectProblem(await get(`/api/v1/events/poll?access_token=${both}`), 401, 'unauthenticated');
  });

  it('403 missing_scope per route', async () => {
    const chatOnly = t.token(['chat:read']);
    const statusOnly = t.token(['status:read']);
    expectProblem(await get('/api/v1/status', chatOnly), 403, 'missing_scope');
    expectProblem(await get('/api/v1/chat', statusOnly), 403, 'missing_scope');
    expect((await get('/api/v1/status', statusOnly)).statusCode).toBe(200);
    expect((await get('/api/v1/chat', chatOnly)).statusCode).toBe(200);
    expect((await get('/api/v1/', chatOnly)).statusCode).toBe(200);
    // types the token can't see at all
    expectProblem(await get('/api/v1/events/poll?types=chat.*', statusOnly), 403, 'missing_scope');
    expectProblem(await get('/api/v1/events/poll?types=nope.*', statusOnly), 400, 'invalid');
    expectProblem(await get('/api/v1/events/poll?types=chat.<script>', statusOnly), 400, 'invalid');
  });

  it('rate limits at 600 requests/minute per token with Retry-After', async () => {
    const other = t.token(['status:read'], 'other');
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      const res = await get('/api/v1/', both);
      expect(res.statusCode).toBe(200);
    }
    const limited = await get('/api/v1/status', both);
    expectProblem(limited, 429, 'rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect((await get('/api/v1/', other)).statusCode).toBe(200); // per token
  });

  it('never sets cookies, even when a stale session cookie is sent', async () => {
    const res = await get('/api/v1/status', both, { cookie: `${SESSION_COOKIE}=stale-session-token` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    const unauth = await get('/api/v1/status', null, { cookie: `${SESSION_COOKIE}=stale-session-token` });
    expect(unauth.headers['set-cookie']).toBeUndefined();
  });

  it('CORS: any origin may read with a token; preflight allowed', async () => {
    const res = await get('/api/v1/status', both, { origin: 'https://overlay.example' });
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    const pre = await t.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/events',
      headers: {
        origin: 'https://overlay.example',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,last-event-id',
        'access-control-request-private-network': 'true',
      },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-headers']).toMatch(/Authorization/);
    expect(pre.headers['access-control-allow-headers']).toMatch(/Last-Event-ID/);
    expect(pre.headers['access-control-allow-private-network']).toBe('true');
  });

  it('unknown /api/v1 paths and methods are problem+json 404s', async () => {
    expectProblem(await get('/api/v1/nope', both), 404, 'not_found');
    expectProblem(await t.app.inject({ method: 'POST', url: '/api/v1/status', headers: { authorization: `Bearer ${both}` } }), 404, 'not_found');
    // Outside /api/v1 the app's own 404 is unchanged.
    expect((await get('/api/nope')).json()).toEqual({ error: 'Not found', code: 'not_found' });
  });
});

describe('GET /openapi.json', () => {
  it('is served without auth as an OpenAPI 3.1 document', async () => {
    const res = await get('/api/v1/openapi.json');
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual([
      '/',
      '/openapi.json',
      '/status',
      '/music',
      '/clock',
      '/chat',
      '/events',
      '/events/poll',
      '/profiles',
      '/profiles/{id}',
      '/profiles/{id}/ingest',
      '/profiles/{id}/overlays',
      '/profiles/{id}/obs',
      '/profiles/{id}/previews/{feed}',
      '/obs/socket',
      '/apps',
      '/apps/{appId}',
      '/apps/{appId}/heartbeat',
      '/apps/{appId}/events',
      '/apps/{appId}/obs-websocket',
      '/messages',
      '/connect/claim',
      '/pairing',
      '/pairing/{pairingId}/token',
    ]);
    expect(doc.components.securitySchemes.bearer).toMatchObject({ type: 'http', scheme: 'bearer' });
    // Every $ref resolves.
    const refs = JSON.stringify(doc).match(/#\/components\/schemas\/\w+/g) ?? [];
    for (const r of refs) expect(doc.components.schemas[r.split('/').at(-1)!], r).toBeDefined();
  });
});

describe('GET /status', () => {
  it('returns the documented status object', async () => {
    const d = t.repos.destinations.create({ profileId: DEFAULT_PROFILE_ID, platform: 'twitch', accountId: null, name: 'Twitch', feed: 'landscape', enabled: true, options: {}, ingestUrl: null });
    t.state.current = session({ destinations: [dstate(d.id, 'error', { message: 'Stream key rejected' })] });
    const res = await get('/api/v1/status', both);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(Object.keys(body)).toEqual(['session', 'feeds', 'destinations', 'platforms']);
    expect(body.destinations[0]).toMatchObject({ id: d.id, name: 'Twitch', phase: 'error', down: true, message: 'Stream key rejected' });
    expect(body.platforms[0]).toMatchObject({ platform: 'twitch', error: 'Stream key rejected' });
  });
});

describe('GET /clock', () => {
  it('returns the shared timecode clock with the NTP-style timestamps', async () => {
    t.state.current = session({ status: 'live', startedAt: new Date(Date.now() - 65_000).toISOString() });
    const t0 = Date.now();
    const res = await get(`/api/v1/clock?t0=${t0}`, both);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body).toMatchObject({ t0, profileId: DEFAULT_PROFILE_ID, session: { status: 'live' }, fps: 30 });
    expect(body.receivedAt).toBeGreaterThanOrEqual(t0);
    expect(body.sentAt).toBeGreaterThanOrEqual(body.receivedAt);
    expect(body.session.elapsedMs).toBeGreaterThanOrEqual(65_000);
    expect(body.timecode.run).toMatch(/^00:01:0\d:\d{2}$/);
    expect(body.timecode.utc).toMatch(/^\d{2}:\d{2}:\d{2}:\d{2}$/);
  });

  it('needs status:read and a valid t0', async () => {
    expectProblem(await get('/api/v1/clock?t0=soon', both), 400, 'invalid');
    expectProblem(await get('/api/v1/clock', t.token(['chat:read'])), 403, 'missing_scope');
  });
});

describe('GET /chat', () => {
  it('returns chat envelopes oldest first with limit + after paging', async () => {
    for (let i = 1; i <= 5; i++) t.bus.emit('chat', chat(i));
    const all = await get('/api/v1/chat', both);
    expect(all.statusCode).toBe(200);
    const body = all.json();
    expect(body.items.map((e: { data: { id: string } }) => e.data.id)).toEqual(['twitch:1', 'twitch:2', 'twitch:3', 'twitch:4', 'twitch:5']);
    expect(body.items[0]).toMatchObject({ type: 'chat.message', src: { connector: 'ctd-multi-stream', connection: 'd1', platform: 'twitch' } });
    expect(body.next).toBe(body.items[4].id);

    const two = (await get('/api/v1/chat?limit=2', both)).json();
    expect(two.items.map((e: { data: { id: string } }) => e.data.id)).toEqual(['twitch:4', 'twitch:5']);

    const after = (await get(`/api/v1/chat?after=${body.items[2].id}`, both)).json();
    expect(after.items.map((e: { data: { id: string } }) => e.data.id)).toEqual(['twitch:4', 'twitch:5']);
    const nothing = (await get(`/api/v1/chat?after=${body.next.toLowerCase()}`, both)).json();
    expect(nothing).toEqual({ items: [], next: body.next });

    // Moderation is applied.
    t.bus.emit('chat-moderation', { kind: 'message-deleted', platform: 'twitch', destinationId: 'd1', ts: '', messageId: 'twitch:2', platformMessageId: '2' });
    expect((await get('/api/v1/chat', both)).json().items).toHaveLength(4);
  });

  it.each(['0', '501', 'abc', '1.5', '-1'])('rejects limit=%s', async (limit) => {
    expectProblem(await get(`/api/v1/chat?limit=${limit}`, both), 400, 'invalid');
  });

  it('rejects a malformed after', async () => {
    expectProblem(await get('/api/v1/chat?after=nope', both), 400, 'invalid');
  });
});

describe('GET /events/poll', () => {
  it('without after: only the current cursor; then the events after it', async () => {
    const start = (await get('/api/v1/events/poll', both)).json();
    expect(start).toEqual({ items: [], next: expect.stringMatching(/^[0-7][0-9A-Z]{25}$/), reset: false });

    t.bus.emit('notice', { level: 'warn', message: 'one' });
    t.bus.emit('chat', chat(1));
    const page = (await get(`/api/v1/events/poll?after=${start.next}`, both)).json();
    expect(page.items.map((e: { type: string }) => e.type)).toEqual(['system.notice', 'chat.message']);
    expect(page.next).toBe(page.items[1].id);
    expect(page.reset).toBe(false);

    const again = (await get(`/api/v1/events/poll?after=${page.next}`, both)).json();
    expect(again).toEqual({ items: [], next: page.next, reset: false });
  });

  it('filters by types and scopes, advancing past filtered-out events', async () => {
    const statusOnly = t.token(['status:read']);
    const start = (await get('/api/v1/events/poll', statusOnly)).json();
    t.bus.emit('chat', chat(1));
    t.bus.emit('notice', { level: 'info', message: 'x' });
    t.bus.emit('chat', chat(2));
    const page = (await get(`/api/v1/events/poll?after=${start.next}`, statusOnly)).json();
    expect(page.items.map((e: { type: string }) => e.type)).toEqual(['system.notice']); // no chat scope
    const chatOnly = (await get(`/api/v1/events/poll?after=${start.next}&types=chat.*`, both)).json();
    expect(chatOnly.items.map((e: { type: string }) => e.type)).toEqual(['chat.message', 'chat.message']);
    const none = (await get(`/api/v1/events/poll?after=${start.next}&types=destination.down`, both)).json();
    expect(none.items).toEqual([]);
    expect(none.next).toBe(chatOnly.next); // newest scanned id
  });

  it('reset: true when after is older than the buffer', async () => {
    const res = (await get('/api/v1/events/poll?after=00000000000000000000000000', both)).json();
    expect(res).toEqual({ items: [], next: expect.any(String), reset: true });
    expectProblem(await get('/api/v1/events/poll?after=zzz', both), 400, 'invalid');
  });

  it('next is the last scanned envelope, even when the filter skipped it', async () => {
    const statusOnly = t.token(['status:read']);
    const start = (await get('/api/v1/events/poll', statusOnly)).json();
    t.bus.emit('notice', { level: 'info', message: 'x' });
    t.bus.emit('chat', chat(1));
    t.bus.emit('chat', chat(2));
    const page = (await get(`/api/v1/events/poll?after=${start.next}`, statusOnly)).json();
    expect(page.items.map((e: { type: string }) => e.type)).toEqual(['system.notice']);
    expect(page.next).toBe(t.hub.cursor()); // past the two chat messages it can't see
    expect((await get(`/api/v1/events/poll?after=${page.next}`, statusOnly)).json()).toEqual({ items: [], next: page.next, reset: false });
  });

  it('a filtered poll is not reset by evicted events it would not receive', async () => {
    t.bus.emit('chat', chat(1));
    const afterChat = t.hub.cursor();
    for (let i = 0; i < 2100; i++) t.bus.emit('notice', { level: 'info', message: `n${i}` });
    const chatPoll = (await get(`/api/v1/events/poll?after=${afterChat}&types=chat.*`, both)).json();
    expect(chatPoll).toEqual({ items: [], next: t.hub.cursor(), reset: false });
    const chatToken = (await get(`/api/v1/events/poll?after=${afterChat}`, t.token(['chat:read']))).json();
    expect(chatToken.reset).toBe(false);
    expect((await get(`/api/v1/events/poll?after=${afterChat}`, both)).json().reset).toBe(true);
  });

  it('a cursor from a run with a later clock resets the poll; /chat ignores it', async () => {
    t.bus.emit('chat', chat(1));
    const future = '7ZZZZZZZZZZZZZZZZZZZZZZZZZ';
    expect((await get(`/api/v1/events/poll?after=${future}`, both)).json()).toEqual({ items: [], next: t.hub.cursor(), reset: true });
    const chatRes = (await get(`/api/v1/chat?after=${future}`, both)).json();
    expect(chatRes.items.map((e: { data: { id: string } }) => e.data.id)).toEqual(['twitch:1']);
  });
});

describe('alert.*', () => {
  it('chat:read tokens get alert envelopes after the chat line; status-only tokens never do', async () => {
    const chatOnly = t.token(['chat:read']);
    const statusOnly = t.token(['status:read']);
    const start = (await get('/api/v1/events/poll', both)).json();
    t.bus.emit('chat', {
      ...chat(7),
      kind: 'event',
      text: 'viewer7 sent a $5.00 Super Chat',
      platform: 'youtube',
      id: 'youtube:7',
      alert: { kind: 'superchat', user: { id: 'UC7', name: 'viewer7' }, amount: { unit: 'currency', value: '5.00', currency: 'USD' }, message: { text: 'gg' } },
    });

    const page = (await get(`/api/v1/events/poll?after=${start.next}`, chatOnly)).json();
    expect(page.items.map((e: { type: string }) => e.type)).toEqual(['chat.message', 'alert.superchat']);
    expect(page.items[1]).toMatchObject({
      type: 'alert.superchat',
      src: { connector: 'ctd-multi-stream', connection: 'd1', platform: 'youtube' },
      data: {
        kind: 'superchat',
        user: { id: 'youtube:UC7', name: 'viewer7' },
        amount: { unit: 'currency', value: '5.00', currency: 'USD' },
        message: { text: 'gg' },
        platform: 'youtube',
        destinationId: 'd1',
        messageId: 'youtube:7',
      },
    });

    const alertsOnly = (await get(`/api/v1/events/poll?after=${start.next}&types=alert.*`, both)).json();
    expect(alertsOnly.items.map((e: { type: string }) => e.type)).toEqual(['alert.superchat']);
    const status = (await get(`/api/v1/events/poll?after=${start.next}`, statusOnly)).json();
    expect(status.items).toEqual([]);
    expectProblem(await get('/api/v1/events/poll?types=alert.*', statusOnly), 403, 'missing_scope');
  });

  it('the OpenAPI document lists the alert event types and the Alert schema', async () => {
    const doc = (await get('/api/v1/openapi.json')).json();
    expect(doc.components.schemas.Envelope.properties.type.enum).toEqual(expect.arrayContaining(['alert.superchat', 'alert.subscription', 'alert.tip']));
    expect(doc.components.schemas.Alert.properties.kind.enum).toHaveLength(9);
    expect(doc.info.version).toMatch(/^1\.8 /);
  });
});

describe('GET /status (test mode, viewers)', () => {
  it('reports session.testMode, per-destination viewers and the per-platform sum of known counts', async () => {
    const a = t.repos.destinations.create({ profileId: DEFAULT_PROFILE_ID, platform: 'twitch', accountId: null, name: 'Twitch A', feed: 'landscape', enabled: true, options: {}, ingestUrl: null });
    const b = t.repos.destinations.create({ profileId: DEFAULT_PROFILE_ID, platform: 'twitch', accountId: null, name: 'Twitch B', feed: 'landscape', enabled: true, options: {}, ingestUrl: null });
    const k = t.repos.destinations.create({ profileId: DEFAULT_PROFILE_ID, platform: 'kick', accountId: null, name: 'Kick', feed: 'landscape', enabled: true, options: {}, ingestUrl: null });
    t.state.current = session({
      testMode: true,
      destinations: [
        dstate(a.id, 'live', { viewers: 3 }),
        dstate(b.id, 'live', { viewers: null }),
        dstate(k.id, 'disabled', { message: 'Skipped — Kick has no test mode' }),
      ],
    });
    const body = (await get('/api/v1/status', both)).json();
    expect(body.session.testMode).toBe(true);
    expect(body.destinations.map((d: { viewers: number | null }) => d.viewers)).toEqual([3, null, null]);
    expect(body.destinations[2]).toMatchObject({ phase: 'disabled', down: false, message: 'Skipped — Kick has no test mode' });
    expect(body.platforms).toEqual([
      expect.objectContaining({ platform: 'twitch', viewers: 3 }),
      expect.objectContaining({ platform: 'kick', viewers: null, live: false, error: null }),
    ]);
  });
});

describe('chat.message.deleted', () => {
  it('always carries a messageId, derived for messages the server never saw', async () => {
    const start = (await get('/api/v1/events/poll', both)).json();
    t.bus.emit('chat-moderation', { kind: 'message-deleted', platform: 'twitch', destinationId: 'd1', ts: '', messageId: null, platformMessageId: 'abc' });
    const page = (await get(`/api/v1/events/poll?after=${start.next}`, both)).json();
    expect(page.items[0]).toMatchObject({
      type: 'chat.message.deleted',
      data: { messageId: 'twitch:abc', platformMessageId: 'abc', platform: 'twitch', destinationId: 'd1' },
    });
  });
});
