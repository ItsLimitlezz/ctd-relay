// Issues (alerts, docs/API.md §17) in the web UI: ordering, what each one affects, badges for the
// feed and destination cards, and the "open for" text. Pure helpers; the live list comes from the
// live store (useOpenIssues), other profiles' lists and the history over REST (api.ts).

import { issueAffects, type ApiIssue, type ApiIssueSubject, type IssueHistoryEntry, type IssueSeverity } from '@shared/issues';
import type { Feed } from '@shared/types';
import type { Tone } from '../components/utils';

const RANK: Record<IssueSeverity, number> = { info: 0, warning: 1, critical: 2 };

export const SEVERITY_TONE: Record<IssueSeverity, Tone> = { info: 'info', warning: 'warn', critical: 'danger' };
export const SEVERITY_LABEL: Record<IssueSeverity, string> = { info: 'Info', warning: 'Warning', critical: 'Critical' };

/** Most severe first, then oldest first (docs/API.md §17.5 rule 4). Doesn't change the input. */
export function sortIssues<T extends Pick<ApiIssue, 'severity' | 'firstSeen'>>(issues: readonly T[]): T[] {
  return [...issues].sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.firstSeen - b.firstSeen);
}

export function worstSeverity(issues: readonly Pick<ApiIssue, 'severity'>[]): IssueSeverity | null {
  let worst: IssueSeverity | null = null;
  for (const i of issues) if (worst === null || RANK[i.severity] > RANK[worst]) worst = i.severity;
  return worst;
}

/** What the issue affects, by name ("Landscape feed", "Destination Twitch", "Extra feed MacBook"). */
export const affectsText = (subject: ApiIssueSubject): string => issueAffects(subject);

/** The issues about one ingest feed. */
export function feedIssues(issues: readonly ApiIssue[], feed: Feed): ApiIssue[] {
  return issues.filter((i) => i.subject.type === 'feed' && i.subject.feed === feed);
}

/** The issues about one destination. */
export function destinationIssues(issues: readonly ApiIssue[], destinationId: string): ApiIssue[] {
  return issues.filter((i) => i.subject.type === 'destination' && i.subject.destinationId === destinationId);
}

export interface IssueBadgeInfo {
  count: number;
  severity: IssueSeverity;
  tone: Tone;
  /** "1 issue" / "2 issues". */
  text: string;
  /** The titles, one per line (the badge's tooltip). */
  title: string;
}

/** The badge for a card's open issues, or null when there are none. */
export function issueBadge(issues: readonly ApiIssue[]): IssueBadgeInfo | null {
  const severity = worstSeverity(issues);
  if (severity === null) return null;
  return {
    count: issues.length,
    severity,
    tone: SEVERITY_TONE[severity],
    text: issues.length === 1 ? '1 issue' : `${issues.length} issues`,
    title: sortIssues(issues)
      .map((i) => i.title)
      .join('\n'),
  };
}

/** How long something has been open, short: "12 s", "4 min", "1 h 5 min", "2 d 3 h". */
export function formatOpenFor(ms: number): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

const RESOLUTION_TEXT: Record<string, string> = {
  recovered: 'Recovered',
  ended: 'Ended with the stream',
  removed: 'Removed',
  stale: 'OBS app went offline',
  restarted: 'Relay restarted',
};

/** How a past issue ended, in plain words ("Recovered after 2 min"), or "Still open". */
export function historyOutcome(e: Pick<IssueHistoryEntry, 'resolution' | 'durationMs' | 'clearedAt'>): string {
  if (e.clearedAt === null || e.resolution === null) return 'Still open';
  const label = RESOLUTION_TEXT[e.resolution] ?? e.resolution;
  return e.durationMs === null ? label : `${label} after ${formatOpenFor(e.durationMs)}`;
}
