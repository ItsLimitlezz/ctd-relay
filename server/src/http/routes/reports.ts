// Stream reports for the web UI (docs/REPORTS.md). Reading is for every signed-in user; the
// settings and "forget this user" are admin-only and audited. The same read routes exist under
// /api/v1/reports for tokens with reports:read (api/v1-reports.ts).

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { reportsFor } from '../../reports/index.js';
import { registerReportRoutes } from '../../reports/routes.js';
import { audit, requireAdmin, requireUser, sendError, type RouteOptions } from '../guards.js';
import { installErrorHandler, profileFromQuery } from '../validation.js';

const settingsBody = z.strictObject({
  recording: z.boolean(),
  audience: z.boolean(),
  retentionDays: z.union([z.literal(0), z.literal(90), z.literal(365)]), // REPORT_RETENTION_CHOICES
});

const reportRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  installErrorHandler(app);
  const reports = () => reportsFor(services);

  registerReportRoutes(app, '/api/reports', {
    reports,
    preHandler: requireUser,
    profileOf(req) {
      const raw = (req.query as Record<string, unknown>).profile;
      if (raw === '*' || raw === 'all') return null;
      return profileFromQuery(services, req.query);
    },
    fail: (reply, status, code, message) => sendError(reply, status, message, code),
  });

  app.get('/api/reports/settings', { preHandler: requireUser }, async (_req, reply) => {
    const r = reports();
    return reply.header('cache-control', 'no-store').send({ settings: r.settings(), available: r.available, recording: r.recorder.activeSessionIds() });
  });

  app.put('/api/reports/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const body = settingsBody.parse(req.body ?? {});
    const r = reports();
    const before = r.settings();
    const saved = r.saveSettings(body);
    const changed = (Object.keys(saved) as (keyof typeof saved)[]).filter((k) => saved[k] !== before[k]);
    if (changed.length > 0) audit(services, req, 'reports.settings', changed.map((k) => `${k}=${String(saved[k])}`).join(', '));
    return reply.header('cache-control', 'no-store').send({ settings: saved, available: r.available, recording: r.recorder.activeSessionIds() });
  });

  app.delete('/api/reports/audience/users/:userId', { preHandler: requireAdmin }, async (req, reply) => {
    const userId = (req.params as { userId?: string }).userId ?? '';
    const r = reports();
    const user = userId.length <= 300 ? r.store.user(userId) : null;
    if (!user || !r.store.forgetUser(userId)) return sendError(reply, 404, 'No one with this id in the reports.', 'not_found');
    // The audit names the platform only: the point is to forget who it was.
    audit(services, req, 'reports.forget_user', `a ${user.platform} viewer`);
    return reply.code(204).send();
  });
};

export default reportRoutes;
