// Spotify Web API client: sign-in (authorization code + PKCE, public client: no secret), now
// playing, track lookup/search and adding to the queue. Nothing else: Relay never controls playback.
// Docs: https://developer.spotify.com/documentation/web-api
// - Authorize: https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
//   accounts.spotify.com/authorize + POST accounts.spotify.com/api/token (client_id, code_verifier).
//   Redirect URIs must be https or a loopback IP literal (localhost is refused); Relay uses
//   http://127.0.0.1:8888/callback and the user pastes the address that page lands on.
// - GET /v1/me/player/currently-playing: 204 = nothing playing; `item` is null for ads/podcasts
//   without additional_types=episode.
// - GET /v1/search?type=track: limit at most 10 since February 2026.
// - POST /v1/me/player/queue?uri=: Premium only; 404 NO_ACTIVE_DEVICE when no Spotify app is playing.
// - 429 carries Retry-After (seconds).

import type { MusicTrack, NowPlaying } from '../../../shared/api.js';
import { createPkce, parseCallbackUrl, parseTokenResponse, type OAuthTokens } from '../platforms/common/oauth.js';

export const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_API = 'https://api.spotify.com/v1';
export const SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:8888/callback';
/** Read what plays + add to the queue (POST /me/player/queue needs user-modify-playback-state). */
export const SPOTIFY_SCOPES = ['user-read-currently-playing', 'user-read-playback-state', 'user-modify-playback-state'] as const;

const TIMEOUT_MS = 10_000;
const REFRESH_MARGIN_MS = 60_000;

