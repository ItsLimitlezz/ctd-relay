import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../../../shared/types.js';
import { bindGuestFeeds } from '../../api/guest-feeds.js';
import { openDatabase } from '../../db/database.js';
import { createGuestFeedsRepo } from '../../db/guest-feeds-repo.js';
import { createRepos } from '../../db/repos.js';
import { EventBus } from '../../events.js';
import { DEFAULT_GUEST_LIMITS, GuestFeeds } from '../../media/guest-feeds.js';
import { createSecretBox } from '../../security/secretbox.js';
import type { AppServices } from '../../services.js';
import guestFeedRoutes from './guest-feeds.js';

const admin: User = { id: 'u1', username: 'admin', role: 'admin', totpEnabled: false, createdAt: '', lastLoginAt: null };
const viewer: User = { ...admin, id: 'u2', username: 'crew', role: 'operator' };

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function build(user: User | null = admin) {
  const db = openDatabase(':memory:');
  const repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
  const guests = new GuestFeeds({ repo: createGuestFeedsRepo(db), secrets: repos.secrets, bus: new EventBus(), log: pino({ level: 'silent' }), limits: { ...DEFAULT_GUEST_LIMITS, maxSlots: 2 } });
  const kicked: string[] = [];
  guests.attachMedia({ kick: async (p) => (kicked.push(p), true) });
  const auditLog = vi.fn();
  const services = {
    config: { rtmpPort: 1935, ffmpegBin: 'ffmpeg' },
    log: pino({ level: 'silent' }),
    media: {},
    repos: { ...repos, audit: { log: auditLog } },
    appSettings: () => ({ publicBaseUrl: '', ingestHost: 'relay.example', disconnectGraceSec: 15 }),
  } as unknown as AppServices;
  bindGuestFeeds(services, guests);
  app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('authSession', null);
  app.addHook('onRequest', async (req) => {
    req.user = user;
  });
  await app.register(guestFeedRoutes, { services });
  return { app, guests, auditLog, kicked };
}

const B = '/api/profiles/default/guest-feeds';

