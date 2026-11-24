// Small fakes shared by the media module's unit tests (no runtime use).

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import pino, { type Logger } from 'pino';
import type { Feed, FeedState } from '../../../shared/types.js';
import type { ScopedSecrets } from '../services.js';
import { describeTracks, type MtxTrack } from './feed-state.js';

/** Minimal ChildProcess stand-in: piped stdout/stderr, kill() and scripted exits. */
export class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** fd 3 (FFmpeg's progress in 'ivs' pushes, where stdout carries the FLV stream). */
  readonly fd3 = new PassThrough();
  readonly stdio = [null, this.stdout, this.stderr, this.fd3];
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: (NodeJS.Signals | number | undefined)[] = [];
  /** Signals the fake ignores (to test SIGKILL escalation). */
  ignore = new Set<string>();

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    if (this.ignore.has(String(signal ?? 'SIGTERM'))) return true;
    this.exit(null, typeof signal === 'string' ? signal : 'SIGTERM');
    return true;
  }

  /** Simulate the process ending (emits 'exit' then 'close'). */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.stdout.end();
    this.stderr.end();
    this.fd3.end();
    this.emit('close', code, signal);
  }

  /** Simulate a spawn failure (ENOENT etc.). */
  failToSpawn(code = 'ENOENT'): void {
    this.pid = undefined;
    const err = Object.assign(new Error(`spawn fake ${code}`), { code });
    this.emit('error', err);
    this.emit('close', -2, null);
  }

  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

export interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  child: FakeChild;
}

/** Spawn function that records calls and returns FakeChild instances. */
export function fakeSpawn() {
  const calls: SpawnCall[] = [];
  const spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    const child = new FakeChild();
    calls.push({ command, args, options, child });
    return child.asChild();
  };
  return { spawn, calls, last: () => calls.at(-1) };
}

export function memorySecrets(initial: Record<string, string> = {}): ScopedSecrets & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => {
      data.set(k, v);
    },
    delete: async (k) => {
      data.delete(k);
    },
    getJson: async <T>(k: string) => {
      const v = data.get(k);
      return v === undefined ? null : (JSON.parse(v) as T);
    },
    setJson: async (k, v) => {
      data.set(k, JSON.stringify(v));
    },
  };
}

/** pino logger that records every line (to assert that secrets never reach logs). */
export function captureLogger(): { log: Logger; text: () => string } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { log: pino({ level: 'trace' }, sink), text: () => chunks.join('') };
}

/** Let pending stream 'data' events and promise callbacks run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((r) => process.nextTick(r));
}

// ---------------------------------------------------------------------------
// Feed codec fixtures
// ---------------------------------------------------------------------------

// Track sets as MediaMTX v1.21.2 reports them (GET /v3/paths/list → items[].tracks2), captured from
// OBS-like publishers (FFmpeg n8.1.3 → rtmp). Fixtures for the feed codec guard.
//
// What FFmpeg then got when it read each path the way a push does (classic RTMP):
//   h264Aac   video + audio      copy push runs
//   hevcAac   audio only         "Error opening output files: Invalid argument" (copy)
//                                "Error binding filtergraph inputs/outputs: Invalid argument" (Dual Format)
//   av1Aac    audio only         same as HEVC
//   h264Opus  video only         copy push runs, without sound
//   h264Only  video only         copy push runs, without sound; Dual Format can't bind its audio


export const TRACKS = {
  h264Aac: [
    { codec: 'H264', codecProps: { width: 1920, height: 1080, profile: 'High', level: '4.2' } },
    { codec: 'MPEG-4 Audio', codecProps: { sampleRate: 48000, channelCount: 2 } },
  ],
  hevcAac: [
    { codec: 'H265', codecProps: { width: 1920, height: 1080, profile: 'Main', level: '4.1' } },
    { codec: 'MPEG-4 Audio', codecProps: { sampleRate: 48000, channelCount: 2 } },
  ],
  av1Aac: [
    { codec: 'AV1', codecProps: { width: 1920, height: 1080 } },
    { codec: 'MPEG-4 Audio', codecProps: { sampleRate: 48000, channelCount: 2 } },
  ],
  h264Opus: [
    { codec: 'H264', codecProps: { width: 1920, height: 1080, profile: 'High', level: '4.2' } },
    { codec: 'Opus', codecProps: { channelCount: 2 } },
  ],
  h264Only: [{ codec: 'H264', codecProps: { width: 1920, height: 1080, profile: 'High', level: '4.2' } }],
} satisfies Record<string, MtxTrack[]>;

export type TrackSet = keyof typeof TRACKS;

/** An online feed with one of the track sets, as the media server reports it. */
export function feedWith(feed: Feed, tracks: TrackSet | null, over: Partial<FeedState> = {}): FeedState {
  return {
    profileId: 'default',
    feed,
    online: true,
    since: '2026-11-19T01:00:00.000Z',
    ...(tracks ? describeTracks(TRACKS[tracks]) : { video: null, audio: null }),
    bitrateKbps: 6000,
    ...over,
  };
}

/** FFmpeg's stderr for a copy push whose input has no video stream (HEVC/AV1 feed), verbatim. */
export const FFMPEG_NO_VIDEO_COPY = [
  "Stream map '' matches no streams.",
  "To ignore this, add a trailing '?' to the map.",
  "Failed to set value '0:v:0' for option 'map': Invalid argument",
  'Error parsing options for output file rtmp://live.example.com/app/key.',
  'Error opening output files: Invalid argument',
];

/** The same for Twitch Dual Format (filter graph over the feeds), verbatim. */
export const FFMPEG_NO_VIDEO_FILTER = [
  "[fc#0 @ 0x557953f0ee00] Stream specifier ':v' in filtergraph description [0:v]setpts=PTS-STARTPTS,split=1[s0] matches no streams.",
  'Error binding filtergraph inputs/outputs: Invalid argument',
];
