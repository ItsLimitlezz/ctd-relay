// Live preview ("Watch", docs/PREVIEW.md): a feed's Low-Latency HLS from the loopback MediaMTX,
// proxied through Relay's own authenticated HTTP server (web UI session cookie, or an API token).
//
// MediaMTX (v1.21.2) muxes a feed on demand: the first playlist request starts a muxer that copies
// the H.264 + AAC tracks into fMP4 parts (no transcoding), and it closes 30 s after the last request
// (hlsMuxerCloseAfter). Each reader gets a MediaMTX session (`?session=<uuid>` in every URI of its
// playlists); MediaMTX checks the reader password only when the session is created. That session id
// never leaves the server: every playlist we pass on has it replaced by our own viewer id (`?v=`),
// which only works together with the Relay login (or token) that opened it. MediaMTX listens on
// 127.0.0.1 only; browsers and apps never reach it.
//
// A viewer is one open player: it asks for the playlist every part (200 ms) while it plays, so one
// that hasn't asked for VIEWER_IDLE_MS has left. At most `maxViewers` per feed at once; a login (or
// token) that opens another player while the feed is full replaces its own oldest one, so reloading
// the page never locks you out.

import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { feedProblem } from '../../../shared/feed-codec.js';
import type { Feed, FeedState } from '../../../shared/types.js';

/** Viewers per feed at once (LIVE_PREVIEW_MAX_VIEWERS). */
export const DEFAULT_LIVE_MAX_VIEWERS = 4;
/** A viewer that asked for nothing this long has closed the player. */
export const VIEWER_IDLE_MS = 15_000;
/** The first playlist request starts the muxer: MediaMTX answers once it has a segment. */
const OPEN_TIMEOUT_MS = 15_000;
/** Blocking playlist reloads and preload-hinted parts wait for the next part (a few hundred ms). */
const FILE_TIMEOUT_MS = 20_000;
const MAX_PLAYLIST_CHARS = 256 * 1024;

export const PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
/** A playlist or fMP4 part/segment/init file as MediaMTX names them (no paths, no dots but the extension). */
export const LIVE_FILE_RE = /^[A-Za-z0-9_-]{1,128}\.(m3u8|mp4)$/;
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VIEWER_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/** LL-HLS delivery directives a player may add to a media playlist request (RFC 8216bis 6.2.5). */
const DIRECTIVES: Record<string, RegExp> = {
  _HLS_msn: /^\d{1,10}$/,
  _HLS_part: /^\d{1,6}$/,
  _HLS_skip: /^(YES|v2)$/,
};

export type LiveErrorCode = 'live_off' | 'feed_offline' | 'feed_codec' | 'viewer_cap' | 'live_ended' | 'not_found' | 'unavailable';

export interface LiveError {
  ok: false;
  status: number;
  code: LiveErrorCode;
  message: string;
  retryAfterSec?: number;
}
export interface LivePlaylist {
  ok: true;
  kind: 'playlist';
  body: string;
}
export interface LiveMedia {
  ok: true;
  kind: 'media';
  contentType: string;
  contentLength: string | null;
  body: Readable;
}
export type LiveResult = LivePlaylist | LiveMedia | LiveError;

export interface LiveSource {
  /** Ends in '/': `http://127.0.0.1:<hls port>/live/<feed>/`. */
  baseUrl: string;
  /** `Basic …` with the internal reader password. */
  authorization: string;
}

export interface LivePreviewDeps {
  feed(profileId: string, feed: Feed): FeedState;
  /** Where the feed's HLS is (null: HLS off or MediaMTX not running). */
  source(profileId: string, feed: Feed): LiveSource | null;
  /** Viewers per feed at once; 0 = the live preview is off. */
  maxViewers: number;
  fetch?: typeof fetch;
  now?: () => number;
  newViewerId?: () => string;
  /** Never gets a URL, a session id or a header (they would hand out the stream). */
  warn?: (fields: Record<string, unknown>, msg: string) => void;
}

