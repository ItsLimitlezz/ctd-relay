// Guest feed routing in the external API (docs/API.md §18.8, API 1.17 additive). Reading needs
// `status:read` (never a key, never a custom server's path); managing routes needs `system:admin`
// (a token for every profile, made by an admin). Every change is audited without the key.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiTokenInfo } from '../../../shared/types.js';
import { GUEST_ROUTE_ID_RE } from '../../../shared/guest-routes.js';
import { GUEST_SLOT_RE } from '../../../shared/guest-feeds.js';
import { GuestRouteError, guestRoutesOf, type GuestRoutes } from '../media/guest-routes.js';
import { CreateRouteBody, UpdateRouteBody, zodMessage } from './guest-routes-schema.js';
import { params, sendProblem, type ProblemCode } from './http.js';
import type { V1Context } from './v1.js';

export function registerGuestRouteApiRoutes(app: FastifyInstance, ctx: V1Context): void {
  const { services, requireToken, authOf, resolveProfile } = ctx;
  const admin = requireToken('system:admin');

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
  const routesOr503 = (reply: FastifyReply): GuestRoutes | null => {
    const r = guestRoutesOf(services);
    if (!r) sendProblem(reply, 503, 'unavailable', 'Guest feed routing is not available on this server.');
    return r;
  };
  const slotOr404 = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const slot = params(req).slot;
    if (typeof slot === 'string' && GUEST_SLOT_RE.test(slot)) return slot;
    sendProblem(reply, 404, 'unknown_guest_feed', 'No guest feed with this id on this profile (see GET /api/v1/profiles/{id}/guest-feeds).');
    return null;
  };
  const routeOr404 = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const id = params(req).route;
    if (typeof id === 'string' && GUEST_ROUTE_ID_RE.test(id)) return id;
    sendProblem(reply, 404, 'unknown_route', 'No route with this id on this guest feed.');
    return null;
  };
  /** system:admin acts on the whole server: a token limited to one profile cannot use it. */
  const serverWide = (req: FastifyRequest, reply: FastifyReply): ApiTokenInfo | null => {
    const { token } = authOf(req);
    if (token.profileId === null || token.profileId === undefined) return token;
    void sendProblem(reply, 403, 'profile_forbidden', 'Managing guest routes needs a system:admin token that is not limited to one profile.');
    return null;
  };
  const audit = (req: FastifyRequest, token: ApiTokenInfo, action: string, detail: string): void => {
    services.repos.audit.log({ userId: null, username: null, action, detail: `${detail}, by API token ${JSON.stringify(token.name)} (${token.prefix}…)`, ip: req.ip ?? null });
  };
  const fail = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof GuestRouteError) return sendProblem(reply, err.statusCode, err.code as ProblemCode, err.message);
    if (err instanceof z.ZodError) return sendProblem(reply, 400, 'invalid', zodMessage(err));
    throw err;
  };

  app.get('/profiles/:id/guest-routes', { preHandler: requireToken('status:read') }, async (req, reply) => {
    const id = pathProfile(req, reply);
    if (id === null) return reply;
    const routes = routesOr503(reply);
    if (!routes) return reply;
    return reply.header('cache-control', 'no-store').send(routes.forProfile(id, false));
  });

  app.get('/profiles/:id/guest-feeds/:slot/routes', { preHandler: requireToken('status:read') }, async (req, reply) => {
    const id = pathProfile(req, reply);
    if (id === null) return reply;
    const routes = routesOr503(reply);
    if (!routes) return reply;
    const slot = slotOr404(req, reply);
    if (!slot) return reply;
    try {
      return reply.header('cache-control', 'no-store').send({ profileId: id, slot, routes: routes.list(id, slot, false) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Common prelude of the admin routes: token, profile, routes, slot (and route). */
  const adminCtx = (req: FastifyRequest, reply: FastifyReply, withRoute: boolean) => {
    const token = serverWide(req, reply);
    if (!token) return null;
    const id = pathProfile(req, reply);
    if (id === null) return null;
    const routes = routesOr503(reply);
    if (!routes) return null;
    const slot = slotOr404(req, reply);
    if (!slot) return null;
    const route = withRoute ? routeOr404(req, reply) : '';
    if (route === null) return null;
    return { token, id, routes, slot, route };
  };

  app.post('/profiles/:id/guest-feeds/:slot/routes', { preHandler: admin }, async (req, reply) => {
    const c = adminCtx(req, reply, false);
    if (!c) return reply;
    try {
      const route = await c.routes.create(c.id, c.slot, CreateRouteBody.parse(req.body ?? {}));
      const target = route.target.kind === 'rtmp' ? `server=${route.target.host}` : `target=${route.target.profileId}/${route.target.feed}`;
      audit(req, c.token, 'guest.route.create', `route=${route.id} slot=${c.slot} profile=${c.id} ${target}`);
      // The external API never returns a custom server's path: strip what the admin view adds.
      return reply.code(201).header('cache-control', 'no-store').send(c.routes.get(c.id, c.slot, route.id, false));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch('/profiles/:id/guest-feeds/:slot/routes/:route', { preHandler: admin }, async (req, reply) => {
    const c = adminCtx(req, reply, true);
    if (!c) return reply;
    try {
      const body = UpdateRouteBody.parse(req.body ?? {});
      await c.routes.update(c.id, c.slot, c.route, body);
      audit(req, c.token, 'guest.route.update', `route=${c.route} slot=${c.slot} profile=${c.id} changed=${Object.keys(body).map((k) => (k === 'streamKey' ? 'key' : k)).join(',')}`);
      return reply.header('cache-control', 'no-store').send(c.routes.get(c.id, c.slot, c.route, false));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete('/profiles/:id/guest-feeds/:slot/routes/:route', { preHandler: admin }, async (req, reply) => {
    const c = adminCtx(req, reply, true);
    if (!c) return reply;
    try {
      await c.routes.remove(c.id, c.slot, c.route);
      audit(req, c.token, 'guest.route.delete', `route=${c.route} slot=${c.slot} profile=${c.id}`);
      return reply.code(204).send();
    } catch (err) {
      return fail(reply, err);
    }
  });

  for (const action of ['start', 'stop'] as const) {
    app.post(`/profiles/:id/guest-feeds/:slot/routes/:route/${action}`, { preHandler: admin }, async (req, reply) => {
      const c = adminCtx(req, reply, true);
      if (!c) return reply;
      try {
        if (action === 'start') await c.routes.start(c.id, c.slot, c.route);
        else await c.routes.stop(c.id, c.slot, c.route);
        audit(req, c.token, `guest.route.${action}`, `route=${c.route} slot=${c.slot} profile=${c.id}`);
        return reply.header('cache-control', 'no-store').send(c.routes.get(c.id, c.slot, c.route, false));
      } catch (err) {
        return fail(reply, err);
      }
    });
  }
}
