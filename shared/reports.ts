// Stream reports: what one live session (a profile's go-live, start → end) looked like, and who
// watched and chatted. Shared by the server (server/src/reports/*) and the web UI. docs/REPORTS.md.
//
// Every number that Relay could not know is `null`, never 0: a platform that does not report
// viewers has null viewers, not zero viewers.

import type { Feed, PlatformId } from './types.js';

// ---------------------------------------------------------------------------
// Settings (settings key 'reports')
// ---------------------------------------------------------------------------

/** 0 = keep everything. */
export type ReportRetentionDays = 0 | 90 | 365;
export const REPORT_RETENTION_CHOICES: readonly ReportRetentionDays[] = [0, 90, 365];

export interface ReportSettings {
  /** Record stream reports at all (viewers, chat counts, feed stats, events). */
  recording: boolean;
  /** Record who chatted, joined or was present (per user, per stream). Never message text. */
  audience: boolean;
  /** Delete report data (streams and audience) older than this many days; 0 = keep all. */
  retentionDays: ReportRetentionDays;
}

export const DEFAULT_REPORT_SETTINGS: ReportSettings = { recording: true, audience: true, retentionDays: 0 };

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type ReportEventKind =
  | 'session.start'
  | 'session.end'
  | 'title'
  | 'destination.live'
  | 'destination.offline'
  | 'destination.retrying'
  | 'destination.recovery'
  | 'destination.error'
  | 'destination.blocked'
  | 'feed.online'
  | 'feed.offline'
  | 'presence.unavailable';

export interface ReportEvent {
  ts: string;
  kind: ReportEventKind;
  destinationId: string | null;
  platform: PlatformId | null;
  /** Short, secret-free text (an error message, the new title, a feed name). */
  detail: string | null;
}

export interface ReportDestination {
  destinationId: string;
  platform: PlatformId;
  name: string;
  /** The canvas this destination was sent. */
  feed: Feed;
  /** Twitch Dual Format mode ('off' | 'obs-direct' | 'relay-multitrack'), null for other platforms. */
  dualFormat: string | null;
  /** Live periods (a recovery opens a new one). `end` null = still live. */
  live: { start: string; end: string | null }[];
}

/** One row of the list (GET /reports/sessions). */
export interface ReportSessionSummary {
  id: string;
  profileId: string;
  profileName: string | null;
  startedAt: string;
  /** null while the session is still live. */
  endedAt: string | null;
  /** The session ended because Relay restarted (end = the last time Relay recorded it). */
  endedByRestart: boolean;
  testMode: boolean;
  /** Title at the start, and the last one. */
  title: string;
  lastTitle: string;
  platforms: PlatformId[];
  durationSec: number;
  peakViewers: number | null;
  viewerMinutes: number | null;
  chatMessages: number;
  uniqueChatters: number | null;
}

/** Numbers for one platform, or for every platform together (`platform: 'total'`). */
export interface ReportStats {
  platform: PlatformId | 'total';
  durationSec: number;
  /** Seconds at least one destination of this platform was live. */
  liveSec: number;
  /** liveSec / durationSec (0..1); for the total, the mean over destinations. null for a 0 s session. */
  uptime: number | null;
  peakViewers: number | null;
  peakViewersAt: string | null;
  /** Time-weighted mean over the time viewers were known. */
  avgViewers: number | null;
  /** Viewers × minutes (a person watching 10 minutes = 10). Not unique viewers. */
  viewerMinutes: number | null;
  /** Minutes the viewer count was known (the base of the average). */
  viewersKnownMinutes: number;
  chatMessages: number;
  chatEvents: number;
  joins: number;
  /** "… and N others joined" (Instagram): joins without a name. */
  anonymousJoins: number;
  uniqueChatters: number | null;
  /** chatMessages per 1000 viewer-minutes. */
  chatPer1kViewerMinutes: number | null;
  recoveries: number;
  errors: number;
}

