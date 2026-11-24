import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Destination } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import { EventBus, type PushEvent } from '../events.js';
import type { PushPlan } from '../platforms/types.js';
import type { MediaServer } from '../services.js';
import { MULTITRACK_UNSUPPORTED } from './ffmpeg-args.js';
import {
  backoffDelay,
  createPushSupervisor,
  explainFfmpegError,
  pickMessage,
  type PushSupervisorDeps,
} from './ffmpeg-supervisor.js';
import { captureLogger, fakeSpawn, feedWith, FFMPEG_NO_VIDEO_COPY, FFMPEG_NO_VIDEO_FILTER, flush, type FakeChild, type TrackSet } from './test-helpers.js';

const SECRET = 'sk_live_SECRET123456';
const READER_PASS = 'readerpass123456';
const config = { ffmpegBin: '/opt/tools/ffmpeg' } as AppConfig;
const SLUGS: Record<string, string | null> = { default: null, club: 'dprtmnt' };
const media = {
  readUrl: (profileId: string, feed: string) => {
    const slug = SLUGS[profileId];
    if (slug === undefined) throw new Error('Profile not found');
    return `rtmp://127.0.0.1:1935/live/${slug ? `${slug}/` : ''}${feed}?user=internal&pass=${READER_PASS}`;
  },
} as unknown as MediaServer;
const plan: PushPlan = { url: `rtmp://live.example.com/app/${SECRET}`, mode: 'copy', feeds: ['landscape'] };
/** Push ids are destination ids; d1 belongs to the default profile, club1 to another one. */
const destinations: Record<string, Partial<Destination>> = {
  d1: { id: 'd1', profileId: 'default' },
  club1: { id: 'club1', profileId: 'club' },
  legacy: { id: 'legacy' }, // an old fixture without profileId
};
const repos = { destinations: { get: (id: string) => (destinations[id] as Destination | undefined) ?? null } };

/** The supervisor's media server with the feeds' tracks known (codec guard). */
function mediaWith(tracks: { landscape?: TrackSet | null; vertical?: TrackSet | null }): MediaServer {
  return {
    ...media,
    feeds: () => [feedWith('landscape', tracks.landscape ?? null), feedWith('vertical', tracks.vertical ?? null)],
  } as unknown as MediaServer;
}

function setup(deps: PushSupervisorDeps = {}, mediaServer: MediaServer = media) {
  const bus = new EventBus();
  const events: PushEvent[] = [];
  bus.on('push', (e) => events.push(e));
  const sp = fakeSpawn();
  const cap = captureLogger();
  const sup = createPushSupervisor(
    { config, bus, log: cap.log, media: mediaServer, repos },
    { spawn: sp.spawn, now: () => Date.now(), probeCapabilities: async () => ({ multitrack: true }), ...deps },
  );
  const child = (): FakeChild => {
    const c = sp.last()?.child;
    if (!c) throw new Error('no process spawned');
    return c;
  };
  return { sup, events, sp, child, logs: cap.text, last: () => events.at(-1) };
}

async function progress(child: FakeChild, outTimeUs: number, totalSize = 0): Promise<void> {
  child.stdout.write(`fps=30.00\nbitrate=2500.0kbits/s\ntotal_size=${totalSize}\nout_time_us=${outTimeUs}\nspeed=1.00x\nprogress=continue\n`);
  await flush();
}

async function crash(child: FakeChild, stderr: string, code = 1): Promise<void> {
  child.stderr.write(stderr);
  await flush();
  child.exit(code);
  await flush();
}

