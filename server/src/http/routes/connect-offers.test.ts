// "Connect a phone": admin QR code (Settings → API) → CTD Live mobile claims a read-only token.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER, SESSION_COOKIE, type ConnectOfferResponse, type ConnectOfferStatus } from '../../../../shared/api.js';
import type { Role } from '../../../../shared/types.js';
import { CONNECT_OFFER_TTL_MS, ConnectOffers, MOBILE_SCOPES } from '../../api/connect.js';
import { createTestApi, type TestApi } from '../../api/test-helpers.js';
import { urlIsPrivate } from './tokens.js';

let t: TestApi;

beforeEach(async () => {
  t = await createTestApi();
});
afterEach(async () => {
  await t.close();
});

let users = 0;
function login(role: Role = 'admin') {
  const user = t.repos.users.create({ username: `${role}${++users}`, passwordHash: 'x', role });
  const { record, token } = t.repos.authSessions.create(user.id, { ip: null, userAgent: null });
  return { cookie: `${SESSION_COOKIE}=${token}`, csrf: record.csrfToken };
}

const admin = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, s = login()) =>
  t.app.inject({ method, url, headers: { host: '192.168.1.20:30443', cookie: s.cookie, [CSRF_HEADER]: s.csrf }, ...(payload ? { payload } : {}) });

const claim = (body: object) => t.app.inject({ method: 'POST', url: '/api/v1/connect/claim', payload: body });

function codeOf(uri: string): string {
  return new URL(uri.replace(/^ctdrelay:/, 'https:')).searchParams.get('code')!;
}

describe('connect a phone', () => {
  it('admin shows a QR code; the phone claims a read-only token once, over the public address', async () => {
    const s = login();
    const res = await admin('POST', '/api/connect-offers', { profileId: null }, s);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const offer = res.json<ConnectOfferResponse>();
    expect(offer).toMatchObject({ state: 'waiting', deviceName: null, apiUrl: 'https://203.0.113.7/api/v1', apiUrlIsPrivate: false });
    expect(offer.qrSvg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    const uri = new URL(offer.uri.replace(/^ctdrelay:/, 'https:'));
    expect(offer.uri.startsWith('ctdrelay://connect?')).toBe(true);
    expect(Object.fromEntries(uri.searchParams)).toMatchObject({ v: '1', api: 'https://203.0.113.7/api/v1', lan: 'http://192.168.1.20:30080/api/v1', fp: 'AA:BB' });
    const code = codeOf(offer.uri);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The code is never in the audit log.
    expect(JSON.stringify(t.repos.audit.list({ limit: 10 }))).not.toContain(code);

    const ok = await claim({ code, deviceName: "Juan's iPhone" });
    expect(ok.statusCode, ok.body).toBe(200);
    const body = ok.json();
    expect(body).toMatchObject({ name: "Juan's iPhone", profileId: null, server: { name: 'CTD Relay', apiRevision: expect.any(String) } });
    expect([...body.scopes].sort()).toEqual([...MOBILE_SCOPES].sort());
    expect(body.token).toMatch(/^ctd_pat_/);
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/status', headers: { authorization: `Bearer ${body.token}` } });
    expect(me.statusCode).toBe(200);
    const keys = await t.app.inject({ method: 'GET', url: '/api/v1/profiles/default/ingest', headers: { authorization: `Bearer ${body.token}` } });
    expect(keys.statusCode).toBe(403); // never stream keys

    // Once only; the web UI sees it connected.
    expect((await claim({ code })).statusCode).toBe(410);
    const status = (await admin('GET', `/api/connect-offers/${offer.id}`, undefined, s)).json<ConnectOfferStatus>();
    expect(status).toMatchObject({ state: 'connected', deviceName: "Juan's iPhone" });
    expect(t.repos.apiTokens.list().map((x) => x.name)).toEqual(["Juan's iPhone"]);
  });

  it('a phone limited to one profile; unknown, cancelled and malformed codes get the same 410', async () => {
    const club = t.addProfile('DPRTMNT', '#E11D48');
    const offer = (await admin('POST', '/api/connect-offers', { profileId: club.id })).json<ConnectOfferResponse>();
    const ok = await claim({ code: codeOf(offer.uri) });
    expect(ok.json()).toMatchObject({ profileId: club.id, name: 'CTD Live mobile' });

    expect((await claim({ code: 'x'.repeat(43) })).statusCode).toBe(410);
    const other = (await admin('POST', '/api/connect-offers', { profileId: null })).json<ConnectOfferResponse>();
    await admin('DELETE', `/api/connect-offers/${other.id}`);
    expect((await claim({ code: codeOf(other.uri) })).statusCode).toBe(410);
    expect((await claim({})).statusCode).toBe(400);
  });

  it('is admin only', async () => {
    const op = login('operator');
    expect((await admin('POST', '/api/connect-offers', { profileId: null }, op)).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: '/api/connect-offers', payload: { profileId: null } })).statusCode).toBe(401);
  });

  it('codes expire after 5 minutes; a 6th open code replaces the oldest', () => {
    let clock = 1_000_000;
    const offers = new ConnectOffers(t.repos, () => clock);
    const a = offers.create({ profileId: null, createdBy: 'admin' });
    clock += CONNECT_OFFER_TTL_MS;
    expect(offers.claim(a.code, 'p')).toBeNull();
    expect(offers.status(a.id)?.state).toBe('expired');
    const codes = Array.from({ length: 6 }, () => offers.create({ profileId: null, createdBy: 'admin' }));
    expect(offers.status(codes[0]!.id)?.state).toBe('expired');
    expect(offers.claim(codes[5]!.code, 'p')).not.toBeNull();
  });

  it('flags a public URL that is really a LAN address (no mobile data)', () => {
    expect(urlIsPrivate('https://203.0.113.7/api/v1')).toBe(false);
    expect(urlIsPrivate('https://stream.example.com/api/v1')).toBe(false);
    expect(urlIsPrivate('https://10.20.30.40:30443/api/v1')).toBe(true);
    expect(urlIsPrivate('https://nas.local/api/v1')).toBe(true);
    expect(urlIsPrivate('https://[fd00::1]/api/v1')).toBe(true);
    expect(urlIsPrivate('https://100.100.1.2/api/v1')).toBe(true); // CGNAT / Tailscale
    expect(urlIsPrivate('https://8.8.8.8:30443/api/v1')).toBe(false);
  });
});
