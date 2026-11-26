import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { WsServerMessage } from '../../../../shared/api.js';
import type {
  Account,
  ChatMessage,
  ChatModeration,
  ConnectedApp,
  DestinationState,
  PairingRequest,
  ProfileSummary,
  SessionState,
  User,
} from '../../../../shared/types.js';
import type { Envelope } from '../../api/types.js';
import { EventBus } from '../../events.js';
import { unknownProfileError } from '../../orchestrator/registry.js';
import type { AppServices } from '../../services.js';
import wsRoutes, { WS_MAX_BUFFERED_BYTES, WsHub, type HubSocket } from './ws.js';

const SESSION: SessionState = {
  status: 'offline',
  sessionId: null,
  startedAt: null,
  title: 'Hello',
  autoGoLive: true,
  feeds: [],
  destinations: [],
};

const CHAT: ChatMessage = {
  id: 'm1',
  platform: 'twitch',
  destinationId: 'd1',
  author: { name: 'viewer' },
  text: 'hi',
  ts: '2026-01-01T00:00:00.000Z',
  kind: 'message',
};

const MODERATION: ChatModeration = {
  kind: 'message-deleted',
  platform: 'twitch',
  destinationId: 'd1',
  ts: '2026-01-01T00:00:01.000Z',
  messageId: 'twitch:1',
  platformMessageId: '1',
};

