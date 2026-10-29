import { describe, expect, it } from 'vitest';
import type { MusicTrack } from '../../../shared/api.js';
import { ID_A } from './music-test-helpers.js';
import { Cooldowns, DEFAULT_SONG_REQUESTS, mayRequest, parseCommand, pickTrack, refusal, requestTarget, rolesOf } from './song-request.js';

const track = (over: Partial<MusicTrack> = {}): MusicTrack => ({
  id: ID_A,
  uri: `spotify:track:${ID_A}`,
  title: 'One More Time',
  artists: ['Daft Punk'],
  album: null,
  artUrl: null,
  durationMs: 320_000,
  explicit: false,
  url: null,
  ...over,
});

describe('parseCommand', () => {
  it('reads !sr / !songrequest / !song', () => {
    expect(parseCommand('!sr  one more   time ')).toEqual({ kind: 'request', query: 'one more time' });
    expect(parseCommand('!SongRequest daft punk')).toEqual({ kind: 'request', query: 'daft punk' });
    expect(parseCommand('!song')).toEqual({ kind: 'song' });
    expect(parseCommand('!sr')).toBeNull();
    expect(parseCommand('!song please')).toBeNull();
    expect(parseCommand('!srx hello')).toBeNull();
    expect(parseCommand('play !sr hello')).toBeNull();
    expect((parseCommand(`!sr ${'a'.repeat(500)}`) as { query: string }).query).toHaveLength(200);
  });
});

describe('who may request', () => {
  it('ranks everyone < subscribers < VIPs < moderators', () => {
    const viewer = rolesOf([]);
    const sub = rolesOf(['subscriber/12']);
    const member = rolesOf(['member']);
    const vip = rolesOf(['vip/1']);
    const mod = rolesOf(['moderator/1']);
    const owner = rolesOf(['broadcaster/1']);
    expect(mayRequest(viewer, 'everyone')).toBe(true);
    expect(mayRequest(viewer, 'subscribers')).toBe(false);
    expect(mayRequest(sub, 'subscribers')).toBe(true);
    expect(mayRequest(member, 'subscribers')).toBe(true);
    expect(mayRequest(sub, 'vips')).toBe(false);
    expect(mayRequest(vip, 'subscribers')).toBe(true);
    expect(mayRequest(vip, 'moderators')).toBe(false);
    expect(mayRequest(mod, 'moderators')).toBe(true);
    expect(mayRequest(owner, 'moderators')).toBe(true);
  });
});

describe('cooldowns', () => {
  it('counts per viewer', () => {
    const c = new Cooldowns();
    expect(c.remaining('twitch:1', 60, 0)).toBe(0);
    c.hit('twitch:1', 0);
    expect(c.remaining('twitch:1', 60, 10_000)).toBe(50_000);
    expect(c.remaining('twitch:2', 60, 10_000)).toBe(0);
    expect(c.remaining('twitch:1', 60, 60_000)).toBe(0);
    expect(c.remaining('twitch:1', 0, 1)).toBe(0);
  });
});

describe('tracks', () => {
  it('refuses explicit and long songs when set', () => {
    const s = { ...DEFAULT_SONG_REQUESTS, allowExplicit: false, maxDurationSec: 300 };
    expect(refusal(track({ explicit: true, durationMs: 100_000 }), s)).toBe('explicit songs are turned off');
    expect(refusal(track(), s)).toBe('songs longer than 5 min are turned off');
    expect(refusal(track({ durationMs: 299_000 }), s)).toBeNull();
  });

  it('picks the first result allowed (e.g. the clean version)', () => {
    const s = { ...DEFAULT_SONG_REQUESTS, allowExplicit: false };
    const dirty = track({ id: 'a', explicit: true });
    const clean = track({ id: 'b' });
    expect(pickTrack([dirty, clean], s)).toEqual({ track: clean });
    expect(pickTrack([dirty], s)).toEqual({ reason: 'explicit songs are turned off' });
    expect(pickTrack([], s)).toEqual({ reason: 'no song found' });
  });

  it('tells links from searches', () => {
    expect(requestTarget(`https://open.spotify.com/track/${ID_A}?si=1`)).toEqual({ kind: 'track', id: ID_A });
    expect(requestTarget('https://youtu.be/dQw4w9WgXcQ')).toEqual({ kind: 'bad-link' });
    expect(requestTarget('daft punk one more time')).toEqual({ kind: 'search', query: 'daft punk one more time' });
  });
});
