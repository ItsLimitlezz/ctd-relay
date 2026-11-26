import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiScope, ApiTokenInfo } from '../../../shared/types.js';
import { openDatabase } from '../db/database.js';
import { createRepos } from '../db/repos.js';
import { EventBus } from '../events.js';
import { createSecretBox } from '../security/secretbox.js';
import type { Repos } from '../services.js';
import { ApiProblem } from './http.js';
import { MAX_PENDING_SCOPE_UPGRADES, SCOPE_UPGRADE_RETAIN_MS, SCOPE_UPGRADE_TTL_MS, createScopeUpgradeService, type ScopeUpgradeServiceHandle } from './scope-upgrade.js';
import { silentLog } from './test-helpers.js';

let clock: number;
const now = () => clock;
let repos: Repos;
let service: ScopeUpgradeServiceHandle;
let changes: number;
let db: ReturnType<typeof openDatabase>;

const makeToken = (scopes: ApiScope[] = ['status:read', 'chat:read'], profileId: string | null = null): { token: ApiTokenInfo; secret: string } =>
  repos.apiTokens.create({ name: 'CTD OBS plugin', scopes, createdBy: 'admin', profileId });

const ask = (token: ApiTokenInfo, scopes: unknown[], over: { appName?: string | null; reason?: string | null } = {}) =>
  service.request(token, { scopes, appName: 'appName' in over ? (over.appName ?? null) : 'CTD OBS plugin', reason: over.reason ?? null, ip: null });

function problem(fn: () => unknown): ApiProblem {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiProblem) return err;
    throw err;
  }
  throw new Error('expected an ApiProblem');
}

const auditActions = () => repos.audit.list({ limit: 100 }).map((e) => e.action);

beforeEach(() => {
  clock = Date.parse('2026-11-26T03:00:00.000Z');
  db = openDatabase(':memory:');
  repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
  const bus = new EventBus();
  service = createScopeUpgradeService({ repos, bus, log: silentLog, now });
  changes = 0;
  bus.on('scope-upgrades-changed', () => changes++);
});

afterEach(() => {
  service.close();
  db.close();
});

describe('scope upgrade: filtering', () => {
  it('ignores unknown scopes and system:admin, and drops the ones the token holds', () => {
    const { token } = makeToken();
    const r = ask(token, ['status:read', 'nope', 'system:admin', 'feeds:watch', 42]);
    expect(r.status).toBe('pending');
    if (r.status !== 'pending') return;
    expect(r.upgrade.adding).toEqual(['feeds:watch']);
    expect(r.upgrade.currentScopes).toEqual(['chat:read', 'status:read']);
    expect(service.list()).toHaveLength(1);
  });

  it('nothing new: approved with the current scopes, no request; nothing valid: 400', () => {
    const { token } = makeToken();
    expect(ask(token, ['status:read', 'nope'])).toEqual({ status: 'approved', scopes: ['chat:read', 'status:read'] });
    expect(service.list()).toEqual([]);
    expect(changes).toBe(0);
    expect(problem(() => ask(token, ['system:admin', 'nope'])).statusCode).toBe(400);
    expect(problem(() => ask(token, ['system:admin'])).code).toBe('invalid');
  });
});

describe('scope upgrade: lifecycle', () => {
  it('one pending request per token: a new one replaces the previous (which ends expired)', () => {
    const { token } = makeToken();
    const first = ask(token, ['feeds:watch']);
    const second = ask(token, ['reports:read']);
    if (first.status !== 'pending' || second.status !== 'pending') throw new Error('expected pending');
    expect(service.list().map((u) => u.id)).toEqual([second.upgrade.id]);
    expect(service.poll(first.upgrade.id, token.id)).toEqual({ status: 'expired' });
    expect(service.poll(second.upgrade.id, token.id)).toEqual({ status: 'pending' });
    expect(auditActions()).toEqual(expect.arrayContaining(['scope_upgrade.request', 'scope_upgrade.expired']));
  });

  it(`at most ${MAX_PENDING_SCOPE_UPGRADES} pending in total: 429 with Retry-After; replacing your own still works`, () => {
    const tokens = Array.from({ length: MAX_PENDING_SCOPE_UPGRADES }, () => makeToken().token);
    for (const t of tokens) ask(t, ['feeds:watch']);
    const extra = makeToken().token;
    const p = problem(() => ask(extra, ['feeds:watch']));
    expect(p.statusCode).toBe(429);
    expect(p.retryAfterSec).toBe(SCOPE_UPGRADE_TTL_MS / 1000);
    expect(ask(tokens[0] as ApiTokenInfo, ['reports:read']).status).toBe('pending');
    expect(service.list()).toHaveLength(MAX_PENDING_SCOPE_UPGRADES);
  });

  it('expires after the TTL, answers 10 more minutes, then is forgotten', () => {
    const { token } = makeToken();
    const r = ask(token, ['feeds:watch']);
    if (r.status !== 'pending') throw new Error('expected pending');
    clock += SCOPE_UPGRADE_TTL_MS;
    expect(service.list()).toEqual([]);
    expect(service.poll(r.upgrade.id, token.id)).toEqual({ status: 'expired' });
    expect(problem(() => service.approve(r.upgrade.id)).statusCode).toBe(410);
    expect(repos.audit.list({ limit: 10 })[0]).toMatchObject({ action: 'scope_upgrade.expired', detail: expect.stringContaining('not answered in time') });
    clock += SCOPE_UPGRADE_RETAIN_MS;
    expect(service.poll(r.upgrade.id, token.id)).toBeNull();
  });

  it('the token revoked while pending: the request ends expired', () => {
    const { token } = makeToken();
    const r = ask(token, ['feeds:watch']);
    if (r.status !== 'pending') throw new Error('expected pending');
    repos.apiTokens.delete(token.id);
    const before = changes;
    expect(service.list()).toEqual([]);
    expect(changes).toBe(before + 1);
    expect(service.poll(r.upgrade.id, token.id)).toEqual({ status: 'expired' });
    expect(repos.audit.list({ limit: 10 })[0]).toMatchObject({ action: 'scope_upgrade.expired', detail: expect.stringContaining('token revoked') });
  });

  it('a request from before a restart answers expired; an unknown one null', () => {
    const { token } = makeToken();
    const r = ask(token, ['feeds:watch']);
    if (r.status !== 'pending') throw new Error('expected pending');
    const restarted = createScopeUpgradeService({ repos, bus: new EventBus(), log: silentLog, now });
    try {
      expect(restarted.poll(r.upgrade.id, token.id)).toEqual({ status: 'expired' });
      expect(restarted.poll('not-an-id', token.id)).toBeNull();
    } finally {
      restarted.close();
    }
  });

  it('another token cannot poll it', () => {
    const { token } = makeToken();
    const other = makeToken().token;
    const r = ask(token, ['feeds:watch']);
    if (r.status !== 'pending') throw new Error('expected pending');
    expect(service.poll(r.upgrade.id, other.id)).toBeNull();
    expect(service.poll('nope', token.id)).toBeNull();
  });
});

