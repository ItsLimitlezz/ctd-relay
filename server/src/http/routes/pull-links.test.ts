// Web UI pull link routes (docs/GUEST-FEEDS.md → Pull link): admins manage and see the link;
// operators see on/off and readers only; the key is never audited.

import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../../../shared/types.js';
import { bindGuestFeeds } from '../../api/guest-feeds.js';
import { bindPullLinks } from '../../api/pull-links.js';
import { openDatabase } from '../../db/database.js';
import { createGuestFeedsRepo } from '../../db/guest-feeds-repo.js';
import { createRepos } from '../../db/repos.js';
import { EventBus } from '../../events.js';
import { DEFAULT_GUEST_LIMITS, GuestFeeds } from '../../media/guest-feeds.js';
import { PullLinks } from '../../media/pull-links.js';
import { createSecretBox } from '../../security/secretbox.js';
import type { AppServices } from '../../services.js';
import pullLinkRoutes from './pull-links.js';

const admin: User = { id: 'u1', username: 'admin', role: 'admin', totpEnabled: false, createdAt: '', lastLoginAt: null };
const operator: User = { ...admin, id: 'u2', username: 'crew', role: 'operator' };

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function build() {
  const who: { user: User | null } = { user: admin };
  const db = openDatabase(':memory:');
  const repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
  const log = pino({ level: 'silent' });
  const guests = new GuestFeeds({ repo: createGuestFeedsRepo(db), secrets: repos.secrets, bus: new EventBus(), log, limits: DEFAULT_GUEST_LIMITS });
  const pull = new PullLinks({ secrets: repos.secrets, log, maxReaders: 2, guestProfileOf: (s) => guests.profileOf(s), slugOf: () => null, profileOfSlug: () => 'default' });
  await pull.load();
  const auditLog = vi.fn();
  const services = {
    config: { rtmpPort: 1935 },
    log,
    repos: { ...repos, audit: { log: auditLog } },
    appSettings: () => ({ ingestHost: 'relay.example.com' }),
  } as unknown as AppServices;
  bindGuestFeeds(services, guests);
  bindPullLinks(services, pull);
  app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    req.user = who.user;
  });
  await app.register(pullLinkRoutes, { services });
  const g = await guests.create('default', 'Cam');
  return { app, who, auditLog, slot: g.slot, base: `/api/profiles/default/guest-feeds/${g.slot}/pull` };
}

describe('pull link routes (web UI)', () => {
  it('admin turns it on, rotates and turns it off; the key is never audited', async () => {
    const { app, auditLog, base } = await build();
    const on = await app.inject({ method: 'PUT', url: base, payload: { enabled: true } });
    expect(on.statusCode, on.body).toBe(200);
    const url: string = on.json().url;
    expect(url).toMatch(/^rtmp:\/\/relay\.example\.com:1935\/guest\/[a-z0-9]{10}\?key=[A-Za-z0-9_-]{24}$/);
    const rotated = await app.inject({ method: 'POST', url: `${base}/rotate` });
    expect(rotated.json().url).not.toBe(url);
    expect((await app.inject({ method: 'PUT', url: base, payload: { enabled: false } })).json()).toMatchObject({ enabled: false, url: null });
    expect((await app.inject({ method: 'DELETE', url: base })).statusCode).toBe(204);
    expect(auditLog.mock.calls.map((c) => c[0].action)).toEqual(['pull.enable', 'pull.rotate', 'pull.disable', 'pull.revoke']);
    expect(JSON.stringify(auditLog.mock.calls)).not.toContain(url.split('key=')[1]);
    expect((await app.inject({ method: 'PUT', url: '/api/profiles/default/feeds/landscape/pull', payload: { enabled: true } })).json().url).toMatch(/\/live\/landscape\?key=/);
    expect((await app.inject({ method: 'GET', url: '/api/profiles/default/guest-feeds/aaaaaaaaaa/pull' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/profiles/nope/pull-links' })).statusCode).toBe(404);
  });

  it('operators see state without the key and cannot manage; signed out gets 401', async () => {
    const { app, who, base, slot } = await build();
    const key = (await app.inject({ method: 'PUT', url: base, payload: { enabled: true } })).json().url.split('key=')[1];
    who.user = operator;
    const state = await app.inject({ method: 'GET', url: '/api/profiles/default/pull-links' });
    expect(state.statusCode).toBe(200);
    expect(state.json().guestFeeds[slot]).toEqual({ enabled: true, readers: 0, maxReaders: 2 });
    expect(state.body).not.toContain(key);
    expect((await app.inject({ method: 'GET', url: base })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: base, payload: { enabled: false } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `${base}/rotate` })).statusCode).toBe(403);
    who.user = null;
    expect((await app.inject({ method: 'GET', url: '/api/profiles/default/pull-links' })).statusCode).toBe(401);
  });
});
