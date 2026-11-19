import { describe, expect, it } from 'vitest';
import {
  audioBlock,
  blockMessage,
  codecLabel,
  explainNoStreamError,
  feedBlock,
  feedProblem,
  feedProblemLine,
  pushNeeds,
  sameBlock,
  videoBlock,
} from '../../../shared/feed-codec.js';
import type { PushPlan } from '../platforms/types.js';
import { describeTracks } from './feed-state.js';
import { feedWith, FFMPEG_NO_VIDEO_COPY, FFMPEG_NO_VIDEO_FILTER, TRACKS } from './test-helpers.js';

const COPY: PushPlan = { url: 'rtmp://live.example.com/app/key', mode: 'copy', feeds: ['landscape'] };
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
const IVS: PushPlan = {
  url: 'rtmps://ingest.example.com/app/key',
  mode: 'ivs',
  feeds: ['landscape', 'vertical'],
  ivs: { tracks: [track('landscape'), track('vertical')], audioBitrateKbps: 160, audioChannels: 2, preset: 'veryfast' },
};

describe('MediaMTX track sets → codecs', () => {
  it('classifies each fixture', () => {
    expect(describeTracks(TRACKS.h264Aac)).toMatchObject({ video: { codec: 'h264' }, audio: { codec: 'aac' } });
    expect(describeTracks(TRACKS.hevcAac)).toMatchObject({ video: { codec: 'hevc' }, audio: { codec: 'aac' } });
    expect(describeTracks(TRACKS.av1Aac)).toMatchObject({ video: { codec: 'av1' }, audio: { codec: 'aac' } });
    expect(describeTracks(TRACKS.h264Opus)).toMatchObject({ video: { codec: 'h264' }, audio: { codec: 'opus' } });
    expect(describeTracks(TRACKS.h264Only)).toMatchObject({ video: { codec: 'h264' }, audio: null });
  });

  it('labels codecs for people', () => {
    expect(codecLabel('hevc')).toBe('HEVC');
    expect(codecLabel('h264')).toBe('H.264');
    expect(codecLabel('av1')).toBe('AV1');
    expect(codecLabel('opus')).toBe('Opus');
    expect(codecLabel('prores')).toBe('PRORES');
  });
});

describe('videoBlock / audioBlock', () => {
  it('H.264 + AAC is fine', () => {
    const f = feedWith('landscape', 'h264Aac');
    expect(videoBlock(f)).toBeNull();
    expect(audioBlock(f)).toBeNull();
    expect(feedProblem(f)).toBeNull();
    expect(feedProblemLine(f)).toBeNull();
  });

  it('HEVC and AV1 video block the feed', () => {
    expect(videoBlock(feedWith('landscape', 'hevcAac'))).toEqual({ reason: 'feed-video-codec', feed: 'landscape', codec: 'hevc' });
    expect(videoBlock(feedWith('vertical', 'av1Aac'))).toEqual({ reason: 'feed-video-codec', feed: 'vertical', codec: 'av1' });
  });

  it('never blocks on what is not known: offline, or tracks not reported yet', () => {
    expect(videoBlock(feedWith('landscape', 'hevcAac', { online: false }))).toBeNull();
    expect(videoBlock(feedWith('landscape', null))).toBeNull();
    expect(audioBlock(feedWith('landscape', null))).toBeNull();
    expect(videoBlock(null)).toBeNull();
    expect(audioBlock(undefined)).toBeNull();
    expect(feedProblem(feedWith('landscape', null))).toBeNull();
  });

  it('audio: Opus is the wrong codec, no track is missing audio', () => {
    expect(audioBlock(feedWith('landscape', 'h264Opus'))).toEqual({ reason: 'feed-audio-codec', feed: 'landscape', codec: 'opus' });
    expect(audioBlock(feedWith('landscape', 'h264Only'))).toEqual({ reason: 'feed-audio-missing', feed: 'landscape', codec: null });
  });
});

