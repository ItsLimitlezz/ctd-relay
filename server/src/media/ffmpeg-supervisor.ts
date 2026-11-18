// PushSupervisor: one FFmpeg process per destination, restarted with backoff until stop().
// Emits 'push' events: starting -> running (first progress with out_time > 0) -> stats updates
// (<= every 2 s) -> retrying (unexpected exit) ... -> stopped. 'failed' = not retryable
// (bad plan, FFmpeg missing). plan.url embeds the stream key and is never logged.
//
// Transcoding (docs/TRANSCODING.md): a 'copy' push whose destination has a transcoding profile
// encodes in this same process instead of copying, while the server's switch is on. It is watched
// for falling behind real time and for encoder failures, and then falls back to plain copy, stops,
// or keeps trying, as the profile and the platform allow. A destination without a profile takes
// exactly the code path it always did.

import { execFile, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Logger } from 'pino';
import type { TranscodeCapabilities, TranscodeSettings } from '../../../shared/api.js';
import { CODEC_LABELS, feedFitsPlatform, isTranscoding } from '../../../shared/transcode.js';
import {
  DEFAULT_PROFILE_ID,
  type Destination,
  type DestinationTranscodeStatus,
  type Feed,
  type FeedState,
  type PushStats,
  type TranscodeProfile,
} from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import type { EventBus, PushStatus } from '../events.js';
import type { PushPlan } from '../platforms/types.js';
import type { DestinationsRepo, MediaServer, PushSupervisor } from '../services.js';
import { buildPushArgs, capabilitiesFromVersion, IVS_PROGRESS_FD, MULTITRACK_UNSUPPORTED, type FfmpegCapabilities } from './ffmpeg-args.js';
import { IvsForwarder } from './ivs-forwarder.js';
import { ProgressParser, type ProgressBlock } from './ffmpeg-progress.js';
import { defaultSpawn, onLines, terminate, type SpawnFn } from './process-utils.js';
import { redactFragments, redactSecretsInText, redactUrl, urlSecretFragments } from './redact.js';
import { buildTranscodePushArgs, resolveTranscodeJob, type TranscodeJob } from './transcode-args.js';

export interface PushSupervisorDeps {
  spawn?: SpawnFn;
  now?: () => number;
  /** Kill + retry when FFmpeg prints no progress for this long. */
  stallTimeoutMs?: number;
  /** Detect FFmpeg features (multitrack); default runs `ffmpeg -version` once. */
  probeCapabilities?: () => Promise<FfmpegCapabilities>;
}

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const HEALTHY_RESET_MS = 60_000;
const STATS_INTERVAL_MS = 2_000;
const STATS_JITTER_MS = 150; // progress blocks arrive every ~2 s; don't skip one for a few ms
const STOP_GRACE_MS = 5_000;
const MAX_MESSAGE_LENGTH = 300;

/** Final lines FFmpeg prints on any failure; the line before them says what actually went wrong. */
const GENERIC_LINE_RE =
  /^(conversion failed!?|exiting normally.*|terminating thread with return code.*|more than one video stream is not supported.*)$/i;

/** Retry delay for the n-th consecutive retry (1-based): 1, 2, 4, 8, 16, 30, 30 ... seconds. */
export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt - 1));
}

/** Strip FFmpeg's "[component @ 0x...] " prefix. */
function stripContext(line: string): string {
  return line.replace(/^\[[^\]]*@\s*(0x)?[0-9a-f]+\]\s*/i, '').trim();
}

/** The most useful recent stderr line (already redacted), or null. */
export function pickMessage(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = stripContext(lines[i] ?? '');
    if (line && !GENERIC_LINE_RE.test(line)) return line.slice(0, MAX_MESSAGE_LENGTH);
  }
  const last = lines.at(-1);
  return last ? stripContext(last).slice(0, MAX_MESSAGE_LENGTH) || null : null;
}

/** errno codes FFmpeg can't name print as "Error number -N occurred" (common on Windows builds). */
const errno = (codes: string): string => `Error number -(?:${codes}) occurred`;

/**
 * Known network failures -> plain sentences. Errno values are the Windows CRT ones (ETIMEDOUT=138,
 * ECONNREFUSED=107, ECONNRESET=108, ECONNABORTED=106, EHOSTUNREACH=110, ENETUNREACH=118) plus raw
 * Winsock codes; Linux prints the text forms. Order matters: the first match wins.
 */
