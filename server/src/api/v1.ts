// External API v1 (docs/API.md): bearer-token auth, problem+json errors, SSE events; profiles and
// the hub (connected apps, app-to-app messages, pairing) since v1.2 (v1-hub.ts).
//
// Registered under the /api/v1 prefix. It never uses the session cookie and never sets one. The
// global auth plugin CSRF-checks unsafe methods only for requests that carry a web UI session
// cookie; apps send none (and browsers don't send the SameSite=Strict cookie cross-site).

import type { ServerResponse } from 'node:http';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { DEFAULT_PROFILE_ID, type ApiScope, type ApiTokenInfo } from '../../../shared/types.js';
import type { RouteOptions } from '../http/guards.js';
import type { AppServices } from '../services.js';
import { buildClock, parseT0 } from './clock.js';
import { eventHubFor, type EventHub, type EventReader } from './event-hub.js';
import { resolveTypes } from './filters.js';
import { ConcurrencyLimiter, SlidingWindowLimiter, isProblemCode, presentedToken, query, sendProblem, type ProblemCode } from './http.js';
import { API_REVISION, openApiDocument } from './openapi.js';
import type { PreviewService } from './previews.js';
import type { ApiEventType, Envelope } from './types.js';
import { parseUlid } from './ulid.js';
import { registerHubRoutes } from './v1-hub.js';
import { musicFor } from '../music/music-service.js';
import { registerObsSocketRoute } from './v1-obs-socket.js';

export const API_PREFIX = '/api/v1';
export const RATE_LIMIT_PER_MINUTE = 600;
export const MAX_STREAMS_PER_TOKEN = 5;
export const HEARTBEAT_MS = 15_000;
export const SSE_RETRY_MS = 3000;
export const CHAT_DEFAULT_LIMIT = 200;
export const CHAT_MAX_LIMIT = 500;
/** A stream client this far behind on live events isn't reading; drop it (it resumes with Last-Event-ID). */
export const MAX_STREAM_BUFFER_BYTES = 1024 * 1024;
/** A gracefully ended stream (revoked token, shutdown) whose end can't be flushed is destroyed after this. */
const STREAM_END_GRACE_MS = 5000;
const PROFILE_ID_MAX = 64;
/**
 * `?profile=` values that ask for every profile the token can see (`/events`, `/events/poll`,
 * `/apps`): every profile for an every-profile token, its own for a profile-limited one. Profile ids
 * are UUIDs or `default`, so they never clash.
 */
export const ALL_PROFILES_VALUES: ReadonlySet<string> = new Set(['*', 'all']);

export interface V1Options extends RouteOptions {
  /** Defaults to eventHubFor(services). */
  hub?: EventHub;
  now?: () => number;
  heartbeatMs?: number;
  /** Test seam: the feed preview service (default: FFmpeg grabs from MediaMTX). */
  previews?: PreviewService;
}

export interface Auth {
  token: ApiTokenInfo;
  secret: string;
}

export type ProfileResolution = { ok: true; profile: string | null } | { ok: false; status: number; code: ProblemCode; detail: string };

