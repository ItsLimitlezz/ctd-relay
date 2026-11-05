// Twitch Dual Format through Relay: BPM SEI, Enhanced FLV parsing, AMF0, the RTMP publisher (against
// a fake ingest), the forwarder and the FFmpeg arguments.

import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { PushPlan } from '../platforms/types.js';
import { decodeAmf0All, encodeAmf0All } from './amf0.js';
import { BpmCounters, bpmNals, emulationPrevent, seiNal } from './bpm.js';
import { avcLengthSize, findIdr, FlvReader, insertBeforeIdr, parseVideoTag } from './eflv.js';
import { buildIvsArgs, IVS_PROGRESS_FD } from './ffmpeg-args.js';
import { BpmInserter, IvsForwarder, type TagPublisher } from './ivs-forwarder.js';
import { parseRtmpUrl, RTMP_VIDEO, RtmpPublisher } from './rtmp-publisher.js';
import { startFakeIngest, type FakeIngest } from './rtmp-test-server.js';

/** AVCC data: each NAL with a 4-byte length. */
function avcc(...nals: number[][]): Buffer {
  return Buffer.concat(nals.map((n) => Buffer.concat([Buffer.from([0, 0, 0, n.length]), Buffer.from(n)])));
}
const IDR = [0x65, 0x88, 0x80];
const SLICE = [0x41, 0x9a, 0x02];
const SEI_X264 = [0x06, 0x05, 0x01, 0x00, 0x80];
const legacy = (key: boolean, data: Buffer) => Buffer.concat([Buffer.from([key ? 0x17 : 0x27, 1, 0, 0, 0]), data]);
const multitrack = (track: number, key: boolean, data: Buffer) =>
  Buffer.concat([Buffer.from([0x80 | ((key ? 1 : 2) << 4) | 6, 0x01]), Buffer.from('avc1'), Buffer.from([track, 0, 0, 0]), data]);

