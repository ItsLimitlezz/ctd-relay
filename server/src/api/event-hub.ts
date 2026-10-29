// Event hub for the external API: turns EventBus events into v1 envelopes (docs/API.md §3, §5,
// §9; a chat message carrying an alert also yields an alert.<kind> envelope), keeps a replay
// buffer for /events and /events/poll (last 2000 envelopes or 15 minutes) and, per profile, a chat
// backfill buffer for GET /chat that mirrors the ChatHub ring (500) with moderation applied.
//
// Every envelope carries `src.profile` (null for events about no single profile). Readers (a
// token, optionally viewing one profile) only get what `visible()` lets through: their profile's
// events, events about no profile, app messages addressed to them; apps.changed is rendered with
// the reader's view of the apps.
//
// One hub per AppServices (eventHubFor). main.ts creates it at startup so nothing is missed.

import type { Logger } from 'pino';
import {
  DEFAULT_PROFILE_ID,
  type ChatMessage,
  type ChatModeration,
  type ConnectedApp,
  type Destination,
  type DestinationState,
  type Feed,
  type FeedState,
  type PlatformInfo,
  type Profile,
  type ProfileSummary,
  type SessionState,
} from '../../../shared/types.js';
import type { AppMessage, EventBus, ObsEvent } from '../events.js';
import type { AppServices } from '../services.js';
import { alertEventData } from './alert-map.js';
import { apiMessageFromUser, chatMessageData, moderationEvent } from './chat-map.js';
import { appsForProfile, publicApp } from './hub.js';
import { deepEqual } from './json.js';
import { apiProfile } from './profiles.js';
import { apiDestination, apiFeed, apiSession, buildStatus, totalViewers } from './status.js';
import {
  CONNECTOR,
  CORE,
  type ApiAppMessage,
  type ApiAppsChanged,
  type ApiChatMessage,
  type ApiDestination,
  type ApiDestinationDown,
  type ApiDestinationUp,
  type ApiEventType,
  type ApiFeed,
  type ApiNotice,
  type ApiProfile,
  type ApiSession,
  type ApiStatus,
  type Envelope,
  type EnvelopeSource,
} from './types.js';
import { createUlidGenerator, ulidFloor, type UlidGenerator } from './ulid.js';

export { deepEqual };

export const BUFFER_MAX_EVENTS = 2000;
export const BUFFER_MAX_AGE_MS = 15 * 60_000;
export const CHAT_BUFFER_SIZE = 500;
/** feed.status for bitrate-only changes and destination.status for stats/viewers-only changes. */
export const STATS_THROTTLE_MS = 2000;

export type EnvelopeListener = (env: Envelope) => void;

export interface EventHubDeps {
  bus: EventBus;
  /** One profile's session state (orchestrators.get(id).state()); may throw for an unknown profile. */
  state(profileId: string): SessionState;
  /** Every destination of every profile, in display order. */
  destinations(): Destination[];
  /** One destination from the repo (names, enabled flag, profile), or null once deleted. */
  destination(id: string): Destination | null;
  /** Platform info (null when unknown) — tells whether test mode skips the platform. */
  platformInfo(platform: Destination['platform']): PlatformInfo | null;
  /** Every profile, oldest first. Default: only the default profile. */
  profiles?(): Pick<Profile, 'id'>[];
  /** Every profile's summary (orchestrators.summaries()). Default: none (no profile.status events). */
  summaries?(): ProfileSummary[];
  /** Every connected app, unfiltered (AppRegistry.list()). Default: none. */
  apps?(): ConnectedApp[];
  log: Pick<Logger, 'warn'>;
  now?: () => number;
  ulid?: UlidGenerator;
  bufferMax?: number;
  bufferMaxAgeMs?: number;
  chatBufferSize?: number;
  throttleMs?: number;
}

/** Who reads the stream: decides which envelopes they get (visible()). */
export interface EventReader {
  tokenId: string;
  /** Profile the token is limited to (null = every profile). */
  tokenProfile: string | null;
  /** Only this profile's events (plus events about no single profile); null = every profile. */
  profile: string | null;
}