/** What the route modules share. */
export interface V1Context {
  services: AppServices;
  hub(): EventHub;
  now(): number;
  /** preHandler: valid token, under the rate limit, with `scope` (when given). */
  requireToken(scope: ApiScope | null, allowQuery?: boolean): (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  authOf(req: FastifyRequest): Auth;
  /**
   * The profile a request is about: `raw` (a `?profile=` value or `{id}` path parameter) checked
   * against the token, else the token's own profile, else `fallback`.
   */
  resolveProfile(token: ApiTokenInfo, raw: unknown, fallback: string | null): ProfileResolution;
  /**
   * Like resolveProfile, for the routes that can show every profile at once: `?profile=*` (or
   * `all`) is every profile the token can see (null for an every-profile token, its own profile for
   * a limited one).
   */
  resolveProfileView(token: ApiTokenInfo, raw: unknown, fallback: string | null): ProfileResolution;
  previews?: PreviewService;
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Retry-After, WWW-Authenticate',
};

export function sseFrame(env: Envelope): string {
  return `id: ${env.id}\nevent: ${env.type}\ndata: ${JSON.stringify(env)}\n\n`;
}

function parseLimit(raw: unknown): number | null {
  if (raw === undefined || raw === '') return CHAT_DEFAULT_LIMIT;
  if (typeof raw !== 'string' || !/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= CHAT_MAX_LIMIT ? n : null;
}

/** undefined = absent, null = present but not a ULID. */
function parseCursor(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  return parseUlid(raw);
}

const v1Plugin: FastifyPluginAsync<V1Options> = async (app, opts) => {
  const { services } = opts;
  const log = services.log.child({ mod: 'api-v1' });
  const now = opts.now ?? Date.now;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  let hubInstance = opts.hub ?? null;
  const hub = (): EventHub => (hubInstance ??= eventHubFor(services));
  const limiter = new SlidingWindowLimiter(RATE_LIMIT_PER_MINUTE, 60_000, now);
  const streamSlots = new ConcurrencyLimiter(MAX_STREAMS_PER_TOKEN);
  const auths = new WeakMap<FastifyRequest, Auth>();
  const openStreams = new Set<() => void>();

  // ---- every response under /api/v1 ----

  app.addHook('onRequest', async (_req, reply) => {
    reply.headers(CORS_HEADERS);
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    // Bearer-only API: never set (or clear) the web UI's session cookie from here.
    reply.removeHeader('set-cookie');
    reply.raw.removeHeader('set-cookie');
    return payload;
  });
  app.setNotFoundHandler((req, reply) => {
    reply.headers(CORS_HEADERS);
    return sendProblem(reply, 404, 'not_found', `No such endpoint: ${req.method} ${req.url.split('?')[0] ?? ''}`);
  });
  app.setErrorHandler((err, req, reply) => {
    const e = err as { statusCode?: number; message?: string; code?: unknown; retryAfterSec?: unknown };
    reply.headers(CORS_HEADERS);
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      if (typeof e.retryAfterSec === 'number' && e.retryAfterSec > 0) reply.header('retry-after', String(Math.ceil(e.retryAfterSec)));
      // Our own errors (ApiProblem, the orchestrators' unknown_profile) keep their status and code.
      if (isProblemCode(e.code)) return sendProblem(reply, e.statusCode, e.code, e.message ?? 'Bad request');
      if (e.statusCode === 429) return sendProblem(reply, 429, 'rate_limited', e.message ?? 'Too many requests');
      // Body too large / not JSON keep their status; everything else is a plain bad request.
      const status = e.statusCode === 413 || e.statusCode === 415 ? e.statusCode : 400;
      return sendProblem(reply, status, 'invalid', e.message ?? 'Bad request');
    }
    req.log.error({ err }, 'api v1 request failed');
    return sendProblem(reply, 500, 'internal', 'Internal error');
  });
  app.addHook('preClose', async () => {
    for (const close of [...openStreams]) close();
  });

  // JSON bodies (PUT/POST since v1.2): an empty body is no body (a heartbeat from a client that
  // always sends Content-Type: application/json), anything else goes through Fastify's own parser
  // (prototype-poisoning protection included).
  const defaultJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') {
      done(null, undefined);
      return;
    }
    defaultJson(req, text, done);
  });

  // CORS preflight (browsers send one before a request with an Authorization header).
  const preflight = async (req: FastifyRequest, reply: FastifyReply) => {
    reply
      .headers(CORS_HEADERS)
      .header('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
      .header('access-control-allow-headers', 'Authorization, Last-Event-ID, Cache-Control, Content-Type')
      .header('access-control-max-age', '600');
    if (req.headers['access-control-request-private-network'] === 'true') reply.header('access-control-allow-private-network', 'true');
    return reply.code(204).send();
  };
  app.options('/', preflight);
  app.options('/*', preflight);

  // ---- auth ----

  function requireToken(scope: ApiScope | null, allowQuery = false) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const secret = presentedToken(req, allowQuery);
      if (!secret) {
        return sendProblem(
          reply,
          401,
          'unauthenticated',
          secret === null
            ? 'Send a token: Authorization: Bearer ctd_pat_… (create one in Settings → API).'
            : 'Malformed Authorization header; expected: Bearer ctd_pat_…',
        );
      }
      const found = services.repos.apiTokens.verify(secret);
      if (!found) return sendProblem(reply, 401, 'unauthenticated', 'Unknown or revoked token. Create a new one in Settings → API.');
      const token: ApiTokenInfo = { ...found, profileId: found.profileId ?? null };
      const rate = limiter.hit(token.id);
      if (!rate.ok) {
        reply.header('retry-after', String(rate.retryAfterSec));
        return sendProblem(reply, 429, 'rate_limited', `Over ${RATE_LIMIT_PER_MINUTE} requests per minute for this token. Retry in ${rate.retryAfterSec} s.`);
      }
      if (scope && !token.scopes.includes(scope)) {
        return sendProblem(reply, 403, 'missing_scope', `This token needs the ${scope} scope. Create a token with it in Settings → API.`);
      }
      auths.set(req, { token, secret });
    };
  }

  const authOf = (req: FastifyRequest): Auth => {
    const auth = auths.get(req);
    if (!auth) throw new Error('route without requireToken');
    return auth;
  };

  function resolveProfile(token: ApiTokenInfo, raw: unknown, fallback: string | null): ProfileResolution {
    const tokenProfile = token.profileId ?? null;
    if (raw !== undefined && raw !== '') {
      if (typeof raw !== 'string' || raw.length > PROFILE_ID_MAX) return { ok: false, status: 400, code: 'invalid', detail: 'profile must be one profile id' };
      if (tokenProfile !== null && raw !== tokenProfile) {
        return { ok: false, status: 403, code: 'profile_forbidden', detail: `This token is limited to profile "${tokenProfile}"; omit profile or pass that id.` };
      }
      if (!services.repos.profiles.get(raw)) return { ok: false, status: 404, code: 'unknown_profile', detail: 'No profile with this id (see GET /api/v1/profiles).' };
      return { ok: true, profile: raw };
    }
    return { ok: true, profile: tokenProfile ?? fallback };
  }

  function resolveProfileView(token: ApiTokenInfo, raw: unknown, fallback: string | null): ProfileResolution {
    if (typeof raw === 'string' && ALL_PROFILES_VALUES.has(raw)) return { ok: true, profile: token.profileId ?? null };
    return resolveProfile(token, raw, fallback);
  }

  const ctx: V1Context = { services, hub, now, requireToken, authOf, resolveProfile, resolveProfileView, ...(opts.previews ? { previews: opts.previews } : {}) };

  /** The reader of /events and /events/poll for this token and profile view. */
  const readerOf = (token: ApiTokenInfo, profile: string | null): EventReader => ({
    tokenId: token.id,
    tokenProfile: token.profileId ?? null,
    profile,
  });

  // ---- routes ----

  app.get('/openapi.json', async (_req, reply) => {
    return reply.header('cache-control', 'no-cache').send(openApiDocument(services.config.version));
  });

  app.get('/', { preHandler: requireToken(null) }, async (req, reply) => {
    const { token } = authOf(req);
    const { build } = services.config;
    return reply.header('cache-control', 'no-store').send({
      name: 'ctd-multi-stream',
      version: services.config.version,
      // v1.3: which image is running (null commit/date: a local build).
      build: { commit: build?.commit ?? null, date: build?.date ?? null },
      apiRevision: API_REVISION,
      apiVersion: 1,
      token: { name: token.name, scopes: token.scopes, profileId: token.profileId ?? null },
    });
  });

  app.get('/status', { preHandler: requireToken('status:read') }, async (req, reply) => {
    const { token } = authOf(req);
    const p = resolveProfile(token, query(req).profile, DEFAULT_PROFILE_ID);
    if (!p.ok) return sendProblem(reply, p.status, p.code, p.detail);
    return reply.header('cache-control', 'no-store').send(hub().status(p.profile ?? DEFAULT_PROFILE_ID));
  });

  // What the profile's Spotify plays (v1.8): null = Spotify not connected (or not read yet).
  app.get('/music', { preHandler: requireToken('status:read') }, async (req, reply) => {
    const { token } = authOf(req);
    const p = resolveProfile(token, query(req).profile, DEFAULT_PROFILE_ID);
    if (!p.ok) return sendProblem(reply, p.status, p.code, p.detail);
    return reply.header('cache-control', 'no-store').send({ nowPlaying: musicFor(services).nowPlaying(p.profile ?? DEFAULT_PROFILE_ID) });
  });

  // The arrival time is taken before authentication so the client's delay estimate stays honest.
  const arrivals = new WeakMap<FastifyRequest, number>();
  app.get(
    '/clock',
    {
      onRequest: (req, _reply, done) => {
        arrivals.set(req, now());
        done();
      },
      preHandler: requireToken('status:read'),
    },
    async (req, reply) => {
      const { token } = authOf(req);
      const q = query(req);
      const p = resolveProfile(token, q.profile, DEFAULT_PROFILE_ID);
      if (!p.ok) return sendProblem(reply, p.status, p.code, p.detail);
      const t0 = parseT0(q.t0);
      if (t0 === undefined) return sendProblem(reply, 400, 'invalid', 't0 must be your send time in epoch milliseconds');
      const profileId = p.profile ?? DEFAULT_PROFILE_ID;
      const status = hub().status(profileId);
      const sentAt = now();
      const clock = buildClock({ t0, receivedAt: arrivals.get(req) ?? sentAt, sentAt, profileId, session: status.session, feeds: status.feeds });
      return reply.header('cache-control', 'no-store').send(clock);
    },
  );

  app.get('/chat', { preHandler: requireToken('chat:read') }, async (req, reply) => {
    const { token } = authOf(req);
    const q = query(req);
    const p = resolveProfile(token, q.profile, DEFAULT_PROFILE_ID);
    if (!p.ok) return sendProblem(reply, p.status, p.code, p.detail);
    const limit = parseLimit(q.limit);
    if (limit === null) return sendProblem(reply, 400, 'invalid', `limit must be an integer from 1 to ${CHAT_MAX_LIMIT}`);
    const after = parseCursor(q.after);
    if (after === null) return sendProblem(reply, 400, 'invalid', 'after must be an envelope id (ULID)');
    return reply.header('cache-control', 'no-store').send(hub().chat(limit, after, p.profile ?? DEFAULT_PROFILE_ID));
  });

  app.get('/events/poll', { preHandler: requireToken(null) }, async (req, reply) => {
    const { token } = authOf(req);
    const q = query(req);
    // Default: the default profile, as before profiles existed; `?profile=*` for every profile.
    const p = resolveProfileView(token, q.profile, DEFAULT_PROFILE_ID);
    if (!p.ok) return sendProblem(reply, p.status, p.code, p.detail);
    const filter = resolveTypes(q.types, token.scopes);
    if (!filter.ok) return sendProblem(reply, filter.status, filter.code, filter.detail);
    const after = parseCursor(q.after);
    if (after === null) return sendProblem(reply, 400, 'invalid', 'after must be an envelope id (ULID)');
    reply.header('cache-control', 'no-store');
    const h = hub();
    if (after === undefined) return reply.send({ items: [], next: h.cursor(), reset: false });
    const reader = readerOf(token, p.profile);
    const replay = h.since(after, filter.types, reader);
    if (replay.reset) return reply.send({ items: [], next: h.cursor(), reset: true });
    const items: Envelope[] = [];
    for (const env of replay.items) {
      if (!filter.types.has(env.type)) continue;
      const v = h.visible(env, reader);
      if (v) items.push(v);
    }
    // The last scanned envelope, matching or not: the next poll doesn't rescan what the filter skipped.
    const next = replay.items.at(-1)?.id ?? after;
    return reply.send({ items, next, reset: false });
  });

  // No automatic HEAD route: a HEAD "stream" would hold a stream slot without ever sending anything.
  app.get('/events', { preHandler: requireToken(null, true), exposeHeadRoute: false }, async (req, reply) => {
    const { token, secret } = authOf(req);
    const q = query(req);
    // Without ?profile=, the default profile (so clients from before profiles keep their behaviour,
    // like /status, /chat and /events/poll); `?profile=*` streams every profile the token can see.
    const p = resolveProfileView(token, q.profile, DEFAULT_PROFILE_ID);
    if (!p.ok) return sendProblem(reply, p.status, p.code, p.detail);
    const filter = resolveTypes(q.types, token.scopes);
    if (!filter.ok) return sendProblem(reply, filter.status, filter.code, filter.detail);
    const header = req.headers['last-event-id'];
    const cursor = parseCursor(typeof header === 'string' && header.trim() ? header : q.cursor);
    if (cursor === null) return sendProblem(reply, 400, 'invalid', 'Last-Event-ID / cursor must be an envelope id (ULID)');
    if (!streamSlots.acquire(token.id)) {
      reply.header('retry-after', '30');
      return sendProblem(reply, 429, 'rate_limited', `At most ${MAX_STREAMS_PER_TOKEN} event streams per token are open at once.`);
    }
    const reader = readerOf(token, p.profile);

    reply.hijack();
    const res: ServerResponse = reply.raw;

    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    /**
     * Release everything this stream holds (slot, hub subscription, heartbeat). `abort` destroys the
     * response right away (slow or broken client: frees the queued data and the socket); otherwise
     * it ends gracefully, and is destroyed anyway if that end can't be flushed within a few seconds
     * (a client that stopped reading would otherwise pin the socket and its buffer forever).
     */
    const close = (abort = false) => {
      if (closed) {
        if (abort && !res.destroyed) res.destroy();
        return;
      }
      closed = true;
      openStreams.delete(end);
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      streamSlots.release(token.id);
      if (abort) {
        res.destroy();
        return;
      }
      if (res.destroyed) return;
      if (!res.writableEnded) res.end();
      const force = setTimeout(() => res.destroy(), STREAM_END_GRACE_MS);
      force.unref?.();
      res.once('close', () => clearTimeout(force));
    };
    const end = () => close(false);
    openStreams.add(end);
    res.on('close', end);
    res.on('error', () => close(true));
    // Gone before the listeners above existed: its 'close' has already fired.
    if (res.destroyed || req.raw.socket?.destroyed) {
      close(true);
      return;
    }

    try {
      res.removeHeader('set-cookie');
      res.writeHead(200, {
        ...CORS_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      req.raw.socket?.setNoDelay?.(true);

      // The initial replay/snapshot is written in one tick while Node corks the socket, so all of it
      // sits in user space for a moment however fast the client is; it is bounded by the hub buffer
      // (2000 envelopes), so it doesn't count against the slow-client limit. Live writes may queue
      // MAX_STREAM_BUFFER_BYTES on top of what is left of it; after the first 'drain', the plain limit.
      let allowance = Number.POSITIVE_INFINITY;
      const write = (chunk: string) => {
        if (closed || res.writableEnded || res.destroyed) return;
        const ok = res.write(chunk);
        if (!ok && res.writableLength > allowance + MAX_STREAM_BUFFER_BYTES) {
          log.debug({ tokenId: token.id, buffered: res.writableLength }, 'event stream client too slow; dropping it');
          close(true);
        }
      };
      const types: ReadonlySet<ApiEventType> = filter.types;
      const h = hub();
      const send = (env: Envelope) => {
        if (!types.has(env.type)) return;
        const v = h.visible(env, reader);
        if (v) write(sseFrame(v));
      };

      write(`retry: ${SSE_RETRY_MS}\n\n`);
      // Replay (or snapshot) and subscribe in the same tick: no event can slip in between.
      let initial: Envelope[];
      if (cursor === undefined) {
        initial = h.snapshot(reader.profile);
      } else {
        const replay = h.since(cursor, types, reader);
        initial = replay.reset ? [h.resetEnvelope(), ...h.snapshot(reader.profile)] : replay.items;
      }
      for (const env of initial) {
        if (closed) break;
        send(env);
      }
      // Closed meanwhile (socket error): set nothing up that close() would no longer release.
      if (closed) return;
      allowance = res.writableLength;
      if (allowance > 0) {
        res.once('drain', () => {
          allowance = 0;
        });
      }
      unsubscribe = h.subscribe(send);

      const timer = setInterval(() => {
        if (closed) {
          clearInterval(timer);
          return;
        }
        // Revoked tokens lose their open streams here (within one heartbeat).
        let valid: boolean;
        try {
          valid = services.repos.apiTokens.verify(secret)?.id === token.id;
        } catch {
          valid = true; // transient DB error: check again next time
        }
        if (!valid) {
          close();
          return;
        }
        write(': ping\n\n');
      }, heartbeatMs);
      timer.unref?.();
      heartbeat = timer;
    } catch (err) {
      // Never leave a hijacked stream open but silent: drop it so the client reconnects.
      log.warn({ tokenId: token.id, error: (err as Error).message }, 'event stream failed');
      close(true);
    }
  });

  registerHubRoutes(app, ctx);
  registerObsSocketRoute(app, ctx);
};

export default v1Plugin;
