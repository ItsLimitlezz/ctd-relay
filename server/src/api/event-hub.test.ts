import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Destination, SessionState } from '../../../shared/types.js';
import { EventBus } from '../events.js';
import { EventHub } from './event-hub.js';
import { dest, dstate, platformInfo, session, silentLog } from './test-helpers.js';
import type { ApiChatMessage, ApiEventType, Envelope } from './types.js';

let bus: EventBus;
let destinations: Destination[];
let current: SessionState;
let hub: EventHub;
let events: Envelope[];
const T0 = Date.parse('2026-10-17T03:00:00.000Z');

function makeHub(over: Partial<ConstructorParameters<typeof EventHub>[0]> = {}): EventHub {
  const h = new EventHub({
    bus,
    log: silentLog,
    state: () => current,
    destinations: () => destinations,
    destination: (id) => destinations.find((d) => d.id === id) ?? null,
    platformInfo,
    ...over,
  });
  h.subscribe((e) => events.push(e));
  return h;
}

function chat(id: string, over: Partial<ChatMessage> = {}, author: Partial<ChatMessage['author']> = {}): ChatMessage {
  return {
    id: `twitch:${id}`,
    platform: 'twitch',
    destinationId: 't1',
    author: { name: 'Ann', id: 'u-ann', ...author },
    text: `msg ${id}`,
    ts: new Date().toISOString(),
    kind: 'message',
    ...over,
  };
}

const types = () => events.map((e) => e.type);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  bus = new EventBus();
  destinations = [dest('t1', { name: 'Twitch' }), dest('i1', { name: 'Instagram', platform: 'instagram', feed: 'vertical' })];
  current = session({ status: 'offline', startedAt: null, destinations: [dstate('t1', 'idle'), dstate('i1', 'idle')] });
  events = [];
  hub = makeHub();
});

afterEach(() => {
  hub.close();
  vi.useRealTimers();
});

describe('envelopes', () => {
  it('wraps bus events in envelopes with monotonic ULIDs, ts and src', () => {
    bus.emit('notice', { level: 'warn', message: 'Instagram ended the live' });
    bus.emit('chat', chat('1'));
    expect(events).toHaveLength(2);
    const [notice, msg] = events as [Envelope, Envelope<ApiChatMessage>];
    expect(notice).toEqual({
      id: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
      type: 'system.notice',
      ts: T0,
      src: { connector: 'ctd-multi-stream', connection: 'core', platform: 'core', profile: null },
      data: { level: 'warn', message: 'Instagram ended the live' },
    });
    expect(msg.id > notice.id).toBe(true);
    expect(msg.src).toEqual({ connector: 'ctd-multi-stream', connection: 't1', platform: 'twitch', profile: 'default' });
    expect(msg.data).toMatchObject({ id: 'twitch:1', channel: 'Twitch', user: { id: 'twitch:u-ann' } });
  });

  it('uses the platform name as channel when the destination is gone', () => {
    bus.emit('chat', chat('1', { destinationId: 'deleted' }));
    expect((events[0]!.data as ApiChatMessage).channel).toBe('Twitch');
  });

  it('stream.status only when status, title, test mode or auto go-live change', () => {
    bus.emit('session', { ...current }); // nothing changed (e.g. a feed came online)
    expect(types()).toEqual([]);
    current = { ...current, status: 'live', startedAt: '2026-10-17T03:00:04.000Z' };
    bus.emit('session', current);
    current = { ...current, title: 'New title' };
    bus.emit('session', current);
    current = { ...current, testMode: true };
    bus.emit('session', current);
    current = { ...current, autoGoLive: false };
    bus.emit('session', current);
    bus.emit('session', current);
    expect(types().filter((t) => t === 'stream.status')).toHaveLength(4);
    expect(events.at(-1)?.data).toEqual({ status: 'live', startedAt: '2026-10-17T03:00:04.000Z', title: 'New title', testMode: true, autoGoLive: false, viewers: null });
  });

  it('stream.status carries the viewers of every platform added up, sent when the total changes', () => {
    current = { ...current, status: 'live', startedAt: '2026-10-17T03:00:04.000Z' };
    bus.emit('session', current);
    bus.emit('destination', dstate('t1', 'live', { viewers: 120 }));
    bus.emit('destination', dstate('i1', 'live', { viewers: 30 }));
    bus.emit('destination', dstate('i1', 'live', { viewers: 30, stats: { bitrateKbps: 1, fps: 30, speed: 1, uptimeSec: 9 } })); // same count
    const totals = events.filter((e) => e.type === 'stream.status').map((e) => (e.data as { viewers: number | null }).viewers);
    expect(totals).toEqual([null, 120, 150]);
  });
});

