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
  /**
   * Pull links (docs/GUEST-FEEDS.md → Pull link): the read key of a guest or feed path, or null when
   * its pull link is off. A read key only ever reads; it never publishes.
   */
  pullKey?(path: string): string | null;
  /** A read with the right pull key: is there room under the per-feed reader cap (reserves it)? */
  pullAdmit?(path: string): boolean;
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
 * - read: only a known profile's feed paths, from loopback as user 'internal' with the internal
 *   reader password (shared by every profile), or, when the feed's pull link is on, from anywhere
 *   with `?key=` equal to its read key (under the reader cap).
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
    case 'read':
      if (auth.publishKey(route) === null) return false; // a known profile
      return isInternalReader(req, auth) || isPullReader(req, auth);
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
 * - read: only an existing slot, by Relay itself (loopback, internal reader password) or, when the
 *   slot's pull link is on, by anyone with its read key (under the reader cap). No push is ever built
 *   from a guest path (parseFeedPath doesn't accept it).
 */
function authorizeGuest(req: MediaMtxAuthRequest, auth: IngestAuthState, slot: string): boolean {
  switch (req.action) {
    case 'publish': {
      const expected = auth.guestKey?.(slot) ?? null;
      if (!expected) return false;
      const key = queryParam(req.query ?? '', 'key');
      return key !== null && key.length > 0 && safeEqual(key, expected);
    }
    case 'read':
      if (!(auth.guestExists?.(slot) ?? false)) return false;
      return isInternalReader(req, auth) || isPullReader(req, auth);
    default:
      return false;
  }
}

/**
 * A pull link reader (OBS Media Source, VLC): any source IP, `?key=` equal to the path's read key
 * (never its ingest key), and room under the reader cap. Checked only for `read`.
 */
function isPullReader(req: MediaMtxAuthRequest, auth: IngestAuthState): boolean {
  const path = req.path ?? '';
  const expected = auth.pullKey?.(path) ?? null;
  if (!expected) return false;
  const key = queryParam(req.query ?? '', 'key');
  if (key === null || key.length === 0 || !safeEqual(key, expected)) return false;
  return auth.pullAdmit?.(path) ?? false;
}
