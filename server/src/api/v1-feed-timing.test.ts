// /api/v1 since v1.18: feed timing (docs/API.md §19) through the real routes, with fake readers.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE_ID, type Feed, type Profile } from '../../../shared/types.js';
import { FeedTimingService, type TimingFrame } from '../media/feed-timing.js';
import type { MtxPath } from '../media/feed-state.js';
import { guestPath } from '../media/paths.js';
import { bindFeedTiming, timingFeeds } from './feed-timing.js';
import { resolveTypes } from './filters.js';
import { PROBLEM_TYPE } from './http.js';
import { createTestApi, type TestApi } from './test-helpers.js';
import { EVENT_SCOPES } from './types.js';

const READER_PASS = 'internalReaderPass_42';
let t: TestApi;
let club: Profile;
let statusOnly: string;
let online: Set<string>;
let readers: { url: string; frame: (f: TimingFrame) => void; stopped: boolean }[];
let timing: FeedTimingService;

const get = (url: string, token: string | null) => t.app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });
function expectProblem(res: Awaited<ReturnType<typeof get>>, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.json()).toMatchObject({ type: PROBLEM_TYPE, status, code });
}

beforeEach(async () => {
  t = await createTestApi();
  club = t.addProfile('DPRTMNT', '#E11D48');
  statusOnly = t.token(['status:read'], 'ctd obs');
  online = new Set([`${DEFAULT_PROFILE_ID}/landscape`]);
  readers = [];
  const media = t.services.media as unknown as Record<string, unknown>;
  media.feed = (profileId: string, feed: Feed) => ({ online: online.has(`${profileId}/${feed}`), video: null, audio: null });
  media.readUrl = (profileId: string, feed: Feed) => `rtmp://127.0.0.1:1936/live/${profileId}/${feed}?user=relay-reader&pass=${READER_PASS}`;
  media.guestReadUrl = (slot: string) => `rtmp://127.0.0.1:1936/guest/${slot}?user=relay-reader&pass=${READER_PASS}`;
  timing = new FeedTimingService({
    feeds: (p) => timingFeeds(t.services, p),
    profiles: () => t.repos.profiles.list().map((p) => p.id),
    readUrl: (p, ref) => (ref.slot ? (media.guestReadUrl as (s: string) => string)(ref.slot) : (media.readUrl as (p: string, f: Feed) => string)(p, ref.feed as Feed)),
    emit: (profileId, data) => t.hub.transient('feed.timing', profileId, data),
    readers: (url, frame) => {
      const r = { url, frame, stopped: false };
      readers.push(r);
      // A real reader's first frames arrive within a second or two.
      frame({ streamTimeMs: 9_000, receivedAt: Date.now(), timecode: null });
      return { stop: () => (r.stopped = true) };
    },
    max: 8,
    log: { info: () => {}, warn: () => {} },
  });
  bindFeedTiming(t.services, timing);
});
afterEach(async () => {
  timing.close();
  await t.close();
});

