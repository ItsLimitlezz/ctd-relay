// Profiles in the external API (docs/API.md §9.1): list items and the OBS ingest settings.

import { FEEDS, type ProfileSummary } from '../../../shared/types.js';
import type { AppServices } from '../services.js';
import { LAN_HTTP_HOST_ENV } from './access.js';
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

/**
 * Host OBS should stream to: the OBS host set in Settings (what the web UI's OBS setup shows), else
 * LAN_HTTP_HOST (the NAS address for LAN apps), else the host the app used to reach the API.
 */
export function obsHost(opts: { ingestHostSetting: string; lanHttpHost: string | undefined; requestHostname: string }): string {
  for (const candidate of [opts.ingestHostSetting, opts.lanHttpHost ?? '', opts.requestHostname]) {
    const host = hostOnly(candidate);
    if (host) return host;
  }
  return 'localhost';
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
