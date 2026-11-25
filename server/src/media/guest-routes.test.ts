import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Feed } from '../../../shared/types.js';
import { openDatabase } from '../db/database.js';
import { createGuestFeedsRepo } from '../db/guest-feeds-repo.js';
import { createGuestRoutesRepo } from '../db/guest-routes-repo.js';
import { createRepos } from '../db/repos.js';
import { EventBus } from '../events.js';
import { createSecretBox } from '../security/secretbox.js';
import type { MediaMtxAuthRequest, MediaServer } from '../services.js';
import { authorizeMediaRequest, type IngestAuthState } from './authorize.js';
import type { MtxPath } from './feed-state.js';
import { DEFAULT_GUEST_LIMITS, GuestFeeds } from './guest-feeds.js';
import { GuestRoutes, guestRouteSecretScope } from './guest-routes.js';
import { feedPath, guestPath, parseFeedPath } from './paths.js';
import { routeTargetProblem } from './route-target.js';
import { captureLogger, fakeSpawn, flush } from './test-helpers.js';

const KEY = 'live_sk_TESTKEY0000000000abcdef';
const OBS_KEY = 'obs-landscape-key-0000000000';
const LAN_SELF = '192.168.1.10';

function setup(opts: { live?: boolean; lookup?: Record<string, string[]> } = {}) {
  const db = openDatabase(':memory:');
  const repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
  db.prepare("INSERT INTO profiles (id, name, slug, color, created_at, updated_at) VALUES ('club', 'Club', 'club', NULL, 'x', 'x')").run();
  const bus = new EventBus();
  const cap = captureLogger();
  const guests = new GuestFeeds({ repo: createGuestFeedsRepo(db), secrets: repos.secrets, bus, log: cap.log, limits: DEFAULT_GUEST_LIMITS });
  guests.attachMedia({ kick: async () => true });
  const spawn = fakeSpawn();
  const obsOnline = new Set<string>();
  const live = { value: opts.live ?? false };
  const routes = new GuestRoutes({
    config: { rtmpPort: 1935, ffmpegBin: 'ffmpeg' },
    repo: createGuestRoutesRepo(db),
    guests,
    secrets: repos.secrets,
    settings: repos.settings,
    profiles: repos.profiles,
    bus,
    log: cap.log,
    isLive: () => live.value,
    selfHosts: () => ['relay.example.com'],
    lookup: async (host) => opts.lookup?.[host] ?? ['203.0.113.50'],
    localAddresses: () => ['127.0.0.1', LAN_SELF],
    supervisorDeps: { spawn: spawn.spawn, probeCapabilities: async () => ({ multitrack: true }) },
  });
  const media = {
    guestReadUrl: (slot: string) => `rtmp://127.0.0.1:1935/${guestPath(slot)}?user=internal&pass=ReaderPassword000`,
    feed: (profileId: string, feed: Feed) => ({ online: obsOnline.has(`${profileId}|${feed}`) }),
  } as unknown as MediaServer;
  routes.attachMedia(media);
  const path = (slot: string, online = true): MtxPath => ({
    name: guestPath(slot),
    online,
    onlineTime: '2026-11-24T20:00:00Z',
    inboundBytes: 0,
    tracks2: online
      ? [
          { codec: 'H264', codecProps: { width: 1280, height: 720 } },
          { codec: 'MPEG-4 Audio', codecProps: { sampleRate: 48000, channelCount: 2 } },
        ]
      : [],
  });
  let t = 1_000_000;
  const send = (slot: string, online: boolean) => {
    t += 1000;
    guests.apply(new Map(online ? [[guestPath(slot), path(slot)]] : []), t);
  };
  const auth: IngestAuthState = {
    readerPassword: 'ReaderPassword000',
    publishKey: (route) => (route.slug === null ? OBS_KEY : route.slug === 'club' ? 'obs-club-key-000000000000' : null),
    routeKey: (route) => routes.routeKey(route.slug === null ? 'default' : route.slug, route.feed),
    obsPublished: (route) => routes.obsPublished(route.slug === null ? 'default' : route.slug, route.feed),
  };
  return { db, repos, bus, guests, routes, spawn, obsOnline, live, send, auth, logText: cap.text };
}

const publishReq = (path: string, key: string, ip = '127.0.0.1'): MediaMtxAuthRequest => ({
  user: '',
  password: '',
  ip,
  action: 'publish',
  path,
  protocol: 'rtmp',
  id: null,
  query: `key=${key}`,
});

