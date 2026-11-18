// End to end with a real FFmpeg (docs/TRANSCODING.md §9): the push supervisor transcodes a feed and
// a "platform" receives what the profile asked for. Skipped when no FFmpeg is available: set
// FFMPEG_BIN, or run `npm run setup-tools` (./tools). Software encoders only, tiny frames.
//
//   feed (a file made here: ultrawide 688×288, 30 fps)  ->  PushSupervisor (decode, scale, encode)
//     ->  fake platform (FFmpeg -listen 1 writing what it receives)  ->  ffprobe

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TranscodeCapabilities } from '../../../shared/api.js';
import type { Destination, FeedState, TranscodeProfile } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import { EventBus, type PushEvent } from '../events.js';
import type { MediaServer } from '../services.js';
import { createPushSupervisor } from './ffmpeg-supervisor.js';
import { probeTranscodeCapabilities } from './transcode-capabilities.js';

const exe = process.platform === 'win32' ? '.exe' : '';
const FFMPEG = process.env.FFMPEG_BIN || path.resolve('tools', `ffmpeg${exe}`);
const FFPROBE = path.join(path.dirname(FFMPEG), path.basename(FFMPEG).replace(/ffmpeg/i, 'ffprobe'));
const available = existsSync(FFMPEG) && existsSync(FFPROBE);

