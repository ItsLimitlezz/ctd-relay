import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FeedState } from '@shared/types';
import { blockedLabel, FeedCard } from './DashboardPage';

const feed = (over: Partial<FeedState> = {}): FeedState => ({
  feed: 'landscape',
  online: true,
  since: '2026-11-19T01:00:00.000Z',
  video: { codec: 'h264', width: 1920, height: 1080 },
  audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
  bitrateKbps: 6000,
  ...over,
});
const card = (state: FeedState) => renderToStaticMarkup(<FeedCard feed={state.feed} state={state} loading={false} />);

describe('feed card: codec', () => {
  it('H.264 + AAC shows no warning', () => {
    const out = card(feed());
    expect(out).toContain('H.264');
    expect(out).not.toContain('⚠');
    expect(out).not.toContain('role="alert"');
  });

  it('HEVC: "HEVC ⚠" on the card, with what to change in CTD OBS', () => {
    const out = card(feed({ video: { codec: 'hevc', width: 1920, height: 1080 } }));
    expect(out).toContain('HEVC ⚠');
    expect(out).toContain('tone-danger');
    expect(out).toContain('role="alert"');
    expect(out).toContain('Landscape feed is HEVC.');
    expect(out).toContain('need H.264');
    expect(out).toContain('Relay dock → Send stream (switches to H.264)');
    // Still online: OBS is connected, it just sends something Relay can't pass on.
    expect(out).toContain('Online');
  });

  it('AV1 on the vertical feed', () => {
    const out = card(feed({ feed: 'vertical', video: { codec: 'av1' } }));
    expect(out).toContain('AV1 ⚠');
    expect(out).toContain('Vertical feed is AV1.');
  });

  it('Opus audio is a warning: the feed is sent, without sound', () => {
    const out = card(feed({ audio: { codec: 'opus', channels: 2 } }));
    expect(out).toContain('Opus ⚠');
    expect(out).toContain('tone-warn');
    expect(out).toContain('without sound');
    expect(out).not.toContain('tone-danger');
  });

  it('an offline feed or unknown tracks show nothing', () => {
    expect(card(feed({ online: false, video: { codec: 'hevc' } }))).not.toContain('⚠');
    expect(card(feed({ video: null, audio: null }))).not.toContain('⚠');
  });
});

describe('blocked destination badge', () => {
  it('names the codec', () => {
    expect(blockedLabel({ reason: 'feed-video-codec', feed: 'landscape', codec: 'hevc' })).toBe('Blocked: HEVC feed');
    expect(blockedLabel({ reason: 'feed-video-codec', feed: 'vertical', codec: 'av1' })).toBe('Blocked: AV1 feed');
    expect(blockedLabel({ reason: 'feed-audio-missing', feed: 'landscape', codec: null })).toBe('Blocked: no AAC audio');
    expect(blockedLabel({ reason: 'feed-audio-codec', feed: 'landscape', codec: 'opus' })).toBe('Blocked: no AAC audio');
  });
});

describe('feed card: preview', () => {
  const withPreview = (state: FeedState) =>
    renderToStaticMarkup(<FeedCard feed={state.feed} state={state} loading={false} profileId="default" onWatch={() => undefined} />);

  it('an online H.264 feed: a thumbnail frame in its aspect, with Watch', () => {
    const out = withPreview(feed());
    expect(out).toContain('feed-thumb is-landscape');
    expect(out).toContain('Loading preview…'); // the first frame arrives after mount
    expect(out).toContain('Watch the landscape feed live');
    const v = withPreview(feed({ feed: 'vertical' }));
    expect(v).toContain('feed-thumb is-vertical');
  });

  it('offline: a placeholder, no Watch', () => {
    const out = withPreview(feed({ online: false, video: null, audio: null }));
    expect(out).toContain('data-mode="offline"');
    expect(out).toContain('Offline');
    expect(out).not.toContain('feed-thumb-watch');
  });

  it('HEVC: the codec warning instead of a picture or a player', () => {
    const out = withPreview(feed({ feed: 'vertical', video: { codec: 'hevc' } }));
    expect(out).toContain('data-mode="codec"');
    expect(out).toContain('No preview: Relay needs H.264');
    expect(out).not.toContain('feed-thumb-watch');
    expect(out).not.toContain('<video');
  });

  it('without a profile (older callers): no preview at all', () => {
    expect(card(feed())).not.toContain('feed-thumb');
  });
});
