import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FeedTimingService,
  FlvTimingParser,
  frameTimecode,
  nalRbsp,
  seiTimecode,
  TIMING_IDLE_STOP_MS,
  TIMING_WINDOW_MS,
  timecodeInText,
  timingArgs,
  TimingStats,
  type ApiFeedTiming,
  type TimingFeedRef,
  type TimingFrame,
} from './feed-timing.js';

const T0 = 1_800_000_000_000;

describe('TimingStats', () => {
  it('transitMs is the delay above the best of the last 30 s; arrivalOffsetMs is that best', () => {
    const s = new TimingStats();
    // 30 fps, sender clock base 5 000 ms, network delay 40 ms, then one frame 90 ms late.
    for (let i = 0; i < 60; i++) s.frame(5_000 + i * 33, T0 + i * 33 + 40);
    expect(s.transitMs()).toBe(0);
    expect(s.arrivalOffsetMs()).toBe(T0 - 5_000 + 40);
    s.frame(5_000 + 60 * 33, T0 + 60 * 33 + 40 + 90);
    expect(s.transitMs()).toBe(90);
    expect(s.streamTimeMs).toBe(5_000 + 60 * 33);
    expect(s.receivedAt).toBe(T0 + 60 * 33 + 130);
  });

  it('the best leaves the window after 30 s: a path that got slower reads 0 again', () => {
    const s = new TimingStats();
    for (let i = 0; i <= 30; i++) s.frame(i * 1_000, T0 + i * 1_000 + 20); // 20 ms for 30 s
    for (let i = 31; i <= 40; i++) s.frame(i * 1_000, T0 + i * 1_000 + 70); // then 70 ms
    expect(s.transitMs()).toBe(50); // the 20 ms frames of the last 30 s are still there
    for (let i = 41; i <= 40 + TIMING_WINDOW_MS / 1_000 + 1; i++) s.frame(i * 1_000, T0 + i * 1_000 + 70);
    expect(s.transitMs()).toBe(0);
  });

  it('jitter: 0 for a steady stream, RFC 3550 smoothing for alternating delays', () => {
    const steady = new TimingStats();
    for (let i = 0; i < 100; i++) steady.frame(i * 20, T0 + i * 20 + 15);
    expect(steady.jitterMs()).toBe(0);
    expect(steady.fps()).toBe(50);

    const bumpy = new TimingStats();
    for (let i = 0; i < 400; i++) bumpy.frame(i * 20, T0 + i * 20 + (i % 2 === 0 ? 0 : 10));
    // |D| is always 10: J converges to 10.
    expect(bumpy.jitterMs()).toBeCloseTo(10, 0);

    const one = new TimingStats();
    one.frame(0, T0);
    one.frame(20, T0 + 36); // D = 16 → J = 1
    expect(one.jitterMs()).toBe(1);
  });

  it('fps from stream time; null until two frames', () => {
    const s = new TimingStats();
    expect(s.fps()).toBeNull();
    expect(s.transitMs()).toBeNull();
    expect(s.jitterMs()).toBeNull();
    for (let i = 0; i < 120; i++) s.frame(Math.round((i * 1000) / 29.97), T0 + i * 33);
    expect(s.fps()).toBeCloseTo(29.97, 1);
  });

  it('a new timeline (publisher restart) starts the statistics over', () => {
    const s = new TimingStats();
    for (let i = 0; i < 50; i++) s.frame(600_000 + i * 33, T0 + i * 33 + (i % 2 ? 30 : 0));
    expect(s.jitterMs()).toBeGreaterThan(5);
    s.frame(0, T0 + 50 * 33); // timestamps back to 0
    expect(s.jitterMs()).toBe(0);
    expect(s.transitMs()).toBe(0);
    expect(s.arrivalOffsetMs()).toBe(T0 + 50 * 33);
  });
});

// ---- SEI ------------------------------------------------------------------

const UUID = Buffer.from('a0b1c2d3e4f546078899aabbccddeeff', 'hex');

/** An SEI NAL with one user_data_unregistered message. */
function seiNal(text: string, uuid = UUID): Buffer {
  const payload = Buffer.concat([uuid, Buffer.from(text, 'latin1')]);
  return Buffer.concat([Buffer.from([0x06, 0x05, payload.length]), payload, Buffer.from([0x80])]);
}
const avcc = (...nals: Buffer[]) => Buffer.concat(nals.flatMap((n) => [Buffer.from([0, 0, 0, n.length]), n]));

