// SQL for the stream report tables (schema.ts). Synchronous, like the other repositories. Holds no
// state of its own: the recorder (recorder.ts) decides what to write, report.ts what to read.

import type { SQLInputValue } from 'node:sqlite';
import type { Feed, PlatformId } from '../../../shared/types.js';
import type { AudienceStreamRow, AudienceUser, FeedMinute, ReportEvent, ReportEventKind, LeaderboardRow } from '../../../shared/reports.js';
import { transaction, type Db } from '../db/database.js';
import { statementCache, type Row } from '../db/rows.js';

const s = (row: Row, col: string): string => String(row[col] ?? '');
const sn = (row: Row, col: string): string | null => (typeof row[col] === 'string' ? (row[col] as string) : null);
const n = (row: Row, col: string): number => Number(row[col] ?? 0);
const nn = (row: Row, col: string): number | null => (row[col] === null || row[col] === undefined ? null : Number(row[col]));

/** At most `max` UTF-16 units, never half of a surrogate pair (that would not be valid XML in an export). */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export interface SessionRow {
  id: string;
  profileId: string;
  startedAt: string;
  endedAt: string | null;
  lastSeenAt: string;
  endedByRestart: boolean;
  testMode: boolean;
  audience: boolean;
}

export interface DestinationRow {
  sessionId: string;
  destinationId: string;
  platform: PlatformId;
  name: string;
  feed: Feed;
  dualFormat: string | null;
}

export interface LivePeriodRow {
  sessionId: string;
  destinationId: string;
  startedAt: string;
  endedAt: string | null;
}

export interface ViewerSampleRow {
  sessionId: string;
  destinationId: string;
  ts: string;
  viewers: number | null;
}

export interface ChatMinuteRow {
  sessionId: string;
  platform: PlatformId;
  minute: string;
  messages: number;
  events: number;
  joins: number;
  uniqueChatters: number;
}

export interface ChatTotalsRow {
  sessionId: string;
  platform: PlatformId;
  messages: number;
  events: number;
  joins: number;
  anonymousJoins: number;
  uniqueChatters: number;
}

export interface ChatDelta {
  messages: number;
  events: number;
  joins: number;
}

export interface AudienceIdentity {
  id: string;
  platform: PlatformId;
  platformUserId: string | null;
  displayName: string;
  login: string | null;
}

/** What one person did in a session since the last write (added up by the recorder). */
export interface AudienceActivity extends ChatDelta {
  user: AudienceIdentity;
  firstSeenAt: string;
  lastSeenAt: string;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
}

/** Which sessions a query covers: explicit ids, or a profile and/or a time range. */
export interface SessionFilter {
  sessionIds?: readonly string[];
  /** null/undefined = every profile. */
  profileId?: string | null;
  /** ISO; sessions that started at or after. */
  from?: string | null;
  /** ISO; sessions that started before. */
  to?: string | null;
  /** Leave out test-mode sessions. */
  excludeTest?: boolean;
}

function sessionWhere(f: SessionFilter, alias = 'rs'): { sql: string; params: SQLInputValue[] } {
  const parts: string[] = [];
  const params: SQLInputValue[] = [];
  if (f.sessionIds) {
    if (f.sessionIds.length === 0) return { sql: '0', params };
    parts.push(`${alias}.id IN (${f.sessionIds.map(() => '?').join(', ')})`);
    params.push(...f.sessionIds);
  }
  if (f.profileId) {
    parts.push(`${alias}.profile_id = ?`);
    params.push(f.profileId);
  }
  if (f.from) {
    parts.push(`${alias}.started_at >= ?`);
    params.push(f.from);
  }
  if (f.to) {
    parts.push(`${alias}.started_at < ?`);
    params.push(f.to);
  }
  if (f.excludeTest) parts.push(`${alias}.test_mode = 0`);
  return { sql: parts.length > 0 ? parts.join(' AND ') : '1', params };
}

