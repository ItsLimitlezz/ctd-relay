// The OBS socket relay (/api/v1/obs/socket): a phone with an obs:control token reaches a fake OBS
// (obs-websocket 5, with authentication) through Relay over real sockets.

import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { hostOfRemoteAddr } from '../media/mediamtx-api.js';
import { isLanUpgradePath } from '../tls/http-listener.js';
import { closeReason, OBS_RELAY_CLOSE, OBS_SUBPROTOCOL, obsAuthString, obsRelayFor } from './obs-relay.js';
import { createTestApi, type TestApi } from './test-helpers.js';

type Msg = { op: number; d: Record<string, unknown> };

/** A socket whose messages and close can be awaited in order. */
class Peer {
  private readonly queue: Msg[] = [];
  private readonly waiting: ((m: Msg) => void)[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly rejected: Promise<number>;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data: RawData) => {
      const m = JSON.parse(data.toString()) as Msg;
      const w = this.waiting.shift();
      if (w) w(m);
      else this.queue.push(m);
    });
    this.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    this.rejected = new Promise((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
    ws.on('error', () => {});
  }

  next(): Promise<Msg> {
    const m = this.queue.shift();
    return m ? Promise.resolve(m) : new Promise((resolve) => this.waiting.push(resolve));
  }

  send(m: Msg): void {
    this.ws.send(JSON.stringify(m));
  }
}

/** A fake OBS: Hello with a challenge when it has a password, Identify, a few requests. */
class FakeObs {
  readonly server: WebSocketServer;
  readonly identifies: Record<string, unknown>[] = [];
  readonly sockets: WebSocket[] = [];
  password: string | null = 'obs-secret';
  private readonly salt = crypto.randomBytes(16).toString('base64');

  constructor() {
    this.server = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: (p) => (p.has(OBS_SUBPROTOCOL) ? OBS_SUBPROTOCOL : false) });
    this.server.on('connection', (ws) => {
      this.sockets.push(ws);
      const challenge = crypto.randomBytes(16).toString('base64');
      const send = (m: Msg) => ws.send(JSON.stringify(m));
      send({ op: 0, d: { obsWebSocketVersion: '5.6.2', rpcVersion: 1, ...(this.password ? { authentication: { challenge, salt: this.salt } } : {}) } });
      ws.on('message', (data) => {
        const m = JSON.parse(data.toString()) as Msg;
        if (m.op === 1) {
          this.identifies.push(m.d);
          if (this.password && m.d.authentication !== obsAuthString(this.password, this.salt, challenge)) {
            ws.close(4009, 'Authentication failed.');
            return;
          }
          // Identified and an event in the same tick: the relay must keep them in order.
          send({ op: 2, d: { negotiatedRpcVersion: 1 } });
          send({ op: 5, d: { eventType: 'CurrentProgramSceneChanged', eventIntent: 4, eventData: { sceneName: 'Main' } } });
        } else if (m.op === 6) {
          const responseData =
            m.d.requestType === 'GetVersion'
              ? { obsVersion: '31.1.2', obsWebSocketVersion: '5.6.2' }
              : { imageData: `data:image/jpeg;base64,${'A'.repeat(2 * 1024 * 1024)}` };
          send({ op: 7, d: { requestType: m.d.requestType, requestId: m.d.requestId, requestStatus: { result: true, code: 100 }, responseData } });
        }
      });
    });
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

let t: TestApi;
let obs: FakeObs;
let base: string;
let phoneToken: string;

