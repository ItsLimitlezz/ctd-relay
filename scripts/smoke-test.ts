// End-to-end media relay smoke test with the real binaries in ./tools (npm run smoke).
//
//   OBS stand-ins (FFmpeg test patterns) -> MediaMTX (auth via our loopback server)
//     -> PushSupervisor (FFmpeg -c copy) -> fake platforms (FFmpeg -listen 1)
//
// Also the feed codec guard's two facts: an HEVC feed is reported as `hevc`, and a push started on
// it anyway gets the clear message instead of FFmpeg's "Invalid argument".
//
// Two profiles stream at the same time: the default profile on the pre-profiles paths/keys
// (`live/landscape?key=…`) and a second profile, added while MediaMTX runs, on
// `live/<slug>/landscape?key=…` (published the way OBS does it: server `…/live`, key `<slug>/landscape?key=…`).
//
// Uses a temp DATA_DIR, an in-memory database and free non-default ports. Prints PASS/FAIL, exit code 0/1.
// Options: --no-multitrack (skip the experimental E-RTMP multitrack check), SMOKE_LOG=debug.

import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { feedProblem } from '../shared/feed-codec.js';
import { DEFAULT_PROFILE_ID, type Feed, type FeedState } from '../shared/types.js';
import { loadConfig } from '../server/src/config.js';
import { openDatabase } from '../server/src/db/database.js';
import { createRepos } from '../server/src/db/repos.js';
import { EventBus, type PushEvent } from '../server/src/events.js';
import { createPushSupervisor } from '../server/src/media/ffmpeg-supervisor.js';
import { LivePreviewService, VIEWER_IDLE_MS } from '../server/src/media/live-preview.js';
import { HLS_MUXER_CLOSE_AFTER_SEC } from '../server/src/media/mediamtx-config.js';
import { createMediaServer } from '../server/src/media/mediamtx.js';
import { createSecretBox } from '../server/src/security/secretbox.js';

const OVERALL_TIMEOUT_MS = 240_000;
const withMultitrack = !process.argv.includes('--no-multitrack');

type Proc = ChildProcess & { tail: string[]; videos: string[] };
const children = new Set<ChildProcess>();

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

