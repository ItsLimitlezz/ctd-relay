import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { clearChatroomCache, kickChat } from './chat-source.js';
import { PusherError } from './pusher.js';
import { centrifugoEvents, kickGuestToken, kickRealtimeTarget } from './realtime.js';
import { makeAccount, makeCtx } from './test-utils.js';

/** Minimal Centrifugo server: answers connect/subscribe, records what the client sent. */
function fakeCentrifugo(wss: WebSocketServer, opts: { refuse?: string[]; requireToken?: string } = {}) {
  const seen: Record<string, unknown>[] = [];
  const sockets: WsSocket[] = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (raw) => {
      const text = String(raw);
      if (text === '{}') {
        seen.push({ pong: true });
        return;
      }
      const msg = JSON.parse(text) as { id: number; connect?: { token?: string }; subscribe?: { channel: string } };
      seen.push(msg);
      if (msg.connect) {
        if (opts.requireToken && msg.connect.token !== opts.requireToken) ws.send(JSON.stringify({ id: msg.id, error: { code: 109, message: 'token expired' } }));
        else ws.send(JSON.stringify({ id: msg.id, connect: { client: 'c1', version: '6', expires: true, ttl: 2700, ping: 25, pong: true } }));
      }
      if (msg.subscribe) {
        if (opts.refuse?.includes(msg.subscribe.channel)) ws.send(JSON.stringify({ id: msg.id, error: { code: 103, message: 'permission denied' } }));
        else ws.send(JSON.stringify({ id: msg.id, subscribe: {} }));
      }
    });
  });
  const pub = (channel: string, event: string, data: unknown) =>
    JSON.stringify({ push: { channel, pub: { data: { event, data: JSON.stringify(data) } } } });
  return { seen, sockets, pub };
}

const chatMessage = (id: string, text: string) => ({
  id,
  chatroom_id: 668,
  content: text,
  type: 'message',
  created_at: '2026-10-18T20:39:52+00:00',
  sender: { id: 19286615, username: 'imcreased', slug: 'imcreased', identity: { color: '#00CCB3', badges: [] } },
});

let wss: WebSocketServer;
let url: string;
let ctl: AbortController;

