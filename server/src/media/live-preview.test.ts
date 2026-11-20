import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Feed, FeedState } from '../../../shared/types.js';
import { LivePreviewService, rewritePlaylist, upstreamSession, VIEWER_IDLE_MS, type LiveResult } from './live-preview.js';

// What MediaMTX v1.21.2 answers (captured from the real binary, `?cookieCheck=1` without a cookie).
const SESSION = '375d577d-062e-44cd-bf31-f7623fd25cd1';
const MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:10',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '',
  `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio2",AUTOSELECT=YES,DEFAULT=YES,URI="audio2_stream.m3u8?session=${SESSION}"`,
  '',
  '#EXT-X-STREAM-INF:BANDWIDTH=4618628,AVERAGE-BANDWIDTH=4513900,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=30.000,AUDIO="audio"',
  `video1_stream.m3u8?session=${SESSION}`,
  '',
].join('\n');
const MEDIA = [
  '#EXTM3U',
  '#EXT-X-VERSION:10',
  '#EXT-X-TARGETDURATION:2',
  '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.50000,CAN-SKIP-UNTIL=12.00000',
  '#EXT-X-PART-INF:PART-TARGET=0.20000',
  '#EXT-X-MEDIA-SEQUENCE:6',
  `#EXT-X-MAP:URI="7cd19161a45e_video1_init.mp4?session=${SESSION}"`,
  '#EXT-X-GAP',
  '#EXTINF:2.00000,',
  'gap.mp4',
  '#EXTINF:2.00000,',
  `7cd19161a45e_video1_seg7.mp4?session=${SESSION}`,
  '#EXT-X-PROGRAM-DATE-TIME:2026-11-20T18:44:56.473Z',
  `#EXT-X-PART:DURATION=0.20000,URI="7cd19161a45e_video1_part40.mp4?session=${SESSION}",INDEPENDENT=YES`,
  `#EXT-X-PRELOAD-HINT:TYPE=PART,URI="7cd19161a45e_video1_part41.mp4?session=${SESSION}"`,
  '',
].join('\n');

const BASE = 'http://127.0.0.1:9996/live/landscape/';
const AUTH = 'Basic aW50ZXJuYWw6cHc=';

function feedState(over: Partial<FeedState> = {}): FeedState {
  return {
    profileId: 'default',
    feed: 'landscape',
    online: true,
    since: '2026-11-20T18:00:00.000Z',
    video: { codec: 'h264', width: 1920, height: 1080 },
    audio: { codec: 'aac' },
    bitrateKbps: 6000,
    ...over,
  };
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

let clock: number;
let calls: Call[];
let feeds: Record<string, FeedState>;
let respond: (url: URL) => Response;
let ids: number;
let sourceOn: boolean;

function service(maxViewers = 2): LivePreviewService {
  return new LivePreviewService({
    feed: (p: string, f: Feed) => feeds[`${p}:${f}`] ?? feedState({ profileId: p, feed: f, online: false, video: null, audio: null }),
    source: () => (sourceOn ? { baseUrl: BASE, authorization: AUTH } : null),
    maxViewers,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      return respond(new URL(url));
    }) as typeof fetch,
    now: () => clock,
    newViewerId: () => `viewer${String(++ids).padStart(16, '0')}`,
  });
}

beforeEach(() => {
  clock = 1_000_000;
  calls = [];
  ids = 0;
  sourceOn = true;
  feeds = { 'default:landscape': feedState(), 'default:vertical': feedState({ feed: 'vertical' }) };
  respond = (url) => {
    if (url.searchParams.get('session') !== null && url.searchParams.get('session') !== SESSION) return new Response('{"error":"session not found"}', { status: 401 });
    if (url.pathname.endsWith('/index.m3u8')) return new Response(MASTER, { status: 200 });
    if (url.pathname.endsWith('.m3u8')) return new Response(MEDIA, { status: 200 });
    return new Response(Buffer.from('moof-bytes'), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '10' } });
  };
});

const ok = (r: LiveResult) => {
  if (!r.ok) throw new Error(`${r.status} ${r.code}: ${r.message}`);
  return r;
};
const viewerOf = (body: string) => /\?v=([A-Za-z0-9_-]+)/.exec(body)?.[1] ?? '';

