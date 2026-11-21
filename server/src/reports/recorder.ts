// Records stream reports (docs/REPORTS.md) by listening to the event bus. It never calls into the
// go-live path: a failure here is logged and dropped, and streaming carries on.
//
// The bus is synchronous, so its handlers here only update memory: every database write goes into a
// queue that is written in one transaction after the current event-loop turn (setImmediate), and
// chat (messages, joins, people) is added up in memory and written with the 30 s tick. A burst of
// chat costs no SQLite work in the emitter's stack, and a slow write can't hold up an emitter.
//
// What it writes, per session (a profile's go-live, from the first `session` snapshot with a
// session id until the profile is offline again):
// - titles with the time they changed, test mode, destinations (platform, canvas, Dual Format),
//   each destination's live periods, recoveries, errors, retries and blocked states;
// - viewers of every destination every 30 s and whenever the count changes (unknown = null);
// - chat per platform per minute (messages, events, joins, distinct chatters) and per session;
// - each feed's codec, resolution, fps, bitrate and keyframe interval per minute, online or not;
// - with audience tracking on: per user per stream, messages, joins, other events, first/last
//   message time, and presence where a platform reports it (presence.ts). Never message text.

import type { Logger } from 'pino';
import type { ChatMessage, Destination, DestinationState, Feed, FeedState, PlatformId, SessionState } from '../../../shared/types.js';
import { DEFAULT_REPORT_SETTINGS, type ReportEvent, type ReportSettings } from '../../../shared/reports.js';
import { apiUserId } from '../api/chat-map.js';
import type { EventBus } from '../events.js';
import { redactSecretsInText } from '../media/redact.js';
import type { AudienceActivity, AudienceIdentity, ChatDelta, ReportStore } from './store.js';

export const VIEWER_SAMPLE_MS = 30_000;
export const PRESENCE_SAMPLE_MS = 5 * 60_000;
export const RETENTION_CHECK_MS = 6 * 3600_000;
/** Retention deletes this many streams per transaction, and works for at most this long before yielding. */
export const RETENTION_BATCH = 20;
export const RETENTION_SLICE_MS = 50;
/** Watch time credited between two presence samples is capped at this (a missed sample is not watching). */
export const PRESENCE_MAX_CREDIT_SEC = 2 * (PRESENCE_SAMPLE_MS / 1000);
/** Upper bound for "and N others joined" (a misread number must not swamp the totals). */
const MAX_OTHERS = 100_000;

const DEFAULT_PROFILE = 'default';

/** Who a platform says is in the chat right now (presence.ts). */
export type PresenceResult =
  | { ok: true; users: { id: string; login: string | null; name: string }[] }
  | { ok: false; reason: 'unsupported' | 'scope' | 'error'; message?: string };

export type PresenceProvider = (dest: Destination, signal: AbortSignal) => Promise<PresenceResult>;

export interface RecorderOptions {
  bus: EventBus;
  store: ReportStore;
  log: Pick<Logger, 'info' | 'warn' | 'debug'>;
  settings: () => ReportSettings;
  destination: (id: string) => Destination | null;
  /** Current session snapshots, read at start() (sessions already running). */
  sessions?: () => SessionState[];
  presence?: PresenceProvider | null;
  now?: () => number;
  /** false in tests: call tick() / presenceTick() / retention() by hand. */
  timers?: boolean;
}

interface DestTrack {
  platform: PlatformId;
  phase: DestinationState['phase'];
  viewers: number | null;
  recoveries: number;
  blocked: string | null;
  /** Presence asks stopped for this session (missing scope, unsupported). */
  noPresence: boolean;
}

interface ChatAcc {
  minute: string;
  delta: ChatDelta;
  minuteUniques: Set<string>;
  sessionUniques: Set<string>;
  totals: ChatDelta & { anonymousJoins: number };
}

interface FeedAcc {
  state: FeedState;
  minute: string;
  bitrateSum: number;
  bitrateCount: number;
}

interface Active {
  id: string;
  profileId: string;
  title: string;
  testMode: boolean;
  audienceMarked: boolean;
  dests: Map<string, DestTrack>;
  chat: Map<PlatformId, ChatAcc>;
  feeds: Map<Feed, FeedAcc>;
  presencePrev: Map<PlatformId, { ts: number; users: Set<string> }>;
  /** Chat activity per person since the last write (audience tracking on). */
  audience: Map<string, AudienceActivity>;
}

