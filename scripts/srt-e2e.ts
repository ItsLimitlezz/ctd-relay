// SRT end to end (docs/SRT.md) with a real MediaMTX and FFmpeg, through Relay's own MediaServer,
// auth hook and pull links:
//   - OBS-style SRT publish (MPEG-TS, H.264 + AAC) with a profile key and a guest key; the auth matrix
//   - Relay's internals on an SRT-published feed: feed state + codec, a push, a thumbnail, LL-HLS
//   - SRT pull links: read key only, reader cap across RTMP + SRT, rotate and revoke disconnect
//   - the delay added through Relay: RTMP→RTMP vs SRT→SRT vs RTMP→SRT (publisher PTS = wall clock,
//     reader stamps each decoded frame on arrival)
//
//   npm run setup-tools && npx tsx scripts/srt-e2e.ts        (SRT_E2E_MEASURE_SEC=12 to measure longer)

import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { srtPublishUrlFromStreamKey, srtUrl } from '../shared/srt.js';
import { DEFAULT_PROFILE_ID, type FeedState } from '../shared/types.js';
import { grabWithFfmpeg } from '../server/src/api/previews.js';
import { loadConfig } from '../server/src/config.js';
import { openDatabase } from '../server/src/db/database.js';
import { createRepos } from '../server/src/db/repos.js';
import { EventBus, type PushEvent } from '../server/src/events.js';
import { createPushSupervisor } from '../server/src/media/ffmpeg-supervisor.js';
import { createMediaServer, udpPortFree } from '../server/src/media/mediamtx.js';
import { PullLinks, type PullTarget } from '../server/src/media/pull-links.js';
import { createSecretBox } from '../server/src/security/secretbox.js';

type Proc = ChildProcess & { tail: string[] };
const children = new Set<ChildProcess>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function freeUdpPort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const p = 20_000 + Math.floor(Math.random() * 20_000);
    if (await udpPortFree(p)) return p;
  }
  throw new Error('no free UDP port');
}

