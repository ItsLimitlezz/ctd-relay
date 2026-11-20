// Small dependency-free SVG charts for stream reports: a line chart (viewers over time) and a
// stacked bar chart (chat per minute). Both have a legend, a crosshair/hover tooltip, keyboard
// stepping (arrow keys), and a table view, so nothing is told by colour alone.
//
// Series colours come from the validated categorical palette in pages/reports/reports.css
// (--series-1..8, one fixed slot per platform; checked for colour-blind separation on the Night
// and Paper surfaces). The total is drawn in ink, thicker. Unknown values (null) are gaps.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

export interface ChartSeries {
  key: string;
  label: string;
  /** A CSS colour, e.g. 'var(--series-1)'. */
  color: string;
  values: readonly (number | null)[];
  /** The total: ink colour, thicker line. */
  strong?: boolean;
}

export interface ChartProps {
  title: string;
  /** Epoch ms of each point. */
  times: readonly number[];
  series: readonly ChartSeries[];
  height?: number;
  /** Label of the value column in the table view. */
  valueLabel?: string;
  formatTime?: (t: number) => string;
  emptyText?: string;
}

const PAD = { top: 12, right: 12, bottom: 28, left: 44 };
const LABEL_GUTTER = 86;

export const timeFormat = (t: number): string => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmt = (v: number | null | undefined): string => (v === null || v === undefined ? 'no data' : v.toLocaleString());

/** Round axis maximum and ticks (1, 2, 5 × 10^n). */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  if (out[out.length - 1]! < max) out.push(out[out.length - 1]! + step);
  return out;
}

/** Up to five evenly spread point indexes for the time axis (first and last included). */
export function tickIndexes(n: number, max = 5): number[] {
  const count = Math.min(max, n);
  if (count <= 1) return n > 0 ? [0] : [];
  return [...new Set(Array.from({ length: count }, (_, k) => Math.round((k / (count - 1)) * (n - 1))))];
}