describe('BPM SEI', () => {
  it('escapes start-code emulation', () => {
    expect([...emulationPrevent(Buffer.from([0, 0, 1, 0, 0, 0, 0, 0, 3, 5]))]).toEqual([0, 0, 3, 1, 0, 0, 3, 0, 0, 3, 0, 3, 5]);
  });

  /** Undo emulation prevention (drop the 0x03 after two zero bytes). */
  const unescape = (nal: Buffer): Buffer => {
    const out: number[] = [];
    let zeros = 0;
    for (const b of nal) {
      if (zeros >= 2 && b === 3) {
        zeros = 0;
        continue;
      }
      out.push(b);
      zeros = b === 0 ? zeros + 1 : 0;
    }
    return Buffer.from(out);
  };

  it('builds user_data_unregistered SEI NALs with the IVS UUIDs, timestamps and counters', () => {
    const [ts, sm, erm] = bpmNals(Date.parse('2024-03-25T15:10:34.489Z'), { rendered: 120, lagged: 0, dropped: 0, output: 360 }, { input: 120, skipped: 0, output: 120 });
    for (const nal of [ts!, sm!, erm!]) {
      expect(nal[0]).toBe(0x06); // SEI
      expect(nal[1]).toBe(5); // user_data_unregistered
      expect(nal.at(-1)).toBe(0x80); // rbsp trailing bits
    }
    expect(ts!.subarray(3, 19).toString('hex')).toBe('0aecffe752724e2fa62fd19cd61a93b5');
    expect(sm!.subarray(3, 19).toString('hex')).toBe('ca60e71c6a8b4388a377151df7bf8ac2');
    expect(erm!.subarray(3, 19).toString('hex')).toBe('f1fbc1d5101e4fb5a61eb8ce3c07b8c0');
    // TS: reserved/num_timestamps_minus1 = 0, type 1 (RFC 3339), event 4 (PIR), NUL-terminated string.
    expect(ts!.subarray(19, 22)).toEqual(Buffer.from([0, 1, 4]));
    expect(ts!.toString('ascii', 22, 46)).toBe('2024-03-25T15:10:34.489Z');
    expect(ts![46]).toBe(0);
    // SM: then num_counters_minus1 = 3 and four tag/u32 pairs (escaped in the NAL: 00 00 00 78 has zeros runs).
    expect(sm!.includes(Buffer.from([0, 0, 3, 0]))).toBe(true);
    const smCounters = unescape(sm!).subarray(47, 47 + 21);
    expect(smCounters[0]).toBe(3);
    expect([smCounters[1], smCounters.readUInt32BE(2), smCounters[6], smCounters[16], smCounters.readUInt32BE(17)]).toEqual([1, 120, 2, 4, 360]);
    expect(unescape(erm!).subarray(47)[0]).toBe(2);
  });

  it('adds the composition time to the TS message only, before the PIR timestamp, like OBS', () => {
    const pir = Date.parse('2024-03-25T15:10:34.489Z');
    const counters = { rendered: 0, lagged: 0, dropped: 0, output: 0 };
    const [ts, sm, erm] = bpmNals(pir, counters, { input: 0, skipped: 0, output: 0 }, pir - 40);
    // TS: num_timestamps_minus1 = 1, then CTS (event 1), then PIR (event 4).
    expect(ts!.subarray(19, 22)).toEqual(Buffer.from([1, 1, 1]));
    expect(ts!.toString('ascii', 22, 46)).toBe('2024-03-25T15:10:34.449Z');
    expect(ts!.subarray(46, 49)).toEqual(Buffer.from([0, 1, 4]));
    expect(ts!.toString('ascii', 49, 73)).toBe('2024-03-25T15:10:34.489Z');
    // SM and ERM keep PIR only, which is all IVS expects there.
    expect(sm!.subarray(19, 22)).toEqual(Buffer.from([0, 1, 4]));
    expect(erm!.subarray(19, 22)).toEqual(Buffer.from([0, 1, 4]));
  });

  it('sizes longer payloads with 0xFF continuation bytes', () => {
    const nal = seiNal(Buffer.alloc(16, 1), Buffer.alloc(300, 0x41));
    expect([nal[1], nal[2], nal[3]]).toEqual([5, 255, 316 - 255]);
  });

  it('counts frames since the previous IDR of each track; the first IDR reports zeros', () => {
    const c = new BpmCounters();
    expect(c.atIdr(0)).toEqual({ session: { rendered: 0, lagged: 0, dropped: 0, output: 0 }, rendition: { input: 0, skipped: 0, output: 0 } });
    for (let i = 0; i < 120; i++) c.frame(0);
    expect(c.atIdr(1).rendition.input).toBe(0);
    for (let i = 0; i < 60; i++) c.frame(1);
    expect(c.atIdr(0)).toEqual({ session: { rendered: 120, lagged: 0, dropped: 0, output: 180 }, rendition: { input: 120, skipped: 0, output: 120 } });
    expect(c.atIdr(1).rendition).toEqual({ input: 60, skipped: 0, output: 60 });
  });
});

