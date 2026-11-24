// Feed previews in the web UI (docs/PREVIEW.md): what a thumbnail or the live player should do, as
// pure functions the components and tests share.

import { feedProblem, type FeedProblem } from '@shared/feed-codec';
import type { FeedState } from '@shared/types';

/** Thumbnails refresh this often while the page is visible and the feed is online. */
export const THUMB_REFRESH_MS = 3_000;
/** Feed state unknown (the Profiles page): look this often whether it came online. */
export const THUMB_PROBE_MS = 10_000;
/** After a failed grab (503), wait a little longer. */
export const THUMB_RETRY_MS = 5_000;

export type ThumbMode =
  /** Refresh every THUMB_REFRESH_MS. */
  | 'live'
  /** Online status unknown: ask every THUMB_PROBE_MS, show what comes back. */
  | 'probe'
  /** Offline: placeholder, no requests. */
  | 'offline'
  /** HEVC/AV1: Relay can't decode a frame of it; show the codec warning, no requests. */
  | 'codec'
  /** Page hidden: keep the last frame, no requests. */
  | 'paused';

/**
 * `online` undefined = not known here (the Profiles page has no feed states): probe. A feed whose
 * video is HEVC/AV1 never gets a frame (FFmpeg reads it over classic RTMP, which can't carry it).
 */
export function thumbMode(state: Pick<FeedState, 'feed' | 'online' | 'video' | 'audio'> | null | undefined, visible: boolean): ThumbMode {
  if (state && state.online && feedProblem(state)?.blocking) return 'codec';
  if (state && !state.online) return 'offline';
  if (!visible) return 'paused';
  return state ? 'live' : 'probe';
}

/** Delay before the next thumbnail request, after one that ended with `status` (0 = network error). */
export function nextThumbDelay(mode: ThumbMode, status: number): number | null {
  if (mode !== 'live' && mode !== 'probe') return null;
  // A frame came back (also when probing): the feed is online, keep it fresh.
  if (status === 200) return THUMB_REFRESH_MS;
  if (status === 404) return THUMB_PROBE_MS;
  if (status === 401) return null; // logged out: the app shell takes over
  return mode === 'live' ? THUMB_RETRY_MS : THUMB_PROBE_MS;
}

/** The problem to show instead of a player (HEVC/AV1 video), else null. */
export function blockingProblem(state: Pick<FeedState, 'feed' | 'online' | 'video' | 'audio'> | null | undefined): FeedProblem | null {
  const p = state?.online ? feedProblem(state) : null;
  return p?.blocking ? p : null;
}

// ---- live player ------------------------------------------------------

export type PlayerErrorKind =
  /** Retry by itself (MediaMTX restarting, network blip, the viewer expired). */
  | 'retry'
  /** The feed is offline: wait for it to come back. */
  | 'offline'
  /** Show the message, offer "Try again" (viewer cap, live preview off). */
  | 'stop'
  /** HEVC/AV1: show the codec message. */
  | 'codec'
  /** Logged out. */
  | 'auth';

export interface PlayerError {
  kind: PlayerErrorKind;
  message: string;
  /** For 'retry': wait this long (ms). */
  retryMs?: number;
}

/**
 * What to do after the live playlist failed: `status`/`code`/`message` from re-asking the server
 * (`GET live.m3u8`), status 0 when it couldn't be reached. `attempt` counts retries in a row.
 */
export function playerError(status: number, code: string | undefined, message: string | undefined, attempt: number, retryAfterSec?: number): PlayerError {
  const backoff = Math.min(1000 * 2 ** Math.min(attempt, 4), 10_000);
  if (status === 401) return { kind: 'auth', message: 'Sign in again to watch.' };
  if (code === 'feed_codec' || status === 409) return { kind: 'codec', message: message ?? "This feed's codec can't be previewed." };
  if (code === 'feed_offline') return { kind: 'offline', message: 'The feed is offline. The player starts again when OBS sends it.' };
  if (code === 'viewer_cap' || code === 'live_off' || status === 429) {
    return { kind: 'stop', message: message ?? 'The live preview is not available right now.' };
  }
  if (status === 0) return { kind: 'retry', message: "Can't reach Relay; trying again…", retryMs: backoff };
  const wait = retryAfterSec && retryAfterSec > 0 ? Math.min(retryAfterSec * 1000, 30_000) : backoff;
  return { kind: 'retry', message: 'Reconnecting…', retryMs: wait };
}

/** Retries in a row before the player gives up and offers "Try again". */
export const MAX_PLAYER_RETRIES = 6;

/** Peak level of an audio frame (−1…1 samples) on a 0…1 meter scale: −60 dBFS = 0, 0 dBFS = 1. */
export function meterLevel(samples: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i] ?? 0);
    if (v > peak) peak = v;
  }
  if (peak <= 0.001) return 0;
  const db = 20 * Math.log10(peak);
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

/** A meter that rises at once and falls back slowly (like a PPM): `prev` and `next` on the 0…1 scale. */
export function meterDecay(prev: number, next: number, dtMs: number): number {
  if (next >= prev) return next;
  // About 20 dB per second at the 60 dB scale.
  return Math.max(next, prev - dtMs / 3000);
}

/** "1.4 s" behind live, or null when unknown. */
export function formatDelay(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

const VOLUME_KEY = 'ctd.preview.volume';

/** The volume this browser last used (0…1), default 0.8. */
export function loadVolume(storage: Pick<Storage, 'getItem'> | null = safeStorage()): number {
  const v = Number(storage?.getItem(VOLUME_KEY) ?? NaN);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.8;
}
export function saveVolume(volume: number, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(VOLUME_KEY, String(Math.max(0, Math.min(1, volume))));
  } catch {
    // private mode / blocked storage: the volume just isn't remembered
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
