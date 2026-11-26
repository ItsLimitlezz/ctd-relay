// Feed timing (docs/API.md §19, v1.18): when did each frame of a profile's feeds reach Relay, by
// the stream's own clock and by Relay's, so CTD OBS can line up feeds that arrive with different
// delays (Landscape, Vertical, guest feeds).
//
// CPU-only by design: nothing is decoded. A reader is FFmpeg copying the feed's video (`-c copy`, no
// decode, no encode) from the loopback MediaMTX as FLV on stdout; Node reads the tag timestamps and,
// for H.264, walks the NAL length prefixes of each frame looking for an SEI timecode. Readers run only
// while an app asks (GET /profiles/{id}/timing, or an /events stream that named feed.timing) and stop
// TIMING_IDLE_STOP_MS after the last interest; at most `max` feeds are measured server-wide.

import type { ChildProcess } from 'node:child_process';
import { avcLengthSize, FlvReader, parseVideoTag, TAG_VIDEO } from './eflv.js';
import { defaultSpawn, terminate, type SpawnFn } from './process-utils.js';
import { redactFragments, redactSecretsInText, urlSecretFragments } from './redact.js';

/** transitMs is measured against the best (smallest) delay of this window. */
export const TIMING_WINDOW_MS = 30_000;
/** A reader stops this long after the last GET / the last interested event stream closed. */
export const TIMING_IDLE_STOP_MS = 30_000;
/** feed.timing events: one per measured feed per tick. */
export const TIMING_TICK_MS = 1_000;
/** Default FEED_TIMING_MAX: feeds measured at once, server-wide. */
export const DEFAULT_FEED_TIMING_MAX = 8;
/** A source timecode older than this (Relay's clock) is no longer reported. */
export const TIMECODE_MAX_AGE_MS = 5_000;
const FPS_WINDOW_MS = 2_000;
/** A jump between stream time and arrival time bigger than this is a new timeline (publisher restart). */
const DISCONTINUITY_MS = 5_000;
const JITTER_GAIN = 1 / 16; // RFC 3550 §6.4.1
const RESTART_MIN_MS = 2_000;
const RESTART_MAX_MS = 15_000;

// ---------------------------------------------------------------------------
// Timestamp math
// ---------------------------------------------------------------------------

/**
 * Per-feed timing statistics from (stream timestamp, arrival time) pairs of video frames.
 *
 * - transit: d = receivedAt − streamTimeMs mixes the sender's clock base with the network delay, so
 *   only its variation means anything: transitMs = d − min(d over the last TIMING_WINDOW_MS).
 * - jitter: RFC 3550 §6.4.1 interarrival jitter, J += (|D| − J) / 16 with
 *   D = (R_j − R_i) − (S_j − S_i) for consecutive frames, in ms.
 * - fps: frames per second of stream time over the last FPS_WINDOW_MS of stream time.
 */
export class TimingStats {
  streamTimeMs: number | null = null;
  receivedAt: number | null = null;
  private jitter = 0;
  private prev: { s: number; r: number } | null = null;
  /** Monotonic deque (increasing d) of (r, d): front = the window's minimum. */
  private mins: { r: number; d: number }[] = [];
  private times: number[] = [];

  frame(streamTimeMs: number, receivedAt: number): void {
    const prev = this.prev;
    if (prev) {
      const D = receivedAt - prev.r - (streamTimeMs - prev.s);
      if (streamTimeMs < prev.s - 1_000 || Math.abs(D) > DISCONTINUITY_MS) this.reset();
      else if (streamTimeMs > prev.s) this.jitter += (Math.abs(D) - this.jitter) * JITTER_GAIN;
    }
    this.prev = { s: streamTimeMs, r: receivedAt };
    this.streamTimeMs = streamTimeMs;
    this.receivedAt = receivedAt;

    const d = receivedAt - streamTimeMs;
    while (this.mins.length > 0 && this.mins[this.mins.length - 1]!.d >= d) this.mins.pop();
    this.mins.push({ r: receivedAt, d });
    const oldest = receivedAt - TIMING_WINDOW_MS;
    while (this.mins.length > 1 && this.mins[0]!.r < oldest) this.mins.shift();

    this.times.push(streamTimeMs);
    const first = streamTimeMs - FPS_WINDOW_MS;
    let drop = 0;
    while (drop < this.times.length - 1 && this.times[drop]! < first) drop++;
    if (drop > 0) this.times.splice(0, drop);
  }

