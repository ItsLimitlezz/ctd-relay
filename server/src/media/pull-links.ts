// Pull links (docs/GUEST-FEEDS.md → Pull link, docs/API.md §18.9): an admin turns on a "Pull link"
// for a guest feed (or a profile's own Landscape / Vertical feed) and gets a plain address,
// rtmp://<host>:<port>/<path>?key=<read key>, to paste into an OBS Media Source or VLC. The reader
// plays straight from the bundled MediaMTX on the RTMP port ingest already uses: no new ports, no
// server to push to, passthrough only (MediaMTX copies the packets; nothing is transcoded).
//
// Each feed has its own read key, separate from the ingest key: a read needs the read key, a
// publish never accepts it (authorize.ts). Keys live in the encrypted secrets (scope 'pull', one
// JSON entry), are answered from memory (the auth hook is synchronous), never logged and only shown
// to admins. Off = no key. Rotating or turning a link off disconnects whoever reads with the old key.
//
// Readers are counted from MediaMTX's RTMP connection list (each poll): connections reading the
// path with a `key` query equal to the current read key. Relay's own readers (FFmpeg thumbnails,
// LL-HLS, routes) authenticate as user 'internal' and are never counted. A cap per feed (default 2,
// env PULL_LINK_MAX_READERS) is checked at auth time; a reader that slipped past it in a race is
// disconnected on the next poll.

import type { Logger } from 'pino';
import { FEEDS, type Feed } from '../../../shared/types.js';
import type { PullLinkInfo, PullLinkState, ProfilePullLinks } from '../../../shared/pull-links.js';
import type { SecretsRepo } from '../services.js';
import { generateKey, isValidKey, queryParam, safeEqual } from './authorize.js';
import { feedPath, guestPath, parseFeedPath, parseGuestPath } from './paths.js';

export const PULL_SECRET_SCOPE = 'pull';
const PULL_SECRET_KEY = 'readKeys';
/** An admitted reader not seen in a poll yet still counts against the cap this long. */
const PENDING_MS = 3_000;

export type PullTarget = { kind: 'guest'; profileId: string; slot: string } | { kind: 'feed'; profileId: string; feed: Feed };

/** One RTMP connection from MediaMTX's `GET /v3/rtmpconns/list`. */
export interface RtmpConn {
  id: string;
  state?: string;
  path?: string;
  query?: string;
  created?: string;
}

/** What the media server lends: its RTMP connections and a way to drop one. */
export interface PullMedia {
  listConns(): Promise<RtmpConn[]>;
  kickConn(id: string): Promise<boolean>;
}

export class PullLinkError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PullLinkError';
  }
}

export interface PullLinksOptions {
  secrets: Pick<SecretsRepo, 'scoped'>;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Concurrent pull readers per feed; 0 = pull links are off on this server. */
  maxReaders: number;
  /** The profile a guest slot belongs to, or null when the slot doesn't exist. */
  guestProfileOf(slot: string): string | null;
  /** A profile's ingest slug (null = the default profile, legacy paths); undefined = no such profile. */
  slugOf(profileId: string): string | null | undefined;
  /** The profile publishing at `live/<slug>/…` (slug null = the default profile), or null. */
  profileOfSlug(slug: string | null): string | null;
  now?: () => number;
}

function targetId(t: PullTarget): string {
  return t.kind === 'guest' ? `guest:${t.slot}` : `feed:${t.profileId}:${t.feed}`;
}

