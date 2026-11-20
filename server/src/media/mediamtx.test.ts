import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedState } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import { openDatabase, type Db } from '../db/database.js';
import { createRepos } from '../db/repos.js';
import { EventBus } from '../events.js';
import { createSecretBox } from '../security/secretbox.js';
import type { MediaMtxAuthRequest, MediaServer, Repos } from '../services.js';
import type { MtxPath } from './feed-state.js';
import { createMediaServer, type MediaServerDeps } from './mediamtx.js';
import { captureLogger, fakeSpawn, flush, type FakeChild } from './test-helpers.js';

let tmp: string;
let servers: MediaServer[] = [];
let dbs: Db[] = [];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ctd-media-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.map((s) => s.stop()));
  servers = [];
  for (const db of dbs) db.close();
  dbs = [];
  await fs.rm(tmp, { recursive: true, force: true });
});

/** A fake MediaMTX control API backed by a mutable path list (regex paths appear while in use). */
function fakeApi() {
  const paths: MtxPath[] = [
    { name: 'live/landscape', online: false, tracks2: [], inboundBytes: 0, source: null },
    { name: 'live/vertical', online: false, tracks2: [], inboundBytes: 0, source: null },
  ];
  const requests: { method: string; url: string }[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ method: init?.method ?? 'GET', url });
    if (url.includes('/v3/paths/list')) return new Response(JSON.stringify({ itemCount: paths.length, pageCount: 1, items: paths }));
    if (url.includes('/kick/')) return new Response(null, { status: 200 });
    return new Response('not found', { status: 404 });
  });
  const set = (name: string, patch: Partial<MtxPath>) => {
    let p = paths.find((x) => x.name === name);
    if (!p) {
      p = { name, online: false, tracks2: [], inboundBytes: 0, source: null };
      paths.push(p);
    }
    Object.assign(p, patch);
  };
  const remove = (name: string) => {
    const i = paths.findIndex((x) => x.name === name);
    if (i >= 0) paths.splice(i, 1);
  };
  return { fetch: fetchFn as unknown as typeof fetch, requests, set, remove };
}

async function setup(opts: { bin?: string; seed?: (repos: Repos) => Promise<void>; deps?: MediaServerDeps; config?: Partial<AppConfig> } = {}) {
  let bin = opts.bin;
  if (bin === undefined) {
    // Own folder: on Linux <tmp>/mediamtx would collide with the config dir <dataDir>/mediamtx/.
    bin = path.join(tmp, 'bin', process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');
    await fs.mkdir(path.dirname(bin), { recursive: true });
    await fs.writeFile(bin, '');
    await fs.chmod(bin, 0o755);
  }
  const config = { dataDir: tmp, rtmpPort: 1935, mediamtxApiPort: 9997, mediamtxBin: bin, ...opts.config } as AppConfig;
  const bus = new EventBus();
  const feedEvents: FeedState[] = [];
  bus.on('feed', (s) => feedEvents.push(s));
  const db = openDatabase(':memory:');
  dbs.push(db);
  const repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
  await opts.seed?.(repos);
  const sp = fakeSpawn();
  const api = fakeApi();
  const cap = captureLogger();
  const server = createMediaServer(
    { config, bus, log: cap.log, repos },
    { spawn: sp.spawn, fetch: api.fetch, readyTimeoutMs: 0, pollIntervalMs: 10, ...opts.deps },
  );
  servers.push(server);
  const configPath = path.join(tmp, 'mediamtx', 'mediamtx.yml');
  const authUrl = async () => {
    const yml = await fs.readFile(configPath, 'utf8');
    const port = /authHTTPAddress: "http:\/\/127\.0\.0\.1:(\d+)\/auth"/.exec(yml)?.[1];
    return `http://127.0.0.1:${port}/auth`;
  };
  const child = (): FakeChild => sp.last()!.child;
  const secret = (scope: string, key: string) => repos.secrets.scoped(scope).get(key);
  return { server, config, bus, feedEvents, repos, secret, sp, api, logs: cap.text, configPath, authUrl, child };
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function postAuth(url: string, body: Record<string, unknown>): Promise<number> {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify({ user: '', password: '', ip: '192.168.1.9', protocol: 'rtmp', id: null, query: '', ...body }) });
  return res.status;
}

