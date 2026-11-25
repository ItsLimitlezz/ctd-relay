// Guest feed issues (docs/API.md §18.5): guest.feed.offline and guest.feed.codec on the v1.16 contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ISSUE_HOLDS, IssueTracker, type IssueGuestFeed } from './issues.js';
import type { ApiIssueCleared, ApiIssueRaised } from './types.js';

const P = 'default';
const SLOT = 'q7m2x9k4tb';
let sent: string[];
let raised: ApiIssueRaised[];
let cleared: ApiIssueCleared[];
let tracker: IssueTracker;

const guest = (over: Partial<IssueGuestFeed> = {}): IssueGuestFeed => ({ slot: SLOT, name: 'Remote cam 1', online: true, problem: null, ...over });
const HEVC = { blocking: true, label: 'HEVC', message: 'Guest feed "Remote cam 1" is HEVC. …' };

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  raised = [];
  cleared = [];
  tracker = new IssueTracker({
    now: Date.now,
    raised: (_p, _src, d) => {
      raised.push(d);
      sent.push(`${d.update ? 'updated' : 'raised'}:${d.id}`);
    },
    cleared: (_p, _src, d) => {
      cleared.push(d);
      sent.push(`cleared:${d.id}:${d.resolution}`);
    },
    run: (fn) => fn(),
  });
});
afterEach(() => {
  tracker.close();
  vi.useRealTimers();
});

describe('guest.feed.offline', () => {
  it('a running session: a guest that stops for 5 s raises a warning; it clears as recovered when back', () => {
    tracker.session(P, true);
    tracker.guestFeed(P, guest());
    tracker.guestFeed(P, guest({ online: false }));
    vi.advanceTimersByTime(ISSUE_HOLDS.feed - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([`raised:guest.feed.offline|${SLOT}`]);
    expect(raised[0]).toMatchObject({ kind: 'guest.feed.offline', severity: 'warning', title: 'Guest feed "Remote cam 1" lost', subject: { type: 'guest.feed', slot: SLOT, name: 'Remote cam 1' }, onProgram: null });
    tracker.guestFeed(P, guest());
    expect(sent.at(-1)).toBe(`cleared:guest.feed.offline|${SLOT}:recovered`);
    expect(tracker.list(P)).toEqual([]);
  });

  it('a blip under 5 s raises nothing', () => {
    tracker.session(P, true);
    tracker.guestFeed(P, guest());
    tracker.guestFeed(P, guest({ online: false }));
    vi.advanceTimersByTime(2000);
    tracker.guestFeed(P, guest());
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([]);
  });

  it('no session running: nothing (a guest leaving between shows is not an alert)', () => {
    tracker.guestFeed(P, guest());
    tracker.guestFeed(P, guest({ online: false }));
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([]);
  });

  it('an admin rotating or revoking the key (expected offline) raises nothing, and clears an open one as removed', () => {
    tracker.session(P, true);
    tracker.guestFeed(P, guest());
    tracker.guestFeed(P, guest({ online: false }), true);
    vi.advanceTimersByTime(60_000);
    expect(sent).toEqual([]);
    tracker.guestFeed(P, guest());
    tracker.guestFeed(P, guest({ online: false }));
    vi.advanceTimersByTime(ISSUE_HOLDS.feed);
    tracker.guestRemoved(P, SLOT, false);
    expect(sent).toEqual([`raised:guest.feed.offline|${SLOT}`, `cleared:guest.feed.offline|${SLOT}:removed`]);
  });

  it('the session ending clears it as ended', () => {
    tracker.session(P, true);
    tracker.guestFeed(P, guest());
    tracker.guestFeed(P, guest({ online: false }));
    vi.advanceTimersByTime(ISSUE_HOLDS.feed);
    tracker.session(P, false);
    expect(sent.at(-1)).toBe(`cleared:guest.feed.offline|${SLOT}:ended`);
  });

  it('renaming the slot updates the open issue', () => {
    tracker.session(P, true);
    tracker.guestFeed(P, guest());
    tracker.guestFeed(P, guest({ online: false }));
    vi.advanceTimersByTime(ISSUE_HOLDS.feed);
    tracker.guestFeed(P, guest({ online: false, name: 'Cam A' }));
    expect(sent.at(-1)).toBe(`updated:guest.feed.offline|${SLOT}`);
    expect(raised.at(-1)?.title).toBe('Guest feed "Cam A" lost');
  });
});

describe('guest.feed.codec', () => {
  it('raised at once for HEVC (session or not), cleared as recovered (H.264), ended (stopped) or removed (slot gone)', () => {
    tracker.guestFeed(P, guest({ problem: HEVC }));
    expect(sent).toEqual([`raised:guest.feed.codec|${SLOT}`]);
    expect(raised[0]).toMatchObject({ kind: 'guest.feed.codec', severity: 'warning', title: 'Guest feed "Remote cam 1" is HEVC' });
    tracker.guestFeed(P, guest({ problem: HEVC })); // a bitrate change: no second raise
    expect(sent).toHaveLength(1);
    tracker.guestFeed(P, guest());
    expect(sent.at(-1)).toBe(`cleared:guest.feed.codec|${SLOT}:recovered`);
    tracker.guestFeed(P, guest({ problem: HEVC }));
    tracker.guestFeed(P, guest({ online: false }));
    expect(sent.at(-1)).toBe(`cleared:guest.feed.codec|${SLOT}:ended`);
    tracker.guestFeed(P, guest({ problem: HEVC }));
    tracker.guestRemoved(P, SLOT, true);
    expect(sent.at(-1)).toBe(`cleared:guest.feed.codec|${SLOT}:removed`);
  });

  it('a non-blocking problem (Opus audio) is not an issue', () => {
    tracker.guestFeed(P, guest({ problem: { blocking: false, label: 'Opus', message: '…' } }));
    expect(sent).toEqual([]);
  });

  it('a deleted profile takes its guest issues along', () => {
    tracker.guestFeed(P, guest({ problem: HEVC }));
    tracker.forgetProfile(P);
    expect(cleared.at(-1)).toMatchObject({ id: `guest.feed.codec|${SLOT}`, resolution: 'removed' });
  });
});
