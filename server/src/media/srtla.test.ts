// SRTLA (docs/SRTLA.md): env parsing, the endpoint helpers, the srtla_rec supervisor (off when the port
// is 0/taken, the binary is missing or SRT is off; restart with backoff; stop; redacted logs), the
// media server wiring and the auth matrix for loopback-forwarded publishes (the group cap, and that
// the internal reader and a guest route's one-time key can't be reached through srtla_rec).
// The real-binary end to end is scripts/srtla-e2e.ts (npm run e2e:srtla).

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { srtStatusOff, srtStatusOn } from '../../../shared/srt.js';
import {
  DEFAULT_SRTLA_MAX_GROUPS,
  DEFAULT_SRTLA_PORT,
  maskSrtlaSecret,
  srtlaEndpoint,
  srtlaEndpointFromStreamKey,
  srtlaStatusOn,
} from '../../../shared/srtla.js';
import { guestIngestInfo } from '../api/guest-feeds.js';
import { loadConfig, type AppConfig } from '../config.js';
import { openDatabase } from '../db/database.js';
import { createRepos } from '../db/repos.js';
import { EventBus } from '../events.js';
import { createSecretBox } from '../security/secretbox.js';
import type { MediaMtxAuthRequest } from '../services.js';
import { authorizeMediaRequest, type IngestAuthState } from './authorize.js';
import { createMediaServer } from './mediamtx.js';
import { createSrtlaReceiver, srtlaArgs } from './srtla.js';
import { captureLogger, fakeSpawn, flush } from './test-helpers.js';

const LAND = 'LandscapeKey_0123456789ab';
const VERT = 'VerticalKey_0123456789abc';
const READER = 'ReaderPass_0123456789abcd';
const GUEST = 'GuestIngestKey_0123456789';
const ROUTE = 'RouteOneTimeKey_012345678';
const SLOT = 'q7m2x9k4tb';

describe('SRTLA config', () => {
  it('defaults: port 5000, cap 4, ./tools/srtla_rec', () => {
    const c = loadConfig({});
    expect(c.srtlaPort).toBe(DEFAULT_SRTLA_PORT);
    expect(c.srtlaMaxGroups).toBe(DEFAULT_SRTLA_MAX_GROUPS);
    expect(c.srtlaBin).toBe(path.resolve('tools', process.platform === 'win32' ? 'srtla_rec.exe' : 'srtla_rec'));
  });
  it('SRTLA_PORT=0 turns it off; SRTLA_MAX_GROUPS and SRTLA_BIN are read', () => {
    const c = loadConfig({ SRTLA_PORT: '0', SRTLA_MAX_GROUPS: '2', SRTLA_BIN: '/opt/ctd/tools/srtla_rec' });
    expect(c.srtlaPort).toBe(0);
    expect(c.srtlaMaxGroups).toBe(2);
    expect(c.srtlaBin).toBe('/opt/ctd/tools/srtla_rec');
  });
  it('rejects a bad port or cap', () => {
    expect(() => loadConfig({ SRTLA_PORT: '70000' })).toThrow();
    expect(() => loadConfig({ SRTLA_MAX_GROUPS: '0' })).toThrow();
  });
  it('srtla_rec arguments: listen port, then the local MediaMTX SRT listener', () => {
    expect(srtlaArgs(5000, 8890)).toEqual(['5000', '127.0.0.1', '8890']);
  });
});