describe('GET /profiles/{id}/timing', () => {
  it('lists landscape, vertical and the guest slots; measures the online ones; no keys or URLs', async () => {
    const g = await t.guests.create(DEFAULT_PROFILE_ID, 'Remote cam 1');
    const mtx: MtxPath = { name: guestPath(g.slot), online: true, onlineTime: '2026-11-24T20:00:00Z', inboundBytes: 0, tracks2: [{ codec: 'H264', codecProps: { width: 1280, height: 720 } }] };
    t.guests.apply(new Map([[mtx.name, mtx]]), Date.now());
    const res = await get(`/api/v1/profiles/${DEFAULT_PROFILE_ID}/timing`, statusOnly);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body).toMatchObject({ profileId: DEFAULT_PROFILE_ID, enabled: true, maxFeeds: 8, measuredFeeds: 2, windowMs: 30_000, idleStopMs: 30_000 });
    expect(body.feeds.map((f: { id: string; measuring: boolean }) => [f.id, f.measuring])).toEqual([
      ['landscape', true],
      ['vertical', false],
      [`guest/${g.slot}`, true],
    ]);
    expect(body.feeds[0]).toMatchObject({ feed: 'landscape', slot: null, online: true, streamTimeMs: 9_000, transitMs: 0 });
    expect(body.feeds[2]).toMatchObject({ feed: 'guest', slot: g.slot, name: 'Remote cam 1', online: true });
    expect(Object.keys(body.feeds[0]).sort()).toEqual(
      ['id', 'feed', 'slot', 'name', 'online', 'measuring', 'streamTimeMs', 'receivedAt', 'sourceTimecode', 'sourceTimecodeStreamTimeMs', 'transitMs', 'arrivalOffsetMs', 'jitterMs', 'fps'].sort(),
    );
    const key = (await t.guests.ingestKey(DEFAULT_PROFILE_ID, g.slot))!;
    for (const secret of [READER_PASS, key, 'rtmp://', 'relay-reader']) expect(res.body).not.toContain(secret);
    expect(readers.map((r) => r.url)).toEqual([expect.stringContaining('/landscape?'), expect.stringContaining(`/guest/${g.slot}?`)]);
  });

  it('needs status:read; a token limited to one profile only sees that profile', async () => {
    const P = `/api/v1/profiles/${DEFAULT_PROFILE_ID}/timing`;
    expectProblem(await get(P, null), 401, 'unauthenticated');
    expectProblem(await get(P, t.token(['chat:read'])), 403, 'missing_scope');
    const clubOnly = t.token(['status:read'], 'club only', club.id);
    expectProblem(await get(P, clubOnly), 403, 'profile_forbidden');
    expectProblem(await get('/api/v1/profiles/nope/timing', statusOnly), 404, 'unknown_profile');
    expect(readers).toHaveLength(0);
    const res = await get(`/api/v1/profiles/${club.id}/timing`, clubOnly);
    expect(res.statusCode).toBe(200);
    expect(res.json().profileId).toBe(club.id);
  });
});

describe('feed.timing on /events', () => {
  it('is status:read and opt-in: only a stream that names it exactly gets it', () => {
    expect(EVENT_SCOPES['feed.timing']).toBe('status:read');
    const all = resolveTypes(undefined, ['status:read']);
    expect(all.ok && all.types.has('feed.timing')).toBe(false);
    const glob = resolveTypes('feed.*', ['status:read']);
    expect(glob.ok && glob.types.has('feed.timing')).toBe(false);
    expect(glob.ok && glob.types.has('feed.status')).toBe(true);
    const named = resolveTypes('feed.timing,issue.*', ['status:read']);
    expect(named.ok && named.types.has('feed.timing')).toBe(true);
    expect(resolveTypes('feed.timing', ['chat:read'])).toMatchObject({ ok: false, status: 403, code: 'missing_scope' });
  });

  it('a stream that asks for it starts measuring and gets about one event a second per feed; one that does not, does not', async () => {
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = t.app.server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const open = async (types: string | null) => {
      const controller = new AbortController();
      const res = await fetch(`${base}/api/v1/events${types ? `?types=${types}` : ''}`, { headers: { authorization: `Bearer ${statusOnly}` }, signal: controller.signal });
      const reader = res.body!.getReader();
      let text = '';
      const pump = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            text += Buffer.from(value).toString();
          }
        } catch {
          // aborted
        }
      })();
      return { text: () => text, close: () => controller.abort(), pump };
    };

    const plain = await open(null);
    await new Promise((r) => setTimeout(r, 200));
    expect(readers).toHaveLength(0);

    const timed = await open('feed.timing');
    await new Promise((r) => setTimeout(r, 1_300));
    expect(readers).toHaveLength(1);
    const frames = timed.text().split('\n\n').filter((f) => f.includes('event: feed.timing'));
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const env = JSON.parse(frames[0]!.split('\n').find((l) => l.startsWith('data: '))!.slice(6));
    expect(env).toMatchObject({ type: 'feed.timing', src: { profile: DEFAULT_PROFILE_ID }, data: { id: 'landscape', measuring: true, streamTimeMs: 9_000 } });
    expect(timed.text()).not.toContain(READER_PASS);
    expect(plain.text()).not.toContain('feed.timing');
    // Not buffered: a poll never replays it.
    expect((await get('/api/v1/events/poll?types=feed.timing', statusOnly)).json().items).toEqual([]);
    plain.close();
    timed.close();
    await Promise.all([plain.pump, timed.pump]);
  });
});
