// Resource safety of the live preview with the real binaries (SR check, docs/PREVIEW.md → Resource safety):
//
//   npx tsx scripts/preview-stress.ts                 every phase
//   STRESS_CPUS=0 npx tsx scripts/preview-stress.ts   Relay, MediaMTX and their FFmpegs pinned to CPU 0
//                                                     (a stand-in for a weak, CPU-only server)
//   STRESS_PHASES=restream,cap npx tsx …              only some phases
//   STRESS_HOG=1 …                                    restream phase with a busy x264 encode (1080p60,
//                                                     like Twitch Dual Format) on Relay's CPUs: a CPU
//                                                     that is already full
//
// Phases:
//   restream  a Custom RTMP destination to a local fake platform, live; the restream's video frames/s,
//             Mbit/s and longest stall at the platform, and FFmpeg's own fps/speed, 30 s with no
//             player, then 30 s with 4 players (Chromium, hls.js) on the same feed
//   cap       a 5th viewer from another login is refused; 12 logins opening at once get at most 4
//   aborted   20 opens abandoned while MediaMTX starts the muxer (cold feed): no slot is kept
//   tabkill   the browser process is killed (SIGKILL) while playing: the muxer stops by itself
//   netdrop   the network freezes (no FIN, no RST) while playing: the muxer stops; when it comes
//             back the player recovers by itself
//   cycles    100 open → playing → close cycles in the web UI, then no muxer, no extra sockets or
//             file descriptors in Relay or MediaMTX, and the 4 slots are free
//   thumbs    thumbnails refresh while the page is visible and make no request while it is hidden
//
// Needs `npm run setup-tools` and Playwright's Chromium (or CHROMIUM_PATH). Linux only (/proc, taskset).

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build } from 'vite';
import { startFakeIngest, type FakeIngest } from '../server/src/media/rtmp-test-server.js';

interface VideoLike {
  currentTime: number;
  readyState: number;
}

const PHASES = (process.env.STRESS_PHASES ?? 'restream,cap,aborted,tabkill,netdrop,cycles,thumbs').split(',');
const CPUS = process.env.STRESS_CPUS ?? null;
const CYCLES = Number(process.env.STRESS_CYCLES ?? 100);
const MAX_VIEWERS = 4;
const children = new Set<ChildProcess>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: string[] = [];
const failures: string[] = [];

function note(line: string): void {
  console.log(`  ${line}`);
  results.push(line);
}
function check(ok: boolean, what: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
}

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

async function until<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, what: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}, cpus: string | null = null): ChildProcess & { out: string[] } {
  const [c, a] = cpus !== null ? ['taskset', ['-c', cpus, cmd, ...args]] : [cmd, args];
  const child = spawn(c, a, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcess & { out: string[] };
  child.out = [];
  const keep = (d: Buffer) => {
    child.out.push(...d.toString().split('\n').filter(Boolean));
    child.out.splice(0, Math.max(0, child.out.length - 2000));
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

/** The CPUs the OBS stand-ins and Chromium use: the others, when Relay is pinned. */
function otherCpus(): string | null {
  if (CPUS === null) return null;
  const pinned = new Set(CPUS.split(',').map(Number));
  const rest = os.cpus().map((_c, i) => i).filter((i) => !pinned.has(i));
  return rest.length ? rest.join(',') : null;
}

/** OBS stand-in: H.264 CBR 6 Mbit/s, 2 s keyframes, AAC. */
function publish(ffmpeg: string, url: string, size: string, fps: number, kbps: number) {
  return run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-re',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${fps}`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps}k`,
    '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-f', 'flv', url,
  ], {}, otherCpus());
}

// ---- /proc helpers ----------------------------------------------------------

function procCpuSec(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return (Number(f[11]) + Number(f[12])) / 100;
  } catch {
    return null;
  }
}
function procRssMb(pid: number): number | null {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) / 1024 : null;
  } catch {
    return null;
  }
}
function childrenOf(pid: number): number[] {
  const out: number[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid === pid) out.push(Number(d));
    } catch {
      // gone
    }
  }
  return out;
}
function cmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return '';
  }
}
function fdCount(pid: number): number {
  try {
    return readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    return -1;
  }
}
/** TCP connections of `pid` whose remote (or local) port is `port`, by state. */
function tcpOf(pid: number, port: number, side: 'remote' | 'local' = 'remote'): { established: number; other: number } {
  const inodes = new Set<string>();
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (m?.[1]) inodes.add(m[1]);
      } catch {
        // closed meanwhile
      }
    }
  } catch {
    return { established: 0, other: 0 };
  }
  let established = 0;
  let other = 0;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10) continue;
      const addr = side === 'remote' ? f[2] : f[1];
      const p = parseInt(addr?.split(':')[1] ?? '', 16);
      if (p !== port || !inodes.has(f[9] ?? '')) continue;
      if (f[3] === '01') established++;
      else other++;
    }
  }
  return { established, other };
}

