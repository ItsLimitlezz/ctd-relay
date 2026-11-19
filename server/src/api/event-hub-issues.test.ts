// The event hub feeding the issue tracker (docs/API.md §16): bus events in, issue.* envelopes out.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedApp, Destination, FeedState, SessionState } from '../../../shared/types.js';
import { EventBus } from '../events.js';
import { EventHub } from './event-hub.js';
import { ISSUE_HOLDS } from './issues.js';
import { dest, dstate, platformInfo, session, silentLog } from './test-helpers.js';
import type { ApiIssueCleared, ApiIssueRaised, Envelope } from './types.js';

const T0 = Date.parse('2026-11-18T20:00:00.000Z');
const APP = 'ctd-obs-plugin-studio';

let bus: EventBus;
let destinations: Destination[];
let current: SessionState;
let apps: ConnectedApp[];
let stored: Record<string, unknown>[];
let hub: EventHub;
let events: Envelope[];

const feed = (name: FeedState['feed'], online: boolean): FeedState => ({ feed: name, online, since: online ? '2026-11-18T19:59:00Z' : null, video: null, audio: null, bitrateKbps: null });
const live = (over: Partial<SessionState> = {}): SessionState =>
  session({ feeds: [feed('landscape', true), feed('vertical', true)], destinations: [dstate('t1', 'live'), dstate('i1', 'live')], ...over });
const issues = () => events.filter((e) => e.type.startsWith('issue.'));
const short = () => issues().map((e) => `${e.type}:${(e.data as { id: string }).id}`);
const app = (online: boolean): ConnectedApp => ({
  id: APP,
  name: 'CTD OBS plugin',
  kind: 'ctd-obs-plugin',
  version: null,
  baseUrl: null,
  capabilities: [],
  resources: [],
  tokenId: 'tok',
  profileId: null,
  registeredAt: '2026-11-18T19:00:00Z',
  lastSeenAt: '2026-11-18T19:59:00Z',
  online,
});

/** The session goes to `next` the way the orchestrator announces it. */
function setSession(next: SessionState): void {
  current = next;
  bus.emit('session', current);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  bus = new EventBus();
  destinations = [dest('t1', { name: 'Twitch' }), dest('i1', { name: 'Instagram', platform: 'instagram', feed: 'vertical' })];
  current = session({ status: 'offline', startedAt: null, feeds: [feed('landscape', false), feed('vertical', false)], destinations: [dstate('t1', 'idle'), dstate('i1', 'idle')] });
  apps = [];
  stored = [];
  events = [];
  hub = new EventHub({
    bus,
    log: silentLog,
    state: () => current,
    destinations: () => destinations,
    destination: (id) => destinations.find((d) => d.id === id) ?? null,
    platformInfo,
    apps: () => apps,
    obsIssues: () => stored,
  });
  hub.subscribe((e) => events.push(e));
});

afterEach(() => {
  hub.close();
  vi.useRealTimers();
});