interface Viewer {
  id: string;
  /** Who opened it: 'session:<auth session>' (web UI) or 'token:<token id>' (API). */
  who: string;
  profileId: string;
  feed: Feed;
  /** MediaMTX's session id for this reader (server-side only; '' while opening). */
  upstream: string;
  lastSeen: number;
  /**
   * Opening: the playlist request to MediaMTX is in flight. The slot counts toward the cap from the
   * start, so players that open at the same moment can't all pass the check together (the first
   * playlist can take a few seconds while MediaMTX starts the muxer).
   */
  opening?: boolean;
}

const FEED_NAME: Record<Feed, string> = { landscape: 'landscape', vertical: 'vertical' };

function fail(status: number, code: LiveErrorCode, message: string, retryAfterSec?: number): LiveError {
  return { ok: false, status, code, message, ...(retryAfterSec ? { retryAfterSec } : {}) };
}

/**
 * Rewrite every URI of a MediaMTX playlist: `<name>?session=<upstream>` → `<prefix><name>?v=<viewer>`.
 * Returns null when a URI is anything else (an absolute URL, a path, another session), so nothing
 * we didn't expect is ever passed on.
 */
export function rewritePlaylist(text: string, opts: { upstream: string; viewerId: string; prefix: string }): string | null {
  if (!text.startsWith('#EXTM3U')) return null;
  let ok = true;
  const rewrite = (uri: string): string => {
    const q = uri.indexOf('?');
    const name = q < 0 ? uri : uri.slice(0, q);
    if (!LIVE_FILE_RE.test(name)) {
      ok = false;
      return uri;
    }
    if (q >= 0) {
      const params = new URLSearchParams(uri.slice(q + 1));
      const session = params.get('session');
      const keys = [...params.keys()];
      if (session !== opts.upstream || keys.some((k) => k !== 'session')) {
        ok = false;
        return uri;
      }
    }
    return `${opts.prefix}${name}?v=${opts.viewerId}`;
  };
  const out = text.split('\n').map((raw) => {
    const line = raw.replace(/\r$/, '');
    if (line === '') return line;
    if (line.startsWith('#')) return line.replace(/URI="([^"]*)"/g, (_m, uri: string) => `URI="${rewrite(uri)}"`);
    return rewrite(line.trim());
  });
  return ok ? out.join('\n') : null;
}

