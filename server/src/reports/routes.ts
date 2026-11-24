// Report routes, registered twice with the same handlers (docs/API.md §16, docs/REPORTS.md):
// - /api/v1/reports/... for API tokens with the reports:read scope (v1-reports.ts);
// - /api/reports/...    for the signed-in web UI (http/routes/reports.ts), plus the settings and
//   "forget this user", which change data and are admin-only.
// The two differ only in how a request is authorised and which profiles it may see.

import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { LEADERBOARD_KINDS, REPORT_EXPORT_FORMATS, type LeaderboardKind, type ReportExportFormat } from '../../../shared/reports.js';
import { PLATFORM_IDS, type PlatformId } from '../../../shared/types.js';
import { collect, exportBaseName, renderExport, safeTimeZone, wallClock } from './export.js';
import type { ReportsService } from './index.js';
import { LEADERBOARD_DEFAULT_LIMIT, LEADERBOARD_MAX_LIMIT, leaderboard, listSessions, rangeSummary, sessionDetail, userDetail } from './report.js';
import type { SessionFilter } from './store.js';

export const SESSIONS_DEFAULT_LIMIT = 100;
export const SESSIONS_MAX_LIMIT = 1000;

export type Fail = (reply: FastifyReply, status: number, code: 'invalid' | 'not_found' | 'unavailable', message: string) => FastifyReply;

export interface ReportRouteOptions {
  reports: () => ReportsService;
  preHandler: preHandlerAsyncHookHandler;
  /**
   * The profile a request may see: a profile id, null for every profile, or a failure already sent
   * (returns undefined).
   */
  profileOf(req: FastifyRequest, reply: FastifyReply): string | null | undefined;
  fail: Fail;
}

type Query = Record<string, unknown>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Epoch ms of local midnight of `day` (YYYY-MM-DD) in `tz`. */
export function localMidnight(day: string, tz: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const target = Date.UTC(y, m - 1, d);
  let guess = target;
  for (let i = 0; i < 3; i++) guess = target - (wallClock(guess, tz) - guess);
  return guess;
}

/**
 * `from` / `to`: a day (YYYY-MM-DD, in `tz`; `to` includes that whole day) or a full ISO time.
 * Returns ISO strings, or an error message.
 */
export function parseRange(q: Query, tz: string): { from: string | null; to: string | null } | string {
  const one = (raw: unknown, end: boolean): string | null | false => {
    if (raw === undefined || raw === '') return null;
    if (typeof raw !== 'string' || raw.length > 40) return false;
    if (DATE_RE.test(raw)) {
      const t = localMidnight(raw, tz) + (end ? 86_400_000 : 0);
      return Number.isFinite(t) ? new Date(t).toISOString() : false;
    }
    const t = Date.parse(raw);
    return Number.isFinite(t) && /^\d{4}-\d{2}-\d{2}T/.test(raw) ? new Date(t).toISOString() : false;
  };
  const from = one(q.from, false);
  const to = one(q.to, true);
  if (from === false) return 'from must be a day (YYYY-MM-DD) or an ISO time';
  if (to === false) return 'to must be a day (YYYY-MM-DD) or an ISO time';
  if (from && to && from >= to) return 'from must be before to';
  return { from, to };
}

function parsePlatform(raw: unknown): PlatformId | null | false {
  if (raw === undefined || raw === '' || raw === 'all') return null;
  return typeof raw === 'string' && (PLATFORM_IDS as readonly string[]).includes(raw) ? (raw as PlatformId) : false;
}

function parseLimit(raw: unknown, def: number, max: number): number | false {
  if (raw === undefined || raw === '') return def;
  if (typeof raw !== 'string' || !/^\d{1,5}$/.test(raw)) return false;
  const n = Number(raw);
  return n >= 1 && n <= max ? n : false;
}

