// Platforms (driver metadata) and per-platform developer-app credentials.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PlatformAppStatus } from '../../../../shared/api.js';
import { CHAT_DEBUG_BODY_LIMIT, CHAT_PACK_BODY_LIMIT, chatDebug, chatPackStatus, putChatPack, revertChatPack } from '../../platforms/instagram/chat-admin.js';
import type { PlatformDriver } from '../../platforms/types.js';
import type { AppServices } from '../../services.js';
import { audit, requireAdmin, requireUser, type RouteOptions } from '../guards.js';
import {
  badRequest,
  coerceField,
  findDriver,
  HttpError,
  installErrorHandler,
  isRecord,
  platformParams,
} from '../validation.js';

const putAppBody = z.object({
  values: z.record(z.string().max(100), z.string().max(4096)),
});

const appScope = (platform: string) => `app:${platform}`;

/** Stored developer-app values (string entries only). Unreadable data counts as empty. */
async function readAppValues(services: AppServices, driver: PlatformDriver): Promise<Record<string, string>> {
  try {
    const raw = await services.repos.secrets.scoped(appScope(driver.info.id)).getJson<unknown>('values');
    if (!isRecord(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch (err) {
    services.log.warn({ err, platform: driver.info.id }, 'could not read developer-app values');
    return {};
  }
}

async function appStatus(services: AppServices, driver: PlatformDriver): Promise<PlatformAppStatus> {
  const { info } = driver;
  const fields = info.developerApp?.fields ?? [];
  const stored = await readAppValues(services, driver);
  const values: Record<string, string> = {};
  const secretsSet: Record<string, boolean> = {};
  for (const f of fields) {
    const v = stored[f.key];
    if (f.type === 'secret') secretsSet[f.key] = Boolean(v);
    else if (v) values[f.key] = v;
  }
  return {
    platform: info.id,
    configured: fields.every((f) => !f.required || Boolean(stored[f.key])),
    values,
    secretsSet,
    redirectUri: info.connectMethod === 'oauth-paste' ? `${services.publicBaseUrl()}/oauth/callback/${info.id}` : null,
  };
}

const platformRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  installErrorHandler(app);

  app.get('/api/platforms', { preHandler: requireUser }, async () => services.platforms.all().map((d) => d.info));

  app.get('/api/platform-apps', { preHandler: requireAdmin }, async () => {
    const drivers = services.platforms.all().filter((d) => d.info.developerApp !== null);
    return Promise.all(drivers.map((d) => appStatus(services, d)));
  });

  app.put('/api/platform-apps/:platform', { preHandler: requireAdmin }, async (req) => {
    const { platform } = platformParams.parse(req.params);
    const driver = findDriver(services, platform);
    const spec = driver?.info.developerApp;
    if (!driver || !spec) throw new HttpError(404, `${platform} does not use a developer app`, 'not_found');
    const { values } = putAppBody.parse(req.body);

    const known = new Set(spec.fields.map((f) => f.key));
    for (const key of Object.keys(values)) {
      if (!known.has(key)) throw badRequest(`Unknown field: ${key}`);
    }

    const stored = await readAppValues(services, driver);
    const next: Record<string, string> = {};
    const changed: string[] = [];
    for (const field of spec.fields) {
      const prev = stored[field.key] ?? '';
      let value = prev; // absent = keep
      const submitted = Object.hasOwn(values, field.key) ? (values[field.key] ?? '').trim() : undefined;
      // Secrets are never sent back to the UI, so an empty secret means "keep the current one".
      if (submitted !== undefined && !(field.type === 'secret' && submitted === '')) {
        const coerced = coerceField(field, submitted);
        value = coerced === undefined ? '' : String(coerced);
      }
      if (value) next[field.key] = value;
      if (value !== prev) changed.push(field.key);
    }

    const scope = services.repos.secrets.scoped(appScope(platform));
    if (Object.keys(next).length > 0) await scope.setJson('values', next);
    else await scope.delete('values');
    // Field names only — never the values.
    if (changed.length > 0) audit(services, req, 'platform-app.update', `${platform}: ${changed.join(', ')}`);
    return appStatus(services, driver);
  });

  // ---- Instagram chat reader: selector pack + debug capture (Settings → Advanced) ----
  // The same operations exist in the external API for system:admin tokens (api/v1-platforms.ts).

  const PACK_PATH = '/api/platforms/instagram/chat/selector-pack';

  app.get(PACK_PATH, { preHandler: requireAdmin }, async (_req, reply) => {
    return reply.header('cache-control', 'no-store').send(chatPackStatus());
  });

  app.put(PACK_PATH, { preHandler: requireAdmin, bodyLimit: CHAT_PACK_BODY_LIMIT }, async (req, reply) => {
    const result = putChatPack(req.body, req.user?.username ?? null);
    if (!result.ok) throw badRequest(result.problems.join('; '));
    audit(services, req, 'instagram.chat_pack.update', result.summary);
    return reply.header('cache-control', 'no-store').send(result.status);
  });

  app.delete(PACK_PATH, { preHandler: requireAdmin }, async (req, reply) => {
    const { reverted, status } = revertChatPack();
    if (reverted) audit(services, req, 'instagram.chat_pack.revert', `back to the built-in pack ${status.builtinVersion}`);
    return reply.header('cache-control', 'no-store').send(status);
  });

  app.post('/api/platforms/instagram/chat/debug', { preHandler: requireAdmin, bodyLimit: CHAT_DEBUG_BODY_LIMIT }, async (req, reply) => {
    const result = await chatDebug(req.body);
    if (!result.ok) throw badRequest(result.problems.join('; '));
    audit(services, req, 'instagram.chat_debug', `sanitised capture of ${result.response.readers.length} live comment reader(s)`);
    return reply.header('cache-control', 'no-store').send(result.response);
  });
};

export default platformRoutes;
