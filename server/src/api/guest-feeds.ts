// Guest feeds (docs/API.md §18): the read routes of the external API, and the services both route
// families share (the web UI's in http/routes/guest-feeds.ts). The LL-HLS player and the JPEG
// thumbnails are the live preview's machinery (media/live-preview.ts, previews.ts) keyed by slot id
// instead of feed, with the guest feeds' own viewer cap.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { GUEST_SLOT_RE, type GuestIngestInfo } from '../../../shared/guest-feeds.js';
import { guestFeedProblem } from '../../../shared/feed-codec.js';
import type { GuestFeeds } from '../media/guest-feeds.js';
import { LivePreviewService } from '../media/live-preview.js';
import { GUEST_APP_NAME } from '../media/paths.js';
import type { AppServices } from '../services.js';
import { params, sendProblem } from './http.js';
import { registerLiveRoutes } from './live.js';
import { grabWithFfmpeg, PreviewService } from './previews.js';
import type { V1Context } from './v1.js';
import { srtPublishUrlFromStreamKey, srtStatusOff, type SrtStatus } from '../../../shared/srt.js';
import { srtlaEndpointFromStreamKey, srtlaStatusOff, type SrtlaStatus } from '../../../shared/srtla.js';

const bound = new WeakMap<object, GuestFeeds>();
const lives = new WeakMap<object, LivePreviewService<string>>();
const previews = new WeakMap<object, PreviewService<string>>();

/** main.ts (and tests) hand the services their guest feeds. */
export function bindGuestFeeds(services: object, guests: GuestFeeds): void {
  bound.set(services, guests);
}

/** These services' guest feeds, or null when none were bound (guest feed routes answer 503). */
export function guestFeedsOf(services: object): GuestFeeds | null {
  return bound.get(services) ?? null;
}

/** The slot id of a request (`:slot`) when it is one of this profile's slots, else null. */
export function slotOf(guests: GuestFeeds, req: FastifyRequest, profileId: string): string | null {
  const slot = (req.params as Record<string, unknown> | undefined)?.slot;
  if (typeof slot !== 'string' || !GUEST_SLOT_RE.test(slot)) return null;
  return guests.feed(profileId, slot) ? slot : null;
}

/** Test seam: the guest feeds' LL-HLS service (default: built from MediaMTX on first use). */
export function bindGuestLive(services: object, live: LivePreviewService<string>): void {
  lives.set(services, live);
}

/** LL-HLS players for guest feeds (one service per AppServices, its own viewer cap). */
export function guestLiveOf(services: AppServices, guests: GuestFeeds): LivePreviewService<string> {
  let s = lives.get(services);
  if (!s) {
    const log = services.log.child({ mod: 'guest-live' });
    s = new LivePreviewService<string>({
      feed: (profileId, slot) => guests.state(profileId, slot) ?? { online: false, video: null, audio: null },
      source: (_profileId, slot) => services.media.guestHlsSource?.(slot) ?? null,
      problem: (state, slot) => guestFeedProblem(state, guests.nameOf(slot) ?? slot),
      label: (slot) => `guest feed "${guests.nameOf(slot) ?? slot}"`,
      offlineReason: "the guest isn't sending",
      offMessage: 'Watching guest feeds is turned off on this server (GUEST_FEED_MAX_VIEWERS=0).',
      maxViewers: guests.limits.maxViewers,
      warn: (fields, msg) => log.warn(fields, msg),
    });
    lives.set(services, s);
  }
  return s;
}

/** JPEG thumbnails of guest feeds (FFmpeg grabs one keyframe, cached 2.5 s; nothing runs unasked). */
export function guestPreviewsOf(services: AppServices, guests: GuestFeeds): PreviewService<string> {
  let s = previews.get(services);
  if (!s) {
    s = new PreviewService<string>({
      online: (profileId, slot) => guests.state(profileId, slot)?.online ?? false,
      grab: (_profileId, slot) => {
        const url = services.media.guestReadUrl?.(slot);
        if (!url) return Promise.reject(new Error('guest feeds are not available'));
        return grabWithFfmpeg(services.config.ffmpegBin, url);
      },
    });
    previews.set(services, s);
  }
  return s;
}