describe('guest feed routes (web UI)', () => {
  it('admin: add (201 with ingest details), list, rename, rotate, revoke, remove', async () => {
    const { app, auditLog, kicked } = await build();
    const created = await app.inject({ method: 'POST', url: B, payload: { name: 'Remote cam 1' } });
    expect(created.statusCode, created.body).toBe(201);
    const { guestFeed, ingest } = created.json();
    expect(guestFeed).toMatchObject({ name: 'Remote cam 1', key: 'active', online: false });
    expect(ingest).toMatchObject({ profileId: 'default', slot: guestFeed.slot, serverUrl: 'rtmp://relay.example:1935/guest' });
    expect(ingest.streamKey).toMatch(new RegExp(`^${guestFeed.slot}\\?key=[A-Za-z0-9_-]{24}$`));
    expect(ingest.fullUrl).toBe(`rtmp://relay.example:1935/guest/${ingest.streamKey}`);
    expect(created.headers['cache-control']).toBe('no-store');

    const list = (await app.inject({ method: 'GET', url: B })).json();
    expect(list.guestFeeds.map((g: { name: string }) => g.name)).toEqual(['Remote cam 1']);
    expect(JSON.stringify(list)).not.toContain(ingest.streamKey);

    const renamed = await app.inject({ method: 'PATCH', url: `${B}/${guestFeed.slot}`, payload: { name: 'Cam A' } });
    expect(renamed.json().name).toBe('Cam A');

    const rotated = await app.inject({ method: 'POST', url: `${B}/${guestFeed.slot}/rotate` });
    expect(rotated.json().streamKey).not.toBe(ingest.streamKey);
    expect((await app.inject({ method: 'GET', url: `${B}/${guestFeed.slot}/ingest` })).json().streamKey).toBe(rotated.json().streamKey);

    const revoked = await app.inject({ method: 'POST', url: `${B}/${guestFeed.slot}/revoke` });
    expect(revoked.json().key).toBe('revoked');
    expect((await app.inject({ method: 'GET', url: `${B}/${guestFeed.slot}/ingest` })).json()).toMatchObject({ streamKey: null, fullUrl: null });

    expect((await app.inject({ method: 'DELETE', url: `${B}/${guestFeed.slot}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: B })).json().guestFeeds).toEqual([]);
    expect(kicked).toHaveLength(3); // rotate, revoke, remove

    const actions = auditLog.mock.calls.map((c) => c[0].action);
    expect(actions).toEqual(['guest.create', 'guest.rename', 'guest.rotate', 'guest.revoke', 'guest.delete']);
    // Never a key in the audit log.
    for (const c of auditLog.mock.calls) {
      expect(String(c[0].detail)).not.toMatch(/key=/);
      expect(String(c[0].detail)).not.toContain(rotated.json().streamKey.split('key=')[1]);
    }
  });

  it('limits and validation: the slot cap (409 limit), bad names (400), unknown slots and profiles (404)', async () => {
    const { app } = await build();
    await app.inject({ method: 'POST', url: B, payload: { name: 'A' } });
    await app.inject({ method: 'POST', url: B, payload: { name: 'B' } });
    const full = await app.inject({ method: 'POST', url: B, payload: { name: 'C' } });
    expect([full.statusCode, full.json().code]).toEqual([409, 'limit']);
    const bad = await app.inject({ method: 'POST', url: B, payload: { name: '   ' } });
    expect([bad.statusCode, bad.json().code]).toEqual([400, 'invalid']);
    const tooLong = await app.inject({ method: 'POST', url: B, payload: { name: 'x'.repeat(61) } });
    expect(tooLong.statusCode).toBe(400);
    const unknown = await app.inject({ method: 'PATCH', url: `${B}/zzzzzzzzzz`, payload: { name: 'x' } });
    expect([unknown.statusCode, unknown.json().code]).toEqual([404, 'unknown_guest_feed']);
    const noProfile = await app.inject({ method: 'GET', url: '/api/profiles/nope/guest-feeds' });
    expect([noProfile.statusCode, noProfile.json().code]).toEqual([404, 'unknown_profile']);
  });

  it('an operator (not admin) can list and watch but not manage or see keys; signed out is 401', async () => {
    const setup = await build();
    const slot = (await setup.guests.create('default', 'A')).slot;
    await setup.app.close();
    app = null;
    // Same slot table would be in another db; check the role gates only.
    const v = await build(viewer);
    expect((await v.app.inject({ method: 'GET', url: B })).statusCode).toBe(200);
    expect((await v.app.inject({ method: 'POST', url: B, payload: { name: 'X' } })).statusCode).toBe(403);
    expect((await v.app.inject({ method: 'GET', url: `${B}/${slot}/ingest` })).statusCode).toBe(403);
    expect((await v.app.inject({ method: 'POST', url: `${B}/${slot}/rotate` })).statusCode).toBe(403);
    expect((await v.app.inject({ method: 'POST', url: `${B}/${slot}/revoke` })).statusCode).toBe(403);
    expect((await v.app.inject({ method: 'DELETE', url: `${B}/${slot}` })).statusCode).toBe(403);
    await v.app.close();
    app = null;
    const anon = await build(null);
    expect((await anon.app.inject({ method: 'GET', url: B })).statusCode).toBe(401);
    expect((await anon.app.inject({ method: 'GET', url: `${B}/${slot}/live.m3u8` })).statusCode).toBe(401);
  });

  it('watching: offline guest is 404 feed_offline; unknown slot 404 unknown_guest_feed', async () => {
    const { app, guests } = await build();
    const slot = (await guests.create('default', 'A')).slot;
    const off = await app.inject({ method: 'GET', url: `${B}/${slot}/preview.jpg` });
    expect([off.statusCode, off.json().code]).toEqual([404, 'feed_offline']);
    const unknown = await app.inject({ method: 'GET', url: `${B}/zzzzzzzzzz/live.m3u8` });
    expect([unknown.statusCode, unknown.json().code]).toEqual([404, 'unknown_guest_feed']);
  });
});
