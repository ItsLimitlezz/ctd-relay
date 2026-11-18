// Session + go-live orchestrator (docs/ARCHITECTURE.md §4).
//
// Owns the SessionState: one DestinationRunner per enabled destination while a session runs.
// Session-level operations (start/stop/destination edits) are serialized on one queue; each
// runner serializes its own steps. Runner teardown (push stop + end()) happens outside the
// session queue but is chained per destination, so a restarted runner never races the old one.
// Test mode ('session.testMode', see test-mode.ts) is fixed for a session: it can only change
// while offline, and each runner skips (or prepares privately) its destination accordingly.
//
// Profiles: one orchestrator per profile (see registry.ts), all running independently and at the
// same time. Each only sees its own profile's OBS feeds (FeedState.profileId) and destinations,
// keeps its settings under profileSettingKey() (the default profile keeps the pre-profiles keys),
// and stamps its profileId on every SessionState, DestinationState, chat attach and notice.

import { createHash, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import {
  DEFAULT_PROFILE_ID,
  FEEDS,
  type Destination,
  type DestinationPhase,
  type DestinationState,
  type Feed,
  type FeedState,
  type FieldSpec,
  type PlatformInfo,
  type Profile,
  type ProfileSummary,
  type SessionState,
  type SessionStatus,
  type TitleResult,
} from '../../../shared/types.js';
import { isDown } from '../api/status.js';
import { profileSettingKey, type AppServices, type Orchestrator } from '../services.js';
import { awaitBounded, errorMessage, SerialQueue, stableStringify, textLength } from './async-utils.js';
import {
  DEFAULT_TIMINGS,
  DestinationRunner,
  type OrchestratorTimings,
  type RunnerHost,
  type StatePatch,
} from './destination-runner.js';
import { TEST_MODE_CHANNEL_TITLE, TEST_MODE_SETTING, testModeLockedError } from './test-mode.js';

export { DEFAULT_TIMINGS, type OrchestratorTimings } from './destination-runner.js';

export const MAX_TITLE_LENGTH = 140;
const DEFAULT_GRACE_SEC = 15;

export interface OrchestratorOptions {
  timings?: Partial<OrchestratorTimings>;
  /** Profile this orchestrator runs (default: the default profile). */
  profileId?: string;
}

/** Settings keys of one profile's session (the default profile keeps 'session.*'). */
export const SESSION_SETTINGS = {
  title: 'session.title',
  autoGoLive: 'session.autoGoLive',
  testMode: TEST_MODE_SETTING,
} as const;

/** Separator between the profile name and a notice, e.g. "DPRTMNT · Instagram ended the live…". */
export const PROFILE_NOTICE_SEPARATOR = ' · ';

/** Error carrying an HTTP status, mapped by the app error handler. */
function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function nowIso(): string {
  return new Date().toISOString();
}

function offlinePhase(dest: Destination): DestinationPhase {
  return dest.enabled ? 'idle' : 'disabled';
}

/**
 * A stored option value the way a save (normalizeFields) would store it: no value (missing, null,
 * '') → the field default; numbers and booleans read from text; text trimmed. Values a save would
 * reject are kept as they are (so changing them still counts as a change).
 */
function effectiveOption(field: FieldSpec, raw: unknown): unknown {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return field.default;
  switch (field.type) {
    case 'boolean':
      if (raw === 'true' || raw === '1' || raw === 1) return true;
      if (raw === 'false' || raw === '0' || raw === 0) return false;
      return raw;
    case 'number': {
      const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
      return typeof n === 'number' && Number.isFinite(n) ? n : raw;
    }
    default:
      if (typeof raw === 'string') return raw.trim();
      return typeof raw === 'number' ? String(raw) : raw;
  }
}

const RESET: StatePatch = { message: null, stats: null, watchUrl: null, retries: 0, viewers: null };
/** Per-session counters: cleared when a session starts (kept after it stops, for the record). */
const SESSION_RESET: StatePatch = { recoveries: 0, lastRecovery: null };

/** A runner teardown started under the session lock, awaited after releasing it. */
type Teardown = { done: Promise<void> } | null;

function stopNotice(reason: string, graceSec: number): string {
  switch (reason) {
    case 'manual':
      return 'Session stopped';
    case 'obs-disconnected':
      return `Session ended: no feed from OBS for ${graceSec} s`;
    case 'shutdown':
      return 'Session stopped: server shutting down';
    case 'profile-deleted':
      return 'Session stopped: profile deleted';
    default:
      return `Session stopped (${reason})`;
  }
}

export function createOrchestrator(services: AppServices, opts: OrchestratorOptions = {}): SessionOrchestrator {
  return new SessionOrchestrator(services, { ...DEFAULT_TIMINGS, ...opts.timings }, opts.profileId ?? DEFAULT_PROFILE_ID);
}

/** Profile of a feed/destination/... event; events without one belong to the default profile. */
export function profileOf(item: { profileId?: string | null } | null | undefined): string {
  return item?.profileId || DEFAULT_PROFILE_ID;
}

export class SessionOrchestrator implements Orchestrator {
  private readonly lock = new SerialQueue();
  private readonly lifetime = new AbortController();
  private readonly host: RunnerHost;
  private readonly log: Logger;

  private loaded = false;
  private status: SessionStatus = 'offline';
  private sessionId: string | null = null;
  private startedAt: string | null = null;
  private title = '';
  private autoGoLive = true;
  /** Session test mode ('session.testMode'); only changes while offline, so it is fixed per session. */
  private testMode = false;

  private readonly feeds = new Map<Feed, FeedState>();
  private readonly states = new Map<string, DestinationState>();
  private readonly runners = new Map<string, DestinationRunner>();
  /** Latest teardown per destination; a new runner for the id waits for it. */
  private readonly cleanups = new Map<string, Promise<void>>();
  /** Removed via destinationRemoved() but possibly still in the repo for a moment. */
  private readonly removed = new Set<string>();

  private obsGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribers: (() => void)[] = [];
  private shuttingDown = false;
  /** A feed came online while a stop was tearing down; auto go-live re-checks once it finishes. */
  private feedReturnedWhileStopping = false;

  constructor(
    private readonly services: AppServices,
    private readonly timings: OrchestratorTimings,
    readonly profileId: string = DEFAULT_PROFILE_ID,
  ) {
    // services.orchestrators is assigned after construction: only read services lazily.
    this.log = services.log.child({ mod: 'orchestrator', profileId });
    this.host = {
      services,
      timings,
      log: this.log,
      profileId,
      title: () => this.title,
      testMode: () => this.testMode,
      feedOnline: (feed) => this.feeds.get(feed)?.online === true,
      graceMs: () => this.graceSec() * 1000,
      endTimeoutMs: () => (this.shuttingDown ? timings.shutdownEndTimeoutMs : timings.endTimeoutMs),
      state: (id) => this.states.get(id) ?? null,
      update: (id, patch) => this.update(id, patch),
      notice: (level, message) => this.notice(level, message),
    };
  }

  // ---------------------------------------------------------------------------
  // Orchestrator interface
  // ---------------------------------------------------------------------------

  async init(): Promise<void> {
    if (this.unsubscribers.length > 0 || this.shuttingDown) return;
    this.ensureLoaded();
    for (const f of this.mediaFeeds()) this.feeds.set(f.feed, f);
    const { bus } = this.services;
    this.unsubscribers.push(
      bus.on('feed', (f) => this.onFeed(f)),
      bus.on('push', (ev) => this.runners.get(ev.id)?.pushEvent(ev)),
    );
    if (this.autoGoLive && this.anyFeedOnline()) await this.start('auto');
  }

  state(): SessionState {
    return this.snapshot().state;
  }

  /**
   * The profile with its live situation (ProfileSummary): enabled destinations, how many are
   * live, and how many are down by the external API's definition (session running, enabled, not
   * skipped by test mode, phase error/retrying/recovering/waiting-for-feed).
   */
  summary(profile: Profile): ProfileSummary {
    const { state, list } = this.snapshot();
    const states = new Map(state.destinations.map((d) => [d.destinationId, d]));
    let destinations = 0;
    let live = 0;
    let down = 0;
    for (const d of list) {
      const st = states.get(d.id);
      const phase = st?.phase ?? offlinePhase(d);
      if (d.enabled) destinations += 1;
      if (phase === 'live') live += 1;
      if (isDown(state, d, phase, this.platformInfo(d), st?.retries ?? 0)) down += 1;
    }
    return {
      ...profile,
      status: state.status,
      startedAt: state.startedAt,
      testMode: state.testMode === true,
      destinations,
      live,
      down,
    };
  }

  private snapshot(): { state: SessionState; list: Destination[] } {
    this.ensureLoaded();
    const list = this.reconcile();
    const listed = new Set(list.map((d) => d.id));
    const destinations: DestinationState[] = [];
    for (const d of list) {
      const st = this.states.get(d.id);
      if (st) destinations.push(st);
    }
    for (const [id, st] of this.states) if (!listed.has(id)) destinations.push(st);
    const state: SessionState = {
      profileId: this.profileId,
      status: this.status,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      title: this.title,
      autoGoLive: this.autoGoLive,
      testMode: this.testMode,
      feeds: FEEDS.map((f) => this.feeds.get(f) ?? offlineFeed(f, this.profileId)),
      destinations,
    };
    return { state, list };
  }

  private platformInfo(dest: Destination): PlatformInfo | null {
    try {
      return this.services.platforms.get(dest.platform).info;
    } catch {
      return null;
    }
  }

  start(trigger: 'auto' | 'manual'): Promise<void> {
    return this.lock.run(() => {
      this.ensureLoaded();
      if (this.status !== 'offline' || this.shuttingDown) return;
      this.sessionId = randomUUID();
      this.startedAt = nowIso();
      this.status = 'starting';
      this.log.info({ sessionId: this.sessionId, trigger, testMode: this.testMode }, 'session starting');
      this.emitSession();

      for (const dest of this.reconcile()) {
        this.update(dest.id, SESSION_RESET);
        if (dest.enabled) this.launchRunner(dest);
        else this.update(dest.id, { ...RESET, phase: 'disabled' });
      }
      this.status = 'live';
      this.emitSession();
    });
  }

  stop(reason = 'manual'): Promise<void> {
    return this.stopSession(reason);
  }

  /**
   * @param expectSessionId set by the OBS grace timer: skip the stop when that session already
   *   ended, or when a feed came back while this stop waited for the lock.
   */
  private stopSession(reason: string, expectSessionId?: string | null): Promise<void> {
    return this.lock.run(async () => {
      if (this.status === 'offline') return;
      if (expectSessionId !== undefined && (this.sessionId !== expectSessionId || this.anyFeedOnline())) return;
      this.clearObsGrace();
      this.feedReturnedWhileStopping = false;
      this.status = 'stopping';
      this.log.info({ sessionId: this.sessionId, reason }, 'session stopping');
      this.emitSession();

      const pending = [...this.runners.keys()].map((id) => this.retireRunner(id));
      await Promise.all([...pending, ...this.cleanups.values()]);

      this.status = 'offline';
      this.sessionId = null;
      this.startedAt = null;
      for (const dest of this.reconcile()) this.update(dest.id, { ...RESET, phase: offlinePhase(dest) });
      this.emitSession();
      this.notice('info', stopNotice(reason, this.graceSec()));

      // OBS (re)started streaming during the teardown: that offline->online transition was ignored
      // while 'stopping', and no other one will come, so honour auto go-live now. This applies to a
      // manual stop too: it is a genuine new OBS start (a feed that simply stays online through a
      // manual stop records nothing and stays offline). start() is queued behind this task, never awaited.
      const feedReturned = this.feedReturnedWhileStopping;
      this.feedReturnedWhileStopping = false;
      if (feedReturned && reason !== 'shutdown') this.maybeAutoStart();
    });
  }

  async setTitle(title: string): Promise<TitleResult[]> {
    this.ensureLoaded();
    const next = title.trim();
    if (textLength(next) > MAX_TITLE_LENGTH) {
      throw httpError(400, `Title must be at most ${MAX_TITLE_LENGTH} characters`);
    }
    this.services.repos.settings.set(this.settingKey('title'), next);
    this.title = next;
    this.emitSession();

    const list = this.listDestinations();
    if (this.status === 'live' || this.status === 'starting') {
      return Promise.all(
        list.map(
          (d) =>
            this.runners.get(d.id)?.setTitle(next) ??
            Promise.resolve(skipped(d.id, d.enabled ? 'Not live yet; the new title is used when it goes live' : 'Destination is disabled')),
        ),
      );
    }
    return Promise.all(list.map((d) => this.setTitleOffline(d, next)));
  }

  setAutoGoLive(value: boolean): void {
    this.ensureLoaded();
    this.services.repos.settings.set(this.settingKey('autoGoLive'), value);
    this.autoGoLive = value;
    this.emitSession();
    if (value) this.maybeAutoStart();
  }

  /**
   * Test mode applies to a whole session, so it only changes while none runs ('starting',
   * 'live' and 'stopping' → 409 session_live). start() and stop() change the status synchronously
   * inside their locked task, so this check can't interleave with a session starting.
   */
  setTestMode(value: boolean): void {
    this.ensureLoaded();
    if (this.status !== 'offline') throw testModeLockedError();
    const next = value === true;
    this.services.repos.settings.set(this.settingKey('testMode'), next);
    if (next === this.testMode) return;
    this.testMode = next;
    this.log.info({ testMode: next }, 'test mode changed');
    this.emitSession();
  }

  // The three methods below do their bookkeeping under the session lock but wait for the runner
  // teardown (push stop + end(), up to ~30 s) outside it, so a Stop click is never stuck behind it.
  // The teardown is returned wrapped in an object: a bare promise would be adopted by the lock.

  async destinationChanged(id: string): Promise<void> {
    const teardown = await this.lock.run(async (): Promise<Teardown> => {
      this.ensureLoaded();
      const dest = this.getDestination(id);
      if (!dest) return this.removeLocked(id);
      this.removed.delete(id);

      const isNew = !this.states.has(id);
      if (isNew) this.states.set(id, blankState(id, offlinePhase(dest), this.profileId));

      if (this.status !== 'live') {
        this.update(id, { phase: offlinePhase(dest) });
        if (isNew) this.emitSession();
        return null;
      }
      if (isNew) this.emitSession();

      const runner = this.runners.get(id);
      if (!dest.enabled) {
        if (runner) return { done: this.retireRunner(id) };
        this.update(id, { ...RESET, phase: 'disabled' });
        return null;
      }
      if (!runner) {
        this.launchRunner(dest);
        return null;
      }
      const [before, after] = await Promise.all([runner.fingerprint, this.fingerprint(dest)]);
      if (before === after) return null;
      this.log.info({ destinationId: id }, 'destination config changed; restarting it');
      const done = this.retireRunner(id);
      this.launchRunner(dest);
      return { done };
    });
    await teardown?.done;
  }

  async destinationRemoved(id: string): Promise<void> {
    const teardown = await this.lock.run(() => this.removeLocked(id));
    await teardown.done;
  }

  async retryDestination(id: string): Promise<void> {
    const teardown = await this.lock.run((): Teardown => {
      if (this.status !== 'live') return null;
      const dest = this.getDestination(id);
      if (!dest || !dest.enabled) return null;
      this.log.info({ destinationId: id }, 'retrying destination');
      const done = this.retireRunner(id);
      this.launchRunner(dest);
      return { done };
    });
    await teardown?.done;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.clearObsGrace();
    await this.stop('shutdown');
    this.lifetime.abort();
  }

  // ---------------------------------------------------------------------------
  // Feeds
  // ---------------------------------------------------------------------------

  private onFeed(event: FeedState): void {
    // Another profile's OBS: none of our business (auto go-live is per profile).
    if (profileOf(event) !== this.profileId) return;
    const feed: FeedState = { ...event, profileId: this.profileId };
    const prev = this.feeds.get(feed.feed);
    this.feeds.set(feed.feed, feed);
    if (prev?.online === feed.online) return; // stats-only update; the UI gets 'feed' events directly
    this.emitSession();
    for (const runner of this.runners.values()) runner.feedsChanged();

    if (feed.online) {
      this.clearObsGrace();
      if (this.status === 'stopping') this.feedReturnedWhileStopping = true;
      this.maybeAutoStart();
    } else if (!this.anyFeedOnline() && (this.status === 'live' || this.status === 'starting')) {
      this.armObsGrace();
    }
  }

  private maybeAutoStart(): void {
    if (!this.autoGoLive || this.status !== 'offline' || this.shuttingDown || !this.anyFeedOnline()) return;
    this.start('auto').catch((err: unknown) => this.log.error({ error: errorMessage(err) }, 'auto go-live failed'));
  }

  /** OBS stopped (every feed offline): end the session unless a feed returns within the grace period. */
  private armObsGrace(): void {
    if (this.obsGraceTimer) return;
    const sessionId = this.sessionId;
    this.obsGraceTimer = setTimeout(() => {
      this.obsGraceTimer = null;
      if (this.sessionId !== sessionId || this.anyFeedOnline()) return;
      // Re-checked under the lock: a feed may return while an earlier task still holds it.
      this.stopSession('obs-disconnected', sessionId).catch((err: unknown) =>
        this.log.error({ error: errorMessage(err) }, 'stopping after OBS disconnect failed'),
      );
    }, this.graceSec() * 1000);
  }

  private clearObsGrace(): void {
    if (this.obsGraceTimer) clearTimeout(this.obsGraceTimer);
    this.obsGraceTimer = null;
  }

  private anyFeedOnline(): boolean {
    for (const f of this.feeds.values()) if (f.online) return true;
    return false;
  }

  /** This profile's feeds as the media server reports them right now. */
  private mediaFeeds(): FeedState[] {
    try {
      return this.services.media
        .feeds(this.profileId)
        .filter((f) => !f.profileId || f.profileId === this.profileId)
        .map((f) => ({ ...f, profileId: this.profileId }));
    } catch (err) {
      this.log.warn({ error: errorMessage(err) }, 'reading feed state failed');
      return [];
    }
  }

  private graceSec(): number {
    const value = Number(this.services.appSettings().disconnectGraceSec);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_GRACE_SEC;
  }

  // ---------------------------------------------------------------------------
  // Runners
  // ---------------------------------------------------------------------------

  private launchRunner(dest: Destination): void {
    const after = this.cleanups.get(dest.id) ?? Promise.resolve();
    if (!this.states.has(dest.id)) this.states.set(dest.id, blankState(dest.id, 'idle', this.profileId));
    const runner = new DestinationRunner(this.host, dest, this.fingerprint(dest), after);
    this.runners.set(dest.id, runner);
    runner.start();
  }

  /** Detach the destination's runner and tear it down. Resolves when the teardown is done. */
  private retireRunner(id: string): Promise<void> {
    const runner = this.runners.get(id);
    if (!runner) return this.cleanups.get(id) ?? Promise.resolve();
    this.runners.delete(id);
    const done = runner.stop().then(() => {
      if (this.cleanups.get(id) === done) this.cleanups.delete(id);
      // No successor took over: settle on a resting phase.
      if (!this.runners.has(id) && this.states.has(id)) {
        const dest = this.getDestination(id);
        const phase: DestinationPhase = !dest || !dest.enabled ? 'disabled' : 'idle';
        this.update(id, { ...RESET, phase });
      }
    });
    this.cleanups.set(id, done);
    return done;
  }

  private removeLocked(id: string): { done: Promise<void> } {
    const done = this.retireRunner(id);
    this.removed.add(id);
    if (this.states.delete(id)) this.emitSession();
    return { done };
  }

  /** Detects config edits that need a runner restart (including a replaced stream key). */
  private async fingerprint(dest: Destination): Promise<string> {
    let keyHash = '';
    if (dest.hasStreamKey) {
      try {
        const key = await this.services.repos.secrets.scoped(`destination:${dest.id}`).get('streamKey');
        keyHash = key ? createHash('sha256').update(key).digest('hex') : '';
      } catch (err) {
        this.log.warn({ destinationId: dest.id, error: errorMessage(err) }, 'reading stream key for fingerprint failed');
      }
    }
    const options = this.restartRelevantOptions(dest);
    return stableStringify([dest.platform, dest.accountId, dest.feed, options, dest.ingestUrl, dest.hasStreamKey, keyHash]);
  }

  /**
   * Options whose edit must restart a running destination, as their effective values: built from
   * the platform's option fields, a missing value counts as the field default (a save backfills
   * defaults for fields added since the destination was created) and keys of removed fields are
   * ignored, so a save that changes nothing effective never ends the live. 'links' fields are left
   * out: they are read at prepare time (each new live takes the next link), so editing the list
   * mid-session must not end the current live — the next live (or takedown recovery) picks it up.
   */
  private restartRelevantOptions(dest: Destination): Record<string, unknown> {
    let fields: readonly FieldSpec[];
    try {
      fields = this.services.platforms.get(dest.platform).info.destinationFields;
    } catch {
      return dest.options;
    }
    const options: Record<string, unknown> = {};
    for (const field of fields) {
      if ((field.target ?? 'option') !== 'option' || field.type === 'links') continue;
      const value = effectiveOption(field, dest.options[field.key]);
      if (value !== undefined) options[field.key] = value;
    }
    return options;
  }

  // ---------------------------------------------------------------------------
  // Title
  // ---------------------------------------------------------------------------

  private async setTitleOffline(dest: Destination, title: string): Promise<TitleResult> {
    if (!dest.enabled) return skipped(dest.id, 'Destination is disabled');
    let driver;
    try {
      driver = this.services.platforms.get(dest.platform);
    } catch (err) {
      return { destinationId: dest.id, ok: false, error: errorMessage(err) };
    }
    const setOffline = driver.setTitleOffline?.bind(driver);
    if (!setOffline) return skipped(dest.id, 'Applied when the stream goes live');
    // An offline title is the channel's own (Twitch, Kick): public even while the stream is a
    // private test, so test mode never changes it (supported platform or skipped one alike).
    if (this.testMode) return skipped(dest.id, TEST_MODE_CHANNEL_TITLE);
    try {
      await awaitBounded(
        async (signal) => {
          const ctx = await this.services.driverContext({
            platform: dest.platform,
            accountId: dest.accountId,
            destinationId: dest.id,
            signal,
          });
          const account = dest.accountId ? this.services.repos.accounts.get(dest.accountId) : null;
          await setOffline(dest, account, title, ctx);
        },
        { ms: this.timings.titleTimeoutMs, signal: this.lifetime.signal, what: 'Updating the title' },
      );
      return { destinationId: dest.id, ok: true };
    } catch (err) {
      this.log.warn({ destinationId: dest.id, error: errorMessage(err) }, 'offline title update failed');
      return { destinationId: dest.id, ok: false, error: errorMessage(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const { settings } = this.services.repos;
    const title = settings.get<unknown>(this.settingKey('title'), '');
    this.title = typeof title === 'string' ? title : '';
    this.autoGoLive = settings.get<unknown>(this.settingKey('autoGoLive'), true) !== false;
    this.testMode = settings.get<unknown>(this.settingKey('testMode'), false) === true;
    for (const f of this.mediaFeeds()) this.feeds.set(f.feed, f);
  }

  /** Settings key of this profile's session setting (default profile: the pre-profiles 'session.*'). */
  private settingKey(name: keyof typeof SESSION_SETTINGS): string {
    return profileSettingKey(this.profileId, SESSION_SETTINGS[name]);
  }

  /** This profile's destinations (ids are global; another profile's destination is never ours). */
  private listDestinations(): Destination[] {
    try {
      return this.services.repos.destinations.list(this.profileId).filter((d) => profileOf(d) === this.profileId);
    } catch (err) {
      this.log.error({ error: errorMessage(err) }, 'listing destinations failed');
      return [];
    }
  }

  private getDestination(id: string): Destination | null {
    try {
      const dest = this.services.repos.destinations.get(id);
      return dest && profileOf(dest) === this.profileId ? dest : null;
    } catch (err) {
      this.log.error({ destinationId: id, error: errorMessage(err) }, 'reading destination failed');
      return null;
    }
  }

  /**
   * User-facing notice for this profile. With several profiles the message names the profile
   * ("DPRTMNT · Instagram ended the live…"), since profiles can be live at the same time.
   */
  private notice(level: 'info' | 'warn' | 'error', message: string): void {
    this.services.bus.emit('notice', { level, message: this.withProfileName(message), profileId: this.profileId });
  }

  private withProfileName(message: string): string {
    try {
      const profiles = this.services.repos.profiles;
      if (!profiles || profiles.list().length < 2) return message;
      const name = profiles.get(this.profileId)?.name;
      return name ? `${name}${PROFILE_NOTICE_SEPARATOR}${message}` : message;
    } catch (err) {
      this.log.debug({ error: errorMessage(err) }, 'reading the profile name failed');
      return message;
    }
  }

  /** Align destination states with the repo; returns the repo list (minus removed ids). */
  private reconcile(): Destination[] {
    const all = this.listDestinations();
    if (this.removed.size > 0) {
      const repoIds = new Set(all.map((d) => d.id));
      for (const id of this.removed) if (!repoIds.has(id)) this.removed.delete(id);
    }
    const list = all.filter((d) => !this.removed.has(d.id));

    const resting = this.status === 'offline';
    for (const d of list) {
      const st = this.states.get(d.id);
      if (!st) {
        this.states.set(d.id, blankState(d.id, resting ? offlinePhase(d) : d.enabled ? 'idle' : 'disabled', this.profileId));
      } else if (resting && !this.runners.has(d.id) && (st.phase === 'idle' || st.phase === 'disabled')) {
        const phase = offlinePhase(d);
        if (st.phase !== phase) this.states.set(d.id, { ...st, phase, since: nowIso() });
      }
    }
    const listed = new Set(list.map((d) => d.id));
    for (const id of [...this.states.keys()]) {
      if (!listed.has(id) && !this.runners.has(id)) this.states.delete(id);
    }
    return list;
  }

  private update(id: string, patch: StatePatch): void {
    const cur = this.states.get(id);
    if (!cur) return;
    // A destination that stops pushing (stats cleared) isn't transcoding any more either. Only
    // destinations that were transcoding ever carry the field.
    if (patch.stats === null && patch.transcode === undefined && cur.transcode) patch = { ...patch, transcode: null };
    const next: DestinationState = { ...cur, ...patch, profileId: this.profileId };
    if (patch.phase && patch.phase !== cur.phase) next.since = nowIso();
    if (
      next.phase === cur.phase &&
      next.message === cur.message &&
      next.stats === cur.stats &&
      next.watchUrl === cur.watchUrl &&
      next.retries === cur.retries &&
      next.recoveries === cur.recoveries &&
      next.lastRecovery === cur.lastRecovery &&
      (next.viewers ?? null) === (cur.viewers ?? null) &&
      (next.transcode ?? null) === (cur.transcode ?? null)
    ) {
      return;
    }
    this.states.set(id, next);
    this.services.bus.emit('destination', next);
  }

  private emitSession(): void {
    this.services.bus.emit('session', this.state());
  }
}

function blankState(id: string, phase: DestinationPhase, profileId: string): DestinationState {
  return {
    destinationId: id,
    profileId,
    phase,
    message: null,
    stats: null,
    watchUrl: null,
    retries: 0,
    since: nowIso(),
    recoveries: 0,
    lastRecovery: null,
    viewers: null,
  };
}

function skipped(destinationId: string, reason: string): TitleResult {
  return { destinationId, ok: true, skipped: true, error: reason };
}

function offlineFeed(feed: Feed, profileId: string): FeedState {
  return { profileId, feed, online: false, since: null, video: null, audio: null, bitrateKbps: null };
}
