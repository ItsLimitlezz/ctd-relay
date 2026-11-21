// Pure helpers for the Reports pages: formatting, chart data, labels. Tested in reports.test.ts.

import type { ChatMinute, LeaderboardKind, ReportEventKind, ReportSessionDetail, ReportStats } from '@shared/reports';
import { PLATFORM_IDS, type PlatformId } from '@shared/types';
import type { ChartSeries } from '../../components/ReportCharts';
import { platformName } from '../../components/PlatformBadge';

/** One fixed palette slot per platform (--series-1..8 in reports.css): colour follows the platform. */
export function platformColor(p: PlatformId | string): string {
  const i = (PLATFORM_IDS as readonly string[]).indexOf(p);
  return `var(--series-${(i < 0 ? PLATFORM_IDS.length - 1 : i) + 1})`;
}

export function formatHms(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** "2 h 05 m" style for headlines. */
export function formatLongDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export function formatNum(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function formatPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })} %`;
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const statsTotal = (stats: readonly ReportStats[]): ReportStats | undefined => stats.find((s) => s.platform === 'total');

/** Viewers chart: a line per platform plus the total (when more than one platform). */
export function viewerChart(d: Pick<ReportSessionDetail, 'viewers' | 'platforms'>): { times: number[]; series: ChartSeries[] } {
  const times = d.viewers.map((v) => Date.parse(v.ts));
  const platforms = PLATFORM_IDS.filter((p) => d.platforms.includes(p));
  const series: ChartSeries[] = platforms.map((p) => ({
    key: p,
    label: platformName(p),
    color: platformColor(p),
    values: d.viewers.map((v) => v.byPlatform[p] ?? null),
  }));
  if (d.platforms.length > 1) series.push({ key: 'total', label: 'Total', color: 'var(--text)', strong: true, values: d.viewers.map((v) => v.total) });
  return { times, series };
}

/** Chat per minute: one bar per minute from the first to the last minute with chat, a segment per platform. */
export function chatChart(minutes: readonly ChatMinute[]): { times: number[]; series: ChartSeries[] } {
  if (minutes.length === 0) return { times: [], series: [] };
  const ts = minutes.map((m) => Date.parse(m.minute));
  const first = Math.min(...ts);
  const last = Math.max(...ts);
  const times: number[] = [];
  for (let t = first; t <= last && times.length < 24 * 60; t += 60_000) times.push(t);
  const platforms = PLATFORM_IDS.filter((p) => minutes.some((m) => m.platform === p));
  const series = platforms.map((p) => {
    const by = new Map(minutes.filter((m) => m.platform === p).map((m) => [Date.parse(m.minute), m.messages]));
    return { key: p, label: platformName(p), color: platformColor(p), values: times.map((t) => by.get(t) ?? 0) };
  });
  return { times, series };
}

export const EVENT_LABEL: Record<ReportEventKind, string> = {
  'session.start': 'Stream started',
  'session.end': 'Stream ended',
  title: 'Title changed',
  'destination.live': 'Live',
  'destination.offline': 'Went offline',
  'destination.retrying': 'Retrying',
  'destination.recovery': 'Recovered (new live)',
  'destination.error': 'Error',
  'destination.blocked': 'Blocked',
  'feed.online': 'Feed online',
  'feed.offline': 'Feed offline',
  'presence.unavailable': 'No watch time',
};

export function eventTone(kind: ReportEventKind): 'danger' | 'warn' | 'success' | 'neutral' | 'info' {
  if (kind === 'destination.error' || kind === 'destination.blocked') return 'danger';
  if (kind === 'destination.retrying' || kind === 'destination.recovery' || kind === 'feed.offline' || kind === 'presence.unavailable') return 'warn';
  if (kind === 'destination.live' || kind === 'feed.online' || kind === 'session.start') return 'success';
  if (kind === 'title') return 'info';
  return 'neutral';
}

export const BOARD_LABEL: Record<LeaderboardKind, string> = {
  chatters: 'Top chatters',
  loyal: 'Most loyal',
  watch: 'Longest watch time',
  newest: 'Newest regulars',
};

export const BOARD_HELP: Record<LeaderboardKind, string> = {
  chatters: 'Most chat messages.',
  loyal: 'Most streams attended: chatted, joined, or in the platform’s viewer list.',
  watch: 'Only platforms that tell CTD Relay who is watching (Twitch’s chatters list). Others have no watch time.',
  newest: 'First seen in this period and back for at least two streams (for one stream: first-timers).',
};

/** YYYY-MM-DD in local time. */
export function dayInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The default range: the last 30 days, today included. */
export function defaultRange(now = new Date()): { from: string; to: string } {
  const from = new Date(now);
  from.setDate(from.getDate() - 29);
  return { from: dayInput(from), to: dayInput(now) };
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
