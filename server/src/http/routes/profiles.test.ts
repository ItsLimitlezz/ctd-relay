import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import type { ProfilesResponse } from '../../../../shared/api.js';
import type { Profile, ProfileSummary, SessionStatus, User } from '../../../../shared/types.js';
import { openDatabase, type Db } from '../../db/database.js';
import { createRepos } from '../../db/repos.js';
import { EventBus } from '../../events.js';
import { createSecretBox } from '../../security/secretbox.js';
import type { AppServices, Orchestrator, Repos } from '../../services.js';
import profileRoutes from './profiles.js';

const admin: User = { id: 'u1', username: 'admin', role: 'admin', totpEnabled: false, createdAt: '', lastLoginAt: null };
const operator: User = { ...admin, id: 'u2', username: 'op', role: 'operator' };

let app: FastifyInstance | null = null;
let db: Db | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  db?.close();
  db = null;
});

/** Fake orchestrator registry: one status per profile id. */
function fakeOrchestrators(repos: Repos) {
  const status = new Map<string, SessionStatus>([['default', 'offline']]);
  const calls: string[] = [];
  const registry = {
    get: vi.fn((id: string): Orchestrator => {
      if (!status.has(id)) throw Object.assign(new Error('Profile not found'), { statusCode: 404, code: 'unknown_profile' });
      return { profileId: id, state: () => ({ profileId: id, status: status.get(id)! }) } as unknown as Orchestrator;
    }),
    add: vi.fn(async (p: Profile) => {
      calls.push(`orchestrators.add ${p.id}`);
      status.set(p.id, 'offline');
    }),
    remove: vi.fn(async (id: string) => {
      calls.push(`orchestrators.remove ${id}`);
      status.delete(id);
    }),
    summaries: vi.fn((): ProfileSummary[] =>
      repos.profiles.list().map((p) => ({ ...p, status: status.get(p.id) ?? 'offline', startedAt: null, testMode: false, destinations: 0, live: 0, down: 0 })),
    ),
  };
  return { registry, status, calls };
}

async function build(opts: { user?: User | null } = {}) {
  db = openDatabase(':memory:');
  const repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
  const bus = new EventBus();
  const events: string[] = [];
  bus.on('profiles-changed', () => events.push('profiles-changed'));
  bus.on('destinations-changed', (...a) => events.push(`destinations-changed ${JSON.stringify(a)}`));
  bus.on('apps-changed', () => events.push('apps-changed'));
  const orch = fakeOrchestrators(repos);
  const calls = orch.calls;
  const media = {
    profileAdded: vi.fn(async (p: Profile) => {
      calls.push(`media.profileAdded ${p.id}`);
    }),
    profileRemoved: vi.fn(async (id: string) => {
      calls.push(`media.profileRemoved ${id}`);
    }),
  };
  const browser = {
    close: vi.fn(async (id: string) => {
      calls.push(`browser.close ${id}`);
    }),
    clear: vi.fn(async (id: string) => {
      calls.push(`browser.clear ${id}`);
    }),
  };
  const apps = {
    removeByToken: vi.fn((tokenId: string) => {
      calls.push(`apps.removeByToken ${tokenId}`);
    }),
  };
  const services = { repos, bus, media, browser, apps, orchestrators: orch.registry } as unknown as AppServices;

  const user = opts.user === undefined ? admin : opts.user;
  app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('authSession', null);
  app.addHook('onRequest', async (req) => {
    req.user = user;
  });
  // Same mapping as app.ts: ZodError -> 400 invalid; errors with statusCode + code keep them.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: err.issues.map((i) => i.message).join('; '), code: 'invalid' });
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message, code: e.code });
    return reply.code(500).send({ error: 'Internal error' });
  });
  await app.register(profileRoutes, { services });
  const audits = () => repos.audit.list({ limit: 100 });
  return { app, repos, bus, events, media, browser, apps, orch, calls, audits };
}

