// End to end with a real MediaMTX and FFmpeg (docs/GUEST-FEEDS.md → Pull link): a "guest" publishes
// to guest/<slot> with its ingest key; a "player" (FFmpeg, as OBS's Media Source and VLC use it)
// reads rtmp://…/guest/<slot>?key=<read key> through Relay's real auth hook. Skipped when the tools
// aren't there: run `npm run setup-tools` (./tools) or set MEDIAMTX_BIN and FFMPEG_BIN.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAuthServer, type AuthServer } from './auth-server.js';
import { authorizeMediaRequest, type IngestAuthState } from './authorize.js';
import { createMediaMtxApi } from './mediamtx-api.js';
import { buildMediaMtxConfig } from './mediamtx-config.js';
import { PullLinks, type PullTarget } from './pull-links.js';
import { memorySecrets } from './test-helpers.js';

const exe = process.platform === 'win32' ? '.exe' : '';
const FFMPEG = process.env.FFMPEG_BIN || path.resolve('tools', `ffmpeg${exe}`);
const MEDIAMTX = process.env.MEDIAMTX_BIN || path.resolve('tools', `mediamtx${exe}`);
const available = existsSync(FFMPEG) && existsSync(MEDIAMTX);

const SLOT = 'pulltest01';
const INGEST_KEY = 'ingestKeyForTheGuest_0123';
const READER_PASSWORD = 'internalReaderPassword_01';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** `ffmpeg -i <url> -t <sec> -f null -`: what a player does. Resolves with the exit code. */
function play(url: string, seconds: number, timeoutMs = 20_000): Promise<number> {
  return new Promise((resolve) => {
    execFile(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-rw_timeout', '8000000', '-i', url, '-t', String(seconds), '-c', 'copy', '-f', 'null', '-'], { timeout: timeoutMs, windowsHide: true }, (err) =>
      resolve(err ? ((err as { code?: number }).code ?? 1) : 0),
    );
  });
}

/** A player that keeps reading until it is killed or disconnected. */
function longPlayer(url: string): ChildProcess {
  return spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', url, '-c', 'copy', '-f', 'null', '-'], { stdio: 'ignore', windowsHide: true });
}

function exitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!available)('pull links with a real MediaMTX and FFmpeg', () => {
  const log = pino({ level: 'silent' });
  const target: PullTarget = { kind: 'guest', profileId: 'default', slot: SLOT };
  let dir: string;
  let mtx: ChildProcess;
  let publisher: ChildProcess;
  let auth: AuthServer;
  let rtmpPort: number;
  let pull: PullLinks;
  let poll: NodeJS.Timeout;
  const base = () => `rtmp://127.0.0.1:${rtmpPort}/guest/${SLOT}`;
  const readKey = () => pull.readKey(`guest/${SLOT}`)!;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctd-pull-'));
    rtmpPort = await freePort();
    const apiPort = await freePort();
    const mem = memorySecrets();
    pull = new PullLinks({
      secrets: { scoped: () => mem },
      log,
      maxReaders: 2,
      guestProfileOf: (slot) => (slot === SLOT ? 'default' : null),
      slugOf: () => null,
      profileOfSlug: (slug) => (slug === null ? 'default' : null),
    });
    await pull.load();
    const state: IngestAuthState = {
      readerPassword: READER_PASSWORD,
      publishKey: () => null,
      guestKey: (slot) => (slot === SLOT ? INGEST_KEY : null),
      guestExists: (slot) => slot === SLOT,
      pullKey: (p) => pull.readKey(p),
      pullAdmit: (p) => pull.admit(p),
    };
    auth = await startAuthServer({ authorize: (req) => authorizeMediaRequest(req, state), log });
    const cfg = path.join(dir, 'mediamtx.yml');
    await fs.writeFile(cfg, buildMediaMtxConfig({ rtmpPort, apiPort, authPort: auth.port, logLevel: 'error' }));
    mtx = spawn(MEDIAMTX, [cfg], { stdio: 'ignore', cwd: dir, windowsHide: true });
    const api = createMediaMtxApi(apiPort);
    pull.attachMedia({ listConns: () => api.listRtmpConns!(), kickConn: (id) => api.kickRtmpConn!(id) });
    for (let i = 0; i < 50; i++) {
      try {
        await api.listPaths();
        break;
      } catch {
        await sleep(100);
      }
    }
    publisher = spawn(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-c:a', 'aac', '-f', 'flv', `rtmp://127.0.0.1:${rtmpPort}/guest/${SLOT}?key=${INGEST_KEY}`],
      { stdio: 'ignore', windowsHide: true },
    );
    for (let i = 0; i < 100; i++) {
      const p = (await api.listPaths().catch(() => [])).find((x) => x.name === `guest/${SLOT}`);
      if (p?.ready) break;
      await sleep(100);
    }
    // The media server's poll: count readers once a second.
    poll = setInterval(() => {
      const at = Date.now();
      void api.listRtmpConns!().then((c) => pull.apply(c, at)).catch(() => {});
    }, 500);
  }, 30_000);

  afterAll(async () => {
    clearInterval(poll);
    publisher?.kill('SIGKILL');
    mtx?.kill('SIGKILL');
    await auth?.close();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('refuses every read while the pull link is off', async () => {
    expect(await play(`${base()}?key=${INGEST_KEY}`, 1)).not.toBe(0);
    expect(await play(base(), 1)).not.toBe(0);
  }, 30_000);

  it('plays with the read key (rtmp://host:port/guest/<slot>?key=<read key>), and only with it', async () => {
    await pull.setEnabled(target, true);
    const info = pull.info(target, '127.0.0.1', rtmpPort);
    expect(info.url).toBe(`${base()}?key=${readKey()}`);
    expect(await play(info.url!, 3)).toBe(0);
    expect(await play(`${base()}?key=${INGEST_KEY}`, 1)).not.toBe(0); // the ingest key never reads
    expect(await play(`${base()}?key=wrongwrongwrongwrong`, 1)).not.toBe(0);
    expect(await play(base(), 1)).not.toBe(0);
  }, 60_000);

  it('never lets the read key publish', async () => {
    const code = await new Promise<number>((resolve) => {
      execFile(
        FFMPEG,
        ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'flv', `${base()}?key=${readKey()}`],
        { timeout: 20_000 },
        (err) => resolve(err ? ((err as { code?: number }).code ?? 1) : 0),
      );
    });
    expect(code).not.toBe(0);
  }, 30_000);

  it('caps concurrent readers, and rotating the key disconnects them', async () => {
    const url = pull.info(target, '127.0.0.1', rtmpPort).url!;
    const a = longPlayer(url);
    const b = longPlayer(url);
    for (let i = 0; i < 40 && pull.state(target).readers < 2; i++) await sleep(250);
    expect(pull.state(target).readers).toBe(2);
    expect(await play(url, 1)).not.toBe(0); // a third reader is refused

    await pull.rotate(target);
    expect(await exitedWithin(a, 8_000)).toBe(true);
    expect(await exitedWithin(b, 8_000)).toBe(true);
    expect(await play(url, 1)).not.toBe(0); // the old link is dead
    expect(await play(pull.info(target, '127.0.0.1', rtmpPort).url!, 2)).toBe(0);
  }, 90_000);

  it('turning it off (revoke) disconnects the readers', async () => {
    const url = pull.info(target, '127.0.0.1', rtmpPort).url!;
    const a = longPlayer(url);
    for (let i = 0; i < 40 && pull.state(target).readers < 1; i++) await sleep(250);
    expect(pull.state(target).readers).toBe(1);
    await pull.setEnabled(target, false);
    expect(await exitedWithin(a, 8_000)).toBe(true);
    expect(await play(url, 1)).not.toBe(0);
    expect(pull.state(target)).toEqual({ enabled: false, readers: 0, maxReaders: 2 });
  }, 60_000);
});
