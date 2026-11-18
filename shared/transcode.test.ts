import { describe, expect, it } from 'vitest';
import type { TranscodeCapabilities, TranscodeEncoderResult } from './api.js';
import {
  codecOptions,
  defaultTranscodeProfile,
  describeTranscode,
  effectiveFps,
  estimateLoad,
  feedFitsPlatform,
  fpsOptions,
  isTranscoding,
  pickEncoder,
  PLATFORM_TRANSCODE_LIMITS,
  sizeOptions,
  validateTranscodeProfile,
} from './transcode.js';
import { PLATFORM_IDS, type TranscodeProfile } from './types.js';

const enc = (encoder: string, codec: TranscodeEncoderResult['codec'], backend: TranscodeEncoderResult['backend'], ok: boolean, speed: number | null = null): TranscodeEncoderResult => ({
  encoder,
  codec,
  backend,
  ok,
  speed: ok ? speed : null,
  device: null,
  error: ok ? null : 'Cannot load libcuda.so.1',
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
    decoders: { h264: ['h264'], hevc: ['hevc'], av1: ['libdav1d'] },
    encoders,
    supported,
    cpu: { cores: 32, model: null },
    devices: { renderNodes: [], nvidia: false },
    error: state === 'unavailable' ? 'FFmpeg not found' : null,
  };
}

/** The owner's server on 2026-11-18: CPU encoders only, every GPU encoder failed its test. */
const CPU_ONLY = caps([
  enc('h264_nvenc', 'h264', 'nvenc', false),
  enc('h264_vaapi', 'h264', 'vaapi', false),
  enc('libx264', 'h264', 'software', true, 3.07),
  enc('hevc_nvenc', 'hevc', 'nvenc', false),
  enc('libx265', 'hevc', 'software', true, 1.78),
  enc('av1_nvenc', 'av1', 'nvenc', false),
  enc('libsvtav1', 'av1', 'software', true, 2.01),
]);

const profile = (video: Partial<TranscodeProfile['video']> = {}, rest: Partial<TranscodeProfile> = {}): TranscodeProfile => ({
  mode: 'transcode',
  video: { codec: 'h264', width: 1920, height: 1080, fps: null, bitrateKbps: 6000, keyframeSec: 2, encoder: 'auto', ...video },
  audio: 'copy',
  fallback: 'copy',
  ...rest,
});

describe('platform limits', () => {
  it('covers every platform with sane numbers', () => {
    for (const id of PLATFORM_IDS) {
      const lim = PLATFORM_TRANSCODE_LIMITS[id];
      expect(lim.codecs.length, id).toBeGreaterThan(0);
      expect(lim.codecs, id).toContain('h264');
      expect(lim.maxLongEdge, id).toBeGreaterThanOrEqual(lim.maxShortEdge);
      expect(lim.defaultFps, id).toBeLessThanOrEqual(lim.maxFps);
      expect(lim.recommendedKbps, id).toBeLessThanOrEqual(lim.maxKbps);
    }
  });

  it('keeps Twitch and Kick on H.264 and lets YouTube take AV1', () => {
    expect(PLATFORM_TRANSCODE_LIMITS.twitch.codecs).toEqual(['h264']);
    expect(PLATFORM_TRANSCODE_LIMITS.kick.codecs).toEqual(['h264']);
    expect(PLATFORM_TRANSCODE_LIMITS.youtube.codecs).toEqual(['h264', 'hevc', 'av1']);
  });

  it('offers sizes within the platform, turned for the vertical feed', () => {
    expect(sizeOptions('twitch', 'landscape')).toEqual([
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { width: 854, height: 480 },
    ]);
    expect(sizeOptions('instagram', 'vertical')[0]).toEqual({ width: 1080, height: 1920 });
    expect(sizeOptions('youtube', 'landscape')[0]).toEqual({ width: 3840, height: 2160 });
    expect(fpsOptions('instagram')).toEqual([null, 30, 25, 24]);
    expect(fpsOptions('twitch')).toEqual([null, 60, 50, 30, 25, 24]);
  });

  it('offers only codecs with a working encoder once the probe is in', () => {
    expect(codecOptions('youtube', null)).toEqual(['h264', 'hevc', 'av1']);
    expect(codecOptions('youtube', caps([], 'probing'))).toEqual(['h264', 'hevc', 'av1']);
    expect(codecOptions('youtube', caps([enc('libx264', 'h264', 'software', true, 3)]))).toEqual(['h264']);
    expect(codecOptions('twitch', caps([enc('libx265', 'hevc', 'software', true, 2)]))).toEqual([]);
  });
});

