// /api/v1 since v1.17: guest feeds (docs/API.md §18) through the real routes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE_ID, type Profile } from '../../../shared/types.js';
import { LivePreviewService } from '../media/live-preview.js';
import { guestFeedProblem } from '../../../shared/feed-codec.js';
import type { GuestFeeds } from '../media/guest-feeds.js';
import type { MtxPath } from '../media/feed-state.js';
import { guestPath } from '../media/paths.js';
import { PROBLEM_TYPE } from './http.js';
import { createTestApi, type TestApi } from './test-helpers.js';
import { EVENT_SCOPES, type Envelope } from './types.js';

const SESSION = '375d577d-062e-44cd-bf31-f7623fd25cd1';
const MASTER = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.640028,mp4a.40.2"\nvideo1_stream.m3u8?session=${SESSION}\n`;
const MEDIA = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PART:DURATION=0.2,URI="a_video1_part1.mp4?session=${SESSION}"\n`;

let t: TestApi;
let club: Profile;
let watcher: string;
let statusOnly: string;
let upstream: string[];
let clock: number;

const P = `/api/v1/profiles/${DEFAULT_PROFILE_ID}`;
const get = (url: string, token: string | null, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

function expectProblem(res: Awaited<ReturnType<typeof get>>, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.headers['content-type']).toContain('application/problem+json');
  expect(res.json()).toMatchObject({ type: PROBLEM_TYPE, status, code });
}

const mtx = (slot: string, codec = 'H264'): MtxPath => ({
  name: guestPath(slot),
  online: true,
  onlineTime: '2026-11-24T20:00:00Z',
  inboundBytes: 0,
  tracks2: [{ codec, codecProps: { width: 1280, height: 720 } }, { codec: 'MPEG-4 Audio' }],
});
const online = (guests: GuestFeeds, ...items: MtxPath[]) => guests.apply(new Map(items.map((p) => [p.name, p])), clock);

beforeEach(async () => {
  upstream = [];
  clock = 1_800_000_000_000;
  t = await createTestApi({
    now: () => clock,
    guestLimits: { maxViewers: 2 },
    guestLive: (guests) =>
      new LivePreviewService<string>({
        feed: (p, slot) => guests.state(p, slot) ?? { online: false, video: null, audio: null },
        source: (_p, slot) => ({ baseUrl: `http://127.0.0.1:9996/guest/${slot}/`, authorization: 'Basic c2VjcmV0' }),
        problem: (state, slot) => guestFeedProblem(state, guests.nameOf(slot) ?? slot),
        label: (slot) => `guest feed "${guests.nameOf(slot) ?? slot}"`,
        offlineReason: "the guest isn't sending",
        maxViewers: 2,
        now: () => clock,
        fetch: (async (input: string | URL | Request) => {
          const url = new URL(String(input));
          upstream.push(url.pathname + url.search);
          if (url.pathname.endsWith('/index.m3u8')) return new Response(MASTER);
          if (url.pathname.endsWith('.m3u8')) return new Response(MEDIA);
          return new Response(Buffer.from('fmp4'), { headers: { 'content-type': 'video/mp4' } });
        }) as typeof fetch,
      }),
  });
  club = t.addProfile('DPRTMNT', '#E11D48');
  watcher = t.token(['status:read', 'feeds:watch'], 'ctd obs');
  statusOnly = t.token(['status:read'], 'ctd live mobile');
});
afterEach(async () => {
  await t.close();
});

describe('GET /profiles/{id}/guest-feeds', () => {
  it('lists slots with state and limits (status:read), never keys', async () => {
    const a = await t.guests.create(DEFAULT_PROFILE_ID, 'Remote cam 1');
    await t.guests.create(DEFAULT_PROFILE_ID, 'Guest laptop');
    online(t.guests, mtx(a.slot));
    const res = await get(`${P}/guest-feeds`, statusOnly);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body).toMatchObject({ profileId: DEFAULT_PROFILE_ID, maxSlots: 4, maxViewers: 2, warnAboveKbps: 8000, maxKbps: 20000 });
    expect(body.guestFeeds).toHaveLength(2);
    expect(Object.keys(body.guestFeeds[0]).sort()).toEqual(['audio', 'bitrateKbps', 'bitrateWarning', 'key', 'limitedAt', 'name', 'online', 'problem', 'since', 'slot', 'video'].sort());
    expect(body.guestFeeds[0]).toMatchObject({ slot: a.slot, name: 'Remote cam 1', key: 'active', online: true, video: { codec: 'h264', width: 1280, height: 720 }, problem: null });
    expect(body.guestFeeds[1]).toMatchObject({ online: false, since: null, video: null, bitrateKbps: null });
    expect(res.body).not.toContain((await t.guests.ingestKey(DEFAULT_PROFILE_ID, a.slot))!);
  });

  it('auth and scope: no token 401, wrong scope 403, a token limited to another profile 403, unknown profile 404', async () => {
    expectProblem(await get(`${P}/guest-feeds`, null), 401, 'unauthenticated');
    expectProblem(await get(`${P}/guest-feeds`, t.token(['chat:read'])), 403, 'missing_scope');
    expectProblem(await get(`${P}/guest-feeds`, t.token(['status:read'], 'club only', club.id)), 403, 'profile_forbidden');
    expectProblem(await get('/api/v1/profiles/nope/guest-feeds', statusOnly), 404, 'unknown_profile');
    expect((await get(`/api/v1/profiles/${club.id}/guest-feeds`, t.token(['status:read'], 'club only', club.id))).statusCode).toBe(200);
  });

  it("a profile only sees its own slots; another profile's slot id is unknown here", async () => {
    const theirs = await t.guests.create(club.id, 'Club guest');
    online(t.guests, mtx(theirs.slot));
    expect((await get(`${P}/guest-feeds`, statusOnly)).json().guestFeeds).toEqual([]);
    expectProblem(await get(`${P}/guest-feeds/${theirs.slot}/live.m3u8`, watcher), 404, 'unknown_guest_feed');
    expectProblem(await get(`${P}/guest-feeds/${theirs.slot}/preview`, watcher), 404, 'unknown_guest_feed');
  });
});

