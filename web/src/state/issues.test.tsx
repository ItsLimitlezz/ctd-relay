import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WsServerMessage } from '@shared/api';
import { issueAffects, type ApiIssue } from '@shared/issues';
import type { SessionState } from '@shared/types';
import { IssueBadge, IssuesStrip } from '../components/Issues';
import { destinationIssues, feedIssues, formatOpenFor, historyOutcome, issueBadge, sortIssues, worstSeverity } from './issues';
import { initialLiveState, parseServerMessage, reduceLive, removeIssue, upsertIssue } from './live-store';

const T0 = Date.parse('2026-11-20T20:00:00.000Z');
const issue = (over: Partial<ApiIssue> = {}): ApiIssue => ({
  id: 'feed.offline|landscape',
  kind: 'feed.offline',
  rule: null,
  severity: 'critical',
  title: 'Landscape feed lost',
  message: null,
  subject: { type: 'feed', feed: 'landscape' },
  onProgram: null,
  scene: null,
  firstSeen: T0,
  updatedAt: T0,
  ...over,
});
const destIssue = (id: string, severity: ApiIssue['severity'], firstSeen = T0) =>
  issue({ id: `destination.down|${id}`, kind: 'destination.down', severity, title: `${id} is down`, subject: { type: 'destination', destinationId: id, platform: 'twitch', name: id }, firstSeen });

describe('issue helpers', () => {
  it('orders by severity, then oldest first, and finds the worst', () => {
    const list = [destIssue('a', 'warning', T0), destIssue('b', 'critical', T0 + 5), destIssue('c', 'critical', T0 + 1), destIssue('d', 'info')];
    expect(sortIssues(list).map((i) => i.subject.type === 'destination' && i.subject.destinationId)).toEqual(['c', 'b', 'a', 'd']);
    expect(list.map((i) => i.id)[0]).toBe('destination.down|a'); // input untouched
    expect(worstSeverity(list)).toBe('critical');
    expect(worstSeverity([])).toBeNull();
  });

  it('says what an issue affects, by name', () => {
    expect(issueAffects({ type: 'feed', feed: 'vertical' })).toBe('Vertical feed');
    expect(issueAffects({ type: 'destination', destinationId: 'd1', platform: 'kick', name: 'Kick backup' })).toBe('Destination Kick backup');
    expect(issueAffects({ type: 'stream' })).toBe('The whole stream');
    expect(issueAffects({ type: 'obs.output', appId: 'a', output: 'vertical', canvas: null })).toBe('OBS output vertical');
    expect(issueAffects({ type: 'obs.source', appId: 'a', source: 'Club cam', path: null })).toBe('OBS source Club cam');
    expect(issueAffects({ type: 'guest.feed', slot: 'abcdefghij', name: 'MacBook' })).toBe('Extra feed MacBook');
    expect(issueAffects({ type: 'guest.feed', slot: 'abcdefghij', name: '' })).toBe('An extra feed');
  });

  it('picks each card’s issues and its badge', () => {
    const list = [issue(), issue({ id: 'feed.offline|vertical', subject: { type: 'feed', feed: 'vertical' } }), destIssue('d1', 'warning'), destIssue('d1x', 'critical')];
    expect(feedIssues(list, 'landscape').map((i) => i.id)).toEqual(['feed.offline|landscape']);
    expect(destinationIssues(list, 'd1').map((i) => i.id)).toEqual(['destination.down|d1']);
    expect(issueBadge([])).toBeNull();
    expect(issueBadge(destinationIssues(list, 'd1'))).toMatchObject({ count: 1, severity: 'warning', tone: 'warn', text: '1 issue' });
    expect(issueBadge([destIssue('x', 'warning'), destIssue('y', 'critical')])).toMatchObject({ count: 2, tone: 'danger', text: '2 issues', title: 'y is down\nx is down' });
  });

  it('formats how long it has been open, and how a past one ended', () => {
    expect(formatOpenFor(-5)).toBe('0 s');
    expect(formatOpenFor(42_000)).toBe('42 s');
    expect(formatOpenFor(4 * 60_000 + 10_000)).toBe('4 min');
    expect(formatOpenFor(65 * 60_000)).toBe('1 h 5 min');
    expect(formatOpenFor(2 * 3600_000)).toBe('2 h');
    expect(formatOpenFor(51 * 3600_000)).toBe('2 d 3 h');
    expect(historyOutcome({ resolution: null, clearedAt: null, durationMs: null })).toBe('Still open');
    expect(historyOutcome({ resolution: 'recovered', clearedAt: T0, durationMs: 120_000 })).toBe('Recovered after 2 min');
    expect(historyOutcome({ resolution: 'restarted', clearedAt: T0, durationMs: 1000 })).toBe('Relay restarted after 1 s');
  });

  it('renders a row per open issue (most severe first) and a badge; nothing when there are none', () => {
    expect(renderToStaticMarkup(<IssuesStrip issues={[]} />)).toBe('');
    expect(renderToStaticMarkup(<IssueBadge issues={[]} />)).toBe('');
    const html = renderToStaticMarkup(<IssuesStrip issues={[destIssue('Twitch', 'warning'), issue({ message: 'OBS stopped sending.' })]} />);
    expect(html.indexOf('Landscape feed lost')).toBeLessThan(html.indexOf('Twitch is down'));
    expect(html).toContain('Destination Twitch');
    expect(html).toContain('OBS stopped sending.');
    expect(html).toContain('is-critical');
    expect(html).toMatch(/open \d/);
    expect(renderToStaticMarkup(<IssueBadge issues={[issue()]} />)).toContain('1 issue');
  });
});

