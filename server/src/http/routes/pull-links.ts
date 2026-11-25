// Pull links for the web UI (docs/GUEST-FEEDS.md → Pull link, docs/API.md §18.9). Session cookie.
//   GET    /api/profiles/:id/pull-links                                 [user]  state of every link (no keys)
//   GET    /api/profiles/:id/guest-feeds/:slot/pull, …/feeds/:feed/pull  [admin] state + the link (no-store)
//   PUT    same {enabled}                                               [admin] on (new read key) / off (disconnects readers)
//   DELETE same                                                         [admin] revoke = off
//   POST   same + /rotate                                               [admin] new read key (disconnects readers)
// Keys are never logged; the audit log names the feed, never the key.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { describeTarget, profilePullLinks, PullBody, pullHost, pullLinksOf, pullTargetOf } from '../../api/pull-links.js';
import { PullLinkError, type PullLinks, type PullTarget } from '../../media/pull-links.js';
import { audit, requireAdmin, requireUser, sendError, type RouteOptions } from '../guards.js';
import { HttpError } from '../validation.js';

const PROFILE_ID_MAX = 128;

const pullLinkRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof PullLinkError || err instanceof HttpError) return sendError(reply, err.statusCode, err.message, err.code);
    if (err instanceof z.ZodError) return sendError(reply, 400, 'Body: {"enabled": true|false}.', 'invalid');
    throw err;
  });

  const pull = (): PullLinks => {
    const p = pullLinksOf(services);
    if (!p) throw new HttpError(503, 'Pull links are not available on this server.', 'unavailable');
    return p;
  };

  const profileId = (req: FastifyRequest): string => {
    const id = (req.params as Record<string, unknown>).id;
    if (typeof id !== 'string' || id.length === 0 || id.length > PROFILE_ID_MAX || !services.repos.profiles.get(id)) {
      throw new HttpError(404, 'Profile not found', 'unknown_profile');
    }
    return id;
  };

  const target = (req: FastifyRequest): PullTarget => {
    const t = pullTargetOf(services, req, profileId(req));
    if (t) return t;
    if ((req.params as Record<string, unknown>).slot !== undefined) throw new HttpError(404, 'Guest feed not found', 'unknown_guest_feed');
    throw new HttpError(404, 'Feed: landscape or vertical.', 'not_found');
  };

  const info = (req: FastifyRequest, t: PullTarget) => pull().info(t, pullHost(services, req), services.config.rtmpPort);

  app.get('/api/profiles/:id/pull-links', { preHandler: requireUser }, async (req, reply) => {
    const id = profileId(req);
    reply.header('cache-control', 'no-store');
    return profilePullLinks(services, pull(), id);
  });

  for (const base of ['/api/profiles/:id/guest-feeds/:slot/pull', '/api/profiles/:id/feeds/:feed/pull']) {
    app.get(base, { preHandler: requireAdmin }, async (req, reply) => {
      const t = target(req);
      reply.header('cache-control', 'no-store');
      return info(req, t);
    });

    app.put(base, { preHandler: requireAdmin }, async (req, reply) => {
      const t = target(req);
      const { enabled } = PullBody.parse(req.body ?? {});
      await pull().setEnabled(t, enabled);
      audit(services, req, enabled ? 'pull.enable' : 'pull.disable', describeTarget(t));
      reply.header('cache-control', 'no-store');
      return info(req, t);
    });

    app.delete(base, { preHandler: requireAdmin }, async (req, reply) => {
      const t = target(req);
      await pull().setEnabled(t, false);
      audit(services, req, 'pull.revoke', describeTarget(t));
      return reply.code(204).send();
    });

    app.post(`${base}/rotate`, { preHandler: requireAdmin }, async (req, reply) => {
      const t = target(req);
      await pull().rotate(t);
      audit(services, req, 'pull.rotate', describeTarget(t));
      reply.header('cache-control', 'no-store');
      return info(req, t);
    });
  }
};

export default pullLinkRoutes;
