// Issues: the CTD suite's one alert contract (docs/API.md §17, v1.16). Shared by the server (the
// tracker in server/src/api/issues.ts, the 7-day history in server/src/api/issue-history.ts) and the
// web UI (the dashboard's issues strip, badges and history). server/src/api/types.ts re-exports these.

import type { Feed, PlatformId } from './types.js';

export type IssueSeverity = 'info' | 'warning' | 'critical';
export const ISSUE_SEVERITIES: readonly IssueSeverity[] = ['info', 'warning', 'critical'];

export type IssueKind = 'feed.offline' | 'destination.down' | 'stream.down' | 'obs.output.down' | 'obs.issue' | 'guest.feed.offline' | 'guest.feed.codec';

export type IssueResolution = 'recovered' | 'ended' | 'removed' | 'stale';

export type ApiIssueSubject =
  | { type: 'feed'; feed: Feed }
  | { type: 'destination'; destinationId: string; platform: PlatformId; name: string }
  | { type: 'stream' }
  | { type: 'obs.output'; appId: string; output: string; canvas: string | null }
  | { type: 'obs.source'; appId: string; source: string; path: string | null }
  /** A guest feed slot (docs/API.md §18, v1.17). */
  | { type: 'guest.feed'; slot: string; name: string };

/** An open issue (GET /status → issues; issue.raised without `update`). */
export interface ApiIssue {
  /** `<kind>|<subject key>`: the one key for raise, update, clear and dedupe. Opaque to clients. */
  id: string;
  kind: IssueKind;
  /** obs.issue only: the plugin's rule (camera-offline, …); null otherwise. */
  rule: string | null;
  severity: IssueSeverity;
  title: string;
  message: string | null;
  subject: ApiIssueSubject;
  /** OBS sources: visible on a program scene (true/false); null = unknown or not an OBS source. */
  onProgram: boolean | null;
  /** The program scene the source is on when onProgram, else null. */
  scene: string | null;
  /** Epoch ms the problem started (after its hold time); unchanged by updates. */
  firstSeen: number;
  updatedAt: number;
}

/** issue.raised data. `update`: false = a new problem (notify), true = the open one changed. */
export interface ApiIssueRaised extends ApiIssue {
  update: boolean;
}

/** issue.cleared data. */
export interface ApiIssueCleared {
  id: string;
  kind: IssueKind;
  rule: string | null;
  subject: ApiIssueSubject;
  title: string;
  firstSeen: number;
  durationMs: number;
  resolution: IssueResolution;
}

// ---------------------------------------------------------------------------
// History (v1.18, additive): raised and cleared issues of the last 7 days, kept in app.db
// (server/src/db/issue-history-repo.ts, its own table track). docs/API.md §17.7.
// ---------------------------------------------------------------------------

/** How long the history keeps an issue after it cleared, and the most rows it keeps. */
export const ISSUE_HISTORY_DAYS = 7;
export const ISSUE_HISTORY_MAX_ROWS = 5000;

/**
 * Why a past issue closed: the issue.cleared resolutions, plus `restarted` = Relay restarted while it
 * was open (open issues live in memory, so a restart ends them without an issue.cleared).
 */
export type IssueHistoryResolution = IssueResolution | 'restarted';

/** One issue in the history: from its issue.raised to its issue.cleared (or still open). */
export interface IssueHistoryEntry {
  /** The issue's id (`<kind>|<subject key>`, opaque). The same id can come back later as a new entry. */
  id: string;
  profileId: string;
  kind: IssueKind;
  rule: string | null;
  /** The latest severity. */
  severity: IssueSeverity;
  /** The highest severity while it was open. */
  peakSeverity: IssueSeverity;
  title: string;
  message: string | null;
  subject: ApiIssueSubject;
  /** Epoch ms the problem started (the issue's firstSeen). */
  firstSeen: number;
  /** Epoch ms of the latest change while open. */
  updatedAt: number;
  /** Epoch ms it cleared; null = still open. */
  clearedAt: number | null;
  /** clearedAt − firstSeen; null while open. */
  durationMs: number | null;
  /** null while open. */
  resolution: IssueHistoryResolution | null;
}

/** GET /api/v1/issues/history and GET /api/issues/history (web UI). Newest first. */
export interface IssueHistoryResponse {
  items: IssueHistoryEntry[];
  /** How many days the history keeps (ISSUE_HISTORY_DAYS). */
  retentionDays: number;
}

/** GET /api/profiles/:id/issues (web UI): the profile's open issues, oldest first (like /status → issues). */
export interface OpenIssuesResponse {
  issues: ApiIssue[];
}

const FEED_NAMES: Record<Feed, string> = { landscape: 'Landscape', vertical: 'Vertical' };

/**
 * What an issue affects, in plain words: "Landscape feed", "Destination Twitch main", "OBS output main",
 * "OBS source Club cam", "Extra feed MacBook", "The whole stream". Used by the dashboard and the exports.
 */
export function issueAffects(subject: ApiIssueSubject): string {
  switch (subject.type) {
    case 'feed':
      return `${FEED_NAMES[subject.feed] ?? subject.feed} feed`;
    case 'destination':
      return subject.name ? `Destination ${subject.name}` : 'A destination';
    case 'stream':
      return 'The whole stream';
    case 'obs.output':
      return subject.output ? `OBS output ${subject.output}` : 'An OBS output';
    case 'obs.source':
      return subject.source ? `OBS source ${subject.source}` : 'An OBS source';
    case 'guest.feed':
      return subject.name ? `Extra feed ${subject.name}` : 'An extra feed';
    default:
      return 'Relay';
  }
}
