import { describe, expect, it } from 'vitest';
import type { WsServerMessage } from '@shared/api';
import type { ChatMessage, DestinationPhase, DestinationState, Feed, FeedState, PlatformId, SessionState } from '@shared/types';
import { LiveStore } from '../state/live-store';
import { chatPlatforms, filterChat } from './ChatPage';
import { applySessionResult, recoverySummary, statusSubtitle } from './DashboardPage';
import { groupSecret, validatePasswordChange } from './ProfilePage';
import { validateSetup } from './SetupPage';

const msg = (id: string, platform: PlatformId): ChatMessage => ({
  id,
  platform,
  destinationId: 'd',
  author: { name: 'a' },
  text: 't',
  ts: '2026-10-11T10:00:00.000Z',
  kind: 'message',
});

describe('page helpers', () => {
  it('validates the setup form', () => {
    expect(validateSetup({ setupCode: '', username: ' ', password: 'short', confirm: 'x' })).toEqual({
      setupCode: expect.any(String),
      username: expect.any(String),
      password: expect.stringContaining('10'),
      confirm: expect.any(String),
    });
    expect(validateSetup({ setupCode: 'ABCD-EFGH-JKLM', username: 'admin', password: 'long enough pw', confirm: 'long enough pw' })).toEqual({});
  });

  it('validates password changes', () => {
    expect(validatePasswordChange('', 'short', 'other')).toEqual({
      current: expect.any(String),
      next: expect.any(String),
      confirm: expect.any(String),
    });
    expect(validatePasswordChange('same password', 'same password', 'same password').next).toMatch(/different/);
    expect(validatePasswordChange('old password', 'new password!', 'new password!')).toEqual({});
  });

  it('groups TOTP secrets for reading', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(groupSecret('ABCDEF')).toBe('ABCD EF');
  });

  it('lists chat platforms in standard order with counts and filters', () => {
    const chat = [msg('1', 'youtube'), msg('2', 'twitch'), msg('3', 'youtube')];
    expect(chatPlatforms(chat, new Set())).toEqual([
      { id: 'twitch', count: 1 },
      { id: 'youtube', count: 2 },
    ]);
    expect(chatPlatforms(chat, new Set<PlatformId>(['kick'])).map((p) => p.id)).toEqual(['twitch', 'youtube', 'kick']);
    expect(filterChat(chat, new Set()).length).toBe(3);
    expect(filterChat(chat, new Set<PlatformId>(['youtube'])).map((m) => m.id)).toEqual(['1', '3']);
  });
});

const feed = (f: Feed, online: boolean): FeedState => ({ feed: f, online, since: null, video: null, audio: null, bitrateKbps: null });
const dest = (id: string, phase: DestinationPhase, over: Partial<DestinationState> = {}): DestinationState => ({
  destinationId: id,
  phase,
  message: null,
  stats: null,
  watchUrl: null,
  retries: 0,
  since: '2026-10-11T10:00:00.000Z',
  recoveries: 0,
  lastRecovery: null,
  ...over,
});
const session = (over: Partial<SessionState> = {}): SessionState => ({
  status: 'offline',
  sessionId: null,
  startedAt: null,
  title: 't',
  autoGoLive: true,
  feeds: [feed('landscape', false), feed('vertical', false)],
  destinations: [],
  ...over,
});