async function hlsMuxers(apiPort: number): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${apiPort}/v3/hlsmuxers/list`);
  const body = (await res.json()) as { items?: { path: string }[] };
  return (body.items ?? []).map((m) => m.path);
}

// ---- a TCP proxy that can freeze (a network drop with no FIN/RST) ------------------------------

interface Freezer {
  port: number;
  freeze(): void;
  /** The network is back: frozen connections are reset (as a NAT or Wi-Fi change would), new ones work. */
  thaw(): void;
  close(): Promise<void>;
}
async function freezableProxy(target: number): Promise<Freezer> {
  let frozen = false;
  const pairs = new Set<{ a: net.Socket; b: net.Socket }>();
  const all = new Set<net.Socket>();
  const srv = net.createServer((a) => {
    all.add(a);
    a.on('close', () => all.delete(a));
    if (frozen) return; // accepted, never answered
    const b = net.connect(target, '127.0.0.1');
    const pair = { a, b };
    pairs.add(pair);
    a.pipe(b);
    b.pipe(a);
    const end = () => {
      pairs.delete(pair);
      a.destroy();
      b.destroy();
    };
    a.on('error', end).on('close', end);
    b.on('error', end).on('close', end);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return {
    port: (srv.address() as net.AddressInfo).port,
    freeze() {
      frozen = true;
      for (const { a, b } of pairs) {
        a.unpipe(b);
        b.unpipe(a);
        a.pause();
        b.pause();
      }
    },
    thaw() {
      frozen = false;
      for (const { a, b } of [...pairs]) {
        a.resetAndDestroy();
        b.destroy();
      }
      // Connections made while frozen were never answered: reset them too.
      for (const a of [...all]) if (!a.destroyed) a.resetAndDestroy();
    },
    close: () =>
      new Promise<void>((r) => {
        for (const { a, b } of pairs) {
          a.destroy();
          b.destroy();
        }
        for (const a of all) a.destroy();
        srv.close(() => r());
      }),
  };
}

// ---- the rig ----------------------------------------------------------------------------------

interface Rig {
  base: string;
  webPort: number;
  apiPort: number;
  hlsPort: number;
  relay: ChildProcess & { out: string[] };
  mtxPid: number;
  cookie: string;
  csrf: string;
  keys: { landscape: string; vertical: string };
  liveScopes: string[];
}

async function api<T>(rig: Pick<Rig, 'base' | 'cookie' | 'csrf'>, method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${rig.base}${route}`, {
    method,
    headers: { cookie: `ctd_session=${rig.cookie}`, 'x-csrf-token': rig.csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${route}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** API tokens that can watch (the live scope if this Relay has one, else status:read). */
async function watchTokens(rig: Rig, n: number, label: string): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const created = await api<{ secret: string }>(rig, 'POST', '/api/tokens', { name: `${label} ${i + 1}`, scopes: rig.liveScopes });
    out.push(created.secret);
  }
  return out;
}