const FRIENDLY_ERRORS: readonly { re: RegExp; message: string }[] = [
  {
    re: new RegExp(
      `Failed to resolve hostname|Name or service not known|Temporary failure in name resolution|No address associated with hostname|${errno('11001|11002')}`,
      'i',
    ),
    message: "Can't find the platform's server. Check the server URL.",
  },
  {
    re: /\bServer error:|NetStream\.Publish\.(?:BadName|Rejected|Denied)|Server returned 40[13]\b|Authentication failed/i,
    message: 'The platform rejected the stream. Check the stream key.',
  },
  {
    re: new RegExp(`Connection refused|${errno('107|10061')}`, 'i'),
    message: "Can't connect to the platform's server: it refused the connection. Check the server URL.",
  },
  {
    re: new RegExp(`Connection timed out|Operation timed out|${errno('138|10060')}`, 'i'),
    message: "Timed out connecting to the platform's server. Check the server URL and that outbound connections aren't blocked.",
  },
  {
    re: new RegExp(`No route to host|Network is unreachable|Host is unreachable|${errno('110|118|10051|10065')}`, 'i'),
    message: "Can't reach the platform's server. Check the server URL and this machine's internet connection.",
  },
  {
    re: new RegExp(`Input/output error|\\bI/O error\\b|Broken pipe|Connection reset|${errno('106|108|10053|10054')}`, 'i'),
    message: 'The platform closed the connection. Check the stream key and server URL.',
  },
];

/** Loopback addresses or demuxing: the failure is on the local feed (MediaMTX), not the platform. */
const LOCAL_INPUT_RE = /\b127\.0\.0\.1\b|\blocalhost\b|\[::1\]|demux/i;

/**
 * Plain-language text for a known FFmpeg network failure line, or null when it isn't recognised
 * (the caller then shows the raw line). The raw line stays in the logs.
 */
export function explainFfmpegError(line: string): string | null {
  if (LOCAL_INPUT_RE.test(line)) return null;
  for (const { re, message } of FRIENDLY_ERRORS) if (re.test(line)) return message;
  return null;
}

/** 'ivs' encoding below this speed counts as falling behind (live input runs at 1.00× when it keeps up). */
const SLOW_SPEED = 0.95;
/** Consecutive progress blocks (~2 s each) before the slow warning is set or cleared. */
const SLOW_BLOCKS = 4;
/** Ignore the first seconds: FFmpeg starts with a burst and its speed figure settles after that. */
const SLOW_GRACE_US = 10_000_000;

/** The card warning while the server can't encode Twitch Dual Format in real time. */
export function slowEncodeMessage(speed: number): string {
  return `This server can't encode Twitch Dual Format fast enough (${speed.toFixed(2)}× real time), so viewers will see stutters. Close other heavy apps on the server, or use "OBS sends Dual Format directly".`;
}

/** A failed Twitch Dual Format connection (RtmpPublisher) in plain words. */
export function publishErrorMessage(detail: string): string {
  const friendly = explainFfmpegError(detail);
  if (/BadName|Rejected|Denied|Authentication/i.test(detail)) return `Twitch refused the Dual Format stream (${detail}).`;
  return friendly ? `${friendly} (${detail})` : `Twitch Dual Format connection: ${detail}`;
}

// ---- Transcoding health (docs/TRANSCODING.md §7.2) ----

/** Speed and frame rate are measured over this much wall-clock time. */
export const TRANSCODE_WINDOW_MS = 10_000;
/** Slower than this (× real time) over the window counts as falling behind. */
export const TRANSCODE_SLOW_SPEED = 0.97;
/** ...and so does encoding fewer than this share of the expected frames. */
const TRANSCODE_SLOW_FPS_SHARE = 0.9;
/** Behind this long without a break: give up transcoding (fall back, stop, or keep trying). */
export const TRANSCODE_FALLBACK_AFTER_MS = 30_000;
/** This many encode failures within the window do the same. */
export const TRANSCODE_FAILURES_MAX = 3;
export const TRANSCODE_FAILURES_WINDOW_MS = 120_000;
/**
 * The first seconds after the push starts running are ignored: FFmpeg begins with a burst (the
 * feed's buffered frames), then settles. Wall clock, so a badly overloaded encode is still judged
 * after this long, however little it has produced.
 */
const TRANSCODE_GRACE_MS = 10_000;

/** FFmpeg lines that mean the encoder (or its device, or the filter feeding it) could not start. */
const ENCODER_OPEN_RE =
  /error while opening encoder|could not open encoder|error initializing output stream|error (?:re)?initializing filters|impossible to convert between the formats|cannot load |no va display|device creation failed|failed to (?:create|initiali[sz]e)[^.]*(?:device|session|encoder|context)|no capable devices found|unsupported (?:codec|device|pixel format)|not supported by (?:the )?(?:device|driver|hardware)/i;

/** The encoder could not open (as opposed to a network or feed problem). */
export function isEncoderOpenFailure(lines: readonly string[]): boolean {
  return lines.some((l) => ENCODER_OPEN_RE.test(l));
}