  /** Smallest receivedAt − streamTimeMs of the window (null before the first frame). */
  arrivalOffsetMs(): number | null {
    return this.mins[0]?.d ?? null;
  }

  /** The latest frame's delay above the window's best, ms (≥ 0; null before the first frame). */
  transitMs(): number | null {
    const min = this.arrivalOffsetMs();
    if (min === null || this.streamTimeMs === null || this.receivedAt === null) return null;
    return this.receivedAt - this.streamTimeMs - min;
  }

  jitterMs(): number | null {
    return this.prev ? round(this.jitter, 1) : null;
  }

  fps(): number | null {
    const n = this.times.length;
    if (n < 2) return null;
    const span = this.times[n - 1]! - this.times[0]!;
    return span > 0 ? round(((n - 1) * 1000) / span, 2) : null;
  }

  reset(): void {
    this.jitter = 0;
    this.prev = null;
    this.mins = [];
    this.times = [];
  }
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// SEI timecode (H.264)
// ---------------------------------------------------------------------------

const NAL_SEI = 6;
const MAX_NALS_PER_FRAME = 256;
const SEI_USER_DATA_UNREGISTERED = 5;
const TIMECODE_RE = /(\d{2}):(\d{2}):(\d{2})([:;.])(\d{2,3})/;

/** RBSP of a NAL unit (header byte dropped, emulation prevention bytes 00 00 03 removed). */
export function nalRbsp(nal: Buffer): Buffer {
  const out = Buffer.alloc(nal.length);
  let n = 0;
  let zeros = 0;
  for (let i = 1; i < nal.length; i++) {
    const b = nal[i]!;
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    zeros = b === 0 ? zeros + 1 : 0;
    out[n++] = b;
  }
  return out.subarray(0, n);
}

/** "HH:MM:SS:FF" (";" kept for drop-frame) from text, or null. */
export function timecodeInText(text: string): string | null {
  const m = TIMECODE_RE.exec(text);
  if (!m) return null;
  const [, hh, mm, ss, sep, ff] = m;
  if (Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59 || Number(ff) > 119) return null;
  return `${hh}:${mm}:${ss}${sep === ';' ? ';' : ':'}${ff!.padStart(2, '0').slice(-2)}`;
}

/**
 * The SMPTE timecode of an H.264 SEI NAL unit (type 6, header byte included), or null. Read:
 * user_data_unregistered (payloadType 5) whose bytes after the 16-byte UUID hold an ASCII timecode
 * `HH:MM:SS:FF` (`;` for drop-frame), whatever the UUID. Not read: pic_timing (payloadType 1), whose
 * clock timestamps can't be found without parsing the SPS/VUI (HRD) the stream was encoded with.
 */
export function seiTimecode(nal: Buffer): string | null {
  if (nal.length < 2 || (nal[0]! & 0x1f) !== NAL_SEI) return null;
  const rbsp = nalRbsp(nal);
  let off = 0;
  while (off < rbsp.length && rbsp[off] !== 0x80) {
    let type = 0;
    while (off < rbsp.length && rbsp[off] === 0xff) type += rbsp[off++]!;
    if (off >= rbsp.length) return null;
    type += rbsp[off++]!;
    let size = 0;
    while (off < rbsp.length && rbsp[off] === 0xff) size += rbsp[off++]!;
    if (off >= rbsp.length) return null;
    size += rbsp[off++]!;
    if (off + size > rbsp.length) return null;
    if (type === SEI_USER_DATA_UNREGISTERED && size > 16) {
      const tc = timecodeInText(rbsp.toString('latin1', off + 16, off + Math.min(size, 16 + 256)));
      if (tc) return tc;
    }
    off += size;
  }
  return null;
}

/**
 * The SEI timecode of one AVCC frame (length-prefixed NAL units), or null. Every NAL unit of the frame
 * is looked at (only its first byte, unless it is an SEI): FFmpeg's h264_metadata, for one, puts its
 * SEI after the slices of a multi-slice frame.
 */
export function frameTimecode(data: Buffer, lengthSize: number): string | null {
  let off = 0;
  for (let n = 0; n < MAX_NALS_PER_FRAME && off + lengthSize < data.length; n++) {
    const len = data.readUIntBE(off, lengthSize);
    const start = off + lengthSize;
    if (len <= 0 || start + len > data.length) return null;
    const type = data[start]! & 0x1f;
    if (type === NAL_SEI) {
      const tc = seiTimecode(data.subarray(start, start + len));
      if (tc) return tc;
    }
    off = start + len;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The reader: FFmpeg -c copy → FLV on stdout → tag timestamps
// ---------------------------------------------------------------------------

export interface TimingFrame {
  /** The frame's FLV/RTMP timestamp (DTS, ms) as the reader gets it from MediaMTX. */
  streamTimeMs: number;
  /** Relay's wall clock (epoch ms) when the frame reached the reader. */
  receivedAt: number;
  /** SEI timecode carried by this frame, or null. */
  timecode: string | null;
}

export interface TimingReader {
  stop(): void;
}

/** Starts a reader of `url`; `onFrame` per video frame, `onExit` once when it ends (not after stop()). */
export type TimingReaderFactory = (url: string, onFrame: (f: TimingFrame) => void, onExit: (reason: string) => void) => TimingReader;

/** FFmpeg arguments: copy the first video track of `input` to FLV on stdout. Nothing is decoded. */
export function timingArgs(input: string): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-fflags', 'nobuffer',
    '-rw_timeout', '8000000',
    '-i', input,
    '-map', '0:v:0',
    '-c', 'copy',
    // Keep the publisher's timestamps (FFmpeg would otherwise start the output at 0).
    '-copyts',
    '-flush_packets', '1',
    '-f', 'flv',
    'pipe:1',
  ];
}

/** Parses the FLV byte stream of a reader into TimingFrames (exported for tests). */
export class FlvTimingParser {
  private readonly flv = new FlvReader();
  private lengthSize = 4;

