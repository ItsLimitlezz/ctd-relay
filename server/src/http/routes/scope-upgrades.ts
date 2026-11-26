// Settings → API [admin]: apps asking for more scopes for the token they already hold (scope
// upgrades, docs/API.md §9.3.1). Approving adds exactly the requested scopes to that token; its
// secret and profile never change. The app side lives in the external API (server/src/api/v1-hub.ts).

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ApproveScopeUpgradeResponse } from '../../../../shared/api.js';
import type { ScopeUpgradeRequest } from '../../../../shared/types.js';
import { audit, requireAdmin, sendError, type RouteOptions } from '../guards.js';
import { installErrorHandler, truncate } from '../validation.js';

const IdParams = z.object({ id: z.string().min(1).max(128) });

/** The app's name and reason come from the app: quote and bound them. */
const appLabel = (u: ScopeUpgradeRequest) => (u.appName !== null ? `${JSON.stringify(truncate(u.appName, 100))} ` : '');

const scopeUpgradeRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  installErrorHandler(app);

  // services.scopeUpgrades is wired by main.ts: always read it lazily.
  const find = (id: string): ScopeUpgradeRequest | null => services.scopeUpgrades.list().find((u) => u.id === id) ?? null;
  const gone = 'This request is gone (it expired or was answered)';

  app.get('/api/scope-upgrades', { preHandler: requireAdmin }, async (_req, reply): Promise<ScopeUpgradeRequest[]> => {
    reply.header('cache-control', 'no-store');
    return services.scopeUpgrades.list();
  });

  app.post('/api/scope-upgrades/:id/approve', { preHandler: requireAdmin }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 400, 'Invalid request id', 'invalid');
    if (!find(params.data.id)) return sendError(reply, 404, gone, 'not_found');
    // All or nothing: exactly the scopes the app asked for (no partial approval yet).
    const { upgrade, token } = services.scopeUpgrades.approve(params.data.id);
    audit(
      services,
      req,
      'scope_upgrade.approve',
      `${appLabel(upgrade)}token=${token.prefix}… adding=${upgrade.adding.join(', ')} scopes=${token.scopes.join(', ')}`,
    );
    const response: ApproveScopeUpgradeResponse = { token };
    return reply.header('cache-control', 'no-store').send(response);
  });

  app.post('/api/scope-upgrades/:id/deny', { preHandler: requireAdmin }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 400, 'Invalid request id', 'invalid');
    if (!find(params.data.id)) return sendError(reply, 404, gone, 'not_found');
    const upgrade = services.scopeUpgrades.deny(params.data.id);
    audit(services, req, 'scope_upgrade.deny', `${appLabel(upgrade)}token=${upgrade.tokenPrefix}… adding=${upgrade.adding.join(', ')}`);
    return {};
  });
};

export default scopeUpgradeRoutes;
