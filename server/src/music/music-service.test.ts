import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NowPlaying, SongRequestResult } from '../../../shared/api.js';
import type { ChatMessage } from '../../../shared/types.js';
import { EventBus } from '../events.js';
import type { ChatMessageInput } from '../platforms/types.js';
import { profileSecretScope } from '../services.js';
import { changed, MusicService } from './music-service.js';
import { fakeSpotify, ID_A, ID_B, memorySecrets, memorySettings, rawTrack } from './music-test-helpers.js';
import { SPOTIFY_REDIRECT_URI } from './spotify.js';

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: () => log } as never;

let service: MusicService | null = null;
afterEach(() => {
  service?.close();
  service = null;
});

function setup(opts: { live?: boolean } = {}) {
  const bus = new EventBus();
  const settings = memorySettings();
  const secrets = memorySecrets();
  const sp = fakeSpotify();
  const posted: { destinationId: string; input: ChatMessageInput; profileId: string | undefined }[] = [];
  const music: NowPlaying[] = [];
  const requests: SongRequestResult[] = [];
  bus.on('music', (m) => music.push(m.nowPlaying));
  bus.on('music-request', (r) => requests.push(r.result));
  service = new MusicService({
    bus,
    log,
    settings,
    secrets,
    chat: { post: (destinationId, _platform, input, profileId) => posted.push({ destinationId, input, profileId }) },
    profiles: () => ['default', 'dprtmnt'],
    isLive: () => opts.live ?? true,
    fetch: sp.fetch,
    fastPollMs: 20,
    slowPollMs: 20,
  });
  service.start();
  return { bus, settings, secrets, sp, posted, music, requests, service };
}

async function connect(s: ReturnType<typeof setup>, profileId = 'default') {
  s.service.setClientId('0123456789abcdef0123456789abcdef');
  const start = await s.service.startConnect(profileId);
  const state = new URL(start.authorizeUrl).searchParams.get('state');
  return s.service.completeConnect(profileId, `${SPOTIFY_REDIRECT_URI}?code=good-code&state=${state}`);
}

