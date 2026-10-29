// Spotify per profile: what is playing (polled, emitted as 'music' on the bus -> music.nowplaying),
// and chat song requests (!sr <song> adds it to the Spotify queue; !song says what plays). Relay
// never controls playback: no skip, pause or volume.
//
// Storage (append-only, never renamed):
// - settings 'music.spotify.app' = { clientId } — the Spotify developer app, shared by every profile.
// - settings 'music.requests' = { [profileId]: SongRequestSettings }.
// - secrets scope profileSecretScope(profileId, 'spotify'): 'oauth' (tokens), 'pending' (PKCE
//   sign-in in progress), 'account' ({ id, name }).
//
// Polling: every 5 s while the profile is live (or someone read the status in the last minute),
// else every 30 s; Retry-After on 429; stops when the login is gone (status shows "connect again").

import type { Logger } from 'pino';
import type {
  NowPlaying,
  SongRequestResult,
  SongRequestSettings,
  SpotifyConnectStart,
  SpotifyStatus,
} from '../../../shared/api.js';
import { DEFAULT_PROFILE_ID, type ChatMessage } from '../../../shared/types.js';
import type { EventBus } from '../events.js';
import { makeState, type OAuthTokens } from '../platforms/common/oauth.js';
import type { ChatMessageInput } from '../platforms/types.js';
import { profileSecretScope, type AppServices, type ChatHub, type ScopedSecrets, type SecretsRepo, type SettingsRepo } from '../services.js';
import {
  Cooldowns,
  DEFAULT_SONG_REQUESTS,
  isPrivileged,
  mayRequest,
  parseCommand,
  pickTrack,
  refusal,
  requestTarget,
  rolesOf,
  whoLabel,
} from './song-request.js';
import {
  SPOTIFY_REDIRECT_URI,
  SpotifyClient,
  SpotifyError,
  codeFromPaste,
  exchangeCode,
  startLogin,
  trackLabel,
  type FetchLike,
  type PendingLogin,
} from './spotify.js';

export const APP_SETTINGS_KEY = 'music.spotify.app';
export const REQUESTS_SETTINGS_KEY = 'music.requests';
export const FAST_POLL_MS = 5_000;
export const SLOW_POLL_MS = 30_000;
export const ERROR_POLL_MS = 60_000;
/** Reading the status (Settings → Spotify, GET /api/v1/music) keeps polling fast this long. */
export const WATCH_MS = 60_000;
/** A seek (progress off by more than this from what was expected) is sent as a change. */
export const SEEK_TOLERANCE_MS = 3_000;
/** Chat older than this (a backlog delivered on connect) never triggers a command. */
export const COMMAND_MAX_AGE_MS = 2 * 60_000;
export const SONG_REPLY_COOLDOWN_MS = 15_000;
const PENDING_MAX_AGE_MS = 15 * 60_000;
const RECENT_MAX = 20;

const SPOTIFY_NAME_RE = /^[A-Za-z0-9]{10,64}$/;

export interface MusicServiceDeps {
  bus: EventBus;
  log: Logger;
  settings: SettingsRepo;
  secrets: SecretsRepo;
  chat: Pick<ChatHub, 'post'>;
  /** Every profile id (oldest first). */
  profiles(): string[];
  /** Whether a profile's session is starting/live (fast polling). */
  isLive(profileId: string): boolean;
  fetch?: FetchLike;
  apiBase?: string;
  now?: () => number;
  /** Poll intervals (tests). */
  fastPollMs?: number;
  slowPollMs?: number;
}

interface ProfileMusic {
  nowPlaying: NowPlaying | null;
  error: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Bumped to cancel a poll in flight (disconnect, reconnect). */
  generation: number;
  watchedAt: number;
  recent: SongRequestResult[];
  cooldowns: Cooldowns;
  lastSongReply: number;
  /** Requests run one after another per profile. */
  queue: Promise<void>;
}

interface SpotifyAccount {
  id: string;
  name: string;
}

