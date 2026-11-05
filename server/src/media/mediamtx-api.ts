// Minimal MediaMTX control API client (v3, loopback only).
// https://github.com/bluenviron/mediamtx/blob/v1.21.2/api/openapi.yaml

import type { MtxPath, MtxPathList } from './feed-state.js';

export type FetchFn = typeof fetch;

const REQUEST_TIMEOUT_MS = 2_000;

/** Source type -> kick endpoint prefix. */
const KICK_ROUTES: Record<string, string> = {
  rtmpConn: 'rtmp/conns',
  rtmpsConn: 'rtmps/conns',
  srtConn: 'srt/conns',
  rtspSession: 'rtsp/sessions',
  rtspsSession: 'rtsps/sessions',
  webRTCSession: 'webrtc/sessions',
};

/** Source type -> connection lookup prefix (RTMP only: that's how OBS publishes). */
const CONN_ROUTES: Record<string, string> = {
  rtmpConn: 'rtmp/conns',
  rtmpsConn: 'rtmps/conns',
};

export interface MediaMtxApi {
  listPaths(signal?: AbortSignal): Promise<MtxPath[]>;
  /** Disconnect whoever is publishing to `pathName`. Returns false when nobody was. */
  kickPublisher(pathName: string): Promise<boolean>;
  /** The IP address publishing to `pathName` (OBS's machine), or null when nobody is. */
  publisherAddress(pathName: string): Promise<string | null>;
}

/** "10.20.30.40:61234" / "[::ffff:10.20.30.40]:61234" / "[fe80::1]:5" -> the IP alone. */
export function hostOfRemoteAddr(remoteAddr: unknown): string | null {
  if (typeof remoteAddr !== 'string' || !remoteAddr) return null;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(remoteAddr);
  let host: string;
  if (bracketed) host = bracketed[1]!;
  else if (remoteAddr.split(':').length === 2) host = remoteAddr.slice(0, remoteAddr.indexOf(':')); // IPv4:port
  else host = remoteAddr; // a bare address
  host = host.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  return host || null;
}

export function createMediaMtxApi(port: number, fetchImpl: FetchFn = fetch): MediaMtxApi {
  const base = `http://127.0.0.1:${port}/v3`;

  const call = async (method: 'GET' | 'POST', route: string, signal?: AbortSignal): Promise<Response> => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await fetchImpl(`${base}/${route}`, {
      method,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`MediaMTX API ${method} /${route.split('/').slice(0, 2).join('/')} -> HTTP ${res.status}`);
    }
    return res;
  };

  const listPaths = async (signal?: AbortSignal): Promise<MtxPath[]> => {
    // Two static paths + the active paths of every other profile; one page is plenty.
    const res = await call('GET', 'paths/list?itemsPerPage=1000', signal);
    const body = (await res.json()) as MtxPathList;
    return Array.isArray(body.items) ? body.items : [];
  };

  return {
    listPaths,
    async kickPublisher(pathName) {
      const item = (await listPaths()).find((p) => p.name === pathName);
      const source = item?.source;
      const route = source?.type ? KICK_ROUTES[source.type] : undefined;
      if (!source?.id || !route) return false;
      const res = await call('POST', `${route}/kick/${encodeURIComponent(source.id)}`);
      await res.body?.cancel().catch(() => {});
      return true;
    },
    async publisherAddress(pathName) {
      const item = (await listPaths()).find((p) => p.name === pathName);
      const source = item?.source;
      const route = source?.type ? CONN_ROUTES[source.type] : undefined;
      if (!source?.id || !route) return null;
      const res = await call('GET', `${route}/get/${encodeURIComponent(source.id)}`);
      const conn = (await res.json()) as { remoteAddr?: unknown };
      return hostOfRemoteAddr(conn.remoteAddr);
    },
  };
}