function run(bin: string, args: string[], timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function exited(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process still running after ${timeoutMs / 1000} s`)), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

interface Probe {
  codec: string;
  width: number;
  height: number;
  audio: string | null;
  /** Presentation times of the keyframes, seconds. */
  keyframes: number[];
  durationSec: number;
}

async function probe(file: string): Promise<Probe> {
  const streams = await run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', file]);
  const info = JSON.parse(streams.stdout) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number }[]; format?: { duration?: string } };
  const video = info.streams.find((s) => s.codec_type === 'video');
  const keys = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file]);
  return {
    codec: video?.codec_name ?? '',
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    audio: info.streams.find((s) => s.codec_type === 'audio')?.codec_name ?? null,
    keyframes: keys.stdout.split(/\r?\n/).map((l) => Number.parseFloat(l)).filter((n) => Number.isFinite(n)),
    durationSec: Number.parseFloat(info.format?.duration ?? '0'),
  };
}

describe.skipIf(!available)('transcoding with a real FFmpeg', () => {
  let dir = '';
  let caps: TranscodeCapabilities;
  const children = new Set<ChildProcess>();

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctd-transcode-'));
    caps = await probeTranscodeCapabilities({ ffmpegBin: FFMPEG });
  }, 120_000);

  afterAll(async () => {
    for (const c of children) c.kill('SIGKILL');
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  /** The "OBS feed": 8 s of an ultrawide test pattern with a tone, keyframe every second. */
  async function makeFeed(name: string, videoArgs: string[]): Promise<string> {
    const file = path.join(dir, name);
    const made = await run(FFMPEG, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=688x288:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '8', ...videoArgs, '-g', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', file,
    ]);
    expect(made.stderr, 'making the feed').not.toMatch(/error/i);
    expect(made.code).toBe(0);
    return file;
  }

  /**
   * Push `feedFile` through the real supervisor to a fake platform and return what it received,
   * with the push events seen on the way.
   */
  async function relay(feedFile: string, feed: Pick<FeedState, 'video' | 'audio'>, transcode: TranscodeProfile | null, out: string) {
    const port = await freePort();
    const url = `rtmp://127.0.0.1:${port}/live/key-${port}`;
    const outFile = path.join(dir, out);
    // The platform: accepts one publisher, writes what it gets, exits when the publisher leaves.
    const platform = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-listen', '1', '-timeout', '30', '-i', url, '-c', 'copy', '-f', 'flv', outFile], {
      stdio: 'ignore',
      windowsHide: true,
    });
    children.add(platform);
    platform.once('exit', () => children.delete(platform));

    const bus = new EventBus();
    const events: PushEvent[] = [];
    bus.on('push', (e) => events.push(e));
    const dest = { id: 'd1', profileId: 'default', platform: 'custom', name: 'Fake platform', transcode } as Partial<Destination> as Destination;
    const sup = createPushSupervisor({
      config: { ffmpegBin: FFMPEG } as AppConfig,
      bus,
      log: pino({ level: 'silent' }),
      media: { readUrl: () => feedFile, feed: () => ({ feed: 'landscape', online: true, since: null, bitrateKbps: null, ...feed }) } as unknown as MediaServer,
      repos: { destinations: { get: () => dest } },
      transcode: { settings: () => ({ enabled: true, maxWorkers: 2 }), capabilities: async () => caps },
    });

    // The feed is a file, so FFmpeg ends by itself when it is through: that shows as 'retrying'.
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`push did not finish; events: ${JSON.stringify(events.slice(-3))}`)), 60_000);
      const seen = { running: false };
      bus.on('push', (e) => {
        if (e.status === 'running') seen.running = true;
        if (e.status === 'failed' || (seen.running && e.status === 'retrying')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    sup.start('d1', { url, mode: 'copy', feeds: ['landscape'] });
    await done;
    await sup.stop('d1');
    await exited(platform, 20_000);
    return { events, received: await probe(outFile) };
  }

  const profile = (video: Partial<TranscodeProfile['video']> = {}): TranscodeProfile => ({
    mode: 'transcode',
    video: { codec: 'h264', width: 320, height: 180, fps: null, bitrateKbps: 400, keyframeSec: 2, encoder: 'auto', ...video },
    audio: 'copy',
    fallback: 'copy',
  });

  const H264_FEED = { video: { codec: 'h264', width: 688, height: 288, fps: 30 }, audio: { codec: 'aac' } };

  it('has a working H.264 software encoder to test with', () => {
    expect(caps.state).toBe('ready');
    expect(caps.encoders.find((e) => e.encoder === 'libx264')).toMatchObject({ ok: true });
  });

  it('H.264 ultrawide feed -> H.264 320×180, letterboxed, keyframe every 2 s, audio kept', async () => {
    const feedFile = await makeFeed('feed-h264.flv', ['-c:v', 'libx264', '-preset', 'veryfast']);
    const { events, received } = await relay(feedFile, H264_FEED, profile(), 'out-h264.flv');
    expect(events.some((e) => e.status === 'failed')).toBe(false);
    expect(events.find((e) => e.status === 'running')?.transcode).toMatchObject({ state: 'running', encoder: 'libx264', codec: 'h264', width: 320, height: 180 });
    expect(received).toMatchObject({ codec: 'h264', width: 320, height: 180, audio: 'aac' });
    expect(received.durationSec).toBeGreaterThan(6);
    // Keyframes on the 2 s clock (the feed's own are every 1 s): 0, 2, 4, 6.
    expect(received.keyframes.length).toBeGreaterThanOrEqual(3);
    const gaps = received.keyframes.slice(1).map((t, i) => t - received.keyframes[i]!);
    for (const gap of gaps) expect(gap).toBeCloseTo(2, 1);
  }, 120_000);

  it('a destination without a profile still gets the feed untouched (copy)', async () => {
    const feedFile = await makeFeed('feed-copy.flv', ['-c:v', 'libx264', '-preset', 'veryfast']);
    const { events, received } = await relay(feedFile, H264_FEED, null, 'out-copy.flv');
    expect(events.every((e) => !('transcode' in e))).toBe(true);
    expect(received).toMatchObject({ codec: 'h264', width: 688, height: 288, audio: 'aac' });
    const gaps = received.keyframes.slice(1).map((t, i) => t - received.keyframes[i]!);
    for (const gap of gaps) expect(gap).toBeCloseTo(1, 1);
  }, 120_000);

  it('frame rate and audio can be changed too: 15 fps, AAC re-encoded', async () => {
    const feedFile = await makeFeed('feed-fps.flv', ['-c:v', 'libx264', '-preset', 'veryfast']);
    const custom: TranscodeProfile = { ...profile({ fps: 15, width: 426, height: 240 }), audio: { codec: 'aac', bitrateKbps: 64 } };
    const { received } = await relay(feedFile, H264_FEED, custom, 'out-fps.flv');
    expect(received).toMatchObject({ codec: 'h264', width: 426, height: 240, audio: 'aac' });
    const rate = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'csv=p=0', path.join(dir, 'out-fps.flv')]);
    const [num, den] = rate.stdout.trim().split('/').map(Number);
    expect(num! / (den || 1)).toBeCloseTo(15, 0);
  }, 120_000);

  it("the issue's case: an AV1 feed becomes H.264 for a platform that only takes H.264", async (ctx) => {
    if (!caps.encoders.some((e) => e.encoder === 'libsvtav1' && e.ok)) return ctx.skip();
    // MKV: this test feed only needs to be an AV1 source FFmpeg can read (MediaMTX serves OBS's as E-RTMP).
    const feedFile = await makeFeed('feed-av1.mkv', ['-c:v', 'libsvtav1', '-preset', '12']);
    const fed = await probe(feedFile);
    expect(fed).toMatchObject({ codec: 'av1', width: 688, height: 288 });
    const { events, received } = await relay(feedFile, { video: { codec: 'av1', width: 688, height: 288, fps: 30 }, audio: { codec: 'aac' } }, profile(), 'out-av1.flv');
    expect(events.some((e) => e.status === 'failed')).toBe(false);
    expect(received).toMatchObject({ codec: 'h264', width: 320, height: 180, audio: 'aac' });
    expect(received.durationSec).toBeGreaterThan(6);
  }, 120_000);
});
