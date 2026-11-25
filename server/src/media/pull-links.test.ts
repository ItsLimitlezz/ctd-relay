// Pull links (docs/GUEST-FEEDS.md → Pull link): the auth hook matrix, the reader cap, rotate/revoke.
// The end-to-end check with a real MediaMTX and FFmpeg is pull-links.integration.test.ts.

import { describe, expect, it } from 'vitest';
import type { MediaMtxAuthRequest } from '../services.js';
import { authorizeMediaRequest, type IngestAuthState } from './authorize.js';
import { PULL_SECRET_SCOPE, PullLinks, type PullTarget, type RtmpConn } from './pull-links.js';
import { captureLogger, memorySecrets } from './test-helpers.js';

const SLOT = 'abcdefghij';
const OTHER_SLOT = 'zzzzzzzzzz';
const INGEST = 'guestIngestKey_000000001';
const OBS_KEY = 'obsLandscapeKey_00000001';
const READER = 'internalReaderPass_00001';
const LAN_IP = '192.0.2.10';

function setup(maxReaders = 2) {
  const mem = memorySecrets();
  const { log, text } = captureLogger();
  let t = 1_000_000;
  const kicked: string[] = [];
  let conns: RtmpConn[] = [];
  const pull = new PullLinks({
    secrets: { scoped: (scope) => (scope === PULL_SECRET_SCOPE ? mem : memorySecrets()) },
    log,
    maxReaders,
    guestProfileOf: (slot) => (slot === SLOT || slot === OTHER_SLOT ? 'default' : null),
    slugOf: (id) => (id === 'default' ? null : id === 'p2' ? 'show2' : undefined),
    profileOfSlug: (slug) => (slug === null ? 'default' : slug === 'show2' ? 'p2' : null),
    now: () => t,
  });
  pull.attachMedia({
    listConns: async () => conns,
    kickConn: async (id) => {
      kicked.push(id);
      conns = conns.filter((c) => c.id !== id);
      return true;
    },
  });
  const state: IngestAuthState = {
    readerPassword: READER,
    publishKey: (route) => (route.slug === null || route.slug === 'show2' ? OBS_KEY : null),
    guestKey: (slot) => (slot === SLOT || slot === OTHER_SLOT ? INGEST : null),
    guestExists: (slot) => slot === SLOT || slot === OTHER_SLOT,
    pullKey: (p) => pull.readKey(p),
    pullAdmit: (p) => pull.admit(p),
  };
  const ask = (action: MediaMtxAuthRequest['action'], path: string, query: string, extra: Partial<MediaMtxAuthRequest> = {}) =>
    authorizeMediaRequest({ user: '', password: '', ip: LAN_IP, action, path, protocol: 'rtmp', id: null, query, ...extra }, state);
  return {
    pull,
    mem,
    ask,
    kicked,
    logText: text,
    setConns: (c: RtmpConn[]) => (conns = c),
    advance: (ms: number) => (t += ms),
    now: () => t,
  };
}

const guest: PullTarget = { kind: 'guest', profileId: 'default', slot: SLOT };
const landscape: PullTarget = { kind: 'feed', profileId: 'default', feed: 'landscape' };

