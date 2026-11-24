import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLEAN_STOP_WINDOW_MS, ISSUE_HOLDS, IssueTracker, MAX_OBS_ISSUES_PER_APP, outputFeed, type IssueSource } from './issues.js';
import type { ApiDestination, ApiIssueCleared, ApiIssueRaised } from './types.js';

const T0 = Date.parse('2026-11-18T20:00:00.000Z');
const P = 'default';
const APP = 'ctd-obs-plugin-studio';

type Sent =
  | { type: 'raised'; profile: string; src: IssueSource; data: ApiIssueRaised }
  | { type: 'cleared'; profile: string; src: IssueSource; data: ApiIssueCleared };

let sent: Sent[];
let forgotten: string[];
let tracker: IssueTracker;

function destination(id: string, over: Partial<ApiDestination> = {}): ApiDestination {
  return {
    id,
    name: id.toUpperCase(),
    platform: 'twitch',
    feed: 'landscape',
    enabled: true,
    phase: 'live',
    live: true,
    down: false,
    waitingFor: [],
    message: null,
    stats: null,
    viewers: null,
    watchUrl: null,
    recoveries: 0,
    lastRecovery: null,
    since: '2026-11-18T20:00:00.000Z',
    blocked: null,
    ...over,
  };
}
const down = (id: string, over: Partial<ApiDestination> = {}) => destination(id, { phase: 'retrying', live: false, down: true, message: 'Connection lost', ...over });

/** `raised:<id>` / `updated:<id>` / `cleared:<id>:<resolution>`, in order. */
const log = () => sent.map((s) => (s.type === 'raised' ? `${s.data.update ? 'updated' : 'raised'}:${s.data.id}` : `cleared:${s.data.id}:${s.data.resolution}`));
const raisedOf = (id: string) => sent.filter((s): s is Extract<Sent, { type: 'raised' }> => s.type === 'raised' && s.data.id === id).at(-1)!.data;

/** A live session with both feeds online. */
function goLive(): void {
  tracker.feed(P, 'landscape', true);
  tracker.feed(P, 'vertical', true);
  tracker.session(P, true);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  sent = [];
  forgotten = [];
  tracker = new IssueTracker({
    now: Date.now,
    raised: (profile, src, data) => sent.push({ type: 'raised', profile, src, data }),
    cleared: (profile, src, data) => sent.push({ type: 'cleared', profile, src, data }),
    run: (fn) => fn(),
    obsAppForgotten: (profile, appId, resolution) => forgotten.push(`${profile}:${appId}:${resolution}`),
  });
});

afterEach(() => {
  tracker.close();
  vi.useRealTimers();
});

