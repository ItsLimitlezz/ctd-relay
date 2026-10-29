// Chat song requests: what counts as a command, who may use it, cooldowns and which track to queue.
// The Spotify calls themselves live in music-service.ts.

import type { MusicTrack, SongRequestSettings, SongRequestWho } from '../../../shared/api.js';
import { badgesAndRoles } from '../api/chat-map.js';
import type { ApiRole } from '../api/types.js';
import { looksLikeLink, trackIdFrom } from './spotify.js';

export const DEFAULT_SONG_REQUESTS: SongRequestSettings = {
  enabled: false,
  who: 'everyone',
  cooldownSec: 60,
  maxDurationSec: 600,
  allowExplicit: true,
  chatReplies: true,
};

export const MAX_QUERY_LENGTH = 200;

export type ChatCommand = { kind: 'request'; query: string } | { kind: 'song' };

/** `!sr <song>` / `!songrequest <song>` (a request) and `!song` (what is playing); anything else is null. */
export function parseCommand(text: string): ChatCommand | null {
  const m = /^\s*!(sr|songrequest|song)(?:\s+([\s\S]*))?$/i.exec(text);
  if (!m) return null;
  const cmd = m[1]!.toLowerCase();
  const rest = (m[2] ?? '').replace(/\s+/g, ' ').trim();
  if (cmd === 'song') return rest ? null : { kind: 'song' };
  if (!rest) return null;
  return { kind: 'request', query: rest.slice(0, MAX_QUERY_LENGTH) };
}

export function rolesOf(badges: readonly string[] | undefined): ApiRole[] {
  return badgesAndRoles(badges).roles;
}

/** Moderators and the broadcaster: may always request, and have no cooldown. */
export function isPrivileged(roles: readonly ApiRole[]): boolean {
  return roles.includes('broadcaster') || roles.includes('moderator');
}

const ORDER: SongRequestWho[] = ['everyone', 'subscribers', 'vips', 'moderators'];

function levelOf(roles: readonly ApiRole[]): number {
  if (isPrivileged(roles)) return 3;
  if (roles.includes('vip')) return 2;
  if (roles.includes('subscriber') || roles.includes('member') || roles.includes('founder')) return 1;
  return 0;
}

/** Whether a viewer with `roles` may request under `who`. VIPs count as subscribers too. */
export function mayRequest(roles: readonly ApiRole[], who: SongRequestWho): boolean {
  return levelOf(roles) >= ORDER.indexOf(who);
}

export function whoLabel(who: SongRequestWho): string {
  switch (who) {
    case 'everyone':
      return 'everyone';
    case 'subscribers':
      return 'subscribers, VIPs and moderators';
    case 'vips':
      return 'VIPs and moderators';
    case 'moderators':
      return 'moderators';
  }
}

/** Per-viewer cooldowns (keys like `twitch:<user id>`), forgetting entries older than an hour. */
export class Cooldowns {
  private readonly last = new Map<string, number>();

  /** Milliseconds left before `key` may request again (0 = now). */
  remaining(key: string, cooldownSec: number, now = Date.now()): number {
    const at = this.last.get(key);
    if (at === undefined || cooldownSec <= 0) return 0;
    return Math.max(0, at + cooldownSec * 1000 - now);
  }

  hit(key: string, now = Date.now()): void {
    this.last.set(key, now);
    if (this.last.size > 2000) {
      for (const [k, t] of this.last) if (now - t > 3_600_000) this.last.delete(k);
    }
  }
}

/** Why `track` can't be queued under `settings`, or null when it can. */
export function refusal(track: MusicTrack, settings: SongRequestSettings): string | null {
  if (!settings.allowExplicit && track.explicit) return 'explicit songs are turned off';
  if (track.durationMs > settings.maxDurationSec * 1000) return `songs longer than ${formatDuration(settings.maxDurationSec)} are turned off`;
  return null;
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s === 0 ? `${m} min` : `${m}:${String(s).padStart(2, '0')}`;
}

export type RequestTarget = { kind: 'track'; id: string } | { kind: 'search'; query: string } | { kind: 'bad-link' };

/** What `!sr <query>` asks for: a Spotify track link/URI, a search, or a link Relay can't use. */
export function requestTarget(query: string): RequestTarget {
  const first = query.split(' ')[0] ?? '';
  const id = trackIdFrom(first);
  if (id) return { kind: 'track', id };
  if (looksLikeLink(first)) return { kind: 'bad-link' };
  return { kind: 'search', query };
}

/** The first search result `settings` allows (e.g. the clean version when explicit songs are off). */
export function pickTrack(results: readonly MusicTrack[], settings: SongRequestSettings): { track: MusicTrack } | { reason: string } {
  if (results.length === 0) return { reason: 'no song found' };
  for (const t of results) if (refusal(t, settings) === null) return { track: t };
  return { reason: refusal(results[0]!, settings)! };
}
