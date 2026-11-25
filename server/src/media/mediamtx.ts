// MediaServer: supervises MediaMTX (RTMP ingest for every profile's two OBS feeds), answers its
// auth requests, and turns its control API into 'feed' events.
//
// Profiles: the default profile keeps the pre-profiles paths (`live/landscape`, `live/vertical`)
// and keys (secret scope 'ingest'); every other profile publishes to `live/<slug>/<feed>` with
// its own keys (scope 'ingest:<profileId>'). MediaMTX accepts every `live/<slug>/<feed>` path through
// one regex path, and our auth hook only lets in slugs of existing profiles with their own keys,
// so adding or removing a profile never restarts MediaMTX (and never drops another profile's OBS).

import type { ChildProcess } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { DEFAULT_PROFILE_ID, FEEDS, type Feed, type FeedState } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import type { EventBus } from '../events.js';
import { profileSecretScope, type MediaMtxAuthRequest, type MediaServer, type Repos } from '../services.js';
import { startAuthServer, type AuthServer } from './auth-server.js';
import type { PullLinks } from './pull-links.js';
import {
  authorizeMediaRequest,
  FEED_KEY_NAMES,
  generateKey,
  INTERNAL_READER_KEY,
  isValidKey,
  type IngestAuthState,
  type ProfileIngestKeys,
} from './authorize.js';
import { ffprobePath, probeFeed } from './feed-probe.js';
import { FeedTracker, offlineFeedState, shouldEmitFeed, type FeedMeasurements, type MtxPath } from './feed-state.js';
import { createMediaMtxApi, type FetchFn } from './mediamtx-api.js';
import { buildMediaMtxConfig } from './mediamtx-config.js';
import type { GuestFeeds } from './guest-feeds.js';

/** What the auth hook needs of guest feed routing (media/guest-routes.ts). */
export interface RouteAuth {
  /** The publish key of the route holding this profile input right now, or null. */
  routeKey(profileId: string, feed: Feed): string | null;
  /** OBS was let in on this profile input with its own key. */
  obsPublished(profileId: string, feed: Feed): void;
}
import { DEFAULT_LIVE_MAX_VIEWERS } from './live-preview.js';
import { APP_NAME, feedPath, guestPath, INTERNAL_READER_USER, streamKeyPath, type IngestRoute } from './paths.js';
import { defaultSpawn, onLines, terminate, type SpawnFn } from './process-utils.js';
import { redactSecretsInText } from './redact.js';

export interface MediaServerDeps {
  spawn?: SpawnFn;
  fetch?: FetchFn;
  now?: () => number;
  pollIntervalMs?: number;
  /** How long start() waits for the control API to answer (0 = don't wait). */
  readyTimeoutMs?: number;
  /**
   * Measures a feed (frame rate, keyframe interval) from its read URL. Default: ffprobe next to
   * FFMPEG_BIN; null turns measuring off (tests that don't care).
   */
  probe?: ((readUrl: string) => Promise<FeedMeasurements>) | null;
  probeDelayMs?: number;
}

export interface MediaServerOptions {
  config: AppConfig;
  bus: EventBus;
  log: Logger;
  /** Profiles (which slugs exist) and encrypted secrets (each profile's OBS keys). */
  repos: Pick<Repos, 'secrets' | 'profiles'>;
  /** Guest feeds (docs/API.md §18): their auth, state and LL-HLS share this MediaMTX. Optional (tests). */
  guests?: GuestFeeds;
  /** Guest feed routing into profiles (media/guest-routes.ts): the auth hook asks it about route keys. */
  routeAuth?: RouteAuth;
  /** Pull links (media/pull-links.ts): read keys for OBS Media Source / VLC readers, and their count. */
  pull?: PullLinks;
}

const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 30_000;
const HEALTHY_AFTER_MS = 60_000;
const POLL_FAILURES_BEFORE_OFFLINE = 3;

/** Unknown profile id (404 `unknown_profile`, like OrchestratorRegistry.get). */
export class UnknownProfileError extends Error {
  readonly statusCode = 404;
  readonly code = 'unknown_profile';
  constructor() {
    super('Profile not found');
    this.name = 'UnknownProfileError';
  }
}

/** The default profile's OBS keys and paths can never be removed. */
export class DefaultProfileMediaError extends Error {
  readonly statusCode = 400;
  readonly code = 'default_profile';
  constructor() {
    super('The default profile cannot be removed');
    this.name = 'DefaultProfileMediaError';
  }
}

