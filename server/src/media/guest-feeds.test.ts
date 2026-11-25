import crypto from 'node:crypto';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { createGuestFeedsRepo } from '../db/guest-feeds-repo.js';
import { createRepos } from '../db/repos.js';
import { EventBus } from '../events.js';
import { createSecretBox } from '../security/secretbox.js';
import { authorizeMediaRequest, type IngestAuthState } from './authorize.js';
import type { MtxPath } from './feed-state.js';
import { DEFAULT_GUEST_LIMITS, GUEST_OVER_LIMIT_MS, GuestFeedError, GuestFeeds, guestSecretScope, type GuestFeedEvent, type GuestFeedLimits, type GuestFeedsChangedEvent } from './guest-feeds.js';
import { buildMediaMtxConfig } from './mediamtx-config.js';
import { feedForPath, GUEST_PATHS_REGEX, guestPath, parseFeedPath, parseGuestPath } from './paths.js';
import type { MediaMtxAuthRequest } from '../services.js';

const log = pino({ level: 'silent' });
const READER = 'ReaderPassword0000000000';

function setup(limits: Partial<GuestFeedLimits> = {}) {
  let t = 1_000_000;
  const db = openDatabase(':memory:');
  const repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
  db.prepare("INSERT INTO profiles (id, name, slug, color, created_at, updated_at) VALUES ('club', 'Club', 'club', NULL, 'x', 'x')").run();
  const bus = new EventBus();
  const events: GuestFeedEvent[] = [];
  const changes: GuestFeedsChangedEvent[] = [];
  const feeds: unknown[] = [];
  bus.on('guest-feed', (e) => events.push(e));
  bus.on('guest-feeds-changed', (e) => changes.push(e));
  bus.on('feed', (f) => feeds.push(f));
  const guests = new GuestFeeds({ repo: createGuestFeedsRepo(db), secrets: repos.secrets, bus, log, limits: { ...DEFAULT_GUEST_LIMITS, ...limits }, now: () => t });
  const kicked: string[] = [];
  guests.attachMedia({
    kick: async (path) => {
      kicked.push(path);
      return true;
    },
  });
  const auth: IngestAuthState = {
    readerPassword: READER,
    publishKey: (route) => (route.slug === null ? `obs-${route.feed}-key-000000000` : null),
    guestKey: (slot) => guests.guestKey(slot),
    guestExists: (slot) => guests.guestExists(slot),
  };
  const path = (slot: string, over: Partial<MtxPath> = {}): MtxPath => ({
    name: guestPath(slot),
    online: true,
    onlineTime: '2026-11-24T20:00:00Z',
    inboundBytes: 0,
    tracks2: [
      { codec: 'H264', codecProps: { width: 1280, height: 720 } },
      { codec: 'MPEG-4 Audio', codecProps: { sampleRate: 48000, channelCount: 2 } },
    ],
    ...over,
  });
  const apply = (...items: MtxPath[]) => guests.apply(new Map(items.map((p) => [p.name, p])), t);
  return { db, repos, bus, guests, events, changes, feeds, kicked, auth, path, apply, tick: (ms: number) => (t += ms), now: () => t };
}

const req = (over: Partial<MediaMtxAuthRequest>): MediaMtxAuthRequest => ({ user: '', password: '', ip: '198.51.100.20', action: 'publish', path: '', protocol: 'rtmp', id: null, query: '', ...over });

