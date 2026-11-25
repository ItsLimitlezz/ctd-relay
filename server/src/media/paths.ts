import { FEEDS, type Feed } from '../../../shared/types.js';

/** RTMP application name. OBS server URL = rtmp://<host>:<port>/live, stream key = '<feed>?key=<k>'. */
export const APP_NAME = 'live';

/** MediaMTX user FFmpeg authenticates as when reading a feed (from loopback only). */
export const INTERNAL_READER_USER = 'internal';

/** Profile slug as it may appear in an ingest path (see ProfilesRepo: `[a-z0-9-]{1,32}`). */
const SLUG = '[a-z0-9-]{1,32}';

/**
 * Where OBS publishes a feed. `slug` null = the default profile, which keeps the pre-profiles paths
 * `live/landscape` / `live/vertical`; other profiles use `live/<slug>/landscape` / `live/<slug>/vertical`.
 */
export interface IngestRoute {
  slug: string | null;
  feed: Feed;
}

/** The OBS "Stream Key" path part: 'landscape' or '<slug>/landscape' (before `?key=`). */
export function streamKeyPath(feed: Feed, slug: string | null = null): string {
  return slug ? `${slug}/${feed}` : feed;
}

/** MediaMTX path for a feed, e.g. 'live/landscape' or 'live/dprtmnt/landscape'. */
export function feedPath(feed: Feed, slug: string | null = null): string {
  return `${APP_NAME}/${streamKeyPath(feed, slug)}`;
}

const PATH_RE = new RegExp(`^${APP_NAME}/(?:(${SLUG})/)?(${FEEDS.join('|')})$`);

/** Inverse of feedPath; null for any other path. Tolerates a leading slash. */
export function parseFeedPath(path: string): IngestRoute | null {
  const p = path.startsWith('/') ? path.slice(1) : path;
  const m = PATH_RE.exec(p);
  if (!m) return null;
  return { slug: m[1] ?? null, feed: m[2] as Feed };
}

/** The default profile's feed for a path; null for any other path (incl. other profiles' paths). */
export function feedForPath(path: string): Feed | null {
  const route = parseFeedPath(path);
  return route && route.slug === null ? route.feed : null;
}

/**
 * MediaMTX path name (a regular expression, `~` prefix) covering every non-default profile's feeds,
 * so a new profile works without restarting MediaMTX; our auth hook decides which slugs exist.
 */
export const PROFILE_PATHS_REGEX = `~^${APP_NAME}/${SLUG}/(${FEEDS.join('|')})$`;

// ---- guest feeds (docs/API.md §18) ----

/**
 * Guests publish to their own RTMP application, `guest/<slot>` (server URL rtmp://<host>:<port>/guest,
 * stream key `<slot>?key=<k>`): the same MediaMTX, port and key check as OBS's feeds, but a path
 * prefix no feed path can have, so a guest path is never parsed as a feed (parseFeedPath → null) and
 * nothing that reads feeds (pushes, the orchestrator) can ever reach a guest feed.
 */
export { GUEST_APP_NAME } from '../../../shared/guest-feeds.js';
const GUEST_PREFIX = 'guest';
const GUEST_PATH_RE = new RegExp(`^${GUEST_PREFIX}/([a-z0-9]{10})$`);

/** MediaMTX path of a guest slot, e.g. 'guest/q7m2x9k4tb'. */
export function guestPath(slot: string): string {
  return `${GUEST_PREFIX}/${slot}`;
}

/** Inverse of guestPath: the slot id, or null for any other path. Tolerates a leading slash. */
export function parseGuestPath(path: string): string | null {
  const p = path.startsWith('/') ? path.slice(1) : path;
  return GUEST_PATH_RE.exec(p)?.[1] ?? null;
}

/** MediaMTX path name (regex) covering every guest slot; the auth hook decides which slots exist. */
export const GUEST_PATHS_REGEX = `~^${GUEST_PREFIX}/[a-z0-9]{10}$`;
