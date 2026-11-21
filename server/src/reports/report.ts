// Builds the report objects (shared/reports.ts) from the stored rows (store.ts) with math.ts.

import type { PlatformId } from '../../../shared/types.js';
import type {
  AudienceUserDetail,
  Leaderboard,
  LeaderboardKind,
  LeaderboardRow,
  ReportDestination,
  ReportRangeSummary,
  ReportSessionDetail,
  ReportSessionSummary,
  ReportStats,
} from '../../../shared/reports.js';
import { LEADERBOARD_KINDS } from '../../../shared/reports.js';
import { chatRate, round, seriesStats, stepSeries, sumSeries, unionMs, valueAt, type Point, type SeriesStats } from './math.js';
import type { ChatTotalsRow, ReportStore, SessionFilter, SessionRow } from './store.js';

export const LEADERBOARD_DEFAULT_LIMIT = 25;
export const LEADERBOARD_MAX_LIMIT = 500;
/** "Newest regulars" over a range: first stream in the range and at least this many streams in it. */
export const REGULAR_MIN_STREAMS = 2;

export interface ReportContext {
  store: ReportStore;
  now?: () => number;
  profileName?: (id: string) => string | null;
}

const ms = (iso: string): number => Date.parse(iso);
const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());

/** Everything about a set of sessions, loaded at once. */
interface Loaded {
  sessions: SessionRow[];
  titles: ReturnType<ReportStore['titles']>;
  destinations: ReturnType<ReportStore['destinations']>;
  live: ReturnType<ReportStore['livePeriods']>;
  events: ReturnType<ReportStore['events']>;
  samples: ReturnType<ReportStore['viewerSamples']>;
  chatTotals: ChatTotalsRow[];
  presence: ReturnType<ReportStore['presence']>;
}

function load(store: ReportStore, sessions: SessionRow[]): Loaded {
  const ids = sessions.map((s) => s.id);
  return {
    sessions,
    titles: store.titles(ids),
    destinations: store.destinations(ids),
    live: store.livePeriods(ids),
    events: store.events(ids),
    samples: store.viewerSamples(ids),
    chatTotals: store.chatTotals(ids),
    presence: store.presence(ids),
  };
}

/** The intermediate numbers of one session, so ranges can add them up. */
interface SessionCalc {
  session: SessionRow;
  start: number;
  end: number;
  platforms: PlatformId[];
  /** Per platform and 'total' (empty in a cached calc: only the stream view needs them). */
  series: Map<PlatformId | 'total', Point[]>;
  /** seriesStats of each series over the session. */
  viewerStats: Map<PlatformId | 'total', SeriesStats>;
  perPlatform: Map<PlatformId, { liveMs: number; destLiveMs: number; destCount: number }>;
  /** Time at least one destination was live. */
  anyLiveMs: number;
  chat: Map<PlatformId, ChatTotalsRow>;
  uniques: Map<PlatformId, number>;
  recoveries: Map<PlatformId, number>;
  errors: Map<PlatformId, number>;
  sampleTimes: number[];
}

