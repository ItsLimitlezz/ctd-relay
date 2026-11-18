// Transcoding push: which encode a destination gets (resolved against this machine's capabilities
// and the feed) and the FFmpeg arguments for it. Pure. docs/TRANSCODING.md §5.
//
// v1 encodes inside the destination's own push (one FFmpeg reads the feed, decodes, scales, encodes
// and sends to the platform), so the push supervisor's restarts, stats and stall detection apply
// unchanged and a copy destination never shares a process with an encode. Decoding is in software
// (libdav1d for AV1); hardware encoders get frames uploaded from system memory.

import type { TranscodeCapabilities, TranscodeEncoderResult } from '../../../shared/api.js';
import { effectiveFps, pickEncoder, transcodeLimits, CODEC_LABELS, DEFAULT_AUDIO_KBPS } from '../../../shared/transcode.js';
import type { FeedState, PlatformId, TranscodeProfile, VideoCodec } from '../../../shared/types.js';

/** Input read timeout, as for copy pushes: FFmpeg exits (and is retried) when the feed stalls 15 s. */
const RW_TIMEOUT_US = '15000000';

/** Software encoder presets: the same as the capability test, so its speed figure stays meaningful. */
export const SOFTWARE_PRESETS: Record<string, string> = { libx264: 'veryfast', libx265: 'ultrafast', libsvtav1: '10' };

/** Enhanced-RTMP FourCC per codec (sent in the RTMP connect so the server knows we speak E-RTMP). */
const FOURCC: Record<VideoCodec, string> = { h264: 'avc1', hevc: 'hvc1', av1: 'av01' };

/** Everything the FFmpeg arguments need, resolved for one push. */
export interface TranscodeJob {
  encoder: Pick<TranscodeEncoderResult, 'encoder' | 'backend' | 'device'>;
  codec: VideoCodec;
  width: number;
  height: number;
  /** Output frame rate; null = the feed's (no fps filter). */
  fps: number | null;
  /** Frame rate the keyframe interval (GOP) is counted in: the output's, else the feed's, else 60. */
  gopFps: number;
  bitrateKbps: number;
  keyframeSec: number;
  bframes: number;
  /** 'copy' only when the feed's audio is AAC; otherwise AAC at this bitrate. */
  audio: 'copy' | { bitrateKbps: number };
}

export type ResolvedTranscode = { ok: true; job: TranscodeJob } | { ok: false; reason: string };

/**
 * The encode for a profile on this machine, or why there is none. The feed's state supplies its
 * frame rate (fps cap, GOP) and audio codec (copy only AAC); either may be unknown.
 */
export function resolveTranscodeJob(
  profile: TranscodeProfile,
  platform: PlatformId,
  caps: TranscodeCapabilities,
  feed: Pick<FeedState, 'video' | 'audio'> | null,
): ResolvedTranscode {
  const v = profile.video;
  const label = CODEC_LABELS[v.codec] ?? v.codec;
  if (caps.state === 'unavailable') return { ok: false, reason: `this server can't transcode (${caps.error ?? 'FFmpeg unavailable'})` };
  if (caps.state !== 'ready') return { ok: false, reason: "this server's encoders haven't been checked yet" };
  const encoder = pickEncoder(v.codec, v.encoder || 'auto', caps);
  if (!encoder) {
    return {
      ok: false,
      reason: v.encoder && v.encoder !== 'auto' ? `${v.encoder} isn't working on this server` : `no working ${label} encoder on this server`,
    };
  }
  const feedFps = feed?.video?.fps ?? null;
  const fps = effectiveFps(profile, platform, feedFps);
  const lim = transcodeLimits(platform);
  const audio: TranscodeJob['audio'] =
    profile.audio === 'copy'
      ? feed?.audio?.codec === 'aac'
        ? 'copy'
        : { bitrateKbps: DEFAULT_AUDIO_KBPS }
      : { bitrateKbps: profile.audio.bitrateKbps };
  return {
    ok: true,
    job: {
      encoder: { encoder: encoder.encoder, backend: encoder.backend, device: encoder.device },
      codec: v.codec,
      width: v.width,
      height: v.height,
      fps,
      gopFps: fps ?? (feedFps ? Math.round(feedFps) : 60),
      bitrateKbps: v.bitrateKbps,
      keyframeSec: v.keyframeSec,
      bframes: lim.maxBframes,
      audio,
    },
  };
}