async function openAsToken(rig: Rig, secret: string, signal?: AbortSignal): Promise<number> {
  const res = await fetch(`${rig.base}/api/v1/profiles/default/feeds/landscape/live.m3u8`, {
    headers: { authorization: `Bearer ${secret}` },
    ...(signal ? { signal } : {}),
  });
  void res.body?.cancel();
  return res.status;
}

async function openPlayer(page: Page, feed: 'landscape' | 'vertical' = 'landscape'): Promise<void> {
  await page.locator(`.feed-thumb.is-${feed} .feed-thumb-watch`).click();
  await until(
    async () => (await page.locator('dialog .live-frame video').evaluate((v: VideoLike) => v.readyState >= 3 && v.currentTime > 0.5)) || null,
    30_000,
    'playback',
  );
}

async function playing(page: Page, forMs = 3000): Promise<boolean> {
  const t0 = await page.locator('dialog .live-frame video').evaluate((v: VideoLike) => v.currentTime);
  await sleep(forMs);
  const t1 = await page.locator('dialog .live-frame video').evaluate((v: VideoLike) => v.currentTime);
  return t1 - t0 > (forMs / 1000) * 0.5;
}

async function muxerStopsWithin(rig: Rig, ms: number): Promise<number | null> {
  const t0 = Date.now();
  try {
    await until(async () => (await hlsMuxers(rig.apiPort)).length === 0 || null, ms, 'the muxers to stop');
    return (Date.now() - t0) / 1000;
  } catch {
    return null;
  }
}

// ---- phases -----------------------------------------------------------------------------------

/** Watch the fake platform: video frames/s, Mbit/s, longest gap between video frames, RTMP time vs wall time. */
async function restreamWindow(rig: Rig, sink: FakeIngest, seconds: number, label: string, pushPid: number | null): Promise<void> {
  sink.messages.splice(0);
  const t0 = Date.now();
  let video = 0;
  let bytes = 0;
  let firstTs: number | null = null;
  let lastTs = 0;
  let lastVideoAt = Date.now();
  let longestGap = 0;
  const stats: { fps: number; speed: number; kbps: number }[] = [];
  const cpu0 = { relay: procCpuSec(rig.relay.pid!), mtx: procCpuSec(rig.mtxPid), push: pushPid ? procCpuSec(pushPid) : null };
  let tick = 0;
  while (Date.now() - t0 < seconds * 1000) {
    await sleep(50);
    const batch = sink.messages.splice(0);
    const now = Date.now();
    let gotVideo = false;
    for (const m of batch) {
      bytes += m.payload.length;
      if (m.type === 9) {
        video++;
        gotVideo = true;
        if (firstTs === null) firstTs = m.timestamp;
        lastTs = m.timestamp;
      }
    }
    if (gotVideo) {
      longestGap = Math.max(longestGap, now - lastVideoAt);
      lastVideoAt = now;
    }
    if (++tick % 40 === 0) {
      const s = await api<{ destinations: { stats: { fps: number; speed: number; bitrateKbps: number } | null }[] }>(rig, 'GET', '/api/session').catch(() => null);
      const st = s?.destinations[0]?.stats;
      if (st) stats.push({ fps: st.fps, speed: st.speed, kbps: st.bitrateKbps });
    }
  }
  longestGap = Math.max(longestGap, Date.now() - lastVideoAt);
  const wall = (Date.now() - t0) / 1000;
  const cpu = (a: number | null, b: number | null) => (a !== null && b !== null ? `${((100 * (b - a)) / wall).toFixed(0)}%` : 'n/a');
  const minFps = stats.length ? Math.min(...stats.map((s) => s.fps)) : NaN;
  const minSpeed = stats.length ? Math.min(...stats.map((s) => s.speed)) : NaN;
  note(
    `${label.padEnd(26)} platform got ${(video / wall).toFixed(1)} fps, ${((bytes * 8) / wall / 1e6).toFixed(2)} Mbit/s, ` +
      `RTMP time ${firstTs !== null ? ((lastTs - firstTs) / 1000 / wall).toFixed(3) : 'n/a'}× wall, longest video gap ${longestGap} ms; ` +
      `FFmpeg fps min ${minFps.toFixed(1)}, speed min ${minSpeed.toFixed(2)}x; ` +
      `CPU Relay ${cpu(cpu0.relay, procCpuSec(rig.relay.pid!))}, MediaMTX ${cpu(cpu0.mtx, procCpuSec(rig.mtxPid))}, push FFmpeg ${pushPid ? cpu(cpu0.push, procCpuSec(pushPid)) : 'n/a'}`,
  );
  return;
}

