// What this machine can do (docs/TRANSCODING.md §4): the cached transcoding capability probe, for
// every signed-in user (Settings → About). Read-only; the probe itself starts in main.ts.

import type { FastifyPluginAsync } from 'fastify';
import { transcodeCapabilitiesFor } from '../../media/transcode-capabilities.js';
import { requireUser, type RouteOptions } from '../guards.js';

const systemRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  app.get('/api/system/transcode-capabilities', { preHandler: requireUser }, async (_req, reply) => {
    return reply.header('cache-control', 'no-store').send(transcodeCapabilitiesFor(services).get());
  });
};

export default systemRoutes;
