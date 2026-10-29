// Shared fakes + harness for the orchestrator tests (excluded from the build by tsconfig.json).

import pino from 'pino';
import { vi, type Mock } from 'vitest';
import type { AppSettings } from '../../../shared/api.js';
import {
  DEFAULT_PROFILE_ID,
  type Account,
  type ChatMessage,
  type Destination,
  type DestinationPhase,
  type DestinationState,
  type Feed,
  type FeedState,
  type PlatformId,
  type PlatformInfo,
  type Profile,
  type SessionState,
} from '../../../shared/types.js';
import { EventBus, type PushEvent, type PushStatus } from '../events.js';
import type { ChatSourceItem, DriverContext, PlatformDriver, PreparedLive, PushPlan } from '../platforms/types.js';
import type {
  AppServices,
  BrowserManager,
  ChatHub,
  MediaServer,
  Orchestrator,
  OrchestratorRegistry,
  PushSupervisor,
  Repos,
  ScopedSecrets,
} from '../services.js';
import type { OrchestratorTimings } from './orchestrator.js';
import { createOrchestratorRegistry } from './registry.js';

export const PLAN: PushPlan = { url: 'rtmp://ingest.example.com/app/secret-key', mode: 'copy', feeds: ['landscape'] };
export const STATS = { bitrateKbps: 6000, fps: 60, speed: 1, uptimeSec: 4 };

/** Drains pending microtasks/immediates (setImmediate stays real under our fake timers). */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}

export async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

export function offlineFeed(feed: Feed, profileId: string = DEFAULT_PROFILE_ID): FeedState {
  return { profileId, feed, online: false, since: null, video: null, audio: null, bitrateKbps: null };
}

