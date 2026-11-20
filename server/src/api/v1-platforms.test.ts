// The operator routes (docs/API.md §15): the Instagram chat reader's selector pack and debug
// capture, through the external API (system:admin token) and the web UI's routes (admin session).

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER, SESSION_COOKIE, type InstagramChatPackStatus } from '../../../shared/api.js';
import { ADMIN_ONLY_SCOPES, API_SCOPES, type Role } from '../../../shared/types.js';
import { sendError } from '../http/guards.js';
import platformRoutes from '../http/routes/platforms.js';
import { BUILTIN_CHAT_PACK, CHAT_PACK_MAX_BYTES, CHAT_PACK_SETTING, chatPackStore } from '../platforms/instagram/chat-pack.js';
import type { AppServices } from '../services.js';
import { PAIRING_SCOPES } from './pairing.js';
import { createTestApi, type TestApi } from './test-helpers.js';

const PACK = '/api/v1/platforms/instagram/chat/selector-pack';
const DEBUG = '/api/v1/platforms/instagram/chat/debug';
const OVERRIDE = { schema: 1, version: 'tuned-1', note: 'new comment rows', row: { css: ['[data-comment-id]'], idAttrs: ['data-comment-id'] } };

let t: TestApi;

beforeEach(async () => {
  t = await createTestApi();
  chatPackStore.attach(t.repos.settings);
});
afterEach(async () => {
  chatPackStore.attach(null);
  await t.close();
});

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
const audited = () => t.repos.audit.list({ limit: 20 }).map((e) => ({ action: e.action, detail: e.detail, username: e.username }));

describe('system:admin scope', () => {
  it('is a known scope that pairing can neither ask for nor be given', async () => {
    expect(API_SCOPES).toContain('system:admin');
    expect(ADMIN_ONLY_SCOPES).toEqual(['system:admin']);
    expect(PAIRING_SCOPES).not.toContain('system:admin');
    expect(PAIRING_SCOPES).toHaveLength(API_SCOPES.length - 1);

    // Asked for together with other scopes: dropped. Asked for alone: nothing left to ask for.
    const mixed = await t.app.inject({ method: 'POST', url: '/api/v1/pairing', payload: { appName: 'Some app', kind: 'tool', scopes: ['system:admin', 'status:read'] } });
    expect(mixed.statusCode).toBe(201);
    const [pending] = t.pairings.list();
    expect(pending!.requestedScopes).toEqual(['status:read']);
    const alone = await t.app.inject({ method: 'POST', url: '/api/v1/pairing', payload: { appName: 'Some app', kind: 'tool', scopes: ['system:admin'] } });
    expect(alone.statusCode).toBe(400);

    // Even an admin's approval cannot add it to a paired app's token.
    const token = t.pairings.approve(pending!.id, { scopes: ['status:read', 'system:admin'], profileId: null, approvedBy: 'admin' });
    expect(token.scopes).toEqual(['status:read']);
    expect(() => t.pairings.approve(t.pairings.list()[0]?.id ?? pending!.id, { scopes: ['system:admin'], profileId: null, approvedBy: 'admin' })).toThrow();
  });

  it('can be put on a token for every profile in Settings → API, not on a profile-limited one', async () => {
    const user = t.repos.users.create({ username: 'admin', passwordHash: 'x', role: 'admin' satisfies Role });
    const { record, token } = t.repos.authSessions.create(user.id, { ip: null, userAgent: null });
    const headers = { cookie: `${SESSION_COOKIE}=${token}`, [CSRF_HEADER]: record.csrfToken, host: '192.168.1.20:30443' };
    const limited = await t.app.inject({ method: 'POST', url: '/api/tokens', headers, payload: { name: 'Support', scopes: ['system:admin'], profileId: 'default' } });
    expect(limited.statusCode).toBe(400);
    expect(limited.json().error).toMatch(/system:admin.*cannot be limited to one profile/);
    const all = await t.app.inject({ method: 'POST', url: '/api/tokens', headers, payload: { name: 'Support', scopes: [...API_SCOPES] } });
    expect(all.statusCode).toBe(200);
    expect(all.json().token.scopes).toEqual([...API_SCOPES]);
    expect((await t.app.inject({ method: 'GET', url: PACK, headers: bearer(all.json().secret) })).statusCode).toBe(200);
  });
});

