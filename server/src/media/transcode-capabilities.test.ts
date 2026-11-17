import { describe, expect, it } from 'vitest';
import {
  ENCODER_CANDIDATES,
  TranscodeCapabilityService,
  decodersByCodec,
  parseCodecList,
  parseHwaccels,
  parseProgressFrames,
  parseProgressSpeed,
  parseVersionLine,
  pickEncodeError,
  probeTranscodeCapabilities,
  summarizeCapabilities,
  testEncodeArgs,
  type RunFn,
  type RunResult,
} from './transcode-capabilities.js';

// Excerpts of the pinned BtbN n8.1.3 linux64 GPL build's output (scripts/setup-tools.mjs).
const VERSION = `ffmpeg version n8.1.3-9-g29e619e767-20260930 Copyright (c) 2000-2026 the FFmpeg developers
built with gcc 16.2.0 (crosstool-NG 1.29.0.7_b1a94f6)
`;

const HWACCELS = `Hardware acceleration methods:
cuda
vaapi
qsv
drm
opencl
vulkan
amf

`;

const LEGEND = ` V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
`;

const ENCODERS = `Encoders:
${LEGEND} V....D a64multi             Multicolor charset for Commodore 64 (codec a64_multi)
 V....D libaom-av1           libaom AV1 (codec av1)
 V..... libsvtav1            SVT-AV1(Scalable Video Technology for AV1) encoder (codec av1)
 V....D av1_nvenc            NVIDIA NVENC av1 encoder (codec av1)
 V..... av1_qsv              AV1 (Intel Quick Sync Video acceleration) (codec av1)
 V....D av1_amf              AMD AMF AV1 encoder (codec av1)
 V....D av1_vaapi            AV1 (VAAPI) (codec av1)
 V....D av1_vulkan           AV1 (Vulkan) (codec av1)
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D h264_amf             AMD AMF H.264 Encoder (codec h264)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V..... h264_qsv             H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (Intel Quick Sync Video acceleration) (codec h264)
 V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)
 V....D libx265              libx265 H.265 / HEVC (codec hevc)
 V....D hevc_amf             AMD AMF HEVC encoder (codec hevc)
 V....D hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)
 V..... hevc_qsv             HEVC (Intel Quick Sync Video acceleration) (codec hevc)
 V....D hevc_vaapi           H.265/HEVC (VAAPI) (codec hevc)
 A....D aac                  AAC (Advanced Audio Coding)
`;

const DECODERS = `Decoders:
${LEGEND} V....D 012v                 Uncompressed 4:2:2 10-bit
 V..... libdav1d             dav1d AV1 decoder by VideoLAN (codec av1)
 V....D av1                  Alliance for Open Media AV1
 V..... av1_cuvid            Nvidia CUVID AV1 decoder (codec av1)
 VFS..D h264                 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10
 V..... h264_cuvid           Nvidia CUVID H264 decoder (codec h264)
 VFS..D hevc                 HEVC (High Efficiency Video Coding)
 V....D hevc_qsv             HEVC video (Intel Quick Sync Video acceleration) (codec hevc)
 A....D aac                  AAC (Advanced Audio Coding)
`;

const PROGRESS_OK = (speed: string) =>
  `frame=30\nfps=0.00\nstream_0_0_q=-1.0\nbitrate=N/A\ntotal_size=N/A\nout_time_us=933333\nout_time=00:00:00.933333\ndup_frames=0\ndrop_frames=0\nspeed=${speed}\nprogress=end\n`;

const NVENC_FAIL = `[h264_nvenc @ 0x56270bf01c80] Cannot load libcuda.so.1
[vost#0:0/h264_nvenc @ 0x56270bf01740] [enc:h264_nvenc @ 0x56270bf01c00] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.
[vf#0:0 @ 0x56270bf1cfc0] Error sending frames to consumers: Operation not permitted
[vf#0:0 @ 0x56270bf1cfc0] Task finished with error code: -1 (Operation not permitted)
[vost#0:0/h264_nvenc @ 0x56270bf01740] [enc:h264_nvenc @ 0x56270bf01c00] Could not open encoder before EOF
[out#0/null @ 0x56270bf013c0] Nothing was written into output file, because at least one of its streams received no packets.
`;