describe('Enhanced FLV', () => {
  it('splits a byte stream into tags across chunk boundaries', () => {
    const tag = (type: number, ts: number, body: Buffer) => {
      const h = Buffer.alloc(11);
      h[0] = type;
      h.writeUIntBE(body.length, 1, 3);
      h.writeUIntBE(ts & 0xffffff, 4, 3);
      h[7] = ts >>> 24;
      const prev = Buffer.alloc(4);
      prev.writeUInt32BE(11 + body.length);
      return Buffer.concat([h, body, prev]);
    };
    const stream = Buffer.concat([Buffer.from('FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00', 'latin1'), tag(9, 40, Buffer.from([1, 2, 3])), tag(8, 0x01000005, Buffer.from([4]))]);
    const r = new FlvReader();
    const out = [...r.push(stream.subarray(0, 20)), ...r.push(stream.subarray(20, 31)), ...r.push(stream.subarray(31))];
    expect(out.map((t) => [t.type, t.timestamp, [...t.body]])).toEqual([
      [9, 40, [1, 2, 3]],
      [8, 0x01000005, [4]],
    ]);
    expect(() => new FlvReader().push(Buffer.from('NOPE00000000000'))).toThrow(/Not an FLV/);
  });

  it('reads legacy (track 0) and multitrack OneTrack packets', () => {
    expect(parseVideoTag(legacy(true, avcc(IDR)))).toEqual({ track: 0, avc: true, kind: 'frame', dataOffset: 5 });
    expect(parseVideoTag(Buffer.from([0x17, 0, 0, 0, 0, 1, 0x64, 0, 0x28, 0xff]))).toMatchObject({ kind: 'sequence-start', dataOffset: 5 });
    expect(parseVideoTag(multitrack(2, true, avcc(IDR)))).toEqual({ track: 2, avc: true, kind: 'frame', dataOffset: 10 });
    expect(parseVideoTag(Buffer.from([0x90, ...Buffer.from('avc1'), 1, 0x64]))).toEqual({ track: 0, avc: true, kind: 'sequence-start', dataOffset: 5 });
    expect(avcLengthSize(Buffer.from([1, 0x64, 0, 0x28, 0xff]))).toBe(4);
    expect(avcLengthSize(Buffer.from([1, 0x64, 0, 0x28, 0xfd]))).toBe(2);
  });

  it('inserts NALs right before the IDR slice, never into non-IDR frames', () => {
    const body = legacy(true, avcc(SEI_X264, IDR));
    const out = insertBeforeIdr(body, 5, 4, [Buffer.from([6, 9, 9])])!;
    expect([...out.subarray(5)]).toEqual([...avcc(SEI_X264, [6, 9, 9], IDR)]);
    expect(insertBeforeIdr(legacy(false, avcc(SLICE)), 5, 4, [Buffer.from([6])])).toBeNull();
    expect(findIdr(avcc(SLICE, IDR), 4)).toBe(-1);
  });
});

describe('BpmInserter', () => {
  it('estimates composition time from the stream timestamp, always before the interleave time', () => {
    let clock = Date.parse('2024-03-25T15:00:00.000Z');
    const b = new BpmInserter(() => clock);
    const tsOf = (out: Buffer) => out.toString('latin1');
    const first = tsOf(b.video(legacy(true, avcc(IDR)), 0));
    expect(first).toContain('2024-03-25T14:59:59.999Z'); // can't equal the PIR time
    expect(first).toContain('2024-03-25T15:00:00.000Z');
    // 2 s of stream later, but the IDR arrives 50 ms late: composition time is on the stream's clock.
    clock += 2050;
    const late = tsOf(b.video(legacy(true, avcc(IDR)), 2000));
    expect(late).toContain('2024-03-25T15:00:02.000Z');
    expect(late).toContain('2024-03-25T15:00:02.050Z');
  });

  it('adds the three BPM NALs in front of every IDR on every track, nothing elsewhere', () => {
    const b = new BpmInserter(() => 0);
    const key0 = b.video(legacy(true, avcc(IDR)));
    const inter0 = legacy(false, avcc(SLICE));
    expect(b.video(inter0)).toBe(inter0);
    const key2 = b.video(multitrack(2, true, avcc(IDR)));
    expect(b.idrs).toBe(2);
    const nalTypes = (buf: Buffer, off: number) => {
      const types: number[] = [];
      for (let o = off; o < buf.length; ) {
        const len = buf.readUInt32BE(o);
        types.push(buf[o + 4]! & 0x1f);
        o += 4 + len;
      }
      return types;
    };
    expect(nalTypes(key0, 5)).toEqual([6, 6, 6, 5]);
    expect(nalTypes(key2, 10)).toEqual([6, 6, 6, 5]);
  });
});

describe('AMF0', () => {
  it('round-trips commands', () => {
    const values = ['connect', 1, { app: 'app', fourCcList: ['avc1', 'hvc1'], ok: true, n: null }, undefined];
    expect(decodeAmf0All(encodeAmf0All(values))).toEqual(values);
  });
});

