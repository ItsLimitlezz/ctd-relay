// Issue history (docs/API.md §17.7, v1.18): every issue raised and cleared in the last 7 days, one
// row per issue from its issue.raised to its issue.cleared. Open issues themselves live in memory
// (api/issues.ts); this is only the record, for the dashboard's history and the Stream Report.
//
// Like the guest feed and report tables, the table has its own migration track, versioned in
// `issue_history_meta`, NOT in PRAGMA user_version: db/database.ts refuses a database whose
// user_version is newer than it knows, so bumping it would stop 0.2.80 / 0.2.90 from starting after
// a rollback. With a separate track the main schema stays v4, older versions open the file and never
// look at this table, and deleting a profile there still removes its rows (ON DELETE CASCADE).
// Append only; never edit a shipped step.
//
// Bounded: rows that cleared more than 7 days ago are deleted, and at most 5,000 rows are kept
// (newest first), at start-up and every hour (api/issue-history.ts).

import {
  ISSUE_HISTORY_DAYS,
  ISSUE_HISTORY_MAX_ROWS,
  type ApiIssue,
  type ApiIssueCleared,
  type ApiIssueSubject,
  type IssueHistoryEntry,
  type IssueHistoryResolution,
  type IssueKind,
  type IssueSeverity,
} from '../../../shared/issues.js';
import { transaction, type Db } from './database.js';
import { int, statementCache, str, strOrNull, type Row } from './rows.js';

export const ISSUE_HISTORY_MIGRATIONS: readonly string[] = [
  // h1: the history table. Only adds a table: 0.2.80 and 0.2.90 still open the file.
  `
  CREATE TABLE issue_history (
    row_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id    TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    issue_id      TEXT NOT NULL,             -- the issue's id: <kind>|<subject key>
    kind          TEXT NOT NULL,
    rule          TEXT,
    severity      TEXT NOT NULL,             -- latest
    peak_severity TEXT NOT NULL,             -- highest while open
    title         TEXT NOT NULL,
    message       TEXT,
    subject       TEXT NOT NULL,             -- JSON (ApiIssueSubject)
    first_seen    INTEGER NOT NULL,          -- epoch ms
    updated_at    INTEGER NOT NULL,
    cleared_at    INTEGER,                   -- null = open
    resolution    TEXT                       -- null = open
  );
  CREATE INDEX issue_history_profile ON issue_history(profile_id, first_seen);
  CREATE INDEX issue_history_open ON issue_history(profile_id, issue_id) WHERE cleared_at IS NULL;
  CREATE INDEX issue_history_cleared ON issue_history(cleared_at);
  `,
];

export function issueHistorySchemaVersion(db: Db): number {
  const exists = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'issue_history_meta'").get();
  if (!exists) return 0;
  const row = db.prepare("SELECT value FROM issue_history_meta WHERE key = 'schema'").get();
  return Number(row?.value ?? 0);
}

/** Create or upgrade the issue history table. Leaves PRAGMA user_version alone. */
export function migrateIssueHistory(db: Db, migrations: readonly string[] = ISSUE_HISTORY_MIGRATIONS): void {
  db.exec('CREATE TABLE IF NOT EXISTS issue_history_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const from = issueHistorySchemaVersion(db);
  if (from > migrations.length) {
    throw new Error(`Issue history table is h${from}, newer than this app supports (h${migrations.length})`);
  }
  for (let v = from; v < migrations.length; v++) {
    transaction(db, () => {
      db.exec(migrations[v] ?? '');
      db.prepare("INSERT INTO issue_history_meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
        String(v + 1),
      );
    });
  }
}

export interface IssueHistoryQuery {
  /** One profile; null/undefined = every profile. */
  profileId?: string | null;
  /** Only entries open at or after this epoch ms (cleared after it, or still open). */
  since?: number;
  /** Only entries that started at or before this epoch ms. */
  until?: number;
  /** Most entries (newest first). Default 200. */
  limit?: number;
}

export interface IssueHistoryRetention {
  maxAgeMs: number;
  maxRows: number;
}

export const ISSUE_HISTORY_RETENTION: IssueHistoryRetention = {
  maxAgeMs: ISSUE_HISTORY_DAYS * 24 * 3600_000,
  maxRows: ISSUE_HISTORY_MAX_ROWS,
};

export interface IssueHistoryRepo {
  /** issue.raised: a new row (update false, or no open row for the id), else the open row is updated. */
  raised(profileId: string, issue: ApiIssue): void;
  /** issue.cleared: closes the open row of the id (nothing when there is none). */
  cleared(profileId: string, cleared: ApiIssueCleared, at: number): void;
  /** Close every open row as `restarted` (start-up: the in-memory issues of the last run are gone). */
  closeOpen(at: number): number;
  /** Newest first. */
  list(q?: IssueHistoryQuery): IssueHistoryEntry[];
  /** Delete what is past the retention: cleared longer than maxAgeMs ago, and beyond maxRows. */
  prune(now: number, retention?: IssueHistoryRetention): number;
  count(): number;
}

const SEVERITY_RANK: Record<IssueSeverity, number> = { info: 0, warning: 1, critical: 2 };
const severity = (v: string): IssueSeverity => (v === 'info' || v === 'critical' ? v : 'warning');
const higher = (a: IssueSeverity, b: IssueSeverity): IssueSeverity => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a);