async function phaseRestream(rig: Rig, browser: Browser): Promise<void> {
  console.log('\n## restream: the outgoing restream with and without 4 players');
  const sink = await startFakeIngest();
  try {
    const dest = await api<{ id: string }>(rig, 'POST', '/api/destinations', {
      platform: 'custom',
      name: 'Stress sink',
      feed: 'landscape',
      ingestUrl: `rtmp://127.0.0.1:${sink.port}/live`,
      streamKey: 'stress',
    });
    await api(rig, 'POST', '/api/session/start');
    await until(async () => {
      const s = await api<{ destinations: { destinationId: string; phase: string }[] }>(rig, 'GET', '/api/session');
      return s.destinations.find((d) => d.destinationId === dest.id)?.phase === 'live' || null;
    }, 30_000, 'the destination to go live');
    const pushPid = (() => {
      const stack = [rig.relay.pid!];
      while (stack.length) {
        const p = stack.pop()!;
        for (const c of childrenOf(p)) {
          if (cmdline(c).includes(`:${sink.port}/`)) return c;
          stack.push(c);
        }
      }
      return null;
    })();
    if (process.env.STRESS_HOG) {
      // A stand-in for a Dual Format re-encode: x264 1080p60, as busy as the CPU lets it be.
      const ffmpeg = process.env.FFMPEG_BIN ?? path.resolve('tools', 'ffmpeg');
      run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60',
        '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '8000k', '-f', 'null', '-'], {}, CPUS);
      note('busy x264 encode running on the same CPUs as Relay');
    }
    await sleep(8000); // settle
    await restreamWindow(rig, sink, 30, 'no player', pushPid);

    const context = await newContext(browser, rig);
    const pages: Page[] = [];
    for (let i = 0; i < MAX_VIEWERS; i++) {
      const p = await context.newPage();
      await p.goto(rig.base);
      await openPlayer(p);
      pages.push(p);
    }
    await sleep(3000);
    await restreamWindow(rig, sink, 30, `${MAX_VIEWERS} players (landscape)`, pushPid);
    let stillPlaying = 0;
    for (const p of pages) if (await playing(p, 2000)) stillPlaying++;
    check(stillPlaying === MAX_VIEWERS, `all ${MAX_VIEWERS} players kept playing during the window (${stillPlaying})`);
    await context.close();
    const stopped = await muxerStopsWithin(rig, 70_000);
    check(stopped !== null, `muxers stop after the ${MAX_VIEWERS} players close (${stopped?.toFixed(0) ?? '>70'} s)`);
    await restreamWindow(rig, sink, 15, 'players closed again', pushPid);
    await api(rig, 'POST', '/api/session/stop');
    await api(rig, 'DELETE', `/api/destinations/${dest.id}`).catch(() => undefined);
  } finally {
    await sink.close();
  }
}

