// Guest feeds (docs/API.md §18, API 1.17): remote video a guest sends to Relay over RTMP, which
// CTD OBS pulls back as a source over LL-HLS. Shared by the server (web UI routes, external API,
// event hub) and the web UI. Pure: no runtime dependencies.

import type { SrtStatus } from './srt.js';
import type { SrtlaEndpoint, SrtlaStatus } from './srtla.js';
import type { FeedProblem } from './feed-codec.js';
import type { FeedState } from './types.js';

/** A slot id: 10 characters [a-z0-9], fixed for the slot's life, never reused. */
export const GUEST_SLOT_RE = /^[a-z0-9]{10}$/;
export const GUEST_NAME_MAX = 60;

/** Defaults of the server's limits (env GUEST_FEEDS_MAX, GUEST_FEED_MAX_VIEWERS, GUEST_FEED_WARN_KBPS, GUEST_FEED_MAX_KBPS). */
export const DEFAULT_GUEST_FEEDS_MAX = 4;
export const DEFAULT_GUEST_FEED_MAX_VIEWERS = 2;
export const DEFAULT_GUEST_FEED_WARN_KBPS = 8_000;
export const DEFAULT_GUEST_FEED_MAX_KBPS = 20_000;

/** RTMP application (path prefix) guests publish to: rtmp://<host>:<port>/guest, stream key `<slot>?key=<k>`. */
export const GUEST_APP_NAME = 'guest';

export type GuestKeyState = 'active' | 'revoked';

/** One guest feed slot and what its guest sends right now (docs/API.md §18.1). */
export interface GuestFeed {
  slot: string;
  name: string;
  key: GuestKeyState;
  online: boolean;
  since: string | null;
  video: FeedState['video'];
  audio: FeedState['audio'];
  bitrateKbps: number | null;
  bitrateWarning: boolean;
  problem: FeedProblem | null;
  /** When Relay last disconnected this guest for going over `maxKbps` (kept 10 minutes), else null. */
  limitedAt: string | null;
}

/** GET /api/v1/profiles/{id}/guest-feeds, GET /api/profiles/:id/guest-feeds, guest.feeds.changed (§18.2). */
export interface GuestFeedList {
  profileId: string;
  maxSlots: number;
  maxViewers: number;
  warnAboveKbps: number;
  /** 0 = no hard limit. */
  maxKbps: number;
  guestFeeds: GuestFeed[];
}

/**
 * [admin] What a guest needs to send (web UI only; never in the external API):
 * GET/POST /api/profiles/:id/guest-feeds/:slot/ingest, …/rotate.
 */
export interface GuestIngestInfo {
  profileId: string;
  slot: string;
  /** rtmp://<host>:<port>/guest */
  serverUrl: string;
  /** `<slot>?key=<key>`; null when the key is revoked. */
  streamKey: string | null;
  /** serverUrl + '/' + streamKey; null when the key is revoked. */
  fullUrl: string | null;
  /** 0.2.100: the same over SRT (docs/SRT.md, OBS Server field, stream key empty); null when revoked or SRT is off. */
  srtUrl?: string | null;
  /** 0.2.100: whether SRT works here. */
  srt?: SrtStatus;
  /** 0.2.110: the same for a bonded SRTLA sender (docs/SRTLA.md); null when revoked or SRTLA is off. */
  srtla?: SrtlaEndpoint | null;
  /** 0.2.110: whether SRTLA works here. */
  srtlaStatus?: SrtlaStatus;
}

/** POST /api/profiles/:id/guest-feeds [admin] → 201 { guestFeed, ingest } */
export interface CreateGuestFeedRequest {
  name: string;
}
export interface CreateGuestFeedResponse {
  guestFeed: GuestFeed;
  ingest: GuestIngestInfo;
}
/** PATCH /api/profiles/:id/guest-feeds/:slot [admin] → GuestFeed */
export interface RenameGuestFeedRequest {
  name: string;
}

/** Trim and collapse whitespace; null when empty or too long. */
export function cleanGuestName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  if (name.length === 0 || name.length > GUEST_NAME_MAX) return null;
  // No control characters (names end up in issue titles and notifications).
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/** The orientation to frame a guest feed in (thumbnails, player): vertical when taller than wide. */
export function guestOrientation(feed: Pick<GuestFeed, 'video'>): 'landscape' | 'vertical' {
  const w = feed.video?.width;
  const h = feed.video?.height;
  return w && h && h > w ? 'vertical' : 'landscape';
}

/** "1280×720 · H.264 · 3.5 Mbps"-style parts, for status lines. */
export function formatKbps(kbps: number | null): string | null {
  if (kbps === null || !Number.isFinite(kbps)) return null;
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
}
