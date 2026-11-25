// Guest feed routing (docs/GUEST-FEEDS.md → Routing, docs/API.md §18.8): send a guest feed on,
// passthrough only (FFmpeg `-c copy`, never transcoded), to
//   - a custom RTMP(S) server ("somewhere else", up to 3 per guest feed), or
//   - a profile's Landscape or Vertical input (its own profile or another): Relay's FFmpeg reads
//     `guest/<slot>` and republishes it on the loopback MediaMTX to the profile's feed path, with a
//     one-time key the auth hook accepts from loopback only. To the profile it is then exactly a feed
//     from OBS: feed cards, codec guard, Go live, test mode, destinations, reports and alerts.
//
// Every route runs on its own PushSupervisor (the destinations' push, retry and state code) with its
// own event bus, so a route's push events never reach the orchestrators or destination runners.
//
// Guards: a route only runs while its guest sends (and stops when they stop); a profile input is
// never taken from OBS (refused while OBS's own feed is on it; OBS coming back stops the route); one
// route per input; no route can point back at this Relay (route-target.ts); a route never starts a
// profile's Go live (the orchestrator ignores routed inputs for auto go-live); starting or stopping
// a profile route by hand is refused while that profile is live.

import type { Logger } from 'pino';
import {
  cleanRouteName,
  DEFAULT_GUEST_ROUTE_SETTINGS,
  feedLabel,
  MAX_PROFILE_ROUTES_PER_GUEST,
  MAX_RTMP_ROUTES_PER_GUEST,
  type CreateGuestRouteRequest,
  type GuestRoute,
  type GuestRouteSettings,
  type GuestRouteState,
  type ProfileGuestRoutes,
  type UpdateGuestRouteRequest,
} from '../../../shared/guest-routes.js';
import { DEFAULT_PROFILE_ID, type Destination, type Feed, type FeedState } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import type { GuestRouteRow, GuestRoutesRepo } from '../db/guest-routes-repo.js';
import { EventBus, type PushEvent } from '../events.js';
import { joinIngestUrl, safeHost } from '../platforms/custom/url.js';
import type { PushPlan } from '../platforms/types.js';
import type { MediaServer, ProfilesRepo, PushSupervisor, SecretsRepo, SettingsRepo } from '../services.js';
import { generateKey } from './authorize.js';
import { createPushSupervisor, type PushSupervisorDeps } from './ffmpeg-supervisor.js';
import type { GuestFeedEvent, GuestFeeds, GuestFeedsChangedEvent } from './guest-feeds.js';
import { offlineFeedState } from './feed-state.js';
import { feedPath } from './paths.js';
import { redactFragments, redactSecretsInText } from './redact.js';
import { routeTargetProblem, type HostLookup } from './route-target.js';

export const GUEST_ROUTE_SETTINGS_KEY = 'guestRoutes';

export class GuestRouteError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GuestRouteError';
  }
}

export function guestRouteSecretScope(routeId: string): string {
  return `guest-route:${routeId}`;
}

interface Run {
  row: GuestRouteRow;
  active: boolean;
  state: GuestRouteState;
  message: string | null;
  since: string | null;
  bitrateKbps: number | null;
  /** profile routes, while running: the one-time publish key the auth hook accepts. */
  publishKey: string | null;
  /** Strings scrubbed from every message (stream key, full URL). */
  secrets: string[];
}

export interface GuestRoutesOptions {
  config: Pick<AppConfig, 'rtmpPort' | 'ffmpegBin'> & Partial<AppConfig>;
  repo: GuestRoutesRepo;
  guests: GuestFeeds;
  secrets: Pick<SecretsRepo, 'scoped' | 'deleteScope'>;
  settings: Pick<SettingsRepo, 'get' | 'set'>;
  profiles: Pick<ProfilesRepo, 'get'>;
  /** The app's bus: guest feed state comes from it. Route pushes use their own bus. */
  bus: EventBus;
  log: Logger;
  /** Is this profile's session starting, live or stopping? (profile routes can't change then) */
  isLive?: (profileId: string) => boolean;
  /** Host names this Relay is reached at (loop protection). */
  selfHosts?: () => string[];
  lookup?: HostLookup;
  localAddresses?: () => string[];
  supervisorDeps?: PushSupervisorDeps;
  now?: () => number;
}

