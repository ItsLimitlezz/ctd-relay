// Pull links (docs/GUEST-FEEDS.md → Pull link, docs/API.md §18.9): a plain RTMP address an admin
// pastes into an OBS Media Source or VLC to watch a guest feed (or a profile's own Landscape /
// Vertical feed) without a server to push to. Off by default; each feed has its own read key.

import type { SrtStatus } from './srt.js';
import type { Feed } from './types.js';

/** Default of the server's cap on concurrent pull readers per feed (env PULL_LINK_MAX_READERS). */
export const DEFAULT_PULL_LINK_MAX_READERS = 2;

/** One feed's pull link state: what `status:read` may see (never the key). */
export interface PullLinkState {
  enabled: boolean;
  /** Players reading through the pull link right now (Relay's own readers aren't counted). */
  readers: number;
  maxReaders: number;
}

/** GET /api/v1/profiles/{id}/pull-links: every pull link of a profile (no keys). */
export interface ProfilePullLinks {
  profileId: string;
  maxReaders: number;
  /** By slot id; every guest feed of the profile is listed. */
  guestFeeds: Record<string, PullLinkState>;
  feeds: Record<Feed, PullLinkState>;
}

/** An admin's view of one pull link: the state plus the link itself (null while off). */
export interface PullLinkInfo extends PullLinkState {
  /** rtmp://<host>:<port>/<path>?key=<read key>: paste into OBS (Media Source → Input) or VLC. Null while off. */
  url: string | null;
  /** The same as `url` without the query (handy to show which feed it is). */
  serverUrl: string;
  /**
   * API 1.17: the pull link over SRT (lower delay), `srt://<host>:<port>?streamid=read:<path>:key=<read key>&latency=<µs>`.
   * OBS Media Source: untick Local File, paste into Input, Input Format `mpegts`. Null while off or when SRT is off.
   */
  srtUrl?: string | null;
  /** API 1.17: whether SRT works here (docs/SRT.md). */
  srt?: SrtStatus;
}