const VAAPI_FAIL = `[VAAPI @ 0x55a308c81d00] No VA display found for device /dev/dri/renderD128.
Device creation failed: -22.
Failed to set value '/dev/dri/renderD128' for option 'vaapi_device': Invalid argument
Error parsing global options: Invalid argument
`;

const ok = (stdout: string, stderr = ''): RunResult => ({ code: 0, stdout, stderr, timedOut: false, spawnError: null });
const fail = (stderr: string, code = 255): RunResult => ({ code, stdout: '', stderr, timedOut: false, spawnError: null });

/** A mocked FFmpeg: info commands answer with the fixtures; test encodes per `encodes`. */
function fakeFfmpeg(encodes: (encoder: string, device: string | null) => RunResult, info: Partial<Record<string, RunResult>> = {}) {
  const calls: string[][] = [];
  const run: RunFn = async (_cmd, args) => {
    calls.push([...args]);
    const flag = args.find((a) => ['-version', '-hwaccels', '-encoders', '-decoders'].includes(a));
    if (flag) {
      const custom = info[flag];
      if (custom) return custom;
      return ok({ '-version': VERSION, '-hwaccels': HWACCELS, '-encoders': ENCODERS, '-decoders': DECODERS }[flag]!);
    }
    const encoder = args[args.indexOf('-c:v') + 1]!;
    const deviceIdx = args.indexOf('-vaapi_device');
    return encodes(encoder, deviceIdx >= 0 ? args[deviceIdx + 1]! : null);
  };
  return { run, calls };
}

const cpu = () => ({ cores: 8, model: 'Test CPU' });
let clock = 1_700_000_000_000;
const now = () => (clock += 250);

describe('parsing', () => {
  it('reads the version line', () => {
    expect(parseVersionLine(VERSION)).toBe('ffmpeg version n8.1.3-9-g29e619e767-20260930 Copyright (c) 2000-2026 the FFmpeg developers');
    expect(parseVersionLine('nonsense')).toBeNull();
  });

  it('reads hwaccels', () => {
    expect(parseHwaccels(HWACCELS)).toEqual(['cuda', 'vaapi', 'qsv', 'drm', 'opencl', 'vulkan', 'amf']);
    expect(parseHwaccels('Hardware acceleration methods:\n\n')).toEqual([]);
  });

  it('reads encoder and decoder lists, skipping the legend', () => {
    const enc = parseCodecList(ENCODERS);
    expect(enc.find((e) => e.name === '=')).toBeUndefined();
    expect(enc.find((e) => e.name === 'h264_qsv')).toEqual({ name: 'h264_qsv', type: 'V', codec: 'h264' });
    expect(enc.find((e) => e.name === 'aac')).toEqual({ name: 'aac', type: 'A', codec: 'aac' });
    // Without "(codec x)" the name is the codec (native decoders).
    expect(decodersByCodec(parseCodecList(DECODERS))).toEqual({
      h264: ['h264', 'h264_cuvid'],
      hevc: ['hevc', 'hevc_qsv'],
      av1: ['libdav1d', 'av1', 'av1_cuvid'],
    });
  });

  it('reads progress speed and frames', () => {
    expect(parseProgressSpeed(PROGRESS_OK('5.04x'))).toBe(5.04);
    expect(parseProgressSpeed('speed=N/A\nprogress=end\n')).toBeNull();
    expect(parseProgressFrames(PROGRESS_OK('1x'))).toBe(30);
    expect(parseProgressFrames('frame=0\nprogress=end\n')).toBe(0);
  });

  it('picks the cause, not FFmpeg’s generic closing lines', () => {
    expect(pickEncodeError(NVENC_FAIL)).toBe('Cannot load libcuda.so.1');
    expect(pickEncodeError(VAAPI_FAIL)).toBe('No VA display found for device /dev/dri/renderD128.');
    expect(pickEncodeError('Svt[warn]: Failed to set thread priority\n[x @ 0x1] Conversion failed!\n')).toBe('Conversion failed!');
    expect(pickEncodeError('')).toBe('test encode failed');
  });
});

