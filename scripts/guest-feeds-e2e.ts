// Guest feeds with the real binaries (npm run e2e:guests): docs/GUEST-FEEDS.md.
//
//   1. Checks: the real MediaMTX accepts the generated config; a guest publishes to guest/<slot> with
//      its key (a wrong key, another slot's key and an OBS key are refused); Relay sees its state;
//      its LL-HLS plays through the live preview proxy code (on demand); rotating the key
//      disconnects it; no 'feed' event is ever emitted for it (nothing that pushes can see it).
//   2. Load (skip with --quick): can guests starve the main feeds? Two main feeds (6 + 4 Mbps) with
//      two copy readers (what a destination push does), then the same plus 4 guests at 8 Mbps with
//      2 LL-HLS players each through Relay's proxy code. Prints CPU of MediaMTX and Relay, and the
//      copy readers' speed and the main feeds' bitrate in each phase.
//
// Publishers send a pre-encoded clip with -c copy, so they cost almost nothing on the machine
// being measured. Needs `npm run setup-tools`. Linux only (CPU from /proc). Prints PASS/FAIL.

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pino from 'pino';
import { guestFeedProblem } from '../shared/feed-codec.js';
import { loadConfig } from '../server/src/config.js';
import { openDatabase } from '../server/src/db/database.js';
import { createGuestFeedsRepo } from '../server/src/db/guest-feeds-repo.js';
import { createRepos } from '../server/src/db/repos.js';
import { EventBus } from '../server/src/events.js';
import { DEFAULT_GUEST_LIMITS, GuestFeeds } from '../server/src/media/guest-feeds.js';
import { LivePreviewService } from '../server/src/media/live-preview.js';
import { createMediaServer } from '../server/src/media/mediamtx.js';
import { createSecretBox } from '../server/src/security/secretbox.js';

const quick = process.argv.includes('--quick');
const PHASE_SEC = Number(process.env.GUEST_E2E_PHASE_SEC ?? 40);
const children = new Set<ChildProcess>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function check(ok: boolean, what: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

async function until<T>(fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve(fn()).catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(250);
  }
}