export function minuteOf(ms: number): string {
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}

export function viewerValue(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

/**
 * `othersCount` of a join line that names one user and N others (Instagram's "<name> and 3 others
 * joined", API 1.12): the named user is a join, the N others are anonymous joins.
 */
export function othersCount(msg: ChatMessage): number {
  const raw: unknown = msg.othersCount;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_OTHERS) : 0;
}

/** Event details are kept for months and exported: never a URL's path, query or a key in them. */
function cleanDetail(kind: ReportEvent['kind'], detail: string | null): string | null {
  if (detail === null || kind === 'title') return detail;
  return redactSecretsInText(detail);
}

/** The audience identity of a chat author, or null when the line has no name and no id. */
export function audienceIdentity(msg: ChatMessage): AudienceIdentity | null {
  const name = (msg.author?.name ?? '').trim();
  const pid = (msg.author?.id ?? '').trim() || null;
  if (!name && !pid) return null;
  return {
    id: apiUserId(msg.platform, pid, name),
    platform: msg.platform,
    platformUserId: pid,
    displayName: name || pid || '',
    login: msg.author?.login?.trim() || null,
  };
}

const emptyDelta = (): ChatDelta => ({ messages: 0, events: 0, joins: 0 });

export class ReportRecorder {
  private readonly active = new Map<string, Active>(); // by profile id
  private readonly offs: (() => void)[] = [];
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readonly presenceCtl = new AbortController();
  private presenceRunning = false;
  private readonly now: () => number;
  /** Writes waiting for the next drain (one transaction). */
  private readonly queue: (() => void)[] = [];
  private drainTimer: ReturnType<typeof setImmediate> | null = null;
  private retentionTimer: ReturnType<typeof setImmediate> | null = null;
  private closed = false;
  /** Settings, read once per tick and on settingsChanged(), not once per chat line. */
  private cfg: ReportSettings;

  constructor(private readonly o: RecorderOptions) {
    this.now = o.now ?? Date.now;
    this.cfg = o.settings();
  }

  start(): void {
    const { bus } = this.o;
    this.closed = false;
    this.cfg = this.o.settings();
    this.offs.push(
      bus.on('session', (s) => this.guard('session', () => this.onSession(s))),
      bus.on('destination', (d) => this.guard('destination', () => this.onDestination(d))),
      bus.on('feed', (f) => this.guard('feed', () => this.onFeed(f))),
      bus.on('chat', (m) => this.guard('chat', () => this.onChat(m))),
    );
    for (const s of this.o.sessions?.() ?? []) this.guard('session', () => this.onSession(s));
    this.drain();
    this.guard('restart', () => {
      const closed = this.o.store.closeOrphans([...this.active.values()].map((a) => a.id));
      if (closed > 0) this.o.log.info({ sessions: closed }, 'reports: sessions left open by a restart were closed at their last record');
    });
    this.retention();
    if (this.o.timers !== false) {
      const every = (ms: number, fn: () => void) => {
        const t = setInterval(fn, ms);
        t.unref?.();
        this.timers.push(t);
      };
      every(VIEWER_SAMPLE_MS, () => this.tick());
      every(PRESENCE_SAMPLE_MS, () => void this.presenceTick());
      every(RETENTION_CHECK_MS, () => this.retention());
    }
  }

  close(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.presenceCtl.abort();
    if (this.retentionTimer) clearImmediate(this.retentionTimer);
    this.retentionTimer = null;
    for (const a of this.active.values()) this.guard('close', () => this.flush(a));
    this.drain();
    this.closed = true;
  }

  /**
   * Settings changed: recording turned off ends what is being recorded now; audience tracking
   * turned off drops what was added up about people since the last write and writes no more.
   */
  settingsChanged(): void {
    this.cfg = this.o.settings();
    if (!this.cfg.audience) for (const a of this.active.values()) a.audience.clear();
    if (!this.cfg.recording) for (const a of [...this.active.values()]) this.guard('settings', () => this.end(a, this.iso()));
    this.drain();
  }

  /** Write everything added up in memory and everything queued, now (before reading reports). */
  sync(): void {
    for (const a of this.active.values()) this.guard('sync', () => this.flush(a));
    this.drain();
  }

