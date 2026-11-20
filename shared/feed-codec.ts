// Feed codec guard (pure, shared by server and web): can Relay send what OBS is sending?
//
// Relay reads each feed from MediaMTX over classic RTMP and hands it to the platform as FLV. Classic
// RTMP/FLV carries H.264 video and AAC audio only, so MediaMTX leaves an HEVC or AV1 video track
// (and an Opus audio track) out of what FFmpeg reads. Checked with MediaMTX v1.21.2 + FFmpeg n8.1.3:
//   - HEVC/AV1 video: FFmpeg gets no video stream. A copy push dies with "Error opening output
//     files: Invalid argument", Twitch Dual Format with "Error binding filtergraph inputs/outputs:
//     Invalid argument", on every retry.
//   - No AAC audio: a copy push still runs but the platform gets no sound; Twitch Dual Format can't
//     start (it encodes the primary feed's audio).
// The codec comes from MediaMTX's track list (media/feed-state.ts), which sees every track whatever
// the reader can take. Nothing here blocks on a codec that isn't known yet.

import type { DestinationBlock, Feed, FeedState } from './types.js';

/** The video codec every push needs on the feeds it reads. */
export const SENDABLE_VIDEO_CODEC = 'h264';
/** Audio codecs that reach the platform (classic FLV). */
const SENDABLE_AUDIO_CODECS: ReadonlySet<string> = new Set(['aac', 'mp3']);

const CODEC_LABELS: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  vp8: 'VP8',
  mpeg4: 'MPEG-4',
  mpeg2video: 'MPEG-2',
  mjpeg: 'M-JPEG',
  aac: 'AAC',
  aac_latm: 'AAC (LATM)',
  opus: 'Opus',
  mp3: 'MP3',
  ac3: 'AC-3',
  flac: 'FLAC',
  pcm: 'PCM',
};

const FEED_NAMES: Record<Feed, string> = { landscape: 'Landscape', vertical: 'Vertical' };

/** 'hevc' → "HEVC", 'h264' → "H.264"; unknown codecs in capitals. */
export function codecLabel(codec: string): string {
  return CODEC_LABELS[codec.toLowerCase()] ?? codec.toUpperCase();
}

type FeedTracks = Pick<FeedState, 'feed' | 'online' | 'video' | 'audio'>;

/** What a push reads: `video` feeds must be H.264; `audio` (if any) is the feed whose AAC audio it can't do without. */
export interface FeedNeeds {
  video: readonly Feed[];
  audio?: Feed | null;
}

/** Just what the guard needs of a PushPlan (server/src/platforms/types.ts). */
export interface PushPlanLike {
  mode: string;
  feeds: readonly Feed[];
  ivs?: { tracks: readonly { feed: Feed }[] } | undefined;
}

/**
 * The feeds a push depends on. Every mode reads its feeds over classic RTMP, so all of them need
 * H.264 video. Copy pushes map audio as optional; 'ivs' (Twitch Dual Format through Relay) encodes
 * the primary feed's audio and can't start without it.
 */
export function pushNeeds(plan: PushPlanLike): FeedNeeds {
  if (plan.mode === 'ivs' && plan.ivs && plan.ivs.tracks.length > 0) {
    const video: Feed[] = [];
    for (const t of plan.ivs.tracks) if (!video.includes(t.feed)) video.push(t.feed);
    return { video, audio: plan.ivs.tracks[0]!.feed };
  }
  return { video: [...new Set(plan.feeds)], audio: null };
}

/** The feed's video can't be sent (a known codec other than H.264), else null. Offline or unknown: null. */
export function videoBlock(feed: FeedTracks | null | undefined): DestinationBlock | null {
  const codec = feed?.online ? feed.video?.codec : undefined;
  if (!feed || !codec || codec.toLowerCase() === SENDABLE_VIDEO_CODEC) return null;
  return { reason: 'feed-video-codec', feed: feed.feed, codec: codec.toLowerCase() };
}

/**
 * The feed's audio can't be sent: another codec than AAC, or (video known, so the track list is in)
 * no audio at all. Offline or tracks unknown: null.
 */
export function audioBlock(feed: FeedTracks | null | undefined): DestinationBlock | null {
  if (!feed?.online || !feed.video) return null;
  const codec = feed.audio?.codec?.toLowerCase();
  if (!codec) return { reason: 'feed-audio-missing', feed: feed.feed, codec: null };
  if (SENDABLE_AUDIO_CODECS.has(codec)) return null;
  return { reason: 'feed-audio-codec', feed: feed.feed, codec };
}

/** The first reason a push with these needs can't run on the feeds as they are now, else null. */
export function feedBlock(feeds: readonly FeedTracks[], needs: FeedNeeds): DestinationBlock | null {
  const find = (f: Feed) => feeds.find((x) => x.feed === f);
  for (const f of needs.video) {
    const block = videoBlock(find(f));
    if (block) return block;
  }
  return needs.audio ? audioBlock(find(needs.audio)) : null;
}

export function sameBlock(a: DestinationBlock | null | undefined, b: DestinationBlock | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.reason === b.reason && a.feed === b.feed && a.codec === b.codec;
}

const FIX_VIDEO = 'In CTD OBS: Relay dock → Send stream (switches to H.264), or Settings → Output → Video encoder: H.264.';
const FIX_VIDEO_VERTICAL = 'In CTD OBS: Relay dock → Send stream (switches to H.264), or the vertical stream\'s settings → Video encoder: H.264.';
const FIX_AUDIO = 'In OBS: Settings → Output → Audio encoder: AAC.';