export function profile(id: string, name: string, over: Partial<Profile> = {}): Profile {
  return {
    id,
    name,
    slug: id === DEFAULT_PROFILE_ID ? 'main' : id,
    color: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

export const DEFAULT_PROFILE: Profile = profile(DEFAULT_PROFILE_ID, 'Main');

/** OBS feeds of every profile (FeedState.profileId set, like the real media server). */
export class FakeMedia {
  private readonly states = new Map<string, FeedState>();
  constructor(private readonly bus: EventBus) {}
  feeds(profileId: string = DEFAULT_PROFILE_ID): FeedState[] {
    return (['landscape', 'vertical'] as const).map((f) => this.feed(profileId, f));
  }
  feed(profileId: string, f: Feed): FeedState {
    return this.states.get(`${profileId}/${f}`) ?? offlineFeed(f, profileId);
  }
  /** Change state without emitting (initial conditions). */
  preset(f: Feed, online: boolean, profileId: string = DEFAULT_PROFILE_ID): void {
    this.states.set(`${profileId}/${f}`, { ...offlineFeed(f, profileId), online, since: online ? new Date().toISOString() : null });
  }
  set(f: Feed, online: boolean, bitrateKbps: number | null = null, profileId: string = DEFAULT_PROFILE_ID): void {
    const s: FeedState = { ...offlineFeed(f, profileId), online, since: online ? new Date().toISOString() : null, bitrateKbps };
    this.states.set(`${profileId}/${f}`, s);
    this.bus.emit('feed', s);
  }
}

export class FakePushes implements PushSupervisor {
  starts: { id: string; plan: PushPlan }[] = [];
  stops: string[] = [];
  private readonly active = new Set<string>();
  constructor(private readonly bus: EventBus) {}
  start(id: string, plan: PushPlan): void {
    this.starts.push({ id, plan });
    this.active.add(id);
    this.emit(id, 'starting');
  }
  async stop(id: string): Promise<void> {
    this.stops.push(id);
    if (this.active.delete(id)) this.emit(id, 'stopped');
  }
  async stopAll(): Promise<void> {
    for (const id of [...this.active]) await this.stop(id);
  }
  isRunning(id: string): boolean {
    return this.active.has(id);
  }
  emit(id: string, status: PushStatus, extra: Partial<PushEvent> = {}): void {
    this.bus.emit('push', { id, status, message: null, stats: null, attempt: 0, ...extra });
  }
  running(id: string): void {
    this.emit(id, 'running', { stats: STATS });
  }
}

export class FakeChat implements ChatHub {
  attaches: { id: string; platform: PlatformId; signal: AbortSignal; profileId: string | undefined }[] = [];
  attach(
    destinationId: string,
    platform: PlatformId,
    _source: (signal: AbortSignal) => AsyncIterable<ChatSourceItem>,
    signal: AbortSignal,
    profileId?: string,
  ): void {
    this.attaches.push({ id: destinationId, platform, signal, profileId });
  }
  post(): void {}
  recent(): ChatMessage[] {
    return [];
  }
  async overlayToken(): Promise<string> {
    return 't';
  }
  async rotateOverlayToken(): Promise<string> {
    return 't';
  }
  async profileForOverlayToken(): Promise<string | null> {
    return null;
  }
}

export function platformInfo(id: PlatformId, over: Partial<PlatformInfo> = {}): PlatformInfo {
  return {
    id,
    name: id,
    feeds: ['landscape', 'vertical'],
    defaultFeed: 'landscape',
    connectMethod: 'none',
    accountFields: [],
    destinationFields: [],
    developerApp: null,
    titleSupport: 'api',
    chatSupport: 'none',
    keyPerSession: false,
    experimental: false,
    ...over,
  };
}

export type DriverImpl = Omit<PlatformDriver, 'info'>;

export function driver(id: PlatformId, impl: DriverImpl, info: Partial<PlatformInfo> = {}): PlatformDriver {
  return { info: platformInfo(id, info), ...impl };
}

export function dest(id: string, over: Partial<Destination> = {}): Destination {
  return {
    id,
    platform: 'custom',
    accountId: null,
    name: id.toUpperCase(),
    feed: 'landscape',
    enabled: true,
    options: {},
    ingestUrl: 'rtmp://ingest.example.com/app',
    hasStreamKey: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

export type EndMock = Mock<() => Promise<void>>;

export function prepared(over: Omit<Partial<PreparedLive>, 'end'> & { end?: EndMock } = {}): PreparedLive & { end: EndMock } {
  return { push: PLAN, watchUrl: 'https://watch.example.com/me', ...over, end: over.end ?? vi.fn(async () => {}) };
}

export interface HarnessOptions {
  /** Destinations without a profileId belong to the default profile. */
  dests: Destination[];
  drivers: PlatformDriver[];
  settings?: Record<string, unknown>;
  graceSec?: number;
  accounts?: Account[];
  timings?: Partial<OrchestratorTimings>;
  /** Profiles besides the default one ("Main"). */
  profiles?: Profile[];
}

export type Harness = ReturnType<typeof harness>;

const inProfile = (item: { profileId?: string }, profileId: string | undefined): boolean =>
  profileId === undefined || (item.profileId ?? DEFAULT_PROFILE_ID) === profileId;

export function harness(opts: HarnessOptions) {
  const bus = new EventBus();
  const media = new FakeMedia(bus);
  const pushes = new FakePushes(bus);
  const chat = new FakeChat();
  const dests = new Map(opts.dests.map((d) => [d.id, d]));
  const accounts = new Map((opts.accounts ?? []).map((a) => [a.id, a]));
  const profiles = new Map([DEFAULT_PROFILE, ...(opts.profiles ?? [])].map((p) => [p.id, p]));
  const settings = new Map<string, unknown>(Object.entries(opts.settings ?? {}));
  const secrets = new Map<string, string>();
  const drivers = new Map(opts.drivers.map((d) => [d.info.id, d]));
  const contexts: DriverContext[] = [];
  const log = pino({ level: 'silent' });

  const scoped = (scope: string): ScopedSecrets => ({
    get: async (k) => secrets.get(`${scope}/${k}`) ?? null,
    set: async (k, v) => void secrets.set(`${scope}/${k}`, v),
    delete: async (k) => void secrets.delete(`${scope}/${k}`),
    getJson: async <T>(k: string) => {
      const v = secrets.get(`${scope}/${k}`);
      return v ? (JSON.parse(v) as T) : null;
    },
    setJson: async (k, v) => void secrets.set(`${scope}/${k}`, JSON.stringify(v)),
  });

  const repos = {
    profiles: {
      list: () => [...profiles.values()],
      get: (id: string) => profiles.get(id) ?? null,
    },
    destinations: {
      list: (profileId?: string) => [...dests.values()].filter((d) => inProfile(d, profileId)),
      get: (id: string) => dests.get(id) ?? null,
    },
    accounts: {
      list: (profileId?: string) => [...accounts.values()].filter((a) => inProfile(a, profileId)),
      get: (id: string) => accounts.get(id) ?? null,
    },
    settings: {
      get: <T>(k: string, fallback: T): T => (settings.has(k) ? (settings.get(k) as T) : fallback),
      set: (k: string, v: unknown) => void settings.set(k, v),
      delete: (k: string) => void settings.delete(k),
    },
    secrets: { scoped, deleteScope: () => {} },
    audit: { log: () => {}, list: () => [] },
  } as unknown as Repos;

  const appSettings = (): AppSettings => ({
    publicBaseUrl: '',
    ingestHost: '',
    disconnectGraceSec: opts.graceSec ?? 15,
  });

  const services = {
    log,
    bus,
    repos,
    media: media as unknown as MediaServer,
    pushes,
    chat,
    browser: {} as BrowserManager,
    platforms: {
      get: (id: PlatformId) => {
        const d = drivers.get(id);
        if (!d) throw new Error(`Unknown platform: ${id}`);
        return d;
      },
      all: () => [...drivers.values()],
    },
    appSettings,
    publicBaseUrl: () => 'https://example.test',
    driverContext: async ({ accountId, destinationId, signal }) => {
      const ctx: DriverContext = {
        log,
        accountSecrets: accountId ? scoped(`account:${accountId}`) : null,
        destinationSecrets: destinationId ? scoped(`destination:${destinationId}`) : null,
        app: null,
        browser: {} as BrowserManager,
        publicBaseUrl: 'https://example.test',
        signal: signal ?? new AbortController().signal,
        updateAccount: async () => {},
      };
      contexts.push(ctx);
      return ctx;
    },
  } as Partial<AppServices> as AppServices;

  const registry: OrchestratorRegistry = createOrchestratorRegistry(services, opts.timings ? { timings: opts.timings } : {});
  services.orchestrators = registry;
  /** The default profile's orchestrator (the only one most tests use). */
  const orch: Orchestrator = registry.get(DEFAULT_PROFILE_ID);

  const destEvents: DestinationState[] = [];
  const sessionEvents: SessionState[] = [];
  const notices: { level: string; message: string; profileId?: string }[] = [];
  bus.on('destination', (s) => destEvents.push(s));
  bus.on('session', (s) => sessionEvents.push(s));
  bus.on('notice', (n) => notices.push(n));

  /** A destination's state, looked up in its own profile's orchestrator. */
  const destState = (id: string): DestinationState => {
    const profileId = dests.get(id)?.profileId ?? DEFAULT_PROFILE_ID;
    const s = registry
      .get(profileId)
      .state()
      .destinations.find((d) => d.destinationId === id);
    if (!s) throw new Error(`no state for ${id}`);
    return s;
  };

  return {
    bus,
    media,
    pushes,
    chat,
    dests,
    profiles,
    settings,
    secrets,
    contexts,
    services,
    registry,
    orch,
    destEvents,
    sessionEvents,
    notices,
    destState,
    phase: (id: string): DestinationPhase => destState(id).phase,
    /** Phase transitions seen in 'destination' events for `id`. */
    history: (id: string): DestinationPhase[] => {
      const out: DestinationPhase[] = [];
      for (const e of destEvents) if (e.destinationId === id && out[out.length - 1] !== e.phase) out.push(e.phase);
      return out;
    },
  };
}

/** Starts a session with landscape online and every destination pushing + running. */
export async function goLive(h: Harness, ids: string[]): Promise<void> {
  await h.orch.init();
  h.media.set('landscape', true);
  await flush();
  for (const id of ids) h.pushes.running(id);
  await flush();
}
