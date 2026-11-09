import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Destination, FieldSpec } from '../../../shared/types.js';
import { normalizeFields } from '../http/validation.js';
import { DriverError, type ChatMessageInput, type PreparedLive } from '../platforms/types.js';
import { advance, dest, driver, flush, goLive, harness, PLAN, prepared, STATS } from './test-helpers.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('go live', () => {
  it('goes live automatically when a feed comes online', async () => {
    const live = prepared();
    const prepare = vi.fn(async (_d: Destination, _a: Account | null, _title: string) => live);
    const h = harness({
      dests: [dest('d1')],
      drivers: [driver('custom', { prepare })],
      settings: { 'session.title': 'Hello world' },
    });
    await h.orch.init();
    expect(h.orch.state().status).toBe('offline');
    expect(h.phase('d1')).toBe('idle');

    h.media.set('landscape', true);
    await flush();
    expect(h.orch.state().status).toBe('live');
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[2]).toBe('Hello world');
    expect(h.pushes.starts).toEqual([{ id: 'd1', plan: PLAN }]);
    expect(h.phase('d1')).toBe('connecting');

    h.pushes.running('d1');
    await flush();
    const st = h.destState('d1');
    expect(st.phase).toBe('live');
    expect(st.watchUrl).toBe('https://watch.example.com/me');
    expect(st.stats).toEqual(STATS);
    expect(h.history('d1')).toEqual(['preparing', 'connecting', 'live']);
    expect(h.sessionEvents.map((s) => s.status)).toContain('starting');
  });

  it('starts on init when a feed is already online and auto go-live is on', async () => {
    const prepare = vi.fn(async () => prepared());
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })] });
    h.media.preset('landscape', true);
    await h.orch.init();
    await flush();
    expect(h.orch.state().status).toBe('live');
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('does not auto start when auto go-live is off', async () => {
    const prepare = vi.fn(async () => prepared());
    const h = harness({
      dests: [dest('d1')],
      drivers: [driver('custom', { prepare })],
      settings: { 'session.autoGoLive': false },
    });
    await h.orch.init();
    h.media.set('landscape', true);
    await flush();
    expect(h.orch.state().status).toBe('offline');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('manual start waits for the feed, then goes live', async () => {
    const prepare = vi.fn(async () => prepared());
    const h = harness({
      dests: [dest('d1'), dest('v1', { platform: 'tiktok', feed: 'vertical' })],
      drivers: [driver('custom', { prepare }), driver('tiktok', { prepare })],
      settings: { 'session.autoGoLive': false },
    });
    await h.orch.init();
    await h.orch.start('manual');
    await flush();
    expect(h.orch.state().status).toBe('live');
    expect(h.phase('d1')).toBe('waiting-for-feed');
    expect(h.destState('d1').message).toContain('landscape');
    expect(prepare).not.toHaveBeenCalled();

    // A manually armed session is not ended just because OBS isn't streaming yet.
    await advance(60_000);
    expect(h.orch.state().status).toBe('live');

    h.media.set('landscape', true);
    await flush();
    expect(prepare).toHaveBeenCalledTimes(1);
    h.pushes.running('d1');
    await flush();
    expect(h.phase('d1')).toBe('live');
    expect(h.phase('v1')).toBe('waiting-for-feed');
  });

  it('honours driver.requiredFeeds', async () => {
    const prepare = vi.fn(async () => prepared({ push: { ...PLAN, mode: 'multitrack', feeds: ['landscape', 'vertical'] } }));
    const h = harness({
      dests: [dest('t1', { platform: 'twitch' })],
      drivers: [driver('twitch', { prepare, requiredFeeds: () => ['landscape', 'vertical'] })],
    });
    await h.orch.init();
    h.media.set('landscape', true);
    await flush();
    expect(h.phase('t1')).toBe('waiting-for-feed');
    expect(h.destState('t1').message).toContain('vertical');
    h.media.set('vertical', true);
    await flush();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(h.phase('t1')).toBe('connecting');
  });

  it('Dual Format with only landscape online waits for the vertical feed', async () => {
    const prepare = vi.fn(async () => prepared());
    const h = harness({
      dests: [dest('t1', { platform: 'twitch', options: { dualFormat: 'relay-multitrack' } })],
      drivers: [driver('twitch', { prepare, requiredFeeds: () => ['landscape', 'vertical'] })],
    });
    await h.orch.init();
    h.media.set('landscape', true);
    await flush();
    expect(h.destState('t1')).toMatchObject({ phase: 'waiting-for-feed', waitingFor: ['vertical'], message: 'Waiting for vertical feed' });
    expect(prepare).not.toHaveBeenCalled();
    h.media.set('landscape', false);
    await flush();
    expect(h.destState('t1')).toMatchObject({ waitingFor: ['landscape', 'vertical'], message: 'Waiting for both feeds' });
    h.media.set('vertical', true);
    await flush();
    expect(h.destState('t1')).toMatchObject({ waitingFor: ['landscape'], message: 'Waiting for landscape feed' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('a vertical-only platform with the vertical feed offline waits for vertical, then clears waitingFor', async () => {
    const prepare = vi.fn(async () => prepared());
    const h = harness({
      dests: [dest('l1'), dest('i1', { platform: 'instagram', feed: 'vertical' })],
      drivers: [driver('custom', { prepare }), driver('instagram', { prepare })],
    });
    await h.orch.init();
    h.media.set('landscape', true);
    await flush();
    expect(h.destState('i1')).toMatchObject({ phase: 'waiting-for-feed', waitingFor: ['vertical'], message: 'Waiting for vertical feed' });
    expect(h.destState('l1').waitingFor ?? []).toEqual([]);
    h.media.set('vertical', true);
    await flush();
    expect(h.destState('i1').phase).toBe('connecting');
    expect(h.destState('i1').waitingFor).toEqual([]);
  });

  it('reports both feeds when neither is online (manual start)', async () => {
    const h = harness({
      dests: [dest('t1', { platform: 'twitch' })],
      drivers: [driver('twitch', { prepare: async () => prepared(), requiredFeeds: () => ['landscape', 'vertical'] })],
      settings: { 'session.autoGoLive': false },
    });
    await h.orch.init();
    await h.orch.start('manual');
    await flush();
    expect(h.destState('t1')).toMatchObject({ waitingFor: ['landscape', 'vertical'], message: 'Waiting for both feeds' });
  });

  it('skips disabled destinations and marks them disabled', async () => {
    const prepare = vi.fn(async () => prepared());
    const h = harness({
      dests: [dest('d1', { enabled: false })],
      drivers: [driver('custom', { prepare })],
    });
    await goLive(h, []);
    expect(h.orch.state().status).toBe('live');
    expect(h.phase('d1')).toBe('disabled');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('goes live immediately when the driver needs no push, and attaches chat', async () => {
    const chatSource = async function* (): AsyncIterable<ChatMessageInput> {};
    const live = prepared({ push: null, chat: chatSource });
    const h = harness({ dests: [dest('d1', { platform: 'twitch' })], drivers: [driver('twitch', { prepare: async () => live })] });
    await goLive(h, []);
    expect(h.phase('d1')).toBe('live');
    expect(h.pushes.starts).toEqual([]);
    expect(h.chat.attaches).toHaveLength(1);
    expect(h.chat.attaches[0]?.id).toBe('d1');
    expect(h.chat.attaches[0]?.signal.aborted).toBe(false);

    await h.orch.stop();
    expect(h.chat.attaches[0]?.signal.aborted).toBe(true);
    expect(live.end).toHaveBeenCalledTimes(1);
  });

  it('fails validation without retrying', async () => {
    const prepare = vi.fn(async () => prepared());
    const h = harness({
      dests: [dest('d1')],
      drivers: [driver('custom', { prepare, validateDestination: async () => ['Stream key is missing'] })],
    });
    await goLive(h, []);
    expect(h.phase('d1')).toBe('error');
    expect(h.destState('d1').message).toBe('Stream key is missing');
    expect(prepare).not.toHaveBeenCalled();
    await advance(600_000);
    expect(h.phase('d1')).toBe('error');
  });
});

describe('confirm', () => {
  it('prepare → push running → confirm → live, confirm only once', async () => {
    let finish!: () => void;
    const confirm = vi.fn((_signal: AbortSignal) => new Promise<void>((r) => (finish = r)));
    const live = prepared({ confirm });
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare: async () => live })] });
    await goLive(h, ['d1']);
    expect(h.phase('d1')).toBe('confirming');
    h.pushes.running('d1');
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(h.phase('d1')).toBe('confirming');

    finish();
    await flush();
    expect(h.phase('d1')).toBe('live');
    expect(h.history('d1')).toEqual(['preparing', 'connecting', 'confirming', 'live']);

    // Relay hiccup: no second confirm.
    h.pushes.emit('d1', 'retrying', { message: 'Connection reset', attempt: 1 });
    await flush();
    expect(h.phase('d1')).toBe('retrying');
    expect(h.destState('d1').retries).toBe(1);
    h.pushes.running('d1');
    await flush();
    expect(h.phase('d1')).toBe('live');
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('confirm failure stops the push, ends the live and marks error', async () => {
    const confirm = vi.fn(async () => {
      throw new Error('Go Live button not found');
    });
    const live = prepared({ confirm });
    const h = harness({
      dests: [dest('d1'), dest('d2', { platform: 'kick' })],
      drivers: [driver('custom', { prepare: async () => live }), driver('kick', { prepare: async () => prepared() })],
    });
    await goLive(h, ['d1', 'd2']);
    expect(h.phase('d1')).toBe('error');
    expect(h.destState('d1').message).toContain('Go Live button not found');
    expect(live.end).toHaveBeenCalledTimes(1);
    expect(h.pushes.stops).toEqual(['d1']);
    expect(h.notices.some((n) => n.level === 'error' && n.message.includes('D1'))).toBe(true);
    // Other destinations are unaffected.
    expect(h.phase('d2')).toBe('live');
    await advance(600_000);
    expect(h.phase('d1')).toBe('error');
  });

  it('confirm timing out after 180 s is an error', async () => {
    const confirm = vi.fn((_signal: AbortSignal) => new Promise<void>(() => {}));
    const live = prepared({ confirm });
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare: async () => live })] });
    await goLive(h, ['d1']);
    await advance(179_000);
    expect(h.phase('d1')).toBe('confirming');
    await advance(1_000);
    expect(h.phase('d1')).toBe('error');
    expect(h.destState('d1').message).toContain('timed out');
    expect(confirm.mock.calls[0]?.[0].aborted).toBe(true);
    expect(live.end).toHaveBeenCalledTimes(1);
  });
});