describe('SEI timecode', () => {
  it('reads HH:MM:SS:FF from user_data_unregistered, any UUID; drop-frame keeps ";"', () => {
    expect(seiTimecode(seiNal('TC 01:02:03:04'))).toBe('01:02:03:04');
    expect(seiTimecode(seiNal('10:20:30;29', Buffer.alloc(16, 7)))).toBe('10:20:30;29');
    expect(seiTimecode(seiNal('no timecode here'))).toBeNull();
    expect(seiTimecode(seiNal('99:02:03:04'))).toBeNull();
    expect(seiTimecode(Buffer.from([0x65, 1, 2, 3]))).toBeNull(); // not an SEI
  });

  it('skips other SEI messages (pic_timing is not read) and handles 0xFF-extended sizes', () => {
    const picTiming = Buffer.from([0x01, 0x03, 0x11, 0x22, 0x33]);
    const long = Buffer.concat([UUID, Buffer.from(`${'x'.repeat(280)} 23:59:59:00`, 'latin1')]);
    const userData = Buffer.concat([Buffer.from([0x05, 0xff, long.length - 255]), long]);
    expect(seiTimecode(Buffer.concat([Buffer.from([0x06]), picTiming, userData, Buffer.from([0x80])]))).toBeNull(); // beyond the 256 bytes read
    const short = Buffer.concat([UUID, Buffer.from('00:00:01:02')]);
    const nal = Buffer.concat([Buffer.from([0x06]), picTiming, Buffer.from([0x05, short.length]), short, Buffer.from([0x80])]);
    expect(seiTimecode(nal)).toBe('00:00:01:02');
  });

  it('removes emulation prevention bytes', () => {
    expect([...nalRbsp(Buffer.from([0x06, 0x00, 0x00, 0x03, 0x01, 0x00, 0x00, 0x03, 0x00]))]).toEqual([0, 0, 1, 0, 0, 0]);
    // An all-zero UUID has to be escaped on the wire: 00 00 03 00 00 03 …
    const rbsp = Buffer.concat([Buffer.from([0x05, 27]), Buffer.alloc(16), Buffer.from('00:00:00:01'), Buffer.from([0x80])]);
    const escaped: number[] = [0x06];
    let zeros = 0;
    for (const b of rbsp) {
      if (zeros >= 2 && b <= 3) {
        escaped.push(3);
        zeros = 0;
      }
      escaped.push(b);
      zeros = b === 0 ? zeros + 1 : 0;
    }
    expect(escaped.length).toBeGreaterThan(rbsp.length + 1);
    expect(seiTimecode(Buffer.from(escaped))).toBe('00:00:00:01');
  });

  it('frameTimecode walks every NAL unit of the AVCC frame (the SEI can come after the slices)', () => {
    const slice = Buffer.from([0x65, 0x88, 0x84]);
    expect(frameTimecode(avcc(Buffer.from([0x09, 0xf0]), seiNal('01:00:00:00'), slice), 4)).toBe('01:00:00:00');
    expect(frameTimecode(avcc(slice, slice, seiNal('02:00:00:00')), 4)).toBe('02:00:00:00');
    expect(frameTimecode(avcc(slice, slice), 4)).toBeNull();
    expect(frameTimecode(Buffer.from([0, 0, 0, 99, 6]), 4)).toBeNull(); // truncated
  });

  it('timecodeInText normalises the frame separator', () => {
    expect(timecodeInText('at 12:34:56.07')).toBe('12:34:56:07');
    expect(timecodeInText('12:34:56')).toBeNull();
  });
});

// ---- FLV parsing --------------------------------------------------------

function flvTag(type: number, ts: number, body: Buffer): Buffer {
  const h = Buffer.alloc(11);
  h[0] = type;
  h.writeUIntBE(body.length, 1, 3);
  h.writeUIntBE(ts & 0xffffff, 4, 3);
  h[7] = (ts >>> 24) & 0xff;
  const prev = Buffer.alloc(4);
  prev.writeUInt32BE(11 + body.length);
  return Buffer.concat([h, body, prev]);
}
const FLV_HEADER = Buffer.from([0x46, 0x4c, 0x56, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0]);

