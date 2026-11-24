// Web UI feed previews: the JPEG thumbnail and the live preview proxy, behind the session cookie.

import crypto from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../../../shared/api.js';
import type { Feed, FeedState } from '../../../../shared/types.js';
import { previewServiceFor } from '../../api/previews.js';
import type { AppConfig } from '../../config.js';
import { openDatabase } from '../../db/database.js';
import { createRepos } from '../../db/repos.js';
import { EventBus } from '../../events.js';
import { livePreviewServiceFor, type LivePreviewService } from '../../media/live-preview.js';
import { createSecretBox } from '../../security/secretbox.js';
import type { AppServices, Repos } from '../../services.js';
import authPlugin from '../auth-plugin.js';
import feedPreviewRoutes from './feed-preview.js';

const SESSION = '375d577d-062e-44cd-bf31-f7623fd25cd1';
const MASTER = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.640028,mp4a.40.2"\nvideo1_stream.m3u8?session=${SESSION}\n`;
const MEDIA = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="a_video1_init.mp4?session=${SESSION}"\n#EXT-X-PART:DURATION=0.2,URI="a_video1_part1.mp4?session=${SESSION}"\n`;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9]);

let app: FastifyInstance;
let repos: Repos;
let online: Record<string, FeedState>;
let upstream: string[];
let live: LivePreviewService;

const feedState = (feed: Feed, over: Partial<FeedState> = {}): FeedState => ({
  feed,
  online: true,
  since: '2026-11-20T18:00:00.000Z',
  video: { codec: 'h264' },
  audio: { codec: 'aac' },
  bitrateKbps: 5000,
  ...over,
});

function login(username: string): string {
  const user = repos.users.create({ username, passwordHash: 'x', role: 'operator' });
  return repos.authSessions.create(user.id, { ip: null, userAgent: null }).token;
}

beforeEach(async () => {
  repos = createRepos(openDatabase(':memory:'), createSecretBox(crypto.randomBytes(32)));
  online = { 'default:landscape': feedState('landscape') };
  upstream = [];
  const services = {
    config: { tlsMode: 'off', version: 'test' } as AppConfig,
    log: pino({ level: 'silent' }),
    bus: new EventBus(),
    repos,
    media: { feed: (p: string, f: Feed) => online[`${p}:${f}`] ?? feedState(f, { online: false, video: null, audio: null }) },
  } as unknown as AppServices;
  // The route takes the services' preview and live services; seed them with fakes first.
  previewServiceFor(services, () => ({ online: (p, f) => online[`${p}:${f}`]?.online === true, grab: async () => JPEG }));
  live = livePreviewServiceFor(services, () => ({
    feed: (p, f) => services.media.feed(p, f),
    source: () => ({ baseUrl: 'http://127.0.0.1:9996/live/landscape/', authorization: 'Basic c2VjcmV0' }),
    maxViewers: 2,
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      upstream.push(url.pathname + url.search);
      if (url.pathname.endsWith('/index.m3u8')) return new Response(MASTER);
      if (url.pathname.endsWith('.m3u8')) return new Response(MEDIA);
      return new Response(Buffer.from('fmp4'), { headers: { 'content-type': 'video/mp4' } });
    }) as typeof fetch,
  }));
  app = Fastify();
  await app.register(cookie);
  await app.register(authPlugin, { services });
  await app.register(feedPreviewRoutes, { services });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

const get = (url: string, token?: string) => app.inject({ method: 'GET', url, ...(token ? { cookies: { [SESSION_COOKIE]: token } } : {}) });
const BASE = '/api/profiles/default/feeds/landscape';

describe('GET /api/profiles/:id/feeds/:feed/preview.jpg', () => {
  it('needs a login', async () => {
    expect((await get(`${BASE}/preview.jpg`)).statusCode).toBe(401);
    expect((await get(`${BASE}/preview.jpg`, 'not-a-session')).statusCode).toBe(401);
  });

  it('a JPEG of an online feed, never cached by the browser', async () => {
    const res = await get(`${BASE}/preview.jpg`, login('op'));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-preview-at']).toMatch(/^\d{4}-/);
    expect(res.rawPayload.equals(JPEG)).toBe(true);
  });

  it('404 feed_offline / unknown_profile / not_found', async () => {
    const t = login('op');
    expect((await get('/api/profiles/default/feeds/vertical/preview.jpg', t)).json()).toMatchObject({ code: 'feed_offline' });
    expect((await get('/api/profiles/ghost/feeds/landscape/preview.jpg', t)).json()).toMatchObject({ code: 'unknown_profile' });
    expect((await get('/api/profiles/default/feeds/square/preview.jpg', t)).statusCode).toBe(404);
  });
});