describe('errors and retries', () => {
  it('DriverError needs-login → error without retry', async () => {
    const prepare = vi.fn(async (): Promise<PreparedLive> => {
      throw new DriverError('Session expired: log in again', 'needs-login');
    });
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })] });
    await goLive(h, []);
    expect(h.phase('d1')).toBe('error');
    expect(h.destState('d1').message).toBe('Session expired: log in again');
    await advance(10 * 60_000);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('generic errors retry with backoff 5/15/30/60/60 s, then error', async () => {
    const prepare = vi.fn(async (): Promise<PreparedLive> => {
      throw new Error('upstream 503');
    });
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })] });
    await goLive(h, []);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(h.phase('d1')).toBe('retrying');
    expect(h.destState('d1').retries).toBe(1);
    expect(h.destState('d1').message).toContain('upstream 503');

    await advance(4_999);
    expect(prepare).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(prepare).toHaveBeenCalledTimes(2);
    await advance(15_000);
    expect(prepare).toHaveBeenCalledTimes(3);
    await advance(30_000);
    expect(prepare).toHaveBeenCalledTimes(4);
    await advance(60_000);
    expect(prepare).toHaveBeenCalledTimes(5);
    expect(h.phase('d1')).toBe('retrying');
    await advance(60_000);
    expect(prepare).toHaveBeenCalledTimes(6);
    expect(h.phase('d1')).toBe('error');
    await advance(10 * 60_000);
    expect(prepare).toHaveBeenCalledTimes(6);
  });

  it('recovers when a retry succeeds', async () => {
    let calls = 0;
    const prepare = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('flaky');
      return prepared();
    });
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })] });
    await goLive(h, []);
    expect(h.phase('d1')).toBe('retrying');
    await advance(5_000);
    expect(h.phase('d1')).toBe('connecting');
    h.pushes.running('d1');
    await flush();
    expect(h.phase('d1')).toBe('live');
  });

  it('a prepare timeout retries, and a late result is ended', async () => {
    const late = prepared();
    let resolveFirst!: (p: PreparedLive) => void;
    let calls = 0;
    const prepare = vi.fn((): Promise<PreparedLive> => {
      calls += 1;
      if (calls === 1) return new Promise((r) => (resolveFirst = r));
      return Promise.resolve(prepared());
    });
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })] });
    await goLive(h, []);
    await advance(120_000);
    expect(h.phase('d1')).toBe('retrying');
    expect(h.destState('d1').message).toContain('timed out');
    expect(h.contexts[0]?.signal.aborted).toBe(true);

    resolveFirst(late);
    await flush();
    expect(late.end).toHaveBeenCalledTimes(1);

    await advance(5_000);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(h.phase('d1')).toBe('connecting');
  });

  it('a failed push ends the live and marks error', async () => {
    const live = prepared();
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare: async () => live })] });
    await goLive(h, ['d1']);
    h.pushes.emit('d1', 'failed', { message: 'ffmpeg not found' });
    await flush();
    expect(h.phase('d1')).toBe('error');
    expect(h.destState('d1').message).toContain('ffmpeg not found');
    expect(live.end).toHaveBeenCalledTimes(1);
    expect(h.pushes.stops).toEqual(['d1']);
  });

  it('error messages never contain stream keys', async () => {
    const prepare = vi.fn(async (): Promise<PreparedLive> => {
      throw new Error('connect failed to rtmp://live.example.com/app/sk_live_123 (refused)');
    });
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })] });
    await goLive(h, []);
    const msg = h.destState('d1').message ?? '';
    expect(msg).toContain('rtmp://live.example.com');
    expect(msg).not.toContain('sk_live_123');
  });

  it('retryDestination restarts a failed destination', async () => {
    let calls = 0;
    const prepare = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new DriverError('Log in again', 'needs-login');
      return prepared();
    });
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })] });
    await goLive(h, []);
    expect(h.phase('d1')).toBe('error');
    await h.orch.retryDestination('d1');
    await flush();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(h.phase('d1')).toBe('connecting');
    expect(h.destState('d1').message).toBeNull();
  });

  it('retryDestination is a no-op while offline', async () => {
    const prepare = vi.fn(async () => prepared());
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })] });
    await h.orch.init();
    await h.orch.retryDestination('d1');
    await flush();
    expect(prepare).not.toHaveBeenCalled();
    expect(h.phase('d1')).toBe('idle');
  });
});

