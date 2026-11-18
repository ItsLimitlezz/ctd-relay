import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLEAN_STOP_WINDOW_MS, ISSUE_HOLDS, IssueTracker, OBS_APP_RECENT_MS, outputFeed, type IssueSource } from './issues.js';
import type { ApiDestination, ApiIssueCleared, ApiIssueRaised } from './types.js';

const T0 = Date.parse('2026-11-18T20:00:00.000Z');
const P = 'default';
const APP = 'ctd-obs-plugin-studio';

type Sent =
  | { type: 'raised'; profile: string; src: IssueSource; data: ApiIssueRaised }
  | { type: 'cleared'; profile: string; src: IssueSource; data: ApiIssueCleared };

let sent: Sent[];
let stored: Record<string, unknown>[];
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
  stored = [];
  tracker = new IssueTracker({
    now: Date.now,
    raised: (profile, src, data) => sent.push({ type: 'raised', profile, src, data }),
    cleared: (profile, src, data) => sent.push({ type: 'cleared', profile, src, data }),
    run: (fn) => fn(),
    obsIssues: () => stored,
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
    expect(OBS_APP_RECENT_MS).toBeGreaterThan(60_000); // the plugin resends every 60 s
  });

  it('OBS stopping its stream on purpose is no alert (clean stop before or during the hold)', () => {
    goLive();
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', canvas: 'landscape', state: 'live' });
    tracker.feed(P, 'landscape', false);
    tracker.feed(P, 'vertical', false);
    vi.advanceTimersByTime(1500);
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', canvas: 'landscape', state: 'stopped' });
    tracker.obsEvent(P, APP, 'obs.output', { output: 'Vertical Stream', canvas: 'vertical', state: 'stopped' });
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([]);
    expect(CLEAN_STOP_WINDOW_MS).toBeGreaterThan(ISSUE_HOLDS.feed);
  });

  it('a clean stop reported late ends the alert; a stop with an error does not count as clean', () => {
    goLive();
    tracker.feed(P, 'landscape', false);
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', state: 'stopped', error: 'Disconnected' });
    vi.advanceTimersByTime(ISSUE_HOLDS.feed);
    expect(log()).toEqual(['raised:feed.offline|landscape']);
    tracker.obsEvent(P, APP, 'obs.output', { output: 'main', state: 'stopped' });
    expect(log()).toEqual(['raised:feed.offline|landscape', 'cleared:feed.offline|landscape:ended']);
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
    vi.advanceTimersByTime(ISSUE_HOLDS.destination);
    expect(log()).toEqual(['raised:destination.down|i1']);
    expect(raisedOf('destination.down|i1').message).toBe('Waiting for vertical feed');
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

  it('an app going offline clears its issues as stale and raises them again when it returns', () => {
    tracker.obsEvent(P, APP, 'obs.issue.raised', issue);
    tracker.apps([{ id: APP, online: true }]);
    expect(sent).toHaveLength(1);
    tracker.apps([{ id: APP, online: false }]);
    expect(log().at(-1)).toBe(`cleared:obs.issue|${APP}|camera-offline|Club cam:stale`);
    stored = [{ ...issue, updatedAt: T0 }];
    tracker.apps([{ id: APP, online: true }]);
    expect(log().at(-1)).toBe(`raised:obs.issue|${APP}|camera-offline|Club cam`);
    tracker.apps([]);
    expect(log().at(-1)).toBe(`cleared:obs.issue|${APP}|camera-offline|Club cam:removed`);
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