describe('what a push needs', () => {
  it('copy: its feed in H.264; audio is optional', () => {
    expect(pushNeeds(COPY)).toEqual({ video: ['landscape'], audio: null });
    expect(feedBlock([feedWith('landscape', 'h264Aac')], pushNeeds(COPY))).toBeNull();
    expect(feedBlock([feedWith('landscape', 'h264Opus')], pushNeeds(COPY))).toBeNull();
    expect(feedBlock([feedWith('landscape', 'h264Only')], pushNeeds(COPY))).toBeNull();
    expect(feedBlock([feedWith('landscape', 'hevcAac')], pushNeeds(COPY))).toMatchObject({ reason: 'feed-video-codec', codec: 'hevc' });
    expect(feedBlock([feedWith('landscape', 'av1Aac')], pushNeeds(COPY))).toMatchObject({ reason: 'feed-video-codec', codec: 'av1' });
    // Another feed's codec is none of this push's business.
    expect(feedBlock([feedWith('landscape', 'h264Aac'), feedWith('vertical', 'hevcAac')], pushNeeds(COPY))).toBeNull();
  });

  it('Twitch Dual Format: both feeds in H.264 and AAC audio on the primary one', () => {
    expect(pushNeeds(IVS)).toEqual({ video: ['landscape', 'vertical'], audio: 'landscape' });
    const ok = [feedWith('landscape', 'h264Aac'), feedWith('vertical', 'h264Aac')];
    expect(feedBlock(ok, pushNeeds(IVS))).toBeNull();
    expect(feedBlock([ok[0]!, feedWith('vertical', 'hevcAac')], pushNeeds(IVS))).toEqual({ reason: 'feed-video-codec', feed: 'vertical', codec: 'hevc' });
    expect(feedBlock([feedWith('landscape', 'h264Only'), ok[1]!], pushNeeds(IVS))).toEqual({ reason: 'feed-audio-missing', feed: 'landscape', codec: null });
    expect(feedBlock([feedWith('landscape', 'h264Opus'), ok[1]!], pushNeeds(IVS))).toEqual({ reason: 'feed-audio-codec', feed: 'landscape', codec: 'opus' });
    // The vertical feed's audio isn't used.
    expect(feedBlock([ok[0]!, feedWith('vertical', 'h264Only')], pushNeeds(IVS))).toBeNull();
  });

  it('multitrack: every feed, no duplicates', () => {
    expect(pushNeeds({ mode: 'multitrack', feeds: ['landscape', 'vertical', 'landscape'] })).toEqual({ video: ['landscape', 'vertical'], audio: null });
  });

  it('compares blocks', () => {
    const a = videoBlock(feedWith('landscape', 'hevcAac'));
    expect(sameBlock(a, videoBlock(feedWith('landscape', 'hevcAac')))).toBe(true);
    expect(sameBlock(a, videoBlock(feedWith('landscape', 'av1Aac')))).toBe(false);
    expect(sameBlock(a, null)).toBe(false);
    expect(sameBlock(null, undefined)).toBe(true);
  });
});

describe('messages', () => {
  const hevc = videoBlock(feedWith('landscape', 'hevcAac'))!;

  it('says what is wrong, why, and what to change in CTD OBS', () => {
    expect(blockMessage(hevc, { platform: 'YouTube' })).toBe(
      'Landscape feed is HEVC. YouTube gets the stream unchanged and needs H.264. In CTD OBS: Relay dock → Send stream (switches to H.264), ' +
        'or Settings → Output → Video encoder: H.264. It starts by itself once the feed is H.264.',
    );
    expect(blockMessage(hevc)).toContain('Twitch, YouTube, Kick and the other platforms get the stream unchanged and need H.264.');
    expect(blockMessage(videoBlock(feedWith('vertical', 'av1Aac'))!, { platform: 'Instagram' })).toMatch(
      /^Vertical feed is AV1\. Instagram gets the stream unchanged and needs H\.264\. .*vertical stream's settings → Video encoder: H\.264\./,
    );
  });

  it('Dual Format does not "get the stream unchanged"', () => {
    expect(blockMessage(hevc, { encodes: true })).toContain('Twitch Dual Format needs H.264 feeds.');
    expect(blockMessage(audioBlock(feedWith('landscape', 'h264Only'))!, { encodes: true })).toBe(
      'Landscape feed has no audio. Twitch Dual Format needs AAC audio on it. In OBS: Settings → Output → Audio encoder: AAC. ' +
        'It starts by itself once the feed has AAC audio.',
    );
    expect(blockMessage(audioBlock(feedWith('landscape', 'h264Opus'))!, { encodes: true })).toContain('Landscape feed audio is Opus.');
  });

  it('stays under the 300 characters apps show', () => {
    for (const tracks of ['hevcAac', 'av1Aac'] as const) {
      for (const feed of ['landscape', 'vertical'] as const) {
        const block = videoBlock(feedWith(feed, tracks))!;
        expect(blockMessage(block).length).toBeLessThanOrEqual(300);
        expect(blockMessage(block, { platform: 'Facebook' }).length).toBeLessThanOrEqual(300);
      }
    }
  });
});

