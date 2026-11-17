import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAST_USED_WRITE_INTERVAL_MS } from '../db/api-tokens-repo.js';
import type { ApiTokenInfo, AppResource } from '../../../shared/types.js';
import { EventBus } from '../events.js';
import type { ProfilesRepo } from '../services.js';
import { ApiProblem } from './http.js';
import {
  MAX_APPS_PER_TOKEN,
  MAX_META_BYTES,
  MAX_RESOURCES,
  ONLINE_WINDOW_MS,
  SUPERSEDED_GRACE_MS,
  appsForProfile,
  createAppRegistry,
  overlaysFor,
  parseAppRegistration,
  publicApp,
  sameAppIdFamily,
  type AppRegistration,
  type AppRegistryHandle,
} from './hub.js';
import { memoryConnectedAppsRepo, memoryProfilesRepo, silentLog } from './test-helpers.js';

let clock: number;
const now = () => clock;
let bus: EventBus;
let profiles: ProfilesRepo;
let registry: AppRegistryHandle;
let changes: number;
let dprtmnt: string;

const token = (id: string, profileId: string | null = null): ApiTokenInfo => ({
  id,
  name: id,
  scopes: ['apps:read', 'apps:write'],
  profileId,
  prefix: 'ctd_pat_xxxx',
  createdAt: '',
  createdBy: null,
  lastUsedAt: null,
});

const overlay = (id: string, profileId: string | null, over: Partial<AppResource> = {}): AppResource => ({
  type: 'overlay',
  id,
  name: `Overlay ${id}`,
  profileId,
  url: `http://10.20.30.40:30200/o/${id}?key=k`,
  width: 1920,
  height: 1080,
  ...over,
});

const reg = (id: string, over: Partial<AppRegistration> = {}): AppRegistration => ({
  id,
  name: 'CTD Overlay',
  kind: 'ctd-overlay',
  version: '1.4.0',
  baseUrl: 'http://10.20.30.40:30200',
  capabilities: ['overlays', 'overlay.create'],
  resources: [],
  ...over,
});

function problem(fn: () => unknown): ApiProblem {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiProblem) return err;
    throw err;
  }
  throw new Error('expected an ApiProblem');
}

beforeEach(() => {
  clock = Date.parse('2026-10-17T03:00:00.000Z');
  bus = new EventBus();
  profiles = memoryProfilesRepo(now);
  dprtmnt = profiles.create({ name: 'DPRTMNT', color: '#E11D48' }).id;
  registry = createAppRegistry({ repos: { profiles, connectedApps: memoryConnectedAppsRepo(now) }, bus, log: silentLog, now });
  changes = 0;
  bus.on('apps-changed', () => changes++);
});

afterEach(() => registry.close());

