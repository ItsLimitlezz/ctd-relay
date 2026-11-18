import { describe, expect, it } from 'vitest';
import type { TranscodeCapabilities, TranscodeEncoderResult } from '../../../shared/api.js';
import type { TranscodeProfile } from '../../../shared/types.js';
import { buildTranscodePushArgs, encoderArgs, resolveTranscodeJob, videoFilter, type TranscodeJob } from './transcode-args.js';

const IN = 'rtmp://127.0.0.1:1935/live/landscape?user=internal&pass=readerpass';
const OUT = 'rtmps://ingest.example.com:443/app/streamkey';

const enc = (encoder: string, codec: TranscodeEncoderResult['codec'], backend: TranscodeEncoderResult['backend'], ok = true, speed: number | null = 3, device: string | null = null): TranscodeEncoderResult => ({
  encoder,
  codec,
  backend,
  ok,
  speed: ok ? speed : null,
  device,
  error: ok ? null : 'failed',
});

function caps(encoders: TranscodeEncoderResult[], state: TranscodeCapabilities['state'] = 'ready'): TranscodeCapabilities {
  const supported = { h264: false, hevc: false, av1: false };
  for (const e of encoders) if (e.ok) supported[e.codec] = true;
  return {
    state,
    probedAt: null,
    durationMs: null,
    ffmpegVersion: 'ffmpeg version n8.1.3',
    hwaccels: [],
    decoders: { h264: [], hevc: [], av1: [] },
    encoders,
    supported,
    cpu: { cores: 32, model: null },
    devices: { renderNodes: [], nvidia: false },
    error: state === 'unavailable' ? 'FFmpeg not found' : null,
  };
}

const CPU = caps([enc('h264_nvenc', 'h264', 'nvenc', false), enc('libx264', 'h264', 'software', true, 3.07), enc('libx265', 'hevc', 'software', true, 1.78), enc('libsvtav1', 'av1', 'software', true, 2.01)]);

const profile = (video: Partial<TranscodeProfile['video']> = {}, rest: Partial<TranscodeProfile> = {}): TranscodeProfile => ({
  mode: 'transcode',
  video: { codec: 'h264', width: 1920, height: 1080, fps: null, bitrateKbps: 6000, keyframeSec: 2, encoder: 'auto', ...video },
  audio: 'copy',
  fallback: 'copy',
  ...rest,
});

const job = (over: Partial<TranscodeJob> = {}): TranscodeJob => ({
  encoder: { encoder: 'libx264', backend: 'software', device: null },
  codec: 'h264',
  width: 1920,
  height: 1080,
  fps: null,
  gopFps: 60,
  bitrateKbps: 6000,
  keyframeSec: 2,
  bframes: 2,
  audio: 'copy',
  ...over,
});

const AV1_FEED = { video: { codec: 'av1', width: 3440, height: 1440, fps: 60 }, audio: { codec: 'aac', sampleRate: 48000, channels: 2 } };