describe('pull links: auth hook matrix', () => {
  it('read/publish × read key / ingest key / wrong / none on a guest path', async () => {
    const s = setup();
    await s.pull.load();
    const path = `guest/${SLOT}`;
    // Off: no pull read at all, whatever the key.
    expect(s.ask('read', path, `key=${INGEST}`)).toBe(false);
    expect(s.ask('read', path, '')).toBe(false);

    await s.pull.setEnabled(guest, true);
    const rk = s.pull.readKey(path)!;
    expect(rk).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(rk).not.toBe(INGEST);

    expect(s.ask('read', path, `key=${rk}`)).toBe(true); // right read key
    expect(s.ask('read', path, `key=${INGEST}`)).toBe(false); // the ingest key never reads
    expect(s.ask('read', path, 'key=wrongwrongwrongwrong')).toBe(false);
    expect(s.ask('read', path, '')).toBe(false);
    expect(s.ask('read', path, `user=pull&pass=${rk}`)).toBe(false); // only ?key=

    expect(s.ask('publish', path, `key=${rk}`)).toBe(false); // the read key never publishes
    expect(s.ask('publish', path, `key=${INGEST}`)).toBe(true); // the guest still can
    expect(s.ask('publish', path, '')).toBe(false);

    // Another slot: its own (off) link; this slot's read key doesn't open it.
    expect(s.ask('read', `guest/${OTHER_SLOT}`, `key=${rk}`)).toBe(false);
    // Relay itself still reads (loopback, internal reader).
    expect(s.ask('read', path, `user=internal&pass=${READER}`, { ip: '127.0.0.1', user: 'internal', password: READER })).toBe(true);
    expect(s.logText()).not.toContain(rk);
  });

  it("a profile's own feed: its own read key, never the OBS key; other paths unchanged", async () => {
    const s = setup();
    await s.pull.load();
    expect(s.ask('read', 'live/landscape', `key=${OBS_KEY}`)).toBe(false);
    await s.pull.setEnabled(landscape, true);
    const rk = s.pull.readKey('live/landscape')!;
    expect(s.ask('read', 'live/landscape', `key=${rk}`)).toBe(true);
    expect(s.ask('read', 'live/landscape', `key=${OBS_KEY}`)).toBe(false);
    expect(s.ask('read', 'live/landscape', '')).toBe(false);
    expect(s.ask('publish', 'live/landscape', `key=${rk}`)).toBe(false);
    expect(s.ask('publish', 'live/landscape', `key=${OBS_KEY}`)).toBe(true);
    // Vertical has no link; the landscape read key doesn't open it, nor another profile's path.
    expect(s.ask('read', 'live/vertical', `key=${rk}`)).toBe(false);
    expect(s.ask('read', 'live/show2/landscape', `key=${rk}`)).toBe(false);
    // Anything else stays loopback/internal only, or denied.
    expect(s.ask('read', 'other/path', `key=${rk}`)).toBe(false);
    expect(s.ask('read', 'live/vertical', `user=internal&pass=${READER}`, { ip: LAN_IP, user: 'internal', password: READER })).toBe(false);
    expect(s.ask('read', 'live/vertical', `user=internal&pass=${READER}`, { ip: '127.0.0.1', user: 'internal', password: READER })).toBe(true);
    expect(s.ask('playback', 'live/landscape', `key=${rk}`)).toBe(false);
  });

  it('a non-default profile feed and an unknown slot', async () => {
    const s = setup();
    await s.pull.load();
    const p2: PullTarget = { kind: 'feed', profileId: 'p2', feed: 'vertical' };
    await s.pull.setEnabled(p2, true);
    const info = s.pull.info(p2, 'relay.example.com', 1935);
    expect(info.url).toMatch(/^rtmp:\/\/relay\.example\.com:1935\/live\/show2\/vertical\?key=[A-Za-z0-9_-]{24}$/);
    expect(s.ask('read', 'live/show2/vertical', info.url!.split('?')[1]!)).toBe(true);
    expect(s.ask('read', 'guest/unknown000', 'key=whatever')).toBe(false);
  });

  it('denies everything until the keys are loaded, and when the server turns pull links off', async () => {
    const s = setup();
    expect(s.pull.readKey(`guest/${SLOT}`)).toBeNull();
    const off = setup(0);
    await off.pull.load();
    await expect(off.pull.setEnabled(guest, true)).rejects.toMatchObject({ statusCode: 409, code: 'limit' });
  });
});

describe('pull links: keys', () => {
  it('stores the keys encrypted-at-rest in scope "pull" and reloads them', async () => {
    const s = setup();
    await s.pull.load();
    await s.pull.setEnabled(guest, true);
    const rk = s.pull.readKey(`guest/${SLOT}`);
    expect(JSON.parse(s.mem.data.get('readKeys')!)).toEqual({ [`guest:${SLOT}`]: rk });
    const again = new PullLinks({
      secrets: { scoped: () => s.mem },
      log: captureLogger().log,
      maxReaders: 2,
      guestProfileOf: () => 'default',
      slugOf: () => null,
      profileOfSlug: () => 'default',
    });
    await again.load();
    expect(again.readKey(`guest/${SLOT}`)).toBe(rk);
  });

  it('turning it on twice keeps the key; rotate makes a new one; forgetGuest drops it', async () => {
    const s = setup();
    await s.pull.load();
    await s.pull.setEnabled(guest, true);
    const first = s.pull.readKey(`guest/${SLOT}`);
    await s.pull.setEnabled(guest, true);
    expect(s.pull.readKey(`guest/${SLOT}`)).toBe(first);
    await s.pull.rotate(guest);
    expect(s.pull.readKey(`guest/${SLOT}`)).not.toBe(first);
    await s.pull.forgetGuest(SLOT);
    expect(s.pull.state(guest).enabled).toBe(false);
  });
});