describe('GuestFeeds: slots and keys', () => {
  it('adds slots up to the cap, renames, lists without keys, and refuses bad names', async () => {
    const s = setup({ maxSlots: 2 });
    const a = await s.guests.create('default', '  Remote   cam 1 ');
    expect(a).toMatchObject({ name: 'Remote cam 1', key: 'active', online: false, problem: null, limitedAt: null });
    await s.guests.create('default', 'B');
    await expect(s.guests.create('default', 'C')).rejects.toMatchObject({ statusCode: 409, code: 'limit' });
    await expect(s.guests.create('club', '')).rejects.toMatchObject({ statusCode: 400, code: 'invalid' });
    expect(s.guests.rename('default', a.slot, 'Cam A').name).toBe('Cam A');
    expect(() => s.guests.rename('club', a.slot, 'x')).toThrow(GuestFeedError); // another profile's slot
    const list = s.guests.list('default');
    expect(list).toMatchObject({ profileId: 'default', maxSlots: 2, maxViewers: 2, warnAboveKbps: 8000, maxKbps: 20000 });
    expect(list.guestFeeds.map((g) => g.name)).toEqual(['Cam A', 'B']);
    expect(JSON.stringify(list)).not.toContain(await s.guests.ingestKey('default', a.slot));
    expect(s.changes.map((c) => c.profileId)).toEqual(['default', 'default', 'default']);
  });

  it('stores keys encrypted per profile; a slot key only publishes on its own path', async () => {
    const s = setup();
    const a = await s.guests.create('default', 'A');
    const b = await s.guests.create('club', 'B');
    const keyA = (await s.guests.ingestKey('default', a.slot))!;
    expect(keyA).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(await s.repos.secrets.scoped(guestSecretScope('default')).get(a.slot)).toBe(keyA);
    expect(authorizeMediaRequest(req({ path: guestPath(a.slot), query: `key=${keyA}` }), s.auth)).toBe(true);
    expect(authorizeMediaRequest(req({ path: guestPath(b.slot), query: `key=${keyA}` }), s.auth)).toBe(false);
    expect(authorizeMediaRequest(req({ path: guestPath(a.slot), query: 'key=wrongwrongwrongwrong' }), s.auth)).toBe(false);
    expect(authorizeMediaRequest(req({ path: guestPath('zzzzzzzzzz'), query: `key=${keyA}` }), s.auth)).toBe(false);
    // A guest key is no OBS key, and an OBS key is no guest key.
    expect(authorizeMediaRequest(req({ path: 'live/landscape', query: `key=${keyA}` }), s.auth)).toBe(false);
    expect(authorizeMediaRequest(req({ path: guestPath(a.slot), query: 'key=obs-landscape-key-000000000' }), s.auth)).toBe(false);
  });

  it('rotate: the old key stops at once, the guest is disconnected, its offline is expected', async () => {
    const s = setup();
    const a = await s.guests.create('default', 'A');
    const old = (await s.guests.ingestKey('default', a.slot))!;
    s.apply(s.path(a.slot));
    const next = await s.guests.rotateKey('default', a.slot);
    expect(next).not.toBe(old);
    expect(authorizeMediaRequest(req({ path: guestPath(a.slot), query: `key=${old}` }), s.auth)).toBe(false);
    expect(authorizeMediaRequest(req({ path: guestPath(a.slot), query: `key=${next}` }), s.auth)).toBe(true);
    expect(s.kicked).toEqual([guestPath(a.slot)]);
    expect(s.changes.at(-1)).toEqual({ profileId: 'default', removed: [], rekeyed: [a.slot] });
    s.tick(1000);
    s.apply(); // MediaMTX: the path is gone
    expect(s.events.at(-1)).toMatchObject({ expectedOffline: true, feed: { online: false } });
  });

  it('revoke: no key, nobody can publish until a rotate; ingest details have no key', async () => {
    const s = setup();
    const a = await s.guests.create('default', 'A');
    const key = (await s.guests.ingestKey('default', a.slot))!;
    expect((await s.guests.revokeKey('default', a.slot)).key).toBe('revoked');
    expect(await s.guests.ingestKey('default', a.slot)).toBeNull();
    expect(await s.repos.secrets.scoped(guestSecretScope('default')).get(a.slot)).toBeNull();
    expect(authorizeMediaRequest(req({ path: guestPath(a.slot), query: `key=${key}` }), s.auth)).toBe(false);
    expect(s.kicked).toEqual([guestPath(a.slot)]);
    const fresh = await s.guests.rotateKey('default', a.slot);
    expect(s.guests.feed('default', a.slot)?.key).toBe('active');
    expect(authorizeMediaRequest(req({ path: guestPath(a.slot), query: `key=${fresh}` }), s.auth)).toBe(true);
  });

  it('remove and profile removal drop the slot, its key and its guest', async () => {
    const s = setup();
    const a = await s.guests.create('default', 'A');
    const b = await s.guests.create('club', 'B');
    const keyB = (await s.guests.ingestKey('club', b.slot))!;
    await s.guests.remove('default', a.slot);
    expect(s.guests.feed('default', a.slot)).toBeNull();
    expect(s.guests.guestExists(a.slot)).toBe(false);
    await s.guests.profileRemoved('club');
    expect(authorizeMediaRequest(req({ path: guestPath(b.slot), query: `key=${keyB}` }), s.auth)).toBe(false);
    expect(await s.repos.secrets.scoped(guestSecretScope('club')).get(b.slot)).toBeNull();
    expect(s.kicked).toEqual([guestPath(a.slot), guestPath(b.slot)]);
    expect(s.changes.slice(-2).map((c) => c.removed)).toEqual([[a.slot], [b.slot]]);
  });

  it('keys survive a restart (a new service on the same database)', async () => {
    const s = setup();
    const a = await s.guests.create('default', 'A');
    const key = await s.guests.ingestKey('default', a.slot);
    const again = new GuestFeeds({ repo: createGuestFeedsRepo(s.db), secrets: s.repos.secrets, bus: s.bus, log, limits: DEFAULT_GUEST_LIMITS });
    expect(again.guestKey(a.slot)).toBeNull(); // not loaded yet: denied this time, loads in the background
    await again.load();
    expect(again.guestKey(a.slot)).toBe(key);
  });

  it('GUEST_FEEDS_MAX=0: no slots, no publishing, an empty list', async () => {
    const s = setup({ maxSlots: 0 });
    await expect(s.guests.create('default', 'A')).rejects.toMatchObject({ code: 'limit' });
    expect(s.guests.list('default').guestFeeds).toEqual([]);
  });
});