describe('resolveTranscodeJob', () => {
  it('resolves the CPU encoder for the ultrawide AV1 feed (the issue, on the owner server)', () => {
    expect(resolveTranscodeJob(profile(), 'twitch', CPU, AV1_FEED)).toEqual({
      ok: true,
      job: {
        encoder: { encoder: 'libx264', backend: 'software', device: null },
        codec: 'h264',
        width: 1920,
        height: 1080,
        fps: null,
        gopFps: 60,
        bitrateKbps: 6000,
        keyframeSec: 2,
        bframes: 2,
        audio: 'copy',
      },
    });
  });

  it('caps the frame rate at the platform maximum and counts the GOP in the output rate', () => {
    const feed = { video: { codec: 'h264', width: 1080, height: 1920, fps: 60 }, audio: { codec: 'aac' } };
    const r = resolveTranscodeJob(profile({ width: 1080, height: 1920, bitrateKbps: 4000 }), 'instagram', CPU, feed);
    expect(r).toMatchObject({ ok: true, job: { fps: 30, gopFps: 30, bframes: 0 } });
    expect(resolveTranscodeJob(profile({ fps: 30 }), 'twitch', CPU, AV1_FEED)).toMatchObject({ job: { fps: 30, gopFps: 30 } });
    // Feed rate unknown: no fps filter, GOP assumes 60 (the forced keyframes keep the 2 s interval).
    expect(resolveTranscodeJob(profile(), 'twitch', CPU, null)).toMatchObject({ job: { fps: null, gopFps: 60 } });
    expect(resolveTranscodeJob(profile(), 'twitch', CPU, { video: { codec: 'h264', fps: 29.97 }, audio: null })).toMatchObject({ job: { fps: null, gopFps: 30 } });
  });

  it('copies audio only when the feed audio is AAC', () => {
    expect(resolveTranscodeJob(profile(), 'twitch', CPU, { video: null, audio: { codec: 'opus' } })).toMatchObject({ job: { audio: { bitrateKbps: 160 } } });
    expect(resolveTranscodeJob(profile(), 'twitch', CPU, null)).toMatchObject({ job: { audio: { bitrateKbps: 160 } } });
    expect(resolveTranscodeJob(profile({}, { audio: { codec: 'aac', bitrateKbps: 128 } }), 'twitch', CPU, AV1_FEED)).toMatchObject({ job: { audio: { bitrateKbps: 128 } } });
  });

  it('prefers working hardware and carries the VAAPI render node', () => {
    const gpu = caps([enc('h264_nvenc', 'h264', 'nvenc', false), enc('h264_vaapi', 'h264', 'vaapi', true, 8, '/dev/dri/renderD129'), enc('libx264', 'h264', 'software')]);
    expect(resolveTranscodeJob(profile(), 'twitch', gpu, AV1_FEED)).toMatchObject({ job: { encoder: { encoder: 'h264_vaapi', backend: 'vaapi', device: '/dev/dri/renderD129' } } });
    expect(resolveTranscodeJob(profile({ encoder: 'libx264' }), 'twitch', gpu, AV1_FEED)).toMatchObject({ job: { encoder: { encoder: 'libx264' } } });
  });

  it('says why there is no encode', () => {
    expect(resolveTranscodeJob(profile({ codec: 'hevc' }), 'youtube', caps([enc('libx264', 'h264', 'software')]), null)).toEqual({ ok: false, reason: 'no working HEVC encoder on this server' });
    expect(resolveTranscodeJob(profile({ encoder: 'h264_nvenc' }), 'twitch', CPU, null)).toEqual({ ok: false, reason: "h264_nvenc isn't working on this server" });
    expect(resolveTranscodeJob(profile(), 'twitch', caps([], 'unavailable'), null)).toEqual({ ok: false, reason: "this server can't transcode (FFmpeg not found)" });
    expect(resolveTranscodeJob(profile(), 'twitch', caps([], 'probing'), null)).toEqual({ ok: false, reason: "this server's encoders haven't been checked yet" });
  });
});

describe('videoFilter', () => {
  it('fits inside the frame and pads, never stretches', () => {
    expect(videoFilter(job())).toBe(
      'scale=1920:1080:flags=bicubic:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p',
    );
  });

  it('drops frames before scaling when a frame rate is set', () => {
    expect(videoFilter(job({ fps: 30, width: 1280, height: 720 }))).toMatch(/^fps=30,scale=1280:720:/);
  });

  it('hands hardware encoders NV12 (uploaded to a surface for VAAPI)', () => {
    expect(videoFilter(job({ encoder: { encoder: 'h264_nvenc', backend: 'nvenc', device: null } }))).toMatch(/,format=nv12$/);
    expect(videoFilter(job({ encoder: { encoder: 'h264_qsv', backend: 'qsv', device: null } }))).toMatch(/,format=nv12$/);
    expect(videoFilter(job({ encoder: { encoder: 'h264_amf', backend: 'amf', device: null } }))).toMatch(/,format=nv12$/);
    expect(videoFilter(job({ encoder: { encoder: 'h264_vaapi', backend: 'vaapi', device: '/dev/dri/renderD128' } }))).toMatch(/,format=nv12,hwupload$/);
  });
});