describe('register', () => {
  it('registers, re-registers (keeping registeredAt) and only announces real changes', () => {
    const t = token('t1');
    const first = registry.register(t, reg('ctd-overlay', { resources: [overlay('ovl_h', dprtmnt)] }));
    expect(first).toMatchObject({ id: 'ctd-overlay', tokenId: 't1', profileId: null, online: true, registeredAt: '2026-10-17T03:00:00.000Z' });
    expect(changes).toBe(1);

    clock += 30_000;
    const again = registry.register(t, reg('ctd-overlay', { resources: [overlay('ovl_h', dprtmnt)] }));
    expect(again.registeredAt).toBe('2026-10-17T03:00:00.000Z');
    expect(again.lastSeenAt).toBe('2026-10-17T03:00:30.000Z');
    expect(changes).toBe(1); // same content: a heartbeat

    registry.register(t, reg('ctd-overlay', { resources: [overlay('ovl_h', dprtmnt), overlay('ovl_v', dprtmnt, { width: 1080, height: 1920 })] }));
    expect(changes).toBe(2);
    expect(registry.get('ctd-overlay')!.resources.map((r) => r.id)).toEqual(['ovl_h', 'ovl_v']);
  });

  it('only the token that registered an id may update, heartbeat or own it', () => {
    registry.register(token('t1'), reg('ctd-overlay'));
    expect(problem(() => registry.register(token('t2'), reg('ctd-overlay')))).toMatchObject({ statusCode: 409, code: 'app_owned' });
    expect(problem(() => registry.heartbeat(token('t2'), 'ctd-overlay'))).toMatchObject({ statusCode: 409, code: 'app_owned' });
    expect(problem(() => registry.heartbeat(token('t1'), 'nope'))).toMatchObject({ statusCode: 404, code: 'not_found' });
  });

  it('a re-paired app takes its id back: owner revoked, or offline + same kind + newer token', () => {
    const tokens: ApiTokenInfo[] = [];
    const tk = (id: string, createdAt: string) => {
      const t = { ...token(id), createdAt };
      tokens.push(t);
      return t;
    };
    registry.close();
    registry = createAppRegistry({
      repos: { profiles, connectedApps: memoryConnectedAppsRepo(now), apiTokens: { list: () => tokens } as never },
      bus,
      log: silentLog,
      now,
    });
    const old = tk('old', '2026-10-01T00:00:00.000Z');
    const plugin = reg('ctd-obs-plugin-studio', { kind: 'ctd-obs-plugin', name: 'CTD OBS plugin' });
    registry.register(old, plugin);

    // While the old one is online, a newer token of another app (another name) can't take the id.
    const fresh = tk('fresh', '2026-10-17T00:00:00.000Z');
    expect(problem(() => registry.register(fresh, { ...plugin, name: 'CTD OBS plugin (other PC)' }))).toMatchObject({ code: 'app_owned' });
    clock += ONLINE_WINDOW_MS + 1;
    // Offline: an older token, or another kind of app, still can't.
    const older = tk('older', '2026-09-01T00:00:00.000Z');
    expect(problem(() => registry.register(older, plugin))).toMatchObject({ code: 'app_owned' });
    expect(problem(() => registry.register(fresh, { ...plugin, kind: 'ctd-overlay' }))).toMatchObject({ code: 'app_owned' });
    // The fresh pairing of the same app can.
    expect(registry.register(fresh, plugin)).toMatchObject({ tokenId: 'fresh', online: true });
    expect(problem(() => registry.heartbeat(old, 'ctd-obs-plugin-studio'))).toMatchObject({ code: 'app_owned' });

    // Owner revoked: any token may register the id at once, even while it looked online.
    tokens.splice(tokens.indexOf(fresh), 1);
    expect(registry.register(older, plugin)).toMatchObject({ tokenId: 'older' });
  });

  describe('re-pairing the same app (stale connections)', () => {
    let tokens: ApiTokenInfo[];
    let audits: { action: string; detail?: string | null }[];
    const tk = (id: string, createdAt: string, profileId: string | null = null) => {
      const t = { ...token(id, profileId), createdAt };
      tokens.push(t);
      return t;
    };
    const live = (id: string) => tokens.some((t) => t.id === id);
    /** A token's use, as the tokens repo records it on each request (at most once a minute). */
    const use = (t: ApiTokenInfo) => {
      t.lastUsedAt = new Date(clock).toISOString();
    };
    const plugin = (id = 'ctd-obs-plugin-studio') => reg(id, { kind: 'ctd-obs-plugin', name: 'CTD OBS plugin (studio)', capabilities: ['obs.ingest', 'obs.overlays'] });
    const ids = () => registry.list().map((a) => `${a.id}:${a.tokenId}`);

    beforeEach(() => {
      tokens = [];
      audits = [];
      registry.close();
      registry = createAppRegistry({
        repos: {
          profiles,
          connectedApps: memoryConnectedAppsRepo(now),
          apiTokens: {
            list: () => tokens,
            delete: (id: string) => tokens.splice(tokens.findIndex((t) => t.id === id) >>> 0, 1),
          } as never,
          audit: { log: (e: { action: string; detail?: string | null }) => audits.push(e) } as never,
        },
        bus,
        log: silentLog,
        now,
      });
    });

    it('re-registering with the same token keeps one entry and supersedes nothing', () => {
      const a = tk('a', '2026-10-01T00:00:00.000Z');
      registry.register(a, plugin());
      for (let i = 0; i < 5; i++) {
        clock += 30_000;
        use(a);
        expect(registry.register(a, plugin())).toMatchObject({ id: 'ctd-obs-plugin-studio', tokenId: 'a', registeredAt: '2026-10-17T03:00:00.000Z' });
      }
      // An OBS restart with the saved pairing: the same token, the same id, even within the online window.
      expect(registry.heartbeat(a, 'ctd-obs-plugin-studio')).toMatchObject({ tokenId: 'a', online: true });
      clock += SUPERSEDED_GRACE_MS + 1;
      registry.checkSuperseded();
      expect(ids()).toEqual(['ctd-obs-plugin-studio:a']);
      expect(live('a')).toBe(true);
      expect(audits).toEqual([]);
    });

    it('re-pairing from the same device while the old entry is online replaces it and revokes the old token', () => {
      const a = tk('a', '2026-10-01T00:00:00.000Z');
      use(a);
      registry.register(a, plugin());
      changes = 0;

      // The plugin pairs again (new scopes): the new token is newer; it registers the same id at once.
      clock += 5_000;
      const b = tk('b', new Date(clock).toISOString());
      const taken = registry.register(b, plugin());
      expect(taken).toMatchObject({ id: 'ctd-obs-plugin-studio', tokenId: 'b', online: true });
      expect(ids()).toEqual(['ctd-obs-plugin-studio:b']);
      expect(changes).toBe(1);
      // The old token can't come back to the id.
      expect(problem(() => registry.heartbeat(a, 'ctd-obs-plugin-studio'))).toMatchObject({ code: 'app_owned' });

      // Within the grace period the old token stays (a request may still be in flight).
      clock += SUPERSEDED_GRACE_MS - 1;
      registry.checkSuperseded();
      expect(live('a')).toBe(true);
      clock += 2;
      registry.checkSuperseded();
      expect(live('a')).toBe(false);
      expect(live('b')).toBe(true);
      expect(audits).toEqual([expect.objectContaining({ action: 'api_token.superseded', detail: expect.stringContaining('ctd-obs-plugin-studio paired again') })]);
      expect(ids()).toEqual(['ctd-obs-plugin-studio:b']);
    });

    it('re-pairing after OBS was closed (old entry offline) also revokes the old token', () => {
      const a = tk('a', '2026-10-01T00:00:00.000Z');
      registry.register(a, plugin());
      clock += ONLINE_WINDOW_MS + 60_000;
      const b = tk('b', new Date(clock).toISOString());
      registry.register(b, plugin());
      clock += SUPERSEDED_GRACE_MS;
      registry.checkSuperseded();
      expect(live('a')).toBe(false);
      expect(ids()).toEqual(['ctd-obs-plugin-studio:b']);
    });

    it('cleans up entries an earlier pairing left under suffixed ids', () => {
      // What production has: the first pairing's entry, then the plugin moved to "-d705a3" after a 409.
      const a = tk('a', '2026-10-01T00:00:00.000Z');
      const b = tk('b', '2026-10-05T00:00:00.000Z');
      registry.register(a, plugin('ctd-obs-plugin-studio'));
      registry.register(b, plugin('ctd-obs-plugin-studio-d705a3'));
      clock += ONLINE_WINDOW_MS + 1;
      // Other apps that must stay: another machine, another kind, another profile's overlay connection.
      const other = tk('other', '2026-09-01T00:00:00.000Z');
      registry.register(other, reg('ctd-obs-plugin-studio-2', { kind: 'ctd-obs-plugin', name: 'CTD OBS plugin (studio-2)' }));
      const ovl = tk('ovl', '2026-09-01T00:00:00.000Z', dprtmnt);
      registry.register(ovl, reg('ctd-overlay-dprtmnt'));
      clock += ONLINE_WINDOW_MS + 1;

      // The same OBS pairs a third time and registers its saved id.
      const c = tk('c', new Date(clock).toISOString());
      const ovl2 = tk('ovl2', new Date(clock).toISOString());
      registry.register(ovl2, reg('ctd-overlay'));
      registry.register(c, plugin('ctd-obs-plugin-studio-d705a3'));
      expect(ids().sort()).toEqual(['ctd-obs-plugin-studio-2:other', 'ctd-obs-plugin-studio-d705a3:c', 'ctd-overlay-dprtmnt:ovl', 'ctd-overlay:ovl2']);
      clock += SUPERSEDED_GRACE_MS;
      registry.checkSuperseded();
      expect(tokens.map((t) => t.id).sort()).toEqual(['c', 'other', 'ovl', 'ovl2']);
    });

    it('never prunes an online entry, or one registered by a newer token', () => {
      const a = tk('a', '2026-10-01T00:00:00.000Z');
      const b = tk('b', '2026-10-05T00:00:00.000Z');
      registry.register(a, plugin('ctd-obs-plugin-studio'));
      registry.register(b, plugin('ctd-obs-plugin-studio-d705a3'));
      // Both online: two OBS with the same machine name, say. Nothing goes.
      registry.register(b, plugin('ctd-obs-plugin-studio-d705a3'));
      expect(ids()).toHaveLength(2);
      clock += ONLINE_WINDOW_MS + 1;
      // The older token's app re-registering doesn't remove the newer one's entry.
      registry.register(a, plugin('ctd-obs-plugin-studio'));
      expect(ids()).toHaveLength(2);
      clock += SUPERSEDED_GRACE_MS;
      registry.checkSuperseded();
      expect(tokens).toHaveLength(2);
    });

    it('keeps the old token when another live app still uses it (two OBS with the same machine name)', () => {
      const a = tk('a', '2026-10-01T00:00:00.000Z');
      registry.register(a, plugin());
      clock += 5_000;
      const b = tk('b', new Date(clock).toISOString());
      registry.register(b, plugin()); // the second machine takes the id
      // The first machine keeps going: refused on the id, it moves to its own one.
      clock += 30_000;
      use(a);
      expect(problem(() => registry.register(a, plugin()))).toMatchObject({ code: 'app_owned' });
      registry.register(a, plugin('ctd-obs-plugin-studio-1a2b3c'));
      clock += LAST_USED_WRITE_INTERVAL_MS + 1_000;
      use(a);
      registry.register(a, plugin('ctd-obs-plugin-studio-1a2b3c'));
      clock += SUPERSEDED_GRACE_MS;
      use(a);
      registry.checkSuperseded();
      expect(live('a')).toBe(true);
      expect(ids().sort()).toEqual(['ctd-obs-plugin-studio-1a2b3c:a', 'ctd-obs-plugin-studio:b']);
      expect(audits).toEqual([]);
    });

    it('keeps the old token while it still has other apps, or when the new one was revoked meanwhile', () => {
      const a = tk('a', '2026-10-01T00:00:00.000Z');
      registry.register(a, plugin());
      registry.register(a, reg('ctd-overlay'));
      clock += 5_000;
      const b = tk('b', new Date(clock).toISOString());
      registry.register(b, plugin());
      clock += SUPERSEDED_GRACE_MS;
      registry.checkSuperseded();
      expect(live('a')).toBe(true);

      const c = tk('c', new Date(clock).toISOString());
      const d = tk('d', new Date(clock + 1).toISOString());
      clock += 1;
      registry.register(c, plugin('ctd-obs-plugin-lab'));
      registry.register(d, plugin('ctd-obs-plugin-lab'));
      tokens.splice(tokens.indexOf(d), 1);
      clock += SUPERSEDED_GRACE_MS;
      registry.checkSuperseded();
      expect(live('c')).toBe(true);
    });

    it('a re-pair of another kind or by an older token is still refused while online', () => {
      const a = tk('a', '2026-10-05T00:00:00.000Z');
      registry.register(a, plugin());
      const older = tk('older', '2026-09-01T00:00:00.000Z');
      expect(problem(() => registry.register(older, plugin()))).toMatchObject({ code: 'app_owned' });
      const fresh = tk('fresh', '2026-10-17T00:00:00.000Z');
      expect(problem(() => registry.register(fresh, { ...plugin(), kind: 'custom' }))).toMatchObject({ code: 'app_owned' });
      expect(ids()).toEqual(['ctd-obs-plugin-studio:a']);
    });

    it('a restart during the grace period keeps the old token (the pending revoke lives in memory)', () => {
      const apps = memoryConnectedAppsRepo(now);
      const deps = () => ({
        repos: {
          profiles,
          connectedApps: apps,
          apiTokens: { list: () => tokens, delete: (id: string) => tokens.splice(tokens.findIndex((t) => t.id === id) >>> 0, 1) } as never,
          audit: { log: (e: { action: string }) => audits.push(e) } as never,
        },
        bus,
        log: silentLog,
        now,
      });
      const before = createAppRegistry(deps());
      const a = tk('a', '2026-10-01T00:00:00.000Z');
      before.register(a, plugin());
      clock += 5_000;
      const b = tk('b', new Date(clock).toISOString());
      before.register(b, plugin());
      before.close();

      // Relay restarts: presence comes back from the repo, the pending revoke doesn't.
      const after = createAppRegistry(deps());
      try {
        expect(after.get('ctd-obs-plugin-studio')).toMatchObject({ tokenId: 'b', online: true });
        clock += 30_000;
        after.register(b, plugin()); // the next heartbeat supersedes nothing new
        clock += SUPERSEDED_GRACE_MS;
        after.checkSuperseded();
        expect(live('a')).toBe(true);
        expect(audits).toEqual([]);
      } finally {
        after.close();
      }
    });

    it('the presence timer revokes the superseded token on its own', async () => {
      registry.close();
      registry = createAppRegistry({
        repos: {
          profiles,
          connectedApps: memoryConnectedAppsRepo(now),
          apiTokens: { list: () => tokens, delete: (id: string) => tokens.splice(tokens.findIndex((t) => t.id === id) >>> 0, 1) } as never,
          audit: { log: (e: { action: string }) => audits.push(e) } as never,
        },
        bus,
        log: silentLog,
        now,
        presenceCheckMs: 5,
      });
      const a = tk('a', '2026-10-01T00:00:00.000Z');
      registry.register(a, plugin());
      clock += 5_000;
      registry.register(tk('b', new Date(clock).toISOString()), plugin());
      await new Promise((r) => setTimeout(r, 30));
      expect(live('a')).toBe(true);
      clock += SUPERSEDED_GRACE_MS;
      await expect.poll(() => live('a'), { timeout: 2_000, interval: 10 }).toBe(false);
      expect(audits).toEqual([expect.objectContaining({ action: 'api_token.superseded' })]);
    });
    it('a token limited to one profile never pushes out (or gets revoked) a connection for every profile or another profile', () => {
      const a = tk('a', '2026-10-01T00:00:00.000Z');
      registry.register(a, plugin());
      // Newer, same kind and name, but limited to one profile: refused while the app is online.
      const narrow = tk('narrow', '2026-10-10T00:00:00.000Z', dprtmnt);
      expect(problem(() => registry.register(narrow, plugin()))).toMatchObject({ code: 'app_owned' });
      expect(ids()).toEqual(['ctd-obs-plugin-studio:a']);

      // Offline, the v1.6 rule still lets it take the id, but the old token is not superseded.
      clock += ONLINE_WINDOW_MS + 1;
      expect(registry.register(narrow, plugin())).toMatchObject({ tokenId: 'narrow' });
      clock += SUPERSEDED_GRACE_MS;
      registry.checkSuperseded();
      expect(live('a')).toBe(true);
      expect(audits).toEqual([]);

      // Another profile's token can't push out a profile-limited connection either.
      const p2 = profiles.create({ name: 'Second', color: null }).id;
      const own = tk('own', '2026-10-11T00:00:00.000Z', dprtmnt);
      registry.register(own, plugin('ctd-obs-plugin-lab'));
      const other = tk('other', '2026-10-12T00:00:00.000Z', p2);
      expect(problem(() => registry.register(other, plugin('ctd-obs-plugin-lab')))).toMatchObject({ code: 'app_owned' });
    });

    it('a re-pair for the same profile, or one widened to every profile, still replaces the old connection', () => {
      const a = tk('a', '2026-10-01T00:00:00.000Z', dprtmnt);
      registry.register(a, plugin());
      clock += 5_000;
      const same = tk('same', new Date(clock).toISOString(), dprtmnt);
      expect(registry.register(same, plugin())).toMatchObject({ tokenId: 'same', online: true });
      clock += 5_000;
      const wide = tk('wide', new Date(clock).toISOString());
      expect(registry.register(wide, plugin())).toMatchObject({ tokenId: 'wide', profileId: null, online: true });
      clock += SUPERSEDED_GRACE_MS;
      registry.checkSuperseded();
      expect(live('a')).toBe(false);
      expect(live('same')).toBe(false);
      expect(ids()).toEqual(['ctd-obs-plugin-studio:wide']);
    });
  });

  it('sameAppIdFamily: an id and its renewals', () => {
    expect(sameAppIdFamily('ctd-obs-plugin-studio', 'ctd-obs-plugin-studio-d705a3')).toBe(true);
    expect(sameAppIdFamily('ctd-obs-plugin-studio-1a2b3c', 'ctd-obs-plugin-studio-d705a3')).toBe(true);
    // A renewed id keeps 18 characters of the machine name, the first id 25.
    expect(sameAppIdFamily('ctd-obs-plugin-averyveryverylongmachin', 'ctd-obs-plugin-averyveryverylong-d705a3')).toBe(true);
    expect(sameAppIdFamily('ctd-obs-plugin-studio', 'ctd-obs-plugin-lab')).toBe(false);
    expect(sameAppIdFamily('ctd-overlay', 'ctd-overlay-dprtmnt')).toBe(false);
  });

  it('validates ids, kinds, limits, overlay URLs and unique resource ids', () => {
    const t = token('t1');
    expect(problem(() => registry.register(t, reg('Bad Id')))).toMatchObject({ statusCode: 400, code: 'invalid' });
    expect(problem(() => registry.register(t, reg('x'.repeat(41))))).toMatchObject({ statusCode: 400 });
    expect(problem(() => registry.register(t, reg('ok', { kind: 'CTD Overlay' })))).toMatchObject({ statusCode: 400 });
    const many = Array.from({ length: MAX_RESOURCES + 1 }, (_, i) => overlay(`o${i}`, null));
    expect(problem(() => registry.register(t, reg('ok', { resources: many }))).message).toMatch(/at most 200 resources/);
    expect(registry.register(t, reg('ok', { resources: many.slice(0, MAX_RESOURCES) })).resources).toHaveLength(MAX_RESOURCES);
    const bigMeta = { blob: 'x'.repeat(MAX_META_BYTES) };
    expect(problem(() => registry.register(t, reg('ok', { resources: [overlay('o', null, { meta: bigMeta })] }))).message).toMatch(/4096 bytes/);
    expect(problem(() => registry.register(t, reg('ok', { resources: [overlay('o', null, { url: undefined })] }))).message).toMatch(/required for overlays/);
    expect(problem(() => registry.register(t, reg('ok', { resources: [overlay('o', null, { url: 'javascript:alert(1)' })] }))).message).toMatch(/http/);
    expect(problem(() => registry.register(t, reg('ok', { resources: [overlay('o', null), overlay('o', null)] }))).message).toMatch(/used twice/);
    // Other resource types need no URL.
    expect(registry.register(t, reg('ok', { resources: [{ type: 'scene-preset', id: 's1', name: 'Takeover', profileId: null, meta: { scenes: 3 } }] })).resources).toHaveLength(1);
  });

  it('parses a raw body: defaults, trimming, deduplicated capabilities, unknown fields dropped', () => {
    const r = parseAppRegistration('ctd-obs-plugin-studio-pc', {
      name: '  CTD OBS plugin ',
      kind: 'ctd-obs-plugin',
      capabilities: ['obs', 'obs'],
      extra: 'ignored',
      resources: [{ type: 'overlay', id: 'x', name: 'X', url: 'https://o.example/x', meta: { canvas: 'vertical' } }],
    });
    expect(r).toEqual({
      id: 'ctd-obs-plugin-studio-pc',
      name: 'CTD OBS plugin',
      kind: 'ctd-obs-plugin',
      version: null,
      baseUrl: null,
      capabilities: ['obs'],
      resources: [{ type: 'overlay', id: 'x', name: 'X', profileId: null, url: 'https://o.example/x', meta: { canvas: 'vertical' } }],
    });
    expect(() => parseAppRegistration('ok', { name: 'x', kind: 'k', resources: [{ type: 'overlay', id: 'x', name: 'X', url: 'http://a', meta: [1] }] })).toThrow(ApiProblem);
  });

  it('a profile-limited token may assign resources only to its profile (or null)', () => {
    const limited = token('t-limited', dprtmnt);
    expect(registry.register(limited, reg('ctd-overlay-dprtmnt', { resources: [overlay('a', dprtmnt), overlay('b', null)] })).profileId).toBe(dprtmnt);
    expect(problem(() => registry.register(limited, reg('ctd-overlay-dprtmnt', { resources: [overlay('a', 'default')] })))).toMatchObject({
      statusCode: 403,
      code: 'profile_forbidden',
    });
  });

  it('resources assigned to a profile that does not exist (e.g. deleted) are left out, not the whole registration', () => {
    const t = token('t1');
    const club = profiles.create({ name: 'Club', color: null }).id;
    registry.register(t, reg('ctd-overlay', { resources: [overlay('a', dprtmnt), overlay('b', club), overlay('c', null)] }));
    profiles.delete(club);
    // The app still sends its old list (it hasn't seen profiles.changed yet): the heartbeat works.
    const saved = registry.register(t, reg('ctd-overlay', { resources: [overlay('a', dprtmnt), overlay('b', club), overlay('c', null)] }));
    expect(saved.resources.map((r) => r.id)).toEqual(['a', 'c']);
    expect(registry.register(t, reg('x', { resources: [overlay('a', 'no-such-profile')] })).resources).toEqual([]);
  });

  it('caps the apps per token', () => {
    const t = token('t1');
    for (let i = 0; i < MAX_APPS_PER_TOKEN; i++) registry.register(t, reg(`app-${i}`));
    expect(problem(() => registry.register(t, reg('one-more')))).toMatchObject({ statusCode: 409, code: 'limit' });
    expect(registry.register(token('t2'), reg('other-token')).id).toBe('other-token');
  });
});