describe('throttling', () => {
  it('feed.status: immediate on online/codec changes, at most every 2 s for bitrate (trailing value)', async () => {
    const base = current.feeds[0]!;
    bus.emit('feed', { ...base, bitrateKbps: 6000 }); // bitrate only, first change: sent
    expect(types()).toEqual(['feed.status']);
    bus.emit('feed', { ...base, bitrateKbps: 6100 });
    bus.emit('feed', { ...base, bitrateKbps: 6200 });
    expect(types()).toEqual(['feed.status']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(types()).toEqual(['feed.status', 'feed.status']);
    expect(events[1]!.data).toMatchObject({ bitrateKbps: 6200 });

    bus.emit('feed', { ...base, online: false, bitrateKbps: null, video: null }); // not throttled
    expect(types()).toHaveLength(3);
    bus.emit('feed', { ...base, online: false, bitrateKbps: null, video: null }); // no change
    expect(types()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(types()).toHaveLength(3);
  });

  it('destination.status: immediate on phase change, at most every 2 s for stats/viewers', async () => {
    current = { ...current, status: 'live' };
    // Only destination.status here (a viewer change also updates the total on stream.status).
    const dests = () => events.filter((e) => e.type === 'destination.status');
    bus.emit('destination', dstate('t1', 'live'));
    expect(dests()).toHaveLength(1);
    const stats = (kbps: number) => ({ bitrateKbps: kbps, fps: 60, speed: 1, uptimeSec: 10 });
    bus.emit('destination', dstate('t1', 'live', { stats: stats(6000) }));
    bus.emit('destination', dstate('t1', 'live', { stats: stats(6001), viewers: 5 }));
    bus.emit('destination', dstate('t1', 'live', { stats: stats(6002), viewers: 7 }));
    expect(dests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(dests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(dests()).toHaveLength(2);
    expect(dests()[1]!.data).toMatchObject({ stats: { bitrateKbps: 6002 }, viewers: 7 });

    bus.emit('destination', dstate('t1', 'retrying', { message: 'Connection lost' }));
    expect(dests()).toHaveLength(3); // phase change: right away (down only while running...)
  });
});

describe('down/up edges', () => {
  it('emits destination.down once per transition, then destination.up with the downtime', async () => {
    current = { ...current, status: 'live', startedAt: '2026-10-17T03:00:04.000Z' };
    bus.emit('session', current);
    bus.emit('destination', dstate('i1', 'live'));
    events = [];

    bus.emit('destination', dstate('i1', 'recovering', { message: 'Instagram ended the live (copyright). Starting a new one…', recoveries: 1 }));
    bus.emit('destination', dstate('i1', 'recovering', { message: 'Instagram ended the live (copyright). Starting a new one…', recoveries: 1, retries: 1 }));
    bus.emit('destination', dstate('i1', 'error', { message: 'still broken', recoveries: 1 }));
    expect(types().filter((t) => t === 'destination.down')).toHaveLength(1);
    const down = events.find((e) => e.type === 'destination.down')!;
    expect(down.data).toEqual({
      destinationId: 'i1',
      name: 'Instagram',
      platform: 'instagram',
      phase: 'recovering',
      reason: 'Instagram ended the live (copyright). Starting a new one…',
    });
    expect(down.src).toEqual({ connector: 'ctd-multi-stream', connection: 'i1', platform: 'instagram', profile: 'default' });
    // destination.status (with down: true) comes before destination.down
    expect(types().indexOf('destination.status')).toBeLessThan(types().indexOf('destination.down'));

    await vi.advanceTimersByTimeAsync(41_000);
    bus.emit('destination', dstate('i1', 'live', { recoveries: 1 }));
    const up = events.filter((e) => e.type === 'destination.up');
    expect(up).toHaveLength(1);
    expect(up[0]!.data).toEqual({ destinationId: 'i1', name: 'Instagram', platform: 'instagram', downForSec: 41, recoveries: 1 });
  });

  it('a stopped session clears down (up), and a disabled destination is never down', () => {
    current = { ...current, status: 'live', destinations: [dstate('t1', 'error', { message: 'boom' }), dstate('i1', 'live')] };
    bus.emit('session', current);
    expect(types().filter((t) => t === 'destination.down')).toHaveLength(1);
    current = { ...current, status: 'offline', destinations: [dstate('t1', 'error', { message: 'boom' }), dstate('i1', 'live')] };
    bus.emit('session', current);
    expect(types().filter((t) => t === 'destination.up')).toHaveLength(1);

    destinations = [dest('t1', { name: 'Twitch', enabled: false }), destinations[1]!];
    current = { ...current, status: 'live' };
    bus.emit('session', current);
    expect(types().filter((t) => t === 'destination.down')).toHaveLength(1);
  });

  it('platforms skipped by test mode are never down', () => {
    destinations = [dest('k1', { name: 'Kick', platform: 'kick' })]; // test helper: kick has no test mode
    current = session({ status: 'live', testMode: true, destinations: [dstate('k1', 'error')] });
    bus.emit('destinations-changed');
    bus.emit('session', current);
    expect(types()).not.toContain('destination.down');
  });

  it('starts from the current state: an already-down destination at startup is not re-announced', () => {
    hub.close();
    current = session({ status: 'live', destinations: [dstate('t1', 'error'), dstate('i1', 'live')] });
    events = [];
    hub = makeHub();
    bus.emit('destination', dstate('t1', 'error', { retries: 2 }));
    expect(types()).not.toContain('destination.down');
    bus.emit('destination', dstate('t1', 'live'));
    expect(types()).toContain('destination.up');
  });
});

describe('replay buffer', () => {
  it('replays after a cursor, and resets for cursors older than the buffer or this process', () => {
    const floor = hub.floor;
    expect(hub.cursor()).toBe(floor);
    expect(hub.since(floor)).toEqual({ items: [], reset: false });
    for (let i = 0; i < 5; i++) bus.emit('notice', { level: 'info', message: `n${i}` });
    const all = hub.since(floor).items;
    expect(all.map((e) => (e.data as { message: string }).message)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
    expect(hub.since(all[2]!.id).items.map((e) => e.id)).toEqual([all[3]!.id, all[4]!.id]);
    expect(hub.since(all[4]!.id)).toEqual({ items: [], reset: false });
    expect(hub.cursor()).toBe(all[4]!.id);
    // A cursor from before this process started (e.g. before a restart).
    expect(hub.since('00000000000000000000000000')).toEqual({ items: [], reset: true });
  });

  it('keeps the last 2000 events', () => {
    hub.close();
    hub = makeHub({ bufferMax: 10 });
    const ids: string[] = [];
    hub.subscribe((e) => ids.push(e.id));
    for (let i = 0; i < 15; i++) bus.emit('notice', { level: 'info', message: String(i) });
    expect(hub.since(hub.floor)).toEqual({ items: [], reset: true });
    expect(hub.since(ids[3]!)).toEqual({ items: [], reset: true }); // its successor (ids[4]) was evicted
    expect(hub.since(ids[4]!).items.map((e) => e.id)).toEqual(ids.slice(5));
    expect(hub.since(ids[5]!).items).toHaveLength(9);
  });

  it('keeps 15 minutes of events', async () => {
    bus.emit('notice', { level: 'info', message: 'old' });
    const old = events[0]!.id;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    bus.emit('notice', { level: 'info', message: 'newer' });
    const newer = events[1]!.id;
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    // 'old' is 16 min old: evicted. A cursor right at it is still fine (nothing after it was lost).
    expect(hub.since(old).items.map((e) => e.id)).toEqual([newer]);
    expect(hub.since(hub.floor).reset).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(hub.since(newer)).toEqual({ items: [], reset: false });
    expect(hub.since(old).reset).toBe(true);
  });

  it('filtered readers only reset when an event of their types was lost', () => {
    hub.close();
    hub = makeHub({ bufferMax: 10 });
    const chatTypes = new Set<ApiEventType>(['chat.message', 'chat.message.deleted', 'chat.user.cleared', 'chat.cleared', 'system.reset']);
    const downOnly = new Set<ApiEventType>(['destination.down', 'system.reset']);
    bus.emit('chat', chat('1'));
    const cursor = hub.cursor();
    for (let i = 0; i < 25; i++) bus.emit('notice', { level: 'info', message: `n${i}` });
    // Unfiltered readers lost notices; chat and destination.down readers lost nothing.
    expect(hub.since(cursor).reset).toBe(true);
    const chatReplay = hub.since(cursor, chatTypes);
    expect(chatReplay.reset).toBe(false);
    expect(chatReplay.items.filter((e) => chatTypes.has(e.type))).toEqual([]);
    expect(hub.since(cursor, downOnly).reset).toBe(false);

    // A chat message after the cursor that left the buffer does reset a chat reader.
    bus.emit('chat', chat('2'));
    for (let i = 0; i < 10; i++) bus.emit('notice', { level: 'info', message: `m${i}` });
    expect(hub.since(cursor, chatTypes).reset).toBe(true);
    expect(hub.since(cursor, downOnly).reset).toBe(false);
    // Still a reset for a cursor from before this process.
    expect(hub.since('00000000000000000000000000', chatTypes).reset).toBe(true);
  });

  it('a cursor newer than anything this process produced (restart with the clock set back) resets', () => {
    bus.emit('chat', chat('1'));
    bus.emit('chat', chat('2'));
    const future = '7ZZZZZZZZZZZZZZZZZZZZZZZZZ';
    expect(hub.since(future)).toEqual({ items: [], reset: true });
    expect(hub.since(hub.cursor())).toEqual({ items: [], reset: false });
    // /chat treats it as absent: the newest messages.
    expect(hub.chat(200, future).items.map((e) => e.data.id)).toEqual(['twitch:1', 'twitch:2']);
  });

  it('snapshot: one stream.status + one destination.status per destination, fresh ids, not buffered', () => {
    const snap = hub.snapshot();
    expect(snap.map((e) => e.type)).toEqual(['stream.status', 'destination.status', 'destination.status']);
    expect(snap[1]!.data).toMatchObject({ id: 't1', name: 'Twitch' });
    expect(snap[2]!.src).toMatchObject({ connection: 'i1', platform: 'instagram' });
    expect(hub.since(hub.floor).items).toEqual([]);
    expect(hub.cursor()).toBe(snap.at(-1)!.id);
  });
});

describe('chat buffer', () => {
  it('mirrors the last 500 messages with moderation applied', () => {
    hub.close();
    hub = makeHub({ chatBufferSize: 5 });
    for (let i = 1; i <= 7; i++) bus.emit('chat', chat(String(i)));
    expect(hub.chat(200).items.map((e) => e.data.id)).toEqual(['twitch:3', 'twitch:4', 'twitch:5', 'twitch:6', 'twitch:7']);

    bus.emit('chat-moderation', { kind: 'message-deleted', platform: 'twitch', destinationId: 't1', ts: '', messageId: 'twitch:4', platformMessageId: '4' });
    bus.emit('chat-moderation', { kind: 'message-deleted', platform: 'twitch', destinationId: 't1', ts: '', messageId: null, platformMessageId: '5' });
    expect(hub.chat(200).items.map((e) => e.data.id)).toEqual(['twitch:3', 'twitch:6', 'twitch:7']);
  });

  it('user-cleared and cleared remove only that destination\'s messages', () => {
    bus.emit('chat', chat('1'));
    bus.emit('chat', chat('2', {}, { name: 'Bob', id: 'u-bob' }));
    bus.emit('chat', chat('3', { destinationId: 'i1', platform: 'instagram', id: 'instagram:3' }, { name: 'Ann', id: undefined }));
    bus.emit('chat-moderation', { kind: 'user-cleared', platform: 'twitch', destinationId: 't1', ts: '', userId: 'u-ann', userName: 'Ann' });
    expect(hub.chat(200).items.map((e) => e.data.id)).toEqual(['twitch:2', 'instagram:3']);
    bus.emit('chat-moderation', { kind: 'cleared', platform: 'twitch', destinationId: 't1', ts: '' });
    expect(hub.chat(200).items.map((e) => e.data.id)).toEqual(['instagram:3']);
    expect(types()).toEqual(['chat.message', 'chat.message', 'chat.message', 'chat.user.cleared', 'chat.cleared']);
    expect(events[3]!.data).toEqual({ userId: 'twitch:u-ann', userName: 'Ann', platform: 'twitch', destinationId: 't1' });
  });

  it('limit and after paging; next is the last item or the given after', () => {
    for (let i = 1; i <= 5; i++) bus.emit('chat', chat(String(i)));
    const all = hub.chat(500).items;
    expect(hub.chat(2).items.map((e) => e.data.id)).toEqual(['twitch:4', 'twitch:5']);
    const page = hub.chat(2, all[0]!.id);
    expect(page.items.map((e) => e.data.id)).toEqual(['twitch:2', 'twitch:3']);
    expect(page.next).toBe(all[2]!.id);
    expect(hub.chat(2, all[4]!.id)).toEqual({ items: [], next: all[4]!.id });
    // Empty buffer: next is the current cursor.
    hub.close();
    events = [];
    hub = makeHub();
    expect(hub.chat(200)).toEqual({ items: [], next: hub.cursor() });
  });
});

describe('alerts', () => {
  it('a chat line carrying an alert also yields alert.<kind> right after its chat.message', () => {
    bus.emit(
      'chat',
      chat('sub1', {
        kind: 'event',
        text: 'Ann subscribed at Tier 1 for 12 months',
        alert: { kind: 'subscription', user: { id: 'u-ann', name: 'Ann' }, amount: { unit: 'months', value: 12 }, tier: '1000' },
      }),
    );
    expect(types()).toEqual(['chat.message', 'alert.subscription']);
    const [line, alert] = events as [Envelope<ApiChatMessage>, Envelope];
    expect(alert.id > line.id).toBe(true);
    expect(alert.src).toEqual(line.src);
    expect(alert.data).toEqual({
      kind: 'subscription',
      user: { id: 'twitch:u-ann', name: 'Ann' },
      amount: { unit: 'months', value: 12 },
      tier: '1000',
      platform: 'twitch',
      destinationId: 't1',
      messageId: line.data.id,
      ts: T0,
    });
    // Alerts are live events only: GET /chat backfill holds the chat line, not the alert.
    expect(hub.chat(200).items.map((e) => e.type)).toEqual(['chat.message']);
    // Replayable from the buffer like any event.
    expect(hub.since(hub.floor).items.map((e) => e.type)).toEqual(['chat.message', 'alert.subscription']);
  });

  it('plain messages and invalid alerts yield no alert envelope', () => {
    bus.emit('chat', chat('1'));
    bus.emit('chat', chat('2', { kind: 'event', alert: { kind: 'nope' } as unknown as ChatMessage['alert'] }));
    expect(types()).toEqual(['chat.message', 'chat.message']);
  });
});

describe('robustness', () => {
  it('a throwing subscriber or repo does not break the bus', () => {
    hub.subscribe(() => {
      throw new Error('listener bug');
    });
    bus.emit('notice', { level: 'info', message: 'x' });
    expect(types()).toEqual(['system.notice']);

    hub.close();
    events = [];
    hub = makeHub({
      destination: () => {
        throw new Error('db locked');
      },
    });
    bus.emit('chat', chat('1'));
    expect(types()).toEqual(['chat.message']);
  });

  it('a repo failure inside a trailing (throttled) send is logged, never thrown from the timer', async () => {
    hub.close();
    const warn = vi.fn();
    let broken = false;
    hub = makeHub({
      log: { warn },
      destination: (id) => {
        if (broken) throw new Error('disk I/O error');
        return destinations.find((d) => d.id === id) ?? null;
      },
    });
    current = { ...current, status: 'live' };
    const stats = (kbps: number) => ({ bitrateKbps: kbps, fps: 60, speed: 1, uptimeSec: 10 });
    bus.emit('destination', dstate('t1', 'live'));
    bus.emit('destination', dstate('t1', 'live', { stats: stats(6000) })); // stats only: trailing send armed
    expect(types()).toEqual(['destination.status']);
    broken = true;
    await vi.advanceTimersByTimeAsync(5000); // would be an uncaught exception (process crash) before the fix
    expect(types()).toEqual(['destination.status']);
    expect(warn).toHaveBeenCalledWith({ error: 'disk I/O error' }, 'api event hub failed to handle an event');

    // Works again once the repo does.
    broken = false;
    bus.emit('destination', dstate('t1', 'live', { stats: stats(6100) }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(types()).toEqual(['destination.status', 'destination.status']);
  });

  it('a failed destinations listing keeps the tracks (no second destination.down)', () => {
    hub.close();
    let broken = false;
    hub = makeHub({
      destinations: () => {
        if (broken) throw new Error('db locked');
        return destinations;
      },
    });
    current = session({ status: 'live', destinations: [dstate('t1', 'error', { message: 'boom' }), dstate('i1', 'live')] });
    bus.emit('session', current);
    expect(types().filter((t) => t === 'destination.down')).toHaveLength(1);
    broken = true;
    bus.emit('destinations-changed');
    bus.emit('session', current);
    broken = false;
    bus.emit('session', current);
    expect(types().filter((t) => t === 'destination.down')).toHaveLength(1);
    expect(types()).not.toContain('destination.up');
  });

  it('deleting a down destination closes its down edge with destination.up', async () => {
    current = session({ status: 'live', destinations: [dstate('t1', 'error', { message: 'boom', recoveries: 2 }), dstate('i1', 'live')] });
    bus.emit('session', current);
    await vi.advanceTimersByTimeAsync(5000);
    destinations = [destinations[1]!];
    bus.emit('destinations-changed');
    const up = events.filter((e) => e.type === 'destination.up');
    expect(up).toHaveLength(1);
    expect(up[0]!.data).toEqual({ destinationId: 't1', name: 'Twitch', platform: 'twitch', downForSec: 5, recoveries: 2 });
    // Deleting a healthy destination sends nothing.
    events = [];
    destinations = [];
    bus.emit('destinations-changed');
    expect(types()).toEqual([]);
  });

  it('close() unsubscribes and cancels trailing sends', async () => {
    bus.emit('feed', { ...current.feeds[0]!, bitrateKbps: 1 });
    bus.emit('feed', { ...current.feeds[0]!, bitrateKbps: 2 });
    hub.close();
    await vi.advanceTimersByTimeAsync(5000);
    bus.emit('notice', { level: 'info', message: 'x' });
    expect(types()).toEqual(['feed.status']);
  });
});
