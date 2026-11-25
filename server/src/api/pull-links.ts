// Pull links in the external API (docs/API.md §18.9, API 1.17 additive) and the helpers both route
// families share (the web UI's in http/routes/pull-links.ts). Reading the state (on/off, readers)
// needs `status:read` and never shows a key; the link itself and managing it need `system:admin`
// (a token for every profile). Every change is audited without the key.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GUEST_SLOT_RE } from '../../../shared/guest-feeds.js';
import { FEEDS, type ApiTokenInfo, type Feed } from '../../../shared/types.js';
import type { ProfilePullLinks } from '../../../shared/pull-links.js';
import { ingestHost } from '../http/routes/ingest.js';
import { PullLinkError, type PullLinks, type PullTarget } from '../media/pull-links.js';
import type { AppServices } from '../services.js';
import { guestFeedsOf } from './guest-feeds.js';
import { params, sendProblem, type ProblemCode } from './http.js';
import type { V1Context } from './v1.js';
import { srtStatusOf } from '../media/srt-status.js';

const bound = new WeakMap<object, PullLinks>();

/** main.ts (and tests) hand the services their pull links. */
export function bindPullLinks(services: object, pull: PullLinks): void {
  bound.set(services, pull);
}

export function pullLinksOf(services: object): PullLinks | null {
  return bound.get(services) ?? null;
}

export const PullBody = z.object({ enabled: z.boolean() }).strict();

/** A profile's pull link state (every guest feed of it + its own two feeds), no keys. */
export function profilePullLinks(services: object, pull: PullLinks, profileId: string): ProfilePullLinks {
  const slots = guestFeedsOf(services)?.list(profileId).guestFeeds.map((g) => g.slot) ?? [];
  return pull.profile(profileId, slots);
}

/** The target of `…/guest-feeds/:slot/pull` or `…/feeds/:feed/pull`, or null (404). */
export function pullTargetOf(services: object, req: FastifyRequest, profileId: string): PullTarget | null {
  const p = (req.params ?? {}) as Record<string, unknown>;
  if (typeof p.slot === 'string') {
    if (!GUEST_SLOT_RE.test(p.slot)) return null;
    return guestFeedsOf(services)?.feed(profileId, p.slot) ? { kind: 'guest', profileId, slot: p.slot } : null;
  }
  if (typeof p.feed === 'string' && (FEEDS as readonly string[]).includes(p.feed)) return { kind: 'feed', profileId, feed: p.feed as Feed };
  return null;
}

/** What OBS/VLC connect to: the ingest host setting, else the address the admin reached Relay at. */
export function pullHost(services: AppServices, req: FastifyRequest): string {
  return ingestHost(services.appSettings().ingestHost, req.hostname);
}

export function describeTarget(t: PullTarget): string {
  return t.kind === 'guest' ? `slot=${t.slot} profile=${t.profileId}` : `feed=${t.feed} profile=${t.profileId}`;
}

/** GET /profiles/{id}/pull-links [status:read]; GET|PUT|DELETE …/{guest-feeds/{slot}|feeds/{feed}}/pull, POST …/pull/rotate [system:admin]. */
export function registerPullLinkApiRoutes(app: FastifyInstance, ctx: V1Context): void {
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
  const pullOr503 = (reply: FastifyReply): PullLinks | null => {
    const pull = pullLinksOf(services);
    if (!pull) sendProblem(reply, 503, 'unavailable', 'Pull links are not available on this server.');
    return pull;
  };
  const serverWide = (req: FastifyRequest, reply: FastifyReply): ApiTokenInfo | null => {
    const { token } = authOf(req);
    if (token.profileId === null || token.profileId === undefined) return token;
    void sendProblem(reply, 403, 'profile_forbidden', 'Managing pull links needs a system:admin token that is not limited to one profile.');
    return null;
  };
  const audit = (req: FastifyRequest, token: ApiTokenInfo, action: string, detail: string): void => {
    services.repos.audit.log({ userId: null, username: null, action, detail: `${detail}, by API token ${JSON.stringify(token.name)} (${token.prefix}…)`, ip: req.ip ?? null });
  };
  const fail = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof PullLinkError) return sendProblem(reply, err.statusCode, err.code as ProblemCode, err.message);
    if (err instanceof z.ZodError) return sendProblem(reply, 400, 'invalid', 'Body: {"enabled": true|false}.');
    throw err;
  };

  /** Common prelude of the admin routes: token, profile, pull links, target. */
  const prelude = (req: FastifyRequest, reply: FastifyReply): { token: ApiTokenInfo; pull: PullLinks; target: PullTarget } | null => {
    const token = serverWide(req, reply);
    if (!token) return null;
    const id = pathProfile(req, reply);
    if (id === null) return null;
    const pull = pullOr503(reply);
    if (!pull) return null;
    const target = pullTargetOf(services, req, id);
    if (!target) {
      const slot = (req.params as Record<string, unknown>).slot !== undefined;
      void sendProblem(reply, 404, slot ? 'unknown_guest_feed' : 'not_found', slot ? 'No guest feed with this id on this profile.' : 'Feed: landscape or vertical.');
      return null;
    }
    return { token, pull, target };
  };

  app.get('/profiles/:id/pull-links', { preHandler: requireToken('status:read') }, async (req, reply) => {
    const id = pathProfile(req, reply);
    if (id === null) return reply;
    const pull = pullOr503(reply);
    if (!pull) return reply;
    return reply.header('cache-control', 'no-store').send(profilePullLinks(services, pull, id));
  });

  for (const base of ['/profiles/:id/guest-feeds/:slot/pull', '/profiles/:id/feeds/:feed/pull']) {
    app.get(base, { preHandler: admin }, async (req, reply) => {
      const c = prelude(req, reply);
      if (!c) return reply;
      try {
        return reply.header('cache-control', 'no-store').send(c.pull.info(c.target, pullHost(services, req), services.config.rtmpPort, srtStatusOf(services.media)));
      } catch (err) {
        return fail(reply, err);
      }
    });

    app.put(base, { preHandler: admin }, async (req, reply) => {
      const c = prelude(req, reply);
      if (!c) return reply;
      try {
        const { enabled } = PullBody.parse(req.body ?? {});
        await c.pull.setEnabled(c.target, enabled);
        audit(req, c.token, enabled ? 'pull.enable' : 'pull.disable', describeTarget(c.target));
        return reply.header('cache-control', 'no-store').send(c.pull.info(c.target, pullHost(services, req), services.config.rtmpPort, srtStatusOf(services.media)));
      } catch (err) {
        return fail(reply, err);
      }
    });

    app.delete(base, { preHandler: admin }, async (req, reply) => {
      const c = prelude(req, reply);
      if (!c) return reply;
      try {
        await c.pull.setEnabled(c.target, false);
        audit(req, c.token, 'pull.revoke', describeTarget(c.target));
        return reply.code(204).send();
      } catch (err) {
        return fail(reply, err);
      }
    });

    app.post(`${base}/rotate`, { preHandler: admin }, async (req, reply) => {
      const c = prelude(req, reply);
      if (!c) return reply;
      try {
        await c.pull.rotate(c.target);
        audit(req, c.token, 'pull.rotate', describeTarget(c.target));
        return reply.header('cache-control', 'no-store').send(c.pull.info(c.target, pullHost(services, req), services.config.rtmpPort, srtStatusOf(services.media)));
      } catch (err) {
        return fail(reply, err);
      }
    });
  }
}
