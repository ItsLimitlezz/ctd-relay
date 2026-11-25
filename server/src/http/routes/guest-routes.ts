// Guest feed routing for the web UI (docs/GUEST-FEEDS.md → Routing). Session cookie like every /api route.
//   GET    /api/profiles/:id/guest-routes                                [user]  this profile's routes + routes into its inputs
//   GET    /api/profiles/:id/guest-feeds/:slot/routes                    [user]  one guest feed's routes
//   POST   /api/profiles/:id/guest-feeds/:slot/routes                    [admin] add {kind:'rtmp',url,streamKey?,auto?} | {kind:'profile',profileId,feed,auto?}
//   PATCH  /api/profiles/:id/guest-feeds/:slot/routes/:route             [admin] {name?, url?, streamKey?, auto?}
//   DELETE /api/profiles/:id/guest-feeds/:slot/routes/:route             [admin]
//   POST   /api/profiles/:id/guest-feeds/:slot/routes/:route/start|stop  [admin]
//   GET    /api/guest-routes/settings, PUT {allowLan}                    [admin]
// Stream keys are write-only (never returned, never logged); the audit log names the route, not the key.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GUEST_ROUTE_ID_RE } from '../../../../shared/guest-routes.js';
import { GUEST_SLOT_RE } from '../../../../shared/guest-feeds.js';
import { CreateRouteBody, RouteSettingsBody, UpdateRouteBody, zodMessage } from '../../api/guest-routes-schema.js';
import { GuestRouteError, guestRoutesOf, type GuestRoutes } from '../../media/guest-routes.js';
import { audit, requireAdmin, requireUser, sendError, type RouteOptions } from '../guards.js';
import { HttpError } from '../validation.js';

const PROFILE_ID_MAX = 128;

const guestRouteRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof GuestRouteError || err instanceof HttpError) return sendError(reply, err.statusCode, err.message, err.code);
    if (err instanceof z.ZodError) return sendError(reply, 400, zodMessage(err), 'invalid');
    throw err;
  });

  const routes = (): GuestRoutes => {
    const r = guestRoutesOf(services);
    if (!r) throw new HttpError(503, 'Guest feed routing is not available on this server.', 'unavailable');
    return r;
  };
  const param = (req: FastifyRequest, name: string): string => {
    const v = (req.params as Record<string, unknown>)[name];
    return typeof v === 'string' ? v : '';
  };
  const profileId = (req: FastifyRequest): string => {
    const id = param(req, 'id');
    if (!id || id.length > PROFILE_ID_MAX || !services.repos.profiles.get(id)) throw new HttpError(404, 'Profile not found', 'unknown_profile');
    return id;
  };
  const slotId = (req: FastifyRequest): string => {
    const slot = param(req, 'slot');
    if (!GUEST_SLOT_RE.test(slot)) throw new HttpError(404, 'Guest feed not found', 'unknown_guest_feed');
    return slot;
  };
  const routeId = (req: FastifyRequest): string => {
    const id = param(req, 'route');
    if (!GUEST_ROUTE_ID_RE.test(id)) throw new HttpError(404, 'Route not found', 'unknown_route');
    return id;
  };
  const isAdmin = (req: FastifyRequest) => req.user?.role === 'admin';

  const base = '/api/profiles/:id/guest-feeds/:slot/routes';

  app.get('/api/profiles/:id/guest-routes', { preHandler: requireUser }, async (req, reply) => {
    const id = profileId(req);
    reply.header('cache-control', 'no-store');
    return routes().forProfile(id, isAdmin(req));
  });

  app.get(base, { preHandler: requireUser }, async (req, reply) => {
    const id = profileId(req);
    const slot = slotId(req);
    reply.header('cache-control', 'no-store');
    return { profileId: id, slot, routes: routes().list(id, slot, isAdmin(req)) };
  });

  app.post(base, { preHandler: requireAdmin }, async (req, reply) => {
    const id = profileId(req);
    const slot = slotId(req);
    const body = CreateRouteBody.parse(req.body ?? {});
    const route = await routes().create(id, slot, body);
    const target = route.target.kind === 'rtmp' ? `server=${route.target.host}` : `target=${route.target.profileId}/${route.target.feed}`;
    audit(services, req, 'guest.route.create', `route=${route.id} slot=${slot} profile=${id} ${target}`);
    reply.header('cache-control', 'no-store').code(201);
    return route;
  });

  app.patch(`${base}/:route`, { preHandler: requireAdmin }, async (req, reply) => {
    const id = profileId(req);
    const slot = slotId(req);
    const rid = routeId(req);
    const body = UpdateRouteBody.parse(req.body ?? {});
    const route = await routes().update(id, slot, rid, body);
    const changed = Object.keys(body).map((k) => (k === 'streamKey' ? 'key' : k));
    audit(services, req, 'guest.route.update', `route=${rid} slot=${slot} profile=${id} changed=${changed.join(',')}`);
    reply.header('cache-control', 'no-store');
    return route;
  });

  app.delete(`${base}/:route`, { preHandler: requireAdmin }, async (req, reply) => {
    const id = profileId(req);
    const slot = slotId(req);
    const rid = routeId(req);
    await routes().remove(id, slot, rid);
    audit(services, req, 'guest.route.delete', `route=${rid} slot=${slot} profile=${id}`);
    return reply.code(204).send();
  });

  for (const action of ['start', 'stop'] as const) {
    app.post(`${base}/:route/${action}`, { preHandler: requireAdmin }, async (req, reply) => {
      const id = profileId(req);
      const slot = slotId(req);
      const rid = routeId(req);
      const route = action === 'start' ? await routes().start(id, slot, rid) : await routes().stop(id, slot, rid);
      audit(services, req, `guest.route.${action}`, `route=${rid} slot=${slot} profile=${id}`);
      reply.header('cache-control', 'no-store');
      return route;
    });
  }

  app.get('/api/guest-routes/settings', { preHandler: requireAdmin }, async () => routes().settings());

  app.put('/api/guest-routes/settings', { preHandler: requireAdmin }, async (req) => {
    const body = RouteSettingsBody.parse(req.body ?? {});
    const next = routes().setSettings(body);
    audit(services, req, 'guest.route.settings', `allowLan=${next.allowLan}`);
    return next;
  });
};

export default guestRouteRoutes;