describe('issues in the live store', () => {
  const session = { profileId: 'default', status: 'live', sessionId: 's', startedAt: null, title: '', autoGoLive: true, feeds: [], destinations: [] } as SessionState;
  const hello = (issues?: ApiIssue[]): WsServerMessage => ({ type: 'hello', session, chat: [], profiles: [], ...(issues ? { issues } : {}) });

  it('parses the issue messages and drops malformed ones', () => {
    const raised = { type: 'issue-raised', profileId: 'default', issue: { ...issue(), update: false } };
    expect(parseServerMessage(JSON.stringify(raised))).toEqual(raised);
    expect(parseServerMessage(JSON.stringify({ type: 'issue-cleared', profileId: 'default', issue: {} }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'issue-raised', issue: issue() }))).toBeNull();
  });

  it('hello sets the open set; raised adds or replaces by id; cleared removes; other profiles are ignored', () => {
    let s = reduceLive({ ...initialLiveState, profileId: 'default' }, hello([issue()]));
    expect(s.issues.map((i) => i.id)).toEqual(['feed.offline|landscape']);
    s = reduceLive(s, { type: 'issue-raised', profileId: 'default', issue: { ...destIssue('d1', 'warning'), update: false } });
    s = reduceLive(s, { type: 'issue-raised', profileId: 'default', issue: { ...issue({ severity: 'warning', title: 'Changed' }), update: true } });
    expect(s.issues.map((i) => i.title)).toEqual(['Changed', 'd1 is down']);
    expect(s.issues[0]).not.toHaveProperty('update');
    s = reduceLive(s, { type: 'issue-raised', profileId: 'club', issue: { ...destIssue('c1', 'critical'), update: false } });
    expect(s.issues).toHaveLength(2);
    const before = s;
    s = reduceLive(s, { type: 'issue-cleared', profileId: 'default', issue: { id: 'nope', kind: 'stream.down', rule: null, subject: { type: 'stream' }, title: '', firstSeen: 0, durationMs: 0, resolution: 'ended' } });
    expect(s).toBe(before);
    s = reduceLive(s, { type: 'issue-cleared', profileId: 'default', issue: { id: 'feed.offline|landscape', kind: 'feed.offline', rule: null, subject: { type: 'feed', feed: 'landscape' }, title: '', firstSeen: T0, durationMs: 1, resolution: 'recovered' } });
    expect(s.issues.map((i) => i.id)).toEqual(['destination.down|d1']);
    // A server before v1.18 sends no issues: none.
    expect(reduceLive(s, hello()).issues).toEqual([]);
  });

  it('upsertIssue / removeIssue', () => {
    expect(upsertIssue([], issue())).toHaveLength(1);
    const list = [issue()];
    expect(removeIssue(list, 'other')).toBe(list);
    expect(removeIssue(list, issue().id)).toEqual([]);
  });
});
