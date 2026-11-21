// End-to-end UI test of the feed previews with the real binaries (npm run e2e:preview).
//
//   FFmpeg test patterns (OBS stand-ins) -> the real Relay (server + MediaMTX, TLS off, temp data dir)
//     -> the web UI in Chromium (Playwright): dashboard thumbnails, "Watch" (LL-HLS through Relay),
//        sound + meter, the HEVC warning, and the muxer stopping after the player closes.
//
// Also prints what the live preview costs on this machine: CPU and RAM of Relay (Node + its FFmpeg
// grabs) and MediaMTX while nobody watches, with the dashboard thumbnails open, and with players open.
// Needs `npm run setup-tools` and the pre-installed Chromium. Uses free ports, prints PASS/FAIL.
// Options: --quick (skip the CPU/RAM measurement), PREVIEW_E2E_SHOTS=<dir> (save screenshots),
// CHROMIUM_PATH=<chrome binary> (a Chromium other than the one Playwright installed; it needs H.264).

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { build } from 'vite';

/** What the checks read of the page's <video> (scripts are type-checked without the DOM library). */
interface VideoLike {
  readyState: number;
  currentTime: number;
  paused: boolean;
  muted: boolean;
  videoWidth: number;
  videoHeight: number;
  currentSrc: string;
}

/** The page's document, inside page.evaluate() callbacks (they run in the page, not in Node). */
declare const document: { visibilityState: string; dispatchEvent(event: Event): boolean };

const quick = process.argv.includes('--quick');
const shots = process.env.PREVIEW_E2E_SHOTS ?? null;
const OVERALL_TIMEOUT_MS = quick ? 240_000 : 420_000;
const children = new Set<ChildProcess>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function until<T>(check: () => Promise<T | null | undefined | false>, timeoutMs: number, what: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await check().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess & { out: string[] } {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcess & { out: string[] };
  child.out = [];
  const keep = (d: Buffer) => {
    child.out.push(...d.toString().split('\n').filter(Boolean));
    child.out.splice(0, Math.max(0, child.out.length - 400));
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

/** An OBS stand-in: H.264 (2 s keyframes) or HEVC + AAC, a clock burned in, at real-time speed. */
function publish(ffmpeg: string, url: string, size: string, codec: 'h264' | 'hevc' = 'h264') {
  const video =
    codec === 'h264'
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-b:v', '4500k', '-maxrate', '4500k', '-bufsize', '4500k']
      : ['-c:v', 'libx265', '-preset', 'ultrafast', '-b:v', '1500k'];
  return run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-re',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    ...video, '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-f', 'flv', url,
  ]);
}

/** CPU seconds (self + reaped children) and RSS of a process, from /proc (Linux only). */
function procStat(pid: number): { cpuSec: number; rssMb: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const tick = 100; // USER_HZ
    const cpu = (Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14])) / tick;
    const rssPages = Number(f[21]);
    return { cpuSec: cpu, rssMb: (rssPages * 4096) / 1024 / 1024 };
  } catch {
    return null;
  }
}

async function measure(label: string, pids: Record<string, number>, seconds: number): Promise<string> {
  const before = Object.fromEntries(Object.entries(pids).map(([k, p]) => [k, procStat(p)]));
  const t0 = Date.now();
  await sleep(seconds * 1000);
  const wall = (Date.now() - t0) / 1000;
  const parts = Object.entries(pids).map(([k, p]) => {
    const a = before[k];
    const b = procStat(p);
    if (!a || !b) return `${k} n/a`;
    return `${k} ${((100 * (b.cpuSec - a.cpuSec)) / wall).toFixed(1)}% CPU, ${b.rssMb.toFixed(0)} MB`;
  });
  return `  ${label.padEnd(34)} ${parts.join(' | ')}`;
}

/** Page script: pretend the tab is hidden/visible (a string: tsx would add helpers to a function). */
function visibility(state: 'hidden' | 'visible'): string {
  return `Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => '${state}' }); document.dispatchEvent(new Event('visibilitychange'));`;
}