describe('dashboard status', () => {
  it('only says "Waiting for OBS" while no feed is online', () => {
    expect(statusSubtitle(session())).toMatch(/^Waiting for OBS/);
    // After a manual stop with OBS still streaming, nothing starts by itself.
    const obsOn = statusSubtitle(session({ feeds: [feed('landscape', true), feed('vertical', false)] }));
    expect(obsOn).toMatch(/^OBS is streaming/);
    expect(obsOn).toContain('Go live');
    expect(statusSubtitle(session({ autoGoLive: false }))).toBe('Press "Go live" when you are ready.');
    expect(statusSubtitle(session({ autoGoLive: false, feeds: [feed('landscape', true)] }))).toBe('Press "Go live" when you are ready.');
  });

  it('counts a destination being recovered as active but not live', () => {
    const live = session({
      status: 'live',
      destinations: [dest('a', 'live'), dest('b', 'recovering'), dest('c', 'disabled')],
    });
    expect(statusSubtitle(live)).toBe('1 of 2 destinations live · 1 recovering');
    expect(statusSubtitle(session({ status: 'live', destinations: [dest('a', 'live'), dest('b', 'live')] }))).toBe('2 of 2 destinations live');
  });

  it('counts enabled destinations that are idle or waiting for a feed ("0 of 3", not "0 of 1")', () => {
    // Regression: idle / waiting destinations were left out of the total, so three enabled
    // destinations with one preparing read "0 of 1 destinations live".
    const s = session({
      status: 'live',
      destinations: [dest('yt', 'preparing'), dest('tw', 'idle'), dest('ig', 'waiting-for-feed'), dest('off', 'disabled')],
    });
    expect(statusSubtitle(s)).toBe('0 of 3 destinations live');
    expect(statusSubtitle({ ...s, status: 'starting' })).toBe('Preparing destinations… 0 of 3 live');
  });

  it("the auto toggle's REST snapshot doesn't undo a newer WebSocket 'live'", () => {
    const store = new LiveStore();
    store.dispatch({ type: 'hello', session: session({ autoGoLive: false }), chat: [], profiles: [] } as WsServerMessage);
    // The auto start triggered by the toggle reaches the socket before the PUT's reply.
    store.dispatch({ type: 'session', session: session({ status: 'live', sessionId: 's1', autoGoLive: true }) });
    applySessionResult('auto', session({ status: 'offline', autoGoLive: true }), store);
    expect(store.getState().session).toMatchObject({ status: 'live', sessionId: 's1', autoGoLive: true });

    // Start / stop answer after the operation finished: their snapshot replaces the state.
    applySessionResult('stop', session({ status: 'offline', autoGoLive: true }), store);
    expect(store.getState().session?.status).toBe('offline');
  });

  it('the test-mode toggle only merges the flag (an auto start may already be under way)', () => {
    const store = new LiveStore();
    store.dispatch({ type: 'hello', session: session({ testMode: false }), chat: [], profiles: [] } as WsServerMessage);
    store.dispatch({ type: 'session', session: session({ status: 'starting', sessionId: 's2', testMode: true }) });
    applySessionResult('test', session({ status: 'offline', testMode: true }), store);
    expect(store.getState().session).toMatchObject({ status: 'starting', sessionId: 's2', testMode: true });
    applySessionResult('test', session({ status: 'offline' }), store); // older server without the field
    expect(store.getState().session?.testMode).toBe(false);
  });
});

describe('destination card: takedown recoveries', () => {
  const now = Date.parse('2026-10-11T23:30:00.000Z');

  it('says nothing before the first recovery', () => {
    expect(recoverySummary(null, now)).toBeNull();
    expect(recoverySummary(dest('a', 'live'), now)).toBeNull();
    // An older server without the new fields.
    expect(recoverySummary({ recoveries: undefined as unknown as number, lastRecovery: null }, now)).toBeNull();
  });

  it('shows the count, the last reason and how long ago', () => {
    const state = dest('a', 'live', {
      recoveries: 2,
      lastRecovery: { at: '2026-10-11T23:27:00.000Z', reason: 'copyright takedown' },
    });
    expect(recoverySummary(state, now)).toBe('Recovered 2× · last: copyright takedown 3 min ago');
    expect(recoverySummary({ recoveries: 1, lastRecovery: null }, now)).toBe('Recovered 1×');
    expect(recoverySummary({ recoveries: 1, lastRecovery: { at: 'bad', reason: '' } }, now)).toBe('Recovered 1×');
  });

  it('keeps long or multi-line reasons on one short line', () => {
    const reason = `Your live video was removed\nbecause it may violate ${'x'.repeat(200)}`;
    const text = recoverySummary({ recoveries: 3, lastRecovery: { at: '2026-10-11T23:29:58.000Z', reason } }, now) ?? '';
    expect(text).toMatch(/^Recovered 3× · last: Your live video was removed because it may violate x+… just now$/);
    expect(text.length).toBeLessThan(170);
  });
});
