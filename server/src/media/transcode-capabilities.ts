// Transcoding capability detection (docs/TRANSCODING.md §4): which video encoders this machine's
// FFmpeg can actually use. Read-only; nothing here transcodes a stream.
//
// At startup, in the background: `ffmpeg -version`, `-hwaccels`, `-encoders`, `-decoders`, the GPU
// device nodes and the CPU, then one short test encode per candidate encoder the build has (30
// synthetic 1280×720 frames to the null muxer), one at a time at low priority. The result is cached
// in memory until the next probe. A failure here never affects streaming: every error ends up in
// the result, never thrown.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import type { Logger } from 'pino';
import type {
  TranscodeCapabilities,
  TranscodeEncoderBackend,
  TranscodeEncoderResult,
  TranscodeVideoCodec,
} from '../../../shared/api.js';
import type { AppServices } from '../services.js';
import { onLines } from './process-utils.js';

export const TRANSCODE_CODECS: readonly TranscodeVideoCodec[] = ['h264', 'hevc', 'av1'];

export interface EncoderCandidate {
  encoder: string;
  codec: TranscodeVideoCodec;
  backend: TranscodeEncoderBackend;
}

/**
 * Candidates in preference order per codec: hardware (NVENC, QSV, VAAPI, AMF), then software.
 * Not candidates (TRANSCODING.md §4.2): *_vulkan, libaom-av1, librav1e, libopenh264, libkvazaar, v4l2m2m.
 */
export const ENCODER_CANDIDATES: readonly EncoderCandidate[] = [
  { encoder: 'h264_nvenc', codec: 'h264', backend: 'nvenc' },
  { encoder: 'h264_qsv', codec: 'h264', backend: 'qsv' },
  { encoder: 'h264_vaapi', codec: 'h264', backend: 'vaapi' },
  { encoder: 'h264_amf', codec: 'h264', backend: 'amf' },
  { encoder: 'libx264', codec: 'h264', backend: 'software' },
  { encoder: 'hevc_nvenc', codec: 'hevc', backend: 'nvenc' },
  { encoder: 'hevc_qsv', codec: 'hevc', backend: 'qsv' },
  { encoder: 'hevc_vaapi', codec: 'hevc', backend: 'vaapi' },
  { encoder: 'hevc_amf', codec: 'hevc', backend: 'amf' },
  { encoder: 'libx265', codec: 'hevc', backend: 'software' },
  { encoder: 'av1_nvenc', codec: 'av1', backend: 'nvenc' },
  { encoder: 'av1_qsv', codec: 'av1', backend: 'qsv' },
  { encoder: 'av1_vaapi', codec: 'av1', backend: 'vaapi' },
  { encoder: 'av1_amf', codec: 'av1', backend: 'amf' },
  { encoder: 'libsvtav1', codec: 'av1', backend: 'software' },
];

/** Test encode: synthetic source, frame count and size (1 s of 720p30). */
export const TEST_FRAMES = 30;
export const TEST_SIZE = '1280x720';
export const TEST_FPS = 30;
/** One test encode may take this long (a hung driver must not stall the probe). */
export const TEST_TIMEOUT_MS = 15_000;
/** Info commands (-version, -encoders, ...). */
const INFO_TIMEOUT_MS = 10_000;
/** Children run at this niceness, so a probe never competes with a live push. */
const PROBE_NICENESS = 10;
const MAX_ERROR_LENGTH = 200;
/** Render nodes tried for VAAPI (a box rarely has more than two GPUs). */
const MAX_RENDER_NODES = 4;

export interface RunResult {
  /** Exit code; null when killed (timeout) or it never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Spawn failed (e.g. ENOENT: FFmpeg not installed). */
  spawnError: string | null;
}

export type RunFn = (command: string, args: readonly string[], timeoutMs: number) => Promise<RunResult>;