const ERR_OUTPUT = `[rtmp @ 0000021f] Server error: invalid stream key ${SECRET}\n[out#0/flv @ 0x55] Error opening output rtmp://live.example.com/app/${SECRET}: I/O error\nConversion failed!\n`;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('helpers', () => {
  it('backs off 1, 2, 4 ... 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('picks the most specific stderr line', () => {
    expect(pickMessage(['[tcp @ 0x1] Connection refused', 'Conversion failed!'])).toBe('Connection refused');
    expect(pickMessage(['Exiting normally, received signal 15.'])).toBe('Exiting normally, received signal 15.');
    expect(pickMessage([])).toBeNull();
  });

  it('explains common network failures in plain words', () => {
    const cases: [string, RegExp][] = [
      ['Error opening output files: Error number -138 occurred', /^Timed out connecting/],
      ['Connection to tcp://live.example.com:1935 failed: Connection timed out', /^Timed out connecting/],
      ['Error number -10060 occurred', /^Timed out connecting/],
      ['Connection to tcp://live.example.com:1935 failed: Connection refused', /refused the connection/],
      ['Error opening output files: Error number -107 occurred', /refused the connection/],
      ['Error number -10061 occurred', /refused the connection/],
      ['Failed to resolve hostname live.example.com: Name or service not known', /^Can't find the platform's server/],
      ['Error number -11001 occurred', /^Can't find the platform's server/],
      ['Error number -110 occurred', /^Can't reach the platform's server/],
      ['No route to host', /^Can't reach the platform's server/],
      ['Error opening output rtmp://live.example.com: I/O error', /closed the connection/],
      ['av_interleaved_write_frame(): Broken pipe', /closed the connection/],
      ['Error writing trailer: Connection reset by peer', /closed the connection/],
      ['Error number -10054 occurred', /closed the connection/],
      ['Server error: invalid stream key [redacted]', /rejected the stream/],
      ['HTTP error 403 Forbidden: Server returned 403 Forbidden (access denied)', /rejected the stream/],
    ];
    for (const [line, expected] of cases) expect(explainFfmpegError(line), line).toMatch(expected);
  });

  it('leaves unrelated or local-feed errors alone', () => {
    expect(explainFfmpegError('Codec not supported')).toBeNull();
    // Bare numbers (ports, bitrates, timestamps) are not errno codes.
    expect(explainFfmpegError('frame=  401 fps= 30 bitrate=-5.0kbits/s size=403kB time=00:00:13.36')).toBeNull();
    expect(explainFfmpegError('Error number -5 happened elsewhere')).toBeNull();
    // The local MediaMTX feed failing is not the platform's fault.
    expect(explainFfmpegError('rtmp://127.0.0.1:1935/live/landscape: Input/output error')).toBeNull();
    expect(explainFfmpegError('Error during demuxing: Input/output error')).toBeNull();
  });
});

