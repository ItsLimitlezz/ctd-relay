// Guest feeds (docs/API.md §18, docs/GUEST-FEEDS.md): per-profile slots a remote guest publishes
// to over RTMP (`guest/<slot>` on Relay's MediaMTX), read back only by Relay itself for the LL-HLS
// player and thumbnails. Never pushed to a destination: no push plan can name a guest path.
//
// This service owns the slots (rows in guest_feeds, keys in the encrypted secrets, scope
// `guest:<profileId>`, one entry per slot id), answers the media auth hook synchronously from memory,
// and turns MediaMTX's path list into guest feed state ('guest-feed' bus events). The media server
// (mediamtx.ts) feeds it every poll and lends it a way to disconnect a publisher.
//
// Keeping guests from starving the main feeds on a weak CPU-only server: no transcoding and no
// ffprobe of guest feeds; LL-HLS muxing only while someone watches (the live preview machinery);
// a slot cap per profile; and a hard bitrate limit (a guest above maxKbps for 10 s is disconnected).

import type { Logger } from 'pino';
import { guestFeedProblem } from '../../../shared/feed-codec.js';
import {
  cleanGuestName,
  DEFAULT_GUEST_FEED_MAX_KBPS,
  DEFAULT_GUEST_FEED_MAX_VIEWERS,
  DEFAULT_GUEST_FEED_WARN_KBPS,
  DEFAULT_GUEST_FEEDS_MAX,
  type GuestFeed,
  type GuestFeedList,
} from '../../../shared/guest-feeds.js';
import type { GuestFeedsRepo, GuestSlotRow } from '../db/guest-feeds-repo.js';
import type { EventBus } from '../events.js';
import type { SecretsRepo } from '../services.js';
import { generateKey, isValidKey } from './authorize.js';
import { FeedTracker, type MtxPath } from './feed-state.js';
import { guestPath } from './paths.js';

/** A guest above maxKbps this long is disconnected. */
export const GUEST_OVER_LIMIT_MS = 10_000;
/** `limitedAt` is shown this long after Relay disconnected a guest for its bitrate. */
export const GUEST_LIMITED_SHOW_MS = 10 * 60_000;
/** An admin rotated/revoked/removed: the guest going offline within this window was expected. */
const EXPECTED_OFFLINE_MS = 15_000;
const BITRATE_EMIT_INTERVAL_MS = 2_000;

export class GuestFeedError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GuestFeedError';
  }
}

export interface GuestFeedLimits {
  /** Slots per profile; 0 = guest feeds off (no slot can be added, no guest can publish). */
  maxSlots: number;
  /** Players per guest feed at once; 0 = guest feeds can't be watched. */
  maxViewers: number;
  warnAboveKbps: number;
  /** 0 = no hard limit. */
  maxKbps: number;
}

export const DEFAULT_GUEST_LIMITS: GuestFeedLimits = {
  maxSlots: DEFAULT_GUEST_FEEDS_MAX,
  maxViewers: DEFAULT_GUEST_FEED_MAX_VIEWERS,
  warnAboveKbps: DEFAULT_GUEST_FEED_WARN_KBPS,
  maxKbps: DEFAULT_GUEST_FEED_MAX_KBPS,
};

/** 'guest-feed' bus event: one slot's state. */
export interface GuestFeedEvent {
  profileId: string;
  feed: GuestFeed;
  /** It went offline because an admin rotated or revoked its key (not a problem to raise). */
  expectedOffline: boolean;
}

/** 'guest-feeds-changed' bus event: slots added, renamed, removed, keys rotated or revoked. */
export interface GuestFeedsChangedEvent {
  profileId: string;
  /** Slot ids that no longer exist. */
  removed: string[];
  /** Slots whose key was rotated or revoked (their guest was disconnected on purpose). */
  rekeyed: string[];
}

export interface GuestFeedsOptions {
  repo: GuestFeedsRepo;
  secrets: Pick<SecretsRepo, 'scoped' | 'deleteScope'>;
  bus: EventBus;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  limits: GuestFeedLimits;
  now?: () => number;
}

interface Slot {
  row: GuestSlotRow;
  /** Loaded key (null = revoked or not loaded yet). */
  key: string | null;
  tracker: FeedTracker;
  emitted: { feed: GuestFeed; at: number } | null;
  overSince: number | null;
  limitedAt: number | null;
  expectOfflineUntil: number;
}