let seq = 0;
function chat(text: string, over: Partial<ChatMessage> = {}, badges: string[] = []): ChatMessage {
  seq++;
  return {
    id: `twitch:m${seq}`,
    platform: 'twitch',
    destinationId: 'dest-tw',
    profileId: 'default',
    author: { name: 'NightOwl', id: '42', login: 'nightowl', badges },
    text,
    ts: new Date().toISOString(),
    kind: 'message',
    ...over,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
async function until(pred: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('connecting', () => {
  it('stores the login per profile and shows the account', async () => {
    const s = setup();
    expect(await connect(s)).toEqual({ id: 'djfan', name: 'DJ Fan' });
    const status = await s.service.status('default');
    expect(status).toMatchObject({ connected: true, account: { id: 'djfan', name: 'DJ Fan' }, clientId: '0123456789abcdef0123456789abcdef' });
    expect((await s.service.status('dprtmnt')).connected).toBe(false);
    expect(s.secrets.scopes.get(profileSecretScope('default', 'spotify'))?.has('oauth')).toBe(true);
    expect(s.secrets.scopes.get(profileSecretScope('default', 'spotify'))?.has('pending')).toBe(false);
  });

  it('rejects a paste from another sign-in and a bad Client ID', async () => {
    const s = setup();
    s.service.setClientId('0123456789abcdef0123456789abcdef');
    await s.service.startConnect('default');
    await expect(s.service.completeConnect('default', `${SPOTIFY_REDIRECT_URI}?code=good-code&state=default.other`)).rejects.toThrow(/older sign-in/);
    expect(() => s.service.setClientId('not a client id!')).toThrow(/not a Spotify Client ID/);
  });

  it('a new Client ID signs every profile out', async () => {
    const s = setup();
    await connect(s);
    s.service.setClientId('fedcba9876543210fedcba9876543210');
    await settle();
    expect((await s.service.status('default')).connected).toBe(false);
  });
});

describe('now playing', () => {
  it('emits a change for a new song and play/pause, not for steady progress', async () => {
    const s = setup();
    s.sp.state.nowPlaying = { is_playing: true, progress_ms: 1000, item: rawTrack(ID_A) };
    await connect(s);
    await until(() => s.music.length === 1);
    expect(s.music[0]).toMatchObject({ playing: true, track: { id: ID_A } });
    await settle();
    expect(s.music).toHaveLength(1); // same song, progress as expected

    s.sp.state.nowPlaying = { is_playing: true, progress_ms: 0, item: rawTrack(ID_B) };
    await until(() => s.music.length === 2);
    expect(s.music[1]!.track?.id).toBe(ID_B);
    expect(s.service.nowPlaying('default')?.track?.id).toBe(ID_B);
  });

  it('detects seeks', () => {
    const at = 1_000_000;
    const prev: NowPlaying = { playing: true, track: null, progressMs: 10_000, at };
    expect(changed(prev, { ...prev, progressMs: 15_000, at: at + 5000 })).toBe(false);
    expect(changed(prev, { ...prev, progressMs: 60_000, at: at + 5000 })).toBe(true);
    expect(changed({ ...prev, playing: false }, { ...prev, playing: false, at: at + 5000 })).toBe(false);
  });

  it('stops polling when the login is gone', async () => {
    const s = setup();
    await connect(s);
    s.sp.state.accessToken = 'at-99';
    s.sp.state.refreshRevoked = true;
    const before = s.sp.calls.length;
    await settle();
    await settle();
    const status = await s.service.status('default');
    expect(status.error).toMatch(/Spotify|login/i);
    const after = s.sp.calls.length;
    await settle();
    expect(s.sp.calls.length).toBe(after);
    expect(after).toBeGreaterThan(before);
  });
});

describe('song requests', () => {
  it('ignores !sr while requests are off', async () => {
    const s = setup();
    await connect(s);
    s.bus.emit('chat', chat('!sr daft punk'));
    await settle();
    expect(s.sp.state.queue).toEqual([]);
    expect(s.posted).toEqual([]);
  });

  it('queues the best match, posts a chat line and emits music.request', async () => {
    const s = setup();
    await connect(s);
    s.service.updateRequestSettings('default', { enabled: true });
    s.bus.emit('chat', chat('!sr song 4uLU'));
    await until(() => s.requests.length === 1);
    expect(s.sp.state.queue).toEqual([`spotify:track:${ID_A}`]);
    expect(s.requests[0]).toMatchObject({ ok: true, user: 'NightOwl', platform: 'twitch', query: 'song 4uLU', track: { id: ID_A } });
    expect(s.posted[0]).toMatchObject({
      destinationId: 'dest-tw',
      profileId: 'default',
      input: { kind: 'event', text: '🎵 NightOwl added Song 4uLU — Artist', author: { name: 'NightOwl', id: '42' } },
    });
    expect((await s.service.status('default')).recentRequests).toHaveLength(1);
  });

  it('takes Spotify links, and refuses other links', async () => {
    const s = setup();
    await connect(s);
    s.service.updateRequestSettings('default', { enabled: true, cooldownSec: 0 });
    s.bus.emit('chat', chat(`!sr https://open.spotify.com/track/${ID_B}?si=abc`));
    s.bus.emit('chat', chat('!sr https://youtu.be/dQw4w9WgXcQ'));
    await until(() => s.requests.length === 2);
    expect(s.sp.state.queue).toEqual([`spotify:track:${ID_B}`]);
    expect(s.requests[1]).toMatchObject({ ok: false, reason: 'send a song name or a Spotify track link' });
  });

  it('applies who may request and the per-viewer cooldown (not for moderators)', async () => {
    const s = setup();
    await connect(s);
    s.service.updateRequestSettings('default', { enabled: true, who: 'subscribers', cooldownSec: 60 });
    s.bus.emit('chat', chat('!sr anything'));
    s.bus.emit('chat', chat('!sr first', {}, ['subscriber/3']));
    s.bus.emit('chat', chat('!sr second', {}, ['subscriber/3']));
    s.bus.emit('chat', chat('!sr mod one', { author: { name: 'Mod', id: '7', badges: ['moderator/1'] } }));
    s.bus.emit('chat', chat('!sr mod two', { author: { name: 'Mod', id: '7', badges: ['moderator/1'] } }));
    await until(() => s.requests.length === 5);
    expect(s.requests.map((r) => [r.ok, r.reason])).toEqual([
      [false, 'song requests are for subscribers, VIPs and moderators'],
      [true, null],
      [false, expect.stringMatching(/^wait \d+ s before requesting again$/)],
      [true, null],
      [true, null],
    ]);
    expect(s.sp.state.queue).toHaveLength(3);
  });

  it('explains Spotify failures in chat', async () => {
    const s = setup();
    await connect(s);
    s.service.updateRequestSettings('default', { enabled: true });
    s.sp.state.queueError = { status: 404, reason: 'NO_ACTIVE_DEVICE', message: 'No active device found' };
    s.bus.emit('chat', chat('!sr something'));
    await until(() => s.requests.length === 1);
    expect(s.posted[0]!.input.text).toBe('🎵 NightOwl: Spotify is not playing on any device right now');
  });

  it('stays quiet in chat when replies are off, and ignores old chat and event lines', async () => {
    const s = setup();
    await connect(s);
    s.service.updateRequestSettings('default', { enabled: true, chatReplies: false, cooldownSec: 0 });
    s.bus.emit('chat', chat('!sr old', { ts: new Date(Date.now() - 10 * 60_000).toISOString() }));
    s.bus.emit('chat', chat('!sr event', { kind: 'event' }));
    s.bus.emit('chat', chat('!sr new one'));
    await until(() => s.requests.length === 1);
    await settle();
    expect(s.requests).toHaveLength(1);
    expect(s.posted).toEqual([]);
  });

  it('answers !song with what plays (rate limited)', async () => {
    const s = setup();
    s.sp.state.nowPlaying = { is_playing: true, progress_ms: 1000, item: rawTrack(ID_A) };
    await connect(s);
    await until(() => s.music.length === 1);
    s.bus.emit('chat', chat('!song'));
    s.bus.emit('chat', chat('!song'));
    expect(s.posted.map((p) => p.input.text)).toEqual(['🎵 Now playing: Song 4uLU — Artist']);
  });
});