interface Throttled<T> {
  /** Last value sent (null = never sent). */
  sent: T | null;
  sentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface DestinationTrack extends Throttled<ApiDestination> {
  profileId: string;
  down: boolean;
  downSince: number | null;
}

type SessionLike = Pick<SessionState, 'status' | 'startedAt' | 'title' | 'autoGoLive' | 'testMode'>;

/** What the hub knows of one profile. */
interface ProfileTrack {
  session: SessionLike;
  /** Last stream.status sent (null = never: the next session event is sent whatever it says). */
  sentSession: ApiSession | null;
  /** Latest state of each of its destinations. */
  states: Map<string, DestinationState>;
  feeds: Map<Feed, Throttled<ApiFeed>>;
  latestFeeds: Map<Feed, ApiFeed>;
  /** GET /chat backfill (chat.message envelopes still visible after moderation). */
  chat: Envelope<ApiChatMessage>[];
}

/** Newest evicted envelope per (type, profile, audience): who would have missed something. */
interface Evicted {
  type: ApiEventType;
  profile: string | null;
  audience: string | null;
  id: string;
}

function withoutKeys<T extends object>(value: T, keys: readonly (keyof T)[]): Partial<T> {
  const copy: Partial<T> = { ...value };
  for (const k of keys) delete copy[k];
  return copy;
}

const DESTINATION_STATS_KEYS: readonly (keyof ApiDestination)[] = ['stats', 'viewers'];
const FEED_STATS_KEYS: readonly (keyof ApiFeed)[] = ['bitrateKbps'];

function source(connection: string, platform: EnvelopeSource['platform'], profile: string | null): EnvelopeSource {
  return { connector: CONNECTOR, connection, platform, profile };
}
const coreSource = (profile: string | null) => source(CORE, CORE, profile);

export function profileOf(dest: Pick<Destination, 'profileId'>): string {
  return dest.profileId ?? DEFAULT_PROFILE_ID;
}

function offlineSession(): SessionLike {
  return { status: 'offline', startedAt: null, title: '', autoGoLive: true, testMode: false };
}

/** Audience of a message to an app nobody has registered (any more): no reader gets it. */
const NOBODY = '\u0000nobody';

/** Would `reader` get an event of this profile / audience? */
function reaches(profile: string | null, audience: string | null, reader: EventReader): boolean {
  if (audience !== null && (audience === NOBODY || audience !== reader.tokenId)) return false;
  if (profile === null) return true;
  if (reader.tokenProfile !== null && profile !== reader.tokenProfile) return false;
  return reader.profile === null || reader.profile === profile;
}

export function apiAppMessage(m: AppMessage, fallbackTs: number): ApiAppMessage {
  const ts = Date.parse(m.ts);
  return {
    id: m.id,
    from: m.from,
    to: m.to,
    type: m.type,
    profileId: m.profileId,
    replyTo: m.replyTo,
    data: m.data,
    ts: Number.isFinite(ts) ? ts : fallbackTs,
  };
}

export class EventHub {
  /** Smallest id this process can have produced: an older cursor predates this run (reset). */
  readonly floor: string;

  private readonly deps: EventHubDeps;
  private readonly now: () => number;
  private readonly ulid: UlidGenerator;
  private readonly bufferMax: number;
  private readonly bufferMaxAgeMs: number;
  private readonly chatBufferSize: number;
  private readonly throttleMs: number;

  private buffer: Envelope[] = [];
  private readonly evicted = new Map<string, Evicted>();
  /** Directed app messages: the only token that may read them. */
  private readonly audiences = new WeakMap<Envelope, string>();
  private lastId: string | null = null;
  private readonly listeners = new Set<EnvelopeListener>();
  private readonly unsubscribers: (() => void)[] = [];

  private readonly tracks = new Map<string, ProfileTrack>();
  private readonly destinations = new Map<string, DestinationTrack>();
  private readonly summaries = new Map<string, ApiProfile>();
  private closed = false;

