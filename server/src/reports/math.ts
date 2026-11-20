// Report math (docs/REPORTS.md → "How the numbers are worked out"). Pure functions over samples.
//
// Viewer samples are a step function: a sample holds until the next sample of the same
// destination, but for at most HOLD_MS. Longer gaps (Relay restarted, a sample was lost) are
// unknown, not "still the same". Unknown values (null) are left out: they add nothing to
// viewer-minutes and are not part of the time an average is taken over.

/** A sample counts for at most this long (three missed 30 s samples). */
export const HOLD_MS = 90_000;

export interface Point {
  /** Epoch ms. */
  t: number;
  /** null = unknown. */
  v: number | null;
}

export interface SeriesStats {
  /** Viewers × milliseconds over the known time. */
  viewerMs: number;
  /** Milliseconds the value was known. */
  knownMs: number;
  peak: number | null;
  peakAt: number | null;
}

/**
 * Turn raw samples of one destination into a step series whose points mark every change,
 * including the moment a value expires after `hold` ms without a new sample.
 */
export function stepSeries(samples: readonly Point[], hold = HOLD_MS): Point[] {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const out: Point[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]!;
    const next = sorted[i + 1];
    // Several samples at the same ms: the last one wins.
    if (next && next.t === p.t) continue;
    push(out, p.t, p.v);
    const expiry = p.t + hold;
    if (p.v !== null && (!next || next.t > expiry)) push(out, expiry, null);
  }
  return out;
}

function push(out: Point[], t: number, v: number | null): void {
  const last = out[out.length - 1];
  if (last && last.t === t) {
    last.v = v;
    return;
  }
  if (last && last.v === v) return;
  out.push({ t, v });
}

/** Value of a step series at `t` (null before its first point). */
export function valueAt(series: readonly Point[], t: number): number | null {
  let lo = 0;
  let hi = series.length - 1;
  let found: Point | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = series[mid]!;
    if (p.t <= t) {
      found = p;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found ? found.v : null;
}

/**
 * Sum of step series (a platform = its destinations, the total = every platform). At any moment
 * the sum covers the series that are known then; when none is known the sum is unknown (null).
 */
export function sumSeries(series: readonly (readonly Point[])[]): Point[] {
  const times = [...new Set(series.flatMap((s) => s.map((p) => p.t)))].sort((a, b) => a - b);
  const out: Point[] = [];
  for (const t of times) {
    let sum: number | null = null;
    for (const s of series) {
      const v = valueAt(s, t);
      if (v !== null) sum = (sum ?? 0) + v;
    }
    push(out, t, sum);
  }
  return out;
}

/** Integrate a step series over [start, end). */
export function seriesStats(series: readonly Point[], start: number, end: number): SeriesStats {
  let viewerMs = 0;
  let knownMs = 0;
  let peak: number | null = null;
  let peakAt: number | null = null;
  for (let i = 0; i < series.length; i++) {
    const p = series[i]!;
    if (p.v === null) continue;
    const from = Math.max(p.t, start);
    const to = Math.min(series[i + 1]?.t ?? end, end);
    if (to <= from) {
      // A value that only exists at the very end still counts as seen (peak), with no duration.
      if (p.t >= start && p.t <= end && (peak === null || p.v > peak)) {
        peak = p.v;
        peakAt = p.t;
      }
      continue;
    }
    viewerMs += p.v * (to - from);
    knownMs += to - from;
    if (peak === null || p.v > peak) {
      peak = p.v;
      peakAt = from;
    }
  }
  return { viewerMs, knownMs, peak, peakAt };
}

export interface Interval {
  start: number;
  /** null = still open (ends at the session's end). */
  end: number | null;
}

/** Length of the union of intervals, clipped to [start, end). */
export function unionMs(intervals: readonly Interval[], start: number, end: number): number {
  const clipped = intervals
    .map((i) => ({ a: Math.max(i.start, start), b: Math.min(i.end ?? end, end) }))
    .filter((i) => i.b > i.a)
    .sort((x, y) => x.a - y.a);
  let total = 0;
  let curA = -Infinity;
  let curB = -Infinity;
  for (const i of clipped) {
    if (i.a > curB) {
      if (curB > curA) total += curB - curA;
      curA = i.a;
      curB = i.b;
    } else if (i.b > curB) {
      curB = i.b;
    }
  }
  if (curB > curA) total += curB - curA;
  return total;
}

/** Round to `digits` decimals; null stays null. */
export function round(v: number | null, digits = 1): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Messages per 1000 viewer-minutes (null without viewer-minutes). */
export function chatRate(messages: number, viewerMinutes: number | null): number | null {
  if (viewerMinutes === null || viewerMinutes <= 0) return null;
  return round((messages / viewerMinutes) * 1000, 1);
}