export interface ProbeDeps {
  ffmpegBin: string;
  run?: RunFn;
  /** `/dev/dri/renderD*` paths. */
  listRenderNodes?: () => string[];
  /** Whether NVIDIA device nodes exist (`/dev/nvidia0`, `/dev/nvidiactl`). */
  hasNvidiaDevice?: () => boolean;
  cpu?: () => { cores: number; model: string | null };
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Parsing (pure)
// ---------------------------------------------------------------------------

/** First line of `ffmpeg -version`, or null. */
export function parseVersionLine(output: string): string | null {
  const line = output.split(/\r?\n/).find((l) => /^\s*ffmpeg version\s/i.test(l));
  return line ? line.trim().slice(0, 200) : null;
}

/** `ffmpeg -hwaccels`: the method names after the "Hardware acceleration methods:" header. */
export function parseHwaccels(output: string): string[] {
  const out: string[] = [];
  let inList = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^hardware acceleration methods:?$/i.test(line)) {
      inList = true;
      continue;
    }
    if (inList && /^[a-z0-9_]+$/i.test(line) && !out.includes(line)) out.push(line);
  }
  return out;
}

export interface CodecListEntry {
  name: string;
  /** 'V' video, 'A' audio, 'S' subtitle. */
  type: string;
  /** The codec in "(codec h264)", or the name itself when the description has none. */
  codec: string;
}

/**
 * `ffmpeg -encoders` / `-decoders` lines, e.g.
 *   " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)"
 *   " VFS..D h264                 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10"
 * The legend above the "------" separator is skipped (its flags column is a single letter + dots).
 */
export function parseCodecList(output: string): CodecListEntry[] {
  const out: CodecListEntry[] = [];
  let pastSeparator = !/^\s*-{3,}\s*$/m.test(output); // tolerate output without the legend
  for (const raw of output.split(/\r?\n/)) {
    if (!pastSeparator) {
      if (/^\s*-{3,}\s*$/.test(raw)) pastSeparator = true;
      continue;
    }
    const m = /^\s*([VAS])([A-Z.]{5})\s+(\S+)\s*(.*)$/.exec(raw);
    if (!m) continue;
    const name = m[3]!;
    const codec = /\(codec\s+([a-z0-9_]+)\)/i.exec(m[4] ?? '')?.[1] ?? name;
    out.push({ name, type: m[1]!, codec: codec.toLowerCase() });
  }
  return out;
}

/** Video decoders per transcode codec, in FFmpeg's order. */
export function decodersByCodec(entries: readonly CodecListEntry[]): Record<TranscodeVideoCodec, string[]> {
  const out: Record<TranscodeVideoCodec, string[]> = { h264: [], hevc: [], av1: [] };
  for (const e of entries) {
    if (e.type !== 'V') continue;
    const codec = e.codec as TranscodeVideoCodec;
    if (TRANSCODE_CODECS.includes(codec) && !out[codec].includes(e.name)) out[codec].push(e.name);
  }
  return out;
}

/** Final `speed=2.24x` of a `-progress` stream (null when absent or N/A). */
export function parseProgressSpeed(output: string): number | null {
  let speed: number | null = null;
  for (const line of output.split(/\r?\n/)) {
    const m = /^speed=\s*([0-9.]+)x\s*$/.exec(line.trim());
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v) && v > 0) speed = Math.round(v * 100) / 100;
    }
  }
  return speed;
}

/** FFmpeg's closing lines on any failure: the first line that isn't one of these is the cause. */
const GENERIC_ERROR_RE =
  /(nothing was written into output file|conversion failed|terminating thread with return code|task finished with error code|error sending frames to consumers|could not open encoder before eof|error while opening encoder - maybe incorrect parameters|^exiting normally|error parsing global options|^device creation failed)/i;

/** Strip FFmpeg's "[component @ 0x...] " prefixes (they nest: "[vost#0:0/x @ 0x..] [enc:x @ 0x..] "). */
function stripContext(line: string): string {
  let s = line.trim();
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/^\[[^\]]*\]\s*/, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

/** The most useful line of a failed test encode's stderr (FFmpeg prints the cause first). */
export function pickEncodeError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map(stripContext)
    .filter((l) => l.length > 0 && !/^svt\[(warn|info)\]/i.test(l));
  const cause = lines.find((l) => !GENERIC_ERROR_RE.test(l)) ?? lines[0] ?? 'test encode failed';
  return cause.slice(0, MAX_ERROR_LENGTH);
}

// ---------------------------------------------------------------------------
// Test encode
// ---------------------------------------------------------------------------

