// SRTLA end to end (docs/SRTLA.md) with the real binaries, through Relay's own MediaServer and auth hook:
//
//   FFmpeg (SRT caller, MPEG-TS H.264 + AAC) → srtla_send (two bonded links: 127.0.0.1 + 127.0.0.2)
//     → srtla_rec (supervised by Relay, SRTLA_PORT) → MediaMTX SRT listener (127.0.0.1:SRT_PORT)
//
//   - the streamid (path + key) survives the SRTLA hop: the auth hook sees it and the feed comes online
//     as H.264 + AAC; MediaMTX sees the publisher at 127.0.0.1 (it came through srtla_rec)
//   - a wrong or missing key is refused; the group cap (SRTLA_MAX_GROUPS=1 here) refuses a second sender
//   - no key in Relay's captured logs (srtla_rec's and MediaMTX's lines included)
//
//   npm run setup-tools && npm run e2e:srtla       (needs ./tools/srtla_rec + ./tools/srtla_send: a C compiler)

import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { srtUrl } from '../shared/srt.js';
import { srtlaEndpointFromStreamKey } from '../shared/srtla.js';
import { DEFAULT_PROFILE_ID, type FeedState } from '../shared/types.js';
import { loadConfig } from '../server/src/config.js';
import { openDatabase } from '../server/src/db/database.js';
import { createRepos } from '../server/src/db/repos.js';
import { EventBus } from '../server/src/events.js';
import { createMediaMtxApi } from '../server/src/media/mediamtx-api.js';
import { createMediaServer, udpPortFree } from '../server/src/media/mediamtx.js';
import { createSecretBox } from '../server/src/security/secretbox.js';
import type { MediaMtxAuthRequest } from '../server/src/services.js';

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

const usedUdp = new Set<number>();
async function freeUdpPort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const p = 20_000 + Math.floor(Math.random() * 20_000);
    if (!usedUdp.has(p) && (await udpPortFree(p))) {
      usedUdp.add(p);
      return p;
    }
  }
  throw new Error('no free UDP port');
}

function proc(bin: string, args: string[], output: string[]): Proc {
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) as Proc;
  child.tail = [];
  for (const s of [child.stdout, child.stderr]) {
    s?.setEncoding('utf8');
    s?.on('data', (d: string) => {
      for (const l of d.split(/\r?\n/)) {
        if (!l || l.includes('SRT.in: @')) continue;
        output.push(l);
        child.tail.push(l);
      }
      child.tail.splice(0, Math.max(0, child.tail.length - 30));
    });
  }
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