describe('SRTLA endpoint helpers', () => {
  it('BELABOX fields and the Moblin URL from an OBS stream key field', () => {
    const e = srtlaEndpointFromStreamKey('relay.example.com', 5000, 'live', `landscape?key=${LAND}`)!;
    expect(e).toEqual({
      host: 'relay.example.com',
      port: 5000,
      streamId: `publish:live/landscape:key=${LAND}`,
      url: `srtla://relay.example.com:5000?streamid=publish:live/landscape:key=${LAND}`,
    });
    expect(srtlaEndpointFromStreamKey('relay.example.com', 5000, 'live', `studio/vertical?key=${VERT}`)!.streamId).toBe(`publish:live/studio/vertical:key=${VERT}`);
    expect(srtlaEndpointFromStreamKey('relay.example.com', 5000, 'live', 'landscape')).toBeNull();
    expect(srtlaEndpoint('relay.example.com', 5000, `guest/${SLOT}`, GUEST).streamId).toBe(`publish:guest/${SLOT}:key=${GUEST}`);
  });
  it('masks the key', () => {
    expect(maskSrtlaSecret(`srtla://relay.example.com:5000?streamid=publish:live/landscape:key=${LAND}`)).not.toContain(LAND);
    expect(maskSrtlaSecret(`publish:live/landscape:key=${LAND}`)).toBe('publish:live/landscape:key=••••••••');
  });
  it('guest ingest details carry SRTLA next to SRT, and nothing when SRTLA is off or the key revoked', () => {
    const on = guestIngestInfo('relay.example.com', 1935, 'default', SLOT, GUEST, srtStatusOn(8890), srtlaStatusOn(5000));
    expect(on.srtla?.url).toBe(`srtla://relay.example.com:5000?streamid=publish:guest/${SLOT}:key=${GUEST}`);
    expect(on.srtlaStatus?.enabled).toBe(true);
    expect(guestIngestInfo('relay.example.com', 1935, 'default', SLOT, GUEST, srtStatusOn(8890)).srtla).toBeNull();
    expect(guestIngestInfo('relay.example.com', 1935, 'default', SLOT, null, srtStatusOn(8890), srtlaStatusOn(5000)).srtla).toBeNull();
  });
});

describe('srtla_rec supervisor', () => {
  const make = (over: { port?: number; exists?: boolean; free?: boolean } = {}) => {
    const sp = fakeSpawn();
    const cap = captureLogger();
    const rec = createSrtlaReceiver(
      { log: cap.log, bin: '/opt/ctd/tools/srtla_rec', port: over.port ?? 5000, maxGroups: 3 },
      { spawn: sp.spawn, udpPortFree: async () => over.free ?? true, binaryExists: async () => over.exists ?? true, restartMinMs: 1_000, restartMaxMs: 8_000 },
    );
    return { sp, rec, cap };
  };
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts srtla_rec on its port, forwarding to 127.0.0.1:<SRT_PORT>', async () => {
    const { sp, rec } = await make();
    await rec.start(srtStatusOn(8890));
    expect(sp.calls).toHaveLength(1);
    expect(sp.last()!.command).toBe('/opt/ctd/tools/srtla_rec');
    expect(sp.last()!.args).toEqual(['5000', '127.0.0.1', '8890']);
    expect(rec.status()).toEqual({ enabled: true, port: 5000, maxGroups: 3, linkCounts: false, reason: null });
    await rec.stop();
  });

  it('SRTLA_PORT=0: off, never spawns, says so', async () => {
    const { sp, rec } = make({ port: 0 });
    await rec.start(srtStatusOn(8890));
    expect(sp.calls).toHaveLength(0);
    expect(rec.status()).toMatchObject({ enabled: false, port: null });
    expect(rec.status().reason).toMatch(/SRTLA_PORT=0/);
  });

  it('SRT off: off, never spawns, gives SRT’s reason', async () => {
    const { sp, rec } = make();
    await rec.start(srtStatusOff('SRT is turned off on this server (SRT_PORT=0).'));
    expect(sp.calls).toHaveLength(0);
    expect(rec.status().reason).toMatch(/SRTLA needs SRT.*SRT_PORT=0/);
  });

  it('the same port as SRT: off', async () => {
    const { sp, rec } = make({ port: 8890 });
    await rec.start(srtStatusOn(8890));
    expect(sp.calls).toHaveLength(0);
    expect(rec.status().reason).toMatch(/both 8890/);
  });

  it('binary missing: off with a plain reason', async () => {
    const { sp, rec } = make({ exists: false });
    await rec.start(srtStatusOn(8890));
    expect(sp.calls).toHaveLength(0);
    expect(rec.status().reason).toMatch(/srtla_rec was not found.*setup-tools/);
  });

  it('port taken: off with a plain reason', async () => {
    const { sp, rec } = make({ free: false });
    await rec.start(srtStatusOn(8890));
    expect(sp.calls).toHaveLength(0);
    expect(rec.status().reason).toMatch(/UDP port 5000 is already in use/);
  });

  it('spawn fails with ENOENT: off, no retry loop', async () => {
    vi.useFakeTimers();
    const { sp, rec } = make();
    await rec.start(srtStatusOn(8890));
    sp.last()!.child.failToSpawn('ENOENT');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sp.calls).toHaveLength(1);
    expect(rec.status().enabled).toBe(false);
    expect(rec.status().reason).toMatch(/not found/);
  });

  it('restarts with backoff when it exits, and not after stop()', async () => {
    vi.useFakeTimers();
    const { sp, rec } = make();
    await rec.start(srtStatusOn(8890));
    sp.last()!.child.exit(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(sp.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sp.calls).toHaveLength(2); // 1 s
    sp.last()!.child.exit(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sp.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sp.calls).toHaveLength(3); // 2 s
    expect(rec.running()).toBe(true);
    const child = sp.last()!.child;
    await rec.stop();
    expect(child.signals).toContain('SIGTERM');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sp.calls).toHaveLength(3);
    expect(rec.running()).toBe(false);
  });

  it('logs its output through the redactor', async () => {
    const { sp, rec, cap } = make();
    await rec.start(srtStatusOn(8890));
    sp.last()!.child.stderr.write(`10.20.30.40:40000: group 0x5555 registered\nsomething failed key=${LAND} srt://relay.example.com:8890?streamid=publish:live/landscape:key=${LAND}\n`);
    await flush();
    await rec.stop();
    expect(cap.text()).toContain('group 0x5555 registered');
    expect(cap.text()).toContain('something failed');
    expect(cap.text()).not.toContain(LAND);
  });
});