describe('feed status', () => {
  it('HEVC: "Landscape: HEVC ⚠", blocking', () => {
    const f = feedWith('landscape', 'hevcAac');
    expect(feedProblemLine(f)).toBe('Landscape: HEVC ⚠');
    expect(feedProblem(f)).toMatchObject({ reason: 'feed-video-codec', codec: 'hevc', label: 'HEVC', blocking: true });
    expect(feedProblem(f)?.message).not.toContain('starts by itself');
    expect(feedProblemLine(feedWith('vertical', 'av1Aac'))).toBe('Vertical: AV1 ⚠');
  });

  it('Opus audio: a warning (sent without sound), not a block; no audio track at all is not reported', () => {
    expect(feedProblem(feedWith('vertical', 'h264Opus'))).toMatchObject({ reason: 'feed-audio-codec', codec: 'opus', label: 'Opus', blocking: false });
    expect(feedProblem(feedWith('vertical', 'h264Opus'))?.message).toContain('without sound');
    expect(feedProblem(feedWith('vertical', 'h264Only'))).toBeNull();
  });

  it('an offline feed has no problem', () => {
    expect(feedProblem(feedWith('landscape', 'hevcAac', { online: false }))).toBeNull();
  });
});

describe("FFmpeg's \"Invalid argument\"", () => {
  it('copy push on an HEVC or AV1 feed: the same clear message', () => {
    const msg = explainNoStreamError(FFMPEG_NO_VIDEO_COPY, [feedWith('landscape', 'hevcAac')], COPY);
    expect(msg).toMatch(/^Landscape feed is HEVC\. Twitch, YouTube, Kick and the other platforms get the stream unchanged and need H\.264\./);
    expect(msg).toContain('Relay dock → Send stream');
    expect(explainNoStreamError(FFMPEG_NO_VIDEO_COPY, [feedWith('landscape', 'av1Aac')], COPY)).toMatch(/^Landscape feed is AV1\./);
  });

  it('Dual Format on an HEVC feed, or without audio', () => {
    const feeds = [feedWith('landscape', 'h264Aac'), feedWith('vertical', 'hevcAac')];
    expect(explainNoStreamError(FFMPEG_NO_VIDEO_FILTER, feeds, IVS)).toMatch(/^Vertical feed is HEVC\. Twitch Dual Format needs H\.264 feeds\./);
    const silent = [feedWith('landscape', 'h264Only'), feedWith('vertical', 'h264Aac')];
    expect(explainNoStreamError(FFMPEG_NO_VIDEO_FILTER, silent, IVS)).toMatch(/^Landscape feed has no audio\. Twitch Dual Format needs AAC audio on it\./);
  });

  it('tracks not known: says what feeds have to be', () => {
    expect(explainNoStreamError(FFMPEG_NO_VIDEO_COPY, [feedWith('landscape', null)], COPY)).toMatch(
      /^Relay found no video it can send in the landscape feed\. Feeds must be H\.264 video with AAC audio\./,
    );
    expect(explainNoStreamError(FFMPEG_NO_VIDEO_COPY, [], COPY)).toMatch(/^Relay found no video it can send/);
  });

  it("leaves FFmpeg's line alone when the feed is fine or the error is another one", () => {
    expect(explainNoStreamError(FFMPEG_NO_VIDEO_COPY, [feedWith('landscape', 'h264Aac')], COPY)).toBeNull();
    // "Invalid argument" on output open without a missing stream (e.g. a bad output option), codec unknown.
    expect(explainNoStreamError(['Error opening output files: Invalid argument'], [feedWith('landscape', null)], COPY)).toBeNull();
    expect(explainNoStreamError(['Error opening output rtmp://x: I/O error'], [feedWith('landscape', 'hevcAac')], COPY)).toBeNull();
    expect(explainNoStreamError([], [feedWith('landscape', 'hevcAac')], COPY)).toBeNull();
  });
});
