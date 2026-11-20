// Stream report routes: /api/v1/reports (reports:read token) and /api/reports (web UI session).

import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '../../../shared/types.js';
import { openDatabase } from '../db/database.js';
import { sendError } from '../http/guards.js';
import reportRoutes from '../http/routes/reports.js';
import { createReportsService, setReportsFor, type ReportsService } from '../reports/index.js';
import type { AppServices } from '../services.js';
import { unzip } from '../reports/zip.js';
import { createTestApi, type TestApi } from './test-helpers.js';

let t: TestApi;
let reports: ReportsService;
const T0 = Date.parse('2026-11-19T20:00:00.000Z');
let now = T0;

/** One recorded stream on the default profile, one on a second profile. */
function record(profileId: string, sessionId: string, destId: string) {
  t.bus.emit('session', { profileId, status: 'live', sessionId, startedAt: new Date(now).toISOString(), title: `Stream ${sessionId}`, autoGoLive: true, feeds: [], destinations: [] });
  t.bus.emit('destination', { destinationId: destId, profileId, phase: 'live', message: null, stats: null, watchUrl: null, retries: 0, since: '', recoveries: 0, lastRecovery: null, viewers: 7 });
  t.bus.emit('chat', { id: `${sessionId}-1`, platform: 'twitch', destinationId: destId, profileId, author: { name: 'Viewer A', id: '11' }, text: 'hi', ts: '', kind: 'message' });
  now += 60_000;
  reports.recorder.tick();
  t.bus.emit('session', { profileId, status: 'offline', sessionId: null, startedAt: null, title: '', autoGoLive: true, feeds: [], destinations: [] });
}

beforeEach(async () => {
  now = T0;
  t = await createTestApi();
  reports = createReportsService({ ...t.services, log: pino({ level: 'silent' }) } as AppServices, openDatabase(':memory:'), { presence: null, now: () => now, timers: false });
  setReportsFor(t.services, reports);
  reports.start();
  const second = t.addProfile('Second');
  const d1 = t.repos.destinations.create({ profileId: 'default', platform: 'twitch', accountId: null, name: 'Twitch', feed: 'landscape', enabled: true, options: {}, ingestUrl: null });
  const d2 = t.repos.destinations.create({ profileId: second.id, platform: 'twitch', accountId: null, name: 'Twitch 2', feed: 'landscape', enabled: true, options: {}, ingestUrl: null });
  record('default', 'sess-a', d1.id);
  record(second.id, 'sess-b', d2.id);
});
afterEach(async () => {
  reports.close();
  await t.close();
});

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

describe('/api/v1/reports', () => {
  it('needs the reports:read scope', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/reports/sessions', headers: bearer(t.token(['status:read'])) });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('missing_scope');
    expect(t.routes).toEqual(expect.arrayContaining(['GET /api/v1/reports/sessions', 'GET /api/v1/reports/sessions/:id/export', 'GET /api/v1/reports/audience']));
  });

  it('lists every profile for an every-profile token, one profile for a limited one', async () => {
    const all = await t.app.inject({ method: 'GET', url: '/api/v1/reports/sessions', headers: bearer(t.token(['reports:read'])) });
    expect(all.json().sessions.map((s: { id: string }) => s.id).sort()).toEqual(['sess-a', 'sess-b']);
    const limited = t.token(['reports:read'], 'limited', 'default');
    const one = await t.app.inject({ method: 'GET', url: '/api/v1/reports/sessions', headers: bearer(limited) });
    expect(one.json().sessions.map((s: { id: string }) => s.id)).toEqual(['sess-a']);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/reports/sessions/sess-b', headers: bearer(limited) })).statusCode).toBe(404);
    const detail = await t.app.inject({ method: 'GET', url: '/api/v1/reports/sessions/sess-a', headers: bearer(limited) });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: 'sess-a', peakViewers: 7, chatMessages: 1 });
    expect(detail.json().leaderboards[0]).toMatchObject({ kind: 'chatters', rows: [{ id: 'twitch:11', messages: 1 }] });
  });

  it('exports .xlsx by default, and csv and json', async () => {
    const h = bearer(t.token(['reports:read']));
    const x = await t.app.inject({ method: 'GET', url: '/api/v1/reports/sessions/sess-a/export', headers: h });
    expect(x.statusCode).toBe(200);
    expect(x.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(x.headers['content-disposition']).toMatch(/^attachment; filename="ctd-relay-stream-2026-11-19-2000\.xlsx"$/);
    expect(unzip(x.rawPayload).has('xl/workbook.xml')).toBe(true);
    const c = await t.app.inject({ method: 'GET', url: '/api/v1/reports/sessions/sess-a/export?format=csv', headers: h });
    expect(c.headers['content-type']).toBe('application/zip');
    const j = await t.app.inject({ method: 'GET', url: '/api/v1/reports/sessions/sess-a/export?format=json', headers: h });
    expect(j.json().sessions[0].id).toBe('sess-a');
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/reports/sessions/sess-a/export?format=pdf', headers: h })).statusCode).toBe(400);
    const range = await t.app.inject({ method: 'GET', url: '/api/v1/reports/export?from=2026-11-19&to=2026-11-19&format=json', headers: h });
    expect(range.statusCode).toBe(200);
    expect(range.json().sessions.map((s: { id: string }) => s.id)).toEqual(['sess-a', 'sess-b']);
    expect(range.json().rangeStats.at(-1)).toMatchObject({ platform: 'total', chatMessages: 2, uniqueChatters: 1 });
  });

  it('leaderboards, user detail and bad input', async () => {
    const h = bearer(t.token(['reports:read']));
    const loyal = await t.app.inject({ method: 'GET', url: '/api/v1/reports/audience?board=loyal', headers: h });
    expect(loyal.json().rows[0]).toMatchObject({ id: 'twitch:11', streams: 2 });
    const user = await t.app.inject({ method: 'GET', url: `/api/v1/reports/audience/users/${encodeURIComponent('twitch:11')}`, headers: h });
    expect(user.json().totals).toMatchObject({ messages: 2, streams: 2, watchSec: null });
    for (const q of ['board=best', 'from=yesterday', 'platform=myspace', 'limit=0', 'from=2026-11-20&to=2026-11-19']) {
      expect((await t.app.inject({ method: 'GET', url: `/api/v1/reports/audience?${q}`, headers: h })).statusCode, q).toBe(400);
    }
  });
});