/** rtmp://<host>:<port>/guest + `<slot>?key=<key>`: what a guest types into OBS or Larix (admin only). */
export function guestIngestInfo(
  serverHost: string,
  rtmpPort: number,
  profileId: string,
  slot: string,
  key: string | null,
  srt: SrtStatus = srtStatusOff('SRT is not available on this server.'),
  srtlaStatus: SrtlaStatus = srtlaStatusOff('SRTLA is not available on this server.'),
): GuestIngestInfo {
  const serverUrl = `rtmp://${serverHost}:${rtmpPort}/${GUEST_APP_NAME}`;
  const streamKey = key ? `${slot}?key=${key}` : null;
  const srtUrl = key && srt.enabled && srt.port ? srtPublishUrlFromStreamKey(serverHost, srt.port, GUEST_APP_NAME, streamKey!) : null;
  const srtla = key && srtlaStatus.enabled && srtlaStatus.port ? srtlaEndpointFromStreamKey(serverHost, srtlaStatus.port, GUEST_APP_NAME, streamKey!) : null;
  return { profileId, slot, serverUrl, streamKey, fullUrl: streamKey ? `${serverUrl}/${streamKey}` : null, srtUrl, srt, srtla, srtlaStatus };
}

/** GET /profiles/{id}/guest-feeds, …/{slot}/preview, …/{slot}/live.m3u8, …/{slot}/live/{file} (v1.17). */
export function registerGuestFeedApiRoutes(app: FastifyInstance, ctx: V1Context): void {
  const { services, requireToken, authOf, resolveProfile } = ctx;

  const pathProfile = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const raw = params(req).id;
    if (typeof raw !== 'string' || raw === '') {
      sendProblem(reply, 404, 'unknown_profile', 'No profile with this id (see GET /api/v1/profiles).');
      return null;
    }
    const p = resolveProfile(authOf(req).token, raw, null);
    if (!p.ok || p.profile === null) {
      if (!p.ok) sendProblem(reply, p.status, p.code, p.detail);
      return null;
    }
    return p.profile;
  };

  const guestsOr503 = (reply: FastifyReply): GuestFeeds | null => {
    const guests = guestFeedsOf(services);
    if (!guests) sendProblem(reply, 503, 'unavailable', 'Guest feeds are not available on this server.');
    return guests;
  };

  app.get('/profiles/:id/guest-feeds', { preHandler: requireToken('status:read') }, async (req, reply) => {
    const id = pathProfile(req, reply);
    if (id === null) return reply;
    const guests = guestsOr503(reply);
    if (!guests) return reply;
    return reply.header('cache-control', 'no-store').send(guests.list(id));
  });

  // ?access_token= is accepted too, like the feed previews (image loaders can't set headers).
  app.get('/profiles/:id/guest-feeds/:slot/preview', { preHandler: requireToken('status:read', true) }, async (req, reply) => {
    const id = pathProfile(req, reply);
    if (id === null) return reply;
    const guests = guestsOr503(reply);
    if (!guests) return reply;
    const slot = slotOf(guests, req, id);
    if (!slot) return sendProblem(reply, 404, 'unknown_guest_feed', 'No guest feed with this id on this profile (see GET /api/v1/profiles/{id}/guest-feeds).');
    reply.header('cache-control', 'no-store');
    let preview;
    try {
      preview = await guestPreviewsOf(services, guests).get(id, slot);
    } catch (err) {
      services.log.warn({ profileId: id, slot, error: err instanceof Error ? err.message : String(err) }, 'guest feed preview failed');
      reply.header('retry-after', '5');
      return sendProblem(reply, 503, 'unavailable', "Couldn't take a preview of the guest feed right now; retry in a few seconds.");
    }
    if (!preview) return sendProblem(reply, 404, 'feed_offline', "The guest feed is offline (the guest isn't sending).");
    return reply.type('image/jpeg').header('x-preview-at', new Date(preview.at).toISOString()).send(preview.jpeg);
  });

  registerLiveRoutes<string>(app, {
    base: '/profiles/:id/guest-feeds/:slot',
    preHandler: requireToken('feeds:watch'),
    filePreHandler: requireToken('feeds:watch', false, 'live'),
    profile: pathProfile,
    who: (req) => `token:${authOf(req).token.id}`,
    error: (reply, status, code, message) => sendProblem(reply, status, code, message),
    // key() answered 404 unless guest feeds are bound, so live() always has them.
    live: () => guestLiveOf(services, guestFeedsOf(services)!),
    key: (req, profileId) => {
      const guests = guestFeedsOf(services);
      return guests ? slotOf(guests, req, profileId) : null;
    },
    notFound: { code: 'unknown_guest_feed', message: 'No guest feed with this id on this profile (see GET /api/v1/profiles/{id}/guest-feeds).' },
  });
}
