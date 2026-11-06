// /api/v1 routes added in v1.2 (docs/API.md §9): profiles, OBS ingest settings, the hub
// (connected apps, overlays per profile, app-to-app messages) and pairing.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { API_SCOPES, DEFAULT_PROFILE_ID, type ApiScope } from '../../../shared/types.js';
import { OBS_BODY_LIMIT, OBS_POSTS_PER_MINUTE, ObsEventsBody, obsStoreFor, parseObsEvents } from './obs.js';
import { grabWithFfmpeg, previewServiceFor } from './previews.js';
import { connectOffersFor, DEVICE_NAME_MAX } from './connect.js';
import { API_REVISION } from './openapi.js';
import type { AppMessage } from '../events.js';
import type { AppServices } from '../services.js';
import { APP_ID_RE, APP_KIND_RE, issuesText, overlaysFor, parseAppRegistration, publicApp } from './hub.js';
import { LAN_HTTP_PORT_ENV, LAN_HTTP_PORT_SETTING, parsePortOverride } from './access.js';
import { SlidingWindowLimiter, addressBucket, params, query, sendProblem } from './http.js';
import { CONTROL_RE, jsonBytes } from './json.js';
import { PAIRING_POLL_INTERVAL_SEC, TOKEN_NAME_MAX } from './pairing.js';
import { apiProfile, buildApiIngest } from './profiles.js';
import { createUlidGenerator, parseUlid } from './ulid.js';
import { showSummary } from './v1-show.js';
import type { V1Context } from './v1.js';

/** PUT /apps/{id}: 200 resources with URLs and meta fit easily. */
export const APP_BODY_LIMIT = 256 * 1024;
export const MESSAGE_DATA_MAX_BYTES = 64 * 1024;
const MESSAGE_BODY_LIMIT = MESSAGE_DATA_MAX_BYTES + 32 * 1024;
const PAIRING_BODY_LIMIT = 8 * 1024;
export const MESSAGES_PER_MINUTE = 120;
export const PAIRINGS_PER_MINUTE_PER_IP = 10;
/** Polls every 3 s are 20 a minute; leaves room for several apps pairing behind one address. */
export const PAIRING_POLLS_PER_MINUTE_PER_IP = 120;
export const MESSAGE_TYPE_RE = /^[a-z0-9_.-]{1,64}$/;

const profileRef = z.string().min(1).max(64);

const MessageBody = z.object({
  to: z.string().regex(APP_ID_RE, 'an app id ([a-z0-9-], at most 40), or null for every app').nullable(),
  type: z.string().regex(MESSAGE_TYPE_RE, '[a-z0-9_.-], at most 64 characters'),
  profileId: profileRef.nullable().optional(),
  replyTo: z.string().max(64).nullable().optional(),
  data: z
    .record(z.string(), z.unknown())
    .refine((d) => !Array.isArray(d), 'must be an object')
    .optional(),
  /** null = the same as omitted (the default sender). */
  from: z.string().regex(APP_ID_RE, 'one of your registered app ids').nullable().optional(),
});

const PairingBody = z.object({
  appName: z
    .string()
    .trim()
    .min(1, 'required')
    .max(TOKEN_NAME_MAX, `at most ${TOKEN_NAME_MAX} characters`)
    .refine((s) => !CONTROL_RE.test(s), 'control characters are not allowed'),
  kind: z.string().regex(APP_KIND_RE, '[a-z0-9-], at most 40 characters'),
  // Scopes this server doesn't know (newer ones, anything) are ignored, not refused: the 8 KB body
  // limit bounds the list; the route keeps the known ones and refuses only an empty result.
  scopes: z.array(z.unknown()).min(1, 'ask for at least one scope'),
  profileId: profileRef.nullable().optional(),
});

const PollBody = z.object({ pollSecret: z.string().min(1).max(200) });