describe('/api/reports (web UI)', () => {
  let app: FastifyInstance;
  const as = (role: Role | null) => (role ? { 'x-test-role': role } : {});

  beforeEach(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => {
      const e = err as { statusCode?: number; message?: string; name?: string };
      // Like app.ts: a body that fails its zod schema is a 400.
      return sendError(reply, e.name === 'ZodError' ? 400 : (e.statusCode ?? 500), e.message ?? 'error');
    });
    app.decorateRequest('user', null);
    app.decorateRequest('authSession', null);
    app.addHook('onRequest', async (req) => {
      const role = req.headers['x-test-role'];
      req.user = role === 'admin' || role === 'operator' ? { id: `user-${role}`, username: `the-${role}`, role, totpEnabled: false, createdAt: '', lastLoginAt: null } : null;
    });
    await app.register(reportRoutes, { services: t.services });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it('reading needs a signed-in user; the default profile unless ?profile=*', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/reports/sessions' })).statusCode).toBe(401);
    const mine = await app.inject({ method: 'GET', url: '/api/reports/sessions', headers: as('operator') });
    expect(mine.json().sessions.map((s: { id: string }) => s.id)).toEqual(['sess-a']);
    const all = await app.inject({ method: 'GET', url: '/api/reports/sessions?profile=*', headers: as('operator') });
    expect(all.json().sessions).toHaveLength(2);
  });

  it('settings and forget-user are admin only and audited without the name', async () => {
    const body = { recording: true, audience: false, retentionDays: 90 };
    expect((await app.inject({ method: 'PUT', url: '/api/reports/settings', headers: as('operator'), payload: body })).statusCode).toBe(403);
    const put = await app.inject({ method: 'PUT', url: '/api/reports/settings', headers: as('admin'), payload: body });
    expect(put.json().settings).toEqual(body);
    expect((await app.inject({ method: 'PUT', url: '/api/reports/settings', headers: as('admin'), payload: { ...body, retentionDays: 30 } })).statusCode).toBe(400);
    const url = `/api/reports/audience/users/${encodeURIComponent('twitch:11')}`;
    expect((await app.inject({ method: 'DELETE', url, headers: as('operator') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url, headers: as('admin') })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `${url}?profile=*`, headers: as('admin') })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url, headers: as('admin') })).statusCode).toBe(404);
    const entries = t.repos.audit.list({ limit: 10 }).map((e) => `${e.action}: ${e.detail}`);
    expect(entries).toEqual(expect.arrayContaining(['reports.forget_user: a twitch viewer', 'reports.settings: audience=false, retentionDays=90']));
    expect(entries.join(' ')).not.toContain('Viewer A');
  });
});