/** A Spotify failure, with what the user should read. */
export class SpotifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Spotify's `reason` (NO_ACTIVE_DEVICE, PREMIUM_REQUIRED...) when it gave one. */
    readonly reason: string | null = null,
    /** From Retry-After on a 429. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'SpotifyError';
  }
  /** The login is gone (revoked, or the refresh token no longer works): reconnect. */
  get needsLogin(): boolean {
    return this.status === 401 || this.reason === 'invalid_grant';
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Where a profile's Spotify login is kept (encrypted). */
export interface TokenStore {
  load(): Promise<OAuthTokens | null>;
  save(tokens: OAuthTokens): Promise<void>;
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

export interface PendingLogin {
  verifier: string;
  state: string;
  createdAt: number;
}

export function authorizeUrl(clientId: string, state: string, challenge: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SPOTIFY_SCOPES.join(' '),
    redirect_uri: SPOTIFY_REDIRECT_URI,
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  return `${SPOTIFY_AUTHORIZE_URL}?${params.toString()}`;
}

export function startLogin(clientId: string, state: string): { url: string; pending: PendingLogin } {
  const pkce = createPkce();
  return { url: authorizeUrl(clientId, state, pkce.challenge), pending: { verifier: pkce.verifier, state, createdAt: Date.now() } };
}

/** The code from the pasted redirect address, or a message saying what is wrong with it. */
export function codeFromPaste(pasted: string, pending: PendingLogin): { code: string } | { error: string } {
  const cb = parseCallbackUrl(pasted);
  if (cb.error) return { error: cb.error === 'access_denied' ? 'Access was denied on Spotify. Click Connect to try again.' : `Spotify said: ${cb.errorDescription ?? cb.error}` };
  if (!cb.code) return { error: 'That address has no code. Paste the whole address of the page Spotify sent you to (it starts with http://127.0.0.1:8888/callback?code=).' };
  if (cb.state !== pending.state) return { error: 'That address belongs to an older sign-in. Click Connect again and paste the new address.' };
  return { code: cb.code };
}

async function tokenRequest(form: Record<string, string>, fetchImpl: FetchLike): Promise<Record<string, unknown>> {
  const res = await fetchImpl(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const code = typeof json.error === 'string' ? json.error : null;
    const desc = typeof json.error_description === 'string' ? json.error_description : null;
    if (code === 'invalid_client') throw new SpotifyError('Spotify rejected the Client ID. Check it in Settings → Spotify.', res.status, code);
    throw new SpotifyError(`Spotify sign-in failed${desc ? `: ${desc}` : ` (HTTP ${res.status})`}`, res.status, code);
  }
  return json;
}

export async function exchangeCode(clientId: string, code: string, verifier: string, fetchImpl: FetchLike = fetch): Promise<OAuthTokens> {
  const json = await tokenRequest(
    { grant_type: 'authorization_code', code, redirect_uri: SPOTIFY_REDIRECT_URI, client_id: clientId, code_verifier: verifier },
    fetchImpl,
  );
  return parseTokenResponse(json);
}

export async function refreshLogin(clientId: string, previous: OAuthTokens, fetchImpl: FetchLike = fetch): Promise<OAuthTokens> {
  if (!previous.refreshToken) throw new SpotifyError('The Spotify login expired. Connect Spotify again.', 401, 'invalid_grant');
  const json = await tokenRequest({ grant_type: 'refresh_token', refresh_token: previous.refreshToken, client_id: clientId }, fetchImpl);
  return parseTokenResponse(json, previous);
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

const TRACK_ID_RE = /^[A-Za-z0-9]{22}$/;

/** A track id from a Spotify link or URI (open.spotify.com/track/<id>, spotify:track:<id>), else null. */
export function trackIdFrom(text: string): string | null {
  const s = text.trim();
  const uri = /^spotify:track:([A-Za-z0-9]{22})$/.exec(s);
  if (uri) return uri[1]!;
  try {
    const url = new URL(s);
    if (!/(^|\.)spotify\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const i = parts.indexOf('track');
    const id = i >= 0 ? parts[i + 1] : undefined;
    return id && TRACK_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** A link that is not a Spotify track (YouTube, an album...): song requests take only tracks. */
export function looksLikeLink(text: string): boolean {
  return /^(https?:\/\/|spotify:)/i.test(text.trim());
}

interface RawTrack {
  type?: string;
  id?: string;
  uri?: string;
  name?: string;
  duration_ms?: number;
  explicit?: boolean;
  artists?: { name?: string }[];
  album?: { name?: string; images?: { url?: string; width?: number | null }[] };
  external_urls?: { spotify?: string };
}

/** Album art closest to 300 px wide (Spotify lists 640, 300, 64). */
function artOf(images: { url?: string; width?: number | null }[] | undefined): string | null {
  const list = (images ?? []).filter((i): i is { url: string; width?: number | null } => typeof i?.url === 'string');
  if (list.length === 0) return null;
  const score = (w: number | null | undefined) => Math.abs((w ?? 300) - 300);
  return [...list].sort((a, b) => score(a.width) - score(b.width))[0]!.url;
}

export function toTrack(raw: unknown): MusicTrack | null {
  const t = raw as RawTrack | null;
  if (!t || (t.type !== undefined && t.type !== 'track') || typeof t.id !== 'string' || typeof t.name !== 'string') return null;
  return {
    id: t.id,
    uri: typeof t.uri === 'string' ? t.uri : `spotify:track:${t.id}`,
    title: t.name,
    artists: (t.artists ?? []).map((a) => a?.name).filter((n): n is string => typeof n === 'string' && n.length > 0),
    album: typeof t.album?.name === 'string' ? t.album.name : null,
    artUrl: artOf(t.album?.images),
    durationMs: typeof t.duration_ms === 'number' && t.duration_ms > 0 ? Math.round(t.duration_ms) : 0,
    explicit: t.explicit === true,
    url: t.external_urls?.spotify ?? `https://open.spotify.com/track/${t.id}`,
  };
}

/** "Title — Artist, Artist" */
export function trackLabel(t: Pick<MusicTrack, 'title' | 'artists'>): string {
  return t.artists.length > 0 ? `${t.title} — ${t.artists.join(', ')}` : t.title;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface SpotifyClientOptions {
  clientId: string;
  tokens: TokenStore;
  fetch?: FetchLike;
  /** Override https://api.spotify.com/v1 (tests). */
  apiBase?: string;
}

export class SpotifyClient {
  private readonly fetchImpl: FetchLike;
  private readonly apiBase: string;
  private refreshing: Promise<OAuthTokens> | null = null;

  constructor(private readonly opts: SpotifyClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.apiBase = opts.apiBase ?? SPOTIFY_API;
  }

  private async token(force = false): Promise<string> {
    const current = await this.opts.tokens.load();
    if (!current) throw new SpotifyError('Spotify is not connected.', 401, 'not_connected');
    if (!force && (current.expiresAt === null || current.expiresAt - Date.now() > REFRESH_MARGIN_MS)) return current.accessToken;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const fresh = await refreshLogin(this.opts.clientId, current, this.fetchImpl);
          await this.opts.tokens.save(fresh);
          return fresh;
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return (await this.refreshing).accessToken;
  }

  /** One API call; refreshes the login once on 401. Returns null for 204 / an empty body. */
  private async call<T>(method: 'GET' | 'POST', path: string, signal?: AbortSignal): Promise<T | null> {
    let retried = false;
    for (;;) {
      const access = await this.token(retried);
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const res = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: { authorization: `Bearer ${access}`, accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (res.status === 401 && !retried) {
        retried = true;
        continue;
      }
      const text = await res.text();
      if (res.ok) {
        if (!text) return null;
        try {
          return JSON.parse(text) as T;
        } catch {
          return null; // queue answers 200 with a non-JSON body
        }
      }
      throw apiError(res, text);
    }
  }

  async me(signal?: AbortSignal): Promise<{ id: string; name: string }> {
    const json = await this.call<{ id?: string; display_name?: string | null }>('GET', '/me', signal);
    if (!json?.id) throw new SpotifyError('Spotify returned no account.', 502);
    return { id: json.id, name: json.display_name?.trim() || json.id };
  }

  async nowPlaying(signal?: AbortSignal): Promise<NowPlaying> {
    const json = await this.call<{ is_playing?: boolean; progress_ms?: number | null; item?: unknown }>(
      'GET',
      '/me/player/currently-playing',
      signal,
    );
    const at = Date.now();
    if (!json) return { playing: false, track: null, progressMs: null, at };
    const track = toTrack(json.item);
    return {
      playing: json.is_playing === true && track !== null,
      track,
      progressMs: track && typeof json.progress_ms === 'number' ? Math.max(0, Math.round(json.progress_ms)) : null,
      at,
    };
  }

  async track(id: string, signal?: AbortSignal): Promise<MusicTrack | null> {
    if (!TRACK_ID_RE.test(id)) return null;
    try {
      return toTrack(await this.call('GET', `/tracks/${id}`, signal));
    } catch (err) {
      if (err instanceof SpotifyError && (err.status === 404 || err.status === 400)) return null;
      throw err;
    }
  }

  /** Best matches for `query` (at most 10: Spotify's limit). */
  async search(query: string, limit = 5, signal?: AbortSignal): Promise<MusicTrack[]> {
    const q = new URLSearchParams({ q: query, type: 'track', limit: String(Math.min(10, Math.max(1, limit))) });
    const json = await this.call<{ tracks?: { items?: unknown[] } }>('GET', `/search?${q.toString()}`, signal);
    return (json?.tracks?.items ?? []).map(toTrack).filter((t): t is MusicTrack => t !== null);
  }

  async addToQueue(uri: string, signal?: AbortSignal): Promise<void> {
    await this.call('POST', `/me/player/queue?${new URLSearchParams({ uri }).toString()}`, signal);
  }
}

function apiError(res: Response, text: string): SpotifyError {
  let message = '';
  let reason: string | null = null;
  try {
    const j = JSON.parse(text) as { error?: { message?: string; reason?: string } | string };
    if (typeof j.error === 'object' && j.error) {
      message = j.error.message ?? '';
      reason = j.error.reason ?? null;
    }
  } catch {
    /* not JSON */
  }
  const retry = Number(res.headers.get('retry-after'));
  const retryAfterMs = res.status === 429 && Number.isFinite(retry) && retry > 0 ? Math.min(retry, 3600) * 1000 : null;
  if (res.status === 401) return new SpotifyError('The Spotify login expired. Connect Spotify again.', 401, reason);
  if (res.status === 429) return new SpotifyError('Spotify is rate limiting Relay for a moment.', 429, reason, retryAfterMs);
  if (reason === 'NO_ACTIVE_DEVICE' || (res.status === 404 && /device/i.test(message))) {
    return new SpotifyError('Spotify is not playing on any device right now.', res.status, 'NO_ACTIVE_DEVICE');
  }
  if (reason === 'PREMIUM_REQUIRED') return new SpotifyError('Adding to the queue needs Spotify Premium.', res.status, reason);
  if (res.status === 403) {
    return new SpotifyError(
      `Spotify refused${message ? `: ${message}` : ''}. In Development Mode the account must be added under User Management in the Spotify app, and the app owner needs Premium.`,
      403,
      reason,
    );
  }
  return new SpotifyError(`Spotify error${message ? `: ${message}` : ` (HTTP ${res.status})`}`, res.status, reason);
}
