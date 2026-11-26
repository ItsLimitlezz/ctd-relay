// Settings → API admin routes for scope upgrades, on a real in-memory database and service, with a
// fake auth hook (header x-test-role).

import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiScope, Role } from '../../../../shared/types.js';
import { silentLog } from '../../api/test-helpers.js';
import { createScopeUpgradeService, type ScopeUpgradeServiceHandle } from '../../api/scope-upgrade.js';
import { openDatabase } from '../../db/database.js';
import { createRepos } from '../../db/repos.js';
import { EventBus } from '../../events.js';
import { createSecretBox } from '../../security/secretbox.js';
import type { AppServices, Repos } from '../../services.js';
import scopeUpgradeRoutes from './scope-upgrades.js';

let db: ReturnType<typeof openDatabase>;
let repos: Repos;
let service: ScopeUpgradeServiceHandle;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDatabase(':memory:');
  repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
  const bus = new EventBus();
  service = createScopeUpgradeService({ repos, bus, log: silentLog });
  const services = { repos, bus, log: silentLog, scopeUpgrades: service } as unknown as AppServices;
  app = Fastify({ logger: false });
  app.decorateRequest('user', null);
  app.decorateRequest('authSession', null);
  app.addHook('onRequest', async (req) => {
    const role = req.headers['x-test-role'];
    req.user =
      role === 'admin' || role === 'operator'
        ? { id: `user-${role}`, username: `${role}-name`, role, totpEnabled: false, createdAt: '', lastLoginAt: null }
        : null;
  });
  await app.register(scopeUpgradeRoutes, { services });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  service.close();
  db.close();
});

const call = (method: 'GET' | 'POST', url: string, role: Role | null = 'admin') =>
  app.inject({ method, url, headers: role ? { 'x-test-role': role } : {} });

function pendingFor(scopes: ApiScope[] = ['status:read'], profileId: string | null = null) {
  const created = repos.apiTokens.create({ name: 'CTD OBS plugin', scopes, createdBy: 'admin', profileId });
  const r = service.request(created.token, { scopes: ['feeds:watch', 'show:secrets'], appName: 'CTD OBS plugin', reason: 'Preview and sources', ip: null });
  if (r.status !== 'pending') throw new Error('expected pending');
  return { ...created, upgrade: r.upgrade };
}

describe('scope upgrade admin routes', () => {
  it('admins only', async () => {
    const { upgrade } = pendingFor();
    for (const role of [null, 'operator'] as const) {
      expect((await call('GET', '/api/scope-upgrades', role)).statusCode).toBeGreaterThanOrEqual(401);
      expect((await call('POST', `/api/scope-upgrades/${upgrade.id}/approve`, role)).statusCode).toBeGreaterThanOrEqual(401);
      expect((await call('POST', `/api/scope-upgrades/${upgrade.id}/deny`, role)).statusCode).toBeGreaterThanOrEqual(401);
    }
    expect(service.list()).toHaveLength(1);
  });

  it('lists pending requests; approve adds exactly the requested scopes and audits without secrets', async () => {
    const club = repos.profiles.create({ name: 'DPRTMNT', color: null });
    const { upgrade, secret, token } = pendingFor(['status:read'], club.id);
    const list = await call('GET', '/api/scope-upgrades');
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([
      expect.objectContaining({ id: upgrade.id, tokenId: token.id, tokenPrefix: token.prefix, profileId: club.id, appName: 'CTD OBS plugin', adding: ['show:secrets', 'feeds:watch'], currentScopes: ['status:read'], reason: 'Preview and sources' }),
    ]);
    expect(list.body).not.toContain(secret);

    const res = await call('POST', `/api/scope-upgrades/${upgrade.id}/approve`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().token).toMatchObject({ id: token.id, profileId: club.id, scopes: ['status:read', 'show:secrets', 'feeds:watch'] });
    expect(res.body).not.toContain(secret);
    expect(repos.apiTokens.verify(secret)?.scopes).toEqual(['status:read', 'show:secrets', 'feeds:watch']);
    expect((await call('POST', `/api/scope-upgrades/${upgrade.id}/approve`)).statusCode).toBe(404);

    const entries = repos.audit.list({ limit: 10 });
    expect(entries.map((e) => e.action)).toEqual(['scope_upgrade.approve', 'scope_upgrade.request']);
    expect(entries[0]).toMatchObject({ username: 'admin-name', detail: `"CTD OBS plugin" token=${token.prefix}… adding=show:secrets, feeds:watch scopes=status:read, show:secrets, feeds:watch` });
    expect(JSON.stringify(entries)).not.toContain(secret);
  });

  it('deny leaves the token alone and is audited', async () => {
    const { upgrade, secret, token } = pendingFor();
    expect((await call('POST', `/api/scope-upgrades/${upgrade.id}/deny`)).json()).toEqual({});
    expect(repos.apiTokens.verify(secret)?.scopes).toEqual(['status:read']);
    expect(service.list()).toEqual([]);
    const [entry] = repos.audit.list({ limit: 1 });
    expect(entry).toMatchObject({ action: 'scope_upgrade.deny', username: 'admin-name', detail: `"CTD OBS plugin" token=${token.prefix}… adding=show:secrets, feeds:watch` });
    expect(JSON.stringify(repos.audit.list({ limit: 10 }))).not.toContain(secret);
    expect((await call('POST', '/api/scope-upgrades/nope/deny')).statusCode).toBe(404);
  });
});