describe('rewritePlaylist', () => {
  it("replaces MediaMTX's session with our viewer id in every URI, lines and URI= attributes", () => {
    const out = rewritePlaylist(MEDIA, { upstream: SESSION, viewerId: 'V', prefix: '' })!;
    expect(out).not.toContain(SESSION);
    expect(out).not.toContain('session=');
    expect(out).toContain('#EXT-X-MAP:URI="7cd19161a45e_video1_init.mp4?v=V"');
    expect(out).toContain('7cd19161a45e_video1_seg7.mp4?v=V');
    expect(out).toContain('URI="7cd19161a45e_video1_part40.mp4?v=V",INDEPENDENT=YES');
    expect(out).toContain('#EXT-X-PRELOAD-HINT:TYPE=PART,URI="7cd19161a45e_video1_part41.mp4?v=V"');
    expect(out).toContain('gap.mp4?v=V');
    // Tags without URIs are passed on untouched.
    expect(out).toContain('#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.50000,CAN-SKIP-UNTIL=12.00000');
  });

  it('points the multivariant playlist one level down (live.m3u8 → live/<file>)', () => {
    const out = rewritePlaylist(MASTER, { upstream: SESSION, viewerId: 'V', prefix: 'live/' })!;
    expect(out).toContain('URI="live/audio2_stream.m3u8?v=V"');
    expect(out.split('\n')).toContain('live/video1_stream.m3u8?v=V');
  });

  it.each([
    ['an absolute URL', 'http://203.0.113.5:9996/live/landscape/x.mp4'],
    ['a path', '../../other/index.m3u8'],
    ['a subdirectory', 'a/b.mp4'],
    ['another session', 'x_part1.mp4?session=11111111-2222-3333-4444-555555555555'],
    ['an extra parameter', `x_part1.mp4?session=${SESSION}&user=internal`],
    ['another file type', 'x.ts'],
  ])('refuses a playlist with %s', (_what, uri) => {
    expect(rewritePlaylist(`#EXTM3U\n#EXTINF:2,\n${uri}\n`, { upstream: SESSION, viewerId: 'V', prefix: '' })).toBeNull();
    expect(rewritePlaylist(`#EXTM3U\n#EXT-X-MAP:URI="${uri}"\n`, { upstream: SESSION, viewerId: 'V', prefix: '' })).toBeNull();
  });

  it('refuses something that is not a playlist', () => {
    expect(rewritePlaylist('{"error":"x"}', { upstream: SESSION, viewerId: 'V', prefix: '' })).toBeNull();
  });

  it('reads the one session id of a multivariant playlist', () => {
    expect(upstreamSession(MASTER)).toBe(SESSION);
    expect(upstreamSession('#EXTM3U\nvideo1_stream.m3u8\n')).toBeNull();
    expect(upstreamSession(`${MASTER}\nx.m3u8?session=11111111-2222-3333-4444-555555555555\n`)).toBeNull();
    expect(upstreamSession('#EXTM3U\nx.m3u8?session=../../etc\n')).toBeNull();
  });
});