/** Spawn FFmpeg, keeping the last stderr lines (and every input video stream line) for diagnostics. */
function ffmpeg(bin: string, args: string[]): Proc {
  const child = spawn(bin, ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }) as Proc;
  child.tail = [];
  child.videos = [];
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (d: string) => {
    const lines = d.split(/\r?\n/).filter(Boolean);
    child.tail.push(...lines);
    child.tail.splice(0, Math.max(0, child.tail.length - 40));
    child.videos.push(...lines.filter((l) => /Stream #0:\d+.*Video:/.test(l)));
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

function exitCode(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process did not exit within ${timeoutMs / 1000} s`)), timeoutMs);
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function testPattern(size: string, freq: number, url: string, extra: string[] = []): string[] {
  return [
    '-loglevel', 'error', '-re',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=${freq}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-g', '60', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', ...extra, '-f', 'flv', url,
  ];
}

/**
 * Publish like OBS: server URL `rtmp://host:port/live` + stream key `<key field>` (RTMP app `live`,
 * stream name = the whole key field, e.g. `dprtmnt/landscape?key=…`).
 */
function obsPublish(bin: string, rtmp: string, keyField: string, size: string, freq: number, extra: string[] = []): Proc {
  return ffmpeg(bin, [...extra, ...testPattern(size, freq, `${rtmp}/live`, ['-rtmp_app', 'live', '-rtmp_playpath', keyField])]);
}

async function run(): Promise<void> {
  const [rtmpPort, apiPort, platformPort, platformPort2, platformPort3, hlsPort] = await Promise.all([
    freePort(), freePort(), freePort(), freePort(), freePort(), freePort(),
  ]);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctd-smoke-'));
  const config = loadConfig({
    DATA_DIR: dataDir,
    RTMP_PORT: String(rtmpPort),
    MEDIAMTX_API_PORT: String(apiPort),
    MEDIAMTX_HLS_PORT: String(hlsPort),
    MEDIAMTX_BIN: process.env.MEDIAMTX_BIN,
    FFMPEG_BIN: process.env.FFMPEG_BIN,
    TLS_MODE: 'off',
  });
  for (const bin of [config.mediamtxBin, config.ffmpegBin]) {
    if (!existsSync(bin)) throw new Error(`${bin} not found; run \`npm run setup-tools\` first`);
  }

  const log = pino({ level: process.env.SMOKE_LOG ?? 'warn' });
  const bus = new EventBus();
  const db = openDatabase(':memory:');
  const repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
  const media = createMediaServer({ config, bus, log: log.child({ mod: 'mediamtx' }), repos });
  const pushes = createPushSupervisor({ config, bus, log: log.child({ mod: 'ffmpeg' }), media, repos });
  const rtmp = `rtmp://127.0.0.1:${rtmpPort}`;
  const ff = config.ffmpegBin;
  const live = new LivePreviewService({
    feed: (p, f) => media.feed(p, f),
    source: (p, f) => media.hlsSource?.(p, f) ?? null,
    maxViewers: 2,
  });
  const hlsMuxers = async (): Promise<string[]> => {
    const res = await fetch(`http://127.0.0.1:${apiPort}/v3/hlsmuxers/list`);
    const body = (await res.json()) as { items?: { path: string }[] };
    return (body.items ?? []).map((m) => m.path);
  };
  const isOnline = (profileId: string, feed: Feed) => (f: FeedState) => f.profileId === profileId && f.feed === feed && f.online && !!f.video;

  /** A push id is a destination id: the destination's profile decides which feed is read. */
  const destination = (profileId: string, name: string, feed: Feed) =>
    repos.destinations.create({ profileId, platform: 'custom', accountId: null, name, feed, enabled: true, options: {}, ingestUrl: null }).id;
  const mainDest = destination(DEFAULT_PROFILE_ID, 'Main relay', 'landscape');
  const dualDest = destination(DEFAULT_PROFILE_ID, 'Main multitrack', 'landscape');

  async function waitRunning(id: string, what: string): Promise<PushEvent> {
    return Promise.race([
      waitFor<PushEvent>(bus, 'push', (e) => e.id === id && e.status === 'running' && (e.stats?.bitrateKbps ?? 0) > 0, 30_000, `${what} running`),
      waitFor<PushEvent>(bus, 'push', (e) => e.id === id && e.status === 'failed', 30_000, `${what} failure`).then((e) => {
        throw new Error(`${what} failed: ${e.message}`);
      }),
    ]);
  }

  try {
    console.log(`MediaMTX ${config.mediamtxBin}\nFFmpeg   ${config.ffmpegBin}\nRTMP :${rtmpPort}, API :${apiPort}, data ${dataDir}\n`);
    await step('start MediaServer', () => media.start());
    const keys = await media.ingestKeys(DEFAULT_PROFILE_ID);
    if ((await media.streamKeyField(DEFAULT_PROFILE_ID, 'landscape')) !== `landscape?key=${keys.landscape}`) {
      throw new Error('the default profile stream key field changed');
    }

    const feed = await step('default profile: publish landscape on live/landscape, wait for the feed (h264)', async () => {
      const online = waitFor<FeedState>(bus, 'feed', isOnline(DEFAULT_PROFILE_ID, 'landscape'), 30_000, 'landscape online');
      const publisher = ffmpeg(ff, testPattern('1280x720', 1000, `${rtmp}/live/landscape?key=${keys.landscape}`));
      return Promise.race([
        online,
        exitCode(publisher, 30_000).then((c) => {
          throw new Error(`publisher exited (${c}): ${publisher.tail.slice(-3).join(' | ')}`);
        }),
      ]);
    });
    console.log(`  feed: ${feed.video?.codec} ${feed.video?.width}x${feed.video?.height}, audio ${feed.audio?.codec ?? 'none'}`);

    await step('reject a publish with a wrong key', async () => {
      const bad = ffmpeg(ff, ['-t', '3', ...testPattern('320x240', 500, `${rtmp}/live/landscape?key=wrongkey`)]);
      const code = await exitCode(bad, 20_000);
      if (code === 0) throw new Error('publish with a wrong key was accepted');
      if (!media.feed(DEFAULT_PROFILE_ID, 'landscape').online) throw new Error('the real publisher was kicked out');
    });

    await step('reject a publish to an unknown path', async () => {
      const bad = ffmpeg(ff, ['-t', '3', ...testPattern('320x240', 500, `${rtmp}/live/other?key=${keys.landscape}`)]);
      if ((await exitCode(bad, 20_000)) === 0) throw new Error('publish to live/other was accepted');
    });

    await step('reject a read without internal credentials', async () => {
      const reader = ffmpeg(ff, ['-loglevel', 'error', '-rw_timeout', '5000000', '-i', `${rtmp}/live/landscape`, '-t', '2', '-f', 'null', '-']);
      if ((await exitCode(reader, 20_000)) === 0) throw new Error('unauthenticated read was accepted');
    });

    // ---- a second profile, added while MediaMTX runs ------------------------------------
    const club = repos.profiles.create({ name: 'DPRTMNT', color: '#E11D48' });
    const clubDest = destination(club.id, 'Club relay', 'landscape');
    await step('live preview (LL-HLS): muxed only once someone watches, through the proxy only', async () => {
      if ((await hlsMuxers()).length !== 0) throw new Error('an HLS muxer runs before anyone watches');
      const direct = await fetch(`http://127.0.0.1:${hlsPort}/live/landscape/index.m3u8?cookieCheck=1`);
      if (direct.status !== 401) throw new Error(`MediaMTX HLS without the reader password answered ${direct.status}`);
      const t0 = Date.now();
      const master = await live.open(DEFAULT_PROFILE_ID, 'landscape', 'session:smoke-a');
      if (!master.ok || master.kind !== 'playlist') throw new Error(`open: ${JSON.stringify(master)}`);
      const startMs = Date.now() - t0;
      if (master.body.includes('session=') || !/^live\/video\d+_stream\.m3u8\?v=/m.test(master.body)) throw new Error(`master playlist not rewritten:\n${master.body}`);
      if (!master.body.includes('avc1.')) throw new Error('master playlist has no H.264 rendition');
      if (!(await hlsMuxers()).includes('live/landscape')) throw new Error('no HLS muxer while watching');
      const vid = /\?v=([A-Za-z0-9_-]+)/.exec(master.body)?.[1] ?? '';
      const videoList = /^live\/(video\d+_stream\.m3u8)/m.exec(master.body)?.[1] ?? '';
      const media1 = await live.file(DEFAULT_PROFILE_ID, 'landscape', videoList, { v: vid }, 'session:smoke-a');
      if (!media1.ok || media1.kind !== 'playlist') throw new Error(`media playlist: ${JSON.stringify(media1)}`);
      if (media1.body.includes('session=') || !media1.body.includes('#EXT-X-PART:')) throw new Error(`media playlist:\n${media1.body}`);
      const part = [...media1.body.matchAll(/#EXT-X-PART:[^\n]*URI="([^"?]+)\?v=/g)].at(-1)?.[1] ?? '';
      const chunk = await live.file(DEFAULT_PROFILE_ID, 'landscape', part, { v: vid }, 'session:smoke-a');
      if (!chunk.ok || chunk.kind !== 'media') throw new Error(`part: ${JSON.stringify(chunk)}`);
      let bytes = 0;
      for await (const b of chunk.body) bytes += (b as Buffer).length;
      if (bytes < 1000) throw new Error(`part has ${bytes} bytes`);
      // Someone else's viewer id is no good; the third player is over the cap of 2.
      const stolen = await live.file(DEFAULT_PROFILE_ID, 'landscape', videoList, { v: vid }, 'session:smoke-b');
      if (stolen.ok || stolen.code !== 'live_ended') throw new Error('a viewer id worked for another login');
      const second = await live.open(DEFAULT_PROFILE_ID, 'landscape', 'session:smoke-b');
      const third = await live.open(DEFAULT_PROFILE_ID, 'landscape', 'session:smoke-c');
      if (!second.ok || third.ok || third.code !== 'viewer_cap') throw new Error(`viewer cap: ${JSON.stringify([second.ok, third])}`);
      console.log(`\n  first playlist in ${startMs} ms, part ${part} ${bytes} bytes, 3rd viewer: ${third.code}`);
    });

    await step(`live preview: the muxer stops ~${HLS_MUXER_CLOSE_AFTER_SEC} s after the last request`, async () => {
      const t0 = Date.now();
      for (;;) {
        if (!(await hlsMuxers()).includes('live/landscape')) break;
        if (Date.now() - t0 > (HLS_MUXER_CLOSE_AFTER_SEC + 20) * 1000) throw new Error('the HLS muxer is still running');
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (live.viewerCount(DEFAULT_PROFILE_ID, 'landscape') !== 0) throw new Error(`viewers still counted after ${VIEWER_IDLE_MS} ms idle`);
      console.log(`\n  muxer gone ${((Date.now() - t0) / 1000).toFixed(0)} s after the last request`);
    });

    const clubKeyField = await step(`add profile "${club.name}" without restarting MediaMTX`, async () => {
      await media.profileAdded(club);
      const field = await media.streamKeyField(club.id, 'landscape');
      if (!field.startsWith(`${club.slug}/landscape?key=`)) throw new Error(`unexpected stream key field ${field.split('?')[0]}`);
      return field;
    });
    const clubKeys = await media.ingestKeys(club.id);
    /** The second profile's OBS stand-in; deleting the profile must really disconnect it. */
    let clubPublisher: Proc | null = null;

    await step(`second profile: publish like OBS (server …/live, key ${club.slug}/landscape?key=…) while the default profile streams`, async () => {
      const online = waitFor<FeedState>(bus, 'feed', isOnline(club.id, 'landscape'), 30_000, 'club landscape online');
      const publisher = obsPublish(ff, rtmp, clubKeyField, '854x480', 700);
      clubPublisher = publisher;
      const state = await Promise.race([
        online,
        exitCode(publisher, 30_000).then((c) => {
          throw new Error(`club publisher exited (${c}): ${publisher.tail.slice(-3).join(' | ')}`);
        }),
      ]);
      if (state.video?.width !== 854) throw new Error(`club feed has the wrong video (${state.video?.width}x${state.video?.height})`);
      if (!media.feed(DEFAULT_PROFILE_ID, 'landscape').online) throw new Error('the default profile feed went offline');
    });

    await step("reject each profile's key on the other profile's path", async () => {
      const wrong1 = obsPublish(ff, rtmp, `${club.slug}/landscape?key=${keys.landscape}`, '320x240', 500, ['-t', '3']);
      const wrong2 = ffmpeg(ff, ['-t', '3', ...testPattern('320x240', 500, `${rtmp}/live/landscape?key=${clubKeys.landscape}`)]);
      const wrong3 = obsPublish(ff, rtmp, `${club.slug}/landscape?key=${clubKeys.vertical}`, '320x240', 500, ['-t', '3']);
      const codes = await Promise.all([exitCode(wrong1, 20_000), exitCode(wrong2, 20_000), exitCode(wrong3, 20_000)]);
      if (codes.some((c) => c === 0)) throw new Error(`a cross-profile key was accepted (exit codes ${codes.join(', ')})`);
      if (!media.feed(DEFAULT_PROFILE_ID, 'landscape').online || !media.feed(club.id, 'landscape').online) {
        throw new Error('a real publisher was kicked out');
      }
    });

    // ---- both profiles relay at once ---------------------------------------------------
    const platformUrl = `rtmp://127.0.0.1:${platformPort}/app/testkey`;
    const platform = ffmpeg(ff, ['-loglevel', 'info', '-nostats', '-listen', '1', '-i', platformUrl, '-f', 'null', '-']);
    const clubPlatformUrl = `rtmp://127.0.0.1:${platformPort3}/app/clubkey`;
    const clubPlatform = ffmpeg(ff, ['-loglevel', 'info', '-nostats', '-listen', '1', '-i', clubPlatformUrl, '-f', 'null', '-']);
    await sleep(1500); // no readiness signal; a probe connection would consume the single accept

    const [running, clubRunning] = await step('relay both profiles at the same time (copy), each to its own platform', async () => {
      const both = Promise.all([waitRunning(mainDest, 'default relay'), waitRunning(clubDest, 'club relay')]);
      pushes.start(mainDest, { url: platformUrl, mode: 'copy', feeds: ['landscape'] });
      pushes.start(clubDest, { url: clubPlatformUrl, mode: 'copy', feeds: ['landscape'] });
      const result = await both;
      if (!pushes.isRunning(mainDest) || !pushes.isRunning(clubDest)) throw new Error('both relays should be running');
      // Each platform got its own profile's OBS (1280x720 vs 854x480).
      await until(() => platform.videos.length > 0 && clubPlatform.videos.length > 0, 15_000, 'the platforms to report their input');
      if (!platform.videos.some((l) => l.includes('1280x720'))) throw new Error(`default platform got: ${platform.videos.join(' | ')}`);
      if (!clubPlatform.videos.some((l) => l.includes('854x480'))) throw new Error(`club platform got: ${clubPlatform.videos.join(' | ')}`);
      return result;
    });
    console.log(`  default push: ${running.stats?.bitrateKbps} kbit/s, ${running.stats?.fps} fps, speed ${running.stats?.speed}x`);
    console.log(`  club push:    ${clubRunning.stats?.bitrateKbps} kbit/s, ${clubRunning.stats?.fps} fps, speed ${clubRunning.stats?.speed}x`);
    if (platform.exitCode !== null) throw new Error(`fake platform exited: ${platform.tail.slice(-3).join(' | ')}`);
    if (clubPlatform.exitCode !== null) throw new Error(`club fake platform exited: ${clubPlatform.tail.slice(-3).join(' | ')}`);

    if (withMultitrack) {
      await step('EXPERIMENTAL multitrack: landscape + vertical in one E-RTMP connection', async () => {
        const vOnline = waitFor<FeedState>(bus, 'feed', isOnline(DEFAULT_PROFILE_ID, 'vertical'), 30_000, 'vertical online');
        ffmpeg(ff, testPattern('720x1280', 600, `${rtmp}/live/vertical?key=${keys.vertical}`));
        await vOnline;

        const url2 = `rtmp://127.0.0.1:${platformPort2}/app/dualkey`;
        const receiver = ffmpeg(ff, ['-loglevel', 'info', '-listen', '1', '-i', url2, '-map', '0', '-c', 'copy', '-t', '6', '-f', 'null', '-']);
        await sleep(1500);
        const ev = waitFor<PushEvent>(bus, 'push', (e) => e.id === dualDest && e.status === 'running', 30_000, 'multitrack push running');
        pushes.start(dualDest, { url: url2, mode: 'multitrack', feeds: ['landscape', 'vertical'] });
        await ev;
        await exitCode(receiver, 30_000);
        if (receiver.videos.length < 2) throw new Error(`receiver saw ${receiver.videos.length} video track(s): ${receiver.tail.slice(-5).join(' | ')}`);
        await pushes.stop(dualDest);
      });
    }

    await step('stop every relay', async () => {
      const stopped = Promise.all(
        [mainDest, clubDest].map((id) => waitFor<PushEvent>(bus, 'push', (e) => e.id === id && e.status === 'stopped', 15_000, `${id} stopped`)),
      );
      await pushes.stopAll();
      await stopped;
      if (pushes.isRunning(mainDest) || pushes.isRunning(clubDest)) throw new Error('push still marked running');
    });

    await step('HEVC feed: reported as hevc and flagged; a push on it says what to change', async () => {
      const isHevc = (f: FeedState) => f.profileId === DEFAULT_PROFILE_ID && f.feed === 'vertical' && f.online && f.video?.codec === 'hevc';
      const online = waitFor<FeedState>(bus, 'feed', isHevc, 30_000, 'vertical online as hevc');
      // Takes the vertical path over from the H.264 publisher of the multitrack step, if it ran.
      const publisher = ffmpeg(ff, [
        '-loglevel', 'error', '-re',
        '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=700',
        '-c:v', 'libx265', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p', '-b:v', '800k',
        '-c:a', 'aac', '-f', 'flv', `${rtmp}/live/vertical?key=${keys.vertical}`,
      ]);
      const hevc = await Promise.race([
        online,
        exitCode(publisher, 30_000).then((c) => {
          throw new Error(`HEVC publisher exited (${c}): ${publisher.tail.slice(-3).join(' | ')}`);
        }),
      ]);
      const problem = feedProblem(hevc);
      if (!problem?.blocking || problem.codec !== 'hevc') throw new Error(`expected a blocking hevc problem, got ${JSON.stringify(problem)}`);
      const watch = await live.open(DEFAULT_PROFILE_ID, 'vertical', 'session:smoke-a');
      if (watch.ok || watch.code !== 'feed_codec') throw new Error(`live preview of an HEVC feed: ${JSON.stringify(watch)}`);

      // The orchestrator never starts this push (codec guard); if one runs anyway, FFmpeg finds no
      // video stream and the supervisor explains it.
      const hevcDest = destination(DEFAULT_PROFILE_ID, 'HEVC relay', 'vertical');
      const retrying = waitFor<PushEvent>(bus, 'push', (e) => e.id === hevcDest && e.status === 'retrying', 30_000, 'the HEVC push to fail');
      pushes.start(hevcDest, { url: `rtmp://127.0.0.1:${platformPort3}/app/hevckey`, mode: 'copy', feeds: ['vertical'] });
      const ev = await retrying;
      await pushes.stop(hevcDest);
      publisher.kill('SIGKILL');
      if (!ev.message?.startsWith('Vertical feed is HEVC.')) throw new Error(`push message: ${ev.message}`);
      console.log(`\n  feed: ${hevc.video?.codec}; push: ${ev.message}`);
    });

    await step('rotate the default landscape key: the publisher using the old key is disconnected', async () => {
      const offline = waitFor<FeedState>(bus, 'feed', (f) => f.profileId === DEFAULT_PROFILE_ID && f.feed === 'landscape' && !f.online, 15_000, 'landscape offline');
      const next = await media.rotateIngestKey(DEFAULT_PROFILE_ID, 'landscape');
      if (next === keys.landscape) throw new Error('key did not change');
      await offline;
      if (!media.feed(club.id, 'landscape').online) throw new Error("the other profile's OBS was disconnected too");
    });

    await step('delete the second profile: its OBS is disconnected and its key stops working', async () => {
      // Check the real connection, not just the event: profileRemoved reports the feed offline even
      // when the kick fails, so wait for the publisher process itself to be dropped by MediaMTX.
      const publisher = clubPublisher as Proc | null;
      if (!publisher || publisher.exitCode !== null || publisher.signalCode !== null) {
        throw new Error('the second profile publisher was not running before the delete');
      }
      const offline = waitFor<FeedState>(bus, 'feed', (f) => f.profileId === club.id && f.feed === 'landscape' && !f.online, 15_000, 'club offline');
      await media.profileRemoved(club.id);
      await offline;
      try {
        await exitCode(publisher, 15_000);
      } catch {
        throw new Error("the deleted profile's OBS stayed connected (its publisher was not kicked)");
      }      repos.profiles.delete(club.id);
      const again = obsPublish(ff, rtmp, clubKeyField, '320x240', 500, ['-t', '3']);
      if ((await exitCode(again, 20_000)) === 0) throw new Error("a deleted profile's key was accepted");
    });
  } finally {
    await pushes.stopAll().catch(() => {});
    for (const c of children) c.kill();
    await media.stop().catch(() => {});
    db.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

const timer = setTimeout(() => {
  console.error(`\nFAIL: smoke test exceeded ${OVERALL_TIMEOUT_MS / 1000} s`);
  for (const c of children) c.kill('SIGKILL');
  process.exit(1);
}, OVERALL_TIMEOUT_MS);

run()
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