describe('media server: SRTLA after MediaMTX', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ctd-srtla-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const start = async (over: { srtPort?: number; srtlaPort?: number; srtlaBin?: boolean; busy?: number[] } = {}) => {
    const bin = path.join(tmp, 'bin', 'mediamtx');
    const srtlaBin = path.join(tmp, 'bin', 'srtla_rec');
    await fs.mkdir(path.dirname(bin), { recursive: true });
    for (const b of [bin, srtlaBin]) {
      await fs.writeFile(b, '');
      await fs.chmod(b, 0o755);
    }
    if (over.srtlaBin === false) await fs.rm(srtlaBin);
    const config = { dataDir: tmp, rtmpPort: 1935, srtPort: over.srtPort ?? 8890, srtlaPort: over.srtlaPort ?? 5000, srtlaBin, mediamtxApiPort: 9997, mediamtxBin: bin } as AppConfig;
    const repos = createRepos(openDatabase(':memory:'), createSecretBox(crypto.randomBytes(32)));
    const sp = fakeSpawn();
    const server = createMediaServer(
      { config, bus: new EventBus(), log: pino({ level: 'silent' }), repos },
      {
        spawn: sp.spawn,
        fetch: (async () => new Response('{"items":[]}')) as unknown as typeof fetch,
        readyTimeoutMs: 0,
        pollIntervalMs: 50,
        udpPortFree: async (p) => !(over.busy ?? []).includes(p),
      },
    );
    await server.start();
    const commands = sp.calls.map((c) => path.basename(c.command));
    const status = server.srtlaStatus!();
    await server.stop();
    return { status, commands, srt: server.srtStatus!(), killed: sp.calls.every((c) => c.child.signals.length > 0) };
  };

  it('on: MediaMTX, then srtla_rec; both stopped on shutdown', async () => {
    const r = await start();
    expect(r.commands).toEqual(['mediamtx', 'srtla_rec']);
    expect(r.status).toMatchObject({ enabled: true, port: 5000 });
    expect(r.killed).toBe(true);
  });

  it('SRT port taken: SRT off, SRTLA off with the reason, MediaMTX (RTMP) as usual', async () => {
    const r = await start({ busy: [8890] });
    expect(r.commands).toEqual(['mediamtx']);
    expect(r.srt.enabled).toBe(false);
    expect(r.status.reason).toMatch(/SRTLA needs SRT/);
  });

  it('SRT_PORT=0: SRTLA off', async () => {
    const r = await start({ srtPort: 0 });
    expect(r.commands).toEqual(['mediamtx']);
    expect(r.status.reason).toMatch(/SRTLA needs SRT/);
  });

  it('SRTLA port taken or binary missing: SRTLA off, SRT on', async () => {
    const taken = await start({ busy: [5000] });
    expect(taken.commands).toEqual(['mediamtx']);
    expect(taken.srt.enabled).toBe(true);
    expect(taken.status.reason).toMatch(/UDP port 5000/);
    const missing = await start({ srtlaBin: false });
    expect(missing.commands).toEqual(['mediamtx']);
    expect(missing.status.reason).toMatch(/not found/);
  });
});

