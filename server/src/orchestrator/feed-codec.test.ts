// Feed codec guard: a feed that is online but can't be sent (HEVC, AV1; no AAC audio for Twitch
// Dual Format) holds its destinations back with a clear message instead of an FFmpeg retry loop.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { feedWith } from '../media/test-helpers.js';
import type { PushPlan } from '../platforms/types.js';
import { advance, dest, driver, flush, harness, PLAN, prepared } from './test-helpers.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const track = (feed: 'landscape' | 'vertical') => ({
  feed,
  width: 1920,
  height: 1080,
  fps: { numerator: 60, denominator: 1 },
  bitrateKbps: 6000,
  keyintSec: 2,
  profile: 'high' as const,
  bframes: 2,
});
const IVS_PLAN: PushPlan = {
  url: 'rtmps://ingest.example.com/app/secret-key',
  mode: 'ivs',
  feeds: ['landscape', 'vertical'],
  ivs: { tracks: [track('landscape'), track('vertical')], audioBitrateKbps: 160, audioChannels: 2, preset: 'veryfast' },
};

describe('feed codec guard', () => {
  it('an HEVC feed blocks its destinations: no live is prepared, no push is started, one clear message', async () => {
    const prepare = vi.fn(async () => prepared());
    const h = harness({
      dests: [dest('yt', { platform: 'youtube' }), dest('kick', { platform: 'kick' })],
      drivers: [driver('youtube', { prepare }, { name: 'YouTube' }), driver('kick', { prepare }, { name: 'Kick' })],
    });
    await h.orch.init();
    h.media.put(feedWith('landscape', 'hevcAac'));
    await flush();

    // The session runs (so everything starts by itself later), but nothing is sent anywhere.
    expect(h.orch.state().status).toBe('live');
    expect(prepare).not.toHaveBeenCalled();
    expect(h.pushes.starts).toEqual([]);
    expect(h.destState('yt')).toMatchObject({
      phase: 'waiting-for-feed',
      waitingFor: ['landscape'],
      blocked: { reason: 'feed-video-codec', feed: 'landscape', codec: 'hevc' },
      message:
        'Landscape feed is HEVC. YouTube gets the stream unchanged and needs H.264. In CTD OBS: Relay dock → Send stream (switches to H.264), ' +
        'or Settings → Output → Video encoder: H.264. It starts by itself once the feed is H.264.',
    });
    expect(h.destState('kick').message).toContain('Kick gets the stream unchanged and needs H.264.');
    expect(h.history('yt')).toEqual(['waiting-for-feed']);

    // However long OBS keeps sending HEVC: still no prepare, no push, no retries.
    await advance(10 * 60_000);
    expect(prepare).not.toHaveBeenCalled();
    expect(h.pushes.starts).toEqual([]);
    expect(h.destState('yt')).toMatchObject({ phase: 'waiting-for-feed', retries: 0 });

    // One notice for the feed, not one per destination.
    const codec = h.notices.filter((n) => n.kind === 'feed.codec');
    expect(codec).toHaveLength(1);
    expect(codec[0]).toMatchObject({ level: 'warn', profileId: 'default', subject: { type: 'feed', feed: 'landscape' }, codec: 'hevc' });
    expect(codec[0]?.message).toMatch(/^Landscape feed is HEVC\. Twitch, YouTube, Kick and the other platforms get the stream unchanged and need H\.264\./);
  });

  it('starts by itself when OBS switches the feed to H.264', async () => {
    const prepare = vi.fn(async () => prepared());
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })] });
    await h.orch.init();
    h.media.put(feedWith('landscape', 'hevcAac'));
    await flush();
    expect(h.destState('d1').blocked).toMatchObject({ codec: 'hevc' });

    // OBS reconnects with H.264 (a new connection: offline, then online with other tracks).
    h.media.set('landscape', false);
    await flush();
    expect(h.destState('d1')).toMatchObject({ phase: 'waiting-for-feed', blocked: null, message: 'Waiting for landscape feed' });
    h.media.put(feedWith('landscape', 'h264Aac', { since: '2026-11-19T01:05:00.000Z' }));
    await flush();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(h.pushes.starts).toEqual([{ id: 'd1', plan: PLAN }]);
    expect(h.destState('d1')).toMatchObject({ phase: 'connecting', blocked: null, waitingFor: [], message: null });

    h.pushes.running('d1');
    await flush();
    expect(h.phase('d1')).toBe('live');
    expect(h.notices.filter((n) => n.kind === 'feed.codec').map((n) => [n.level, n.codec, n.message])).toEqual([
      ['warn', 'hevc', expect.stringContaining('Landscape feed is HEVC.')],
      ['info', 'h264', 'Landscape feed is H.264 + AAC now: its destinations start by themselves.'],
    ]);
  });

  it("starts when the same connection's tracks change to H.264 (no offline in between)", async () => {
    const prepare = vi.fn(async () => prepared());
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })] });
    await h.orch.init();
    h.media.put(feedWith('landscape', 'av1Aac'));
    await flush();
    expect(h.destState('d1').blocked).toEqual({ reason: 'feed-video-codec', feed: 'landscape', codec: 'av1' });
    expect(h.destState('d1').message).toMatch(/^Landscape feed is AV1\./);

    h.media.put(feedWith('landscape', 'h264Aac'));
    await flush();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(h.phase('d1')).toBe('connecting');
  });

  it('only the destinations of the HEVC feed are held back', async () => {
    const prepare = vi.fn(async () => prepared());
    const h = harness({
      dests: [dest('land'), dest('ig', { platform: 'instagram', feed: 'vertical' })],
      drivers: [driver('custom', { prepare }), driver('instagram', { prepare: async () => prepared({ push: { ...PLAN, feeds: ['vertical'] } }) }, { name: 'Instagram' })],
    });
    await h.orch.init();
    h.media.put(feedWith('landscape', 'h264Aac'));
    h.media.put(feedWith('vertical', 'hevcAac'));
    await flush();
    expect(h.phase('land')).toBe('connecting');
    expect(h.destState('land').blocked ?? null).toBeNull();
    expect(h.destState('ig')).toMatchObject({ phase: 'waiting-for-feed', waitingFor: ['vertical'], blocked: { feed: 'vertical', codec: 'hevc' } });
    expect(h.destState('ig').message).toMatch(/^Vertical feed is HEVC\. Instagram gets the stream unchanged and needs H\.264\./);
    expect(h.pushes.starts.map((s) => s.id)).toEqual(['land']);
  });

  it('a codec that is not known yet never blocks; once known as HEVC the push stops', async () => {
    const live = prepared();
    const prepare = vi.fn(async () => live);
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })], graceSec: 15 });
    await h.orch.init();
    h.media.put(feedWith('landscape', null)); // online, tracks not reported yet
    await flush();
    expect(h.phase('d1')).toBe('connecting');
    expect(h.pushes.starts).toHaveLength(1);

    h.media.put(feedWith('landscape', 'hevcAac'));
    await flush();
    expect(h.pushes.stops).toEqual(['d1']);
    expect(h.destState('d1')).toMatchObject({ phase: 'waiting-for-feed', blocked: { codec: 'hevc' }, stats: null });
    // FFmpeg's "retrying" from the push that was just stopped can't put it back into a retry loop.
    h.pushes.emit('d1', 'retrying', { message: 'Error opening output files: Invalid argument', attempt: 1 });
    await flush();
    expect(h.phase('d1')).toBe('waiting-for-feed');
    expect(h.pushes.starts).toHaveLength(1);
  });

  it('live on H.264, then OBS switches to HEVC: paused like a lost feed, the live ends after the grace period, and it comes back with H.264', async () => {
    const first = prepared();
    const second = prepared();
    const prepare = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })], graceSec: 15 });
    await h.orch.init();
    h.media.put(feedWith('landscape', 'h264Aac'));
    await flush();
    h.pushes.running('d1');
    await flush();
    expect(h.phase('d1')).toBe('live');

    h.media.put(feedWith('landscape', 'hevcAac', { since: '2026-11-19T02:00:00.000Z' }));
    await flush();
    expect(h.pushes.stops).toEqual(['d1']);
    expect(h.destState('d1')).toMatchObject({ phase: 'waiting-for-feed', blocked: { codec: 'hevc' } });
    expect(first.end).not.toHaveBeenCalled();

    await advance(15_000);
    expect(first.end).toHaveBeenCalledTimes(1);
    expect(h.destState('d1')).toMatchObject({ phase: 'waiting-for-feed', blocked: { codec: 'hevc' }, watchUrl: null });
    expect(h.destState('d1').message).toMatch(/^Landscape feed is HEVC\./);
    // The session itself stays up: OBS is still connected.
    expect(h.orch.state().status).toBe('live');
    expect(prepare).toHaveBeenCalledTimes(1);

    h.media.put(feedWith('landscape', 'h264Aac', { since: '2026-11-19T02:05:00.000Z' }));
    await flush();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(h.pushes.starts).toHaveLength(2);
    h.pushes.running('d1');
    await flush();
    expect(h.destState('d1')).toMatchObject({ phase: 'live', blocked: null });
  });

  it('a switch back to H.264 within the grace period keeps the same live', async () => {
    const live = prepared();
    const prepare = vi.fn(async () => live);
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })], graceSec: 15 });
    await h.orch.init();
    h.media.put(feedWith('landscape', 'h264Aac'));
    await flush();
    h.pushes.running('d1');
    await flush();
    h.media.put(feedWith('landscape', 'hevcAac'));
    await flush();
    await advance(5_000);
    h.media.put(feedWith('landscape', 'h264Aac'));
    await flush();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(live.end).not.toHaveBeenCalled();
    expect(h.pushes.starts).toHaveLength(2);
    expect(h.phase('d1')).toBe('connecting');
  });

  it('Opus audio does not block a copy destination, but the operator is told there is no sound', async () => {
    const prepare = vi.fn(async () => prepared());
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare })] });
    await h.orch.init();
    h.media.put(feedWith('landscape', 'h264Opus'));
    await flush();
    expect(h.phase('d1')).toBe('connecting');
    expect(h.destState('d1').blocked ?? null).toBeNull();
    const codec = h.notices.filter((n) => n.kind === 'feed.codec');
    expect(codec).toHaveLength(1);
    expect(codec[0]).toMatchObject({ level: 'warn', codec: 'opus', subject: { type: 'feed', feed: 'landscape' } });
    expect(codec[0]?.message).toContain('Landscape feed audio is Opus. Platforms need AAC audio, so they get this feed without sound.');
    // A feed without any audio track goes out as it is (and nobody is told "all fine").
    h.media.put(feedWith('landscape', 'h264Only'));
    await flush();
    expect(h.destState('d1').blocked ?? null).toBeNull();
    expect(h.notices.filter((n) => n.kind === 'feed.codec')).toHaveLength(1);
    expect(h.pushes.stops).toEqual([]);
  });

  it('says so when the audio is AAC again', async () => {
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare: async () => prepared() })] });
    await h.orch.init();
    h.media.put(feedWith('landscape', 'h264Opus'));
    await flush();
    h.media.put(feedWith('landscape', 'h264Aac'));
    await flush();
    expect(h.notices.filter((n) => n.kind === 'feed.codec').map((n) => [n.level, n.codec, n.message])).toEqual([
      ['warn', 'opus', expect.stringContaining('without sound')],
      ['info', 'aac', 'Landscape feed audio is AAC now: platforms get its sound again.'],
    ]);
  });

  describe('Twitch Dual Format through Relay', () => {
    const twitch = () => dest('tw', { platform: 'twitch', options: { dualFormat: 'relay-multitrack' } });
    const dual = (prepare: () => Promise<ReturnType<typeof prepared>>) =>
      driver('twitch', { prepare, requiredFeeds: () => ['landscape', 'vertical'] }, { name: 'Twitch' });

    it('an HEVC feed blocks it (Relay encodes it, but still has to read H.264)', async () => {
      const prepare = vi.fn(async () => prepared({ push: IVS_PLAN }));
      const h = harness({ dests: [twitch()], drivers: [dual(prepare)] });
      await h.orch.init();
      h.media.put(feedWith('landscape', 'h264Aac'));
      h.media.put(feedWith('vertical', 'hevcAac'));
      await flush();
      expect(prepare).not.toHaveBeenCalled();
      expect(h.pushes.starts).toEqual([]);
      expect(h.destState('tw')).toMatchObject({ phase: 'waiting-for-feed', waitingFor: ['vertical'], blocked: { feed: 'vertical', codec: 'hevc' } });
      expect(h.destState('tw').message).toMatch(/^Vertical feed is HEVC\. Twitch Dual Format needs H\.264 feeds\./);

      h.media.put(feedWith('vertical', 'h264Aac'));
      await flush();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(h.pushes.starts).toEqual([{ id: 'tw', plan: IVS_PLAN }]);
    });

    it('needs AAC audio on the landscape feed', async () => {
      const prepare = vi.fn(async () => prepared({ push: IVS_PLAN }));
      const h = harness({ dests: [twitch()], drivers: [dual(prepare)] });
      await h.orch.init();
      h.media.put(feedWith('landscape', 'h264Only'));
      h.media.put(feedWith('vertical', 'h264Aac'));
      await flush();
      expect(prepare).not.toHaveBeenCalled();
      expect(h.destState('tw')).toMatchObject({ phase: 'waiting-for-feed', blocked: { reason: 'feed-audio-missing', feed: 'landscape', codec: null } });
      expect(h.destState('tw').message).toMatch(/^Landscape feed has no audio\. Twitch Dual Format needs AAC audio on it\./);

      h.media.put(feedWith('landscape', 'h264Aac'));
      await flush();
      expect(h.phase('tw')).toBe('connecting');
    });

    it('a plan that turns out to encode (no dualFormat option to tell beforehand) is held back before its push starts, and stays held back', async () => {
      const live = prepared({ push: IVS_PLAN });
      const prepare = vi.fn(async () => live);
      const h = harness({
        dests: [dest('tw', { platform: 'twitch' })],
        drivers: [dual(prepare)],
        graceSec: 15,
      });
      await h.orch.init();
      h.media.put(feedWith('landscape', 'h264Opus'));
      h.media.put(feedWith('vertical', 'h264Aac'));
      await flush();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(h.pushes.starts).toEqual([]);
      expect(h.destState('tw')).toMatchObject({ phase: 'waiting-for-feed', blocked: { reason: 'feed-audio-codec', feed: 'landscape', codec: 'opus' } });

      // After the grace period the live is dropped, and it is not prepared again while nothing changed.
      await advance(15_000);
      expect(live.end).toHaveBeenCalledTimes(1);
      expect(h.destState('tw')).toMatchObject({ phase: 'waiting-for-feed', blocked: { codec: 'opus' } });
      h.media.put(feedWith('vertical', 'h264Aac', { bitrateKbps: 4000 }));
      await flush();
      expect(prepare).toHaveBeenCalledTimes(1);
    });

    it('"OBS sends Dual Format itself" pushes nothing, so the feeds\' codecs do not matter', async () => {
      const prepare = vi.fn(async () => prepared({ push: null }));
      const h = harness({
        dests: [dest('tw', { platform: 'twitch', options: { dualFormat: 'obs-direct' } }), dest('d1')],
        drivers: [driver('twitch', { prepare, requiredFeeds: () => [] }), driver('custom', { prepare: async () => prepared() })],
      });
      await h.orch.init();
      h.media.put(feedWith('landscape', 'hevcAac'));
      await flush();
      expect(h.phase('tw')).toBe('live');
      expect(h.destState('d1').blocked).toMatchObject({ codec: 'hevc' });
    });
  });

  it('counts as down for the API and the profile summary, and is cleared when the session stops', async () => {
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare: async () => prepared() })] });
    await h.orch.init();
    h.media.put(feedWith('landscape', 'hevcAac'));
    await flush();
    expect(h.registry.summaries()[0]).toMatchObject({ id: 'default', destinations: 1, live: 0, down: 1 });
    const event = h.destEvents.findLast((e) => e.destinationId === 'd1');
    expect(event).toMatchObject({ phase: 'waiting-for-feed', blocked: { codec: 'hevc' } });

    await h.orch.stop();
    await flush();
    expect(h.destState('d1')).toMatchObject({ phase: 'idle', blocked: null, message: null });
  });

  it('announces a feed again on a new OBS connection that is still HEVC, not on every stats update', async () => {
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare: async () => prepared() })], graceSec: 60 });
    await h.orch.init();
    h.media.put(feedWith('landscape', 'hevcAac'));
    await flush();
    h.media.put(feedWith('landscape', 'hevcAac', { bitrateKbps: 5000 }));
    h.media.put(feedWith('landscape', 'hevcAac', { bitrateKbps: 5500 }));
    await flush();
    expect(h.notices.filter((n) => n.kind === 'feed.codec')).toHaveLength(1);

    h.media.set('landscape', false);
    await flush();
    h.media.put(feedWith('landscape', 'hevcAac', { since: '2026-11-19T01:10:00.000Z' }));
    await flush();
    expect(h.notices.filter((n) => n.kind === 'feed.codec')).toHaveLength(2);
    expect(h.destState('d1').blocked).toMatchObject({ codec: 'hevc' });
  });
});