describe('GuestRoutes: CRUD and keys', () => {
  it('adds custom servers (max 3) and profile inputs; never returns or logs the stream key', async () => {
    const s = setup();
    const g = await s.guests.create('default', 'Cam');
    const a = await s.routes.create('default', g.slot, { kind: 'rtmp', url: 'rtmps://live.example.com/app', streamKey: KEY });
    expect(a).toMatchObject({ slot: g.slot, profileId: 'default', name: 'live.example.com', auto: false, active: false, state: 'idle' });
    expect(a.target).toEqual({ kind: 'rtmp', host: 'rtmps://live.example.com', url: 'rtmps://live.example.com/app', hasKey: true });
    // The key is encrypted at rest, in its own scope.
    expect(await s.repos.secrets.scoped(guestRouteSecretScope(a.id)).get('streamKey')).toBe(KEY);
    expect(JSON.stringify(s.db.prepare('SELECT * FROM guest_routes').all())).not.toContain(KEY);
    await s.routes.create('default', g.slot, { kind: 'rtmp', url: 'rtmp://b.example.com/app' });
    await s.routes.create('default', g.slot, { kind: 'rtmp', url: 'rtmp://c.example.com/app' });
    await expect(s.routes.create('default', g.slot, { kind: 'rtmp', url: 'rtmp://d.example.com/app' })).rejects.toMatchObject({ statusCode: 409, code: 'limit' });

    const p = await s.routes.create('default', g.slot, { kind: 'profile', profileId: 'club', feed: 'vertical' });
    expect(p.target).toEqual({ kind: 'profile', profileId: 'club', profileName: 'Club', feed: 'vertical' });
    await expect(s.routes.create('default', g.slot, { kind: 'profile', profileId: 'club', feed: 'vertical' })).rejects.toMatchObject({ code: 'exists' });
    await expect(s.routes.create('default', g.slot, { kind: 'profile', profileId: 'nope', feed: 'vertical' })).rejects.toMatchObject({ code: 'unknown_profile' });

    // Non-admin view (external API): no URL path, no key.
    const plain = s.routes.list('default', g.slot, false);
    expect(plain).toHaveLength(4);
    expect(JSON.stringify(plain)).not.toContain(KEY);
    expect(JSON.stringify(plain)).not.toContain('/app');
    expect(JSON.stringify(s.routes.list('default', g.slot, true))).not.toContain(KEY);
    // Another profile can't see this slot's routes.
    expect(() => s.routes.list('club', g.slot)).toThrow(/Guest feed not found/);
    // Inbound view of the target profile.
    expect(s.routes.forProfile('club').inbound.map((r) => r.id)).toEqual([p.id]);

    const upd = await s.routes.update('default', g.slot, a.id, { name: 'Backup', streamKey: '' });
    expect(upd).toMatchObject({ name: 'Backup', target: { hasKey: false } });
    expect(await s.repos.secrets.scoped(guestRouteSecretScope(a.id)).get('streamKey')).toBeNull();
    await s.routes.update('default', g.slot, a.id, { streamKey: KEY });
    await s.routes.remove('default', g.slot, a.id);
    expect(await s.repos.secrets.scoped(guestRouteSecretScope(a.id)).get('streamKey')).toBeNull();
    expect(s.routes.list('default', g.slot)).toHaveLength(3);
    expect(s.logText()).not.toContain(KEY);
  });

  it('removing the guest slot or the target profile removes its routes', async () => {
    const s = setup();
    const g = await s.guests.create('default', 'Cam');
    await s.routes.create('default', g.slot, { kind: 'profile', profileId: 'club', feed: 'landscape' });
    s.db.prepare("DELETE FROM profiles WHERE id = 'club'").run();
    expect(s.routes.list('default', g.slot)).toHaveLength(0);
    await s.routes.create('default', g.slot, { kind: 'rtmp', url: 'rtmp://a.example.com/app' });
    await s.guests.remove('default', g.slot);
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM guest_routes').get()?.n).toBe(0);
  });
});