describe('LivePreviewService.open (live.m3u8)', () => {
  it("asks MediaMTX for the playlist with the reader password, then hands out our own viewer id", async () => {
    const live = service();
    const r = ok(await live.open('default', 'landscape', 'session:a'));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}index.m3u8?cookieCheck=1`);
    expect(calls[0]!.init?.headers).toEqual({ authorization: AUTH });
    expect(calls[0]!.init?.redirect).toBe('manual');
    expect(r.kind).toBe('playlist');
    if (r.kind !== 'playlist') return;
    expect(r.body).not.toContain(SESSION);
    expect(r.body).toContain('live/video1_stream.m3u8?v=viewer0000000000000001');
    expect(live.viewerCount('default', 'landscape')).toBe(1);
  });

  it('is off with LIVE_PREVIEW_MAX_VIEWERS=0 (nothing is asked of MediaMTX)', async () => {
    const r = await service(0).open('default', 'landscape', 'session:a');
    expect(r).toMatchObject({ ok: false, status: 503, code: 'live_off' });
    expect(calls).toHaveLength(0);
  });

  it('an offline feed: 404 feed_offline, without starting a muxer', async () => {
    feeds['default:landscape'] = feedState({ online: false });
    expect(await service().open('default', 'landscape', 'session:a')).toMatchObject({ ok: false, status: 404, code: 'feed_offline' });
    expect(calls).toHaveLength(0);
  });

  it.each(['hevc', 'av1'])('a %s feed: 409 feed_codec with the codec guard message, no player', async (codec) => {
    feeds['default:vertical'] = feedState({ feed: 'vertical', video: { codec } });
    const r = await service().open('default', 'vertical', 'session:a');
    expect(r).toMatchObject({ ok: false, status: 409, code: 'feed_codec' });
    if (!r.ok) expect(r.message).toMatch(/^Vertical feed is (HEVC|AV1)\. .*H\.264/);
    expect(calls).toHaveLength(0);
  });

  it('Opus audio (sent without sound) still plays', async () => {
    feeds['default:landscape'] = feedState({ audio: { codec: 'opus' } });
    expect((await service().open('default', 'landscape', 'session:a')).ok).toBe(true);
  });

  it('MediaMTX not running: 503 with Retry-After', async () => {
    sourceOn = false;
    expect(await service().open('default', 'landscape', 'session:a')).toMatchObject({ ok: false, status: 503, code: 'unavailable', retryAfterSec: 5 });
  });

  it("MediaMTX says the stream isn't there: feed_offline; refuses or fails: unavailable; never trusts a redirect", async () => {
    const live = service();
    respond = () => new Response('', { status: 404 });
    expect(await live.open('default', 'landscape', 'session:a')).toMatchObject({ status: 404, code: 'feed_offline' });
    respond = () => new Response('', { status: 401 });
    expect(await live.open('default', 'landscape', 'session:a')).toMatchObject({ status: 503, code: 'unavailable' });
    respond = () => new Response('', { status: 302, headers: { location: '/live/landscape/index.m3u8?cookieCheck=1' } });
    expect(await live.open('default', 'landscape', 'session:a')).toMatchObject({ status: 503, code: 'unavailable' });
    respond = () => {
      throw new TypeError('fetch failed');
    };
    expect(await live.open('default', 'landscape', 'session:a')).toMatchObject({ status: 503, code: 'unavailable' });
    respond = () => new Response('#EXTM3U\nhttp://evil.example/x.m3u8?session=' + SESSION + '\n', { status: 200 });
    expect(await live.open('default', 'landscape', 'session:a')).toMatchObject({ status: 503, code: 'unavailable' });
    expect(live.viewerCount('default', 'landscape')).toBe(0);
  });
});

describe('LivePreviewService.file (live/<file>)', () => {
  async function opened(live: LivePreviewService, who = 'session:a', feed: Feed = 'landscape') {
    const r = ok(await live.open('default', feed, who));
    return viewerOf(r.kind === 'playlist' ? r.body : '');
  }

  it('a media playlist: forwarded with the upstream session and the LL-HLS directives only, rewritten back', async () => {
    const live = service();
    const v = await opened(live);
    const r = ok(await live.file('default', 'landscape', 'video1_stream.m3u8', { v, _HLS_msn: '12', _HLS_part: '3', _HLS_skip: 'YES', user: 'x', session: 'evil' }, 'session:a'));
    const url = new URL(calls.at(-1)!.url);
    expect(url.origin + url.pathname).toBe(`${BASE}video1_stream.m3u8`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ session: SESSION, _HLS_msn: '12', _HLS_part: '3', _HLS_skip: 'YES' });
    // No reader password on later requests: MediaMTX checked it when the session was made.
    expect(calls.at(-1)!.init?.headers).toBeUndefined();
    expect(r.kind === 'playlist' && r.body).toContain(`7cd19161a45e_video1_seg7.mp4?v=${v}`);
  });

  it('drops malformed directives', async () => {
    const live = service();
    const v = await opened(live);
    await live.file('default', 'landscape', 'video1_stream.m3u8', { v, _HLS_msn: '12; rm', _HLS_part: '-1', _HLS_skip: 'maybe' }, 'session:a');
    expect(Object.fromEntries(new URL(calls.at(-1)!.url).searchParams)).toEqual({ session: SESSION });
  });

  it('a part: streamed with its type and length', async () => {
    const live = service();
    const v = await opened(live);
    const r = ok(await live.file('default', 'landscape', '7cd19161a45e_video1_part40.mp4', { v }, 'session:a'));
    expect(r.kind).toBe('media');
    if (r.kind !== 'media') return;
    expect(r.contentType).toBe('video/mp4');
    expect(r.contentLength).toBe('10');
    expect(r.body).toBeInstanceOf(Readable);
    const chunks: Buffer[] = [];
    for await (const c of r.body) chunks.push(Buffer.from(c as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('moof-bytes');
  });

  it('refuses names that are not MediaMTX files', async () => {
    const live = service();
    const v = await opened(live);
    for (const name of ['../index.m3u8', 'x.ts', 'a.b.mp4', '', '%2e%2e.mp4', 'x'.repeat(129) + '.mp4']) {
      expect(await live.file('default', 'landscape', name, { v }, 'session:a')).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    }
    expect(calls).toHaveLength(1);
  });

  it("a viewer id only works for whoever opened it, on that profile and feed", async () => {
    const live = service();
    const v = await opened(live, 'session:a');
    const n = calls.length;
    for (const [profile, feed, who, vid] of [
      ['default', 'landscape', 'session:b', v],
      ['default', 'landscape', 'token:a', v],
      ['default', 'vertical', 'session:a', v],
      ['club', 'landscape', 'session:a', v],
      ['default', 'landscape', 'session:a', 'viewer0000000000000099'],
      ['default', 'landscape', 'session:a', undefined],
    ] as const) {
      expect(await live.file(profile, feed, 'video1_stream.m3u8', vid ? { v: vid } : {}, who)).toMatchObject({ ok: false, status: 410, code: 'live_ended' });
    }
    expect(calls).toHaveLength(n);
  });

  it('MediaMTX lost the session (its muxer closed): 410, and the viewer is gone', async () => {
    const live = service();
    const v = await opened(live);
    respond = () => new Response('{"status":"error","error":"session not found"}', { status: 401 });
    expect(await live.file('default', 'landscape', 'video1_stream.m3u8', { v }, 'session:a')).toMatchObject({ status: 410, code: 'live_ended' });
    expect(live.viewerCount('default', 'landscape')).toBe(0);
  });

  it('the feed goes offline or turns HEVC mid-play: the player is told, the viewer ends', async () => {
    const live = service();
    const v = await opened(live);
    feeds['default:landscape'] = feedState({ online: false });
    expect(await live.file('default', 'landscape', 'video1_stream.m3u8', { v }, 'session:a')).toMatchObject({ status: 404, code: 'feed_offline' });
    expect(live.viewerCount('default', 'landscape')).toBe(0);
    feeds['default:landscape'] = feedState();
    const v2 = await opened(live);
    feeds['default:landscape'] = feedState({ video: { codec: 'hevc' } });
    expect(await live.file('default', 'landscape', 'video1_stream.m3u8', { v: v2 }, 'session:a')).toMatchObject({ status: 409, code: 'feed_codec' });
  });

  it('a part that is gone: 404 (the viewer stays)', async () => {
    const live = service();
    const v = await opened(live);
    respond = () => new Response('', { status: 404 });
    expect(await live.file('default', 'landscape', 'x_part1.mp4', { v }, 'session:a')).toMatchObject({ status: 404, code: 'not_found' });
    expect(live.viewerCount('default', 'landscape')).toBe(1);
  });

  it('passes the client abort on to MediaMTX', async () => {
    const live = service();
    const v = await opened(live);
    const ac = new AbortController();
    await live.file('default', 'landscape', 'video1_stream.m3u8', { v }, 'session:a', ac.signal);
    const signal = calls.at(-1)!.init?.signal;
    expect(signal?.aborted).toBe(false);
    ac.abort();
    expect(signal?.aborted).toBe(true);
  });
});

describe('viewers: cap and on-demand stop', () => {
  it('caps players per feed; feeds and profiles are counted apart', async () => {
    const live = service(2);
    ok(await live.open('default', 'landscape', 'session:a'));
    ok(await live.open('default', 'landscape', 'session:b'));
    const n = calls.length;
    const third = await live.open('default', 'landscape', 'session:c');
    expect(third).toMatchObject({ ok: false, status: 429, code: 'viewer_cap', retryAfterSec: VIEWER_IDLE_MS / 1000 });
    if (!third.ok) expect(third.message).toBe('2 players are already open on the landscape feed (the most at once). Try again when one is closed.');
    // Refused before MediaMTX is asked (no extra session there).
    expect(calls).toHaveLength(n);
    ok(await live.open('default', 'vertical', 'session:c'));
  });

  it('opening another player at the cap replaces your own oldest one (a page reload never locks you out)', async () => {
    const live = service(2);
    const first = ok(await live.open('default', 'landscape', 'session:a'));
    clock += 1000;
    ok(await live.open('default', 'landscape', 'session:b'));
    clock += 1000;
    ok(await live.open('default', 'landscape', 'session:a'));
    expect(live.viewerCount('default', 'landscape')).toBe(2);
    const oldV = viewerOf(first.kind === 'playlist' ? first.body : '');
    expect(await live.file('default', 'landscape', 'video1_stream.m3u8', { v: oldV }, 'session:a')).toMatchObject({ code: 'live_ended' });
  });

  it('a player that stops asking leaves after VIEWER_IDLE_MS; one that keeps playing stays', async () => {
    const live = service(1);
    const r = ok(await live.open('default', 'landscape', 'session:a'));
    const v = viewerOf(r.kind === 'playlist' ? r.body : '');
    for (let i = 0; i < 10; i++) {
      clock += VIEWER_IDLE_MS / 2;
      ok(await live.file('default', 'landscape', 'video1_stream.m3u8', { v }, 'session:a'));
    }
    expect(await live.open('default', 'landscape', 'session:b')).toMatchObject({ code: 'viewer_cap' });
    clock += VIEWER_IDLE_MS + 1;
    expect(live.viewerCount('default', 'landscape')).toBe(0);
    expect(await live.file('default', 'landscape', 'video1_stream.m3u8', { v }, 'session:a')).toMatchObject({ code: 'live_ended' });
    ok(await live.open('default', 'landscape', 'session:b'));
  });
});