interface FeedSlot {
  feed: Feed;
  path: string;
  tracker: FeedTracker;
  emitted: { state: FeedState; at: number };
  /** The publish session (its `since`) already measured or being measured. */
  probedSince: string | null;
}

/** Wait after OBS connects before measuring (the encoder settles, the first keyframe arrives). */
const PROBE_DELAY_MS = 3_000;

interface ProfileIngest {
  profileId: string;
  /** null = the default profile (legacy paths). */
  slug: string | null;
  keys: ProfileIngestKeys | null;
  loading: Promise<ProfileIngestKeys> | null;
  feeds: Map<Feed, FeedSlot>;
}

export function createMediaServer({ config, bus, log, repos, guests, routeAuth, pull }: MediaServerOptions, deps: MediaServerDeps = {}): MediaServer {
  const spawn = deps.spawn ?? defaultSpawn;
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? 1_000;
  const readyTimeoutMs = deps.readyTimeoutMs ?? 5_000;
  // ffprobe ships next to ffmpeg (Docker image, `npm run setup-tools`); no FFMPEG_BIN, no measuring.
  const ffprobe = config.ffmpegBin ? ffprobePath(config.ffmpegBin) : null;
  const probe = deps.probe !== undefined ? deps.probe : ffprobe ? (url: string) => probeFeed(ffprobe, url) : null;
  const api = createMediaMtxApi(config.mediamtxApiPort, deps.fetch);
  const workDir = path.join(config.dataDir, 'mediamtx');
  const configPath = path.join(workDir, 'mediamtx.yml');
  const bin = config.mediamtxBin;
  // Live preview (docs/PREVIEW.md): loopback LL-HLS, unless it is turned off.
  // Guest feeds are read back the same way (their own viewer cap).
  const hlsWanted = (config.livePreviewMaxViewers ?? DEFAULT_LIVE_MAX_VIEWERS) > 0 || (guests !== undefined && guests.limits.maxViewers > 0);
  const hlsPort = config.mediamtxHlsPort && hlsWanted ? config.mediamtxHlsPort : null;
  const notFound = `MediaMTX not found at ${bin}; run \`npm run setup-tools\` (or set MEDIAMTX_BIN). Feeds stay offline.`;
  /** The internal reader password lives in the legacy 'ingest' scope (shared by every profile). */
  const readerScope = repos.secrets.scoped(profileSecretScope(DEFAULT_PROFILE_ID, 'ingest'));

  let readerPassword: string | null = null;
  let readerLoading: Promise<string> | null = null;
  let auth: AuthServer | null = null;
  let running = false;
  let proc: ChildProcess | null = null;
  let procStartedAt = 0;
  let restartAttempt = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let pollAbort = new AbortController();
  let pollFailures = 0;
  let lastError: string | null = null;

  /** Profiles whose paths are accepted, by id; non-default ones also by slug. */
  const profiles = new Map<string, ProfileIngest>();
  const bySlug = new Map<string, string>();
  /** Deleted profiles: never re-registered (e.g. by a late OBS reconnect before the row is gone). */
  const removed = new Set<string>();

  // ---- profiles ---------------------------------------------------------

  function register(profileId: string, slug: string | null): ProfileIngest {
    const existing = profiles.get(profileId);
    if (existing) return existing;
    const s = profileId === DEFAULT_PROFILE_ID ? null : slug;
    const entry: ProfileIngest = {
      profileId,
      slug: s,
      keys: null,
      loading: null,
      feeds: new Map(
        FEEDS.map((feed) => [
          feed,
          {
            feed,
            path: feedPath(feed, s),
            tracker: new FeedTracker(feed, profileId),
            emitted: { state: offlineFeedState(feed, profileId), at: 0 },
            probedSince: null,
          },
        ]),
      ),
    };
    profiles.set(profileId, entry);
    if (s) bySlug.set(s, profileId);
    return entry;
  }

  /** A known profile (registering it from the database if needed), else null. */
  function findProfile(profileId: string): ProfileIngest | null {
    const known = profiles.get(profileId);
    if (known) return known;
    if (profileId === DEFAULT_PROFILE_ID) return register(DEFAULT_PROFILE_ID, null);
    if (removed.has(profileId)) return null;
    const row = repos.profiles.get(profileId);
    return row ? register(row.id, row.slug) : null;
  }

  function requireProfile(profileId: string): ProfileIngest {
    const entry = findProfile(profileId);
    if (!entry) throw new UnknownProfileError();
    return entry;
  }

  // ---- keys -------------------------------------------------------------

  async function loadKeys(entry: ProfileIngest): Promise<ProfileIngestKeys> {
    const scope = repos.secrets.scoped(profileSecretScope(entry.profileId, 'ingest'));
    const out: Partial<ProfileIngestKeys> = {};
    for (const name of FEED_KEY_NAMES) {
      let value = await scope.get(name);
      if (!isValidKey(value)) {
        if (removed.has(entry.profileId)) throw new UnknownProfileError();
        value = generateKey();
        await scope.set(name, value);
        log.info({ profileId: entry.profileId, key: name }, 'Generated new ingest key');
      }
      out[name] = value;
    }
    return out as ProfileIngestKeys;
  }

  function ensureKeys(entry: ProfileIngest): Promise<ProfileIngestKeys> {
    if (entry.keys) return Promise.resolve(entry.keys);
    entry.loading ??= loadKeys(entry)
      .then((k) => {
        if (profiles.get(entry.profileId) === entry) entry.keys = k;
        return k;
      })
      .finally(() => {
        entry.loading = null;
      });
    return entry.loading;
  }

  async function loadReader(): Promise<string> {
    let value = await readerScope.get(INTERNAL_READER_KEY);
    if (!isValidKey(value)) {
      value = generateKey();
      await readerScope.set(INTERNAL_READER_KEY, value);
      log.info({ key: INTERNAL_READER_KEY }, 'Generated new ingest secret');
    }
    return value;
  }

  function ensureReader(): Promise<string> {
    if (readerPassword) return Promise.resolve(readerPassword);
    readerLoading ??= loadReader()
      .then((p) => (readerPassword = p))
      .finally(() => {
        readerLoading = null;
      });
    return readerLoading;
  }

  /** Load keys in the background (auth requests are synchronous); OBS retries and gets in. */
  function warmUp(entry: ProfileIngest): void {
    if (entry.keys || entry.loading) return;
    ensureKeys(entry).catch((err: unknown) =>
      log.error({ profileId: entry.profileId, err: err instanceof Error ? err.message : String(err) }, 'Could not load ingest keys'),
    );
  }

  const authState: IngestAuthState = {
    get readerPassword() {
      return readerPassword;
    },
    publishKey(route: IngestRoute): string | null {
      let entry: ProfileIngest | null;
      if (route.slug === null) {
        entry = findProfile(DEFAULT_PROFILE_ID);
      } else {
        const id = bySlug.get(route.slug);
        if (id !== undefined) {
          entry = profiles.get(id) ?? null;
        } else {
          // A profile created without profileAdded() (or not loaded yet): learn it, deny this time.
          const row = repos.profiles.getBySlug(route.slug);
          entry = row && row.id !== DEFAULT_PROFILE_ID && !removed.has(row.id) ? register(row.id, row.slug) : null;
        }
      }
      if (!entry) return null;
      if (!entry.keys) warmUp(entry);
      return entry.keys?.[route.feed] ?? null;
    },
    guestKey: (slot) => guests?.guestKey(slot) ?? null,
    guestExists: (slot) => guests?.guestExists(slot) ?? false,
    routeKey: (route) => {
      const id = profileIdOf(route);
      return id && routeAuth ? routeAuth.routeKey(id, route.feed) : null;
    },
    obsPublished: (route) => {
      const id = profileIdOf(route);
      if (id && routeAuth) routeAuth.obsPublished(id, route.feed);
    },
    pullKey: (p) => pull?.readKey(p) ?? null,
    pullAdmit: (p) => pull?.admit(p) ?? false,
  };

  /** The profile id of a feed path (null = unknown profile). */
  function profileIdOf(route: IngestRoute): string | null {
    if (route.slug === null) return DEFAULT_PROFILE_ID;
    const id = bySlug.get(route.slug);
    return id !== undefined && profiles.has(id) ? id : null;
  }

  // ---- feed state -------------------------------------------------------

  function publish(slot: FeedSlot, state: FeedState): void {
    const t = now();
    if (!shouldEmitFeed(slot.emitted.state, state, slot.emitted.at, t)) return;
    slot.emitted = { state, at: t };
    bus.emit('feed', { ...state });
  }

  function applyPaths(items: MtxPath[]): void {
    const t = now();
    const byName = new Map(items.map((p) => [p.name, p]));
    for (const entry of profiles.values()) {
      for (const slot of entry.feeds.values()) {
        const state = slot.tracker.update(byName.get(slot.path), t);
        publish(slot, state);
        if (state.online && state.since && state.video && slot.probedSince !== state.since) scheduleProbe(entry, slot, state.since);
      }
    }
    // Guest feeds: state only (no ffprobe, to keep their CPU cost at zero).
    guests?.apply(byName, t);
  }

  /** Measure frame rate and keyframe interval once per OBS connection (MediaMTX doesn't report them). */
  function scheduleProbe(entry: ProfileIngest, slot: FeedSlot, since: string): void {
    if (!probe) return;
    slot.probedSince = since;
    setTimeout(() => {
      if (!running || slot.tracker.current().since !== since || !readerPassword) return;
      probe(readUrlFor(entry, slot.feed)).then(
        (m) => {
          const state = slot.tracker.setMeasurements(since, m);
          publish(slot, state);
          log.info({ profileId: entry.profileId, feed: slot.feed, fps: m.fps, keyframeSec: m.keyframeSec }, 'feed measured');
        },
        (err: unknown) => log.warn({ profileId: entry.profileId, feed: slot.feed, error: err instanceof Error ? err.message : String(err) }, 'measuring the feed failed'),
      );
    }, deps.probeDelayMs ?? PROBE_DELAY_MS).unref?.();
  }

  function readUrlFor(entry: ProfileIngest, feed: Feed): string {
    if (!readerPassword) throw new Error('Media server not started');
    const pass = encodeURIComponent(readerPassword);
    return `rtmp://127.0.0.1:${config.rtmpPort}/${feedPath(feed, entry.slug)}?user=${INTERNAL_READER_USER}&pass=${pass}`;
  }

  function markOffline(entry: ProfileIngest): void {
    for (const slot of entry.feeds.values()) publish(slot, slot.tracker.reset());
  }

  function markAllOffline(): void {
    for (const entry of profiles.values()) markOffline(entry);
    guests?.resetAll();
    pull?.resetAll();
  }

  function hlsAuthorization(): string | null {
    if (hlsPort === null || !running || !readerPassword) return null;
    return `Basic ${Buffer.from(`${INTERNAL_READER_USER}:${readerPassword}`).toString('base64')}`;
  }

  function feedState(profileId: string, feed: Feed): FeedState {
    const state = findProfile(profileId)?.feeds.get(feed)?.tracker.current() ?? offlineFeedState(feed, profileId);
    return { ...state };
  }

  async function kick(pathName: string, logFields: Record<string, unknown>, what: string): Promise<void> {
    if (!proc) return;
    try {
      if (await api.kickPublisher(pathName)) log.info(logFields, what);
    } catch (err) {
      log.warn({ ...logFields, err: err instanceof Error ? err.message : String(err) }, 'Could not disconnect the current publisher');
    }
  }

  // ---- polling ----------------------------------------------------------

  function schedulePoll(): void {
    if (!running || pollTimer) return;
    pollTimer = setTimeout(() => void pollOnce(), pollIntervalMs);
  }

  async function pollOnce(): Promise<void> {
    pollTimer = null;
    if (!running) return;
    if (proc) {
      try {
        const items = await api.listPaths(pollAbort.signal);
        pollFailures = 0;
        if (running && proc) applyPaths(items);
        if (running && proc && pull?.active() && api.listRtmpConns) {
          // Pull link readers: their own try, so a failure here never marks the feeds offline.
          try {
            const fetchedAt = now();
            const conns = await api.listRtmpConns(pollAbort.signal);
            if (running && proc) await pull.apply(conns, fetchedAt);
          } catch (err) {
            log.debug({ err: err instanceof Error ? err.message : String(err) }, 'Could not count pull link readers');
          }
        }
      } catch (err) {
        pollFailures++;
        if (pollFailures === POLL_FAILURES_BEFORE_OFFLINE) {
          log.debug({ err: err instanceof Error ? err.message : String(err) }, 'MediaMTX API not answering; marking feeds offline');
        }
        if (pollFailures >= POLL_FAILURES_BEFORE_OFFLINE) markAllOffline();
      }
    }
    schedulePoll();
  }

  async function waitForApi(timeoutMs: number): Promise<boolean> {
    const deadline = now() + timeoutMs;
    while (running && proc && now() < deadline) {
      try {
        await api.listPaths(pollAbort.signal);
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return false;
  }

  // ---- process ----------------------------------------------------------

  function onLogLine(line: string): void {
    // "2026/10/11 17:01:26 INF [RTMP] ..." -> "INF [RTMP] ..."
    const text = redactSecretsInText(line.replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}(\.\d+)? /, '').trim());
    if (!text) return;
    if (text.startsWith('ERR ')) {
      lastError = text.slice(4);
      log.warn(`mediamtx: ${text}`);
    } else {
      log.debug(`mediamtx: ${text}`);
    }
  }

  function killOnExit(): void {
    // Don't leave an orphaned MediaMTX holding the ports if Node dies without stop().
    try {
      proc?.kill();
    } catch {
      // ignore
    }
  }

  async function binaryAvailable(): Promise<boolean> {
    // Bare command names (resolved through PATH) are checked by spawn itself.
    if (!bin.includes('/') && !bin.includes('\\')) return true;
    try {
      await fs.access(bin, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  function spawnProcess(): void {
    lastError = null;
    let child: ChildProcess;
    try {
      child = spawn(bin, [configPath], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      log.error({ err }, notFound);
      return;
    }
    proc = child;
    procStartedAt = now();
    onLines(child.stdout, onLogLine);
    onLines(child.stderr, onLogLine);

    let ended = false;
    const onEnd = (code: number | null, signal: NodeJS.Signals | null, spawnError?: NodeJS.ErrnoException) => {
      if (ended) return;
      ended = true;
      if (proc !== child) return;
      proc = null;
      markAllOffline();
      if (!running) return;
      if (spawnError && (spawnError.code === 'ENOENT' || spawnError.code === 'EACCES')) {
        log.error(notFound);
        return; // nothing to retry until the binary is installed
      }
      if (now() - procStartedAt >= HEALTHY_AFTER_MS) restartAttempt = 0;
      const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** restartAttempt);
      restartAttempt++;
      log.warn(
        { code, signal, lastError, attempt: restartAttempt },
        `MediaMTX exited unexpectedly; restarting in ${Math.round(delay / 1000)} s`,
      );
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (running && !proc) spawnProcess();
      }, delay);
    };
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (child.pid === undefined) onEnd(null, null, err);
      else log.warn({ err }, 'MediaMTX process error');
    });
    child.on('exit', (code, signal) => onEnd(code, signal));
    if (child.pid !== undefined) log.info({ pid: child.pid, rtmpPort: config.rtmpPort }, 'MediaMTX started');
  }

  /** Register every profile and load its keys. The default profile must work; others are best effort. */
  async function loadAllProfiles(): Promise<void> {
    await ensureReader();
    await ensureKeys(register(DEFAULT_PROFILE_ID, null));
    for (const p of repos.profiles.list()) {
      if (p.id === DEFAULT_PROFILE_ID || removed.has(p.id)) continue;
      try {
        await ensureKeys(register(p.id, p.slug));
      } catch (err) {
        log.error({ profileId: p.id, err: err instanceof Error ? err.message : String(err) }, 'Could not load the ingest keys of a profile');
      }
    }
  }

  // ---- MediaServer ------------------------------------------------------

  guests?.attachMedia({
    async kick(pathName) {
      if (!proc) return false;
      return api.kickPublisher(pathName);
    },
  });

  pull?.attachMedia({
    async listConns() {
      return proc && api.listRtmpConns ? api.listRtmpConns() : [];
    },
    async kickConn(id) {
      return proc && api.kickRtmpConn ? api.kickRtmpConn(id) : false;
    },
  });

  const server: MediaServer = {
    appName: APP_NAME,

    async publisherAddress(profileId) {
      const entry = findProfile(profileId);
      if (!entry || !proc) return null;
      for (const feed of FEEDS) {
        if (!entry.feeds.get(feed)?.tracker.current().online) continue;
        try {
          const address = await api.publisherAddress(feedPath(feed, entry.slug));
          if (address) return address;
        } catch (err) {
          log.debug({ profileId, feed, err: err instanceof Error ? err.message : String(err) }, 'Could not look up the publisher address');
        }
      }
      return null;
    },

    async start() {
      if (running) return;
      running = true;
      restartAttempt = 0;
      pollAbort = new AbortController();
      try {
        await loadAllProfiles();
        await guests?.load();
        auth ??= await startAuthServer({ authorize: (req) => server.authorize(req), log });
        await fs.mkdir(workDir, { recursive: true });
        await fs.writeFile(
          configPath,
          buildMediaMtxConfig({ rtmpPort: config.rtmpPort, apiPort: config.mediamtxApiPort, authPort: auth.port, hlsPort }),
          { mode: 0o600 },
        );
      } catch (err) {
        running = false;
        await auth?.close();
        auth = null;
        throw err;
      }

      if (!(await binaryAvailable())) {
        log.error(notFound);
        return;
      }
      process.once('exit', killOnExit);
      spawnProcess();
      schedulePoll();
      if (readyTimeoutMs > 0 && proc && !(await waitForApi(readyTimeoutMs))) {
        log.warn('MediaMTX control API did not answer yet; feeds will appear once it does');
      }
    },

    async stop() {
      running = false;
      pollAbort.abort();
      if (pollTimer) clearTimeout(pollTimer);
      if (restartTimer) clearTimeout(restartTimer);
      pollTimer = null;
      restartTimer = null;
      process.off('exit', killOnExit);
      const child = proc;
      if (child) await terminate(child, 5_000);
      proc = null;
      await auth?.close();
      auth = null;
      markAllOffline();
    },

    feeds(profileId) {
      return FEEDS.map((f) => feedState(profileId, f));
    },

    feed(profileId, feed) {
      return feedState(profileId, feed);
    },

    hlsSource(profileId, feed) {
      const entry = requireProfile(profileId);
      const authorization = hlsAuthorization();
      if (!authorization) return null;
      return { baseUrl: `http://127.0.0.1:${hlsPort}/${feedPath(feed, entry.slug)}/`, authorization };
    },

    guestHlsSource(slot) {
      const authorization = hlsAuthorization();
      if (!authorization || !guests?.guestExists(slot)) return null;
      return { baseUrl: `http://127.0.0.1:${hlsPort}/${guestPath(slot)}/`, authorization };
    },

    guestReadUrl(slot) {
      if (!readerPassword) throw new Error('Media server not started');
      const pass = encodeURIComponent(readerPassword);
      return `rtmp://127.0.0.1:${config.rtmpPort}/${guestPath(slot)}?user=${INTERNAL_READER_USER}&pass=${pass}`;
    },

    readUrl(profileId, feed) {
      if (!readerPassword) throw new Error('Media server not started');
      return readUrlFor(requireProfile(profileId), feed);
    },

    authorize(req: MediaMtxAuthRequest) {
      return authorizeMediaRequest(req, authState);
    },

    async ingestKeys(profileId) {
      const k = await ensureKeys(requireProfile(profileId));
      return { landscape: k.landscape, vertical: k.vertical };
    },

    async rotateIngestKey(profileId, feed) {
      const entry = requireProfile(profileId);
      const current = await ensureKeys(entry);
      const next = generateKey();
      await repos.secrets.scoped(profileSecretScope(profileId, 'ingest')).set(feed, next);
      entry.keys = { ...current, [feed]: next };
      log.info({ profileId, feed }, 'Ingest key rotated');
      // The old key stops working immediately; also drop a publisher that is still connected with it.
      await kick(feedPath(feed, entry.slug), { profileId, feed }, 'Disconnected the publisher using the old key');
      return next;
    },

    async streamKeyField(profileId, feed) {
      const entry = requireProfile(profileId);
      const k = await ensureKeys(entry);
      return `${streamKeyPath(feed, entry.slug)}?key=${k[feed]}`;
    },

    async profileAdded(profile) {
      removed.delete(profile.id);
      const entry = register(profile.id, profile.slug);
      await ensureKeys(entry);
      log.info({ profileId: profile.id, slug: entry.slug }, 'Profile ingest ready');
    },

    async profileRemoved(profileId) {
      if (profileId === DEFAULT_PROFILE_ID) throw new DefaultProfileMediaError();
      removed.add(profileId);
      const entry = profiles.get(profileId);
      const slug = entry?.slug ?? repos.profiles.get(profileId)?.slug ?? null;
      // Stop accepting its paths first (MediaMTX asks us on every publish), then drop its keys.
      profiles.delete(profileId);
      if (slug && bySlug.get(slug) === profileId) bySlug.delete(slug);
      repos.secrets.deleteScope(profileSecretScope(profileId, 'ingest'));
      // A connected OBS was authorized earlier: disconnect it.
      if (slug) {
        for (const feed of FEEDS) await kick(feedPath(feed, slug), { profileId, feed }, 'Disconnected the publisher of a deleted profile');
      }
      if (entry) markOffline(entry);
      await guests?.profileRemoved(profileId);
      log.info({ profileId }, 'Profile ingest removed');
    },
  };

  return server;
}