function run(cmd: string, args: string[]): ChildProcess & { out: string[] } {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcess & { out: string[] };
  child.out = [];
  const keep = (d: Buffer) => {
    child.out.push(...d.toString().split(/[\r\n]+/).filter(Boolean));
    child.out.splice(0, Math.max(0, child.out.length - 200));
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

async function encodeClip(ffmpeg: string, file: string, size: string, kbps: number): Promise<void> {
  const p = run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps}k`,
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', file,
  ]);
  const code = await new Promise<number | null>((r) => p.on('exit', r));
  if (code !== 0) throw new Error(`encoding ${file} failed: ${p.out.join(' | ')}`);
}

/** A publisher that sends a clip in a loop, unchanged (costs ~nothing). */
function publishClip(ffmpeg: string, clip: string, url: string) {
  return run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-re', '-stream_loop', '-1', '-i', clip, '-c', 'copy', '-f', 'flv', url]);
}

/** What a destination push does to a feed (read it, -c copy), into the null muxer; reports speed. */
function copyReader(ffmpeg: string, url: string) {
  return run(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-stats_period', '2', '-progress', 'pipe:1', '-i', url, '-c', 'copy', '-f', 'null', '-']);
}

function lastSpeed(p: { out: string[] }): number | null {
  const lines = p.out.filter((l) => l.startsWith('speed='));
  const last = lines.at(-1);
  const m = last ? /speed=\s*([\d.]+)x/.exec(last) : null;
  return m ? Number(m[1]) : null;
}

function procStat(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return (Number(f[11]) + Number(f[12])) / 100;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const ffmpeg = path.resolve('tools/ffmpeg');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctd-guests-'));
  const [rtmpPort, apiPort, hlsPort] = [await freePort(), await freePort(), await freePort()];
  const config = loadConfig(
    {
      DATA_DIR: dataDir,
      RTMP_PORT: String(rtmpPort),
      MEDIAMTX_API_PORT: String(apiPort),
      MEDIAMTX_HLS_PORT: String(hlsPort),
      MEDIAMTX_BIN: 'tools/mediamtx',
      FFMPEG_BIN: 'tools/ffmpeg',
      LOG_LEVEL: 'warn',
    },
    '0.0.0-e2e',
  );
  const log = pino({ level: 'warn' });
  const db = openDatabase(path.join(dataDir, 'app.db'));
  const repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
  const bus = new EventBus();
  const feedEvents: string[] = [];
  bus.on('feed', (f) => feedEvents.push(f.feed));
  const guests = new GuestFeeds({ repo: createGuestFeedsRepo(db), secrets: repos.secrets, bus, log, limits: { ...DEFAULT_GUEST_LIMITS, maxViewers: 2 } });
  const media = createMediaServer({ config, bus, log, repos, guests }, { probe: null });

  console.log(`CTD Relay guest feeds e2e (${os.cpus().length} CPUs, ${os.cpus()[0]?.model ?? 'unknown CPU'})`);
  try {
    await media.start();
    const slots = [];
    for (let i = 1; i <= 4; i++) slots.push((await guests.create('default', `Guest ${i}`)).slot);
    const keyOf = async (slot: string) => (await guests.ingestKey('default', slot))!;
    const base = `rtmp://127.0.0.1:${rtmpPort}`;
    const guestUrl = async (slot: string, key?: string) => `${base}/guest/${slot}?key=${key ?? (await keyOf(slot))}`;
    const s0 = slots[0]!;

    const clips = path.join(dataDir, 'clips');
    await fs.mkdir(clips);
    await encodeClip(ffmpeg, path.join(clips, 'land.mp4'), '1920x1080', 6000);
    await encodeClip(ffmpeg, path.join(clips, 'vert.mp4'), '1080x1920', 4000);
    await encodeClip(ffmpeg, path.join(clips, 'guest.mp4'), '1920x1080', 8000);

    console.log('Checks');
    // Refused publishes first: wrong key, another slot's key, an OBS key.
    const obsKey = (await media.ingestKeys('default')).landscape;
    for (const [what, url] of [
      ['wrong key', await guestUrl(s0, 'wrongwrongwrongwrongwr')],
      ["another slot's key", await guestUrl(s0, await keyOf(slots[1]!))],
      ['an OBS stream key', await guestUrl(s0, obsKey)],
    ] as const) {
      const p = publishClip(ffmpeg, path.join(clips, 'guest.mp4'), url);
      const code = await Promise.race([new Promise<number | null>((r) => p.on('exit', r)), sleep(8000).then(() => 'running')]);
      check(code !== 'running' && guests.feed('default', s0)?.online !== true, `a guest publish with ${what} is refused`);
      p.kill('SIGKILL');
    }

    const g0 = publishClip(ffmpeg, path.join(clips, 'guest.mp4'), await guestUrl(s0));
    const on = await until(() => guests.feed('default', s0)?.online && guests.feed('default', s0), 15_000);
    check(!!on && on.video?.codec === 'h264' && on.video.width === 1920, `the guest is online with its tracks (${on ? `${on.video?.width}×${on.video?.height} ${on.video?.codec}` : 'offline'})`);
    const rate = await until(() => (guests.feed('default', s0)?.bitrateKbps ?? 0) > 1000 && guests.feed('default', s0)!.bitrateKbps, 10_000);
    check(!!rate, `bitrate measured (${rate ?? '?'} kbps)`);

    // LL-HLS through the live preview proxy code, on demand.
    const live = new LivePreviewService<string>({
      feed: (p, s) => guests.state(p, s) ?? { online: false, video: null, audio: null },
      source: (_p, s) => media.guestHlsSource?.(s) ?? null,
      problem: (state, s) => guestFeedProblem(state, guests.nameOf(s) ?? s),
      maxViewers: 2,
    });
    const muxers = async () => ((await (await fetch(`http://127.0.0.1:${apiPort}/v3/hlsmuxers/list`)).json()) as { items?: unknown[] }).items?.length ?? 0;
    check((await muxers()) === 0, 'no HLS muxer runs while nobody watches');
    const t0 = Date.now();
    const opened = await live.open('default', s0, 'e2e');
    check(opened.ok && opened.kind === 'playlist', `live.m3u8 opens a player (${Date.now() - t0} ms to the first playlist)`);
    if (opened.ok && opened.kind === 'playlist') {
      const href = /^live\/(\S+)\?v=(\S+)$/m.exec(opened.body);
      const media1 = href ? await live.file('default', s0, href[1]!, { v: href[2]! }, 'e2e') : null;
      const part = media1?.ok && media1.kind === 'playlist' ? /URI="([^"?]+)\?v=([^"]+)"/.exec(media1.body) : null;
      const chunk = part ? await live.file('default', s0, part[1]!, { v: part[2]! }, 'e2e') : null;
      let bytes = 0;
      if (chunk?.ok && chunk.kind === 'media') for await (const b of chunk.body) bytes += (b as Buffer).length;
      check(bytes > 0, `media playlist and an fMP4 part play through the proxy (${bytes} bytes)`);
      check(!opened.body.includes('session='), "MediaMTX's session id never reaches the player");
      check((await muxers()) === 1, 'one HLS muxer while someone watches');
      const third = [await live.open('default', s0, 'a'), await live.open('default', s0, 'b')].at(-1)!;
      check(!third.ok && third.code === 'viewer_cap', 'the viewer cap (2) refuses a third player');
    }

    // Rotating disconnects it; the old key stops working.
    const oldKey = await keyOf(s0);
    await guests.rotateKey('default', s0);
    const gone = await until(() => guests.feed('default', s0)?.online === false || null, 15_000);
    check(!!gone, 'rotating the key disconnects the guest');
    await until(() => g0.exitCode !== null || null, 5000);
    const again = publishClip(ffmpeg, path.join(clips, 'guest.mp4'), await guestUrl(s0, oldKey));
    await sleep(5000);
    check(guests.feed('default', s0)?.online !== true, 'the old key no longer publishes');
    again.kill('SIGKILL');
    check(feedEvents.every((f) => f === 'landscape' || f === 'vertical'), "no 'feed' event names a guest");

    if (!quick) await load({ ffmpeg, clips, base, apiPort, guests, media, slots, live: () => live, keyOf, rtmpPort });
  } finally {
    for (const c of children) c.kill('SIGKILL');
    await media.stop().catch(() => undefined);
    db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
  console.log(failures === 0 ? 'PASS' : `FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

interface LoadCtx {
  ffmpeg: string;
  clips: string;
  base: string;
  apiPort: number;
  rtmpPort: number;
  guests: GuestFeeds;
  media: ReturnType<typeof createMediaServer>;
  slots: string[];
  live: () => LivePreviewService<string>;
  keyOf: (slot: string) => Promise<string>;
}

async function load(ctx: LoadCtx): Promise<void> {
  const { ffmpeg, clips, base, media, guests, slots } = ctx;
  console.log(`Load (${PHASE_SEC} s per phase)`);
  const keys = await media.ingestKeys('default');
  publishClip(ffmpeg, path.join(clips, 'land.mp4'), `${base}/live/landscape?key=${keys.landscape}`);
  publishClip(ffmpeg, path.join(clips, 'vert.mp4'), `${base}/live/vertical?key=${keys.vertical}`);
  await until(() => media.feed('default', 'landscape').online && media.feed('default', 'vertical').online, 15_000);
  const readers = [copyReader(ffmpeg, media.readUrl('default', 'landscape')), copyReader(ffmpeg, media.readUrl('default', 'vertical'))];
  const mtxPid = Number((await new Promise<string>((r) => run('pgrep', ['-n', '-f', 'tools/mediamtx']).stdout?.on('data', (d: Buffer) => r(d.toString())))).trim());
  await sleep(5000);

  // A tiny local HTTP front for the guest LL-HLS proxy code, so FFmpeg can play it like CTD OBS would.
  const server = http.createServer(async (req, res) => {
    const m = /^\/g\/([a-z0-9]{10})\/(live\.m3u8|live\/[^?]+|[^/?]+)(?:\?(.*))?$/.exec(req.url ?? '');
    if (!m) return res.writeHead(404).end();
    const [, slot, rest, qs] = m;
    const who = `player-${req.headers['x-player'] ?? 'x'}`;
    const result =
      rest === 'live.m3u8'
        ? await ctx.live().open('default', slot!, who)
        : await ctx.live().file('default', slot!, rest!.replace(/^live\//, ''), Object.fromEntries(new URLSearchParams(qs ?? '')), who);
    if (!result.ok) return res.writeHead(result.status).end();
    if (result.kind === 'playlist') return res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(result.body);
    res.writeHead(200, { 'content-type': result.contentType });
    result.body.pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const httpPort = (server.address() as net.AddressInfo).port;

  const phase = async (label: string) => {
    const mtx0 = procStat(mtxPid);
    const node0 = process.cpuUsage();
    const rates: number[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < PHASE_SEC * 1000) {
      await sleep(2000);
      rates.push(media.feed('default', 'landscape').bitrateKbps ?? 0);
    }
    const wall = (Date.now() - t0) / 1000;
    const mtx1 = procStat(mtxPid);
    const node1 = process.cpuUsage(node0);
    const mtxCpu = mtx0 !== null && mtx1 !== null ? ((100 * (mtx1 - mtx0)) / wall).toFixed(1) : 'n/a';
    const nodeCpu = ((100 * (node1.user + node1.system)) / 1e6 / wall).toFixed(1);
    const speeds = readers.map((r) => lastSpeed(r)?.toFixed(2) ?? '?');
    const min = Math.min(...rates.slice(1));
    const max = Math.max(...rates.slice(1));
    console.log(`  ${label.padEnd(46)} MediaMTX ${mtxCpu}% CPU | Relay (Node) ${nodeCpu}% | copy readers ${speeds.join('x, ')}x | landscape ${min}–${max} kbps`);
    return { speeds: readers.map((r) => lastSpeed(r) ?? 0) };
  };

  await phase('main feeds + 2 copy readers');
  for (const slot of slots) publishClip(ffmpeg, path.join(clips, 'guest.mp4'), `${base}/guest/${slot}?key=${await ctx.keyOf(slot)}`);
  await until(() => slots.every((s) => guests.feed('default', s)?.online), 20_000);
  await phase('+ 4 guests at 8 Mbps (nobody watching)');
  for (const slot of slots) {
    for (const n of [1, 2]) {
      run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-headers', `X-Player: ${slot}-${n}\r\n`, '-live_start_index', '-1', '-i', `http://127.0.0.1:${httpPort}/g/${slot}/live.m3u8`, '-c', 'copy', '-f', 'null', '-']);
    }
  }
  await sleep(6000);
  const last = await phase('+ 2 LL-HLS players per guest (8 players)');
  const total = slots.reduce((n, s) => n + ctx.live().viewerCount('default', s), 0);
  console.log(`  players open: ${total}`);
  check(last.speeds.every((s) => s >= 0.95), 'the main feeds\' copy readers keep real time with guests on');
  server.close();
}

main().catch((err) => {
  console.error(err);
  for (const c of children) c.kill('SIGKILL');
  process.exit(1);
});
