// SRT (docs/SRT.md): low-delay ingest and pull links over one UDP port of the bundled MediaMTX.
// Same paths and keys as RTMP: the key travels inside SRT's `streamid`
// (`publish:<path>:key=<k>` / `read:<path>:key=<k>`), which MediaMTX hands to Relay's auth hook as
// the query `key=<k>`, so every RTMP rule applies unchanged (an ingest key never reads, a read key
// never publishes, the reader cap, rotate and revoke).

/** Default UDP port of the SRT listener (env SRT_PORT; 0 turns SRT off). */
export const DEFAULT_SRT_PORT = 8890;

/**
 * SRT receive latency, in milliseconds. SRT holds every packet this long so lost ones can be resent;
 * the two ends use the larger of their two values. Rule of thumb: about 4 × the round trip.
 * The links Relay hands out carry the internet value (senders and players are often on another
 * network, through a forwarded UDP port); on a good link it can go lower, and on a LAN 150 ms is enough.
 */
export const SRT_LATENCY_INTERNET_MS = 500;
export const SRT_LATENCY_LAN_MS = 150;
/** What the links carry. */
export const SRT_LATENCY_DEFAULT_MS = SRT_LATENCY_INTERNET_MS;

/**
 * FFmpeg's libsrt and OBS read `latency=` in the URL in **microseconds** (FFmpeg docs → Protocols →
 * srt → latency), so 500 ms is `latency=500000`.
 */
export function srtLatencyParam(ms: number): string {
  return `latency=${Math.round(ms * 1000)}`;
}

/** Whether SRT works on this server, for the UI and the API (never contains a key). */
export interface SrtStatus {
  /** The SRT listener is running (SRT_PORT > 0 and the UDP port could be bound). */
  enabled: boolean;
  /** UDP port inside the container (what to map/forward), or null when SRT is off. */
  port: number | null;
  /** Latency (ms) built into the links: the internet value (lower it on a good link). */
  latencyMs: number;
  /** Latency (ms) enough when sender and Relay (or Relay and player) share a LAN. */
  lanLatencyMs: number;
  /** Why SRT is off (plain words), null when it's on. */
  reason: string | null;
}

export function srtStatusOff(reason: string): SrtStatus {
  return { enabled: false, port: null, latencyMs: SRT_LATENCY_DEFAULT_MS, lanLatencyMs: SRT_LATENCY_LAN_MS, reason };
}

export function srtStatusOn(port: number): SrtStatus {
  return { enabled: true, port, latencyMs: SRT_LATENCY_DEFAULT_MS, lanLatencyMs: SRT_LATENCY_LAN_MS, reason: null };
}

/**
 * `srt://<host>:<port>?streamid=<mode>:<path>:key=<key>&latency=<µs>`. `path` is the MediaMTX path
 * (`live/landscape`, `live/<slug>/vertical`, `guest/<slot>`). Keys are URL-safe, so nothing needs
 * escaping; the `=` inside the streamid value is fine for FFmpeg/OBS (they split on `&`).
 */
export function srtUrl(host: string, port: number, mode: 'publish' | 'read', path: string, key: string, latencyMs = SRT_LATENCY_DEFAULT_MS): string {
  return `srt://${host}:${port}?streamid=${mode}:${path}:key=${key}&${srtLatencyParam(latencyMs)}`;
}

/**
 * The SRT publish URL for an RTMP app + OBS "Stream Key" field (`landscape?key=…`,
 * `<slug>/landscape?key=…`, `<slot>?key=…`). Null when the field has no key.
 */
export function srtPublishUrlFromStreamKey(host: string, port: number, app: string, streamKeyField: string, latencyMs = SRT_LATENCY_DEFAULT_MS): string | null {
  const q = streamKeyField.indexOf('?');
  if (q < 0) return null;
  const key = new URLSearchParams(streamKeyField.slice(q + 1)).get('key');
  if (!key) return null;
  return srtUrl(host, port, 'publish', `${app}/${streamKeyField.slice(0, q)}`, key, latencyMs);
}

/** The same link with the latency swapped (e.g. the internet suggestion). */
export function withSrtLatency(url: string, latencyMs: number): string {
  return url.replace(/([?&])latency=\d+/, `$1${srtLatencyParam(latencyMs)}`);
}

/** The link with its key hidden, for showing on screen. */
export function maskSrtUrl(url: string): string {
  return url.replace(/(:key=)[^&]*/, '$1••••••••');
}
