// Report exports (docs/REPORTS.md → Export): one table model, written as .xlsx (default), as CSV
// files in a .zip, or as JSON. The .xlsx and the CSVs hold the same tables; JSON holds the report
// objects themselves (shared/reports.ts) with UTC ISO times.

import type { PlatformId } from '../../../shared/types.js';
import type { AudienceStreamRow, Leaderboard, ReportExportFormat, ReportSessionDetail, ReportStats } from '../../../shared/reports.js';
import { leaderboard, rangeSummary, sessionDetail, type ReportContext } from './report.js';
import type { SessionFilter } from './store.js';
import { buildXlsx, type CellValue, type Column, type Sheet } from './xlsx.js';
import { zip } from './zip.js';

export const EXPORT_LEADERBOARD_LIMIT = 500;

const PLATFORM_NAMES: Record<string, string> = {
  twitch: 'Twitch',
  youtube: 'YouTube',
  kick: 'Kick',
  facebook: 'Facebook',
  x: 'X',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  custom: 'Custom RTMP',
  total: 'Total',
};
export const platformLabel = (p: string): string => PLATFORM_NAMES[p] ?? p;

/** A valid IANA time zone, else 'UTC'. */
export function safeTimeZone(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
    return raw;
  } catch {
    return 'UTC';
  }
}