describe('GET /api/profiles', () => {
  it('lists every profile with its live situation, for any user', async () => {
    const { app, orch, repos } = await build({ user: operator });
    repos.profiles.create({ name: 'DPRTMNT', color: '#E11D48' });
    const res = await app.inject({ method: 'GET', url: '/api/profiles' });
    expect(res.statusCode).toBe(200);
    const body = res.json<ProfilesResponse>();
    expect(body.profiles.map((p) => [p.name, p.slug, p.status])).toEqual([
      ['Main', 'main', 'offline'],
      ['DPRTMNT', 'dprtmnt', 'offline'],
    ]);
    expect(orch.registry.summaries).toHaveBeenCalled();
  });

  it('needs a login', async () => {
    const { app } = await build({ user: null });
    expect((await app.inject({ method: 'GET', url: '/api/profiles' })).statusCode).toBe(401);
  });
});

describe('POST /api/profiles', () => {
  it('creates the profile, its OBS paths and its engine, then announces it', async () => {
    const { app, repos, calls, events, audits } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: '  DPRTMNT  ', color: '#e11d48' } });
    expect(res.statusCode).toBe(201);
    const p = res.json<Profile>();
    expect(p).toMatchObject({ name: 'DPRTMNT', slug: 'dprtmnt', color: '#E11D48' });
    expect(repos.profiles.get(p.id)).toEqual(p);
    expect(calls).toEqual([`media.profileAdded ${p.id}`, `orchestrators.add ${p.id}`]);
    expect(events).toEqual(['profiles-changed']);
    expect(audits()[0]).toMatchObject({ action: 'profile.create', userId: 'u1', detail: expect.stringContaining('slug=dprtmnt') });

    const second = await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'dprtmnt' } });
    expect(second.json<Profile>()).toMatchObject({ slug: 'dprtmnt-2', color: null });
  });

  it.each([
    [{}, 'missing name'],
    [{ name: '   ' }, 'blank name'],
    [{ name: 'x'.repeat(61) }, 'too long'],
    [{ name: 'two\nlines' }, 'line break'],
    [{ name: 'Club', color: 'red' }, 'bad colour'],
    [{ name: 'Club', color: '#12345' }, 'short colour'],
  ])('rejects %j (%s)', async (payload, _why) => {
    const { app, repos, media } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/profiles', payload });
    expect(res.statusCode).toBe(400);
    expect(repos.profiles.list()).toHaveLength(1);
    expect(media.profileAdded).not.toHaveBeenCalled();
  });

  it('accepts 60 characters and an explicit null colour', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'é'.repeat(60), color: null } });
    expect(res.statusCode).toBe(201);
    expect(res.json<Profile>().color).toBeNull();
  });

  it('rolls back when the engine cannot be created', async () => {
    const { app, repos, orch, media, events } = await build();
    orch.registry.add.mockRejectedValueOnce(new Error('boom'));
    const res = await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Broken' } });
    expect(res.statusCode).toBe(500);
    expect(repos.profiles.list().map((p) => p.id)).toEqual(['default']);
    expect(media.profileRemoved).toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('is admin-only', async () => {
    const { app, repos } = await build({ user: operator });
    expect((await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'X' } })).statusCode).toBe(403);
    expect(repos.profiles.list()).toHaveLength(1);
  });
});

describe('PATCH /api/profiles/:id', () => {
  it('renames and recolours, keeping the slug', async () => {
    const { app, repos, events, audits } = await build();
    const club = repos.profiles.create({ name: 'DPRTMNT', color: null });
    const res = await app.inject({ method: 'PATCH', url: `/api/profiles/${club.id}`, payload: { name: 'DPRTMNT Club', color: '#00aa00' } });
    expect(res.statusCode).toBe(200);
    expect(res.json<Profile>()).toMatchObject({ id: club.id, name: 'DPRTMNT Club', slug: 'dprtmnt', color: '#00AA00' });
    expect(events).toEqual(['profiles-changed']);
    expect(audits()[0]).toMatchObject({ action: 'profile.update', detail: expect.stringContaining('"DPRTMNT" -> "DPRTMNT Club"') });

    // Clearing the colour; a no-op patch changes nothing.
    expect((await app.inject({ method: 'PATCH', url: `/api/profiles/${club.id}`, payload: { color: null } })).json<Profile>().color).toBeNull();
    const before = events.length;
    expect((await app.inject({ method: 'PATCH', url: `/api/profiles/${club.id}`, payload: {} })).statusCode).toBe(200);
    expect(events).toHaveLength(before);
  });

  it('renames the default profile (its OBS keys stay)', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'PATCH', url: '/api/profiles/default', payload: { name: 'Miami or Bust' } });
    expect(res.json<Profile>()).toMatchObject({ id: 'default', name: 'Miami or Bust', slug: 'main' });
  });

  it('404s an unknown profile and validates the body', async () => {
    const { app, repos } = await build();
    const res = await app.inject({ method: 'PATCH', url: '/api/profiles/nope', payload: { name: 'X' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'unknown_profile' });
    expect((await app.inject({ method: 'PATCH', url: '/api/profiles/default', payload: { name: '' } })).statusCode).toBe(400);
    expect(repos.profiles.get('default')?.name).toBe('Main');
  });

  it('is admin-only', async () => {
    const { app } = await build({ user: operator });
    expect((await app.inject({ method: 'PATCH', url: '/api/profiles/default', payload: { name: 'X' } })).statusCode).toBe(403);
  });
});

