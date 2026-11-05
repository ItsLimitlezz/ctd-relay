// Hub admin routes (pairings + connected apps) and the profile binding of API tokens, with fake
// PairingService / AppRegistry / repos and a fake auth hook (header x-test-role).

import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import type { ApiTokensResponse, CreateApiTokenResponse } from '../../../../shared/api.js';
import type { ApiScope, ApiTokenInfo, ConnectedApp, PairingRequest, Profile, Role } from '../../../../shared/types.js';
import { EventBus } from '../../events.js';
import type { AppConfig } from '../../config.js';
import type { AppServices } from '../../services.js';
import { sendError } from '../guards.js';
import pairingRoutes, { type ApprovePairingResponse } from './pairings.js';
import tokenRoutes, { MAX_API_TOKENS } from './tokens.js';

const SECRET_TAIL = 'Zx9SuperSecretTokenTail';

function profile(id: string, name: string): Profile {
  return { id, name, slug: id === 'default' ? 'main' : id, color: null, createdAt: '', updatedAt: '' };
}

function pairing(id: string, over: Partial<PairingRequest> = {}): PairingRequest {
  return {
    id,
    appName: 'CTD OBS plugin (Studio PC)',
    kind: 'ctd-obs-plugin',
    code: 'KQ7-2MX',
    requestedScopes: ['status:read', 'chat:read', 'ingest:read', 'apps:read', 'apps:write'],
    requestedProfileId: null,
    ip: '192.168.1.30',
    createdAt: '2026-10-15T14:00:00.000Z',
    expiresAt: '2026-10-15T14:10:00.000Z',
    ...over,
  };
}

function connectedApp(id: string, tokenId: string): ConnectedApp {
  return {
    id,
    name: 'CTD Overlay',
    kind: 'ctd-overlay',
    version: '1.4.0',
    baseUrl: 'http://10.20.30.40:30200',
    capabilities: ['overlays'],
    resources: [],
    tokenId,
    profileId: null,
    registeredAt: '2026-10-15T14:00:00.000Z',
    lastSeenAt: '2026-10-15T14:00:00.000Z',
    online: true,
  };
}

function setup() {
  const profiles = new Map([
    ['default', profile('default', 'Miami or Bust')],
    ['club', profile('club', 'DPRTMNT')],
  ]);
  let seq = 0;
  const tokens: ApiTokenInfo[] = [];
  const secrets = new Map<string, string>();
  const apiTokens = {
    list: () => tokens.map((t) => ({ ...t })),
    create(input: { name: string; scopes: ApiScope[]; createdBy: string | null; profileId?: string | null }) {
      const token: ApiTokenInfo = {
        id: `tok${++seq}`,
        name: input.name,
        scopes: input.scopes,
        profileId: input.profileId ?? null,
        prefix: `ctd_pat_${seq}abc`,
        createdAt: '2026-10-15T14:00:00.000Z',
        createdBy: input.createdBy,
        lastUsedAt: null,
      };
      tokens.push(token);
      const secret = `${token.prefix}${SECRET_TAIL}`;
      secrets.set(token.id, secret);
      return { token, secret };
    },
    verify: () => null,
    delete(id: string) {
      const i = tokens.findIndex((t) => t.id === id);
      if (i >= 0) tokens.splice(i, 1);
    },
  };

  const pending = new Map<string, PairingRequest>([
    ['pr1', pairing('pr1')],
    ['pr2', pairing('pr2', { appName: 'CTD Overlay', kind: 'ctd-overlay', code: 'AB3-CD4', requestedScopes: ['chat:read'] })],
  ]);
  /** Secrets the app collects by polling (never returned to the admin). */
  const collected = new Map<string, string>();
  const pairings = {
    create: vi.fn(),
    poll: vi.fn(),
    list: vi.fn(() => [...pending.values()]),
    approve: vi.fn((id: string, opts: { name?: string; scopes: ApiScope[]; profileId: string | null; approvedBy: string | null }) => {
      const request = pending.get(id);
      if (!request) throw Object.assign(new Error('Pairing expired'), { statusCode: 410, code: 'expired' });
      pending.delete(id);
      const created = apiTokens.create({ name: opts.name ?? request.appName, scopes: opts.scopes, createdBy: opts.approvedBy, profileId: opts.profileId });
      collected.set(id, created.secret);
      return created.token;
    }),
    deny: vi.fn((id: string) => void pending.delete(id)),
  };

  const appList = new Map<string, ConnectedApp>([['ctd-overlay', connectedApp('ctd-overlay', 'tok-old')]]);
  const apps = {
    list: vi.fn(() => [...appList.values()]),
    get: vi.fn((id: string) => appList.get(id) ?? null),
    register: vi.fn(),
    heartbeat: vi.fn(),
    remove: vi.fn((id: string) => void appList.delete(id)),
    removeByToken: vi.fn((tokenId: string) => {
      for (const [id, a] of appList) if (a.tokenId === tokenId) appList.delete(id);
    }),
  };

  const auditEntries: { action: string; detail: string | null; username: string | null }[] = [];
  const services = {
    config: { tlsMode: 'self-signed', webPort: 8443, httpPort: 8080, version: '9.9.9' } as AppConfig,
    log: pino({ level: 'silent' }),
    bus: new EventBus(),
    repos: {
      profiles: { list: () => [...profiles.values()], get: (id: string) => profiles.get(id) ?? null },
      apiTokens,
      settings: { get: <T>(_key: string, fallback: T) => fallback, set: () => {}, delete: () => {} },
      audit: { log: (e: { action: string; detail?: string | null; username: string | null }) => void auditEntries.push({ action: e.action, detail: e.detail ?? null, username: e.username }), list: () => [] },
    },
    tls: { status: () => ({ fingerprint256: 'AA:BB' }) },
    publicBaseUrl: () => 'https://203.0.113.7',
    pairings,
    apps,
  } as unknown as AppServices;
  return { services, tokens, secrets, pending, collected, pairings, apps, appList, auditEntries, profiles };
}

