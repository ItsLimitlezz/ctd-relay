// In-memory Spotify Web API + storage fakes for the music tests.

import type { ScopedSecrets, SecretsRepo, SettingsRepo } from '../services.js';
import type { FetchLike } from './spotify.js';

export function memorySettings(): SettingsRepo & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string, fallback: T) => (data.has(key) ? (structuredClone(data.get(key)) as T) : fallback),
    set: (key, value) => void data.set(key, structuredClone(value)),
    delete: (key) => void data.delete(key),
  };
}

export function memorySecrets(): SecretsRepo & { scopes: Map<string, Map<string, string>> } {
  const scopes = new Map<string, Map<string, string>>();
  const scoped = (scope: string): ScopedSecrets => {
    const m = () => {
      let s = scopes.get(scope);
      if (!s) scopes.set(scope, (s = new Map()));
      return s;
    };
    return {
      get: async (k) => m().get(k) ?? null,
      set: async (k, v) => void m().set(k, v),
      delete: async (k) => void m().delete(k),
      getJson: async <T>(k: string) => {
        const v = m().get(k);
        return v === undefined ? null : (JSON.parse(v) as T);
      },
      setJson: async (k, v) => void m().set(k, JSON.stringify(v)),
    };
  };
  return { scopes, scoped, deleteScope: (s) => void scopes.delete(s) };
}

export function rawTrack(id: string, over: Record<string, unknown> = {}) {
  return {
    type: 'track',
    id,
    uri: `spotify:track:${id}`,
    name: `Song ${id.slice(0, 4)}`,
    duration_ms: 200_000,
    explicit: false,
    artists: [{ name: 'Artist' }],
    album: { name: 'Album', images: [{ url: 'https://i.scdn.co/640', width: 640 }, { url: 'https://i.scdn.co/300', width: 300 }] },
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    ...over,
  };
}

/** 22-character Spotify ids. */
export const ID_A = '4uLU6hMCjMI75M1A2tKUQC';
export const ID_B = '7ouMYWpwJ422jRcDASZB7P';

type Handler = (req: { method: string; url: URL; headers: Record<string, string>; body: string }) => { status: number; json?: unknown; headers?: Record<string, string> };

/** A fake of accounts.spotify.com + api.spotify.com: every request is recorded; `routes` answer them. */
export function fakeSpotify(routes: Record<string, Handler> = {}) {
  const calls: { method: string; path: string; query: URLSearchParams; auth: string | undefined; body: string }[] = [];
  const state = {
    accessToken: 'at-1',
    nowPlaying: null as unknown,
    queue: [] as string[],
    searchResults: [rawTrack(ID_A)] as unknown[],
    tracks: new Map<string, unknown>([[ID_A, rawTrack(ID_A)], [ID_B, rawTrack(ID_B)]]),
    queueError: null as { status: number; reason: string; message: string } | null,
    /** The user removed access: refreshing fails with invalid_grant. */
    refreshRevoked: false,
  };
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init.body === 'string' ? init.body : '';
    const method = init.method ?? 'GET';
    calls.push({ method, path: url.pathname, query: url.searchParams, auth: headers.authorization, body });
    const key = `${method} ${url.pathname}`;
    const custom = routes[key];
    const reply = (status: number, json?: unknown, extra: Record<string, string> = {}) =>
      new Response(json === undefined ? null : JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...extra } });
    if (custom) {
      const r = custom({ method, url, headers, body });
      return reply(r.status, r.json, r.headers);
    }
    if (url.pathname === '/api/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'good-code' || !form.get('code_verifier')) return reply(400, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
        return reply(200, { access_token: state.accessToken, refresh_token: 'rt-1', expires_in: 3600, scope: 'user-read-currently-playing' });
      }
      if (state.refreshRevoked) return reply(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' });
      state.accessToken = `at-${Number(state.accessToken.slice(3)) + 1}`;
      return reply(200, { access_token: state.accessToken, expires_in: 3600 });
    }
    if (headers.authorization !== `Bearer ${state.accessToken}`) return reply(401, { error: { status: 401, message: 'The access token expired' } });
    switch (key) {
      case 'GET /v1/me':
        return reply(200, { id: 'djfan', display_name: 'DJ Fan' });
      case 'GET /v1/me/player/currently-playing':
        return state.nowPlaying ? reply(200, state.nowPlaying) : new Response(null, { status: 204 });
      case 'GET /v1/search':
        return reply(200, { tracks: { items: state.searchResults } });
      case 'POST /v1/me/player/queue': {
        if (state.queueError) return reply(state.queueError.status, { error: { status: state.queueError.status, message: state.queueError.message, reason: state.queueError.reason } });
        state.queue.push(url.searchParams.get('uri') ?? '');
        return new Response(null, { status: 204 });
      }
    }
    const track = /^\/v1\/tracks\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && track) {
      const t = state.tracks.get(track[1]!);
      return t ? reply(200, t) : reply(404, { error: { status: 404, message: 'Non existing id' } });
    }
    return reply(404, { error: { status: 404, message: `no route ${key}` } });
  };
  return { fetch: fetchImpl, calls, state };
}
