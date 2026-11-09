// Builds GET /api/v1/status (docs/API.md §4) from the orchestrator state + destinations repo.

import type {
  Destination,
  DestinationPhase,
  DestinationState,
  Feed,
  FeedState,
  PlatformInfo,
  SessionState,
} from '../../../shared/types.js';
import { requiredFeedsOf, waitingForFeedMessage } from '../orchestrator/feeds.js';
import type { ApiDestination, ApiFeed, ApiPlatform, ApiSession, ApiStatus } from './types.js';

/** Phases in which an enabled destination of a running session isn't reaching its platform. */
export const DOWN_PHASES: ReadonlySet<DestinationPhase> = new Set<DestinationPhase>(['error', 'retrying', 'recovering', 'waiting-for-feed']);
/**
 * Steps towards live that a retry passes through: still down while `retries` > 0, so a retry that
 * fails again doesn't flap down → up → down (the runner resets `retries` only once it is live).
 */
const RETRY_STEPS: ReadonlySet<DestinationPhase> = new Set<DestinationPhase>(['preparing', 'connecting', 'confirming']);

export interface StatusSources {
  /** orchestrator.state() */
  state(): SessionState;
  /** destinations repo, in display order */
  destinations(): Destination[];
  /** Platform info (null when unknown) — tells whether test mode skips the platform. */
  platformInfo(platform: Destination['platform']): PlatformInfo | null;
}

type SessionLike = Pick<SessionState, 'status' | 'startedAt' | 'title' | 'autoGoLive' | 'testMode'>;

/** A usable viewer count (finite, ≥ 0), else null. */
function viewerCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Viewers across every platform: the sum of the counts that are known, null when none is. */
export function totalViewers(items: Iterable<{ viewers?: number | null }>): number | null {
  let total: number | null = null;
  for (const item of items) {
    const n = viewerCount(item.viewers);
    if (n !== null) total = (total ?? 0) + n;
  }
  return total;
}

export function apiSession(s: SessionLike, viewers: number | null = null): ApiSession {
  return {
    status: s.status,
    startedAt: s.startedAt,
    title: s.title,
    testMode: s.testMode === true,
    autoGoLive: s.autoGoLive,
    viewers,
  };
}

export function apiFeed(f: FeedState): ApiFeed {
  return {
    feed: f.feed,
    online: f.online,
    since: f.since,
    video: f.video,
    audio: f.audio,
    bitrateKbps: f.bitrateKbps,
  };
}

export function sessionRunning(s: Pick<SessionState, 'status'>): boolean {
  return s.status === 'live' || s.status === 'starting';
}

/** Test mode skips platforms without a private/test setting (PlatformInfo.testMode). */
export function skippedByTestMode(s: Pick<SessionState, 'testMode'>, info: PlatformInfo | null): boolean {
  return s.testMode === true && info?.testMode?.supported !== true;
}

export function isDown(
  s: Pick<SessionState, 'status' | 'testMode'>,
  dest: Pick<Destination, 'enabled'>,
  phase: DestinationPhase,
  info: PlatformInfo | null,
  retries = 0,
): boolean {
  const failing = DOWN_PHASES.has(phase) || (retries > 0 && RETRY_STEPS.has(phase));
  return sessionRunning(s) && dest.enabled && !skippedByTestMode(s, info) && failing;
}

export function apiDestination(
  dest: Destination,
  st: DestinationState | undefined,
  session: Pick<SessionState, 'status' | 'testMode'> & Partial<Pick<SessionState, 'feeds'>>,
  info: PlatformInfo | null,
): ApiDestination {
  let phase: DestinationPhase = st?.phase ?? (dest.enabled ? 'idle' : 'disabled');
  let waitingFor: Feed[] = phase === 'waiting-for-feed' ? [...(st?.waitingFor ?? [])] : [];
  let message = st?.message ?? null;
  // An enabled destination of a running session is never "idle": if its runner has not reported yet
  // (or reports a resting phase) while a feed it needs is offline, say so instead.
  if (phase === 'idle' && sessionRunning(session) && dest.enabled && !skippedByTestMode(session, info) && session.feeds) {
    const missing = requiredFeedsOf(dest).filter((f) => session.feeds?.find((x) => x.feed === f)?.online !== true);
    if (missing.length > 0) {
      phase = 'waiting-for-feed';
      waitingFor = missing;
      message = waitingForFeedMessage(missing);
    }
  }
  const viewers = viewerCount(st?.viewers);
  return {
    id: dest.id,
    name: dest.name,
    platform: dest.platform,
    feed: dest.feed,
    enabled: dest.enabled,
    phase,
    live: phase === 'live',
    down: isDown(session, dest, phase, info, st?.retries ?? 0),
    waitingFor,
    message,
    stats: st?.stats ?? null,
    viewers,
    watchUrl: st?.watchUrl ?? null,
    recoveries: st?.recoveries ?? 0,
    lastRecovery: st?.lastRecovery ?? null,
    since: st?.since ?? dest.updatedAt,
  };
}

/** One entry per platform with an enabled destination, in destination order. */
export function platformRollup(destinations: readonly ApiDestination[], title: string): ApiPlatform[] {
  const out = new Map<ApiPlatform['platform'], ApiPlatform>();
  for (const d of destinations) {
    if (!d.enabled) continue;
    let p = out.get(d.platform);
    if (!p) {
      p = { platform: d.platform, destinations: [], live: false, title, startedAt: null, viewers: null, error: null };
      out.set(d.platform, p);
    }
    p.destinations.push(d.id);
    if (d.live) {
      p.live = true;
      const since = Date.parse(d.since);
      if (Number.isFinite(since) && (p.startedAt === null || since < p.startedAt)) p.startedAt = since;
    }
    if (d.viewers !== null) p.viewers = (p.viewers ?? 0) + d.viewers;
    // The first down destination's own message; never an invented one (null when none has a message).
    if (d.down && p.error === null && d.message !== null) p.error = d.message;
  }
  return [...out.values()];
}

export function buildStatus(src: StatusSources): ApiStatus {
  const state = src.state();
  const byId = new Map(state.destinations.map((d) => [d.destinationId, d]));
  const destinations = src.destinations().map((d) => apiDestination(d, byId.get(d.id), state, src.platformInfo(d.platform)));
  return {
    session: apiSession(state, totalViewers(destinations)),
    feeds: state.feeds.map(apiFeed),
    destinations,
    platforms: platformRollup(destinations, state.title),
  };
}