describe('GET /profiles/{id}/guest-feeds/{slot}/live.m3u8 (+ live/{file})', () => {
  it('plays with feeds:watch in the header on every request, through the live preview machinery', async () => {
    const a = await t.guests.create(DEFAULT_PROFILE_ID, 'Remote cam 1');
    online(t.guests, mtx(a.slot));
    const base = `${P}/guest-feeds/${a.slot}`;
    const master = await get(`${base}/live.m3u8`, watcher);
    expect(master.statusCode, master.body).toBe(200);
    expect(master.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    expect(master.headers['cache-control']).toBe('no-store');
    expect(master.body).not.toContain(SESSION);
    const href = /^live\/video1_stream\.m3u8\?v=\S+$/m.exec(master.body)![0];
    const media = await get(`${base}/${href}&_HLS_msn=2`, watcher);
    expect(media.statusCode).toBe(200);
    const part = /URI="([^"]+)"/.exec(media.body)![1]!;
    expect((await get(`${base}/live/${part}`, watcher)).body).toBe('fmp4');
    expect(upstream[0]).toBe(`/guest/${a.slot}/index.m3u8?cookieCheck=1`);
    expect(upstream[1]).toContain(`/guest/${a.slot}/video1_stream.m3u8?session=${SESSION}&_HLS_msn=2`);
    // The viewer is the token's: another token gets 410.
    expectProblem(await get(`${base}/${href}`, t.token(['feeds:watch'])), 410, 'live_ended');
  });

  it('status:read is not enough, and ?access_token= is refused', async () => {
    const a = await t.guests.create(DEFAULT_PROFILE_ID, 'A');
    online(t.guests, mtx(a.slot));
    expectProblem(await get(`${P}/guest-feeds/${a.slot}/live.m3u8`, statusOnly), 403, 'missing_scope');
    expectProblem(await get(`${P}/guest-feeds/${a.slot}/live.m3u8?access_token=${watcher}`, null), 401, 'unauthenticated');
    expectProblem(await get(`${P}/guest-feeds/${a.slot}/live/x.m3u8?v=abc`, statusOnly), 403, 'missing_scope');
    expectProblem(await get(`${P}/guest-feeds/${a.slot}/live.m3u8`, t.token(['feeds:watch'], 'club', club.id)), 403, 'profile_forbidden');
  });

  it('offline, revoked, unknown and HEVC guests', async () => {
    const a = await t.guests.create(DEFAULT_PROFILE_ID, 'Remote cam 1');
    expectProblem(await get(`${P}/guest-feeds/${a.slot}/live.m3u8`, watcher), 404, 'feed_offline');
    expect((await get(`${P}/guest-feeds/${a.slot}/live.m3u8`, watcher)).json().detail).toContain("the guest isn't sending");
    expectProblem(await get(`${P}/guest-feeds/zzzzzzzzzz/live.m3u8`, watcher), 404, 'unknown_guest_feed');
    expectProblem(await get(`${P}/guest-feeds/BAD/live.m3u8`, watcher), 404, 'unknown_guest_feed');
    online(t.guests, mtx(a.slot, 'H265'));
    const hevc = await get(`${P}/guest-feeds/${a.slot}/live.m3u8`, watcher);
    expectProblem(hevc, 409, 'feed_codec');
    expect(hevc.json().detail).toContain('Guest feed "Remote cam 1" is HEVC');
    expect(upstream).toEqual([]); // nothing reached MediaMTX
  });

  it('viewer cap: maxViewers players per guest feed, then 429 with Retry-After; one token replaces its own oldest', async () => {
    const a = await t.guests.create(DEFAULT_PROFILE_ID, 'A');
    online(t.guests, mtx(a.slot));
    const other = t.token(['feeds:watch'], 'web watcher');
    expect((await get(`${P}/guest-feeds/${a.slot}/live.m3u8`, watcher)).statusCode).toBe(200);
    expect((await get(`${P}/guest-feeds/${a.slot}/live.m3u8`, other)).statusCode).toBe(200);
    const third = await get(`${P}/guest-feeds/${a.slot}/live.m3u8`, t.token(['feeds:watch'], 'third'));
    expectProblem(third, 429, 'viewer_cap');
    expect(third.headers['retry-after']).toBe('15');
    expect((await get(`${P}/guest-feeds/${a.slot}/live.m3u8`, watcher)).statusCode).toBe(200); // replaces its own
  });

  it('on demand: nothing reaches MediaMTX until a player asks; an idle player is gone after 15 s', async () => {
    const a = await t.guests.create(DEFAULT_PROFILE_ID, 'A');
    online(t.guests, mtx(a.slot));
    await get(`${P}/guest-feeds`, statusOnly);
    expect(upstream).toEqual([]);
    const master = await get(`${P}/guest-feeds/${a.slot}/live.m3u8`, watcher);
    expect(upstream).toHaveLength(1);
    const href = /^live\/video1_stream\.m3u8\?v=\S+$/m.exec(master.body)![0];
    clock += 16_000;
    expectProblem(await get(`${P}/guest-feeds/${a.slot}/${href}`, watcher), 410, 'live_ended');
  });
});