function calcSession(ctx: ReportContext, l: Loaded, s: SessionRow, uniquesAudience: Map<PlatformId, number>): SessionCalc {
  const now = (ctx.now ?? Date.now)();
  const start = ms(s.startedAt);
  const end = Math.max(start, s.endedAt ? ms(s.endedAt) : now);
  const dests = l.destinations.filter((d) => d.sessionId === s.id);
  const platforms = [...new Set(dests.map((d) => d.platform))].sort();
  const samples = l.samples.filter((x) => x.sessionId === s.id);
  const destSeries = new Map<string, Point[]>();
  for (const d of dests) {
    destSeries.set(
      d.destinationId,
      stepSeries(samples.filter((x) => x.destinationId === d.destinationId).map((x) => ({ t: ms(x.ts), v: x.viewers }))),
    );
  }
  const series = new Map<PlatformId | 'total', Point[]>();
  for (const p of platforms) {
    series.set(p, sumSeries(dests.filter((d) => d.platform === p).map((d) => destSeries.get(d.destinationId) ?? [])));
  }
  series.set('total', sumSeries(platforms.map((p) => series.get(p) ?? [])));
  const viewerStats = new Map<PlatformId | 'total', SeriesStats>();
  for (const [k, v] of series) viewerStats.set(k, seriesStats(v, start, end));

  const live = l.live.filter((x) => x.sessionId === s.id);
  const perPlatform = new Map<PlatformId, { liveMs: number; destLiveMs: number; destCount: number }>();
  for (const p of platforms) {
    const pd = dests.filter((d) => d.platform === p);
    const intervals = live.filter((x) => pd.some((d) => d.destinationId === x.destinationId)).map((x) => ({ start: ms(x.startedAt), end: x.endedAt ? ms(x.endedAt) : null }));
    const destLiveMs = pd.reduce(
      (sum, d) =>
        sum +
        unionMs(
          live.filter((x) => x.destinationId === d.destinationId).map((x) => ({ start: ms(x.startedAt), end: x.endedAt ? ms(x.endedAt) : null })),
          start,
          end,
        ),
      0,
    );
    perPlatform.set(p, { liveMs: unionMs(intervals, start, end), destLiveMs, destCount: pd.length });
  }

  const anyLiveMs = unionMs(live.map((x) => ({ start: ms(x.startedAt), end: x.endedAt ? ms(x.endedAt) : null })), start, end);
  const chat = new Map<PlatformId, ChatTotalsRow>();
  for (const c of l.chatTotals.filter((x) => x.sessionId === s.id)) chat.set(c.platform, c);
  const uniques = new Map<PlatformId, number>();
  for (const p of new Set([...platforms, ...chat.keys()])) {
    uniques.set(p, Math.max(chat.get(p)?.uniqueChatters ?? 0, uniquesAudience.get(p) ?? 0));
  }
  const events = l.events.filter((e) => e.sessionId === s.id);
  const count = (kinds: string[]) => {
    const m = new Map<PlatformId, number>();
    for (const e of events) if (e.platform && kinds.includes(e.kind)) m.set(e.platform, (m.get(e.platform) ?? 0) + 1);
    return m;
  };
  const sampleTimes = [...new Set(samples.map((x) => ms(x.ts)))].filter((t) => t >= start && t <= end).sort((a, b) => a - b);
  return {
    session: s,
    start,
    end,
    platforms,
    series,
    viewerStats,
    perPlatform,
    anyLiveMs,
    chat,
    uniques,
    recoveries: count(['destination.recovery']),
    errors: count(['destination.error', 'destination.blocked']),
    sampleTimes,
  };
}

const NO_VIEWERS: SeriesStats = { viewerMs: 0, knownMs: 0, peak: null, peakAt: null };

