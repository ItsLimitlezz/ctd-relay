// The issue history (docs/API.md §17.7): recording the hub's issue.* envelopes, GET /api/v1/issues/history,
// and a stream's issues in its Stream Report and its exports.

import { afterEach, describe, expect, it } from 'vitest';
import type { ApiIssue, ApiIssueCleared } from '../../../shared/issues.js';
import { openDatabase } from '../db/database.js';
import { createIssueHistoryRepo, type IssueHistoryRepo } from '../db/issue-history-repo.js';
import { collect, renderExport, tables } from '../reports/export.js';
import { sessionDetail } from '../reports/report.js';
import { createRig, T0 } from '../reports/test-helpers.js';
import { unzip } from '../reports/zip.js';
import { historyLimit, IssueHistory, setIssueHistoryFor } from './issue-history.js';
import { createTestApi, silentLog, type TestApi } from './test-helpers.js';
import type { Envelope, EnvelopeSource } from './types.js';

const MIN = 60_000;
const issue = (over: Partial<ApiIssue> = {}): ApiIssue => ({
  id: 'destination.down|d1',
  kind: 'destination.down',
  rule: null,
  severity: 'warning',
  title: 'Twitch main is down',
  message: 'Twitch refused the stream',
  subject: { type: 'destination', destinationId: 'd1', platform: 'twitch', name: 'Twitch main' },
  onProgram: null,
  scene: null,
  firstSeen: T0,
  updatedAt: T0,
  ...over,
});
const clearedOf = (i: ApiIssue): ApiIssueCleared => ({ id: i.id, kind: i.kind, rule: i.rule, subject: i.subject, title: i.title, firstSeen: i.firstSeen, durationMs: 0, resolution: 'recovered' });
const src = (profile: string | null): EnvelopeSource => ({ connector: 'ctd-multi-stream', connection: 'core', platform: 'core', profile });
const env = (type: Envelope['type'], profile: string | null, data: unknown, ts: number): Envelope => ({ id: `e${ts}`, type, ts, src: src(profile), data });

/** A hand-driven stand-in for the event hub. */
function fakeEvents() {
  const listeners = new Set<(e: Envelope) => void>();
  return {
    subscribe(l: (e: Envelope) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    emit: (e: Envelope) => {
      for (const l of listeners) l(e);
    },
    size: () => listeners.size,
  };
}

describe('IssueHistory', () => {
  it('closes what the last run left open, then records issue.raised / issue.cleared of each profile', () => {
    const db = openDatabase(':memory:');
    const repo = createIssueHistoryRepo(db);
    repo.raised('default', issue({ id: 'left.over' }));
    const events = fakeEvents();
    let now = T0 + MIN;
    const history = new IssueHistory({ repo, events, log: silentLog, now: () => now, timers: false });
    history.start();
    expect(repo.list()[0]).toMatchObject({ id: 'left.over', resolution: 'restarted' });

    const a = issue({ firstSeen: now, updatedAt: now });
    events.emit(env('issue.raised', 'default', { ...a, update: false }, now));
    events.emit(env('issue.raised', null, { ...a, update: false }, now)); // no profile: not recorded
    events.emit(env('feed.status', 'default', {}, now));
    now += 2 * MIN;
    events.emit(env('issue.cleared', 'default', clearedOf(a), now));
    const [latest] = history.list({ profileId: 'default' });
    expect(latest).toMatchObject({ id: a.id, clearedAt: now, durationMs: 2 * MIN, resolution: 'recovered' });
    expect(history.list()).toHaveLength(2);
    history.close();
    expect(events.size()).toBe(0);
    db.close();
  });

  it('a failing write is logged and dropped, never thrown at the hub', () => {
    const warnings: string[] = [];
    const repo = {
      closeOpen: () => 0,
      prune: () => 0,
      raised: () => {
        throw new Error('disk I/O error');
      },
    } as unknown as IssueHistoryRepo;
    const events = fakeEvents();
    const history = new IssueHistory({ repo, events, log: { info: () => undefined, warn: (_o: unknown, m: string) => void warnings.push(m) } as never, timers: false });
    history.start();
    expect(() => events.emit(env('issue.raised', 'default', { ...issue(), update: false }, T0))).not.toThrow();
    expect(warnings).toEqual(['issue history: recording an issue failed']);
    history.close();
  });

  it('?limit= is 1–1000, default 200', () => {
    expect(historyLimit(undefined)).toBe(200);
    expect(historyLimit('50')).toBe(50);
    expect(historyLimit('0')).toBeNull();
    expect(historyLimit('1001')).toBeNull();
    expect(historyLimit('x')).toBeNull();
  });
});

describe('GET /api/v1/issues/history (v1.18)', () => {
  let t: TestApi;
  afterEach(async () => {
    await t?.close();
  });

  it('lists the last 7 days newest first, per profile or every profile, with status:read', async () => {
    t = await createTestApi();
    const db = openDatabase(':memory:');
    const history = new IssueHistory({ repo: createIssueHistoryRepo(db), events: t.hub, log: silentLog, timers: false });
    setIssueHistoryFor(t.services, history);
    history.start();
    const club = t.addProfile('Club');
    db.prepare("INSERT INTO profiles (id, name, slug, color, created_at, updated_at) VALUES (?, 'Club', 'club', NULL, 'x', 'x')").run(club.id);
    // Through the real hub: the OBS plugin reports a problem, then that it is fixed.
    t.bus.emit('obs-event', {
      appId: 'ctd-obs-plugin-studio',
      profileId: 'default',
      type: 'obs.issue.raised',
      id: 'i1',
      ts: Date.now(),
      data: { id: 'camera-offline|Club cam', rule: 'camera-offline', severity: 'critical', source: 'Club cam', title: 'Camera offline' },
    });
    const reader = t.token(['status:read']);
    const get = (url: string, token = reader) => t.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

    let res = await get('/api/v1/issues/history');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ retentionDays: 7, items: [{ kind: 'obs.issue', title: 'Camera offline', clearedAt: null, resolution: null, profileId: 'default' }] });

    t.bus.emit('obs-event', { appId: 'ctd-obs-plugin-studio', profileId: 'default', type: 'obs.issue.cleared', id: 'i2', ts: Date.now(), data: { id: 'camera-offline|Club cam' } });
    res = await get('/api/v1/issues/history?profile=*&limit=10');
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0]).toMatchObject({ resolution: 'recovered', peakSeverity: 'critical' });
    expect((await get(`/api/v1/issues/history?profile=${club.id}`)).json().items).toEqual([]);

    expect((await get('/api/v1/issues/history?limit=0')).statusCode).toBe(400);
    expect((await get('/api/v1/issues/history?profile=nope')).statusCode).toBe(404);
    expect((await get('/api/v1/issues/history', t.token(['chat:read']))).statusCode).toBe(403);
    // A token limited to the club profile sees its own profile only.
    expect((await get('/api/v1/issues/history?profile=default', t.token(['status:read'], 'club app', club.id))).statusCode).toBe(403);
    expect((await get('/api/v1/issues/history?profile=*', t.token(['status:read'], 'club app', club.id))).json().items).toEqual([]);
    history.close();
    db.close();
  });
});