describe('issues on the event stream', () => {
  it('a live feed going offline becomes issue.raised after the hold, and issue.cleared when it is back', () => {
    setSession(live());
    bus.emit('feed', feed('vertical', false));
    vi.advanceTimersByTime(ISSUE_HOLDS.feed);
    expect(short()).toEqual(['issue.raised:feed.offline|vertical']);
    const raised = issues()[0] as Envelope<ApiIssueRaised>;
    expect(raised.src).toEqual({ connector: 'ctd-multi-stream', connection: 'core', platform: 'core', profile: 'default' });
    expect(raised.data).toMatchObject({ kind: 'feed.offline', severity: 'critical', title: 'Vertical feed lost', subject: { type: 'feed', feed: 'vertical' }, update: false });
    expect(hub.status().issues).toEqual([expect.objectContaining({ id: 'feed.offline|vertical', firstSeen: T0 + ISSUE_HOLDS.feed })]);
    expect(hub.status().issues[0]).not.toHaveProperty('update');

    bus.emit('feed', feed('vertical', true));
    expect(short()).toEqual(['issue.raised:feed.offline|vertical', 'issue.cleared:feed.offline|vertical']);
    expect((issues()[1] as Envelope<ApiIssueCleared>).data).toMatchObject({ resolution: 'recovered', durationMs: 0 });
    expect(hub.status().issues).toEqual([]);
  });

  it('OBS stopped and the grace period ran out: the feed issues clear as ended, not recovered', () => {
    setSession(live());
    bus.emit('feed', feed('landscape', false));
    bus.emit('feed', feed('vertical', false));
    vi.advanceTimersByTime(ISSUE_HOLDS.feed);
    setSession(session({ status: 'offline', startedAt: null, feeds: [feed('landscape', false), feed('vertical', false)], destinations: [dstate('t1', 'idle'), dstate('i1', 'idle')] }));
    expect(short()).toEqual([
      'issue.raised:feed.offline|landscape',
      'issue.raised:feed.offline|vertical',
      'issue.cleared:feed.offline|landscape',
      'issue.cleared:feed.offline|vertical',
    ]);
    expect(issues().slice(2).map((e) => (e.data as ApiIssueCleared).resolution)).toEqual(['ended', 'ended']);
  });

  it('a destination that stays down is destination.down (from the destination), then critical stream.down when all are', () => {
    setSession(live());
    setSession(live({ destinations: [dstate('t1', 'live'), dstate('i1', 'recovering', { message: 'Instagram ended the live (copyright). Starting a new one…' })] }));
    expect(events.map((e) => e.type)).toContain('destination.down');
    expect(issues()).toEqual([]); // held
    vi.advanceTimersByTime(ISSUE_HOLDS.destination);
    expect(short()).toEqual(['issue.raised:destination.down|i1']);
    expect(issues()[0]).toMatchObject({
      src: { connection: 'i1', platform: 'instagram', profile: 'default' },
      data: { severity: 'warning', title: 'Instagram is down', message: 'Instagram ended the live (copyright). Starting a new one…' },
    });

    setSession(live({ destinations: [dstate('t1', 'error', { message: 'Stream key rejected' }), dstate('i1', 'recovering')] }));
    vi.advanceTimersByTime(ISSUE_HOLDS.stream);
    expect(short().slice(1)).toEqual(['issue.raised:destination.down|i1', 'issue.raised:destination.down|t1', 'issue.raised:stream.down']);
    expect((issues()[1] as Envelope<ApiIssueRaised>).data).toMatchObject({ update: true, message: null }); // i1's message changed
    expect((issues()[2] as Envelope<ApiIssueRaised>).data).toMatchObject({ severity: 'critical', title: 'Twitch is down' }); // Relay gave up on it
    expect((issues()[3] as Envelope<ApiIssueRaised>).data).toMatchObject({ kind: 'stream.down', severity: 'critical' });
    expect(hub.status().issues.map((i) => i.id)).toEqual(['destination.down|i1', 'destination.down|t1', 'stream.down']);

    // Stopping the session ends all three; the hub's destination.up edges come too.
    events = [];
    setSession(session({ status: 'offline', startedAt: null, destinations: [dstate('t1', 'idle'), dstate('i1', 'idle')] }));
    expect(issues().map((e) => `${(e.data as ApiIssueCleared).id}:${(e.data as ApiIssueCleared).resolution}`).sort()).toEqual(['destination.down|i1:ended', 'destination.down|t1:ended', 'stream.down:ended']);
    expect(events.filter((e) => e.type === 'destination.up')).toHaveLength(2);
    expect(hub.status().issues).toEqual([]);
  });

  it('a deleted destination takes its issue along (removed)', () => {
    setSession(live());
    setSession(live({ destinations: [dstate('t1', 'live'), dstate('i1', 'retrying')] }));
    vi.advanceTimersByTime(ISSUE_HOLDS.destination);
    destinations = destinations.filter((d) => d.id !== 'i1');
    bus.emit('destinations-changed');
    expect((issues().at(-1) as Envelope<ApiIssueCleared>).data).toMatchObject({ id: 'destination.down|i1', resolution: 'removed' });
  });

  it("the plugin's obs.issue.* are re-emitted as they are, each followed by its issue.*", () => {
    const data = { id: 'camera-offline|Club cam', rule: 'camera-offline', severity: 'critical', source: 'Club cam', title: 'Camera offline', firstSeen: T0, onProgram: true, scene: 'Club' };
    bus.emit('obs-event', { appId: APP, profileId: 'default', type: 'obs.issue.raised', id: 'e1', ts: T0, data });
    bus.emit('obs-event', { appId: APP, profileId: 'default', type: 'obs.issue.cleared', id: 'e2', ts: T0 + 1, data: { id: data.id } });
    expect(events.map((e) => e.type)).toEqual(['obs.issue.raised', 'issue.raised', 'obs.issue.cleared', 'issue.cleared']);
    expect(events[1]).toMatchObject({
      src: { connection: APP, platform: 'obs', profile: 'default' },
      data: { id: `obs.issue|${APP}|camera-offline|Club cam`, kind: 'obs.issue', rule: 'camera-offline', onProgram: true, scene: 'Club', subject: { type: 'obs.source', appId: APP, source: 'Club cam', path: null } },
    });
    expect((events[3] as Envelope<ApiIssueCleared>).data.resolution).toBe('recovered');
  });

  it('obs.failover passes through and opens no issue', () => {
    const data = { canvas: 'landscape', from: 'Club cam', to: 'BRB', reason: 'camera-offline', mode: 'target' };
    bus.emit('obs-event', { appId: APP, profileId: 'default', type: 'obs.failover', id: 'f1', ts: T0, data });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'obs.failover', src: { connection: APP, platform: 'obs' }, data: { ...data, appId: APP, eventId: 'f1', at: T0 } });
    expect(hub.status().issues).toEqual([]);
  });

  it('an OBS app going offline makes its issues stale; unregistering removes them', () => {
    apps = [app(true)];
    const data = { id: 'camera-offline|Club cam', rule: 'camera-offline', severity: 'critical', source: 'Club cam', title: 'Camera offline' };
    bus.emit('obs-event', { appId: APP, profileId: 'default', type: 'obs.issue.raised', id: 'e1', ts: T0, data });
    apps = [app(false)];
    bus.emit('apps-changed');
    expect((issues().at(-1) as Envelope<ApiIssueCleared>).data.resolution).toBe('stale');
    stored = [data];
    apps = [app(true)];
    bus.emit('apps-changed');
    expect(issues().at(-1)).toMatchObject({ type: 'issue.raised', data: { update: false } });
    apps = [];
    bus.emit('apps-changed');
    expect((issues().at(-1) as Envelope<ApiIssueCleared>).data.resolution).toBe('removed');
  });

  it('issues belong to their profile, and a deleted profile takes them along', () => {
    let profiles = [{ id: 'default' }, { id: 'club' }];
    hub.close();
    events = [];
    hub = new EventHub({ bus, log: silentLog, state: () => current, destinations: () => destinations, destination: () => null, platformInfo, profiles: () => profiles });
    hub.subscribe((e) => events.push(e));
    bus.emit('obs-event', { appId: APP, profileId: 'club', type: 'obs.issue.raised', id: 'e1', ts: T0, data: { id: 'av-drift|Cam', severity: 'warning', title: 'A/V drift' } });
    const raised = issues()[0]!;
    expect(raised.src.profile).toBe('club');
    expect(hub.visible(raised, { tokenId: 't', tokenProfile: 'default', profile: null })).toBeNull();
    expect(hub.visible(raised, { tokenId: 't', tokenProfile: null, profile: 'club' })).toBe(raised);
    expect(hub.status('club').issues).toHaveLength(1);
    expect(hub.status('default').issues).toEqual([]);
    profiles = [{ id: 'default' }];
    bus.emit('profiles-changed');
    expect((issues().at(-1) as Envelope<ApiIssueCleared>).data).toMatchObject({ id: `obs.issue|${APP}|av-drift|Cam`, resolution: 'removed' });
  });

  it("the stream's opening snapshot doesn't repeat open issues (GET /status has them)", () => {
    bus.emit('obs-event', { appId: APP, profileId: 'default', type: 'obs.issue.raised', id: 'e1', ts: T0, data: { id: 'av-drift|Cam', severity: 'warning', title: 'A/V drift' } });
    expect(hub.snapshot('default').map((e) => e.type)).toEqual(['stream.status', 'destination.status', 'destination.status']);
    expect(hub.status().issues).toHaveLength(1);
  });

  it('closing the hub cancels pending holds', () => {
    setSession(live());
    bus.emit('feed', feed('landscape', false));
    hub.close();
    vi.advanceTimersByTime(60_000);
    expect(issues()).toEqual([]);
  });
});