  /** Write the queued writes in one transaction. A failing write is logged and skipped. */
  drain(): void {
    if (this.drainTimer) {
      clearImmediate(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    this.guard('write', () => this.o.store.transaction(() => {
      for (const fn of batch) this.guard('write', fn);
    }));
  }

  /**
   * "Forget this user": also forget what is held in memory about them (pending chat counts, the
   * last presence sample, so no watch time is credited from before), then delete their rows.
   */
  forgetUser(userId: string): boolean {
    this.sync();
    for (const a of this.active.values()) {
      a.audience.delete(userId);
      for (const p of a.presencePrev.values()) p.users.delete(userId);
    }
    return this.o.store.forgetUser(userId);
  }

  /** Session ids being recorded now. */
  activeSessionIds(): string[] {
    return [...this.active.values()].map((a) => a.id);
  }

  // ---------------------------------------------------------------- periodic

  /** Every 30 s: a viewer sample of every destination, chat and feed minutes, last-seen time. */
  tick(): void {
    this.guard('settings', () => {
      this.cfg = this.o.settings();
    });
    const ts = this.iso();
    for (const a of this.active.values()) {
      this.guard('tick', () => {
        for (const [id, d] of a.dests) {
          const viewers = d.viewers;
          this.write(() => this.o.store.addViewerSample(a.id, id, ts, viewers));
        }
        this.flush(a);
        this.write(() => this.o.store.touchSession(a.id, ts));
      });
    }
    this.drain();
  }

  /** Every 5 min: ask platforms that can tell who is present (Twitch chatters list). */
  async presenceTick(): Promise<void> {
    const provider = this.o.presence;
    if (!provider || this.presenceRunning || !this.cfg.audience) return;
    this.presenceRunning = true;
    try {
      for (const a of [...this.active.values()]) {
        const byPlatform = new Map<PlatformId, Map<string, AudienceIdentity>>();
        for (const [destId, d] of a.dests) {
          if (d.phase !== 'live' || d.noPresence) continue;
          const dest = this.o.destination(destId);
          if (!dest) continue;
          let result: PresenceResult;
          try {
            result = await provider(dest, this.presenceCtl.signal);
          } catch (err) {
            result = { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
          }
          if (this.presenceCtl.signal.aborted || this.active.get(a.profileId) !== a || !this.cfg.audience) return;
          if (!result.ok) {
            if (result.reason !== 'error') {
              d.noPresence = true;
              if (result.reason === 'scope') {
                this.event(a, {
                  kind: 'presence.unavailable',
                  destinationId: destId,
                  platform: d.platform,
                  detail: result.message ?? 'reconnect the account to allow reading the chatters list',
                });
              }
            } else {
              this.o.log.debug({ destinationId: destId, error: result.message }, 'reports: presence sample failed');
            }
            continue;
          }
          const users = byPlatform.get(d.platform) ?? new Map<string, AudienceIdentity>();
          for (const u of result.users) {
            const ident: AudienceIdentity = {
              id: apiUserId(d.platform, u.id, u.name),
              platform: d.platform,
              platformUserId: u.id || null,
              displayName: u.name || u.login || u.id,
              login: u.login,
            };
            users.set(ident.id, ident);
          }
          byPlatform.set(d.platform, users);
        }
        const nowMs = this.now();
        const ts = new Date(nowMs).toISOString();
        for (const [platform, users] of byPlatform) {
          const prev = a.presencePrev.get(platform);
          const gapSec = prev ? Math.min((nowMs - prev.ts) / 1000, PRESENCE_MAX_CREDIT_SEC) : 0;
          const rows = [...users.values()].map((user) => ({ user, creditSec: prev?.users.has(user.id) ? gapSec : 0 }));
          this.write(() => this.o.store.audiencePresence(a.id, platform, ts, rows));
          this.markAudience(a);
          a.presencePrev.set(platform, { ts: nowMs, users: new Set(users.keys()) });
        }
      }
      this.drain();
    } finally {
      this.presenceRunning = false;
    }
  }

  /**
   * Delete what is older than the retention setting: RETENTION_BATCH streams per transaction (no
   * long lock), for at most RETENTION_SLICE_MS at a time; the rest continues on the next turns.
   */
  retention(): void {
    if (this.retentionTimer) clearImmediate(this.retentionTimer);
    this.retentionTimer = null;
    const days = this.o.settings().retentionDays;
    if (!days) return;
    const cutoff = new Date(this.now() - days * 86_400_000).toISOString();
    const total = { sessions: 0, users: 0 };
    const step = (): void => {
      this.retentionTimer = null;
      const until = performance.now() + RETENTION_SLICE_MS;
      let done = false;
      this.guard('retention', () => {
        while (!done && performance.now() < until) {
          const r = this.o.store.purgeBefore(cutoff, RETENTION_BATCH);
          total.sessions += r.sessions;
          total.users += r.users;
          done = r.done;
        }
      });
      if (!done && !this.closed) {
        this.retentionTimer = setImmediate(step);
        return;
      }
      if (total.sessions > 0 || total.users > 0) this.o.log.info({ ...total, days }, 'reports: deleted data older than the retention setting');
    };
    step();
  }

  // ---------------------------------------------------------------- events

  private onSession(s: SessionState): void {
    const profileId = s.profileId ?? DEFAULT_PROFILE;
    let a = this.active.get(profileId);
    const running = s.sessionId !== null && s.status !== 'offline';
    if (a && (!running || a.id !== s.sessionId)) {
      this.end(a, this.iso());
      a = undefined;
    }
    if (!running || !s.sessionId) return;
    if (!a) {
      if (!this.cfg.recording) return;
      a = this.begin(profileId, s);
    }
    if (s.title !== a.title) {
      a.title = s.title;
      const ts = this.iso();
      const id = a.id;
      const title = s.title;
      this.write(() => this.o.store.addTitle(id, ts, title));
      this.event(a, { kind: 'title', destinationId: null, platform: null, detail: s.title }, ts);
    }
    for (const f of s.feeds) this.onFeed({ ...f, profileId });
    for (const d of s.destinations) this.onDestination({ ...d, profileId });
  }

  private begin(profileId: string, s: SessionState): Active {
    const startedAt = s.startedAt ?? this.iso();
    const audience = this.cfg.audience;
    const a: Active = {
      id: s.sessionId as string,
      profileId,
      title: s.title,
      testMode: s.testMode === true,
      audienceMarked: false,
      dests: new Map(),
      chat: new Map(),
      feeds: new Map(),
      presencePrev: new Map(),
      audience: new Map(),
    };
    const title = s.title;
    this.write(() => {
      this.o.store.startSession({ id: a.id, profileId, startedAt, testMode: a.testMode, audience: false });
      this.o.store.addTitle(a.id, startedAt, title);
    });
    this.event(a, { kind: 'session.start', destinationId: null, platform: null, detail: a.testMode ? 'test mode' : null }, startedAt);
    if (audience) this.markAudience(a);
    this.active.set(profileId, a);
    this.o.log.info({ sessionId: a.id, profileId }, 'reports: recording this session');
    return a;
  }

  private end(a: Active, ts: string): void {
    this.active.delete(a.profileId);
    this.flush(a);
    for (const [id, d] of a.dests) {
      if (d.phase === 'live') this.event(a, { kind: 'destination.offline', destinationId: id, platform: d.platform, detail: 'session ended' }, ts);
      this.write(() => this.o.store.addViewerSample(a.id, id, ts, null));
    }
    for (const [feed, f] of a.feeds) {
      if (f.state.online) this.event(a, { kind: 'feed.offline', destinationId: null, platform: null, detail: feed }, ts);
    }
    this.event(a, { kind: 'session.end', destinationId: null, platform: null, detail: null }, ts);
    this.write(() => this.o.store.endSession(a.id, ts));
  }

  private onDestination(d: DestinationState): void {
    const a = this.active.get(d.profileId ?? DEFAULT_PROFILE);
    if (!a) return;
    let t = a.dests.get(d.destinationId);
    const viewers = viewerValue(d.viewers);
    if (!t) {
      if (d.phase === 'idle' || d.phase === 'disabled') return;
      const dest = this.o.destination(d.destinationId);
      if (!dest) return;
      const dual = dest.platform === 'twitch' && typeof dest.options.dualFormat === 'string' ? dest.options.dualFormat : dest.platform === 'twitch' ? 'off' : null;
      const row = { sessionId: a.id, destinationId: dest.id, platform: dest.platform, name: dest.name, feed: dest.feed, dualFormat: dual };
      this.write(() => this.o.store.upsertDestination(row));
      // Recoveries count per session (the orchestrator resets them), so the baseline is 0.
      t = { platform: dest.platform, phase: 'idle', viewers: null, recoveries: 0, blocked: null, noPresence: false };
      a.dests.set(d.destinationId, t);
    }
    const ts = this.iso();
    const id = d.destinationId;
    const base = { destinationId: id, platform: t.platform };
    if (d.phase !== t.phase) {
      const wasLive = t.phase === 'live';
      if (d.phase === 'live') {
        this.write(() => this.o.store.openLive(a.id, id, ts));
        this.event(a, { ...base, kind: 'destination.live', detail: null }, ts);
      } else if (wasLive) {
        this.write(() => this.o.store.closeLive(a.id, id, ts));
        if (d.phase !== 'retrying' && d.phase !== 'recovering' && d.phase !== 'error') {
          this.event(a, { ...base, kind: 'destination.offline', detail: d.message }, ts);
        }
      }
      if (d.phase === 'retrying') this.event(a, { ...base, kind: 'destination.retrying', detail: d.message }, ts);
      if (d.phase === 'error') this.event(a, { ...base, kind: 'destination.error', detail: d.message }, ts);
      t.phase = d.phase;
    }
    // A feed this destination can't send (0.2.40 codec guard, DestinationState.blocked).
    const b = d.blocked;
    const blocked = b && typeof b.reason === 'string' ? `${b.reason}${typeof b.codec === 'string' ? ` (${b.codec})` : ''}` : null;
    if (blocked !== t.blocked) {
      if (blocked) this.event(a, { ...base, kind: 'destination.blocked', detail: d.message ?? blocked }, ts);
      t.blocked = blocked;
    }
    const recoveries = d.recoveries ?? 0;
    if (recoveries > t.recoveries) {
      this.event(a, { ...base, kind: 'destination.recovery', detail: d.lastRecovery?.reason ?? null }, ts);
    }
    t.recoveries = Math.max(t.recoveries, recoveries);
    if (viewers !== t.viewers) {
      t.viewers = viewers;
      this.write(() => this.o.store.addViewerSample(a.id, id, ts, viewers));
    }
  }

  private onFeed(f: FeedState): void {
    const a = this.active.get(f.profileId ?? DEFAULT_PROFILE);
    if (!a) return;
    const nowMs = this.now();
    const minute = minuteOf(nowMs);
    const acc = a.feeds.get(f.feed);
    if (acc && acc.state.online !== f.online) {
      this.event(a, { kind: f.online ? 'feed.online' : 'feed.offline', destinationId: null, platform: null, detail: f.feed });
    } else if (!acc && f.online) {
      this.event(a, { kind: 'feed.online', destinationId: null, platform: null, detail: f.feed });
    }
    const next: FeedAcc = acc && acc.minute === minute ? acc : { state: f, minute, bitrateSum: 0, bitrateCount: 0 };
    if (acc && acc.minute !== minute) this.writeFeed(a, acc);
    next.state = f;
    if (f.online && typeof f.bitrateKbps === 'number' && Number.isFinite(f.bitrateKbps)) {
      next.bitrateSum += f.bitrateKbps;
      next.bitrateCount++;
    }
    a.feeds.set(f.feed, next);
  }

  private onChat(msg: ChatMessage): void {
    const a = this.active.get(msg.profileId ?? DEFAULT_PROFILE);
    if (!a) return;
    const nowMs = this.now();
    const minute = minuteOf(nowMs);
    let acc = a.chat.get(msg.platform);
    if (!acc) {
      acc = { minute, delta: emptyDelta(), minuteUniques: new Set(), sessionUniques: new Set(), totals: { ...emptyDelta(), anonymousJoins: 0 } };
      a.chat.set(msg.platform, acc);
    } else if (acc.minute !== minute) {
      this.flushChat(a, msg.platform, acc);
      acc.minute = minute;
      acc.minuteUniques = new Set();
    }
    const isMessage = msg.kind === 'message';
    const isJoin = msg.kind === 'event' && msg.join === true;
    const d: ChatDelta = { messages: isMessage ? 1 : 0, events: !isMessage && !isJoin ? 1 : 0, joins: isJoin ? 1 : 0 };
    acc.delta.messages += d.messages;
    acc.delta.events += d.events;
    acc.delta.joins += d.joins;
    acc.totals.messages += d.messages;
    acc.totals.events += d.events;
    acc.totals.joins += d.joins;
    if (isJoin) acc.totals.anonymousJoins += othersCount(msg);
    const ident = audienceIdentity(msg);
    if (ident && isMessage) {
      acc.minuteUniques.add(ident.id);
      acc.sessionUniques.add(ident.id);
    }
    if (ident && this.cfg.audience) {
      const ts = new Date(nowMs).toISOString();
      const u = a.audience.get(ident.id);
      if (!u) {
        a.audience.set(ident.id, { user: ident, ...d, firstSeenAt: ts, lastSeenAt: ts, firstMessageAt: isMessage ? ts : null, lastMessageAt: isMessage ? ts : null });
      } else {
        u.user = ident;
        u.messages += d.messages;
        u.events += d.events;
        u.joins += d.joins;
        u.lastSeenAt = ts;
        if (isMessage) {
          u.firstMessageAt ??= ts;
          u.lastMessageAt = ts;
        }
      }
      this.markAudience(a);
    }
  }

  // ---------------------------------------------------------------- writes

  private flush(a: Active): void {
    for (const [platform, acc] of a.chat) this.flushChat(a, platform, acc);
    if (a.audience.size > 0) {
      const rows = [...a.audience.values()];
      a.audience.clear();
      this.write(() => this.o.store.addAudience(a.id, rows));
    }
    for (const acc of a.feeds.values()) this.writeFeed(a, acc);
    // A new minute starts the averages over (writeFeed of the next tick writes the current minute).
    const minute = minuteOf(this.now());
    for (const [feed, acc] of a.feeds) {
      if (acc.minute !== minute) a.feeds.set(feed, { state: acc.state, minute, bitrateSum: 0, bitrateCount: 0 });
    }
  }

  private flushChat(a: Active, platform: PlatformId, acc: ChatAcc): void {
    const d = acc.delta;
    const t = acc.totals;
    if (d.messages + d.events + d.joins > 0 || acc.minuteUniques.size > 0) {
      const minute = acc.minute;
      const unique = acc.minuteUniques.size;
      this.write(() => this.o.store.addChatMinute(a.id, platform, minute, d, unique));
    }
    if (t.messages + t.events + t.joins + t.anonymousJoins > 0 || acc.sessionUniques.size > 0) {
      const unique = acc.sessionUniques.size;
      this.write(() => this.o.store.addChatTotals(a.id, platform, t, unique));
    }
    acc.delta = emptyDelta();
    acc.totals = { ...emptyDelta(), anonymousJoins: 0 };
  }

  private writeFeed(a: Active, acc: FeedAcc): void {
    const st = acc.state;
    const v = st.online ? st.video : null;
    const row = {
      minute: acc.minute,
      feed: st.feed,
      online: st.online,
      codec: v?.codec ?? null,
      width: v?.width ?? null,
      height: v?.height ?? null,
      fps: v?.fps ?? null,
      bitrateKbps: st.online ? (acc.bitrateCount > 0 ? Math.round((acc.bitrateSum / acc.bitrateCount) * 10) / 10 : viewerValue(st.bitrateKbps)) : null,
      keyframeSec: v?.keyframeSec ?? null,
    };
    this.write(() => this.o.store.putFeedMinute(a.id, row));
  }

  private markAudience(a: Active): void {
    if (a.audienceMarked) return;
    a.audienceMarked = true;
    this.write(() => this.o.store.markAudience(a.id));
  }

  private event(a: Active, e: Omit<ReportEvent, 'ts'>, ts = this.iso()): void {
    const row: ReportEvent = { ...e, detail: cleanDetail(e.kind, e.detail), ts };
    this.write(() => this.o.store.addEvent(a.id, row));
  }

  /** Queue a write; the queue is written after this event-loop turn (or by drain()/tick()). */
  private write(fn: () => void): void {
    this.queue.push(fn);
    if (this.drainTimer || this.closed) return;
    this.drainTimer = setImmediate(() => {
      this.drainTimer = null;
      this.drain();
    });
    this.drainTimer.unref?.();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.o.log.warn({ what, error: err instanceof Error ? err.message : String(err) }, 'reports: recording failed (streaming is not affected)');
    }
  }
}

export function reportSettingsFrom(raw: unknown): ReportSettings {
  const r = raw && typeof raw === 'object' ? (raw as Partial<ReportSettings>) : {};
  // 0 (keep everything) only when chosen; nothing stored (or anything else) is the default.
  const retention = r.retentionDays === 0 || r.retentionDays === 90 || r.retentionDays === 365 ? r.retentionDays : DEFAULT_REPORT_SETTINGS.retentionDays;
  return {
    recording: typeof r.recording === 'boolean' ? r.recording : DEFAULT_REPORT_SETTINGS.recording,
    audience: typeof r.audience === 'boolean' ? r.audience : DEFAULT_REPORT_SETTINGS.audience,
    retentionDays: retention,
  };
}
