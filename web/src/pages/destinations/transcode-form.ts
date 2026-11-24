// Pure helpers for the destination form's Transcoding section: what can be chosen for this
// platform on this server, defaults, and the plain-language hints. Rules live in @shared/transcode.

import type { TranscodeCapabilities, TranscodeEncoderResult, TranscodeSettings } from '@shared/api';
import {
  CODEC_LABELS,
  codecOptions,
  CPU_REFUSE_LOAD,
  CPU_WARN_LOAD,
  cpuEstimate,
  cpuRefusal,
  defaultTranscodeProfile,
  describeTranscode,
  fpsOptions,
  loadPercent,
  isTranscoding,
  pickEncoder,
  sizeOptions,
  transcodeLimits,
} from '@shared/transcode';
import type { DestinationTranscodeStatus, Feed, FeedState, PlatformInfo, TranscodeProfile, VideoCodec } from '@shared/types';
import type { SelectOption } from '../../components/Select';

export type FeedVideo = FeedState['video'];

/** What the section needs to know about this server (null while loading). */
export interface TranscodeContext {
  settings: TranscodeSettings | null;
  caps: TranscodeCapabilities | null;
}

/** Why transcoding can't be switched on for this platform on this server; null = it can. */
export function transcodeBlocked(info: Pick<PlatformInfo, 'id' | 'name'>, ctx: TranscodeContext): string | null {
  if (!ctx.settings || !ctx.caps) return null;
  if (!ctx.settings.enabled) return 'Transcoding is turned off on this server. An admin can turn it on in Settings → Transcoding.';
  if (ctx.caps.state === 'unavailable') return `This server can't transcode${ctx.caps.error ? `: ${ctx.caps.error}` : '.'}`;
  if (ctx.caps.state === 'ready' && codecOptions(info.id, ctx.caps).length === 0) {
    const wanted = transcodeLimits(info.id).codecs.map((c) => CODEC_LABELS[c]).join(' or ');
    return `No ${wanted} encoder works on this server, and that is what ${info.name} takes. See Settings → Transcoding.`;
  }
  return null;
}

/** Landscape wants width ≥ height, vertical the other way round: turn the frame when it doesn't match. */
export function orientFor(profile: TranscodeProfile, feed: Feed): TranscodeProfile {
  const { width, height } = profile.video;
  const turned = feed === 'vertical' ? width > height : height > width;
  return turned ? { ...profile, video: { ...profile.video, width: height, height: width } } : profile;
}

/**
 * The profile after switching transcoding on: the saved settings when there are some, else the
 * platform's default for this feed (with a codec this server can encode).
 */
export function turnOn(profile: TranscodeProfile | null, info: Pick<PlatformInfo, 'id'>, feed: Feed, video: FeedVideo, caps: TranscodeCapabilities | null): TranscodeProfile {
  if (profile) return orientFor({ ...profile, mode: 'transcode' }, feed);
  const fresh = defaultTranscodeProfile(info.id, feed, video);
  const codecs = codecOptions(info.id, caps);
  const codec = codecs.includes(fresh.video.codec) ? fresh.video.codec : (codecs[0] ?? fresh.video.codec);
  return { ...fresh, video: { ...fresh.video, codec } };
}

/** Switching off keeps the settings for next time ('copy' mode = nothing is encoded). */
export function turnOff(profile: TranscodeProfile | null): TranscodeProfile | null {
  return profile ? { ...profile, mode: 'copy' } : null;
}

export const sizeValue = (v: { width: number; height: number }): string => `${v.width}x${v.height}`;

