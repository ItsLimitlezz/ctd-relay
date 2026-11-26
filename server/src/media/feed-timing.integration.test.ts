// End to end with a real MediaMTX and FFmpeg (docs/API.md §19): a "publisher" sends a test pattern
// (with an SEI timecode, inserted by FFmpeg's h264_metadata filter) to MediaMTX; GET
// /api/v1/profiles/{id}/timing starts a real FFmpeg copy reader on it. Skipped when the tools aren't
// there: run `npm run setup-tools` (./tools) or set MEDIAMTX_BIN and FFMPEG_BIN.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE_ID, type Feed } from '../../../shared/types.js';
import { createTestApi, type TestApi } from '../api/test-helpers.js';
import { terminate } from './process-utils.js';

const exe = process.platform === 'win32' ? '.exe' : '';
const FFMPEG = process.env.FFMPEG_BIN || path.resolve('tools', `ffmpeg${exe}`);
const MEDIAMTX = process.env.MEDIAMTX_BIN || path.resolve('tools', `mediamtx${exe}`);
const available = existsSync(FFMPEG) && existsSync(MEDIAMTX);

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!available)('feed timing with a real MediaMTX and FFmpeg', () => {
  let dir: string;
  let mtx: ChildProcess;
  let publisher: ChildProcess;
  let t: TestApi;
  let url: string;
  let token: string;

  beforeAll(async () => {
    const port = await freePort();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctd-timing-'));
    const conf = path.join(dir, 'mediamtx.yml');
    await fs.writeFile(
      conf,
      [`logLevel: error`, `rtsp: no`, `rtmp: yes`, `rtmpAddress: 127.0.0.1:${port}`, `hls: no`, `webrtc: no`, `srt: no`, `api: no`, `metrics: no`, `pprof: no`, `playback: no`, `paths:`, `  all_others:`, ''].join('\n'),
    );
    mtx = spawn(MEDIAMTX, [conf], { cwd: dir, stdio: 'ignore', windowsHide: true }); // its auto.crt/auto.key land in dir
    await sleep(800);
    url = `rtmp://127.0.0.1:${port}/live/landscape`;
    // RTMP timestamps start at 5 s (-output_ts_offset), so streamTimeMs shows they pass through.
    publisher = spawn(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '30',
        '-bsf:v', 'h264_metadata=sei_user_data=a0b1c2d3-e4f5-4607-8899-aabbccddeeff+TC 01\\\\:02\\\\:03\\\\:04', '-output_ts_offset', '5', '-f', 'flv', url],
      { stdio: 'ignore', windowsHide: true },
    );
    await sleep(1_500);

    t = await createTestApi();
    (t.services.config as { ffmpegBin: string }).ffmpegBin = FFMPEG;
    const media = t.services.media as unknown as Record<string, unknown>;
    media.feed = (_p: string, feed: Feed) => ({ online: feed === 'landscape', video: null, audio: null });
    media.readUrl = () => url;
    token = t.token(['status:read'], 'ctd obs');
  }, 20_000);

  afterAll(async () => {
    await t?.close();
    if (publisher) await terminate(publisher, 2_000);
    if (mtx) await terminate(mtx, 2_000);
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('GET /timing starts a copy reader: measuring, fps, streamTimeMs on the publisher clock, receivedAt now, the SEI timecode', async () => {
    const get = async () => {
      const res = await t.app.inject({ method: 'GET', url: `/api/v1/profiles/${DEFAULT_PROFILE_ID}/timing`, headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode, res.body).toBe(200);
      return res.json().feeds[0];
    };
    const first = await get();
    expect(first).toMatchObject({ id: 'landscape', online: true, measuring: true });
    let f = first;
    for (let i = 0; i < 40 && (f.fps === null || f.fps < 20); i++) {
      await sleep(250);
      f = await get();
    }
    expect(f.measuring).toBe(true);
    expect(f.fps).toBeGreaterThan(25);
    expect(f.fps).toBeLessThan(35);
    expect(f.streamTimeMs).toBeGreaterThan(5_000); // the publisher's timeline, not the reader's 0
    expect(Math.abs(f.receivedAt - Date.now())).toBeLessThan(2_000);
    expect(f.transitMs).toBeGreaterThanOrEqual(0);
    expect(f.jitterMs).toBeGreaterThanOrEqual(0);
    expect(f.sourceTimecode).toBe('01:02:03:04');
    expect(f.sourceTimecodeStreamTimeMs).toBeLessThanOrEqual(f.streamTimeMs);
  }, 30_000);
});
