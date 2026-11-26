// Reports: past streams of the current profile (or every profile), their numbers and audience.
// ?session=<id> opens one stream, ?user=<id> one viewer. docs/REPORTS.md.

import { useEffect, useState } from 'react';
import { ISSUE_HISTORY_DAYS } from '@shared/issues';
import type { ReportExportFormat, ReportIssue, ReportQuery, ReportRetentionDays, ReportSettingsResponse } from '@shared/reports';
import { REPORT_RETENTION_CHOICES } from '@shared/reports';
import { PLATFORM_IDS, type PlatformId } from '@shared/types';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { ConfirmButton } from '../components/ConfirmButton';
import { EmptyState } from '../components/EmptyState';
import { Field } from '../components/Field';
import { IssueHistoryCard } from '../components/Issues';
import { PlatformBadge, platformName } from '../components/PlatformBadge';
import { LineChart, StackedBars } from '../components/ReportCharts';
import { Select } from '../components/Select';
import { Spinner } from '../components/Spinner';
import { TextInput } from '../components/TextInput';
import { toast } from '../components/Toast';
import { Toggle } from '../components/Toggle';
import { Link, navigate, setQuery, useQuery } from '../router';
import { useAuth } from '../state/auth';
import { errorMessage } from '../state/errors';
import { useApi } from '../state/hooks';
import { historyOutcome, SEVERITY_LABEL, SEVERITY_TONE } from '../state/issues';
import { useProfileContext, useProfileId } from '../state/profile';
import { ExportLinks, Leaderboards, PlatformTable, StatTiles } from './reports/ReportParts';
import {
  EVENT_LABEL,
  browserTimeZone,
  chatChart,
  defaultRange,
  eventTone,
  formatHms,
  formatLongDuration,
  formatNum,
  formatWhen,
  statsTotal,
  viewerChart,
} from './reports/report-format';
import './settings/admin.css';
import './reports/reports.css';

const userLink = (id: string) => `/reports?user=${encodeURIComponent(id)}`;

export default function ReportsPage() {
  const q = useQuery();
  const session = q.get('session');
  const user = q.get('user');
  const profileId = useProfileId();
  const all = q.get('all') === '1';
  const profile = all ? '*' : profileId;
  if (session) return <SessionView id={session} profile={profile} />;
  if (user) return <UserView id={user} profile={profile} />;
  return <ListView profile={profile} all={all} />;
}

