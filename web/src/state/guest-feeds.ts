// Guest feeds in the web UI (docs/GUEST-FEEDS.md): pure helpers for the Guest feeds card.

import { SRT_LATENCY_DEFAULT_MS, SRT_LATENCY_LAN_MS, srtLatencyParam } from '@shared/srt';
import { codecLabel } from '@shared/feed-codec';
import { formatKbps, guestOrientation, type GuestFeed, type GuestFeedList, type GuestIngestInfo } from '@shared/guest-feeds';
import type { FeedState } from '@shared/types';
import { guestLiveUrl, guestPreviewUrl } from '../api';
import type { StreamSource } from './feed-preview';

/** The guest feed as a FeedState, for the shared thumbnail and player (framed by its orientation). */
export function guestFeedState(g: GuestFeed, profileId: string): FeedState {
  return { profileId, feed: guestOrientation(g), online: g.online, since: g.since, video: g.video, audio: g.audio, bitrateKbps: g.bitrateKbps };
}

export function guestSource(profileId: string, g: GuestFeed): StreamSource {
  return {
    previewUrl: guestPreviewUrl(profileId, g.slot),
    liveUrl: guestLiveUrl(profileId, g.slot),
    label: `Extra feed "${g.name}"`,
    problem: g.problem,
    offlineText: "Nothing is being sent to this feed. The player starts when it is.",
    note: 'What is sent to this feed, unchanged (not re-encoded). Muted until you turn the sound on. Closing this stops it.',
  };
}

/** "1280×720 · H.264 · AAC · 3.5 Mbps", or null while offline. */
export function guestMediaLine(g: GuestFeed): string | null {
  if (!g.online) return null;
  const parts: string[] = [];
  if (g.video?.width && g.video.height) parts.push(`${g.video.width}×${g.video.height}`);
  if (g.video?.codec) parts.push(codecLabel(g.video.codec));
  if (g.audio?.codec) parts.push(codecLabel(g.audio.codec));
  const rate = formatKbps(g.bitrateKbps);
  if (rate) parts.push(rate);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export type GuestStatus = { label: string; tone: 'success' | 'neutral' | 'warn' | 'danger' };

export function guestStatus(g: GuestFeed): GuestStatus {
  if (g.key === 'revoked') return { label: 'Key revoked', tone: 'danger' };
  if (g.online) return { label: 'Online', tone: 'success' };
  return { label: 'Offline', tone: 'neutral' };
}

/** The bitrate warning, or null. */
export function bitrateWarning(g: GuestFeed, list: Pick<GuestFeedList, 'warnAboveKbps' | 'maxKbps'>): string | null {
  if (g.limitedAt) {
    return `Relay disconnected this guest for sending more than ${formatKbps(list.maxKbps)}. Ask them to lower their bitrate.`;
  }
  if (!g.bitrateWarning) return null;
  return `Above ${formatKbps(list.warnAboveKbps)}: ask the guest to lower their bitrate (it costs your server's bandwidth).`;
}

/** What "Copy ingest details" puts on the clipboard (the key is in it: share it only with the guest). */
export function ingestText(name: string, info: GuestIngestInfo): string | null {
  if (!info.streamKey || !info.fullUrl) return null;
  const lines = [`CTD Relay guest feed: ${name}`, `Server: ${info.serverUrl}`, `Stream key: ${info.streamKey}`, `Full URL (Larix and other one-field apps): ${info.fullUrl}`];
  if (info.srtUrl) {
    lines.push(
      `Lower delay, SRT (OBS: Settings → Stream → Service "Custom…" → Server = this, Stream Key empty): ${info.srtUrl}`,
      `(latency= is in microseconds: ${srtLatencyParam(info.srt?.latencyMs ?? SRT_LATENCY_DEFAULT_MS)} suits the internet and can go lower on a good link; on the same LAN as Relay ${srtLatencyParam(info.srt?.lanLatencyMs ?? SRT_LATENCY_LAN_MS)} is enough.)`,
    );
  }
  if (info.srtla) {
    lines.push(
      `Bonded cellular, SRTLA (Moblin: Settings → Streams → URL): ${info.srtla.url}`,
      `(BELABOX, manual relay server: SRTLA receiver address ${info.srtla.host}, port ${info.srtla.port} UDP, SRT streamid ${info.srtla.streamId})`,
    );
  }
  lines.push('Video: H.264, Audio: AAC, keyframe every 2 s, CBR.');
  return lines.join('\n');
}

/** Replace one slot in the list (a guest-feed socket message); unknown slots are ignored (a refetch adds them). */
export function applyGuestFeed(list: GuestFeedList | null, g: GuestFeed): GuestFeedList | null {
  if (!list || !list.guestFeeds.some((x) => x.slot === g.slot)) return list;
  return { ...list, guestFeeds: list.guestFeeds.map((x) => (x.slot === g.slot ? g : x)) };
}
