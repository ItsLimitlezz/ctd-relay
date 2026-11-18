// Transcoding inside the push supervisor (docs/TRANSCODING.md §5, §7.2): which pushes encode, what
// happens when the encode falls behind or the encoder fails, and that copy pushes are untouched.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscodeCapabilities, TranscodeEncoderResult, TranscodeSettings } from '../../../shared/api.js';
import type { Destination, FeedState, TranscodeProfile } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import { EventBus, type PushEvent } from '../events.js';
import type { PushPlan } from '../platforms/types.js';
import type { MediaServer } from '../services.js';
import { buildPushArgs } from './ffmpeg-args.js';
import {
  createPushSupervisor,
  isEncoderOpenFailure,
  TRANSCODE_FALLBACK_AFTER_MS,
  transcodeBehindMessage,
  transcodeFallbackMessage,
  type TranscodeRuntime,
} from './ffmpeg-supervisor.js';
import { captureLogger, fakeSpawn, flush, type FakeChild } from './test-helpers.js';
import { buildTranscodePushArgs, resolveTranscodeJob } from './transcode-args.js';
import { TranscodeCapabilityService, type RunFn } from './transcode-capabilities.js';
import { createTranscodeRuntime, readTranscodeSettings } from './transcode-settings.js';

const SECRET = 'sk_live_SECRET123456';
const READER_PASS = 'readerpass123456';
const config = { ffmpegBin: '/opt/tools/ffmpeg' } as AppConfig;
const INPUT = `rtmp://127.0.0.1:1935/live/landscape?user=internal&pass=${READER_PASS}`;
const plan: PushPlan = { url: `rtmp://live.example.com/app/${SECRET}`, mode: 'copy', feeds: ['landscape'] };

const enc = (encoder: string, codec: TranscodeEncoderResult['codec'], backend: TranscodeEncoderResult['backend'], ok = true, speed: number | null = 3): TranscodeEncoderResult => ({
  encoder,
  codec,
  backend,
  ok,
  speed: ok ? speed : null,
  device: null,
  error: ok ? null : 'Cannot load libcuda.so.1',
});

function caps(encoders: TranscodeEncoderResult[], state: TranscodeCapabilities['state'] = 'ready'): TranscodeCapabilities {
  const supported = { h264: false, hevc: false, av1: false };
  for (const e of encoders) if (e.ok) supported[e.codec] = true;
  return {
    state,
    probedAt: null,
    durationMs: null,
    ffmpegVersion: 'ffmpeg version n8.1.3',
    hwaccels: [],
    decoders: { h264: [], hevc: [], av1: [] },
    encoders,
    supported,
    cpu: { cores: 32, model: null },
    devices: { renderNodes: [], nvidia: false },
    error: null,
  };
}

/** The owner's server: CPU encoders work, the GPU ones don't. */
const CPU = caps([enc('h264_nvenc', 'h264', 'nvenc', false), enc('libx264', 'h264', 'software', true, 3.07)]);

const profile = (rest: Partial<TranscodeProfile> = {}, video: Partial<TranscodeProfile['video']> = {}): TranscodeProfile => ({
  mode: 'transcode',
  video: { codec: 'h264', width: 1280, height: 720, fps: 30, bitrateKbps: 3000, keyframeSec: 2, encoder: 'auto', ...video },
  audio: 'copy',
  fallback: 'copy',
  ...rest,
});

/** A 1080p60 H.264 feed: every platform can take it as it is. */
const H264_FEED: Pick<FeedState, 'video' | 'audio'> = { video: { codec: 'h264', width: 1920, height: 1080, fps: 60 }, audio: { codec: 'aac' } };
/** The issue's feed: Twitch and Kick can't take it as it is. */
const AV1_FEED: Pick<FeedState, 'video' | 'audio'> = { video: { codec: 'av1', width: 3440, height: 1440, fps: 60 }, audio: { codec: 'aac' } };

interface World {
  destinations: Record<string, Partial<Destination>>;
  settings: TranscodeSettings;
  caps: TranscodeCapabilities;
  feed: Pick<FeedState, 'video' | 'audio'>;
}