function waitForFeed(bus: EventBus, match: (v: FeedState) => boolean, timeoutMs: number, what: string): Promise<FeedState> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`));
    }, timeoutMs);
    const off = bus.on('feed', (v: FeedState) => {
      if (!match(v)) return;
      clearTimeout(timer);
      off();
      resolve(v);
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

/** OBS-like low-delay test pattern over SRT (MPEG-TS, H.264 zerolatency + AAC). */
function pattern(url: string, extra: string[] = []): string[] {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-re',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=700',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-bf', '0', '-g', '30', '-pix_fmt', 'yuv420p', '-b:v', '2500k',
    '-c:a', 'aac', '-b:a', '128k',
    ...extra, '-muxdelay', '0', '-muxpreload', '0', '-pkt_size', '1316', '-f', 'mpegts', url,
  ];
}

async function run(): Promise<void> {
  const [rtmpPort, apiPort, hlsPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const srtPort = await freeUdpPort();
  const srtlaPort = await freeUdpPort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctd-srtla-'));
  const config = loadConfig({
    DATA_DIR: dataDir,
    RTMP_PORT: String(rtmpPort),
    SRT_PORT: String(srtPort),
    SRTLA_PORT: String(srtlaPort),
    SRTLA_MAX_GROUPS: '1',
    SRTLA_BIN: process.env.SRTLA_BIN,
    MEDIAMTX_API_PORT: String(apiPort),
    MEDIAMTX_HLS_PORT: String(hlsPort),
    MEDIAMTX_BIN: process.env.MEDIAMTX_BIN,
    FFMPEG_BIN: process.env.FFMPEG_BIN,
    TLS_MODE: 'off',
  });
  const srtlaSend = process.env.SRTLA_SEND_BIN ?? path.join(path.dirname(config.srtlaBin!), 'srtla_send');
  for (const bin of [config.mediamtxBin, config.ffmpegBin, config.srtlaBin!, srtlaSend]) {
    if (!existsSync(bin)) throw new Error(`${bin} not found; run \`npm run setup-tools\` (with cc, make and git installed) first`);
  }
  const ff = config.ffmpegBin;

  // Every Relay log line (trace level: MediaMTX's and srtla_rec's debug lines too), to search for keys.
  const logLines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logLines.push(chunk.toString());
      if (process.env.SRTLA_E2E_LOG) process.stderr.write(chunk);
      cb();
    },
  });
  const log = pino({ level: 'trace' }, sink);
  const bus = new EventBus();
  const repos = createRepos(openDatabase(':memory:'), createSecretBox(crypto.randomBytes(32)));
  const media = createMediaServer({ config, bus, log: log.child({ mod: 'mediamtx' }), repos });
  const api = createMediaMtxApi(apiPort);
  const toolOutput: string[] = []; // the test's own FFmpeg (its errors may echo its URL: not Relay's)
  const senderOutput: string[] = []; // srtla_send (stands in for BELABOX/Moblin): checked for keys too

  // Record what the auth hook saw (never the key itself: whether it matched).
  const seen: { action: string; protocol: string; ip: string; path: string; keyMatches: string | null; ok: boolean }[] = [];
  let knownKeys: Record<string, string> = {};
  const authorize = media.authorize.bind(media);
  media.authorize = (req: MediaMtxAuthRequest) => {
    const ok = authorize(req);
    const k = new URLSearchParams(req.query.replace(/^\?/, '')).get('key');
    seen.push({ action: req.action, protocol: req.protocol, ip: req.ip, path: req.path, keyMatches: k === null ? null : (Object.entries(knownKeys).find(([, v]) => v === k)?.[0] ?? 'other'), ok });
    return ok;
  };

  // Two bonded links: srtla_send binds one UDP socket per source address (Linux routes all of 127/8 to lo).
  const ipsFile = path.join(dataDir, 'srtla_ips');
  await fs.writeFile(ipsFile, '127.0.0.1\n127.0.0.2\n');
  const startSender = async () => {
    const port = await freeUdpPort();
    const p = proc(srtlaSend, [String(port), '127.0.0.1', String(srtlaPort), ipsFile], senderOutput);
    await sleep(1500); // registers its group and both links with srtla_rec
    return { port, p };
  };
  const isOnline = (feed: 'landscape' | 'vertical') => (f: FeedState) => f.profileId === DEFAULT_PROFILE_ID && f.feed === feed && f.online && !!f.video;

  try {
    console.log(`MediaMTX   ${config.mediamtxBin}\nFFmpeg     ${ff}\nsrtla_rec  ${config.srtlaBin}\nsrtla_send ${srtlaSend}\nSRT :${srtPort}/udp, SRTLA :${srtlaPort}/udp, data ${dataDir}\n`);
    await step('start MediaServer: MediaMTX with SRT, then srtla_rec', async () => {
      await media.start();
      const s = media.srtlaStatus?.();
      if (!s?.enabled || s.port !== srtlaPort) throw new Error(`SRTLA status: ${JSON.stringify(s)}`);
      await sleep(1500); // srtla_rec probes the SRT listener, then binds
    });
    const keys = await media.ingestKeys(DEFAULT_PROFILE_ID);
    knownKeys = { landscape: keys.landscape, vertical: keys.vertical };
    const field = await media.streamKeyField(DEFAULT_PROFILE_ID, 'landscape');
    const endpoint = srtlaEndpointFromStreamKey('relay.example.com', srtlaPort, media.appName, field)!;

    const a = await startSender();
    const feed = await step(`bonded publish: FFmpeg → srtla_send (2 links) → srtla_rec → MediaMTX, streamid ${endpoint.streamId.replace(/key=.*/, 'key=…')} → feed online`, async () => {
      const online = waitForFeed(bus, isOnline('landscape'), 30_000, 'landscape online');
      // What BELABOX/Moblin do: SRT with the streamid from the ingest details, into their local srtla sender.
      const pub = proc(ff, pattern(`srt://127.0.0.1:${a.port}?streamid=${endpoint.streamId}&latency=1000000`), toolOutput);
      return Promise.race([
        online,
        exitCode(pub, 30_000).then((c) => {
          throw new Error(`publisher exited (${c}): ${pub.tail.slice(-3).join(' | ')} / srtla_send: ${a.p.tail.slice(-3).join(' | ')}`);
        }),
      ]);
    });
    console.log(`  feed: ${feed.video?.codec} ${feed.video?.width}x${feed.video?.height}, audio ${feed.audio?.codec ?? 'none'}`);
    if (feed.video?.codec !== 'h264' || feed.audio?.codec !== 'aac') throw new Error('codec guard: expected h264 + aac');

    await step('the streamid survived the SRTLA hop (auth hook + MediaMTX connection)', async () => {
      const hit = seen.find((s) => s.action === 'publish' && s.ok && s.path === 'live/landscape');
      if (!hit || hit.protocol !== 'srt' || hit.keyMatches !== 'landscape') throw new Error(`auth hook saw ${JSON.stringify(hit)}`);
      const conns = await api.listSrtConns!();
      const pubConn = conns.find((c) => c.state === 'publish' && c.path === 'live/landscape');
      if (!pubConn) throw new Error(`no SRT publisher in MediaMTX: ${JSON.stringify(conns.map((c) => ({ state: c.state, path: c.path })))}`);
      console.log(`\n  auth hook: action=publish protocol=${hit.protocol} ip=${hit.ip} path=${hit.path} key=<landscape key, matched>; MediaMTX srtconn path=${pubConn.path} remoteAddr=${pubConn.remoteAddr}`);
      if (!/^127\.0\.0\.1:/.test(pubConn.remoteAddr ?? '')) throw new Error('the publisher did not come through srtla_rec');
      const regs = logLines.filter((l) => l.includes('connection registration')).map((l) => /(\d+\.\d+\.\d+\.\d+):\d+ \(group [^)]*\): connection registration$/.exec(JSON.parse(l).msg ?? '')?.[1]).filter(Boolean);
      console.log(`  srtla_rec link registrations from: ${[...new Set(regs)].join(', ')}`);
      if (new Set(regs).size < 2) throw new Error('expected two bonded links');
    });

    await step('refused through SRTLA: wrong key, no key, another feed’s key on this path', async () => {
      const urls = [
        `srt://127.0.0.1:PORT?streamid=publish:live/vertical:key=wrongwrongwrongwrong`,
        `srt://127.0.0.1:PORT?streamid=publish:live/vertical`,
        `srt://127.0.0.1:PORT?streamid=publish:live/vertical:key=${keys.landscape}`,
      ];
      for (const u of urls) {
        const s = await startSender();
        const before = seen.length;
        const bad = proc(ff, ['-t', '3', ...pattern(u.replace('PORT', String(s.port)))], toolOutput);
        const code = await exitCode(bad, 20_000);
        bad.kill('SIGKILL');
        s.p.kill('SIGKILL');
        if (code === 0 || media.feed(DEFAULT_PROFILE_ID, 'vertical').online) throw new Error(`accepted: ${u.replace(/key=[^&]+/, 'key=…')}`);
        const tried = seen.slice(before).filter((x) => x.path === 'live/vertical');
        if (tried.length === 0 || tried.some((x) => x.ok)) throw new Error(`auth hook: ${JSON.stringify(tried)}`);
      }
      if (!media.feed(DEFAULT_PROFILE_ID, 'landscape').online) throw new Error('the bonded publisher was kicked out');
    });

    await step('group cap (SRTLA_MAX_GROUPS=1): a second bonded sender with the right key is refused', async () => {
      const s = await startSender();
      const before = seen.length;
      const second = proc(ff, ['-t', '3', ...pattern(srtUrl('127.0.0.1', s.port, 'publish', 'live/vertical', keys.vertical, 1000))], toolOutput);
      const code = await exitCode(second, 20_000);
      second.kill('SIGKILL');
      s.p.kill('SIGKILL');
      const tried = seen.slice(before).filter((x) => x.path === 'live/vertical');
      if (code === 0 || tried.length === 0 || tried.some((x) => x.ok) || tried.some((x) => x.keyMatches !== 'vertical')) throw new Error(`cap not applied: ${JSON.stringify(tried)}`);
      if (!logLines.some((l) => l.includes('SRTLA_MAX_GROUPS'))) throw new Error('no cap log line');
    });

    await step('the same key over plain SRT from the LAN side is not capped (only bonded senders are)', async () => {
      // Plain SRT straight to MediaMTX from 127.0.0.1 would look bonded; skip when no other address is there.
      const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
      if (!lan) {
        process.stdout.write('(no non-loopback IPv4 address: skipped) ');
        return;
      }
      const online = waitForFeed(bus, isOnline('vertical'), 30_000, 'vertical online');
      const pub = proc(ff, pattern(srtUrl(lan, srtPort, 'publish', 'live/vertical', keys.vertical, 500)), toolOutput);
      await Promise.race([online, exitCode(pub, 30_000).then((c) => Promise.reject(new Error(`exited ${c}: ${pub.tail.slice(-2).join(' | ')}`)))]);
      pub.kill('SIGKILL');
    });

    await step('no key in Relay’s logs (srtla_rec + MediaMTX lines at trace level) or in srtla_send’s output', async () => {
      const relay = logLines.join('');
      for (const k of Object.values(keys)) {
        if (relay.includes(k)) throw new Error('a key reached Relay’s logs');
        if (senderOutput.some((l) => l.includes(k))) throw new Error('a key reached srtla_send’s output');
      }
      const srtlaLines = logLines.filter((l) => l.includes('srtla_rec')).length;
      console.log(`\n  ${logLines.length} Relay log lines checked (${srtlaLines} from/about srtla_rec)`);
      if (srtlaLines === 0) throw new Error('no srtla_rec lines captured');
    });

    await step('stop: srtla_rec and MediaMTX go away', async () => {
      await media.stop();
      if (!media.srtlaStatus) throw new Error('no status');
      // The receiver's UDP port is free again.
      await sleep(300);
      if (!(await udpPortFree(srtlaPort))) throw new Error('srtla_rec still holds its port');
    });
    console.log('\nPASS');
  } finally {
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
