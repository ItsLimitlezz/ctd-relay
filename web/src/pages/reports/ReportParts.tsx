// Building blocks shared by the Reports views: stat tiles, the per-platform table, leaderboards,
// export links.

import { useState } from 'react';
import type { Leaderboard, LeaderboardKind, ReportExportFormat, ReportStats } from '@shared/reports';
import { LEADERBOARD_KINDS } from '@shared/reports';
import type { PlatformId } from '@shared/types';
import { buttonClass } from '../../components/Button';
import { plural } from '../../components/format';
import { PlatformBadge, platformName } from '../../components/PlatformBadge';
import { TabPanel, Tabs } from '../../components/Tabs';
import { Link } from '../../router';
import { BOARD_HELP, BOARD_LABEL, formatHms, formatLongDuration, formatNum, formatPct, formatWhen } from './report-format';

export function StatTiles({ stats, streams }: { stats: ReportStats | undefined; streams?: number }) {
  if (!stats) return null;
  const tiles: { label: string; value: string; hint?: string }[] = [
    ...(streams !== undefined ? [{ label: 'Streams', value: formatNum(streams) }] : []),
    { label: 'Duration', value: formatLongDuration(stats.durationSec) },
    { label: 'Peak viewers', value: formatNum(stats.peakViewers), hint: stats.peakViewersAt ? `at ${formatWhen(stats.peakViewersAt)}` : undefined },
    { label: 'Avg concurrent', value: formatNum(stats.avgViewers, 1) },
    { label: 'Viewer-minutes', value: formatNum(stats.viewerMinutes), hint: 'viewers × minutes, not unique viewers' },
    { label: 'Chat messages', value: formatNum(stats.chatMessages), hint: stats.chatPer1kViewerMinutes !== null ? `${formatNum(stats.chatPer1kViewerMinutes, 1)} per 1k viewer-min` : undefined },
    { label: 'Unique chatters', value: formatNum(stats.uniqueChatters) },
    { label: 'Uptime', value: formatPct(stats.uptime), hint: `${plural(stats.recoveries, 'recovery', 'recoveries')} · ${plural(stats.errors, 'error')}` },
  ];
  return (
    <dl className="report-tiles">
      {tiles.map((t) => (
        <div key={t.label} className="report-tile">
          <dt>{t.label}</dt>
          <dd>
            <span className="report-tile-value">{t.value}</span>
            {t.hint && <span className="report-tile-hint">{t.hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function PlatformTable({ stats }: { stats: readonly ReportStats[] }) {
  return (
    <div className="table-wrap">
      <table className="data-table is-stacked report-table">
        <caption className="sr-only">Numbers per platform</caption>
        <thead>
          <tr>
            <th scope="col">Platform</th>
            <th scope="col">Live</th>
            <th scope="col">Uptime</th>
            <th scope="col">Peak</th>
            <th scope="col">Avg</th>
            <th scope="col">Viewer-min</th>
            <th scope="col">Chat</th>
            <th scope="col">Per 1k v-min</th>
            <th scope="col">Chatters</th>
            <th scope="col">Joins</th>
            <th scope="col">Recoveries</th>
            <th scope="col">Errors</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.platform} className={s.platform === 'total' ? 'is-total' : undefined}>
              <td data-label="Platform">{s.platform === 'total' ? <strong>Total</strong> : <PlatformBadge platform={s.platform as PlatformId} size="sm" withName />}</td>
              <td data-label="Live">{formatHms(s.liveSec)}</td>
              <td data-label="Uptime">{formatPct(s.uptime)}</td>
              <td data-label="Peak">{formatNum(s.peakViewers)}</td>
              <td data-label="Avg">{formatNum(s.avgViewers, 1)}</td>
              <td data-label="Viewer-min">{formatNum(s.viewerMinutes)}</td>
              <td data-label="Chat">{formatNum(s.chatMessages)}</td>
              <td data-label="Per 1k v-min">{formatNum(s.chatPer1kViewerMinutes, 1)}</td>
              <td data-label="Chatters">{formatNum(s.uniqueChatters)}</td>
              <td data-label="Joins">
                {formatNum(s.joins)}
                {s.anonymousJoins > 0 && <span className="muted"> + {formatNum(s.anonymousJoins)} unnamed</span>}
              </td>
              <td data-label="Recoveries">{formatNum(s.recoveries)}</td>
              <td data-label="Errors">{formatNum(s.errors)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Leaderboards({ boards, idPrefix, userLink }: { boards: readonly Leaderboard[]; idPrefix: string; userLink: (id: string) => string }) {
  const [tab, setTab] = useState<LeaderboardKind>('chatters');
  const board = boards.find((b) => b.kind === tab);
  return (
    <div className="stack">
      <Tabs
        idPrefix={idPrefix}
        aria-label="Leaderboards"
        value={tab}
        onChange={(id) => setTab(id as LeaderboardKind)}
        tabs={LEADERBOARD_KINDS.map((k) => ({ id: k, label: BOARD_LABEL[k] }))}
      />
      <TabPanel idPrefix={idPrefix} id={tab}>
        <p className="muted small">{BOARD_HELP[tab]}</p>
        {!board || board.rows.length === 0 ? (
          <p className="muted small">Nobody here yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table is-stacked report-table">
              <caption className="sr-only">{BOARD_LABEL[tab]}</caption>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Name</th>
                  <th scope="col">Messages</th>
                  <th scope="col">Streams</th>
                  <th scope="col">Joins</th>
                  <th scope="col">Watch time</th>
                  <th scope="col">First seen</th>
                </tr>
              </thead>
              <tbody>
                {board.rows.map((r, i) => (
                  <tr key={r.id}>
                    <td data-label="#">{i + 1}</td>
                    <td data-label="Name" className="cell-wrap">
                      <span className="row">
                        <PlatformBadge platform={r.platform} size="sm" />
                        <Link to={userLink(r.id)}>{r.displayName}</Link>
                        <span className="sr-only">({platformName(r.platform)})</span>
                      </span>
                    </td>
                    <td data-label="Messages">{formatNum(r.messages)}</td>
                    <td data-label="Streams">{formatNum(r.streams)}</td>
                    <td data-label="Joins">{formatNum(r.joins)}</td>
                    <td data-label="Watch time">{r.watchSec === null ? <span className="muted">not reported</span> : formatHms(r.watchSec)}</td>
                    <td data-label="First seen">{formatWhen(r.firstSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </TabPanel>
    </div>
  );
}

const FORMAT_LABEL: Record<ReportExportFormat, string> = { xlsx: 'Excel (.xlsx)', csv: 'CSV (.zip)', json: 'JSON' };

export function ExportLinks({ href, label = 'Export' }: { href: (f: ReportExportFormat) => string; label?: string }) {
  return (
    <div className="row" role="group" aria-label={label}>
      <a className={buttonClass('primary', 'sm')} href={href('xlsx')} download>
        {label}: {FORMAT_LABEL.xlsx}
      </a>
      <a className={buttonClass('secondary', 'sm')} href={href('csv')} download>
        {FORMAT_LABEL.csv}
      </a>
      <a className={buttonClass('ghost', 'sm')} href={href('json')} download>
        {FORMAT_LABEL.json}
      </a>
    </div>
  );
}
