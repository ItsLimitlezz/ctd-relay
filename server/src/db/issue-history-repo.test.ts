import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { ApiIssue, ApiIssueCleared } from '../../../shared/issues.js';
import { MIGRATIONS, migrate, openDatabase, schemaVersion } from './database.js';
import { createGuestFeedsRepo } from './guest-feeds-repo.js';
import { createIssueHistoryRepo, ISSUE_HISTORY_MIGRATIONS, ISSUE_HISTORY_RETENTION, issueHistorySchemaVersion, migrateIssueHistory } from './issue-history-repo.js';

const T0 = Date.parse('2026-11-20T20:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 3600_000;

const issue = (over: Partial<ApiIssue> = {}): ApiIssue => ({
  id: 'feed.offline|landscape',
  kind: 'feed.offline',
  rule: null,
  severity: 'warning',
  title: 'Landscape feed lost',
  message: 'OBS stopped sending the landscape feed to Relay during the live.',
  subject: { type: 'feed', feed: 'landscape' },
  onProgram: null,
  scene: null,
  firstSeen: T0,
  updatedAt: T0,
  ...over,
});
const cleared = (i: ApiIssue, resolution: ApiIssueCleared['resolution'] = 'recovered'): ApiIssueCleared => ({
  id: i.id,
  kind: i.kind,
  rule: i.rule,
  subject: i.subject,
  title: i.title,
  firstSeen: i.firstSeen,
  durationMs: 0,
  resolution,
});

describe('issue history table (own migration track)', () => {
  it('only adds tables: PRAGMA user_version stays where 0.2.80 / 0.2.90 left it', () => {
    const db = openDatabase(':memory:');
    const before = schemaVersion(db);
    expect(before).toBe(MIGRATIONS.length);
    createIssueHistoryRepo(db);
    expect(schemaVersion(db)).toBe(before);
    expect(issueHistorySchemaVersion(db)).toBe(ISSUE_HISTORY_MIGRATIONS.length);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'issue_%' ORDER BY name").all().map((r) => r.name);
    expect(tables).toEqual(['issue_history', 'issue_history_meta']);
    db.close();
  });

  it('downgrade: 0.2.80 / 0.2.90 (the main migrations alone) still open a database this wrote, and deleting a profile there removes its rows', () => {
    const db = openDatabase(':memory:');
    // 0.2.90's guest feed track is there too (a database that went 0.2.80 → 0.2.90 → this).
    createGuestFeedsRepo(db);
    const repo = createIssueHistoryRepo(db);
    db.prepare("INSERT INTO profiles (id, name, slug, color, created_at, updated_at) VALUES ('p2', 'Club', 'club', NULL, 'x', 'x')").run();
    repo.raised('default', issue());
    repo.raised('p2', issue({ id: 'stream.down', kind: 'stream.down', subject: { type: 'stream' }, title: 'Every destination is down', severity: 'critical' }));
    // What 0.2.80 and 0.2.90 do on start: migrate() with their own (identical) main migration list.
    expect(() => migrate(db, MIGRATIONS)).not.toThrow();
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    // They can delete a profile (FK cascade takes its history along).
    db.prepare("DELETE FROM profiles WHERE id = 'p2'").run();
    expect(repo.list({ profileId: 'p2' })).toEqual([]);
    expect(repo.list({ profileId: 'default' })).toHaveLength(1);
    db.close();
  });

  it('re-running is a no-op and a newer track is refused', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE profiles (id TEXT PRIMARY KEY)');
    migrateIssueHistory(db);
    migrateIssueHistory(db);
    expect(issueHistorySchemaVersion(db)).toBe(ISSUE_HISTORY_MIGRATIONS.length);
    expect(() => migrateIssueHistory(db, [])).toThrow(/newer than this app supports/);
    db.close();
  });
});