/** Add up per-platform (and total) stats over one or more sessions. */
function aggregate(calcs: readonly SessionCalc[], uniquesOverride: Map<PlatformId, number> | null): ReportStats[] {
  const platforms = [...new Set(calcs.flatMap((c) => [...c.platforms, ...c.chat.keys()]))].sort();
  const make = (platform: PlatformId | 'total'): ReportStats => {
    let durationMs = 0;
    let liveMs = 0;
    let destLiveMs = 0;
    let destDurMs = 0;
    let viewerMs = 0;
    let knownMs = 0;
    let anyViewers = false;
    let peak: number | null = null;
    let peakAt: number | null = null;
    let messages = 0;
    let events = 0;
    let joins = 0;
    let anon = 0;
    let uniques = 0;
    let recoveries = 0;
    let errors = 0;
    for (const c of calcs) {
      const dur = c.end - c.start;
      const relevant = platform === 'total' || c.platforms.includes(platform) || c.chat.has(platform);
      if (!relevant) continue;
      durationMs += dur;
      const pps = platform === 'total' ? [...c.perPlatform.values()] : [c.perPlatform.get(platform)].filter((x) => x !== undefined);
      liveMs += platform === 'total' ? c.anyLiveMs : (pps[0]?.liveMs ?? 0);
      for (const x of pps) {
        destLiveMs += x.destLiveMs;
        destDurMs += x.destCount * dur;
      }
      const st = c.viewerStats.get(platform) ?? NO_VIEWERS;
      if (st.knownMs > 0 || st.peak !== null) anyViewers = true;
      viewerMs += st.viewerMs;
      knownMs += st.knownMs;
      if (st.peak !== null && (peak === null || st.peak > peak)) {
        peak = st.peak;
        peakAt = st.peakAt;
      }
      const chats = platform === 'total' ? [...c.chat.values()] : [c.chat.get(platform)].filter((x) => x !== undefined);
      for (const ch of chats) {
        messages += ch.messages;
        events += ch.events;
        joins += ch.joins;
        anon += ch.anonymousJoins;
      }
      uniques += platform === 'total' ? [...c.uniques.values()].reduce((a, b) => a + b, 0) : (c.uniques.get(platform) ?? 0);
      const rec = platform === 'total' ? [...c.recoveries.values()].reduce((a, b) => a + b, 0) : (c.recoveries.get(platform) ?? 0);
      const err = platform === 'total' ? [...c.errors.values()].reduce((a, b) => a + b, 0) : (c.errors.get(platform) ?? 0);
      recoveries += rec;
      errors += err;
    }
    if (uniquesOverride) {
      uniques = platform === 'total' ? [...uniquesOverride.values()].reduce((a, b) => a + b, 0) : (uniquesOverride.get(platform) ?? 0);
    }
    const viewerMinutes = anyViewers ? round(viewerMs / 60_000, 1) : null;
    // Uptime: one platform = time any of its destinations was live; the total = the mean over every destination.
    const uptimeBase = platform === 'total' ? destDurMs : durationMs;
    const uptimeLive = platform === 'total' ? destLiveMs : liveMs;
    return {
      platform,
      durationSec: Math.round(durationMs / 1000),
      liveSec: Math.round(liveMs / 1000),
      uptime: uptimeBase > 0 ? round(uptimeLive / uptimeBase, 4) : null,
      peakViewers: peak,
      peakViewersAt: iso(peakAt),
      avgViewers: knownMs > 0 ? round(viewerMs / knownMs, 1) : null,
      viewerMinutes,
      viewersKnownMinutes: round(knownMs / 60_000, 1) ?? 0,
      chatMessages: messages,
      chatEvents: events,
      joins,
      anonymousJoins: anon,
      uniqueChatters: uniquesOverride === null && calcs.length > 1 ? null : uniques,
      chatPer1kViewerMinutes: chatRate(messages, viewerMinutes),
      recoveries,
      errors,
    };
  };
  return [...platforms.map(make), make('total')];
}

function summaryOf(ctx: ReportContext, titles: { first: string; last: string }, c: SessionCalc, stats: ReportStats[]): ReportSessionSummary {
  const s = c.session;
  const total = stats[stats.length - 1]!;
  return {
    id: s.id,
    profileId: s.profileId,
    profileName: ctx.profileName?.(s.profileId) ?? null,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    endedByRestart: s.endedByRestart,
    testMode: s.testMode,
    title: titles.first,
    lastTitle: titles.last,
    platforms: c.platforms,
    durationSec: Math.round((c.end - c.start) / 1000),
    peakViewers: total.peakViewers,
    viewerMinutes: total.viewerMinutes,
    chatMessages: total.chatMessages,
    uniqueChatters: total.uniqueChatters,
  };
}

/**
 * One session's rows, intermediate numbers and stats. Sessions are loaded one at a time (indexed by
 * session id), so a list or a year-long range holds one stream's samples in memory at once and the
 * work grows with the number of rows, not rows × sessions.
 */
function calcOne(ctx: ReportContext, s: SessionRow): { l: Loaded; c: SessionCalc; stats: ReportStats[] } {
  const l = load(ctx.store, [s]);
  const c = calcSession(ctx, l, s, s.audience ? ctx.store.uniqueChattersByPlatform([s.id]) : new Map());
  return { l, c, stats: aggregate([c], null) };
}

/**
 * The numbers of a stream that has ended don't change until rows are deleted (forget a user,
 * retention), so lists and ranges keep them (scalars only, about 1 KB a stream) instead of reading
 * every viewer sample again. Keyed by store; dropped when the store's generation changes.
 */
