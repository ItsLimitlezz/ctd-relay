// Issues (alerts, docs/API.md §17) in the web UI:
// - IssuesStrip: one row per open issue (title, what it affects, how long it has been open, live).
// - IssueBadge: "2 issues" on a feed or destination card.
// - IssueHistoryCard: the last 7 days (Reports page), for one profile or every profile.

import type { ApiIssue, IssueHistoryEntry } from '@shared/issues';
import { api } from '../api';
import { useApi, useNow } from '../state/hooks';
import { affectsText, formatOpenFor, historyOutcome, issueBadge, SEVERITY_LABEL, SEVERITY_TONE, sortIssues } from '../state/issues';
import { Badge } from './Badge';
import { Button } from './Button';
import { Card } from './Card';
import { formatDateTime } from './format';
import { Spinner } from './Spinner';
import { cx } from './utils';

/** The open issues, most severe first. Renders nothing while there are none. */
export function IssuesStrip({ issues, compact = false, label = 'Open issues' }: { issues: readonly ApiIssue[]; compact?: boolean; label?: string }) {
  const now = useNow(issues.length > 0 ? 1000 : null);
  if (issues.length === 0) return null;
  return (
    <section className={cx('issues-strip', compact && 'is-compact')} aria-label={label} data-testid="issues-strip">
      <ul>
        {sortIssues(issues).map((i) => (
          <li key={i.id} className={cx('issue-row', `is-${i.severity}`)} data-testid="issue-row">
            <Badge tone={SEVERITY_TONE[i.severity]} dot pulse={i.severity === 'critical'}>
              {SEVERITY_LABEL[i.severity]}
            </Badge>
            <div className="issue-text">
              <strong className="issue-title">{i.title}</strong>
              <span className="issue-affects muted small">{affectsText(i.subject)}</span>
              {!compact && i.message && <span className="issue-message small">{i.message}</span>}
            </div>
            <span className="issue-age small muted" title={`Since ${new Date(i.firstSeen).toLocaleString()}`}>
              open {formatOpenFor(now - i.firstSeen)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "1 issue" / "3 issues" in the severity's colour, with the titles as its tooltip; nothing when none. */
export function IssueBadge({ issues, testId }: { issues: readonly ApiIssue[]; testId?: string }) {
  const b = issueBadge(issues);
  if (!b) return null;
  return (
    <span data-testid={testId}>
      <Badge tone={b.tone} dot title={b.title}>
        {b.text}
      </Badge>
    </span>
  );
}

/** The last 7 days of issues. `profile`: a profile id or '*' (every profile, with its name when given). */
export function IssueHistoryCard({ profile, profileName }: { profile: string; profileName?: (id: string) => string | null }) {
  const history = useApi(() => api.issueHistory(profile), [profile]);
  const items = history.data?.items ?? [];
  const days = history.data?.retentionDays ?? 7;
  return (
    <Card
      title="Issues"
      subtitle={`What went wrong in the last ${days} days, newest first${profile === '*' ? ', every profile' : ''}.`}
      actions={
        <Button size="sm" variant="ghost" onClick={history.reload} disabled={history.loading}>
          Refresh
        </Button>
      }
      data-testid="issue-history"
    >
      {history.loading && !history.data ? (
        <Spinner label="Loading issues…" />
      ) : history.error ? (
        <p className="alert alert-danger small">{history.error}</p>
      ) : items.length === 0 ? (
        <p className="muted small">No issues in the last {days} days.</p>
      ) : (
        <ul className="issue-history">
          {items.map((e) => (
            <IssueHistoryRow key={`${e.profileId}|${e.id}|${e.firstSeen}`} entry={e} profileName={profile === '*' ? profileName : undefined} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function IssueHistoryRow({ entry: e, profileName }: { entry: IssueHistoryEntry; profileName?: ((id: string) => string | null) | undefined }) {
  const who = profileName ? (profileName(e.profileId) ?? e.profileId) : null;
  return (
    <li className={cx('issue-row', `is-${e.peakSeverity}`)} data-testid="issue-history-row">
      <Badge tone={e.clearedAt === null ? SEVERITY_TONE[e.peakSeverity] : 'neutral'}>{SEVERITY_LABEL[e.peakSeverity]}</Badge>
      <div className="issue-text">
        <strong className="issue-title">{e.title}</strong>
        <span className="issue-affects muted small">
          {affectsText(e.subject)}
          {who ? ` · ${who}` : ''}
        </span>
        {e.message && <span className="issue-message small">{e.message}</span>}
      </div>
      <span className="issue-age small muted">
        {formatDateTime(new Date(e.firstSeen).toISOString())} · {historyOutcome(e)}
      </span>
    </li>
  );
}
