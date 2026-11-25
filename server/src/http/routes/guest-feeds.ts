// Guest feeds for the web UI (docs/API.md §18, docs/GUEST-FEEDS.md). Session cookie like every /api route.
//   GET    /api/profiles/:id/guest-feeds                       [user]  slots + state (no keys)
//   POST   /api/profiles/:id/guest-feeds                       [admin] add a slot {name} → 201 { guestFeed, ingest }
//   PATCH  /api/profiles/:id/guest-feeds/:slot                 [admin] rename {name}
//   DELETE /api/profiles/:id/guest-feeds/:slot                 [admin] remove (disconnects its guest)
//   GET    /api/profiles/:id/guest-feeds/:slot/ingest          [admin] server URL + stream key (no-store)
//   POST   /api/profiles/:id/guest-feeds/:slot/rotate          [admin] new key (disconnects its guest) → ingest
//   POST   /api/profiles/:id/guest-feeds/:slot/revoke          [admin] no key (disconnects its guest) → slot
//   GET    /api/profiles/:id/guest-feeds/:slot/preview.jpg     [user]  thumbnail
//   GET    /api/profiles/:id/guest-feeds/:slot/live.m3u8, live/:file  [user] the LL-HLS player
// Keys are never logged, and the audit log names the slot, never the key.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GUEST_SLOT_RE } from '../../../../shared/guest-feeds.js';
import { guestFeedsOf, guestIngestInfo, guestLiveOf, guestPreviewsOf, slotOf } from '../../api/guest-feeds.js';
import { registerLiveRoutes } from '../../api/live.js';
import { GuestFeedError, type GuestFeeds } from '../../media/guest-feeds.js';
import type { AppServices } from '../../services.js';
import { audit, requireAdmin, requireUser, sendError, type RouteOptions } from '../guards.js';
import { ingestHost } from './ingest.js';
import { HttpError } from '../validation.js';
import { srtStatusOf } from '../../media/srt-status.js';

const PROFILE_ID_MAX = 128;
const NameBody = z.object({ name: z.string().max(200) });

const guestFeedRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof GuestFeedError || err instanceof HttpError) return sendError(reply, err.statusCode, err.message, err.code);
    if (err instanceof z.ZodError) return sendError(reply, 400, 'Name: 1–60 characters.', 'invalid');
    throw err;
  });

  const base = '/api/profiles/:id/guest-feeds';

  const guests = (): GuestFeeds => {
    const g = guestFeedsOf(services);
    if (!g) throw new HttpError(503, 'Guest feeds are not available on this server.', 'unavailable');
    return g;
  };

  const profileId = (req: FastifyRequest): string => {
    const id = (req.params as Record<string, unknown>).id;
    if (typeof id !== 'string' || id.length === 0 || id.length > PROFILE_ID_MAX || !services.repos.profiles.get(id)) {
      throw new HttpError(404, 'Profile not found', 'unknown_profile');
    }
    return id;
  };

  const slotId = (req: FastifyRequest): string => {
    const slot = (req.params as Record<string, unknown>).slot;
    if (typeof slot !== 'string' || !GUEST_SLOT_RE.test(slot)) throw new HttpError(404, 'Guest feed not found', 'unknown_guest_feed');
    return slot;
  };

  const ingestFor = async (req: FastifyRequest, profile: string, slot: string) =>
    guestIngestInfo(ingestHost(services.appSettings().ingestHost, req.hostname), services.config.rtmpPort, profile, slot, await guests().ingestKey(profile, slot), srtStatusOf(services.media));

  app.get(base, { preHandler: requireUser }, async (req, reply) => {
    const id = profileId(req);
    reply.header('cache-control', 'no-store');
    return guests().list(id);
  });

  app.post(base, { preHandler: requireAdmin }, async (req, reply) => {
    const id = profileId(req);
    const { name } = NameBody.parse(req.body ?? {});
    const guestFeed = await guests().create(id, name);
    audit(services, req, 'guest.create', `slot=${guestFeed.slot} profile=${id}`);
    reply.header('cache-control', 'no-store').code(201);
    return { guestFeed, ingest: await ingestFor(req, id, guestFeed.slot) };
  });

  app.patch(`${base}/:slot`, { preHandler: requireAdmin }, async (req) => {
    const id = profileId(req);
    const slot = slotId(req);
    const { name } = NameBody.parse(req.body ?? {});
    const guestFeed = guests().rename(id, slot, name);
    audit(services, req, 'guest.rename', `slot=${slot} profile=${id}`);
    return guestFeed;
  });

  app.delete(`${base}/:slot`, { preHandler: requireAdmin }, async (req, reply) => {
    const id = profileId(req);
    const slot = slotId(req);
    await guests().remove(id, slot);
    audit(services, req, 'guest.delete', `slot=${slot} profile=${id}`);
    return reply.code(204).send();
  });

  app.get(`${base}/:slot/ingest`, { preHandler: requireAdmin }, async (req, reply) => {
    const id = profileId(req);
    const slot = slotId(req);
    reply.header('cache-control', 'no-store');
    return ingestFor(req, id, slot);
  });

  app.post(`${base}/:slot/rotate`, { preHandler: requireAdmin }, async (req, reply) => {
    const id = profileId(req);
    const slot = slotId(req);
    await guests().rotateKey(id, slot);
    audit(services, req, 'guest.rotate', `slot=${slot} profile=${id}`);
    reply.header('cache-control', 'no-store');
    return ingestFor(req, id, slot);
  });

  app.post(`${base}/:slot/revoke`, { preHandler: requireAdmin }, async (req, reply) => {
    const id = profileId(req);
    const slot = slotId(req);
    const guestFeed = await guests().revokeKey(id, slot);
    audit(services, req, 'guest.revoke', `slot=${slot} profile=${id}`);
    reply.header('cache-control', 'no-store');
    return guestFeed;
  });

  app.get(`${base}/:slot/preview.jpg`, { preHandler: requireUser }, async (req, reply) => {
    const id = profileId(req);
    const g = guests();
    const slot = slotOf(g, req, id);
    if (!slot) return sendError(reply, 404, 'Guest feed not found', 'unknown_guest_feed');
    reply.header('cache-control', 'no-store');
    let preview;
    try {
      preview = await guestPreviewsOf(services, g).get(id, slot);
    } catch (err) {
      services.log.warn({ profileId: id, slot, error: err instanceof Error ? err.message : String(err) }, 'guest feed preview failed');
      reply.header('retry-after', '5');
      return sendError(reply, 503, "Couldn't take a preview of the guest feed right now.", 'unavailable');
    }
    if (!preview) return sendError(reply, 404, 'The guest feed is offline.', 'feed_offline');
    return reply.type('image/jpeg').header('x-preview-at', new Date(preview.at).toISOString()).send(preview.jpeg);
  });

  const profile = (req: FastifyRequest, reply: FastifyReply): string | null => {
    try {
      return profileId(req);
    } catch {
      void sendError(reply, 404, 'Profile not found', 'unknown_profile');
      return null;
    }
  };

  registerLiveRoutes<string>(app, {
    base: `${base}/:slot`,
    preHandler: requireUser,
    profile,
    who: (req) => `session:${req.authSession?.id ?? ''}`,
    error: (reply, status, code, message) => sendError(reply, status, message, code),
    live: () => guestLiveOf(services as AppServices, guestFeedsOf(services)!),
    key: (req, id) => {
      const g = guestFeedsOf(services);
      return g ? slotOf(g, req, id) : null;
    },
    notFound: { code: 'unknown_guest_feed', message: 'Guest feed not found' },
  });
};

export default guestFeedRoutes;
