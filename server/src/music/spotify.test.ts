import { describe, expect, it } from 'vitest';
import type { OAuthTokens } from '../platforms/common/oauth.js';
import { fakeSpotify, ID_A, rawTrack } from './music-test-helpers.js';
import {
  SPOTIFY_REDIRECT_URI,
  SpotifyClient,
  SpotifyError,
  codeFromPaste,
  exchangeCode,
  startLogin,
  toTrack,
  trackIdFrom,
  trackLabel,
} from './spotify.js';

function store(tokens: OAuthTokens | null) {
  let current = tokens;
  return {
    load: async () => current,
    save: async (t: OAuthTokens) => {
      current = t;
    },
    get current() {
      return current;
    },
  };
}

const fresh = (accessToken = 'at-1', expiresAt: number | null = Date.now() + 3_600_000): OAuthTokens => ({
  accessToken,
  refreshToken: 'rt-1',
  expiresAt,
  scope: null,
  tokenType: 'Bearer',
});

describe('sign-in', () => {
  it('builds a PKCE authorize URL for the loopback redirect', () => {
    const { url, pending } = startLogin('cid123', 'default.abc');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(u.searchParams.get('redirect_uri')).toBe(SPOTIFY_REDIRECT_URI);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toBe('user-read-currently-playing user-read-playback-state user-modify-playback-state');
    expect(u.searchParams.get('state')).toBe('default.abc');
    expect(pending.verifier.length).toBeGreaterThan(40);
  });

  it('reads the code from the pasted address and checks the state', () => {
    const pending = { verifier: 'v', state: 's1', createdAt: 0 };
    expect(codeFromPaste(`${SPOTIFY_REDIRECT_URI}?code=abc&state=s1`, pending)).toEqual({ code: 'abc' });
    expect(codeFromPaste(`${SPOTIFY_REDIRECT_URI}?code=abc&state=old`, pending)).toMatchObject({ error: expect.stringMatching(/older sign-in/) });
    expect(codeFromPaste(`${SPOTIFY_REDIRECT_URI}?error=access_denied&state=s1`, pending)).toMatchObject({ error: expect.stringMatching(/denied/) });
    expect(codeFromPaste('hello', pending)).toMatchObject({ error: expect.stringMatching(/no code/) });
  });

  it('exchanges the code with the verifier and no secret', async () => {
    const sp = fakeSpotify();
    const tokens = await exchangeCode('cid123', 'good-code', 'verifier', sp.fetch);
    expect(tokens).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1' });
    const form = new URLSearchParams(sp.calls[0]!.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code: 'good-code',
      redirect_uri: SPOTIFY_REDIRECT_URI,
      client_id: 'cid123',
      code_verifier: 'verifier',
    });
    await expect(exchangeCode('cid123', 'bad', 'verifier', sp.fetch)).rejects.toThrow(/Invalid authorization code/);
  });
});

describe('tracks', () => {
  it('finds track ids in links and URIs only', () => {
    expect(trackIdFrom(`https://open.spotify.com/track/${ID_A}?si=xyz`)).toBe(ID_A);
    expect(trackIdFrom(`https://open.spotify.com/intl-de/track/${ID_A}`)).toBe(ID_A);
    expect(trackIdFrom(`spotify:track:${ID_A}`)).toBe(ID_A);
    expect(trackIdFrom(`https://open.spotify.com/album/${ID_A}`)).toBeNull();
    expect(trackIdFrom(`https://evil.example/track/${ID_A}`)).toBeNull();
    expect(trackIdFrom('never gonna give you up')).toBeNull();
  });

  it('maps a track with the ~300 px art', () => {
    expect(toTrack(rawTrack(ID_A, { explicit: true }))).toEqual({
      id: ID_A,
      uri: `spotify:track:${ID_A}`,
      title: 'Song 4uLU',
      artists: ['Artist'],
      album: 'Album',
      artUrl: 'https://i.scdn.co/300',
      durationMs: 200_000,
      explicit: true,
      url: `https://open.spotify.com/track/${ID_A}`,
    });
    expect(toTrack({ type: 'episode', id: 'x', name: 'Podcast' })).toBeNull();
    expect(trackLabel({ title: 'One', artists: ['A', 'B'] })).toBe('One — A, B');
  });
});