const inputKey = (profileId: string, feed: Feed) => `${profileId}|${feed}`;

export class GuestRoutes {
  private readonly runs = new Map<string, Run>();
  /** profileId|feed → route id holding that input (while active). */
  private readonly inputs = new Map<string, string>();
  private readonly routeBus = new EventBus();
  private readonly pushes: PushSupervisor;
  private media: MediaServer | null = null;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly opts: GuestRoutesOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
    for (const row of opts.repo.all()) this.runs.set(row.id, this.newRun(row));
    const self = this;
    // The destinations' supervisor, reading the guest instead of a profile's feed: push ids are route ids.
    const mediaAdapter = {
      readUrl(routeId: string): string {
        const run = self.runs.get(routeId);
        if (!run || !self.media?.guestReadUrl) throw new Error('Guest feed is not available');
        return self.media.guestReadUrl(run.row.slot);
      },
      feed(routeId: string): FeedState {
        return self.guestFeedState(routeId);
      },
      feeds(routeId: string): FeedState[] {
        return [self.guestFeedState(routeId)];
      },
    } as unknown as MediaServer;
    this.pushes = createPushSupervisor(
      {
        config: opts.config as AppConfig,
        bus: this.routeBus,
        log: opts.log.child({ mod: 'guest-route-push' }),
        media: mediaAdapter,
        repos: { destinations: { get: (id) => (this.runs.has(id) ? ({ profileId: id } as Destination) : null) } },
      },
      opts.supervisorDeps ?? {},
    );
    this.routeBus.on('push', (ev) => this.onPush(ev));
    opts.bus.on('guest-feed', (ev) => this.onGuestFeed(ev));
    opts.bus.on('guest-feeds-changed', (ev) => this.onGuestsChanged(ev));
  }

  attachMedia(media: MediaServer): void {
    this.media = media;
  }

  // ---- auth hook (synchronous; media/mediamtx.ts RouteAuth) ------------------

  routeKey(profileId: string, feed: Feed): string | null {
    const id = this.inputs.get(inputKey(profileId, feed));
    const run = id ? this.runs.get(id) : undefined;
    return run?.active ? run.publishKey : null;
  }

  /** OBS came back on an input a route holds: the route stands down (OBS's own feed always wins). */
  obsPublished(profileId: string, feed: Feed): void {
    const id = this.inputs.get(inputKey(profileId, feed));
    const run = id ? this.runs.get(id) : undefined;
    if (!run || !run.active) return;
    const profile = this.opts.profiles.get(profileId)?.name ?? profileId;
    this.log.info({ route: run.row.id, profileId, feed }, 'OBS started sending to a routed input; stopping the route');
    void this.halt(run, 'blocked', `OBS started sending ${feedLabel(feed)} to "${profile}", so this route stopped (Relay never replaces OBS's own feed). Start it again once OBS stops.`);
  }

  /** Is this profile input fed by a guest route right now? (the orchestrator ignores it for auto go-live) */
  isRouted(profileId: string, feed: Feed): boolean {
    const id = this.inputs.get(inputKey(profileId, feed));
    return Boolean(id && this.runs.get(id)?.active);
  }

  /** The guest feed routed into this input right now: { slot, name } or null (feed card indicator). */
  routedSource(profileId: string, feed: Feed): { routeId: string; slot: string; name: string | null } | null {
    const id = this.inputs.get(inputKey(profileId, feed));
    const run = id ? this.runs.get(id) : undefined;
    if (!run?.active) return null;
    return { routeId: run.row.id, slot: run.row.slot, name: this.opts.guests.nameOf(run.row.slot) };
  }

  // ---- reading --------------------------------------------------------------

  /** Routes of one guest feed (the slot must belong to the profile). `admin` adds custom servers' URLs. */
  list(profileId: string, slot: string, admin = false): GuestRoute[] {
    this.requireSlot(profileId, slot);
    this.sync();
    return [...this.runs.values()].filter((r) => r.row.slot === slot).map((r) => this.view(r, profileId, admin));
  }

  /** Routes of a profile's guest feeds, and routes into its inputs. */
  forProfile(profileId: string, admin = false): ProfileGuestRoutes {
    this.sync();
    const outbound: GuestRoute[] = [];
    const inbound: ProfileGuestRoutes['inbound'] = [];
    for (const run of this.runs.values()) {
      const owner = this.ownerOf(run.row.slot);
      if (owner === profileId) outbound.push(this.view(run, owner, admin));
      if (run.row.kind === 'profile' && run.row.targetProfileId === profileId && owner) {
        inbound.push({ ...this.view(run, owner, admin), guestName: this.opts.guests.nameOf(run.row.slot) });
      }
    }
    return { profileId, outbound, inbound };
  }

  get(profileId: string, slot: string, routeId: string, admin = false): GuestRoute {
    return this.view(this.require(profileId, slot, routeId), profileId, admin);
  }

  settings(): GuestRouteSettings {
    return { ...DEFAULT_GUEST_ROUTE_SETTINGS, ...this.opts.settings.get<Partial<GuestRouteSettings>>(GUEST_ROUTE_SETTINGS_KEY, {}) };
  }

  setSettings(patch: Partial<GuestRouteSettings>): GuestRouteSettings {
    const next = { ...this.settings(), ...(typeof patch.allowLan === 'boolean' ? { allowLan: patch.allowLan } : {}) };
    this.opts.settings.set(GUEST_ROUTE_SETTINGS_KEY, next);
    return next;
  }

  // ---- managing routes (admin) ----------------------------------------------

  async create(profileId: string, slot: string, body: CreateGuestRouteRequest): Promise<GuestRoute> {
    this.requireSlot(profileId, slot);
    this.sync();
    const mine = [...this.runs.values()].filter((r) => r.row.slot === slot);
    const auto = body.auto === true;
    if (body.kind === 'rtmp') {
      if (mine.filter((r) => r.row.kind === 'rtmp').length >= MAX_RTMP_ROUTES_PER_GUEST) {
        throw new GuestRouteError(409, 'limit', `A guest feed can be sent to at most ${MAX_RTMP_ROUTES_PER_GUEST} custom servers. Remove one first.`);
      }
      const url = String(body.url ?? '').trim();
      const key = typeof body.streamKey === 'string' ? body.streamKey.trim() : '';
      await this.checkTarget(url, key || null);
      const name = this.name(body.name, safeHost(url).replace(/^rtmps?:\/\//, ''));
      const row = this.opts.repo.create({ slot, kind: 'rtmp', name, url, targetProfileId: null, targetFeed: null, auto });
      if (key) await this.opts.secrets.scoped(guestRouteSecretScope(row.id)).set('streamKey', key);
      this.hasKey.set(row.id, Boolean(key));
      const run = this.newRun(row);
      this.runs.set(row.id, run);
      this.log.info({ route: row.id, slot, server: safeHost(url) }, 'Guest route added (custom server)');
      if (auto) this.autoStart(run);
      return this.view(run, profileId, true);
    }
    if (body.kind === 'profile') {
      const feed = body.feed;
      if (feed !== 'landscape' && feed !== 'vertical') throw new GuestRouteError(400, 'invalid', 'Input: landscape or vertical.');
      const target = this.opts.profiles.get(body.profileId);
      if (!target) throw new GuestRouteError(404, 'unknown_profile', 'Target profile not found.');
      if (mine.filter((r) => r.row.kind === 'profile').length >= MAX_PROFILE_ROUTES_PER_GUEST) {
        throw new GuestRouteError(409, 'limit', `A guest feed can be set as the input of at most ${MAX_PROFILE_ROUTES_PER_GUEST} profiles. Remove one first.`);
      }
      if (mine.some((r) => r.row.kind === 'profile' && r.row.targetProfileId === target.id && r.row.targetFeed === feed)) {
        throw new GuestRouteError(409, 'exists', `This guest feed is already set as ${feedLabel(feed)} of "${target.name}".`);
      }
      const name = this.name(body.name, `${target.name} · ${feedLabel(feed)}`);
      const row = this.opts.repo.create({ slot, kind: 'profile', name, url: null, targetProfileId: target.id, targetFeed: feed, auto });
      const run = this.newRun(row);
      this.runs.set(row.id, run);
      this.log.info({ route: row.id, slot, targetProfileId: target.id, feed }, 'Guest route added (profile input)');
      if (auto) this.autoStart(run);
      return this.view(run, profileId, true);
    }
    throw new GuestRouteError(400, 'invalid', 'kind: rtmp or profile.');
  }

  async update(profileId: string, slot: string, routeId: string, patch: UpdateGuestRouteRequest): Promise<GuestRoute> {
    const run = this.require(profileId, slot, routeId);
    const next: Partial<Pick<GuestRouteRow, 'name' | 'url' | 'auto'>> = {};
    if (patch.name !== undefined) next.name = this.name(patch.name, run.row.name);
    if (patch.auto !== undefined) next.auto = patch.auto === true;
    const urlChanged = patch.url !== undefined || patch.streamKey !== undefined;
    if (urlChanged) {
      if (run.row.kind !== 'rtmp') throw new GuestRouteError(400, 'invalid', 'Only a custom server route has a URL and stream key.');
      if (run.active) throw new GuestRouteError(409, 'route_active', 'Stop the route before changing its server or key.');
      const url = patch.url !== undefined ? String(patch.url).trim() : (run.row.url ?? '');
      const scope = this.opts.secrets.scoped(guestRouteSecretScope(routeId));
      const key = patch.streamKey === undefined ? ((await scope.get('streamKey')) ?? '') : (patch.streamKey ?? '').trim();
      await this.checkTarget(url, key || null);
      next.url = url;
      if (patch.streamKey !== undefined) {
        if (key) await scope.set('streamKey', key);
        else await scope.delete('streamKey');
        this.hasKey.set(routeId, Boolean(key));
      }
    }
    run.row = this.opts.repo.update(routeId, next) ?? run.row;
    if (next.auto === true && !run.active) this.autoStart(run);
    return this.view(run, profileId, true);
  }

  async remove(profileId: string, slot: string, routeId: string): Promise<void> {
    const run = this.require(profileId, slot, routeId);
    this.refuseWhileLive(run, 'remove');
    await this.halt(run, 'idle', null);
    this.runs.delete(routeId);
    this.opts.repo.delete(routeId);
    this.opts.secrets.deleteScope(guestRouteSecretScope(routeId));
    this.log.info({ route: routeId, slot }, 'Guest route removed');
  }

  /** Start by hand. Refused (409) when the guest isn't sending, the target is refused, or the input is taken. */
  async start(profileId: string, slot: string, routeId: string): Promise<GuestRoute> {
    const run = this.require(profileId, slot, routeId);
    if (run.active) return this.view(run, profileId, true);
    this.refuseWhileLive(run, 'start');
    if (!this.opts.guests.feed(profileId, slot)?.online) {
      throw new GuestRouteError(409, 'feed_offline', "The guest isn't sending right now; a route can only run while they do.");
    }
    const why = await this.launch(run);
    if (why) {
      this.setState(run, 'idle', null);
      throw new GuestRouteError(409, why.code, why.message);
    }
    return this.view(run, profileId, true);
  }

  async stop(profileId: string, slot: string, routeId: string): Promise<GuestRoute> {
    const run = this.require(profileId, slot, routeId);
    if (!run.active) return this.view(run, profileId, true);
    this.refuseWhileLive(run, 'stop');
    await this.halt(run, 'idle', null);
    return this.view(run, profileId, true);
  }

  /** Server shutdown. */
  async stopAll(): Promise<void> {
    for (const run of this.runs.values()) {
      run.active = false;
      this.release(run);
    }
    await this.pushes.stopAll();
  }

  // ---- internals --------------------------------------------------------------

  private newRun(row: GuestRouteRow): Run {
    return { row, active: false, state: 'idle', message: null, since: null, bitrateKbps: null, publishKey: null, secrets: [] };
  }

  private ownerOf(slot: string): string | null {
    return this.opts.guests.profileOf(slot);
  }

  private guestFeedState(routeId: string): FeedState {
    const run = this.runs.get(routeId);
    const owner = run ? this.ownerOf(run.row.slot) : null;
    const s = run && owner ? this.opts.guests.state(owner, run.row.slot) : null;
    return { ...offlineFeedState('landscape', owner ?? DEFAULT_PROFILE_ID), ...(s ?? {}) } as FeedState;
  }

  /** Drop routes whose rows went (a profile or slot was deleted: ON DELETE CASCADE). */
  private sync(): void {
    const ids = new Set(this.opts.repo.all().map((r) => r.id));
    for (const [id, run] of this.runs) {
      if (ids.has(id)) continue;
      this.runs.delete(id);
      this.opts.secrets.deleteScope(guestRouteSecretScope(id));
      void this.halt(run, 'idle', null);
    }
  }

  private requireSlot(profileId: string, slot: string): void {
    if (!this.opts.guests.feed(profileId, slot)) throw new GuestRouteError(404, 'unknown_guest_feed', 'Guest feed not found');
  }

  private require(profileId: string, slot: string, routeId: string): Run {
    this.requireSlot(profileId, slot);
    this.sync();
    const run = this.runs.get(routeId);
    if (!run || run.row.slot !== slot) throw new GuestRouteError(404, 'unknown_route', 'Route not found');
    return run;
  }

  private name(raw: unknown, fallback: string): string {
    if (raw === undefined || raw === null || raw === '') return cleanRouteName(fallback) ?? 'Route';
    const name = cleanRouteName(raw);
    if (!name) throw new GuestRouteError(400, 'invalid', 'Name: 1–60 characters.');
    return name;
  }

  private async checkTarget(url: string, key: string | null): Promise<void> {
    const problem = await this.targetProblem(url, key);
    if (problem) throw new GuestRouteError(400, 'invalid_target', problem);
  }

  private targetProblem(url: string, key: string | null): Promise<string | null> {
    return routeTargetProblem(url, key, {
      allowLan: this.settings().allowLan,
      rtmpPort: this.opts.config.rtmpPort,
      selfHosts: this.opts.selfHosts?.() ?? [],
      ...(this.opts.lookup ? { lookup: this.opts.lookup } : {}),
      ...(this.opts.localAddresses ? { localAddresses: this.opts.localAddresses } : {}),
    });
  }

  private refuseWhileLive(run: Run, what: 'start' | 'stop' | 'remove'): void {
    if (run.row.kind !== 'profile' || !run.row.targetProfileId) return;
    if (!this.opts.isLive?.(run.row.targetProfileId)) return;
    const profile = this.opts.profiles.get(run.row.targetProfileId)?.name ?? run.row.targetProfileId;
    const verb = what === 'start' ? 'start' : what === 'stop' ? 'stop' : 'remove';
    throw new GuestRouteError(
      409,
      'session_live',
      `"${profile}" is live: Relay can't ${verb} a route into its ${feedLabel(run.row.targetFeed ?? 'landscape')} input without a cut on every destination. End the live first, or ${what === 'start' ? 'send the guest from OBS' : 'stop the guest sending'}.`,
    );
  }

  /** A profile input's own OBS feed is on, or another route holds it: why it can't be taken. */
  private inputConflict(run: Run): { code: string; message: string } | null {
    const pid = run.row.targetProfileId;
    const feed = run.row.targetFeed;
    if (!pid || !feed) return { code: 'invalid', message: 'This route has no target input.' };
    const profile = this.opts.profiles.get(pid);
    if (!profile) return { code: 'unknown_profile', message: 'The target profile no longer exists.' };
    const holder = this.inputs.get(inputKey(pid, feed));
    if (holder && holder !== run.row.id && this.runs.get(holder)?.active) {
      return { code: 'input_busy', message: `Another guest feed is already routed into ${feedLabel(feed)} of "${profile.name}". Stop that route first.` };
    }
    let online = false;
    try {
      online = this.media?.feed(pid, feed).online ?? false;
    } catch {
      online = false;
    }
    if (online && holder !== run.row.id) {
      return {
        code: 'input_busy',
        message: `OBS is already sending ${feedLabel(feed)} to "${profile.name}". Relay won't replace OBS's own feed: stop that output in OBS first, then start the route.`,
      };
    }
    return null;
  }

  private autoStart(run: Run): void {
    if (!run.row.auto || run.active) return;
    const owner = this.ownerOf(run.row.slot);
    if (!owner || !this.opts.guests.feed(owner, run.row.slot)?.online) return;
    void this.launch(run).then((why) => {
      if (why) this.setState(run, 'blocked', why.message);
    });
  }

  /** Start the push. Returns why it can't (nothing started), or null. */
  private async launch(run: Run): Promise<{ code: string; message: string } | null> {
    if (!this.media?.guestReadUrl) return { code: 'unavailable', message: 'Guest feeds are not available on this server.' };
    let plan: PushPlan;
    if (run.row.kind === 'rtmp') {
      const url = run.row.url ?? '';
      const key = ((await this.opts.secrets.scoped(guestRouteSecretScope(run.row.id)).get('streamKey')) ?? '').trim();
      const problem = await this.targetProblem(url, key || null);
      if (problem) return { code: 'invalid_target', message: problem };
      const full = joinIngestUrl(url, key);
      run.secrets = [full, ...(key ? [key] : [])];
      plan = { url: full, mode: 'copy', feeds: ['landscape'] };
    } else {
      const conflict = this.inputConflict(run);
      if (conflict) return conflict;
      const pid = run.row.targetProfileId!;
      const feed = run.row.targetFeed!;
      const profile = this.opts.profiles.get(pid)!;
      run.publishKey = generateKey();
      this.inputs.set(inputKey(pid, feed), run.row.id);
      const path = feedPath(feed, pid === DEFAULT_PROFILE_ID ? null : profile.slug);
      const url = `rtmp://127.0.0.1:${this.opts.config.rtmpPort}/${path}?key=${run.publishKey}`;
      run.secrets = [url, run.publishKey];
      plan = { url, mode: 'copy', feeds: ['landscape'] };
    }
    if (run.active) return null; // started meanwhile
    run.active = true;
    this.setState(run, 'starting', null);
    this.log.info({ route: run.row.id, slot: run.row.slot, kind: run.row.kind }, 'Guest route starting');
    this.pushes.start(run.row.id, plan);
    return null;
  }

  private release(run: Run): void {
    if (run.row.kind === 'profile' && run.row.targetProfileId && run.row.targetFeed) {
      const k = inputKey(run.row.targetProfileId, run.row.targetFeed);
      if (this.inputs.get(k) === run.row.id) this.inputs.delete(k);
    }
    run.publishKey = null;
  }

  /** Stop the push (if any) and settle in `state`. */
  private async halt(run: Run, state: GuestRouteState, message: string | null): Promise<void> {
    const was = run.active;
    run.active = false;
    this.release(run);
    this.setState(run, state, message);
    if (was || this.pushes.isRunning(run.row.id)) {
      this.log.info({ route: run.row.id, slot: run.row.slot }, 'Guest route stopping');
      await this.pushes.stop(run.row.id);
    }
  }

  private setState(run: Run, state: GuestRouteState, message: string | null): void {
    run.state = state;
    run.message = message === null ? null : this.scrub(run, message);
    if (state !== 'running') {
      run.since = null;
      run.bitrateKbps = null;
    }
  }

  private scrub(run: Run, text: string): string {
    return redactFragments(redactSecretsInText(text), run.secrets);
  }

  private onPush(ev: PushEvent): void {
    const run = this.runs.get(ev.id);
    if (!run || !run.active) return;
    switch (ev.status) {
      case 'starting':
        this.setState(run, 'starting', null);
        break;
      case 'running':
        if (run.state !== 'running') {
          run.state = 'running';
          run.message = ev.message === null ? null : this.scrub(run, ev.message);
          run.since = new Date(this.now()).toISOString();
        }
        run.bitrateKbps = ev.stats?.bitrateKbps ?? run.bitrateKbps;
        break;
      case 'retrying':
        this.setState(run, 'retrying', ev.message);
        break;
      case 'failed':
        run.active = false;
        this.release(run);
        this.setState(run, 'failed', ev.message);
        break;
      case 'stopped':
        break;
    }
  }

  private onGuestFeed(ev: GuestFeedEvent): void {
    const slot = ev.feed.slot;
    for (const run of this.runs.values()) {
      if (run.row.slot !== slot) continue;
      if (!ev.feed.online || ev.feed.key === 'revoked') {
        // Routes stop when the guest stops. A routed profile input goes offline like OBS stopping.
        if (run.active || run.state === 'blocked') void this.halt(run, 'idle', null);
      } else if (run.row.auto && !run.active && run.state !== 'failed') {
        this.autoStart(run);
      }
    }
  }

  private onGuestsChanged(ev: GuestFeedsChangedEvent): void {
    if (ev.removed.length === 0) return;
    this.sync();
  }

  private view(run: Run, profileId: string, admin: boolean): GuestRoute {
    const row = run.row;
    const target: GuestRoute['target'] =
      row.kind === 'rtmp'
        ? {
            kind: 'rtmp',
            host: safeHost(row.url ?? ''),
            ...(admin ? { url: row.url ?? '' } : {}),
            hasKey: this.hasKey.get(row.id) ?? false,
          }
        : {
            kind: 'profile',
            profileId: row.targetProfileId ?? '',
            profileName: row.targetProfileId ? (this.opts.profiles.get(row.targetProfileId)?.name ?? null) : null,
            feed: row.targetFeed ?? 'landscape',
          };
    return {
      id: row.id,
      slot: row.slot,
      profileId,
      name: row.name,
      target,
      auto: row.auto,
      active: run.active,
      state: run.state,
      message: run.message,
      since: run.state === 'running' ? run.since : null,
      bitrateKbps: run.state === 'running' ? run.bitrateKbps : null,
    };
  }

  /** Whether a stream key is stored, cached (secrets reads are async; views are sync). */
  private readonly hasKey = new Map<string, boolean>();
  private async refreshHasKey(routeId: string): Promise<void> {
    try {
      const v = await this.opts.secrets.scoped(guestRouteSecretScope(routeId)).get('streamKey');
      this.hasKey.set(routeId, Boolean(v));
    } catch {
      // keep the cached value
    }
  }

  /** Load key presence for every custom route (call once at startup, and after key changes). */
  async load(): Promise<void> {
    for (const run of this.runs.values()) if (run.row.kind === 'rtmp') await this.refreshHasKey(run.row.id);
  }
}

// ---- binding (like api/guest-feeds.ts bindGuestFeeds) --------------------------

const bound = new WeakMap<object, GuestRoutes>();

export function bindGuestRoutes(services: object, routes: GuestRoutes): void {
  bound.set(services, routes);
}

export function guestRoutesOf(services: object): GuestRoutes | null {
  return bound.get(services) ?? null;
}