describe('RtmpPublisher', () => {
  let ingest: FakeIngest | null = null;
  afterEach(async () => {
    await ingest?.close();
    ingest = null;
  });

  it('parses rtmp(s) URLs into app and stream name (query kept)', () => {
    expect(parseRtmpUrl('rtmps://iad05.contribute.live-video.net/app/v1_x?bandwidthtest=true&clientConfigId=c')).toEqual({
      tls: true,
      host: 'iad05.contribute.live-video.net',
      port: 443,
      app: 'app',
      streamName: 'v1_x?bandwidthtest=true&clientConfigId=c',
      tcUrl: 'rtmps://iad05.contribute.live-video.net/app',
    });
    expect(parseRtmpUrl('rtmp://127.0.0.1:1936/live/k')).toMatchObject({ tls: false, port: 1936, app: 'live', streamName: 'k' });
    expect(() => parseRtmpUrl('https://x/y/z')).toThrow();
  });

  it('connects with E-RTMP codecs, publishes, sends messages in chunks and unpublishes on close', async () => {
    ingest = await startFakeIngest();
    const pub = await RtmpPublisher.open(`rtmp://127.0.0.1:${ingest.port}/app/live_key?clientConfigId=c`);
    const big = Buffer.alloc(10_000, 0xab);
    pub.send(RTMP_VIDEO, 0x01000000, big); // extended timestamp, several chunks
    await pub.close();
    await ingest.unpublished;
    const names = ingest.commands.map((c) => c[0]);
    expect(names).toEqual(['connect', 'releaseStream', 'FCPublish', 'createStream', 'publish', 'FCUnpublish', 'deleteStream']);
    // The same fields as OBS's connect (librtmp SendConnectPacket), and no others.
    expect(ingest.commands[0]![2]).toEqual({
      app: 'app',
      type: 'nonprivate',
      flashVer: 'FMLE/3.0 (compatible; FMSc/1.0)',
      swfUrl: `rtmp://127.0.0.1:${ingest.port}/app`,
      tcUrl: `rtmp://127.0.0.1:${ingest.port}/app`,
    });
    expect(ingest.commands[4]).toEqual(['publish', 0, null, 'live_key?clientConfigId=c', 'live']);
    expect(ingest.messages).toEqual([{ type: RTMP_VIDEO, timestamp: 0x01000000, streamId: 1, payload: big }]);
  });

  it('fails when the server refuses the stream, and reports a lost connection', async () => {
    ingest = await startFakeIngest({ refusePublish: 'NetStream.Publish.BadName' });
    await expect(RtmpPublisher.open(`rtmp://127.0.0.1:${ingest.port}/app/bad`)).rejects.toMatchObject({ statusCode: 'NetStream.Publish.BadName' });
    await ingest.close();

    ingest = await startFakeIngest();
    const pub = await RtmpPublisher.open(`rtmp://127.0.0.1:${ingest.port}/app/k`);
    const lost = new Promise<Error>((resolve) => pub.on('error', resolve));
    ingest.dropAll();
    expect((await lost).message).toMatch(/closed the connection|Connection lost/);
  });
});

