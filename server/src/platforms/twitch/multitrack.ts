// Twitch Dual Format through Relay (Enhanced Broadcasting = Amazon IVS multitrack video).
//
// What was learned (Oct 2026):
// - OBS asks Twitch's config service before every Enhanced Broadcasting stream:
//   POST https://ingest.twitch.tv/api/v3/GetClientConfiguration, JSON body (OBS
//   frontend/utility/GoLiveAPI_*.cpp). Twitch runs on Amazon IVS; the API and the rules below are
//   documented at https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/multitrack-video-sw-integration.html
// - Request: service "IVS", schema_version "2025-01-25", authentication = the stream key, client
//   {name, version, supported_codecs}, capabilities {cpu, memory, system, gpu: [...]}, preferences
//   {maximum_video_tracks, vod_track_audio, audio_*, canvases: [{width, height, canvas_width,
//   canvas_height, framerate}]}. Canvas 0 is the landscape feed, canvas 1 the vertical one.
// - Probed live on 2026-10-21 (fake key): without a GPU it refuses ("did not send GPU Information");
//   an old GPU (Radeon HD 7870) is "not currently supported"; a current NVIDIA GPU passes, and then
//   Dual Format "requires at least 2 tracks per canvas" (2 or 3 tracks refused). With 4 tracks it
//   returns 1920x1080@60 6000k + 640x360@30 500k (landscape), 1080x1920@60 5000k + 360x640@30 500k
//   (vertical), keyframes every 2 s, AAC 160k: about 12 Mbps up.
// - IVS disconnects streams whose tracks don't match the configuration (count, codec, resolution,
//   frame rate, bitrate), whose IDRs aren't aligned across tracks, or that lack the broadcast
//   performance metrics before every IDR. So Relay encodes every track itself (x264, constant
//   bitrate, aligned keyframes: media/ffmpeg-args.ts buildIvsArgs) and publishes the stream itself
//   with the metrics added (media/ivs-forwarder.ts).
// - Connect: url_template with {stream_key} replaced by `authentication`, then the user's query
//   (bandwidthtest), then clientConfigId=<config_id>. Track 0 goes as single-track packets, the
//   others as Multitrack/OneTrack packets (FFmpeg 8 flvenc does exactly this).
// - Probed again on 2026-11-04 (fake key, one change at a time): the client name, OS, user agent and
//   stream_attempt_start_time made no difference at this step; only the GPU did (reported-gpus.ts).
//   The fake key was accepted too, so a configuration says nothing about whether the ingest will
//   accept the stream. That has not been tried with a real key.
// - By default the request matches OBS's (frontend/utility/GoLiveAPI_PostData.cpp, system-info-*.cpp),
//   read from OBS 33.0.1. Two differences are on purpose: supported_codecs stays H.264 because Relay
//   only encodes H.264 (OBS lists what its encoders support, and H.265/AV1 could come back), and the
//   CPU, memory and OS are this machine's.

import fs from 'node:fs';
import os from 'node:os';
import { FEEDS, type Feed } from '../../../../shared/types.js';
import { fetchJson, PlatformHttpError } from '../common/http.js';
import { DriverError, type IvsTrack, type PushPlan } from '../types.js';
import { appendQuery, type ReportedClient, type VideoFormat } from './options.js';
import { DEFAULT_REPORTED_GPU, type ReportedGpu } from './reported-gpus.js';

export const CLIENT_CONFIG_URL = 'https://ingest.twitch.tv/api/v3/GetClientConfiguration';
const SCHEMA_VERSION = '2025-01-25';
const CONFIG_TIMEOUT_MS = 10_000;
const FALLBACK = 'Use "OBS sends Dual Format directly" instead.';
/** Twitch Dual Format's minimum: two tracks per canvas (the full-size one and a small one). */
export const MIN_DUAL_FORMAT_TRACKS = 4;
/** x264 preset for the tracks Relay encodes (override with CTD_X264_PRESET). */
export const DEFAULT_X264_PRESET = 'veryfast';
const X264_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'];

/** What the "OBS Studio" client identity reports: the OBS release the request was copied from. */
export const OBS_CLIENT_VERSION = '33.0.1';
/** OBS's HTTP client (frontend/utility/RemoteTextThread.cpp). */
export const OBS_USER_AGENT = `obs-basic ${OBS_CLIENT_VERSION}`;
const MAX_SYSTEM_VERSION_LENGTH = 128;

interface Framerate {
  numerator?: number;
  denominator?: number;
}