function setup(world: Partial<World> = {}, withRuntime = true) {
  const w: World = {
    destinations: { d1: { id: 'd1', profileId: 'default', platform: 'twitch', name: 'Twitch main', transcode: profile() } },
    settings: { enabled: true, maxWorkers: 2 },
    caps: CPU,
    feed: H264_FEED,
    ...world,
  };
  const media = {
    readUrl: () => INPUT,
    feed: () => ({ feed: 'landscape', online: true, since: null, bitrateKbps: null, ...w.feed }),
  } as unknown as MediaServer;
  const repos = { destinations: { get: (id: string) => (w.destinations[id] as Destination | undefined) ?? null } };
  const runtime: TranscodeRuntime = { settings: () => w.settings, capabilities: async () => w.caps };
  const bus = new EventBus();
  const events: PushEvent[] = [];
  bus.on('push', (e) => events.push(e));
  const sp = fakeSpawn();
  const cap = captureLogger();
  const sup = createPushSupervisor(
    { config, bus, log: cap.log, media, repos, ...(withRuntime ? { transcode: runtime } : {}) },
    { spawn: sp.spawn, now: () => Date.now(), probeCapabilities: async () => ({ multitrack: true }), stallTimeoutMs: 10 * 60_000 },
  );
  const child = (): FakeChild => {
    const c = sp.last()?.child;
    if (!c) throw new Error('no process spawned');
    return c;
  };
  return { w, sup, events, sp, child, logs: cap.text, last: () => events.at(-1) };
}

type Rig = ReturnType<typeof setup>;

/** The encode's job as the supervisor resolves it for d1. */
function expectedArgs(w: World, id = 'd1'): string[] {
  const dest = w.destinations[id] as Destination;
  const r = resolveTranscodeJob(dest.transcode!, dest.platform, w.caps, w.feed);
  if (!r.ok) throw new Error(r.reason);
  return buildTranscodePushArgs(INPUT, plan.url, r.job);
}

const COPY_ARGS = buildPushArgs(plan, { landscape: INPUT });

/**
 * One progress block every 2 s of wall clock for `seconds`. `speed` = media time per wall second;
 * `fps` = frames encoded per wall second (default: the profile's 30 fps × speed).
 */
class Encode {
  private outUs = 0;
  private frames = 0;
  constructor(
    private readonly rig: Rig,
    private readonly child: FakeChild = rig.child(),
  ) {}

  async run(seconds: number, speed = 1, fps = 30 * speed): Promise<void> {
    for (let s = 0; s < seconds; s += 2) {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return;
      vi.advanceTimersByTime(2000);
      this.outUs += 2_000_000 * speed;
      this.frames += 2 * fps;
      this.child.stdout.write(
        `frame=${Math.round(this.frames)}\nfps=${fps.toFixed(2)}\nbitrate=3000.0kbits/s\ntotal_size=${Math.round(this.outUs / 8)}\nout_time_us=${Math.round(this.outUs)}\nspeed=${speed.toFixed(2)}x\nprogress=continue\n`,
      );
      await flush();
    }
  }
}

async function crash(child: FakeChild, stderr: string, code = 1): Promise<void> {
  child.stderr.write(stderr);
  await flush();
  child.exit(code);
  await flush();
}

