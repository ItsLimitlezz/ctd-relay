// The OBS socket relay's API (obs-relay.ts, docs/API.md §12):
// - GET /api/v1/obs/socket (WebSocket, obs:control): the relay CTD Live mobile connects to from anywhere.
// - PUT /api/v1/apps/{appId}/obs-websocket (obs:write): the CTD OBS plugin reports OBS's WebSocket
//   settings (on, port, password, its LAN address) so nobody has to type them into Relay.

import net from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { classifyIp, normalizeIp } from '../tls/public-ip.js';
import { params, sendProblem } from './http.js';
import { APP_ID_RE } from './hub.js';
import { MAX_SOCKETS_PER_TOKEN, obsRelayFor } from './obs-relay.js';
import type { V1Context } from './v1.js';

const ObsWebSocketBody = z.strictObject({
  enabled: z.boolean(),
  port: z.number().int().min(1).max(65535),
  authRequired: z.boolean(),
  password: z.string().max(256).nullable().optional(),
  /** The OBS machine's LAN addresses, best first (the plugin knows them; Relay may only see a NAT). */
  addresses: z.array(z.string().max(64)).max(8).optional(),
});

/** OBS's LAN address: the first private address the plugin listed, else the request's own address if private. */
export function obsHostFrom(addresses: readonly string[] | undefined, requestIp: string | undefined): string | null {
  const isLan = (a: string) => net.isIP(a) !== 0 && classifyIp(a) === 'private';
  for (const a of addresses ?? []) {
    const ip = normalizeIp(a.trim());
    if (ip && isLan(ip)) return ip;
  }
  const own = requestIp ? normalizeIp(requestIp) : null;
  return own && isLan(own) ? own : null;
}

export function registerObsSocketRoute(app: FastifyInstance, ctx: V1Context): void {
  const { services } = ctx;
  const relay = obsRelayFor(services);

  const socketSlot = async (req: FastifyRequest, reply: FastifyReply) => {
    const { token } = ctx.authOf(req);
    if (relay.socketsFor(token.id) >= MAX_SOCKETS_PER_TOKEN) {
      reply.header('retry-after', '30');
      return sendProblem(reply, 429, 'rate_limited', `At most ${MAX_SOCKETS_PER_TOKEN} OBS sockets per token; close one first.`);
    }
  };

  app.get('/obs/socket', { websocket: true, preHandler: [ctx.requireToken('obs:control'), socketSlot] }, (socket, req) => {
    relay.accept(socket, ctx.authOf(req).token, req.ip ?? null);
  });

  app.put('/apps/:appId/obs-websocket', { preHandler: ctx.requireToken('obs:write'), bodyLimit: 4096 }, async (req, reply) => {
    const { token } = ctx.authOf(req);
    const id = params(req).appId;
    if (typeof id !== 'string' || !APP_ID_RE.test(id)) return sendProblem(reply, 400, 'invalid', 'App id: [a-z0-9-], 1 to 40 characters');
    const appRecord = services.apps.get(id);
    if (!appRecord) return sendProblem(reply, 404, 'not_found', `No app is registered as "${id}": register it first (PUT /api/v1/apps/${id}).`);
    if (appRecord.tokenId !== token.id) return sendProblem(reply, 409, 'app_owned', `"${id}" was registered by another token.`);
    const parsed = ObsWebSocketBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendProblem(reply, 400, 'invalid', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    }
    const body = parsed.data;
    const host = obsHostFrom(body.addresses, req.ip);
    const { changed } = await relay.reportFromPlugin({
      appId: id,
      appName: appRecord.name,
      enabled: body.enabled,
      port: body.port,
      authRequired: body.authRequired,
      ...(body.password !== undefined ? { password: body.password } : {}),
      host,
    });
    // Never log or audit the password itself; only what changed, and only when something did.
    if (changed.length > 0) {
      services.repos.audit.log({
        userId: null,
        username: null,
        action: 'obs_relay.plugin_update',
        detail: `OBS WebSocket settings from ${appRecord.name} (${id}): ${changed.join(', ')}`,
        ip: req.ip ?? null,
      });
      services.log.info({ appId: id, changed }, 'obs relay: OBS WebSocket settings updated by the plugin');
    }
    const status = await relay.status();
    return reply
      .header('cache-control', 'no-store')
      .send({ host: status.host ?? host, port: status.port, hasPassword: status.hasPassword, manualHost: status.host !== null });
  });

  app.addHook('preClose', async () => {
    relay.closeAll();
  });
}