/** test=exclude (default for ranges and leaderboards) | include. */
function parseTest(raw: unknown, def: 'include' | 'exclude'): boolean | null {
  const v = raw === undefined || raw === '' ? def : raw;
  if (v === 'include') return false;
  if (v === 'exclude') return true;
  return null;
}

function parseFormat(raw: unknown): ReportExportFormat | null {
  if (raw === undefined || raw === '') return 'xlsx';
  return typeof raw === 'string' && (REPORT_EXPORT_FORMATS as readonly string[]).includes(raw) ? (raw as ReportExportFormat) : null;
}

export function registerReportRoutes(app: FastifyInstance, base: string, o: ReportRouteOptions): void {
  const { preHandler, fail } = o;

  const service = (reply: FastifyReply): ReportsService | null => {
    const r = o.reports();
    if (!r.available) {
      fail(reply, 503, 'unavailable', 'Stream reports are off: the report tables were made by a newer CTD Relay. Update the app.');
      return null;
    }
    return r;
  };

  /** Common filters; sends the error and returns null when one is invalid. */
  const filterOf = (req: FastifyRequest, reply: FastifyReply, testDefault: 'include' | 'exclude'): { f: SessionFilter; tz: string; platform: PlatformId | null } | null => {
    const q = req.query as Query;
    const profile = o.profileOf(req, reply);
    if (profile === undefined) return null;
    const tz = safeTimeZone(q.tz);
    const range = parseRange(q, tz);
    if (typeof range === 'string') {
      fail(reply, 400, 'invalid', range);
      return null;
    }
    const platform = parsePlatform(q.platform);
    if (platform === false) {
      fail(reply, 400, 'invalid', `platform must be one of ${PLATFORM_IDS.join(', ')}`);
      return null;
    }
    const excludeTest = parseTest(q.test, testDefault);
    if (excludeTest === null) {
      fail(reply, 400, 'invalid', 'test must be include or exclude');
      return null;
    }
    return { f: { profileId: profile, from: range.from, to: range.to, excludeTest }, tz, platform };
  };

  /** The session, if it exists and this request may see its profile. */
  const sessionOf = (req: FastifyRequest, reply: FastifyReply, r: ReportsService): string | null => {
    const id = (req.params as { id?: string }).id ?? '';
    const profile = o.profileOf(req, reply);
    if (profile === undefined) return null;
    const s = id.length <= 64 ? r.store.getSession(id) : null;
    if (!s || (profile !== null && s.profileId !== profile)) {
      fail(reply, 404, 'not_found', 'No stream report with this id.');
      return null;
    }
    return s.id;
  };

  const sendFile = (reply: FastifyReply, file: { body: Buffer; contentType: string; fileName: string }) =>
    reply
      .header('cache-control', 'no-store')
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .send(file.body);

  app.get(`${base}/sessions`, { preHandler }, async (req, reply) => {
    const r = service(reply);
    if (!r) return reply;
    const parsed = filterOf(req, reply, 'include');
    if (!parsed) return reply;
    const limit = parseLimit((req.query as Query).limit, SESSIONS_DEFAULT_LIMIT, SESSIONS_MAX_LIMIT);
    if (limit === false) return fail(reply, 400, 'invalid', `limit must be 1–${SESSIONS_MAX_LIMIT}`);
    let sessions = listSessions(r.context(), parsed.f, limit);
    if (parsed.platform) sessions = sessions.filter((s) => s.platforms.includes(parsed.platform!));
    return reply.header('cache-control', 'no-store').send({ sessions });
  });

  app.get(`${base}/sessions/:id`, { preHandler }, async (req, reply) => {
    const r = service(reply);
    if (!r) return reply;
    const id = sessionOf(req, reply, r);
    if (!id) return reply;
    const ctx = r.context();
    const detail = sessionDetail(ctx, id)!;
    const leaderboards = LEADERBOARD_KINDS.map((k) => leaderboard(ctx, { sessionIds: [id] }, k, null, LEADERBOARD_DEFAULT_LIMIT));
    return reply.header('cache-control', 'no-store').send({ ...detail, leaderboards });
  });

  app.get(`${base}/sessions/:id/export`, { preHandler }, async (req, reply) => {
    const r = service(reply);
    if (!r) return reply;
    const format = parseFormat((req.query as Query).format);
    if (!format) return fail(reply, 400, 'invalid', 'format must be xlsx, csv or json');
    const id = sessionOf(req, reply, r);
    if (!id) return reply;
    const bundle = collect(r.context(), { sessionId: id }, safeTimeZone((req.query as Query).tz))!;
    return sendFile(reply, renderExport(bundle, format, exportBaseName(bundle)));
  });

  app.get(`${base}/summary`, { preHandler }, async (req, reply) => {
    const r = service(reply);
    if (!r) return reply;
    const parsed = filterOf(req, reply, 'exclude');
    if (!parsed) return reply;
    const limit = parseLimit((req.query as Query).limit, LEADERBOARD_DEFAULT_LIMIT, LEADERBOARD_MAX_LIMIT);
    if (limit === false) return fail(reply, 400, 'invalid', `limit must be 1–${LEADERBOARD_MAX_LIMIT}`);
    return reply.header('cache-control', 'no-store').send(rangeSummary(r.context(), parsed.f, { platform: parsed.platform, limit }));
  });

  app.get(`${base}/export`, { preHandler }, async (req, reply) => {
    const r = service(reply);
    if (!r) return reply;
    const format = parseFormat((req.query as Query).format);
    if (!format) return fail(reply, 400, 'invalid', 'format must be xlsx, csv or json');
    const parsed = filterOf(req, reply, 'exclude');
    if (!parsed) return reply;
    const bundle = collect(r.context(), parsed.f, parsed.tz)!;
    return sendFile(reply, renderExport(bundle, format, exportBaseName(bundle)));
  });

  app.get(`${base}/audience`, { preHandler }, async (req, reply) => {
    const r = service(reply);
    if (!r) return reply;
    const q = req.query as Query;
    const board = (q.board === undefined || q.board === '' ? 'chatters' : q.board) as LeaderboardKind;
    if (!LEADERBOARD_KINDS.includes(board)) return fail(reply, 400, 'invalid', `board must be one of ${LEADERBOARD_KINDS.join(', ')}`);
    const limit = parseLimit(q.limit, LEADERBOARD_DEFAULT_LIMIT, LEADERBOARD_MAX_LIMIT);
    if (limit === false) return fail(reply, 400, 'invalid', `limit must be 1–${LEADERBOARD_MAX_LIMIT}`);
    const parsed = filterOf(req, reply, 'exclude');
    if (!parsed) return reply;
    let f: SessionFilter = parsed.f;
    if (q.session !== undefined && q.session !== '') {
      const s = typeof q.session === 'string' ? r.store.getSession(q.session) : null;
      if (!s || (parsed.f.profileId && s.profileId !== parsed.f.profileId)) return fail(reply, 404, 'not_found', 'No stream report with this id.');
      f = { sessionIds: [s.id] };
    }
    return reply.header('cache-control', 'no-store').send(leaderboard(r.context(), f, board, parsed.platform, limit));
  });

  app.get(`${base}/audience/users/:userId`, { preHandler }, async (req, reply) => {
    const r = service(reply);
    if (!r) return reply;
    const parsed = filterOf(req, reply, 'include');
    if (!parsed) return reply;
    const userId = (req.params as { userId?: string }).userId ?? '';
    const detail = userId.length <= 300 ? userDetail(r.context(), userId, parsed.f) : null;
    if (!detail || (detail.streams.length === 0 && parsed.f.profileId)) return fail(reply, 404, 'not_found', 'No one with this id in the reports.');
    return reply.header('cache-control', 'no-store').send(detail);
  });
}
