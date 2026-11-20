import { describe, expect, it } from 'vitest';
import type { FeedState } from '@shared/types';
import { feedLiveUrl, feedPreviewUrl } from '../api';
import {
  blockingProblem,
  formatDelay,
  loadVolume,
  meterDecay,
  meterLevel,
  nextThumbDelay,
  playerError,
  saveVolume,
  THUMB_PROBE_MS,
  THUMB_REFRESH_MS,
  THUMB_RETRY_MS,
  thumbMode,
} from './feed-preview';

const feed = (over: Partial<FeedState> = {}): FeedState => ({
  feed: 'landscape',
  online: true,
  since: '2026-11-20T18:00:00.000Z',
  video: { codec: 'h264', width: 1920, height: 1080 },
  audio: { codec: 'aac' },
  bitrateKbps: 6000,
  ...over,
});

describe('preview URLs', () => {
  it('are same-origin paths with the profile in the path (relative playlist URIs keep it), nothing secret', () => {
    expect(feedPreviewUrl('default', 'landscape')).toBe('/api/profiles/default/feeds/landscape/preview.jpg');
    expect(feedLiveUrl('a b/c', 'vertical')).toBe('/api/profiles/a%20b%2Fc/feeds/vertical/live.m3u8');
  });
});

describe('thumbMode', () => {
  it('refreshes only while visible and online', () => {
    expect(thumbMode(feed(), true)).toBe('live');
    expect(thumbMode(feed(), false)).toBe('paused');
    expect(thumbMode(feed({ online: false }), true)).toBe('offline');
    expect(thumbMode(feed({ online: false }), false)).toBe('offline');
  });

  it('unknown state (Profiles page): probe while visible', () => {
    expect(thumbMode(undefined, true)).toBe('probe');
    expect(thumbMode(undefined, false)).toBe('paused');
  });

  it('HEVC/AV1: the codec warning, never a request', () => {
    expect(thumbMode(feed({ video: { codec: 'hevc' } }), true)).toBe('codec');
    expect(thumbMode(feed({ feed: 'vertical', video: { codec: 'av1' } }), true)).toBe('codec');
    // Opus audio still has a picture.
    expect(thumbMode(feed({ audio: { codec: 'opus' } }), true)).toBe('live');
  });
});

describe('nextThumbDelay', () => {
  it('every 3 s with frames, slower when offline or failing, nothing when stopped or signed out', () => {
    expect(THUMB_REFRESH_MS).toBe(3000);
    expect(nextThumbDelay('live', 200)).toBe(THUMB_REFRESH_MS);
    expect(nextThumbDelay('probe', 200)).toBe(THUMB_REFRESH_MS);
    expect(nextThumbDelay('probe', 404)).toBe(THUMB_PROBE_MS);
    expect(nextThumbDelay('live', 503)).toBe(THUMB_RETRY_MS);
    expect(nextThumbDelay('live', 0)).toBe(THUMB_RETRY_MS);
    expect(nextThumbDelay('live', 401)).toBeNull();
    for (const m of ['paused', 'offline', 'codec'] as const) expect(nextThumbDelay(m, 200)).toBeNull();
  });
});

describe('blockingProblem', () => {
  it('HEVC/AV1 on an online feed only', () => {
    expect(blockingProblem(feed({ video: { codec: 'hevc' } }))?.message).toMatch(/^Landscape feed is HEVC\./);
    expect(blockingProblem(feed({ online: false, video: { codec: 'hevc' } }))).toBeNull();
    expect(blockingProblem(feed({ audio: { codec: 'opus' } }))).toBeNull();
    expect(blockingProblem(undefined)).toBeNull();
  });
});

describe('playerError', () => {
  it('maps the server answer to what the player does', () => {
    expect(playerError(409, 'feed_codec', 'Vertical feed is HEVC. …', 0)).toEqual({ kind: 'codec', message: 'Vertical feed is HEVC. …' });
    expect(playerError(404, 'feed_offline', 'x', 0).kind).toBe('offline');
    expect(playerError(429, 'viewer_cap', '4 players are already open', 0)).toEqual({ kind: 'stop', message: '4 players are already open' });
    expect(playerError(503, 'live_off', 'off', 0).kind).toBe('stop');
    expect(playerError(401, 'unauthenticated', 'x', 0).kind).toBe('auth');
  });

  it('retries with back-off, honouring Retry-After', () => {
    expect(playerError(503, 'unavailable', 'x', 0, 5)).toEqual({ kind: 'retry', message: 'Reconnecting…', retryMs: 5000 });
    expect(playerError(0, undefined, undefined, 0).retryMs).toBe(1000);
    expect(playerError(0, undefined, undefined, 3).retryMs).toBe(8000);
    expect(playerError(500, 'internal', 'x', 9).retryMs).toBe(10_000);
  });
});

describe('audio meter', () => {
  it('peak in dBFS on a 60 dB scale', () => {
    expect(meterLevel(new Float32Array(16))).toBe(0);
    expect(meterLevel(Float32Array.from([0, 1, -0.2]))).toBe(1);
    expect(meterLevel(Float32Array.from([0.1, -0.05]))).toBeCloseTo(40 / 60, 3); // −20 dBFS
    expect(meterLevel(Float32Array.from([-0.0005]))).toBe(0);
  });

  it('rises at once, falls slowly', () => {
    expect(meterDecay(0.2, 0.9, 16)).toBe(0.9);
    expect(meterDecay(0.9, 0, 300)).toBeCloseTo(0.8, 5);
    expect(meterDecay(0.05, 0, 1000)).toBe(0);
  });
});

describe('formatDelay', () => {
  it('one decimal under 10 s', () => {
    expect(formatDelay(1.234)).toBe('1.2 s');
    expect(formatDelay(12.6)).toBe('13 s');
    expect(formatDelay(null)).toBeNull();
    expect(formatDelay(-1)).toBeNull();
    expect(formatDelay(Number.NaN)).toBeNull();
  });
});

describe('volume', () => {
  it('is remembered per browser, 0.8 by default, clamped', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadVolume(storage)).toBe(0.8);
    saveVolume(0.35, storage);
    expect(loadVolume(storage)).toBe(0.35);
    saveVolume(7, storage);
    expect(loadVolume(storage)).toBe(1);
    store.set('ctd.preview.volume', 'loud');
    expect(loadVolume(storage)).toBe(0.8);
    expect(loadVolume(null)).toBe(0.8);
    expect(() => saveVolume(0.5, { setItem: () => { throw new Error('quota'); } })).not.toThrow();
  });
});