describe('GET /profiles/{id}/guest-feeds/{slot}/preview', () => {
  it('needs status:read; 404 feed_offline while the guest is not sending', async () => {
    const a = await t.guests.create(DEFAULT_PROFILE_ID, 'A');
    expectProblem(await get(`${P}/guest-feeds/${a.slot}/preview`, t.token(['chat:read'])), 403, 'missing_scope');
    expectProblem(await get(`${P}/guest-feeds/${a.slot}/preview`, statusOnly), 404, 'feed_offline');
    expectProblem(await get(`${P}/guest-feeds/${a.slot}/preview?access_token=${statusOnly}`, null), 404, 'feed_offline');
  });
});

describe('guest events (status:read)', () => {
  it('guest.feed.status when a guest goes online/offline, guest.feeds.changed on slot changes, guest.feed.codec as an issue', async () => {
    expect(EVENT_SCOPES['guest.feed.status']).toBe('status:read');
    expect(EVENT_SCOPES['guest.feeds.changed']).toBe('status:read');
    const start = t.hub.cursor();
    const a = await t.guests.create(DEFAULT_PROFILE_ID, 'Remote cam 1');
    online(t.guests, mtx(a.slot, 'H265'));
    clock += 1000;
    online(t.guests, mtx(a.slot));
    clock += 1000;
    online(t.guests);
    t.guests.rename(DEFAULT_PROFILE_ID, a.slot, 'Cam A');
    const items = (await get(`/api/v1/events/poll?after=${start}&types=guest.*,issue.*`, statusOnly)).json().items as Envelope[];
    const summary = items.map((e) => {
      const d = e.data as { online?: boolean; kind?: string; resolution?: string; guestFeeds?: unknown[] };
      if (e.type === 'guest.feed.status') return `status:${d.online ? 'online' : 'offline'}`;
      if (e.type === 'guest.feeds.changed') return `changed:${d.guestFeeds?.length}`;
      return `${e.type}:${d.kind}${d.resolution ? `:${d.resolution}` : ''}`;
    });
    expect(summary).toEqual([
      'changed:1',
      'issue.raised:guest.feed.codec',
      'status:online',
      'issue.cleared:guest.feed.codec:recovered',
      'status:online',
      'status:offline',
      'status:offline',
      'changed:1',
    ]);
    expect(items.every((e) => e.src.profile === DEFAULT_PROFILE_ID && e.src.connection === 'core')).toBe(true);
    const raised = items.find((e) => e.type === 'issue.raised')!;
    expect(raised.data).toMatchObject({ id: `guest.feed.codec|${a.slot}`, severity: 'warning', subject: { type: 'guest.feed', slot: a.slot, name: 'Remote cam 1' } });
    // Without status:read they are left out.
    const chat = (await get(`/api/v1/events/poll?after=${start}`, t.token(['chat:read']))).json().items as Envelope[];
    expect(chat.filter((e) => e.type.startsWith('guest.'))).toEqual([]);
  });

  it("another profile's guest events don't reach a token limited to this one", async () => {
    const start = t.hub.cursor();
    const theirs = await t.guests.create(club.id, 'Club guest');
    online(t.guests, mtx(theirs.slot));
    const limited = t.token(['status:read'], 'default only', DEFAULT_PROFILE_ID);
    const items = (await get(`/api/v1/events/poll?after=${start}&types=guest.*`, limited)).json().items as Envelope[];
    expect(items).toEqual([]);
  });
});
