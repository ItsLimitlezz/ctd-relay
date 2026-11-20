// External API tokens (Settings → API) [admin]. The API itself lives under /api/v1 (server/src/api).
// Tokens are shared by every profile but may be limited to one (`profileId`; null = every profile).
// Also "Connect a phone": the one-time QR code CTD Live mobile scans (the claim is POST /api/v1/connect/claim),
// and "OBS on your computer": where the phone's OBS socket relay (/api/v1/obs/socket) finds OBS.

import fs from 'node:fs';
import net from 'node:net';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiTokensResponse, ConnectOfferResponse, ConnectOfferStatus, CreateApiTokenResponse } from '../../../../shared/api.js';
import { ADMIN_ONLY_SCOPES, API_SCOPES, type ApiScope } from '../../../../shared/types.js';
import { LAN_HTTP_HOST_ENV, LAN_HTTP_PORT_ENV, LAN_HTTP_PORT_SETTING, accessInfo, localIPv4Addresses, parsePortOverride } from '../../api/access.js';
import { connectOffersFor, connectUri, qrSvg } from '../../api/connect.js';
import { obsRelayFor } from '../../api/obs-relay.js';
import { classifyIp } from '../../tls/public-ip.js';
import type { AppServices } from '../../services.js';
import { lanClientPolicy } from '../../tls/http-listener.js';
import { audit, requireAdmin, sendError, type RouteOptions } from '../guards.js';
import { MAX_PROFILE_ID } from '../validation.js';

export const MAX_API_TOKENS = 100;
export const TOKEN_NAME_MAX = 60;

export const tokenNameSchema = z
  .string()
  .trim()
  .min(1, 'name is required')
  .max(TOKEN_NAME_MAX, `name: at most ${TOKEN_NAME_MAX} characters`);
export const scopesSchema = z
  .array(z.enum(API_SCOPES as [ApiScope, ...ApiScope[]]))
  .min(1, 'pick at least one scope')
  .max(API_SCOPES.length);
/** A profile id, or null = every profile. */
export const tokenProfileSchema = z.string().trim().min(1, 'profileId must be a profile id or null').max(MAX_PROFILE_ID).nullable();

const CreateBody = z.strictObject({
  name: tokenNameSchema,
  scopes: scopesSchema,
  profileId: tokenProfileSchema.optional(),
});
const IdParams = z.object({ id: z.string().min(1).max(64) });
const ConnectOfferBody = z.object({ profileId: tokenProfileSchema });

const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const ObsRelayBody = z.strictObject({
  /** null or '' = automatic (the address OBS streams to Relay from). */
  host: z
    .string()
    .trim()
    .max(253)
    .nullable()
    .transform((v) => (v ? v.replace(/^\[(.*)\]$/, '$1') : null))
    .refine((v) => v === null || net.isIP(v) !== 0 || HOSTNAME_RE.test(v), 'an IP address or host name, without http:// or a port'),
  port: z.number().int().min(1).max(65535),
  password: z.string().max(256).nullable().optional(),
});

/** A URL whose host is a private, loopback or link-local address (or a .local / localhost name). */
export function urlIsPrivate(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return true;
  }
  if (/^localhost$|\.local$|\.lan$|\.home\.arpa$/i.test(host)) return true;
  // CGNAT (100.64/10) isn't reachable from the internet either (and is what Tailscale uses).
  return ['private', 'cgnat', 'loopback', 'link-local', 'ula'].includes(classifyIp(host));
}

