// Profiles in the external API (docs/API.md §9.1): list items and the OBS ingest settings.

import { FEEDS, type ProfileSummary } from '../../../shared/types.js';
import type { AppServices } from '../services.js';
import { LAN_HTTP_HOST_ENV, isLocalHostName } from './access.js';
import { classifyIp, normalizeIp } from '../tls/public-ip.js';
import type { ApiIngest, ApiProfile } from './types.js';

/** A ProfileSummary as the API documents it (explicit fields, in documentation order). */
export function apiProfile(s: ProfileSummary): ApiProfile {
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    color: s.color,
    status: s.status,
    startedAt: s.startedAt,
    testMode: s.testMode === true,
    destinations: s.destinations,
    live: s.live,
    down: s.down,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** Host part of a URL-ish value ("10.20.30.40", "nas.lan:8443", "http://nas/", "[fd00::1]"), bracketed for IPv6. */
export function hostOnly(value: string): string {
  let host = value.trim();
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname;
    } catch {
      // keep as typed
    }
  }
  host = host.replace(/\/.*$/, '');
  if (!host.startsWith('[') && /^[^:]+:\d+$/.test(host)) host = host.slice(0, host.lastIndexOf(':'));
  if (host.startsWith('[')) host = host.slice(0, host.indexOf(']') + 1);
  else if (host.includes(':')) host = `[${host}]`;
  // Only characters a host name or IP literal can have (the value ends up in a URL).
  return /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)$/.test(host) ? host : '';
}

/** True when the host the client used is a public address or name (not LAN, loopback or a LAN-only name). */
function isPublicHost(host: string): boolean {
  const bare = host.startsWith('[') ? host.slice(1, -1) : host;
  const ip = normalizeIp(bare);
  if (ip) return !['private', 'cgnat', 'ula', 'loopback', 'link-local', 'invalid'].includes(classifyIp(ip));
  const name = bare.toLowerCase().replace(/\.$/, '');
  return name !== 'localhost' && !name.endsWith('.localhost') && !isLocalHostName(name);
}

/**
 * Host OBS should stream to: the OBS host set in Settings (what the web UI's OBS setup shows), else
 * the host the app used to reach the API when that is public (OBS reached Relay that way, so it can
 * again), else LAN_HTTP_HOST (the NAS address for LAN apps), else the request host as given.
 */
export function obsHost(opts: { ingestHostSetting: string; lanHttpHost: string | undefined; requestHostname: string }): string {
  const setting = hostOnly(opts.ingestHostSetting);
  if (setting) return setting;
  const requestHost = hostOnly(opts.requestHostname);
  if (requestHost && isPublicHost(requestHost)) return requestHost;
  return hostOnly(opts.lanHttpHost ?? '') || requestHost || 'localhost';
}

/** GET /profiles/{id}/ingest. Contains stream keys: never log it. */
export async function buildApiIngest(services: AppServices, profileId: string, requestHostname: string): Promise<ApiIngest> {
  const { media, config } = services;
  let setting = '';
  try {
    setting = services.appSettings().ingestHost ?? '';
  } catch {
    // defaults
  }
  const host = obsHost({ ingestHostSetting: setting, lanHttpHost: process.env[LAN_HTTP_HOST_ENV], requestHostname });
  const serverUrl = `rtmp://${host}:${config.rtmpPort}/${media.appName}`;
  const feeds: ApiIngest['feeds'] = [];
  for (const feed of FEEDS) {
    const streamKey = await media.streamKeyField(profileId, feed);
    feeds.push({ feed, streamKey, fullUrl: `${serverUrl}/${streamKey}` });
  }
  return { profileId, serverUrl, feeds };
}