export interface ClientConfigResponse {
  meta?: { service?: string; schema_version?: string; config_id?: string } | null;
  status?: { result?: string | null; html_en_us?: string | null } | null;
  ingest_endpoints?: { protocol?: string; url_template?: string; authentication?: string | null }[] | null;
  encoder_configurations?:
    | {
        type?: string;
        width?: number;
        height?: number;
        framerate?: Framerate | null;
        canvas_index?: number;
        settings?: { bitrate?: number; keyint_sec?: number; profile?: string; bf?: number } | null;
      }[]
    | null;
  audio_configurations?: {
    live?: { codec?: string; track_id?: number; channels?: number; settings?: { bitrate?: number } | null }[] | null;
    vod?: unknown[] | null;
  } | null;
}

export interface MultitrackInput {
  /** The channel's stream key from Helix (no query string). */
  streamKey: string;
  landscape: VideoFormat;
  vertical: VideoFormat;
  /** Ingest server override (rtmp/rtmps base URL), or null to use the endpoint Twitch returns. */
  ingestServer: string | null;
  bandwidthTest: boolean;
  /** Most video tracks Twitch may ask for (at least 4: two per canvas). */
  maxTracks?: number;
  /** The GPU described to Twitch (default: DEFAULT_REPORTED_GPU). */
  gpu?: ReportedGpu;
  /** Who the request says it comes from (default: 'obs'). */
  client?: ReportedClient;
  /** Version reported by the 'relay' client. */
  clientVersion?: string;
}

/** Collapse Twitch's HTML status message into plain text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function rejected(reason: string): DriverError {
  const text = reason.trim().replace(/[\s.!]+$/, '') || 'unknown reason';
  return new DriverError(`Twitch rejected relay Dual Format: ${text}. ${FALLBACK}`, 'misconfigured');
}

function canvas(f: VideoFormat): Record<string, unknown> {
  return { width: f.width, height: f.height, canvas_width: f.width, canvas_height: f.height, framerate: f.fps };
}

export interface HostInfo {
  platform: NodeJS.Platform;
  /** os.release(): "10.0.19045" on Windows, the kernel release on Linux. */
  release: string;
  /** os.version(): the kernel build string on Linux. */
  version: string;
  arch: string;
  /** Contents of /etc/os-release, when there is one. */
  osRelease: string | null;
}

function hostInfo(): HostInfo {
  const platform = os.platform();
  let osRelease: string | null = null;
  if (platform === 'linux') {
    try {
      osRelease = fs.readFileSync('/etc/os-release', 'utf8');
    } catch {
      // not every system has it
    }
  }
  return { platform, release: os.release(), version: os.version(), arch: os.arch(), osRelease };
}