function toSession(row: Row): SessionRow {
  return {
    id: s(row, 'id'),
    profileId: s(row, 'profile_id'),
    startedAt: s(row, 'started_at'),
    endedAt: sn(row, 'ended_at'),
    lastSeenAt: s(row, 'last_seen_at'),
    endedByRestart: n(row, 'ended_by_restart') !== 0,
    testMode: n(row, 'test_mode') !== 0,
    audience: n(row, 'audience') !== 0,
  };
}

function toAudienceUser(row: Row): AudienceUser {
  return {
    id: s(row, 'id'),
    platform: s(row, 'platform') as PlatformId,
    displayName: s(row, 'display_name'),
    login: sn(row, 'login'),
    firstSeenAt: s(row, 'first_seen_at'),
    lastSeenAt: s(row, 'last_seen_at'),
  };
}

export type ReportStore = ReturnType<typeof createReportStore>;

export function createReportStore(db: Db) {
  const stmt = statementCache(db);
  /** A transaction, or part of the one already open (the recorder writes its queue in one). */
  const tx = <T>(fn: () => T): T => (db.isTransaction ? fn() : transaction(db, fn));
  /** Changes when stored rows are deleted (report.ts drops what it worked out from them). */
  let generation = 0;
  const inIds = (ids: readonly string[]): string => ids.map(() => '?').join(', ');
  /** Rows of `table` for these sessions, ordered. */
  const forSessions = (table: string, ids: readonly string[], order: string): Row[] =>
    ids.length === 0 ? [] : (db.prepare(`SELECT * FROM ${table} WHERE session_id IN (${inIds(ids)}) ORDER BY ${order}`).all(...ids) as Row[]);

  return {
    transaction<T>(fn: () => T): T {
      return tx(fn);
    },

    generation(): number {
      return generation;
    },

    // ---------------------------------------------------------------- sessions

    startSession(r: { id: string; profileId: string; startedAt: string; testMode: boolean; audience: boolean }): void {
      stmt(
        `INSERT INTO report_sessions (id, profile_id, started_at, last_seen_at, test_mode, audience) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ended_at = NULL, ended_by_restart = 0`,
      ).run(r.id, r.profileId, r.startedAt, r.startedAt, r.testMode ? 1 : 0, r.audience ? 1 : 0);
    },

    touchSession(id: string, ts: string): void {
      stmt('UPDATE report_sessions SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?').run(ts, id, ts);
    },

    markAudience(id: string): void {
      stmt('UPDATE report_sessions SET audience = 1 WHERE id = ?').run(id);
    },

    endSession(id: string, endedAt: string, byRestart = false): void {
      stmt('UPDATE report_sessions SET ended_at = ?, last_seen_at = MAX(last_seen_at, ?), ended_by_restart = ? WHERE id = ?').run(
        endedAt,
        endedAt,
        byRestart ? 1 : 0,
        id,
      );
      stmt('UPDATE report_live_periods SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL').run(endedAt, id);
    },

    /**
     * Sessions still open from before a restart (not in `activeIds`): end them at the last time
     * they were recorded. Returns how many.
     */
    closeOrphans(activeIds: readonly string[]): number {
      const open = (stmt('SELECT * FROM report_sessions WHERE ended_at IS NULL').all() as Row[]).map(toSession);
      let closed = 0;
      for (const o of open) {
        if (activeIds.includes(o.id)) continue;
        this.endSession(o.id, o.lastSeenAt, true);
        closed++;
      }
      return closed;
    },

    getSession(id: string): SessionRow | null {
      const row = stmt('SELECT * FROM report_sessions WHERE id = ?').get(id) as Row | undefined;
      return row ? toSession(row) : null;
    },

    listSessions(f: SessionFilter, limit = 500): SessionRow[] {
      const w = sessionWhere(f);
      return (db.prepare(`SELECT * FROM report_sessions rs WHERE ${w.sql} ORDER BY rs.started_at DESC LIMIT ?`).all(...w.params, limit) as Row[]).map(
        toSession,
      );
    },

    deleteSession(id: string): void {
      stmt('DELETE FROM report_sessions WHERE id = ?').run(id);
      generation++;
    },

    // ---------------------------------------------------------------- what happened

    addTitle(sessionId: string, ts: string, title: string): void {
      stmt('INSERT INTO report_titles (session_id, ts, title) VALUES (?, ?, ?)').run(sessionId, ts, title);
    },

    titles(ids: readonly string[]): { sessionId: string; ts: string; title: string }[] {
      return forSessions('report_titles', ids, 'session_id, ts').map((r) => ({ sessionId: s(r, 'session_id'), ts: s(r, 'ts'), title: s(r, 'title') }));
    },

    upsertDestination(r: DestinationRow): void {
      stmt(
        `INSERT INTO report_destinations (session_id, destination_id, platform, name, feed, dual_format) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, destination_id) DO UPDATE SET name = excluded.name, feed = excluded.feed, dual_format = excluded.dual_format`,
      ).run(r.sessionId, r.destinationId, r.platform, r.name, r.feed, r.dualFormat);
    },

    destinations(ids: readonly string[]): DestinationRow[] {
      return forSessions('report_destinations', ids, 'session_id, platform, name').map((r) => ({
        sessionId: s(r, 'session_id'),
        destinationId: s(r, 'destination_id'),
        platform: s(r, 'platform') as PlatformId,
        name: s(r, 'name'),
        feed: s(r, 'feed') as Feed,
        dualFormat: sn(r, 'dual_format'),
      }));
    },

    openLive(sessionId: string, destinationId: string, ts: string): void {
      const open = stmt('SELECT 1 AS x FROM report_live_periods WHERE session_id = ? AND destination_id = ? AND ended_at IS NULL').get(
        sessionId,
        destinationId,
      );
      if (!open) stmt('INSERT INTO report_live_periods (session_id, destination_id, started_at) VALUES (?, ?, ?)').run(sessionId, destinationId, ts);
    },

    closeLive(sessionId: string, destinationId: string, ts: string): boolean {
      const r = stmt('UPDATE report_live_periods SET ended_at = ? WHERE session_id = ? AND destination_id = ? AND ended_at IS NULL').run(
        ts,
        sessionId,
        destinationId,
      );
      return Number(r.changes) > 0;
    },

    livePeriods(ids: readonly string[]): LivePeriodRow[] {
      return forSessions('report_live_periods', ids, 'session_id, destination_id, started_at').map((r) => ({
        sessionId: s(r, 'session_id'),
        destinationId: s(r, 'destination_id'),
        startedAt: s(r, 'started_at'),
        endedAt: sn(r, 'ended_at'),
      }));
    },

    addEvent(sessionId: string, e: ReportEvent): void {
      stmt('INSERT INTO report_events (session_id, ts, kind, destination_id, platform, detail) VALUES (?, ?, ?, ?, ?, ?)').run(
        sessionId,
        e.ts,
        e.kind,
        e.destinationId,
        e.platform,
        e.detail === null ? null : clip(e.detail, 300),
      );
    },

    events(ids: readonly string[]): (ReportEvent & { sessionId: string })[] {
      return forSessions('report_events', ids, 'session_id, ts, id').map((r) => ({
        sessionId: s(r, 'session_id'),
        ts: s(r, 'ts'),
        kind: s(r, 'kind') as ReportEventKind,
        destinationId: sn(r, 'destination_id'),
        platform: sn(r, 'platform') as PlatformId | null,
        detail: sn(r, 'detail'),
      }));
    },

    // ---------------------------------------------------------------- viewers

    addViewerSample(sessionId: string, destinationId: string, ts: string, viewers: number | null): void {
      stmt('INSERT INTO report_viewer_samples (session_id, destination_id, ts, viewers) VALUES (?, ?, ?, ?)').run(sessionId, destinationId, ts, viewers);
    },

    viewerSamples(ids: readonly string[]): ViewerSampleRow[] {
      return forSessions('report_viewer_samples', ids, 'session_id, ts, rowid').map((r) => ({
        sessionId: s(r, 'session_id'),
        destinationId: s(r, 'destination_id'),
        ts: s(r, 'ts'),
        viewers: nn(r, 'viewers'),
      }));
    },

    // ---------------------------------------------------------------- chat

    /** Add counts to a minute; `unique` is the minute's distinct chatters so far (kept as the max). */
    addChatMinute(sessionId: string, platform: PlatformId, minute: string, d: ChatDelta, unique: number): void {
      stmt(
        `INSERT INTO report_chat_minutes (session_id, platform, minute, messages, events, joins, unique_chatters) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, platform, minute) DO UPDATE SET messages = messages + excluded.messages, events = events + excluded.events,
           joins = joins + excluded.joins, unique_chatters = MAX(unique_chatters, excluded.unique_chatters)`,
      ).run(sessionId, platform, minute, d.messages, d.events, d.joins, unique);
    },

    chatMinutes(ids: readonly string[]): ChatMinuteRow[] {
      return forSessions('report_chat_minutes', ids, 'session_id, minute, platform').map((r) => ({
        sessionId: s(r, 'session_id'),
        platform: s(r, 'platform') as PlatformId,
        minute: s(r, 'minute'),
        messages: n(r, 'messages'),
        events: n(r, 'events'),
        joins: n(r, 'joins'),
        uniqueChatters: n(r, 'unique_chatters'),
      }));
    },

    addChatTotals(sessionId: string, platform: PlatformId, d: ChatDelta & { anonymousJoins: number }, unique: number): void {
      stmt(
        `INSERT INTO report_chat_totals (session_id, platform, messages, events, joins, anonymous_joins, unique_chatters) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, platform) DO UPDATE SET messages = messages + excluded.messages, events = events + excluded.events,
           joins = joins + excluded.joins, anonymous_joins = anonymous_joins + excluded.anonymous_joins,
           unique_chatters = MAX(unique_chatters, excluded.unique_chatters)`,
      ).run(sessionId, platform, d.messages, d.events, d.joins, d.anonymousJoins, unique);
    },

    chatTotals(ids: readonly string[]): ChatTotalsRow[] {
      return forSessions('report_chat_totals', ids, 'session_id, platform').map((r) => ({
        sessionId: s(r, 'session_id'),
        platform: s(r, 'platform') as PlatformId,
        messages: n(r, 'messages'),
        events: n(r, 'events'),
        joins: n(r, 'joins'),
        anonymousJoins: n(r, 'anonymous_joins'),
        uniqueChatters: n(r, 'unique_chatters'),
      }));
    },

    // ---------------------------------------------------------------- feeds

    putFeedMinute(sessionId: string, m: FeedMinute): void {
      stmt(
        `INSERT INTO report_feed_minutes (session_id, feed, minute, online, codec, width, height, fps, bitrate_kbps, keyframe_sec)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, feed, minute) DO UPDATE SET online = excluded.online, codec = excluded.codec, width = excluded.width,
           height = excluded.height, fps = excluded.fps, bitrate_kbps = excluded.bitrate_kbps, keyframe_sec = excluded.keyframe_sec`,
      ).run(sessionId, m.feed, m.minute, m.online ? 1 : 0, m.codec, m.width, m.height, m.fps, m.bitrateKbps, m.keyframeSec);
    },

    feedMinutes(ids: readonly string[]): (FeedMinute & { sessionId: string })[] {
      return forSessions('report_feed_minutes', ids, 'session_id, minute, feed').map((r) => ({
        sessionId: s(r, 'session_id'),
        feed: s(r, 'feed') as Feed,
        minute: s(r, 'minute'),
        online: n(r, 'online') !== 0,
        codec: sn(r, 'codec'),
        width: nn(r, 'width'),
        height: nn(r, 'height'),
        fps: nn(r, 'fps'),
        bitrateKbps: nn(r, 'bitrate_kbps'),
        keyframeSec: nn(r, 'keyframe_sec'),
      }));
    },

    // ---------------------------------------------------------------- audience

    /** A user did something in a session: chatted (`d.messages`), joined, or another chat event. */
    audienceActivity(sessionId: string, u: AudienceIdentity, ts: string, d: ChatDelta): void {
      const msgTs = d.messages > 0 ? ts : null;
      this.addAudience(sessionId, [{ user: u, ...d, firstSeenAt: ts, lastSeenAt: ts, firstMessageAt: msgTs, lastMessageAt: msgTs }]);
    },

    /** Add what people did in a session (the recorder's batch since its last write). */
    addAudience(sessionId: string, rows: readonly AudienceActivity[]): void {
      if (rows.length === 0) return;
      tx(() => {
        const user = stmt(
          `INSERT INTO audience_users (id, platform, platform_user_id, display_name, login, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, login = COALESCE(excluded.login, login),
             platform_user_id = COALESCE(excluded.platform_user_id, platform_user_id),
             first_seen_at = MIN(first_seen_at, excluded.first_seen_at), last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`,
        );
        const stream = stmt(
          `INSERT INTO audience_stream (session_id, user_id, platform, messages, events, joins, first_message_at, last_message_at, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id, user_id) DO UPDATE SET messages = messages + excluded.messages, events = events + excluded.events,
             joins = joins + excluded.joins,
             first_message_at = COALESCE(MIN(first_message_at, excluded.first_message_at), first_message_at, excluded.first_message_at),
             last_message_at = COALESCE(MAX(last_message_at, excluded.last_message_at), last_message_at, excluded.last_message_at),
             last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`,
        );
        for (const r of rows) {
          const u = r.user;
          user.run(u.id, u.platform, u.platformUserId, clip(u.displayName, 200), u.login === null ? null : clip(u.login, 200), r.firstSeenAt, r.lastSeenAt);
          stream.run(sessionId, u.id, u.platform, r.messages, r.events, r.joins, r.firstMessageAt, r.lastMessageAt, r.firstSeenAt, r.lastSeenAt);
        }
      });
    },

    /**
     * One presence sample (a platform's list of who is in the chat). `creditSec` is added to the
     * watch time of each user (0 for users who were not in the previous sample).
     */
    audiencePresence(sessionId: string, platform: PlatformId, ts: string, users: readonly { user: AudienceIdentity; creditSec: number }[]): void {
      tx(() => {
        stmt(
          `INSERT INTO report_presence (session_id, platform, samples, last_sample_at) VALUES (?, ?, 1, ?)
           ON CONFLICT(session_id, platform) DO UPDATE SET samples = samples + 1, last_sample_at = excluded.last_sample_at`,
        ).run(sessionId, platform, ts);
        for (const { user: u, creditSec } of users) {
          stmt(
            `INSERT INTO audience_users (id, platform, platform_user_id, display_name, login, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, login = COALESCE(excluded.login, login),
               last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`,
          ).run(u.id, u.platform, u.platformUserId, clip(u.displayName, 200), u.login === null ? null : clip(u.login, 200), ts, ts);
          stmt(
            `INSERT INTO audience_stream (session_id, user_id, platform, first_seen_at, last_seen_at, presence_samples, watch_sec)
             VALUES (?, ?, ?, ?, ?, 1, ?)
             ON CONFLICT(session_id, user_id) DO UPDATE SET presence_samples = presence_samples + 1,
               watch_sec = COALESCE(watch_sec, 0) + excluded.watch_sec, last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`,
          ).run(sessionId, u.id, u.platform, ts, ts, Math.max(0, Math.round(creditSec)));
        }
      });
    },

    presence(ids: readonly string[]): { sessionId: string; platform: PlatformId; samples: number }[] {
      return forSessions('report_presence', ids, 'session_id, platform').map((r) => ({
        sessionId: s(r, 'session_id'),
        platform: s(r, 'platform') as PlatformId,
        samples: n(r, 'samples'),
      }));
    },

    /** Audience rows of these sessions (Audience sheet). */
    audienceStreams(ids: readonly string[]): AudienceStreamRow[] {
      if (ids.length === 0) return [];
      const rows = db
        .prepare(
          `SELECT a.*, u.display_name FROM audience_stream a JOIN audience_users u ON u.id = a.user_id
           WHERE a.session_id IN (${inIds(ids)}) ORDER BY a.session_id, a.messages DESC, u.display_name`,
        )
        .all(...ids) as Row[];
      return rows.map(toStreamRow);
    },

    /** Distinct users with at least one message in these sessions, per platform. */
    uniqueChattersByPlatform(ids: readonly string[]): Map<PlatformId, number> {
      const out = new Map<PlatformId, number>();
      if (ids.length === 0) return out;
      const rows = db
        .prepare(
          `SELECT platform, COUNT(DISTINCT user_id) AS c FROM audience_stream WHERE session_id IN (${inIds(ids)}) AND messages > 0 GROUP BY platform`,
        )
        .all(...ids) as Row[];
      for (const r of rows) out.set(s(r, 'platform') as PlatformId, n(r, 'c'));
      return out;
    },

    /**
     * Per-user totals over the sessions in `f` (optionally one platform). `watchSec` is null for a
     * user whose platform never sent a presence list in those sessions.
     */
    leaderboardRows(f: SessionFilter, platform: PlatformId | null): LeaderboardRow[] {
      const w = sessionWhere(f);
      const params: SQLInputValue[] = [...w.params];
      let platformSql = '';
      if (platform) {
        platformSql = 'AND a.platform = ?';
        params.push(platform);
      }
      const rows = db
        .prepare(
          `SELECT u.*, SUM(a.messages) AS messages, SUM(a.joins) AS joins, COUNT(DISTINCT a.session_id) AS streams,
             SUM(a.watch_sec) AS watch_sec, MAX(CASE WHEN p.session_id IS NULL THEN 0 ELSE 1 END) AS has_presence
           FROM audience_stream a
           JOIN report_sessions rs ON rs.id = a.session_id
           JOIN audience_users u ON u.id = a.user_id
           LEFT JOIN report_presence p ON p.session_id = a.session_id AND p.platform = a.platform
           WHERE ${w.sql} ${platformSql}
           GROUP BY u.id`,
        )
        .all(...params) as Row[];
      return rows.map((r) => ({
        ...toAudienceUser(r),
        messages: n(r, 'messages'),
        joins: n(r, 'joins'),
        streams: n(r, 'streams'),
        watchSec: n(r, 'has_presence') ? n(r, 'watch_sec') : null,
      }));
    },

    /** First session (ever, any profile) each user attended. */
    firstSessionStart(userIds: readonly string[]): Map<string, string> {
      const out = new Map<string, string>();
      if (userIds.length === 0) return out;
      for (let i = 0; i < userIds.length; i += 500) {
        const chunk = userIds.slice(i, i + 500);
        const rows = db
          .prepare(
            `SELECT a.user_id, MIN(rs.started_at) AS first FROM audience_stream a JOIN report_sessions rs ON rs.id = a.session_id
             WHERE a.user_id IN (${inIds(chunk)}) GROUP BY a.user_id`,
          )
          .all(...chunk) as Row[];
        for (const r of rows) out.set(s(r, 'user_id'), s(r, 'first'));
      }
      return out;
    },

    user(id: string): AudienceUser | null {
      const row = stmt('SELECT * FROM audience_users WHERE id = ?').get(id) as Row | undefined;
      return row ? toAudienceUser(row) : null;
    },

    userStreams(userId: string, f: SessionFilter = {}): (AudienceStreamRow & { startedAt: string; profileId: string })[] {
      const w = sessionWhere(f);
      const rows = db
        .prepare(
          `SELECT a.*, u.display_name, rs.started_at AS session_started_at, rs.profile_id AS session_profile_id FROM audience_stream a
           JOIN report_sessions rs ON rs.id = a.session_id JOIN audience_users u ON u.id = a.user_id
           WHERE a.user_id = ? AND ${w.sql} ORDER BY rs.started_at DESC`,
        )
        .all(userId, ...w.params) as Row[];
      return rows.map((r) => ({ ...toStreamRow(r), startedAt: s(r, 'session_started_at'), profileId: s(r, 'session_profile_id') }));
    },

    /**
     * "Forget this user": every report row about them. The deleted bytes are overwritten
     * (secure_delete for this delete) and the write-ahead log is checkpointed and emptied, so the
     * name is not left in free pages of app.db or in app.db-wal. Returns whether they were known.
     * Backups and dataset snapshots taken before keep their copy.
     */
    forgetUser(id: string): boolean {
      const before = Number((db.prepare('PRAGMA secure_delete').get() as Row | undefined)?.secure_delete ?? 0);
      db.exec('PRAGMA secure_delete = ON');
      let known: boolean;
      try {
        known = tx(() => {
          stmt('DELETE FROM audience_stream WHERE user_id = ?').run(id);
          return Number(stmt('DELETE FROM audience_users WHERE id = ?').run(id).changes) > 0;
        });
      } finally {
        db.exec(`PRAGMA secure_delete = ${before === 1 ? 'ON' : before === 2 ? 'FAST' : 'OFF'}`);
      }
      generation++;
      if (known) {
        try {
          db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        } catch {
          // Not in WAL mode (tests) or busy: the next checkpoint copies the zeroed pages.
        }
      }
      return known;
    },

    /**
     * Delete up to `limit` streams that started before `cutoff` (ISO), in one transaction; when
     * none are left, also the people who were only seen in deleted streams. `done` = nothing left.
     */
    purgeBefore(cutoff: string, limit = 1_000_000): { sessions: number; users: number; done: boolean } {
      return tx(() => {
        const sessions = Number(
          stmt(
            'DELETE FROM report_sessions WHERE id IN (SELECT id FROM report_sessions WHERE started_at < ? AND ended_at IS NOT NULL ORDER BY started_at LIMIT ?)',
          ).run(cutoff, limit).changes,
        );
        if (sessions > 0) generation++;
        if (sessions >= limit) return { sessions, users: 0, done: false };
        const users = Number(
          stmt('DELETE FROM audience_users WHERE last_seen_at < ? AND NOT EXISTS (SELECT 1 FROM audience_stream a WHERE a.user_id = audience_users.id)').run(
            cutoff,
          ).changes,
        );
        if (users > 0) generation++;
        return { sessions, users, done: true };
      });
    },
  };
}

function toStreamRow(r: Row): AudienceStreamRow {
  return {
    sessionId: s(r, 'session_id'),
    userId: s(r, 'user_id'),
    platform: s(r, 'platform') as PlatformId,
    displayName: s(r, 'display_name'),
    messages: n(r, 'messages'),
    events: n(r, 'events'),
    joins: n(r, 'joins'),
    firstMessageAt: sn(r, 'first_message_at'),
    lastMessageAt: sn(r, 'last_message_at'),
    firstSeenAt: s(r, 'first_seen_at'),
    lastSeenAt: s(r, 'last_seen_at'),
    presenceSamples: n(r, 'presence_samples'),
    watchSec: nn(r, 'watch_sec'),
  };
}