let fx: ReturnType<typeof setup>;
let app: FastifyInstance;

beforeEach(async () => {
  fx = setup();
  app = Fastify({ logger: false });
  // Same mapping as the app-level handler in http/app.ts.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return sendError(reply, 400, err.message, 'invalid');
    const e = err as { statusCode?: number; message?: string; code?: unknown };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      const code = typeof e.code === 'string' && !e.code.startsWith('FST_') ? e.code : undefined;
      return sendError(reply, e.statusCode, e.message ?? 'Bad request', code);
    }
    return sendError(reply, 500, 'Internal error');
  });
  app.decorateRequest('user', null);
  app.decorateRequest('authSession', null);
  app.addHook('onRequest', async (req) => {
    const role = req.headers['x-test-role'];
    req.user =
      role === 'admin' || role === 'operator'
        ? { id: `user-${role}`, username: `${role}-name`, role, totpEnabled: false, createdAt: '', lastLoginAt: null }
        : null;
  });
  await app.register(tokenRoutes, { services: fx.services });
  await app.register(pairingRoutes, { services: fx.services });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function call(method: 'GET' | 'POST' | 'DELETE', url: string, role: Role | null = 'admin', payload?: unknown) {
  const headers: Record<string, string> = { host: '192.168.1.20:30443' };
  if (role) headers['x-test-role'] = role;
  return app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

const approveBody = { scopes: ['ingest:read', 'status:read', 'apps:read', 'status:read'], profileId: 'club' };

// ---------------------------------------------------------------------------
// Pairings
// ---------------------------------------------------------------------------

describe('pairings', () => {
  it('is admin only', async () => {
    for (const [method, url, body] of [
      ['GET', '/api/pairings', undefined],
      ['POST', '/api/pairings/pr1/approve', approveBody],
      ['POST', '/api/pairings/pr1/deny', {}],
      ['GET', '/api/apps', undefined],
      ['DELETE', '/api/apps/ctd-overlay', undefined],
    ] as const) {
      expect((await call(method, url, null, body)).statusCode, url).toBe(401);
      expect((await call(method, url, 'operator', body)).statusCode, url).toBe(403);
    }
    expect(fx.pairings.approve).not.toHaveBeenCalled();
    expect(fx.pairings.deny).not.toHaveBeenCalled();
    expect(fx.apps.remove).not.toHaveBeenCalled();
  });

  it('lists pending pairings, never cached', async () => {
    const res = await call('GET', '/api/pairings');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json<PairingRequest[]>().map((p) => [p.id, p.code])).toEqual([
      ['pr1', 'KQ7-2MX'],
      ['pr2', 'AB3-CD4'],
    ]);
  });

  it('approves with the chosen profile + scopes; the secret only goes to the app', async () => {
    const res = await call('POST', '/api/pairings/pr1/approve', 'admin', { ...approveBody, name: '  OBS Studio PC  ' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { token } = res.json<ApprovePairingResponse>();
    expect(token).toMatchObject({ name: 'OBS Studio PC', profileId: 'club', scopes: ['status:read', 'ingest:read', 'apps:read'], createdBy: 'admin-name' });
    expect(fx.pairings.approve).toHaveBeenCalledWith('pr1', {
      name: 'OBS Studio PC',
      scopes: ['status:read', 'ingest:read', 'apps:read'],
      profileId: 'club',
      approvedBy: 'admin-name',
    });
    expect(res.body).not.toContain(SECRET_TAIL);
    expect(fx.collected.get('pr1')).toContain(SECRET_TAIL); // held for the app's next poll

    const entry = fx.auditEntries.at(-1)!;
    expect(entry).toMatchObject({ action: 'pairing.approve', username: 'admin-name' });
    expect(entry.detail).toContain('"CTD OBS plugin (Studio PC)" (ctd-obs-plugin)');
    expect(entry.detail).toContain('profile "DPRTMNT" (club)');
    expect(entry.detail).toContain('scopes=status:read, ingest:read, apps:read');
    expect(JSON.stringify(fx.auditEntries)).not.toContain(SECRET_TAIL);
    expect(fx.pending.has('pr1')).toBe(false);
  });

  it('approves for every profile with profileId null (token name defaults to the app name)', async () => {
    const res = await call('POST', '/api/pairings/pr2/approve', 'admin', { scopes: ['chat:read'], profileId: null });
    expect(res.statusCode).toBe(200);
    expect(res.json<ApprovePairingResponse>().token).toMatchObject({ name: 'CTD Overlay', profileId: null });
    expect(fx.pairings.approve.mock.calls[0]?.[1]).not.toHaveProperty('name');
    expect(fx.auditEntries.at(-1)?.detail).toContain('every profile');
  });

  it.each([
    [{ scopes: ['chat:read'] }], // profileId must be explicit (null = every profile)
    [{ profileId: null }],
    [{ scopes: [], profileId: null }],
    [{ scopes: ['admin'], profileId: null }],
    [{ scopes: ['chat:read'], profileId: '' }],
    [{ scopes: ['chat:read'], profileId: null, extra: true }],
    [{ scopes: ['chat:read'], profileId: null, name: 'x'.repeat(61) }],
    [{ scopes: ['chat:read'], profileId: null, name: 'bad‮name' }],
  ])('rejects approve body %j', async (body) => {
    const res = await call('POST', '/api/pairings/pr1/approve', 'admin', body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid' });
    expect(fx.pairings.approve).not.toHaveBeenCalled();
  });

  it('404s for unknown pairings and unknown profiles', async () => {
    let res = await call('POST', '/api/pairings/gone/approve', 'admin', approveBody);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found' });
    res = await call('POST', '/api/pairings/pr1/approve', 'admin', { ...approveBody, profileId: 'ghost' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'unknown_profile' });
    expect(fx.pairings.approve).not.toHaveBeenCalled();
    expect((await call('POST', '/api/pairings/gone/deny', 'admin', {})).statusCode).toBe(404);
  });

  it("passes the pairing service's own errors through (e.g. expired meanwhile)", async () => {
    fx.pairings.list.mockReturnValueOnce([pairing('pr9')]);
    const res = await call('POST', '/api/pairings/pr9/approve', 'admin', approveBody);
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ code: 'expired' });
    expect(fx.tokens).toHaveLength(0);
  });

  it(`refuses to approve beyond ${MAX_API_TOKENS} tokens`, async () => {
    for (let i = 0; i < MAX_API_TOKENS; i++) fx.services.repos.apiTokens.create({ name: `t${i}`, scopes: ['chat:read'], createdBy: null });
    const res = await call('POST', '/api/pairings/pr1/approve', 'admin', approveBody);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'limit' });
    expect(fx.pending.has('pr1')).toBe(true);
  });

  it('denies a pairing and audits it', async () => {
    const res = await call('POST', '/api/pairings/pr2/deny', 'admin', {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    expect(fx.pairings.deny).toHaveBeenCalledWith('pr2');
    expect(fx.auditEntries.at(-1)).toMatchObject({ action: 'pairing.deny', detail: '"CTD Overlay" (ctd-overlay) code=AB3-CD4' });
    expect(fx.tokens).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Connected apps
// ---------------------------------------------------------------------------

describe('connected apps', () => {
  it('lists every connected app', async () => {
    const res = await call('GET', '/api/apps');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json<ConnectedApp[]>().map((a) => a.id)).toEqual(['ctd-overlay']);
    expect(fx.apps.list).toHaveBeenCalledWith();
  });

  it('removes an app and audits it', async () => {
    expect((await call('DELETE', '/api/apps/nope')).statusCode).toBe(404);
    const res = await call('DELETE', '/api/apps/ctd-overlay');
    expect(res.statusCode).toBe(200);
    expect(fx.apps.remove).toHaveBeenCalledWith('ctd-overlay');
    expect(fx.appList.size).toBe(0);
    expect(fx.auditEntries.at(-1)).toMatchObject({ action: 'app.remove', detail: '"CTD Overlay" id=ctd-overlay kind=ctd-overlay' });
  });
});

// ---------------------------------------------------------------------------
// API tokens: profile binding
// ---------------------------------------------------------------------------

describe('API tokens per profile', () => {
  it('creates a token limited to a profile and lists it with the profile', async () => {
    const res = await call('POST', '/api/tokens', 'admin', { name: 'DPRTMNT overlay', scopes: ['chat:read'], profileId: 'club' });
    expect(res.statusCode).toBe(200);
    const { token, secret } = res.json<CreateApiTokenResponse>();
    expect(secret).toContain(SECRET_TAIL);
    expect(token).toMatchObject({ name: 'DPRTMNT overlay', profileId: 'club' });
    expect(fx.auditEntries.at(-1)?.detail).toContain('profile "DPRTMNT" (club)');
    expect(JSON.stringify(fx.auditEntries)).not.toContain(SECRET_TAIL);

    const list = (await call('GET', '/api/tokens')).json<ApiTokensResponse>();
    expect(list.tokens).toEqual([token]);
  });

  it('omitted or null = every profile', async () => {
    const omitted = (await call('POST', '/api/tokens', 'admin', { name: 'a', scopes: ['status:read'] })).json<CreateApiTokenResponse>();
    const explicit = (await call('POST', '/api/tokens', 'admin', { name: 'b', scopes: ['status:read'], profileId: null })).json<CreateApiTokenResponse>();
    expect(omitted.token.profileId).toBeNull();
    expect(explicit.token.profileId).toBeNull();
    expect(fx.auditEntries.at(-1)?.detail).toContain('every profile');
  });

  it('accepts the new hub scopes', async () => {
    const res = await call('POST', '/api/tokens', 'admin', { name: 'OBS plugin', scopes: ['apps:write', 'ingest:read', 'apps:read'] });
    expect(res.json<CreateApiTokenResponse>().token.scopes).toEqual(['ingest:read', 'apps:read', 'apps:write']);
  });

  it('rejects unknown (404 unknown_profile) and malformed (400) profiles', async () => {
    let res = await call('POST', '/api/tokens', 'admin', { name: 'x', scopes: ['chat:read'], profileId: 'ghost' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'unknown_profile' });
    res = await call('POST', '/api/tokens', 'admin', { name: 'x', scopes: ['chat:read'], profileId: '' });
    expect(res.statusCode).toBe(400);
    res = await call('POST', '/api/tokens', 'admin', { name: 'x', scopes: ['chat:read'], profileId: 42 });
    expect(res.statusCode).toBe(400);
    expect(fx.tokens).toHaveLength(0);
  });

  it('revoking a token also removes the apps it registered', async () => {
    const { token } = (await call('POST', '/api/tokens', 'admin', { name: 'Overlay', scopes: ['apps:write'] })).json<CreateApiTokenResponse>();
    fx.appList.set('ctd-overlay-dprtmnt', connectedApp('ctd-overlay-dprtmnt', token.id));
    const res = await call('DELETE', `/api/tokens/${token.id}`);
    expect(res.statusCode).toBe(200);
    expect(fx.apps.removeByToken).toHaveBeenCalledWith(token.id);
    expect([...fx.appList.keys()]).toEqual(['ctd-overlay']);
    expect(fx.tokens).toHaveLength(0);
  });

  it('revokes the token even if cleaning up its apps fails', async () => {
    const { token } = (await call('POST', '/api/tokens', 'admin', { name: 'Overlay', scopes: ['apps:write'] })).json<CreateApiTokenResponse>();
    fx.apps.removeByToken.mockImplementationOnce(() => {
      throw new Error('db locked');
    });
    const res = await call('DELETE', `/api/tokens/${token.id}`);
    expect(res.statusCode).toBe(200);
    expect(fx.tokens).toHaveLength(0);
    expect(fx.auditEntries.at(-1)).toMatchObject({ action: 'api_token.delete' });
  });
});