export class MusicService {
  private readonly profilesState = new Map<string, ProfileMusic>();
  private readonly unsubscribers: (() => void)[] = [];
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly deps: MusicServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Listen to chat and start polling every connected profile. */
  start(): void {
    this.unsubscribers.push(
      this.deps.bus.on('chat', (m) => this.onChat(m)),
      this.deps.bus.on('profiles-changed', () => this.onProfilesChanged()),
    );
    for (const id of this.deps.profiles()) void this.resume(id);
  }

  close(): void {
    this.closed = true;
    for (const off of this.unsubscribers.splice(0)) off();
    for (const p of this.profilesState.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.generation++;
    }
  }

  // -------------------------------------------------------------------------
  // Settings and status
  // -------------------------------------------------------------------------

  clientId(): string | null {
    const app = this.deps.settings.get<{ clientId?: unknown }>(APP_SETTINGS_KEY, {});
    return typeof app.clientId === 'string' && app.clientId ? app.clientId : null;
  }

  setClientId(clientId: string | null): void {
    const id = clientId?.trim() || null;
    if (id !== null && !SPOTIFY_NAME_RE.test(id)) throw Object.assign(new Error('That is not a Spotify Client ID (letters and digits).'), { statusCode: 400, code: 'invalid' });
    const previous = this.clientId();
    this.deps.settings.set(APP_SETTINGS_KEY, { clientId: id });
    // A login belongs to the app it was made with: another Client ID needs new logins.
    if (previous !== null && id !== previous) for (const p of this.deps.profiles()) void this.disconnect(p);
  }

  requestSettings(profileId: string): SongRequestSettings {
    const all = this.deps.settings.get<Record<string, Partial<SongRequestSettings>>>(REQUESTS_SETTINGS_KEY, {});
    return { ...DEFAULT_SONG_REQUESTS, ...(all[profileId] ?? {}) };
  }

  updateRequestSettings(profileId: string, patch: Partial<SongRequestSettings>): SongRequestSettings {
    const all = this.deps.settings.get<Record<string, Partial<SongRequestSettings>>>(REQUESTS_SETTINGS_KEY, {});
    const next = { ...this.requestSettings(profileId), ...patch };
    this.deps.settings.set(REQUESTS_SETTINGS_KEY, { ...all, [profileId]: next });
    return next;
  }

  nowPlaying(profileId: string): NowPlaying | null {
    const p = this.state(profileId);
    this.watch(profileId, p);
    return p.nowPlaying;
  }

  async status(profileId: string): Promise<SpotifyStatus> {
    const p = this.state(profileId);
    this.watch(profileId, p);
    const account = await this.secrets(profileId).getJson<SpotifyAccount>('account');
    const tokens = await this.secrets(profileId).getJson<OAuthTokens>('oauth');
    return {
      profileId,
      clientId: this.clientId(),
      redirectUri: SPOTIFY_REDIRECT_URI,
      connected: tokens !== null,
      account: tokens && account ? { id: account.id, name: account.name } : null,
      error: p.error,
      nowPlaying: p.nowPlaying,
      requests: this.requestSettings(profileId),
      recentRequests: [...p.recent],
    };
  }

  // -------------------------------------------------------------------------
  // Sign-in
  // -------------------------------------------------------------------------

  async startConnect(profileId: string): Promise<SpotifyConnectStart> {
    const clientId = this.requireClientId();
    const { url, pending } = startLogin(clientId, makeState(profileId));
    await this.secrets(profileId).setJson('pending', pending);
    return { authorizeUrl: url, redirectUri: SPOTIFY_REDIRECT_URI };
  }

