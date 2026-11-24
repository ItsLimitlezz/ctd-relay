// Transcoding rules shared by the server (validation, FFmpeg) and the web UI (form defaults):
// what each platform's RTMP ingest accepts, the default profile for a destination, profile checks,
// and which encoder "auto" picks on this machine. Pure (no runtime dependencies). docs/TRANSCODING.md.

import type { TranscodeCapabilities, TranscodeEncoderResult } from './api.js';
import type { Feed, FeedState, PlatformId, TranscodeProfile, VideoCodec } from './types.js';
import { VIDEO_CODECS } from './types.js';

export const CODEC_LABELS: Record<VideoCodec, string> = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1' };

/** What a platform's RTMP(S) ingest accepts (docs/TRANSCODING.md §3; late 2026). */
export interface PlatformTranscodeLimits {
  /** Codecs it accepts over plain RTMP, preferred first. */
  codecs: readonly VideoCodec[];
  /** Largest frame, either orientation: long edge × short edge. */
  maxLongEdge: number;
  maxShortEdge: number;
  maxFps: number;
  /** Frame-rate cap the default profile uses (the feed's own rate when it is lower). */
  defaultFps: number;
  /** Video bitrate in kbit/s: the default, and the most a profile may ask for. */
  recommendedKbps: number;
  maxKbps: number;
  /** B-frames the encoder may use (0 for the mobile-first platforms). */
  maxBframes: number;
}

const HD = { maxLongEdge: 1920, maxShortEdge: 1080 } as const;

/**
 * Per platform. Twitch takes HEVC/AV1 only through Enhanced Broadcasting (its own handshake), Kick
 * hasn't been verified with HEVC, so both are H.264 here until checked.
 */
export const PLATFORM_TRANSCODE_LIMITS: Record<PlatformId, PlatformTranscodeLimits> = {
  youtube: { codecs: ['h264', 'hevc', 'av1'], maxLongEdge: 3840, maxShortEdge: 2160, maxFps: 60, defaultFps: 60, recommendedKbps: 12000, maxKbps: 51000, maxBframes: 2 },
  twitch: { codecs: ['h264'], ...HD, maxFps: 60, defaultFps: 60, recommendedKbps: 6000, maxKbps: 8500, maxBframes: 2 },
  kick: { codecs: ['h264'], ...HD, maxFps: 60, defaultFps: 60, recommendedKbps: 8000, maxKbps: 8000, maxBframes: 2 },
  facebook: { codecs: ['h264'], ...HD, maxFps: 60, defaultFps: 60, recommendedKbps: 6000, maxKbps: 9000, maxBframes: 2 },
  x: { codecs: ['h264'], ...HD, maxFps: 60, defaultFps: 60, recommendedKbps: 9000, maxKbps: 12000, maxBframes: 2 },
  instagram: { codecs: ['h264'], ...HD, maxFps: 30, defaultFps: 30, recommendedKbps: 4000, maxKbps: 6000, maxBframes: 0 },
  tiktok: { codecs: ['h264'], ...HD, maxFps: 60, defaultFps: 30, recommendedKbps: 6000, maxKbps: 6000, maxBframes: 0 },
  custom: { codecs: ['h264', 'hevc', 'av1'], maxLongEdge: 7680, maxShortEdge: 4320, maxFps: 120, defaultFps: 60, recommendedKbps: 6000, maxKbps: 100000, maxBframes: 2 },
};

export function transcodeLimits(platform: PlatformId): PlatformTranscodeLimits {
  return PLATFORM_TRANSCODE_LIMITS[platform] ?? PLATFORM_TRANSCODE_LIMITS.custom;
}

/** Profile field ranges (beyond the platform limits). */
export const TRANSCODE_RANGES = {
  minWidth: 160,
  minHeight: 90,
  minFps: 15,
  minKbps: 300,
  minKeyframeSec: 1,
  maxKeyframeSec: 10,
  minAudioKbps: 64,
  maxAudioKbps: 320,
} as const;

export const DEFAULT_KEYFRAME_SEC = 2;
export const DEFAULT_AUDIO_KBPS = 160;
export const DEFAULT_MAX_WORKERS = 2;
export const MAX_WORKERS_LIMIT = 8;

/** 16:9 frame heights offered by the UI (landscape; swapped for the vertical feed). */
const LADDER: readonly [number, number][] = [
  [3840, 2160],
  [2560, 1440],
  [1920, 1080],
  [1280, 720],
  [854, 480],
];

