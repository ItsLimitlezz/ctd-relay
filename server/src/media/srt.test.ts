// SRT (docs/SRT.md): config generation, the link helpers, the auth matrix for SRT publish/read as
// MediaMTX v1.21.2 sends them (protocol 'srt', the streamid's `key=…` part as `query`), pull links
// over SRT, and the media server turning SRT off when its UDP port is taken.
// The real-binary end to end is scripts/srt-e2e.ts (npm run e2e:srt).

import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SRT_PORT,
  maskSrtUrl,
  SRT_LATENCY_INTERNET_MS,
  SRT_LATENCY_LAN_MS,
  srtLatencyParam,
  srtPublishUrlFromStreamKey,
  srtStatusOff,
  srtStatusOn,
  srtUrl,
  withSrtLatency,
} from '../../../shared/srt.js';
import { guestIngestInfo } from '../api/guest-feeds.js';
import { loadConfig, type AppConfig } from '../config.js';
import { openDatabase } from '../db/database.js';
import { createRepos } from '../db/repos.js';
import { EventBus } from '../events.js';
import { createSecretBox } from '../security/secretbox.js';
import type { MediaMtxAuthRequest } from '../services.js';
import { authorizeMediaRequest, type IngestAuthState } from './authorize.js';
import { createMediaServer, udpPortFree } from './mediamtx.js';
import { buildMediaMtxConfig } from './mediamtx-config.js';
import { PullLinks, type PullTarget, type RtmpConn } from './pull-links.js';
import { fakeSpawn, memorySecrets } from './test-helpers.js';

const LAND = 'LandscapeKey_0123456789ab';
const VERT = 'VerticalKey_0123456789abc';
const READER = 'ReaderPass_0123456789abcd';
const GUEST = 'GuestIngestKey_0123456789';
const SLOT = 'q7m2x9k4tb';

describe('MediaMTX config with SRT', () => {
  const base = { rtmpPort: 1935, apiPort: 9997, authPort: 40000 };
  it('is off without an SRT port (unchanged)', () => {
    expect(buildMediaMtxConfig(base).split('\n')).toContain('srt: false');
  });
  it('listens on the SRT UDP port on every interface (OBS and readers are on the LAN or internet)', () => {
    const lines = buildMediaMtxConfig({ ...base, srtPort: 8890 }).split('\n');
    expect(lines).toContain('srt: true');
    expect(lines).toContain('srtAddress: ":8890"');
    expect(lines).not.toContain('srt: false');
    // Auth stays delegated to Relay for every protocol, RTMP is unchanged.
    expect(lines).toContain('authMethod: http');
    expect(lines).toContain('rtmp: true');
    // Only keys MediaMTX v1.21 knows (it rejects unknown ones).
    expect(lines.filter((l) => /^srt/.test(l)).map((l) => l.split(':')[0])).toEqual(['srt', 'srtAddress']);
  });
  it('rejects an invalid SRT port', () => {
    expect(() => buildMediaMtxConfig({ ...base, srtPort: 70000 })).toThrow(/srtPort/);
  });
  it('SRT_PORT: default 8890, 0 = off', () => {
    expect(loadConfig({}).srtPort).toBe(DEFAULT_SRT_PORT);
    expect(DEFAULT_SRT_PORT).toBe(8890);
    expect(loadConfig({ SRT_PORT: '0' }).srtPort).toBe(0);
    expect(loadConfig({ SRT_PORT: '9000' }).srtPort).toBe(9000);
  });
});