interface CachedCalc {
  key: string;
  c: SessionCalc;
  stats: ReportStats[];
  title: string;
  lastTitle: string;
}
const calcCaches = new WeakMap<ReportStore, { generation: number; byId: Map<string, CachedCalc> }>();
export const CALC_CACHE_MAX = 5000;

function cachedCalc(ctx: ReportContext, s: SessionRow): { c: SessionCalc; stats: ReportStats[]; title: string; lastTitle: string } {
  const key = `${s.endedAt ?? ''}|${s.audience ? 1 : 0}|${s.testMode ? 1 : 0}`;
  let cache = calcCaches.get(ctx.store);
  if (!cache || cache.generation !== ctx.store.generation()) {
    cache = { generation: ctx.store.generation(), byId: new Map() };
    calcCaches.set(ctx.store, cache);
  }
  const hit = s.endedAt ? cache.byId.get(s.id) : undefined;
  if (hit && hit.key === key) return hit;
  const { l, c, stats } = calcOne(ctx, s);
  const titles = l.titles.filter((t) => t.sessionId === s.id);
  const out = { key, c: { ...c, series: new Map(), sampleTimes: [] }, stats, title: titles[0]?.title ?? '', lastTitle: titles[titles.length - 1]?.title ?? '' };
  if (s.endedAt) {
    if (cache.byId.size >= CALC_CACHE_MAX) cache.byId.delete(cache.byId.keys().next().value as string);
    cache.byId.set(s.id, out);
  }
  return out;
}

/** Work out (and keep) the numbers of one ended stream ahead of time (Reports list, ranges). */
export function warmSession(ctx: ReportContext, s: SessionRow): void {
  if (s.endedAt) cachedCalc(ctx, s);
}

export function listSessions(ctx: ReportContext, f: SessionFilter, limit = 500): ReportSessionSummary[] {
  return ctx.store.listSessions(f, limit).map((s) => {
    const x = cachedCalc(ctx, s);
    return summaryOf(ctx, { first: x.title, last: x.lastTitle }, x.c, x.stats);
  });
}

export function sessionDetail(ctx: ReportContext, id: string): ReportSessionDetail | null {
  const s = ctx.store.getSession(id);
  if (!s) return null;
  const { l, c, stats: st } = calcOne(ctx, s);
  const titleRows = l.titles.filter((t) => t.sessionId === s.id);
  const destinations: ReportDestination[] = l.destinations.map((d) => ({
    destinationId: d.destinationId,
    platform: d.platform,
    name: d.name,
    feed: d.feed,
    dualFormat: d.dualFormat,
    live: l.live.filter((x) => x.destinationId === d.destinationId).map((x) => ({ start: x.startedAt, end: x.endedAt })),
  }));
  const viewers = c.sampleTimes.map((t) => {
    const byPlatform: Partial<Record<PlatformId, number | null>> = {};
    for (const p of c.platforms) byPlatform[p] = valueAt(c.series.get(p) ?? [], t);
    return { ts: new Date(t).toISOString(), total: valueAt(c.series.get('total') ?? [], t), byPlatform };
  });
  return {
    ...summaryOf(ctx, { first: titleRows[0]?.title ?? '', last: titleRows[titleRows.length - 1]?.title ?? '' }, c, st),
    titles: l.titles.map((t) => ({ ts: t.ts, title: t.title })),
    destinations,
    stats: st,
    viewers,
    chatMinutes: ctx.store.chatMinutes([s.id]).map(({ sessionId: _s, ...m }) => m),
    feedMinutes: ctx.store.feedMinutes([s.id]).map(({ sessionId: _s, ...m }) => m),
    events: l.events.map(({ sessionId: _s, ...e }) => e),
    presence: l.presence.map(({ sessionId: _s, ...p }) => p),
    audienceTracked: s.audience,
  };
}