/** Frame sizes a profile for this platform and feed may pick in the UI, largest first. */
export function sizeOptions(platform: PlatformId, feed: Feed): { width: number; height: number }[] {
  const lim = transcodeLimits(platform);
  return LADDER.filter(([w, h]) => w <= lim.maxLongEdge && h <= lim.maxShortEdge).map(([w, h]) =>
    feed === 'vertical' ? { width: h, height: w } : { width: w, height: h },
  );
}

/** Frame rates the UI offers (null = the feed's own). */
export function fpsOptions(platform: PlatformId): (number | null)[] {
  const max = transcodeLimits(platform).maxFps;
  return [null, ...[120, 60, 50, 30, 25, 24].filter((f) => f <= max)];
}

/** Codecs the platform accepts that have a working encoder here (all accepted ones while unknown). */
export function codecOptions(platform: PlatformId, caps: TranscodeCapabilities | null): VideoCodec[] {
  const accepted = transcodeLimits(platform).codecs;
  if (!caps || caps.state !== 'ready') return [...accepted];
  return accepted.filter((c) => caps.supported[c]);
}

type FeedVideo = NonNullable<FeedState['video']>;

/**
 * The profile a destination starts from when transcoding is turned on: the platform's preferred
 * codec, the largest standard 16:9 (9:16 for vertical) frame that fits the platform and isn't larger
 * than the feed (no upscaling), the feed's frame rate capped at the platform default, the
 * recommended bitrate, 2 s keyframes, encoder 'auto', the feed's audio, and fall back to copy.
 */
export function defaultTranscodeProfile(platform: PlatformId, feed: Feed, video: Partial<FeedVideo> | null = null): TranscodeProfile {
  const lim = transcodeLimits(platform);
  const sizes = sizeOptions(platform, feed);
  // The everyday default is 1080p even where the platform allows more (YouTube): smaller and cheaper.
  const preferred = sizes.filter((s) => Math.max(s.width, s.height) <= 1920);
  const longFeed = video?.width && video.height ? Math.max(video.width, video.height) : null;
  // Largest first: the first one no larger than the feed; a feed smaller than all of them gets the smallest.
  const pick = (longFeed ? (preferred.find((s) => Math.max(s.width, s.height) <= longFeed) ?? preferred.at(-1)) : preferred[0]) ?? sizes.at(-1)!;
  const feedFps = video?.fps ?? null;
  const fps = feedFps !== null && feedFps <= lim.defaultFps + 0.5 ? null : lim.defaultFps >= 60 ? null : lim.defaultFps;
  return {
    mode: 'transcode',
    video: {
      codec: lim.codecs[0] ?? 'h264',
      width: pick.width,
      height: pick.height,
      fps,
      bitrateKbps: lim.recommendedKbps,
      keyframeSec: DEFAULT_KEYFRAME_SEC,
      encoder: 'auto',
    },
    audio: 'copy',
    fallback: 'copy',
  };
}

/**
 * Output frame rate actually used: the profile's, else the feed's capped at the platform maximum
 * (null = no fps filter, keep the feed's rate).
 */