export interface ViewerSeriesPoint {
  ts: string;
  /** destinationId → viewers (null = unknown). */
  values: Record<string, number | null>;
}

export interface ChatMinute {
  minute: string;
  platform: PlatformId;
  messages: number;
  events: number;
  joins: number;
  uniqueChatters: number;
}

export interface FeedMinute {
  minute: string;
  feed: Feed;
  online: boolean;
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrateKbps: number | null;
  keyframeSec: number | null;
}

export interface ReportSessionDetail extends ReportSessionSummary {
  titles: { ts: string; title: string }[];
  destinations: ReportDestination[];
  /** Per platform, then `total` last. */
  stats: ReportStats[];
  /** Total concurrent viewers over time (sum of the known platforms; null when none is known). */
  viewers: { ts: string; total: number | null; byPlatform: Partial<Record<PlatformId, number | null>> }[];
  chatMinutes: ChatMinute[];
  feedMinutes: FeedMinute[];
  events: ReportEvent[];
  /** Platforms that told Relay who is present (e.g. the Twitch chatters list), with how many samples. */
  presence: { platform: PlatformId; samples: number }[];
  /** False when audience tracking was off during this session. */
  audienceTracked: boolean;
}

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------

export type LeaderboardKind = 'chatters' | 'loyal' | 'watch' | 'newest';
export const LEADERBOARD_KINDS: readonly LeaderboardKind[] = ['chatters', 'loyal', 'watch', 'newest'];

export interface AudienceUser {
  /** `<platform>:<platform user id>`, or `<platform>:name:<display name>` without one. */
  id: string;
  platform: PlatformId;
  displayName: string;
  login: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface LeaderboardRow extends AudienceUser {
  messages: number;
  /** Streams attended (chatted, joined, or present in a platform's presence list). */
  streams: number;
  joins: number;
  /** Only from platforms that report presence; null when the user's platform does not. */
  watchSec: number | null;
}

export interface Leaderboard {
  kind: LeaderboardKind;
  rows: LeaderboardRow[];
}

/** One user's row for one stream (Audience sheet). */
export interface AudienceStreamRow {
  sessionId: string;
  userId: string;
  platform: PlatformId;
  displayName: string;
  messages: number;
  events: number;
  joins: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  presenceSamples: number;
  watchSec: number | null;
}

export interface AudienceUserDetail {
  user: AudienceUser;
  totals: LeaderboardRow;
  streams: (AudienceStreamRow & { startedAt: string; title: string })[];
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

export interface ReportRangeSummary {
  from: string | null;
  to: string | null;
  streams: number;
  /** Per platform, then `total` last, over every stream in the range. */
  stats: ReportStats[];
  sessions: ReportSessionSummary[];
  leaderboards: Leaderboard[];
}

export interface ReportSessionsResponse {
  sessions: ReportSessionSummary[];
}

export type ReportExportFormat = 'xlsx' | 'csv' | 'json';
export const REPORT_EXPORT_FORMATS: readonly ReportExportFormat[] = ['xlsx', 'csv', 'json'];

/** GET /reports/sessions/{id}: the detail plus the four leaderboards of that stream. */
export interface ReportSessionDetailResponse extends ReportSessionDetail {
  leaderboards: Leaderboard[];
}

/** GET/PUT /api/reports/settings (web UI). */
export interface ReportSettingsResponse {
  settings: ReportSettings;
  /** False when the report tables can't be used (made by a newer Relay). */
  available: boolean;
  /** Sessions being recorded now. */
  recording: string[];
}

/** Query of the list, summary, leaderboard and export routes. */
export interface ReportQuery {
  /** A profile id, or '*' for every profile. */
  profile?: string;
  from?: string;
  to?: string;
  tz?: string;
  platform?: PlatformId | '';
  test?: 'include' | 'exclude';
  limit?: number;
  board?: LeaderboardKind;
  session?: string;
}
