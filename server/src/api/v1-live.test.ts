// /api/v1 since v1.14: the live preview (LL-HLS) of a profile's feed, for apps.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE_ID, type Feed, type FeedState, type Profile } from '../../../shared/types.js';
import { LivePreviewService } from '../media/live-preview.js';
import { PROBLEM_TYPE } from './http.js';
import { createTestApi, type TestApi } from './test-helpers.js';

const SESSION = '375d577d-062e-44cd-bf31-f7623fd25cd1';
const MASTER = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.640028,mp4a.40.2"\nvideo1_stream.m3u8?session=${SESSION}\n`;
const MEDIA = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PART:DURATION=0.2,URI="a_video1_part1.mp4?session=${SESSION}"\n`;

let t: TestApi;
let club: Profile;
let reader: string;
let feeds: Record<string, FeedState>;
let upstream: string[];

const state = (feed: Feed, over: Partial<FeedState> = {}): FeedState => ({
  feed,
  online: true,
  since: '2026-11-20T18:00:00.000Z',
  video: { codec: 'h264' },
  audio: { codec: 'aac' },
  bitrateKbps: 5000,
  ...over,
});

beforeEach(async () => {
  upstream = [];
  feeds = { [`${DEFAULT_PROFILE_ID}:landscape`]: state('landscape') };
  const live = new LivePreviewService({
    feed: (p, f) => feeds[`${p}:${f}`] ?? state(f, { online: false, video: null, audio: null }),
    source: () => ({ baseUrl: 'http://127.0.0.1:9996/live/landscape/', authorization: 'Basic c2VjcmV0' }),
    maxViewers: 3,
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      upstream.push(url.pathname + url.search);
      if (url.pathname.endsWith('/index.m3u8')) return new Response(MASTER);
      if (url.pathname.endsWith('.m3u8')) return new Response(MEDIA);
      return new Response(Buffer.from('fmp4'), { headers: { 'content-type': 'video/mp4' } });
    }) as typeof fetch,
  });
  t = await createTestApi({ live });
  club = t.addProfile('DPRTMNT', '#E11D48');
  reader = t.token(['status:read'], 'ctd live studio');
});
afterEach(async () => {
  await t.close();
});

const get = (url: string, token: string | null, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
const BASE = `/api/v1/profiles/${DEFAULT_PROFILE_ID}/feeds/landscape`;

function expectProblem(res: Awaited<ReturnType<typeof get>>, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.headers['content-type']).toContain('application/problem+json');
  expect(res.json()).toMatchObject({ type: PROBLEM_TYPE, status, code });
}

describe('GET /profiles/{id}/feeds/{feed}/live.m3u8 (+ live/{file})', () => {
  it('is in the route list next to the JPEG preview', () => {
    expect(t.routes).toEqual(expect.arrayContaining([`GET ${'/api/v1/profiles/:id/feeds/:feed/live.m3u8'}`, `GET ${'/api/v1/profiles/:id/feeds/:feed/live/:file'}`]));
  });

  it('plays with the Authorization header on every request; CORS open like the rest of /api/v1', async () => {
    const master = await get(`${BASE}/live.m3u8`, reader, { origin: 'capacitor://localhost' });
    expect(master.statusCode).toBe(200);
    expect(master.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    expect(master.headers['access-control-allow-origin']).toBe('*');
    expect(master.body).not.toContain(SESSION);
    const href = /^live\/video1_stream\.m3u8\?v=\S+$/m.exec(master.body)![0];
    const media = await get(`${BASE}/${href}&_HLS_msn=2`, reader);
    expect(media.statusCode).toBe(200);
    const part = /URI="([^"]+)"/.exec(media.body)![1]!;
    const chunk = await get(`${BASE}/live/${part}`, reader);
    expect(chunk.statusCode).toBe(200);
    expect(chunk.body).toBe('fmp4');
    expect(upstream).toHaveLength(3);
  });

  it('401 without a token; no ?access_token= for the live preview (a token in a URL ends up in logs)', async () => {
    expectProblem(await get(`${BASE}/live.m3u8`, null), 401, 'unauthenticated');
    expectProblem(await get(`${BASE}/live.m3u8?access_token=${reader}`, null), 401, 'unauthenticated');
    expectProblem(await get(`${BASE}/live/video1_stream.m3u8?v=x&access_token=${reader}`, null), 401, 'unauthenticated');
    expect(upstream).toEqual([]);
  });

  it("a playing player (~20 requests a second) isn't held to the 600 a minute of the rest of the API", async () => {
    const master = await get(`${BASE}/live.m3u8`, reader);
    const href = /^live\/video1_stream\.m3u8\?v=\S+$/m.exec(master.body)![0];
    // 40 s of one player: 4 requests every 200 ms.
    for (let i = 0; i < 800; i++) {
      const res = await get(`${BASE}/${href}`, reader);
      if (res.statusCode !== 200) throw new Error(`request ${i}: ${res.statusCode} ${res.body}`);
    }
    // The ordinary budget is untouched by it.
    expect((await get('/api/v1/status', reader)).statusCode).toBe(200);
  });

  it('needs status:read (the preview scope)', async () => {
    expectProblem(await get(`${BASE}/live.m3u8`, t.token(['chat:read'], 'chat only')), 403, 'missing_scope');
  });

  it("a viewer id is tied to the token that opened it", async () => {
    const master = await get(`${BASE}/live.m3u8`, reader);
    const href = /^live\/video1_stream\.m3u8\?v=\S+$/m.exec(master.body)![0];
    expectProblem(await get(`${BASE}/${href}`, t.token(['status:read'], 'another app')), 410, 'live_ended');
  });

  it("a profile-limited token can't watch another profile", async () => {
    const mainOnly = t.token(['status:read'], 'main only', DEFAULT_PROFILE_ID);
    expectProblem(await get(`/api/v1/profiles/${club.id}/feeds/landscape/live.m3u8`, mainOnly), 403, 'profile_forbidden');
    expect((await get(`${BASE}/live.m3u8`, mainOnly)).statusCode).toBe(200);
  });

  it('feed_offline, feed_codec (HEVC/AV1), viewer_cap, not_found', async () => {
    expectProblem(await get(`/api/v1/profiles/${DEFAULT_PROFILE_ID}/feeds/vertical/live.m3u8`, reader), 404, 'feed_offline');
    feeds[`${DEFAULT_PROFILE_ID}:vertical`] = state('vertical', { video: { codec: 'av1' } });
    const av1 = await get(`/api/v1/profiles/${DEFAULT_PROFILE_ID}/feeds/vertical/live.m3u8`, reader);
    expectProblem(av1, 409, 'feed_codec');
    expect(av1.json().detail).toMatch(/^Vertical feed is AV1\./);
    expectProblem(await get(`/api/v1/profiles/${DEFAULT_PROFILE_ID}/feeds/sideways/live.m3u8`, reader), 404, 'not_found');
    for (const name of ['a', 'b', 'c']) expect((await get(`${BASE}/live.m3u8`, t.token(['status:read'], name))).statusCode).toBe(200);
    const capped = await get(`${BASE}/live.m3u8`, reader);
    expectProblem(capped, 429, 'viewer_cap');
    expect(capped.headers['retry-after']).toBe('15');
  });
});