const ClaimBody = z.object({
  code: z.string().min(1).max(200),
  deviceName: z
    .string()
    .max(DEVICE_NAME_MAX, `at most ${DEVICE_NAME_MAX} characters`)
    .refine((s) => !CONTROL_RE.test(s), 'control characters are not allowed')
    .optional(),
});
/** Claims per address per minute: a phone needs one; guessing a 256-bit code is hopeless anyway. */
export const CLAIMS_PER_MINUTE_PER_IP = 10;

/**
 * The web UI address the admin approves pairings at, as seen by the app that asked: same host it
 * used. A request over the LAN's plain-HTTP port maps back to HTTPS with the same port shift the
 * LAN API URL assumes (80 → 443, 30080 → 30443, HTTP_PORT → WEB_PORT). When that port is the
 * LAN_HTTP_PORT override (the port mapping is not the usual shift), the HTTPS port can't be derived
 * from it: the server's public web UI address (`fallback`) is used instead.
 */
export function webUiBase(
  config: Pick<AppServices['config'], 'tlsMode' | 'webPort' | 'httpPort'>,
  hostHeader: string | undefined,
  secure: boolean,
  fallback: string,
  lanHttpPortOverride: number | null = null,
): string {
  const m = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec((hostHeader ?? '').trim());
  if (!m?.[1]) return fallback.replace(/\/+$/, '');
  const name = m[1];
  const port = m[2] ? Number(m[2]) : null;
  if (secure) return `https://${name}${port !== null && port !== 443 ? `:${port}` : ''}`;
  if (config.tlsMode === 'off') return `http://${name}${port !== null && port !== 80 ? `:${port}` : ''}`;
  const p = port ?? 80;
  if (lanHttpPortOverride !== null && p === lanHttpPortOverride && p !== config.httpPort) return fallback.replace(/\/+$/, '');
  let httpsPort = p === config.httpPort ? config.webPort : p === 80 ? 443 : p + (config.webPort - config.httpPort);
  if (!(Number.isInteger(httpsPort) && httpsPort > 0 && httpsPort <= 65535)) httpsPort = config.webPort;
  return `https://${name}${httpsPort === 443 ? '' : `:${httpsPort}`}`;
}

