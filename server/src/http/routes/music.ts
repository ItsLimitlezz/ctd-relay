// Settings → Spotify [admin]: the Spotify developer app (shared), and per profile (`?profile=`) the
// Spotify login and chat song request settings. See music/music-service.ts.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { DEFAULT_PROFILE_ID } from '../../../../shared/types.js';
import { musicFor } from '../../music/music-service.js';
import { audit, requireAdmin, sendError, type RouteOptions } from '../guards.js';
import { installErrorHandler, profileFromQuery } from '../validation.js';

const AppBody = z.strictObject({ clientId: z.string().max(64) });
const CompleteBody = z.strictObject({ pastedUrl: z.string().min(1).max(4096) });
const RequestsBody = z
  .strictObject({
    enabled: z.boolean(),
    who: z.enum(['everyone', 'subscribers', 'vips', 'moderators']),
    cooldownSec: z.number().int().min(0).max(3600),
    maxDurationSec: z.number().int().min(60).max(3600),
    allowExplicit: z.boolean(),
    chatReplies: z.boolean(),
  })
  .partial();

function issues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
}

const musicRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  installErrorHandler(app); // `?profile=` errors and the service's 400s
  const music = musicFor(services);
  const scoped = (profileId: string) => (profileId === DEFAULT_PROFILE_ID ? null : `profile=${profileId}`);

  app.get('/api/music', { preHandler: requireAdmin }, async (req, reply) => {
    return reply.header('cache-control', 'no-store').send(await music.status(profileFromQuery(services, req.query)));
  });

  app.put('/api/music/app', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = AppBody.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(reply, 400, issues(parsed.error), 'invalid');
    music.setClientId(parsed.data.clientId);
    audit(services, req, 'music.app_update', parsed.data.clientId.trim() ? 'Spotify Client ID set' : 'Spotify Client ID removed');
    return reply.header('cache-control', 'no-store').send(await music.status(profileFromQuery(services, req.query)));
  });

  app.post('/api/music/connect/start', { preHandler: requireAdmin }, async (req, reply) => {
    return reply.header('cache-control', 'no-store').send(await music.startConnect(profileFromQuery(services, req.query)));
  });

  app.post('/api/music/connect/complete', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = CompleteBody.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(reply, 400, issues(parsed.error), 'invalid');
    const profileId = profileFromQuery(services, req.query);
    const account = await music.completeConnect(profileId, parsed.data.pastedUrl);
    audit(services, req, 'music.connect', [`Spotify ${account.name}`, scoped(profileId)].filter(Boolean).join(', '));
    return reply.header('cache-control', 'no-store').send(await music.status(profileId));
  });

  app.delete('/api/music/connection', { preHandler: requireAdmin }, async (req, reply) => {
    const profileId = profileFromQuery(services, req.query);
    await music.disconnect(profileId);
    audit(services, req, 'music.disconnect', scoped(profileId));
    return reply.header('cache-control', 'no-store').send(await music.status(profileId));
  });

  app.put('/api/music/requests', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = RequestsBody.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(reply, 400, issues(parsed.error), 'invalid');
    const profileId = profileFromQuery(services, req.query);
    const next = music.updateRequestSettings(profileId, parsed.data);
    audit(services, req, 'music.requests_update', [`song requests ${next.enabled ? 'on' : 'off'} for ${next.who}`, scoped(profileId)].filter(Boolean).join(', '));
    return reply.header('cache-control', 'no-store').send(await music.status(profileId));
  });
};

export default musicRoutes;