describe('GuestFeeds: state from MediaMTX', () => {
  it('online/offline, resolution, bitrate and the bitrate warning; bitrate-only changes at most every 2 s', async () => {
    const s = setup({ warnAboveKbps: 4000 });
    const a = await s.guests.create('default', 'A');
    s.apply(s.path(a.slot));
    expect(s.events.at(-1)?.feed).toMatchObject({ online: true, video: { codec: 'h264', width: 1280, height: 720 }, audio: { codec: 'aac' }, bitrateWarning: false });
    s.tick(1000);
    s.apply(s.path(a.slot, { inboundBytes: 375_000 })); // 3000 kbps
    const n = s.events.length;
    s.tick(1000);
    s.apply(s.path(a.slot, { inboundBytes: 1_000_000 })); // 5000 kbps over the last second
    expect(s.events.length).toBeLessThanOrEqual(n + 1);
    s.tick(2000);
    s.apply(s.path(a.slot, { inboundBytes: 2_500_000 }));
    expect(s.events.at(-1)?.feed.bitrateWarning).toBe(true);
    s.tick(1000);
    s.apply();
    expect(s.events.at(-1)).toMatchObject({ expectedOffline: false, feed: { online: false, bitrateKbps: null, bitrateWarning: false } });
    expect(s.feeds).toEqual([]); // a guest is never a 'feed' (nothing that pushes listens to it)
  });

  it('codec guard: HEVC is a blocking problem, Opus audio a warning', async () => {
    const s = setup();
    const a = await s.guests.create('default', 'A');
    s.apply(s.path(a.slot, { tracks2: [{ codec: 'H265', codecProps: { width: 1920, height: 1080 } }, { codec: 'MPEG-4 Audio' }] }));
    expect(s.guests.feed('default', a.slot)?.problem).toMatchObject({ reason: 'feed-video-codec', codec: 'hevc', label: 'HEVC', blocking: true });
    expect(s.guests.feed('default', a.slot)?.problem?.message).toContain('Guest feed "A" is HEVC');
    s.apply(s.path(a.slot, { tracks2: [{ codec: 'H264' }, { codec: 'Opus' }] }));
    expect(s.guests.feed('default', a.slot)?.problem).toMatchObject({ reason: 'feed-audio-codec', blocking: false });
  });

  it('hard limit: a guest above maxKbps for 10 s is disconnected and limitedAt is set', async () => {
    const s = setup({ maxKbps: 1000 });
    const a = await s.guests.create('default', 'A');
    let bytes = 0;
    s.apply(s.path(a.slot, { inboundBytes: bytes }));
    for (let i = 0; i < 12; i++) {
      s.tick(1000);
      bytes += 500_000; // 4000 kbps
      s.apply(s.path(a.slot, { inboundBytes: bytes }));
      if (i < 9) expect(s.kicked).toEqual([]);
    }
    expect(s.kicked).toEqual([guestPath(a.slot)]);
    expect(s.guests.feed('default', a.slot)?.limitedAt).not.toBeNull();
    expect(GUEST_OVER_LIMIT_MS).toBe(10_000);
  });

  it('resetAll (MediaMTX stopped) takes every guest offline', async () => {
    const s = setup();
    const a = await s.guests.create('default', 'A');
    s.apply(s.path(a.slot));
    s.guests.resetAll();
    expect(s.guests.feed('default', a.slot)?.online).toBe(false);
  });
});