describe('DELETE /api/profiles/:id', () => {
  async function seedClub(t: Awaited<ReturnType<typeof build>>) {
    const { repos, orch } = t;
    const club = repos.profiles.create({ name: 'DPRTMNT', color: null });
    orch.status.set(club.id, 'offline');
    const acc = repos.accounts.create({ profileId: club.id, platform: 'instagram', label: 'IG', options: {} });
    const dest = repos.destinations.create({ profileId: club.id, platform: 'instagram', accountId: acc.id, name: 'IG', feed: 'vertical', enabled: true, options: {}, ingestUrl: null });
    await repos.secrets.scoped(`account:${acc.id}`).set('oauth', 'club-token');
    await repos.secrets.scoped(`browser:${acc.id}`).set('storageState', '{}');
    await repos.secrets.scoped(`destination:${dest.id}`).set('streamKey', 'club-stream-key');
    await repos.secrets.scoped(`ingest:${club.id}`).set('landscape', 'ClubLandscape_0123456789');
    await repos.secrets.scoped(`chat:${club.id}`).set('overlayToken', 'club-overlay');
    repos.settings.set(`profile:${club.id}:session.title`, 'Saturday');
    repos.settings.set(`profile:${club.id}:session.testMode`, true);
    const clubToken = repos.apiTokens.create({ name: 'Club overlay', scopes: ['chat:read'], createdBy: null, profileId: club.id });
    const everyToken = repos.apiTokens.create({ name: 'OBS plugin', scopes: ['status:read'], createdBy: null, profileId: null });

    // The default profile's data, which must survive untouched.
    const mainAcc = repos.accounts.create({ profileId: 'default', platform: 'youtube', label: 'YT', options: {} });
    const mainDest = repos.destinations.create({ profileId: 'default', platform: 'youtube', accountId: mainAcc.id, name: 'YT', feed: 'landscape', enabled: true, options: {}, ingestUrl: null });
    await repos.secrets.scoped(`destination:${mainDest.id}`).set('streamKey', 'main-stream-key');
    await repos.secrets.scoped('ingest').set('landscape', 'MainLandscape_0123456789');
    await repos.secrets.scoped('chat').set('overlayToken', 'main-overlay');
    await repos.secrets.scoped('app:twitch').setJson('values', { clientId: 'x', clientSecret: 'y' });
    repos.settings.set('session.title', 'Miami');
    return { club, acc, dest, clubToken, everyToken, mainAcc, mainDest };
  }

  it('removes its show profile and library entries, and keeps the others', async () => {
    const t = await build();
    const { app, repos } = t;
    const s = await seedClub(t);
    const sha = (n: string) => crypto.createHash('sha256').update(n).digest('hex');
    repos.blobs.upsert({ sha256: sha('a'), size: 1, kind: 'image' });
    const save = (profileId: string) =>
      repos.showProfiles.addRevision({
        profileId, name: 'S', parentRevision: 0, manifest: '{}', bundleSha256: sha(profileId), size: 1,
        blobs: [sha('a')], savedByApp: null, savedByToken: null, note: null,
      });
    save(s.club.id);
    save('default');
    repos.assetLibrary.create({ sha256: sha('a'), name: 'club', kind: 'image', profileId: s.club.id, uploadedBy: null });
    const shared = repos.assetLibrary.create({ sha256: sha('a'), name: 'shared', kind: 'image', profileId: null, uploadedBy: null });

    const res = await app.inject({ method: 'DELETE', url: `/api/profiles/${s.club.id}` });
    expect(res.statusCode).toBe(200);
    expect(repos.showProfiles.getByProfile(s.club.id)).toBeNull();
    expect(repos.showProfiles.getByProfile('default')).not.toBeNull();
    expect(repos.assetLibrary.list().map((a) => a.id)).toEqual([shared.id]);
  });

  it("deletes the profile with everything that belonged to it, and nothing else", async () => {
    const t = await build();
    const { app, repos, calls, events, audits } = t;
    const s = await seedClub(t);

    const res = await app.inject({ method: 'DELETE', url: `/api/profiles/${s.club.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});

    expect(repos.profiles.get(s.club.id)).toBeNull();
    expect(repos.accounts.list(s.club.id)).toEqual([]);
    expect(repos.destinations.list(s.club.id)).toEqual([]);
    expect(await repos.secrets.scoped(`account:${s.acc.id}`).get('oauth')).toBeNull();
    expect(await repos.secrets.scoped(`browser:${s.acc.id}`).get('storageState')).toBeNull();
    expect(await repos.secrets.scoped(`destination:${s.dest.id}`).get('streamKey')).toBeNull();
    expect(await repos.secrets.scoped(`ingest:${s.club.id}`).get('landscape')).toBeNull();
    expect(await repos.secrets.scoped(`chat:${s.club.id}`).get('overlayToken')).toBeNull();
    expect(repos.settings.get(`profile:${s.club.id}:session.title`, null)).toBeNull();
    expect(repos.settings.get(`profile:${s.club.id}:session.testMode`, null)).toBeNull();
    expect(repos.apiTokens.list().map((x) => x.id)).toEqual([s.everyToken.token.id]);

    expect(calls).toEqual([
      `orchestrators.remove ${s.club.id}`,
      `browser.close ${s.acc.id}`,
      `browser.clear ${s.acc.id}`,
      `media.profileRemoved ${s.club.id}`,
      `apps.removeByToken ${s.clubToken.token.id}`,
    ]);
    expect(events).toEqual([`destinations-changed [{"profileId":"${s.club.id}"}]`, 'profiles-changed']);
    expect(audits()[0]).toMatchObject({ action: 'profile.delete', detail: expect.stringMatching(/destinations=1 accounts=1 tokens=1/) });
    expect(JSON.stringify(audits())).not.toContain('club-stream-key');

    // The default profile keeps everything.
    expect(repos.profiles.get('default')).not.toBeNull();
    expect(repos.accounts.get(s.mainAcc.id)).not.toBeNull();
    expect(repos.destinations.get(s.mainDest.id)).not.toBeNull();
    expect(await repos.secrets.scoped(`destination:${s.mainDest.id}`).get('streamKey')).toBe('main-stream-key');
    expect(await repos.secrets.scoped('ingest').get('landscape')).toBe('MainLandscape_0123456789');
    expect(await repos.secrets.scoped('chat').get('overlayToken')).toBe('main-overlay');
    expect(await repos.secrets.scoped('app:twitch').getJson('values')).toEqual({ clientId: 'x', clientSecret: 'y' });
    expect(repos.settings.get('session.title', '')).toBe('Miami');
  });

  it("drops every-profile apps' resources assigned to it (not unassigned), so their next registration still works", async () => {
    const t = await build();
    const { app, repos, events } = t;
    const s = await seedClub(t);
    const overlay = (id: string, profileId: string | null) => ({ type: 'overlay', id, name: id, profileId });
    // CTD Overlay connected for every profile, with overlays for both profiles and one unassigned.
    repos.connectedApps.upsert({
      id: 'ctd-overlay',
      name: 'CTD Overlay',
      kind: 'overlay',
      version: '1.0.0',
      baseUrl: null,
      capabilities: ['overlays'],
      resources: [overlay('club-lower-third', s.club.id), overlay('miami-banner', 'default'), overlay('shared-logo', null)],
      tokenId: s.everyToken.token.id,
      profileId: null,
    });
    // An every-profile app with nothing for the club stays untouched.
    repos.connectedApps.upsert({
      id: 'ctd-obs-plugin',
      name: 'OBS plugin',
      kind: 'obs-plugin',
      version: null,
      baseUrl: null,
      capabilities: [],
      resources: [overlay('main-only', 'default')],
      tokenId: s.everyToken.token.id,
      profileId: null,
    });
    const pluginBefore = repos.connectedApps.get('ctd-obs-plugin');

    expect((await app.inject({ method: 'DELETE', url: `/api/profiles/${s.club.id}` })).statusCode).toBe(200);

    expect(repos.connectedApps.get('ctd-overlay')?.resources.map((r) => [r.id, r.profileId])).toEqual([
      ['miami-banner', 'default'],
      ['shared-logo', null],
    ]);
    expect(repos.connectedApps.get('ctd-obs-plugin')).toEqual(pluginBefore);
    expect(events.filter((e) => e === 'apps-changed')).toHaveLength(1);
    // Announced after the profile row is gone, so listeners never see a resource for a missing profile.
    expect(events).toEqual(['apps-changed', `destinations-changed [{"profileId":"${s.club.id}"}]`, 'profiles-changed']);
  });

  it('removes destinations and accounts created for it while the delete was running', async () => {
    const t = await build();
    const { app, repos, browser, media, audits } = t;
    const s = await seedClub(t);
    let lateAccountId = '';
    // A request handled while the browser session closes adds a destination and an account.
    browser.close.mockImplementationOnce(async () => {
      lateAccountId = repos.accounts.create({ profileId: s.club.id, platform: 'kick', label: 'Late', options: {} }).id;
      const d = repos.destinations.create({ profileId: s.club.id, platform: 'custom', accountId: null, name: 'Late 1', feed: 'landscape', enabled: true, options: {}, ingestUrl: null });
      await repos.secrets.scoped(`destination:${d.id}`).set('streamKey', 'late-key-1');
    });
    // Another one while the OBS paths go.
    media.profileRemoved.mockImplementationOnce(async () => {
      repos.destinations.create({ profileId: s.club.id, platform: 'custom', accountId: null, name: 'Late 2', feed: 'vertical', enabled: true, options: {}, ingestUrl: null });
    });

    expect((await app.inject({ method: 'DELETE', url: `/api/profiles/${s.club.id}` })).statusCode).toBe(200);

    expect(repos.profiles.get(s.club.id)).toBeNull();
    expect(repos.destinations.list().filter((d) => d.profileId === s.club.id)).toEqual([]);
    expect(repos.accounts.list().filter((a) => a.profileId === s.club.id)).toEqual([]);
    expect(browser.clear).toHaveBeenCalledWith(lateAccountId);
    expect(repos.destinations.get(s.mainDest.id)).not.toBeNull();
    expect(audits()[0]).toMatchObject({ action: 'profile.delete', detail: expect.stringMatching(/destinations=3 accounts=2 /) });
  });

  it('refuses the default profile', async () => {
    const { app, repos, calls } = await build();
    const res = await app.inject({ method: 'DELETE', url: '/api/profiles/default' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'default_profile' });
    expect(repos.profiles.get('default')).not.toBeNull();
    expect(calls).toEqual([]);
  });

  it.each(['starting', 'live', 'stopping'] as const)('refuses while its session is %s', async (status) => {
    const t = await build();
    const s = await seedClub(t);
    t.orch.status.set(s.club.id, status);
    const res = await t.app.inject({ method: 'DELETE', url: `/api/profiles/${s.club.id}` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'session_live' });
    expect(t.repos.profiles.get(s.club.id)).not.toBeNull();
    expect(t.repos.destinations.list(s.club.id)).toHaveLength(1);
    expect(t.calls).toEqual([]);
  });

  it('keeps going when a browser session cannot be closed', async () => {
    const t = await build();
    const s = await seedClub(t);
    t.browser.close.mockRejectedValueOnce(new Error('browser gone'));
    t.browser.clear.mockRejectedValueOnce(new Error('browser gone'));
    expect((await t.app.inject({ method: 'DELETE', url: `/api/profiles/${s.club.id}` })).statusCode).toBe(200);
    expect(await t.repos.secrets.scoped(`account:${s.acc.id}`).get('oauth')).toBeNull();
    expect(t.repos.profiles.get(s.club.id)).toBeNull();
  });

  it('404s an unknown profile', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'DELETE', url: '/api/profiles/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'unknown_profile' });
  });

  it('is admin-only', async () => {
    const op = await build({ user: operator });
    const club = op.repos.profiles.create({ name: 'Club', color: null });
    expect((await op.app.inject({ method: 'DELETE', url: `/api/profiles/${club.id}` })).statusCode).toBe(403);
    expect(op.repos.profiles.get(club.id)).not.toBeNull();
  });
});
