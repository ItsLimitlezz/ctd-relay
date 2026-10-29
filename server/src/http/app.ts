import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import dockRoutes from '../api/dock.js';
import { lanHttpPlugin } from '../api/lan.js';
import v1Routes, { API_PREFIX } from '../api/v1.js';
import overlayModeration from '../chat/overlay-moderation.js';
import { DriverError } from '../platforms/types.js';
import type { AppServices, TlsMaterial } from '../services.js';
import authPlugin from './auth-plugin.js';
import { sendError, type RouteOptions } from './guards.js';
import accountRoutes from './routes/accounts.js';
import auditRoutes from './routes/audit.js';
import authRoutes from './routes/auth.js';
import browserRoutes from './routes/browser.js';
import chatRoutes from './routes/chat.js';
import destinationRoutes from './routes/destinations.js';
import healthRoutes from './routes/health.js';
import ingestRoutes from './routes/ingest.js';
import musicRoutes from './routes/music.js';
import pairingRoutes from './routes/pairings.js';
import platformRoutes from './routes/platforms.js';
import profileRoutes from './routes/profiles.js';
import sessionRoutes from './routes/session.js';
import settingsRoutes from './routes/settings.js';
import setupRoutes from './routes/setup.js';
import tokenRoutes from './routes/tokens.js';
import userRoutes from './routes/users.js';
import wsRoutes from './routes/ws.js';

/** Where the built web UI lives (vite build output). Missing in dev — the Vite dev server serves it. */
function webDir(): string | null {
  const dir = path.resolve(process.env.WEB_DIR ?? 'dist/web');
  return fs.existsSync(path.join(dir, 'index.html')) ? dir : null;
}

export async function buildApp(services: AppServices, tlsMaterial: TlsMaterial | null): Promise<FastifyInstance> {
  const { config } = services;
  const app = Fastify({
    loggerInstance: services.log.child({ mod: 'http' }),
    trustProxy: config.trustProxy,
    disableRequestLogging: true,
    bodyLimit: 1024 * 1024,
    ...(tlsMaterial ? { https: { key: tlsMaterial.key, cert: tlsMaterial.cert } } : {}),
  }) as unknown as FastifyInstance;

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return sendError(reply, 400, err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 'invalid');
    }
    if (err instanceof DriverError) {
      return sendError(reply, 400, err.message, err.code);
    }
    const e = err as { statusCode?: number; message?: string; code?: unknown };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      // Keep machine-readable codes from our own errors; Fastify's internal FST_* codes aren't API codes.
      const code = typeof e.code === 'string' && !e.code.startsWith('FST_') ? e.code : undefined;
      return sendError(reply, e.statusCode, e.message ?? 'Bad request', code);
    }
    req.log.error({ err }, 'request failed');
    return sendError(reply, 500, 'Internal error');
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: tlsMaterial ? [] : null,
      },
    },
    hsts: tlsMaterial ? { maxAge: 15552000, includeSubDomains: false } : false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  const opts: RouteOptions = { services };
  // After helmet: LAN plain-HTTP requests (TlsManager.setLanHandler) drop the HTTPS-only headers.
  await app.register(lanHttpPlugin, opts);
  await app.register(authPlugin, opts);

  await app.register(healthRoutes, opts);
  await app.register(setupRoutes, opts);
  await app.register(authRoutes, opts);
  await app.register(userRoutes, opts);
  await app.register(auditRoutes, opts);
  await app.register(platformRoutes, opts);
  // Profiles: independent streaming set-ups (per-profile routes take ?profile=, see shared/api.ts).
  await app.register(profileRoutes, opts);
  await app.register(accountRoutes, opts);
  await app.register(destinationRoutes, opts);
  await app.register(sessionRoutes, opts);
  await app.register(ingestRoutes, opts);
  await app.register(chatRoutes, opts);
  // Spotify now playing + chat song requests (Settings → Spotify).
  await app.register(musicRoutes, opts);
  await app.register(settingsRoutes, opts);
  await app.register(browserRoutes, opts);
  await app.register(wsRoutes, opts);
  await app.register(tokenRoutes, opts);
  // The hub's admin side: pending app pairings + connected apps (Settings → API).
  await app.register(pairingRoutes, opts);
  await app.register(overlayModeration, opts);
  // External API (bearer tokens, docs/API.md) + the OBS dock page that uses it.
  await app.register(v1Routes, { ...opts, prefix: API_PREFIX });
  await app.register(dockRoutes, opts);

  const dir = webDir();
  if (dir) {
    await app.register(fastifyStatic, { root: dir, prefix: '/', wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      const url = req.raw.url ?? '/';
      if (req.method === 'GET' && !url.startsWith('/api/') && !url.startsWith('/overlay/')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return sendError(reply, 404, 'Not found', 'not_found');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => sendError(reply, 404, 'Not found', 'not_found'));
  }

  return app;
}
