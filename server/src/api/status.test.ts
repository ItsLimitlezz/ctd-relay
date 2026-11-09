import { describe, expect, it } from 'vitest';
import type { PlatformInfo } from '../../../shared/types.js';
import { apiDestination, buildStatus, isDown, platformRollup, totalViewers } from './status.js';
import { dest, dstate, session } from './test-helpers.js';

const info = (supported: boolean): PlatformInfo => ({ testMode: { supported, description: '' } }) as PlatformInfo;

describe('down', () => {
  it('is true only while running, enabled, not skipped by test mode, in a failing phase', () => {
    const running = session();
    for (const phase of ['error', 'retrying', 'recovering', 'waiting-for-feed'] as const) {
      expect(isDown(running, { enabled: true }, phase, null), phase).toBe(true);
    }
    for (const phase of ['idle', 'disabled', 'preparing', 'connecting', 'confirming', 'live', 'ending'] as const) {
      expect(isDown(running, { enabled: true }, phase, null), phase).toBe(false);
    }
    expect(isDown(session({ status: 'starting' }), { enabled: true }, 'error', null)).toBe(true);
    expect(isDown(session({ status: 'offline' }), { enabled: true }, 'error', null)).toBe(false);
    expect(isDown(session({ status: 'stopping' }), { enabled: true }, 'error', null)).toBe(false);
    expect(isDown(running, { enabled: false }, 'error', null)).toBe(false);
    expect(isDown(session({ testMode: true }), { enabled: true }, 'error', info(false))).toBe(false);
    expect(isDown(session({ testMode: true }), { enabled: true }, 'error', null)).toBe(false);
    expect(isDown(session({ testMode: true }), { enabled: true }, 'error', info(true))).toBe(true);
  });

  it('stays down while a retry works its way back (no down → up → down flapping)', () => {
    const running = session();
    for (const phase of ['preparing', 'connecting', 'confirming'] as const) {
      expect(isDown(running, { enabled: true }, phase, null, 2), phase).toBe(true);
    }
    expect(isDown(running, { enabled: true }, 'live', null, 2)).toBe(false);
    expect(isDown(running, { enabled: true }, 'ending', null, 2)).toBe(false);
    expect(isDown(session({ status: 'offline' }), { enabled: true }, 'preparing', null, 2)).toBe(false);
  });
});

describe('waiting for a feed', () => {
  const running = (online: { landscape: boolean; vertical: boolean }) =>
    session({
      feeds: [
        { feed: 'landscape', online: online.landscape, since: null, video: null, audio: null, bitrateKbps: null },
        { feed: 'vertical', online: online.vertical, since: null, video: null, audio: null, bitrateKbps: null },
      ],
    });

  it('passes the runner\'s waitingFor through and is down', () => {
    const st = dstate('tw', 'waiting-for-feed', { message: 'Waiting for vertical feed', waitingFor: ['vertical'] });
    const out = apiDestination(dest('tw'), st, running({ landscape: true, vertical: false }), null);
    expect(out).toMatchObject({ phase: 'waiting-for-feed', waitingFor: ['vertical'], message: 'Waiting for vertical feed', down: true });
    expect(apiDestination(dest('tw'), dstate('tw', 'live'), running({ landscape: true, vertical: true }), null).waitingFor).toEqual([]);
  });

  it('never shows an enabled destination of a running session as idle while its feed is offline', () => {
    const vertical = dest('ig', { platform: 'instagram', feed: 'vertical' });
    const out = apiDestination(vertical, dstate('ig', 'idle'), running({ landscape: true, vertical: false }), null);
    expect(out).toMatchObject({ phase: 'waiting-for-feed', waitingFor: ['vertical'], message: 'Waiting for vertical feed', down: true });
    const dual = dest('tw', { options: { dualFormat: 'relay-multitrack' } });
    expect(apiDestination(dual, dstate('tw', 'idle'), running({ landscape: true, vertical: false }), null)).toMatchObject({
      phase: 'waiting-for-feed',
      waitingFor: ['vertical'],
    });
    expect(apiDestination(dual, undefined, running({ landscape: false, vertical: false }), null)).toMatchObject({
      waitingFor: ['landscape', 'vertical'],
      message: 'Waiting for both feeds',
    });
  });

  it('stays idle when offline, disabled, skipped by test mode, or when its feeds are online', () => {
    const vertical = dest('ig', { platform: 'instagram', feed: 'vertical' });
    const idle = dstate('ig', 'idle');
    expect(apiDestination(vertical, idle, { ...running({ landscape: true, vertical: false }), status: 'offline' }, null).phase).toBe('idle');
    expect(apiDestination({ ...vertical, enabled: false }, idle, running({ landscape: true, vertical: false }), null).phase).toBe('idle');
    expect(apiDestination(vertical, idle, { ...running({ landscape: true, vertical: false }), testMode: true }, info(false)).phase).toBe('idle');
    expect(apiDestination(vertical, idle, running({ landscape: true, vertical: true }), null).phase).toBe('idle');
  });
});

