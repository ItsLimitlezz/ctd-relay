// Twitch destination options (see PlatformInfo.destinationFields in index.ts) and ingest URL helpers.

import type { Destination } from '../../../../shared/types.js';
import { CUSTOM_GPU_EXAMPLE, CUSTOM_GPU_ID, DEFAULT_REPORTED_GPU, DEFAULT_REPORTED_GPU_ID, parseCustomGpu, reportedGpuPreset, type ReportedGpu } from './reported-gpus.js';

/**
 * Twitch's recommended global ingest ("Default" entry of https://ingest.twitch.tv/ingests,
 * checked Oct 2026: rtmps://ingest.global-contribute.live-video.net/app/{stream_key}).
 */
export const DEFAULT_INGEST = 'rtmps://ingest.global-contribute.live-video.net/app';

export type DualFormatMode = 'off' | 'obs-direct' | 'relay-multitrack';
export const DUAL_FORMAT_MODES: readonly DualFormatMode[] = ['off', 'obs-direct', 'relay-multitrack'];

/** Who "Relay both feeds" says it is: OBS Studio (same requests as real OBS) or CTD Relay. */
export type ReportedClient = 'obs' | 'relay';
export const REPORTED_CLIENTS: readonly ReportedClient[] = ['obs', 'relay'];
export const DEFAULT_REPORTED_CLIENT: ReportedClient = 'obs';

/** Output format of one feed, described to Twitch's Enhanced Broadcasting config service. */
export interface VideoFormat {
  width: number;
  height: number;
  fps: { numerator: number; denominator: number };
}

export const DEFAULT_LANDSCAPE_FORMAT = '1920x1080@60';
export const DEFAULT_VERTICAL_FORMAT = '1080x1920@60';

export interface TwitchDestinationOptions {
  dualFormat: DualFormatMode;
  /** Ingest base URL override (rtmp/rtmps, no key), or null for the default. */
  ingestServer: string | null;
  bandwidthTest: boolean;
  landscapeFormat: VideoFormat;
  verticalFormat: VideoFormat;
  /** The GPU described to Twitch by "Relay both feeds". */
  reportedGpu: ReportedGpu;
  reportedClient: ReportedClient;
}

const FORMAT_RE = /^(\d{2,5})\s*x\s*(\d{2,5})(?:\s*@\s*(\d{1,3}(?:\.\d{1,3})?|\d{1,6}\/\d{1,6}))?$/i;

/** '1920x1080@60', '1280x720@29.97', '1080x1920@30000/1001', '1920x1080' (= 30 fps). */
export function parseVideoFormat(value: string): VideoFormat | null {
  const m = FORMAT_RE.exec(value.trim());
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 16 || height < 16 || width > 8192 || height > 8192) return null;
  const fps = parseFps(m[3] ?? '30');
  return fps ? { width, height, fps } : null;
}

function parseFps(raw: string): VideoFormat['fps'] | null {
  if (raw.includes('/')) {
    const [n, d] = raw.split('/').map(Number);
    if (!n || !d || n / d > 240) return null;
    return { numerator: n, denominator: d };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 240) return null;
  if (Number.isInteger(value)) return { numerator: value, denominator: 1 };
  // NTSC rates: 23.976, 29.97, 59.94 ... -> 24000/1001, 30000/1001, 60000/1001.
  const ntsc = Math.round(value * 1.001);
  if (Math.abs(ntsc / 1.001 - value) < 0.01) return { numerator: ntsc * 1000, denominator: 1001 };
  return { numerator: Math.round(value * 1000), denominator: 1000 };
}