describe('buildTranscodePushArgs', () => {
  it('libx264: the whole command, golden', () => {
    expect(buildTranscodePushArgs(IN, OUT, job())).toEqual([
      '-hide_banner', '-nostdin', '-loglevel', 'warning', '-progress', 'pipe:1', '-stats_period', '2',
      '-rw_timeout', '15000000', '-i', IN,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', 'scale=1920:1080:flags=bicubic:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high',
      '-b:v', '6000k', '-minrate', '6000k', '-maxrate', '6000k', '-bufsize', '6000k',
      '-g', '120', '-keyint_min', '120', '-bf', '2', '-sc_threshold', '0', '-x264-params', 'nal-hrd=cbr:force-cfr=1',
      '-force_key_frames', 'expr:gte(t,n_forced*2)',
      '-c:a', 'copy',
      '-f', 'flv', '-flvflags', 'no_duration_filesize',
      OUT,
    ]);
  });

  it('counts the GOP in output frames: fps × keyframe seconds', () => {
    const args = buildTranscodePushArgs(IN, OUT, job({ fps: 30, gopFps: 30, keyframeSec: 2 }));
    expect(args[args.indexOf('-g') + 1]).toBe('60');
    expect(args[args.indexOf('-keyint_min') + 1]).toBe('60');
    const four = buildTranscodePushArgs(IN, OUT, job({ gopFps: 60, keyframeSec: 4 }));
    expect(four[four.indexOf('-g') + 1]).toBe('240');
    expect(four[four.indexOf('-force_key_frames') + 1]).toBe('expr:gte(t,n_forced*4)');
  });

  it('re-encodes audio to AAC when it cannot be copied', () => {
    const args = buildTranscodePushArgs(IN, OUT, job({ audio: { bitrateKbps: 160 } }));
    expect(args.join(' ')).toContain('-c:a aac -b:a 160k -ar 48000 -ac 2');
    expect(args).not.toContain('copy');
  });

  it('libx265 and libsvtav1: their presets, and Enhanced RTMP for the non-H.264 codec', () => {
    const hevc = buildTranscodePushArgs(IN, OUT, job({ codec: 'hevc', encoder: { encoder: 'libx265', backend: 'software', device: null }, bitrateKbps: 9000 }));
    expect(hevc.join(' ')).toContain('-c:v libx265 -preset ultrafast -b:v 9000k -maxrate 9000k -bufsize 9000k -g 120 -keyint_min 120 -bf 2 -x265-params log-level=error:scenecut=0:open-gop=0');
    expect(hevc.join(' ')).toContain('-rtmp_enhanced_codecs hvc1 -f flv');

    const av1 = buildTranscodePushArgs(IN, OUT, job({ codec: 'av1', encoder: { encoder: 'libsvtav1', backend: 'software', device: null }, bitrateKbps: 9000 }));
    // SVT-AV1 refuses -maxrate outside CRF and has no CBR here: target bitrate only.
    expect(av1.join(' ')).toContain('-c:v libsvtav1 -preset 10 -b:v 9000k -g 120 -svtav1-params scd=0 -force_key_frames');
    expect(av1).not.toContain('-maxrate');
    expect(av1).not.toContain('-bf');
    expect(av1.join(' ')).toContain('-rtmp_enhanced_codecs av01 -f flv');

    expect(buildTranscodePushArgs(IN, OUT, job())).not.toContain('-rtmp_enhanced_codecs');
    // Not an RTMP output (a file in tests): no RTMP option.
    expect(buildTranscodePushArgs(IN, '/tmp/out.flv', job({ codec: 'hevc', encoder: { encoder: 'libx265', backend: 'software', device: null } }))).not.toContain('-rtmp_enhanced_codecs');
  });

  it('hardware encoders: constant bitrate and the fixed GOP, per backend', () => {
    const args = (encoder: string, backend: TranscodeJob['encoder']['backend'], device: string | null = null) =>
      encoderArgs(job({ encoder: { encoder, backend, device } })).join(' ');
    expect(args('h264_nvenc', 'nvenc')).toBe('-c:v h264_nvenc -preset p4 -tune ll -rc cbr -b:v 6000k -maxrate 6000k -bufsize 6000k -g 120 -keyint_min 120 -bf 2 -forced-idr 1');
    expect(args('hevc_qsv', 'qsv')).toBe('-c:v hevc_qsv -preset veryfast -b:v 6000k -maxrate 6000k -bufsize 6000k -g 120 -keyint_min 120 -bf 2 -forced_idr 1');
    expect(args('h264_vaapi', 'vaapi', '/dev/dri/renderD128')).toBe('-c:v h264_vaapi -rc_mode CBR -b:v 6000k -maxrate 6000k -bufsize 6000k -g 120 -keyint_min 120 -bf 2');
    expect(args('h264_amf', 'amf')).toBe('-c:v h264_amf -usage lowlatency -rc cbr -b:v 6000k -maxrate 6000k -bufsize 6000k -g 120 -keyint_min 120 -bf 2');
  });

  it('VAAPI: opens the render node that passed the test, before the input', () => {
    const args = buildTranscodePushArgs(IN, OUT, job({ encoder: { encoder: 'h264_vaapi', backend: 'vaapi', device: '/dev/dri/renderD129' } }));
    expect(args.indexOf('-vaapi_device')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-vaapi_device') + 1]).toBe('/dev/dri/renderD129');
    expect(buildTranscodePushArgs(IN, OUT, job())).not.toContain('-vaapi_device');
  });

  it('no B-frames where the platform wants none', () => {
    const args = buildTranscodePushArgs(IN, OUT, job({ bframes: 0 }));
    expect(args[args.indexOf('-bf') + 1]).toBe('0');
  });

  it('puts extra output args right before the URL and needs a URL', () => {
    expect(buildTranscodePushArgs(IN, OUT, job(), ['-bufsize', '1M']).slice(-3)).toEqual(['-bufsize', '1M', OUT]);
    expect(() => buildTranscodePushArgs(IN, '', job())).toThrow(/output URL/);
    expect(() => encoderArgs(job({ encoder: { encoder: 'libaom-av1', backend: 'software', device: null } }))).toThrow(/Unsupported software encoder/);
  });
});