function ListView({ profile, all }: { profile: string; all: boolean }) {
  const q = useQuery();
  const { isAdmin } = useAuth();
  const { profiles } = useProfileContext();
  const profileName = (id: string) => profiles?.find((p) => p.id === id)?.name ?? null;
  const defaults = defaultRange();
  const from = q.get('from') ?? defaults.from;
  const to = q.get('to') ?? defaults.to;
  const platform = (q.get('platform') ?? '') as PlatformId | '';
  const includeTest = q.get('test') === 'include';
  const tz = browserTimeZone();
  const query: ReportQuery = { profile, from, to, tz, platform, test: includeTest ? 'include' : 'exclude' };
  const summary = useApi(() => api.reports.summary(query), [profile, from, to, platform, includeTest]);
  const data = summary.data;

  return (
    <div className="page stack-lg">
      <header className="page-header">
        <div>
          <h1>Reports</h1>
          <p>Every stream Relay recorded: viewers, chat, uptime, and who watched and chatted the most.</p>
        </div>
        <ExportLinks label="Export period" href={(f: ReportExportFormat) => api.reports.rangeExportUrl(f, query)} />
      </header>

      <Card title="Period" subtitle={all ? 'Every profile' : 'This profile'}>
        <div className="report-filters">
          <Field label="From">
            <TextInput type="date" value={from} max={to} onValueChange={(v) => setQuery({ from: v || null })} />
          </Field>
          <Field label="To">
            <TextInput type="date" value={to} min={from} onValueChange={(v) => setQuery({ to: v || null })} />
          </Field>
          <Field label="Platform">
            <Select
              value={platform}
              onValueChange={(v) => setQuery({ platform: v || null })}
              options={[{ value: '', label: 'All platforms' }, ...PLATFORM_IDS.map((p) => ({ value: p, label: platformName(p) }))]}
            />
          </Field>
          <div className="report-filter-toggles">
            <Toggle checked={includeTest} onChange={(on) => setQuery({ test: on ? 'include' : null })} label="Include test-mode streams" size="sm" />
            <Toggle checked={all} onChange={(on) => setQuery({ all: on ? '1' : null })} label="Every profile" size="sm" />
          </div>
        </div>
      </Card>

      {summary.loading && !data ? (
        <Spinner label="Loading reports…" />
      ) : summary.error ? (
        <Card>
          <p className="text-danger">{summary.error}</p>
        </Card>
      ) : !data || data.streams === 0 ? (
        <EmptyState
          title="No streams in this period"
          description="Relay records a report every time this profile goes live. Pick a longer period, or include test-mode streams."
        />
      ) : (
        <>
          <Card title="Totals">
            <StatTiles stats={statsTotal(data.stats)} streams={data.streams} />
            {data.stats.length > 2 && (
              <details className="report-details">
                <summary>Per platform</summary>
                <PlatformTable stats={data.stats} />
              </details>
            )}
          </Card>

          <Card title="Streams" flush>
            <div className="table-wrap">
              <table className="data-table is-stacked report-table">
                <caption className="sr-only">Streams in this period, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Started</th>
                    <th scope="col">Title</th>
                    <th scope="col">Platforms</th>
                    <th scope="col">Duration</th>
                    <th scope="col">Peak</th>
                    <th scope="col">Viewer-min</th>
                    <th scope="col">Chat</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sessions.map((s) => (
                    <tr key={s.id}>
                      <td data-label="Started">{formatWhen(s.startedAt)}</td>
                      <td data-label="Title" className="cell-wrap">
                        <Link to={`/reports?session=${encodeURIComponent(s.id)}`}>{s.title || 'Untitled'}</Link>
                        {s.testMode && (
                          <>
                            {' '}
                            <Badge tone="warn">Test</Badge>
                          </>
                        )}
                        {s.endedAt === null && (
                          <>
                            {' '}
                            <Badge tone="live" dot pulse>
                              Live
                            </Badge>
                          </>
                        )}
                        {all && s.profileName && <span className="muted small"> · {s.profileName}</span>}
                      </td>
                      <td data-label="Platforms">
                        <span className="row">
                          {s.platforms.map((p) => (
                            <PlatformBadge key={p} platform={p} size="sm" />
                          ))}
                          <span className="sr-only">{s.platforms.map(platformName).join(', ')}</span>
                        </span>
                      </td>
                      <td data-label="Duration">{formatHms(s.durationSec)}</td>
                      <td data-label="Peak">{formatNum(s.peakViewers)}</td>
                      <td data-label="Viewer-min">{formatNum(s.viewerMinutes)}</td>
                      <td data-label="Chat">{formatNum(s.chatMessages)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Audience" subtitle={platform ? platformName(platform) : 'All platforms'}>
            <Leaderboards boards={data.leaderboards} idPrefix="range-boards" userLink={userLink} />
          </Card>
        </>
      )}

      <IssueHistoryCard profile={profile} profileName={profileName} />

      <ReportSettingsCard isAdmin={isAdmin} />
    </div>
  );
}

function SessionView({ id, profile }: { id: string; profile: string }) {
  const tz = browserTimeZone();
  const r = useApi(() => api.reports.session(id, { profile: '*' }), [id]);
  const d = r.data;
  if (r.loading && !d) return <Spinner label="Loading the report…" />;
  if (r.error || !d) {
    return (
      <div className="page stack-lg">
        <BackLink />
        <EmptyState title="Report not found" description={r.error ?? 'It may have been deleted by the retention setting.'} />
      </div>
    );
  }
  const viewers = viewerChart(d);
  const chat = chatChart(d.chatMinutes);
  const feeds = feedSummary(d.feedMinutes);
  return (
    <div className="page stack-lg">
      <BackLink />
      <header className="page-header">
        <div>
          <h1 className="report-title">{d.title || 'Untitled stream'}</h1>
          <p>
            {formatWhen(d.startedAt)} · {formatLongDuration(d.durationSec)}
            {d.profileName && profile === '*' ? ` · ${d.profileName}` : ''}
            {d.testMode && (
              <>
                {' '}
                <Badge tone="warn">Test mode</Badge>
              </>
            )}
            {d.endedAt === null && (
              <>
                {' '}
                <Badge tone="live" dot pulse>
                  Live now
                </Badge>
              </>
            )}
          </p>
          {d.endedByRestart && <p className="small muted">Relay restarted during this stream: the end is the last time it recorded it.</p>}
        </div>
        <ExportLinks href={(f) => api.reports.sessionExportUrl(d.id, f, { tz })} />
      </header>

      <Card title="Totals">
        <StatTiles stats={statsTotal(d.stats)} />
      </Card>

      <Card title="Viewers">
        <LineChart title="Concurrent viewers per platform" times={viewers.times} series={viewers.series} />
        <p className="muted small">
          Gaps are times a platform did not report a viewer count: they are not zero. The total adds the platforms that reported a count at that moment.
        </p>
      </Card>

      <Card title="Chat">
        <StackedBars title="Chat messages per minute" times={chat.times} series={chat.series} />
      </Card>

      <Card title="Per platform" flush>
        <PlatformTable stats={d.stats} />
      </Card>

      <Card title="Audience" subtitle={d.audienceTracked ? undefined : 'Audience tracking was off for this stream: counts only.'}>
        <Leaderboards boards={d.leaderboards} idPrefix="session-boards" userLink={userLink} />
      </Card>

      <div className="report-columns">
        <Card title="Destinations">
          <ul className="report-list">
            {d.destinations.map((x) => (
              <li key={x.destinationId}>
                <PlatformBadge platform={x.platform} size="sm" withName /> <span>{x.name}</span>
                <span className="muted small">
                  {' '}
                  · {x.feed}
                  {x.dualFormat && x.dualFormat !== 'off' ? ` · Dual Format (${x.dualFormat})` : ''} · live{' '}
                  {x.live.length === 0 ? 'never' : x.live.map((p) => `${formatWhen(p.start)} → ${p.end ? formatWhen(p.end) : 'now'}`).join(', ')}
                </span>
              </li>
            ))}
          </ul>
          {d.titles.length > 1 && (
            <>
              <h3 className="report-subhead">Titles</h3>
              <ul className="report-list">
                {d.titles.map((t) => (
                  <li key={t.ts}>
                    <span className="muted small">{formatWhen(t.ts)}</span> {t.title}
                  </li>
                ))}
              </ul>
            </>
          )}
          {feeds.length > 0 && (
            <>
              <h3 className="report-subhead">Feeds</h3>
              <ul className="report-list">
                {feeds.map((f) => (
                  <li key={f.feed}>
                    <strong>{f.feed}</strong> <span className="muted small">{f.text}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        <Card title="Timeline">
          <ol className="report-timeline">
            {d.events.map((e, i) => (
              <li key={i}>
                <span className="muted small">{new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>{' '}
                <Badge tone={eventTone(e.kind)}>{EVENT_LABEL[e.kind] ?? e.kind}</Badge>
                {e.platform && <span className="small"> {platformName(e.platform)}</span>}
                {e.detail && <span className="small muted cell-wrap"> {e.detail}</span>}
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <ReportIssues issues={d.issues ?? []} startedAt={d.startedAt} />
    </div>
  );
}

/** Issues open during the stream (docs/API.md §17), from the 7-day issue history. */
function ReportIssues({ issues, startedAt }: { issues: readonly ReportIssue[]; startedAt: string }) {
  // The history keeps 7 days: an older stream's issues are gone, which is not the same as none.
  const tooOld = Date.now() - Date.parse(startedAt) > ISSUE_HISTORY_DAYS * 86_400_000;
  return (
    <Card title="Issues" subtitle={`Problems Relay saw during this stream. Issues are kept for ${ISSUE_HISTORY_DAYS} days.`}>
      {issues.length === 0 ? (
        <p className="muted small">{tooOld ? `This stream is older than ${ISSUE_HISTORY_DAYS} days: its issues are no longer kept.` : 'No issues during this stream.'}</p>
      ) : (
        <ul className="issue-history">
          {issues.map((i) => (
            <li key={`${i.id}|${i.startedAt}`} className={`issue-row is-${i.severity}`}>
              <Badge tone={SEVERITY_TONE[i.severity]}>{SEVERITY_LABEL[i.severity]}</Badge>
              <div className="issue-text">
                <strong className="issue-title">{i.title}</strong>
                <span className="issue-affects muted small">{i.affects}</span>
                {i.message && <span className="issue-message small">{i.message}</span>}
              </div>
              <span className="issue-age small muted">
                {formatWhen(i.startedAt)} ·{' '}
                {historyOutcome({ resolution: i.resolution, clearedAt: i.clearedAt ? Date.parse(i.clearedAt) : null, durationMs: i.durationSec === null ? null : i.durationSec * 1000 })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** "h264 1920×1080 60 fps, 5,980 kbps avg, offline 3 min" per feed. */
function feedSummary(minutes: readonly { feed: string; online: boolean; codec: string | null; width: number | null; height: number | null; fps: number | null; bitrateKbps: number | null }[]) {
  const feeds = [...new Set(minutes.map((m) => m.feed))];
  return feeds.map((feed) => {
    const rows = minutes.filter((m) => m.feed === feed);
    const on = rows.filter((m) => m.online);
    const last = on[on.length - 1];
    const rates = on.map((m) => m.bitrateKbps).filter((v): v is number => v !== null);
    const avg = rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : null;
    const off = rows.length - on.length;
    const parts = [
      last ? [last.codec, last.width && last.height ? `${last.width}×${last.height}` : null, last.fps ? `${Math.round(last.fps)} fps` : null].filter(Boolean).join(' ') : 'never online',
      avg !== null ? `${avg.toLocaleString()} kbps avg` : null,
      off > 0 ? `offline ${off} min` : null,
    ].filter(Boolean);
    return { feed, text: parts.join(', ') };
  });
}

function UserView({ id, profile }: { id: string; profile: string }) {
  const { isAdmin } = useAuth();
  const r = useApi(() => api.reports.user(id, { profile }), [id, profile]);
  const d = r.data;
  if (r.loading && !d) return <Spinner label="Loading…" />;
  if (r.error || !d) {
    return (
      <div className="page stack-lg">
        <BackLink />
        <EmptyState title="Not in the reports" description={r.error ?? undefined} />
      </div>
    );
  }
  const forget = async () => {
    try {
      await api.reports.forgetUser(id);
      toast.success('Forgotten: every report row about them is deleted.');
      navigate('/reports');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <div className="page stack-lg">
      <BackLink />
      <header className="page-header">
        <div>
          <h1 className="row">
            <PlatformBadge platform={d.user.platform} size="lg" /> {d.user.displayName}
          </h1>
          <p>
            {platformName(d.user.platform)}
            {d.user.login && d.user.login !== d.user.displayName ? ` · ${d.user.login}` : ''} · first seen {formatWhen(d.user.firstSeenAt)} · last seen{' '}
            {formatWhen(d.user.lastSeenAt)}
          </p>
        </div>
        {isAdmin && (
          <ConfirmButton variant="danger" size="sm" confirmLabel="Click again to forget" onConfirm={forget}>
            Forget this user
          </ConfirmButton>
        )}
      </header>
      <Card title="Totals">
        <dl className="report-tiles">
          {[
            ['Streams', formatNum(d.totals.streams)],
            ['Messages', formatNum(d.totals.messages)],
            ['Joins', formatNum(d.totals.joins)],
            ['Watch time', d.totals.watchSec === null ? 'not reported' : formatHms(d.totals.watchSec)],
          ].map(([k, v]) => (
            <div key={k} className="report-tile">
              <dt>{k}</dt>
              <dd>
                <span className="report-tile-value">{v}</span>
              </dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title="Streams" flush>
        <div className="table-wrap">
          <table className="data-table is-stacked report-table">
            <caption className="sr-only">Streams this viewer attended</caption>
            <thead>
              <tr>
                <th scope="col">Stream</th>
                <th scope="col">Messages</th>
                <th scope="col">Joins</th>
                <th scope="col">First message</th>
                <th scope="col">Last message</th>
                <th scope="col">Watch time</th>
              </tr>
            </thead>
            <tbody>
              {d.streams.map((s) => (
                <tr key={s.sessionId}>
                  <td data-label="Stream" className="cell-wrap">
                    <Link to={`/reports?session=${encodeURIComponent(s.sessionId)}`}>{s.title || 'Untitled'}</Link>
                    <span className="muted small"> · {formatWhen(s.startedAt)}</span>
                  </td>
                  <td data-label="Messages">{formatNum(s.messages)}</td>
                  <td data-label="Joins">{formatNum(s.joins)}</td>
                  <td data-label="First message">{formatWhen(s.firstMessageAt)}</td>
                  <td data-label="Last message">{formatWhen(s.lastMessageAt)}</td>
                  <td data-label="Watch time">{s.watchSec === null ? <span className="muted">not reported</span> : formatHms(s.watchSec)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="muted small">CTD Relay keeps counts and times only, never what was written.</p>
    </div>
  );
}

function BackLink() {
  return (
    <p>
      <Link to="/reports">← All reports</Link>
    </p>
  );
}

const RETENTION_LABEL: Record<ReportRetentionDays, string> = { 0: 'Keep everything', 90: '90 days', 365: '365 days' };

function ReportSettingsCard({ isAdmin }: { isAdmin: boolean }) {
  const [state, setState] = useState<ReportSettingsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.reports.settings().then(setState, () => undefined);
  }, []);
  if (!state) return null;
  const save = async (patch: Partial<ReportSettingsResponse['settings']>) => {
    setBusy(true);
    try {
      setState(await api.reports.saveSettings({ ...state.settings, ...patch }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const s = state.settings;
  return (
    <Card title="Recording and privacy" subtitle={isAdmin ? undefined : 'Only an admin can change these.'}>
      {!state.available && <p className="text-danger">The report tables were made by a newer CTD Relay. Update the app to record reports again.</p>}
      <div className="stack">
        <Field label="Record stream reports" inline help="Viewers, chat counts, feed stats and events of every stream.">
          <Toggle checked={s.recording} disabled={!isAdmin} busy={busy} onChange={(on) => void save({ recording: on })} />
        </Field>
        <Field
          label="Audience tracking"
          inline
          help="Keeps who chats, joins and watches the most (leaderboards): names, counts and times per stream, never message text. Off: counts only; forget one person on their page."
        >
          <Toggle checked={s.audience} disabled={!isAdmin} busy={busy} onChange={(on) => void save({ audience: on })} />
        </Field>
        <Field label="Keep reports for" help="Older streams, and viewers only seen in them, are deleted.">
          <Select
            value={String(s.retentionDays)}
            disabled={!isAdmin || busy}
            onValueChange={(v) => void save({ retentionDays: Number(v) as ReportRetentionDays })}
            options={REPORT_RETENTION_CHOICES.map((d) => ({ value: String(d), label: RETENTION_LABEL[d] }))}
          />
        </Field>
      </div>
    </Card>
  );
}
