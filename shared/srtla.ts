// SRTLA (docs/SRTLA.md): SRT link aggregation, for bonded cellular + Wi-Fi senders (BELABOX, Moblin).
// Relay runs upstream `srtla_rec` (BELABOX/srtla, pinned) on its own UDP port; it forwards the SRT
// packets it reassembles to the local MediaMTX SRT listener (127.0.0.1:SRT_PORT). The SRT handshake,
// and so the `streamid` with the key, passes through unchanged: the same paths and keys as SRT
// (`publish:<path>:key=<k>`), the same auth hook.

/** Default UDP port of the SRTLA receiver (env SRTLA_PORT; 0 turns SRTLA off). BELABOX's own default. */
export const DEFAULT_SRTLA_PORT = 5000;

/** Default cap on bonded senders publishing at once (env SRTLA_MAX_GROUPS). */
export const DEFAULT_SRTLA_MAX_GROUPS = 4;

/** Upstream receiver: https://github.com/BELABOX/srtla, AGPL-3.0. Also pinned in Dockerfile + setup-tools. */
export const SRTLA_UPSTREAM_COMMIT = '37862da3d0c13b46956efd3f88877053293d97d6';

/** Whether SRTLA works on this server, for the UI and the API (never contains a key). */
export interface SrtlaStatus {
  /** The receiver is running (SRTLA_PORT > 0, SRT on, the binary found, the UDP port free). */
  enabled: boolean;
  /** UDP port inside the container (what to map and forward), or null when SRTLA is off. */
  port: number | null;
  /** Bonded senders that may publish at once (SRTLA_MAX_GROUPS). */
  maxGroups: number;
  /**
   * Whether Relay can show how many links a bonded sender uses. Always false: `srtla_rec` has no
   * stats output, and its log names a group by a memory address, never by stream (docs/SRTLA.md).
   */
  linkCounts: false;
  /** Why SRTLA is off (plain words), null when it's on. */
  reason: string | null;
}

export function srtlaStatusOff(reason: string, maxGroups = DEFAULT_SRTLA_MAX_GROUPS): SrtlaStatus {
  return { enabled: false, port: null, maxGroups, linkCounts: false, reason };
}

export function srtlaStatusOn(port: number, maxGroups = DEFAULT_SRTLA_MAX_GROUPS): SrtlaStatus {
  return { enabled: true, port, maxGroups, linkCounts: false, reason: null };
}

/**
 * What a bonded sender needs. BELABOX asks for the three fields (SRTLA address, SRTLA port, SRT
 * streamid); Moblin takes the one URL (`srtla://<host>:<port>?streamid=<streamId>`).
 */
export interface SrtlaEndpoint {
  host: string;
  port: number;
  /** `publish:<path>:key=<k>`: holds the publish key. */
  streamId: string;
  /** `srtla://<host>:<port>?streamid=publish:<path>:key=<k>` (Moblin's URL field). */
  url: string;
}

/** `path` is the MediaMTX path (`live/landscape`, `live/<slug>/vertical`, `guest/<slot>`). */
export function srtlaEndpoint(host: string, port: number, path: string, key: string): SrtlaEndpoint {
  const streamId = `publish:${path}:key=${key}`;
  return { host, port, streamId, url: `srtla://${host}:${port}?streamid=${streamId}` };
}

/**
 * The SRTLA endpoint for an RTMP app + OBS "Stream Key" field (`landscape?key=…`,
 * `<slug>/landscape?key=…`, `<slot>?key=…`). Null when the field has no key.
 */
export function srtlaEndpointFromStreamKey(host: string, port: number, app: string, streamKeyField: string): SrtlaEndpoint | null {
  const q = streamKeyField.indexOf('?');
  if (q < 0) return null;
  const key = new URLSearchParams(streamKeyField.slice(q + 1)).get('key');
  if (!key) return null;
  return srtlaEndpoint(host, port, `${app}/${streamKeyField.slice(0, q)}`, key);
}

/** A streamid or srtla:// URL with its key hidden, for showing on screen. */
export function maskSrtlaSecret(value: string): string {
  return value.replace(/(:key=)[^&\s]*/, '$1••••••••');
}