describe('totalViewers', () => {
  it('adds up the known counts; null when none is known', () => {
    expect(totalViewers([{ viewers: 3 }, { viewers: null }, {}, { viewers: 0 }, { viewers: 40 }])).toBe(43);
    expect(totalViewers([{ viewers: 0 }])).toBe(0);
    expect(totalViewers([{ viewers: null }, { viewers: -1 }, { viewers: Number.NaN }])).toBeNull();
    expect(totalViewers([])).toBeNull();
  });
});

describe('status builder', () => {
  it('builds session, feeds, destinations and the per-platform rollup', () => {
    const destinations = [
      dest('t1', { name: 'Twitch' }),
      dest('i1', { name: 'Instagram', platform: 'instagram', feed: 'vertical' }),
      dest('t2', { name: 'Twitch 2' }),
      dest('k1', { name: 'Kick', platform: 'kick', enabled: false }),
    ];
    const state = session({
      destinations: [
        dstate('t1', 'live', { stats: { bitrateKbps: 6010, fps: 60, speed: 1, uptimeSec: 3605 }, viewers: 214, watchUrl: 'https://www.twitch.tv/x' }),
        dstate('i1', 'recovering', {
          message: 'Instagram ended the live (copyright). Starting a new one…',
          recoveries: 1,
          lastRecovery: { at: '2026-10-17T04:12:40Z', reason: 'copyright' },
          since: '2026-10-17T04:12:40Z',
          viewers: null,
        }),
        dstate('t2', 'live', { since: '2026-10-17T03:00:05.000Z', viewers: 10 }),
        dstate('k1', 'disabled'),
        dstate('gone', 'ending'), // removed from the repo while tearing down: not listed
      ],
    });
    const status = buildStatus({
      state: () => state,
      destinations: () => destinations,
      platformInfo: () => null,
    });

    // viewers: every platform added up (214 + 10; Instagram's unknown count is left out).
    expect(status.session).toEqual({ status: 'live', startedAt: '2026-10-17T03:00:04.000Z', title: 'DPRTMNT Saturday', testMode: false, autoGoLive: true, viewers: 224 });
    expect(status.feeds).toHaveLength(2);
    expect(status.feeds[0]).toMatchObject({ feed: 'landscape', online: true, bitrateKbps: 6012 });
    expect(status.destinations.map((d) => d.id)).toEqual(['t1', 'i1', 't2', 'k1']);
    expect(status.destinations[0]).toEqual({
      id: 't1',
      name: 'Twitch',
      platform: 'twitch',
      feed: 'landscape',
      enabled: true,
      phase: 'live',
      live: true,
      down: false,
      waitingFor: [],
      message: null,
      stats: { bitrateKbps: 6010, fps: 60, speed: 1, uptimeSec: 3605 },
      viewers: 214,
      watchUrl: 'https://www.twitch.tv/x',
      recoveries: 0,
      lastRecovery: null,
      since: '2026-10-17T03:00:09.000Z',
    });
    expect(status.destinations[1]).toMatchObject({ phase: 'recovering', live: false, down: true, viewers: null, recoveries: 1 });
    expect(status.platforms).toEqual([
      { platform: 'twitch', destinations: ['t1', 't2'], live: true, title: 'DPRTMNT Saturday', startedAt: Date.parse('2026-10-17T03:00:05.000Z'), viewers: 224, error: null },
      {
        platform: 'instagram',
        destinations: ['i1'],
        live: false,
        title: 'DPRTMNT Saturday',
        startedAt: null,
        viewers: null,
        error: 'Instagram ended the live (copyright). Starting a new one…',
      },
    ]);
  });

  it('fills in destinations the orchestrator has no state for, and never reports 0 for unknown viewers', () => {
    const d = apiDestination(dest('x', { enabled: false }), undefined, session({ status: 'offline' }), null);
    expect(d).toMatchObject({ phase: 'disabled', live: false, down: false, viewers: null, stats: null, since: '2026-10-01T00:00:00.000Z' });
    expect(apiDestination(dest('y'), dstate('y', 'live', { viewers: -1 }), session(), null).viewers).toBeNull();
    expect(apiDestination(dest('y'), dstate('y', 'live', { viewers: 0 }), session(), null).viewers).toBe(0);
  });

  it('rollup: viewers null when none known, first down message as error', () => {
    const items = [
      apiDestination(dest('a'), dstate('a', 'error', { message: 'first' }), session(), null),
      apiDestination(dest('b'), dstate('b', 'retrying', { message: 'second' }), session(), null),
    ];
    expect(platformRollup(items, 't')).toEqual([{ platform: 'twitch', destinations: ['a', 'b'], live: false, title: 't', startedAt: null, viewers: null, error: 'first' }]);
  });

  it('rollup: error is a real destination message, never an invented one', () => {
    const silent = apiDestination(dest('a'), dstate('a', 'retrying'), session(), null);
    expect(silent.down).toBe(true);
    expect(platformRollup([silent], 't')[0]!.error).toBeNull();
    const second = apiDestination(dest('b'), dstate('b', 'error', { message: 'Stream key rejected' }), session(), null);
    expect(platformRollup([silent, second], 't')[0]!.error).toBe('Stream key rejected');
  });
});
