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
import { chatRate, round, seriesStats, stepSeries, sumSeries, unionMs, type Point } from './math.js';
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
  /** Per platform and 'total'. */
  series: Map<PlatformId | 'total', Point[]>;
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
    perPlatform,
    anyLiveMs,
    chat,
    uniques,
    recoveries: count(['destination.recovery']),
    errors: count(['destination.error', 'destination.blocked']),
    sampleTimes,
  };
}

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
      const st = seriesStats(c.series.get(platform) ?? [], c.start, c.end);
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

function summaryOf(ctx: ReportContext, l: Loaded, c: SessionCalc, stats: ReportStats[]): ReportSessionSummary {
  const s = c.session;
  const titles = l.titles.filter((t) => t.sessionId === s.id);
  const total = stats[stats.length - 1]!;
  return {
    id: s.id,
    profileId: s.profileId,
    profileName: ctx.profileName?.(s.profileId) ?? null,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    endedByRestart: s.endedByRestart,
    testMode: s.testMode,
    title: titles[0]?.title ?? '',
    lastTitle: titles[titles.length - 1]?.title ?? '',
    platforms: c.platforms,
    durationSec: Math.round((c.end - c.start) / 1000),
    peakViewers: total.peakViewers,
    viewerMinutes: total.viewerMinutes,
    chatMessages: total.chatMessages,
    uniqueChatters: total.uniqueChatters,
  };
}

function calcAll(ctx: ReportContext, sessions: SessionRow[]): { l: Loaded; calcs: SessionCalc[]; stats: Map<string, ReportStats[]> } {
  const l = load(ctx.store, sessions);
  const calcs: SessionCalc[] = [];
  const stats = new Map<string, ReportStats[]>();
  for (const s of sessions) {
    const c = calcSession(ctx, l, s, s.audience ? ctx.store.uniqueChattersByPlatform([s.id]) : new Map());
    calcs.push(c);
    stats.set(s.id, aggregate([c], null));
  }
  return { l, calcs, stats };
}

export function listSessions(ctx: ReportContext, f: SessionFilter, limit = 500): ReportSessionSummary[] {
  const sessions = ctx.store.listSessions(f, limit);
  const { l, calcs, stats } = calcAll(ctx, sessions);
  return calcs.map((c) => summaryOf(ctx, l, c, stats.get(c.session.id)!));
}

export function sessionDetail(ctx: ReportContext, id: string): ReportSessionDetail | null {
  const s = ctx.store.getSession(id);
  if (!s) return null;
  const { l, calcs, stats } = calcAll(ctx, [s]);
  const c = calcs[0]!;
  const st = stats.get(s.id)!;
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
    for (const p of c.platforms) byPlatform[p] = valueOf(c.series.get(p), t);
    return { ts: new Date(t).toISOString(), total: valueOf(c.series.get('total'), t), byPlatform };
  });
  return {
    ...summaryOf(ctx, l, c, st),
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

function valueOf(series: Point[] | undefined, t: number): number | null {
  if (!series) return null;
  let v: number | null = null;
  for (const p of series) {
    if (p.t > t) break;
    v = p.v;
  }
  return v;
}

export function rangeSummary(
  ctx: ReportContext,
  f: SessionFilter,
  opts: { platform?: PlatformId | null; limit?: number } = {},
): ReportRangeSummary {
  const sessions = ctx.store.listSessions(f, 5000);
  const { l, calcs, stats } = calcAll(ctx, sessions);
  const ids = sessions.map((s) => s.id);
  const anyAudience = sessions.some((s) => s.audience);
  const rangeStats = aggregate(calcs, anyAudience ? ctx.store.uniqueChattersByPlatform(ids) : null);
  return {
    from: f.from ?? null,
    to: f.to ?? null,
    streams: sessions.length,
    stats: rangeStats,
    sessions: calcs.map((c) => summaryOf(ctx, l, c, stats.get(c.session.id)!)),
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