const ENCODER_OPEN_ERROR =
  '[libx264 @ 0x55] Error setting preset/tune veryfast/(null).\n[vost#0:0/libx264 @ 0x56] [enc:libx264 @ 0x57] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.\nConversion failed!\n';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('which pushes transcode', () => {
  it('copies exactly as before when the destination has no profile', async () => {
    const rig = setup({ destinations: { d1: { id: 'd1', profileId: 'default', platform: 'twitch', name: 'Twitch main' } } });
    rig.sup.start('d1', plan);
    await flush();
    expect(rig.sp.calls).toHaveLength(1);
    expect(rig.sp.calls[0]!.args).toEqual(COPY_ARGS);
    await new Encode(rig).run(6);
    // Byte-identical events: no `transcode` key anywhere.
    expect(rig.events[0]).toEqual({ id: 'd1', status: 'starting', message: null, stats: null, attempt: 0 });
    expect(rig.events.every((e) => !('transcode' in e))).toBe(true);
    expect(rig.last()).toMatchObject({ status: 'running', message: null });
    await rig.sup.stop('d1');
  });

  it('copies while the server switch is off, whatever the profile says (the default)', async () => {
    const rig = setup({ settings: { enabled: false, maxWorkers: 2 } });
    rig.sup.start('d1', plan);
    await flush();
    expect(rig.sp.calls[0]!.args).toEqual(COPY_ARGS);
    await new Encode(rig).run(4);
    expect(rig.events.every((e) => !('transcode' in e))).toBe(true);
    await rig.sup.stop('d1');
  });

  it("copies when the profile is saved in 'copy' mode, null or the supervisor has no transcoding", async () => {
    for (const transcode of [profile({ mode: 'copy' }), null]) {
      const rig = setup({ destinations: { d1: { id: 'd1', profileId: 'default', platform: 'twitch', name: 'T', transcode } } });
      rig.sup.start('d1', plan);
      await flush();
      expect(rig.sp.calls[0]!.args).toEqual(COPY_ARGS);
      await rig.sup.stop('d1');
    }
    const rig = setup({}, false);
    rig.sup.start('d1', plan);
    await flush();
    expect(rig.sp.calls[0]!.args).toEqual(COPY_ARGS);
    await rig.sup.stop('d1');
  });

  it('encodes with the resolved encoder and reports starting -> running', async () => {
    const rig = setup();
    rig.sup.start('d1', plan);
    await flush();
    expect(rig.sp.calls).toHaveLength(1);
    expect(rig.sp.calls[0]!.args).toEqual(expectedArgs(rig.w));
    expect(rig.sp.calls[0]!.args).toContain('libx264');
    await new Encode(rig).run(2);
    expect(rig.last()).toMatchObject({
      status: 'running',
      message: null,
      transcode: { state: 'running', encoder: 'libx264', codec: 'h264', width: 1280, height: 720, fps: 30, bitrateKbps: 3000, speed: null, message: null },
    });
    await rig.sup.stop('d1');
    expect(rig.logs()).toContain('push transcoding');
    expect(rig.logs()).not.toContain(SECRET);
    expect(rig.logs()).not.toContain(READER_PASS);
    expect(JSON.stringify(rig.events)).not.toContain(SECRET);
  });

  it("never transcodes Twitch Dual Format pushes ('ivs' / 'multitrack' encode on their own)", async () => {
    const rig = setup();
    rig.sup.start('d1', { url: plan.url, mode: 'multitrack', feeds: ['landscape', 'vertical'] });
    await flush();
    expect(rig.sp.calls[0]!.args).not.toContain('libx264');
    expect(rig.sp.calls[0]!.args.join(' ')).toContain('-c copy');
    await rig.sup.stop('d1');
  });

  it('reads the profile again at every launch, so an edit applies at the next (re)start', async () => {
    const rig = setup();
    rig.sup.start('d1', plan);
    await flush();
    expect(rig.sp.calls[0]!.args).toContain('3000k');
    rig.w.destinations.d1 = { ...rig.w.destinations.d1, transcode: profile({}, { bitrateKbps: 4500 }) };
    await crash(rig.child(), '[rtmp @ 0x1] Connection reset by peer\n');
    await vi.advanceTimersByTimeAsync(1000);
    expect(rig.sp.calls).toHaveLength(2);
    expect(rig.sp.calls[1]!.args).toContain('4500k');
    await rig.sup.stop('d1');
  });
});