function subjectOf(raw: string | null): ApiIssueSubject {
  if (raw) {
    try {
      const v: unknown = JSON.parse(raw);
      if (v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string') return v as ApiIssueSubject;
    } catch {
      // fall through
    }
  }
  return { type: 'stream' };
}

function nullableInt(row: Row, col: string): number | null {
  return row[col] === null || row[col] === undefined ? null : int(row, col);
}

function toEntry(row: Row): IssueHistoryEntry {
  const firstSeen = int(row, 'first_seen');
  const clearedAt = nullableInt(row, 'cleared_at');
  return {
    id: str(row, 'issue_id'),
    profileId: str(row, 'profile_id'),
    kind: str(row, 'kind') as IssueKind,
    rule: strOrNull(row, 'rule'),
    severity: severity(str(row, 'severity')),
    peakSeverity: severity(str(row, 'peak_severity')),
    title: str(row, 'title'),
    message: strOrNull(row, 'message'),
    subject: subjectOf(strOrNull(row, 'subject')),
    firstSeen,
    updatedAt: int(row, 'updated_at'),
    clearedAt,
    durationMs: clearedAt === null ? null : Math.max(0, clearedAt - firstSeen),
    resolution: clearedAt === null ? null : ((strOrNull(row, 'resolution') ?? 'ended') as IssueHistoryResolution),
  };
}

const COLUMNS = 'row_id, profile_id, issue_id, kind, rule, severity, peak_severity, title, message, subject, first_seen, updated_at, cleared_at, resolution';
export const ISSUE_HISTORY_LIST_MAX = 1000;

export function createIssueHistoryRepo(db: Db): IssueHistoryRepo {
  migrateIssueHistory(db);
  const stmt = statementCache(db);
  const openRow = (profileId: string, issueId: string): Row | undefined =>
    stmt(`SELECT ${COLUMNS} FROM issue_history WHERE profile_id = ? AND issue_id = ? AND cleared_at IS NULL ORDER BY row_id DESC LIMIT 1`).get(profileId, issueId);

  return {
    raised(profileId, issue) {
      const open = openRow(profileId, issue.id);
      if (open) {
        stmt('UPDATE issue_history SET kind = ?, rule = ?, severity = ?, peak_severity = ?, title = ?, message = ?, subject = ?, updated_at = ? WHERE row_id = ?').run(
          issue.kind,
          issue.rule,
          issue.severity,
          higher(severity(str(open, 'peak_severity')), issue.severity),
          issue.title,
          issue.message,
          JSON.stringify(issue.subject),
          issue.updatedAt,
          int(open, 'row_id'),
        );
        return;
      }
      stmt(
        'INSERT INTO issue_history (profile_id, issue_id, kind, rule, severity, peak_severity, title, message, subject, first_seen, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(profileId, issue.id, issue.kind, issue.rule, issue.severity, issue.severity, issue.title, issue.message, JSON.stringify(issue.subject), issue.firstSeen, issue.updatedAt);
    },
    cleared(profileId, c, at) {
      const open = openRow(profileId, c.id);
      if (!open) return;
      stmt('UPDATE issue_history SET cleared_at = ?, resolution = ? WHERE row_id = ?').run(Math.max(at, int(open, 'first_seen')), c.resolution, int(open, 'row_id'));
    },
    closeOpen(at) {
      return Number(stmt("UPDATE issue_history SET cleared_at = MAX(?, updated_at), resolution = 'restarted' WHERE cleared_at IS NULL").run(at).changes);
    },
    list(q = {}) {
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (q.profileId) {
        where.push('profile_id = ?');
        args.push(q.profileId);
      }
      if (q.since !== undefined) {
        where.push('(cleared_at IS NULL OR cleared_at >= ?)');
        args.push(q.since);
      }
      if (q.until !== undefined) {
        where.push('first_seen <= ?');
        args.push(q.until);
      }
      const limit = Math.max(1, Math.min(ISSUE_HISTORY_LIST_MAX, Math.floor(q.limit ?? 200)));
      const sql = `SELECT ${COLUMNS} FROM issue_history ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY first_seen DESC, row_id DESC LIMIT ${limit}`;
      return db.prepare(sql).all(...args).map(toEntry);
    },
    prune(now, retention = ISSUE_HISTORY_RETENTION) {
      return transaction(db, () => {
        let n = Number(stmt('DELETE FROM issue_history WHERE cleared_at IS NOT NULL AND cleared_at < ?').run(now - retention.maxAgeMs).changes);
        const edge = stmt('SELECT row_id FROM issue_history ORDER BY row_id DESC LIMIT 1 OFFSET ?').get(Math.max(0, retention.maxRows));
        if (edge) n += Number(stmt('DELETE FROM issue_history WHERE row_id <= ?').run(int(edge, 'row_id')).changes);
        return n;
      });
    },
    count: () => Number(stmt('SELECT COUNT(*) AS n FROM issue_history').get()?.n ?? 0),
  };
}
