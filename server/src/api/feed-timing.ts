// Feed timing (docs/API.md §19, v1.18): GET /profiles/{id}/timing and the feed.timing events, for
// CTD OBS to line up feeds that arrive with different delays. The measuring is media/feed-timing.ts;
// this file binds it to the services (MediaMTX read URLs, guest slots, the API event hub).

import type { FastifyInstance } from 'fastify';
import type { Feed } from '../../../shared/types.js';
import { DEFAULT_FEED_TIMING_MAX, FeedTimingService, ffmpegTimingReaders, type ApiFeedTiming, type TimingFeedRef } from '../media/feed-timing.js';
import type { AppServices } from '../services.js';
import { eventHubFor } from './event-hub.js';
import { guestFeedsOf } from './guest-feeds.js';
import { params, sendProblem } from './http.js';
import type { V1Context } from './v1.js';

const services2timing = new WeakMap<object, FeedTimingService>();

/** Test seam: these services' feed timing service. */
export function bindFeedTiming(services: object, timing: FeedTimingService): void {
  services2timing.set(services, timing);
}

const FEEDS: readonly Feed[] = ['landscape', 'vertical'];

/** The feed timing service of these services (built on first use; nothing runs until an app asks). */
export function feedTimingOf(services: AppServices): FeedTimingService {
  let s = services2timing.get(services);
  if (!s) {
    const log = services.log.child({ mod: 'feed-timing' });
    s = new FeedTimingService({
      feeds: (profileId) => timingFeeds(services, profileId),
      profiles: () => services.repos.profiles.list().map((p) => p.id),
      readUrl: (profileId, ref) => {
        try {
          if (ref.feed === 'guest') return ref.slot ? (services.media.guestReadUrl?.(ref.slot) ?? null) : null;
          return services.media.readUrl(profileId, ref.feed);
        } catch {
          return null;
        }
      },
      emit: (profileId, timing: ApiFeedTiming) => eventHubFor(services).transient('feed.timing', profileId, timing),
      readers: ffmpegTimingReaders({ ffmpegBin: services.config.ffmpegBin }),
      max: services.config.feedTimingMax ?? DEFAULT_FEED_TIMING_MAX,
      log,
    });
    services2timing.set(services, s);
  }
  return s;
}

/** A profile's feeds: landscape, vertical, then its guest slots ([] when the profile is unknown). */
export function timingFeeds(services: AppServices, profileId: string): TimingFeedRef[] {
  const out: TimingFeedRef[] = [];
  try {
    for (const feed of FEEDS) out.push({ id: feed, feed, slot: null, name: null, online: services.media.feed(profileId, feed).online });
  } catch {
    return [];
  }
  const guests = guestFeedsOf(services);
  if (guests) {
    for (const g of guests.list(profileId).guestFeeds) out.push({ id: `guest/${g.slot}`, feed: 'guest', slot: g.slot, name: g.name, online: g.online });
  }
  return out;
}

/** GET /profiles/{id}/timing (v1.18). */
export function registerFeedTimingApiRoutes(app: FastifyInstance, ctx: V1Context): void {
  const { services, requireToken, authOf, resolveProfile } = ctx;

  app.addHook('onClose', async () => {
    services2timing.get(services)?.close();
  });

  app.get('/profiles/:id/timing', { preHandler: requireToken('status:read') }, async (req, reply) => {
    const raw = params(req).id;
    if (typeof raw !== 'string' || raw === '') return sendProblem(reply, 404, 'unknown_profile', 'No profile with this id (see GET /api/v1/profiles).');
    const p = resolveProfile(authOf(req).token, raw, null);
    if (!p.ok) return sendProblem(reply, p.status, p.code, p.detail);
    if (p.profile === null) return sendProblem(reply, 404, 'unknown_profile', 'No profile with this id (see GET /api/v1/profiles).');
    return reply.header('cache-control', 'no-store').send(feedTimingOf(services).read(p.profile));
  });
}