describe('feed loss and grace period', () => {
  it('brief feed loss restarts the push with the same plan, without a new prepare', async () => {
    const confirm = vi.fn(async () => {});
    const live = prepared({ confirm });
    const prepare = vi.fn(async () => live);
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })], graceSec: 15 });
    await goLive(h, ['d1']);
    expect(h.phase('d1')).toBe('live');

    h.media.set('landscape', false);
    await flush();
    expect(h.pushes.stops).toEqual(['d1']);
    expect(h.phase('d1')).toBe('waiting-for-feed');

    await advance(10_000);
    h.media.set('landscape', true);
    await flush();
    expect(h.pushes.starts).toHaveLength(2);
    expect(h.pushes.starts[1]?.plan).toBe(PLAN);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(h.phase('d1')).toBe('connecting');

    h.pushes.running('d1');
    await flush();
    expect(h.phase('d1')).toBe('live');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(live.end).not.toHaveBeenCalled();

    await advance(30_000);
    expect(h.orch.state().status).toBe('live');
    expect(h.phase('d1')).toBe('live');
  });

  it('all feeds offline past the grace period stops the session and ends every live', async () => {
    const a = prepared();
    const b = prepared();
    const h = harness({
      dests: [dest('d1'), dest('v1', { platform: 'instagram', feed: 'vertical' })],
      drivers: [driver('custom', { prepare: async () => a }), driver('instagram', { prepare: async () => b })],
      graceSec: 15,
    });
    await h.orch.init();
    h.media.set('landscape', true);
    h.media.set('vertical', true);
    await flush();
    h.pushes.running('d1');
    h.pushes.running('v1');
    await flush();
    expect(h.phase('d1')).toBe('live');
    expect(h.phase('v1')).toBe('live');

    h.media.set('landscape', false);
    h.media.set('vertical', false);
    await flush();
    await advance(14_000);
    expect(h.orch.state().status).toBe('live');
    await advance(1_000);
    await flush();
    const s = h.orch.state();
    expect(s.status).toBe('offline');
    expect(s.sessionId).toBeNull();
    expect(a.end).toHaveBeenCalledTimes(1);
    expect(b.end).toHaveBeenCalledTimes(1);
    expect(h.phase('d1')).toBe('idle');
    expect(h.phase('v1')).toBe('idle');
    expect(h.notices.some((n) => n.message.includes('no feed from OBS'))).toBe(true);
  });

  it('one feed lost past grace ends only that destination; it re-prepares when the feed returns', async () => {
    const lives = [prepared(), prepared()];
    let i = 0;
    const prepare = vi.fn(async () => lives[i++]!);
    const other = prepared();
    const h = harness({
      dests: [dest('v1', { platform: 'instagram', feed: 'vertical' }), dest('d2', { platform: 'kick' })],
      drivers: [driver('instagram', { prepare }), driver('kick', { prepare: async () => other })],
      graceSec: 15,
    });
    await h.orch.init();
    h.media.set('landscape', true);
    h.media.set('vertical', true);
    await flush();
    h.pushes.running('v1');
    h.pushes.running('d2');
    await flush();

    h.media.set('vertical', false);
    await flush();
    await advance(15_000);
    expect(lives[0]!.end).toHaveBeenCalledTimes(1);
    expect(h.phase('v1')).toBe('waiting-for-feed');
    expect(h.destState('v1').watchUrl).toBeNull();
    expect(h.orch.state().status).toBe('live');
    expect(h.phase('d2')).toBe('live');
    expect(other.end).not.toHaveBeenCalled();

    h.media.set('vertical', true);
    await flush();
    expect(prepare).toHaveBeenCalledTimes(2);
    h.pushes.running('v1');
    await flush();
    expect(h.phase('v1')).toBe('live');
  });

  it('OBS coming back while the session is stopping starts a new session once teardown ends', async () => {
    let finishEnd!: () => void;
    const first = prepared({ end: vi.fn(() => new Promise<void>((r) => (finishEnd = r))) });
    const second = prepared();
    const lives = [first, second];
    let i = 0;
    const prepare = vi.fn(async () => lives[i++]!);
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })], graceSec: 15 });
    await goLive(h, ['d1']);
    const firstSession = h.orch.state().sessionId;

    h.media.set('landscape', false);
    await advance(15_000);
    expect(h.orch.state().status).toBe('stopping');
    expect(first.end).toHaveBeenCalledTimes(1);

    h.media.set('landscape', true); // OBS restarts during the slow end()
    await flush();
    expect(h.orch.state().status).toBe('stopping');

    finishEnd();
    await flush();
    const s = h.orch.state();
    expect(s.status).toBe('live');
    expect(s.sessionId).not.toBeNull();
    expect(s.sessionId).not.toBe(firstSession);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('a manual stop while OBS keeps streaming stays stopped', async () => {
    let finishEnd!: () => void;
    const live = prepared({ end: vi.fn(() => new Promise<void>((r) => (finishEnd = r))) });
    const prepare = vi.fn(async () => live);
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })] });
    await goLive(h, ['d1']);
    const stopped = h.orch.stop();
    await flush();
    expect(h.orch.state().status).toBe('stopping');
    h.media.set('landscape', true, 6000); // stats-only update: no transition
    await flush();
    finishEnd();
    await stopped;
    await advance(60_000);
    expect(h.orch.state().status).toBe('offline');
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('the grace stop is skipped when the feed returns while it waits for the session lock', async () => {
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare: async () => prepared() })], graceSec: 15 });
    await goLive(h, ['d1']);

    h.media.set('landscape', false);
    await advance(14_900);

    // Hold the session lock: destinationChanged waits on a slow stream-key read.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const repos = h.services.repos as unknown as { secrets: { scoped: (s: string) => { get: () => Promise<string | null> } } };
    const original = repos.secrets.scoped;
    repos.secrets.scoped = (scope) => ({ ...original(scope), get: async () => (await gate, null) });
    const changed = h.orch.destinationChanged('d1');
    await flush();

    await advance(200); // grace fires; the stop queues behind the lock
    h.media.set('landscape', true);
    await flush();
    release();
    await changed;
    await flush();

    expect(h.orch.state().status).toBe('live');
    expect(h.notices.some((n) => n.message.includes('no feed from OBS'))).toBe(false);
    repos.secrets.scoped = original;
  });

  it('feed returning to a session in grace cancels the stop', async () => {
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare: async () => prepared() })] });
    await goLive(h, ['d1']);
    h.media.set('landscape', false);
    await advance(10_000);
    h.media.set('landscape', true);
    await advance(60_000);
    expect(h.orch.state().status).toBe('live');
  });
});

