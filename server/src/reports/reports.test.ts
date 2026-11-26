import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate, openDatabase, schemaVersion } from '../db/database.js';
import { collect, renderExport, tables, toCsv, wallClock } from './export.js';
import { HOLD_MS, seriesStats, stepSeries, sumSeries, unionMs, valueAt } from './math.js';
import { PRESENCE_MAX_CREDIT_SEC, PRESENCE_SAMPLE_MS, VIEWER_SAMPLE_MS, othersCount, reportSettingsFrom } from './recorder.js';
import { DEFAULT_REPORT_SETTINGS } from '../../../shared/reports.js';
import { normalizeChatMessage } from '../chat/normalize.js';
import { leaderboard, listSessions, rangeSummary, sessionDetail, userDetail } from './report.js';
import { REPORT_MIGRATIONS, migrateReports, reportSchemaVersion } from './schema.js';
import { createRig, T0, type Rig } from './test-helpers.js';
import { unzip } from './zip.js';

/** SHA-256 of each shipped report migration step. A shipped step must never change. */
const SHIPPED_REPORT_STEPS = [
  '45ac820555b7790081dd9870d0173d3fe43a043052643b8c4a81cb1dcfd66816', // r1: sessions, samples, chat, feeds, audience
];

const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('report tables (schema.ts)', () => {
  it('has its own track: user_version stays at the main schema, reports_meta holds r1', () => {
    const db = openDatabase(':memory:');
    migrateReports(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(reportSchemaVersion(db)).toBe(REPORT_MIGRATIONS.length);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['report_sessions', 'report_viewer_samples', 'report_chat_minutes', 'audience_users', 'audience_stream']));
    migrateReports(db); // idempotent
    expect(reportSchemaVersion(db)).toBe(REPORT_MIGRATIONS.length);
  });

  it('shipped steps never change', () => {
    const hashes = REPORT_MIGRATIONS.map((m) => crypto.createHash('sha256').update(m).digest('hex'));
    expect(hashes.slice(0, SHIPPED_REPORT_STEPS.length)).toEqual(SHIPPED_REPORT_STEPS);
  });

  it('an older Relay (main migrations only) still opens a database that has report tables', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctd-reports-'));
    dirs.push(dir);
    const file = path.join(dir, 'app.db');
    const rig = createRig({ db: openDatabase(file) });
    rig.startSession('old-check');
    rig.db.close();
    // What 0.2.40 does at start-up: open + migrate with its own list. It must not refuse the file.
    const old = new DatabaseSync(file);
    expect(() => migrate(old, MIGRATIONS)).not.toThrow();
    expect(schemaVersion(old)).toBe(MIGRATIONS.length);
    old.close();
  });

  it('report tables made by a newer Relay switch reports off instead of failing the start', () => {
    const db = openDatabase(':memory:');
    migrateReports(db);
    db.prepare("UPDATE reports_meta SET value = '99' WHERE key = 'schema'").run();
    const rig = createRig({ db });
    expect(rig.reports.available).toBe(false);
  });
});

describe('math.ts', () => {
  it('a sample holds for at most HOLD_MS; longer gaps are unknown', () => {
    const s = stepSeries([
      { t: 0, v: 10 },
      { t: 30_000, v: 20 },
      { t: 30_000 + HOLD_MS + 60_000, v: 5 },
    ]);
    expect(valueAt(s, 15_000)).toBe(10);
    expect(valueAt(s, 30_000 + HOLD_MS - 1)).toBe(20);
    expect(valueAt(s, 30_000 + HOLD_MS + 1)).toBeNull();
  });

  it('null is unknown, never zero: it adds no viewer-minutes and is not in the average', () => {
    const s = stepSeries([
      { t: 0, v: 100 },
      { t: MIN, v: null },
      { t: 2 * MIN, v: 50 },
      { t: 3 * MIN, v: 50 },
    ]);
    const st = seriesStats(s, 0, 4 * MIN);
    // 100 for a minute, unknown for a minute, 50 for the last two minutes (clipped at the end).
    expect(st.knownMs).toBe(3 * MIN);
    expect(st.viewerMs).toBe(100 * MIN + 50 * 2 * MIN);
    expect(st.peak).toBe(100);
    expect(st.peakAt).toBe(0);
  });

  it('sums the known series only; unknown when none is known', () => {
    const a = stepSeries([{ t: 0, v: 10 }, { t: MIN, v: null }]);
    const b = stepSeries([{ t: 30_000, v: 5 }]);
    const total = sumSeries([a, b]);
    expect(valueAt(total, 0)).toBe(10);
    expect(valueAt(total, 40_000)).toBe(15);
    expect(valueAt(total, MIN + 1)).toBe(5); // a unknown, b still held
    expect(valueAt(total, 30_000 + HOLD_MS + 1)).toBeNull();
  });

  it('union of live periods clipped to the session', () => {
    expect(
      unionMs(
        [
          { start: 0, end: 10 },
          { start: 5, end: 20 },
          { start: 30, end: null },
        ],
        2,
        40,
      ),
    ).toBe(18 + 10);
  });
});