export function transcodeBehindMessage(speed: number, cantCopy: string | null = null): string {
  const base = `Transcoding is running at ${speed.toFixed(2)}× real time, so viewers will see stutters. Lower this destination's transcoding size, frame rate or bitrate, or turn its transcoding off.`;
  return cantCopy ? `${base} Relay keeps transcoding because ${cantCopy}.` : base;
}

export function transcodeFallbackMessage(why: string): string {
  return `Transcoding stopped (${why}). This destination now gets the feed as OBS sends it.`;
}

/** Why the platform can't be sent the feed as it is, e.g. "kick can't take the feed as it is (AV1 3440×1440)". */
function cantCopyReason(dest: Destination, video: FeedState['video'] | null | undefined): string {
  if (!video?.width || !video.height) return `the feed's format isn't known, so it can't be sent as it is`;
  const codec = (CODEC_LABELS as Record<string, string>)[video.codec] ?? video.codec.toUpperCase();
  const fps = video.fps ? ` ${Math.round(video.fps)} fps` : '';
  return `${dest.name || dest.platform} can't take the feed as it is (${codec} ${video.width}×${video.height}${fps})`;
}

/** A push that encodes (or did, before falling back) for its destination. */
interface TranscodeRun {
  job: TranscodeJob;
  status: DestinationTranscodeStatus;
  /** Frame rate the encode should reach; null = unknown (speed alone decides). */
  expectedFps: number | null;
  /** Recent progress samples (wall clock, output time, frames out). */
  samples: { t: number; outTimeUs: number; frame: number }[];
  /** Wall time since which it has been behind without a break. */
  behindSince: number | null;
  /** While behind: wall time since which it has kept up again. */
  okSince: number | null;
  /** While behind and not falling back: why the platform can't be sent the original feed instead. */
  cantCopy: string | null;
}

interface Push {
  id: string;
  plan: PushPlan;
  /** Profile whose OBS feeds this push reads (the destination's profile); null = unknown destination. */
  profileId: string | null;
  log: Logger;
  secrets: string[];
  stopped: boolean;
  attempt: number;
  announced: boolean;
  proc: ChildProcess | null;
  exited: Promise<void>;
  retryTimer: NodeJS.Timeout | null;
  stallTimer: NodeJS.Timeout | null;
  stallMessage: string | null;
  /** 'ivs' mode: Relay publishes FFmpeg's output itself (IvsForwarder); why that connection failed. */
  forwarder: IvsForwarder | null;
  forwardMessage: string | null;
  /** 'ivs': set while encoding runs slower than real time (shown on the card while live). */
  slowMessage: string | null;
  slowBlocks: number;
  goodBlocks: number;
  runningSince: number | null;
  lastStatsAt: number;
  lines: string[];
  /** The encode this process runs (null = plain copy or another mode). */
  transcode: TranscodeRun | null;
  /** Set once transcoding was given up for this push: it copies from here on (no flapping). */
  fallback: DestinationTranscodeStatus | null;
  /** Wall times of recent exits caused by the encode (not the network or the feed). */
  transcodeFailures: number[];
  /** The next exit relaunches at once, without backoff (switching to copy). */
  relaunchNow: boolean;
}

interface TranscodeWanted {
  runtime: TranscodeRuntime;
  dest: Destination;
  profile: TranscodeProfile;
  settings: TranscodeSettings;
}

/** What transcoding needs from the rest of the app (absent = this supervisor never transcodes). */
export interface TranscodeRuntime {
  /** The server's switch and limit, read every time a push (re)starts. */
  settings(): TranscodeSettings;
  /** The capability probe's result; waits for a probe that is still running. */
  capabilities(): Promise<TranscodeCapabilities>;
}

function defaultProbe(bin: string): () => Promise<FfmpegCapabilities> {
  return () =>
    new Promise((resolve) => {
      execFile(bin, ['-version'], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
        resolve(err ? { multitrack: false } : capabilitiesFromVersion(stdout));
      });
    });
}

export interface PushSupervisorOptions {
  config: AppConfig;
  bus: EventBus;
  log: Logger;
  media: MediaServer;
  /**
   * Push ids are destination ids: the destination's profile decides which OBS feeds are read
   * (each profile has its own). Looked up once when a push starts.
   */
  repos: { destinations: Pick<DestinationsRepo, 'get'> };
  /** Enables per-destination transcoding (docs/TRANSCODING.md). */
  transcode?: TranscodeRuntime;
}