const publishReq = (pathName: string, key: string): MediaMtxAuthRequest => ({
  user: '',
  password: '',
  ip: '192.168.1.9',
  action: 'publish',
  path: pathName,
  protocol: 'rtmp',
  id: null,
  query: `key=${key}`,
});

describe('MediaServer: live preview (LL-HLS)', () => {
  it('serves HLS on loopback and tells the proxy where a feed is, with the reader password as a header', async () => {
    const { server, configPath, secret, authUrl, repos } = await setup({ config: { mediamtxHlsPort: 9996 } });
    expect(server.hlsSource?.('default', 'landscape')).toBeNull(); // not started yet
    await server.start();
    const yml = await fs.readFile(configPath, 'utf8');
    expect(yml).toContain('hls: true');
    expect(yml).toContain('hlsAddress: "127.0.0.1:9996"');
    const pass = (await secret('ingest', 'internalReader'))!;
    expect(server.hlsSource?.('default', 'landscape')).toEqual({
      baseUrl: 'http://127.0.0.1:9996/live/landscape/',
      authorization: `Basic ${Buffer.from(`internal:${pass}`).toString('base64')}`,
    });
    const club = repos.profiles.create({ name: 'DPRTMNT', color: null });
    await server.profileAdded(club);
    expect(server.hlsSource?.(club.id, 'vertical')?.baseUrl).toBe(`http://127.0.0.1:9996/live/${club.slug}/vertical/`);
    expect(() => server.hlsSource?.('ghost', 'landscape')).toThrow(/Profile not found/);
    // MediaMTX asks the auth hook when an HLS session starts: the proxy's loopback read is allowed, nothing else.
    const url = await authUrl();
    expect(await postAuth(url, { action: 'read', protocol: 'hls', path: 'live/landscape', ip: '127.0.0.1', user: 'internal', password: pass })).toBe(200);
    expect(await postAuth(url, { action: 'read', protocol: 'hls', path: 'live/landscape', ip: '192.168.1.9', user: 'internal', password: pass })).toBe(401);
    expect(await postAuth(url, { action: 'read', protocol: 'hls', path: 'live/landscape', ip: '127.0.0.1', user: '', password: '' })).toBe(401);
  });

  it('LIVE_PREVIEW_MAX_VIEWERS=0 keeps HLS off; so does a config without an HLS port', async () => {
    const off = await setup({ config: { mediamtxHlsPort: 9996, livePreviewMaxViewers: 0 } });
    await off.server.start();
    expect(await fs.readFile(off.configPath, 'utf8')).toContain('hls: false');
    expect(off.server.hlsSource?.('default', 'landscape')).toBeNull();
    await off.server.stop();
    const none = await setup();
    await none.server.start();
    expect(await fs.readFile(none.configPath, 'utf8')).toContain('hls: false');
    expect(none.server.hlsSource?.('default', 'landscape')).toBeNull();
  });
});