describe('pull links: readers, cap, rotate and revoke', () => {
  const conn = (id: string, query: string, over: Partial<RtmpConn> = {}): RtmpConn => ({ id, state: 'read', path: `guest/${SLOT}`, query, created: `2026-11-25T10:00:0${id.slice(-1)}Z`, ...over });

  it('counts only pull readers with the current key; caps at maxReaders at auth time', async () => {
    const s = setup(2);
    await s.pull.load();
    await s.pull.setEnabled(guest, true);
    const rk = s.pull.readKey(`guest/${SLOT}`)!;
    const q = `key=${rk}`;
    expect(s.ask('read', `guest/${SLOT}`, q)).toBe(true);
    expect(s.ask('read', `guest/${SLOT}`, q)).toBe(true);
    expect(s.ask('read', `guest/${SLOT}`, q)).toBe(false); // two pending admits fill the cap

    const at = s.now();
    s.advance(500);
    await s.pull.apply(
      [
        conn('r1', q),
        conn('r2', q),
        conn('i1', `user=internal&pass=${READER}`), // Relay's own reader: not counted
        conn('p1', `key=${INGEST}`, { state: 'publish' }), // the guest
      ],
      at,
    );
    expect(s.pull.state(guest)).toEqual({ enabled: true, readers: 2, maxReaders: 2 });
    expect(s.ask('read', `guest/${SLOT}`, q)).toBe(false);
    expect(s.kicked).toEqual([]);

    // One leaves: room again.
    await s.pull.apply([conn('r1', q)], s.now());
    expect(s.pull.state(guest).readers).toBe(1);
    expect(s.ask('read', `guest/${SLOT}`, q)).toBe(true);
  });

  it('pending admits expire, and a reader that raced past the cap is disconnected (the newest)', async () => {
    const s = setup(1);
    await s.pull.load();
    await s.pull.setEnabled(guest, true);
    const q = `key=${s.pull.readKey(`guest/${SLOT}`)!}`;
    expect(s.ask('read', `guest/${SLOT}`, q)).toBe(true);
    expect(s.ask('read', `guest/${SLOT}`, q)).toBe(false);
    s.advance(5_000); // the admitted reader never showed up
    expect(s.ask('read', `guest/${SLOT}`, q)).toBe(true);

    await s.pull.apply([conn('r1', q), conn('r2', q)], s.now());
    expect(s.kicked).toEqual(['r2']);
    expect(s.pull.state(guest).readers).toBe(1);
  });

  it('rotating disconnects current readers (not the guest, not Relay); turning it off too', async () => {
    const s = setup();
    await s.pull.load();
    await s.pull.setEnabled(guest, true);
    const q = `key=${s.pull.readKey(`guest/${SLOT}`)!}`;
    const keep = [conn('i1', `user=internal&pass=${READER}`), conn('p1', `key=${INGEST}`, { state: 'publish' }), conn('x1', q, { path: `guest/${OTHER_SLOT}` })];
    s.setConns([conn('r1', q), conn('r2', q), ...keep]);
    await s.pull.rotate(guest);
    expect(s.kicked.sort()).toEqual(['r1', 'r2']);
    expect(s.ask('read', `guest/${SLOT}`, q)).toBe(false); // the old link is dead

    s.kicked.length = 0;
    const q2 = `key=${s.pull.readKey(`guest/${SLOT}`)!}`;
    s.setConns([conn('r3', q2), ...keep]);
    await s.pull.setEnabled(guest, false);
    expect(s.kicked).toEqual(['r3']);
    expect(s.pull.state(guest)).toEqual({ enabled: false, readers: 0, maxReaders: 2 });
    expect(s.ask('read', `guest/${SLOT}`, q2)).toBe(false);
    expect(s.logText()).not.toContain(q2.slice(4));
  });

  it('the poll disconnects a reader still holding an old key (a kick that failed)', async () => {
    const s = setup();
    await s.pull.load();
    await s.pull.setEnabled(guest, true);
    await s.pull.apply([conn('old', 'key=someOldKeyThatIsNoMore1')], s.now());
    expect(s.kicked).toEqual(['old']);
    expect(s.pull.state(guest).readers).toBe(0);
  });

  it('profile() lists every guest slot and both feeds without keys', async () => {
    const s = setup();
    await s.pull.load();
    await s.pull.setEnabled(landscape, true);
    const p = s.pull.profile('default', [SLOT]);
    expect(p).toEqual({
      profileId: 'default',
      maxReaders: 2,
      guestFeeds: { [SLOT]: { enabled: false, readers: 0, maxReaders: 2 } },
      feeds: { landscape: { enabled: true, readers: 0, maxReaders: 2 }, vertical: { enabled: false, readers: 0, maxReaders: 2 } },
    });
    expect(JSON.stringify(p)).not.toContain(s.pull.readKey('live/landscape')!);
  });
});
