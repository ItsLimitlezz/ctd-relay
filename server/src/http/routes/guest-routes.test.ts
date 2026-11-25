import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../../../shared/types.js';
import { bindGuestFeeds } from '../../api/guest-feeds.js';
import { openDatabase } from '../../db/database.js';
import { createGuestFeedsRepo } from '../../db/guest-feeds-repo.js';
import { createGuestRoutesRepo } from '../../db/guest-routes-repo.js';
import { createRepos } from '../../db/repos.js';
import { EventBus } from '../../events.js';
import { DEFAULT_GUEST_LIMITS, GuestFeeds } from '../../media/guest-feeds.js';
import { bindGuestRoutes, GuestRoutes } from '../../media/guest-routes.js';
import { fakeSpawn } from '../../media/test-helpers.js';
import { createSecretBox } from '../../security/secretbox.js';
import type { AppServices, MediaServer } from '../../services.js';
import guestRouteRoutes from './guest-routes.js';

const KEY = 'live_sk_WEBKEY000000000000qq';
const admin: User = { id: 'u1', username: 'admin', role: 'admin', totpEnabled: false, createdAt: '', lastLoginAt: null };
const operator: User = { ...admin, id: 'u2', username: 'crew', role: 'operator' };

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function build(initial: User | null) {
  const who = { user: initial };
  const db = openDatabase(':memory:');
  const repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
  const bus = new EventBus();
  const log = pino({ level: 'silent' });
  const guests = new GuestFeeds({ repo: createGuestFeedsRepo(db), secrets: repos.secrets, bus, log, limits: DEFAULT_GUEST_LIMITS });
  const routes = new GuestRoutes({
    config: { rtmpPort: 1935, ffmpegBin: 'ffmpeg' },
    repo: createGuestRoutesRepo(db),
    guests,
    secrets: repos.secrets,
    settings: repos.settings,
    profiles: repos.profiles,
    bus,
    log,
    lookup: async () => ['203.0.113.9'],
    localAddresses: () => ['127.0.0.1'],
    supervisorDeps: { spawn: fakeSpawn().spawn },
  });
  routes.attachMedia({ guestReadUrl: () => 'rtmp://127.0.0.1:1935/guest/x', feed: () => ({ online: false }) } as unknown as MediaServer);
  const auditLog = vi.fn();
  const services = { config: { rtmpPort: 1935 }, log, repos: { ...repos, audit: { log: auditLog } } } as unknown as AppServices;
  bindGuestFeeds(services, guests);
  bindGuestRoutes(services, routes);
  app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    req.user = who.user;
  });
  await app.register(guestRouteRoutes, { services });
  const g = await guests.create('default', 'Cam');
  return { app, auditLog, who, base: `/api/profiles/default/guest-feeds/${g.slot}/routes` };
}

describe('guest route routes (web UI)', () => {
  it('admin adds, edits, starts and removes routes; the key is never returned or audited', async () => {
    const { app, auditLog, base } = await build(admin);
    const res = await app.inject({ method: 'POST', url: base, payload: { kind: 'rtmp', url: 'rtmps://live.example.com/app', streamKey: KEY } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.body).not.toContain(KEY);
    const route = res.json();
    expect(route.target).toMatchObject({ kind: 'rtmp', url: 'rtmps://live.example.com/app', hasKey: true });
    const bad = await app.inject({ method: 'POST', url: base, payload: { kind: 'rtmp', url: 'pipe:1' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('invalid_target');
    const start = await app.inject({ method: 'POST', url: `${base}/${route.id}/start` });
    expect(start.statusCode).toBe(409);
    expect(start.json().code).toBe('feed_offline');
    expect((await app.inject({ method: 'PATCH', url: `${base}/${route.id}`, payload: { auto: true } })).json().auto).toBe(true);
    const list = await app.inject({ method: 'GET', url: base });
    expect(list.json().routes).toHaveLength(1);
    expect(list.body).not.toContain(KEY);
    expect((await app.inject({ method: 'PUT', url: '/api/guest-routes/settings', payload: { allowLan: false } })).json()).toEqual({ allowLan: false });
    expect((await app.inject({ method: 'DELETE', url: `${base}/${route.id}` })).statusCode).toBe(204);
    expect(auditLog.mock.calls.map((c) => c[0].action)).toEqual(['guest.route.create', 'guest.route.update', 'guest.route.settings', 'guest.route.delete']);
    expect(JSON.stringify(auditLog.mock.calls)).not.toContain(KEY);
  });

  it('operators read state (without custom server paths) but cannot manage; signed out gets 401', async () => {
    const { app, who, base } = await build(admin);
    await app.inject({ method: 'POST', url: base, payload: { kind: 'rtmp', url: 'rtmp://live.example.com/secretpath', streamKey: KEY } });
    who.user = operator;
    expect((await app.inject({ method: 'POST', url: base, payload: { kind: 'rtmp', url: 'rtmp://live.example.com/app' } })).statusCode).toBe(403);
    const list = await app.inject({ method: 'GET', url: base });
    expect(list.statusCode).toBe(200);
    expect(list.json().routes[0].target).toEqual({ kind: 'rtmp', host: 'rtmp://live.example.com', hasKey: true });
    expect(list.body).not.toContain('secretpath');
    expect(list.body).not.toContain(KEY);
    expect((await app.inject({ method: 'GET', url: '/api/guest-routes/settings' })).statusCode).toBe(403);
    who.user = null;
    expect((await app.inject({ method: 'GET', url: base })).statusCode).toBe(401);
  });
});