describe('defaultTranscodeProfile', () => {
  it("is the issue's case: an ultrawide AV1 feed becomes 1080p H.264 at the platform's bitrate", () => {
    expect(defaultTranscodeProfile('twitch', 'landscape', { codec: 'av1', width: 3440, height: 1440, fps: 60 })).toEqual({
      mode: 'transcode',
      video: { codec: 'h264', width: 1920, height: 1080, fps: null, bitrateKbps: 6000, keyframeSec: 2, encoder: 'auto' },
      audio: 'copy',
      fallback: 'copy',
    });
    expect(defaultTranscodeProfile('kick', 'landscape', { codec: 'av1', width: 3440, height: 1440, fps: 60 }).video.bitrateKbps).toBe(8000);
  });

  it('never upscales and defaults to 1080p even where more is allowed', () => {
    expect(defaultTranscodeProfile('twitch', 'landscape', { codec: 'h264', width: 1280, height: 720, fps: 30 }).video).toMatchObject({ width: 1280, height: 720 });
    expect(defaultTranscodeProfile('youtube', 'landscape', { codec: 'h264', width: 3840, height: 2160, fps: 60 }).video).toMatchObject({ width: 1920, height: 1080 });
    expect(defaultTranscodeProfile('youtube', 'landscape').video).toMatchObject({ width: 1920, height: 1080, fps: null });
    // Smaller than the smallest standard size: the smallest one (padding, not a huge upscale).
    expect(defaultTranscodeProfile('twitch', 'landscape', { codec: 'h264', width: 640, height: 360 }).video).toMatchObject({ width: 854, height: 480 });
  });

  it('caps the frame rate where the platform is 30 fps', () => {
    expect(defaultTranscodeProfile('instagram', 'vertical', { codec: 'h264', width: 1080, height: 1920, fps: 60 }).video).toMatchObject({ width: 1080, height: 1920, fps: 30 });
    expect(defaultTranscodeProfile('instagram', 'vertical', { codec: 'h264', width: 1080, height: 1920, fps: 30 }).video.fps).toBeNull();
    expect(defaultTranscodeProfile('instagram', 'vertical').video.fps).toBe(30);
  });

  it('gives a profile that passes its own platform checks', () => {
    for (const id of PLATFORM_IDS) {
      for (const feed of ['landscape', 'vertical'] as const) {
        expect(validateTranscodeProfile(defaultTranscodeProfile(id, feed), id, id), `${id} ${feed}`).toEqual([]);
      }
    }
  });
});