describe('SRT links', () => {
  it('latency= is in microseconds (FFmpeg libsrt / OBS)', () => {
    expect(srtLatencyParam(150)).toBe('latency=150000');
    expect(SRT_LATENCY_LAN_MS).toBeGreaterThanOrEqual(120);
    expect(SRT_LATENCY_LAN_MS).toBeLessThanOrEqual(200);
    expect(SRT_LATENCY_INTERNET_MS).toBeGreaterThan(SRT_LATENCY_LAN_MS);
  });
  it('builds publish/read streamids with the key as a query', () => {
    expect(srtUrl('relay.example.com', 8890, 'read', 'guest/abc', 'K')).toBe('srt://relay.example.com:8890?streamid=read:guest/abc:key=K&latency=150000');
  });
  it('turns an OBS stream key field into the SRT server address', () => {
    expect(srtPublishUrlFromStreamKey('relay.example.com', 8890, 'live', `landscape?key=${LAND}`)).toBe(
      `srt://relay.example.com:8890?streamid=publish:live/landscape:key=${LAND}&latency=150000`,
    );
    expect(srtPublishUrlFromStreamKey('h', 1, 'live', 'club/vertical?key=V')).toBe('srt://h:1?streamid=publish:live/club/vertical:key=V&latency=150000');
    expect(srtPublishUrlFromStreamKey('h', 1, 'guest', `${SLOT}?key=G`)).toBe(`srt://h:1?streamid=publish:guest/${SLOT}:key=G&latency=150000`);
    expect(srtPublishUrlFromStreamKey('h', 1, 'live', 'landscape')).toBeNull();
  });
  it('swaps the latency and masks the key', () => {
    const url = srtUrl('h', 1, 'read', 'live/landscape', 'SECRETKEY');
    expect(withSrtLatency(url, SRT_LATENCY_INTERNET_MS)).toBe('srt://h:1?streamid=read:live/landscape:key=SECRETKEY&latency=800000');
    expect(maskSrtUrl(url)).not.toContain('SECRETKEY');
    expect(maskSrtUrl(url)).toContain('latency=150000');
  });
  it('guest ingest details carry the SRT address only while SRT is on and the key is valid', () => {
    const on = guestIngestInfo('relay.example.com', 1935, 'default', SLOT, GUEST, srtStatusOn(8890));
    expect(on.srtUrl).toBe(`srt://relay.example.com:8890?streamid=publish:guest/${SLOT}:key=${GUEST}&latency=150000`);
    expect(on.srt?.enabled).toBe(true);
    expect(guestIngestInfo('h', 1935, 'default', SLOT, null, srtStatusOn(8890)).srtUrl).toBeNull();
    const off = guestIngestInfo('h', 1935, 'default', SLOT, GUEST, srtStatusOff('off'));
    expect(off.srtUrl).toBeNull();
    expect(off.srt?.reason).toBe('off');
  });
});

/** What MediaMTX v1.21.2 sends the auth hook for `streamid=<action>:<path>:<query>` (checked against the real binary). */
function srtReq(action: 'publish' | 'read', p: string, query: string, ip = '192.168.1.50'): MediaMtxAuthRequest {
  return { user: '', password: '', ip, action, path: p, protocol: 'srt', id: 'conn', query };
}