beforeEach(async () => {
  clearChatroomCache();
  ctl = new AbortController();
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/connection/websocket`;
});

afterEach(async () => {
  ctl.abort();
  for (const c of wss.clients) c.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

describe('centrifugoEvents', () => {
  it('connects with the token, subscribes, answers pings and yields publications (several per frame)', async () => {
    const server = fakeCentrifugo(wss, { requireToken: 'guest-jwt' });
    const events = centrifugoEvents({ url, token: async () => 'guest-jwt', channels: ['chatrooms.668.v2'], optionalChannels: ['channel_668'], signal: ctl.signal });
    const first = events.next();
    // Publish only once the client has subscribed: how long that takes depends on the machine.
    await vi.waitFor(
      () => {
        expect(server.seen).toContainEqual(expect.objectContaining({ subscribe: { channel: 'chatrooms.668.v2' } }));
        expect(server.seen).toContainEqual(expect.objectContaining({ subscribe: { channel: 'channel_668' } }));
      },
      { timeout: 10_000 },
    );
    const ws = server.sockets[0]!;
    ws.send('{}'); // ping
    ws.send(
      [server.pub('chatrooms.668.v2', 'App\\Events\\ChatMessageEvent', chatMessage('m1', 'LOL')), server.pub('chatrooms.668.v2', 'App\\Events\\ChatMessageEvent', chatMessage('m2', 'KEKW'))].join('\n'),
    );
    expect((await first).value).toMatchObject({ event: 'App\\Events\\ChatMessageEvent', channel: 'chatrooms.668.v2', data: { id: 'm1', content: 'LOL' } });
    expect((await events.next()).value).toMatchObject({ data: { id: 'm2' } });
    expect(server.seen).toContainEqual({ id: 1, connect: { token: 'guest-jwt', name: 'js' } });
    await vi.waitFor(() => expect(server.seen).toContainEqual({ pong: true }), { timeout: 10_000 }); // the pong is on its way to the server
    ctl.abort();
    expect((await events.next()).done).toBe(true);
  });

  it('a refused optional channel is ignored', async () => {
    fakeCentrifugo(wss, { refuse: ['channel_668'] });
    const ok = centrifugoEvents({ url, token: async () => 't', channels: ['chatrooms.668.v2'], optionalChannels: ['channel_668'], signal: ctl.signal });
    const pending = ok.next();
    await new Promise((r) => setTimeout(r, 300));
    ctl.abort();
    expect((await pending).done).toBe(true);
  });

  it('a refused chatroom subscription ends it with a fatal error', async () => {
    fakeCentrifugo(wss, { refuse: ['chatrooms.1.v2'] });
    const refused = centrifugoEvents({ url, token: async () => 't', channels: ['chatrooms.1.v2'], signal: ctl.signal });
    const err = await refused.next().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PusherError);
    expect((err as PusherError).message).toMatch(/refused the chatroom subscription/);
    expect((err as PusherError).fatal).toBe(true);
  });

  it('a refused connect (bad token) throws', async () => {
    fakeCentrifugo(wss, { requireToken: 'good' });
    const events = centrifugoEvents({ url, token: async () => 'bad', channels: ['chatrooms.1.v2'], signal: ctl.signal });
    await expect(events.next()).rejects.toThrow(/refused the connect: 109 token expired/);
  });
});

describe('Kick realtime service', () => {
  const fakeFetch = (routes: Record<string, unknown>) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      const path = new URL(u).pathname;
      const body = routes[path];
      if (body === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
      return new Response(JSON.stringify(typeof body === 'function' ? (body as (b: unknown) => unknown)(JSON.parse(String(init?.body))) : body), { status: 200 });
    }) as typeof fetch;

  it('asks which provider serves the channel (Centrifugo or Pusher) and gets a guest token', async () => {
    let asked: unknown = null;
    const fetchImpl = fakeFetch({
      '/api/v1/realtime/channels/46085515/chat/connection': (b: unknown) => {
        asked = b;
        return { data: { connections: [{ provider: 'centrifugo', credentials: { url: 'wss://realtime.us-east-1.platform.kick.com/connection/websocket' } }] } };
      },
      '/api/v1/realtime/auth/connection': { data: { token: 'guest-jwt' } },
    });
    const target = await kickRealtimeTarget(46085515, ctl.signal, { fetchImpl });
    expect(target).toMatchObject({ provider: 'centrifugo', url: 'wss://realtime.us-east-1.platform.kick.com/connection/websocket' });
    expect(asked).toMatchObject({ client: { type: 'web' }, capabilities: { accepted_providers: [{ provider: 'pusher' }, { provider: 'centrifugo' }] } });
    expect(await kickGuestToken('c', ctl.signal, { fetchImpl })).toBe('guest-jwt');

    const pusher = fakeFetch({ '/api/v1/realtime/channels/1/chat/connection': { data: { connections: [{ provider: 'pusher', credentials: { app_key: 'k', cluster: 'us3' } }] } } });
    expect(await kickRealtimeTarget(1, ctl.signal, { fetchImpl: pusher })).toEqual({ provider: 'pusher', appKey: 'k', cluster: 'us3' });
    await expect(kickRealtimeTarget(2, ctl.signal, { fetchImpl: pusher })).rejects.toThrow(/HTTP 404/);
  });

  it('kickChat streams chat over Centrifugo when Kick offers it (looking up a channel id the cache lacks)', async () => {
    const server = fakeCentrifugo(wss);
    const ctx = makeCtx();
    const account = makeAccount({ options: { slug: 'itslimitlezz', chatroomId: 45797175 } }); // old cache: no channel id
    const chat = kickChat({
      ctx,
      account,
      slug: 'itslimitlezz',
      signal: ctl.signal,
      lookup: async () => ({ chatroomId: 45797175, channelId: 46085515 }),
      realtime: async (channelId) => {
        expect(channelId).toBe(46085515);
        return { provider: 'centrifugo', url, clientId: 'c1' };
      },
      guestToken: async () => 'guest-jwt',
    });
    const first = chat.next();
    await new Promise((r) => setTimeout(r, 300));
    server.sockets[0]!.send(server.pub('chatrooms.45797175.v2', 'App\\Events\\ChatMessageEvent', chatMessage('m9', 'hello from kick')));
    expect((await first).value).toMatchObject({ text: 'hello from kick', author: { name: 'imcreased' } });
    expect(server.seen).toContainEqual(expect.objectContaining({ subscribe: { channel: 'chatrooms.45797175.v2' } }));
    ctl.abort();
  });
});