describe('FlvTimingParser', () => {
  it('gives one frame per video tag with its timestamp and SEI timecode, across chunk boundaries', () => {
    const avcC = Buffer.from([0x17, 0, 0, 0, 0, 1, 0x64, 0, 0x1f, 0xff]);
    const frame1 = Buffer.concat([Buffer.from([0x17, 1, 0, 0, 0]), avcc(seiNal('TC 01:02:03:04'), Buffer.from([0x65, 1]))]);
    const frame2 = Buffer.concat([Buffer.from([0x27, 1, 0, 0, 0]), avcc(Buffer.from([0x41, 1]))]);
    const audio = Buffer.from([0xaf, 1, 0, 0]);
    const bytes = Buffer.concat([FLV_HEADER, flvTag(9, 9_000, avcC), flvTag(9, 9_000, frame1), flvTag(8, 9_010, audio), flvTag(9, 0x01_00_00_21, frame2)]);
    const p = new FlvTimingParser();
    const frames: TimingFrame[] = [...p.push(bytes.subarray(0, 40), T0), ...p.push(bytes.subarray(40), T0 + 5)];
    expect(frames).toEqual([
      { streamTimeMs: 9_000, receivedAt: T0 + 5, timecode: '01:02:03:04' },
      { streamTimeMs: 0x01_00_00_21, receivedAt: T0 + 5, timecode: null },
    ]);
  });

  it('FFmpeg copies, never decodes or encodes, and keeps the publisher timestamps', () => {
    const args = timingArgs('rtmp://127.0.0.1:1935/live/landscape');
    expect(args.join(' ')).toContain('-map 0:v:0 -c copy -copyts');
    expect(args).not.toContain('-vf');
    expect(args).not.toContain('-c:v');
  });
});

// ---- the service: interest, cap, idle stop ---------------------------

