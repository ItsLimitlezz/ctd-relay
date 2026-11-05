import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiTokenInfo, AppResource } from '../../../shared/types.js';
import { EventBus } from '../events.js';
import type { ProfilesRepo } from '../services.js';
import { ApiProblem } from './http.js';
import {
  MAX_APPS_PER_TOKEN,
  MAX_META_BYTES,
  MAX_RESOURCES,
  ONLINE_WINDOW_MS,
  appsForProfile,
  createAppRegistry,
  overlaysFor,
  parseAppRegistration,
  publicApp,
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

    // While the old one is online, a newer token can't take the id.
    const fresh = tk('fresh', '2026-10-17T00:00:00.000Z');
    expect(problem(() => registry.register(fresh, plugin))).toMatchObject({ code: 'app_owned' });
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