/** A 10-minute stream on Twitch + YouTube (two YouTube destinations), with a gap in Twitch viewers. */
function liveStream(rig: Rig) {
  const tw = rig.destination('twitch', { options: { dualFormat: 'relay-multitrack' } });
  const yt1 = rig.destination('youtube', { feed: 'landscape' });
  const yt2 = rig.destination('youtube', { feed: 'vertical' });
  rig.startSession('s1', { testMode: false });
  rig.feed('landscape', true);
  rig.dest(tw, 'preparing');
  rig.dest(yt1, 'preparing');
  rig.dest(yt2, 'preparing');
  rig.clock.advance(10_000);
  rig.dest(tw, 'live', { viewers: null });
  rig.dest(yt1, 'live');
  rig.dest(yt2, 'live', { viewers: 4 });
  return { tw, yt1, yt2 };
}

describe('recording', () => {
  it('samples viewers every tick and on change; unknown stays null', () => {
    const rig = createRig();
    const { tw, yt2 } = liveStream(rig);
    rig.reports.recorder.tick();
    rig.clock.advance(5_000);
    rig.dest(tw, 'live', { viewers: 12 }); // change → sample now
    rig.clock.advance(VIEWER_SAMPLE_MS - 5_000);
    rig.reports.recorder.tick();
    const samples = rig.reports.store.viewerSamples(['s1']);
    const tw0 = samples.filter((x) => x.destinationId === tw);
    expect(tw0.map((x) => x.viewers)).toEqual([null, 12, 12]);
    expect(samples.filter((x) => x.destinationId === yt2).map((x) => x.viewers)).toEqual([4, 4, 4]);
    expect(samples.some((x) => x.viewers === 0)).toBe(false);
    const d = rig.reports.store.destinations(['s1']).find((x) => x.destinationId === tw)!;
    expect(d.dualFormat).toBe('relay-multitrack');
  });

  it('records titles, live periods, errors, recoveries and the end', () => {
    const rig = createRig();
    const { tw } = liveStream(rig);
    rig.clock.advance(MIN);
    rig.session({ title: 'New title' });
    rig.dest(tw, 'recovering', { recoveries: 1, lastRecovery: { at: iso(rig.clock.now), reason: 'ended by the platform' } });
    rig.clock.advance(MIN);
    rig.dest(tw, 'live', { recoveries: 1 });
    rig.dest(tw, 'error', { recoveries: 1, message: 'Twitch rejected the stream key' });
    rig.clock.advance(MIN);
    rig.stopSession();
    const d = sessionDetail(rig.reports.context(), 's1')!;
    expect(d.titles.map((t) => t.title)).toEqual(['Test stream', 'New title']);
    expect(d.endedAt).toBe(iso(rig.clock.now));
    const kinds = d.events.map((e) => e.kind);
    expect(kinds).toContain('destination.recovery');
    expect(kinds).toContain('destination.error');
    expect(kinds[kinds.length - 1]).toBe('session.end');
    const tdest = d.destinations.find((x) => x.destinationId === tw)!;
    expect(tdest.live).toHaveLength(2);
    expect(tdest.live.every((p) => p.end !== null)).toBe(true);
    const twStats = d.stats.find((s) => s.platform === 'twitch')!;
    expect(twStats.recoveries).toBe(1);
    expect(twStats.errors).toBe(1);
  });

  it('counts chat per platform per minute, unique chatters, joins and anonymous joins', () => {
    const rig = createRig();
    const { tw } = liveStream(rig);
    const ig = rig.destination('instagram', { feed: 'vertical' });
    rig.dest(ig, 'live');
    rig.chat('twitch', tw, { name: 'Viewer A', id: '11' });
    rig.chat('twitch', tw, { name: 'Viewer A', id: '11' });
    rig.chat('twitch', tw, { name: 'Viewer B', id: '12' });
    rig.chat('instagram', ig, { name: 'fan_one' }, { kind: 'event', join: true, text: 'fan_one and 3 others joined', othersCount: 3 });
    rig.clock.advance(MIN);
    rig.chat('twitch', tw, { name: 'Viewer B', id: '12' });
    rig.reports.recorder.tick();
    const minutes = rig.reports.store.chatMinutes(['s1']);
    const twMin = minutes.filter((m) => m.platform === 'twitch');
    expect(twMin.map((m) => [m.messages, m.uniqueChatters])).toEqual([
      [3, 2],
      [1, 1],
    ]);
    const totals = rig.reports.store.chatTotals(['s1']);
    expect(totals.find((t) => t.platform === 'twitch')).toMatchObject({ messages: 4, uniqueChatters: 2 });
    expect(totals.find((t) => t.platform === 'instagram')).toMatchObject({ messages: 0, joins: 1, anonymousJoins: 3 });
    // Audience: the named joiner is a user; message text is stored nowhere.
    const rows = rig.reports.store.audienceStreams(['s1']);
    expect(rows.find((r) => r.userId === 'instagram:name:fan_one')).toMatchObject({ joins: 1, messages: 0 });
    const dump = JSON.stringify(rig.db.prepare('SELECT * FROM audience_stream').all()) + JSON.stringify(rig.db.prepare('SELECT * FROM report_events').all());
    expect(dump).not.toContain('hello');
  });

  it('othersCount: only positive whole numbers count', () => {
    const base = { id: 'x', platform: 'instagram', destinationId: 'd', author: { name: 'a' }, text: '', ts: '', kind: 'event' } as const;
    expect(othersCount({ ...base, othersCount: 3 } as never)).toBe(3);
    expect(othersCount({ ...base, othersCount: -2 } as never)).toBe(0);
    expect(othersCount({ ...base, othersCount: '5' } as never)).toBe(0);
    expect(othersCount({ ...base } as never)).toBe(0);
  });

  it('audience tracking off: counts only, no rows about people', () => {
    const rig = createRig();
    rig.reports.saveSettings({ recording: true, audience: false, retentionDays: 0 });
    const { tw } = liveStream(rig);
    rig.chat('twitch', tw, { name: 'Viewer A', id: '11' });
    rig.reports.recorder.tick();
    expect(rig.reports.store.audienceStreams(['s1'])).toEqual([]);
    expect(rig.db.prepare('SELECT COUNT(*) AS c FROM audience_users').get()).toEqual({ c: 0 });
    expect(rig.reports.store.chatTotals(['s1'])[0]).toMatchObject({ messages: 1, uniqueChatters: 1 });
    expect(sessionDetail(rig.reports.context(), 's1')!.audienceTracked).toBe(false);
  });

  it('recording off: nothing is recorded, and turning it off ends the current recording', () => {
    const rig = createRig();
    liveStream(rig);
    rig.reports.saveSettings({ recording: false, audience: true, retentionDays: 0 });
    expect(rig.reports.store.getSession('s1')!.endedAt).not.toBeNull();
    rig.stopSession();
    rig.startSession('s2');
    expect(rig.reports.store.getSession('s2')).toBeNull();
  });

  it('feed stats per minute, with offline periods', () => {
    const rig = createRig();
    liveStream(rig);
    rig.reports.recorder.tick();
    rig.clock.advance(MIN);
    rig.feed('landscape', false);
    rig.reports.recorder.tick();
    const feeds = rig.reports.store.feedMinutes(['s1']);
    expect(feeds[0]).toMatchObject({ feed: 'landscape', online: true, codec: 'h264', width: 1920, fps: 60, bitrateKbps: 6000, keyframeSec: 2 });
    expect(feeds[feeds.length - 1]).toMatchObject({ online: false, codec: null, bitrateKbps: null });
    expect(rig.reports.store.events(['s1']).map((e) => e.kind)).toContain('feed.offline');
  });

  it('a session left open by a restart is closed at its last record', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctd-reports-'));
    dirs.push(dir);
    const file = path.join(dir, 'app.db');
    const rig = createRig({ db: openDatabase(file) });
    liveStream(rig);
    rig.clock.advance(MIN);
    rig.reports.recorder.tick();
    const lastSeen = iso(rig.clock.now);
    rig.reports.close();
    rig.db.close();
    const again = createRig({ db: openDatabase(file) });
    const s = again.reports.store.getSession('s1')!;
    expect(s.endedAt).toBe(lastSeen);
    expect(s.endedByRestart).toBe(true);
    expect(again.reports.store.livePeriods(['s1']).every((p) => p.endedAt === lastSeen)).toBe(true);
  });
});

