// Fixtures for the external API tests (excluded from the build).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBlobStore, type BlobLimits } from '../storage/blob-store.js';
import crypto from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import {
  DEFAULT_PROFILE_ID,
  type ApiScope,
  type ConnectedApp,
  type Destination,
  type DestinationPhase,
  type DestinationState,
  type Feed,
  type PlatformId,
  type PlatformInfo,
  type Profile,
  type ProfileSummary,
  type SessionState,
} from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import { openDatabase } from '../db/database.js';
import { createRepos } from '../db/repos.js';
import { EventBus } from '../events.js';
import authPlugin from '../http/auth-plugin.js';
import { sendError } from '../http/guards.js';
import assetRoutes from '../http/routes/assets.js';
import systemRoutes from '../http/routes/system.js';
import tokenRoutes from '../http/routes/tokens.js';
import { createSecretBox } from '../security/secretbox.js';
import type { AppServices, ConnectedAppsRepo, MediaServer, Orchestrator, OrchestratorRegistry, ProfilesRepo, Repos, TlsManager } from '../services.js';
import dockRoutes from './dock.js';
import { EventHub, eventHubDeps } from './event-hub.js';
import { createAppRegistry, type AppRegistryHandle } from './hub.js';
import { lanHttpPlugin } from './lan.js';
import { createPairingService, type PairingServiceHandle } from './pairing.js';
import { isDown } from './status.js';
import type { PreviewService } from './previews.js';
import v1Routes, { API_PREFIX } from './v1.js';