export interface BlockMessageOptions {
  /** The platform the message is for ("YouTube"); default: platforms in general. */
  platform?: string;
  /** The destination encodes on Relay (Twitch Dual Format): it doesn't "get the stream unchanged". */
  encodes?: boolean;
  /** Leave out "It starts by itself…" (feed-level texts, FFmpeg errors). */
  noResume?: boolean;
}

/**
 * The message for a blocked destination, e.g. "Landscape feed is HEVC. YouTube gets the stream
 * unchanged and needs H.264. In CTD OBS: Relay dock → Send stream (switches to H.264), or Settings →
 * Output → Video encoder: H.264. It starts by itself once the feed is H.264."
 */
export function blockMessage(block: DestinationBlock, opts: BlockMessageOptions = {}): string {
  const feed = FEED_NAMES[block.feed];
  const who = opts.platform?.trim();
  if (block.reason === 'feed-video-codec') {
    const what = `${feed} feed is ${codecLabel(block.codec ?? 'unknown')}.`;
    const why = opts.encodes
      ? `${who ?? 'Twitch Dual Format'} needs H.264 feeds.`
      : who
        ? `${who} gets the stream unchanged and needs H.264.`
        : 'Twitch, YouTube, Kick and the other platforms get the stream unchanged and need H.264.';
    const fix = block.feed === 'vertical' ? FIX_VIDEO_VERTICAL : FIX_VIDEO;
    return [what, why, fix, ...(opts.noResume ? [] : ['It starts by itself once the feed is H.264.'])].join(' ');
  }
  const what =
    block.reason === 'feed-audio-missing' ? `${feed} feed has no audio.` : `${feed} feed audio is ${codecLabel(block.codec ?? 'unknown')}.`;
  const why = opts.encodes ? `${who ?? 'Twitch Dual Format'} needs AAC audio on it.` : `${who ?? 'Platforms'} need${who ? 's' : ''} AAC audio.`;
  return [what, why, FIX_AUDIO, ...(opts.noResume ? [] : ['It starts by itself once the feed has AAC audio.'])].join(' ');
}

/** What is wrong with a feed on its own, whoever uses it (dashboard feed card, GET /status → feeds[].problem). */
export interface FeedProblem {
  reason: DestinationBlock['reason'];
  /** The codec that can't be sent ('hevc', 'av1', 'opus'). */
  codec: string;
  /** True: nothing can be sent from this feed. False: it is sent, but without sound. */
  blocking: boolean;
  /** Short label, e.g. "HEVC". */
  label: string;
  message: string;
}

/**
 * A feed's codec problem, or null: a video codec other than H.264 (no destination can send it), or
 * an audio codec other than AAC (platforms get the feed without sound).
 */
export function feedProblem(feed: FeedTracks | null | undefined): FeedProblem | null {
  const video = videoBlock(feed);
  if (video?.codec) {
    return { reason: video.reason, codec: video.codec, blocking: true, label: codecLabel(video.codec), message: blockMessage(video, { noResume: true }) };
  }
  const audio = audioBlock(feed);
  if (audio?.reason === 'feed-audio-codec' && audio.codec) {
    const label = codecLabel(audio.codec);
    return {
      reason: audio.reason,
      codec: audio.codec,
      blocking: false,
      label,
      message: `${FEED_NAMES[audio.feed]} feed audio is ${label}. Platforms need AAC audio, so they get this feed without sound. ${FIX_AUDIO}`,
    };
  }
  return null;
}

/** "Landscape: HEVC ⚠" (the profile's feed status line), or null when the feed is fine. */
export function feedProblemLine(feed: FeedTracks | null | undefined): string | null {
  const problem = feedProblem(feed);
  return problem && feed ? `${FEED_NAMES[feed.feed]}: ${problem.label} ⚠` : null;
}

/** FFmpeg's endings when the input has no stream to map (what a non-H.264 feed looks like to it). */
const NO_STREAM_RE = /Error opening output files?: Invalid argument|Error binding filtergraph inputs\/outputs: Invalid argument/i;
/** The line before them that names the cause: the mapped stream isn't in the input. */
const NO_MATCH_RE = /matches no streams/i;

/** True for FFmpeg's "Invalid argument" endings on output open / filtergraph binding. */
export function isNoStreamError(line: string): boolean {
  return NO_STREAM_RE.test(line);
}

/**
 * A clear sentence for FFmpeg's "Error opening output files: Invalid argument" / "Error binding
 * filtergraph inputs/outputs: Invalid argument" when a feed the push reads isn't H.264 + AAC, else
 * null (the caller keeps FFmpeg's line). `lines` are FFmpeg's last stderr lines. With the feed's
 * tracks unknown and FFmpeg saying the stream it wanted isn't there, it says what feeds have to be.
 */
export function explainNoStreamError(
  lines: readonly string[],
  feeds: readonly FeedTracks[],
  plan: PushPlanLike,
  opts: BlockMessageOptions = {},
): string | null {
  if (!lines.some(isNoStreamError)) return null;
  const needs = pushNeeds(plan);
  const block = feedBlock(feeds, needs);
  if (block) return blockMessage(block, { ...opts, encodes: plan.mode === 'ivs', noResume: true });
  if (!lines.some((l) => NO_MATCH_RE.test(l))) return null;
  // Tracks known and fine: not a codec problem, leave FFmpeg's own line.
  if (needs.video.every((f) => feeds.find((x) => x.feed === f)?.video)) return null;
  const names = needs.video.map((f) => FEED_NAMES[f].toLowerCase()).join(' and ');
  return `Relay found no video it can send in the ${names} feed${needs.video.length > 1 ? 's' : ''}. Feeds must be H.264 video with AAC audio. ${FIX_VIDEO}`;
}