function osReleaseField(text: string | null, field: string): string {
  const line = text?.split('\n').find((l) => l.startsWith(`${field}=`));
  return line ? line.slice(field.length + 1).replace(/"/g, '').trim() : '';
}

/** This machine's OS, in the shape OBS reports it (system-info-windows.cpp, system-info-posix.cpp). */
export function reportedSystem(host: HostInfo): Record<string, unknown> {
  const common = { bits: /64/.test(host.arch) ? 64 : 32, arm: host.arch.startsWith('arm') || host.arch === 'aarch64', armEmulation: false };
  if (host.platform === 'win32') {
    const [major = '10', minor = '0', build = '0'] = host.release.split('.');
    return { version: `${major}.${minor}`, name: 'Windows', build: Number(build) || 0, release: 'unavailable', revision: '0', ...common };
  }
  if (host.platform === 'linux') {
    return {
      version: `Linux ${host.release} ${host.version}`.slice(0, MAX_SYSTEM_VERSION_LENGTH),
      name: osReleaseField(host.osRelease, 'NAME') || 'Linux-based distribution',
      build: 0,
      release: osReleaseField(host.osRelease, 'VERSION_ID') || 'unknown',
      revision: '',
      ...common,
    };
  }
  return { version: host.version, name: host.platform === 'darwin' ? 'macOS' : host.platform, build: 0, release: host.release, revision: '', ...common };
}

/** This machine's CPU, memory and OS, plus the reported GPU. */
function capabilities(gpu: ReportedGpu): Record<string, unknown> {
  const cpus = os.cpus();
  return {
    cpu: {
      physical_cores: cpus.length || 1,
      logical_cores: os.availableParallelism?.() ?? (cpus.length || 1),
      ...(cpus[0]?.speed ? { speed: cpus[0].speed } : {}),
      ...(cpus[0]?.model ? { name: cpus[0].model.trim() } : {}),
    },
    memory: { total: os.totalmem(), free: os.freemem() },
    gaming_features: null,
    system: reportedSystem(hostInfo()),
    gpu: [gpu],
  };
}

function clientInfo(input: MultitrackInput): { name: string; version: string } {
  if ((input.client ?? 'obs') === 'obs') return { name: 'obs-studio', version: OBS_CLIENT_VERSION };
  return { name: 'ctd-relay', version: input.clientVersion ?? process.env.npm_package_version ?? '0' };
}

/** The GetClientConfiguration request for two canvases: landscape (0) and vertical (1). */
export function buildConfigRequest(input: MultitrackInput): Record<string, unknown> {
  return {
    service: 'IVS',
    schema_version: SCHEMA_VERSION,
    authentication: input.streamKey,
    client: { ...clientInfo(input), supported_codecs: ['h264'] },
    capabilities: capabilities(input.gpu ?? DEFAULT_REPORTED_GPU),
    preferences: {
      maximum_aggregate_bitrate: null,
      // Every track costs CPU on this server: ask for Dual Format's minimum unless told otherwise.
      maximum_video_tracks: Math.max(MIN_DUAL_FORMAT_TRACKS, Math.floor(input.maxTracks ?? MIN_DUAL_FORMAT_TRACKS)),
      vod_track_audio: false,
      composition_gpu_index: 0,
      audio_samples_per_sec: 48_000,
      audio_channels: 2,
      audio_max_buffering_ms: 960,
      audio_fixed_buffering: false,
      canvases: [canvas(input.landscape), canvas(input.vertical)],
    },
  };
}

/** POST the request. HTTP/parse failures become DriverErrors (rejections are 'misconfigured'). */
export async function fetchClientConfig(
  body: Record<string, unknown>,
  signal: AbortSignal,
  url = CLIENT_CONFIG_URL,
  userAgent?: string,
): Promise<ClientConfigResponse> {
  try {
    const json = await fetchJson<ClientConfigResponse>(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(userAgent ? { 'user-agent': userAgent } : {}) },
      body: JSON.stringify(body),
      signal,
      timeoutMs: CONFIG_TIMEOUT_MS,
    });
    if (!json || typeof json !== 'object') throw rejected('empty configuration response');
    return json;
  } catch (err) {
    if (err instanceof DriverError || (err instanceof Error && err.name === 'AbortError')) throw err;
    if (err instanceof PlatformHttpError) {
      if (err.status >= 500 || err.status === 429) {
        throw new DriverError(`Twitch's Enhanced Broadcasting service is unavailable (HTTP ${err.status})`, 'platform-error');
      }
      throw rejected(statusText(err.body) || `HTTP ${err.status}`);
    }
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new DriverError("Twitch's Enhanced Broadcasting service did not respond in time", 'timeout');
    }
    throw new DriverError("Couldn't reach Twitch's Enhanced Broadcasting service", 'platform-error');
  }
}

/** status.html_en_us / message from an error body, as plain text. */
function statusText(body: string): string {
  try {
    const j = JSON.parse(body) as { status?: { html_en_us?: unknown } | unknown; message?: unknown; error?: unknown };
    const status = j.status && typeof j.status === 'object' ? (j.status as { html_en_us?: unknown }) : null;
    const text = status?.html_en_us ?? j.message ?? j.error;
    return typeof text === 'string' ? stripHtml(text) : '';
  } catch {
    return '';
  }
}

function codecOf(encoderType: string): 'h264' | 'hevc' | 'av1' {
  if (/hevc|h265|265/i.test(encoderType)) return 'hevc';
  if (/av1/i.test(encoderType)) return 'av1';
  return 'h264';
}

function profileOf(value: unknown): IvsTrack['profile'] {
  return value === 'main' || value === 'baseline' ? value : 'high';
}

function x264Preset(): string {
  const p = process.env.CTD_X264_PRESET?.trim().toLowerCase();
  return p && X264_PRESETS.includes(p) ? p : DEFAULT_X264_PRESET;
}

/**
 * Turn Twitch's configuration into what Relay encodes: one H.264 track per encoder configuration
 * (array index = track id, canvas 0 = landscape, 1 = vertical), at exactly the size, frame rate and
 * bitrate Twitch asked for. `warn` receives non-fatal status warnings.
 */