describe('presence (watch time only where the platform says who is there)', () => {
  it('credits the time between two samples a user was in, capped', async () => {
    let users = [{ id: '11', login: 'viewer_a', name: 'Viewer A' }];
    const rig = createRig({ presence: async (dest) => (dest.platform === 'twitch' ? { ok: true, users } : { ok: false, reason: 'unsupported' }) });
    const { tw, yt1 } = liveStream(rig);
    void yt1;
    await rig.reports.recorder.presenceTick(); // first sample: no credit
    rig.clock.advance(PRESENCE_SAMPLE_MS);
    users = [...users, { id: '12', login: 'viewer_b', name: 'Viewer B' }];
    await rig.reports.recorder.presenceTick();
    rig.clock.advance(PRESENCE_SAMPLE_MS * 10); // a long gap: capped
    await rig.reports.recorder.presenceTick();
    const rows = rig.reports.store.audienceStreams(['s1']);
    const a = rows.find((r) => r.userId === 'twitch:11')!;
    const b = rows.find((r) => r.userId === 'twitch:12')!;
    expect(a.watchSec).toBe(PRESENCE_SAMPLE_MS / 1000 + PRESENCE_MAX_CREDIT_SEC);
    expect(b.watchSec).toBe(PRESENCE_MAX_CREDIT_SEC);
    expect(a.presenceSamples).toBe(3);
    const board = leaderboard(rig.reports.context(), { sessionIds: ['s1'] }, 'watch', null);
    expect(board.rows.map((r) => r.id)).toEqual(['twitch:11', 'twitch:12']);
    // YouTube says nothing about presence: its viewers have no watch time (null, not 0).
    void tw;
  });

  it('a login without the scope: one event, no more asks this session', async () => {
    let asks = 0;
    const rig = createRig({
      presence: async () => {
        asks++;
        return { ok: false, reason: 'scope', message: 'reconnect' };
      },
    });
    const tw = rig.destination('twitch');
    rig.startSession('s1');
    rig.dest(tw, 'live');
    await rig.reports.recorder.presenceTick();
    await rig.reports.recorder.presenceTick();
    expect(asks).toBe(1);
    expect(rig.reports.store.events(['s1']).filter((e) => e.kind === 'presence.unavailable')).toHaveLength(1);
  });

  it('platforms without presence: watch time is null, attended = chatted or joined', () => {
    const rig = createRig();
    const { yt1 } = liveStream(rig);
    rig.chat('youtube', yt1, { name: 'Viewer C', id: 'UC1' });
    const d = userDetail(rig.reports.context(), 'youtube:UC1')!;
    expect(d.totals.watchSec).toBeNull();
    expect(d.totals.streams).toBe(1);
    expect(leaderboard(rig.reports.context(), { sessionIds: ['s1'] }, 'watch', null).rows).toEqual([]);
  });
});