describe('title', () => {
  it('offline: uses setTitleOffline where supported, skips the rest', async () => {
    const kickTitle = vi.fn(async (_d: Destination, _a: Account | null, _title: string) => {});
    const twitchTitle = vi.fn(async () => {});
    const h = harness({
      dests: [
        dest('k1', { platform: 'kick' }),
        dest('x1', { platform: 'x' }),
        dest('y1', { platform: 'youtube' }),
        dest('t1', { platform: 'twitch', enabled: false }),
      ],
      drivers: [
        driver('kick', { prepare: async () => prepared(), setTitleOffline: kickTitle }),
        driver('x', { prepare: async () => prepared() }),
        driver('youtube', {
          prepare: async () => prepared(),
          setTitleOffline: async () => {
            throw new DriverError('Quota exceeded');
          },
        }),
        driver('twitch', { prepare: async () => prepared(), setTitleOffline: twitchTitle }),
      ],
    });
    await h.orch.init();
    const results = await h.orch.setTitle('  New title  ');
    expect(results).toEqual([
      { destinationId: 'k1', ok: true },
      { destinationId: 'x1', ok: true, skipped: true, error: expect.any(String) },
      { destinationId: 'y1', ok: false, error: 'Quota exceeded' },
      { destinationId: 't1', ok: true, skipped: true, error: expect.any(String) },
    ]);
    expect(kickTitle).toHaveBeenCalledTimes(1);
    expect(kickTitle.mock.calls[0]?.[2]).toBe('New title');
    expect(twitchTitle).not.toHaveBeenCalled();
    expect(h.settings.get('session.title')).toBe('New title');
    expect(h.orch.state().title).toBe('New title');
    expect(h.sessionEvents.at(-1)?.title).toBe('New title');
  });

  it('rejects titles longer than 140 characters', async () => {
    const h = harness({ dests: [], drivers: [] });
    await h.orch.init();
    await expect(h.orch.setTitle('x'.repeat(141))).rejects.toMatchObject({ statusCode: 400 });
    await expect(h.orch.setTitle('😀'.repeat(140))).resolves.toEqual([]);
  });

  it('live: uses prepared.setTitle, skips destinations without it or not prepared yet', async () => {
    const setTitle = vi.fn(async () => {});
    const offline = vi.fn(async () => {});
    const h = harness({
      dests: [
        dest('k1', { platform: 'kick' }),
        dest('f1', { platform: 'facebook' }),
        dest('i1', { platform: 'instagram', feed: 'vertical' }),
      ],
      drivers: [
        driver('kick', { prepare: async () => prepared({ setTitle }), setTitleOffline: offline }),
        driver('facebook', { prepare: async () => prepared() }),
        driver('instagram', { prepare: async () => prepared({ setTitle }) }),
      ],
    });
    await goLive(h, ['k1', 'f1']);
    const results = await h.orch.setTitle('Live title');
    expect(results).toEqual([
      { destinationId: 'k1', ok: true },
      { destinationId: 'f1', ok: true, skipped: true, error: expect.any(String) },
      { destinationId: 'i1', ok: true, skipped: true, error: expect.any(String) },
    ]);
    expect(setTitle).toHaveBeenCalledWith('Live title', expect.any(AbortSignal));
    expect(offline).not.toHaveBeenCalled();
  });

  it('live: reports setTitle failures', async () => {
    const h = harness({
      dests: [dest('k1', { platform: 'kick' })],
      drivers: [
        driver('kick', {
          prepare: async () =>
            prepared({
              setTitle: async () => {
                throw new Error('403 Forbidden');
              },
            }),
        }),
      ],
    });
    await goLive(h, ['k1']);
    expect(await h.orch.setTitle('T')).toEqual([{ destinationId: 'k1', ok: false, error: '403 Forbidden' }]);
  });

  it('applies a title changed while preparing once the live is prepared', async () => {
    const setTitle = vi.fn(async () => {});
    let finish!: (p: PreparedLive) => void;
    const prepare = vi.fn(() => new Promise<PreparedLive>((r) => (finish = r)));
    const h = harness({
      dests: [dest('k1', { platform: 'kick' })],
      drivers: [driver('kick', { prepare })],
      settings: { 'session.title': 'Old' },
    });
    await goLive(h, []);
    expect(h.phase('k1')).toBe('preparing');
    expect(await h.orch.setTitle('New')).toEqual([{ destinationId: 'k1', ok: true, skipped: true, error: expect.any(String) }]);
    finish(prepared({ setTitle }));
    await flush();
    expect(setTitle).toHaveBeenCalledWith('New', expect.any(AbortSignal));
  });
});