describe('IvsForwarder', () => {
  it('holds FFmpeg’s output until publishing, forwards tags with BPM added, pauses on backpressure', async () => {
    const sent: { type: number; timestamp: number; body: Buffer }[] = [];
    let drain: () => void = () => {};
    let full = true;
    const pub: TagPublisher = {
      send(type, timestamp, body) {
        sent.push({ type, timestamp, body });
        return !full;
      },
      close: async () => {},
      on: () => pub,
      once: (_e: string, fn: () => void) => {
        drain = fn;
        return pub;
      },
    } as TagPublisher;
    const input = new PassThrough();
    const fwd = new IvsForwarder('rtmp://x/app/k', { log: { info: () => {}, warn: () => {} }, publish: async () => pub, now: () => 0 });
    fwd.start(input, (err) => {
      throw err;
    });
    const tag = (type: number, body: Buffer) => {
      const h = Buffer.alloc(11);
      h[0] = type;
      h.writeUIntBE(body.length, 1, 3);
      return Buffer.concat([h, body, Buffer.alloc(4)]);
    };
    input.write(Buffer.from('FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00', 'latin1'));
    input.write(tag(9, legacy(true, avcc(IDR))));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
    expect(input.isPaused()).toBe(true); // send() said the network is behind
    full = false;
    input.write(tag(8, Buffer.from([0xaf, 1, 2])));
    drain();
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.map((s) => s.type)).toEqual([9, 8]);
    expect(sent[0]!.body.length).toBeGreaterThan(legacy(true, avcc(IDR)).length); // BPM added
    await fwd.close();
  });

  it('reports a refused connection as fatal', async () => {
    const errors: string[] = [];
    const fwd = new IvsForwarder('rtmp://x/app/k', {
      log: { info: () => {}, warn: () => {} },
      publish: async () => {
        throw new Error('NetStream.Publish.BadName: refused');
      },
    });
    fwd.start(new PassThrough(), (err) => errors.push(err.message));
    await new Promise((r) => setTimeout(r, 10));
    expect(errors).toEqual(['NetStream.Publish.BadName: refused']);
  });
});

describe('buildIvsArgs', () => {
  const fps = (n: number) => ({ numerator: n, denominator: 1 });
  const plan: PushPlan = {
    url: 'rtmps://h/app/k',
    mode: 'ivs',
    feeds: ['landscape', 'vertical'],
    ivs: {
      tracks: [
        { feed: 'landscape', width: 1920, height: 1080, fps: fps(60), bitrateKbps: 6000, keyintSec: 2, profile: 'high', bframes: 3 },
        { feed: 'landscape', width: 640, height: 360, fps: fps(30), bitrateKbps: 500, keyintSec: 2, profile: 'main', bframes: 3 },
        { feed: 'vertical', width: 1080, height: 1920, fps: fps(60), bitrateKbps: 5000, keyintSec: 2, profile: 'high', bframes: 3 },
        { feed: 'vertical', width: 360, height: 640, fps: fps(30), bitrateKbps: 500, keyintSec: 2, profile: 'main', bframes: 3 },
      ],
      audioBitrateKbps: 160,
      audioChannels: 2,
      preset: 'veryfast',
    },
  };

  it('encodes every track with aligned keyframes at constant bitrate and writes FLV to stdout', () => {
    const args = buildIvsArgs(plan, { landscape: 'rtmp://127.0.0.1/live/landscape', vertical: 'rtmp://127.0.0.1/live/vertical' });
    const s = args.join(' ');
    expect(s).toContain(`-progress pipe:${IVS_PROGRESS_FD}`);
    expect(args.filter((a) => a === '-i')).toHaveLength(2);
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('[0:v]setpts=PTS-STARTPTS,split=2[s0][s1]');
    expect(graph).toContain('[1:v]setpts=PTS-STARTPTS,split=2[s2][s3]');
    expect(graph).toContain('[s1]fps=30/1,scale=640:360');
    expect(graph).toContain('[0:a]asetpts=PTS-STARTPTS');
    for (const [i, rate, gop] of [
      [0, '6000k', '120'],
      [1, '500k', '60'],
      [2, '5000k', '120'],
      [3, '500k', '60'],
    ] as const) {
      expect(s).toContain(`-map [v${i}] -c:v:${i} libx264`);
      expect(s).toContain(`-b:v:${i} ${rate} -minrate:v:${i} ${rate} -maxrate:v:${i} ${rate} -bufsize:v:${i} ${rate} -g:v:${i} ${gop} -keyint_min:v:${i} ${gop} -sc_threshold:v:${i} 0`);
      expect(s).toContain(`-force_key_frames:v:${i} expr:gte(t,n_forced*2) -x264-params:v:${i} nal-hrd=cbr:force-cfr=1`);
    }
    expect(s).toContain('-map [a] -c:a aac -b:a 160k -ar 48000 -ac 2');
    expect(args.slice(-1)).toEqual(['pipe:1']);
    expect(s).not.toContain('rtmps://h/app/k'); // Relay publishes, not FFmpeg
  });
});