describe('test encode arguments', () => {
  it('software: yuv420p, fast preset, null muxer with progress', () => {
    const args = testEncodeArgs({ encoder: 'libx264', codec: 'h264', backend: 'software' });
    expect(args).toEqual(expect.arrayContaining(['-f', 'lavfi', '-frames:v', '30', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-progress', 'pipe:1']));
    expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
    expect(args).not.toContain('-vaapi_device');
  });

  it('hardware: NV12; VAAPI uploads to the given render node', () => {
    expect(testEncodeArgs({ encoder: 'h264_nvenc', codec: 'h264', backend: 'nvenc' })).toEqual(expect.arrayContaining(['-pix_fmt', 'nv12']));
    const vaapi = testEncodeArgs({ encoder: 'h264_vaapi', codec: 'h264', backend: 'vaapi' }, '/dev/dri/renderD129');
    expect(vaapi.slice(vaapi.indexOf('-vaapi_device'), vaapi.indexOf('-vaapi_device') + 2)).toEqual(['-vaapi_device', '/dev/dri/renderD129']);
    expect(vaapi).toEqual(expect.arrayContaining(['-vf', 'format=nv12,hwupload']));
    expect(() => testEncodeArgs({ encoder: 'h264_vaapi', codec: 'h264', backend: 'vaapi' })).toThrow(/render node/);
  });
});

describe('probeTranscodeCapabilities', () => {
  it('software-only machine (no GPU passed through): software encoders work, hardware ones explain why not', async () => {
    const { run, calls } = fakeFfmpeg((encoder) => {
      if (encoder === 'libx264') return ok(PROGRESS_OK('5.04x'));
      if (encoder === 'libx265') return ok(PROGRESS_OK('2.91x'));
      if (encoder === 'libsvtav1') return ok(PROGRESS_OK('3.10x'), 'Svt[warn]: Failed to set thread priority: Invalid argument\n');
      if (encoder.endsWith('_nvenc')) return fail(NVENC_FAIL);
      if (encoder.endsWith('_qsv')) return fail('[h264_qsv @ 0x1] Error creating a MFX session: -9.\nConversion failed!\n', 171);
      if (encoder.endsWith('_amf')) return fail('[AMF @ 0x1] DLL libamfrt64.so.1 failed to open\n', 171);
      throw new Error(`unexpected test encode ${encoder}`);
    });
    const caps = await probeTranscodeCapabilities({ ffmpegBin: 'ffmpeg', run, listRenderNodes: () => [], hasNvidiaDevice: () => false, cpu, now });

    expect(caps.state).toBe('ready');
    expect(caps.error).toBeNull();
    expect(caps.ffmpegVersion).toMatch(/^ffmpeg version n8\.1\.3/);
    expect(caps.hwaccels).toContain('vaapi');
    expect(caps.decoders.av1).toEqual(['libdav1d', 'av1', 'av1_cuvid']);
    expect(caps.supported).toEqual({ h264: true, hevc: true, av1: true });
    expect(caps.cpu).toEqual({ cores: 8, model: 'Test CPU' });
    expect(caps.devices).toEqual({ renderNodes: [], nvidia: false });
    expect(caps.probedAt).toEqual(expect.any(String));
    expect(caps.durationMs).toBeGreaterThan(0);

    // Every compiled-in candidate is listed, hardware before software; vulkan/libaom aren't candidates.
    const names = caps.encoders.map((e) => e.encoder);
    expect(names).toEqual(ENCODER_CANDIDATES.filter((c) => c.backend !== 'software').map((c) => c.encoder).concat(['libx264', 'libx265', 'libsvtav1']));
    expect(names).not.toContain('av1_vulkan');
    expect(caps.encoders.find((e) => e.encoder === 'libx264')).toEqual({ encoder: 'libx264', codec: 'h264', backend: 'software', ok: true, speed: 5.04, device: null, error: null });
    expect(caps.encoders.find((e) => e.encoder === 'h264_nvenc')).toMatchObject({ ok: false, speed: null, error: 'Cannot load libcuda.so.1' });
    expect(caps.encoders.find((e) => e.encoder === 'hevc_qsv')?.error).toBe('Error creating a MFX session: -9.');
    expect(caps.encoders.find((e) => e.encoder === 'av1_amf')?.error).toBe('DLL libamfrt64.so.1 failed to open');
    // VAAPI isn't even tried without a render node.
    expect(caps.encoders.find((e) => e.encoder === 'h264_vaapi')).toMatchObject({ ok: false, error: expect.stringMatching(/render node/) });
    expect(calls.some((a) => a.includes('-vaapi_device'))).toBe(false);
    // One process at a time, and at most one per candidate + 4 info commands.
    expect(calls).toHaveLength(4 + names.filter((n) => !n.endsWith('_vaapi')).length);
  });

  it('the owner’s case: old AMD card, H.264 VAAPI only (second render node), no HEVC/AV1 hardware', async () => {
    const { run, calls } = fakeFfmpeg((encoder, device) => {
      if (encoder === 'h264_vaapi') return device === '/dev/dri/renderD129' ? ok(PROGRESS_OK('7.5x')) : fail(VAAPI_FAIL, 234);
      if (encoder === 'libx264') return ok(PROGRESS_OK('1.2x'));
      if (encoder.endsWith('_vaapi')) return fail('[hevc_vaapi @ 0x1] No usable encoding profile found.\n', 1);
      if (encoder === 'libx265' || encoder === 'libsvtav1') return ok('frame=0\nspeed=N/A\nprogress=end\n'); // exit 0, nothing written
      return fail(NVENC_FAIL);
    });
    const caps = await probeTranscodeCapabilities({
      ffmpegBin: 'ffmpeg',
      run,
      listRenderNodes: () => ['/dev/dri/renderD128', '/dev/dri/renderD129'],
      hasNvidiaDevice: () => false,
      cpu,
      now,
    });
    expect(caps.supported).toEqual({ h264: true, hevc: false, av1: false });
    expect(caps.encoders.find((e) => e.encoder === 'h264_vaapi')).toEqual({
      encoder: 'h264_vaapi', codec: 'h264', backend: 'vaapi', ok: true, speed: 7.5, device: '/dev/dri/renderD129', error: null,
    });
    expect(caps.encoders.find((e) => e.encoder === 'hevc_vaapi')).toMatchObject({ ok: false, device: null, error: 'No usable encoding profile found.' });
    expect(caps.encoders.find((e) => e.encoder === 'libx265')).toMatchObject({ ok: false, error: 'test encode failed' });
    expect(calls.filter((a) => a.includes('h264_vaapi')).map((a) => a[a.indexOf('-vaapi_device') + 1])).toEqual(['/dev/dri/renderD128', '/dev/dri/renderD129']);
    expect(summarizeCapabilities(caps)).toBe('H.264: h264_vaapi, libx264 · HEVC: none · AV1: none');
  });

  it('a hung encoder times out without failing the probe', async () => {
    const { run } = fakeFfmpeg((encoder) =>
      encoder === 'h264_nvenc' ? { code: null, stdout: '', stderr: '', timedOut: true, spawnError: null } : ok(PROGRESS_OK('2x')),
    );
    const caps = await probeTranscodeCapabilities({ ffmpegBin: 'ffmpeg', run, listRenderNodes: () => [], hasNvidiaDevice: () => true, cpu, now });
    expect(caps.state).toBe('ready');
    expect(caps.devices.nvidia).toBe(true);
    expect(caps.encoders.find((e) => e.encoder === 'h264_nvenc')).toMatchObject({ ok: false, error: 'test encode timed out after 15 s' });
  });

  it('FFmpeg missing: unavailable, no test encodes', async () => {
    const { run, calls } = fakeFfmpeg(() => ok(''), {
      '-version': { code: null, stdout: '', stderr: '', timedOut: false, spawnError: 'spawn ffmpeg ENOENT' },
    });
    const caps = await probeTranscodeCapabilities({ ffmpegBin: 'ffmpeg', run, listRenderNodes: () => [], hasNvidiaDevice: () => false, cpu, now });
    expect(caps).toMatchObject({ state: 'unavailable', error: "FFmpeg can't run: spawn ffmpeg ENOENT", encoders: [], supported: { h264: false, hevc: false, av1: false } });
    expect(calls).toHaveLength(1);
    expect(summarizeCapabilities(caps)).toBe("unavailable (FFmpeg can't run: spawn ffmpeg ENOENT)");
  });

  it('a build without any candidate encoder', async () => {
    const { run } = fakeFfmpeg(() => ok(''), { '-encoders': ok(`Encoders:\n${LEGEND} V....D a64multi   Multicolor (codec a64_multi)\n`) });
    const caps = await probeTranscodeCapabilities({ ffmpegBin: 'ffmpeg', run, listRenderNodes: () => [], hasNvidiaDevice: () => false, cpu, now });
    expect(caps).toMatchObject({ state: 'ready', encoders: [], supported: { h264: false, hevc: false, av1: false }, error: null });
    expect(summarizeCapabilities(caps)).toBe('H.264: none · HEVC: none · AV1: none');
  });
});

describe('TranscodeCapabilityService', () => {
  it('is probing until the first probe ends, then caches; concurrent starts share one probe', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = fakeFfmpeg(() => ok(PROGRESS_OK('3x')));
    let versionCalls = 0;
    const run: RunFn = async (cmd, args, timeout) => {
      if (args.includes('-version')) {
        versionCalls++;
        await gate;
      }
      return inner.run(cmd, args, timeout);
    };
    const svc = new TranscodeCapabilityService({ ffmpegBin: 'ffmpeg', run, listRenderNodes: () => [], hasNvidiaDevice: () => false, cpu, now });
    expect(svc.get()).toMatchObject({ state: 'probing', cpu: { cores: 8 }, encoders: [] });
    expect(summarizeCapabilities(svc.get())).toBe('checking…');

    const a = svc.start();
    const b = svc.start();
    expect(a).toBe(b);
    expect(svc.get().state).toBe('probing');
    release();
    const caps = await a;
    expect(versionCalls).toBe(1);
    expect(caps.state).toBe('ready');
    expect(svc.get()).toBe(caps);

    // A later start re-probes (re-check).
    await svc.start();
    expect(versionCalls).toBe(2);
  });

  it('never rejects, even if the runner throws', async () => {
    const svc = new TranscodeCapabilityService({
      ffmpegBin: 'ffmpeg',
      run: async () => {
        throw new Error('boom');
      },
      listRenderNodes: () => [],
      hasNvidiaDevice: () => false,
      cpu,
      now,
    });
    await expect(svc.start()).resolves.toMatchObject({ state: 'unavailable', error: 'capability probe failed: boom' });
    expect(svc.get().state).toBe('unavailable');
  });

  it('after close() a finishing probe no longer replaces the result', async () => {
    const { run } = fakeFfmpeg(() => ok(PROGRESS_OK('3x')));
    const svc = new TranscodeCapabilityService({ ffmpegBin: 'ffmpeg', run, listRenderNodes: () => [], hasNvidiaDevice: () => false, cpu, now });
    const p = svc.start();
    svc.close();
    await p;
    expect(svc.get().state).toBe('probing');
  });
});