describe('GET/PUT/DELETE /platforms/instagram/chat/selector-pack', () => {
  it('needs a token with system:admin that is not limited to a profile', async () => {
    expect((await t.app.inject({ method: 'GET', url: PACK })).statusCode).toBe(401);
    const everythingElse = t.token(API_SCOPES.filter((s) => s !== 'system:admin'));
    for (const [method, url] of [['GET', PACK], ['PUT', PACK], ['DELETE', PACK], ['POST', DEBUG]] as const) {
      const res = await t.app.inject({ method, url, headers: bearer(everythingElse), ...(method === 'PUT' ? { payload: OVERRIDE } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().code).toBe('missing_scope');
    }
    // A token row limited to one profile (older data, or written by hand) is refused too.
    const limited = t.token(['system:admin'], 'limited', 'default');
    const res = await t.app.inject({ method: 'PUT', url: PACK, headers: bearer(limited), payload: OVERRIDE });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('profile_forbidden');
    expect(chatPackStore.state().source).toBe('builtin');
    expect(audited()).toEqual([]);
  });

  it('reads the built-in pack, stores an override, keeps it across a restart, and reverts', async () => {
    const admin = bearer(t.token(['system:admin'], 'Support agent'));
    const before = await t.app.inject({ method: 'GET', url: PACK, headers: admin });
    expect(before.statusCode).toBe(200);
    expect(before.headers['cache-control']).toBe('no-store');
    expect(before.json<InstagramChatPackStatus>()).toEqual({
      source: 'builtin',
      version: BUILTIN_CHAT_PACK.version,
      builtinVersion: BUILTIN_CHAT_PACK.version,
      note: null,
      updatedAt: null,
      updatedBy: null,
      readers: 0,
      maxBytes: CHAT_PACK_MAX_BYTES,
      pack: BUILTIN_CHAT_PACK,
      override: null,
    });

    const put = await t.app.inject({ method: 'PUT', url: PACK, headers: admin, payload: OVERRIDE });
    expect(put.statusCode).toBe(200);
    const status = put.json<InstagramChatPackStatus>();
    expect(status).toMatchObject({ source: 'override', version: 'tuned-1', note: 'new comment rows', updatedBy: 'token Support agent', override: OVERRIDE });
    expect(status.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect((status.pack as { row: { css: string[]; avatarCss: string[] } }).row).toMatchObject({ css: ['[data-comment-id]'], avatarCss: BUILTIN_CHAT_PACK.row.avatarCss });
    // What the reader asks for on its next poll.
    expect(chatPackStore.active().row.css).toEqual(['[data-comment-id]']);
    // Stored in the settings table: a restart loads it again.
    expect(t.repos.settings.get<{ override: unknown } | null>(CHAT_PACK_SETTING, null)?.override).toEqual(OVERRIDE);
    chatPackStore.attach(null);
    expect(chatPackStore.state().source).toBe('builtin');
    chatPackStore.attach(t.repos.settings);
    expect((await t.app.inject({ method: 'GET', url: PACK, headers: admin })).json()).toMatchObject({ source: 'override', version: 'tuned-1' });

    const del = await t.app.inject({ method: 'DELETE', url: PACK, headers: admin });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ source: 'builtin', version: BUILTIN_CHAT_PACK.version, override: null, updatedBy: null });
    expect(t.repos.settings.get(CHAT_PACK_SETTING, null)).toBeNull();
    expect(chatPackStore.active()).toEqual(BUILTIN_CHAT_PACK);
    // Reverting again changes nothing and is not audited again.
    expect((await t.app.inject({ method: 'DELETE', url: PACK, headers: admin })).statusCode).toBe(200);

    const log = audited().reverse();
    expect(log.map((e) => e.action)).toEqual(['instagram.chat_pack.update', 'instagram.chat_pack.revert']);
    expect(log[0]!.detail).toMatch(/^version "tuned-1" \(\d+ bytes; changes row\), by API token "Support agent" \(ctd_pat_[\w-]+…\)$/);
    expect(log[1]!.detail).toContain(`back to the built-in pack ${BUILTIN_CHAT_PACK.version}`);
    // The audit log says who and what, never the token itself.
    expect(JSON.stringify(log)).not.toMatch(/ctd_pat_[\w-]{20,}/);
  });

  it('refuses packs that are not valid, listing every problem, and changes nothing', async () => {
    const admin = bearer(t.token(['system:admin']));
    const bad = await t.app.inject({
      method: 'PUT',
      url: PACK,
      headers: admin,
      payload: { schema: 1, version: 'v', row: { css: ['xpath=//div'], extract: '(el) => el.textContent' }, text: { meta: ['^(a+)+$'] }, timing: { pollMs: 1 } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['content-type']).toContain('application/problem+json');
    const detail = bad.json().detail as string;
    expect(bad.json().code).toBe('invalid');
    expect(detail).toMatch(/row\.css\.0: CSS selector/);
    expect(detail).toMatch(/row: Unrecognized key/i);
    expect(detail).toMatch(/text\.meta\.0: regular expression: too slow/);
    expect(detail).toMatch(/timing\.pollMs/);

    for (const payload of [[], 'pack', { version: 'v' }, { schema: 1, version: 'v', container: { css: ['"); alert(1); ("'] } }]) {
      const res = await t.app.inject({ method: 'PUT', url: PACK, headers: { ...admin, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    // Over the pack's size cap: refused as invalid; far over it: the body is not even read.
    const large = await t.app.inject({ method: 'PUT', url: PACK, headers: admin, payload: { schema: 1, version: 'v', note: 'x'.repeat(CHAT_PACK_MAX_BYTES) } });
    expect(large.statusCode).toBe(400);
    expect(large.json().detail).toContain(`larger than ${CHAT_PACK_MAX_BYTES} bytes`);
    const huge = await t.app.inject({ method: 'PUT', url: PACK, headers: admin, payload: { schema: 1, version: 'v', note: 'x'.repeat(CHAT_PACK_MAX_BYTES * 3) } });
    expect(huge.statusCode).toBe(413);

    expect(chatPackStore.state().source).toBe('builtin');
    expect(t.repos.settings.get(CHAT_PACK_SETTING, null)).toBeNull();
    expect(audited()).toEqual([]);
  });

  it('is in the OpenAPI document and the route list', async () => {
    expect(t.routes).toEqual(expect.arrayContaining([`GET ${PACK}`, `PUT ${PACK}`, `DELETE ${PACK}`, `POST ${DEBUG}`]));
    const doc = (await t.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
    expect(Object.keys(doc.paths['/platforms/instagram/chat/selector-pack'])).toEqual(['get', 'put', 'delete']);
    expect(doc.paths['/platforms/instagram/chat/debug'].post.operationId).toBe('postInstagramChatDebug');
    expect(doc.components.schemas.Scope.enum).toContain('system:admin');
    expect(doc.components.schemas.InstagramChatPackOverride.required).toEqual(['schema', 'version']);
  });
});

describe('POST /platforms/instagram/chat/debug', () => {
  it('returns no readers when no Instagram live is being read, validates its options, and is audited', async () => {
    const admin = bearer(t.token(['system:admin'], 'Support agent'));
    const res = await t.app.inject({ method: 'POST', url: DEBUG, headers: admin, payload: { scope: 'page', up: 2, decisions: 10 } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ capturedAt: expect.any(String), pack: { source: 'builtin', version: BUILTIN_CHAT_PACK.version, builtinVersion: BUILTIN_CHAT_PACK.version }, readers: [] });
    expect((await t.app.inject({ method: 'POST', url: DEBUG, headers: admin })).statusCode).toBe(200); // no body
    for (const payload of [{ scope: 'cookies' }, { up: 99 }, { decisions: -1 }, { evaluate: 'document.cookie' }]) {
      const bad = await t.app.inject({ method: 'POST', url: DEBUG, headers: admin, payload });
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(audited().filter((e) => e.action === 'instagram.chat_debug')).toHaveLength(2);
    expect(audited()[0]!.detail).toMatch(/sanitised capture of 0 live comment reader\(s\), by API token "Support agent"/);
  });
});

describe('web UI routes (/api/platforms/instagram/chat/…)', () => {
  let app: FastifyInstance;
  const WEB_PACK = '/api/platforms/instagram/chat/selector-pack';
  const as = (role: Role | null) => (role ? { 'x-test-role': role } : {});

  beforeEach(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => {
      const e = err as { statusCode?: number; message?: string; code?: unknown };
      return sendError(reply, e.statusCode ?? 500, e.message ?? 'error', typeof e.code === 'string' && !e.code.startsWith('FST_') ? e.code : undefined);
    });
    app.decorateRequest('user', null);
    app.decorateRequest('authSession', null);
    // Fake auth: the real auth plugin (session cookie + CSRF) is tested on its own.
    app.addHook('onRequest', async (req) => {
      const role = req.headers['x-test-role'];
      req.user = role === 'admin' || role === 'operator' ? { id: `user-${role}`, username: `the-${role}`, role, totpEnabled: false, createdAt: '', lastLoginAt: null } : null;
    });
    const services = { repos: t.repos, log: t.services.log, platforms: { all: () => [] } } as unknown as AppServices;
    await app.register(platformRoutes, { services });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it('are admin only', async () => {
    for (const [method, url] of [['GET', WEB_PACK], ['PUT', WEB_PACK], ['DELETE', WEB_PACK], ['POST', '/api/platforms/instagram/chat/debug']] as const) {
      const payload = method === 'PUT' ? { payload: OVERRIDE } : {};
      expect((await app.inject({ method, url, ...payload })).statusCode, `${method} anonymous`).toBe(401);
      expect((await app.inject({ method, url, headers: as('operator'), ...payload })).statusCode, `${method} operator`).toBe(403);
    }
    expect(chatPackStore.state().source).toBe('builtin');
    expect(audited()).toEqual([]);
  });

  it('show the active pack and revert an override, audited under the admin\'s name', async () => {
    expect((await app.inject({ method: 'GET', url: WEB_PACK, headers: as('admin') })).json()).toMatchObject({ source: 'builtin', readers: 0 });
    const put = await app.inject({ method: 'PUT', url: WEB_PACK, headers: as('admin'), payload: OVERRIDE });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ source: 'override', version: 'tuned-1', updatedBy: 'the-admin' });
    const bad = await app.inject({ method: 'PUT', url: WEB_PACK, headers: as('admin'), payload: { schema: 1, version: 'v', row: { css: ['text=x'] } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/row\.css\.0/);
    expect((await app.inject({ method: 'GET', url: WEB_PACK, headers: as('admin') })).json()).toMatchObject({ source: 'override', version: 'tuned-1' });

    const del = await app.inject({ method: 'DELETE', url: WEB_PACK, headers: as('admin') });
    expect(del.json()).toMatchObject({ source: 'builtin', override: null });
    const debug = await app.inject({ method: 'POST', url: '/api/platforms/instagram/chat/debug', headers: as('admin'), payload: {} });
    expect(debug.json()).toMatchObject({ readers: [] });

    expect(audited().reverse()).toEqual([
      { action: 'instagram.chat_pack.update', detail: expect.stringMatching(/^version "tuned-1" \(\d+ bytes; changes row\)$/), username: 'the-admin' },
      { action: 'instagram.chat_pack.revert', detail: `back to the built-in pack ${BUILTIN_CHAT_PACK.version}`, username: 'the-admin' },
      { action: 'instagram.chat_debug', detail: 'sanitised capture of 0 live comment reader(s)', username: 'the-admin' },
    ]);
  });
});
