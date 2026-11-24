// The push's transcoding state on the destination card (DestinationState.transcode), and that a
// copy destination's state keeps the shape it always had. docs/TRANSCODING.md §6, §7.2.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DestinationTranscodeStatus } from '../../../shared/types.js';
import { advance, dest, driver, flush, goLive, harness, prepared, STATS } from './test-helpers.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const status = (over: Partial<DestinationTranscodeStatus> = {}): DestinationTranscodeStatus => ({
  state: 'running',
  encoder: 'libx264',
  codec: 'h264',
  width: 1920,
  height: 1080,
  fps: null,
  bitrateKbps: 6000,
  speed: 1,
  message: null,
  ...over,
});

function rig() {
  return harness({ dests: [dest('d1'), dest('d2')], drivers: [driver('custom', { prepare: vi.fn(async () => prepared()) })] });
}

describe('destination transcoding state', () => {
  it("never appears on a copy destination's state", async () => {
    const h = rig();
    await goLive(h, ['d1', 'd2']);
    h.pushes.emit('d1', 'retrying', { message: 'Connection reset', attempt: 1 });
    await flush();
    h.pushes.running('d1');
    await flush();
    expect(h.phase('d1')).toBe('live');
    expect('transcode' in h.destState('d1')).toBe(false);
    expect('transcode' in h.destState('d2')).toBe(false);
  });

  it('follows the push: running, behind with its warning, fallback to copy', async () => {
    const h = rig();
    await h.orch.init();
    h.media.set('landscape', true);
    await flush();
    h.pushes.emit('d1', 'running', { stats: STATS, transcode: status({ speed: null }) });
    h.pushes.running('d2');
    await flush();
    expect(h.destState('d1')).toMatchObject({ phase: 'live', message: null, transcode: { state: 'running', encoder: 'libx264' } });

    const behind = 'Transcoding is running at 0.82× real time, so viewers will see stutters.';
    h.pushes.emit('d1', 'running', { stats: STATS, message: behind, transcode: status({ state: 'behind', speed: 0.82, message: behind }) });
    await flush();
    expect(h.destState('d1')).toMatchObject({ phase: 'live', message: behind, transcode: { state: 'behind', speed: 0.82 } });

    const fell = 'Transcoding stopped (this server encoded at 0.82× real time). This destination now gets the feed as OBS sends it.';
    h.pushes.emit('d1', 'running', { stats: STATS, message: fell, transcode: status({ state: 'fallback-copy', encoder: null, speed: null, message: fell }) });
    await flush();
    expect(h.destState('d1')).toMatchObject({ phase: 'live', message: fell, transcode: { state: 'fallback-copy', encoder: null } });
    // The other destination is untouched by all of it.
    expect(h.destState('d2')).toMatchObject({ phase: 'live', message: null });
    expect('transcode' in h.destState('d2')).toBe(false);
  });

  it('keeps the state while the push retries and clears it when the push is a plain copy again', async () => {
    const h = rig();
    await goLive(h, ['d2']);
    h.pushes.emit('d1', 'running', { stats: STATS, transcode: status() });
    await flush();
    h.pushes.emit('d1', 'retrying', { message: 'Connection reset', attempt: 1, transcode: status({ state: 'starting', speed: null }) });
    await flush();
    expect(h.destState('d1')).toMatchObject({ phase: 'retrying', stats: null, transcode: { state: 'starting' } });

    // The switch was turned off meanwhile: the relaunched push copies and says nothing about transcoding.
    h.pushes.emit('d1', 'retrying', { message: 'Connection reset', attempt: 2 });
    await flush();
    expect(h.destState('d1').transcode).toBeNull();
    h.pushes.running('d1');
    await flush();
    expect(h.destState('d1')).toMatchObject({ phase: 'live', transcode: null });
  });

  it('clears the state when the destination stops pushing (failed, feed gone, session over)', async () => {
    const h = rig();
    await goLive(h, ['d2']);
    h.pushes.emit('d1', 'running', { stats: STATS, transcode: status() });
    await flush();
    h.pushes.emit('d1', 'failed', { message: 'Transcoding stopped: this server encoded at 0.80× real time.', transcode: status({ state: 'behind' }) });
    await flush();
    expect(h.destState('d1')).toMatchObject({ phase: 'error', message: 'Relay failed: Transcoding stopped: this server encoded at 0.80× real time.', stats: null, transcode: null });

    h.pushes.emit('d2', 'running', { stats: STATS, transcode: status() });
    await flush();
    expect(h.destState('d2').transcode).toMatchObject({ state: 'running' });
    h.media.set('landscape', false);
    await flush();
    expect(h.destState('d2')).toMatchObject({ phase: 'waiting-for-feed', stats: null, transcode: null });
    await advance(60_000);
    expect(h.orch.state().status).toBe('offline');
    expect(h.destState('d2').transcode).toBeNull();
  });
});