export function rangeSummary(
  ctx: ReportContext,
  f: SessionFilter,
  opts: { platform?: PlatformId | null; limit?: number } = {},
): ReportRangeSummary {
  const sessions = ctx.store.listSessions(f, 5000);
  const calcs: SessionCalc[] = [];
  const summaries: ReportSessionSummary[] = [];
  for (const s of sessions) {
    const x = cachedCalc(ctx, s);
    calcs.push(x.c);
    summaries.push(summaryOf(ctx, { first: x.title, last: x.lastTitle }, x.c, x.stats));
  }
  const ids = sessions.map((s) => s.id);
  const anyAudience = sessions.some((s) => s.audience);
  const rangeStats = aggregate(calcs, anyAudience ? ctx.store.uniqueChattersByPlatform(ids) : null);
  return {
    from: f.from ?? null,
    to: f.to ?? null,
    streams: sessions.length,
    stats: rangeStats,
    sessions: summaries,
    leaderboards: LEADERBOARD_KINDS.map((k) => leaderboard(ctx, { sessionIds: ids }, k, opts.platform ?? null, opts.limit)),
  };
}

// ---------------------------------------------------------------- audience

export function leaderboard(
  ctx: ReportContext,
  f: SessionFilter,
  kind: LeaderboardKind,
  platform: PlatformId | null,
  limit = LEADERBOARD_DEFAULT_LIMIT,
): Leaderboard {
  const n = Math.max(1, Math.min(LEADERBOARD_MAX_LIMIT, Math.floor(limit)));
  let rows = ctx.store.leaderboardRows(f, platform);
  const byName = (a: LeaderboardRow, b: LeaderboardRow) => a.displayName.localeCompare(b.displayName);
  switch (kind) {
    case 'chatters':
      rows = rows.filter((r) => r.messages > 0).sort((a, b) => b.messages - a.messages || b.streams - a.streams || byName(a, b));
      break;
    case 'loyal':
      rows = rows.sort((a, b) => b.streams - a.streams || b.messages - a.messages || byName(a, b));
      break;
    case 'watch':
      rows = rows.filter((r) => r.watchSec !== null && r.watchSec > 0).sort((a, b) => (b.watchSec ?? 0) - (a.watchSec ?? 0) || byName(a, b));
      break;
    case 'newest': {
      const sessions = f.sessionIds ? null : ctx.store.listSessions(f, 5000);
      const ids = f.sessionIds ?? sessions!.map((s) => s.id);
      const starts = ctx.store.listSessions({ sessionIds: ids }, 5000).map((s) => s.startedAt).sort();
      const first = ctx.store.firstSessionStart(rows.map((r) => r.id));
      const from = starts[0] ?? '';
      const single = ids.length === 1;
      rows = rows
        .filter((r) => {
          const f0 = first.get(r.id);
          return f0 !== undefined && f0 >= from && (single || r.streams >= REGULAR_MIN_STREAMS);
        })
        .sort((a, b) => (first.get(b.id) ?? '').localeCompare(first.get(a.id) ?? '') || b.streams - a.streams || b.messages - a.messages);
      break;
    }
  }
  return { kind, rows: rows.slice(0, n) };
}

export function userDetail(ctx: ReportContext, id: string, f: SessionFilter = {}): AudienceUserDetail | null {
  const user = ctx.store.user(id);
  if (!user) return null;
  const streams = ctx.store.userStreams(id, f);
  const sessions = ctx.store.listSessions({ sessionIds: streams.map((s) => s.sessionId) }, 5000);
  const titles = ctx.store.titles(sessions.map((s) => s.id));
  const presence = new Set(ctx.store.presence(sessions.map((s) => s.id)).map((p) => `${p.sessionId}|${p.platform}`));
  const anyPresence = streams.some((s) => presence.has(`${s.sessionId}|${s.platform}`));
  return {
    user,
    totals: {
      ...user,
      messages: streams.reduce((a, s) => a + s.messages, 0),
      joins: streams.reduce((a, s) => a + s.joins, 0),
      streams: streams.length,
      watchSec: anyPresence ? streams.reduce((a, s) => a + (s.watchSec ?? 0), 0) : null,
    },
    streams: streams.map(({ profileId: _p, ...s }) => ({
      ...s,
      title: titles.find((t) => t.sessionId === s.sessionId)?.title ?? '',
    })),
  };
}