async function hlsMuxers(apiPort: number): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${apiPort}/v3/hlsmuxers/list`);
  const body = (await res.json()) as { items?: { path: string }[] };
  return (body.items ?? []).map((m) => m.path);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  await fs.mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });
}

async function main(): Promise<void> {
  const tools = path.resolve('tools');
  const mediamtx = process.env.MEDIAMTX_BIN ?? path.join(tools, 'mediamtx');
  const ffmpeg = process.env.FFMPEG_BIN ?? path.join(tools, 'ffmpeg');
  for (const bin of [mediamtx, ffmpeg]) if (!existsSync(bin)) throw new Error(`${bin} not found; run \`npm run setup-tools\` first`);
  const [webPort, rtmpPort, apiPort, hlsPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctd-preview-e2e-'));
  const webDir = path.join(dataDir, 'web');
  const base = `http://127.0.0.1:${webPort}`;
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  let relay: (ChildProcess & { out: string[] }) | null = null;

  try {
    await step('build the web UI', async () => {
      await build({ configFile: path.resolve('vite.config.ts'), logLevel: 'silent', build: { outDir: webDir, emptyOutDir: true } });
    });

    relay = await step('start Relay (TLS off) with its MediaMTX', async () => {
      const r = run(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
        DATA_DIR: dataDir,
        WEB_DIR: webDir,
        TLS_MODE: 'off',
        WEB_PORT: String(webPort),
        HTTP_PORT: '0',
        RTMP_PORT: String(rtmpPort),
        MEDIAMTX_API_PORT: String(apiPort),
        MEDIAMTX_HLS_PORT: String(hlsPort),
        MEDIAMTX_BIN: mediamtx,
        FFMPEG_BIN: ffmpeg,
        LIVE_PREVIEW_MAX_VIEWERS: '3',
        LOG_LEVEL: 'info',
      });
      await until(async () => (await fetch(`${base}/api/setup/status`)).ok, 60_000, 'Relay to answer');
      return r;
    });

    const cookie = await step('first-run setup: create the admin, sign in', async () => {
      const code = await until(async () => {
        for (const line of relay!.out) {
          const m = /"setupCode":"([A-Z0-9-]+)"/.exec(line);
          if (m) return m[1];
        }
        return null;
      }, 10_000, 'the setup code in the log');
      const res = await fetch(`${base}/api/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ setupCode: code, username: 'admin', password: 'correct horse battery staple' }),
      });
      if (!res.ok) throw new Error(`setup: ${res.status} ${await res.text()}`);
      const sid = /ctd_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
      if (!sid) throw new Error('no session cookie');
      return sid;
    });

    const keys = await step('publish both feeds like OBS (H.264, 2 s keyframes, AAC)', async () => {
      const res = await fetch(`${base}/api/ingest`, { headers: { cookie: `ctd_session=${cookie}` } });
      const info = (await res.json()) as { feeds: { feed: string; streamKey: string }[] };
      const key = (feed: string) => info.feeds.find((f) => f.feed === feed)!.streamKey;
      publish(ffmpeg, `rtmp://127.0.0.1:${rtmpPort}/live/${key('landscape')}`, '1920x1080');
      publish(ffmpeg, `rtmp://127.0.0.1:${rtmpPort}/live/${key('vertical')}`, '1080x1920');
      await until(async () => {
        const s = (await (await fetch(`${base}/api/session`, { headers: { cookie: `ctd_session=${cookie}` } })).json()) as { feeds: { online: boolean; video: unknown }[] };
        return s.feeds.every((f) => f.online && f.video);
      }, 30_000, 'both feeds online');
      return { landscape: key('landscape'), vertical: key('vertical') };
    });

    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: shots ? 2 : 1 });
    await context.addCookies([{ name: 'ctd_session', value: cookie, url: base, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) pageErrors.push(m.text());
    });

    await step('dashboard: both feed cards show a fresh thumbnail in their own aspect', async () => {
      await page.goto(base);
      const thumb = (feed: string) => page.locator(`.feed-thumb.is-${feed}`);
      for (const feed of ['landscape', 'vertical']) await thumb(feed).locator('img').waitFor({ timeout: 20_000 });
      const box = async (feed: string) => (await thumb(feed).boundingBox())!;
      const l = await box('landscape');
      const v = await box('vertical');
      const ratio = (b: { width: number; height: number }) => b.width / b.height;
      if (Math.abs(ratio(l) - 16 / 9) > 0.03) throw new Error(`landscape thumbnail is ${l.width}x${l.height}`);
      if (Math.abs(ratio(v) - 9 / 16) > 0.03) throw new Error(`vertical thumbnail is ${v.width}x${v.height}`);
      if (Math.abs(l.height - v.height) > 2) throw new Error(`thumbnails differ in height: ${l.height} vs ${v.height}`);
      const first = await thumb('landscape').locator('img').getAttribute('src');
      await until(async () => (await thumb('landscape').locator('img').getAttribute('src')) !== first, 10_000, 'the thumbnail to refresh');
      await shot(page, 'dashboard');
    });

    let pids: Record<string, number> = {};
    if (!quick) {
      const mtxPid = Number((await until(async () => {
        const out = await new Promise<string>((resolve) => {
          const p = spawn('pgrep', ['-f', `${mediamtx} `]);
          let s = '';
          p.stdout.on('data', (d: Buffer) => (s += d.toString()));
          p.on('close', () => resolve(s));
        });
        return out.trim().split('\n')[0] || null;
      }, 5000, 'the MediaMTX pid')));
      pids = { Relay: relay.pid!, MediaMTX: mtxPid };
    }
    const results: string[] = [];

    if (!quick) {
      await step('measure: dashboard open (thumbnails every 3 s), nobody watching', async () => {
        results.push(await measure('2 thumbnails refreshing, no player', pids, 20));
        if ((await hlsMuxers(apiPort)).length !== 0) throw new Error('an HLS muxer runs while nobody watches');
      });
      await step('measure: page hidden (thumbnails stop)', async () => {
        // Headless Chromium keeps every page "visible"; stand in for a hidden tab by emulating it.
        await page.evaluate(visibility('hidden'));
        results.push(await measure('feeds in, nothing shown (baseline)', pids, 20));
        await page.evaluate(visibility('visible'));
      });
    }

    const latency = await step('Watch (landscape): plays LL-HLS through Relay, muted, ~1–3 s behind', async () => {
      await page.locator('.feed-thumb.is-landscape .feed-thumb-watch').click();
      const video = page.locator('dialog .live-frame video');
      await until(async () => (await video.evaluate((v: VideoLike) => v.readyState >= 3 && v.currentTime > 1 && !v.paused)) || null, 30_000, 'playback');
      const info = await video.evaluate((v: VideoLike) => ({ w: v.videoWidth, h: v.videoHeight, muted: v.muted, src: v.currentSrc }));
      if (info.w !== 1920 || info.h !== 1080) throw new Error(`video is ${info.w}x${info.h}`);
      if (!info.muted) throw new Error('the player started with sound');
      if (!info.src.startsWith('blob:')) throw new Error(`expected hls.js (MSE), got ${info.src}`);
      if (!(await hlsMuxers(apiPort)).includes('live/landscape')) throw new Error('no HLS muxer while watching');
      // Let it settle, then read the delay the player shows (time behind Relay's ingest).
      await sleep(8000);
      const status = (await page.locator('.live-status').textContent()) ?? '';
      const m = /([\d.]+) s behind/.exec(status);
      if (!m) throw new Error(`status: "${status}"`);
      const behind = Number(m[1]);
      if (behind > 4) throw new Error(`the player is ${behind} s behind`);
      // Every URL the page fetched: no MediaMTX session, no credentials.
      const urls = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));
      const live = urls.filter((u) => u.includes('/live'));
      if (live.length < 5 || live.some((u) => /session=|pass=|key=|token/i.test(u) || !u.startsWith(base))) {
        throw new Error(`unexpected live preview URLs: ${live.slice(0, 5).join(', ')}`);
      }
      await shot(page, 'player-landscape');
      return behind;
    });

    await step('sound on: the meter moves, the volume applies', async () => {
      await page.locator('dialog .live-controls button[aria-pressed]').click();
      await until(async () => (await page.locator('dialog .live-controls button[aria-pressed="true"]').count()) === 1 || null, 3000, 'sound on');
      await until(async () => {
        const clip = await page.locator('.live-meter-bar').evaluate((el: { style: { clipPath: string } }) => el.style.clipPath);
        const right = Number(/inset\(0(?:px)? ([\d.]+)%/.exec(clip)?.[1] ?? 100);
        return right < 60 || null; // a 440 Hz sine at −14 dBFS or so: well above the floor
      }, 5000, 'the audio meter to move');
      await page.locator('dialog .live-volume').fill('0.3');
      await page.locator('dialog .live-controls button[aria-pressed]').click();
      await shot(page, 'player-sound');
    });

    if (!quick) {
      await step('measure: one player open', async () => {
        results.push(await measure('1 player (LL-HLS) + thumbnails', pids, 20));
      });
      await step('measure: three players (cap 3) on both feeds', async () => {
        const extra = await Promise.all([context.newPage(), context.newPage()]);
        for (const [i, p] of extra.entries()) {
          await p.goto(base);
          await p.locator(`.feed-thumb.is-${i === 0 ? 'landscape' : 'vertical'} .feed-thumb-watch`).click();
          await until(async () => (await p.locator('dialog .live-frame video').evaluate((v: VideoLike) => v.currentTime > 1)) || null, 30_000, 'second player');
        }
        results.push(await measure('3 players (2 landscape, 1 vertical)', pids, 20));
        for (const p of extra) await p.close();
      });
    }

    await step('close the player: MediaMTX stops muxing ~30 s after the last request', async () => {
      await page.keyboard.press('Escape');
      await page.locator('dialog .live-frame').waitFor({ state: 'detached' });
      const t0 = Date.now();
      await until(async () => (await hlsMuxers(apiPort)).length === 0 || null, 80_000, 'the HLS muxers to stop');
      console.log(`\n  muxers stopped ${((Date.now() - t0) / 1000).toFixed(0)} s after the last player closed`);
    });

    await step('HEVC on the vertical feed: the card and the player show the codec warning, no player', async () => {
      publish(ffmpeg, `rtmp://127.0.0.1:${rtmpPort}/live/${keys.vertical}`, '720x1280', 'hevc');
      const thumb = page.locator('.feed-thumb.is-vertical');
      await until(async () => (await thumb.getAttribute('data-mode')) === 'codec' || null, 30_000, 'the HEVC warning on the card');
      const text = (await thumb.textContent()) ?? '';
      if (!text.includes('HEVC ⚠') || (await thumb.locator('.feed-thumb-watch').count()) !== 0) throw new Error(`vertical thumbnail: ${text}`);
      const res = await page.evaluate(async () => {
        const r = await fetch('/api/profiles/default/feeds/vertical/live.m3u8', { cache: 'no-store' });
        return { status: r.status, body: (await r.json()) as { code: string; error: string } };
      });
      if (res.status !== 409 || res.body.code !== 'feed_codec' || !res.body.error.startsWith('Vertical feed is HEVC.')) throw new Error(JSON.stringify(res));
      await shot(page, 'dashboard-hevc');
    });

    await step('profiles page: each profile row shows both feeds; Watch works there too', async () => {
      await page.goto(`${base}/profiles`);
      const row = page.locator('.profile-feeds').first();
      await row.locator('.feed-thumb.is-landscape img').waitFor({ timeout: 20_000 });
      await row.locator('.feed-thumb.is-landscape .feed-thumb-watch').click();
      await until(async () => (await page.locator('dialog .live-frame video').evaluate((v: VideoLike) => v.currentTime > 1)) || null, 30_000, 'playback from the profiles page');
      await shot(page, 'profiles');
      await page.keyboard.press('Escape');
    });

    await step('without a login: no previews (and MediaMTX HLS is not reachable without the reader password)', async () => {
      const res = await fetch(`${base}/api/profiles/default/feeds/landscape/live.m3u8`);
      const jpeg = await fetch(`${base}/api/profiles/default/feeds/landscape/preview.jpg`);
      if (res.status !== 401 || jpeg.status !== 401) throw new Error(`${res.status} / ${jpeg.status}`);
      const direct = await fetch(`http://127.0.0.1:${hlsPort}/live/landscape/index.m3u8?cookieCheck=1`);
      if (direct.status !== 401) throw new Error(`MediaMTX HLS without the reader password: ${direct.status}`);
    });

    if (pageErrors.length) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    const leaked = relay.out.filter((l) => l.includes(keys.landscape) || l.includes(keys.vertical) || /session=[0-9a-f-]{36}/.test(l));
    if (leaked.length) throw new Error(`Relay logged a key or an HLS session: ${leaked[0]}`);

    console.log(`\n  player delay behind Relay's ingest: ${latency} s`);
    if (results.length) {
      console.log(`\n  CPU (% of one core) and RSS on this machine (${os.cpus().length} × ${os.cpus()[0]?.model ?? 'CPU'}), 20 s each:`);
      for (const r of results) console.log(r);
    }
  } finally {
    await browser.close().catch(() => {});
    for (const c of [...children]) c.kill('SIGTERM');
    await sleep(1000);
    for (const c of [...children]) c.kill('SIGKILL');
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

const timer = setTimeout(() => {
  console.error(`\nFAIL: exceeded ${OVERALL_TIMEOUT_MS / 1000} s`);
  for (const c of children) c.kill('SIGKILL');
  process.exit(1);
}, OVERALL_TIMEOUT_MS);

main()
  .then(() => {
    clearTimeout(timer);
    console.log('\nPASS');
    process.exit(0);
  })
  .catch((err: unknown) => {
    clearTimeout(timer);
    console.error(`\nFAIL: ${err instanceof Error ? err.message : String(err)}`);
    for (const c of children) c.kill('SIGKILL');
    process.exit(1);
  });