  async completeConnect(profileId: string, pastedUrl: string): Promise<SpotifyAccount> {
    const clientId = this.requireClientId();
    const secrets = this.secrets(profileId);
    const pending = await secrets.getJson<PendingLogin>('pending');
    if (!pending || this.now() - pending.createdAt > PENDING_MAX_AGE_MS) {
      throw userError('That sign-in expired. Click Connect again.');
    }
    const result = codeFromPaste(pastedUrl, pending);
    if ('error' in result) throw userError(result.error);
    let tokens: OAuthTokens;
    try {
      tokens = await exchangeCode(clientId, result.code, pending.verifier, this.deps.fetch);
    } catch (err) {
      throw userError(err instanceof Error ? err.message : String(err));
    }
    await secrets.delete('pending');
    await secrets.setJson('oauth', tokens);
    let account: SpotifyAccount;
    try {
      account = await this.client(profileId, clientId).me();
    } catch (err) {
      await secrets.delete('oauth');
      throw userError(err instanceof Error ? err.message : String(err));
    }
    await secrets.setJson('account', account);
    const p = this.state(profileId);
    p.error = null;
    this.deps.log.info({ profileId, spotifyUser: account.id }, 'spotify: connected');
    await this.resume(profileId);
    return account;
  }

  async disconnect(profileId: string): Promise<void> {
    const p = this.state(profileId);
    p.generation++;
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    const secrets = this.secrets(profileId);
    await secrets.delete('oauth');
    await secrets.delete('account');
    await secrets.delete('pending');
    p.error = null;
    if (p.nowPlaying?.track) this.emit(profileId, { playing: false, track: null, progressMs: null, at: this.now() });
    p.nowPlaying = null;
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  /** Start (or restart) polling a profile if it is connected. */
  private async resume(profileId: string): Promise<void> {
    const p = this.state(profileId);
    p.generation++;
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    if (this.closed || !this.clientId()) return;
    if (!(await this.secrets(profileId).getJson<OAuthTokens>('oauth'))) return;
    void this.poll(profileId, p.generation);
  }

  private async poll(profileId: string, generation: number): Promise<void> {
    const p = this.state(profileId);
    const clientId = this.clientId();
    if (this.closed || generation !== p.generation || !clientId) return;
    p.timer = null; // no timer while this read runs (and none at all once polling stopped)
    let next = this.interval(profileId, p);
    try {
      const np = await this.client(profileId, clientId).nowPlaying();
      if (generation !== p.generation) return;
      p.error = null;
      if (changed(p.nowPlaying, np)) this.emit(profileId, np);
      p.nowPlaying = np;
    } catch (err) {
      if (generation !== p.generation) return;
      const e = err instanceof SpotifyError ? err : null;
      p.error = e ? e.message : `Couldn't reach Spotify (${err instanceof Error ? err.message : String(err)})`;
      if (e?.needsLogin) {
        this.deps.log.warn({ profileId }, 'spotify: the login is gone; polling stops until Spotify is connected again');
        return;
      }
      next = e?.retryAfterMs ?? ERROR_POLL_MS;
      this.deps.log.debug({ profileId, error: p.error }, 'spotify: reading now playing failed');
    }
    if (this.closed || generation !== p.generation) return;
    p.timer = setTimeout(() => void this.poll(profileId, generation), next);
    p.timer.unref?.();
  }

  private interval(profileId: string, p: ProfileMusic): number {
    let live = false;
    try {
      live = this.deps.isLive(profileId);
    } catch {
      /* unknown profile */
    }
    const fast = live || this.now() - p.watchedAt < WATCH_MS;
    return fast ? (this.deps.fastPollMs ?? FAST_POLL_MS) : (this.deps.slowPollMs ?? SLOW_POLL_MS);
  }

  /** Someone looks at it now: poll fast, and right away if the last read is old. */
  private watch(profileId: string, p: ProfileMusic): void {
    const wasIdle = this.now() - p.watchedAt >= WATCH_MS;
    p.watchedAt = this.now();
    if (wasIdle && p.timer && !this.closed) {
      clearTimeout(p.timer);
      p.timer = null;
      void this.poll(profileId, p.generation);
    }
  }

  private emit(profileId: string, nowPlaying: NowPlaying): void {
    try {
      this.deps.bus.emit('music', { profileId, nowPlaying });
    } catch (err) {
      this.deps.log.warn({ error: err instanceof Error ? err.message : String(err) }, 'music listener failed');
    }
  }

  // -------------------------------------------------------------------------
  // Chat commands
  // -------------------------------------------------------------------------

  private onChat(msg: ChatMessage): void {
    if (this.closed || msg.kind !== 'message') return;
    const cmd = parseCommand(msg.text);
    if (!cmd) return;
    const ts = Date.parse(msg.ts);
    if (Number.isFinite(ts) && this.now() - ts > COMMAND_MAX_AGE_MS) return;
    const profileId = msg.profileId ?? DEFAULT_PROFILE_ID;
    const p = this.state(profileId);
    if (cmd.kind === 'song') {
      this.replySong(profileId, p, msg);
      return;
    }
    const settings = this.requestSettings(profileId);
    if (!settings.enabled) return;
    p.queue = p.queue
      .then(() => this.handleRequest(profileId, p, msg, cmd.query, settings))
      .catch((err) => this.deps.log.warn({ profileId, error: err instanceof Error ? err.message : String(err) }, 'spotify: song request failed'));
  }

  private replySong(profileId: string, p: ProfileMusic, msg: ChatMessage): void {
    if (this.now() - p.lastSongReply < SONG_REPLY_COOLDOWN_MS) return;
    const np = p.nowPlaying;
    if (!np) return; // Spotify not connected (or not read yet): stay quiet
    p.lastSongReply = this.now();
    const text = np.track && np.playing ? `🎵 Now playing: ${trackLabel(np.track)}` : '🎵 Nothing is playing on Spotify right now.';
    this.post(profileId, msg, text);
  }

  private async handleRequest(profileId: string, p: ProfileMusic, msg: ChatMessage, query: string, settings: SongRequestSettings): Promise<void> {
    const roles = rolesOf(msg.author.badges);
    const userKey = `${msg.platform}:${msg.author.id ?? msg.author.login ?? msg.author.name.toLowerCase()}`;
    const base = { at: this.now(), user: msg.author.name, platform: msg.platform, query };
    const refuse = (reason: string, track: SongRequestResult['track'] = null) => this.record(profileId, p, msg, settings, { ...base, ok: false, track, reason });

    if (!mayRequest(roles, settings.who)) return refuse(`song requests are for ${whoLabel(settings.who)}`);
    const privileged = isPrivileged(roles);
    const wait = privileged ? 0 : p.cooldowns.remaining(userKey, settings.cooldownSec, this.now());
    if (wait > 0) return refuse(`wait ${Math.ceil(wait / 1000)} s before requesting again`);

    const clientId = this.clientId();
    if (!clientId || !(await this.secrets(profileId).getJson<OAuthTokens>('oauth'))) return refuse('Spotify is not connected');
    const client = this.client(profileId, clientId);
    const target = requestTarget(query);
    try {
      let track;
      if (target.kind === 'bad-link') return refuse('send a song name or a Spotify track link');
      if (target.kind === 'track') {
        track = await client.track(target.id);
        if (!track) return refuse('that Spotify link is not a song');
        const why = refusal(track, settings);
        if (why) return refuse(why, track);
      } else {
        const picked = pickTrack(await client.search(target.query, 5), settings);
        if ('reason' in picked) return refuse(picked.reason);
        track = picked.track;
      }
      await client.addToQueue(track.uri);
      if (!privileged) p.cooldowns.hit(userKey, this.now());
      return this.record(profileId, p, msg, settings, { ...base, ok: true, track, reason: null });
    } catch (err) {
      const reason = err instanceof SpotifyError ? err.message.replace(/\.$/, '') : "couldn't reach Spotify";
      return refuse(lowerFirst(reason));
    }
  }

  private record(profileId: string, p: ProfileMusic, msg: ChatMessage, settings: SongRequestSettings, result: SongRequestResult): void {
    p.recent.unshift(result);
    if (p.recent.length > RECENT_MAX) p.recent.length = RECENT_MAX;
    try {
      this.deps.bus.emit('music-request', { profileId, destinationId: msg.destinationId, result });
    } catch (err) {
      this.deps.log.warn({ error: err instanceof Error ? err.message : String(err) }, 'music-request listener failed');
    }
    if (!settings.chatReplies) return;
    const text = result.ok && result.track
      ? `🎵 ${result.user} added ${trackLabel(result.track)}`
      : `🎵 ${result.user}: ${result.reason ?? 'that request did not work'}`;
    this.post(profileId, msg, text);
  }

  /** An event line in the chat the command came from, attributed to whoever typed it. */
  private post(profileId: string, msg: ChatMessage, text: string): void {
    const input: ChatMessageInput = {
      id: `music-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      author: { name: msg.author.name, ...(msg.author.id ? { id: msg.author.id } : {}), ...(msg.author.login ? { login: msg.author.login } : {}) },
      text,
      kind: 'event',
      ts: new Date(this.now()).toISOString(),
    };
    try {
      this.deps.chat.post(msg.destinationId, msg.platform, input, profileId);
    } catch (err) {
      this.deps.log.warn({ error: err instanceof Error ? err.message : String(err) }, 'spotify: posting the chat reply failed');
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private onProfilesChanged(): void {
    const ids = new Set(this.deps.profiles());
    for (const [id, p] of this.profilesState) {
      if (ids.has(id)) continue;
      p.generation++;
      if (p.timer) clearTimeout(p.timer);
      this.profilesState.delete(id);
    }
  }

  private state(profileId: string): ProfileMusic {
    let p = this.profilesState.get(profileId);
    if (!p) {
      p = { nowPlaying: null, error: null, timer: null, generation: 0, watchedAt: 0, recent: [], cooldowns: new Cooldowns(), lastSongReply: 0, queue: Promise.resolve() };
      this.profilesState.set(profileId, p);
    }
    return p;
  }

  private secrets(profileId: string): ScopedSecrets {
    return this.deps.secrets.scoped(profileSecretScope(profileId, 'spotify'));
  }

  private client(profileId: string, clientId: string): SpotifyClient {
    const secrets = this.secrets(profileId);
    return new SpotifyClient({
      clientId,
      tokens: { load: () => secrets.getJson<OAuthTokens>('oauth'), save: (t) => secrets.setJson('oauth', t) },
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(this.deps.apiBase ? { apiBase: this.deps.apiBase } : {}),
    });
  }

  private requireClientId(): string {
    const id = this.clientId();
    if (!id) throw userError('Add the Client ID of your Spotify developer app first.');
    return id;
  }
}

function userError(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400, code: 'spotify' });
}

/** "Adding to the queue…" -> "adding to the queue…" (after "Name: "); "Spotify …" keeps its capital. */
function lowerFirst(s: string): string {
  return !s || /^Spotify\b/.test(s) ? s : s[0]!.toLowerCase() + s.slice(1);
}

/** Worth an event: another song, play/pause, or a seek. */
export function changed(prev: NowPlaying | null, next: NowPlaying): boolean {
  if (!prev) return true;
  if ((prev.track?.id ?? null) !== (next.track?.id ?? null) || prev.playing !== next.playing) return true;
  if (next.progressMs === null || prev.progressMs === null) return next.progressMs !== prev.progressMs;
  const expected = prev.playing ? prev.progressMs + (next.at - prev.at) : prev.progressMs;
  return Math.abs(next.progressMs - expected) > SEEK_TOLERANCE_MS;
}

const services = new WeakMap<AppServices, MusicService>();

/** The music service of these services (created on first use; main.ts starts it). */
export function musicFor(s: AppServices): MusicService {
  let m = services.get(s);
  if (!m) {
    m = new MusicService({
      bus: s.bus,
      log: s.log.child({ mod: 'music' }),
      settings: s.repos.settings,
      secrets: s.repos.secrets,
      chat: s.chat,
      profiles: () => s.repos.profiles.list().map((p) => p.id),
      isLive: (id) => s.orchestrators.get(id).state().status !== 'offline',
    });
    services.set(s, m);
  }
  return m;
}