/** Encoder options for a short, realistic live-style test (CBR-ish, fast presets). */
function encoderOptions(c: EncoderCandidate): string[] {
  switch (c.encoder) {
    case 'libx264':
      return ['-preset', 'veryfast'];
    case 'libx265':
      return ['-preset', 'ultrafast', '-x265-params', 'log-level=error'];
    case 'libsvtav1':
      return ['-preset', '10'];
    default:
      return [];
  }
}

/** Arguments of one test encode. VAAPI needs a render node (`device`). */
export function testEncodeArgs(c: EncoderCandidate, device: string | null = null): string[] {
  const head = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  if (c.backend === 'vaapi') {
    if (!device) throw new Error('VAAPI test encode needs a render node');
    head.push('-vaapi_device', device);
  }
  const input = ['-f', 'lavfi', '-i', `testsrc2=size=${TEST_SIZE}:rate=${TEST_FPS}`, '-frames:v', String(TEST_FRAMES)];
  // Hardware encoders take NV12 (VAAPI uploaded to a surface); software takes 4:2:0 planar.
  const pixels =
    c.backend === 'vaapi' ? ['-vf', 'format=nv12,hwupload'] : c.backend === 'software' ? ['-pix_fmt', 'yuv420p'] : ['-pix_fmt', 'nv12'];
  return [
    ...head,
    ...input,
    ...pixels,
    '-c:v', c.encoder,
    ...encoderOptions(c),
    '-b:v', '3000k',
    '-g', String(TEST_FPS * 2),
    '-an',
    '-progress', 'pipe:1',
    '-f', 'null', '-',
  ];
}

/** Last `frame=N` of a `-progress` stream (0 when absent). */
export function parseProgressFrames(output: string): number {
  let frames = 0;
  for (const line of output.split(/\r?\n/)) {
    const m = /^frame=\s*(\d+)\s*$/.exec(line.trim());
    if (m) frames = Number(m[1]);
  }
  return frames;
}

/** A completed test encode: exit 0 and frames came out (FFmpeg can exit 0 having written nothing). */
function encodeSucceeded(r: RunResult): boolean {
  return r.code === 0 && !r.timedOut && parseProgressFrames(r.stdout) > 0;
}

function failureMessage(r: RunResult): string {
  if (r.spawnError) return r.spawnError.slice(0, MAX_ERROR_LENGTH);
  if (r.timedOut) return `test encode timed out after ${TEST_TIMEOUT_MS / 1000} s`;
  return pickEncodeError(r.stderr);
}