describe('guest paths: never a feed, never restreamed', () => {
  it('a guest path is not a feed path, and a feed path is not a guest path', () => {
    expect(parseGuestPath('guest/q7m2x9k4tb')).toBe('q7m2x9k4tb');
    expect(parseGuestPath('/guest/q7m2x9k4tb')).toBe('q7m2x9k4tb');
    expect(parseGuestPath('guest/landscape')).toBeNull();
    expect(parseGuestPath('live/landscape')).toBeNull();
    expect(parseFeedPath('guest/q7m2x9k4tb')).toBeNull();
    expect(feedForPath('guest/q7m2x9k4tb')).toBeNull();
  });

  it('only Relay itself (loopback, internal reader) may read a guest path', async () => {
    const s = setup();
    const a = await s.guests.create('default', 'A');
    const read = (over: Partial<MediaMtxAuthRequest>) => authorizeMediaRequest(req({ action: 'read', path: guestPath(a.slot), ip: '127.0.0.1', user: 'internal', password: READER, ...over }), s.auth);
    expect(read({})).toBe(true);
    expect(read({ ip: '198.51.100.20' })).toBe(false);
    expect(read({ password: 'nope' })).toBe(false);
    expect(read({ path: guestPath('zzzzzzzzzz') })).toBe(false);
    expect(read({ action: 'playback' })).toBe(false);
  });

  it('MediaMTX accepts guest/<slot> through one regex path; HLS muxes on demand only', () => {
    const yml = buildMediaMtxConfig({ rtmpPort: 1935, apiPort: 9997, authPort: 9000, hlsPort: 9996 });
    expect(yml).toContain(`"${GUEST_PATHS_REGEX}":`);
    expect(yml).toContain('hlsAlwaysRemux: false');
    expect(GUEST_PATHS_REGEX).toBe('~^guest/[a-z0-9]{10}$');
  });

  it('a destination can only name a feed (landscape/vertical)', async () => {
    const { feedSchema } = await import('../http/validation.js');
    expect(feedSchema.safeParse('guest').success).toBe(false);
    expect(feedSchema.safeParse(guestPath('q7m2x9k4tb')).success).toBe(false);
    expect(feedSchema.safeParse('q7m2x9k4tb').success).toBe(false);
  });

  it('a kick that finds nobody is quiet', async () => {
    const s = setup();
    const a = await s.guests.create('default', 'A');
    const spy = vi.fn(async () => false);
    s.guests.attachMedia({ kick: spy });
    await s.guests.remove('default', a.slot);
    expect(spy).toHaveBeenCalledWith(guestPath(a.slot));
  });
});