  push(chunk: Buffer, receivedAt: number): TimingFrame[] {
    const frames: TimingFrame[] = [];
    for (const tag of this.flv.push(chunk)) {
      if (tag.type !== TAG_VIDEO) continue;
      const info = parseVideoTag(tag.body);
      if (!info || info.track !== 0) continue;
      if (info.kind === 'sequence-start') {
        if (info.avc) this.lengthSize = avcLengthSize(tag.body.subarray(info.dataOffset));
        continue;
      }
      if (info.kind !== 'frame') continue;
      const timecode = info.avc ? frameTimecode(tag.body.subarray(info.dataOffset), this.lengthSize) : null;
      frames.push({ streamTimeMs: tag.timestamp, receivedAt, timecode });
    }
    return frames;
  }
}

export interface FfmpegTimingDeps {
  ffmpegBin: string;
  spawn?: SpawnFn;
  now?: () => number;
}

/** The real reader factory: one FFmpeg child per feed (never logs the URL: it holds the reader password). */
export function ffmpegTimingReaders(deps: FfmpegTimingDeps): TimingReaderFactory {
  const spawn = deps.spawn ?? defaultSpawn;
  const now = deps.now ?? Date.now;
  return (url, onFrame, onExit) => {
    let stopped = false;
    let ended = false;
    const parser = new FlvTimingParser();
    let err = '';
    const child: ChildProcess = spawn(deps.ffmpegBin, timingArgs(url), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const end = (reason: string) => {
      if (ended) return;
      ended = true;
      if (!stopped) onExit(redactSecretsInText(redactFragments(reason.replaceAll(url, '<feed>'), urlSecretFragments(url))));
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stopped) return;
      let frames: TimingFrame[];
      try {
        frames = parser.push(chunk, now());
      } catch (e) {
        void terminate(child, 2_000);
        end(`unreadable output: ${(e as Error).message}`);
        return;
      }
      for (const f of frames) onFrame(f);
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (err.length < 300) err += b.toString();
    });
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    child.on('error', (e) => end(`could not start FFmpeg: ${e.message}`));
    child.on('exit', (code, signal) => end(`FFmpeg exited (${signal ?? code})${err ? `: ${err.trim().split('\n').pop()}` : ''}`));
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        void terminate(child, 2_000);
      },
    };
  };
}