describe('presence', () => {
  it('goes offline after 90 s without a heartbeat (announced once), and online again on a heartbeat', () => {
    const t = token('t1');
    registry.register(t, reg('ctd-overlay'));
    changes = 0;
    clock += ONLINE_WINDOW_MS;
    registry.checkPresence();
    expect(registry.get('ctd-overlay')!.online).toBe(true);
    expect(changes).toBe(0);
    clock += 1;
    registry.checkPresence();
    registry.checkPresence();
    expect(registry.get('ctd-overlay')!.online).toBe(false);
    expect(changes).toBe(1);

    const hb = registry.heartbeat(t, 'ctd-overlay');
    expect(hb.online).toBe(true);
    expect(changes).toBe(2);
    registry.heartbeat(t, 'ctd-overlay');
    expect(changes).toBe(2);
  });

  it('re-registering an offline app announces it online even when nothing else changed', () => {
    const t = token('t1');
    registry.register(t, reg('ctd-overlay'));
    clock += 120_000;
    registry.checkPresence();
    changes = 0;
    registry.register(t, reg('ctd-overlay'));
    expect(changes).toBe(1);
  });

  it('starts from the persisted lastSeenAt', () => {
    const repo = memoryConnectedAppsRepo(now);
    repo.upsert({ ...reg('old'), tokenId: 't1', profileId: null });
    clock += 200_000;
    const fresh = createAppRegistry({ repos: { profiles, connectedApps: repo }, bus, log: silentLog, now });
    expect(fresh.get('old')!.online).toBe(false);
    fresh.close();
  });
});