/** Video filter chain: fps (drop first: cheaper), fit inside the frame, pad, pixel format / upload. */
export function videoFilter(job: TranscodeJob): string {
  const { width: w, height: h } = job;
  const parts: string[] = [];
  if (job.fps !== null) parts.push(`fps=${job.fps}`);
  parts.push(
    `scale=${w}:${h}:flags=bicubic:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
  );
  switch (job.encoder.backend) {
    case 'software':
      parts.push('format=yuv420p');
      break;
    case 'vaapi':
      parts.push('format=nv12', 'hwupload');
      break;
    default:
      // NVENC / QSV / AMF take NV12 from system memory and upload it themselves.
      parts.push('format=nv12');
  }
  return parts.join(',');
}

/** Encoder-specific options: constant bitrate, fixed GOP, no scene-cut keyframes where settable. */
export function encoderArgs(job: TranscodeJob): string[] {
  const rate = `${job.bitrateKbps}k`;
  const gop = String(Math.max(1, Math.round(job.gopFps * job.keyframeSec)));
  const bf = String(job.bframes);
  const { encoder, backend } = job.encoder;
  const cbr = ['-b:v', rate, '-maxrate', rate, '-bufsize', rate];
  const gopArgs = ['-g', gop, '-keyint_min', gop, '-bf', bf];
  switch (backend) {
    case 'software':
      if (encoder === 'libx264') {
        return [
          '-c:v', 'libx264', '-preset', SOFTWARE_PRESETS.libx264!, '-profile:v', 'high',
          '-b:v', rate, '-minrate', rate, '-maxrate', rate, '-bufsize', rate,
          ...gopArgs, '-sc_threshold', '0', '-x264-params', 'nal-hrd=cbr:force-cfr=1',
        ];
      }
      if (encoder === 'libx265') {
        return ['-c:v', 'libx265', '-preset', SOFTWARE_PRESETS.libx265!, ...cbr, ...gopArgs, '-x265-params', 'log-level=error:scenecut=0:open-gop=0'];
      }
      if (encoder === 'libsvtav1') {
        // SVT-AV1 has no constant-bitrate mode for this (random-access) structure and refuses a
        // max bitrate outside CRF: target bitrate only. Its GOP comes from -g and the forced keyframes.
        return ['-c:v', 'libsvtav1', '-preset', SOFTWARE_PRESETS.libsvtav1!, '-b:v', rate, '-g', gop, '-svtav1-params', 'scd=0'];
      }
      throw new Error(`Unsupported software encoder ${encoder}`);
    case 'nvenc':
      return ['-c:v', encoder, '-preset', 'p4', '-tune', 'll', '-rc', 'cbr', ...cbr, ...gopArgs, '-forced-idr', '1'];
    case 'qsv':
      return ['-c:v', encoder, '-preset', 'veryfast', ...cbr, ...gopArgs, '-forced_idr', '1'];
    case 'vaapi':
      return ['-c:v', encoder, '-rc_mode', 'CBR', ...cbr, ...gopArgs];
    case 'amf':
      return ['-c:v', encoder, '-usage', 'lowlatency', '-rc', 'cbr', ...cbr, ...gopArgs];
    default:
      throw new Error(`Unsupported encoder backend ${String(backend)}`);
  }
}

function audioArgs(job: TranscodeJob): string[] {
  if (job.audio === 'copy') return ['-c:a', 'copy'];
  return ['-c:a', 'aac', '-b:a', `${job.audio.bitrateKbps}k`, '-ar', '48000', '-ac', '2'];
}

/**
 * Full FFmpeg arguments: read the feed (`inputUrl`, with the internal read credentials), transcode,
 * push FLV to `outputUrl` (the platform, with its key). Neither URL may be logged.
 */
export function buildTranscodePushArgs(inputUrl: string, outputUrl: string, job: TranscodeJob, extraOutputArgs: readonly string[] = []): string[] {
  if (!outputUrl) throw new Error('Push plan has no output URL');
  const head = ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-progress', 'pipe:1', '-stats_period', '2'];
  const device = job.encoder.backend === 'vaapi' ? ['-vaapi_device', job.encoder.device ?? '/dev/dri/renderD128'] : [];
  const rtmp = /^rtmps?:\/\//i.test(outputUrl) && job.codec !== 'h264' ? ['-rtmp_enhanced_codecs', FOURCC[job.codec]] : [];
  return [
    ...head,
    ...device,
    '-rw_timeout', RW_TIMEOUT_US,
    '-i', inputUrl,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', videoFilter(job),
    ...encoderArgs(job),
    // Keyframes on the clock (every keyframeSec of output time), whatever the encoder decides.
    '-force_key_frames', `expr:gte(t,n_forced*${job.keyframeSec})`,
    ...audioArgs(job),
    ...rtmp,
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    ...extraOutputArgs,
    outputUrl,
  ];
}
