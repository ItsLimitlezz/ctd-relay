// What this machine can do (docs/TRANSCODING.md §4): the cached transcoding capability probe, for
// every signed-in user (Settings → About / Transcoding), the admin's "check again", and the
// server-wide transcoding switch (settings key 'transcode'). The probe itself starts in main.ts.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { TranscodeSettingsResponse } from '../../../../shared/api.js';
import { MAX_WORKERS_LIMIT } from '../../../../shared/transcode.js';
import { transcodeCapabilitiesFor } from '../../media/transcode-capabilities.js';
import { readTranscodeSettings, TRANSCODE_SETTINGS_KEY } from '../../media/transcode-settings.js';
import type { AppServices } from '../../services.js';
import { audit, requireAdmin, requireUser, type RouteOptions } from '../guards.js';
import { installErrorHandler } from '../validation.js';

const settingsBody = z.strictObject({
  enabled: z.boolean().optional(),
  maxWorkers: z.number().int().min(1).max(MAX_WORKERS_LIMIT).optional(),
});

function transcodeResponse(services: AppServices): TranscodeSettingsResponse {
  return { settings: readTranscodeSettings(services.repos.settings), capabilities: transcodeCapabilitiesFor(services).get() };
}

const systemRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  installErrorHandler(app);

  app.get('/api/system/transcode-capabilities', { preHandler: requireUser }, async (_req, reply) => {
    return reply.header('cache-control', 'no-store').send(transcodeCapabilitiesFor(services).get());
  });

  // Run the probe again (new GPU passed through, driver fixed). Low-priority test encodes; streams
  // that are running keep their encoder. Answers when the probe finished.
  app.post('/api/system/transcode-capabilities/refresh', { preHandler: requireAdmin }, async (req, reply) => {
    const caps = await transcodeCapabilitiesFor(services).start();
    audit(services, req, 'transcode.recheck', caps.state === 'ready' ? `working=${caps.encoders.filter((e) => e.ok).map((e) => e.encoder).join(',') || 'none'}` : caps.state);
    return reply.header('cache-control', 'no-store').send(caps);
  });

  app.get('/api/system/transcode', { preHandler: requireUser }, async (_req, reply) => {
    return reply.header('cache-control', 'no-store').send(transcodeResponse(services));
  });

  // The switch applies to pushes that start afterwards: a running stream is never interrupted.
  app.put('/api/system/transcode', { preHandler: requireAdmin }, async (req, reply) => {
    const body = settingsBody.parse(req.body ?? {});
    const before = readTranscodeSettings(services.repos.settings);
    const next = { ...before, ...(body.enabled !== undefined ? { enabled: body.enabled } : {}), ...(body.maxWorkers !== undefined ? { maxWorkers: body.maxWorkers } : {}) };
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== before[k]);
    if (changed.length > 0) {
      services.repos.settings.set(TRANSCODE_SETTINGS_KEY, next);
      audit(services, req, 'transcode.settings', changed.map((k) => `${k}=${String(next[k])}`).join(', '));
    }
    return reply.header('cache-control', 'no-store').send(transcodeResponse(services));
  });
};

export default systemRoutes;