export function guestSecretScope(profileId: string): string {
  return `guest:${profileId}`;
}

function sameButBitrate(a: GuestFeed, b: GuestFeed): boolean {
  const strip = (f: GuestFeed) => ({ ...f, bitrateKbps: null, bitrateWarning: false });
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

export class GuestFeeds {
  readonly limits: GuestFeedLimits;
  private readonly slots = new Map<string, Slot>();
  private readonly now: () => number;
  private kick: ((path: string) => Promise<boolean>) | null = null;
  private loaded: Promise<void> | null = null;

  constructor(private readonly opts: GuestFeedsOptions) {
    this.limits = opts.limits;
    this.now = opts.now ?? Date.now;
    for (const row of opts.repo.all()) this.slots.set(row.id, this.newSlot(row));
  }

  /** The media server lends a way to disconnect whoever publishes on a path. */
  attachMedia(media: { kick(path: string): Promise<boolean> }): void {
    this.kick = (path) => media.kick(path);
  }

  /** Load every slot's key (auth answers from memory). Safe to call again. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      for (const slot of this.slots.values()) {
        try {
          await this.loadKey(slot);
        } catch (err) {
          this.opts.log.error({ slot: slot.row.id, err: err instanceof Error ? err.message : String(err) }, 'Could not load a guest feed key');
        }
      }
    })().finally(() => {
      this.loaded = null;
    });
    return this.loaded;
  }

  // ---- auth (synchronous) ------------------------------------------------

  /** The slot's publish key; null when unknown, revoked, not loaded yet, or guest feeds are off. */
  guestKey(slotId: string): string | null {
    if (this.limits.maxSlots <= 0) return null;
    const slot = this.slots.get(slotId);
    if (!slot || slot.row.revoked) return null;
    if (!slot.key) void this.load();
    return slot.key;
  }

  guestExists(slotId: string): boolean {
    return this.slots.has(slotId);
  }

  /** The profile a slot belongs to, or null. */
  profileOf(slotId: string): string | null {
    return this.slots.get(slotId)?.row.profileId ?? null;
  }

  nameOf(slotId: string): string | null {
    return this.slots.get(slotId)?.row.name ?? null;
  }

  // ---- reading ----------------------------------------------------------

  /** One slot of a profile (null when it doesn't exist or belongs to another profile). */
  feed(profileId: string, slotId: string): GuestFeed | null {
    const slot = this.slots.get(slotId);
    return slot && slot.row.profileId === profileId ? this.view(slot) : null;
  }

  /** Raw feed state (FeedState shape) for the live preview / thumbnails, or null. */
  state(profileId: string, slotId: string): { online: boolean; video: GuestFeed['video']; audio: GuestFeed['audio'] } | null {
    const slot = this.slots.get(slotId);
    if (!slot || slot.row.profileId !== profileId) return null;
    const s = slot.tracker.current();
    return { online: s.online, video: s.video, audio: s.audio };
  }

  list(profileId: string): GuestFeedList {
    return {
      profileId,
      maxSlots: this.limits.maxSlots,
      maxViewers: this.limits.maxViewers,
      warnAboveKbps: this.limits.warnAboveKbps,
      maxKbps: this.limits.maxKbps,
      guestFeeds: this.limits.maxSlots > 0 ? this.ofProfile(profileId).map((s) => this.view(s)) : [],
    };
  }

  /** The slot's key for the admin's ingest details (null when revoked). Throws for an unknown slot. */
  async ingestKey(profileId: string, slotId: string): Promise<string | null> {
    const slot = this.require(profileId, slotId);
    if (slot.row.revoked) return null;
    return this.loadKey(slot);
  }

  // ---- managing slots (admin) --------------------------------------------

  async create(profileId: string, rawName: string): Promise<GuestFeed> {
    const name = this.name(rawName);
    if (this.limits.maxSlots <= 0) throw new GuestFeedError(409, 'limit', 'Guest feeds are turned off on this server (GUEST_FEEDS_MAX=0).');
    if (this.opts.repo.count(profileId) >= this.limits.maxSlots) {
      throw new GuestFeedError(409, 'limit', `This profile already has ${this.limits.maxSlots} guest feeds (the most per profile). Remove one first.`);
    }
    const row = this.opts.repo.create(profileId, name);
    const slot = this.newSlot(row);
    this.slots.set(row.id, slot);
    try {
      slot.key = generateKey();
      await this.scope(profileId).set(row.id, slot.key);
    } catch (err) {
      this.slots.delete(row.id);
      this.opts.repo.delete(row.id);
      throw err;
    }
    this.opts.log.info({ profileId, slot: row.id }, 'Guest feed slot added');
    this.changed(profileId, [], []);
    return this.view(slot);
  }

  rename(profileId: string, slotId: string, rawName: string): GuestFeed {
    const slot = this.require(profileId, slotId);
    const name = this.name(rawName);
    slot.row = this.opts.repo.rename(slotId, name) ?? slot.row;
    this.emitState(slot, true);
    this.changed(profileId, [], []);
    return this.view(slot);
  }

  /** New key: the old one stops working and a guest using it is disconnected. Re-activates a revoked slot. */
  async rotateKey(profileId: string, slotId: string): Promise<string> {
    const slot = this.require(profileId, slotId);
    const next = generateKey();
    await this.scope(profileId).set(slotId, next);
    slot.key = next;
    slot.row = this.opts.repo.setRevoked(slotId, false) ?? slot.row;
    slot.expectOfflineUntil = this.now() + EXPECTED_OFFLINE_MS;
    this.opts.log.info({ profileId, slot: slotId }, 'Guest feed key rotated');
    await this.disconnect(slot, 'Disconnected the guest using the old key');
    this.emitState(slot, true);
    this.changed(profileId, [], [slotId]);
    return next;
  }

  /** No key at all: nobody can send to the slot until the key is rotated. */
  async revokeKey(profileId: string, slotId: string): Promise<GuestFeed> {
    const slot = this.require(profileId, slotId);
    await this.scope(profileId).delete(slotId);
    slot.key = null;
    slot.row = this.opts.repo.setRevoked(slotId, true) ?? slot.row;
    slot.expectOfflineUntil = this.now() + EXPECTED_OFFLINE_MS;
    this.opts.log.info({ profileId, slot: slotId }, 'Guest feed key revoked');
    await this.disconnect(slot, 'Disconnected the guest of a revoked key');
    this.emitState(slot, true);
    this.changed(profileId, [], [slotId]);
    return this.view(slot);
  }

  async remove(profileId: string, slotId: string): Promise<void> {
    const slot = this.require(profileId, slotId);
    // Stop accepting it first (auth answers from this map), then drop its key and row.
    this.slots.delete(slotId);
    await this.scope(profileId).delete(slotId);
    this.opts.repo.delete(slotId);
    this.opts.log.info({ profileId, slot: slotId }, 'Guest feed slot removed');
    await this.disconnect(slot, 'Disconnected the guest of a removed slot');
    this.changed(profileId, [slotId], []);
  }

  /** A profile was deleted: its slots, keys and guests go. */
  async profileRemoved(profileId: string): Promise<void> {
    const gone = this.ofProfile(profileId);
    for (const slot of gone) this.slots.delete(slot.row.id);
    this.opts.repo.deleteProfile(profileId);
    this.opts.secrets.deleteScope(guestSecretScope(profileId));
    for (const slot of gone) await this.disconnect(slot, 'Disconnected the guest of a deleted profile');
    if (gone.length > 0) this.changed(profileId, gone.map((s) => s.row.id), []);
  }

  // ---- media state (from the media server's poll) -------------------------

  /** Apply MediaMTX's path list (by path name). */
  apply(byName: ReadonlyMap<string, MtxPath>, t: number): void {
    for (const slot of this.slots.values()) {
      slot.tracker.update(byName.get(guestPath(slot.row.id)), t);
      this.enforceLimit(slot, t);
      this.emitState(slot, false);
    }
  }

  /** MediaMTX stopped: every guest is offline. */
  resetAll(): void {
    for (const slot of this.slots.values()) {
      slot.tracker.reset();
      slot.overSince = null;
      this.emitState(slot, false);
    }
  }

  // ---- internals --------------------------------------------------------

  private newSlot(row: GuestSlotRow): Slot {
    return { row, key: null, tracker: new FeedTracker('landscape', row.profileId), emitted: null, overSince: null, limitedAt: null, expectOfflineUntil: 0 };
  }

  private ofProfile(profileId: string): Slot[] {
    return [...this.slots.values()].filter((s) => s.row.profileId === profileId);
  }

  private require(profileId: string, slotId: string): Slot {
    const slot = this.slots.get(slotId);
    if (!slot || slot.row.profileId !== profileId) throw new GuestFeedError(404, 'unknown_guest_feed', 'Guest feed not found');
    return slot;
  }

  private name(raw: string): string {
    const name = cleanGuestName(raw);
    if (!name) throw new GuestFeedError(400, 'invalid', 'Name: 1–60 characters.');
    return name;
  }

  private scope(profileId: string) {
    return this.opts.secrets.scoped(guestSecretScope(profileId));
  }

  private async loadKey(slot: Slot): Promise<string | null> {
    if (slot.row.revoked) return null;
    if (slot.key) return slot.key;
    const scope = this.scope(slot.row.profileId);
    let value = await scope.get(slot.row.id);
    if (!isValidKey(value)) {
      if (!this.slots.has(slot.row.id)) return null;
      value = generateKey();
      await scope.set(slot.row.id, value);
      this.opts.log.info({ profileId: slot.row.profileId, slot: slot.row.id }, 'Generated a new guest feed key');
    }
    if (this.slots.get(slot.row.id) === slot && !slot.row.revoked) slot.key = value;
    return slot.key;
  }

  private view(slot: Slot): GuestFeed {
    const s = slot.tracker.current();
    const limitedAt = slot.limitedAt !== null && this.now() - slot.limitedAt < GUEST_LIMITED_SHOW_MS ? new Date(slot.limitedAt).toISOString() : null;
    return {
      slot: slot.row.id,
      name: slot.row.name,
      key: slot.row.revoked ? 'revoked' : 'active',
      online: s.online,
      since: s.since,
      video: s.video,
      audio: s.audio,
      bitrateKbps: s.bitrateKbps,
      bitrateWarning: s.online && s.bitrateKbps !== null && s.bitrateKbps > this.limits.warnAboveKbps,
      problem: guestFeedProblem(s, slot.row.name),
      limitedAt,
    };
  }

  private emitState(slot: Slot, force: boolean): void {
    const feed = this.view(slot);
    const t = this.now();
    const prev = slot.emitted;
    if (prev && !force) {
      if (sameButBitrate(prev.feed, feed)) {
        if (prev.feed.bitrateKbps === feed.bitrateKbps || t - prev.at < BITRATE_EMIT_INTERVAL_MS) return;
      }
    }
    if (!prev && !feed.online && !force) {
      // Nothing to say about a slot nobody ever sent to (first poll after start).
      slot.emitted = { feed, at: t };
      return;
    }
    slot.emitted = { feed, at: t };
    const expectedOffline = !feed.online && t < slot.expectOfflineUntil;
    this.opts.bus.emit('guest-feed', { profileId: slot.row.profileId, feed, expectedOffline });
  }

  private enforceLimit(slot: Slot, t: number): void {
    const max = this.limits.maxKbps;
    const s = slot.tracker.current();
    if (max <= 0 || !s.online || s.bitrateKbps === null || s.bitrateKbps <= max) {
      slot.overSince = null;
      return;
    }
    slot.overSince ??= t;
    if (t - slot.overSince < GUEST_OVER_LIMIT_MS) return;
    slot.overSince = null;
    slot.limitedAt = t;
    this.opts.log.warn({ profileId: slot.row.profileId, slot: slot.row.id, bitrateKbps: s.bitrateKbps, maxKbps: max }, 'Guest feed over the bitrate limit; disconnecting it');
    void this.disconnect(slot, 'Disconnected a guest over the bitrate limit');
  }

  private async disconnect(slot: Slot, what: string): Promise<void> {
    if (!this.kick) return;
    try {
      if (await this.kick(guestPath(slot.row.id))) this.opts.log.info({ profileId: slot.row.profileId, slot: slot.row.id }, what);
    } catch (err) {
      this.opts.log.warn({ slot: slot.row.id, err: err instanceof Error ? err.message : String(err) }, 'Could not disconnect the guest');
    }
  }

  private changed(profileId: string, removed: string[], rekeyed: string[]): void {
    this.opts.bus.emit('guest-feeds-changed', { profileId, removed, rekeyed });
  }
}
