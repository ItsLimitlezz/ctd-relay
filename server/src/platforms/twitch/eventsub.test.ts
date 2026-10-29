import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { PlatformHttpError } from '../common/http.js';
import type { ChatMessageInput, ChatSourceItem } from '../types.js';
import { forgetFollows, followToChat, readTwitchEvents, withSideSource, type EventSubSubscription } from './eventsub.js';

/** A tiny fake of eventsub.wss.twitch.tv on 127.0.0.1 (sessions are numbered per connection). */
class FakeEventSub {
  readonly server: WebSocketServer;
  readonly sockets: { socket: ServerSocket; path: string; closed: boolean }[] = [];
  private waiters: (() => void)[] = [];
  /** Send session_welcome on connect. */
  welcome = true;
  keepaliveSeconds = 10;

  constructor() {
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.server.on('connection', (socket, req) => {
      const entry = { socket, path: req.url ?? '/', closed: false };
      this.sockets.push(entry);
      socket.on('close', () => {
        entry.closed = true;
        this.notify();
      });
      if (this.welcome) this.sendTo(this.sockets.length - 1, welcomeMsg(`session-${this.sockets.length}`, this.keepaliveSeconds));
      this.notify();
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/ws`;
  }

  private notify(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  async until(pred: () => boolean, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the fake EventSub server');
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
  }

  sendTo(index: number, msg: unknown): void {
    this.sockets[index]!.socket.send(JSON.stringify(msg));
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.socket.terminate();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

function welcomeMsg(id: string, keepalive = 10) {
  return {
    metadata: { message_id: `w-${id}`, message_type: 'session_welcome', message_timestamp: new Date().toISOString() },
    payload: { session: { id, status: 'connected', keepalive_timeout_seconds: keepalive, reconnect_url: null } },
  };
}

function followMsg(messageId: string, userId: string, name: string) {
  return {
    metadata: { message_id: messageId, message_type: 'notification', subscription_type: 'channel.follow', subscription_version: '2' },
    payload: {
      subscription: { type: 'channel.follow', version: '2', status: 'enabled' },
      event: {
        user_id: userId,
        user_login: name.toLowerCase(),
        user_name: name,
        broadcaster_user_id: '1337',
        broadcaster_user_login: 'limitlezz',
        broadcaster_user_name: 'Limitlezz',
        followed_at: '2026-10-29T18:00:00.123Z',
      },
    },
  };
}

function consume(it: AsyncIterable<ChatSourceItem>, into: ChatSourceItem[]): Promise<unknown> {
  return (async () => {
    try {
      for await (const m of it) into.push(m);
      return 'ended';
    } catch (err) {
      return err;
    }
  })();
}

let es: FakeEventSub;
let subs: { sessionId: string; sub: EventSubSubscription }[];

beforeEach(async () => {
  forgetFollows();
  subs = [];
  es = new FakeEventSub();
  await new Promise<void>((resolve) => es.server.once('listening', () => resolve()));
});

afterEach(async () => {
  await es.close();
});

const options = (extra: Partial<Parameters<typeof readTwitchEvents>[0]> = {}) => ({
  broadcasterId: '1337',
  url: es.url,
  subscribe: async (sessionId: string, sub: EventSubSubscription) => {
    subs.push({ sessionId, sub });
  },
  backoffMinMs: 20,
  backoffMaxMs: 40,
  ...extra,
});

describe('followToChat', () => {
  it('maps a channel.follow event to an event line with a follow alert', () => {
    const item = followToChat(followMsg('m1', '42', 'NightOwl').payload.event, 'm1');
    expect(item).toEqual({
      id: 'follow-m1',
      author: { name: 'NightOwl', id: '42', login: 'nightowl' },
      text: 'NightOwl followed',
      kind: 'event',
      ts: '2026-10-29T18:00:00.123Z',
      alert: { kind: 'follow', user: { id: '42', name: 'NightOwl' } },
    });
  });

  it('skips events without a user and quick re-follows', () => {
    expect(followToChat({ user_name: 'x' }, 'm')).toBeNull();
    expect(followToChat(followMsg('a', '7', 'Again').payload.event, 'a')).not.toBeNull();
    expect(followToChat(followMsg('b', '7', 'Again').payload.event, 'b')).toBeNull();
  });
});

describe('readTwitchEvents', () => {
  it('subscribes to follows on the welcomed session and yields follow alerts once', async () => {
    const ctl = new AbortController();
    const items: ChatSourceItem[] = [];
    const done = consume(readTwitchEvents(options(), ctl.signal), items);

    await es.until(() => subs.length === 1);
    expect(subs[0]).toEqual({
      sessionId: 'session-1',
      sub: { type: 'channel.follow', version: '2', condition: { broadcaster_user_id: '1337', moderator_user_id: '1337' } },
    });

    es.sendTo(0, { metadata: { message_id: 'k1', message_type: 'session_keepalive' }, payload: {} });
    es.sendTo(0, followMsg('m1', '42', 'NightOwl'));
    es.sendTo(0, followMsg('m1', '42', 'NightOwl')); // redelivered
    es.sendTo(0, followMsg('m2', '43', 'Pumpkin'));
    await es.until(() => items.length === 2);
    expect(items.map((i) => (i as ChatMessageInput).alert?.user.name)).toEqual(['NightOwl', 'Pumpkin']);

    ctl.abort();
    expect(await done).toBe('ended');
    await es.until(() => es.sockets[0]!.closed);
  });

  it('follows session_reconnect without subscribing again', async () => {
    const ctl = new AbortController();
    const items: ChatSourceItem[] = [];
    const done = consume(readTwitchEvents(options(), ctl.signal), items);
    await es.until(() => subs.length === 1);

    es.sendTo(0, {
      metadata: { message_id: 'r1', message_type: 'session_reconnect' },
      payload: { session: { id: 'session-1', status: 'reconnecting', reconnect_url: `${es.url}?reconnect=1` } },
    });
    await es.until(() => es.sockets.length === 2 && es.sockets[0]!.closed);
    expect(es.sockets[1]!.path).toBe('/ws?reconnect=1');

    es.sendTo(1, followMsg('m3', '44', 'Ghost'));
    await es.until(() => items.length === 1);
    expect(subs).toHaveLength(1);

    ctl.abort();
    await done;
  });

  it('reconnects and subscribes again after the connection drops', async () => {
    const ctl = new AbortController();
    const items: ChatSourceItem[] = [];
    const done = consume(readTwitchEvents(options(), ctl.signal), items);
    await es.until(() => subs.length === 1);

    es.sockets[0]!.socket.terminate();
    await es.until(() => subs.length === 2);
    expect(subs[1]!.sessionId).toBe('session-2');

    ctl.abort();
    expect(await done).toBe('ended');
  });

  it('reconnects when the session goes silent past its keepalive', async () => {
    es.keepaliveSeconds = 0.1 as number;
    const ctl = new AbortController();
    const done = consume(readTwitchEvents(options({ keepaliveGraceMs: 0 }), ctl.signal), []);
    await es.until(() => subs.length >= 2, 6000);
    ctl.abort();
    await done;
  });

  it('ends quietly when Twitch refuses the subscription', async () => {
    const ctl = new AbortController();
    const refuse = async () => {
      throw new PlatformHttpError(403, 'api.twitch.tv responded 403', '{"message":"subscription missing proper authorization"}');
    };
    const result = await consume(readTwitchEvents(options({ subscribe: refuse }), ctl.signal), []);
    expect(result).toBe('ended');
    expect(es.sockets).toHaveLength(1);
  });
});

describe('withSideSource', () => {
  async function* items<T>(list: T[], signal: AbortSignal, then?: 'wait' | 'throw'): AsyncGenerator<T> {
    for (const x of list) yield x;
    if (then === 'throw') throw new Error('boom');
    if (then === 'wait') await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  }

  it('merges both, survives the side failing and ends with the main source', async () => {
    const ctl = new AbortController();
    const out: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const main = async function* (signal: AbortSignal) {
      yield 'a';
      await gate;
      yield* items(['b'], signal);
    };
    const side = (signal: AbortSignal) => items(['x'], signal, 'throw');
    const done = (async () => {
      for await (const v of withSideSource(main, side, ctl.signal)) {
        out.push(v);
        if (out.length === 2) release();
      }
    })();
    await done;
    expect(out.sort()).toEqual(['a', 'b', 'x']);
  });

  it('throws when the main source throws, and stops the side source', async () => {
    const ctl = new AbortController();
    let sideStopped = false;
    const side = async function* (signal: AbortSignal) {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      sideStopped = true;
      yield 'never';
    };
    const main = (signal: AbortSignal) => items(['a'], signal, 'throw');
    const result = await consume(withSideSource(main, side, ctl.signal) as AsyncIterable<never>, []);
    expect((result as Error).message).toBe('boom');
    await new Promise((r) => setTimeout(r, 10));
    expect(sideStopped).toBe(true);
  });
});