async function testEncoder(run: RunFn, ffmpegBin: string, c: EncoderCandidate, renderNodes: readonly string[]): Promise<TranscodeEncoderResult> {
  const base = { encoder: c.encoder, codec: c.codec, backend: c.backend };
  if (c.backend === 'vaapi') {
    if (renderNodes.length === 0) return { ...base, ok: false, speed: null, device: null, error: 'no /dev/dri render node (GPU not passed through)' };
    let lastError = 'test encode failed';
    for (const node of renderNodes) {
      const r = await run(ffmpegBin, testEncodeArgs(c, node), TEST_TIMEOUT_MS);
      if (encodeSucceeded(r)) return { ...base, ok: true, speed: parseProgressSpeed(r.stdout), device: node, error: null };
      lastError = failureMessage(r);
    }
    return { ...base, ok: false, speed: null, device: null, error: lastError };
  }
  const r = await run(ffmpegBin, testEncodeArgs(c), TEST_TIMEOUT_MS);
  if (encodeSucceeded(r)) return { ...base, ok: true, speed: parseProgressSpeed(r.stdout), device: null, error: null };
  return { ...base, ok: false, speed: null, device: null, error: failureMessage(r) };
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

export function emptyCapabilities(state: TranscodeCapabilities['state'], cpu: { cores: number; model: string | null }, error: string | null = null): TranscodeCapabilities {
  return {
    state,
    probedAt: null,
    durationMs: null,
    ffmpegVersion: null,
    hwaccels: [],
    decoders: { h264: [], hevc: [], av1: [] },
    encoders: [],
    supported: { h264: false, hevc: false, av1: false },
    cpu,
    devices: { renderNodes: [], nvidia: false },
    error,
  };
}

/** Run the whole probe once. Never throws. */
export async function probeTranscodeCapabilities(deps: ProbeDeps): Promise<TranscodeCapabilities> {
  const run = deps.run ?? defaultRun;
  const now = deps.now ?? Date.now;
  const cpu = (deps.cpu ?? defaultCpu)();
  const started = now();
  const finish = (caps: TranscodeCapabilities): TranscodeCapabilities => {
    const end = now();
    return { ...caps, probedAt: new Date(end).toISOString(), durationMs: Math.max(0, end - started) };
  };
  const renderNodes = (deps.listRenderNodes ?? defaultRenderNodes)().slice(0, MAX_RENDER_NODES);
  const devices = { renderNodes, nvidia: (deps.hasNvidiaDevice ?? defaultHasNvidia)() };

  const version = await run(deps.ffmpegBin, ['-hide_banner', '-version'], INFO_TIMEOUT_MS);
  // `-hide_banner -version` still prints the version line.
  const versionLine = parseVersionLine(version.stdout) ?? parseVersionLine(version.stderr);
  if (version.code !== 0 || !versionLine) {
    const why = version.spawnError ?? (version.timedOut ? 'ffmpeg -version timed out' : `ffmpeg -version failed (exit ${version.code ?? 'signal'})`);
    return finish({ ...emptyCapabilities('unavailable', cpu, `FFmpeg can't run: ${why}`.slice(0, MAX_ERROR_LENGTH)), devices });
  }

  const [hw, enc, dec] = [
    await run(deps.ffmpegBin, ['-hide_banner', '-hwaccels'], INFO_TIMEOUT_MS),
    await run(deps.ffmpegBin, ['-hide_banner', '-encoders'], INFO_TIMEOUT_MS),
    await run(deps.ffmpegBin, ['-hide_banner', '-decoders'], INFO_TIMEOUT_MS),
  ];
  const hwaccels = parseHwaccels(hw.stdout);
  const compiledEncoders = new Set(parseCodecList(enc.stdout).filter((e) => e.type === 'V').map((e) => e.name));
  const decoders = decodersByCodec(parseCodecList(dec.stdout));

  // Hardware first (as listed), then software, so a slow CPU encode runs last.
  const candidates = ENCODER_CANDIDATES.filter((c) => compiledEncoders.has(c.encoder));
  const ordered = [...candidates.filter((c) => c.backend !== 'software'), ...candidates.filter((c) => c.backend === 'software')];
  const encoders: TranscodeEncoderResult[] = [];
  for (const c of ordered) encoders.push(await testEncoder(run, deps.ffmpegBin, c, renderNodes));

  const supported = { h264: false, hevc: false, av1: false };
  for (const e of encoders) if (e.ok) supported[e.codec] = true;

  return finish({
    state: 'ready',
    probedAt: null,
    durationMs: null,
    ffmpegVersion: versionLine,
    hwaccels,
    decoders,
    encoders,
    supported,
    cpu,
    devices,
    error: compiledEncoders.size === 0 ? 'ffmpeg -encoders listed nothing' : null,
  });
}

// ---------------------------------------------------------------------------
// Cached service
// ---------------------------------------------------------------------------

export class TranscodeCapabilityService {
  private result: TranscodeCapabilities;
  private running: Promise<TranscodeCapabilities> | null = null;
  private closed = false;

  constructor(
    private readonly deps: ProbeDeps,
    private readonly log?: Logger,
  ) {
    this.result = emptyCapabilities('probing', (deps.cpu ?? defaultCpu)());
  }

  /** The cached result ('probing' until the first probe ends). */
  get(): TranscodeCapabilities {
    return this.result;
  }

  /** Start a probe unless one is running; resolves with its result. Never rejects. */
  start(): Promise<TranscodeCapabilities> {
    if (this.running) return this.running;
    const run = (async () => {
      try {
        const caps = await probeTranscodeCapabilities(this.deps);
        if (!this.closed) {
          this.result = caps;
          this.logResult(caps);
        }
        return caps;
      } catch (err) {
        // probeTranscodeCapabilities doesn't throw; this is a last line of defence.
        const caps = emptyCapabilities('unavailable', this.result.cpu, `capability probe failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, MAX_ERROR_LENGTH));
        if (!this.closed) this.result = caps;
        return caps;
      } finally {
        this.running = null;
      }
    })();
    this.running = run;
    return run;
  }

  /** Stop publishing results (shutdown). A running test encode ends within its own timeout. */
  close(): void {
    this.closed = true;
  }

  private logResult(caps: TranscodeCapabilities): void {
    if (!this.log) return;
    if (caps.state !== 'ready') {
      this.log.warn({ error: caps.error }, 'transcode capabilities: FFmpeg unavailable');
      return;
    }
    this.log.info(
      {
        durationMs: caps.durationMs,
        working: caps.encoders.filter((e) => e.ok).map((e) => (e.speed ? `${e.encoder} ${e.speed}x` : e.encoder)),
        failed: caps.encoders.filter((e) => !e.ok).map((e) => e.encoder),
        cores: caps.cpu.cores,
      },
      'transcode capabilities probed',
    );
  }
}

/** One-line summary for UIs and logs: "H.264: h264_nvenc, libx264 · HEVC: none · AV1: …". */
export function summarizeCapabilities(caps: TranscodeCapabilities): string {
  if (caps.state === 'probing') return 'checking…';
  if (caps.state === 'unavailable') return `unavailable${caps.error ? ` (${caps.error})` : ''}`;
  const label: Record<TranscodeVideoCodec, string> = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1' };
  return TRANSCODE_CODECS.map((codec) => {
    const ok = caps.encoders.filter((e) => e.codec === codec && e.ok).map((e) => e.encoder);
    return `${label[codec]}: ${ok.length ? ok.join(', ') : 'none'}`;
  }).join(' · ');
}

const instances = new WeakMap<AppServices, TranscodeCapabilityService>();

/** The capability service of these services (created on first use; main.ts starts the probe). */
export function transcodeCapabilitiesFor(s: AppServices): TranscodeCapabilityService {
  let svc = instances.get(s);
  if (!svc) {
    svc = new TranscodeCapabilityService({ ffmpegBin: s.config.ffmpegBin }, s.log.child({ mod: 'transcode-caps' }));
    instances.set(s, svc);
  }
  return svc;
}

/** Test seam: use `svc` (e.g. with a mocked runner) for these services. */
export function setTranscodeCapabilitiesFor(s: AppServices, svc: TranscodeCapabilityService): void {
  instances.set(s, svc);
}

// ---------------------------------------------------------------------------
// Defaults (real processes and devices)
// ---------------------------------------------------------------------------

const MAX_OUTPUT = 512 * 1024;

export const defaultRun: RunFn = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const done = (r: Omit<RunResult, 'stdout' | 'stderr' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, stdout, stderr, timedOut });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    if (child.pid !== undefined) {
      try {
        os.setPriority(child.pid, PROBE_NICENESS);
      } catch {
        // not permitted / already gone: run at normal priority
      }
    }
    onLines(child.stdout, (l) => {
      if (stdout.length < MAX_OUTPUT) stdout += `${l}\n`;
    });
    onLines(child.stderr, (l) => {
      if (stderr.length < MAX_OUTPUT) stderr += `${l}\n`;
    });
    child.on('error', (err) => done({ code: null, spawnError: err.message }));
    child.on('close', (code) => done({ code, spawnError: null }));
  });

function defaultRenderNodes(): string[] {
  if (process.platform !== 'linux') return [];
  try {
    return fs
      .readdirSync('/dev/dri')
      .filter((n) => /^renderD\d+$/.test(n))
      .sort()
      .map((n) => `/dev/dri/${n}`);
  } catch {
    return [];
  }
}

function defaultHasNvidia(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return fs.existsSync('/dev/nvidiactl') || fs.existsSync('/dev/nvidia0');
  } catch {
    return false;
  }
}

function defaultCpu(): { cores: number; model: string | null } {
  const cpus = os.cpus();
  const model = cpus[0]?.model?.trim() || null;
  return { cores: typeof os.availableParallelism === 'function' ? os.availableParallelism() : cpus.length, model };
}