describe('route target validation', () => {
  const policy = { allowLan: true, rtmpPort: 1935, selfHosts: ['relay.example.com'], localAddresses: () => ['127.0.0.1', LAN_SELF], lookup: async () => ['203.0.113.50'] };
  it.each([
    ['file:///etc/passwd', /rtmp/],
    ['pipe:1', /rtmp/],
    ['http://live.example.com/app', /rtmp/],
    ['srt://live.example.com:9000', /rtmp/],
    ['rtmp://127.0.0.1/live', /loopback/],
    ['rtmp://[::1]/live', /loopback/],
    ['rtmp://localhost/live', /localhost/],
    ['rtmp://169.254.169.254/latest', /link-local/],
    ['rtmp://[fe80::1]/live', /link-local/],
    ['rtmp://0.0.0.0/live', /unspecified/],
    ['rtmp://user:pass@live.example.com/app', /user name/],
    [`rtmp://${LAN_SELF}/guest`, /own RTMP port/],
    [`rtmp://${LAN_SELF}:1935/live`, /own RTMP port/],
    ['rtmp://relay.example.com/guest', /own RTMP port/],
  ])('refuses %s', async (url, why) => {
    expect(await routeTargetProblem(url, null, policy)).toMatch(why);
  });
  it('allows public and LAN servers by default; the owner can turn LAN targets off', async () => {
    expect(await routeTargetProblem('rtmps://live.example.com:443/app', 'abc', policy)).toBeNull();
    expect(await routeTargetProblem('rtmp://192.0.2.10/app', null, policy)).toBeNull();
    expect(await routeTargetProblem('rtmp://192.168.1.50/app', null, policy)).toBeNull();
    expect(await routeTargetProblem(`rtmp://${LAN_SELF}:1936/app`, null, policy)).toBeNull(); // another service on this box
    expect(await routeTargetProblem('rtmp://192.168.1.50/app', null, { ...policy, allowLan: false })).toMatch(/private LAN/);
    expect(await routeTargetProblem('rtmp://10.0.0.5/app', null, { ...policy, allowLan: false })).toMatch(/private LAN/);
    // A name that resolves to loopback is refused like the literal.
    expect(await routeTargetProblem('rtmp://sneaky.example.com/app', null, { ...policy, lookup: async () => ['127.0.0.1'] })).toMatch(/loopback/);
    expect(await routeTargetProblem('rtmp://live.example.com/app', 'bad key', policy)).toMatch(/spaces/);
  });
  it('the owner setting applies to new routes', async () => {
    const s = setup();
    const g = await s.guests.create('default', 'Cam');
    await s.routes.create('default', g.slot, { kind: 'rtmp', url: 'rtmp://192.168.1.50/app' });
    expect(s.routes.setSettings({ allowLan: false })).toEqual({ allowLan: false });
    await expect(s.routes.create('default', g.slot, { kind: 'rtmp', url: 'rtmp://192.168.1.51/app' })).rejects.toMatchObject({ statusCode: 400, code: 'invalid_target' });
  });
});