describe('destination changes mid-session', () => {
  function twoDestinations() {
    const k = prepared();
    const x = prepared();
    const kPrepare = vi.fn(async () => k);
    const h = harness({
      dests: [dest('k1', { platform: 'kick' }), dest('x1', { platform: 'x' })],
      drivers: [driver('kick', { prepare: kPrepare }), driver('x', { prepare: async () => x })],
    });
    return { h, k, x, kPrepare };
  }

  it('disabling ends only that destination; enabling starts it again', async () => {
    const { h, k, x, kPrepare } = twoDestinations();
    await goLive(h, ['k1', 'x1']);

    h.dests.set('k1', { ...h.dests.get('k1')!, enabled: false });
    await h.orch.destinationChanged('k1');
    expect(k.end).toHaveBeenCalledTimes(1);
    expect(h.pushes.stops).toEqual(['k1']);
    expect(h.phase('k1')).toBe('disabled');
    expect(h.history('k1')).toContain('ending');
    expect(x.end).not.toHaveBeenCalled();
    expect(h.phase('x1')).toBe('live');

    h.dests.set('k1', { ...h.dests.get('k1')!, enabled: true });
    await h.orch.destinationChanged('k1');
    await flush();
    expect(kPrepare).toHaveBeenCalledTimes(2);
    expect(h.phase('k1')).toBe('connecting');
    h.pushes.running('k1');
    await flush();
    expect(h.phase('k1')).toBe('live');
  });

  it('restarts a destination when its config or stream key changes, not on rename', async () => {
    const { h, k, kPrepare } = twoDestinations();
    h.secrets.set('destination:k1/streamKey', 'key-1');
    await goLive(h, ['k1', 'x1']);

    h.dests.set('k1', { ...h.dests.get('k1')!, name: 'Renamed' });
    await h.orch.destinationChanged('k1');
    await flush();
    expect(kPrepare).toHaveBeenCalledTimes(1);
    expect(k.end).not.toHaveBeenCalled();

    h.secrets.set('destination:k1/streamKey', 'key-2');
    await h.orch.destinationChanged('k1');
    await flush();
    expect(k.end).toHaveBeenCalledTimes(1);
    expect(kPrepare).toHaveBeenCalledTimes(2);
    expect(h.pushes.starts.filter((s) => s.id === 'k1')).toHaveLength(2);

    h.dests.set('k1', { ...h.dests.get('k1')!, ingestUrl: 'rtmps://other.example.com/app' });
    await h.orch.destinationChanged('k1');
    await flush();
    expect(kPrepare).toHaveBeenCalledTimes(3);
  });

  it('compares effective options: a save that backfills defaults or normalizes values does not restart it', async () => {
    // A TikTok destination saved before autoRecover / zeroViewerSec existed, with a text-typed number.
    const fields: FieldSpec[] = [
      { key: 'goLiveTimeoutSec', label: 'Go-live timeout', type: 'number', target: 'option', default: 90 },
      { key: 'autoRecover', label: 'Auto-recover', type: 'boolean', target: 'option', default: true },
      { key: 'zeroViewerSec', label: 'Zero viewers', type: 'number', target: 'option', default: 0 },
      { key: 'note', label: 'Note', type: 'text', target: 'option' },
      { key: 'streamKey', label: 'Stream key', type: 'secret', target: 'streamKey' },
    ];
    const live = prepared();
    const prepare = vi.fn(async () => live);
    const h = harness({
      dests: [dest('t1', { platform: 'tiktok', options: { goLiveTimeoutSec: '45', note: '' } })],
      drivers: [driver('tiktok', { prepare }, { destinationFields: fields })],
    });
    await goLive(h, ['t1']);
    const save = async (patch: Partial<Destination>, input: Record<string, unknown> = {}) => {
      const current = h.dests.get('t1')!;
      h.dests.set('t1', { ...current, ...patch, options: normalizeFields(fields.filter((f) => f.target === 'option'), input, current.options) });
      await h.orch.destinationChanged('t1');
      await flush();
    };

    await save({ name: 'Renamed' });
    expect(h.dests.get('t1')!.options).toEqual({ goLiveTimeoutSec: 45, autoRecover: true, zeroViewerSec: 0 });
    await save({}, { autoRecover: 'true', note: '  ' });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(live.end).not.toHaveBeenCalled();
    expect(h.phase('t1')).toBe('live');

    await save({}, { note: 'hello' });
    expect(live.end).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('a destination added mid-session starts right away', async () => {
    const { h, kPrepare } = twoDestinations();
    await goLive(h, ['k1', 'x1']);
    h.dests.set('c1', dest('c1', { platform: 'kick' }));
    await h.orch.destinationChanged('c1');
    await flush();
    expect(h.orch.state().destinations.map((d) => d.destinationId)).toEqual(['k1', 'x1', 'c1']);
    expect(h.sessionEvents.at(-1)?.destinations.some((d) => d.destinationId === 'c1')).toBe(true);
    expect(kPrepare).toHaveBeenCalledTimes(2);
    expect(h.phase('c1')).toBe('connecting');
  });

  it('destinationRemoved ends it and drops it from the state', async () => {
    const { h, k } = twoDestinations();
    await goLive(h, ['k1', 'x1']);
    await h.orch.destinationRemoved('k1');
    expect(k.end).toHaveBeenCalledTimes(1);
    // Still in the repo for a moment (the route deletes it after this call): must not reappear.
    expect(h.orch.state().destinations.map((d) => d.destinationId)).toEqual(['x1']);
    expect(h.sessionEvents.at(-1)?.destinations.map((d) => d.destinationId)).toEqual(['x1']);
    h.dests.delete('k1');
    expect(h.orch.state().destinations.map((d) => d.destinationId)).toEqual(['x1']);
  });

  it('offline changes just refresh the resting phase', async () => {
    const { h, kPrepare } = twoDestinations();
    await h.orch.init();
    h.dests.set('k1', { ...h.dests.get('k1')!, enabled: false });
    await h.orch.destinationChanged('k1');
    expect(h.phase('k1')).toBe('disabled');
    expect(kPrepare).not.toHaveBeenCalled();
  });
});

describe('start/stop safety', () => {
  it('double start and double stop are safe', async () => {
    const live = prepared();
    const prepare = vi.fn(async () => live);
    const h = harness({
      dests: [dest('d1')],
      drivers: [driver('custom', { prepare })],
      settings: { 'session.autoGoLive': false },
    });
    await h.orch.init();
    h.media.set('landscape', true);
    await Promise.all([h.orch.start('manual'), h.orch.start('manual')]);
    await flush();
    const sessionId = h.orch.state().sessionId;
    expect(sessionId).toBeTruthy();
    expect(prepare).toHaveBeenCalledTimes(1);
    h.pushes.running('d1');
    await flush();

    await Promise.all([h.orch.stop(), h.orch.stop()]);
    expect(live.end).toHaveBeenCalledTimes(1);
    expect(h.notices.filter((n) => n.message === 'Session stopped')).toHaveLength(1);
    const s = h.orch.state();
    expect(s.status).toBe('offline');
    expect(s.startedAt).toBeNull();
    expect(h.phase('d1')).toBe('idle');
    expect(h.destState('d1').stats).toBeNull();
    expect(h.sessionEvents.map((e) => e.status)).toEqual(
      expect.arrayContaining(['starting', 'live', 'stopping', 'offline']),
    );
  });

  it('stop while preparing aborts the driver and ends a late result', async () => {
    const live = prepared();
    let finish!: (p: PreparedLive) => void;
    const prepare = vi.fn(() => new Promise<PreparedLive>((r) => (finish = r)));
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })] });
    await goLive(h, []);
    expect(h.phase('d1')).toBe('preparing');
    await h.orch.stop();
    expect(h.contexts[0]?.signal.aborted).toBe(true);
    expect(h.phase('d1')).toBe('idle');

    finish(live);
    await flush();
    expect(live.end).toHaveBeenCalledTimes(1);
    expect(h.pushes.starts).toEqual([]);
    expect(h.phase('d1')).toBe('idle');
  });

  it('a stuck end() is bounded by its 30 s timeout', async () => {
    const live = prepared({ end: vi.fn(() => new Promise<void>(() => {})) });
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare: async () => live })] });
    await goLive(h, ['d1']);
    let stopped = false;
    void h.orch.stop().then(() => (stopped = true));
    await advance(29_000);
    expect(stopped).toBe(false);
    await advance(1_000);
    expect(stopped).toBe(true);
    expect(h.orch.state().status).toBe('offline');
  });

  it('shutdown bounds a stuck end() by the shorter 15 s shutdown budget', async () => {
    const live = prepared({ end: vi.fn(() => new Promise<void>(() => {})) });
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare: async () => live })] });
    await goLive(h, ['d1']);
    let done = false;
    void h.orch.shutdown().then(() => (done = true));
    await advance(14_000);
    expect(done).toBe(false);
    await advance(1_000);
    expect(done).toBe(true);
    expect(h.orch.state().status).toBe('offline');
  });

  it('can start again after a stop', async () => {
    const prepare = vi.fn(async () => prepared());
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })] });
    await goLive(h, ['d1']);
    const first = h.orch.state().sessionId;
    await h.orch.stop();
    await h.orch.start('manual');
    await flush();
    expect(h.orch.state().status).toBe('live');
    expect(h.orch.state().sessionId).not.toBe(first);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('setAutoGoLive(true) while a feed is online starts the session', async () => {
    const prepare = vi.fn(async () => prepared());
    const h = harness({
      dests: [dest('d1')],
      drivers: [driver('custom', { prepare })],
      settings: { 'session.autoGoLive': false },
    });
    await h.orch.init();
    h.media.set('landscape', true);
    await flush();
    expect(h.orch.state().status).toBe('offline');
    h.orch.setAutoGoLive(true);
    await flush();
    expect(h.settings.get('session.autoGoLive')).toBe(true);
    expect(h.orch.state().status).toBe('live');
    expect(h.orch.state().autoGoLive).toBe(true);
  });

  it('shutdown stops the session and ignores later feed events', async () => {
    const live = prepared();
    const prepare = vi.fn(async () => live);
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })] });
    await goLive(h, ['d1']);
    await h.orch.shutdown();
    expect(live.end).toHaveBeenCalledTimes(1);
    expect(h.orch.state().status).toBe('offline');
    h.media.set('landscape', false);
    h.media.set('landscape', true);
    await flush();
    expect(h.orch.state().status).toBe('offline');
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('unknown platforms error without affecting the others', async () => {
    const h = harness({
      dests: [dest('z1', { platform: 'tiktok' }), dest('d1')],
      drivers: [driver('custom', { prepare: async () => prepared() })],
    });
    await goLive(h, ['d1']);
    expect(h.phase('z1')).toBe('error');
    expect(h.phase('d1')).toBe('live');
  });
});