describe('FeedTimingService', () => {
  let now: number;
  let started: { url: string; frame: (f: TimingFrame) => void; exit: (r: string) => void; stopped: boolean }[];
  let events: { profileId: string; timing: ApiFeedTiming }[];
  let feeds: Record<string, TimingFeedRef[]>;

  const ref = (id: string, online = true): TimingFeedRef =>
    id.startsWith('guest/') ? { id, feed: 'guest', slot: id.slice(6), name: 'Guest', online } : { id, feed: id as 'landscape', slot: null, name: null, online };

  const make = (max = 8) =>
    new FeedTimingService({
      feeds: (p) => feeds[p] ?? [],
      profiles: () => Object.keys(feeds),
      readUrl: (p, r) => `rtmp://127.0.0.1:1935/${p}/${r.id}?user=relay&pass=readerSecret123`,
      emit: (profileId, timing) => events.push({ profileId, timing }),
      readers: (url, frame, exit) => {
        const r = { url, frame, exit, stopped: false };
        started.push(r);
        return { stop: () => (r.stopped = true) };
      },
      max,
      log: { info: () => {}, warn: () => {} },
      now: () => now,
    });
  const running = () => started.filter((r) => !r.stopped);
  const advance = (ms: number) => {
    now += ms;
    vi.advanceTimersByTime(ms);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    now = T0;
    started = [];
    events = [];
    feeds = { default: [ref('landscape'), ref('vertical', false), ref('guest/q7m2x9k4tb')], club: [ref('landscape'), ref('vertical')] };
  });
  afterEach(() => vi.useRealTimers());

  it('a GET measures the profile’s online feeds only, and every feed is listed', () => {
    const s = make();
    const list = s.read('default');
    expect(list).toMatchObject({ profileId: 'default', enabled: true, maxFeeds: 8, measuredFeeds: 2, windowMs: 30_000, idleStopMs: 30_000, serverTime: T0 });
    expect(list.feeds.map((f) => [f.id, f.online, f.measuring])).toEqual([
      ['landscape', true, true],
      ['vertical', false, false],
      ['guest/q7m2x9k4tb', true, true],
    ]);
    expect(list.feeds[0]).toMatchObject({ streamTimeMs: null, receivedAt: null, fps: null });
    expect(running().map((r) => r.url)).toEqual([expect.stringContaining('/default/landscape'), expect.stringContaining('/default/guest/q7m2x9k4tb')]);
    expect(JSON.stringify(list)).not.toContain('readerSecret123');
    s.close();
  });

  it('frames show up in the next read and in one feed.timing event per measured feed per second', () => {
    const s = make();
    s.read('default');
    const [land] = started;
    land!.frame({ streamTimeMs: 1_000, receivedAt: T0 + 10, timecode: '01:02:03:04' });
    land!.frame({ streamTimeMs: 1_033, receivedAt: T0 + 43, timecode: null });
    const f = s.read('default').feeds[0]!;
    expect(f).toMatchObject({ measuring: true, streamTimeMs: 1_033, receivedAt: T0 + 43, transitMs: 0, jitterMs: 0, sourceTimecode: '01:02:03:04', sourceTimecodeStreamTimeMs: 1_000, fps: 30.3 });
    advance(1_000);
    expect(events.map((e) => e.timing.id)).toEqual(['landscape', 'guest/q7m2x9k4tb']);
    advance(1_000);
    expect(events).toHaveLength(4);
    s.close();
  });

  it('stops each reader 30 s after the last GET, and nothing is sent after that', () => {
    const s = make();
    s.read('default');
    advance(20_000);
    s.read('default'); // renews interest
    advance(TIMING_IDLE_STOP_MS - 1_000);
    expect(running()).toHaveLength(2);
    advance(2_000);
    expect(running()).toHaveLength(0);
    const n = events.length;
    advance(5_000);
    expect(events).toHaveLength(n);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an interested event stream keeps measuring while open, and 30 s after it closes', () => {
    const s = make();
    const release = s.hold('club');
    expect(running().map((r) => r.url)).toEqual([expect.stringContaining('/club/landscape'), expect.stringContaining('/club/vertical')]);
    advance(120_000);
    expect(running()).toHaveLength(2);
    release();
    advance(TIMING_IDLE_STOP_MS - 1_000);
    expect(running()).toHaveLength(2);
    advance(2_000);
    expect(running()).toHaveLength(0);
  });

  it('a stream for every profile (null) measures every profile', () => {
    const s = make();
    const release = s.hold(null);
    expect(running()).toHaveLength(4);
    release();
    advance(TIMING_IDLE_STOP_MS + 1_000);
    expect(running()).toHaveLength(0);
  });

  it('caps the feeds measured server-wide; 0 turns it off', () => {
    const s = make(3);
    s.read('default');
    const club = s.read('club');
    expect(running()).toHaveLength(3);
    expect(club.measuredFeeds).toBe(3);
    expect(club.feeds.map((f) => f.measuring)).toEqual([true, false]);
    // When one stops, the waiting feed gets the free reader.
    feeds.default = [ref('landscape', false), ref('vertical', false), ref('guest/q7m2x9k4tb')];
    advance(1_000);
    expect(running()).toHaveLength(3);
    expect(s.read('club').feeds.map((f) => f.measuring)).toEqual([true, true]);
    s.close();

    started = [];
    const off = make(0);
    expect(off.read('default')).toMatchObject({ enabled: false, maxFeeds: 0, measuredFeeds: 0 });
    off.hold(null)();
    expect(started).toHaveLength(0);
  });

  it('a reader that dies is started again after a back-off; a feed going offline stops its reader', () => {
    const s = make();
    s.read('default');
    started[0]!.stopped = true; // it ended by itself
    started[0]!.exit('FFmpeg exited (1)');
    expect(s.read('default').feeds[0]!.measuring).toBe(false);
    advance(1_000);
    expect(started).toHaveLength(2);
    advance(1_000);
    expect(started).toHaveLength(3);
    expect(started[2]!.url).toContain('/default/landscape');
    feeds.default = [ref('landscape', false), ref('vertical', false), ref('guest/q7m2x9k4tb')];
    advance(1_000);
    expect(started[2]!.stopped).toBe(true);
    expect(s.read('default').feeds[0]).toMatchObject({ online: false, measuring: false, streamTimeMs: null });
    s.close();
    expect(running()).toHaveLength(0);
  });
});