describe('GuestRoutes: running with the guest feed', () => {
  it('a custom server route starts by hand only while the guest sends, copies, and stops with the guest', async () => {
    const s = setup();
    const g = await s.guests.create('default', 'Cam');
    const r = await s.routes.create('default', g.slot, { kind: 'rtmp', url: 'rtmps://live.example.com/app', streamKey: KEY });
    await expect(s.routes.start('default', g.slot, r.id)).rejects.toMatchObject({ statusCode: 409, code: 'feed_offline' });
    s.send(g.slot, true);
    const started = await s.routes.start('default', g.slot, r.id);
    expect(started).toMatchObject({ active: true, state: 'starting' });
    await flush(20);
    const call = s.spawn.last();
    expect(call).toBeDefined();
    const args = call!.args.join(' ');
    expect(args).toContain(`-i rtmp://127.0.0.1:1935/guest/${g.slot}?user=internal`);
    expect(args).toContain('-c copy');
    expect(args).not.toMatch(/libx264|-c:v/);
    expect(call!.args.at(-1)).toBe(`rtmps://live.example.com/app/${KEY}`);
    // The guest stops: the route stops (and a manual one stays stopped when they come back).
    s.send(g.slot, false);
    await flush(20);
    expect(s.routes.get('default', g.slot, r.id)).toMatchObject({ active: false, state: 'idle' });
    expect(call!.child.signals.length).toBeGreaterThan(0);
    s.send(g.slot, true);
    await flush(20);
    expect(s.routes.get('default', g.slot, r.id).active).toBe(false);
    expect(s.logText()).not.toContain(KEY);
  });

  it('an automatic route follows the guest: on when they send, off when they stop', async () => {
    const s = setup();
    const g = await s.guests.create('default', 'Cam');
    const r = await s.routes.create('default', g.slot, { kind: 'rtmp', url: 'rtmp://live.example.com/app', auto: true });
    expect(s.spawn.calls).toHaveLength(0);
    s.send(g.slot, true);
    await flush(20);
    expect(s.routes.get('default', g.slot, r.id).active).toBe(true);
    expect(s.spawn.calls).toHaveLength(1);
    s.send(g.slot, false);
    await flush(20);
    expect(s.routes.get('default', g.slot, r.id).active).toBe(false);
    s.send(g.slot, true);
    await flush(20);
    expect(s.routes.get('default', g.slot, r.id).active).toBe(true);
    expect(s.spawn.calls).toHaveLength(2);
  });

  it('a profile route republishes into the input with a one-time key the auth hook takes from loopback only', async () => {
    const s = setup();
    const g = await s.guests.create('club', 'Cam');
    const r = await s.routes.create('club', g.slot, { kind: 'profile', profileId: 'default', feed: 'landscape' });
    s.send(g.slot, true);
    await s.routes.start('club', g.slot, r.id);
    await flush(20);
    const out = s.spawn.last()!.args.at(-1)!;
    expect(out).toMatch(new RegExp(`^rtmp://127\\.0\\.0\\.1:1935/${feedPath('landscape')}\\?key=`));
    const key = new URL(out).searchParams.get('key')!;
    expect(s.routes.isRouted('default', 'landscape')).toBe(true);
    expect(s.routes.routedSource('default', 'landscape')).toMatchObject({ slot: g.slot, name: 'Cam' });
    expect(authorizeMediaRequest(publishReq(feedPath('landscape'), key), s.auth)).toBe(true);
    expect(authorizeMediaRequest(publishReq(feedPath('landscape'), key, '198.51.100.7'), s.auth)).toBe(false);
    expect(authorizeMediaRequest(publishReq(feedPath('vertical'), key), s.auth)).toBe(false);
    expect(authorizeMediaRequest(publishReq(feedPath('landscape', 'club'), key), s.auth)).toBe(false);
    // Never a guest path, and parseFeedPath still never names one.
    expect(parseFeedPath(guestPath(g.slot))).toBeNull();
    // Stop: the key dies with the route.
    await s.routes.stop('club', g.slot, r.id);
    expect(authorizeMediaRequest(publishReq(feedPath('landscape'), key), s.auth)).toBe(false);
    expect(s.routes.isRouted('default', 'landscape')).toBe(false);
  });

  it("refuses to take an input OBS is sending, or one another route holds; OBS coming back stops the route", async () => {
    const s = setup();
    const g1 = await s.guests.create('default', 'Cam 1');
    const g2 = await s.guests.create('default', 'Cam 2');
    const r1 = await s.routes.create('default', g1.slot, { kind: 'profile', profileId: 'club', feed: 'landscape' });
    const r2 = await s.routes.create('default', g2.slot, { kind: 'profile', profileId: 'club', feed: 'landscape' });
    s.send(g1.slot, true);
    s.guests.apply(
      new Map([
        [guestPath(g1.slot), { name: guestPath(g1.slot), online: true, onlineTime: 'x', inboundBytes: 0, tracks2: [{ codec: 'H264', codecProps: { width: 1280, height: 720 } }] }],
        [guestPath(g2.slot), { name: guestPath(g2.slot), online: true, onlineTime: 'x', inboundBytes: 0, tracks2: [{ codec: 'H264', codecProps: { width: 1280, height: 720 } }] }],
      ]),
      2_000_000,
    );
    s.obsOnline.add('club|landscape');
    await expect(s.routes.start('default', g1.slot, r1.id)).rejects.toMatchObject({ statusCode: 409, code: 'input_busy', message: expect.stringMatching(/OBS is already sending Landscape to "Club"/) });
    expect(s.spawn.calls).toHaveLength(0);
    s.obsOnline.delete('club|landscape');
    await s.routes.start('default', g1.slot, r1.id);
    await expect(s.routes.start('default', g2.slot, r2.id)).rejects.toMatchObject({ code: 'input_busy', message: expect.stringMatching(/Another guest feed/) });
    // OBS publishes with its own key: the route stands down, no silent override either way.
    expect(authorizeMediaRequest(publishReq(feedPath('landscape', 'club'), 'obs-club-key-000000000000', '192.168.1.20'), s.auth)).toBe(true);
    await flush(20);
    expect(s.routes.get('default', g1.slot, r1.id)).toMatchObject({ active: false, state: 'blocked', message: expect.stringMatching(/OBS started sending Landscape/) });
    expect(s.routes.isRouted('club', 'landscape')).toBe(false);
  });

  it('an auto profile route does not start into a live profile when its guest comes online', async () => {
    const s = setup();
    const g = await s.guests.create('default', 'Cam');
    const r = await s.routes.create('default', g.slot, { kind: 'profile', profileId: 'club', feed: 'landscape', auto: true });
    // "Club" is live and its OBS landscape feed dropped for a moment: the guest appearing must not take the input.
    s.live.value = true;
    s.send(g.slot, true);
    await flush(20);
    expect(s.spawn.calls).toHaveLength(0);
    expect(s.routes.isRouted('club', 'landscape')).toBe(false);
    expect(s.routes.get('default', g.slot, r.id)).toMatchObject({ active: false, state: 'blocked', message: expect.stringMatching(/is live/) });
  });

  it('during a live, an auto route resumes into an input it was feeding, but not one OBS took back', async () => {
    const s = setup();
    const g = await s.guests.create('default', 'Cam');
    const r = await s.routes.create('default', g.slot, { kind: 'profile', profileId: 'club', feed: 'landscape', auto: true });
    s.send(g.slot, true);
    await flush(20);
    expect(s.spawn.calls).toHaveLength(1);
    s.spawn.last()!.child.stdout.write('fps=30.00\nbitrate=2500.0kbits/s\ntotal_size=1000\nout_time_us=2000000\nspeed=1.00x\nprogress=continue\n');
    await flush(20);
    expect(s.routes.get('default', g.slot, r.id).state).toBe('running');
    // "Club" goes live on the guest; the guest drops and comes back: the route resumes, like OBS reconnecting.
    s.live.value = true;
    s.send(g.slot, false);
    await flush(20);
    s.send(g.slot, true);
    await flush(20);
    expect(s.spawn.calls).toHaveLength(2);
    expect(s.routes.isRouted('club', 'landscape')).toBe(true);
    // OBS publishes on that input: the route stands down, and OBS is the source from now on.
    expect(authorizeMediaRequest(publishReq(feedPath('landscape', 'club'), 'obs-club-key-000000000000', '192.168.1.20'), s.auth)).toBe(true);
    await flush(20);
    expect(s.routes.isRouted('club', 'landscape')).toBe(false);
    // OBS drops for a moment, the guest drops and comes back: the route does not take the live input.
    s.send(g.slot, false);
    await flush(20);
    s.send(g.slot, true);
    await flush(20);
    expect(s.spawn.calls).toHaveLength(2);
    expect(s.routes.get('default', g.slot, r.id)).toMatchObject({ active: false, state: 'blocked', message: expect.stringMatching(/is live/) });
  });

  it('a profile route can not be started or stopped by hand while that profile is live', async () => {
    const s = setup();
    const g = await s.guests.create('default', 'Cam');
    const r = await s.routes.create('default', g.slot, { kind: 'profile', profileId: 'club', feed: 'vertical' });
    s.send(g.slot, true);
    s.live.value = true;
    await expect(s.routes.start('default', g.slot, r.id)).rejects.toMatchObject({ statusCode: 409, code: 'session_live' });
    s.live.value = false;
    await s.routes.start('default', g.slot, r.id);
    s.live.value = true;
    await expect(s.routes.stop('default', g.slot, r.id)).rejects.toMatchObject({ code: 'session_live' });
    await expect(s.routes.remove('default', g.slot, r.id)).rejects.toMatchObject({ code: 'session_live' });
    // The guest stopping still stops it (like OBS stopping): the input goes offline as normal.
    s.send(g.slot, false);
    await flush(20);
    expect(s.routes.get('default', g.slot, r.id).active).toBe(false);
    // Custom server routes are not tied to a profile's live.
    const c = await s.routes.create('default', g.slot, { kind: 'rtmp', url: 'rtmp://live.example.com/app' });
    s.send(g.slot, true);
    await expect(s.routes.start('default', g.slot, c.id)).resolves.toMatchObject({ active: true });
  });

  it('push failures are scrubbed of the stream key', async () => {
    const s = setup();
    const g = await s.guests.create('default', 'Cam');
    const r = await s.routes.create('default', g.slot, { kind: 'rtmp', url: 'rtmp://live.example.com/app', streamKey: KEY });
    s.send(g.slot, true);
    await s.routes.start('default', g.slot, r.id);
    await flush(20);
    const child = s.spawn.last()!.child;
    child.stderr.write(`[rtmp @ 0x1] Cannot open connection rtmp://live.example.com/app/${KEY}: Connection refused\n`);
    await flush(5);
    child.exit(1);
    await flush(20);
    const view = s.routes.get('default', g.slot, r.id, true);
    expect(view.state).toBe('retrying');
    expect(view.message ?? '').not.toContain(KEY);
    expect(s.logText()).not.toContain(KEY);
  });
});
