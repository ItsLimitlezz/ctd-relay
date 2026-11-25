// Guest feed routing (docs/GUEST-FEEDS.md → Routing, docs/API.md §18.8, API 1.17 additive): send a
// guest feed on, passthrough (`-c copy`), either to a custom RTMP(S) server ("somewhere else") or into
// a profile as its Landscape or Vertical input, where it then works exactly like OBS's own feed.
// Shared by the server and the web UI. Pure: no runtime dependencies. The published guest feed
// shapes (shared/guest-feeds.ts) are unchanged: routes are their own objects.

import type { Feed } from './types.js';

/** A route id: 10 characters [a-z0-9], like slot ids. */
export const GUEST_ROUTE_ID_RE = /^[a-z0-9]{10}$/;
/** Custom RTMP(S) targets per guest feed. */
export const MAX_RTMP_ROUTES_PER_GUEST = 3;
/** Profile inputs per guest feed (one guest can feed several profiles). */
export const MAX_PROFILE_ROUTES_PER_GUEST = 3;
export const GUEST_ROUTE_NAME_MAX = 60;

export type GuestRouteKind = 'rtmp' | 'profile';

/**
 * - `idle`: not running (manual and not started, or the guest isn't sending yet for an automatic one).
 * - `starting` / `running` / `retrying`: the passthrough push (FFmpeg `-c copy`), as for destinations.
 * - `blocked`: it should run but can't (`message` says why: OBS's own feed is on that input, the
 *   target is refused, another route holds the input).
 * - `failed`: FFmpeg can't run it at all (`message`).
 */
export type GuestRouteState = 'idle' | 'starting' | 'running' | 'retrying' | 'blocked' | 'failed';

/** Where a route sends the guest feed. Never holds a key. */
export type GuestRouteTarget =
  | {
      kind: 'rtmp';
      /** scheme://host[:port] only (no path, no key), e.g. `rtmps://live.example.com`. */
      host: string;
      /** The server URL as entered (may hold a path). Only in the web UI for admins; absent in the API. */
      url?: string;
      /** A stream key is stored (write-only: never returned). */
      hasKey: boolean;
    }
  | {
      kind: 'profile';
      profileId: string;
      /** The profile's name now (null when it no longer exists). */
      profileName: string | null;
      feed: Feed;
    };

/** One route of a guest feed (docs/API.md §18.8). */
export interface GuestRoute {
  id: string;
  /** The guest feed (slot) it sends. */
  slot: string;
  /** The profile that owns the guest feed. */
  profileId: string;
  name: string;
  target: GuestRouteTarget;
  /** Start by itself whenever the guest is sending (and stop when they stop). */
  auto: boolean;
  /** Started (by hand, or by `auto` while the guest sends). */
  active: boolean;
  state: GuestRouteState;
  /** Why it is blocked, failed or retrying; a warning while running. Never holds a key. */
  message: string | null;
  /** When it last reached `running`, while running. */
  since: string | null;
  bitrateKbps: number | null;
}

/** GET …/guest-feeds/{slot}/routes */
export interface GuestRouteList {
  profileId: string;
  slot: string;
  routes: GuestRoute[];
}

/** GET …/profiles/{id}/guest-routes: routes of this profile's guest feeds, and routes into its inputs. */
export interface ProfileGuestRoutes {
  profileId: string;
  /** Routes of this profile's guest feeds. */
  outbound: GuestRoute[];
  /** Routes (from any profile's guest feeds) set as this profile's Landscape or Vertical input. */
  inbound: (GuestRoute & { guestName: string | null })[];
}

/** POST …/guest-feeds/{slot}/routes [admin] */
export type CreateGuestRouteRequest =
  | { kind: 'rtmp'; name?: string; url: string; streamKey?: string | null; auto?: boolean }
  | { kind: 'profile'; name?: string; profileId: string; feed: Feed; auto?: boolean };

/** PATCH …/routes/{route} [admin]: streamKey undefined = keep, '' / null = clear, else replace. */
export interface UpdateGuestRouteRequest {
  name?: string;
  url?: string;
  streamKey?: string | null;
  auto?: boolean;
}

/** Settings → Guest feed routing [admin]. */
export interface GuestRouteSettings {
  /** Allow custom targets on private LAN addresses (RFC 1918, CGNAT, IPv6 ULA). Default true. */
  allowLan: boolean;
}

export const DEFAULT_GUEST_ROUTE_SETTINGS: GuestRouteSettings = { allowLan: true };

/** Trim and collapse whitespace; null when empty, too long or with control characters. */
export function cleanRouteName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  if (name.length === 0 || name.length > GUEST_ROUTE_NAME_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

export function feedLabel(feed: Feed): string {
  return feed === 'landscape' ? 'Landscape' : 'Vertical';
}