export function formatToString(f: VideoFormat): string {
  const fps = f.fps.denominator === 1 ? `${f.fps.numerator}` : (f.fps.numerator / f.fps.denominator).toFixed(2);
  return `${f.width}x${f.height}@${fps}`;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Accept the URL template as listed on ingest.twitch.tv (".../app/{stream_key}"): drop the
 * trailing {stream_key} placeholder so only the server part is kept.
 */
export function normalizeIngestServer(value: string): string {
  return value.trim().replace(/\/*(?:\{stream_key\}|%7Bstream_key%7D)$/i, '');
}

/** True for an rtmp(s):// URL with a host and no query/fragment/credentials/template placeholders. */
export function isValidIngestServer(value: string): boolean {
  if (/[\s{}]/.test(value) || /%7B|%7D/i.test(value)) return false;
  try {
    const u = new URL(value);
    return (u.protocol === 'rtmp:' || u.protocol === 'rtmps:') && !!u.hostname && !u.search && !u.hash && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Parse the destination's options. Invalid values are reported in `problems` and replaced by defaults. */
export function readOptions(dest: Pick<Destination, 'options'>): { options: TwitchDestinationOptions; problems: string[] } {
  const o = dest.options ?? {};
  const problems: string[] = [];

  const rawMode = str(o.dualFormat) || 'off';
  let dualFormat: DualFormatMode = 'off';
  if ((DUAL_FORMAT_MODES as readonly string[]).includes(rawMode)) dualFormat = rawMode as DualFormatMode;
  else problems.push(`Unknown Dual Format mode "${rawMode.slice(0, 40)}"`);

  let ingestServer: string | null = normalizeIngestServer(str(o.ingestServer)) || null;
  if (ingestServer && !isValidIngestServer(ingestServer)) {
    problems.push('Ingest server must be an rtmp:// or rtmps:// URL without a stream key or query string');
    ingestServer = null;
  }

  const format = (key: string, label: string, fallback: string): VideoFormat => {
    const raw = str(o[key]);
    const parsed = parseVideoFormat(raw || fallback);
    if (parsed) return parsed;
    if (dualFormat === 'relay-multitrack') problems.push(`${label} must look like 1920x1080@60`);
    return parseVideoFormat(fallback)!;
  };

  // Like the feed formats, these only matter for "Relay both feeds".
  const relayMode = dualFormat === 'relay-multitrack';
  const rawGpu = str(o.reportedGpu) || DEFAULT_REPORTED_GPU_ID;
  let reportedGpu = DEFAULT_REPORTED_GPU;
  if (rawGpu === CUSTOM_GPU_ID) {
    const custom = parseCustomGpu(str(o.customGpu));
    if (custom) reportedGpu = custom;
    else if (relayMode) problems.push(`Custom GPU must look like ${CUSTOM_GPU_EXAMPLE}`);
  } else {
    const known = reportedGpuPreset(rawGpu);
    if (known) reportedGpu = known;
    else if (relayMode) problems.push(`Unknown reported GPU "${rawGpu.slice(0, 40)}"`);
  }

  const rawClient = str(o.reportedClient) || DEFAULT_REPORTED_CLIENT;
  let reportedClient = DEFAULT_REPORTED_CLIENT;
  if ((REPORTED_CLIENTS as readonly string[]).includes(rawClient)) reportedClient = rawClient as ReportedClient;
  else if (relayMode) problems.push(`Unknown reported client "${rawClient.slice(0, 40)}"`);

  return {
    options: {
      dualFormat,
      ingestServer,
      bandwidthTest: o.bandwidthTest === true || o.bandwidthTest === 'true',
      landscapeFormat: format('landscapeFormat', 'Landscape feed format', DEFAULT_LANDSCAPE_FORMAT),
      verticalFormat: format('verticalFormat', 'Vertical feed format', DEFAULT_VERTICAL_FORMAT),
      reportedGpu,
      reportedClient,
    },
    problems,
  };
}

/** Append `key=value` query items to a URL-ish string (also works for rtmp:// keys). */
export function appendQuery(url: string, items: [string, string][]): string {
  if (items.length === 0) return url;
  const query = items.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

/** `<server>/<key>` with exactly one slash, plus `?bandwidthtest=true` when testing. */
export function buildIngestUrl(server: string, streamKey: string, bandwidthTest: boolean): string {
  const base = server.trim().replace(/\/+$/, '');
  const key = streamKey.trim().replace(/^\/+/, '');
  return appendQuery(`${base}/${key}`, bandwidthTest ? [['bandwidthtest', 'true']] : []);
}
