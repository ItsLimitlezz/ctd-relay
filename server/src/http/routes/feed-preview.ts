// Feed previews for the web UI (any logged-in user; session cookie, same as every /api route):
//   GET /api/profiles/:id/feeds/:feed/preview.jpg   one JPEG frame (the dashboard thumbnails)
//   GET /api/profiles/:id/feeds/:feed/live.m3u8     live preview: LL-HLS multivariant playlist
//   GET /api/profiles/:id/feeds/:feed/live/:file    its media playlists and fMP4 parts (`?v=<viewer>`)
// The browser sends the SameSite=Strict session cookie with every playlist and part request
// (same origin), so there is nothing secret in any URL. See docs/PREVIEW.md.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { isFeed, livePreviewOf, previewsOf, registerLiveRoutes } from '../../api/live.js';
import { requireUser, sendError, type RouteOptions } from '../guards.js';

const PROFILE_ID_MAX = 128;

const feedPreviewRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const base = '/api/profiles/:id/feeds/:feed';

  const profile = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const id = (req.params as Record<string, unknown>).id;
    if (typeof id !== 'string' || id.length === 0 || id.length > PROFILE_ID_MAX || !services.repos.profiles.get(id)) {
      void sendError(reply, 404, 'Profile not found', 'unknown_profile');
      return null;
    }
    return id;
  };

  app.get(`${base}/preview.jpg`, { preHandler: requireUser }, async (req, reply) => {
    const id = profile(req, reply);
    if (id === null) return reply;
    const feed = (req.params as Record<string, unknown>).feed;
    if (!isFeed(feed)) return sendError(reply, 404, 'Feed: landscape or vertical.', 'not_found');
    reply.header('cache-control', 'no-store');
    let preview;
    try {
      preview = await previewsOf(services).get(id, feed);
    } catch (err) {
      services.log.warn({ profileId: id, feed, error: err instanceof Error ? err.message : String(err) }, 'feed preview failed');
      reply.header('retry-after', '5');
      return sendError(reply, 503, "Couldn't take a preview of the feed right now.", 'unavailable');
    }
    if (!preview) return sendError(reply, 404, `The ${feed} feed is offline.`, 'feed_offline');
    return reply.type('image/jpeg').header('x-preview-at', new Date(preview.at).toISOString()).send(preview.jpeg);
  });

  registerLiveRoutes(app, {
    base,
    preHandler: requireUser,
    profile,
    // The auth session (its hashed id): a viewer id is no good in another browser.
    who: (req) => `session:${req.authSession?.id ?? ''}`,
    error: (reply, status, code, message) => sendError(reply, status, message, code),
    live: () => livePreviewOf(services),
  });
};

export default feedPreviewRoutes;