async function phaseCap(rig: Rig, browser: Browser): Promise<void> {
  console.log('\n## cap: at most 4 players per feed');
  const context = await newContext(browser, rig);
  const pages: Page[] = [];
  for (let i = 0; i < MAX_VIEWERS; i++) {
    const p = await context.newPage();
    await p.goto(rig.base);
    await openPlayer(p);
    pages.push(p);
  }
  const [other] = await watchTokens(rig, 1, 'cap 5th');
  const fifth = await openAsToken(rig, other!);
  check(fifth === 429, `a 5th viewer from another login gets 429 viewer_cap (${fifth})`);
  await context.close();
  // Players closed: their slots free 15 s after their last request; the muxer stops ~30 s later.
  await muxerStopsWithin(rig, 70_000);

  // 12 logins at once on a cold feed (the muxer takes a second or two to start: a wide window).
  const tokens = await watchTokens(rig, 12, 'cap race');
  const statuses = await Promise.all(tokens.map((t) => openAsToken(rig, t)));
  const ok = statuses.filter((s) => s === 200).length;
  check(ok <= MAX_VIEWERS && ok >= 1, `12 logins opening at once: ${ok} got a player, the others ${[...new Set(statuses.filter((s) => s !== 200))].join('/')} (cap ${MAX_VIEWERS})`);
  await sleep(16_000); // those viewers send nothing more: they expire
}

async function phaseAborted(rig: Rig): Promise<void> {
  console.log('\n## aborted: opens abandoned while MediaMTX starts the muxer');
  // A cold feed: MediaMTX answers the first playlist only once it has a segment (1–2 s).
  await muxerStopsWithin(rig, 90_000);
  const tokens = await watchTokens(rig, 20, 'abandoned');
  const acs = tokens.map(() => new AbortController());
  const pending = tokens.map((t, i) => openAsToken(rig, t, acs[i]!.signal).catch(() => 0));
  await sleep(300);
  for (const ac of acs) ac.abort();
  const statuses = await Promise.all(pending);
  const got = statuses.filter((x) => x === 200).length;
  note(`20 logins opened a cold feed and gave up after 0.3 s: ${got} got a playlist before that, ${statuses.filter((x) => x === 429).length} got 429 at once, ${statuses.filter((x) => x === 0).length} gave up waiting`);
  // Past the time MediaMTX takes to answer (so an abandoned open that still completes would hold its
  // place by now), well inside the 15 s a silent viewer keeps it.
  await sleep(4000);
  const others = await watchTokens(rig, MAX_VIEWERS, 'after abandoned');
  const res = await Promise.all(others.map((t) => openAsToken(rig, t)));
  const ok = res.filter((x) => x === 200).length;
  check(ok === MAX_VIEWERS - got, `right after, ${ok} of ${MAX_VIEWERS} other logins get a player (expected ${MAX_VIEWERS - got}: abandoned opens keep no place) (${res.join(',')})`);
  await sleep(16_000);
}

async function newContext(browser: Browser, rig: Rig, base = rig.base): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: 'ctd_session', value: rig.cookie, url: base, httpOnly: true, sameSite: 'Strict' }]);
  return context;
}