describe('auth: SRT publishes forwarded from loopback by srtla_rec', () => {
  const req = (over: Partial<MediaMtxAuthRequest>): MediaMtxAuthRequest => ({
    user: '',
    password: '',
    ip: '127.0.0.1',
    action: 'publish',
    path: 'live/landscape',
    protocol: 'srt',
    id: 'conn',
    query: `key=${LAND}`,
    ...over,
  });
  const state = (admit: (p: string) => boolean = () => true): IngestAuthState & { admitted: string[] } => {
    const admitted: string[] = [];
    return {
      admitted,
      readerPassword: READER,
      publishKey: (r) => (r.slug === null ? { landscape: LAND, vertical: VERT }[r.feed] : null),
      guestKey: (s) => (s === SLOT ? GUEST : null),
      guestExists: (s) => s === SLOT,
      routeKey: (r) => (r.slug === null && r.feed === 'vertical' ? ROUTE : null),
      srtlaAdmit: (p) => {
        admitted.push(p);
        return admit(p);
      },
    };
  };

  it('the right key publishes a profile feed or a guest slot, and takes a group slot', () => {
    const s = state();
    expect(authorizeMediaRequest(req({}), s)).toBe(true);
    expect(authorizeMediaRequest(req({ path: `guest/${SLOT}`, query: `key=${GUEST}` }), s)).toBe(true);
    expect(s.admitted).toEqual(['live/landscape', `guest/${SLOT}`]);
  });

  it('a wrong, missing or other feed’s key is refused, and never takes a slot', () => {
    const s = state();
    for (const r of [req({ query: 'key=wrongwrongwrongwrong' }), req({ query: '' }), req({ query: `key=${VERT}` }), req({ path: `guest/${SLOT}`, query: `key=${LAND}` }), req({ path: 'live/other/landscape' })]) {
      expect(authorizeMediaRequest(r, s)).toBe(false);
    }
    expect(s.admitted).toEqual([]);
  });

  it('the group cap refuses a bonded publish with a good key', () => {
    const s = state(() => false);
    expect(authorizeMediaRequest(req({}), s)).toBe(false);
    expect(authorizeMediaRequest(req({ path: `guest/${SLOT}`, query: `key=${GUEST}` }), s)).toBe(false);
  });

  it('the cap only applies to SRT from loopback (RTMP from OBS on the server, SRT from the LAN are not bonded)', () => {
    const s = state(() => false);
    expect(authorizeMediaRequest(req({ protocol: 'rtmp' }), s)).toBe(true);
    expect(authorizeMediaRequest(req({ ip: '10.20.30.40' }), s)).toBe(true);
    expect(s.admitted).toEqual([]);
  });

  it('a guest route’s one-time key never publishes over SRT, even from loopback', () => {
    const s = state();
    expect(authorizeMediaRequest(req({ path: 'live/vertical', query: `key=${ROUTE}` }), s)).toBe(false);
    // Relay's own FFmpeg (RTMP from loopback) still can; from elsewhere it can't.
    expect(authorizeMediaRequest(req({ path: 'live/vertical', query: `key=${ROUTE}`, protocol: 'rtmp' }), s)).toBe(true);
    expect(authorizeMediaRequest(req({ path: 'live/vertical', query: `key=${ROUTE}`, protocol: 'rtmp', ip: '10.20.30.40' }), s)).toBe(false);
  });

  it('the internal reader password never reads over SRT, even from loopback (streamid read:<path>:internal:<pass>)', () => {
    const s = state();
    for (const path of ['live/landscape', `guest/${SLOT}`]) {
      expect(authorizeMediaRequest(req({ action: 'read', path, query: '', user: 'internal', password: READER }), s)).toBe(false);
      expect(authorizeMediaRequest(req({ action: 'read', path, query: '', user: 'internal', password: READER, protocol: 'rtmp' }), s)).toBe(true);
      expect(authorizeMediaRequest(req({ action: 'read', path, query: '', user: 'internal', password: READER, protocol: 'hls' }), s)).toBe(true);
    }
  });

  it('loopback alone grants nothing over SRT: no key, no read, no other action', () => {
    const s = state();
    expect(authorizeMediaRequest(req({ query: '' }), s)).toBe(false);
    expect(authorizeMediaRequest(req({ action: 'read', query: '' }), s)).toBe(false);
    expect(authorizeMediaRequest(req({ action: 'read' }), s)).toBe(false); // an ingest key never reads
    expect(authorizeMediaRequest(req({ action: 'api', query: '' }), s)).toBe(false);
  });
});