function ffmpeg(bin: string, args: string[], onLine?: (line: string) => void): Proc {
  const child = spawn(bin, ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }) as Proc;
  child.tail = [];
  child.stderr?.setEncoding('utf8');
  let buf = '';
  child.stderr?.on('data', (d: string) => {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const l of lines) {
      if (!l || l.includes('SRT.in: @')) continue; // libsrt's harmless "INVALID SIZE" chatter
      onLine?.(l);
      child.tail.push(l);
    }
    child.tail.splice(0, Math.max(0, child.tail.length - 30));
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

function exitCode(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function waitFor<T>(bus: EventBus, event: 'feed' | 'push', match: (v: T) => boolean, timeoutMs: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`));
    }, timeoutMs);
    const off = bus.on(event, ((v: T) => {
      if (!match(v)) return;
      clearTimeout(timer);
      off();
      resolve(v);
    }) as never);
  });
}

async function until(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
    await sleep(100);
  }
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  process.stdout.write(`- ${name} ... `);
  try {
    const result = await fn();
    console.log(`ok (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    return result;
  } catch (err) {
    console.log('FAILED');
    throw err;
  }
}

/**
 * Test pattern, like OBS at low delay: x264 zerolatency (no B-frames), 1 s keyframes, AAC.
 * `-output_ts_offset <now>` makes PTS = wall clock (seconds since the epoch), so a reader can tell how
 * late each frame arrives. MPEG-TS gets `-muxdelay 0` (else FFmpeg shifts PTS by 0.7 s).
 */
function pattern(url: string, format: 'flv' | 'mpegts', extra: string[] = []): string[] {
  const ts = format === 'mpegts' ? ['-muxdelay', '0', '-muxpreload', '0', '-pkt_size', '1316'] : [];
  return [
    '-loglevel', 'error', '-re',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=700',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-bf', '0', '-g', '30', '-pix_fmt', 'yuv420p', '-b:v', '3000k',
    '-c:a', 'aac', '-b:a', '128k',
    '-output_ts_offset', (Date.now() / 1000).toFixed(3),
    ...extra, ...ts, '-f', format, url,
  ];
}

/** Read a URL and stamp every decoded frame: lateness = arrival wall clock − PTS (ms). */
function measure(bin: string, url: string, seconds: number): Promise<number[]> {
  const late: number[] = [];
  const reader = ffmpeg(bin, ['-loglevel', 'info', '-fflags', 'nobuffer', '-flags', 'low_delay', '-copyts', '-i', url, '-map', '0:v', '-vf', 'showinfo', '-t', String(seconds), '-f', 'null', '-'], (line) => {
    const m = /pts_time:([\d.]+)/.exec(line);
    if (m) late.push(Date.now() - Number(m[1]) * 1000);
  });
  return exitCode(reader, (seconds + 20) * 1000).then(() => late);
}

function stats(late: number[]): string {
  const steady = late.slice(Math.floor(late.length / 3)).sort((a, b) => a - b); // after the reader caught up
  if (steady.length === 0) return 'no frames';
  const q = (f: number) => steady[Math.min(steady.length - 1, Math.floor(f * steady.length))]!;
  return `median ${q(0.5).toFixed(0)} ms, p10 ${q(0.1).toFixed(0)} ms, p90 ${q(0.9).toFixed(0)} ms (${steady.length} frames)`;
}

async function run(): Promise<void> {
  const [rtmpPort, apiPort, hlsPort, platformPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const srtPort = await freeUdpPort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctd-srt-'));
  const config = loadConfig({
    DATA_DIR: dataDir,
    RTMP_PORT: String(rtmpPort),
    SRT_PORT: String(srtPort),
    MEDIAMTX_API_PORT: String(apiPort),
    MEDIAMTX_HLS_PORT: String(hlsPort),
    MEDIAMTX_BIN: process.env.MEDIAMTX_BIN,
    FFMPEG_BIN: process.env.FFMPEG_BIN,
    TLS_MODE: 'off',
  });
  for (const bin of [config.mediamtxBin, config.ffmpegBin]) {
    if (!existsSync(bin)) throw new Error(`${bin} not found; run \`npm run setup-tools\` first`);
  }
  const ff = config.ffmpegBin;
  const log = pino({ level: process.env.SRT_E2E_LOG ?? 'warn' });
  const bus = new EventBus();
  const repos = createRepos(openDatabase(':memory:'), createSecretBox(crypto.randomBytes(32)));
  const pull = new PullLinks({
    secrets: repos.secrets,
    log,
    maxReaders: 2,
    guestProfileOf: () => null,
    slugOf: (id) => (id === DEFAULT_PROFILE_ID ? null : undefined),
    profileOfSlug: (slug) => (slug === null ? DEFAULT_PROFILE_ID : null),
  });
  await pull.load();
  const media = createMediaServer({ config, bus, log: log.child({ mod: 'mediamtx' }), repos, pull });
  const pushes = createPushSupervisor({ config, bus, log: log.child({ mod: 'ffmpeg' }), media, repos });
  const host = '127.0.0.1';
  const rtmp = `rtmp://${host}:${rtmpPort}`;
  const srt = (mode: 'publish' | 'read', p: string, key: string) => srtUrl(host, srtPort, mode, p, key);
  const isOnline = (f: FeedState) => f.profileId === DEFAULT_PROFILE_ID && f.feed === 'landscape' && f.online && !!f.video;
  const measureSec = Number(process.env.SRT_E2E_MEASURE_SEC ?? 8);
  const results: string[] = [];

  try {
    console.log(`MediaMTX ${config.mediamtxBin}\nFFmpeg   ${config.ffmpegBin}\nRTMP :${rtmpPort}, SRT :${srtPort}/udp, data ${dataDir}\n`);
    await step('start MediaServer with SRT on', async () => {
      await media.start();
      const s = media.srtStatus?.();
      if (!s?.enabled || s.port !== srtPort) throw new Error(`SRT status: ${JSON.stringify(s)}`);
    });
    const keys = await media.ingestKeys(DEFAULT_PROFILE_ID);
    const keyField = await media.streamKeyField(DEFAULT_PROFILE_ID, 'landscape');
    const obsSrtUrl = srtPublishUrlFromStreamKey(host, srtPort, media.appName, keyField)!;

    let publisher!: Proc;
    const feed = await step('OBS-style SRT publish (Server = srt://…?streamid=publish:live/landscape:key=…, MPEG-TS H.264+AAC) → feed online', async () => {
      const online = waitFor<FeedState>(bus, 'feed', isOnline, 30_000, 'landscape online');
      publisher = ffmpeg(ff, pattern(obsSrtUrl, 'mpegts'));
      return Promise.race([
        online,
        exitCode(publisher, 30_000).then((c) => {
          throw new Error(`publisher exited (${c}): ${publisher.tail.slice(-3).join(' | ')}`);
        }),
      ]);
    });
    console.log(`  feed: ${feed.video?.codec} ${feed.video?.width}x${feed.video?.height} ${feed.video?.fps ?? ''}fps, audio ${feed.audio?.codec ?? 'none'}`);
    if (feed.video?.codec !== 'h264' || feed.audio?.codec !== 'aac') throw new Error('codec guard: expected h264 + aac');

    await step('SRT publish refused: wrong key, no key, unknown path', async () => {
      for (const url of [srt('publish', 'live/landscape', 'wrongwrongwrongwrong'), `srt://${host}:${srtPort}?streamid=publish:live/landscape`, srt('publish', 'live/other', keys.landscape)]) {
        const bad = ffmpeg(ff, ['-t', '2', ...pattern(url, 'mpegts')]);
        if ((await exitCode(bad, 20_000)) === 0) throw new Error(`accepted: ${url.replace(/key=[^&]+/, 'key=…')}`);
      }
      if (!media.feed(DEFAULT_PROFILE_ID, 'landscape').online) throw new Error('the real publisher was kicked out');
    });

    await step('SRT read refused: ingest key, no key, pull link off', async () => {
      for (const url of [srt('read', 'live/landscape', keys.landscape), `srt://${host}:${srtPort}?streamid=read:live/landscape`]) {
        const r = ffmpeg(ff, ['-loglevel', 'error', '-i', url, '-t', '1', '-f', 'null', '-']);
        if ((await exitCode(r, 20_000)) === 0) throw new Error('read accepted');
      }
    });

    await step('internal read (thumbnail) of the SRT-published feed', async () => {
      const jpeg = await grabWithFfmpeg(ff, media.readUrl(DEFAULT_PROFILE_ID, 'landscape'));
      if (jpeg.length < 1000 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG');
    });

    await step('LL-HLS preview of the SRT-published feed (loopback, internal password)', async () => {
      const src = media.hlsSource?.(DEFAULT_PROFILE_ID, 'landscape');
      if (!src) throw new Error('no HLS source');
      let ok = false;
      for (let i = 0; i < 60 && !ok; i++) {
        const res = await fetch(`${src.baseUrl}index.m3u8`, { headers: { authorization: src.authorization } });
        ok = res.ok && (await res.text()).includes('#EXTM3U');
        if (!ok) await sleep(250);
      }
      if (!ok) throw new Error('no playlist');
    });

    await step('push (copy) of the SRT-published feed to an RTMP "platform"', async () => {
      const dest = repos.destinations.create({ profileId: DEFAULT_PROFILE_ID, platform: 'custom', accountId: null, name: 'SRT relay', feed: 'landscape', enabled: true, options: {}, ingestUrl: null }).id;
      const platformUrl = `rtmp://127.0.0.1:${platformPort}/app/testkey`;
      const platform = ffmpeg(ff, ['-loglevel', 'info', '-listen', '1', '-i', platformUrl, '-f', 'null', '-']);
      await sleep(1500);
      const running = waitFor<PushEvent>(bus, 'push', (e) => e.id === dest && e.status === 'running' && (e.stats?.bitrateKbps ?? 0) > 0, 30_000, 'push running');
      pushes.start(dest, { url: platformUrl, mode: 'copy', feeds: ['landscape'] });
      const ev = await running;
      console.log(`\n  push: ${ev.stats?.bitrateKbps} kbit/s, ${ev.stats?.fps} fps, speed ${ev.stats?.speed}x`);
      await pushes.stopAll();
      platform.kill('SIGKILL');
    });

    const target: PullTarget = { kind: 'feed', profileId: DEFAULT_PROFILE_ID, feed: 'landscape' };
    await step('SRT pull link: read key reads over SRT and RTMP; it never publishes', async () => {
      await pull.setEnabled(target, true);
      const info = pull.info(target, host, rtmpPort, media.srtStatus!());
      if (!info.srtUrl?.startsWith(`srt://${host}:${srtPort}?streamid=read:live/landscape:key=`)) throw new Error(`srtUrl ${info.srtUrl}`);
      const r = ffmpeg(ff, ['-loglevel', 'error', '-i', info.srtUrl, '-t', '2', '-f', 'null', '-']);
      if ((await exitCode(r, 20_000)) !== 0) throw new Error(`SRT pull read failed: ${r.tail.slice(-3).join(' | ')}`);
      const r2 = ffmpeg(ff, ['-loglevel', 'error', '-i', info.url!, '-t', '1', '-f', 'null', '-']);
      if ((await exitCode(r2, 20_000)) !== 0) throw new Error('RTMP pull read failed');
      const readKey = pull.readKey('live/landscape')!;
      const bad = ffmpeg(ff, ['-t', '2', ...pattern(srt('publish', 'live/landscape', readKey), 'mpegts')]);
      if ((await exitCode(bad, 20_000)) === 0) throw new Error('read key published over SRT');
    });

    await step('reader cap counts SRT + RTMP readers; rotate and revoke disconnect SRT readers', async () => {
      let info = pull.info(target, host, rtmpPort, media.srtStatus!());
      const a = ffmpeg(ff, ['-loglevel', 'error', '-i', info.srtUrl!, '-f', 'null', '-']);
      const b = ffmpeg(ff, ['-loglevel', 'error', '-i', info.url!, '-f', 'null', '-']);
      await until(() => pull.state(target).readers === 2, 15_000, '2 readers');
      const third = ffmpeg(ff, ['-loglevel', 'error', '-i', info.srtUrl!, '-t', '1', '-f', 'null', '-']);
      if ((await exitCode(third, 20_000)) === 0) throw new Error('a third (SRT) reader was let in');
      await pull.rotate(target);
      if ((await exitCode(a, 10_000)) === null || (await exitCode(b, 10_000)) === null) throw new Error('rotate did not disconnect');
      info = pull.info(target, host, rtmpPort, media.srtStatus!());
      const c = ffmpeg(ff, ['-loglevel', 'error', '-i', info.srtUrl!, '-f', 'null', '-']);
      await until(() => pull.state(target).readers === 1, 15_000, '1 reader');
      await pull.setEnabled(target, false);
      if ((await exitCode(c, 10_000)) === null) throw new Error('turning the link off did not disconnect');
    });

    // ---- delay through Relay ---------------------------------------------------------
    await pull.setEnabled(target, true);
    publisher.kill('SIGKILL');
    await sleep(1500);
    const runCase = async (name: string, pubUrl: string, format: 'flv' | 'mpegts', readUrl: () => string) => {
      await step(`measure ${name}`, async () => {
        const online = waitFor<FeedState>(bus, 'feed', isOnline, 30_000, 'online');
        const pub = ffmpeg(ff, pattern(pubUrl, format));
        await online;
        await sleep(1000);
        const late = await measure(ff, readUrl(), measureSec);
        pub.kill('SIGKILL');
        await until(() => !media.feed(DEFAULT_PROFILE_ID, 'landscape').online, 15_000, 'offline');
        results.push(`${name}: ${stats(late)}`);
      });
    };
    const info = () => pull.info(target, host, rtmpPort, media.srtStatus!());
    await runCase('RTMP → Relay → RTMP pull', `${rtmp}/live/landscape?key=${keys.landscape}`, 'flv', () => info().url!);
    await runCase('SRT → Relay → SRT pull (latency=150 ms)', obsSrtUrl, 'mpegts', () => info().srtUrl!);
    await runCase('RTMP → Relay → SRT pull', `${rtmp}/live/landscape?key=${keys.landscape}`, 'flv', () => info().srtUrl!);
    await runCase('SRT → Relay → RTMP pull', obsSrtUrl, 'mpegts', () => info().url!);
    // Baseline: the same publisher straight into a reader (SRT listener, no Relay): what FFmpeg itself adds.
    await step('measure baseline: SRT publisher → SRT reader directly (no Relay)', async () => {
      const port = await freeUdpPort();
      const listenUrl = `srt://127.0.0.1:${port}?mode=listener&latency=150000`;
      const lateP = measure(ff, listenUrl, measureSec);
      await sleep(800);
      const pub = ffmpeg(ff, ['-t', String(measureSec + 4), ...pattern(`srt://127.0.0.1:${port}?mode=caller&latency=150000`, 'mpegts')]);
      results.push(`baseline SRT direct (no Relay): ${stats(await lateP)}`);
      pub.kill('SIGKILL');
    });
    console.log('\nArrival minus publisher PTS (wall clock), steady state, loopback:');
    for (const r of results) console.log(`  ${r}`);
    console.log('\nPASS');
  } finally {
    await pushes.stopAll().catch(() => {});
    await media.stop().catch(() => {});
    for (const c of children) c.kill('SIGKILL');
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.stack : err);
    for (const c of children) c.kill('SIGKILL');
    process.exit(1);
  },
);