describe('issues in the Stream Report', () => {
  it('lists the issues open during the stream (from the history), in the detail and as the Issues sheet', () => {
    const rig = createRig();
    const repo = createIssueHistoryRepo(rig.db);
    const history = new IssueHistory({ repo, events: { subscribe: () => () => undefined }, log: silentLog, now: () => rig.clock.now, timers: false });
    // Before the stream, and over before it started: not in it.
    const old = issue({ id: 'old', firstSeen: T0 - 30 * MIN, title: 'Old problem' });
    repo.raised('default', old);
    repo.cleared('default', clearedOf(old), T0 - 20 * MIN);
    // Raised before, still open at the start: in it.
    repo.raised('default', issue({ id: 'obs.issue|app|cam', kind: 'obs.issue', rule: 'camera-offline', title: 'Camera offline', severity: 'critical', subject: { type: 'obs.source', appId: 'app', source: 'Club cam', path: null }, firstSeen: T0 - MIN }));

    rig.startSession('s1');
    const during = issue({ firstSeen: T0 + 2 * MIN, updatedAt: T0 + 2 * MIN });
    repo.raised('default', during);
    repo.raised('default', { ...during, severity: 'critical', updatedAt: T0 + 3 * MIN });
    repo.cleared('default', clearedOf(during), T0 + 4 * MIN);
    rig.clock.advance(10 * MIN);
    rig.stopSession();
    // After the stream: not in it.
    repo.raised('default', issue({ id: 'later', firstSeen: T0 + 20 * MIN, title: 'Later problem' }));

    const ctx = { ...rig.reports.context(), issues: (p: string, from: number, to: number) => history.between(p, from, to) };
    const d = sessionDetail(ctx, 's1')!;
    expect(d.issues.map((i) => i.title)).toEqual(['Camera offline', 'Twitch main is down']);
    expect(d.issues[1]).toMatchObject({
      severity: 'critical',
      affects: 'Destination Twitch main',
      startedAt: new Date(T0 + 2 * MIN).toISOString(),
      clearedAt: new Date(T0 + 4 * MIN).toISOString(),
      durationSec: 120,
      resolution: 'recovered',
    });
    expect(d.issues[0]).toMatchObject({ affects: 'OBS source Club cam', clearedAt: null, resolution: null });
    // Without a history (older reports code paths): none, nothing breaks.
    expect(sessionDetail(rig.reports.context(), 's1')!.issues).toEqual([]);

    const bundle = collect(ctx, { sessionId: 's1' }, 'UTC')!;
    const sheet = tables(bundle).find((s) => s.name === 'Issues')!;
    expect(sheet.columns.map((c) => c.header)).toEqual(['Started (UTC)', 'Severity', 'Issue', 'Affects', 'Detail', 'Cleared (UTC)', 'Duration', 'How it ended', 'Kind']);
    expect(sheet.rows).toEqual([
      [T0 - MIN, 'critical', 'Camera offline', 'OBS source Club cam', 'Twitch refused the stream', null, null, 'still open', 'obs.issue'],
      [T0 + 2 * MIN, 'critical', 'Twitch main is down', 'Destination Twitch main', 'Twitch refused the stream', T0 + 4 * MIN, 120, 'recovered', 'destination.down'],
    ]);
    // In the .xlsx: the Issues sheet, last, with the titles in it.
    const files = unzip(renderExport(bundle, 'xlsx', 'r').body);
    const names = [...files.get('xl/workbook.xml')!.toString().matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    expect(names.at(-1)).toBe('Issues');
    const xml = [...files.entries()].filter(([n]) => n.startsWith('xl/')).map(([, b]) => b.toString()).join('');
    expect(xml).toContain('Twitch main is down');
  });
});