// C0/C1 controls and bidi overrides don't belong in a label shown in the UI and the audit log.
export const CONTROL_RE = /[\u{0}-\u{1F}\u{7F}-\u{9F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u;

/** Scopes in canonical order, each once. */
export function uniqueScopes(scopes: readonly ApiScope[]): ApiScope[] {
  return API_SCOPES.filter((s) => scopes.includes(s));
}

/** Audit wording for a token's profile binding. */
export function profileLabel(services: Pick<AppServices, 'repos'>, profileId: string | null): string {
  if (profileId === null) return 'every profile';
  const name = services.repos.profiles.get(profileId)?.name;
  return name ? `profile ${JSON.stringify(name)} (${profileId})` : `profile ${profileId}`;
}

let containerCache: boolean | null = null;
/** Docker (/.dockerenv) or Podman (/run/.containerenv): this machine's addresses aren't the LAN's. */
function inContainer(): boolean {
  if (containerCache === null) {
    try {
      containerCache = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
    } catch {
      containerCache = false;
    }
  }
  return containerCache;
}

function access(services: AppServices, req: FastifyRequest) {
  const { config } = services;
  return accessInfo({
    publicBaseUrl: services.publicBaseUrl(),
    fingerprint256: services.tls.status().fingerprint256,
    lan: {
      hostHeader: req.headers.host,
      secure: (req.raw.socket as { encrypted?: boolean } | undefined)?.encrypted === true,
      tlsMode: config.tlsMode,
      webPort: config.webPort,
      httpPort: config.httpPort,
      lanHttpPortOverride: parsePortOverride(process.env[LAN_HTTP_PORT_ENV], services.repos.settings.get<unknown>(LAN_HTTP_PORT_SETTING, null)),
      lanHttpHostOverride: process.env[LAN_HTTP_HOST_ENV] ?? null,
      lanHttpEnabled: lanClientPolicy(process.env).enabled,
      inContainer: inContainer(),
      localAddresses: localIPv4Addresses(),
    },
  });
}

const tokenRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const { repos } = services;

  app.get('/api/tokens', { preHandler: requireAdmin }, async (req, reply): Promise<ApiTokensResponse> => {
    reply.header('cache-control', 'no-store');
    return { tokens: repos.apiTokens.list(), access: access(services, req) };
  });

  app.post('/api/tokens', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 'invalid');
    }
    const { name, scopes } = parsed.data;
    if (CONTROL_RE.test(name)) return sendError(reply, 400, 'name: control characters are not allowed', 'invalid');
    const profileId = parsed.data.profileId ?? null;
    if (profileId !== null && !repos.profiles.get(profileId)) return sendError(reply, 404, 'Profile not found', 'unknown_profile');
    const adminOnly = scopes.filter((s) => ADMIN_ONLY_SCOPES.includes(s));
    if (profileId !== null && adminOnly.length > 0) {
      return sendError(reply, 400, `scopes: ${adminOnly.join(', ')} changes the whole server, so the token cannot be limited to one profile`, 'invalid');
    }
    if (repos.apiTokens.list().length >= MAX_API_TOKENS) {
      return sendError(reply, 409, `At most ${MAX_API_TOKENS} tokens; revoke unused ones first`, 'limit');
    }
    const created = repos.apiTokens.create({ name, scopes: uniqueScopes(scopes), createdBy: req.user?.username ?? null, profileId });
    // Never log or audit the secret itself.
    audit(
      services,
      req,
      'api_token.create',
      `${created.token.name} (${created.token.scopes.join(', ')}) ${profileLabel(services, created.token.profileId ?? null)} ${created.token.prefix}…`,
    );
    const body: CreateApiTokenResponse = { token: created.token, secret: created.secret };
    return reply.header('cache-control', 'no-store').send(body);
  });

  // ---- "Connect a phone": one-time QR code for CTD Live mobile (docs/API.md §11) ----

  const offers = connectOffersFor(services);

  app.post('/api/connect-offers', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = ConnectOfferBody.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'profileId: a profile id or null', 'invalid');
    const profileId = parsed.data.profileId;
    if (profileId !== null && !repos.profiles.get(profileId)) return sendError(reply, 404, 'Profile not found', 'unknown_profile');
    const info = access(services, req);
    const target = { apiUrl: info.baseUrl, lanApiUrl: info.lanBaseUrl, fingerprint256: info.tlsFingerprint256 };
    const offer = offers.create({ profileId, createdBy: req.user?.username ?? null });
    const uri = connectUri(target, offer.code);
    const body: ConnectOfferResponse = {
      id: offer.id,
      state: 'waiting',
      deviceName: null,
      expiresAt: offer.expiresAt,
      qrSvg: await qrSvg(uri),
      uri,
      apiUrl: target.apiUrl,
      lanApiUrl: target.lanApiUrl,
      apiUrlIsPrivate: urlIsPrivate(target.apiUrl),
    };
    // The code is a credential for 5 minutes: never logged or audited.
    audit(services, req, 'connect_offer.create', `QR code for a phone, ${profileLabel(services, profileId)}`);
    return reply.header('cache-control', 'no-store').send(body);
  });

  app.get('/api/connect-offers/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = IdParams.safeParse(req.params);
    if (!parsed.success) return sendError(reply, 400, 'Invalid offer id', 'invalid');
    const status = offers.status(parsed.data.id);
    if (!status) return sendError(reply, 404, 'No such QR code (it may have expired)', 'not_found');
    const body: ConnectOfferStatus = { id: parsed.data.id, ...status };
    return reply.header('cache-control', 'no-store').send(body);
  });

  app.delete('/api/connect-offers/:id', { preHandler: requireAdmin }, async (req) => {
    const parsed = IdParams.safeParse(req.params);
    if (parsed.success) offers.cancel(parsed.data.id);
    return {};
  });

  // ---- "OBS on your computer": where the OBS socket relay finds OBS (docs/API.md §12) ----

  const relay = obsRelayFor(services);

  app.get('/api/obs-relay', { preHandler: requireAdmin }, async (_req, reply) => {
    return reply.header('cache-control', 'no-store').send(await relay.status());
  });

  app.put('/api/obs-relay', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = ObsRelayBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 'invalid');
    }
    const { host, port, password } = parsed.data;
    await relay.configure({ host, port, ...(password !== undefined ? { password } : {}) });
    // Never log or audit the password itself.
    const pw = password === undefined ? '' : password ? ', password changed' : ', password removed';
    audit(services, req, 'obs_relay.update', `OBS at ${host ?? 'the address OBS streams from'}:${port}${pw}`);
    return reply.header('cache-control', 'no-store').send(await relay.status());
  });

  app.post('/api/obs-relay/test', { preHandler: requireAdmin }, async (_req, reply) => {
    return reply.header('cache-control', 'no-store').send(await relay.test());
  });

  app.delete('/api/tokens/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = IdParams.safeParse(req.params);
    if (!parsed.success) return sendError(reply, 400, 'Invalid token id', 'invalid');
    const token = repos.apiTokens.list().find((t) => t.id === parsed.data.id);
    if (!token) return sendError(reply, 404, 'Token not found', 'not_found');
    // Requests with it fail from now on; its open event streams close at their next heartbeat (≤ 15 s).
    repos.apiTokens.delete(token.id);
    // Phones controlling OBS with it are cut off now, not at the next check.
    obsRelayFor(services).disconnectToken(token.id);
    // The apps it registered in the hub go with it (best effort: the token is already revoked).
    try {
      services.apps.removeByToken(token.id);
    } catch (err) {
      req.log.warn({ err, tokenId: token.id }, 'removing the apps of a revoked token failed');
    }
    audit(services, req, 'api_token.delete', `${token.name} ${token.prefix}…`);
    return {};
  });
};

export default tokenRoutes;