describe('SpotifyClient', () => {
  it('reads now playing (204 = nothing) and refreshes an expiring login first', async () => {
    const sp = fakeSpotify();
    const tokens = store(fresh('at-0', Date.now() + 10_000)); // expires within the margin
    sp.state.accessToken = 'at-0';
    const client = new SpotifyClient({ clientId: 'cid', tokens, fetch: sp.fetch });
    expect(await client.nowPlaying()).toMatchObject({ playing: false, track: null, progressMs: null });
    expect(sp.calls[0]!.path).toBe('/api/token');
    expect(tokens.current?.accessToken).toBe('at-1');
    expect(tokens.current?.refreshToken).toBe('rt-1'); // kept when Spotify sends none

    sp.state.nowPlaying = { is_playing: true, progress_ms: 61_000, item: rawTrack(ID_A), currently_playing_type: 'track' };
    expect(await client.nowPlaying()).toMatchObject({ playing: true, progressMs: 61_000, track: { id: ID_A } });
  });

  it('refreshes once on a 401 and retries', async () => {
    const sp = fakeSpotify();
    sp.state.accessToken = 'at-5';
    const tokens = store(fresh('at-4'));
    const client = new SpotifyClient({ clientId: 'cid', tokens, fetch: sp.fetch });
    expect(await client.me()).toEqual({ id: 'djfan', name: 'DJ Fan' });
    expect(sp.calls.map((c) => c.path)).toEqual(['/v1/me', '/api/token', '/v1/me']);
  });

  it('searches with Spotify\'s limit and adds to the queue', async () => {
    const sp = fakeSpotify();
    const client = new SpotifyClient({ clientId: 'cid', tokens: store(fresh()), fetch: sp.fetch });
    const found = await client.search('daft punk', 50);
    expect(found.map((t) => t.id)).toEqual([ID_A]);
    expect(sp.calls[0]!.query.get('limit')).toBe('10');
    await client.addToQueue(`spotify:track:${ID_A}`);
    expect(sp.state.queue).toEqual([`spotify:track:${ID_A}`]);
    expect(await client.track('nope')).toBeNull();
  });

  it('explains queue failures', async () => {
    const sp = fakeSpotify();
    const client = new SpotifyClient({ clientId: 'cid', tokens: store(fresh()), fetch: sp.fetch });
    sp.state.queueError = { status: 404, reason: 'NO_ACTIVE_DEVICE', message: 'Player command failed: No active device found' };
    await expect(client.addToQueue('spotify:track:x')).rejects.toMatchObject({ message: 'Spotify is not playing on any device right now.', reason: 'NO_ACTIVE_DEVICE' });
    sp.state.queueError = { status: 403, reason: 'PREMIUM_REQUIRED', message: 'Premium required' };
    await expect(client.addToQueue('spotify:track:x')).rejects.toThrow(/needs Spotify Premium/);
  });

  it('passes Retry-After on 429', async () => {
    const sp = fakeSpotify({ 'GET /v1/me/player/currently-playing': () => ({ status: 429, json: {}, headers: { 'retry-after': '7' } }) });
    const client = new SpotifyClient({ clientId: 'cid', tokens: store(fresh()), fetch: sp.fetch });
    const err = await client.nowPlaying().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpotifyError);
    expect((err as SpotifyError).retryAfterMs).toBe(7000);
  });

  it('says the login is gone when there is none', async () => {
    const client = new SpotifyClient({ clientId: 'cid', tokens: store(null), fetch: fakeSpotify().fetch });
    const err = (await client.nowPlaying().catch((e: unknown) => e)) as SpotifyError;
    expect(err.needsLogin).toBe(true);
  });
});