describe('live preview proxy (web UI)', () => {
  it('needs a login for the playlist and for every file', async () => {
    expect((await get(`${BASE}/live.m3u8`)).statusCode).toBe(401);
    expect((await get(`${BASE}/live/video1_stream.m3u8?v=x`)).statusCode).toBe(401);
    expect(upstream).toEqual([]);
  });

  it('plays with the session cookie alone: no credentials or MediaMTX session in any URL it hands out', async () => {
    const t = login('op');
    const master = await get(`${BASE}/live.m3u8`, t);
    expect(master.statusCode).toBe(200);
    expect(master.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    expect(master.headers['cache-control']).toBe('no-store');
    expect(master.headers['set-cookie']).toBeUndefined();
    expect(master.body).not.toContain(SESSION);
    expect(master.body).not.toMatch(/key=|pass=|token|Basic/i);
    const href = /^live\/video1_stream\.m3u8\?v=[A-Za-z0-9_-]{22}$/m.exec(master.body)?.[0];
    expect(href).toBeTruthy();

    const media = await get(`${BASE}/${href!}&_HLS_msn=3&_HLS_part=1`, t);
    expect(media.statusCode).toBe(200);
    expect(media.body).not.toContain(SESSION);
    const part = /URI="(a_video1_part1\.mp4\?v=[^"]+)"/.exec(media.body)?.[1];
    const chunk = await get(`${BASE}/live/${part!}`, t);
    expect(chunk.statusCode).toBe(200);
    expect(chunk.headers['content-type']).toBe('video/mp4');
    expect(chunk.body).toBe('fmp4');
    expect(upstream).toEqual([
      '/live/landscape/index.m3u8?cookieCheck=1',
      `/live/landscape/video1_stream.m3u8?session=${SESSION}&_HLS_msn=3&_HLS_part=1`,
      `/live/landscape/a_video1_part1.mp4?session=${SESSION}`,
    ]);
  });

  it("another login can't use your viewer id (410 live_ended)", async () => {
    const mine = login('op');
    const theirs = login('other');
    const master = await get(`${BASE}/live.m3u8`, mine);
    const href = /^live\/video1_stream\.m3u8\?v=\S+$/m.exec(master.body)![0];
    const res = await get(`${BASE}/${href}`, theirs);
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ code: 'live_ended' });
  });

  it('a logout ends the player at its next request', async () => {
    const t = login('op');
    const master = await get(`${BASE}/live.m3u8`, t);
    const href = /^live\/video1_stream\.m3u8\?v=\S+$/m.exec(master.body)![0];
    repos.authSessions.delete(t);
    expect((await get(`${BASE}/${href}`, t)).statusCode).toBe(401);
  });

  it('viewer cap, offline feed and codec guard come back as errors the player shows', async () => {
    await get(`${BASE}/live.m3u8`, login('a'));
    await get(`${BASE}/live.m3u8`, login('b'));
    const capped = await get(`${BASE}/live.m3u8`, login('c'));
    expect(capped.statusCode).toBe(429);
    expect(capped.headers['retry-after']).toBe('15');
    expect(capped.json()).toMatchObject({ code: 'viewer_cap' });
    expect(live.viewerCount('default', 'landscape')).toBe(2);

    const t = login('d');
    expect((await get('/api/profiles/default/feeds/vertical/live.m3u8', t)).json()).toMatchObject({ code: 'feed_offline' });
    online['default:vertical'] = feedState('vertical', { video: { codec: 'hevc' } });
    const hevc = await get('/api/profiles/default/feeds/vertical/live.m3u8', t);
    expect(hevc.statusCode).toBe(409);
    expect(hevc.json()).toMatchObject({ code: 'feed_codec', error: expect.stringContaining('Vertical feed is HEVC.') });
    expect((await get('/api/profiles/ghost/feeds/landscape/live.m3u8', t)).json()).toMatchObject({ code: 'unknown_profile' });
    expect((await get(`${BASE}/live/..%2Findex.m3u8?v=x`, t)).statusCode).toBe(404);
  });
});
