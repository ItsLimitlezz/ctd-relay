// LAN plain-HTTP handoff: the HTTP listener routes private-address requests for /api/v1, /dock and
// /overlay (+ the /overlay/ws upgrade) to Fastify; everything else keeps the ACME/redirect behaviour.

import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import helmet from '@fastify/helmet';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DOCK_CSP } from '../api/dock.js';
import { createLanHandler, lanHttpPlugin } from '../api/lan.js';
import { createTestApi, type TestApi } from '../api/test-helpers.js';
import type { AppConfig } from '../config.js';
import type { AppServices, LanHandler, SettingsRepo } from '../services.js';
import { createHttpListener, isLanClient, isLanPath, isLanUpgradePath, lanClientPolicy, type HttpListener } from './http-listener.js';
import { createTlsManager } from './tls-manager.js';

const log = pino({ level: 'silent' });

function request(port: number, urlPath: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, headers: { host: `192.168.1.20:${port}`, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Opens a WebSocket; resolves with the first message, or rejects with the HTTP status it got instead. */
function wsFirstMessage(port: number, urlPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${urlPath}`, { headers: { host: `192.168.1.20:${port}` } });
    ws.on('message', (data) => {
      resolve(String(data));
      ws.close();
    });
    ws.on('unexpected-response', (_req, res) => {
      reject(new Error(`HTTP ${res.statusCode} ${res.headers.location ?? ''}`.trim()));
      ws.terminate();
    });
    ws.on('error', reject);
  });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], upgradeInsecureRequests: [] } },
    hsts: { maxAge: 15552000, includeSubDomains: false },
  });
  await app.register(websocket);
  await app.register(lanHttpPlugin, { services: { config: { tlsMode: 'self-signed' } } as unknown as AppServices });
  app.get('/api/v1/x', async (req) => ({ ok: true, protocol: req.protocol }));
  app.get('/dock', async () => 'dock');
  app.get('/overlay/chat', async () => 'overlay');
  app.get('/api/users', async () => 'admin data');
  app.get('/overlay/ws', { websocket: true }, (socket) => socket.send('hello from overlay'));
  app.get('/api/ws', { websocket: true }, (socket) => socket.send('ui socket'));
  await app.ready();
  return app;
}

describe('LAN path and client rules', () => {
  it.each([
    ['192.168.1.5', true],
    ['10.0.0.2', true],
    ['172.17.0.1', true], // Docker bridge gateway
    ['100.64.1.1', true], // CGNAT / Tailscale
    ['127.0.0.1', true],
    ['::1', true],
    ['::ffff:192.168.1.5', true],
    ['fd12::1', true],
    ['fe80::1', true],
    ['169.254.1.1', true],
    ['93.184.216.34', false],
    ['::ffff:93.184.216.34', false],
    ['2001:4860::8888', false],
    ['', false],
    [undefined, false],
  ])('isLanClient(%s) = %s', (ip, lan) => {
    expect(isLanClient(ip)).toBe(lan);
  });

  it.each([
    ['/api/v1', true],
    ['/api/v1/', true],
    ['/api/v1/status?x=1', true],
    ['/api/v1/events?types=chat.*', true],
    ['/dock', true],
    ['/dock/dock.js', true],
    ['/overlay/chat?token=abc', true],
    ['/overlay/ws?token=abc', true],
    ['/', false],
    ['/api/users', false],
    ['/api/v10', false],
    ['/api/v1x', false],
    ['/docker', false],
    ['/overlay', false],
    ['/api/v1/../users', false],
    ['/api/v1/%2e%2e/users', false],
    ['/api/v1/%2F..', false],
    ['/overlay/..%2fapi', false],
    ['/api/v1\\..\\x', false],
    ['http://evil/api/v1/status', false],
    ['//api/v1', false],
    [undefined, false],
  ])('isLanPath(%s) = %s', (url, ok) => {
    expect(isLanPath(url)).toBe(ok);
  });

  it('only /overlay/ws may be upgraded', () => {
    expect(isLanUpgradePath('/overlay/ws?token=x')).toBe(true);
    expect(isLanUpgradePath('/api/ws')).toBe(false);
    expect(isLanUpgradePath('/overlay/chat')).toBe(false);
  });
});

describe('lanClientPolicy (LAN_HTTP / LAN_HTTP_CIDRS)', () => {
  it('defaults to the private ranges', () => {
    const p = lanClientPolicy({});
    expect(p.enabled).toBe(true);
    expect(p.warnings).toEqual([]);
    expect(p.isLanClient('172.17.0.1')).toBe(true);
    expect(p.isLanClient('93.184.216.34')).toBe(false);
    expect(lanClientPolicy({ LAN_HTTP: 'on' }).isLanClient('10.1.2.3')).toBe(true);
  });

  it('LAN_HTTP=off: nobody is LAN (Docker Desktop, rootless, tunnels)', () => {
    for (const value of ['off', 'OFF', 'false', '0', 'no']) {
      const p = lanClientPolicy({ LAN_HTTP: value });
      expect(p.enabled).toBe(false);
      expect(p.isLanClient('192.168.65.1')).toBe(false);
      expect(p.isLanClient('127.0.0.1')).toBe(false);
    }
  });

  it('LAN_HTTP_CIDRS replaces the private ranges (e.g. to exclude the Docker gateway)', () => {
    const p = lanClientPolicy({ LAN_HTTP_CIDRS: ' 192.168.1.0/24, fd00::/8 ,10.0.0.7, bogus, 10.0.0.0/99 ' });
    expect(p.enabled).toBe(true);
    expect(p.isLanClient('192.168.1.77')).toBe(true);
    expect(p.isLanClient('::ffff:192.168.1.77')).toBe(true);
    expect(p.isLanClient('fd00::5')).toBe(true);
    expect(p.isLanClient('10.0.0.7')).toBe(true);
    expect(p.isLanClient('10.0.0.8')).toBe(false);
    expect(p.isLanClient('172.17.0.1')).toBe(false); // bridge gateway: proxied, maybe from the internet
    expect(p.isLanClient('100.64.1.1')).toBe(false);
    expect(p.isLanClient(undefined)).toBe(false);
    expect(p.warnings).toHaveLength(2); // bogus, /99
    expect(p.description).toBe('peers in 192.168.1.0/24, fd00::/8, 10.0.0.7/32');
  });

  it('a CIDR list with no valid entry turns LAN HTTP off (fail closed)', () => {
    const p = lanClientPolicy({ LAN_HTTP_CIDRS: 'nope' });
    expect(p.enabled).toBe(false);
    expect(p.isLanClient('192.168.1.5')).toBe(false);
    expect(p.warnings.at(-1)).toMatch(/no valid entry/);
  });

  it('an unknown LAN_HTTP value warns and stays on', () => {
    const p = lanClientPolicy({ LAN_HTTP: 'maybe' });
    expect(p.enabled).toBe(true);
    expect(p.warnings[0]).toMatch(/not on or off/);
  });
});

describe('HTTP listener handoff (real sockets)', () => {
  let app: FastifyInstance;
  let handler: LanHandler;
  const challenges = new Map<string, string>([['tok1', 'tok1.thumb']]);
  let lan: HttpListener;
  let pub: HttpListener;
  let none: HttpListener;
  let lanPort: number;
  let pubPort: number;
  let nonePort: number;

  beforeAll(async () => {
    app = await buildApp();
    handler = createLanHandler(app);
    lan = createHttpListener({ port: 0, host: '127.0.0.1', publicPort: 443, challenges, log, lanHandler: () => handler });
    pub = createHttpListener({ port: 0, host: '127.0.0.1', publicPort: 443, challenges, log, lanHandler: () => handler, isLanClient: () => false });
    none = createHttpListener({ port: 0, host: '127.0.0.1', publicPort: 443, challenges, log, lanHandler: () => null });
    [lanPort, pubPort, nonePort] = await Promise.all([lan.listen(), pub.listen(), none.listen()]);
  });
  afterAll(async () => {
    await Promise.all([lan.close(), pub.close(), none.close()]);
    await app.close();
  });

  it('routes LAN requests for the API, dock and overlay to the app over plain HTTP', async () => {
    const api = await request(lanPort, '/api/v1/x');
    expect(api.status).toBe(200);
    expect(JSON.parse(api.body)).toEqual({ ok: true, protocol: 'http' });
    // HTTPS-only headers are dropped for plain-HTTP requests.
    expect(api.headers['content-security-policy']).toBeDefined();
    expect(api.headers['content-security-policy']).not.toMatch(/upgrade-insecure-requests/);
    expect(api.headers['strict-transport-security']).toBeUndefined();
    expect((await request(lanPort, '/dock')).body).toBe('dock');
    expect((await request(lanPort, '/overlay/chat?token=x')).body).toBe('overlay');
  });

  it('keeps redirecting everything else, and public clients', async () => {
    const admin = await request(lanPort, '/api/users');
    expect(admin.status).toBe(301);
    expect(admin.headers.location).toBe('https://192.168.1.20/api/users');
    expect((await request(lanPort, '/')).status).toBe(301);
    expect((await request(lanPort, '/api/v1/../users')).status).toBe(301);

    const fromInternet = await request(pubPort, '/api/v1/x');
    expect(fromInternet.status).toBe(301);
    expect(fromInternet.headers.location).toBe('https://192.168.1.20/api/v1/x');
    expect((await request(nonePort, '/api/v1/x')).status).toBe(301); // no handler (e.g. before wiring)
  });

  it('still answers ACME challenges first', async () => {
    const res = await request(lanPort, '/.well-known/acme-challenge/tok1');
    expect(res.status).toBe(200);
    expect(res.body).toBe('tok1.thumb');
  });

  it('forwards /overlay/ws upgrades from LAN clients to the app (@fastify/websocket)', async () => {
    expect(await wsFirstMessage(lanPort, '/overlay/ws?token=x')).toBe('hello from overlay');
    await expect(wsFirstMessage(lanPort, '/api/ws')).rejects.toThrow(/HTTP 301 https:\/\/192\.168\.1\.20\/api\/ws/);
    await expect(wsFirstMessage(pubPort, '/overlay/ws?token=x')).rejects.toThrow(/HTTP 301/);
    await expect(wsFirstMessage(nonePort, '/overlay/ws?token=x')).rejects.toThrow(/HTTP 301/);
  });
});

describe('the real API over the LAN listener', () => {
  let t: TestApi;
  let listener: HttpListener;
  let port: number;
  afterEach(async () => {
    await listener?.close();
    await t?.close();
  });

  it('serves /api/v1 with bearer auth and the dock with its own CSP', async () => {
    t = await createTestApi();
    listener = createHttpListener({ port: 0, host: '127.0.0.1', publicPort: 443, challenges: new Map(), log, lanHandler: () => createLanHandler(t.app) });
    port = await listener.listen();
    const token = t.token();
    const status = await request(port, '/api/v1/status', { authorization: `Bearer ${token}` });
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toHaveProperty('session');
    expect((await request(port, '/api/v1/status')).status).toBe(401);
    const dock = await request(port, '/dock');
    expect(dock.status).toBe(200);
    expect(dock.headers['content-security-policy']).toBe(DOCK_CSP);
    expect(dock.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('TlsManager.setLanHandler', () => {
  let dataDir: string;
  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const p = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => resolve(p));
      });
    });
  }

  it('hands LAN requests to the handler set before or after start(), and null removes it', async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctd-lan-'));
    const httpPort = await freePort();
    const settings: SettingsRepo = { get: (_k, fallback) => fallback, set: () => {}, delete: () => {} };
    const config = {
      dataDir,
      webPort: 8443,
      httpPort,
      publicPort: 443,
      tlsMode: 'self-signed',
      publicIp: '203.0.113.7',
      publicHost: null,
    } as AppConfig;
    const tls = createTlsManager({ config, log, settings }, { lanAddresses: () => ['192.168.1.20'], discoverPublicIp: async () => null });
    try {
      await tls.init();
      await tls.start(() => {});
      expect((await request(httpPort, '/api/v1/status')).status).toBe(301);

      const seen: string[] = [];
      tls.setLanHandler?.({
        request(req, res) {
          seen.push(req.url ?? '');
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('handled');
        },
        upgrade(_req, socket) {
          socket.destroy();
        },
      });
      const res = await request(httpPort, '/api/v1/status');
      expect(res.status).toBe(200);
      expect(res.body).toBe('handled');
      expect(seen).toEqual(['/api/v1/status']);

      tls.setLanHandler?.(null);
      expect((await request(httpPort, '/api/v1/status')).status).toBe(301);
    } finally {
      await tls.stop();
    }
  });

  it.each([
    ['LAN_HTTP=off', { LAN_HTTP: 'off' }],
    ['a peer outside LAN_HTTP_CIDRS (e.g. the proxy/gateway address)', { LAN_HTTP_CIDRS: '192.168.1.0/24' }],
  ])('%s: redirects even with a handler set', async (_name, env) => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctd-lan-'));
    const httpPort = await freePort();
    const settings: SettingsRepo = { get: (_k, fallback) => fallback, set: () => {}, delete: () => {} };
    const config = { dataDir, webPort: 8443, httpPort, publicPort: 443, tlsMode: 'self-signed', publicIp: '203.0.113.7', publicHost: null } as AppConfig;
    const tls = createTlsManager(
      { config, log, settings },
      { lanAddresses: () => ['192.168.1.20'], discoverPublicIp: async () => null, lanPolicy: lanClientPolicy(env) },
    );
    try {
      await tls.init();
      await tls.start(() => {});
      tls.setLanHandler?.({
        request(_req, res) {
          res.writeHead(200);
          res.end('handled');
        },
        upgrade(_req, socket) {
          socket.destroy();
        },
      });
      // The test client connects from 127.0.0.1: private by default, but not LAN under these settings.
      const res = await request(httpPort, '/api/v1/status');
      expect(res.status).toBe(301);
      expect(res.headers.location).toBe('https://192.168.1.20/api/v1/status');
    } finally {
      await tls.stop();
    }
  });
});