describe('SRT auth matrix (same rules as RTMP)', () => {
  const readKeys = new Map<string, string>([
    ['live/landscape', 'PullReadKey_landscape_01'],
    [`guest/${SLOT}`, 'PullReadKey_guestslot_01'],
  ]);
  let admitted = 0;
  let room = true;
  const state: IngestAuthState = {
    readerPassword: READER,
    publishKey: (r) => (r.slug === null ? (r.feed === 'landscape' ? LAND : VERT) : r.slug === 'club' ? 'ClubLandscapeKey_0123456' : null),
    guestKey: (slot) => (slot === SLOT ? GUEST : null),
    guestExists: (slot) => slot === SLOT,
    pullKey: (p) => readKeys.get(p) ?? null,
    pullAdmit: () => {
      admitted++;
      return room;
    },
  };
  const ok = (r: MediaMtxAuthRequest) => authorizeMediaRequest(r, state);

  it.each([
    ['landscape publish with its key', srtReq('publish', 'live/landscape', `key=${LAND}`), true],
    ['vertical publish with its key', srtReq('publish', 'live/vertical', `key=${VERT}`), true],
    ['another profile with its key', srtReq('publish', 'live/club/landscape', 'key=ClubLandscapeKey_0123456'), true],
    ['guest slot with its key (from the internet)', srtReq('publish', `guest/${SLOT}`, `key=${GUEST}`, '203.0.113.9'), true],
    ['wrong key', srtReq('publish', 'live/landscape', 'key=nope'), false],
    ['no key (streamid publish:live/landscape)', srtReq('publish', 'live/landscape', ''), false],
    ["the other feed's key", srtReq('publish', 'live/landscape', `key=${VERT}`), false],
    ['a guest key on a profile feed', srtReq('publish', 'live/landscape', `key=${GUEST}`), false],
    ['a profile key on a guest slot', srtReq('publish', `guest/${SLOT}`, `key=${LAND}`), false],
    ['unknown path', srtReq('publish', 'live/other', `key=${LAND}`), false],
    ['a read key never publishes (feed)', srtReq('publish', 'live/landscape', `key=${readKeys.get('live/landscape')}`), false],
    ['a read key never publishes (guest)', srtReq('publish', `guest/${SLOT}`, `key=${readKeys.get(`guest/${SLOT}`)}`), false],
  ])('publish: %s', (_name, r, expected) => {
    expect(ok(r)).toBe(expected);
  });

  it.each([
    ['feed with its pull read key', srtReq('read', 'live/landscape', `key=${readKeys.get('live/landscape')}`), true],
    ['guest feed with its pull read key', srtReq('read', `guest/${SLOT}`, `key=${readKeys.get(`guest/${SLOT}`)}`, '203.0.113.9'), true],
    ['an ingest key never reads', srtReq('read', 'live/landscape', `key=${LAND}`), false],
    ['a guest ingest key never reads', srtReq('read', `guest/${SLOT}`, `key=${GUEST}`), false],
    ["another feed's read key", srtReq('read', 'live/vertical', `key=${readKeys.get('live/landscape')}`), false],
    ['pull link off (no read key for vertical)', srtReq('read', 'live/vertical', 'key=anything_at_all_123'), false],
    ['no key', srtReq('read', 'live/landscape', ''), false],
    ['the internal password from the LAN', { ...srtReq('read', 'live/landscape', ''), user: 'internal', password: READER }, false],
    ['the internal password from loopback (Relay itself)', { ...srtReq('read', 'live/landscape', '', '127.0.0.1'), user: 'internal', password: READER }, true],
  ])('read: %s', (_name, r, expected) => {
    expect(ok(r)).toBe(expected);
  });

  it('a read with the right key still needs room under the reader cap', () => {
    room = false;
    const before = admitted;
    expect(ok(srtReq('read', 'live/landscape', `key=${readKeys.get('live/landscape')}`))).toBe(false);
    expect(admitted).toBe(before + 1);
    room = true;
  });
});

