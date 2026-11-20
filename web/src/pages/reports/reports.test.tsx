import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReportSessionDetail, ReportStats } from '@shared/reports';
import { LineChart, StackedBars, linePath, niceTicks, tickIndexes } from '../../components/ReportCharts';
import { ROUTES } from '../../router';
import { PlatformTable, StatTiles } from './ReportParts';
import { chatChart, defaultRange, formatHms, formatNum, formatPct, platformColor, viewerChart } from './report-format';

const stats = (over: Partial<ReportStats> = {}): ReportStats => ({
  platform: 'total',
  durationSec: 3600,
  liveSec: 3500,
  uptime: 0.9722,
  peakViewers: 40,
  peakViewersAt: '2026-11-19T20:30:00.000Z',
  avgViewers: 21.5,
  viewerMinutes: 1290,
  viewersKnownMinutes: 60,
  chatMessages: 120,
  chatEvents: 4,
  joins: 3,
  anonymousJoins: 2,
  uniqueChatters: 9,
  chatPer1kViewerMinutes: 93,
  recoveries: 1,
  errors: 0,
  ...over,
});

describe('report-format', () => {
  it('formats unknown as a dash, never 0', () => {
    expect(formatNum(null)).toBe('—');
    expect(formatPct(null)).toBe('—');
    expect(formatHms(null)).toBe('—');
    expect(formatHms(3725)).toBe('1:02:05');
    expect(formatHms(65)).toBe('1:05');
  });

  it('gives each platform a fixed palette slot', () => {
    expect(platformColor('twitch')).toBe('var(--series-1)');
    expect(platformColor('youtube')).toBe('var(--series-2)');
    expect(platformColor('tiktok')).toBe('var(--series-7)');
  });

  it('viewer chart: a series per platform, a total when there are several, nulls kept', () => {
    const d: Pick<ReportSessionDetail, 'viewers' | 'platforms'> = {
      platforms: ['twitch', 'youtube'],
      viewers: [
        { ts: '2026-11-19T20:00:00.000Z', total: 5, byPlatform: { twitch: 5, youtube: null } },
        { ts: '2026-11-19T20:00:30.000Z', total: 12, byPlatform: { twitch: 6, youtube: 6 } },
      ],
    };
    const c = viewerChart(d);
    expect(c.series.map((s) => s.key)).toEqual(['twitch', 'youtube', 'total']);
    expect(c.series[1]!.values).toEqual([null, 6]);
    expect(c.series[2]!.strong).toBe(true);
    expect(viewerChart({ ...d, platforms: ['twitch'] }).series.map((s) => s.key)).toEqual(['twitch']);
  });

  it('chat chart fills minutes without chat with 0 (no chat is a real zero)', () => {
    const c = chatChart([
      { minute: '2026-11-19T20:00:00.000Z', platform: 'twitch', messages: 3, events: 0, joins: 0, uniqueChatters: 2 },
      { minute: '2026-11-19T20:02:00.000Z', platform: 'kick', messages: 1, events: 0, joins: 0, uniqueChatters: 1 },
    ]);
    expect(c.times).toHaveLength(3);
    expect(c.series.map((s) => [s.key, s.values])).toEqual([
      ['twitch', [3, 0, 0]],
      ['kick', [0, 0, 1]],
    ]);
  });

  it('default range: the last 30 days', () => {
    expect(defaultRange(new Date(2026, 10, 19, 12))).toEqual({ from: '2026-10-21', to: '2026-11-19' });
  });
});

describe('ReportCharts', () => {
  it('nice ticks and gaps in lines', () => {
    expect(niceTicks(37)).toEqual([0, 10, 20, 30, 40]);
    expect(tickIndexes(3)).toEqual([0, 1, 2]);
    expect(tickIndexes(100)).toEqual([0, 25, 50, 74, 99]);
    expect(linePath([1, null, 2, 3], (i) => i, (v) => v)).toBe('M0.0,1.0M2.0,2.0L3.0,3.0');
  });

  it('renders a labelled figure with a legend and a table view', () => {
    const html = renderToStaticMarkup(
      <LineChart
        title="Concurrent viewers"
        times={[0, 30_000]}
        series={[
          { key: 'twitch', label: 'Twitch', color: 'var(--series-1)', values: [1, null] },
          { key: 'total', label: 'Total', color: 'var(--text)', strong: true, values: [1, null] },
        ]}
      />,
    );
    expect(html).toContain('<figure');
    expect(html).toContain('Concurrent viewers');
    expect(html).toContain('viz-legend');
    expect(html).toContain('Show as table');
    expect(html).toContain('<td>—</td>'); // unknown in the table, not 0
  });

  it('says so when nothing was recorded', () => {
    expect(renderToStaticMarkup(<LineChart title="x" times={[0]} series={[{ key: 'a', label: 'A', color: 'red', values: [null] }]} />)).toContain('No viewer counts');
    expect(renderToStaticMarkup(<StackedBars title="x" times={[]} series={[]} />)).toContain('No chat');
  });
});

describe('Reports page parts', () => {
  it('labels viewer-minutes as such, not unique viewers', () => {
    const html = renderToStaticMarkup(<StatTiles stats={stats()} streams={3} />);
    expect(html).toContain('Viewer-minutes');
    expect(html).toContain('not unique viewers');
    expect(html).toContain('97.2 %');
  });

  it('per-platform table shows unnamed joins', () => {
    const html = renderToStaticMarkup(<PlatformTable stats={[stats({ platform: 'instagram' }), stats()]} />);
    expect(html).toContain('+ 2 unnamed');
    expect(html).toContain('Total');
  });

  it('is in the main navigation for every signed-in user', () => {
    expect(ROUTES.find((r) => r.name === 'reports')).toMatchObject({ path: '/reports', nav: true, adminOnly: false });
  });
});
