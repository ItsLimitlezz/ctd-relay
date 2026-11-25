import { describe, expect, it } from 'vitest';
import type { GuestFeed, GuestFeedList } from '@shared/guest-feeds';
import { parseServerMessage } from './live-store';
import { applyGuestFeed, bitrateWarning, guestFeedState, guestMediaLine, guestSource, guestStatus, ingestText } from './guest-feeds';

const g = (over: Partial<GuestFeed> = {}): GuestFeed => ({
  slot: 'q7m2x9k4tb',
  name: 'Remote cam 1',
  key: 'active',
  online: true,
  since: '2026-11-24T20:00:00.000Z',
  video: { codec: 'h264', width: 720, height: 1280 },
  audio: { codec: 'aac' },
  bitrateKbps: 3480,
  bitrateWarning: false,
  problem: null,
  limitedAt: null,
  ...over,
});
const list = (feeds: GuestFeed[]): GuestFeedList => ({ profileId: 'default', maxSlots: 4, maxViewers: 2, warnAboveKbps: 8000, maxKbps: 20000, guestFeeds: feeds });

describe('guest feeds (web)', () => {
  it('frames a guest by its orientation and uses its own URLs and texts', () => {
    expect(guestFeedState(g(), 'default')).toMatchObject({ feed: 'vertical', online: true });
    expect(guestFeedState(g({ video: { codec: 'h264', width: 1280, height: 720 } }), 'default').feed).toBe('landscape');
    const src = guestSource('default', g());
    expect(src.previewUrl).toBe('/api/profiles/default/guest-feeds/q7m2x9k4tb/preview.jpg');
    expect(src.liveUrl).toBe('/api/profiles/default/guest-feeds/q7m2x9k4tb/live.m3u8');
    expect(src.label).toBe('Guest feed "Remote cam 1"');
  });

  it('status, media line and warnings', () => {
    expect(guestStatus(g())).toEqual({ label: 'Online', tone: 'success' });
    expect(guestStatus(g({ online: false }))).toEqual({ label: 'Offline', tone: 'neutral' });
    expect(guestStatus(g({ key: 'revoked', online: false })).label).toBe('Key revoked');
    expect(guestMediaLine(g())).toBe('720×1280 · H.264 · AAC · 3.5 Mbps');
    expect(guestMediaLine(g({ online: false }))).toBeNull();
    expect(bitrateWarning(g(), list([]))).toBeNull();
    expect(bitrateWarning(g({ bitrateWarning: true }), list([]))).toContain('Above 8.0 Mbps');
    expect(bitrateWarning(g({ limitedAt: '2026-11-24T20:01:00.000Z' }), list([]))).toContain('disconnected');
  });

  it('copy text holds the details only when there is a key', () => {
    const info = { profileId: 'default', slot: 'q7m2x9k4tb', serverUrl: 'rtmp://relay.example:1935/guest', streamKey: 'q7m2x9k4tb?key=abc', fullUrl: 'rtmp://relay.example:1935/guest/q7m2x9k4tb?key=abc' };
    expect(ingestText('Cam', info)).toContain('Stream key: q7m2x9k4tb?key=abc');
    expect(ingestText('Cam', { ...info, streamKey: null, fullUrl: null })).toBeNull();
    expect(ingestText('Cam', info)).not.toContain('SRT');
  });

  it('copy text adds the SRT address (OBS Server, key empty) and the latency in microseconds when SRT is on', () => {
    const info = {
      profileId: 'default',
      slot: 'q7m2x9k4tb',
      serverUrl: 'rtmp://relay.example.com:1935/guest',
      streamKey: 'q7m2x9k4tb?key=abc',
      fullUrl: 'rtmp://relay.example.com:1935/guest/q7m2x9k4tb?key=abc',
      srtUrl: 'srt://relay.example.com:8890?streamid=publish:guest/q7m2x9k4tb:key=abc&latency=150000',
      srt: { enabled: true, port: 8890, latencyMs: 150, internetLatencyMs: 800, reason: null },
    };
    const text = ingestText('Cam', info)!;
    expect(text).toContain('srt://relay.example.com:8890?streamid=publish:guest/q7m2x9k4tb:key=abc&latency=150000');
    expect(text).toContain('Stream Key empty');
    expect(text).toContain('latency=800000');
  });

  it('applies a guest-feed socket message to the list (unknown slots wait for a refetch)', () => {
    const l = list([g()]);
    expect(applyGuestFeed(l, g({ online: false }))?.guestFeeds[0]?.online).toBe(false);
    expect(applyGuestFeed(l, g({ slot: 'zzzzzzzzzz' }))).toBe(l);
    expect(applyGuestFeed(null, g())).toBeNull();
  });

  it('the socket messages parse', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'guest-feed', profileId: 'default', guestFeed: g() }))?.type).toBe('guest-feed');
    expect(parseServerMessage(JSON.stringify({ type: 'guest-feed', profileId: 'default', guestFeed: {} }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'guest-feeds-changed', profileId: 'default' }))?.type).toBe('guest-feeds-changed');
  });
});
