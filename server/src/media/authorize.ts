// Pure decision logic for MediaMTX HTTP auth requests.
// Request fields (v1.21.2): user, password, token, ip, action, path, protocol, id, query, userAgent.
// For RTMP, MediaMTX takes user/password from the URL query (?user=..&pass=..) and passes the raw
// query string as `query`. https://github.com/bluenviron/mediamtx/blob/v1.21.2/docs/2-features/06-authentication.md

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Feed } from '../../../shared/types.js';
import type { MediaMtxAuthRequest } from '../services.js';
import { INTERNAL_READER_USER, parseFeedPath, parseGuestPath, type IngestRoute } from './paths.js';

/** One profile's publish keys (OBS stream keys), one per feed. */
export type ProfileIngestKeys = Record<Feed, string>;

/** The default profile's secrets in scope 'ingest': its publish keys + the internal reader password. */
export type IngestSecrets = Record<Feed | 'internalReader', string>;

/** Secret names of a profile's publish keys. The default profile's scope also holds 'internalReader'. */
export const FEED_KEY_NAMES = ['landscape', 'vertical'] as const satisfies readonly Feed[];
export const INTERNAL_READER_KEY = 'internalReader';
export const INGEST_SECRET_NAMES = [...FEED_KEY_NAMES, INTERNAL_READER_KEY] as const satisfies readonly (keyof IngestSecrets)[];

/** What the auth decision needs: the reader password and a lookup of publish keys by path. */
export interface IngestAuthState {
  /** Internal reader password; null = not loaded yet (deny everything). */
  readerPassword: string | null;
  /** The publish key for a path (default profile when slug is null); null = unknown profile. */
  publishKey(route: IngestRoute): string | null;
  /**
   * Guest feeds (docs/API.md §18): a slot's ingest key, or null when the slot doesn't exist, its key
   * is revoked or guest feeds are off. Undefined = no guest feeds at all (deny every guest path).
   */
  guestKey?(slot: string): string | null;
  /** Does the guest slot exist (it may be read back by Relay)? */
  guestExists?(slot: string): boolean;
  /**
   * Guest feed routing (docs/GUEST-FEEDS.md → Routing): the one-time publish key of the route that
   * holds this feed path right now (Relay's own FFmpeg republishing a guest feed into a profile), or
   * null. Accepted from loopback only.
   */
  routeKey?(route: IngestRoute): string | null;
  /** OBS (its own key) was let in on a feed path: a route holding that input must stand down. */
  obsPublished?(route: IngestRoute): void;
}

/** 24-char URL-safe random key (144 bits). */
export function generateKey(): string {
  return randomBytes(18).toString('base64url');
}

/** Keys must be URL-safe (they go into RTMP URLs unencoded) and reasonably long. */
export function isValidKey(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

/** Constant-time string comparison (hashing first hides the length). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** 127.0.0.0/8, ::1 and IPv4-mapped loopback. */
export function isLoopbackIp(ip: string): boolean {
  let addr = ip.trim();
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone);
  const lower = addr.toLowerCase();
  if (lower.startsWith('::ffff:')) addr = addr.slice(7);
  if (isIP(addr) === 4) return addr.startsWith('127.');
  if (isIP(addr) === 6) return lower === '::1' || lower === '0:0:0:0:0:0:0:1';
  return false;
}

/** Value of one query parameter from MediaMTX's raw `query` (may start with '?'). */
export function queryParam(query: string, name: string): string | null {
  const raw = query.startsWith('?') ? query.slice(1) : query;
  try {
    return new URLSearchParams(raw).get(name);
  } catch {
    return null;
  }
}

/** Auth state for the default profile alone (pre-profiles behaviour; handy in tests). */
export function singleProfileAuth(keys: IngestSecrets | null): IngestAuthState | null {
  if (!keys) return null;
  return {
    readerPassword: keys.internalReader,
    publishKey: (route) => (route.slug === null ? keys[route.feed] : null),
  };
}

