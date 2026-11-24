// CPU cost of transcoding with the real binaries (SR check for 0.2.80, docs/TRANSCODING.md §0):
//
//   npx tsx scripts/transcode-cpu.ts              copy and libx264 720p30 / 720p60 / 1080p30 / 1080p60
//   TC_SECONDS=60 npx tsx scripts/transcode-cpu.ts   a longer window per run (default 30 s)
//
// Starts the pinned MediaMTX on a free local port, publishes a 1080p60 H.264 + AAC test feed into it
// (the "OBS" feed), then runs one push at a time exactly as Relay builds it (buildPushArgs for the
// copy, resolveTranscodeJob + buildTranscodePushArgs for each transcode) to another local MediaMTX
// path, and reads its CPU time from /proc over the window. Prints this machine's capability probe
// next to each row's CPU estimate (cpuEstimate, what the CPU guard decides on), so the estimate can
// be compared with what the encode really costs here. Nothing leaves the machine.
//
// Needs `npm run setup-tools`. Linux only (/proc). Run it on the server itself to see its numbers.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { cpuEstimate } from '../shared/transcode.js';
import type { TranscodeProfile } from '../shared/types.js';
import { buildPushArgs } from '../server/src/media/ffmpeg-args.js';
import { buildTranscodePushArgs, resolveTranscodeJob } from '../server/src/media/transcode-args.js';
import { probeTranscodeCapabilities } from '../server/src/media/transcode-capabilities.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FF = path.join(ROOT, 'tools', 'ffmpeg');
const MTX = path.join(ROOT, 'tools', 'mediamtx');
const SECONDS = Number(process.env.TC_SECONDS ?? 30);
const SETTLE_MS = 8000;
const CLK_TCK = 100; // Linux USER_HZ

const procs: ChildProcess[] = [];
process.on('exit', () => procs.forEach((p) => p.kill('SIGKILL')));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function run(bin: string, args: string[], cwd: string, echo = false): ChildProcess {
  const p = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  if (echo) p.stderr!.on('data', (d: Buffer) => process.stderr.write(d));
  return p;
}

/** User + system CPU ticks of a process. */
function cpuTicks(pid: number): number {
  const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
  return Number(f[11]) + Number(f[12]);
}

async function main(): Promise<void> {
  for (const bin of [FF, MTX]) if (!fs.existsSync(bin)) throw new Error(`${bin} missing: run npm run setup-tools`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctd-transcode-cpu-'));
  const port = await freePort();
  fs.writeFileSync(
    path.join(dir, 'mediamtx.yml'),
    [
      'logLevel: warn', 'api: false', 'metrics: false', 'pprof: false', 'playback: false',
      'rtsp: false', 'webrtc: false', 'srt: false', 'hls: false',
      'rtmp: true', `rtmpAddress: "127.0.0.1:${port}"`,
      'authMethod: internal', 'authInternalUsers:', '  - user: any', '    pass:', '    ips: ["127.0.0.1/32"]', '    permissions:', '      - action: publish', '      - action: read',
      'paths:', '  all_others:',
    ].join('\n'),
  );
  const mtx = run(MTX, [path.join(dir, 'mediamtx.yml')], dir, true);
  await sleep(1500);
  const input = `rtmp://127.0.0.1:${port}/live/feed`;
  const pub = run(
    FF,
    ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v', '6000k', '-maxrate', '6000k', '-bufsize', '12000k', '-g', '120', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-f', 'flv', input],
    dir,
    true,
  );
  await sleep(4000);

  const caps = await probeTranscodeCapabilities({ ffmpegBin: FF });
  const cores = os.cpus().length;
  console.log(`capability probe: ${caps.encoders.filter((e) => e.ok).map((e) => `${e.encoder} ${e.speed ?? '?'}×`).join(', ') || 'no working encoder'}; ${cores} cores`);
  const feed = { video: { codec: 'h264', width: 1920, height: 1080, fps: 60 }, audio: { codec: 'aac' } };

  async function measure(args: string[]): Promise<{ oneCore: number; machine: number; speed: string | null; fps: number | null }> {
    const p = run(FF, ['-nostats', ...args], dir);
    let speed: string | null = null;
    let frames = 0;
    p.stdout!.on('data', (d: Buffer) => {
      const text = d.toString();
      speed = /speed=\s*([0-9.]+)x/.exec(text)?.[1] ?? speed;
      const f = /frame=(\d+)/.exec(text);
      if (f) frames = Number(f[1]);
    });
    await sleep(SETTLE_MS);
    const t0 = cpuTicks(p.pid!);
    const f0 = frames;
    const w0 = Date.now();
    await sleep(SECONDS * 1000);
    const secs = (Date.now() - w0) / 1000;
    const oneCore = ((cpuTicks(p.pid!) - t0) / CLK_TCK / secs) * 100;
    const fps = frames > f0 ? (frames - f0) / secs : null;
    p.kill('SIGTERM');
    await sleep(1000);
    return { oneCore: Math.round(oneCore), machine: Math.round(oneCore / cores), speed, fps: fps === null ? null : Math.round(fps * 10) / 10 };
  }

  const out = (name: string) => `rtmp://127.0.0.1:${port}/out/${name}`;
  const rows: string[] = ['| Push | CPU (one core) | CPU (whole machine) | speed | fps out | CPU guard estimate |', '|---|---|---|---|---|---|'];
  // Both builders already report progress on stdout (-progress pipe:1), as Relay reads it.
  const copy = await measure(buildPushArgs({ url: out('copy'), mode: 'copy', feeds: ['landscape'] }, { landscape: input }, { multitrack: true }));
  rows.push(`| copy (\`-c copy\`) | ${copy.oneCore} % | ${copy.machine} % | ${copy.speed ?? '?'}× | ${copy.fps ?? '?'} | none |`);
  for (const [name, width, height, fps, kbps] of [['720p30', 1280, 720, 30, 3500], ['720p60', 1280, 720, 60, 4500], ['1080p30', 1920, 1080, 30, 6000], ['1080p60', 1920, 1080, 60, 6000]] as const) {
    const profile: TranscodeProfile = { mode: 'transcode', video: { codec: 'h264', width, height, fps, bitrateKbps: kbps, keyframeSec: 2, encoder: 'libx264' }, audio: 'copy', fallback: 'copy' };
    const r = resolveTranscodeJob(profile, 'youtube', caps, feed);
    if (!r.ok) {
      rows.push(`| libx264 ${name} | – | – | – | – | ${r.reason} |`);
      continue;
    }
    const est = cpuEstimate(profile, 'youtube', caps, 60);
    const m = await measure(buildTranscodePushArgs(input, out(name), r.job));
    rows.push(`| libx264 ${name} | ${m.oneCore} % | ${m.machine} % | ${m.speed ?? '?'}× | ${m.fps ?? '?'} | ${est?.load != null ? `about ${Math.round(est.load * 100)} %${est.load >= 1 ? ' (refused)' : ''}` : '?'} |`);
  }
  console.log(rows.join('\n'));
  pub.kill('SIGTERM');
  mtx.kill('SIGTERM');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