describe('scope upgrade: approve / deny', () => {
  it('approve adds exactly the requested scopes to the same token; its profile and secret stay', () => {
    const club = repos.profiles.create({ name: 'DPRTMNT', color: null });
    const { token, secret } = makeToken(['status:read'], club.id);
    const r = ask(token, ['feeds:watch', 'reports:read', 'system:admin']);
    if (r.status !== 'pending') throw new Error('expected pending');
    const { token: updated, upgrade } = service.approve(r.upgrade.id);
    expect(upgrade.adding).toEqual(['reports:read', 'feeds:watch']);
    expect(updated).toMatchObject({ id: token.id, prefix: token.prefix, profileId: club.id, scopes: ['status:read', 'reports:read', 'feeds:watch'] });
    // The very next verify (every API request) sees the new scopes with the same secret.
    expect(repos.apiTokens.verify(secret)).toMatchObject({ id: token.id, profileId: club.id, scopes: ['status:read', 'reports:read', 'feeds:watch'] });
    expect(service.poll(r.upgrade.id, token.id)).toEqual({ status: 'approved', scopes: ['status:read', 'reports:read', 'feeds:watch'] });
    expect(service.list()).toEqual([]);
    expect(problem(() => service.approve(r.upgrade.id)).statusCode).toBe(409);
  });

  it('deny leaves the token as it was', () => {
    const { token } = makeToken();
    const r = ask(token, ['ingest:read']);
    if (r.status !== 'pending') throw new Error('expected pending');
    expect(service.deny(r.upgrade.id).adding).toEqual(['ingest:read']);
    expect(service.poll(r.upgrade.id, token.id)).toEqual({ status: 'denied' });
    expect(repos.apiTokens.list()[0]?.scopes).toEqual(['chat:read', 'status:read']);
    expect(problem(() => service.deny('nope')).statusCode).toBe(404);
  });

  it('lists the token, its profile, the registered app and the reason; never a secret', () => {
    const { token, secret } = makeToken();
    repos.connectedApps.upsert({ id: 'ctd-obs', name: 'CTD OBS plugin (Studio PC)', kind: 'ctd-obs-plugin', version: '1.0.0', baseUrl: null, capabilities: [], resources: [], tokenId: token.id, profileId: null });
    ask(token, ['feeds:watch'], { appName: null, reason: 'Live preview in the dock' });
    const [u] = service.list();
    expect(u).toMatchObject({ tokenId: token.id, tokenName: 'CTD OBS plugin', tokenPrefix: token.prefix, profileId: null, appName: 'CTD OBS plugin (Studio PC)', kind: 'ctd-obs-plugin', adding: ['feeds:watch'], reason: 'Live preview in the dock' });
    expect(JSON.stringify(service.list())).not.toContain(secret);
    expect(JSON.stringify(repos.audit.list({ limit: 10 }))).not.toContain(secret);
  });
});

describe('ApiTokensRepo.addScopes', () => {
  it('keeps scopes it does not know (written by a newer version) and returns null for an unknown token', () => {
    const { token } = makeToken(['status:read']);
    db.prepare('UPDATE api_tokens SET scopes = ? WHERE id = ?').run(JSON.stringify(['status:read', 'future:thing']), token.id);
    expect(repos.apiTokens.addScopes(token.id, ['chat:read', 'status:read'])?.scopes).toEqual(['chat:read', 'status:read']);
    const raw = db.prepare('SELECT scopes FROM api_tokens WHERE id = ?').get(token.id) as { scopes: string };
    expect(JSON.parse(raw.scopes)).toEqual(['status:read', 'future:thing', 'chat:read']);
    expect(repos.apiTokens.addScopes('nope', ['chat:read'])).toBeNull();
  });
});