describe('report math over a recorded stream', () => {
  function recorded() {
    const rig = createRig();
    const { tw, yt1, yt2 } = liveStream(rig); // t = T0 + 10 s
    rig.reports.recorder.tick();
    rig.dest(tw, 'live', { viewers: 10 });
    rig.dest(yt1, 'live', { viewers: 6 });
    for (let i = 0; i < 4; i++) {
      rig.clock.advance(VIEWER_SAMPLE_MS);
      rig.reports.recorder.tick();
    }
    // Twitch stops reporting viewers for 2 minutes (null), YouTube keeps going.
    rig.dest(tw, 'live', { viewers: null });
    for (let i = 0; i < 4; i++) {
      rig.clock.advance(VIEWER_SAMPLE_MS);
      rig.reports.recorder.tick();
    }
    rig.dest(tw, 'live', { viewers: 30 });
    rig.chat('twitch', tw, { name: 'Viewer A', id: '11' });
    rig.chat('twitch', tw, { name: 'Viewer B', id: '12' });
    rig.chat('youtube', yt1, { name: 'Viewer C', id: 'UC1' });
    rig.clock.advance(VIEWER_SAMPLE_MS);
    rig.reports.recorder.tick();
    rig.stopSession();
    return rig;
  }

  it('per platform and total: peak, average, viewer-minutes, chat rate, uptime', () => {
    const rig = recorded();
    const d = sessionDetail(rig.reports.context(), 's1')!;
    const tw = d.stats.find((s) => s.platform === 'twitch')!;
    const yt = d.stats.find((s) => s.platform === 'youtube')!;
    const total = d.stats.find((s) => s.platform === 'total')!;
    expect(d.durationSec).toBe(10 + 9 * 30);
    // Twitch: unknown 30 s, 10 for 2 min, unknown 2 min, 30 for 30 s.
    expect(tw.peakViewers).toBe(30);
    expect(tw.viewersKnownMinutes).toBe(2.5);
    expect(tw.viewerMinutes).toBe(10 * 2 + 30 * 0.5);
    expect(tw.avgViewers).toBe(14);
    // YouTube: vertical 4 the whole time, landscape unknown then 6.
    expect(yt.peakViewers).toBe(10);
    // Total = sum of the known platforms at each moment.
    expect(total.peakViewers).toBe(40);
    expect(total.viewerMinutes).toBe(Math.round((tw.viewerMinutes! + yt.viewerMinutes!) * 10) / 10);
    expect(tw.chatMessages).toBe(2);
    expect(tw.chatPer1kViewerMinutes).toBe(Math.round((2 / 35) * 1000 * 10) / 10);
    expect(total.uniqueChatters).toBe(3);
    expect(tw.uptime).toBeCloseTo(270 / 280, 3);
    // The viewers timeline never turns unknown into 0.
    expect(d.viewers.some((v) => v.byPlatform.twitch === null)).toBe(true);
    expect(d.viewers.some((v) => v.byPlatform.twitch === 0)).toBe(false);
  });

  it('list rows and date-range summaries', () => {
    const rig = recorded();
    rig.clock.advance(3600_000);
    rig.startSession('s2');
    const tw = rig.repos.destinations.list().find((x) => x.platform === 'twitch')!.id;
    rig.dest(tw, 'live', { viewers: 50 });
    rig.chat('twitch', tw, { name: 'Viewer A', id: '11' });
    rig.clock.advance(MIN);
    rig.reports.recorder.tick();
    rig.stopSession();
    const list = listSessions(rig.reports.context(), {});
    expect(list.map((s) => s.id)).toEqual(['s2', 's1']);
    const range = rangeSummary(rig.reports.context(), { from: iso(T0 - 1), to: iso(rig.clock.now + 1) });
    expect(range.streams).toBe(2);
    const total = range.stats.find((s) => s.platform === 'total')!;
    expect(total.peakViewers).toBe(50);
    expect(total.chatMessages).toBe(4);
    expect(total.uniqueChatters).toBe(3); // Viewer A counted once over both streams
    const loyal = range.leaderboards.find((l) => l.kind === 'loyal')!;
    expect(loyal.rows[0]).toMatchObject({ id: 'twitch:11', streams: 2 });
    const newest = range.leaderboards.find((l) => l.kind === 'newest')!;
    expect(newest.rows.map((r) => r.id)).toEqual(['twitch:11']); // first seen in range, 2 streams
    const chatters = leaderboard(rig.reports.context(), { sessionIds: ['s1', 's2'] }, 'chatters', 'twitch');
    expect(chatters.rows.map((r) => [r.id, r.messages])).toEqual([
      ['twitch:11', 2],
      ['twitch:12', 1],
    ]);
  });

  it('forget this user removes every report row about them', () => {
    const rig = recorded();
    expect(rig.reports.store.forgetUser('twitch:11')).toBe(true);
    expect(rig.reports.store.user('twitch:11')).toBeNull();
    expect(rig.reports.store.audienceStreams(['s1']).some((r) => r.userId === 'twitch:11')).toBe(false);
    expect(rig.db.prepare("SELECT COUNT(*) AS c FROM audience_stream WHERE user_id = 'twitch:11'").get()).toEqual({ c: 0 });
    expect(rig.reports.store.forgetUser('twitch:11')).toBe(false);
  });

  it('retention deletes old streams and the people only seen in them', () => {
    const rig = recorded();
    rig.clock.advance(100 * 86_400_000);
    rig.reports.saveSettings({ recording: true, audience: true, retentionDays: 90 });
    expect(rig.reports.store.getSession('s1')).toBeNull();
    expect(rig.db.prepare('SELECT COUNT(*) AS c FROM audience_users').get()).toEqual({ c: 0 });
    expect(rig.db.prepare('SELECT COUNT(*) AS c FROM report_viewer_samples').get()).toEqual({ c: 0 });
  });

  it('the .xlsx opens as a workbook and holds the same numbers as the JSON export', () => {
    const rig = recorded();
    const bundle = collect(rig.reports.context(), { sessionId: 's1' }, 'UTC')!;
    const json = JSON.parse(renderExport(bundle, 'json', 'r').body.toString('utf8')) as typeof bundle;
    const files = unzip(renderExport(bundle, 'xlsx', 'r').body);
    for (const f of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/styles.xml', 'xl/charts/chart1.xml', 'xl/drawings/drawing1.xml']) {
      expect(files.has(f), f).toBe(true);
    }
    const workbook = files.get('xl/workbook.xml')!.toString();
    const names = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(['Summary', 'Per platform', 'Viewers', 'Chat per minute', 'Events', 'Top chatters', 'Audience', 'Anonymous joins', 'Feeds', 'Issues']);
    const sheet = (n: number) => files.get(`xl/worksheets/sheet${n}.xml`)!.toString();
    // Frozen header on every sheet; the chart sits on Viewers.
    for (let i = 1; i <= names.length; i++) expect(sheet(i)).toContain('state="frozen"');
    expect(sheet(3)).toContain('<drawing r:id="rId1"/>');
    // Per platform: read the numbers back and compare with JSON.
    const cells = parseSheet(sheet(2));
    const header = cells[0]!;
    const col = (h: string) => header.indexOf(h);
    for (const s of json.sessions[0]!.stats) {
      const row = cells.find((r) => r[col('Platform')] === (s.platform === 'total' ? 'Total' : s.platform === 'youtube' ? 'YouTube' : 'Twitch'))!;
      expect(Number(row[col('Viewer-minutes')])).toBe(s.viewerMinutes);
      expect(Number(row[col('Peak viewers')])).toBe(s.peakViewers);
      expect(Number(row[col('Chat messages')])).toBe(s.chatMessages);
      expect(Number(row[col('Duration')]) * 86_400).toBeCloseTo(s.durationSec, 6);
      expect(Number(row[col('Uptime')])).toBe(s.uptime);
    }
    // Dates are Excel serials, not text.
    const summary = parseSheet(sheet(1));
    expect(Number(summary[1]![0])).toBeCloseTo(Date.parse(json.sessions[0]!.startedAt) / 86_400_000 + 25_569, 6);
    // Unknown viewers are empty cells, not 0.
    const viewers = parseSheet(sheet(3));
    expect(viewers.slice(1).some((r) => r[1] === undefined)).toBe(true);
    expect(viewers.slice(1).every((r) => r[1] !== '0')).toBe(true);
    // Top chatters agrees with the JSON leaderboard.
    const top = parseSheet(sheet(6));
    const board = json.leaderboards.find((l) => l.kind === 'chatters')!;
    expect(top.slice(1).map((r) => r[4])).toEqual(board.rows.map((r) => r.id));
  });

  it('CSV export: a zip of the same tables, with formula-like names defused', () => {
    const rig = recorded();
    const tw = rig.repos.destinations.list().find((x) => x.platform === 'twitch')!.id;
    rig.startSession('s3');
    rig.dest(tw, 'live');
    rig.chat('twitch', tw, { name: '=HYPERLINK("x")', id: '99' });
    rig.stopSession();
    const bundle = collect(rig.reports.context(), { sessionId: 's3' }, 'UTC')!;
    const files = unzip(renderExport(bundle, 'csv', 'r').body);
    expect([...files.keys()][0]).toBe('01-summary.csv');
    const audience = files.get('07-audience.csv')!.toString('utf8');
    expect(audience).toContain(`"'=HYPERLINK(""x"")"`);
    expect(toCsv(tables(bundle)[0]!).split('\r\n')[0]).toContain('Stream started (UTC)');
  });

  it('time zones: wall-clock times for the reader', () => {
    const t = Date.parse('2026-07-01T12:00:00.000Z');
    expect(new Date(wallClock(t, 'America/New_York')).toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(wallClock(t, 'UTC')).toBe(t);
  });
});

describe('SR check 0.2.50: live path, privacy, scale', () => {
  it('chat costs no database write in the emitter: people and counts are written with the tick', () => {
    const rig = createRig();
    const { tw } = liveStream(rig);
    const calls: string[] = [];
    const store = rig.reports.store as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const k of ['addAudience', 'audienceActivity', 'addChatMinute', 'addChatTotals', 'addEvent', 'addViewerSample', 'markAudience']) {
      const orig = store[k]!.bind(store);
      store[k] = (...a: unknown[]) => {
        calls.push(k);
        return orig(...a);
      };
    }
    // Straight on the bus (the rig's helper would write right away).
    for (let i = 0; i < 500; i++) {
      rig.bus.emit('chat', { id: `b${i}`, platform: 'twitch', destinationId: tw, profileId: 'default', author: { name: `Viewer ${i % 50}`, id: String(i % 50) }, text: 'x', ts: '', kind: 'message' });
    }
    rig.bus.emit('destination', { destinationId: tw, profileId: 'default', phase: 'live', message: null, stats: null, watchUrl: null, retries: 0, since: '', recoveries: 0, lastRecovery: null, viewers: 99 });
    expect(calls).toEqual([]);
    rig.reports.recorder.tick();
    // One batch: the 50 people in one addAudience call, the chat minute and totals once.
    expect(calls.filter((c) => c === 'addAudience')).toHaveLength(1);
    expect(calls.filter((c) => c === 'addChatMinute')).toHaveLength(1);
    expect(calls).not.toContain('audienceActivity');
    expect(rig.reports.store.audienceStreams(['s1']).filter((r) => r.platform === 'twitch')).toHaveLength(50);
    expect(rig.reports.store.chatTotals(['s1']).find((t) => t.platform === 'twitch')).toMatchObject({ messages: 500, uniqueChatters: 50 });
    expect(rig.reports.store.viewerSamples(['s1']).some((x) => x.destinationId === tw && x.viewers === 99)).toBe(true);
  });

  it('queued writes land after the event-loop turn without a tick', async () => {
    const rig = createRig();
    const tw = rig.destination('twitch');
    rig.bus.emit('session', { profileId: 'default', status: 'live', sessionId: 'q1', startedAt: iso(rig.clock.now), title: 'Queued', autoGoLive: true, feeds: [], destinations: [] });
    rig.bus.emit('destination', { destinationId: tw, profileId: 'default', phase: 'live', message: null, stats: null, watchUrl: null, retries: 0, since: '', recoveries: 0, lastRecovery: null, viewers: 5 });
    expect(rig.db.prepare("SELECT COUNT(*) AS c FROM report_sessions WHERE id = 'q1'").get()).toEqual({ c: 0 });
    await new Promise((r) => setImmediate(r));
    expect(rig.reports.store.getSession('q1')).not.toBeNull();
    expect(rig.reports.store.viewerSamples(['q1']).map((x) => x.viewers)).toEqual([5]);
  });

  it('a failing write is skipped; the rest of the batch is kept and streaming is not affected', () => {
    const rig = createRig();
    const { tw } = liveStream(rig);
    const store = rig.reports.store as unknown as Record<string, (...a: unknown[]) => unknown>;
    store.addEvent = () => {
      throw new Error('disk full');
    };
    rig.dest(tw, 'error', { message: 'boom' });
    rig.dest(tw, 'live', { viewers: 3 });
    expect(rig.reports.store.viewerSamples(['s1']).some((x) => x.destinationId === tw && x.viewers === 3)).toBe(true);
  });

  it('Instagram "<name> and N others joined" from the chat normaliser: the named user is a join, N are anonymous joins', () => {
    const rig = createRig();
    rig.startSession('ig1');
    const ig = rig.destination('instagram', { feed: 'vertical' });
    rig.dest(ig, 'live', { viewers: 40 });
    const line = normalizeChatMessage({ author: { name: 'fan_two' }, text: 'fan_two and 12 others joined', kind: 'event', join: true, othersCount: 12 }, 'instagram', ig);
    expect(line).toMatchObject({ join: true, othersCount: 12 });
    rig.bus.emit('chat', { ...line!, profileId: 'default' });
    rig.chat('instagram', ig, { name: 'fan_three' }, { kind: 'event', join: true, text: 'fan_three joined' });
    rig.stopSession();
    const totals = rig.reports.store.chatTotals(['ig1'])[0]!;
    expect(totals).toMatchObject({ platform: 'instagram', joins: 2, anonymousJoins: 12, messages: 0 });
    expect(rig.reports.store.audienceStreams(['ig1']).map((r) => [r.userId, r.joins])).toEqual(
      expect.arrayContaining([
        ['instagram:name:fan_two', 1],
        ['instagram:name:fan_three', 1],
      ]),
    );
    const d = sessionDetail(rig.reports.context(), 'ig1')!;
    expect(d.stats.find((x) => x.platform === 'instagram')).toMatchObject({ joins: 2, anonymousJoins: 12 });
    const bundle = collect(rig.reports.context(), { sessionId: 'ig1' }, 'UTC')!;
    expect(bundle.anonymousJoins).toEqual([{ sessionId: 'ig1', platform: 'instagram', count: 12 }]);
  });

  it('forget this user: the name is gone from app.db and its write-ahead log on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctd-reports-'));
    dirs.push(dir);
    const file = path.join(dir, 'app.db');
    const rig = createRig({ db: openDatabase(file) });
    const { tw } = liveStream(rig);
    const name = 'ZqxForgetMeViewer';
    for (let i = 0; i < 3; i++) rig.chat('twitch', tw, { name, id: '777' });
    rig.chat('twitch', tw, { name: 'Viewer Kept', id: '778' });
    rig.reports.recorder.tick();
    rig.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); // the name is in app.db itself now
    const onDisk = () => [file, `${file}-wal`].filter((f) => fs.existsSync(f)).some((f) => fs.readFileSync(f).includes(name));
    expect(onDisk()).toBe(true);
    expect(rig.reports.forgetUser('twitch:777')).toBe(true);
    expect(onDisk()).toBe(false);
    expect(rig.reports.store.user('twitch:778')).not.toBeNull();
  });

  it('forget this user during a live: what the recorder holds about them is not written back', async () => {
    let users = [{ id: '777', login: 'forget_me', name: 'Forget Me' }];
    const rig = createRig({ presence: async () => ({ ok: true, users }) });
    const tw = rig.destination('twitch');
    rig.startSession('f1');
    rig.dest(tw, 'live');
    await rig.reports.recorder.presenceTick();
    rig.chat('twitch', tw, { name: 'Forget Me', id: '777' }); // in memory, not written yet
    expect(rig.reports.forgetUser('twitch:777')).toBe(true);
    rig.reports.recorder.tick();
    expect(rig.reports.store.user('twitch:777')).toBeNull();
    // Still in the chatters list at the next sample: a new first sample, no watch time from before.
    rig.clock.advance(PRESENCE_SAMPLE_MS);
    await rig.reports.recorder.presenceTick();
    expect(rig.reports.store.audienceStreams(['f1']).find((r) => r.userId === 'twitch:777')).toMatchObject({ watchSec: 0, presenceSamples: 1, messages: 0 });
    users = [];
  });

  it('audience tracking turned off during a live: nothing more is written about people', () => {
    const rig = createRig();
    const { tw } = liveStream(rig);
    rig.chat('twitch', tw, { name: 'Viewer A', id: '11' }); // added up, not yet written
    rig.reports.saveSettings({ recording: true, audience: false, retentionDays: 0 });
    rig.chat('twitch', tw, { name: 'Viewer B', id: '12' });
    rig.reports.recorder.tick();
    rig.stopSession();
    expect(rig.db.prepare('SELECT COUNT(*) AS c FROM audience_users').get()).toEqual({ c: 0 });
    expect(rig.db.prepare('SELECT COUNT(*) AS c FROM audience_stream').get()).toEqual({ c: 0 });
    expect(rig.reports.store.chatTotals(['s1']).find((t) => t.platform === 'twitch')).toMatchObject({ messages: 2 });
  });

  it('event details never keep a stream key or an ingest URL path', () => {
    const rig = createRig();
    const { tw } = liveStream(rig);
    rig.dest(tw, 'error', { message: 'Error opening output rtmp://live.example.com/app/live_123456_SECRETKEY?bandwidthtest=true' });
    rig.dest(tw, 'retrying', { message: 'publish failed key=SECRETKEY2 (retrying in 5 s)' });
    const details = rig.reports.store.events(['s1']).map((e) => e.detail ?? '').join('\n');
    expect(details).toContain('rtmp://live.example.com');
    expect(details).not.toContain('SECRETKEY');
  });

  it('a name cut in the middle of an emoji still gives valid XML in the .xlsx', () => {
    const rig = createRig();
    const { tw } = liveStream(rig);
    const name = `${'a'.repeat(199)}😀`; // the 200-character cut falls inside the emoji
    rig.chat('twitch', tw, { name, id: '55' });
    rig.dest(tw, 'error', { message: `${'b'.repeat(299)}😀 tail` });
    rig.stopSession();
    const user = rig.reports.store.user('twitch:55')!;
    expect(user.displayName).toBe('a'.repeat(199));
    const files = unzip(renderExport(collect(rig.reports.context(), { sessionId: 's1' }, 'UTC')!, 'xlsx', 'r').body);
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    for (const [n, data] of files) if (n.endsWith('.xml')) expect(lone.test(data.toString('utf8')), n).toBe(false);
  });

  it('defaults: recording and audience tracking on, reports kept for 365 days; "keep everything" only when chosen', () => {
    expect(DEFAULT_REPORT_SETTINGS).toEqual({ recording: true, audience: true, retentionDays: 365 });
    expect(reportSettingsFrom(null)).toEqual(DEFAULT_REPORT_SETTINGS);
    expect(reportSettingsFrom({ recording: true, audience: true })).toMatchObject({ retentionDays: 365 });
    expect(reportSettingsFrom({ retentionDays: 30 })).toMatchObject({ retentionDays: 365 });
    expect(reportSettingsFrom({ retentionDays: 0 })).toMatchObject({ retentionDays: 0 });
    expect(reportSettingsFrom({ retentionDays: 90 })).toMatchObject({ retentionDays: 90 });
  });

  it('with nothing saved, a stream older than 365 days is deleted; with "keep everything" it stays', () => {
    const rig = createRig();
    const tw = rig.destination('twitch');
    rig.startSession('old');
    rig.dest(tw, 'live', { viewers: 3 });
    rig.clock.advance(MIN);
    rig.stopSession();
    rig.clock.advance(366 * 86_400_000);
    rig.reports.recorder.retention(); // what start-up and the 6-hourly check do
    expect(rig.reports.store.getSession('old')).toBeNull();

    const keep = createRig();
    keep.reports.saveSettings({ recording: true, audience: true, retentionDays: 0 });
    const tw2 = keep.destination('twitch');
    keep.startSession('kept');
    keep.dest(tw2, 'live', { viewers: 3 });
    keep.stopSession();
    keep.clock.advance(3 * 365 * 86_400_000);
    keep.reports.recorder.retention();
    expect(keep.reports.store.getSession('kept')).not.toBeNull();
  });

  it('retention deletes in small transactions and finishes', () => {
    const rig = createRig();
    const tw = rig.destination('twitch');
    for (let i = 0; i < 45; i++) {
      rig.startSession(`old${i}`);
      rig.dest(tw, 'live', { viewers: i });
      rig.chat('twitch', tw, { name: `Viewer ${i}`, id: String(i) });
      rig.clock.advance(MIN);
      rig.stopSession();
    }
    const r1 = rig.reports.store.purgeBefore(iso(rig.clock.now + 1), 20);
    expect(r1).toEqual({ sessions: 20, users: 0, done: false });
    rig.clock.advance(400 * 86_400_000);
    rig.reports.saveSettings({ recording: true, audience: true, retentionDays: 365 });
    expect(rig.db.prepare('SELECT COUNT(*) AS c FROM report_sessions').get()).toEqual({ c: 0 });
    expect(rig.db.prepare('SELECT COUNT(*) AS c FROM audience_users').get()).toEqual({ c: 0 });
  });

  it('lists keep the numbers of ended streams, and forgetting someone updates them', () => {
    const rig = createRig();
    const { tw } = liveStream(rig);
    rig.chat('twitch', tw, { name: 'Viewer A', id: '11' });
    rig.chat('twitch', tw, { name: 'Viewer B', id: '12' });
    rig.clock.advance(MIN);
    rig.reports.recorder.tick();
    rig.stopSession();
    const first = listSessions(rig.reports.context(), {});
    const detail = sessionDetail(rig.reports.context(), 's1')!;
    expect(listSessions(rig.reports.context(), {})).toEqual(first);
    expect(first[0]).toMatchObject({ peakViewers: detail.peakViewers, viewerMinutes: detail.viewerMinutes, chatMessages: 2 });
    expect(rangeSummary(rig.reports.context(), {}).stats).toEqual(rangeSummary(rig.reports.context(), {}).stats);
    rig.reports.forgetUser('twitch:11');
    const lb = leaderboard(rig.reports.context(), { sessionIds: ['s1'] }, 'chatters', null);
    expect(lb.rows.map((r) => r.id)).toEqual(['twitch:12']);
  });
});

/** Minimal reader for our own sheet XML: rows of cell values (inline strings or numbers). */
function parseSheet(xml: string): (string | undefined)[][] {
  const out: (string | undefined)[][] = [];
  for (const row of xml.matchAll(/<row r="(\d+)">(.*?)<\/row>/g)) {
    const cells: (string | undefined)[] = [];
    for (const c of row[2]!.matchAll(/<c r="([A-Z]+)\d+"[^>]*>(?:<is><t[^>]*>(.*?)<\/t><\/is>|<v>(.*?)<\/v>)<\/c>/g)) {
      const colIdx = [...c[1]!].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      cells[colIdx] = (c[2] ?? c[3])!.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }
    out.push(cells);
  }
  return out;
}