describe('media server: the SRTLA group cap', () => {
  it('admits SRTLA_MAX_GROUPS bonded paths, refuses the next, and frees a slot once its publisher is gone', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ctd-srtla-cap-'));
    try {
      let t = 1_000_000;
      const config = { dataDir: tmp, rtmpPort: 1935, srtPort: 8890, srtlaPort: 5000, srtlaMaxGroups: 1, mediamtxApiPort: 9997, mediamtxBin: path.join(tmp, 'none') } as AppConfig;
      const repos = createRepos(openDatabase(':memory:'), createSecretBox(crypto.randomBytes(32)));
      const fakeSrtla = { start: async () => {}, stop: async () => {}, status: () => srtlaStatusOn(5000, 1), running: () => true };
      const server = createMediaServer({ config, bus: new EventBus(), log: pino({ level: 'silent' }), repos }, { srtla: fakeSrtla, now: () => t, readyTimeoutMs: 0 });
      await server.start(); // no MediaMTX binary: keys load, nothing spawns
      const keys = await server.ingestKeys('default');
      const bonded = (feed: 'landscape' | 'vertical', key: string) =>
        server.authorize({ user: '', password: '', ip: '127.0.0.1', action: 'publish', path: `live/${feed}`, protocol: 'srt', id: 'c', query: `key=${key}` });
      expect(bonded('landscape', keys.landscape)).toBe(true);
      expect(bonded('landscape', keys.landscape)).toBe(true); // the same sender reconnecting keeps its slot
      expect(bonded('vertical', keys.vertical)).toBe(false); // cap 1
      // SRT from the LAN is not bonded: not capped.
      expect(server.authorize({ user: '', password: '', ip: '10.20.30.40', action: 'publish', path: 'live/vertical', protocol: 'srt', id: 'c', query: `key=${keys.vertical}` })).toBe(true);
      t += 16_000; // not seen in MediaMTX's SRT connections since: the slot is free again
      expect(bonded('vertical', keys.vertical)).toBe(true);
      await server.stop();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
