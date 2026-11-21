// Stream reports for API tokens (v1.13, docs/API.md §16, docs/REPORTS.md): read-only, behind the
// reports:read scope. A token limited to one profile sees that profile's streams only; an
// every-profile token sees every profile unless it asks for one (`?profile=`).

import type { FastifyInstance } from 'fastify';
import { reportsFor } from '../reports/index.js';
import { registerReportRoutes } from '../reports/routes.js';
import { sendProblem } from './http.js';
import type { V1Context } from './v1.js';

export function registerReportApiRoutes(app: FastifyInstance, ctx: V1Context): void {
  const { services, requireToken, authOf, resolveProfileView } = ctx;
  registerReportRoutes(app, '/reports', {
    reports: () => reportsFor(services),
    preHandler: requireToken('reports:read'),
    profileOf(req, reply) {
      const { token } = authOf(req);
      const r = resolveProfileView(token, (req.query as Record<string, unknown>).profile, null);
      if (!r.ok) {
        void sendProblem(reply, r.status, r.code, r.detail);
        return undefined;
      }
      return r.profile;
    },
    fail: (reply, status, code, message) => sendProblem(reply, status, code, message),
  });
}