/** The MediaMTX session id every URI of a multivariant playlist carries (all the same), else null. */
export function upstreamSession(text: string): string | null {
  const ids = new Set([...text.matchAll(/[?&]session=([^&"\s]+)/g)].map((m) => m[1] ?? ''));
  if (ids.size !== 1) return null;
  const [id] = [...ids];
  return id && SESSION_RE.test(id) ? id : null;
}

export class LivePreviewService {
  private readonly viewers = new Map<string, Viewer>();
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly newViewerId: () => string;

  constructor(private readonly deps: LivePreviewDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.newViewerId = deps.newViewerId ?? (() => randomBytes(16).toString('base64url'));
  }

  get maxViewers(): number {
    return this.deps.maxViewers;
  }

  /** Open players on a feed right now. */
  viewerCount(profileId: string, feed: Feed): number {
    this.prune();
    let n = 0;
    for (const v of this.viewers.values()) if (v.profileId === profileId && v.feed === feed) n++;
    return n;
  }

  /** Can this feed be watched now? Null when yes, else why not (same errors as open()). */
  check(profileId: string, feed: Feed): LiveError | null {
    if (this.deps.maxViewers <= 0) {
      return fail(503, 'live_off', 'The live preview is turned off on this server (LIVE_PREVIEW_MAX_VIEWERS=0).');
    }
    const state = this.deps.feed(profileId, feed);
    if (!state.online) return fail(404, 'feed_offline', `The ${FEED_NAME[feed]} feed is offline (OBS isn't sending it).`);
    const problem = feedProblem(state);
    // HEVC/AV1: browsers can't be counted on to play it, and the guard already blocks every destination.
    if (problem?.blocking) return fail(409, 'feed_codec', problem.message);
    return null;
  }

  /**
   * GET live.m3u8: a new player. Starts the feed's muxer if nobody watches yet and returns the
   * multivariant playlist, its URIs pointing at `live/<file>?v=<viewer>`.
   */
  async open(profileId: string, feed: Feed, who: string, signal?: AbortSignal): Promise<LiveResult> {
    const blocked = this.check(profileId, feed);
    if (blocked) return blocked;
    const source = this.deps.source(profileId, feed);
    if (!source) return fail(503, 'unavailable', "The media server isn't running; retry in a few seconds.", 5);

    this.prune();
    const watching = [...this.viewers.values()].filter((v) => v.profileId === profileId && v.feed === feed);
    if (watching.length >= this.deps.maxViewers) {
      const mine = watching.filter((v) => v.who === who && !v.opening).sort((a, b) => a.lastSeen - b.lastSeen);
      const oldest = mine[0];
      if (!oldest) {
        const max = this.deps.maxViewers;
        return fail(
          429,
          'viewer_cap',
          `${max} ${max === 1 ? 'player is' : 'players are'} already open on the ${FEED_NAME[feed]} feed (the most at once). Try again when one is closed.`,
          Math.ceil(VIEWER_IDLE_MS / 1000),
        );
      }
      this.viewers.delete(oldest.id);
    }
    const viewerId = this.newViewerId();
    if (!VIEWER_ID_RE.test(viewerId) || this.viewers.has(viewerId)) {
      return fail(503, 'unavailable', "Couldn't start the live preview right now; retry in a few seconds.", 5);
    }
    // Hold the slot before waiting for MediaMTX (see Viewer.opening); give it back on any failure.
    const slot: Viewer = { id: viewerId, who, profileId, feed, upstream: '', lastSeen: this.now(), opening: true };
    this.viewers.set(viewerId, slot);
    const release = () => {
      if (this.viewers.get(viewerId) === slot) this.viewers.delete(viewerId);
    };

    let res: Response;
    const timeout = AbortSignal.timeout(OPEN_TIMEOUT_MS);
    try {
      // `cookieCheck=1` without a cookie: MediaMTX puts the session in the URIs instead of a cookie.
      res = await this.fetch(`${source.baseUrl}index.m3u8?cookieCheck=1`, {
        headers: { authorization: source.authorization },
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      release();
      if (signal?.aborted) return fail(503, 'unavailable', 'The request was cancelled.');
      this.deps.warn?.({ profileId, feed, error: errorName(err) }, 'live preview: MediaMTX HLS did not answer');
      return fail(503, 'unavailable', "Couldn't start the live preview right now; retry in a few seconds.", 5);
    }
    if (res.status === 404) {
      release();
      void res.body?.cancel();
      return fail(404, 'feed_offline', `The ${FEED_NAME[feed]} feed is offline (OBS isn't sending it).`);
    }
    if (res.status !== 200) {
      release();
      void res.body?.cancel();
      this.deps.warn?.({ profileId, feed, status: res.status }, 'live preview: MediaMTX HLS refused the playlist');
      return fail(503, 'unavailable', "Couldn't start the live preview right now; retry in a few seconds.", 5);
    }
    const text = await readText(res);
    const upstream = text === null ? null : upstreamSession(text);
    const body = text !== null && upstream ? rewritePlaylist(text, { upstream, viewerId, prefix: 'live/' }) : null;
    if (!body || !upstream) {
      release();
      this.deps.warn?.({ profileId, feed }, 'live preview: unexpected playlist from MediaMTX');
      return fail(503, 'unavailable', "Couldn't start the live preview right now; retry in a few seconds.", 5);
    }
    if (signal?.aborted) {
      // The player went away while MediaMTX answered: nobody will use this viewer.
      release();
      return fail(503, 'unavailable', 'The request was cancelled.');
    }
    slot.upstream = upstream;
    slot.lastSeen = this.now();
    delete slot.opening;
    this.viewers.set(viewerId, slot);
    return { ok: true, kind: 'playlist', body };
  }

  /** GET live/<file>?v=<viewer>: a media playlist (rewritten) or an fMP4 part/segment (streamed). */
  async file(profileId: string, feed: Feed, name: string, query: Record<string, unknown>, who: string, signal?: AbortSignal): Promise<LiveResult> {
    if (!LIVE_FILE_RE.test(name)) return fail(404, 'not_found', 'No such live preview file.');
    const vid = typeof query.v === 'string' ? query.v : '';
    this.prune();
    const viewer = VIEWER_ID_RE.test(vid) ? this.viewers.get(vid) : undefined;
    if (!viewer || viewer.opening || viewer.who !== who || viewer.profileId !== profileId || viewer.feed !== feed) {
      return fail(410, 'live_ended', 'This live preview ended; open it again.');
    }
    const blocked = this.check(profileId, feed);
    if (blocked) {
      this.viewers.delete(viewer.id);
      return blocked;
    }
    const source = this.deps.source(profileId, feed);
    if (!source) return fail(503, 'unavailable', "The media server isn't running; retry in a few seconds.", 5);
    viewer.lastSeen = this.now();

    const params = new URLSearchParams({ session: viewer.upstream });
    for (const [key, re] of Object.entries(DIRECTIVES)) {
      const value = query[key];
      if (typeof value === 'string' && re.test(value)) params.set(key, value);
    }
    const timeout = AbortSignal.timeout(FILE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetch(`${source.baseUrl}${name}?${params.toString()}`, {
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (signal?.aborted) return fail(503, 'unavailable', 'The request was cancelled.');
      this.deps.warn?.({ profileId, feed, error: errorName(err) }, 'live preview: MediaMTX HLS did not answer');
      return fail(503, 'unavailable', 'The live preview stalled; retry.', 1);
    }
    if (res.status === 401 || res.status === 403) {
      // MediaMTX closed the session (its muxer stopped): the player has to open a new one.
      void res.body?.cancel();
      this.viewers.delete(viewer.id);
      return fail(410, 'live_ended', 'This live preview ended; open it again.');
    }
    if (res.status === 404) {
      void res.body?.cancel();
      return fail(404, 'not_found', 'That part of the live preview is gone (the player fell behind).');
    }
    if (res.status !== 200 || !res.body) {
      void res.body?.cancel();
      return fail(503, 'unavailable', 'The live preview stalled; retry.', 1);
    }
    viewer.lastSeen = this.now();
    if (name.endsWith('.m3u8')) {
      const text = await readText(res);
      const body = text === null ? null : rewritePlaylist(text, { upstream: viewer.upstream, viewerId: viewer.id, prefix: '' });
      if (!body) {
        this.deps.warn?.({ profileId, feed }, 'live preview: unexpected playlist from MediaMTX');
        return fail(503, 'unavailable', 'The live preview stalled; retry.', 1);
      }
      return { ok: true, kind: 'playlist', body };
    }
    const type = res.headers.get('content-type') ?? '';
    return {
      ok: true,
      kind: 'media',
      contentType: /^(video|audio)\/mp4$/.test(type) ? type : 'video/mp4',
      contentLength: res.headers.get('content-length'),
      body: Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>),
    };
  }

  private prune(): void {
    const cutoff = this.now() - VIEWER_IDLE_MS;
    // An opening slot is given back by open() itself (it waits at most OPEN_TIMEOUT_MS).
    for (const [id, v] of this.viewers) if (!v.opening && v.lastSeen < cutoff) this.viewers.delete(id);
  }
}

async function readText(res: Response): Promise<string | null> {
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_PLAYLIST_CHARS) {
    void res.body?.cancel();
    return null;
  }
  const text = await res.text().catch(() => null);
  return text !== null && text.length <= MAX_PLAYLIST_CHARS ? text : null;
}

function errorName(err: unknown): string {
  if (err instanceof Error) return err.name === 'TimeoutError' ? 'timed out' : err.name;
  return 'error';
}

const services = new WeakMap<object, LivePreviewService>();

/** The live preview service of these services (created on first use). */
export function livePreviewServiceFor(key: object, deps: () => LivePreviewDeps): LivePreviewService {
  let s = services.get(key);
  if (!s) {
    s = new LivePreviewService(deps());
    services.set(key, s);
  }
  return s;
}