describe('validateTranscodeProfile', () => {
  it('accepts a fitting profile', () => {
    expect(validateTranscodeProfile(profile(), 'twitch', 'Twitch', CPU_ONLY)).toEqual([]);
    expect(validateTranscodeProfile(profile({ codec: 'av1', width: 3840, height: 2160, bitrateKbps: 20000 }), 'youtube', 'YouTube', CPU_ONLY)).toEqual([]);
    expect(validateTranscodeProfile(profile({ width: 1080, height: 1920, fps: 30, bitrateKbps: 4000 }), 'instagram', 'Instagram', CPU_ONLY)).toEqual([]);
  });

  it("refuses what the platform doesn't take", () => {
    expect(validateTranscodeProfile(profile({ codec: 'hevc' }), 'kick', 'Kick')[0]).toMatch(/Kick doesn't accept HEVC/);
    expect(validateTranscodeProfile(profile({ codec: 'av1' }), 'twitch', 'Twitch')[0]).toMatch(/Twitch doesn't accept AV1 \(it takes H\.264\)/);
    expect(validateTranscodeProfile(profile({ width: 2560, height: 1440 }), 'twitch', 'Twitch')[0]).toMatch(/at most 1920×1080 \(got 2560×1440\)/);
    expect(validateTranscodeProfile(profile({ width: 1440, height: 1440 }), 'twitch', 'Twitch')[0]).toMatch(/at most 1920×1080/);
    expect(validateTranscodeProfile(profile({ fps: 60 }), 'instagram', 'Instagram')[0]).toMatch(/between 15 and 30 fps/);
    expect(validateTranscodeProfile(profile({ bitrateKbps: 20000 }), 'twitch', 'Twitch')[0]).toMatch(/between 300 and 8500 kbps/);
  });

  it('refuses malformed numbers', () => {
    expect(validateTranscodeProfile(profile({ width: 1921 }), 'custom', 'Custom')[0]).toMatch(/even numbers/);
    expect(validateTranscodeProfile(profile({ width: 100, height: 50 }), 'custom', 'Custom')[0]).toMatch(/at least 160×90/);
    expect(validateTranscodeProfile(profile({ fps: 29.97 }), 'custom', 'Custom')[0]).toMatch(/frame rate/);
    expect(validateTranscodeProfile(profile({ bitrateKbps: 100 }), 'custom', 'Custom')[0]).toMatch(/bitrate/);
    expect(validateTranscodeProfile(profile({ keyframeSec: 0 }), 'custom', 'Custom')[0]).toMatch(/keyframe/);
    expect(validateTranscodeProfile(profile({}, { audio: { codec: 'aac', bitrateKbps: 8 } }), 'custom', 'Custom')[0]).toMatch(/audio bitrate/);
  });

  it('needs an encoder that works on this machine', () => {
    const h264Only = caps([enc('h264_nvenc', 'h264', 'nvenc', false), enc('libx264', 'h264', 'software', true, 3.07)]);
    expect(validateTranscodeProfile(profile({ codec: 'hevc' }), 'youtube', 'YouTube', h264Only)[0]).toMatch(/no working HEVC encoder/);
    expect(validateTranscodeProfile(profile({ encoder: 'h264_nvenc' }), 'twitch', 'Twitch', h264Only)[0]).toMatch(/h264_nvenc failed its test encode on this server \(Cannot load libcuda\.so\.1\)/);
    expect(validateTranscodeProfile(profile({ encoder: 'h264_qsv' }), 'twitch', 'Twitch', h264Only)[0]).toMatch(/Unknown encoder h264_qsv/);
    expect(validateTranscodeProfile(profile({ encoder: 'libx265' }), 'twitch', 'Twitch', CPU_ONLY)[0]).toMatch(/libx265 doesn't encode H\.264/);
    expect(validateTranscodeProfile(profile({ encoder: 'libx264' }), 'twitch', 'Twitch', h264Only)).toEqual([]);
    expect(validateTranscodeProfile(profile(), 'twitch', 'Twitch', caps([], 'unavailable'))[0]).toMatch(/can't transcode: FFmpeg not found/);
  });

  it('only checks the platform while the probe is still running', () => {
    expect(validateTranscodeProfile(profile({ codec: 'av1' }), 'youtube', 'YouTube', caps([], 'probing'))).toEqual([]);
    expect(validateTranscodeProfile(profile({ codec: 'av1' }), 'twitch', 'Twitch', caps([], 'probing'))).toHaveLength(1);
  });

  it('says so when "Auto" has only a software encoder that is too slow', () => {
    const slow = caps([enc('libx264', 'h264', 'software', true, 1.1)]);
    expect(validateTranscodeProfile(profile(), 'twitch', 'Twitch', slow)[0]).toMatch(/fast enough for "Auto"/);
    expect(validateTranscodeProfile(profile({ encoder: 'libx264' }), 'twitch', 'Twitch', slow)).toEqual([]);
  });
});

describe('pickEncoder', () => {
  it('picks the CPU encoder when no GPU encoder works (the owner server)', () => {
    expect(pickEncoder('h264', 'auto', CPU_ONLY)?.encoder).toBe('libx264');
    expect(pickEncoder('hevc', 'auto', CPU_ONLY)?.encoder).toBe('libx265');
    expect(pickEncoder('av1', 'auto', CPU_ONLY)?.encoder).toBe('libsvtav1');
  });

  it('prefers a working hardware encoder, in the probe order', () => {
    const gpu = caps([enc('h264_nvenc', 'h264', 'nvenc', false), enc('h264_qsv', 'h264', 'qsv', true, 9), enc('h264_vaapi', 'h264', 'vaapi', true, 8), enc('libx264', 'h264', 'software', true, 3)]);
    expect(pickEncoder('h264', 'auto', gpu)?.encoder).toBe('h264_qsv');
    expect(pickEncoder('h264', 'libx264', gpu)?.encoder).toBe('libx264');
    expect(pickEncoder('h264', 'h264_nvenc', gpu)).toBeNull();
    expect(pickEncoder('hevc', 'auto', gpu)).toBeNull();
  });

  it('leaves a slow software encoder out of auto but allows it by name', () => {
    const slow = caps([enc('libx264', 'h264', 'software', true, 1.49)]);
    expect(pickEncoder('h264', 'auto', slow)).toBeNull();
    expect(pickEncoder('h264', 'libx264', slow)?.encoder).toBe('libx264');
    // A software encoder whose speed couldn't be read still counts.
    expect(pickEncoder('h264', 'auto', caps([enc('libx264', 'h264', 'software', true, null)]))?.encoder).toBe('libx264');
  });

  it('picks nothing before the probe is ready', () => {
    expect(pickEncoder('h264', 'auto', caps([enc('libx264', 'h264', 'software', true, 3)], 'probing'))).toBeNull();
  });
});

describe('helpers', () => {
  it('keeps the feed frame rate unless it is above the platform maximum', () => {
    expect(effectiveFps(profile(), 'twitch', 60)).toBeNull();
    expect(effectiveFps(profile(), 'twitch', 59.94)).toBeNull();
    expect(effectiveFps(profile(), 'instagram', 60)).toBe(30);
    expect(effectiveFps(profile(), 'instagram', null)).toBeNull();
    expect(effectiveFps(profile({ fps: 30 }), 'twitch', 60)).toBe(30);
  });

  it('estimates load from the test speed', () => {
    const x264 = enc('libx264', 'h264', 'software', true, 3.07);
    // 1080p60 is 4.5× the test's pixel rate: 4.5 / 3.07.
    expect(estimateLoad(1920, 1080, 60, x264)).toBeCloseTo(1.466, 2);
    expect(estimateLoad(1280, 720, 30, x264)).toBeCloseTo(0.326, 2);
    expect(estimateLoad(1920, 1080, null, x264, 30)).toBeCloseTo(0.733, 2);
    expect(estimateLoad(1920, 1080, null, x264)).toBeNull();
    expect(estimateLoad(1920, 1080, 60, null)).toBeNull();
  });

  it('knows when a platform can take the feed as it is', () => {
    expect(feedFitsPlatform('twitch', { codec: 'h264', width: 1920, height: 1080, fps: 60 })).toBe(true);
    expect(feedFitsPlatform('twitch', { codec: 'h264', width: 1920, height: 1080, fps: 59.94 })).toBe(true);
    expect(feedFitsPlatform('twitch', { codec: 'h264', width: 1920, height: 1080 })).toBe(true);
    expect(feedFitsPlatform('twitch', { codec: 'av1', width: 1920, height: 1080, fps: 60 })).toBe(false);
    expect(feedFitsPlatform('kick', { codec: 'h264', width: 3440, height: 1440, fps: 60 })).toBe(false);
    expect(feedFitsPlatform('youtube', { codec: 'av1', width: 3440, height: 1440, fps: 60 })).toBe(true);
    expect(feedFitsPlatform('instagram', { codec: 'h264', width: 1080, height: 1920, fps: 60 })).toBe(false);
    expect(feedFitsPlatform('instagram', { codec: 'h264', width: 1080, height: 1920, fps: 30 })).toBe(true);
    // Unknown codec or size: don't send it blind.
    expect(feedFitsPlatform('twitch', { codec: 'h264' })).toBe(false);
    expect(feedFitsPlatform('twitch', null)).toBe(false);
    expect(feedFitsPlatform('custom', { codec: 'vp9', width: 1280, height: 720 })).toBe(false);
  });

  it('describes a profile and tells copy from transcode', () => {
    expect(describeTranscode({ codec: 'h264', width: 1920, height: 1080, fps: null, bitrateKbps: 6000 })).toBe('H.264 1920×1080 · source fps · 6000 kbps');
    expect(describeTranscode({ codec: 'av1', width: 1280, height: 720, fps: 30, bitrateKbps: 2500 })).toBe('AV1 1280×720 · 30 fps · 2500 kbps');
    expect(isTranscoding(profile())).toBe(true);
    expect(isTranscoding(profile({}, { mode: 'copy' }))).toBe(false);
    expect(isTranscoding(null)).toBe(false);
    expect(isTranscoding(undefined)).toBe(false);
  });
});