/** Epoch ms → the same wall-clock time in `tz`, as if it were UTC (for Excel serials and CSV text). */
export function wallClock(epochMs: number, tz: string): number {
  if (tz === 'UTC') return epochMs;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(epochMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc + (epochMs % 1000);
}

export interface ExportBundle {
  scope: { sessionId: string } | { from: string | null; to: string | null };
  generatedAt: string;
  timeZone: string;
  sessions: ReportSessionDetail[];
  /** Range exports: per platform + total over every stream. */
  rangeStats: ReportStats[] | null;
  leaderboards: Leaderboard[];
  audience: AudienceStreamRow[];
  anonymousJoins: { sessionId: string; platform: PlatformId; count: number }[];
}

export function collect(ctx: ReportContext, scope: { sessionId: string } | SessionFilter, tz: string): ExportBundle | null {
  const generatedAt = new Date((ctx.now ?? Date.now)()).toISOString();
  if ('sessionId' in scope) {
    const d = sessionDetail(ctx, scope.sessionId);
    if (!d) return null;
    return {
      scope: { sessionId: d.id },
      generatedAt,
      timeZone: tz,
      sessions: [d],
      rangeStats: null,
      leaderboards: (['chatters', 'loyal', 'watch', 'newest'] as const).map((k) => leaderboard(ctx, { sessionIds: [d.id] }, k, null, EXPORT_LEADERBOARD_LIMIT)),
      audience: ctx.store.audienceStreams([d.id]),
      anonymousJoins: anonymous([d]),
    };
  }
  const range = rangeSummary(ctx, scope, { limit: EXPORT_LEADERBOARD_LIMIT });
  const details = range.sessions
    .slice()
    .reverse()
    .map((s) => sessionDetail(ctx, s.id))
    .filter((d): d is ReportSessionDetail => d !== null);
  return {
    scope: { from: scope.from ?? null, to: scope.to ?? null },
    generatedAt,
    timeZone: tz,
    sessions: details,
    rangeStats: range.stats,
    leaderboards: range.leaderboards,
    audience: ctx.store.audienceStreams(details.map((d) => d.id)),
    anonymousJoins: anonymous(details),
  };
}

function anonymous(details: ReportSessionDetail[]): ExportBundle['anonymousJoins'] {
  return details.flatMap((d) =>
    d.stats.filter((s) => s.platform !== 'total' && s.anonymousJoins > 0).map((s) => ({ sessionId: d.id, platform: s.platform as PlatformId, count: s.anonymousJoins })),
  );
}

// ---------------------------------------------------------------- tables

const C = {
  date: (header: string): Column => ({ header, kind: 'date', width: 20 }),
  text: (header: string, width = 16): Column => ({ header, kind: 'text', width }),
  int: (header: string, width = 12): Column => ({ header, kind: 'int', width }),
  dec: (header: string, width = 12): Column => ({ header, kind: 'dec', width }),
  dur: (header: string): Column => ({ header, kind: 'duration', width: 12 }),
  pct: (header: string): Column => ({ header, kind: 'pct', width: 10 }),
};

/** Build every sheet of an export. Dates are wall-clock epoch ms in the bundle's time zone. */
export function tables(b: ExportBundle): Sheet[] {
  const tz = b.timeZone;
  const t = (iso: string | null): number | null => (iso ? wallClock(Date.parse(iso), tz) : null);
  const tzLabel = tz === 'UTC' ? 'UTC' : tz;
  const multi = b.sessions.length > 1 || b.rangeStats !== null;
  const byId = new Map(b.sessions.map((d) => [d.id, d]));
  const streamCols = (): Column[] => [C.date(`Stream started (${tzLabel})`), C.text('Title', 36)];
  const streamVals = (sessionId: string): CellValue[] => {
    const d = byId.get(sessionId);
    return [t(d?.startedAt ?? null), d?.title ?? ''];
  };
  const statCols = (): Column[] => [
    C.dur('Duration'),
    C.dur('Live time'),
    C.pct('Uptime'),
    C.int('Peak viewers'),
    C.date(`Peak at (${tzLabel})`),
    C.dec('Avg concurrent viewers', 14),
    C.dec('Viewer-minutes', 14),
    C.dec('Minutes with viewer count', 14),
    C.int('Chat messages', 14),
    C.int('Chat events'),
    C.int('Joins'),
    C.int('Anonymous joins', 14),
    C.int('Unique chatters', 14),
    C.dec('Chat per 1k viewer-minutes', 16),
    C.int('Recoveries'),
    C.int('Errors'),
  ];
  const statVals = (s: ReportStats): CellValue[] => [
    s.durationSec,
    s.liveSec,
    s.uptime,
    s.peakViewers,
    t(s.peakViewersAt),
    s.avgViewers,
    s.viewerMinutes,
    s.viewersKnownMinutes,
    s.chatMessages,
    s.chatEvents,
    s.joins,
    s.anonymousJoins,
    s.uniqueChatters,
    s.chatPer1kViewerMinutes,
    s.recoveries,
    s.errors,
  ];

  // Summary: one row per stream (+ every stream together for a range).
  const summary: Sheet = {
    name: 'Summary',
    columns: [
      ...streamCols(),
      C.date(`Ended (${tzLabel})`),
      C.text('Last title', 36),
      C.text('Profile'),
      C.text('Test mode', 10),
      C.text('Platforms', 28),
      ...statCols(),
      C.text('Session id', 38),
    ],
    rows: b.sessions.map((d) => {
      const total = d.stats[d.stats.length - 1]!;
      return [
        t(d.startedAt),
        d.title,
        t(d.endedAt),
        d.lastTitle,
        d.profileName ?? d.profileId,
        d.testMode ? 'yes' : 'no',
        d.platforms.map(platformLabel).join(', '),
        ...statVals(total),
        d.id,
      ];
    }),
  };
  if (b.rangeStats) {
    const total = b.rangeStats[b.rangeStats.length - 1]!;
    summary.rows.push([null, `All ${b.sessions.length} streams`, null, null, null, null, null, ...statVals(total), null]);
  }

  const perPlatform: Sheet = {
    name: 'Per platform',
    columns: [...streamCols(), C.text('Platform', 12), ...statCols()],
    rows: b.sessions.flatMap((d) => d.stats.map((s) => [...streamVals(d.id), platformLabel(s.platform), ...statVals(s)])),
  };
  if (b.rangeStats) for (const s of b.rangeStats) perPlatform.rows.push([null, 'All streams', platformLabel(s.platform), ...statVals(s)]);

  // Viewers: 30 s samples, a column per platform + Total.
  const platforms = [...new Set(b.sessions.flatMap((d) => d.platforms))].sort();
  const viewerCols: Column[] = [C.date(`Time (${tzLabel})`), ...(multi ? [C.text('Stream', 36)] : []), ...platforms.map((p) => C.int(platformLabel(p))), C.int('Total')];
  const viewers: Sheet = {
    name: 'Viewers',
    columns: viewerCols,
    rows: b.sessions.flatMap((d) =>
      d.viewers.map((v) => [t(v.ts), ...(multi ? [d.title] : []), ...platforms.map((p) => v.byPlatform[p] ?? null), v.total]),
    ),
  };
  // Columns: 0 = time, 1..P = platforms, P + 1 = total.
  if (!multi) viewers.chart = { title: 'Concurrent viewers', categoryColumn: 0, seriesColumns: [...platforms.map((_, i) => i + 1), platforms.length + 1] };

  const chat: Sheet = {
    name: 'Chat per minute',
    columns: [C.date(`Minute (${tzLabel})`), ...(multi ? [C.text('Stream', 36)] : []), C.text('Platform', 12), C.int('Messages'), C.int('Events'), C.int('Joins'), C.int('Unique chatters', 14)],
    rows: b.sessions.flatMap((d) =>
      d.chatMinutes.map((m) => [t(m.minute), ...(multi ? [d.title] : []), platformLabel(m.platform), m.messages, m.events, m.joins, m.uniqueChatters]),
    ),
  };

  const destName = (d: ReportSessionDetail, id: string | null) => (id ? (d.destinations.find((x) => x.destinationId === id)?.name ?? '') : '');
  const events: Sheet = {
    name: 'Events',
    columns: [C.date(`Time (${tzLabel})`), ...(multi ? [C.text('Stream', 36)] : []), C.text('Event', 22), C.text('Platform', 12), C.text('Destination', 22), C.text('Detail', 60)],
    rows: b.sessions.flatMap((d) =>
      d.events.map((e) => [t(e.ts), ...(multi ? [d.title] : []), e.kind, e.platform ? platformLabel(e.platform) : '', destName(d, e.destinationId), e.detail ?? '']),
    ),
  };

  const chatters = b.leaderboards.find((l) => l.kind === 'chatters')?.rows ?? [];
  const top: Sheet = {
    name: 'Top chatters',
    columns: [C.int('Rank', 6), C.text('Platform', 12), C.text('Name', 24), C.text('Login', 20), C.text('User id', 32), C.int('Messages'), C.int('Streams'), C.int('Joins'), C.dur('Watch time'), C.date(`First seen (${tzLabel})`), C.date(`Last seen (${tzLabel})`)],
    rows: chatters.map((r, i) => [i + 1, platformLabel(r.platform), r.displayName, r.login ?? '', r.id, r.messages, r.streams, r.joins, r.watchSec, t(r.firstSeenAt), t(r.lastSeenAt)]),
  };

  const audience: Sheet = {
    name: 'Audience',
    columns: [
      ...streamCols(),
      C.text('Platform', 12),
      C.text('Name', 24),
      C.text('User id', 32),
      C.int('Messages'),
      C.int('Events'),
      C.int('Joins'),
      C.date(`First message (${tzLabel})`),
      C.date(`Last message (${tzLabel})`),
      C.date(`First seen (${tzLabel})`),
      C.date(`Last seen (${tzLabel})`),
      C.int('Presence samples', 14),
      C.dur('Watch time'),
    ],
    rows: b.audience.map((a) => [
      ...streamVals(a.sessionId),
      platformLabel(a.platform),
      a.displayName,
      a.userId,
      a.messages,
      a.events,
      a.joins,
      t(a.firstMessageAt),
      t(a.lastMessageAt),
      t(a.firstSeenAt),
      t(a.lastSeenAt),
      a.presenceSamples,
      a.watchSec,
    ]),
  };

  const anon: Sheet = {
    name: 'Anonymous joins',
    columns: [...streamCols(), C.text('Platform', 12), C.int('Anonymous joins', 16)],
    rows: b.anonymousJoins.map((x) => [...streamVals(x.sessionId), platformLabel(x.platform), x.count]),
  };

  const feeds: Sheet = {
    name: 'Feeds',
    columns: [
      C.date(`Minute (${tzLabel})`),
      ...(multi ? [C.text('Stream', 36)] : []),
      C.text('Feed', 12),
      C.text('Online', 8),
      C.text('Codec', 8),
      C.int('Width', 8),
      C.int('Height', 8),
      C.dec('FPS', 8),
      C.dec('Bitrate (kbps)', 14),
      C.dec('Keyframe interval (s)', 18),
    ],
    rows: b.sessions.flatMap((d) =>
      d.feedMinutes.map((f) => [t(f.minute), ...(multi ? [d.title] : []), f.feed, f.online ? 'yes' : 'no', f.codec ?? '', f.width, f.height, f.fps, f.bitrateKbps, f.keyframeSec]),
    ),
  };

  // Issues (alerts, docs/API.md §17) open during each stream, from the 7-day issue history. Last, so
  // the CSV files of the older sheets keep their numbers.
  const issues: Sheet = {
    name: 'Issues',
    columns: [
      C.date(`Started (${tzLabel})`),
      ...(multi ? [C.text('Stream', 36)] : []),
      C.text('Severity', 10),
      C.text('Issue', 36),
      C.text('Affects', 28),
      C.text('Detail', 60),
      C.date(`Cleared (${tzLabel})`),
      C.dur('Duration'),
      C.text('How it ended', 14),
      C.text('Kind', 18),
    ],
    rows: b.sessions.flatMap((d) =>
      (d.issues ?? []).map((i) => [
        t(i.startedAt),
        ...(multi ? [d.title] : []),
        i.severity,
        i.title,
        i.affects,
        i.message ?? '',
        t(i.clearedAt),
        i.durationSec,
        i.resolution ?? (i.clearedAt ? '' : 'still open'),
        i.kind,
      ]),
    ),
  };

  return [summary, perPlatform, viewers, chat, events, top, audience, anon, feeds, issues];
}

// ---------------------------------------------------------------- CSV

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
function csvCell(v: CellValue, kind: Column['kind']): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    if (kind === 'date') {
      const d = new Date(v);
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    }
    if (kind === 'duration') {
      const s = Math.round(v);
      return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
    }
    return String(v);
  }
  let s = typeof v === 'boolean' ? (v ? 'true' : 'false') : v;
  // Spreadsheet formula injection: text that a spreadsheet would run as a formula is quoted.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(sheet: Sheet): string {
  const lines = [sheet.columns.map((c) => csvCell(c.header, 'text')).join(',')];
  for (const row of sheet.rows) lines.push(sheet.columns.map((c, i) => csvCell(row[i], c.kind)).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

const fileSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export interface ExportFile {
  body: Buffer;
  contentType: string;
  fileName: string;
}

export function renderExport(b: ExportBundle, format: ReportExportFormat, baseName: string): ExportFile {
  if (format === 'json') {
    const { timeZone: _tz, ...json } = b;
    return { body: Buffer.from(JSON.stringify({ ...json, version: 1 }, null, 2)), contentType: 'application/json; charset=utf-8', fileName: `${baseName}.json` };
  }
  const sheets = tables(b);
  if (format === 'csv') {
    const files = sheets.map((s, i) => ({ name: `${pad(i + 1)}-${fileSlug(s.name)}.csv`, data: toCsv(s) }));
    return { body: zip(files), contentType: 'application/zip', fileName: `${baseName}-csv.zip` };
  }
  return {
    body: buildXlsx(sheets, { title: baseName }),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileName: `${baseName}.xlsx`,
  };
}

/** `ctd-relay-stream-2026-11-19-2030` / `ctd-relay-streams-2026-11-01-to-2026-11-30`. */
export function exportBaseName(b: ExportBundle): string {
  const day = (iso: string | null) => {
    if (!iso) return '';
    const d = new Date(wallClock(Date.parse(iso), b.timeZone));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };
  if ('sessionId' in b.scope) {
    const s = b.sessions[0];
    const d = s ? new Date(wallClock(Date.parse(s.startedAt), b.timeZone)) : null;
    return d ? `ctd-relay-stream-${day(s!.startedAt)}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}` : 'ctd-relay-stream';
  }
  const from = day(b.scope.from) || 'start';
  const to = day(b.scope.to) || 'now';
  return `ctd-relay-streams-${from}-to-${to}`;
}