describe('feed.offline', () => {
  it('is raised after the hold when a live feed goes offline, and cleared when it returns', () => {
    goLive();
    tracker.feed(P, 'vertical', false);
    vi.advanceTimersByTime(ISSUE_HOLDS.feed - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(log()).toEqual(['raised:feed.offline|vertical']);
    expect(sent[0]).toMatchObject({ profile: P, src: { connection: 'core', platform: 'core' } });
    expect(raisedOf('feed.offline|vertical')).toEqual({
      id: 'feed.offline|vertical',
      kind: 'feed.offline',
      rule: null,
      severity: 'critical',
      title: 'Vertical feed lost',
      message: 'OBS stopped sending the vertical feed; the landscape feed is still live.',
      subject: { type: 'feed', feed: 'vertical' },
      onProgram: null,
      scene: null,
      firstSeen: T0 + ISSUE_HOLDS.feed,
      updatedAt: T0 + ISSUE_HOLDS.feed,
      update: false,
    });
    expect(tracker.list(P).map((i) => i.id)).toEqual(['feed.offline|vertical']);

    vi.advanceTimersByTime(4000);
    tracker.feed(P, 'vertical', true);
    expect(log()).toEqual(['raised:feed.offline|vertical', 'cleared:feed.offline|vertical:recovered']);
    expect(sent[1]!.data).toMatchObject({ kind: 'feed.offline', durationMs: 4000, title: 'Vertical feed lost', subject: { type: 'feed', feed: 'vertical' } });
    expect(tracker.list(P)).toEqual([]);
  });

  it('a blip shorter than the hold is no alert', () => {
    goLive();
    tracker.feed(P, 'landscape', false);
    vi.advanceTimersByTime(ISSUE_HOLDS.feed - 500);
    tracker.feed(P, 'landscape', true);
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([]);
  });

  it('is not raised outside a running session, nor for a feed that never was online', () => {
    tracker.feed(P, 'landscape', true);
    tracker.feed(P, 'landscape', false); // session offline
    tracker.session(P, true);
    tracker.feed(P, 'vertical', false); // never online
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([]);
  });

  it('without a CTD OBS app watching, OBS going quiet is a warning; the session ending clears it as ended', () => {
    goLive();
    tracker.feed(P, 'landscape', false);
    tracker.feed(P, 'vertical', false);
    vi.advanceTimersByTime(ISSUE_HOLDS.feed);
    expect(log()).toEqual(['raised:feed.offline|landscape', 'raised:feed.offline|vertical']);
    expect(raisedOf('feed.offline|landscape').severity).toBe('warning');
    tracker.session(P, false);
    expect(log().slice(2)).toEqual(['cleared:feed.offline|landscape:ended', 'cleared:feed.offline|vertical:ended']);
  });

  it('with the plugin watching and no clean stop, it is critical (OBS crashed or lost its network)', () => {
    goLive();
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', canvas: 'landscape', state: 'live' });
    tracker.feed(P, 'landscape', false);
    tracker.feed(P, 'vertical', false);
    vi.advanceTimersByTime(ISSUE_HOLDS.feed);
    expect(raisedOf('feed.offline|landscape')).toMatchObject({ severity: 'critical', message: expect.stringContaining('without stopping its stream') });
  });

  it('a plugin that has had nothing new to say for an hour is still watching, until it goes offline', () => {
    // Only changes reach the tracker (the OBS state store drops the 60 s resends): silence is not absence.
    tracker.obsEvent(P, APP, 'obs.scene', { canvas: 'landscape', scene: 'Main' });
    tracker.apps([{ id: APP, online: true }]);
    vi.advanceTimersByTime(3600_000);
    goLive();
    tracker.feed(P, 'landscape', false);
    tracker.feed(P, 'vertical', false);
    vi.advanceTimersByTime(ISSUE_HOLDS.feed);
    expect(raisedOf('feed.offline|landscape').severity).toBe('critical');
    // The same loss with the app offline: nobody there to say why, a warning.
    tracker.session(P, false);
    tracker.apps([{ id: APP, online: false }]);
    sent = [];
    goLive();
    tracker.feed(P, 'landscape', false);
    tracker.feed(P, 'vertical', false);
    vi.advanceTimersByTime(ISSUE_HOLDS.feed);
    expect(raisedOf('feed.offline|landscape').severity).toBe('warning');
  });

  it('OBS stopping its stream on purpose is no alert (clean stop before or during the hold)', () => {
    goLive();
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', canvas: 'landscape', state: 'live' });
    tracker.feed(P, 'landscape', false);
    tracker.feed(P, 'vertical', false);
    tracker.obsEvent(P, APP, 'obs.output', { output: 'Vertical Stream', canvas: 'vertical', state: 'live' });
    vi.advanceTimersByTime(1500);
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', canvas: 'landscape', state: 'stopped' });
    tracker.obsEvent(P, APP, 'obs.output', { output: 'Vertical Stream', canvas: 'vertical', state: 'stopped' });
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([]);
    expect(CLEAN_STOP_WINDOW_MS).toBeGreaterThan(ISSUE_HOLDS.feed);
  });

  it('a clean stop reported a little late ends the alert', () => {
    goLive();
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', state: 'live' });
    tracker.feed(P, 'landscape', false);
    vi.advanceTimersByTime(ISSUE_HOLDS.feed);
    expect(log()).toEqual(['raised:feed.offline|landscape']);
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', state: 'stopped' });
    expect(log()).toEqual(['raised:feed.offline|landscape', 'cleared:feed.offline|landscape:ended']);
  });

  it('only a live output stopping without an error, around the loss, is a stop on purpose', () => {
    // A stop with an error is a failure.
    goLive();
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', state: 'live' });
    tracker.feed(P, 'landscape', false);
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', state: 'stopped', error: 'Disconnected' });
    vi.advanceTimersByTime(ISSUE_HOLDS.feed);
    expect(log()).toEqual(['raised:feed.offline|landscape']);
    // OBS crashed and was started again: its idle output reports "stopped", but it never was live for this app
    // run, and a second OBS machine's idle output is not this stream either. The crash alert stays.
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', state: 'stopped' });
    tracker.obsEvent(P, 'ctd-obs-plugin-backup', 'obs.output', { output: 'main', state: 'stopped' });
    expect(log()).toEqual(['raised:feed.offline|landscape']);
    // Ten minutes after the loss, even a real live → stopped is about something else (a later attempt).
    vi.advanceTimersByTime(10 * 60_000);
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', state: 'live' });
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', state: 'stopped' });
    expect(log()).toEqual(['raised:feed.offline|landscape']);
    tracker.session(P, false);
    expect(log().at(-1)).toBe('cleared:feed.offline|landscape:ended');
  });

  it('says OBS is reconnecting when the plugin reports it, and updates the open issue', () => {
    goLive();
    tracker.feed(P, 'landscape', false);
    tracker.feed(P, 'vertical', false);
    vi.advanceTimersByTime(ISSUE_HOLDS.feed);
    expect(raisedOf('feed.offline|landscape').severity).toBe('warning');
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', canvas: 'landscape', state: 'reconnecting', error: 'Connection timed out' });
    const updated = raisedOf('feed.offline|landscape');
    expect(updated).toMatchObject({ update: true, severity: 'critical', message: 'OBS is reconnecting to Relay: Connection timed out', firstSeen: T0 + ISSUE_HOLDS.feed });
    // The feed issue tells it: no second alert for the output itself.
    vi.advanceTimersByTime(ISSUE_HOLDS.output);
    expect(log().filter((l) => l.includes('obs.output.down'))).toEqual([]);
  });

  it('the other feed dropping too rewrites the first one\'s message', () => {
    goLive();
    tracker.obsEvent(P, APP, 'obs.scene', { canvas: 'landscape', scene: 'Main' });
    tracker.feed(P, 'vertical', false);
    vi.advanceTimersByTime(ISSUE_HOLDS.feed);
    tracker.feed(P, 'landscape', false);
    expect(log()).toEqual(['raised:feed.offline|vertical', 'updated:feed.offline|vertical']);
    expect(raisedOf('feed.offline|vertical').message).toContain('without stopping its stream');
  });
});

describe('destination.down and stream.down', () => {
  it('raises a held-down destination as a warning, critical once Relay gave up, and clears it on recovery', () => {
    goLive();
    tracker.destination(P, destination('t1'));
    tracker.destination(P, destination('y1', { platform: 'youtube', name: 'YouTube' }));
    tracker.destination(P, down('y1', { platform: 'youtube', name: 'YouTube' }));
    vi.advanceTimersByTime(ISSUE_HOLDS.destination);
    expect(log()).toEqual(['raised:destination.down|y1']);
    expect(sent[0]).toMatchObject({ src: { connection: 'y1', platform: 'youtube' } });
    expect(raisedOf('destination.down|y1')).toMatchObject({
      kind: 'destination.down',
      severity: 'warning',
      title: 'YouTube is down',
      message: 'Connection lost',
      subject: { type: 'destination', destinationId: 'y1', platform: 'youtube', name: 'YouTube' },
    });
    tracker.destination(P, down('y1', { platform: 'youtube', name: 'YouTube', phase: 'error', message: 'Stream key rejected' }));
    expect(raisedOf('destination.down|y1')).toMatchObject({ update: true, severity: 'critical', message: 'Stream key rejected' });
    tracker.destination(P, down('y1', { platform: 'youtube', name: 'YouTube', phase: 'error', message: 'Stream key rejected' })); // same again
    expect(sent).toHaveLength(2);
    tracker.destination(P, destination('y1', { platform: 'youtube', name: 'YouTube' }));
    expect(log().at(-1)).toBe('cleared:destination.down|y1:recovered');
  });

  it('a retry that is live again within the hold is no alert', () => {
    goLive();
    tracker.destination(P, down('t1'));
    vi.advanceTimersByTime(ISSUE_HOLDS.destination - 1);
    tracker.destination(P, destination('t1'));
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([]);
  });

  it('every counted destination down is one critical stream.down on top; one back up clears it', () => {
    goLive();
    tracker.destination(P, destination('t1'));
    tracker.destination(P, destination('y1'));
    tracker.destination(P, destination('k1', { enabled: true, phase: 'disabled' })); // skipped by test mode: not counted
    tracker.destination(P, down('t1'));
    tracker.destination(P, down('y1'));
    vi.advanceTimersByTime(ISSUE_HOLDS.stream);
    expect(log()).toEqual(['raised:destination.down|t1', 'raised:destination.down|y1', 'raised:stream.down']);
    expect(raisedOf('stream.down')).toMatchObject({ severity: 'critical', subject: { type: 'stream' }, message: 'None of the 2 destinations is reaching its platform.' });
    tracker.destination(P, destination('t1'));
    expect(log().slice(3)).toEqual(['cleared:destination.down|t1:recovered', 'cleared:stream.down:recovered']);
  });

  it('the session stopping ends them (ended), a deleted destination removes its own', () => {
    goLive();
    tracker.destination(P, down('t1'));
    tracker.destination(P, destination('y1'));
    vi.advanceTimersByTime(ISSUE_HOLDS.destination);
    tracker.destinationRemoved(P, 't1');
    expect(log()).toEqual(['raised:destination.down|t1', 'cleared:destination.down|t1:removed']);
    tracker.destination(P, down('y1'));
    vi.advanceTimersByTime(ISSUE_HOLDS.stream);
    tracker.session(P, false);
    expect(log().slice(2)).toEqual(['raised:destination.down|y1', 'raised:stream.down', 'cleared:destination.down|y1:ended', 'cleared:stream.down:ended']);
    // The hub then refreshes the destinations of the stopped session: nothing more to say.
    tracker.destination(P, destination('y1', { phase: 'idle', live: false }));
    expect(sent).toHaveLength(6);
  });

  it('destinations only waiting for a lost feed add nothing to its feed.offline', () => {
    goLive();
    tracker.destination(P, destination('t1'));
    tracker.destination(P, destination('i1', { feed: 'vertical' }));
    tracker.feed(P, 'landscape', false);
    tracker.feed(P, 'vertical', false);
    tracker.destination(P, down('t1', { phase: 'waiting-for-feed', waitingFor: ['landscape'], message: 'Waiting for landscape feed' }));
    tracker.destination(P, down('i1', { feed: 'vertical', phase: 'waiting-for-feed', waitingFor: ['vertical'], message: 'Waiting for vertical feed' }));
    vi.advanceTimersByTime(60_000);
    expect(log()).toEqual(['raised:feed.offline|landscape', 'raised:feed.offline|vertical']);
  });

  it('OBS stopped on purpose: no alert at all while the session waits out its grace period', () => {
    goLive();
    tracker.destination(P, destination('t1'));
    tracker.destination(P, destination('i1', { feed: 'vertical' }));
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', canvas: 'landscape', state: 'live' });
    tracker.obsEvent(P, APP, 'obs.output', { output: 'Vertical Stream', canvas: 'vertical', state: 'live' });
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', canvas: 'landscape', state: 'stopped' });
    tracker.obsEvent(P, APP, 'obs.output', { output: 'Vertical Stream', canvas: 'vertical', state: 'stopped' });
    tracker.feed(P, 'landscape', false);
    tracker.feed(P, 'vertical', false);
    tracker.destination(P, down('t1', { phase: 'waiting-for-feed', waitingFor: ['landscape'], message: 'Waiting for landscape feed' }));
    tracker.destination(P, down('i1', { feed: 'vertical', phase: 'waiting-for-feed', waitingFor: ['vertical'], message: 'Waiting for vertical feed' }));
    vi.advanceTimersByTime(60_000);
    tracker.session(P, false);
    expect(sent).toEqual([]);
  });

  it('a clean stop says nothing about the next stream: its loss alerts again', () => {
    goLive();
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', canvas: 'landscape', state: 'live' });
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', canvas: 'landscape', state: 'stopped' });
    tracker.feed(P, 'landscape', false);
    vi.advanceTimersByTime(2000);
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', canvas: 'landscape', state: 'live' });
    tracker.feed(P, 'landscape', true); // streaming again, 2 s after the stop
    vi.advanceTimersByTime(1000);
    tracker.feed(P, 'landscape', false); // and lost for real, still inside the clean-stop window
    vi.advanceTimersByTime(ISSUE_HOLDS.feed);
    expect(log()).toEqual(['raised:feed.offline|landscape']);
  });

  it('a destination waiting for a feed that never came is its own alert', () => {
    tracker.feed(P, 'landscape', true);
    tracker.session(P, true);
    tracker.destination(P, destination('t1'));
    tracker.destination(P, down('i1', { feed: 'vertical', phase: 'waiting-for-feed', waitingFor: ['vertical'], message: 'Waiting for vertical feed' }));
    // The vertical output a few seconds behind the main one is a show starting, not a problem…
    vi.advanceTimersByTime(ISSUE_HOLDS.waiting - 1);
    expect(sent).toEqual([]);
    // …but one that never comes is worth saying.
    vi.advanceTimersByTime(1);
    expect(log()).toEqual(['raised:destination.down|i1']);
    expect(raisedOf('destination.down|i1')).toMatchObject({ severity: 'warning', message: 'Waiting for vertical feed' });
    expect(ISSUE_HOLDS.waiting).toBeGreaterThan(ISSUE_HOLDS.destination);
  });

  it('a session started by hand before OBS sends anything is not "down on every platform"', () => {
    tracker.session(P, true);
    tracker.destination(P, down('t1', { phase: 'waiting-for-feed', waitingFor: ['landscape'], message: 'Waiting for landscape feed' }));
    tracker.destination(P, down('i1', { feed: 'vertical', phase: 'waiting-for-feed', waitingFor: ['vertical'], message: 'Waiting for vertical feed' }));
    vi.advanceTimersByTime(ISSUE_HOLDS.stream + ISSUE_HOLDS.destination);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(ISSUE_HOLDS.waiting);
    expect(log()).toEqual(['raised:destination.down|t1', 'raised:destination.down|i1']); // no stream.down
    // The feeds arrive, then every platform fails: now it is.
    sent = [];
    tracker.feed(P, 'landscape', true);
    tracker.destination(P, down('t1', { phase: 'error', message: 'Stream key rejected' }));
    tracker.destination(P, down('i1', { feed: 'vertical', phase: 'retrying' }));
    vi.advanceTimersByTime(ISSUE_HOLDS.stream);
    expect(log()).toContain('raised:stream.down');
  });
});

describe('OBS issues', () => {
  const issue = { id: 'camera-offline|Club cam', rule: 'camera-offline', severity: 'critical', source: 'Club cam', path: 'live/club', title: 'Camera offline', cause: 'No publisher on live/club', firstSeen: T0 - 2000 };

  it('turns obs.issue.raised / cleared into an obs.issue with the plugin\'s severity, source and program flag', () => {
    tracker.obsEvent(P, APP, 'obs.issue.raised', { ...issue, onProgram: true, scene: 'Club' });
    expect(log()).toEqual([`raised:obs.issue|${APP}|camera-offline|Club cam`]);
    expect(sent[0]).toMatchObject({ src: { connection: APP, platform: 'obs' } });
    expect(sent[0]!.data).toEqual({
      id: `obs.issue|${APP}|camera-offline|Club cam`,
      kind: 'obs.issue',
      rule: 'camera-offline',
      severity: 'critical',
      title: 'Camera offline',
      message: 'No publisher on live/club',
      subject: { type: 'obs.source', appId: APP, source: 'Club cam', path: 'live/club' },
      onProgram: true,
      scene: 'Club',
      firstSeen: T0 - 2000,
      updatedAt: T0,
      update: false,
    });
    // A failover took it off program: the plugin resends the issue, Relay sends an update.
    vi.advanceTimersByTime(1000);
    tracker.obsEvent(P, APP, 'obs.issue.raised', { ...issue, onProgram: false });
    expect(raisedOf(`obs.issue|${APP}|camera-offline|Club cam`)).toMatchObject({ update: true, onProgram: false, scene: null, firstSeen: T0 - 2000, updatedAt: T0 + 1000 });
    tracker.obsEvent(P, APP, 'obs.issue.cleared', { id: issue.id });
    expect(log().at(-1)).toBe(`cleared:obs.issue|${APP}|camera-offline|Club cam:recovered`);
    tracker.obsEvent(P, APP, 'obs.issue.cleared', { id: issue.id }); // not open: nothing
    expect(sent).toHaveLength(3);
  });

  it('copes with a sparse issue: unknown severity is a warning, the rule comes from the id', () => {
    tracker.obsEvent(P, APP, 'obs.issue.raised', { id: 'upstream-loss|live/club', severity: 'loud', firstSeen: 12 });
    expect(sent[0]!.data).toMatchObject({ rule: 'upstream-loss', severity: 'warning', title: 'upstream-loss: live/club', message: null, onProgram: null, firstSeen: T0 });
    // An issue that was already open for an hour (Relay restarted since) keeps its start time.
    tracker.obsEvent(P, APP, 'obs.issue.raised', { id: 'av-drift|Cam', severity: 'warning', title: 'A/V drift', firstSeen: T0 - 3600_000 });
    expect(sent[1]!.data).toMatchObject({ firstSeen: T0 - 3600_000, updatedAt: T0 });
  });

  it('an app going offline clears its issues as stale; its own next report raises what is still wrong', () => {
    tracker.obsEvent(P, APP, 'obs.issue.raised', issue);
    tracker.apps([{ id: APP, online: true }]);
    expect(sent).toHaveLength(1);
    tracker.apps([{ id: APP, online: false }]);
    expect(log().at(-1)).toBe(`cleared:obs.issue|${APP}|camera-offline|Club cam:stale`);
    // The hub is told, so the OBS state store forgets what the app reported (its next report is a change again).
    expect(forgotten).toEqual([`${P}:${APP}:stale`]);
    // Back online: nothing is revived from memory (yesterday's "camera offline" must not come back by itself)…
    tracker.apps([{ id: APP, online: true }]);
    tracker.obsEvent(P, APP, 'obs.scene', { canvas: 'landscape', scene: 'Main' });
    expect(sent).toHaveLength(2);
    // …the plugin says so if it is still wrong.
    tracker.obsEvent(P, APP, 'obs.issue.raised', issue);
    expect(sent.at(-1)).toMatchObject({ type: 'raised', data: { update: false } });
    tracker.apps([]);
    expect(log().at(-1)).toBe(`cleared:obs.issue|${APP}|camera-offline|Club cam:removed`);
    expect(forgotten.at(-1)).toBe(`${P}:${APP}:removed`);
  });

  it('caps the open issues of one app', () => {
    for (let i = 0; i < MAX_OBS_ISSUES_PER_APP + 50; i++) tracker.obsEvent(P, APP, 'obs.issue.raised', { id: `frozen-picture|Cam ${i}`, severity: 'warning', title: `Frozen picture on Cam ${i}` });
    expect(tracker.list(P)).toHaveLength(MAX_OBS_ISSUES_PER_APP);
    // The ones that are open still update and clear; another app has its own budget.
    tracker.obsEvent(P, APP, 'obs.issue.raised', { id: 'frozen-picture|Cam 0', severity: 'critical', title: 'Frozen picture on Cam 0' });
    expect(sent.at(-1)).toMatchObject({ type: 'raised', data: { update: true, severity: 'critical' } });
    tracker.obsEvent(P, 'ctd-obs-plugin-backup', 'obs.issue.raised', { id: 'av-drift|Cam', severity: 'warning', title: 'A/V drift' });
    expect(tracker.list(P)).toHaveLength(MAX_OBS_ISSUES_PER_APP + 1);
    tracker.obsEvent(P, APP, 'obs.issue.cleared', { id: 'frozen-picture|Cam 1' });
    tracker.obsEvent(P, APP, 'obs.issue.raised', { id: 'frozen-picture|Cam 140', severity: 'warning', title: 'Frozen picture on Cam 140' });
    expect(tracker.list(P)).toHaveLength(MAX_OBS_ISSUES_PER_APP + 1);
    // A long id is cut like the OBS state store cuts it, and a missing title can't run past the limit.
    tracker.obsEvent('club', APP, 'obs.issue.raised', { id: `upstream-loss|${'x'.repeat(400)}`, severity: 'warning' });
    const long = tracker.list('club')[0]!;
    expect(long.id.length).toBeLessThanOrEqual(`obs.issue|${APP}|`.length + 120);
    expect(long.title.length).toBeLessThanOrEqual(120);
  });

  it('obs.output.down: an output reconnecting for 3 s when no Relay feed tells it; live clears it', () => {
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', canvas: 'landscape', state: 'reconnecting', error: 'Connection reset' });
    vi.advanceTimersByTime(ISSUE_HOLDS.output);
    expect(log()).toEqual([`raised:obs.output.down|${APP}|main`]);
    expect(sent[0]!.data).toMatchObject({
      kind: 'obs.output.down',
      severity: 'warning',
      title: 'OBS landscape stream reconnecting',
      message: 'Connection reset',
      subject: { type: 'obs.output', appId: APP, output: 'main', canvas: 'landscape' },
    });
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', canvas: 'landscape', state: 'live' });
    expect(log().at(-1)).toBe(`cleared:obs.output.down|${APP}|main:recovered`);
    // A reconnect that makes it within the hold is no alert; a stop ends an open one.
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', state: 'reconnecting' });
    vi.advanceTimersByTime(ISSUE_HOLDS.output - 1);
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', state: 'live' });
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(2);
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', state: 'reconnecting' });
    vi.advanceTimersByTime(ISSUE_HOLDS.output);
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', state: 'stopped' });
    expect(log().slice(2)).toEqual([`raised:obs.output.down|${APP}|main`, `cleared:obs.output.down|${APP}|main:ended`]);
  });

  it('obs.output.down is folded into a lost feed\'s feed.offline, but raised for a feed that never came', () => {
    // SR check: a session running while OBS can't get its stream to Relay at all (the feed was never online)
    // raises no feed.offline, so the reconnecting output must not be swallowed by it.
    tracker.session(P, true);
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', canvas: 'landscape', state: 'reconnecting', error: 'Connection refused' });
    vi.advanceTimersByTime(ISSUE_HOLDS.output);
    expect(log()).toEqual([`raised:obs.output.down|${APP}|main`]);
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', canvas: 'landscape', state: 'live' });
    tracker.feed(P, 'landscape', true);
    expect(log().at(-1)).toBe(`cleared:obs.output.down|${APP}|main:recovered`);
    // Now the feed was live and goes away while OBS reconnects: one alert, feed.offline.
    tracker.feed(P, 'landscape', false);
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', canvas: 'landscape', state: 'reconnecting', error: 'Connection reset' });
    vi.advanceTimersByTime(ISSUE_HOLDS.feed);
    expect(log().slice(2)).toEqual(['raised:feed.offline|landscape']);
  });

  it('maps OBS outputs to Relay feeds, leaving recordings out', () => {
    expect(outputFeed({ output: 'main' })).toBe('landscape');
    expect(outputFeed({ output: 'Aitum Stream Suite Output Vertical Stream', canvas: 'vertical' })).toBe('vertical');
    expect(outputFeed({ output: 'record', canvas: 'landscape' })).toBeNull();
    expect(outputFeed({ output: 'Replay Buffer' })).toBeNull();
    expect(outputFeed({ output: 'custom' })).toBeNull();
    expect(outputFeed({})).toBeNull();
  });
});

describe('the open set', () => {
  it('lists open issues oldest first, per profile; a deleted profile takes its issues along', () => {
    goLive();
    tracker.obsEvent(P, APP, 'obs.issue.raised', { id: 'av-drift|Cam', rule: 'av-drift', severity: 'warning', source: 'Cam', title: 'A/V drift' });
    tracker.destination(P, destination('t1'));
    tracker.destination(P, down('y1'));
    vi.advanceTimersByTime(ISSUE_HOLDS.destination);
    tracker.obsEvent('club', APP, 'obs.issue.raised', { id: 'camera-offline|Cam', severity: 'critical', title: 'Camera offline' });
    expect(tracker.list(P).map((i) => i.id)).toEqual([`obs.issue|${APP}|av-drift|Cam`, 'destination.down|y1']);
    expect(tracker.list('club').map((i) => i.id)).toEqual([`obs.issue|${APP}|camera-offline|Cam`]);
    expect(tracker.list('nobody')).toEqual([]);
    tracker.forgetProfile('club');
    expect(log().at(-1)).toBe(`cleared:obs.issue|${APP}|camera-offline|Cam:removed`);
    expect(tracker.list('club')).toEqual([]);
  });

  it('close() cancels pending holds', () => {
    goLive();
    tracker.feed(P, 'landscape', false);
    tracker.close();
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([]);
  });
});