/** SVG path for one series: a new sub-path after every gap (null). */
export function linePath(values: readonly (number | null)[], x: (i: number) => number, y: (v: number) => number): string {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

function useWidth(ref: RefObject<HTMLElement | null>, fallback = 640): number {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) setW(Math.round(width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function Legend({ series }: { series: readonly ChartSeries[] }) {
  return (
    <ul className="viz-legend" aria-hidden="true">
      {series.map((s) => (
        <li key={s.key}>
          <span className={s.strong ? 'viz-swatch is-strong' : 'viz-swatch'} style={{ background: s.strong ? 'var(--text)' : s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function TableView({ title, times, series, valueLabel, formatTime }: Required<Pick<ChartProps, 'title' | 'times' | 'series' | 'formatTime'>> & { valueLabel: string }) {
  return (
    <details className="viz-table">
      <summary>Show as table</summary>
      <div className="table-wrap">
        <table className="data-table">
          <caption className="sr-only">
            {title} ({valueLabel})
          </caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              {series.map((s) => (
                <th key={s.key} scope="col">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {times.map((t, i) => (
              <tr key={t}>
                <th scope="row">{formatTime(t)}</th>
                {series.map((s) => (
                  <td key={s.key}>{s.values[i] === null || s.values[i] === undefined ? '—' : s.values[i]!.toLocaleString()}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Hover / keyboard position over the points. */
function useCursor(n: number) {
  const [i, setI] = useState<number | null>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (n === 0) return;
    const cur = i ?? n - 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = Math.min(n - 1, cur + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, cur - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape') {
      setI(null);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    setI(next);
  };
  return { i, setI, onKeyDown };
}

function Tooltip({ x, width, time, rows }: { x: number; width: number; time: string; rows: { key: string; label: string; color: string; strong?: boolean; value: number | null }[] }) {
  const left = Math.min(Math.max(8, x + 12), Math.max(8, width - 180));
  return (
    <div className="viz-tooltip" style={{ left }} role="status" aria-live="polite">
      <div className="viz-tooltip-time">{time}</div>
      {rows.map((r) => (
        <div key={r.key} className="viz-tooltip-row">
          <span className={r.strong ? 'viz-swatch is-strong' : 'viz-swatch'} style={{ background: r.strong ? 'var(--text)' : r.color }} />
          <span>{r.label}</span>
          <strong>{fmt(r.value)}</strong>
        </div>
      ))}
    </div>
  );
}

export function LineChart({ title, times, series, height = 240, valueLabel = 'viewers', formatTime = timeFormat, emptyText = 'No viewer counts were recorded.' }: ChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const cursor = useCursor(times.length);
  const labelId = useId();
  const known = series.some((s) => s.values.some((v) => v !== null));
  const directLabels = width >= 480 && series.length <= 4;
  const right = PAD.right + (directLabels ? LABEL_GUTTER : 0);
  const geo = useMemo(() => {
    const max = Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1] || 1;
    const t0 = times[0] ?? 0;
    const t1 = times[times.length - 1] ?? t0 + 1;
    const span = Math.max(1, t1 - t0);
    const plotW = Math.max(10, width - PAD.left - right);
    const plotH = height - PAD.top - PAD.bottom;
    const x = (i: number) => PAD.left + (((times[i] ?? t0) - t0) / span) * plotW;
    const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
    return { ticks, x, y, plotW, plotH, t0, span };
  }, [series, times, width, height, right]);

  if (times.length === 0 || !known) return <p className="muted small">{emptyText}</p>;

  const xTicks = tickIndexes(times.length, width < 480 ? 3 : 5);
  // Direct labels at each series' last known point, nudged apart.
  const ends = directLabels
    ? series
        .map((s) => {
          let idx = -1;
          for (let k = s.values.length - 1; k >= 0; k--) if (s.values[k] !== null && s.values[k] !== undefined) {
            idx = k;
            break;
          }
          return idx < 0 ? null : { key: s.key, label: s.label, y: geo.y(s.values[idx]!), x: geo.x(idx) };
        })
        .filter((e): e is { key: string; label: string; y: number; x: number } => e !== null)
        .sort((a, b) => a.y - b.y)
    : [];
  for (let k = 1; k < ends.length; k++) if (ends[k]!.y - ends[k - 1]!.y < 13) ends[k]!.y = ends[k - 1]!.y + 13;

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = geo.t0 + (px / Math.max(1, rect.width)) * geo.span;
    let best = 0;
    for (let k = 1; k < times.length; k++) if (Math.abs(times[k]! - t) < Math.abs(times[best]! - t)) best = k;
    cursor.setI(best);
  };
  const i = cursor.i;

  return (
    <figure className="viz report-viz" aria-labelledby={labelId}>
      <figcaption id={labelId} className="viz-title">
        {title}
      </figcaption>
      <Legend series={series} />
      <div
        className="viz-plot"
        ref={box}
        tabIndex={0}
        role="group"
        aria-label={`${title}. Use the arrow keys to read values; the table view lists every point.`}
        onKeyDown={cursor.onKeyDown}
        onBlur={() => cursor.setI(null)}
      >
        <svg width={width} height={height} aria-hidden="true" focusable="false">
          {geo.ticks.map((v) => (
            <g key={v}>
              <line className="viz-grid" x1={PAD.left} x2={PAD.left + geo.plotW} y1={geo.y(v)} y2={geo.y(v)} />
              <text className="viz-axis" x={PAD.left - 6} y={geo.y(v)} dy="0.32em" textAnchor="end">
                {v.toLocaleString()}
              </text>
            </g>
          ))}
          {xTicks.map((k) => (
            <text key={k} className="viz-axis" x={geo.x(k)} y={height - 8} textAnchor={k === 0 ? 'start' : k === times.length - 1 ? 'end' : 'middle'}>
              {formatTime(times[k]!)}
            </text>
          ))}
          {series.map((s) => (
            <path
              key={s.key}
              d={linePath(s.values, geo.x, geo.y)}
              fill="none"
              stroke={s.strong ? 'var(--text)' : s.color}
              strokeWidth={s.strong ? 2.5 : 2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {ends.map((e) => (
            <text key={e.key} className="viz-direct" x={PAD.left + geo.plotW + 6} y={e.y} dy="0.32em">
              {e.label}
            </text>
          ))}
          {i !== null && (
            <g>
              <line className="viz-crosshair" x1={geo.x(i)} x2={geo.x(i)} y1={PAD.top} y2={PAD.top + geo.plotH} />
              {series.map((s) =>
                s.values[i] === null || s.values[i] === undefined ? null : (
                  <circle key={s.key} cx={geo.x(i)} cy={geo.y(s.values[i]!)} r={4} fill={s.strong ? 'var(--text)' : s.color} stroke="var(--bg-elev)" strokeWidth={2} />
                ),
              )}
            </g>
          )}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={geo.plotW}
            height={geo.plotH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerDown={onMove}
            onPointerLeave={() => cursor.setI(null)}
          />
        </svg>
        {i !== null && (
          <Tooltip
            x={geo.x(i)}
            width={width}
            time={formatTime(times[i]!)}
            rows={series.map((s) => ({ key: s.key, label: s.label, color: s.color, strong: s.strong, value: s.values[i] ?? null }))}
          />
        )}
      </div>
      <TableView title={title} times={times} series={series} valueLabel={valueLabel} formatTime={formatTime} />
    </figure>
  );
}

/** Stacked bars, one per time slot (minute), one segment per series; a 2px gap between segments. */
export function StackedBars({ title, times, series, height = 200, valueLabel = 'messages', formatTime = timeFormat, emptyText = 'No chat was recorded.' }: ChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const cursor = useCursor(times.length);
  const labelId = useId();
  const totals = times.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const max = Math.max(0, ...totals);
  if (times.length === 0 || max === 0) return <p className="muted small">{emptyText}</p>;
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const slot = plotW / times.length;
  const barW = Math.max(1, Math.min(24, slot - 2));
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const xTicks = tickIndexes(times.length, width < 480 ? 3 : 5);
  const i = cursor.i;
  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    cursor.setI(Math.max(0, Math.min(times.length - 1, Math.floor(((e.clientX - rect.left) / Math.max(1, rect.width)) * times.length))));
  };
  return (
    <figure className="viz report-viz" aria-labelledby={labelId}>
      <figcaption id={labelId} className="viz-title">
        {title}
      </figcaption>
      {series.length > 1 && <Legend series={series} />}
      <div
        className="viz-plot"
        ref={box}
        tabIndex={0}
        role="group"
        aria-label={`${title}. Use the arrow keys to read values; the table view lists every minute.`}
        onKeyDown={cursor.onKeyDown}
        onBlur={() => cursor.setI(null)}
      >
        <svg width={width} height={height} aria-hidden="true" focusable="false">
          {ticks.map((v) => (
            <g key={v}>
              <line className="viz-grid" x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} />
              <text className="viz-axis" x={PAD.left - 6} y={y(v)} dy="0.32em" textAnchor="end">
                {v.toLocaleString()}
              </text>
            </g>
          ))}
          {xTicks.map((k) => (
            <text key={k} className="viz-axis" x={PAD.left + k * slot + slot / 2} y={height - 8} textAnchor={k === 0 ? 'start' : k === times.length - 1 ? 'end' : 'middle'}>
              {formatTime(times[k]!)}
            </text>
          ))}
          {times.map((t, k) => {
            let acc = 0;
            const x = PAD.left + k * slot + (slot - barW) / 2;
            return (
              <g key={t} opacity={i === null || i === k ? 1 : 0.55}>
                {series.map((s) => {
                  const v = s.values[k] ?? 0;
                  if (v <= 0) return null;
                  const y1 = y(acc);
                  acc += v;
                  const y2 = y(acc);
                  // 2px surface gap between stacked segments.
                  const h = Math.max(1, y1 - y2 - (acc < totals[k]! ? 2 : 0));
                  return <rect key={s.key} x={x} y={y2} width={barW} height={h} fill={s.color} />;
                })}
              </g>
            );
          })}
          <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} fill="transparent" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => cursor.setI(null)} />
        </svg>
        {i !== null && (
          <Tooltip
            x={PAD.left + i * slot}
            width={width}
            time={formatTime(times[i]!)}
            rows={[
              ...series.map((s) => ({ key: s.key, label: s.label, color: s.color, value: s.values[i] ?? 0 })),
              ...(series.length > 1 ? [{ key: '__total', label: 'Total', color: 'var(--text)', strong: true, value: totals[i] ?? 0 }] : []),
            ]}
          />
        )}
      </div>
      <TableView title={title} times={times} series={series} valueLabel={valueLabel} formatTime={formatTime} />
    </figure>
  );
}