// ---------------------------------------------------------------------------
// The service: interest, the cap, idle stop, feed.timing ticks
// ---------------------------------------------------------------------------

export type TimingFeedKind = 'landscape' | 'vertical' | 'guest';

/** One feed of a profile, as the service needs it. */
export interface TimingFeedRef {
  /** 'landscape', 'vertical', or 'guest/<slot>'. Unique within the profile. */
  id: string;
  feed: TimingFeedKind;
  slot: string | null;
  name: string | null;
  online: boolean;
}

/** One feed in GET /profiles/{id}/timing and the feed.timing event (docs/API.md §19.2). */
export interface ApiFeedTiming {
  id: string;
  feed: TimingFeedKind;
  slot: string | null;
  name: string | null;
  online: boolean;
  measuring: boolean;
  streamTimeMs: number | null;
  receivedAt: number | null;
  sourceTimecode: string | null;
  sourceTimecodeStreamTimeMs: number | null;
  transitMs: number | null;
  arrivalOffsetMs: number | null;
  jitterMs: number | null;
  fps: number | null;
}

export interface ApiFeedTimingList {
  profileId: string;
  /** false when FEED_TIMING_MAX=0: nothing is ever measured. */
  enabled: boolean;
  /** FEED_TIMING_MAX: feeds measured at once, server-wide. */
  maxFeeds: number;
  /** Feeds being measured right now, server-wide (all profiles). */
  measuredFeeds: number;
  windowMs: number;
  idleStopMs: number;
  /** Relay's clock when the reply was built (epoch ms). */
  serverTime: number;
  feeds: ApiFeedTiming[];
}

export interface FeedTimingDeps {
  /** Feeds of a profile: landscape, vertical, then its guest slots ([] for an unknown profile). */
  feeds(profileId: string): TimingFeedRef[];
  /** Every profile id (for an event stream that covers every profile). */
  profiles(): string[];
  /** Internal reader URL of a feed (holds the reader password; never logged), or null. */
  readUrl(profileId: string, feed: TimingFeedRef): string | null;
  /** Send one feed.timing event. */
  emit(profileId: string, timing: ApiFeedTiming): void;
  readers: TimingReaderFactory;
  max: number;
  log: { info(o: object, msg: string): void; warn(o: object, msg: string): void };
  now?: () => number;
}

interface Measurement {
  profileId: string;
  ref: TimingFeedRef;
  stats: TimingStats;
  timecode: { value: string; streamTimeMs: number; at: number } | null;
  reader: TimingReader | null;
  failures: number;
  retryAt: number;
  /** Bumped whenever a reader starts or stops: callbacks of an older reader are ignored. */
  gen: number;
}

const ALL = '*';

