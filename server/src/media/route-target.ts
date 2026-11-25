// Custom RTMP(S) targets of guest feed routes: what may be pushed to (docs/GUEST-FEEDS.md → Routing).
//
// - rtmp:// or rtmps:// only (no file:, pipe:, tcp:, srt:..., nothing FFmpeg would open locally).
// - Never loopback, link-local or unspecified/multicast hosts (this server's own services, cloud
//   metadata endpoints). Private LAN hosts (RFC 1918, CGNAT, IPv6 ULA) are allowed unless the owner
//   turns that off (Settings → Guest feed routing, `allowLan`).
// - Never this Relay's own RTMP port (loop protection: a route must not feed Relay back into itself;
//   to send a guest into a profile, use a profile route).
//
// Names are resolved once when the route is saved and again each time it starts (an up-front check,
// not an egress filter: FFmpeg resolves the name again itself).

import dns from 'node:dns/promises';
import os from 'node:os';
import { rtmpUrlProblem, streamKeyProblem } from '../platforms/custom/url.js';
import { classifyIp } from '../tls/public-ip.js';

export type HostLookup = (hostname: string) => Promise<string[]>;

export interface RouteTargetPolicy {
  allowLan: boolean;
  /** This Relay's RTMP port (loop protection). */
  rtmpPort: number;
  /** Host names/addresses this Relay is reached at (ingest host, public host); its interfaces are added. */
  selfHosts?: readonly string[];
  lookup?: HostLookup;
  /** This machine's addresses (default: os.networkInterfaces()). */
  localAddresses?: () => string[];
}

const LOOKUP_TIMEOUT_MS = 5_000;

const defaultLookup: HostLookup = async (hostname) => (await dns.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

function interfaceAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) out.push(a.address.toLowerCase());
  return out;
}

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
}

/** 0.0.0.0/8, multicast, broadcast and IPv6 unspecified/multicast: never a real server. */
function isUnspecifiedOrMulticast(ip: string): boolean {
  const v4 = /^(\d+)\.\d+\.\d+\.\d+$/.exec(ip);
  if (v4) {
    const first = Number(v4[1]);
    return first === 0 || first >= 224;
  }
  const lower = ip.toLowerCase();
  return lower === '::' || lower.startsWith('ff');
}

/** Why an address is refused, or null. */
function addressProblem(ip: string, allowLan: boolean): string | null {
  const cls = classifyIp(ip);
  if (cls === 'loopback') return 'points to this server (loopback)';
  if (cls === 'link-local') return 'points to a link-local address';
  if (cls === 'reserved' && isUnspecifiedOrMulticast(ip)) return 'points to an unspecified or multicast address';
  if (!allowLan && (cls === 'private' || cls === 'cgnat' || cls === 'ula')) {
    return 'points to a private LAN address, and LAN targets are turned off (Settings → Guest feed routing)';
  }
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('DNS lookup timed out')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Why a custom target can't be used, or null. `streamKey` is checked for spaces/control characters
 * only. Messages never repeat the URL's path or the key.
 */
export async function routeTargetProblem(rawUrl: string, streamKey: string | null, policy: RouteTargetPolicy): Promise<string | null> {
  const syntax = rtmpUrlProblem(rawUrl, 'Server URL');
  if (syntax) return syntax;
  if (streamKey) {
    const keyProblem = streamKeyProblem(streamKey);
    if (keyProblem) return keyProblem;
  }
  const url = new URL(rawUrl.trim());
  if (url.username || url.password) return 'Server URL must not contain a user name or password (put credentials in the stream key)';
  const host = bareHost(url.hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return 'Server URL points to this server (localhost)';

  const port = url.port ? Number(url.port) : url.protocol === 'rtmps:' ? 443 : 1935;
  const local = (policy.localAddresses ?? interfaceAddresses)().map((a) => bareHost(a));
  const selfHosts = new Set([...(policy.selfHosts ?? []).map(bareHost).filter(Boolean), ...local]);

  let addresses: string[];
  if (classifyIp(host) !== 'invalid') {
    addresses = [host];
  } else {
    try {
      addresses = await withTimeout((policy.lookup ?? defaultLookup)(host), LOOKUP_TIMEOUT_MS);
    } catch {
      // Doesn't resolve (yet): allowed; it is checked again when the route starts and FFmpeg fails clearly.
      addresses = [];
    }
  }
  for (const ip of addresses) {
    const problem = addressProblem(bareHost(ip), policy.allowLan);
    if (problem) return `Server URL ${problem}`;
  }
  if (port === policy.rtmpPort && (selfHosts.has(host) || addresses.some((a) => selfHosts.has(bareHost(a))))) {
    return "Server URL points to this Relay's own RTMP port. A route can't send a guest feed back into Relay; use \"Send to a profile\" instead";
  }
  return null;
}