export function dest(id: string, over: Partial<Destination> = {}): Destination {
  return {
    id,
    platform: 'twitch',
    accountId: null,
    name: id.toUpperCase(),
    feed: 'landscape',
    enabled: true,
    options: {},
    ingestUrl: null,
    hasStreamKey: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

export function dstate(id: string, phase: DestinationPhase, over: Partial<DestinationState> = {}): DestinationState {
  return {
    destinationId: id,
    phase,
    message: null,
    stats: null,
    watchUrl: null,
    retries: 0,
    since: '2026-10-17T03:00:09.000Z',
    recoveries: 0,
    lastRecovery: null,
    ...over,
  };
}

export function session(over: Partial<SessionState> = {}): SessionState {
  return {
    status: 'live',
    sessionId: 's1',
    startedAt: '2026-10-17T03:00:04.000Z',
    title: 'DPRTMNT Saturday',
    autoGoLive: true,
    testMode: false,
    feeds: [
      { feed: 'landscape', online: true, since: '2026-10-17T02:59:58Z', video: { codec: 'H264', width: 1920, height: 1080 }, audio: null, bitrateKbps: 6012 },
      { feed: 'vertical', online: false, since: null, video: null, audio: null, bitrateKbps: null },
    ],
    destinations: [],
    ...over,
  };
}

export function offline(profileId?: string): SessionState {
  return session({ status: 'offline', sessionId: null, startedAt: null, title: '', ...(profileId ? { profileId } : {}) });
}

export const silentLog = pino({ level: 'silent' });

/** Platforms with/without test mode, by id. */
export function platformInfo(platform: PlatformId): PlatformInfo {
  return { id: platform, name: platform[0]!.toUpperCase() + platform.slice(1), testMode: { supported: platform !== 'kick', description: '' } } as PlatformInfo;
}

// ---------------------------------------------------------------------------
// In-memory repos for unit tests that don't need SQLite (the hub registry).
// ---------------------------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString();

export function memoryProfilesRepo(now: () => number = Date.now): ProfilesRepo {
  const t0 = iso(now());
  const rows: Profile[] = [{ id: DEFAULT_PROFILE_ID, name: 'Main', slug: 'main', color: null, createdAt: t0, updatedAt: t0 }];
  const copy = (p: Profile | undefined) => (p ? { ...p } : null);
  const slugFor = (name: string) => {
    let base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'profile';
    if (['landscape', 'vertical', 'main', 'default'].includes(base)) base = `${base}-profile`;
    let slug = base;
    for (let i = 2; rows.some((r) => r.slug === slug); i++) slug = `${base}-${i}`;
    return slug;
  };
  return {
    list: () => rows.map((r) => ({ ...r })),
    get: (id) => copy(rows.find((r) => r.id === id)),
    getBySlug: (slug) => copy(rows.find((r) => r.slug === slug)),
    create: ({ name, color }) => {
      const ts = iso(now());
      const p: Profile = { id: crypto.randomUUID(), name, slug: slugFor(name), color, createdAt: ts, updatedAt: ts };
      rows.push(p);
      return { ...p };
    },
    update: (id, patch) => {
      const p = rows.find((r) => r.id === id);
      if (!p) throw new Error('profile not found');
      Object.assign(p, patch, { updatedAt: iso(now()) });
      return { ...p };
    },
    delete: (id) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    },
  };
}

export function memoryConnectedAppsRepo(now: () => number = Date.now): ConnectedAppsRepo {
  const rows = new Map<string, ConnectedApp>();
  const copy = (a: ConnectedApp | undefined) => (a ? (structuredClone(a) as ConnectedApp) : null);
  return {
    list: () => [...rows.values()].map((a) => copy(a)!),
    get: (id) => copy(rows.get(id)),
    upsert: (app) => {
      const ts = iso(now());
      const row: ConnectedApp = { ...structuredClone(app), registeredAt: app.registeredAt ?? ts, lastSeenAt: ts, online: false };
      rows.set(app.id, row);
      return copy(row)!;
    },
    touch: (id) => {
      const a = rows.get(id);
      if (a) a.lastSeenAt = iso(now());
    },
    delete: (id) => {
      rows.delete(id);
    },
    deleteByToken: (tokenId) => {
      for (const [id, a] of rows) if (a.tokenId === tokenId) rows.delete(id);
    },
  };
}

/** Orchestrator registry stand-in: one state per profile (`states`), summaries computed like the engine's. */
export function fakeOrchestrators(repos: Repos, stateOf: (profileId: string) => SessionState): OrchestratorRegistry {
  const unknown = () => Object.assign(new Error('Unknown profile'), { statusCode: 404, code: 'unknown_profile' });
  const orchestrator = (profileId: string) => ({ profileId, state: () => stateOf(profileId) }) as unknown as Orchestrator;
  return {
    get(profileId) {
      if (!repos.profiles.get(profileId)) throw unknown();
      return orchestrator(profileId);
    },
    all: () => repos.profiles.list().map((p) => orchestrator(p.id)),
    add: async () => {},
    remove: async () => {},
    init: async () => {},
    shutdown: async () => {},
    summaries(): ProfileSummary[] {
      return repos.profiles.list().map((p) => {
        const s = stateOf(p.id);
        const byId = new Map(s.destinations.map((st) => [st.destinationId, st]));
        const enabled = repos.destinations.list(p.id).filter((d) => d.enabled);
        let live = 0;
        let down = 0;
        for (const d of enabled) {
          const st = byId.get(d.id);
          const phase = st?.phase ?? 'idle';
          if (phase === 'live') live++;
          if (isDown(s, d, phase, platformInfo(d.platform), st?.retries ?? 0)) down++;
        }
        return { ...p, status: s.status, startedAt: s.startedAt, testMode: s.testMode === true, destinations: enabled.length, live, down };
      });
    },
  };
}

export function fakeMedia(repos: Repos): MediaServer {
  const key = (profileId: string, feed: Feed) => `${feed === 'landscape' ? 'L' : 'V'}key${profileId.replace(/[^A-Za-z0-9]/g, '')}`;
  return {
    appName: 'live',
    async ingestKeys(profileId: string) {
      return { landscape: key(profileId, 'landscape'), vertical: key(profileId, 'vertical') };
    },
    async streamKeyField(profileId: string, feed: Feed) {
      if (profileId === DEFAULT_PROFILE_ID) return `${feed}?key=${key(profileId, feed)}`;
      const p = repos.profiles.get(profileId);
      if (!p) throw new Error('unknown profile');
      return `${p.slug}/${feed}?key=${key(profileId, feed)}`;
    },
  } as unknown as MediaServer;
}

export interface TestApi {
  app: FastifyInstance;
  services: AppServices;
  repos: Repos;
  bus: EventBus;
  hub: EventHub;
  apps: AppRegistryHandle;
  pairings: PairingServiceHandle;
  /** Mutable orchestrator state of the default profile (services.orchestrators.get('default').state()). */
  state: { current: SessionState };
  /** Session state of other profiles (offline when unset). */
  states: Map<string, SessionState>;
  /** The OBS host setting (Settings → OBS). */
  settings: { ingestHost: string };
  /** Every route registered under /api/v1 ("METHOD /path"). */
  routes: string[];
  token(scopes?: ApiScope[], name?: string, profileId?: string | null): string;
  /** Create a profile and announce it like the profiles route does. */
  addProfile(name: string, color?: string | null): Profile;
  close(): Promise<void>;
}

export async function createTestApi(
  opts: { tlsMode?: AppConfig['tlsMode']; heartbeatMs?: number; now?: () => number; previews?: PreviewService; blobLimits?: () => BlobLimits } = {},
): Promise<TestApi> {
  const now = opts.now ?? Date.now;
  const secretBox = createSecretBox(crypto.randomBytes(32));
  const db = openDatabase(':memory:');
  const repos = createRepos(db, secretBox);
  const bus = new EventBus();
  const state = { current: session({ status: 'offline', startedAt: null }) };
  const states = new Map<string, SessionState>();
  const settings = { ingestHost: '' };
  const stateOf = (profileId: string): SessionState => (profileId === DEFAULT_PROFILE_ID ? state.current : (states.get(profileId) ?? offline(profileId)));
  const config = { tlsMode: opts.tlsMode ?? 'self-signed', version: '9.9.9', webPort: 8443, httpPort: 8080, rtmpPort: 1936 } as AppConfig;
  const tls = {
    mode: config.tlsMode,
    status: () => ({ fingerprint256: 'AA:BB', mode: config.tlsMode }),
  } as unknown as TlsManager;
  const apps = createAppRegistry({ repos, bus, log: silentLog, now });
  const pairings = createPairingService({ repos, bus, log: silentLog, config, now });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctd-api-'));
  const blobStore = createBlobStore({ dataDir, repo: repos.blobs, ...(opts.blobLimits ? { limits: opts.blobLimits } : {}) });
  const services = {
    config,
    log: silentLog,
    bus,
    repos,
    secretBox,
    tls,
    blobStore,
    orchestrators: fakeOrchestrators(repos, stateOf),
    apps,
    pairings,
    media: fakeMedia(repos),
    platforms: { get: (p: PlatformId) => ({ info: platformInfo(p) }), all: () => [] },
    appSettings: () => ({ publicBaseUrl: '', ingestHost: settings.ingestHost, disconnectGraceSec: 15 }),
    publicBaseUrl: () => 'https://203.0.113.7',
  } as unknown as AppServices;

  const hub = new EventHub({ ...eventHubDeps(services), log: silentLog, platformInfo, ...(opts.now ? { now: opts.now } : {}) });

  const app = Fastify();
  const routes: string[] = [];
  app.addHook('onRoute', (r) => {
    if (!r.url.startsWith(API_PREFIX)) return;
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) routes.push(`${m} ${r.url}`);
  });
  app.setNotFoundHandler((_req, reply) => sendError(reply, 404, 'Not found', 'not_found'));
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.tlsMode === 'off' ? null : [],
      },
    },
    hsts: config.tlsMode === 'off' ? false : { maxAge: 15552000, includeSubDomains: false },
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(websocket);
  await app.register(lanHttpPlugin, { services });
  await app.register(authPlugin, { services });
  await app.register(tokenRoutes, { services });
  await app.register(assetRoutes, { services });
  await app.register(systemRoutes, { services });
  await app.register(v1Routes, {
    services,
    hub,
    prefix: API_PREFIX,
    ...(opts.heartbeatMs ? { heartbeatMs: opts.heartbeatMs } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.previews ? { previews: opts.previews } : {}),
  });
  await app.register(dockRoutes, { services });
  await app.ready();

  let closed = false;
  return {
    app,
    services,
    repos,
    bus,
    hub,
    apps,
    pairings,
    state,
    states,
    settings,
    routes,
    token(scopes = ['chat:read', 'status:read'], name = 'test', profileId = null) {
      return repos.apiTokens.create({ name, scopes, createdBy: 'admin', profileId }).secret;
    },
    addProfile(name, color = null) {
      const p = repos.profiles.create({ name, color });
      bus.emit('profiles-changed');
      return p;
    },
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      hub.close();
      apps.close();
      pairings.close();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