export function registerHubRoutes(app: FastifyInstance, ctx: V1Context): void {
  const { services, requireToken, authOf, resolveProfile } = ctx;
  const messageLimiter = new SlidingWindowLimiter(MESSAGES_PER_MINUTE, 60_000, ctx.now);
  const pairingLimiter = new SlidingWindowLimiter(PAIRINGS_PER_MINUTE_PER_IP, 60_000, ctx.now);
  const pollLimiter = new SlidingWindowLimiter(PAIRING_POLLS_PER_MINUTE_PER_IP, 60_000, ctx.now);
  const claimLimiter = new SlidingWindowLimiter(CLAIMS_PER_MINUTE_PER_IP, 60_000, ctx.now);
  const messageId = createUlidGenerator(ctx.now);
  const obsLimiter = new SlidingWindowLimiter(OBS_POSTS_PER_MINUTE, 60_000, ctx.now);
  const obsStore = obsStoreFor(services);
  const previews = ctx.previews ?? previewServiceFor(services, () => ({
    online: (profileId, feed) => services.media.feed(profileId, feed).online,
    grab: (profileId, feed) => grabWithFfmpeg(services.config.ffmpegBin, services.media.readUrl(profileId, feed)),
  }));

  /** The `{id}` profile of a path, checked against the token; sends the problem and returns null otherwise. */
  const pathProfile = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const { token } = authOf(req);
    const raw = params(req).id;
    if (typeof raw !== 'string' || raw === '') {
      sendProblem(reply, 404, 'unknown_profile', 'No profile with this id (see GET /api/v1/profiles).');
      return null;
    }
    const p = resolveProfile(token, raw, null);
    if (!p.ok || p.profile === null) {
      if (!p.ok) sendProblem(reply, p.status, p.code, p.detail);
      return null;
    }
    return p.profile;
  };

  const ipLimited = (limiter: SlidingWindowLimiter, req: FastifyRequest, reply: FastifyReply, what: string): boolean => {
    // IPv6 by /64 (addressBucket): one host can't dodge the limit by rotating addresses in its prefix.
    const rate = limiter.hit(`ip:${addressBucket(req.ip)}`);
    if (rate.ok) return true;
    reply.header('retry-after', String(rate.retryAfterSec));
    sendProblem(reply, 429, 'rate_limited', `Too many ${what} from this address. Retry in ${rate.retryAfterSec} s.`);
    return false;
  };

  // ---- profiles ----

  app.get('/profiles', { preHandler: requireToken('status:read') }, async (req, reply) => {
    const { token } = authOf(req);
    let list = services.orchestrators.summaries();
    if (token.profileId) list = list.filter((s) => s.id === token.profileId);
    return reply.header('cache-control', 'no-store').send({ items: list.map((s) => ({ ...apiProfile(s), show: showSummary(services, s.id) })) });
  });

  app.get('/profiles/:id', { preHandler: requireToken('status:read') }, async (req, reply) => {
    const id = pathProfile(req, reply);
    if (id === null) return reply;
    const summary = services.orchestrators.summaries().find((s) => s.id === id);
    if (!summary) return sendProblem(reply, 404, 'unknown_profile', 'No profile with this id (see GET /api/v1/profiles).');
    return reply.header('cache-control', 'no-store').send({ ...apiProfile(summary), show: showSummary(services, summary.id) });
  });

  app.get('/profiles/:id/ingest', { preHandler: requireToken('ingest:read') }, async (req, reply) => {
    const id = pathProfile(req, reply);
    if (id === null) return reply;
    // Stream keys: never cached, never logged.
    const ingest = await buildApiIngest(services, id, req.hostname);
    return reply.header('cache-control', 'no-store').send(ingest);
  });

  app.get('/profiles/:id/overlays', { preHandler: requireToken('apps:read') }, async (req, reply) => {
    const id = pathProfile(req, reply);
    if (id === null) return reply;
    return reply.header('cache-control', 'no-store').send({ items: overlaysFor(services.apps.list(), id) });
  });

  // ---- connected apps ----

  app.get('/apps', { preHandler: requireToken('apps:read') }, async (req, reply) => {
    const { token } = authOf(req);
    // New in v1.2: without ?profile= (or with ?profile=*) every app the token can see.
    const p = ctx.resolveProfileView(token, query(req).profile, null);
    if (!p.ok) return sendProblem(reply, p.status, p.code, p.detail);
    return reply.header('cache-control', 'no-store').send({ items: services.apps.list(p.profile).map(publicApp) });
  });

  app.put('/apps/:appId', { preHandler: requireToken('apps:write'), bodyLimit: APP_BODY_LIMIT }, async (req, reply) => {
    const { token } = authOf(req);
    const registration = parseAppRegistration(params(req).appId, req.body);
    const saved = services.apps.register(token, registration);
    return reply.header('cache-control', 'no-store').send(publicApp(saved));
  });

  app.post('/apps/:appId/heartbeat', { preHandler: requireToken('apps:write') }, async (req, reply) => {
    const { token } = authOf(req);
    const id = params(req).appId;
    if (typeof id !== 'string' || !APP_ID_RE.test(id)) return sendProblem(reply, 400, 'invalid', 'App id: [a-z0-9-], 1 to 40 characters');
    return reply.header('cache-control', 'no-store').send(publicApp(services.apps.heartbeat(token, id)));
  });

  app.delete('/apps/:appId', { preHandler: requireToken('apps:write') }, async (req, reply) => {
    const { token } = authOf(req);
    const id = params(req).appId;
    if (typeof id !== 'string' || !APP_ID_RE.test(id)) return sendProblem(reply, 400, 'invalid', 'App id: [a-z0-9-], 1 to 40 characters');
    const existing = services.apps.get(id);
    if (!existing) return sendProblem(reply, 404, 'not_found', `No app is registered as "${id}".`);
    if (existing.tokenId !== token.id) return sendProblem(reply, 409, 'app_owned', `"${id}" was registered by another token.`);
    services.apps.remove(id);
    return reply.code(204).send();
  });

  // ---- OBS events (v1.4, §10) ----

  app.post('/apps/:appId/events', { preHandler: requireToken('obs:write'), bodyLimit: OBS_BODY_LIMIT }, async (req, reply) => {
    const { token } = authOf(req);
    const id = params(req).appId;
    if (typeof id !== 'string' || !APP_ID_RE.test(id)) return sendProblem(reply, 400, 'invalid', 'App id: [a-z0-9-], 1 to 40 characters');
    const rate = obsLimiter.hit(token.id);
    if (!rate.ok) {
      reply.header('retry-after', String(rate.retryAfterSec));
      return sendProblem(reply, 429, 'rate_limited', `Over ${OBS_POSTS_PER_MINUTE} event batches per minute for this token. Retry in ${rate.retryAfterSec} s.`);
    }
    const appRecord = services.apps.get(id);
    if (!appRecord) return sendProblem(reply, 404, 'not_found', `No app is registered as "${id}": register it first (PUT /api/v1/apps/${id}).`);
    if (appRecord.tokenId !== token.id) return sendProblem(reply, 409, 'app_owned', `"${id}" was registered by another token.`);
    // The profile: the token's own, else ?profile=, else the default profile.
    const p = resolveProfile(token, query(req).profile, DEFAULT_PROFILE_ID);
    if (!p.ok) return sendProblem(reply, p.status, p.code, p.detail);
    const profileId = p.profile ?? DEFAULT_PROFILE_ID;
    const parsed = ObsEventsBody.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'invalid', issuesText(parsed.error));

    const now = ctx.now();
    const { events, ignored } = parseObsEvents(parsed.data.events, now);
    let accepted = 0;
    let duplicates = 0;
    for (const ev of events) {
      const fresh = obsStore.apply(profileId, id, ev, now);
      accepted++;
      if (fresh) services.bus.emit('obs-event', { appId: id, profileId, type: ev.type, id: ev.id, ts: ev.ts, data: ev.data });
      else duplicates++;
    }
    services.apps.heartbeat(token, id); // sending events keeps the app online
    return reply.code(202).header('cache-control', 'no-store').send({ accepted: accepted - duplicates, ignored: ignored + duplicates });
  });

  app.get('/profiles/:id/obs', { preHandler: requireToken('status:read') }, async (req, reply) => {
    const id = pathProfile(req, reply);
    if (id === null) return reply;
    // Apps that unregistered since are left out; `online` follows the hub's 90 s presence rule.
    const apps = obsStore.view(id).flatMap((a) => {
      const registered = services.apps.get(a.appId);
      return registered ? [{ ...a, online: registered.online }] : [];
    });
    return reply.header('cache-control', 'no-store').send({ apps });
  });

  // ---- feed previews (v1.4, §10) ----

  // ?access_token= is accepted too, so an <img> (or a phone's image loader) can show it.
  app.get('/profiles/:id/previews/:feed', { preHandler: requireToken('status:read', true) }, async (req, reply) => {
    const id = pathProfile(req, reply);
    if (id === null) return reply;
    const feed = params(req).feed;
    if (feed !== 'landscape' && feed !== 'vertical') return sendProblem(reply, 404, 'not_found', 'Feed: landscape or vertical.');
    let preview;
    try {
      preview = await previews.get(id, feed);
    } catch (err) {
      services.log.warn({ profileId: id, feed, error: err instanceof Error ? err.message : String(err) }, 'feed preview failed');
      reply.header('retry-after', '5');
      return sendProblem(reply, 503, 'unavailable', "Couldn't take a preview of the feed right now; retry in a few seconds.");
    }
    if (!preview) return sendProblem(reply, 404, 'feed_offline', `The ${feed} feed is offline (OBS isn't sending it).`);
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', 'no-store')
      .header('x-preview-at', new Date(preview.at).toISOString())
      .send(preview.jpeg);
  });

  // ---- app-to-app messages ----

  app.post('/messages', { preHandler: requireToken('apps:write'), bodyLimit: MESSAGE_BODY_LIMIT }, async (req, reply) => {
    const { token } = authOf(req);
    const rate = messageLimiter.hit(token.id);
    if (!rate.ok) {
      reply.header('retry-after', String(rate.retryAfterSec));
      return sendProblem(reply, 429, 'rate_limited', `Over ${MESSAGES_PER_MINUTE} messages per minute for this token. Retry in ${rate.retryAfterSec} s.`);
    }
    const parsed = MessageBody.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'invalid', issuesText(parsed.error));
    const body = parsed.data;
    const data = body.data ?? {};
    if (jsonBytes(data) > MESSAGE_DATA_MAX_BYTES) return sendProblem(reply, 400, 'invalid', `data: at most ${MESSAGE_DATA_MAX_BYTES / 1024} KB of JSON`);

    let replyTo: string | null = null;
    if (body.replyTo !== undefined && body.replyTo !== null) {
      replyTo = parseUlid(body.replyTo);
      if (replyTo === null) return sendProblem(reply, 400, 'invalid', 'replyTo: the id of the message you answer');
    }

    const tokenProfile = token.profileId ?? null;
    // Omitted: the token's profile (or none). A token limited to a profile speaks for it (or for none).
    const profileId = body.profileId === undefined ? tokenProfile : body.profileId;
    if (profileId !== null) {
      if (tokenProfile !== null && profileId !== tokenProfile) {
        return sendProblem(reply, 403, 'profile_forbidden', `This token is limited to profile "${tokenProfile}"; profileId must be it or null.`);
      }
      if (!services.repos.profiles.get(profileId)) return sendProblem(reply, 404, 'unknown_profile', 'profileId: no profile with this id (see GET /api/v1/profiles).');
    }

    if (body.to !== null) {
      const target = services.apps.get(body.to);
      if (!target) return sendProblem(reply, 404, 'not_found', `No app is registered as "${body.to}" (see GET /api/v1/apps).`);
      if (profileId !== null && target.profileId !== null && target.profileId !== profileId) {
        return sendProblem(reply, 400, 'invalid', `"${body.to}" is connected for another profile and can't receive messages about this one.`);
      }
    }

    const own = services.apps.list().filter((a) => a.tokenId === token.id);
    let from: string | null;
    if (body.from !== undefined && body.from !== null) {
      if (!own.some((a) => a.id === body.from)) return sendProblem(reply, 400, 'invalid', 'from: one of the app ids this token registered');
      from = body.from;
    } else {
      own.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0));
      from = own[0]?.id ?? null;
    }

    const message: AppMessage = {
      id: messageId(),
      from,
      fromTokenId: token.id,
      to: body.to,
      type: body.type,
      profileId,
      replyTo,
      data,
      ts: new Date(ctx.now()).toISOString(),
    };
    services.bus.emit('app-message', message);
    return reply.code(201).header('cache-control', 'no-store').send({ id: message.id });
  });

  // ---- "Connect a phone" claim (no token yet: rate-limited per address; docs/API.md §11) ----

  app.post('/connect/claim', { bodyLimit: PAIRING_BODY_LIMIT }, async (req, reply) => {
    if (!ipLimited(claimLimiter, req, reply, 'connect attempts')) return reply;
    const parsed = ClaimBody.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'invalid', issuesText(parsed.error));
    const deviceName = parsed.data.deviceName?.trim() || 'CTD Live mobile';
    const claimed = connectOffersFor(services).claim(parsed.data.code, deviceName);
    if (!claimed) {
      return sendProblem(reply, 410, 'expired', 'This QR code was already used or has expired. Show a new one in CTD Relay (Settings → API → Connect a phone).');
    }
    services.log.info({ tokenId: claimed.token.id, ip: req.ip }, 'connect: a phone connected with a QR code');
    return reply.header('cache-control', 'no-store').send({
      token: claimed.secret,
      tokenId: claimed.token.id,
      name: claimed.token.name,
      scopes: claimed.token.scopes,
      profileId: claimed.token.profileId ?? null,
      server: { name: 'CTD Relay', version: services.config.version, apiRevision: API_REVISION },
    });
  });

  // ---- pairing (no token yet: rate-limited per address) ----

  app.post('/pairing', { bodyLimit: PAIRING_BODY_LIMIT }, async (req, reply) => {
    if (!ipLimited(pairingLimiter, req, reply, 'pairing requests')) return reply;
    const parsed = PairingBody.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'invalid', issuesText(parsed.error));
    const body = parsed.data;
    const scopes: ApiScope[] = API_SCOPES.filter((s) => body.scopes.includes(s));
    if (scopes.length === 0) return sendProblem(reply, 400, 'invalid', `scopes: any of ${API_SCOPES.join(', ')}`);
    const profileId = body.profileId ?? null;
    if (profileId !== null && !services.repos.profiles.get(profileId)) {
      return sendProblem(reply, 404, 'unknown_profile', 'profileId: no profile with this id (ask for every profile with null; the admin picks one).');
    }
    const { pairing, pollSecret } = services.pairings.create({
      appName: body.appName,
      kind: body.kind,
      requestedScopes: scopes,
      requestedProfileId: profileId,
      ip: req.ip ?? null,
    });
    const secure = (req.raw.socket as { encrypted?: boolean } | undefined)?.encrypted === true;
    let lanHttpPort: number | null = null;
    try {
      lanHttpPort = parsePortOverride(process.env[LAN_HTTP_PORT_ENV], services.repos.settings.get<unknown>(LAN_HTTP_PORT_SETTING, null));
    } catch {
      lanHttpPort = parsePortOverride(process.env[LAN_HTTP_PORT_ENV]);
    }
    const base = webUiBase(services.config, req.headers.host, secure, services.publicBaseUrl(), lanHttpPort);
    const expiresIn = Math.max(0, Math.round((Date.parse(pairing.expiresAt) - ctx.now()) / 1000));
    return reply.code(201).header('cache-control', 'no-store').send({
      pairingId: pairing.id,
      pollSecret,
      code: pairing.code,
      expiresIn,
      interval: PAIRING_POLL_INTERVAL_SEC,
      approveUrl: `${base}/settings?tab=api&pair=${encodeURIComponent(pairing.id)}`,
    });
  });

  app.post('/pairing/:pairingId/token', { bodyLimit: PAIRING_BODY_LIMIT }, async (req, reply) => {
    if (!ipLimited(pollLimiter, req, reply, 'pairing polls')) return reply;
    const id = params(req).pairingId;
    const parsed = PollBody.safeParse(req.body ?? {});
    if (typeof id !== 'string' || id.length > 64 || !parsed.success) return sendProblem(reply, 400, 'invalid', 'Send { "pollSecret": "…" } from the pairing response.');
    reply.header('cache-control', 'no-store');
    const result = services.pairings.poll(id, parsed.data.pollSecret);
    switch (result.status) {
      case 'pending':
        return reply.code(202).send({ status: 'pending' });
      case 'approved':
        return reply.code(200).send({
          status: 'approved',
          token: result.secret,
          profileId: result.token.profileId ?? null,
          scopes: result.token.scopes,
        });
      case 'denied':
        return sendProblem(reply, 403, 'denied', 'The connection was denied in Settings → API.');
      default:
        return sendProblem(reply, 410, 'expired', 'This pairing request expired (or is unknown); start a new one.');
    }
  });
}