describe('IssueHistoryRepo', () => {
  it('a raise opens a row, updates change it (keeping the highest severity), a clear closes it', () => {
    const db = openDatabase(':memory:');
    const repo = createIssueHistoryRepo(db);
    const a = issue();
    repo.raised('default', a);
    repo.raised('default', { ...a, severity: 'critical', message: 'Reconnecting', updatedAt: T0 + MIN });
    repo.raised('default', { ...a, severity: 'warning', updatedAt: T0 + 2 * MIN });
    let [row] = repo.list({ profileId: 'default' });
    expect(row).toMatchObject({ id: a.id, severity: 'warning', peakSeverity: 'critical', clearedAt: null, resolution: null, durationMs: null });
    repo.cleared('default', cleared(a), T0 + 3 * MIN);
    [row] = repo.list({ profileId: 'default' });
    expect(row).toMatchObject({ clearedAt: T0 + 3 * MIN, durationMs: 3 * MIN, resolution: 'recovered', subject: { type: 'feed', feed: 'landscape' } });
    // A clear of an id that isn't open changes nothing; the same id raised again is a new row.
    repo.cleared('default', cleared(a), T0 + 4 * MIN);
    repo.raised('default', { ...a, firstSeen: T0 + 5 * MIN, updatedAt: T0 + 5 * MIN });
    expect(repo.list().map((e) => [e.firstSeen, e.clearedAt])).toEqual([
      [T0 + 5 * MIN, null],
      [T0, T0 + 3 * MIN],
    ]);
    db.close();
  });

  it('closeOpen marks what the last run left open as restarted', () => {
    const db = openDatabase(':memory:');
    const repo = createIssueHistoryRepo(db);
    repo.raised('default', issue());
    expect(repo.closeOpen(T0 + MIN)).toBe(1);
    expect(repo.list()[0]).toMatchObject({ resolution: 'restarted', clearedAt: T0 + MIN });
    expect(repo.closeOpen(T0 + 2 * MIN)).toBe(0);
    db.close();
  });

  it('lists by profile and by time range (open at any time in it), newest first', () => {
    const db = openDatabase(':memory:');
    const repo = createIssueHistoryRepo(db);
    db.prepare("INSERT INTO profiles (id, name, slug, color, created_at, updated_at) VALUES ('p2', 'Club', 'club', NULL, 'x', 'x')").run();
    const before = issue({ id: 'a', firstSeen: T0 - 10 * MIN });
    const during = issue({ id: 'b', firstSeen: T0 + 5 * MIN });
    const after = issue({ id: 'c', firstSeen: T0 + 90 * MIN });
    const stillOpen = issue({ id: 'd', firstSeen: T0 - 5 * MIN });
    for (const i of [before, during, after, stillOpen]) repo.raised('default', i);
    repo.cleared('default', cleared(before), T0 - MIN); // over before the stream started
    repo.cleared('default', cleared(during), T0 + 6 * MIN);
    repo.raised('p2', issue({ id: 'other', firstSeen: T0 + MIN }));
    const inStream = repo.list({ profileId: 'default', since: T0, until: T0 + 60 * MIN });
    expect(inStream.map((e) => e.id)).toEqual(['b', 'd']);
    expect(repo.list({ profileId: null }).map((e) => e.id)).toEqual(['c', 'b', 'other', 'd', 'a']);
    expect(repo.list({ limit: 2 })).toHaveLength(2);
    db.close();
  });

  it('retention: rows cleared more than 7 days ago go, open ones stay, and at most maxRows are kept', () => {
    const db = openDatabase(':memory:');
    const repo = createIssueHistoryRepo(db);
    const old = issue({ id: 'old', firstSeen: T0 - 9 * DAY });
    const oldOpen = issue({ id: 'old-open', firstSeen: T0 - 9 * DAY });
    const recent = issue({ id: 'recent', firstSeen: T0 - 6 * DAY });
    for (const i of [old, oldOpen, recent]) repo.raised('default', i);
    repo.cleared('default', cleared(old), T0 - 8 * DAY);
    repo.cleared('default', cleared(recent), T0 - 6 * DAY + MIN);
    expect(repo.prune(T0)).toBe(1);
    expect(repo.list().map((e) => e.id).sort()).toEqual(['old-open', 'recent']);

    for (let n = 0; n < 30; n++) repo.raised('default', issue({ id: `x${n}`, firstSeen: T0 + n }));
    expect(repo.count()).toBe(32);
    expect(repo.prune(T0, { ...ISSUE_HISTORY_RETENTION, maxRows: 10 })).toBe(22);
    expect(repo.count()).toBe(10);
    // The newest rows are the ones kept.
    expect(repo.list({ limit: 1000 }).map((e) => e.id)).toContain('x29');
    expect(repo.list({ limit: 1000 }).map((e) => e.id)).not.toContain('recent');
    db.close();
  });

  it('defaults: 7 days and 5,000 rows', () => {
    expect(ISSUE_HISTORY_RETENTION).toEqual({ maxAgeMs: 7 * DAY, maxRows: 5000 });
  });
});