describe('remove', () => {
  it('remove(id) and removeByToken announce the change; unknown ids are a no-op', () => {
    registry.register(token('t1'), reg('a'));
    registry.register(token('t1'), reg('b'));
    registry.register(token('t2'), reg('c'));
    changes = 0;
    registry.remove('a');
    registry.remove('a');
    expect(changes).toBe(1);
    registry.removeByToken('t1');
    expect(registry.list().map((x) => x.id)).toEqual(['c']);
    expect(changes).toBe(2);
    registry.removeByToken('t-none');
    expect(changes).toBe(2);
  });
});

describe('views', () => {
  it('list(profile): apps of that profile or every profile, resources of that profile or unassigned', () => {
    registry.register(token('t1'), reg('ctd-overlay', { resources: [overlay('a', 'default'), overlay('d', dprtmnt), overlay('n', null)] }));
    registry.register(token('t2', dprtmnt), reg('ctd-overlay-dprtmnt', { resources: [overlay('d2', dprtmnt)] }));
    expect(registry.list().map((a) => a.id)).toEqual(['ctd-overlay', 'ctd-overlay-dprtmnt']);
    const forDefault = registry.list('default');
    expect(forDefault.map((a) => a.id)).toEqual(['ctd-overlay']);
    expect(forDefault[0]!.resources.map((r) => r.id)).toEqual(['a', 'n']);
    const forD = registry.list(dprtmnt);
    expect(forD.map((a) => [a.id, a.resources.map((r) => r.id)])).toEqual([
      ['ctd-overlay', ['d', 'n']],
      ['ctd-overlay-dprtmnt', ['d2']],
    ]);
    expect(appsForProfile(registry.list(), null)).toHaveLength(2);
    expect(publicApp(registry.list()[0]!)).not.toHaveProperty('tokenId');
  });

  it('overlaysFor: every overlay assigned to the profile, from every app', () => {
    registry.register(token('t1'), reg('ctd-overlay', { resources: [overlay('a', 'default'), overlay('d', dprtmnt, { meta: { canvas: 'landscape' } }), overlay('n', null)] }));
    registry.register(token('t2', dprtmnt), reg('other', { name: 'Other', resources: [overlay('d2', dprtmnt), { type: 'scene', id: 's', name: 'S', profileId: dprtmnt }] }));
    expect(overlaysFor(registry.list(), dprtmnt)).toEqual([
      {
        appId: 'ctd-overlay',
        appName: 'CTD Overlay',
        appOnline: true,
        id: 'd',
        name: 'Overlay d',
        url: 'http://10.20.30.40:30200/o/d?key=k',
        width: 1920,
        height: 1080,
        meta: { canvas: 'landscape' },
      },
      { appId: 'other', appName: 'Other', appOnline: true, id: 'd2', name: 'Overlay d2', url: 'http://10.20.30.40:30200/o/d2?key=k', width: 1920, height: 1080 },
    ]);
    expect(overlaysFor(registry.list(), 'default').map((o) => o.id)).toEqual(['a']);
  });
});