describe('when the encode cannot start', () => {
  it('sends the original feed when no encoder works and the platform accepts the feed', async () => {
    const rig = setup({ caps: caps([enc('h264_nvenc', 'h264', 'nvenc', false)]) });
    rig.sup.start('d1', plan);
    await flush();
    expect(rig.sp.calls[0]!.args).toEqual(COPY_ARGS);
    await new Encode(rig).run(2);
    const why = 'no working H.264 encoder on this server';
    expect(rig.last()).toMatchObject({
      status: 'running',
      message: transcodeFallbackMessage(why),
      transcode: { state: 'fallback-copy', encoder: null, codec: 'h264', width: 1280, height: 720, message: transcodeFallbackMessage(why) },
    });
    await rig.sup.stop('d1');
  });

  it("fails with the reason when the platform can't take the feed either", async () => {
    const rig = setup({ caps: caps([enc('h264_nvenc', 'h264', 'nvenc', false)]), feed: AV1_FEED });
    rig.sup.start('d1', plan);
    await flush();
    expect(rig.sp.calls).toHaveLength(0);
    expect(rig.last()).toMatchObject({
      status: 'failed',
      message: "Can't transcode: no working H.264 encoder on this server, and Twitch main can't take the feed as it is (AV1 3440×1440 60 fps).",
    });
    expect(rig.sup.isRunning('d1')).toBe(false);
  });

  it("fails instead of copying when the profile says 'stop'", async () => {
    const rig = setup({
      caps: caps([]),
      destinations: { d1: { id: 'd1', profileId: 'default', platform: 'twitch', name: 'Twitch main', transcode: profile({ fallback: 'stop' }) } },
    });
    rig.sup.start('d1', plan);
    await flush();
    expect(rig.sp.calls).toHaveLength(0);
    expect(rig.last()).toMatchObject({ status: 'failed', message: "Can't transcode: no working H.264 encoder on this server." });
  });

  it('keeps to the server limit of simultaneous transcodes', async () => {
    const dest = (id: string): Partial<Destination> => ({ id, profileId: 'default', platform: 'twitch', name: id, transcode: profile() });
    const rig = setup({ destinations: { d1: dest('d1'), d2: dest('d2'), d3: dest('d3') }, settings: { enabled: true, maxWorkers: 2 } });
    for (const id of ['d1', 'd2', 'd3']) {
      rig.sup.start(id, plan);
      await flush();
    }
    expect(rig.sp.calls.map((c) => c.args.includes('libx264'))).toEqual([true, true, false]);
    expect(rig.sp.calls[2]!.args).toEqual(COPY_ARGS);
    await new Encode(rig, rig.sp.calls[2]!.child).run(2);
    expect(rig.events.filter((e) => e.id === 'd3').at(-1)).toMatchObject({
      status: 'running',
      transcode: { state: 'fallback-copy', message: transcodeFallbackMessage('2 destinations are already transcoding (the limit in Settings → Transcoding)') },
    });
    // A slot frees up: the next start transcodes again.
    await rig.sup.stop('d1');
    await rig.sup.stop('d3');
    rig.sup.start('d3', plan);
    await flush();
    expect(rig.sp.last()!.args).toContain('libx264');
    await rig.sup.stopAll();
  });

  it('falls back at once when the encoder cannot open', async () => {
    const rig = setup();
    rig.sup.start('d1', plan);
    await flush();
    await crash(rig.child(), ENCODER_OPEN_ERROR);
    // No backoff: the copy starts immediately.
    expect(rig.sp.calls).toHaveLength(2);
    expect(rig.sp.calls[1]!.args).toEqual(COPY_ARGS);
    const retry = rig.events.find((e) => e.status === 'retrying');
    expect(retry?.message).toMatch(/^Transcoding stopped \(the libx264 encoder couldn't start: /);
    expect(retry?.transcode).toMatchObject({ state: 'fallback-copy', encoder: null });
    await new Encode(rig).run(2);
    expect(rig.last()).toMatchObject({ status: 'running', transcode: { state: 'fallback-copy' } });
    await rig.sup.stop('d1');
  });

  it('recognises encoder start failures', () => {
    expect(isEncoderOpenFailure(['Error while opening encoder - maybe incorrect parameters'])).toBe(true);
    expect(isEncoderOpenFailure(['Cannot load libcuda.so.1'])).toBe(true);
    expect(isEncoderOpenFailure(['No VA display found for device /dev/dri/renderD128.'])).toBe(true);
    expect(isEncoderOpenFailure(['Impossible to convert between the formats supported by the filter'])).toBe(true);
    expect(isEncoderOpenFailure(['Connection refused', 'Conversion failed!'])).toBe(false);
    expect(isEncoderOpenFailure([])).toBe(false);
  });
});

describe('when the encode keeps failing', () => {
  it('gives up after three encode failures in two minutes and copies', async () => {
    const rig = setup();
    rig.sup.start('d1', plan);
    await flush();
    const failure = '[vf#0:0 @ 0x1] Error while filtering: Cannot allocate memory\nConversion failed!\n';
    await crash(rig.child(), failure);
    expect(rig.last()).toMatchObject({ status: 'retrying', transcode: { state: 'starting', encoder: 'libx264' } });
    await vi.advanceTimersByTimeAsync(1000);
    await crash(rig.child(), failure);
    await vi.advanceTimersByTimeAsync(2000);
    expect(rig.sp.calls).toHaveLength(3);
    expect(rig.sp.calls[2]!.args).toContain('libx264');
    await crash(rig.child(), failure);
    expect(rig.sp.calls).toHaveLength(4);
    expect(rig.sp.calls[3]!.args).toEqual(COPY_ARGS);
    expect(rig.last()?.transcode).toMatchObject({ state: 'fallback-copy' });
    expect(rig.events.findLast((e) => e.status === 'retrying')?.message).toMatch(/the encode failed 3 times in a row: Error while filtering: Cannot allocate memory/);
    await rig.sup.stop('d1');
  });

  it("doesn't count network failures or the feed going away", async () => {
    const rig = setup();
    rig.sup.start('d1', plan);
    await flush();
    const errors = [
      '[rtmp @ 0x1] Connection refused\n',
      '[tcp @ 0x1] Connection timed out\n',
      `[in#0 @ 0x1] Error opening input: ${INPUT}: I/O error\n`,
      '[in#0/flv @ 0x1] Error during demuxing: I/O error\n',
      '[rtmp @ 0x1] Server error: invalid stream key\n',
    ];
    for (const [i, err] of errors.entries()) {
      await crash(rig.child(), err);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(rig.sp.calls).toHaveLength(i + 2);
      expect(rig.sp.last()!.args).toContain('libx264');
    }
    // A clean exit (the feed ended) isn't a failure either.
    rig.child().exit(0);
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rig.sp.last()!.args).toContain('libx264');
    expect(rig.events.some((e) => e.transcode?.state === 'fallback-copy')).toBe(false);
    await rig.sup.stop('d1');
  });

  it("keeps retrying the encode when the platform can't take the original feed", async () => {
    const rig = setup({ feed: AV1_FEED });
    rig.sup.start('d1', plan);
    await flush();
    for (let i = 0; i < 4; i++) {
      await crash(rig.child(), ENCODER_OPEN_ERROR);
      expect(rig.last()).toMatchObject({ status: 'retrying', attempt: i + 1 });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(rig.sp.last()!.args).toContain('libx264');
    }
    expect(rig.events.some((e) => e.transcode?.state === 'fallback-copy')).toBe(false);
    await rig.sup.stop('d1');
  });

  it("stops the destination when the profile says 'stop'", async () => {
    const rig = setup({ destinations: { d1: { id: 'd1', profileId: 'default', platform: 'twitch', name: 'Twitch main', transcode: profile({ fallback: 'stop' }) } } });
    rig.sup.start('d1', plan);
    await flush();
    await crash(rig.child(), ENCODER_OPEN_ERROR);
    expect(rig.last()?.status).toBe('failed');
    expect(rig.last()?.message).toMatch(/^Transcoding stopped: the libx264 encoder couldn't start: .*set to stop instead of sending the original feed/);
    expect(rig.sp.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rig.sp.calls).toHaveLength(1);
  });
});

describe('when the encode falls behind real time', () => {
  it('warns, then falls back to copy after 30 s behind, and stays on copy', async () => {
    const rig = setup();
    rig.sup.start('d1', plan);
    await flush();
    const first = rig.child();
    const encode = new Encode(rig, first);
    await encode.run(24); // settles (10 s), then a full 10 s window: keeps up
    expect(rig.last()).toMatchObject({ status: 'running', message: null, transcode: { state: 'running', speed: 1 } });

    await encode.run(16, 0.8); // the window fills with slow samples
    expect(rig.last()?.transcode?.state).toBe('behind');
    expect(rig.last()?.message).toMatch(/^Transcoding is running at 0\.\d\d× real time, so viewers will see stutters\./);
    expect(rig.sp.calls).toHaveLength(1);

    await encode.run(TRANSCODE_FALLBACK_AFTER_MS / 1000 + 4, 0.8);
    // The encode was ended and the same push restarted as a plain copy, without a 'retrying'.
    expect(first.signals).toContain('SIGTERM');
    expect(rig.sp.calls).toHaveLength(2);
    expect(rig.sp.calls[1]!.args).toEqual(COPY_ARGS);
    expect(rig.events.some((e) => e.status === 'retrying')).toBe(false);
    const fallback = rig.events.find((e) => e.transcode?.state === 'fallback-copy');
    expect(fallback).toMatchObject({ status: 'running', transcode: { encoder: null, speed: null } });
    expect(fallback?.message).toMatch(/^Transcoding stopped \(this server encoded at 0\.80× real time\)\. This destination now gets the feed as OBS sends it\.$/);

    await new Encode(rig).run(4);
    expect(rig.last()).toMatchObject({ status: 'running', message: fallback?.message, transcode: { state: 'fallback-copy' } });

    // A later crash relaunches as copy too (no flapping back to the encode)...
    await crash(rig.child(), '[rtmp @ 0x1] Connection reset by peer\n');
    await vi.advanceTimersByTimeAsync(1000);
    expect(rig.sp.last()!.args).toEqual(COPY_ARGS);
    // ...until the push is started afresh (next go-live / feed back): that tries the encode again.
    await rig.sup.stop('d1');
    rig.sup.start('d1', plan);
    await flush();
    expect(rig.sp.last()!.args).toContain('libx264');
    await rig.sup.stop('d1');
  });

  it('clears the warning when it keeps up again', async () => {
    const rig = setup();
    rig.sup.start('d1', plan);
    await flush();
    const encode = new Encode(rig);
    await encode.run(24);
    await encode.run(14, 0.8);
    expect(rig.last()?.transcode?.state).toBe('behind');
    await encode.run(30);
    expect(rig.last()).toMatchObject({ status: 'running', message: null, transcode: { state: 'running', message: null } });
    expect(rig.sp.calls).toHaveLength(1);
    // The 30 s count starts over: another short slow spell doesn't fall back.
    await encode.run(20, 0.8);
    expect(rig.last()?.transcode?.state).toBe('behind');
    expect(rig.sp.calls).toHaveLength(1);
    await rig.sup.stop('d1');
  });

  it('counts too few encoded frames as behind even when media time keeps pace', async () => {
    const rig = setup();
    rig.sup.start('d1', plan);
    await flush();
    const encode = new Encode(rig);
    await encode.run(24);
    await encode.run(14, 1, 22); // 22 of 30 frames per second
    expect(rig.last()?.transcode).toMatchObject({ state: 'behind' });
    expect(rig.last()?.message).toBe(transcodeBehindMessage(rig.last()!.transcode!.speed!));
    expect(rig.last()!.transcode!.speed!).toBeLessThan(0.9);
    await rig.sup.stop('d1');
  });

  it("ignores the first seconds and a profile that keeps the feed's unknown frame rate", async () => {
    const rig = setup({
      feed: { video: { codec: 'h264', width: 1920, height: 1080 }, audio: { codec: 'aac' } },
      destinations: { d1: { id: 'd1', profileId: 'default', platform: 'twitch', name: 'T', transcode: profile({}, { fps: null }) } },
    });
    rig.sup.start('d1', plan);
    await flush();
    const encode = new Encode(rig);
    await encode.run(8, 0.5); // start-up burst: not judged
    expect(rig.last()?.transcode?.state).toBe('running');
    await encode.run(30, 1, 12); // frame rate unknown: only speed decides
    expect(rig.last()?.transcode).toMatchObject({ state: 'running', speed: 1 });
    await rig.sup.stop('d1');
  });

  it('judges an encode that is overloaded from the start by the clock, not by how little it produced', async () => {
    const rig = setup();
    rig.sup.start('d1', plan);
    await flush();
    const encode = new Encode(rig);
    await encode.run(20, 0.3);
    expect(rig.last()?.transcode?.state).toBe('running'); // 10 s to settle + a 10 s window
    await encode.run(6, 0.3);
    expect(rig.last()?.transcode).toMatchObject({ state: 'behind', speed: 0.3 });
    await rig.sup.stop('d1');
  });

  it("keeps transcoding with a clear warning when the platform can't take the original feed", async () => {
    const rig = setup({ feed: AV1_FEED });
    rig.sup.start('d1', plan);
    await flush();
    const encode = new Encode(rig);
    await encode.run(24);
    await encode.run(TRANSCODE_FALLBACK_AFTER_MS / 1000 + 30, 0.8);
    expect(rig.sp.calls).toHaveLength(1);
    expect(rig.child().signals).toEqual([]);
    expect(rig.last()?.transcode?.state).toBe('behind');
    expect(rig.last()?.message).toMatch(/Relay keeps transcoding because Twitch main can't take the feed as it is \(AV1 3440×1440 60 fps\)\.$/);
    await rig.sup.stop('d1');
  });

  it("stops the destination when the profile says 'stop', and a later stop waits for FFmpeg to be gone", async () => {
    const rig = setup({ destinations: { d1: { id: 'd1', profileId: 'default', platform: 'twitch', name: 'Twitch main', transcode: profile({ fallback: 'stop' }) } } });
    rig.sup.start('d1', plan);
    await flush();
    const child = rig.child();
    child.ignore.add('SIGTERM'); // FFmpeg takes a moment to leave
    const encode = new Encode(rig, child);
    await encode.run(24);
    for (let i = 0; i < 40 && rig.last()?.status !== 'failed'; i++) await encode.run(2, 0.8);
    expect(rig.last()?.status).toBe('failed');
    expect(rig.last()?.message).toMatch(/^Transcoding stopped: this server encoded at 0\.80× real time\./);
    expect(rig.sup.isRunning('d1')).toBe(false);
    expect(child.signals).toContain('SIGTERM');

    let stopped = false;
    const stop = rig.sup.stop('d1').then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(5000); // grace over: SIGKILL
    await stop;
    expect(child.signals).toContain('SIGKILL');
    expect(rig.sp.calls).toHaveLength(1);
  });

  it('does nothing of this to a copy push that runs slow', async () => {
    const rig = setup({ settings: { enabled: false, maxWorkers: 2 } });
    rig.sup.start('d1', plan);
    await flush();
    const encode = new Encode(rig);
    await encode.run(24);
    await encode.run(120, 0.5);
    expect(rig.sp.calls).toHaveLength(1);
    expect(rig.child().signals).toEqual([]);
    expect(rig.events.every((e) => e.message === null && !('transcode' in e))).toBe(true);
    await rig.sup.stop('d1');
  });
});

describe('transcode runtime and settings', () => {
  const store = (value: unknown) => ({ get: <T>(_key: string, fallback: T) => (value === undefined ? fallback : (value as T)) });

  it('is off with two workers unless stored otherwise, and ignores malformed values', () => {
    expect(readTranscodeSettings(store(undefined))).toEqual({ enabled: false, maxWorkers: 2 });
    expect(readTranscodeSettings(store({ enabled: true, maxWorkers: 4 }))).toEqual({ enabled: true, maxWorkers: 4 });
    expect(readTranscodeSettings(store({ enabled: 'yes', maxWorkers: 99 }))).toEqual({ enabled: false, maxWorkers: 2 });
    expect(readTranscodeSettings(store('on'))).toEqual({ enabled: false, maxWorkers: 2 });
    expect(readTranscodeSettings(store([true]))).toEqual({ enabled: false, maxWorkers: 2 });
  });

  it('waits for a probe that is still running, but not for long', async () => {
    let finish: (() => void) | null = null;
    const run: RunFn = async (_cmd, args) => {
      if (args.includes('-version')) {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { code: 0, stdout: 'ffmpeg version n8.1.3\n', stderr: '', timedOut: false, spawnError: null };
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false, spawnError: null };
    };
    const svc = new TranscodeCapabilityService({ ffmpegBin: 'ffmpeg', run, listRenderNodes: () => [], hasNvidiaDevice: () => false, cpu: () => ({ cores: 4, model: null }) });
    const runtime = createTranscodeRuntime(store(undefined), () => svc, 5000);

    const slow = runtime.capabilities();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await slow).state).toBe('probing');

    const joined = runtime.capabilities();
    await flush();
    finish!();
    expect((await joined).state).toBe('ready');
    // Ready: answered from the cache, no new probe.
    expect((await runtime.capabilities()).state).toBe('ready');
  });
});