export class FeedTimingService {
  private readonly now: () => number;
  /** Last GET per profile (epoch ms). */
  private readonly touched = new Map<string, number>();
  /** Open interested event streams per profile ('*' = every profile). */
  private readonly holds = new Map<string, number>();
  /** Last moment a hold on the profile was released (it stays interested TIMING_IDLE_STOP_MS longer). */
  private readonly released = new Map<string, number>();
  private readonly measured = new Map<string, Measurement>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly deps: FeedTimingDeps) {
    this.now = deps.now ?? Date.now;
  }

  get max(): number {
    return Math.max(0, this.deps.max);
  }

  /** GET /profiles/{id}/timing: register interest in the profile, start its readers, report its feeds. */
  read(profileId: string): ApiFeedTimingList {
    if (this.max > 0 && !this.closed) {
      this.touched.set(profileId, this.now());
      this.sync();
    }
    return {
      profileId,
      enabled: this.max > 0,
      maxFeeds: this.max,
      measuredFeeds: this.runningCount(),
      windowMs: TIMING_WINDOW_MS,
      idleStopMs: TIMING_IDLE_STOP_MS,
      serverTime: this.now(),
      feeds: this.deps.feeds(profileId).map((ref) => this.view(profileId, ref)),
    };
  }

  /** An event stream that asked for feed.timing: interest in `profileId` (null = every profile) until released. */
  hold(profileId: string | null): () => void {
    if (this.max === 0 || this.closed) return () => {};
    const key = profileId ?? ALL;
    this.holds.set(key, (this.holds.get(key) ?? 0) + 1);
    this.sync();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.holds.get(key) ?? 1) - 1;
      if (n > 0) this.holds.set(key, n);
      else this.holds.delete(key);
      this.released.set(key, this.now());
    };
  }

  /** Feeds measured right now (readers running), server-wide. */
  runningCount(): number {
    let n = 0;
    for (const m of this.measured.values()) if (m.reader) n++;
    return n;
  }

  /** Is anything about `profileId` still interested (a recent GET, an open stream, or one closed recently)? */
  private interested(profileId: string, t: number): boolean {
    if ((this.holds.get(profileId) ?? 0) > 0 || (this.holds.get(ALL) ?? 0) > 0) return true;
    const recent = (at: number | undefined) => at !== undefined && t - at < TIMING_IDLE_STOP_MS;
    return recent(this.touched.get(profileId)) || recent(this.released.get(profileId)) || recent(this.released.get(ALL));
  }

  private interestedProfiles(t: number): string[] {
    const ids = new Set<string>();
    if ((this.holds.get(ALL) ?? 0) > 0 || (this.released.has(ALL) && t - this.released.get(ALL)! < TIMING_IDLE_STOP_MS)) {
      for (const id of this.deps.profiles()) ids.add(id);
    }
    for (const id of [...this.touched.keys(), ...this.holds.keys(), ...this.released.keys()]) if (id !== ALL) ids.add(id);
    return [...ids].filter((id) => this.interested(id, t));
  }

  /** Start/stop readers to match interest, feeds online and the cap; tick timer on while anything runs. */
  private sync(): void {
    if (this.closed) return;
    const t = this.now();
    const wanted = new Map<string, { profileId: string; ref: TimingFeedRef }>();
    for (const profileId of this.interestedProfiles(t)) {
      for (const ref of this.deps.feeds(profileId)) wanted.set(`${profileId}\u0000${ref.id}`, { profileId, ref });
    }
    // Forget what nobody wants any more (or what no longer exists).
    for (const [key, m] of this.measured) {
      const w = wanted.get(key);
      if (!w) {
        this.stopReader(m);
        this.measured.delete(key);
      } else {
        m.ref = w.ref;
        if (!w.ref.online && m.reader) {
          this.stopReader(m);
          m.stats.reset();
        }
      }
    }
    // Start readers for online feeds, first come first served, up to the cap.
    let running = this.runningCount();
    for (const [key, w] of wanted) {
      let m = this.measured.get(key);
      if (!m) {
        m = { profileId: w.profileId, ref: w.ref, stats: new TimingStats(), timecode: null, reader: null, failures: 0, retryAt: 0, gen: 0 };
        this.measured.set(key, m);
      }
      if (m.reader || !w.ref.online || running >= this.max || t < m.retryAt) continue;
      if (this.startReader(m)) running++;
    }
    // Housekeeping of the interest maps.
    for (const [id, at] of this.touched) if (t - at >= TIMING_IDLE_STOP_MS) this.touched.delete(id);
    for (const [id, at] of this.released) if (t - at >= TIMING_IDLE_STOP_MS) this.released.delete(id);

    if (this.measured.size > 0 && !this.timer) {
      this.timer = setInterval(() => this.tick(), TIMING_TICK_MS);
      this.timer.unref?.();
    } else if (this.measured.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private startReader(m: Measurement): boolean {
    const url = this.deps.readUrl(m.profileId, m.ref);
    if (!url) return false;
    m.stats.reset();
    m.timecode = null;
    const gen = ++m.gen;
    const reader = this.deps.readers(
      url,
      (f) => {
        if (m.gen !== gen) return;
        m.failures = 0;
        m.stats.frame(f.streamTimeMs, f.receivedAt);
        if (f.timecode) m.timecode = { value: f.timecode, streamTimeMs: f.streamTimeMs, at: f.receivedAt };
      },
      (reason) => {
        if (m.gen !== gen) return;
        m.gen++;
        m.reader = null;
        m.failures++;
        m.retryAt = this.now() + Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** Math.min(4, m.failures - 1));
        this.deps.log.warn({ profileId: m.profileId, feed: m.ref.id, reason }, 'feed timing reader stopped; retrying');
      },
    );
    if (m.gen !== gen) return false; // ended before it started
    m.reader = reader;
    this.deps.log.info({ profileId: m.profileId, feed: m.ref.id }, 'feed timing reader started');
    return true;
  }

  private stopReader(m: Measurement): void {
    if (!m.reader) return;
    const r = m.reader;
    m.reader = null;
    m.gen++;
    r.stop();
    this.deps.log.info({ profileId: m.profileId, feed: m.ref.id }, 'feed timing reader stopped');
  }

  private tick(): void {
    this.sync();
    for (const m of this.measured.values()) {
      if (!m.reader) continue;
      try {
        this.deps.emit(m.profileId, this.timingOf(m, m.ref));
      } catch (err) {
        this.deps.log.warn({ error: (err as Error).message }, 'feed.timing event failed');
      }
    }
  }

  private view(profileId: string, ref: TimingFeedRef): ApiFeedTiming {
    const m = this.measured.get(`${profileId}\u0000${ref.id}`);
    return this.timingOf(m ?? null, ref);
  }

  private timingOf(m: Measurement | null, ref: TimingFeedRef): ApiFeedTiming {
    const s = m?.stats;
    const fresh = s && s.receivedAt !== null;
    const tc = m?.timecode && this.now() - m.timecode.at < TIMECODE_MAX_AGE_MS ? m.timecode : null;
    return {
      id: ref.id,
      feed: ref.feed,
      slot: ref.slot,
      name: ref.name,
      online: ref.online,
      measuring: !!m?.reader,
      streamTimeMs: fresh ? s.streamTimeMs : null,
      receivedAt: fresh ? s.receivedAt : null,
      sourceTimecode: tc?.value ?? null,
      sourceTimecodeStreamTimeMs: tc?.streamTimeMs ?? null,
      transitMs: fresh ? s.transitMs() : null,
      arrivalOffsetMs: fresh ? s.arrivalOffsetMs() : null,
      jitterMs: fresh ? s.jitterMs() : null,
      fps: fresh ? s.fps() : null,
    };
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const m of this.measured.values()) this.stopReader(m);
    this.measured.clear();
  }
}