export class PullLinks {
  readonly maxReaders: number;
  private keys = new Map<string, string>();
  private readers = new Map<string, number>();
  private pending = new Map<string, number[]>();
  private media: PullMedia | null = null;
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly opts: PullLinksOptions) {
    this.maxReaders = opts.maxReaders;
    this.now = opts.now ?? Date.now;
  }

  attachMedia(media: PullMedia): void {
    this.media = media;
  }

  /** Load the read keys (call once at start; auth denies every pull read until then). */
  async load(): Promise<void> {
    const raw = await this.scope().getJson<Record<string, unknown>>(PULL_SECRET_KEY);
    const keys = new Map<string, string>();
    if (raw && typeof raw === 'object') {
      for (const [id, value] of Object.entries(raw)) if (typeof value === 'string' && isValidKey(value)) keys.set(id, value);
    }
    this.keys = keys;
    this.loaded = true;
  }

  /** Is any pull link on (the media server only lists connections then)? */
  active(): boolean {
    return this.keys.size > 0 && this.maxReaders > 0;
  }

  // ---- auth (synchronous) ------------------------------------------------

  /** The read key of a MediaMTX path, or null (pull link off, unknown path, not loaded, pull links off). */
  readKey(path: string): string | null {
    if (!this.loaded || this.maxReaders <= 0) return null;
    const id = this.idOfPath(path);
    return id ? (this.keys.get(id) ?? null) : null;
  }

  /** A read with the right key: room under the cap? Reserves a place when there is. */
  admit(path: string): boolean {
    const id = this.idOfPath(path);
    if (!id) return false;
    const t = this.now();
    const pending = (this.pending.get(id) ?? []).filter((at) => t - at < PENDING_MS);
    if ((this.readers.get(id) ?? 0) + pending.length >= this.maxReaders) {
      this.pending.set(id, pending);
      return false;
    }
    pending.push(t);
    this.pending.set(id, pending);
    return true;
  }

  // ---- reading ----------------------------------------------------------

  state(target: PullTarget): PullLinkState {
    const id = targetId(target);
    return { enabled: this.keys.has(id), readers: this.keys.has(id) ? (this.readers.get(id) ?? 0) : 0, maxReaders: this.maxReaders };
  }

  /** Every pull link of a profile (no keys), for `status:read`. */
  profile(profileId: string, guestSlots: readonly string[]): ProfilePullLinks {
    const guestFeeds: Record<string, PullLinkState> = {};
    for (const slot of guestSlots) guestFeeds[slot] = this.state({ kind: 'guest', profileId, slot });
    const feeds = Object.fromEntries(FEEDS.map((feed) => [feed, this.state({ kind: 'feed', profileId, feed })])) as Record<Feed, PullLinkState>;
    return { profileId, maxReaders: this.maxReaders, guestFeeds, feeds };
  }

  /** The admin's view, with the link itself (host = what OBS/VLC connect to). */
  info(target: PullTarget, host: string, rtmpPort: number): PullLinkInfo {
    const serverUrl = `rtmp://${host}:${rtmpPort}/${this.pathOf(target)}`;
    const key = this.keys.get(targetId(target)) ?? null;
    return { ...this.state(target), serverUrl, url: key ? `${serverUrl}?key=${key}` : null };
  }

  // ---- managing (admin) ---------------------------------------------------

  /** Turn the pull link on (a new read key) or off (no key; current readers are disconnected). */
  async setEnabled(target: PullTarget, enabled: boolean): Promise<void> {
    if (enabled) {
      if (this.maxReaders <= 0) throw new PullLinkError(409, 'limit', 'Pull links are turned off on this server (PULL_LINK_MAX_READERS=0).');
      if (this.keys.has(targetId(target))) return;
      await this.save(targetId(target), generateKey());
      this.opts.log.info(this.logFields(target), 'Pull link turned on');
      return;
    }
    if (!this.keys.has(targetId(target))) return;
    await this.save(targetId(target), null);
    this.opts.log.info(this.logFields(target), 'Pull link turned off');
    await this.disconnect(target);
  }

  /** A new read key (turns the link on): the old link stops working and its readers are disconnected. */
  async rotate(target: PullTarget): Promise<void> {
    if (this.maxReaders <= 0) throw new PullLinkError(409, 'limit', 'Pull links are turned off on this server (PULL_LINK_MAX_READERS=0).');
    this.pathOf(target); // unknown profile → 404
    await this.save(targetId(target), generateKey());
    this.opts.log.info(this.logFields(target), 'Pull link key rotated');
    await this.disconnect(target);
  }

  /** A guest slot was removed: drop its read key (its readers went with the guest). */
  async forgetGuest(slot: string): Promise<void> {
    if (this.keys.has(`guest:${slot}`)) await this.save(`guest:${slot}`, null);
  }

  /** A profile was removed: drop its own feeds' read keys. */
  async forgetProfile(profileId: string): Promise<void> {
    for (const feed of FEEDS) if (this.keys.has(`feed:${profileId}:${feed}`)) await this.save(`feed:${profileId}:${feed}`, null);
  }

  // ---- media state (from the media server's poll) -------------------------

  /** Count pull readers per feed; drop readers over the cap or holding a key that is no longer valid. */
  async apply(conns: readonly RtmpConn[], fetchedAt: number): Promise<void> {
    const counts = new Map<string, RtmpConn[]>();
    const kick: RtmpConn[] = [];
    for (const conn of conns) {
      if (conn.state !== 'read' || !conn.path) continue;
      const key = queryParam(conn.query ?? '', 'key');
      if (key === null) continue; // Relay's own readers (user 'internal'), never counted
      const id = this.idOfPath(conn.path);
      if (!id) continue;
      const expected = this.keys.get(id);
      if (!expected || this.maxReaders <= 0 || !safeEqual(key, expected)) {
        kick.push(conn); // an old or revoked link still connected (e.g. a kick that failed)
        continue;
      }
      const list = counts.get(id) ?? [];
      list.push(conn);
      counts.set(id, list);
    }
    this.readers.clear();
    for (const [id, list] of counts) {
      if (list.length > this.maxReaders) {
        list.sort((a, b) => String(a.created ?? '').localeCompare(String(b.created ?? '')));
        kick.push(...list.slice(this.maxReaders)); // the newest go; the first readers keep watching
      }
      this.readers.set(id, Math.min(list.length, this.maxReaders));
    }
    // Admits seen by this poll are counted above; keep only those that came after it started.
    for (const [id, list] of this.pending) this.pending.set(id, list.filter((at) => at >= fetchedAt));
    for (const conn of kick) await this.kickConn(conn);
  }

  /** MediaMTX stopped: nobody is reading. */
  resetAll(): void {
    this.readers.clear();
    this.pending.clear();
  }

  // ---- internals --------------------------------------------------------

  private scope() {
    return this.opts.secrets.scoped(PULL_SECRET_SCOPE);
  }

  private async save(id: string, key: string | null): Promise<void> {
    const run = this.writing.then(async () => {
      const next = new Map(this.keys);
      if (key) next.set(id, key);
      else next.delete(id);
      await this.scope().setJson(PULL_SECRET_KEY, Object.fromEntries(next));
      this.keys = next;
      this.readers.delete(id);
      this.pending.delete(id);
    });
    this.writing = run.catch(() => {});
    return run;
  }

  /** MediaMTX path → target id, only for paths whose slot / profile exists. */
  private idOfPath(path: string): string | null {
    const slot = parseGuestPath(path);
    if (slot !== null) return this.opts.guestProfileOf(slot) !== null ? `guest:${slot}` : null;
    const route = parseFeedPath(path);
    if (!route) return null;
    const profileId = this.opts.profileOfSlug(route.slug);
    return profileId ? `feed:${profileId}:${route.feed}` : null;
  }

  private pathOf(target: PullTarget): string {
    if (target.kind === 'guest') return guestPath(target.slot);
    const slug = this.opts.slugOf(target.profileId);
    if (slug === undefined) throw new PullLinkError(404, 'unknown_profile', 'Profile not found');
    return feedPath(target.feed, slug);
  }

  private logFields(target: PullTarget): Record<string, string> {
    return target.kind === 'guest' ? { profileId: target.profileId, slot: target.slot } : { profileId: target.profileId, feed: target.feed };
  }

  /** Drop every pull reader of a target (whatever key it used; Relay's own readers stay). */
  private async disconnect(target: PullTarget): Promise<void> {
    if (!this.media) return;
    let path: string;
    try {
      path = this.pathOf(target);
    } catch {
      return;
    }
    try {
      const conns = await this.media.listConns();
      let n = 0;
      for (const conn of conns) {
        if (conn.state === 'read' && conn.path === path && queryParam(conn.query ?? '', 'key') !== null && (await this.kickConn(conn))) n++;
      }
      if (n > 0) this.opts.log.info({ ...this.logFields(target), readers: n }, 'Disconnected pull link readers');
    } catch (err) {
      this.opts.log.warn({ ...this.logFields(target), err: err instanceof Error ? err.message : String(err) }, 'Could not disconnect pull link readers');
    }
  }

  private async kickConn(conn: RtmpConn): Promise<boolean> {
    if (!this.media) return false;
    try {
      return await this.media.kickConn(conn.id);
    } catch (err) {
      this.opts.log.warn({ path: conn.path, err: err instanceof Error ? err.message : String(err) }, 'Could not disconnect a pull link reader');
      return false;
    }
  }
}