const ACCOUNT: Account = {
  id: 'a1',
  platform: 'twitch',
  label: 'dprtmnt',
  status: 'connected',
  statusMessage: null,
  options: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const USER: User = {
  id: 'u1',
  username: 'alice',
  role: 'operator',
  totpEnabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
};

const ADMIN: User = { ...USER, id: 'u2', username: 'root', role: 'admin' };

function summary(id: string, over: Partial<ProfileSummary> = {}): ProfileSummary {
  return {
    id,
    name: id,
    slug: id,
    color: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'offline',
    startedAt: null,
    testMode: false,
    destinations: 1,
    live: 0,
    down: 0,
    ...over,
  };
}

const SUMMARIES: ProfileSummary[] = [summary('default'), summary('club', { name: 'DPRTMNT' })];

const PAIRING: PairingRequest = {
  id: 'p1',
  appName: 'CTD OBS plugin',
  kind: 'ctd-obs-plugin',
  code: 'KQ7-2MX',
  requestedScopes: ['status:read'],
  requestedProfileId: null,
  ip: '192.168.1.5',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T00:10:00.000Z',
};

const APP: ConnectedApp = {
  id: 'ctd-overlay',
  name: 'CTD Overlay',
  kind: 'ctd-overlay',
  version: '1.4.0',
  baseUrl: null,
  capabilities: ['overlays'],
  resources: [],
  tokenId: 't1',
  profileId: null,
  registeredAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  online: true,
};

function dstate(destinationId: string, profileId: string, phase: DestinationState['phase']): DestinationState {
  return { destinationId, profileId, phase, message: null, stats: null, watchUrl: null, retries: 0, since: 'x', recoveries: 0, lastRecovery: null };
}

/** Lets the hub's coalesced 'profiles' message go out (it is sent on the next turn of the event loop). */
const tick = () => new Promise<void>((r) => setImmediate(r));

class FakeSocket implements HubSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: WsServerMessage[] = [];
  pings = 0;
  terminated = false;
  private readonly listeners = new Map<string, (() => void)[]>();
  send(data: string): void {
    this.sent.push(JSON.parse(data) as WsServerMessage);
  }
  ping(): void {
    this.pings += 1;
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.fire('close');
  }
  on(event: 'pong' | 'close', listener: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  fire(event: 'pong' | 'close'): void {
    for (const l of this.listeners.get(event) ?? []) l();
  }
}

const silent = pino({ level: 'silent' });
const hello: WsServerMessage = { type: 'hello', session: SESSION, chat: [], profiles: [] };

describe('WsHub', () => {
  it('sends hello first, then forwards every bus event type', () => {
    const bus = new EventBus();
    const hub = new WsHub(bus, silent);
    const s = new FakeSocket();
    hub.add(s, hello);
    bus.emit('session', SESSION);
    bus.emit('feed', { feed: 'landscape', online: true, since: null, video: null, audio: null, bitrateKbps: 5000 });
    bus.emit('destination', { destinationId: 'd1', phase: 'live', message: null, stats: null, watchUrl: null, retries: 0, since: 'x', recoveries: 0, lastRecovery: null });
    bus.emit('chat', CHAT);
    bus.emit('chat-moderation', MODERATION);
    bus.emit('account', ACCOUNT);
    bus.emit('destinations-changed');
    bus.emit('notice', { level: 'warn', message: 'careful' });
    bus.emit('push', { id: 'd1', status: 'running', message: null, stats: null, attempt: 0 }); // internal: not forwarded
    expect(s.sent.map((m) => m.type)).toEqual([
      'hello',
      'session',
      'feed',
      'destination',
      'chat',
      'chat-moderation',
      'account',
      'destinations-changed',
      'notice',
    ]);
    // Moderation goes out unchanged, so the dashboard removes deleted / banned / cleared chat.
    expect(s.sent[5]).toEqual({ type: 'chat-moderation', moderation: MODERATION });
    expect(s.sent.at(-1)).toEqual({ type: 'notice', level: 'warn', message: 'careful' });
    hub.close();
    // Closed: no more forwarding.
    bus.emit('chat-moderation', MODERATION);
    expect(s.sent.filter((m) => m.type === 'chat-moderation')).toHaveLength(1);
  });

  it('terminates clients that miss a pong', () => {
    const hub = new WsHub(new EventBus(), silent);
    const good = new FakeSocket();
    const dead = new FakeSocket();
    hub.add(good, hello);
    hub.add(dead, hello);
    hub.heartbeat();
    expect(good.pings).toBe(1);
    expect(dead.pings).toBe(1);
    good.fire('pong');
    hub.heartbeat();
    expect(good.terminated).toBe(false);
    expect(good.pings).toBe(2);
    expect(dead.terminated).toBe(true);
    expect(hub.size).toBe(1);
    hub.close();
  });

  it('skips slow clients and drops closed ones', () => {
    const bus = new EventBus();
    const hub = new WsHub(bus, silent);
    const slow = new FakeSocket();
    const gone = new FakeSocket();
    hub.add(slow, hello);
    hub.add(gone, hello);
    slow.bufferedAmount = WS_MAX_BUFFERED_BYTES + 1;
    gone.fire('close');
    bus.emit('destinations-changed');
    expect(slow.sent.map((m) => m.type)).toEqual(['hello']);
    expect(gone.sent.map((m) => m.type)).toEqual(['hello']);
    expect(hub.size).toBe(1);
    slow.bufferedAmount = 0;
    bus.emit('destinations-changed');
    expect(slow.sent.map((m) => m.type)).toEqual(['hello', 'destinations-changed']);
    hub.close();
  });

  it('closes sockets whose session was revoked with 4401 on the next heartbeat', () => {
    class ClosableSocket extends FakeSocket {
      closedWith: number | null = null;
      close(code?: number): void {
        this.closedWith = code ?? null;
        this.readyState = 3;
        this.fire('close');
      }
    }
    const bus = new EventBus();
    const hub = new WsHub(bus, silent);
    let valid = true;
    const s = new ClosableSocket();
    const legacy = new FakeSocket(); // no close(): terminated instead
    const unchecked = new ClosableSocket(); // no validator: never closed for it
    const flaky = new ClosableSocket(); // validator throws (DB hiccup): kept
    hub.add(s, hello, () => valid);
    hub.add(legacy, hello, () => valid);
    hub.add(unchecked, hello);
    hub.add(flaky, hello, () => {
      throw new Error('db busy');
    });
    hub.heartbeat();
    expect(s.closedWith).toBeNull();
    for (const sock of [s, legacy, unchecked, flaky]) sock.fire('pong');

    valid = false;
    hub.heartbeat();
    expect(s.closedWith).toBe(4401);
    expect(legacy.terminated).toBe(true);
    expect(unchecked.closedWith).toBeNull();
    expect(flaky.closedWith).toBeNull();
    expect(hub.size).toBe(2);
    bus.emit('destinations-changed');
    expect(s.sent.map((m) => m.type)).toEqual(['hello']);
    hub.close();
  });

  it('close() unsubscribes from the bus and terminates sockets', () => {
    const bus = new EventBus();
    const hub = new WsHub(bus, silent);
    const s = new FakeSocket();
    hub.add(s, hello);
    hub.close();
    expect(s.terminated).toBe(true);
    bus.emit('destinations-changed');
    expect(s.sent).toHaveLength(1);
  });
});

describe('WsHub profiles', () => {
  it('forwards profile events only to that profile’s sockets', () => {
    const bus = new EventBus();
    const hub = new WsHub(bus, silent);
    const main = new FakeSocket();
    const club = new FakeSocket();
    hub.add(main, hello); // default profile
    hub.add(club, hello, undefined, { profileId: 'club' });

    bus.emit('session', { ...SESSION, profileId: 'club' });
    bus.emit('feed', { profileId: 'club', feed: 'landscape', online: true, since: null, video: null, audio: null, bitrateKbps: 5000 });
    bus.emit('destination', dstate('c1', 'club', 'live'));
    bus.emit('chat', { ...CHAT, profileId: 'club' });
    bus.emit('chat-moderation', { ...MODERATION, profileId: 'club' });
    bus.emit('account', { ...ACCOUNT, profileId: 'club' });
    bus.emit('destinations-changed', { profileId: 'club' });
    bus.emit('notice', { level: 'warn', message: 'DPRTMNT · careful', profileId: 'club' });
    const clubOnly = ['session', 'feed', 'destination', 'chat', 'chat-moderation', 'account', 'destinations-changed', 'notice'];
    expect(club.sent.map((m) => m.type)).toEqual(['hello', ...clubOnly]);
    expect(main.sent.map((m) => m.type)).toEqual(['hello']);

    // Events without a profile belong to the default profile; notices / list changes without one go to all.
    bus.emit('session', SESSION);
    bus.emit('chat', CHAT);
    bus.emit('notice', { level: 'info', message: 'Server restarting' });
    bus.emit('destinations-changed');
    expect(main.sent.slice(1).map((m) => m.type)).toEqual(['session', 'chat', 'notice', 'destinations-changed']);
    expect(club.sent.slice(1 + clubOnly.length).map((m) => m.type)).toEqual(['notice', 'destinations-changed']);
    expect(club.sent.at(-2)).toEqual({ type: 'notice', level: 'info', message: 'Server restarting' });
    hub.close();
  });

  it('forwards issue.raised / issue.cleared from the API event hub to the issue’s profile only (v1.18)', () => {
    const bus = new EventBus();
    const hub = new WsHub(bus, silent);
    let listener: ((env: Envelope) => void) | null = null;
    hub.attachIssues({
      subscribe: (l) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    });
    const main = new FakeSocket();
    const club = new FakeSocket();
    hub.add(main, hello);
    hub.add(club, hello, undefined, { profileId: 'club' });
    const issue = {
      id: 'feed.offline|landscape',
      kind: 'feed.offline',
      rule: null,
      severity: 'critical',
      title: 'Landscape feed lost',
      message: null,
      subject: { type: 'feed', feed: 'landscape' },
      onProgram: null,
      scene: null,
      firstSeen: 1,
      updatedAt: 1,
      update: false,
    } as const;
    const env = (type: Envelope['type'], profile: string | null, data: unknown): Envelope => ({
      id: 'x',
      type,
      ts: 2,
      src: { connector: 'ctd-multi-stream', connection: 'core', platform: 'core', profile },
      data,
    });
    listener!(env('issue.raised', 'club', issue));
    listener!(env('feed.status', 'club', {}));
    listener!(env('issue.raised', null, issue));
    const cleared = { id: issue.id, kind: issue.kind, rule: null, subject: issue.subject, title: issue.title, firstSeen: 1, durationMs: 1, resolution: 'recovered' };
    listener!(env('issue.cleared', 'club', cleared));
    expect(club.sent.slice(1)).toEqual([
      { type: 'issue-raised', profileId: 'club', issue },
      { type: 'issue-cleared', profileId: 'club', issue: cleared },
    ]);
    expect(main.sent.map((m) => m.type)).toEqual(['hello']);
    hub.close();
    expect(listener).toBeNull();
  });

  it('sends every profile’s summaries on any session change and on profile edits (coalesced)', async () => {
    const bus = new EventBus();
    let summaries = SUMMARIES;
    let calls = 0;
    const hub = new WsHub(bus, silent, {
      profiles: () => {
        calls += 1;
        return summaries;
      },
    });
    const main = new FakeSocket();
    const club = new FakeSocket();
    hub.add(main, hello);
    hub.add(club, hello, undefined, { profileId: 'club' });

    summaries = [summary('default'), summary('club', { status: 'live', live: 1 })];
    bus.emit('session', { ...SESSION, profileId: 'club', status: 'starting' });
    bus.emit('session', { ...SESSION, profileId: 'club', status: 'live' });
    await tick();
    expect(calls).toBe(1);
    for (const s of [main, club]) expect(s.sent.filter((m) => m.type === 'profiles')).toEqual([{ type: 'profiles', profiles: summaries }]);

    bus.emit('profiles-changed');
    await tick();
    expect(main.sent.filter((m) => m.type === 'profiles')).toHaveLength(2);

    // Destination phase changes only send when the summaries actually changed.
    bus.emit('destination', dstate('c1', 'club', 'live'));
    await tick();
    expect(main.sent.filter((m) => m.type === 'profiles')).toHaveLength(2);
    bus.emit('destination', { ...dstate('c1', 'club', 'live'), stats: { bitrateKbps: 1, fps: 1, speed: 1, uptimeSec: 1 } });
    await tick();
    expect(calls).toBe(3); // same phase: not even recomputed
    summaries = [summary('default'), summary('club', { status: 'live', live: 0, down: 1 })];
    bus.emit('destination', dstate('c1', 'club', 'retrying'));
    await tick();
    expect(main.sent.filter((m) => m.type === 'profiles').at(-1)).toEqual({ type: 'profiles', profiles: summaries });
    expect(club.sent.filter((m) => m.type === 'profiles')).toHaveLength(3);
    hub.close();
  });

  it('sends pending pairings to admins only (on connect and on change) and apps to everyone', () => {
    const bus = new EventBus();
    let admin = true;
    let pairings: PairingRequest[] = [PAIRING];
    const hub = new WsHub(bus, silent, { pairings: () => pairings, apps: () => [APP] });
    const adminSocket = new FakeSocket();
    const operator = new FakeSocket();
    hub.add(adminSocket, hello, undefined, { isAdmin: () => admin });
    hub.add(operator, hello, undefined, { isAdmin: () => false });
    expect(adminSocket.sent).toEqual([hello, { type: 'pairings', pairings: [PAIRING] }]);
    expect(operator.sent).toEqual([hello]);

    pairings = [];
    bus.emit('pairings-changed');
    expect(adminSocket.sent.at(-1)).toEqual({ type: 'pairings', pairings: [] });
    expect(operator.sent).toEqual([hello]);

    bus.emit('apps-changed');
    for (const s of [adminSocket, operator]) expect(s.sent.at(-1)).toEqual({ type: 'apps', apps: [APP] });

    // Demoted: no more pairings.
    admin = false;
    bus.emit('pairings-changed');
    expect(adminSocket.sent.at(-1)?.type).toBe('apps');
    hub.close();
  });
});

describe('GET /api/ws', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function build() {
    const bus = new EventBus();
    const states: Record<string, SessionState> = { default: SESSION, club: { ...SESSION, profileId: 'club', title: 'Club night' } };
    const services = {
      log: silent,
      bus,
      orchestrators: {
        get: (id: string) => {
          const state = states[id];
          if (!state) throw unknownProfileError();
          return { profileId: id, state: () => state };
        },
        summaries: () => SUMMARIES,
      },
      chat: { recent: (limit: number, profileId = 'default') => (limit >= 1 ? [{ ...CHAT, profileId }] : []) },
      pairings: { list: () => [PAIRING] },
      apps: { list: () => [APP] },
      repos: { users: { get: (id: string) => [USER, ADMIN].find((u) => u.id === id) ?? null } },
    } as unknown as AppServices;
    const instance = Fastify();
    instance.decorateRequest('user', null);
    instance.decorateRequest('authSession', null);
    instance.addHook('onRequest', async (req) => {
      const who = req.headers['x-test-user'];
      req.user = who === 'admin' ? ADMIN : who ? USER : null;
    });
    await instance.register(websocket);
    await instance.register(wsRoutes, { services });
    await instance.ready();
    app = instance;
    return { app: instance, bus };
  }

  async function connect(app: FastifyInstance, url: string, user = '1') {
    const received: WsServerMessage[] = [];
    let notify: (() => void) | null = null;
    const ws = await app.injectWS(
      url,
      { headers: { 'x-test-user': user } },
      {
        onInit: (client) =>
          client.on('message', (data: Buffer) => {
            received.push(JSON.parse(data.toString()) as WsServerMessage);
            notify?.();
          }),
      },
    );
    const waitFor = async (n: number) => {
      while (received.length < n) await new Promise<void>((r) => (notify = r));
    };
    return { ws, received, waitFor };
  }

  it('rejects anonymous upgrades', async () => {
    const { app } = await build();
    await expect(app.injectWS('/api/ws')).rejects.toThrow('401');
  });

  it('rejects an unknown or malformed profile before the upgrade', async () => {
    const { app } = await build();
    await expect(app.injectWS('/api/ws?profile=nope', { headers: { 'x-test-user': '1' } })).rejects.toThrow('404');
    await expect(app.injectWS('/api/ws?profile=a&profile=b', { headers: { 'x-test-user': '1' } })).rejects.toThrow('400');
  });

  it('sends hello with the default profile’s session + recent chat and every profile, then live events', async () => {
    const { app, bus } = await build();
    const { ws, received, waitFor } = await connect(app, '/api/ws');

    await waitFor(1);
    expect(received[0]).toEqual({ type: 'hello', session: SESSION, chat: [{ ...CHAT, profileId: 'default' }], profiles: SUMMARIES, issues: [] });

    ws.send('ignored by the server');
    bus.emit('notice', { level: 'info', message: 'Session stopped' });
    await waitFor(2);
    expect(received[1]).toEqual({ type: 'notice', level: 'info', message: 'Session stopped' });

    ws.terminate();
  });

  it('?profile= scopes hello and events to that profile', async () => {
    const { app, bus } = await build();
    const { ws, received, waitFor } = await connect(app, '/api/ws?profile=club');
    await waitFor(1);
    expect(received[0]).toEqual({
      type: 'hello',
      session: { ...SESSION, profileId: 'club', title: 'Club night' },
      chat: [{ ...CHAT, profileId: 'club' }],
      profiles: SUMMARIES,
      issues: [],
    });

    bus.emit('chat', { ...CHAT, id: 'other', profileId: 'default' });
    bus.emit('chat', { ...CHAT, id: 'mine', profileId: 'club' });
    await waitFor(2);
    expect(received[1]).toEqual({ type: 'chat', message: { ...CHAT, id: 'mine', profileId: 'club' } });
    ws.terminate();
  });

  it('admins get the pending pairings right after hello, operators never', async () => {
    const { app, bus } = await build();
    const admin = await connect(app, '/api/ws', 'admin');
    await admin.waitFor(2);
    expect(admin.received.map((m) => m.type)).toEqual(['hello', 'pairings']);
    expect(admin.received[1]).toEqual({ type: 'pairings', pairings: [PAIRING] });

    const operator = await connect(app, '/api/ws');
    await operator.waitFor(1);
    bus.emit('pairings-changed');
    bus.emit('apps-changed');
    await admin.waitFor(4);
    await operator.waitFor(2);
    expect(admin.received.slice(2).map((m) => m.type)).toEqual(['pairings', 'apps']);
    expect(operator.received.map((m) => m.type)).toEqual(['hello', 'apps']);
    expect(operator.received[1]).toEqual({ type: 'apps', apps: [APP] });
    admin.ws.terminate();
    operator.ws.terminate();
  });
});