export function effectiveFps(profile: TranscodeProfile, platform: PlatformId, feedFps: number | null | undefined): number | null {
  if (profile.video.fps !== null) return profile.video.fps;
  const max = transcodeLimits(platform).maxFps;
  return feedFps && feedFps > max + 0.5 ? max : null;
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

/**
 * Problems with a profile for this platform, in plain words ([] = fine). `caps` adds the machine
 * checks: the codec needs an encoder that passed its test here; a named encoder must have passed.
 * While the probe is still running (or caps is null) only the platform checks apply.
 */
export function validateTranscodeProfile(
  profile: TranscodeProfile,
  platform: PlatformId,
  platformName: string,
  caps: TranscodeCapabilities | null = null,
  feedFps: number | null = null,
): string[] {
  const errors: string[] = [];
  const lim = transcodeLimits(platform);
  const v = profile.video;
  const r = TRANSCODE_RANGES;
  if (!VIDEO_CODECS.includes(v.codec)) errors.push(`Unknown video codec ${String(v.codec)}`);
  else if (!lim.codecs.includes(v.codec)) {
    errors.push(`${platformName} doesn't accept ${CODEC_LABELS[v.codec]} (it takes ${lim.codecs.map((c) => CODEC_LABELS[c]).join(', ')})`);
  }
  if (!isInt(v.width) || !isInt(v.height) || v.width % 2 !== 0 || v.height % 2 !== 0 || v.width < r.minWidth || v.height < r.minHeight) {
    errors.push(`The frame size must be even numbers of at least ${r.minWidth}×${r.minHeight}`);
  } else if (Math.max(v.width, v.height) > lim.maxLongEdge || Math.min(v.width, v.height) > lim.maxShortEdge) {
    errors.push(`${platformName} takes at most ${lim.maxLongEdge}×${lim.maxShortEdge} (got ${v.width}×${v.height})`);
  }
  if (v.fps !== null && (!isInt(v.fps) || v.fps < r.minFps || v.fps > lim.maxFps)) {
    errors.push(`The frame rate must be between ${r.minFps} and ${lim.maxFps} fps for ${platformName}`);
  }
  if (!isInt(v.bitrateKbps) || v.bitrateKbps < r.minKbps || v.bitrateKbps > lim.maxKbps) {
    errors.push(`The video bitrate must be between ${r.minKbps} and ${lim.maxKbps} kbps for ${platformName}`);
  }
  if (!isInt(v.keyframeSec) || v.keyframeSec < r.minKeyframeSec || v.keyframeSec > r.maxKeyframeSec) {
    errors.push(`The keyframe interval must be ${r.minKeyframeSec} to ${r.maxKeyframeSec} seconds`);
  }
  if (profile.audio !== 'copy' && (!isInt(profile.audio.bitrateKbps) || profile.audio.bitrateKbps < r.minAudioKbps || profile.audio.bitrateKbps > r.maxAudioKbps)) {
    errors.push(`The audio bitrate must be between ${r.minAudioKbps} and ${r.maxAudioKbps} kbps`);
  }
  if (errors.length > 0 || !caps || caps.state === 'probing') return errors;

  if (caps.state === 'unavailable') {
    errors.push(`This server can't transcode: ${caps.error ?? "FFmpeg isn't available"}`);
  } else if (v.encoder === 'auto') {
    if (!pickEncoder(v.codec, 'auto', caps)) {
      errors.push(
        caps.supported[v.codec]
          ? `No ${CODEC_LABELS[v.codec]} encoder on this server is fast enough for "Auto" (see Settings → Transcoding); pick one by name`
          : `This server has no working ${CODEC_LABELS[v.codec]} encoder (see Settings → Transcoding)`,
      );
    }
  } else {
    const e = caps.encoders.find((x) => x.encoder === v.encoder);
    if (!e) errors.push(`Unknown encoder ${v.encoder}`);
    else if (e.codec !== v.codec) errors.push(`${v.encoder} doesn't encode ${CODEC_LABELS[v.codec]}`);
    else if (!e.ok) errors.push(`${v.encoder} failed its test encode on this server${e.error ? ` (${e.error})` : ''}`);
  }
  // The CPU guard: a software encode the server's own test says can't keep real time is refused.
  if (errors.length === 0 && isTranscoding(profile)) {
    const cpu = cpuEstimate(profile, platform, caps, feedFps);
    if (cpu && cpu.load !== null && cpu.load >= CPU_REFUSE_LOAD) errors.push(cpuRefusal(cpu));
  }
  return errors;
}

/** "Auto" only takes a software encoder that managed at least this speed in the 720p30 test. */
export const AUTO_SOFTWARE_MIN_SPEED = 1.5;

/**
 * The encoder to use: a named one when it passed its test here; 'auto' = the first working
 * hardware encoder (NVENC, QSV, VAAPI, AMF: the probe's order), else the software encoder when its
 * test ran at least AUTO_SOFTWARE_MIN_SPEED× real time. null = none.
 */
export function pickEncoder(codec: VideoCodec, wanted: string, caps: TranscodeCapabilities): TranscodeEncoderResult | null {
  if (caps.state !== 'ready') return null;
  const working = caps.encoders.filter((e) => e.codec === codec && e.ok);
  if (wanted !== 'auto') return working.find((e) => e.encoder === wanted) ?? null;
  return (
    working.find((e) => e.backend !== 'software') ??
    working.find((e) => e.backend === 'software' && (e.speed === null || e.speed >= AUTO_SOFTWARE_MIN_SPEED)) ??
    null
  );
}

/**
 * Rough load of one transcode as a share of what the encoder managed in its test (1.0 = all of it):
 * output pixel rate over the test's 1280×720×30, divided by the measured speed. null = unknown.
 * Software decode of the feed comes on top; this is a warning, not a promise.
 */
export function estimateLoad(width: number, height: number, fps: number | null, encoder: TranscodeEncoderResult | null, feedFps: number | null = null): number | null {
  const rate = fps ?? feedFps;
  if (!encoder?.speed || !rate) return null;
  return (width * height * rate) / (1280 * 720 * 30) / encoder.speed;
}

// ---- The CPU guard (SR check for 0.2.80: the prod server encodes on its CPU only) ----

/** Frame rate assumed for "same as the feed" while the feed's own isn't known: OBS's usual 60. */
export const ASSUMED_FEED_FPS = 60;
/** A software encode estimated at this share of the encoder's test speed or more can't keep real time: refused. */
export const CPU_REFUSE_LOAD = 1;
/** From this share on, the form, Settings and the card say the CPU is close to its limit. */
export const CPU_WARN_LOAD = 0.6;

/** A software encode's estimated CPU share (see estimateLoad); `load` null = no test speed. */
export interface CpuEstimate {
  encoder: TranscodeEncoderResult;
  load: number | null;
  width: number;
  height: number;
  /** The frame rate the estimate is for (the profile's, the feed's, or ASSUMED_FEED_FPS). */
  fps: number;
  /** True when `fps` is ASSUMED_FEED_FPS because the feed's frame rate isn't known. */
  assumedFps: boolean;
}

/**
 * The CPU estimate of a profile on this machine: null when it doesn't encode on the CPU (a GPU
 * encoder, no working encoder, or the encoders aren't checked yet). "Same as the feed" counts the
 * feed's frame rate, else ASSUMED_FEED_FPS, so an unknown rate never looks lighter than it may be.
 */
export function cpuEstimate(profile: TranscodeProfile, platform: PlatformId, caps: TranscodeCapabilities | null, feedFps: number | null = null): CpuEstimate | null {
  if (caps?.state !== 'ready') return null;
  const encoder = pickEncoder(profile.video.codec, profile.video.encoder || 'auto', caps);
  if (!encoder || encoder.backend !== 'software') return null;
  // effectiveFps is null for "keep the feed's rate" (no fps filter): then the feed's own rate counts.
  const known = effectiveFps(profile, platform, feedFps) ?? (feedFps && feedFps > 0 ? feedFps : null);
  const fps = known ?? ASSUMED_FEED_FPS;
  const { width, height } = profile.video;
  return { encoder, load: estimateLoad(width, height, fps, encoder), width, height, fps, assumedFps: known === null };
}

/** "about 147 %" */
export const loadPercent = (load: number): string => `about ${Math.round(load * 100)} %`;

/** Why a profile is refused: the server's own CPU test says it can't keep real time. */
export function cpuRefusal(cpu: CpuEstimate): string {
  const fps = `${Math.round(cpu.fps)} fps${cpu.assumedFps ? ' (the feed\'s rate is not known yet, so 60 is assumed)' : ''}`;
  return (
    `This server's CPU can't encode ${cpu.width}×${cpu.height} at ${fps} in real time: ${loadPercent(cpu.load ?? 0)} of what ${cpu.encoder.encoder} managed in its test. ` +
    'Lower the frame size or the frame rate (for example 1280×720 at 30 fps), or leave transcoding off.'
  );
}

/**
 * Whether the platform can take the feed as it is (for falling back to copy): its codec, frame size
 * and frame rate are within the platform's limits. Unknown codec or size = no.
 */
export function feedFitsPlatform(platform: PlatformId, video: FeedState['video'] | null | undefined): boolean {
  if (!video?.width || !video.height) return false;
  const lim = transcodeLimits(platform);
  if (!(lim.codecs as readonly string[]).includes(video.codec)) return false;
  if (Math.max(video.width, video.height) > lim.maxLongEdge || Math.min(video.width, video.height) > lim.maxShortEdge) return false;
  return !video.fps || video.fps <= lim.maxFps + 0.5;
}

/** "H.264 1920×1080 · 60 fps · 6000 kbps" (fps "source" when kept). */
export function describeTranscode(p: { codec: VideoCodec; width: number; height: number; fps: number | null; bitrateKbps: number }): string {
  return `${CODEC_LABELS[p.codec]} ${p.width}×${p.height} · ${p.fps === null ? 'source fps' : `${p.fps} fps`} · ${p.bitrateKbps} kbps`;
}

/** The profile is active: transcoding mode (copy-mode profiles keep their settings for later). */
export function isTranscoding(profile: TranscodeProfile | null | undefined): profile is TranscodeProfile {
  return profile?.mode === 'transcode';
}