describe('MediaServer (default profile)', () => {
  it('generates keys, writes the config and spawns MediaMTX', async () => {
    const { server, secret, sp, configPath, authUrl } = await setup();
    await server.start();

    for (const k of ['landscape', 'vertical', 'internalReader']) expect(await secret('ingest', k)).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const landscape = (await secret('ingest', 'landscape'))!;
    expect(await server.ingestKeys('default')).toEqual({ landscape, vertical: await secret('ingest', 'vertical') });
    expect(await server.streamKeyField('default', 'landscape')).toBe(`landscape?key=${landscape}`);
    expect(server.appName).toBe('live');

    const yml = await fs.readFile(configPath, 'utf8');
    expect(yml).toContain('rtmpAddress: ":1935"');
    expect(yml).toContain('apiAddress: "127.0.0.1:9997"');
    expect(yml).toContain('"~^live/[a-z0-9-]{1,32}/(landscape|vertical)$":');

    expect(sp.calls).toHaveLength(1);
    expect(sp.calls[0]?.args).toEqual([configPath]);
    expect(sp.calls[0]?.options.cwd).toBe(path.dirname(configPath));

    const url = await authUrl();
    expect(await postAuth(url, { action: 'publish', path: 'live/landscape', query: `key=${landscape}` })).toBe(200);
    expect(await postAuth(url, { action: 'publish', path: 'live/landscape', query: 'key=wrong' })).toBe(401);
    expect(await postAuth(url, { action: 'publish', path: 'live/other', query: `key=${landscape}` })).toBe(401);
    expect(await postAuth(url, { action: 'publish', path: 'live/main/landscape', query: `key=${landscape}` })).toBe(401);
    const pass = (await secret('ingest', 'internalReader'))!;
    expect(await postAuth(url, { action: 'read', path: 'live/landscape', ip: '127.0.0.1', user: 'internal', password: pass })).toBe(200);
    expect(await postAuth(url, { action: 'read', path: 'live/landscape', ip: '192.168.1.9', user: 'internal', password: pass })).toBe(401);

    expect(server.readUrl('default', 'vertical')).toBe(`rtmp://127.0.0.1:1935/live/vertical?user=internal&pass=${pass}`);
  });

  it("keeps the owner's stored keys (OBS settings keep working)", async () => {
    const stored = { landscape: 'AAAAAAAAAAAAAAAAAAAAAAAA', vertical: 'BBBBBBBBBBBBBBBBBBBBBBBB', internalReader: 'CCCCCCCCCCCCCCCCCCCCCCCC' };
    const { server, secret } = await setup({
      seed: async (repos) => {
        for (const [k, v] of Object.entries(stored)) await repos.secrets.scoped('ingest').set(k, v);
      },
    });
    await server.start();
    for (const [k, v] of Object.entries(stored)) expect(await secret('ingest', k)).toBe(v);
    expect(await server.streamKeyField('default', 'landscape')).toBe('landscape?key=AAAAAAAAAAAAAAAAAAAAAAAA');
    expect(await server.streamKeyField('default', 'vertical')).toBe('vertical?key=BBBBBBBBBBBBBBBBBBBBBBBB');
    expect(server.authorize(publishReq('live/landscape', stored.landscape))).toBe(true);
  });

  it('polls the control API and emits feed events', async () => {
    const { server, api, feedEvents } = await setup();
    await server.start();
    expect(server.feeds('default').map((f) => f.online)).toEqual([false, false]);

    api.set('live/landscape', {
      online: true,
      onlineTime: '2026-10-11T17:00:00Z',
      inboundBytes: 1000,
      tracks2: [{ codec: 'H264', codecProps: { width: 1280, height: 720 } }, { codec: 'MPEG-4 Audio', codecProps: { sampleRate: 48000, channelCount: 2 } }],
    });
    await waitFor(() => feedEvents.some((e) => e.online));
    expect(feedEvents[0]).toMatchObject({
      profileId: 'default',
      feed: 'landscape',
      online: true,
      since: '2026-10-11T17:00:00.000Z',
      video: { codec: 'h264', width: 1280, height: 720 },
    });
    expect(server.feed('default', 'landscape').online).toBe(true);
    expect(server.feed('default', 'vertical')).toMatchObject({ profileId: 'default', online: false });

    api.set('live/landscape', { online: false });
    await waitFor(() => feedEvents.at(-1)?.online === false);
    expect(feedEvents.filter((e) => e.feed === 'vertical')).toHaveLength(0); // never changed
  });

  it('measures frame rate and keyframe interval once per OBS connection and publishes them', async () => {
    const probed: string[] = [];
    const { server, api, feedEvents } = await setup({
      deps: {
        probeDelayMs: 10,
        probe: async (url: string) => {
          probed.push(url);
          return { fps: 59.94, keyframeSec: 8.3, keyframeSecIsMinimum: false };
        },
      },
    });
    await server.start();
    api.set('live/landscape', { online: true, onlineTime: '2026-10-11T17:00:00Z', inboundBytes: 1000, tracks2: [{ codec: 'H264', codecProps: { width: 1920, height: 1080 } }] });
    await waitFor(() => feedEvents.some((e) => e.video?.keyframeSec === 8.3));
    expect(server.feed('default', 'landscape').video).toMatchObject({ fps: 59.94, keyframeSec: 8.3 });
    expect(probed).toHaveLength(1);
    expect(probed[0]).toMatch(/^rtmp:\/\/127\.0\.0\.1:\d+\/live\/landscape\?user=/); // the internal reader
    await new Promise((r) => setTimeout(r, 60));
    expect(probed).toHaveLength(1); // not again for the same connection
  });

  it('restarts MediaMTX with backoff after an unexpected exit and keeps feeds offline meanwhile', async () => {
    vi.useFakeTimers();
    const { server, sp, child, logs } = await setup({ deps: { pollIntervalMs: 1000 } });
    await server.start();

    child().stdout.write('2026/10/11 17:00:00 ERR [RTMP] listen tcp :1935: bind: address already in use\n');
    await flush();
    child().exit(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(sp.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sp.calls).toHaveLength(2);

    child().exit(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(sp.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sp.calls).toHaveLength(3);

    expect(logs()).toContain('address already in use');
    expect(logs()).toContain('MediaMTX exited unexpectedly');
  });

  it('logs a clear error and stays offline when the binary is missing', async () => {
    const { server, sp, logs } = await setup({ bin: path.join(tmp, 'nope', 'mediamtx') });
    await expect(server.start()).resolves.toBeUndefined();
    expect(sp.calls).toHaveLength(0);
    expect(logs()).toContain('MediaMTX not found at');
    expect(logs()).toContain('npm run setup-tools');
    expect(server.feeds('default').every((f) => !f.online)).toBe(true);
  });

  it('does not restart when spawning fails with ENOENT', async () => {
    vi.useFakeTimers();
    const { server, sp, child, logs } = await setup({ bin: 'mediamtx-not-on-path' });
    await server.start();
    child().failToSpawn('ENOENT');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sp.calls).toHaveLength(1);
    expect(logs()).toContain('MediaMTX not found at mediamtx-not-on-path');
  });

  it('rotates a key, kicks the current publisher and only accepts the new key', async () => {
    const { server, api, secret } = await setup();
    await server.start();
    const old = (await secret('ingest', 'landscape'))!;
    api.set('live/landscape', { online: true, source: { type: 'rtmpConn', id: 'conn-1' } });

    const next = await server.rotateIngestKey('default', 'landscape');
    expect(next).not.toBe(old);
    expect(next).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(await secret('ingest', 'landscape')).toBe(next);
    expect((await server.ingestKeys('default')).landscape).toBe(next);
    expect(api.requests).toContainEqual({ method: 'POST', url: 'http://127.0.0.1:9997/v3/rtmp/conns/kick/conn-1' });

    expect(server.authorize(publishReq('live/landscape', old))).toBe(false);
    expect(server.authorize(publishReq('live/landscape', next))).toBe(true);
  });

  it('stop() terminates MediaMTX, closes the auth endpoint and marks feeds offline', async () => {
    const { server, api, child, authUrl, feedEvents } = await setup();
    await server.start();
    api.set('live/vertical', { online: true, tracks2: [{ codec: 'H264' }] });
    await waitFor(() => feedEvents.some((e) => e.feed === 'vertical' && e.online));

    const proc = child();
    const url = await authUrl();
    await server.stop();
    expect(proc.signals).toHaveLength(1);
    expect(feedEvents.at(-1)).toMatchObject({ feed: 'vertical', online: false });
    await expect(fetch(url, { method: 'POST', body: '{}' })).rejects.toThrow();
    expect(() => server.readUrl('default', 'landscape')).not.toThrow(); // keys stay cached
  });

  it('forwards MediaMTX log lines without secrets', async () => {
    const { server, child, logs } = await setup();
    await server.start();
    child().stdout.write('2026/10/11 17:00:00 INF [RTMP] [conn 192.168.1.9:5000] opened rtmp://192.168.1.2/live/landscape?key=TOPSECRETKEY9\n');
    child().stderr.write('2026/10/11 17:00:01 WAR [RTMP] query key=TOPSECRETKEY9&pass=hunter22 rejected\n');
    await flush();
    expect(logs()).toContain('mediamtx: INF [RTMP] [conn 192.168.1.9:5000] opened rtmp://192.168.1.2');
    expect(logs()).not.toContain('TOPSECRETKEY9');
    expect(logs()).not.toContain('hunter22');
  });

  it('readUrl() before start() throws', async () => {
    const { server } = await setup();
    expect(() => server.readUrl('default', 'landscape')).toThrow(/not started/);
  });
});

describe('MediaServer (several profiles)', () => {
  async function withClub() {
    let clubId = '';
    const t = await setup({
      seed: async (repos) => {
        clubId = repos.profiles.create({ name: 'DPRTMNT', color: null }).id;
      },
    });
    return { ...t, clubId };
  }

  it('gives each profile its own keys, paths and OBS stream key field', async () => {
    const { server, secret, clubId, logs } = await withClub();
    await server.start();

    const club = await server.ingestKeys(clubId);
    expect(club.landscape).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(await secret(`ingest:${clubId}`, 'landscape')).toBe(club.landscape);
    expect(await secret(`ingest:${clubId}`, 'vertical')).toBe(club.vertical);
    expect(await secret(`ingest:${clubId}`, 'internalReader')).toBeNull(); // shared, stays in 'ingest'
    const main = await server.ingestKeys('default');
    expect(new Set([main.landscape, main.vertical, club.landscape, club.vertical]).size).toBe(4);

    expect(await server.streamKeyField(clubId, 'landscape')).toBe(`dprtmnt/landscape?key=${club.landscape}`);
    expect(await server.streamKeyField(clubId, 'vertical')).toBe(`dprtmnt/vertical?key=${club.vertical}`);
    const pass = encodeURIComponent((await secret('ingest', 'internalReader'))!);
    expect(server.readUrl(clubId, 'vertical')).toBe(`rtmp://127.0.0.1:1935/live/dprtmnt/vertical?user=internal&pass=${pass}`);

    // Two OBS at once: each profile's key only works on its own paths.
    expect(server.authorize(publishReq('live/landscape', main.landscape))).toBe(true);
    expect(server.authorize(publishReq('live/dprtmnt/landscape', club.landscape))).toBe(true);
    expect(server.authorize(publishReq('live/dprtmnt/vertical', club.vertical))).toBe(true);
    expect(server.authorize(publishReq('live/dprtmnt/landscape', main.landscape))).toBe(false);
    expect(server.authorize(publishReq('live/landscape', club.landscape))).toBe(false);
    expect(server.authorize(publishReq('live/dprtmnt/vertical', club.landscape))).toBe(false);
    expect(server.authorize(publishReq('live/other/landscape', club.landscape))).toBe(false);

    expect(logs()).not.toContain(club.landscape);
    expect(logs()).not.toContain(main.landscape);
  });

  it('accepts a profile added while MediaMTX runs, without restarting it', async () => {
    const { server, repos, sp, configPath } = await setup();
    await server.start();
    const yml = await fs.readFile(configPath, 'utf8');

    const club = repos.profiles.create({ name: 'Sunday Club', color: null });
    await server.profileAdded(club);
    const keys = await server.ingestKeys(club.id);
    expect(server.authorize(publishReq('live/sunday-club/landscape', keys.landscape))).toBe(true);
    expect(sp.calls).toHaveLength(1); // same MediaMTX process
    expect(await fs.readFile(configPath, 'utf8')).toBe(yml); // config unchanged
  });

  it('learns a profile it was not told about on its first publish (OBS retries)', async () => {
    const { server, repos, secret } = await setup();
    await server.start();
    const club = repos.profiles.create({ name: 'Late', color: null });
    await repos.secrets.scoped(`ingest:${club.id}`).set('landscape', 'LateLandscapeKey_0123456');
    await repos.secrets.scoped(`ingest:${club.id}`).set('vertical', 'LateVerticalKey_01234567');
    expect(server.authorize(publishReq('live/late/landscape', 'LateLandscapeKey_0123456'))).toBe(false); // loading
    await waitFor(() => server.authorize(publishReq('live/late/landscape', 'LateLandscapeKey_0123456')));
    expect(await secret(`ingest:${club.id}`, 'landscape')).toBe('LateLandscapeKey_0123456'); // not regenerated
  });

  it('tracks each profile feed separately, with profileId on every event', async () => {
    const { server, api, feedEvents, clubId } = await withClub();
    await server.start();
    api.set('live/landscape', { online: true, tracks2: [{ codec: 'H264', codecProps: { width: 1920, height: 1080 } }] });
    api.set('live/dprtmnt/landscape', { online: true, tracks2: [{ codec: 'H264', codecProps: { width: 1280, height: 720 } }] });
    await waitFor(() => feedEvents.filter((e) => e.online).length === 2);
    expect(feedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profileId: 'default', feed: 'landscape', online: true, video: { codec: 'h264', width: 1920, height: 1080 } }),
        expect.objectContaining({ profileId: clubId, feed: 'landscape', online: true, video: { codec: 'h264', width: 1280, height: 720 } }),
      ]),
    );
    expect(server.feeds(clubId).map((f) => [f.profileId, f.feed, f.online])).toEqual([
      [clubId, 'landscape', true],
      [clubId, 'vertical', false],
    ]);
    expect(server.feed('default', 'landscape').video?.width).toBe(1920);

    // The club's OBS stops (its regex path disappears); the default profile stays online.
    api.remove('live/dprtmnt/landscape');
    await waitFor(() => feedEvents.at(-1)?.online === false);
    expect(feedEvents.at(-1)).toMatchObject({ profileId: clubId, feed: 'landscape', online: false });
    expect(server.feed('default', 'landscape').online).toBe(true);
    expect(server.feeds('unknown-profile')).toEqual([
      expect.objectContaining({ profileId: 'unknown-profile', feed: 'landscape', online: false }),
      expect.objectContaining({ profileId: 'unknown-profile', feed: 'vertical', online: false }),
    ]);
  });

  it("rotates one profile's key without touching the others", async () => {
    const { server, api, clubId, secret } = await withClub();
    await server.start();
    const main = await server.ingestKeys('default');
    const before = await server.ingestKeys(clubId);
    api.set('live/dprtmnt/vertical', { online: true, source: { type: 'rtmpConn', id: 'club-conn' } });
    const next = await server.rotateIngestKey(clubId, 'vertical');
    expect(await secret(`ingest:${clubId}`, 'vertical')).toBe(next);
    expect(await server.ingestKeys(clubId)).toEqual({ landscape: before.landscape, vertical: next });
    expect(await server.ingestKeys('default')).toEqual(main);
    expect(api.requests).toContainEqual({ method: 'POST', url: 'http://127.0.0.1:9997/v3/rtmp/conns/kick/club-conn' });
    expect(server.authorize(publishReq('live/dprtmnt/vertical', before.vertical))).toBe(false);
    expect(server.authorize(publishReq('live/dprtmnt/vertical', next))).toBe(true);
  });

  it('removing a profile kicks its OBS, forgets its keys and never touches the default profile', async () => {
    const { server, api, repos, clubId, secret, feedEvents } = await withClub();
    await server.start();
    const club = await server.ingestKeys(clubId);
    api.set('live/dprtmnt/landscape', { online: true, tracks2: [{ codec: 'H264' }], source: { type: 'rtmpConn', id: 'club-conn' } });
    await waitFor(() => server.feed(clubId, 'landscape').online);

    await server.profileRemoved(clubId);
    expect(api.requests).toContainEqual({ method: 'POST', url: 'http://127.0.0.1:9997/v3/rtmp/conns/kick/club-conn' });
    expect(server.authorize(publishReq('live/dprtmnt/landscape', club.landscape))).toBe(false);
    expect(await secret(`ingest:${clubId}`, 'landscape')).toBeNull();
    expect(feedEvents.at(-1)).toMatchObject({ profileId: clubId, feed: 'landscape', online: false });
    await expect(server.ingestKeys(clubId)).rejects.toMatchObject({ statusCode: 404, code: 'unknown_profile' });
    expect(() => server.readUrl(clubId, 'landscape')).toThrow(/not found/);

    // A late OBS reconnect (the profile row is deleted after this) must not resurrect its keys.
    await flush();
    expect(server.authorize(publishReq('live/dprtmnt/landscape', club.landscape))).toBe(false);
    await flush();
    expect(await secret(`ingest:${clubId}`, 'landscape')).toBeNull();
    repos.profiles.delete(clubId);

    await expect(server.profileRemoved('default')).rejects.toMatchObject({ code: 'default_profile' });
    expect(await secret('ingest', 'landscape')).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(await secret('ingest', 'internalReader')).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });

  it('rejects unknown profiles with 404 unknown_profile', async () => {
    const { server } = await setup();
    await server.start();
    await expect(server.ingestKeys('nope')).rejects.toMatchObject({ statusCode: 404, code: 'unknown_profile' });
    await expect(server.streamKeyField('nope', 'landscape')).rejects.toMatchObject({ code: 'unknown_profile' });
    await expect(server.rotateIngestKey('nope', 'landscape')).rejects.toMatchObject({ code: 'unknown_profile' });
  });
});