describe('pull links over SRT', () => {
  const log = pino({ level: 'silent' });
  const target: PullTarget = { kind: 'feed', profileId: 'default', feed: 'landscape' };
  const make = async () => {
    const mem = memorySecrets();
    const kicked: string[] = [];
    const pull = new PullLinks({
      secrets: { scoped: () => mem },
      log,
      maxReaders: 2,
      guestProfileOf: () => null,
      slugOf: () => null,
      profileOfSlug: (s) => (s === null ? 'default' : null),
    });
    await pull.load();
    pull.attachMedia({ listConns: async () => [], kickConn: async (id) => (kicked.push(id), true) });
    return { pull, kicked };
  };

  it('the admin view has an SRT read link next to the RTMP one, only while the link and SRT are on', async () => {
    const { pull } = await make();
    expect(pull.info(target, 'relay.example.com', 1935, srtStatusOn(8890)).srtUrl).toBeNull(); // link off
    await pull.setEnabled(target, true);
    const key = pull.readKey('live/landscape')!;
    const info = pull.info(target, 'relay.example.com', 1935, srtStatusOn(8890));
    expect(info.url).toBe(`rtmp://relay.example.com:1935/live/landscape?key=${key}`);
    expect(info.srtUrl).toBe(`srt://relay.example.com:8890?streamid=read:live/landscape:key=${key}&latency=150000`);
    expect(info.srt?.enabled).toBe(true);
    const off = pull.info(target, 'relay.example.com', 1935, srtStatusOff('SRT is turned off on this server (SRT_PORT=0).'));
    expect(off.srtUrl).toBeNull();
    expect(off.srt?.reason).toContain('SRT_PORT=0');
  });

  it('counts SRT readers with RTMP readers under one cap and kicks the newest and stale ones', async () => {
    const { pull, kicked } = await make();
    await pull.setEnabled(target, true);
    const key = pull.readKey('live/landscape')!;
    const conn = (id: string, created: string, k = key): RtmpConn => ({ id, state: 'read', path: 'live/landscape', query: `key=${k}`, created });
    await pull.apply(
      [
        conn('rtmp-1', '2026-11-25T10:00:00Z'),
        conn('srt:a', '2026-11-25T10:00:01Z'),
        conn('srt:b', '2026-11-25T10:00:02Z'),
        conn('srt:old', '2026-11-25T09:00:00Z', 'OldRotatedKey_0123456789'),
        { id: 'srt:pub', state: 'publish', path: 'live/landscape', query: `key=${LAND}` },
      ],
      0,
    );
    expect(pull.state(target).readers).toBe(2);
    expect(kicked.sort()).toEqual(['srt:b', 'srt:old']);
  });
});

describe('media server: SRT on, or off when its UDP port is taken', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ctd-srt-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const start = async (srtPort: number, free: boolean) => {
    const bin = path.join(tmp, 'bin', 'mediamtx');
    await fs.mkdir(path.dirname(bin), { recursive: true });
    await fs.writeFile(bin, '');
    await fs.chmod(bin, 0o755);
    const config = { dataDir: tmp, rtmpPort: 1935, srtPort, mediamtxApiPort: 9997, mediamtxBin: bin } as AppConfig;
    const repos = createRepos(openDatabase(':memory:'), createSecretBox(crypto.randomBytes(32)));
    const sp = fakeSpawn();
    const server = createMediaServer(
      { config, bus: new EventBus(), log: pino({ level: 'silent' }), repos },
      { spawn: sp.spawn, fetch: (async () => new Response('{"items":[]}')) as unknown as typeof fetch, readyTimeoutMs: 0, pollIntervalMs: 50, udpPortFree: async () => free },
    );
    await server.start();
    const yml = await fs.readFile(path.join(tmp, 'mediamtx', 'mediamtx.yml'), 'utf8');
    await server.stop();
    return { status: server.srtStatus!(), yml, spawned: sp.calls.length };
  };

  it('SRT on: srt: true in the config, status enabled with the port', async () => {
    const r = await start(8890, true);
    expect(r.yml).toContain('srt: true');
    expect(r.yml).toContain('srtAddress: ":8890"');
    expect(r.status).toMatchObject({ enabled: true, port: 8890, reason: null });
  });

  it('port taken: SRT off with a plain reason, MediaMTX (RTMP) still starts', async () => {
    const r = await start(8890, false);
    expect(r.yml).toContain('srt: false');
    expect(r.yml).toContain('rtmp: true');
    expect(r.spawned).toBe(1);
    expect(r.status.enabled).toBe(false);
    expect(r.status.reason).toMatch(/UDP port 8890 is already in use/);
  });

  it('SRT_PORT=0: off, and says so', async () => {
    const r = await start(0, true);
    expect(r.yml).toContain('srt: false');
    expect(r.status.reason).toMatch(/SRT_PORT=0/);
  });

  it('udpPortFree sees a bound UDP port', async () => {
    const sock = dgram.createSocket('udp4');
    await new Promise<void>((r) => sock.bind(0, () => r()));
    const port = sock.address().port;
    expect(await udpPortFree(port)).toBe(false);
    sock.close();
  });
});