export function parseSize(value: string): { width: number; height: number } | null {
  const m = /^(\d+)x(\d+)$/.exec(value);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

const SIZE_NAMES: Record<number, string> = { 2160: '4K', 1440: '1440p', 1080: '1080p', 720: '720p', 480: '480p' };

export function sizeSelectOptions(info: Pick<PlatformInfo, 'id'>, feed: Feed, current: { width: number; height: number }): SelectOption[] {
  const options = sizeOptions(info.id, feed).map((s) => {
    const name = SIZE_NAMES[Math.min(s.width, s.height)];
    return { value: sizeValue(s), label: `${s.width}×${s.height}${name ? ` (${name})` : ''}` };
  });
  // A size set through the API that isn't one of the standard ones stays selectable.
  if (!options.some((o) => o.value === sizeValue(current))) options.unshift({ value: sizeValue(current), label: `${current.width}×${current.height} (custom)` });
  return options;
}

export const SOURCE_FPS = 'source';

export function fpsSelectOptions(info: Pick<PlatformInfo, 'id'>, video: FeedVideo, current: number | null): SelectOption[] {
  const feedFps = video?.fps ? ` (${Math.round(video.fps * 100) / 100} fps now)` : '';
  const options = fpsOptions(info.id).map((f) => (f === null ? { value: SOURCE_FPS, label: `Same as the feed${feedFps}` } : { value: String(f), label: `${f} fps` }));
  if (current !== null && !options.some((o) => o.value === String(current))) options.push({ value: String(current), label: `${current} fps` });
  return options;
}

export function codecSelectOptions(info: Pick<PlatformInfo, 'id'>, caps: TranscodeCapabilities | null, current: VideoCodec): SelectOption[] {
  const usable = codecOptions(info.id, caps);
  const options = usable.map((c) => ({ value: c as string, label: CODEC_LABELS[c] }));
  if (!usable.includes(current)) options.unshift({ value: current, label: `${CODEC_LABELS[current] ?? current} (not available here)` });
  return options;
}

const BACKEND_LABELS: Record<TranscodeEncoderResult['backend'], string> = {
  software: 'CPU',
  nvenc: 'NVIDIA GPU',
  qsv: 'Intel GPU',
  vaapi: 'GPU (VAAPI)',
  amf: 'AMD GPU',
};

export function encoderLabel(e: Pick<TranscodeEncoderResult, 'encoder' | 'backend'>): string {
  return `${e.encoder} (${BACKEND_LABELS[e.backend] ?? e.backend})`;
}

export function encoderSelectOptions(codec: VideoCodec, caps: TranscodeCapabilities | null, current: string): SelectOption[] {
  const ready = caps?.state === 'ready' ? caps : null;
  const auto = ready ? pickEncoder(codec, 'auto', ready) : null;
  const options: SelectOption[] = [{ value: 'auto', label: auto ? `Automatic: ${encoderLabel(auto)}` : 'Automatic' }];
  for (const e of ready?.encoders ?? []) if (e.codec === codec && e.ok) options.push({ value: e.encoder, label: encoderLabel(e) });
  if (current !== 'auto' && !options.some((o) => o.value === current)) options.push({ value: current, label: `${current} (not working here)` });
  return options;
}

export const AUDIO_COPY = 'copy';
const AUDIO_KBPS = [128, 160, 192, 256, 320];

export function audioSelectOptions(current: TranscodeProfile['audio']): SelectOption[] {
  const options: SelectOption[] = [{ value: AUDIO_COPY, label: "Keep the feed's audio" }, ...AUDIO_KBPS.map((k) => ({ value: String(k), label: `Re-encode to AAC ${k} kbps` }))];
  if (current !== 'copy' && !AUDIO_KBPS.includes(current.bitrateKbps)) options.push({ value: String(current.bitrateKbps), label: `Re-encode to AAC ${current.bitrateKbps} kbps` });
  return options;
}

export const audioValue = (audio: TranscodeProfile['audio']): string => (audio === 'copy' ? AUDIO_COPY : String(audio.bitrateKbps));

export function parseAudio(value: string): TranscodeProfile['audio'] {
  const n = Number(value);
  return value === AUDIO_COPY || !Number.isInteger(n) || n <= 0 ? 'copy' : { codec: 'aac', bitrateKbps: n };
}

export const FALLBACK_OPTIONS: SelectOption[] = [
  { value: 'copy', label: 'Send the original feed instead (when the platform accepts it)' },
  { value: 'stop', label: 'Stop this destination' },
];

export interface LoadHint {
  tone: 'ok' | 'warn' | 'error';
  text: string;
}

/**
 * The CPU warning shown whenever a destination's transcoding is on and encodes on the CPU (the prod
 * server has no working GPU encoder): it costs CPU the whole time the destination is live, and the
 * same CPU runs Twitch Dual Format and every other encode.
 */
export const CPU_WARNING =
  "Transcoding runs on this server's CPU for as long as this destination is live. One 1080p60 encode can take a home server's whole CPU, and the same CPU also encodes Twitch Dual Format through Relay and every other transcoding destination: when it falls behind, all of them stutter. Try it in test mode before a show.";

/**
 * How heavy this encode looks next to what the encoder managed in the server's startup test, from
 * the same estimate the server checks (cpuEstimate): `error` = it would be refused on save.
 * null = nothing to say yet (encoders not checked, or no working encoder).
 */
export function loadHint(profile: TranscodeProfile, info: Pick<PlatformInfo, 'id'>, caps: TranscodeCapabilities | null, video: FeedVideo): LoadHint | null {
  if (caps?.state !== 'ready') return null;
  const encoder = pickEncoder(profile.video.codec, profile.video.encoder, caps);
  if (!encoder) return null;
  if (encoder.backend !== 'software') return { tone: 'ok', text: `Encodes on the ${BACKEND_LABELS[encoder.backend]} with ${encoder.encoder}.` };
  const cpu = cpuEstimate(profile, info.id, caps, video?.fps ?? null);
  if (!cpu || cpu.load === null) {
    return { tone: 'warn', text: `Encodes on the CPU with ${encoder.encoder}. Its test gave no speed figure, so there is no estimate: try it in test mode, the dashboard warns when it falls behind.` };
  }
  if (cpu.load >= CPU_REFUSE_LOAD) return { tone: 'error', text: cpuRefusal(cpu) };
  const assumed = cpu.assumedFps ? ' (at 60 fps: the feed\'s rate is not known yet)' : '';
  const pct = loadPercent(cpu.load);
  if (cpu.load >= CPU_WARN_LOAD) {
    return {
      tone: 'warn',
      text: `Encodes on the CPU with ${encoder.encoder}: ${pct} of what it managed in this server's short test${assumed}, close to its limit before decoding and everything else the server runs. Prefer a smaller size or frame rate.`,
    };
  }
  return { tone: 'ok', text: `Encodes on the CPU with ${encoder.encoder}: ${pct} of what it managed in this server's test${assumed}.` };
}

/** Whether the chosen encoder for this profile is a CPU one (the CPU warning is shown then). */
export function encodesOnCpu(profile: TranscodeProfile, caps: TranscodeCapabilities | null): boolean {
  if (caps?.state !== 'ready') return true; // unknown yet: the prod case, so say it
  const encoder = pickEncoder(profile.video.codec, profile.video.encoder, caps);
  return !encoder || encoder.backend === 'software';
}

/** Whether two profiles differ (the PATCH only sends a changed one). */
export function transcodeChanged(a: TranscodeProfile | null | undefined, b: TranscodeProfile | null | undefined): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

/** One line for lists: "Transcoded: H.264 1920×1080 · source fps · 6000 kbps"; null when copying. */
export function transcodeListLine(profile: TranscodeProfile | null | undefined): string | null {
  return isTranscoding(profile) ? `Transcoded: ${describeTranscode(profile.video)}` : null;
}

/** Dashboard card line for a push that transcodes (or fell back): text + whether it needs attention. */
export function transcodeStatusLine(t: DestinationTranscodeStatus | null | undefined): { text: string; tone: 'ok' | 'warn' } | null {
  if (!t) return null;
  const what = describeTranscode(t);
  switch (t.state) {
    case 'fallback-copy':
      return { text: `Transcoding stopped: sending the original feed (wanted ${what})`, tone: 'warn' };
    case 'behind':
      return { text: `Transcoding ${what} with ${t.encoder ?? 'the encoder'}: ${t.speed !== null ? `${t.speed.toFixed(2)}× real time` : 'behind'}`, tone: 'warn' };
    case 'starting':
      return { text: `Transcoding ${what} with ${t.encoder ?? 'the encoder'}: starting`, tone: t.message ? 'warn' : 'ok' };
    default:
      // A message on a running encode is the CPU guard's "may stutter" (the platform can't take the original).
      return { text: `Transcoding ${what} with ${t.encoder ?? 'the encoder'}${t.speed !== null ? ` · ${t.speed.toFixed(2)}× real time` : ''}`, tone: t.message ? 'warn' : 'ok' };
  }
}