async function phaseTabKill(rig: Rig): Promise<void> {
  console.log('\n## tabkill: the browser dies while playing');
  await muxerStopsWithin(rig, 70_000);
  const server = await chromium.launchServer({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  const browser = await chromium.connect(server.wsEndpoint());
  const context = await newContext(browser, rig);
  const page = await context.newPage();
  await page.goto(rig.base);
  await openPlayer(page);
  check((await hlsMuxers(rig.apiPort)).length === 1, 'one muxer while playing');
  server.process().kill('SIGKILL');
  const t = await muxerStopsWithin(rig, 90_000);
  check(t !== null && t <= 45, `muxer stopped ${t?.toFixed(0) ?? '>90'} s after the browser was killed (≤ 45 s)`);
  const sockets = tcpOf(rig.relay.pid!, rig.hlsPort);
  check(sockets.established === 0, `Relay holds no connection to MediaMTX HLS afterwards (${sockets.established} established, ${sockets.other} closing)`);
}

async function phaseNetDrop(rig: Rig, browser: Browser): Promise<void> {
  console.log('\n## netdrop: the network freezes while playing (no FIN/RST)');
  await muxerStopsWithin(rig, 70_000);
  const proxy = await freezableProxy(rig.webPort);
  const base = `http://127.0.0.1:${proxy.port}`;
  try {
    const context = await newContext(browser, rig, base);
    const page = await context.newPage();
    await page.goto(base);
    await openPlayer(page);
    proxy.freeze();
    const t0 = Date.now();
    const t = await muxerStopsWithin(rig, 120_000);
    check(t !== null && t <= 60, `muxer stopped ${t?.toFixed(0) ?? '>120'} s after the network froze (≤ 60 s)`);
    // Relay's side of the frozen connections: closed or bounded, and nothing open to MediaMTX.
    const sockets = tcpOf(rig.relay.pid!, rig.hlsPort);
    check(sockets.established === 0, `Relay holds no connection to MediaMTX HLS while the network is down (${sockets.established})`);
    const held = tcpOf(rig.relay.pid!, rig.webPort, 'local');
    note(`Relay connections from the frozen browser still open ${((Date.now() - t0) / 1000).toFixed(0)} s after the drop: ${held.established}`);
    proxy.thaw();
    const back = Date.now();
    await until(async () => (await page.locator('dialog .live-frame video').evaluate((v: VideoLike) => v.readyState >= 3)) && (await playing(page, 2000)), 60_000, 'the player to recover').then(
      () => check(true, `the player recovered by itself ${((Date.now() - back) / 1000).toFixed(0)} s after the network came back`),
      () => check(false, 'the player recovered by itself within 60 s after the network came back'),
    );
    await context.close();
  } finally {
    await proxy.close();
  }
}

async function phaseCycles(rig: Rig, browser: Browser): Promise<void> {
  console.log(`\n## cycles: ${CYCLES} × open, play, close`);
  await muxerStopsWithin(rig, 70_000);
  await sleep(2000);
  const before = { relayFds: fdCount(rig.relay.pid!), mtxFds: fdCount(rig.mtxPid), relayRss: procRssMb(rig.relay.pid!), mtxRss: procRssMb(rig.mtxPid) };
  const context = await newContext(browser, rig);
  const page = await context.newPage();
  await page.goto(rig.base);
  const t0 = Date.now();
  let failed = 0;
  for (let i = 0; i < CYCLES; i++) {
    try {
      await openPlayer(page, i % 2 ? 'vertical' : 'landscape');
    } catch {
      failed++;
    }
    await page.keyboard.press('Escape');
    await page.locator('dialog .live-frame').waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
    if ((i + 1) % 25 === 0) {
      console.log(
        `    ${i + 1} cycles, ${((Date.now() - t0) / 1000).toFixed(0)} s, Relay ${fdCount(rig.relay.pid!)} fds ${procRssMb(rig.relay.pid!)?.toFixed(0)} MB, MediaMTX ${fdCount(rig.mtxPid)} fds ${procRssMb(rig.mtxPid)?.toFixed(0)} MB`,
      );
    }
  }
  check(failed === 0, `${CYCLES} cycles, every one played (${failed} failed)`);
  await context.close();
  const t = await muxerStopsWithin(rig, 90_000);
  check(t !== null, `no muxer ${t?.toFixed(0) ?? '>90'} s after the last cycle`);
  await sleep(5000);
  const after = { relayFds: fdCount(rig.relay.pid!), mtxFds: fdCount(rig.mtxPid), relayRss: procRssMb(rig.relay.pid!), mtxRss: procRssMb(rig.mtxPid) };
  const hls = tcpOf(rig.relay.pid!, rig.hlsPort);
  check(hls.established === 0, `Relay: no connection left to MediaMTX HLS (${hls.established} established, ${hls.other} closing)`);
  check(after.relayFds <= before.relayFds + 5, `Relay file descriptors ${before.relayFds} → ${after.relayFds}`);
  check(after.mtxFds <= before.mtxFds + 5, `MediaMTX file descriptors ${before.mtxFds} → ${after.mtxFds}`);
  note(`RSS Relay ${before.relayRss?.toFixed(0)} → ${after.relayRss?.toFixed(0)} MB, MediaMTX ${before.mtxRss?.toFixed(0)} → ${after.mtxRss?.toFixed(0)} MB`);
  await sleep(16_000);
  const others = await watchTokens(rig, MAX_VIEWERS, 'after cycles');
  const statuses = await Promise.all(others.map((x) => openAsToken(rig, x)));
  check(statuses.every((s) => s === 200), `after the cycles, ${MAX_VIEWERS} other logins all get a player (${statuses.join(',')})`);
  await sleep(16_000);
}

async function phaseThumbs(rig: Rig, browser: Browser): Promise<void> {
  console.log('\n## thumbs: thumbnails refresh only while the page is visible');
  const context = await newContext(browser, rig);
  const page = await context.newPage();
  let jpegs = 0;
  const times: Record<string, number[]> = { landscape: [], vertical: [] };
  page.on('request', (r) => {
    const m = /feeds\/(landscape|vertical)\/preview\.jpg/.exec(r.url());
    if (!m) return;
    jpegs++;
    times[m[1]!]!.push(Date.now());
  });
  await page.goto(rig.base);
  await page.locator('.feed-thumb.is-landscape img').waitFor({ timeout: 20_000 });
  jpegs = 0;
  times.landscape = [];
  times.vertical = [];
  await sleep(20_000);
  const visible = jpegs;
  const gaps = Object.values(times).flatMap((t) => t.slice(1).map((x, i) => (x - t[i]!) / 1000));
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : NaN;
  await page.evaluate(`Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));`);
  await sleep(500);
  jpegs = 0;
  await sleep(20_000);
  const hidden = jpegs;
  // The next refresh is due 3 s after a frame arrived (a grab takes up to a keyframe interval).
  check(visible >= 6 && avgGap >= 2.9 && avgGap <= 6, `visible: ${visible} thumbnail requests in 20 s, one per feed every ${avgGap.toFixed(1)} s (3 s after the last frame arrived)`);
  check(hidden === 0, `hidden: ${hidden} thumbnail requests in 20 s`);
  await context.close();
}

// ---- main -------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const tools = path.resolve('tools');
  const mediamtx = process.env.MEDIAMTX_BIN ?? path.join(tools, 'mediamtx');
  const ffmpeg = process.env.FFMPEG_BIN ?? path.join(tools, 'ffmpeg');
  for (const bin of [mediamtx, ffmpeg]) if (!existsSync(bin)) throw new Error(`${bin} not found; run \`npm run setup-tools\` first`);
  const [webPort, rtmpPort, apiPort, hlsPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctd-preview-stress-'));
  const webDir = path.join(dataDir, 'web');
  const base = `http://127.0.0.1:${webPort}`;
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  console.log(`CPU: ${os.cpus().length} × ${os.cpus()[0]?.model ?? '?'}; Relay + MediaMTX + FFmpeg on ${CPUS === null ? 'every CPU' : `CPU ${CPUS} only`}`);
  try {
    await build({ configFile: path.resolve('vite.config.ts'), logLevel: 'silent', build: { outDir: webDir, emptyOutDir: true } });
    const relay = run(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
      DATA_DIR: dataDir, WEB_DIR: webDir, TLS_MODE: 'off', WEB_PORT: String(webPort), HTTP_PORT: '0',
      RTMP_PORT: String(rtmpPort), MEDIAMTX_API_PORT: String(apiPort), MEDIAMTX_HLS_PORT: String(hlsPort),
      MEDIAMTX_BIN: mediamtx, FFMPEG_BIN: ffmpeg, LIVE_PREVIEW_MAX_VIEWERS: String(MAX_VIEWERS), LOG_LEVEL: 'info',
    }, CPUS);
    await until(async () => (await fetch(`${base}/api/setup/status`)).ok, 60_000, 'Relay to answer');
    const code = await until(async () => {
      for (const line of relay.out) {
        const m = /"setupCode":"([A-Z0-9-]+)"/.exec(line);
        if (m) return m[1];
      }
      return null;
    }, 10_000, 'the setup code');
    const res = await fetch(`${base}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupCode: code, username: 'admin', password: 'correct horse battery staple' }),
    });
    if (!res.ok) throw new Error(`setup: ${res.status}`);
    const cookie = /ctd_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
    const csrf = ((await res.json()) as { csrfToken: string }).csrfToken;
    const partial = { base, cookie, csrf };
    const info = await api<{ feeds: { feed: string; streamKey: string }[] }>(partial, 'GET', '/api/ingest');
    const key = (feed: string) => info.feeds.find((f) => f.feed === feed)!.streamKey;
    const keys = { landscape: key('landscape'), vertical: key('vertical') };
    publish(ffmpeg, `rtmp://127.0.0.1:${rtmpPort}/live/${keys.landscape}`, '1920x1080', 30, 6000);
    publish(ffmpeg, `rtmp://127.0.0.1:${rtmpPort}/live/${keys.vertical}`, '1080x1920', 30, 4000);
    await until(async () => {
      const s = await api<{ feeds: { online: boolean; video: unknown }[] }>(partial, 'GET', '/api/session');
      return s.feeds.every((f) => f.online && f.video);
    }, 30_000, 'both feeds online');
    const mtxPid = childrenOf(relay.pid!).find((p) => cmdline(p).includes(mediamtx)) ?? 0;
    // A token with the live scope, if this Relay has one (feeds:watch), else status:read.
    const probe = await fetch(`${base}/api/tokens`, {
      method: 'POST',
      headers: { cookie: `ctd_session=${cookie}`, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'scope probe', scopes: ['status:read', 'feeds:watch'] }),
    });
    const liveScopes = probe.ok ? ['status:read', 'feeds:watch'] : ['status:read'];
    void probe.body?.cancel();
    console.log(`watch tokens use: ${liveScopes.join(', ')}`);
    const rig: Rig = { base, webPort, apiPort, hlsPort, relay, mtxPid, cookie, csrf, keys, liveScopes };

    if (PHASES.includes('restream')) await phaseRestream(rig, browser);
    if (PHASES.includes('cap')) await phaseCap(rig, browser);
    if (PHASES.includes('aborted')) await phaseAborted(rig);
    if (PHASES.includes('tabkill')) await phaseTabKill(rig);
    if (PHASES.includes('netdrop')) await phaseNetDrop(rig, browser);
    if (PHASES.includes('cycles')) await phaseCycles(rig, browser);
    if (PHASES.includes('thumbs')) await phaseThumbs(rig, browser);

    const leaked = relay.out.filter((l) => l.includes(keys.landscape) || l.includes(keys.vertical) || /session=[0-9a-f-]{36}/.test(l) || /Bearer |ctd_session=/.test(l));
    check(leaked.length === 0, `Relay's log holds no stream key, HLS session, token or cookie (${leaked.length} lines)`);
  } finally {
    await browser.close().catch(() => {});
    for (const c of [...children]) c.kill('SIGTERM');
    await sleep(1000);
    for (const c of [...children]) c.kill('SIGKILL');
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
  console.log('\nSummary:');
  for (const r of results) console.log(`  ${r}`);
}

const overall = setTimeout(() => {
  console.error('\nFAIL: exceeded 40 minutes');
  for (const c of children) c.kill('SIGKILL');
  process.exit(1);
}, 40 * 60_000);
overall.unref();

main()
  .then(() => {
    console.log(failures.length ? `\nFAIL: ${failures.length} check(s)` : '\nPASS');
    process.exit(failures.length ? 1 : 0);
  })
  .catch((err: unknown) => {
    console.error(`\nFAIL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    for (const c of children) c.kill('SIGKILL');
    process.exit(1);
  });
