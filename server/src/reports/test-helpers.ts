// Test rig for stream reports: an in-memory database with real repos, an event bus, a hand-driven
// clock and recorder (no timers). Synthetic names only.

import crypto from 'node:crypto';
import pino from 'pino';
import type { ChatMessage, DestinationPhase, DestinationState, Feed, FeedState, PlatformId, SessionState } from '../../../shared/types.js';
import { openDatabase, type Db } from '../db/database.js';
import { createRepos } from '../db/repos.js';
import { EventBus } from '../events.js';
import { createSecretBox } from '../security/secretbox.js';
import type { AppServices, Repos } from '../services.js';
import { createReportsService, type ReportsService } from './index.js';
import type { PresenceProvider } from './recorder.js';

export const T0 = Date.parse('2026-11-19T20:00:00.000Z');

export interface Rig {
  db: Db;
  bus: EventBus;
  repos: Repos;
  reports: ReportsService;
  clock: { now: number; advance(ms: number): void; set(ms: number): void };
  destination(platform: PlatformId, opts?: { feed?: Feed; name?: string; options?: Record<string, unknown> }): string;
  session(patch?: Partial<SessionState>): SessionState;
  startSession(id?: string, extra?: Partial<SessionState>): SessionState;
  stopSession(): void;
  dest(id: string, phase: DestinationPhase, extra?: Partial<DestinationState>): void;
  feed(feed: Feed, online: boolean, extra?: Partial<FeedState>): void;
  chat(platform: PlatformId, destinationId: string, author: { name: string; id?: string }, extra?: Partial<ChatMessage>): void;
}

export function createRig(opts: { presence?: PresenceProvider | null; db?: Db } = {}): Rig {
  const db = opts.db ?? openDatabase(':memory:');
  const repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
  const bus = new EventBus();
  const clock = {
    now: T0,
    advance(ms: number) {
      this.now += ms;
    },
    set(ms: number) {
      this.now = ms;
    },
  };
  const services = {
    bus,
    log: pino({ level: 'silent' }),
    repos,
    orchestrators: { all: () => [] },
    driverContext: async () => {
      throw new Error('no driver context in tests');
    },
  } as unknown as Pick<AppServices, 'bus' | 'log' | 'repos' | 'orchestrators' | 'driverContext'>;
  const reports = createReportsService(services, db, { presence: opts.presence ?? null, now: () => clock.now, timers: false });
  let current: SessionState = { profileId: 'default', status: 'offline', sessionId: null, startedAt: null, title: 'Test stream', autoGoLive: true, feeds: [], destinations: [] };
  let n = 0;
  const rig: Rig = {
    db,
    bus,
    repos,
    reports,
    clock,
    destination(platform, o = {}) {
      n++;
      return repos.destinations.create({
        profileId: 'default',
        platform,
        accountId: null,
        name: o.name ?? `${platform} ${n}`,
        feed: o.feed ?? 'landscape',
        enabled: true,
        options: o.options ?? {},
        ingestUrl: null,
      }).id;
    },
    session(patch = {}) {
      current = { ...current, ...patch };
      bus.emit('session', current);
      return current;
    },
    startSession(id = 'sess-1', extra = {}) {
      return rig.session({ status: 'live', sessionId: id, startedAt: new Date(clock.now).toISOString(), ...extra });
    },
    stopSession() {
      rig.session({ status: 'offline', sessionId: null, startedAt: null });
    },
    dest(id, phase, extra = {}) {
      bus.emit('destination', {
        destinationId: id,
        profileId: 'default',
        phase,
        message: null,
        stats: null,
        watchUrl: null,
        retries: 0,
        since: new Date(clock.now).toISOString(),
        recoveries: 0,
        lastRecovery: null,
        ...extra,
      });
    },
    feed(feed, online, extra = {}) {
      bus.emit('feed', {
        profileId: 'default',
        feed,
        online,
        since: online ? new Date(clock.now).toISOString() : null,
        video: online ? { codec: 'h264', width: 1920, height: 1080, fps: 60, keyframeSec: 2 } : null,
        audio: online ? { codec: 'aac' } : null,
        bitrateKbps: online ? 6000 : null,
        ...extra,
      });
    },
    chat(platform, destinationId, author, extra = {}) {
      n++;
      bus.emit('chat', {
        id: `m${n}`,
        platform,
        destinationId,
        profileId: 'default',
        author,
        text: 'hello',
        ts: new Date(clock.now).toISOString(),
        kind: 'message',
        ...extra,
      });
    },
  };
  reports.start();
  return rig;
}
