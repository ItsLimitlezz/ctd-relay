// PushSupervisor: one FFmpeg process per destination, restarted with backoff until stop().
// Emits 'push' events: starting -> running (first progress with out_time > 0) -> stats updates
// (<= every 2 s) -> retrying (unexpected exit) ... -> stopped. 'failed' = not retryable
// (bad plan, FFmpeg missing). plan.url embeds the stream key and is never logged.

import { execFile, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Logger } from 'pino';
import { explainNoStreamError } from '../../../shared/feed-codec.js';
import { DEFAULT_PROFILE_ID, type Feed, type PushStats } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import type { EventBus, PushStatus } from '../events.js';
import type { PushPlan } from '../platforms/types.js';
import type { DestinationsRepo, MediaServer, PushSupervisor } from '../services.js';
import { buildPushArgs, capabilitiesFromVersion, IVS_PROGRESS_FD, MULTITRACK_UNSUPPORTED, type FfmpegCapabilities } from './ffmpeg-args.js';
import { IvsForwarder } from './ivs-forwarder.js';
import { ProgressParser, type ProgressBlock } from './ffmpeg-progress.js';
import { defaultSpawn, onLines, terminate, type SpawnFn } from './process-utils.js';
import { redactFragments, redactSecretsInText, redactUrl, urlSecretFragments } from './redact.js';

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
}

export function createPushSupervisor({ config, bus, log, media, repos }: PushSupervisorOptions, deps: PushSupervisorDeps = {}): PushSupervisor {
  const spawn = deps.spawn ?? defaultSpawn;
  const now = deps.now ?? Date.now;
  const stallTimeoutMs = deps.stallTimeoutMs ?? 30_000;
  const probe = deps.probeCapabilities ?? defaultProbe(config.ffmpegBin);
  const pushes = new Map<string, Push>();
  /** stop() calls in flight, so a second stop(id) also waits for the exit. */
  const stopping = new Map<string, Promise<void>>();
  let caps: Promise<FfmpegCapabilities> | null = null;

  const emit = (p: Push, status: PushStatus, message: string | null = null, stats: PushStats | null = null) => {
    bus.emit('push', { id: p.id, status, message, stats, attempt: p.attempt });
  };

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

  function onProgress(p: Push, block: ProgressBlock, stats: PushStats): void {
    if (p.stopped) return;
    const t = now();
    if (p.runningSince === null) {
      if (block.outTimeUs <= 0) return;
      p.runningSince = t;
      p.lastStatsAt = t;
      p.log.info({ target: redactUrl(p.plan.url) }, 'push running');
      emit(p, 'running', null, stats);
      return;
    }
    const wasSlow = p.slowMessage;
    trackSpeed(p, block);
    if (t - p.lastStatsAt >= STATS_INTERVAL_MS - STATS_JITTER_MS || p.slowMessage !== wasSlow) {
      p.lastStatsAt = t;
      emit(p, 'running', p.slowMessage, stats);
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
   * FFmpeg's "Error opening output files: Invalid argument" / "Error binding filtergraph
   * inputs/outputs: Invalid argument" mean the feed has no stream it could map: OBS sends HEVC or
   * AV1 (or no AAC audio for Twitch Dual Format). Say that, and what to change, instead.
   */
  function explainFeedCodec(p: Push): string | null {
    if (p.profileId === null) return null;
    try {
      return explainNoStreamError(p.lines, media.feeds(p.profileId), p.plan);
    } catch {
      return null; // feed state unavailable: FFmpeg's own line is shown
    }
  }

  function onExit(p: Push, code: number | null, signal: NodeJS.Signals | null, spawnError?: NodeJS.ErrnoException): void {
    if (p.stallTimer) clearTimeout(p.stallTimer);
    p.stallTimer = null;
    p.proc = null;
    if (p.stopped || pushes.get(p.id) !== p) return;

    if (spawnError && (spawnError.code === 'ENOENT' || spawnError.code === 'EACCES')) {
      fail(p, `FFmpeg not found at ${config.ffmpegBin}; run \`npm run setup-tools\` (or set FFMPEG_BIN)`);
      return;
    }
    const raw = p.stallMessage || p.forwardMessage ? null : pickMessage(p.lines);
    const message =
      p.stallMessage ??
      p.forwardMessage ??
      (raw !== null ? (explainFeedCodec(p) ?? explainFfmpegError(raw) ?? raw) : null) ??
      (spawnError ? `FFmpeg could not start: ${spawnError.message}` : signal ? `FFmpeg was killed (${signal})` : `FFmpeg exited with code ${code}`);
    if (p.runningSince !== null && now() - p.runningSince >= HEALTHY_RESET_MS) p.attempt = 0;
    p.attempt++;
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
      args = buildPushArgs(p.plan, inputs, c);
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