export function planFromConfig(config: ClientConfigResponse, input: MultitrackInput, warn: (msg: string) => void = () => {}): PushPlan {
  const status = config.status ?? null;
  const statusMsg = status?.html_en_us ? stripHtml(status.html_en_us) : '';
  const encoders = config.encoder_configurations ?? [];
  if (status?.result === 'error') throw rejected(statusMsg || 'the configuration request failed');
  if (status?.result === 'warning') {
    if (encoders.length === 0) throw rejected(statusMsg || 'no encoder configuration returned');
    if (statusMsg) warn(statusMsg);
  }
  if (encoders.length === 0) throw rejected('no encoder configuration returned');

  const tracks: IvsTrack[] = encoders.map((enc, i) => {
    const idx = enc.canvas_index ?? 0;
    const feed: Feed | undefined = FEEDS[idx];
    if (!feed) throw rejected(`it asked for an unknown canvas (${idx})`);
    const codec = codecOf(enc.type ?? '');
    if (codec !== 'h264') throw rejected(`it asked for ${codec.toUpperCase()} video; Relay encodes H.264`);
    const width = enc.width ?? 0;
    const height = enc.height ?? 0;
    const bitrate = enc.settings?.bitrate ?? 0;
    if (!(width >= 16 && height >= 16 && width <= 8192 && height <= 8192)) throw rejected(`track ${i} has no usable size`);
    if (!(bitrate > 0)) throw rejected(`track ${i} has no bitrate`);
    const fps = enc.framerate?.numerator && enc.framerate.denominator ? { numerator: enc.framerate.numerator, denominator: enc.framerate.denominator } : (idx === 0 ? input.landscape : input.vertical).fps;
    return {
      feed,
      width,
      height,
      fps,
      bitrateKbps: Math.round(bitrate),
      keyintSec: enc.settings?.keyint_sec && enc.settings.keyint_sec > 0 ? enc.settings.keyint_sec : 2,
      profile: profileOf(enc.settings?.profile),
      bframes: Math.max(0, Math.min(4, Math.round(enc.settings?.bf ?? 2))),
    };
  });
  if (tracks[0]!.feed !== 'landscape') throw rejected('its first track is not the landscape feed');
  if (!tracks.some((t) => t.feed === 'vertical')) throw rejected('it returned no track for the vertical feed (is Dual Format enabled for this channel?)');

  const liveAudio = config.audio_configurations?.live ?? [];
  if (liveAudio.length !== 1) throw rejected(`it asks for ${liveAudio.length} audio tracks; Relay sends exactly one`);
  const audio = liveAudio[0]!;
  if (audio.codec && audio.codec.toLowerCase() !== 'aac') throw rejected(`it asks for ${audio.codec} audio; Relay sends AAC`);

  return {
    url: ingestUrl(config, input),
    mode: 'ivs',
    feeds: ['landscape', 'vertical'],
    ivs: {
      tracks,
      audioBitrateKbps: audio.settings?.bitrate && audio.settings.bitrate > 0 ? Math.round(audio.settings.bitrate) : 160,
      audioChannels: audio.channels && audio.channels > 0 ? audio.channels : 2,
      preset: x264Preset(),
    },
  };
}

/** Pick an endpoint (RTMPS preferred) and build `<server>/<authentication>?...&clientConfigId=<id>`. */
function ingestUrl(config: ClientConfigResponse, input: MultitrackInput): string {
  const wantRtmps = input.ingestServer ? input.ingestServer.toLowerCase().startsWith('rtmps:') : true;
  const endpoints = (config.ingest_endpoints ?? []).filter(
    (e) => typeof e.url_template === 'string' && /^rtmp/i.test(e.protocol ?? '') && e.url_template.includes('{stream_key}'),
  );
  const endpoint =
    endpoints.find((e) => (e.protocol ?? '').toUpperCase() === (wantRtmps ? 'RTMPS' : 'RTMP')) ?? endpoints[0] ?? null;
  if (!endpoint && !input.ingestServer) throw rejected('it returned no RTMP ingest endpoint');

  const key = endpoint?.authentication?.trim() || input.streamKey;
  let base: string;
  if (input.ingestServer) {
    base = `${input.ingestServer.replace(/\/+$/, '')}/${key}`;
  } else {
    const template = endpoint!.url_template!;
    const cut = template.indexOf('/{stream_key}');
    const server = cut >= 0 ? template.slice(0, cut) : template.replace('{stream_key}', '').replace(/\/+$/, '');
    const templateQuery = template.includes('?') ? template.slice(template.indexOf('?')) : '';
    base = `${server}/${key}${templateQuery}`;
  }
  const query: [string, string][] = [];
  if (input.bandwidthTest) query.push(['bandwidthtest', 'true']);
  const configId = config.meta?.config_id?.trim();
  if (configId) query.push(['clientConfigId', configId]);
  return appendQuery(base, query);
}

/** Full flow: ask Twitch for a configuration describing both feeds and turn it into a push plan. */
export async function prepareMultitrack(
  input: MultitrackInput,
  signal: AbortSignal,
  warn?: (msg: string) => void,
  url?: string,
): Promise<PushPlan> {
  const userAgent = (input.client ?? 'obs') === 'obs' ? OBS_USER_AGENT : undefined;
  const config = await fetchClientConfig(buildConfigRequest(input), signal, url, userAgent);
  return planFromConfig(config, input, warn);
}
