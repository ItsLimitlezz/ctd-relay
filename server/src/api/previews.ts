// Feed previews (docs/API.md §10, v1.4): a JPEG of what OBS sends on a profile's landscape /
// vertical feed, for apps like CTD Live mobile. Made on request with the bundled FFmpeg from the
// local MediaMTX feed (one keyframe, decoded only that frame, scaled to 640 px wide) and cached a few
// seconds, so polling clients share one grab. Nothing runs while nobody asks.

import { spawn } from 'node:child_process';
import type { Feed } from '../../../shared/types.js';

/**
 * A preview younger than this is served from the cache: the web UI refreshes its thumbnails every
 * 3 s, so every refresh gets a new frame; however many clients poll, a feed gets at most one grab
 * per 2.5 s.
 */
export const PREVIEW_MAX_AGE_MS = 2_500;
const GRAB_TIMEOUT_MS = 10_000;
const MAX_JPEG_BYTES = 2 * 1024 * 1024;
export const PREVIEW_WIDTH = 640;

export interface Preview {
  jpeg: Buffer;
  /** Epoch ms the frame was grabbed. */
  at: number;
}

/** `K` names one stream of a profile: a Feed, or a guest slot id (guest feeds, docs/API.md §18). */
export interface PreviewDeps<K extends string = Feed> {
  /** Is the feed online (OBS sending it)? */
  online(profileId: string, feed: K): boolean;
  /** One JPEG frame of the feed (rejects on failure). */
  grab(profileId: string, feed: K): Promise<Buffer>;
  now?: () => number;
}

export class PreviewService<K extends string = Feed> {
  private readonly cache = new Map<string, Preview>();
  private readonly inflight = new Map<string, Promise<Preview>>();
  private readonly now: () => number;

  constructor(private readonly deps: PreviewDeps<K>) {
    this.now = deps.now ?? Date.now;
  }

  /** The feed's preview, fresh within PREVIEW_MAX_AGE_MS, or null when the feed is offline. */
  async get(profileId: string, feed: K): Promise<Preview | null> {
    const key = `${profileId}:${feed}`;
    if (!this.deps.online(profileId, feed)) {
      this.cache.delete(key);
      return null;
    }
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < PREVIEW_MAX_AGE_MS) return cached;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.deps.grab(profileId, feed).then((jpeg) => {
        const p = { jpeg, at: this.now() };
        this.cache.set(key, p);
        return p;
      });
      this.inflight.set(key, pending);
      void pending.finally(() => this.inflight.delete(key)).catch(() => {});
    }
    try {
      return await pending;
    } catch (err) {
      // A failed grab with a recent frame: serve the last one rather than nothing.
      if (cached) return cached;
      throw err;
    }
  }

  forgetProfile(profileId: string): void {
    for (const key of [...this.cache.keys()]) if (key.startsWith(`${profileId}:`)) this.cache.delete(key);
  }
}

/** FFmpeg arguments for one preview frame of `input` (an RTMP read URL), JPEG on stdout. */
export function previewArgs(input: string): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    // Decode keyframes only: the first one is the preview, nothing else is decoded.
    '-skip_frame', 'nokey',
    '-rw_timeout', '8000000',
    '-i', input,
    '-an',
    '-frames:v', '1',
    '-vf', `scale=${PREVIEW_WIDTH}:-2`,
    '-q:v', '5',
    '-f', 'image2pipe',
    '-c:v', 'mjpeg',
    'pipe:1',
  ];
}

/** Run FFmpeg once and collect the JPEG it writes (never logs the input URL: it holds the reader password). */
export function grabWithFfmpeg(ffmpegBin: string, input: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin, previewArgs(input), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('preview grab timed out'));
    }, GRAB_TIMEOUT_MS);
    child.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size > MAX_JPEG_BYTES) {
        child.kill('SIGKILL');
        return;
      }
      chunks.push(b);
    });
    child.stderr.on('data', (b: Buffer) => {
      if (err.length < 400) err += b.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const jpeg = Buffer.concat(chunks);
      // JPEG starts with FF D8.
      if (code === 0 && jpeg.length > 2 && jpeg[0] === 0xff && jpeg[1] === 0xd8) resolve(jpeg);
      else reject(new Error(`preview grab failed (exit ${code ?? 'signal'}): ${err.replace(/rtmp:\/\/\S+/g, '<feed>').trim().slice(0, 200)}`));
    });
  });
}

const services = new WeakMap<object, PreviewService>();

/** The preview service of these services (created on first use). */
export function previewServiceFor(key: object, deps: () => PreviewDeps): PreviewService {
  let s = services.get(key);
  if (!s) {
    s = new PreviewService(deps());
    services.set(key, s);
  }
  return s;
}