/**
 * - publish: only to a known profile's feed path (`live/<feed>` for the default profile,
 *   `live/<slug>/<feed>` for the others) with `?key=` equal to that profile's key for that feed
 *   (any source IP — OBS is on the LAN). A key never works on another profile's path.
 * - read: only a known profile's feed paths, only from loopback, as user 'internal' with the internal
 *   reader password (shared by every profile; FFmpeg is the only reader).
 * - everything else (playback, api, metrics, pprof, unknown): deny.
 */
export function authorizeMediaRequest(req: MediaMtxAuthRequest, auth: IngestAuthState | null): boolean {
  if (!auth) return false;
  const slot = parseGuestPath(req.path ?? '');
  if (slot !== null) return authorizeGuest(req, auth, slot);
  const route = parseFeedPath(req.path ?? '');
  if (!route) return false;

  switch (req.action) {
    case 'publish': {
      const expected = auth.publishKey(route);
      if (!expected) return false;
      const key = queryParam(req.query ?? '', 'key');
      if (key === null || key.length === 0) return false;
      if (safeEqual(key, expected)) {
        auth.obsPublished?.(route);
        return true;
      }
      // A guest feed routed into this input: Relay's own FFmpeg, from loopback, with the route's key.
      const routeKey = auth.routeKey?.(route) ?? null;
      return routeKey !== null && routeKey.length > 0 && isLoopbackIp(req.ip ?? '') && safeEqual(key, routeKey);
    }
    case 'read': {
      const expected = auth.publishKey(route);
      if (expected === null) return false; // a known profile
      if (isInternalReader(req, auth)) return true;
      // TEST BUILD ONLY (Juan, 2026-11-25): pull a feed into another OBS as a Media Source with the
      // feed's own stream key (`rtmp://<host>:<port>/live/<feed>?key=<stream key>`). To be replaced
      // by the Pull link's separate read key (mid/guest-feed-pull) before any release.
      const key = queryParam(req.query ?? '', 'key');
      return key !== null && key.length > 0 && expected.length > 0 && safeEqual(key, expected);
    }
    default:
      return false;
  }
}

/** Relay itself reading (FFmpeg, the LL-HLS proxy): loopback, user 'internal', the reader password. */
function isInternalReader(req: MediaMtxAuthRequest, auth: IngestAuthState): boolean {
  const reader = auth.readerPassword;
  return (
    reader !== null &&
    reader.length > 0 &&
    isLoopbackIp(req.ip ?? '') &&
    req.user === INTERNAL_READER_USER &&
    typeof req.password === 'string' &&
    req.password.length > 0 &&
    safeEqual(req.password, reader)
  );
}

/**
 * Guest paths (`guest/<slot>`):
 * - publish: an existing slot whose key isn't revoked, with `?key=` equal to that slot's key (any
 *   source IP: guests are on the internet). A slot's key never works on another slot or a feed path.
 * - read: only Relay itself (loopback, internal reader password), only an existing slot. Nothing
 *   else ever reads a guest path: no push is built from one (parseFeedPath doesn't accept it).
 */
function authorizeGuest(req: MediaMtxAuthRequest, auth: IngestAuthState, slot: string): boolean {
  switch (req.action) {
    case 'publish': {
      const expected = auth.guestKey?.(slot) ?? null;
      if (!expected) return false;
      const key = queryParam(req.query ?? '', 'key');
      return key !== null && key.length > 0 && safeEqual(key, expected);
    }
    case 'read': {
      if (!(auth.guestExists?.(slot) ?? false)) return false;
      if (isInternalReader(req, auth)) return true;
      // TEST BUILD ONLY (see the feed read above): the guest's own key also reads the guest feed.
      const expected = auth.guestKey?.(slot) ?? null;
      const key = queryParam(req.query ?? '', 'key');
      return expected !== null && expected.length > 0 && key !== null && key.length > 0 && safeEqual(key, expected);
    }
    default:
      return false;
  }
}