describe('PushSupervisor', () => {
  it('spawns FFmpeg with the media read URL and reports starting -> running -> stats', async () => {
    const { sup, events, sp, child, last } = setup();
    sup.start('d1', plan);
    await flush();

    expect(sp.calls).toHaveLength(1);
    const call = sp.calls[0]!;
    expect(call.command).toBe('/opt/tools/ffmpeg');
    expect(call.args).toContain(media.readUrl('default', 'landscape'));
    expect(call.args.at(-1)).toBe(plan.url);
    expect(events).toEqual([{ id: 'd1', status: 'starting', message: null, stats: null, attempt: 0 }]);
    expect(sup.isRunning('d1')).toBe(true);

    await progress(child(), 0); // connected but nothing written yet
    expect(events).toHaveLength(1);

    await progress(child(), 2_000_000, 625_000);
    expect(last()).toMatchObject({ status: 'running', attempt: 0, stats: { bitrateKbps: 2500, fps: 30, speed: 1, uptimeSec: 2 } });

    vi.advanceTimersByTime(1000);
    await progress(child(), 3_000_000, 1_000_000);
    expect(events).toHaveLength(2); // rate limited

    vi.advanceTimersByTime(1000);
    await progress(child(), 4_000_000, 1_375_000);
    expect(events).toHaveLength(3);
    expect(last()?.stats?.bitrateKbps).toBe(3000); // (1_375_000 - 1_000_000) * 8 / 1 s

    await sup.stop('d1');
  });

  it('retries unexpected exits with exponential backoff and a redacted message', async () => {
    const { sup, sp, child, last, logs, events } = setup();
    sup.start('d1', plan);
    await flush();

    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const [i, delay] of delays.entries()) {
      await crash(child(), ERR_OUTPUT);
      expect(last()).toMatchObject({ status: 'retrying', attempt: i + 1, stats: null });
      expect(last()?.message).toBe('The platform closed the connection. Check the stream key and server URL.');

      const count = sp.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sp.calls).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(sp.calls).toHaveLength(count + 1);
      expect(last()).toMatchObject({ status: 'starting', attempt: i + 1 });
    }

    expect(logs()).not.toContain(SECRET);
    expect(logs()).not.toContain(READER_PASS);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    await sup.stop('d1');
  });

  it('redacts a stream key echoed without its URL', async () => {
    const { sup, child, last, logs } = setup();
    sup.start('d1', plan);
    await flush();
    await crash(child(), `[rtmp @ 0x1] Server error: invalid stream key ${SECRET}\n`);
    // The card gets the plain sentence; the (redacted) raw line stays in the logs.
    expect(last()?.message).toBe('The platform rejected the stream. Check the stream key.');
    expect(logs()).toContain('Server error: invalid stream key [redacted]');
    expect(logs()).not.toContain(SECRET);
    await sup.stop('d1');
  });

  it('shows unrecognised FFmpeg errors unchanged', async () => {
    const { sup, child, last } = setup();
    sup.start('d1', plan);
    await flush();
    await crash(child(), '[flv @ 0x1] Codec not supported\n');
    expect(last()?.message).toBe('Codec not supported');
    await sup.stop('d1');
  });

  it('an HEVC feed: FFmpeg\'s "Error opening output files: Invalid argument" becomes the clear message', async () => {
    const { sup, child, last, logs } = setup({}, mediaWith({ landscape: 'hevcAac' }));
    sup.start('d1', plan);
    await flush();
    await crash(child(), `${FFMPEG_NO_VIDEO_COPY.join('\n')}\n`, 234);
    expect(last()).toMatchObject({ status: 'retrying', attempt: 1 });
    expect(last()?.message).toBe(
      'Landscape feed is HEVC. Twitch, YouTube, Kick and the other platforms get the stream unchanged and need H.264. ' +
        'In CTD OBS: Relay dock → Send stream (switches to H.264), or Settings → Output → Video encoder: H.264.',
    );
    // FFmpeg's own line stays in the log for whoever debugs it.
    expect(logs()).toContain('Error opening output files: Invalid argument');
    await sup.stop('d1');
  });

  it('an AV1 feed, and tracks that are not known: still a sentence the operator can act on', async () => {
    const av1 = setup({}, mediaWith({ landscape: 'av1Aac' }));
    av1.sup.start('d1', plan);
    await flush();
    await crash(av1.child(), `${FFMPEG_NO_VIDEO_COPY.join('\n')}\n`, 234);
    expect(av1.last()?.message).toMatch(/^Landscape feed is AV1\. /);
    await av1.sup.stop('d1');

    // No feed state at all (this suite's plain media fake has no feeds()).
    const unknown = setup();
    unknown.sup.start('d1', plan);
    await flush();
    await crash(unknown.child(), `${FFMPEG_NO_VIDEO_COPY.join('\n')}\n`, 234);
    expect(unknown.last()?.message).toBe('Error opening output files: Invalid argument');
    await unknown.sup.stop('d1');

    const noTracks = setup({}, mediaWith({ landscape: null }));
    noTracks.sup.start('d1', plan);
    await flush();
    await crash(noTracks.child(), `${FFMPEG_NO_VIDEO_COPY.join('\n')}\n`, 234);
    expect(noTracks.last()?.message).toMatch(/^Relay found no video it can send in the landscape feed\. Feeds must be H\.264 video with AAC audio\./);
    await noTracks.sup.stop('d1');
  });

  it('Twitch Dual Format on an HEVC feed: "Error binding filtergraph inputs/outputs" becomes the clear message', async () => {
    const track = (feed: 'landscape' | 'vertical') => ({
      feed,
      width: 1920,
      height: 1080,
      fps: { numerator: 60, denominator: 1 },
      bitrateKbps: 6000,
      keyintSec: 2,
      profile: 'high' as const,
      bframes: 2,
    });
    const ivs: PushPlan = {
      url: `rtmps://ingest.example.com/app/${SECRET}`,
      mode: 'ivs',
      feeds: ['landscape', 'vertical'],
      ivs: { tracks: [track('landscape'), track('vertical')], audioBitrateKbps: 160, audioChannels: 2, preset: 'veryfast' },
    };
    const { sup, child, last } = setup({}, mediaWith({ landscape: 'hevcAac', vertical: 'hevcAac' }));
    sup.start('d1', ivs);
    await flush();
    await crash(child(), `${FFMPEG_NO_VIDEO_FILTER.join('\n')}\n`, 234);
    expect(last()).toMatchObject({ status: 'retrying' });
    expect(last()?.message).toMatch(/^Landscape feed is HEVC\. Twitch Dual Format needs H\.264 feeds\. In CTD OBS: Relay dock → Send stream/);
    await sup.stop('d1');
  });

  it('an H.264 feed: "Invalid argument" stays FFmpeg\'s own line', async () => {
    const { sup, child, last } = setup({}, mediaWith({ landscape: 'h264Aac' }));
    sup.start('d1', plan);
    await flush();
    await crash(child(), `${FFMPEG_NO_VIDEO_COPY.join('\n')}\n`, 234);
    expect(last()?.message).toBe('Error opening output files: Invalid argument');
    await sup.stop('d1');
  });

  it('resets the attempt counter after 60 s of healthy streaming', async () => {
    const { sup, child, last } = setup({ stallTimeoutMs: 10 * 60_000 });
    sup.start('d1', plan);
    await flush();
    await crash(child(), 'boom\n');
    await vi.advanceTimersByTimeAsync(1000);
    await crash(child(), 'boom\n');
    expect(last()).toMatchObject({ status: 'retrying', attempt: 2 });

    await vi.advanceTimersByTimeAsync(2000);
    await progress(child(), 1_000_000);
    expect(last()).toMatchObject({ status: 'running', attempt: 2 });
    await vi.advanceTimersByTimeAsync(61_000);
    await crash(child(), 'boom\n');
    expect(last()).toMatchObject({ status: 'retrying', attempt: 1, message: 'boom' });
    await sup.stop('d1');
  });

  it('stop() terminates FFmpeg, emits stopped and never respawns', async () => {
    const { sup, sp, child, last } = setup();
    sup.start('d1', plan);
    await flush();
    await progress(child(), 1_000_000);

    const proc = child();
    await sup.stop('d1');
    expect(proc.signals).toEqual([process.platform === 'win32' ? undefined : 'SIGTERM']);
    expect(last()).toMatchObject({ id: 'd1', status: 'stopped' });
    expect(sup.isRunning('d1')).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(sp.calls).toHaveLength(1);
    await sup.stop('d1'); // idempotent
  });

  it('escalates to SIGKILL when FFmpeg ignores SIGTERM for 5 s', async () => {
    const { sup, child } = setup();
    sup.start('d1', plan);
    await flush();
    const proc = child();
    proc.ignore.add('SIGTERM');

    let done = false;
    const stopping = sup.stop('d1').then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(proc.signals.at(-1)).toBe('SIGKILL');
  });

  it('concurrent stop() calls both wait for the exit and emit stopped once', async () => {
    const { sup, child, events } = setup();
    sup.start('d1', plan);
    await flush();
    child().ignore.add('SIGTERM');
    let a = false;
    let b = false;
    const s1 = sup.stop('d1').then(() => (a = true));
    const s2 = sup.stop('d1').then(() => (b = true));
    await flush();
    expect([a, b]).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([s1, s2]);
    expect(events.filter((e) => e.status === 'stopped')).toHaveLength(1);
  });

  it('stop() during the retry wait cancels the retry', async () => {
    const { sup, sp, child, events } = setup();
    sup.start('d1', plan);
    await flush();
    await crash(child(), 'boom\n');
    await sup.stop('d1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sp.calls).toHaveLength(1);
    expect(events.map((e) => e.status)).toEqual(['starting', 'retrying', 'stopped']);
  });

  it('start() on a running id restarts it without a stopped event', async () => {
    const { sup, sp, events } = setup();
    sup.start('d1', plan);
    await flush();
    const first = sp.calls[0]!.child;

    const plan2: PushPlan = { ...plan, url: 'rtmp://other.example.com/app/anotherkey99' };
    sup.start('d1', plan2);
    await flush();
    expect(first.signals).toHaveLength(1);
    expect(sp.calls).toHaveLength(2);
    expect(sp.calls[1]!.args.at(-1)).toBe(plan2.url);
    expect(events.map((e) => e.status)).toEqual(['starting', 'starting']);
    expect(sup.isRunning('d1')).toBe(true);
    await sup.stopAll();
    expect(sup.isRunning('d1')).toBe(false);
  });

  it('fails (no retry) when FFmpeg is missing', async () => {
    const { sup, sp, child, last } = setup();
    sup.start('d1', plan);
    await flush();
    child().failToSpawn('ENOENT');
    await flush();
    expect(last()).toMatchObject({ status: 'failed' });
    expect(last()?.message).toContain('npm run setup-tools');
    expect(sup.isRunning('d1')).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sp.calls).toHaveLength(1);
  });

  it('fails multitrack plans when the FFmpeg build cannot mux them', async () => {
    const { sup, sp, last } = setup({ probeCapabilities: async () => ({ multitrack: false }) });
    sup.start('d1', { ...plan, mode: 'multitrack', feeds: ['landscape', 'vertical'] });
    await flush();
    expect(sp.calls).toHaveLength(0);
    expect(last()).toMatchObject({ status: 'failed', message: MULTITRACK_UNSUPPORTED });
  });

  it('builds multitrack pushes from both feeds when supported', async () => {
    const { sup, sp } = setup();
    sup.start('d1', { ...plan, mode: 'multitrack', feeds: ['landscape', 'vertical'] });
    await flush();
    expect(sp.calls[0]?.args).toEqual(
      expect.arrayContaining([media.readUrl('default', 'landscape'), media.readUrl('default', 'vertical'), '1:v:0']),
    );
    await sup.stop('d1');
  });

  describe("'ivs' pushes (Twitch Dual Format through Relay)", () => {
    const flvHeader = Buffer.from('FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00', 'latin1');
    const videoTag = (body: Buffer) => {
      const h = Buffer.alloc(11);
      h[0] = 9;
      h.writeUIntBE(body.length, 1, 3);
      return Buffer.concat([h, body, Buffer.alloc(4)]);
    };
    const keyframe = Buffer.from([0x17, 1, 0, 0, 0, 0, 0, 0, 3, 0x65, 0x88, 0x80]);
    const ivsPlan = (port: number): PushPlan => ({
      url: `rtmp://127.0.0.1:${port}/app/${SECRET}`,
      mode: 'ivs',
      feeds: ['landscape', 'vertical'],
      ivs: {
        tracks: [
          { feed: 'landscape', width: 1920, height: 1080, fps: { numerator: 60, denominator: 1 }, bitrateKbps: 6000, keyintSec: 2, profile: 'high', bframes: 3 },
          { feed: 'vertical', width: 1080, height: 1920, fps: { numerator: 60, denominator: 1 }, bitrateKbps: 5000, keyintSec: 2, profile: 'high', bframes: 3 },
        ],
        audioBitrateKbps: 160,
        audioChannels: 2,
        preset: 'veryfast',
      },
    });
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(cond()).toBe(true);
    };

    it('publishes FFmpeg’s stdout itself (progress on fd 3) and unpublishes on stop', async () => {
      vi.useRealTimers();
      const { startFakeIngest } = await import('./rtmp-test-server.js');
      const ingest = await startFakeIngest();
      try {
        const { sup, sp, events } = setup();
        sup.start('d1', ivsPlan(ingest.port));
        await until(() => sp.calls.length === 1);
        const call = sp.calls[0]!;
        expect(call.options.stdio).toEqual(['ignore', 'pipe', 'pipe', 'pipe']);
        expect(call.args.at(-1)).toBe('pipe:1');
        expect(call.args.join(' ')).not.toContain(SECRET); // FFmpeg never sees the stream key
        call.child.stdout.write(Buffer.concat([flvHeader, videoTag(keyframe)]));
        call.child.fd3.write('out_time_us=2000000\ntotal_size=1000\nprogress=continue\n');
        await until(() => ingest.messages.length === 1 && events.some((e) => e.status === 'running'));
        expect(ingest.messages[0]!.payload.length).toBeGreaterThan(keyframe.length); // BPM added
        await sup.stop('d1');
        await ingest.unpublished;
        expect(events.at(-1)?.status).toBe('stopped');
      } finally {
        await ingest.close();
      }
    });

    it('warns while encoding runs slower than real time, and clears when it keeps up again', async () => {
      vi.useRealTimers();
      const { startFakeIngest } = await import('./rtmp-test-server.js');
      const ingest = await startFakeIngest();
      try {
        const { sup, sp, events } = setup();
        sup.start('d1', ivsPlan(ingest.port));
        await until(() => sp.calls.length === 1);
        const fd3 = sp.calls[0]!.child.fd3;
        let t = 0;
        const block = (speed: number) => {
          t += 2_000_000;
          fd3.write(`out_time_us=${t}\ntotal_size=${t}\nspeed=${speed}x\nprogress=continue\n`);
        };
        for (let i = 0; i < 5; i++) block(1); // first 10 s: grace
        for (let i = 0; i < 4; i++) block(0.8);
        await until(() => events.some((e) => e.status === 'running' && e.message !== null));
        expect(events.findLast((e) => e.status === 'running')?.message).toMatch(/can't encode Twitch Dual Format fast enough \(0\.80× real time\)/);
        for (let i = 0; i < 4; i++) block(1);
        await until(() => events.findLast((e) => e.status === 'running')?.message === null);
        await sup.stop('d1');
      } finally {
        await ingest.close();
      }
    });

    it('stops FFmpeg and retries when Twitch refuses the stream, saying why', async () => {
      vi.useRealTimers();
      const { startFakeIngest } = await import('./rtmp-test-server.js');
      const ingest = await startFakeIngest({ refusePublish: 'NetStream.Publish.BadName' });
      try {
        const { sup, sp, events, logs } = setup();
        sup.start('d1', ivsPlan(ingest.port));
        await until(() => events.some((e) => e.status === 'retrying'));
        expect(sp.calls[0]!.child.signals).toContain('SIGKILL');
        expect(events.find((e) => e.status === 'retrying')?.message).toMatch(/^Twitch refused the Dual Format stream \(NetStream\.Publish\.BadName/);
        expect(logs()).not.toContain(SECRET);
        await sup.stop('d1');
      } finally {
        await ingest.close();
      }
    });
  });

  it("reads the feed of the destination's own profile, so two profiles stream at once", async () => {
    const { sup, sp } = setup();
    sup.start('d1', plan);
    sup.start('club1', { ...plan, url: 'rtmp://club.example.com/app/clubkey123', feeds: ['vertical'] });
    await flush();
    expect(sp.calls).toHaveLength(2);
    const byTarget = new Map(sp.calls.map((c) => [c.args.at(-1), c.args]));
    expect(byTarget.get(plan.url)).toContain('rtmp://127.0.0.1:1935/live/landscape?user=internal&pass=readerpass123456');
    expect(byTarget.get('rtmp://club.example.com/app/clubkey123')).toContain(
      'rtmp://127.0.0.1:1935/live/dprtmnt/vertical?user=internal&pass=readerpass123456',
    );
    expect(sup.isRunning('d1') && sup.isRunning('club1')).toBe(true);
    await sup.stopAll();
  });

  it('treats a destination without a profile as the default profile', async () => {
    const { sup, sp } = setup();
    sup.start('legacy', plan);
    await flush();
    expect(sp.calls[0]?.args).toContain(media.readUrl('default', 'landscape'));
    await sup.stop('legacy');
  });

  it('fails (never guessing a profile) for an unknown destination', async () => {
    const { sup, sp, last } = setup();
    sup.start('ghost', plan);
    await flush();
    expect(sp.calls).toHaveLength(0);
    expect(last()).toMatchObject({ id: 'ghost', status: 'failed', message: expect.stringMatching(/Unknown destination/) });
    expect(sup.isRunning('ghost')).toBe(false);
  });

  it('kills and retries a stalled FFmpeg', async () => {
    const { sup, child, last } = setup({ stallTimeoutMs: 30_000 });
    sup.start('d1', plan);
    await flush();
    const proc = child();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(proc.signals).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(proc.signals).toEqual(['SIGKILL']);
    expect(last()).toMatchObject({ status: 'retrying', attempt: 1, message: 'No progress from FFmpeg for 30 s' });
    await sup.stop('d1');
  });
});