export function createPushSupervisor({ config, bus, log, media, repos, transcode }: PushSupervisorOptions, deps: PushSupervisorDeps = {}): PushSupervisor {
  const spawn = deps.spawn ?? defaultSpawn;
  const now = deps.now ?? Date.now;
  const stallTimeoutMs = deps.stallTimeoutMs ?? 30_000;
  const probe = deps.probeCapabilities ?? defaultProbe(config.ffmpegBin);
  const pushes = new Map<string, Push>();
  /** stop() calls in flight, so a second stop(id) also waits for the exit. */
  const stopping = new Map<string, Promise<void>>();
  let caps: Promise<FfmpegCapabilities> | null = null;

  const emit = (p: Push, status: PushStatus, message: string | null = null, stats: PushStats | null = null) => {
    const tc = p.fallback ?? p.transcode?.status ?? null;
    // Copy pushes emit exactly what they always did; `transcode` only exists on transcoding ones.
    bus.emit('push', { id: p.id, status, message, stats, attempt: p.attempt, ...(tc ? { transcode: { ...tc } } : {}) });
  };

  /** The card warning of a running push: slow Dual Format encode, or the transcoding state's. */
  const runningMessage = (p: Push): string | null => p.slowMessage ?? p.fallback?.message ?? p.transcode?.status.message ?? null;

  const capabilities = (): Promise<FfmpegCapabilities> => {
    caps ??= probe().catch(() => ({ multitrack: false }));
    return caps;
  };

  function clearTimers(p: Push): void {
    if (p.retryTimer) clearTimeout(p.retryTimer);
    if (p.stallTimer) clearTimeout(p.stallTimer);
    p.retryTimer = null;
    p.stallTimer = null;
  }

  function fail(p: Push, message: string): void {
    clearTimers(p);
    p.stopped = true;
    if (pushes.get(p.id) === p) pushes.delete(p.id);
    p.log.error(`push failed: ${message}`);
    emit(p, 'failed', message);
  }

  function armStallTimer(p: Push, child: ChildProcess): void {
    if (p.stallTimer) clearTimeout(p.stallTimer);
    p.stallTimer = setTimeout(() => {
      p.stallTimer = null;
      if (p.proc !== child || p.stopped) return;
      p.stallMessage = `No progress from FFmpeg for ${Math.round(stallTimeoutMs / 1000)} s`;
      p.log.warn(p.stallMessage);
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, stallTimeoutMs);
  }

  /**
   * 'ivs' pushes encode on this server: warn while FFmpeg runs slower than real time (the feed is
   * live, so speed sits at 1.00× when the CPU keeps up). Set after SLOW_BLOCKS slow progress blocks
   * in a row, cleared after as many good ones.
   */
  function trackSpeed(p: Push, block: ProgressBlock): void {
    if (p.plan.mode !== 'ivs' || block.speed <= 0 || block.outTimeUs < SLOW_GRACE_US) return;
    if (block.speed < SLOW_SPEED) {
      p.goodBlocks = 0;
      if (++p.slowBlocks >= SLOW_BLOCKS && !p.slowMessage) {
        p.slowMessage = slowEncodeMessage(block.speed);
        p.log.warn({ speed: block.speed }, 'twitch dual format: encoding slower than real time');
      }
    } else {
      p.slowBlocks = 0;
      if (p.slowMessage && ++p.goodBlocks >= SLOW_BLOCKS) {
        p.slowMessage = null;
        p.goodBlocks = 0;
        p.log.info({ speed: block.speed }, 'twitch dual format: encoding keeps up again');
      }
    }
  }

  /** The feed this push reads, as MediaMTX last described it (null when it can't be read). */
  function feedOf(p: Push): FeedState | null {
    const feed = p.plan.feeds[0];
    if (p.profileId === null || !feed) return null;
    try {
      return media.feed(p.profileId, feed);
    } catch {
      return null;
    }
  }

  /** Pushes that are encoding right now, other than `self` (the server's worker limit). */
  function activeTranscodes(self: Push): number {
    let n = 0;
    for (const other of pushes.values()) if (other !== self && !other.stopped && other.transcode && !other.fallback) n++;
    return n;
  }

  function fallbackStatus(v: { codec: DestinationTranscodeStatus['codec']; width: number; height: number; fps: number | null; bitrateKbps: number }, why: string): DestinationTranscodeStatus {
    return {
      state: 'fallback-copy',
      encoder: null,
      codec: v.codec,
      width: v.width,
      height: v.height,
      fps: v.fps,
      bitrateKbps: v.bitrateKbps,
      speed: null,
      message: transcodeFallbackMessage(why),
    };
  }

  /**
   * A running push that must end for good (the profile says stop instead of falling back): report
   * 'failed' and end its FFmpeg. A stop(id) that follows waits for that process to be gone.
   */
  function failRunning(p: Push, message: string): void {
    const child = p.proc;
    fail(p, message);
    if (!child) return;
    const gone = terminate(child, STOP_GRACE_MS)
      .then(() => p.exited)
      .finally(() => {
        if (stopping.get(p.id) === gone) stopping.delete(p.id);
      });
    stopping.set(p.id, gone);
  }

  /**
   * Transcoding isn't working for this push (`why`). What happens next (docs/TRANSCODING.md §7.2):
   * - 'stop': the profile says stop; the push has been failed with the reason.
   * - 'copy': the platform accepts the feed as it is; the push copies from its next launch on
   *   (`p.fallback` is set, and stays for this push's lifetime so it can't flap).
   * - 'keep': the platform can't take the feed, so transcoding goes on; `cantCopy` says why.
   */
  function giveUpTranscoding(p: Push, why: string): { outcome: 'stop' } | { outcome: 'copy'; message: string | null } | { outcome: 'keep'; cantCopy: string } {
    const run = p.transcode;
    const dest = repos.destinations.get(p.id);
    const profile = dest?.transcode;
    const video = run?.status ?? (isTranscoding(profile) ? profile.video : null);
    const feed = feedOf(p);
    if (dest && isTranscoding(profile) && profile.fallback === 'stop') {
      failRunning(p, `Transcoding stopped: ${why}. (This destination is set to stop instead of sending the original feed.)`);
      return { outcome: 'stop' };
    }
    // No destination or profile any more (edited meanwhile): plain copy is what it asks for now.
    if (!dest || !isTranscoding(profile) || feedFitsPlatform(dest.platform, feed?.video)) {
      const status = video ? fallbackStatus(video, why) : null;
      p.fallback = status;
      p.transcode = null;
      p.log.warn({ why }, 'transcoding given up; this push sends the original feed from now on');
      return { outcome: 'copy', message: status?.message ?? null };
    }
    return { outcome: 'keep', cantCopy: cantCopyReason(dest, feed?.video) };
  }

  /**
   * Health of a transcoding push from its progress (every ~2 s): speed and frame rate over the last
   * TRANSCODE_WINDOW_MS. Slower than real time = 'behind' (card warning); behind for
   * TRANSCODE_FALLBACK_AFTER_MS = give up transcoding. Returns true when the state or message changed.
   */
  function trackTranscode(p: Push, block: ProgressBlock, stats: PushStats, t: number): boolean {
    const run = p.transcode;
    if (!run || p.fallback || p.runningSince === null || t - p.runningSince < TRANSCODE_GRACE_MS) return false;
    run.samples.push({ t, outTimeUs: block.outTimeUs, frame: block.frame });
    // Keep one sample that is at least a window old as the base.
    while (run.samples.length > 1 && t - run.samples[1]!.t >= TRANSCODE_WINDOW_MS) run.samples.shift();
    const base = run.samples[0]!;
    const span = t - base.t;
    if (span < TRANSCODE_WINDOW_MS) return false;

    const speed = (block.outTimeUs - base.outTimeUs) / 1000 / span;
    const fps = ((block.frame - base.frame) * 1000) / span;
    const fpsShare = run.expectedFps && block.frame > 0 ? fps / run.expectedFps : null;
    // What viewers get: the slower of "media time per second" and "share of the frames".
    const ratio = Math.round(Math.max(0, Math.min(speed, fpsShare ?? speed)) * 100) / 100;
    const slow = speed < TRANSCODE_SLOW_SPEED || (fpsShare !== null && fpsShare < TRANSCODE_SLOW_FPS_SHARE);
    const st = run.status;
    const before = `${st.state}|${st.message}`;
    st.speed = ratio;

    if (slow) {
      run.okSince = null;
      if (run.behindSince === null) {
        run.behindSince = t;
        st.state = 'behind';
        st.message = transcodeBehindMessage(ratio);
        p.log.warn({ speed: ratio, fps: Math.round(fps), encoder: run.job.encoder.encoder }, 'transcoding slower than real time');
      } else if (t - run.behindSince >= TRANSCODE_FALLBACK_AFTER_MS) {
        const result = giveUpTranscoding(p, `this server encoded at ${ratio.toFixed(2)}× real time`);
        if (result.outcome === 'stop') return false; // failed and reported
        if (result.outcome === 'copy') {
          // Say so first, then restart this process as a plain copy, without backoff (see onExit).
          p.lastStatsAt = t;
          emit(p, 'running', runningMessage(p), stats);
          p.relaunchNow = true;
          if (p.proc) void terminate(p.proc, STOP_GRACE_MS);
          return false;
        }
        // The platform can't take the original: keep transcoding, say so, look again later.
        run.behindSince = t;
        run.cantCopy = result.cantCopy;
        st.message = transcodeBehindMessage(ratio, run.cantCopy);
      } else {
        st.message = transcodeBehindMessage(ratio, run.cantCopy);
      }
    } else if (run.behindSince !== null) {
      run.okSince ??= t;
      if (t - run.okSince >= TRANSCODE_WINDOW_MS) {
        run.behindSince = null;
        run.okSince = null;
        run.cantCopy = null;
        st.state = 'running';
        st.message = null;
        p.log.info({ speed: ratio }, 'transcoding keeps up again');
      }
    }
    return before !== `${st.state}|${st.message}`;
  }

  function onProgress(p: Push, block: ProgressBlock, stats: PushStats): void {
    if (p.stopped) return;
    const t = now();
    if (p.runningSince === null) {
      if (block.outTimeUs <= 0) return;
      p.runningSince = t;
      p.lastStatsAt = t;
      if (p.transcode) p.transcode.status.state = 'running';
      p.log.info({ target: redactUrl(p.plan.url) }, 'push running');
      emit(p, 'running', p.fallback?.message ?? null, stats);
      return;
    }
    const wasSlow = p.slowMessage;
    trackSpeed(p, block);
    const transcodeChanged = trackTranscode(p, block, stats, t);
    if (p.stopped) return; // transcoding was stopped for good (reported as 'failed')
    if (t - p.lastStatsAt >= STATS_INTERVAL_MS - STATS_JITTER_MS || p.slowMessage !== wasSlow || transcodeChanged) {
      p.lastStatsAt = t;
      emit(p, 'running', runningMessage(p), stats);
    }
  }

  function onStderr(p: Push, raw: string): void {
    const line = redactFragments(redactSecretsInText(raw.trim()), p.secrets);
    if (!line) return;
    p.lines.push(line);
    if (p.lines.length > 20) p.lines.shift();
    p.log.debug(`ffmpeg: ${line}`);
  }

  /**
   * Whether an unexpected exit of a transcoding push is the encode's fault: FFmpeg hung, was killed,
   * or failed with something that is neither a network error nor the local feed going away. (The
   * feed ending makes FFmpeg exit cleanly or with a demux error; that is not an encode failure.)
   */
  function isEncodeFailure(p: Push, raw: string | null, code: number | null, spawnError?: NodeJS.ErrnoException): boolean {
    if (spawnError || p.forwardMessage) return false;
    if (p.stallMessage) return true;
    if (code === 0) return false;
    if (raw === null) return true;
    return explainFfmpegError(raw) === null && !LOCAL_INPUT_RE.test(raw);
  }

  function onExit(p: Push, code: number | null, signal: NodeJS.Signals | null, spawnError?: NodeJS.ErrnoException): void {
    if (p.stallTimer) clearTimeout(p.stallTimer);
    p.stallTimer = null;
    p.proc = null;
    if (p.stopped || pushes.get(p.id) !== p) return;

    if (p.relaunchNow) {
      // Transcoding was given up while running: the same push continues as a plain copy.
      p.relaunchNow = false;
      p.attempt = 0;
      void launch(p);
      return;
    }

    if (spawnError && (spawnError.code === 'ENOENT' || spawnError.code === 'EACCES')) {
      fail(p, `FFmpeg not found at ${config.ffmpegBin}; run \`npm run setup-tools\` (or set FFMPEG_BIN)`);
      return;
    }
    const raw = p.stallMessage || p.forwardMessage ? null : pickMessage(p.lines);
    const message =
      p.stallMessage ??
      p.forwardMessage ??
      (raw !== null ? (explainFfmpegError(raw) ?? raw) : null) ??
      (spawnError ? `FFmpeg could not start: ${spawnError.message}` : signal ? `FFmpeg was killed (${signal})` : `FFmpeg exited with code ${code}`);
    if (p.runningSince !== null && now() - p.runningSince >= HEALTHY_RESET_MS) p.attempt = 0;
    p.attempt++;

    // The encode is gone with its process: until the relaunch reports again it is "starting".
    if (p.transcode) {
      Object.assign(p.transcode.status, { state: 'starting', speed: null, message: null });
      Object.assign(p.transcode, { samples: [], behindSince: null, okSince: null, cantCopy: null });
    }

    // An exit caused by the encode itself (not the network, not the feed): after an encoder that
    // can't open, or TRANSCODE_FAILURES_MAX of them in a short time, give up transcoding.
    if (p.transcode && !p.fallback && isEncodeFailure(p, raw, code, spawnError)) {
      const t = now();
      p.transcodeFailures = [...p.transcodeFailures.filter((at) => t - at < TRANSCODE_FAILURES_WINDOW_MS), t];
      const cantOpen = p.runningSince === null && isEncoderOpenFailure(p.lines);
      if (cantOpen || p.transcodeFailures.length >= TRANSCODE_FAILURES_MAX) {
        const why = cantOpen
          ? `the ${p.transcode.job.encoder.encoder} encoder couldn't start: ${message}`
          : `the encode failed ${p.transcodeFailures.length} times in a row: ${message}`;
        p.log.warn({ code, signal, ...(raw !== null ? { detail: raw } : {}) }, `transcoding push exited (${message})`);
        const result = giveUpTranscoding(p, why);
        if (result.outcome === 'stop') return;
        if (result.outcome === 'copy') {
          // The stream to the platform is down right now: say so, then copy at once (no backoff).
          emit(p, 'retrying', result.message ?? message);
          void launch(p);
          return;
        }
        // 'keep': the platform can't take the original, so the normal retry below goes on.
      }
    }

    const delay = backoffDelay(p.attempt);
    p.log.warn(
      { code, signal, attempt: p.attempt, target: redactUrl(p.plan.url), ...(raw !== null && raw !== message ? { detail: raw } : {}) },
      `push exited (${message}); retrying in ${delay / 1000} s`,
    );
    emit(p, 'retrying', message);
    p.retryTimer = setTimeout(() => {
      p.retryTimer = null;
      void launch(p);
    }, delay);
  }

  function spawnFfmpeg(p: Push, args: string[]): void {
    if (p.announced) emit(p, 'starting');
    p.announced = true;
    p.lines = [];
    p.stallMessage = null;
    p.forwardMessage = null;
    p.slowMessage = null;
    p.slowBlocks = 0;
    p.goodBlocks = 0;
    p.runningSince = null;

    // 'ivs': stdout carries the FLV stream Relay publishes; progress goes to fd 3.
    const ivs = p.plan.mode === 'ivs';
    let child: ChildProcess;
    try {
      child = spawn(config.ffmpegBin, args, { stdio: ivs ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      onExit(p, null, null, err as NodeJS.ErrnoException);
      return;
    }
    p.proc = child;
    let resolveExited: () => void = () => {};
    p.exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });

    let forwarder: IvsForwarder | null = null;
    if (ivs && child.stdout) {
      forwarder = new IvsForwarder(p.plan.url, { log: p.log });
      p.forwarder = forwarder;
      forwarder.start(child.stdout, (err) => {
        if (p.proc !== child) return;
        p.forwardMessage = publishErrorMessage(redactFragments(redactSecretsInText(err.message), p.secrets));
        p.log.warn(`twitch dual format: ${p.forwardMessage}`);
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      });
    }

    const parser = new ProgressParser();
    onLines(ivs ? (child.stdio[IVS_PROGRESS_FD] as Readable | null) : child.stdout, (line) => {
      const result = parser.push(line);
      if (!result) return;
      armStallTimer(p, child);
      onProgress(p, result.block, result.stats);
    });
    onLines(child.stderr, (line) => onStderr(p, line));
    armStallTimer(p, child);

    let ended = false;
    const end = (code: number | null, signal: NodeJS.Signals | null, err?: NodeJS.ErrnoException) => {
      if (ended) return;
      ended = true;
      if (forwarder) {
        if (p.forwarder === forwarder) p.forwarder = null;
        void forwarder.close();
      }
      resolveExited();
      if (p.proc === child) onExit(p, code, signal, err);
    };
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (child.pid === undefined) end(null, null, err);
      else p.log.warn({ err: err.message }, 'ffmpeg process error');
    });
    // 'close' waits for stdio to drain, so the last stderr lines are in p.lines.
    child.on('close', (code, signal) => end(code, signal));
  }

  /**
   * Whether this push should transcode: a copy push whose destination has a transcoding profile,
   * while the server's switch is on and this push hasn't given up on it. Synchronous, so a push
   * that doesn't transcode launches exactly as it always did (no extra tick, same arguments).
   */
  function transcodeWanted(p: Push): TranscodeWanted | null {
    p.transcode = null;
    if (!transcode || p.plan.mode !== 'copy' || p.fallback) return null;
    const dest = repos.destinations.get(p.id);
    const profile = dest?.transcode;
    if (!dest || !isTranscoding(profile)) return null;
    const settings = transcode.settings();
    return settings.enabled ? { runtime: transcode, dest, profile, settings } : null;
  }

  /**
   * FFmpeg arguments for a push that should transcode: an encoder must work here and the worker
   * limit must have room. null = it can't; the push then falls back to copy (`p.fallback`) or has
   * been failed with the reason, as the profile and the platform allow.
   */
  async function transcodeArgs(p: Push, inputs: Partial<Record<Feed, string>>, wanted: TranscodeWanted): Promise<string[] | null> {
    const { runtime, dest, profile, settings } = wanted;
    const caps = await runtime.capabilities();
    if (p.stopped || pushes.get(p.id) !== p) return null;

    const feed = feedOf(p);
    let resolved = resolveTranscodeJob(profile, dest.platform, caps, feed);
    if (resolved.ok && activeTranscodes(p) >= settings.maxWorkers) {
      const n = settings.maxWorkers;
      resolved = { ok: false, reason: `${n} destination${n === 1 ? ' is' : 's are'} already transcoding (the limit in Settings → Transcoding)` };
    }
    if (!resolved.ok) {
      if (profile.fallback !== 'stop' && feedFitsPlatform(dest.platform, feed?.video)) {
        p.fallback = fallbackStatus(profile.video, resolved.reason);
        p.log.warn({ why: resolved.reason }, "can't transcode; sending the original feed");
        return null;
      }
      const cantCopy = profile.fallback === 'stop' ? '' : `, and ${cantCopyReason(dest, feed?.video)}`;
      fail(p, `Can't transcode: ${resolved.reason}${cantCopy}.`);
      return null;
    }

    const job = resolved.job;
    const input = inputs[p.plan.feeds[0]!];
    if (!input) throw new Error('No input URL for the feed');
    p.transcode = {
      job,
      status: {
        state: 'starting',
        encoder: job.encoder.encoder,
        codec: job.codec,
        width: job.width,
        height: job.height,
        fps: job.fps,
        bitrateKbps: job.bitrateKbps,
        speed: null,
        message: null,
      },
      expectedFps: job.fps ?? feed?.video?.fps ?? null,
      samples: [],
      behindSince: null,
      okSince: null,
      cantCopy: null,
    };
    p.log.info(
      { encoder: job.encoder.encoder, codec: job.codec, size: `${job.width}x${job.height}`, fps: job.fps ?? 'source', bitrateKbps: job.bitrateKbps },
      'push transcoding',
    );
    return buildTranscodePushArgs(input, p.plan.url, job, p.plan.extraOutputArgs);
  }

  async function launch(p: Push): Promise<void> {
    if (p.stopped || pushes.get(p.id) !== p) return;
    let args: string[];
    try {
      // Never fall back to another profile's feed: that would send the wrong OBS to this platform.
      if (p.profileId === null) throw new Error('Unknown destination: no profile to read the feed from');
      const c = p.plan.mode !== 'copy' ? await capabilities() : { multitrack: true };
      if (p.plan.mode === 'ivs' && !c.multitrack) throw new Error(MULTITRACK_UNSUPPORTED);
      if (p.stopped || pushes.get(p.id) !== p) return;
      const inputs: Partial<Record<Feed, string>> = {};
      for (const feed of p.plan.feeds) inputs[feed] = media.readUrl(p.profileId, feed);
      const wanted = transcodeWanted(p);
      const encode = wanted ? await transcodeArgs(p, inputs, wanted) : null;
      if (p.stopped || pushes.get(p.id) !== p) return;
      args = encode ?? buildPushArgs(p.plan, inputs, c);
    } catch (err) {
      fail(p, redactSecretsInText(err instanceof Error ? err.message : String(err)));
      return;
    }
    spawnFfmpeg(p, args);
  }

  /** Stop a push without emitting 'stopped' (used for stop() and restarts). */
  async function retire(p: Push): Promise<void> {
    p.stopped = true;
    clearTimers(p);
    const child = p.proc;
    // End the Twitch stream properly (FCUnpublish) before FFmpeg goes.
    await p.forwarder?.close();
    if (child) await terminate(child, STOP_GRACE_MS);
    await p.exited;
  }

  const supervisor: PushSupervisor = {
    start(id, plan) {
      const prev = pushes.get(id);
      const dest = repos.destinations.get(id);
      const p: Push = {
        id,
        plan,
        profileId: dest ? (dest.profileId ?? DEFAULT_PROFILE_ID) : null,
        log: log.child({ push: id }),
        secrets: urlSecretFragments(plan.url),
        stopped: false,
        attempt: 0,
        announced: false,
        proc: null,
        exited: Promise.resolve(),
        retryTimer: null,
        stallTimer: null,
        stallMessage: null,
        forwarder: null,
        forwardMessage: null,
        slowMessage: null,
        slowBlocks: 0,
        goodBlocks: 0,
        runningSince: null,
        lastStatsAt: 0,
        lines: [],
        transcode: null,
        fallback: null,
        transcodeFailures: [],
        relaunchNow: false,
      };
      pushes.set(id, p);
      p.log.info(
        { target: redactUrl(plan.url), mode: plan.mode, feeds: plan.feeds, profileId: p.profileId, restart: Boolean(prev) },
        'push starting',
      );
      emit(p, 'starting');
      // On restart, wait for the old FFmpeg to exit first (a stop() meanwhile waits for it too).
      const ready = (prev ? retire(prev) : Promise.resolve()).catch((err: unknown) =>
        p.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'previous push did not stop cleanly'),
      );
      p.exited = ready;
      void ready.then(() => launch(p));
    },

    stop(id) {
      const p = pushes.get(id);
      if (!p) return stopping.get(id) ?? Promise.resolve();
      pushes.delete(id);
      const done = retire(p)
        .then(() => {
          p.log.info('push stopped');
          emit(p, 'stopped');
        })
        .finally(() => {
          if (stopping.get(id) === done) stopping.delete(id);
        });
      stopping.set(id, done);
      return done;
    },

    async stopAll() {
      await Promise.all([...pushes.keys()].map((id) => supervisor.stop(id)));
    },

    isRunning(id) {
      return pushes.has(id);
    },
  };
  return supervisor;
}