beforeEach(async () => {
  t = await createTestApi();
  obs = new FakeObs();
  await new Promise((resolve) => obs.server.once('listening', resolve));
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/api/v1/obs/socket`;
  phoneToken = t.token(['chat:read', 'status:read', 'obs:control'], 'CTD Live mobile (iPhone)');
  await obsRelayFor(t.services).configure({ host: '127.0.0.1', port: obs.port, password: 'obs-secret' });
});
afterEach(async () => {
  await t.close();
  await obs.close();
});

const connect = (token: string | null = phoneToken) =>
  new Peer(new WebSocket(base, OBS_SUBPROTOCOL, { headers: token ? { authorization: `Bearer ${token}` } : {} }));

async function identified(phone: Peer): Promise<Msg> {
  const hello = await phone.next();
  phone.send({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 33 } });
  return hello;
}

describe('/api/v1/obs/socket', () => {
  it('relays obs-websocket both ways; OBS’s password stays on the server', async () => {
    const phone = connect();
    const hello = await identified(phone);
    // OBS's own Hello, minus the challenge (the token already signed the phone in).
    expect(hello).toEqual({ op: 0, d: { obsWebSocketVersion: '5.6.2', rpcVersion: 1 } });
    // Identified, then the event OBS sent right behind it: in order, nothing lost.
    expect(await phone.next()).toEqual({ op: 2, d: { negotiatedRpcVersion: 1 } });
    expect((await phone.next()).d.eventType).toBe('CurrentProgramSceneChanged');
    // Relay answered OBS's challenge and passed the phone's subscriptions through.
    expect(obs.identifies).toEqual([{ rpcVersion: 1, eventSubscriptions: 33, authentication: expect.any(String) }]);
    // A 2 MB screenshot comes back whole.
    phone.send({ op: 6, d: { requestType: 'GetSourceScreenshot', requestId: 'r1', requestData: { sourceName: 'Main', imageFormat: 'jpg' } } });
    const res = await phone.next();
    expect(res.op).toBe(7);
    expect(res.d.requestId).toBe('r1');
    expect(String((res.d.responseData as { imageData: string }).imageData).length).toBeGreaterThan(2 * 1024 * 1024);
    expect((await obsRelayFor(t.services).status()).sessions).toBe(1);
    phone.ws.close();
    await phone.closed;
  });

  it('needs a token with obs:control (checked before the upgrade)', async () => {
    expect(await connect(null).rejected).toBe(401);
    expect(await connect('ctd_pat_' + 'x'.repeat(43)).rejected).toBe(401);
    expect(await connect(t.token(['status:read', 'chat:read'], 'old phone')).rejected).toBe(403);
  });

  it('closes with a reason people can act on', async () => {
    const relay = obsRelayFor(t.services);

    await relay.configure({ host: '127.0.0.1', port: obs.port, password: 'wrong' });
    let phone = connect();
    await identified(phone);
    expect(await phone.closed).toEqual({ code: OBS_RELAY_CLOSE.authFailed, reason: expect.stringContaining('password') });

    await relay.configure({ host: '127.0.0.1', port: obs.port, password: null });
    phone = connect();
    await identified(phone);
    expect((await phone.closed).code).toBe(OBS_RELAY_CLOSE.authFailed); // OBS asks for one, Relay has none

    await relay.configure({ host: '127.0.0.1', port: 1, password: 'obs-secret' });
    phone = connect();
    expect(await phone.closed).toEqual({ code: OBS_RELAY_CLOSE.unreachable, reason: expect.stringContaining('127.0.0.1:1') });

    await relay.configure({ host: null, port: obs.port });
    phone = connect();
    expect((await phone.closed).code).toBe(OBS_RELAY_CLOSE.notConfigured);
  });

  it('finds OBS at the address it streams from when none is set', async () => {
    const relay = obsRelayFor(t.services);
    await relay.configure({ host: null, port: obs.port });
    (t.services.media as { publisherAddress?: (id: string) => Promise<string | null> }).publisherAddress = async () => '127.0.0.1';
    const phone = connect();
    await identified(phone);
    expect((await phone.next()).op).toBe(2);
    // Remembered for when OBS isn't streaming.
    (t.services.media as { publisherAddress?: (id: string) => Promise<string | null> }).publisherAddress = async () => null;
    expect(relay.settings().lastSeenHost).toBe('127.0.0.1');
    expect((await relay.status()).detectedHost).toBe('127.0.0.1');
    phone.ws.close();
  });

  it('passes OBS closing on, and cuts off a revoked phone', async () => {
    let phone = connect();
    await identified(phone);
    await phone.next();
    obs.sockets.at(-1)!.close(1001);
    expect((await phone.closed).code).toBe(OBS_RELAY_CLOSE.obsClosed);

    phone = connect();
    await identified(phone);
    await phone.next();
    const id = t.repos.apiTokens.list().find((tk) => tk.name === 'CTD Live mobile (iPhone)')!.id;
    obsRelayFor(t.services).disconnectToken(id);
    expect(await phone.closed).toEqual({ code: OBS_RELAY_CLOSE.revoked, reason: expect.stringContaining('Scan a new code') });
  });

  it('refuses anything but Identify after Hello', async () => {
    const phone = connect();
    await phone.next();
    phone.send({ op: 6, d: { requestType: 'GetVersion', requestId: 'x' } });
    expect((await phone.closed).code).toBe(OBS_RELAY_CLOSE.notIdentified);
  });

  it('Test connection reports OBS’s versions or what is wrong', async () => {
    const relay = obsRelayFor(t.services);
    expect(await relay.test()).toEqual({ ok: true, host: '127.0.0.1', port: obs.port, obsVersion: '31.1.2', obsWebSocketVersion: '5.6.2' });
    await relay.configure({ host: '127.0.0.1', port: obs.port, password: 'nope' });
    expect(await relay.test()).toEqual({ ok: false, host: '127.0.0.1', port: obs.port, error: expect.stringContaining('password') });
    await relay.configure({ host: '127.0.0.1', port: obs.port }); // undefined keeps the saved password
    expect((await relay.status()).hasPassword).toBe(true);
  });
});

describe('PUT /api/v1/apps/{appId}/obs-websocket (the CTD OBS plugin fills in OBS’s settings)', () => {
  const put = (token: string, appId: string, body: unknown) =>
    t.app.inject({ method: 'PUT', url: `/api/v1/apps/${appId}/obs-websocket`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: JSON.stringify(body) });

  it('stores port, password and the OBS machine’s LAN address, then the relay uses them', async () => {
    const relay = obsRelayFor(t.services);
    await relay.configure({ host: null, port: 4455, password: null });
    const plugin = t.token(['apps:write', 'obs:write'], 'CTD OBS plugin');
    expect((await t.app.inject({ method: 'PUT', url: '/api/v1/apps/ctd-obs-plugin-studio', headers: { authorization: `Bearer ${plugin}`, 'content-type': 'application/json' }, payload: JSON.stringify({ name: 'CTD OBS plugin', kind: 'ctd-obs-plugin' }) })).statusCode).toBe(200);

    // 127.0.0.1 isn't a LAN address: no host from it; the plugin's own address list is used instead.
    const res = await put(plugin, 'ctd-obs-plugin-studio', { enabled: true, port: obs.port, authRequired: true, password: 'obs-secret', addresses: ['fe80::1', '192.168.1.42'] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ host: '192.168.1.42', port: obs.port, hasPassword: true, manualHost: false });
    expect(await relay.status()).toMatchObject({ detectedHost: '192.168.1.42', hasPassword: true, serverEnabled: true, reportedBy: { appId: 'ctd-obs-plugin-studio', name: 'CTD OBS plugin' } });
    expect(JSON.stringify(t.repos.audit.list({ limit: 5 }))).not.toContain('obs-secret');
    expect(t.repos.audit.list({ limit: 5 })[0]).toMatchObject({ action: 'obs_relay.plugin_update' });

    // The fake OBS is on 127.0.0.1: set that by hand (a manual address wins) and connect through the relay.
    await relay.configure({ host: '127.0.0.1', port: obs.port });
    const phone = connect();
    await identified(phone);
    expect((await phone.next()).op).toBe(2); // the plugin's password signed Relay in to OBS

    // Authentication turned off in OBS: the saved password goes.
    await put(plugin, 'ctd-obs-plugin-studio', { enabled: false, port: obs.port, authRequired: false });
    expect(await relay.status()).toMatchObject({ hasPassword: false, serverEnabled: false });
    phone.ws.close();
  });

  it('needs obs:write and the plugin’s own registered app', async () => {
    const reader = t.token(['status:read'], 'reader');
    expect((await put(reader, 'x', { enabled: true, port: 4455, authRequired: false })).statusCode).toBe(403);
    const plugin = t.token(['apps:write', 'obs:write'], 'plugin');
    expect((await put(plugin, 'nobody', { enabled: true, port: 4455, authRequired: false })).statusCode).toBe(404);
    await t.app.inject({ method: 'PUT', url: '/api/v1/apps/p1', headers: { authorization: `Bearer ${plugin}`, 'content-type': 'application/json' }, payload: JSON.stringify({ name: 'P', kind: 'ctd-obs-plugin' }) });
    expect((await put(plugin, 'p1', { enabled: 'yes', port: 4455 })).statusCode).toBe(400);
    expect((await put(t.token(['apps:write', 'obs:write'], 'other'), 'p1', { enabled: true, port: 4455, authRequired: false })).statusCode).toBe(409);
  });
});

describe('helpers', () => {
  it('computes obs-websocket authentication (the protocol docs’ example)', () => {
    expect(obsAuthString('supersecretpassword', 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=', '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=')).toBe(
      '1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=',
    );
  });

  it('keeps close reasons within 123 bytes', () => {
    expect(closeReason('short')).toBe('short');
    const long = closeReason('é'.repeat(100));
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(123);
    expect(long.endsWith('…')).toBe(true);
  });

  it('reads the publisher address from MediaMTX’s remoteAddr', () => {
    expect(hostOfRemoteAddr('192.168.1.50:61234')).toBe('192.168.1.50');
    expect(hostOfRemoteAddr('[::ffff:192.168.1.50]:61234')).toBe('192.168.1.50');
    expect(hostOfRemoteAddr('[fe80::1]:5')).toBe('fe80::1');
    expect(hostOfRemoteAddr('')).toBeNull();
    expect(hostOfRemoteAddr(undefined)).toBeNull();
  });

  it('serves the OBS socket to LAN clients over plain HTTP', () => {
    expect(isLanUpgradePath('/api/v1/obs/socket')).toBe(true);
    expect(isLanUpgradePath('/api/v1/events')).toBe(false);
  });
});