  constructor(deps: EventHubDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.ulid = deps.ulid ?? createUlidGenerator(this.now);
    this.bufferMax = deps.bufferMax ?? BUFFER_MAX_EVENTS;
    this.bufferMaxAgeMs = deps.bufferMaxAgeMs ?? BUFFER_MAX_AGE_MS;
    this.chatBufferSize = deps.chatBufferSize ?? CHAT_BUFFER_SIZE;
    this.throttleMs = deps.throttleMs ?? STATS_THROTTLE_MS;
    this.floor = ulidFloor(this.now());

    // Baseline: what clients would see right now, so the first real change is detected as one.
    for (const id of this.profileIds()) this.tracks.set(id, this.newTrack(id, true));
    for (const dest of this.safeDestinations() ?? []) {
      const item = this.buildDestination(dest);
      this.destinations.set(dest.id, {
        profileId: profileOf(dest),
        sent: item,
        sentAt: 0,
        timer: null,
        down: item.down,
        downSince: item.down ? this.now() : null,
      });
    }
    for (const s of this.safeSummaries() ?? []) this.summaries.set(s.id, apiProfile(s));

    const { bus } = deps;
    this.unsubscribers.push(
      bus.on('chat', (m) => this.guard(() => this.onChat(m))),
      bus.on('chat-moderation', (m) => this.guard(() => this.onModeration(m))),
      bus.on('session', (s) => this.guard(() => this.onSession(s))),
      bus.on('destination', (st) => this.guard(() => this.onDestination(st))),
      bus.on('destinations-changed', (scope?: { profileId: string }) =>
        this.guard(() => {
          this.refreshAll(scope?.profileId);
          this.refreshSummaries();
        }),
      ),
      bus.on('feed', (f) => this.guard(() => this.onFeed(f))),
      bus.on('notice', (n) =>
        this.guard(() => this.publish<ApiNotice>('system.notice', coreSource(n.profileId ?? null), { level: n.level, message: n.message })),
      ),
      bus.on('profiles-changed', () => this.guard(() => this.onProfilesChanged())),
      bus.on('apps-changed', () => this.guard(() => this.onAppsChanged())),
      bus.on('app-message', (m) => this.guard(() => this.onAppMessage(m))),
      bus.on('obs-event', (e) => this.guard(() => this.onObsEvent(e))),
      // Spotify (music/music-service.ts): what plays, and chat song requests.
      bus.on('music', (m) => this.guard(() => this.publish('music.nowplaying', coreSource(m.profileId), m.nowPlaying))),
      bus.on('music-request', (r) =>
        this.guard(() => {
          const dest = this.safeDestination(r.destinationId);
          this.publish('music.request', source(r.destinationId, dest?.platform ?? r.result.platform, r.profileId), r.result);
        }),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** The current position: pass it as `after` to get only what happens from now on. */
  cursor(): string {
    return this.lastId ?? this.floor;
  }

  /**
   * Buffered envelopes after `after` (oldest first, unfiltered: apply `types` and `visible()`), or
   * reset when something the reader would receive was lost: `after` predates this process, is newer
   * than anything this process produced (a cursor from an earlier run with the clock set back), or
   * an envelope after it that `reader` would get, of one of `types` (default: any), left the buffer.
   */
  since(after: string, types?: ReadonlySet<ApiEventType>, reader?: EventReader): { items: Envelope[]; reset: boolean } {
    this.evictOld();
    if (after < this.floor || after > this.cursor() || this.lostAfter(after, types, reader)) return { items: [], reset: true };
    return { items: this.buffer.slice(this.firstAfter(this.buffer, after)), reset: false };
  }

  private lostAfter(after: string, types: ReadonlySet<ApiEventType> | undefined, reader: EventReader | undefined): boolean {
    for (const e of this.evicted.values()) {
      if (after >= e.id) continue;
      if (types && !types.has(e.type)) continue;
      if (reader && !reaches(e.profile, e.audience, reader)) continue;
      return true;
    }
    return false;
  }

  /**
   * The envelope as `reader` gets it, or null when it isn't for them: another profile's event, or
   * an app message addressed to another token. apps.changed lists the apps as seen from the
   * reader's profile (like GET /apps?profile=).
   */
  visible(env: Envelope, reader: EventReader): Envelope | null {
    if (!reaches(env.src.profile ?? null, this.audiences.get(env) ?? null, reader)) return null;
    if (env.type === 'apps.changed') {
      const view = reader.profile ?? reader.tokenProfile;
      if (view !== null) {
        const data = env.data as ApiAppsChanged;
        return { ...env, data: { apps: appsForProfile(data.apps, view) } satisfies ApiAppsChanged };
      }
    }
    return env;
  }

  /** Recent chat of one profile still visible after moderation, oldest first. */
  chat(limit: number, after?: string, profileId: string = DEFAULT_PROFILE_ID): { items: Envelope<ApiChatMessage>[]; next: string } {
    const buffer = this.tracks.get(profileId)?.chat ?? [];
    // A cursor newer than anything this process produced (earlier run, clock set back) means nothing: treat it as absent.
    if (after !== undefined && after <= this.cursor()) {
      const items = buffer.slice(this.firstAfter(buffer, after)).slice(0, limit);
      return { items, next: items.at(-1)?.id ?? after };
    }
    const items = limit > 0 ? buffer.slice(-limit) : [];
    return { items, next: items.at(-1)?.id ?? this.cursor() };
  }

  /** GET /status of one profile. */
  status(profileId: string = DEFAULT_PROFILE_ID): ApiStatus {
    return buildStatus({
      state: () => this.deps.state(profileId),
      destinations: () => this.deps.destinations().filter((d) => profileOf(d) === profileId),
      platformInfo: (platform) => this.deps.platformInfo(platform),
    });
  }

  /**
   * Current state as fresh (unbuffered) envelopes: per profile (one, or every profile when null),
   * one stream.status + one destination.status per destination.
   */
  snapshot(profile: string | null = null): Envelope[] {
    const ids = profile !== null ? [profile] : this.profileIds();
    const ts = this.now();
    const out: Envelope[] = [];
    for (const id of ids) {
      let status: ApiStatus;
      try {
        status = this.status(id);
      } catch (err) {
        this.deps.log.warn({ error: (err as Error).message }, 'api event hub: reading a profile status failed');
        continue;
      }
      out.push(this.envelope('stream.status', coreSource(id), status.session, ts));
      for (const d of status.destinations) out.push(this.envelope('destination.status', source(d.id, d.platform, id), d, ts));
    }
    return out;
  }

  /** A fresh system.reset envelope (not buffered). */
  resetEnvelope(): Envelope<Record<string, never>> {
    return this.envelope('system.reset', coreSource(null), {}, this.now());
  }

  subscribe(listener: EnvelopeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Live subscribers (open event streams); for diagnostics and tests. */
  listenerCount(): number {
    return this.listeners.size;
  }

  close(): void {
    this.closed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const t of this.destinations.values()) if (t.timer) clearTimeout(t.timer);
    for (const track of this.tracks.values()) this.stopTimers(track);
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  private envelope<T>(type: ApiEventType, src: EnvelopeSource, data: T, ts: number): Envelope<T> {
    const id = this.ulid();
    this.lastId = id;
    return { id, type, ts, src, data };
  }

  private publish<T>(type: ApiEventType, src: EnvelopeSource, data: T, audience: string | null = null): Envelope<T> {
    const env = this.envelope(type, src, data, this.now());
    if (audience !== null) this.audiences.set(env, audience);
    this.buffer.push(env);
    this.evictOld();
    for (const listener of this.listeners) {
      try {
        listener(env);
      } catch (err) {
        this.deps.log.warn({ error: (err as Error).message }, 'api event listener failed');
      }
    }
    return env;
  }

  private evictOld(): void {
    const oldest = this.now() - this.bufferMaxAgeMs;
    let drop = Math.max(0, this.buffer.length - this.bufferMax);
    while (drop < this.buffer.length && (this.buffer[drop]?.ts ?? Infinity) < oldest) drop++;
    if (drop === 0) return;
    for (const env of this.buffer.splice(0, drop)) {
      const profile = env.src.profile ?? null;
      const audience = this.audiences.get(env) ?? null;
      this.evicted.set(`${env.type}\u0000${profile ?? ''}\u0000${audience ?? ''}`, { type: env.type, profile, audience, id: env.id });
    }
  }

  /** Index of the first envelope with id > after (buffers are sorted by id). */
  private firstAfter(list: readonly Envelope[], after: string): number {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((list[mid]?.id ?? '') <= after) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private guard(fn: () => void): void {
    if (this.closed) return;
    try {
      fn();
    } catch (err) {
      this.deps.log.warn({ error: (err as Error).message }, 'api event hub failed to handle an event');
    }
  }

  // -------------------------------------------------------------------------
  // Profiles
  // -------------------------------------------------------------------------

  private profileIds(): string[] {
    try {
      const list = this.deps.profiles ? this.deps.profiles() : [{ id: DEFAULT_PROFILE_ID }];
      return list.map((p) => p.id);
    } catch (err) {
      this.deps.log.warn({ error: (err as Error).message }, 'api event hub: listing profiles failed');
      return this.tracks.size > 0 ? [...this.tracks.keys()] : [DEFAULT_PROFILE_ID];
    }
  }

  /**
   * A profile's track. `baseline`: start from its current state (no event for what is already
   * true); without it, the first session/feed event is sent whatever it says (the track is created
   * by that event, so the current state already includes it).
   */
  private newTrack(profileId: string, baseline: boolean): ProfileTrack {
    let state: SessionState | null = null;
    if (baseline) {
      try {
        state = this.deps.state(profileId);
      } catch (err) {
        this.deps.log.warn({ error: (err as Error).message }, 'api event hub: reading a session state failed');
      }
    }
    const track: ProfileTrack = {
      session: state ?? offlineSession(),
      sentSession: state ? apiSession(state, totalViewers(state.destinations)) : null,
      states: new Map(),
      feeds: new Map(),
      latestFeeds: new Map(),
      chat: [],
    };
    if (state) {
      for (const st of state.destinations) track.states.set(st.destinationId, st);
      for (const f of state.feeds) {
        track.feeds.set(f.feed, { sent: apiFeed(f), sentAt: 0, timer: null });
        track.latestFeeds.set(f.feed, apiFeed(f));
      }
    }
    return track;
  }

  private track(profileId: string, baseline = true): ProfileTrack {
    let track = this.tracks.get(profileId);
    if (!track) {
      track = this.newTrack(profileId, baseline);
      this.tracks.set(profileId, track);
    }
    return track;
  }

  private stopTimers(track: ProfileTrack): void {
    for (const f of track.feeds.values()) if (f.timer) clearTimeout(f.timer);
  }

  private onProfilesChanged(): void {
    this.publish('profiles.changed', coreSource(null), {});
    let ids: string[] | null = null;
    try {
      ids = (this.deps.profiles ? this.deps.profiles() : [{ id: DEFAULT_PROFILE_ID }]).map((p) => p.id);
    } catch (err) {
      this.deps.log.warn({ error: (err as Error).message }, 'api event hub: listing profiles failed');
    }
    if (ids) {
      const keep = new Set(ids);
      for (const [id, track] of this.tracks) {
        if (keep.has(id)) continue;
        this.stopTimers(track);
        this.tracks.delete(id); // its chat backfill goes with it
      }
      for (const id of ids) this.track(id);
    }
    this.refreshAll(); // destinations of a deleted profile are gone: closes their down edges
    this.refreshSummaries();
  }

  /** profile.status for every profile whose summary changed. */
  private refreshSummaries(): void {
    const list = this.safeSummaries();
    if (list === null) return;
    const seen = new Set<string>();
    for (const s of list) {
      seen.add(s.id);
      const item = apiProfile(s);
      const prev = this.summaries.get(s.id);
      if (prev && deepEqual(prev, item)) continue;
      this.summaries.set(s.id, item);
      this.publish('profile.status', coreSource(s.id), item);
    }
    for (const id of [...this.summaries.keys()]) if (!seen.has(id)) this.summaries.delete(id);
  }

  // -------------------------------------------------------------------------
  // Hub (connected apps)
  // -------------------------------------------------------------------------

  private onAppsChanged(): void {
    const apps = this.deps.apps ? this.deps.apps() : [];
    this.publish<ApiAppsChanged>('apps.changed', coreSource(null), { apps: apps.map(publicApp) });
  }

  private onAppMessage(m: AppMessage): void {
    let audience: string | null = null;
    if (m.to !== null) {
      // Only the token that registered the recipient reads it (nobody, e.g. once it unregistered).
      const apps = this.deps.apps ? this.deps.apps() : [];
      audience = apps.find((a) => a.id === m.to)?.tokenId ?? NOBODY;
    }
    this.publish('app.message', coreSource(m.profileId), apiAppMessage(m, this.now()), audience);
  }

  /** obs.* from a connected app: its data plus who sent it (`appId`), its id and its time (`at`). */
  private onObsEvent(e: ObsEvent): void {
    this.publish(e.type as ApiEventType, source(e.appId, 'obs', e.profileId), { ...e.data, appId: e.appId, eventId: e.id, at: e.ts });
  }

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------

  private channelName(destinationId: string, platform: ChatMessage['platform']): string {
    const dest = this.safeDestination(destinationId);
    if (dest) return dest.name;
    return this.safePlatformInfo(platform)?.name ?? platform;
  }

  private chatProfile(profileId: string | undefined, destinationId: string): string {
    if (profileId) return profileId;
    const dest = this.safeDestination(destinationId);
    return dest ? profileOf(dest) : DEFAULT_PROFILE_ID;
  }

  private onChat(msg: ChatMessage): void {
    const profile = this.chatProfile(msg.profileId, msg.destinationId);
    const src = source(msg.destinationId, msg.platform, profile);
    const data = chatMessageData(msg, this.channelName(msg.destinationId, msg.platform));
    const env = this.publish('chat.message', src, data);
    const buffer = this.track(profile).chat;
    buffer.push(env);
    if (buffer.length > this.chatBufferSize) buffer.splice(0, buffer.length - this.chatBufferSize);
    // Sub, gift, cheer, raid, Super Chat…: also a structured alert.<kind>, right after its chat line.
    const alert = alertEventData(msg);
    if (alert) this.publish(alert.type, src, alert.data);
  }

  private onModeration(m: ChatModeration): void {
    const profile = this.chatProfile(m.profileId, m.destinationId);
    const event = moderationEvent(m);
    this.publish(event.type, source(m.destinationId, m.platform, profile), event.data);
    const sameDest = (e: Envelope<ApiChatMessage>) => e.data.destinationId === m.destinationId;
    let remove: (e: Envelope<ApiChatMessage>) => boolean;
    switch (m.kind) {
      case 'message-deleted': {
        const prefixed = `${m.platform}:${m.platformMessageId}`;
        remove = (e) =>
          sameDest(e) && ((m.messageId !== null && e.data.id === m.messageId) || e.data.platformMessageId === m.platformMessageId || e.data.id === prefixed);
        break;
      }
      case 'user-cleared':
        remove = (e) => sameDest(e) && apiMessageFromUser(e.data, m);
        break;
      case 'cleared':
        remove = sameDest;
        break;
    }
    const track = this.tracks.get(profile);
    if (track) track.chat = track.chat.filter((e) => !remove(e));
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  private onSession(s: SessionState): void {
    const profile = s.profileId ?? DEFAULT_PROFILE_ID;
    const track = this.track(profile, false);
    track.session = s;
    track.states = new Map(s.destinations.map((st) => [st.destinationId, st]));
    this.sendSession(profile, track, true);
    this.refreshAll(profile);
    this.refreshSummaries();
  }

  /** stream.status when the session (or the total viewer count) changed; `force` when it's never been sent. */
  private sendSession(profile: string, track: ProfileTrack, force: boolean): void {
    const session = apiSession(track.session, totalViewers(track.states.values()));
    if (track.sentSession === null ? !force : deepEqual(session, track.sentSession)) return;
    track.sentSession = session;
    this.publish('stream.status', coreSource(profile), session);
  }

  private onDestination(st: DestinationState): void {
    const dest = this.safeDestination(st.destinationId);
    const profile = st.profileId ?? (dest ? profileOf(dest) : DEFAULT_PROFILE_ID);
    const track = this.track(profile);
    const prev = track.states.get(st.destinationId);
    track.states.set(st.destinationId, st);
    // The total viewer count rides on stream.status.
    if ((prev?.viewers ?? null) !== (st.viewers ?? null)) this.sendSession(profile, track, false);
    if (dest) this.refreshDestination(dest);
    // Live/down counts only change with the phase (stats and viewers updates don't).
    if (!prev || prev.phase !== st.phase) this.refreshSummaries();
  }

  /** Re-evaluate every destination (of one profile, or of all). Removed ones close their down edge. */
  private refreshAll(profile?: string): void {
    const list = this.safeDestinations();
    // A failed listing is not an empty one: keep the tracks (and their down state) until it works again.
    if (list === null) return;
    const present = new Set<string>();
    for (const dest of list) {
      if (profile !== undefined && profileOf(dest) !== profile) continue;
      present.add(dest.id);
      this.refreshDestination(dest);
    }
    for (const [id, track] of this.destinations) {
      if (present.has(id)) continue;
      if (profile !== undefined && track.profileId !== profile) continue;
      if (track.timer) clearTimeout(track.timer);
      this.destinations.delete(id);
      // A deleted destination isn't down any more: close its down edge so clients don't keep a red row.
      if (track.down && track.sent) {
        const now = this.now();
        this.publish<ApiDestinationUp>('destination.up', source(id, track.sent.platform, track.profileId), {
          destinationId: id,
          name: track.sent.name,
          platform: track.sent.platform,
          downForSec: Math.max(0, Math.round((now - (track.downSince ?? now)) / 1000)),
          recoveries: track.sent.recoveries,
        });
      }
    }
  }

  private buildDestination(dest: Destination): ApiDestination {
    const track = this.track(profileOf(dest));
    return apiDestination(dest, track.states.get(dest.id), track.session, this.safePlatformInfo(dest.platform));
  }

  private refreshDestination(dest: Destination): void {
    const profile = profileOf(dest);
    let track = this.destinations.get(dest.id);
    if (!track) {
      track = { profileId: profile, sent: null, sentAt: 0, timer: null, down: false, downSince: null };
      this.destinations.set(dest.id, track);
    }
    track.profileId = profile;
    const item = this.buildDestination(dest);
    const src = source(dest.id, dest.platform, profile);
    this.update(track, item, DESTINATION_STATS_KEYS, (d) => this.publish('destination.status', src, d), () => {
      const current = this.deps.destination(dest.id);
      return current ? this.buildDestination(current) : null;
    });

    if (item.down !== track.down) {
      const now = this.now();
      if (item.down) {
        track.downSince = now;
        this.publish<ApiDestinationDown>('destination.down', src, {
          destinationId: dest.id,
          name: dest.name,
          platform: dest.platform,
          phase: item.phase,
          reason: item.message,
        });
      } else {
        const since = track.downSince ?? now;
        track.downSince = null;
        this.publish<ApiDestinationUp>('destination.up', src, {
          destinationId: dest.id,
          name: dest.name,
          platform: dest.platform,
          downForSec: Math.max(0, Math.round((now - since) / 1000)),
          recoveries: item.recoveries,
        });
      }
      track.down = item.down;
    }
  }

  private onFeed(f: FeedState): void {
    const profile = f.profileId ?? DEFAULT_PROFILE_ID;
    const profileTrack = this.track(profile, false);
    let track = profileTrack.feeds.get(f.feed);
    if (!track) {
      track = { sent: null, sentAt: 0, timer: null };
      profileTrack.feeds.set(f.feed, track);
    }
    const item = apiFeed(f);
    profileTrack.latestFeeds.set(f.feed, item);
    // A trailing (throttled) send uses the newest state of that feed.
    this.update(
      track,
      item,
      FEED_STATS_KEYS,
      (value) => this.publish('feed.status', coreSource(profile), value),
      () => profileTrack.latestFeeds.get(f.feed) ?? null,
    );
  }

  /**
   * Send `item` now when something other than `statsKeys` changed (or it was never sent); when only
   * stats changed, send at most once per throttle window (trailing send with the latest value).
   */
  private update<T extends object>(
    track: Throttled<T>,
    item: T,
    statsKeys: readonly (keyof T)[],
    send: (item: T) => void,
    latest: () => T | null,
  ): void {
    const sendNow = (value: T) => {
      if (track.timer) clearTimeout(track.timer);
      track.timer = null;
      track.sent = value;
      track.sentAt = this.now();
      send(value);
    };
    if (track.sent === null) return sendNow(item);
    if (deepEqual(track.sent, item)) return;
    if (!deepEqual(withoutKeys(track.sent, statsKeys), withoutKeys(item, statsKeys))) return sendNow(item);
    // Stats-only change.
    const wait = track.sentAt + this.throttleMs - this.now();
    if (wait <= 0 && !track.timer) return sendNow(item);
    if (track.timer) return;
    track.timer = setTimeout(() => {
      track.timer = null;
      // Timer callbacks run outside the bus handlers' guard: a throwing repo read here would
      // otherwise be an uncaught exception that takes the whole process down.
      this.guard(() => {
        const value = latest();
        if (value && !deepEqual(value, track.sent)) sendNow(value);
      });
    }, Math.max(0, wait));
    track.timer.unref?.();
  }

  // -------------------------------------------------------------------------
  // Defensive accessors (a failing repo must not break the bus)
  // -------------------------------------------------------------------------

  /** The destinations, or null when listing them failed (never mistake a failure for "none"). */
  private safeDestinations(): Destination[] | null {
    try {
      return this.deps.destinations();
    } catch (err) {
      this.deps.log.warn({ error: (err as Error).message }, 'api event hub: listing destinations failed');
      return null;
    }
  }

  private safeDestination(id: string): Destination | null {
    try {
      return this.deps.destination(id);
    } catch {
      return null;
    }
  }

  private safePlatformInfo(platform: Destination['platform']): PlatformInfo | null {
    try {
      return this.deps.platformInfo(platform);
    } catch {
      return null;
    }
  }

  private safeSummaries(): ProfileSummary[] | null {
    if (!this.deps.summaries) return null;
    try {
      return this.deps.summaries();
    } catch (err) {
      this.deps.log.warn({ error: (err as Error).message }, 'api event hub: reading the profile summaries failed');
      return null;
    }
  }
}

/** The hub's view of the services (also used by the tests, so they exercise the same wiring). */
export function eventHubDeps(services: AppServices): EventHubDeps {
  return {
    bus: services.bus,
    log: services.log.child({ mod: 'api-events' }),
    state: (profileId) => services.orchestrators.get(profileId).state(),
    destinations: () => services.repos.destinations.list(),
    destination: (id) => services.repos.destinations.get(id),
    platformInfo: (platform) => {
      try {
        return services.platforms.get(platform).info;
      } catch {
        return null;
      }
    },
    profiles: () => services.repos.profiles.list(),
    summaries: () => services.orchestrators.summaries(),
    apps: () => services.apps.list(),
  };
}

const hubs = new WeakMap<AppServices, EventHub>();

/** The API event hub of these services (created on first use; main.ts calls it at startup). */
export function eventHubFor(services: AppServices): EventHub {
  let hub = hubs.get(services);
  if (!hub) {
    hub = new EventHub(eventHubDeps(services));
    hubs.set(services, hub);
  }
  return hub;
}
