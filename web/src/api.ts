// Typed client for the server API (see shared/api.ts for the contract).
//
// Profile-scoped calls take an optional `profileId` and send it as `?profile=` (the server's
// default profile when omitted); creates carry it in the body (`profileId`).

import type {
  ApiError,
  ApiTokensResponse,
  AppSettings,
  ApprovePairingRequest,
  AuditResponse,
  ChangePasswordRequest,
  ConnectCompleteRequest,
  ConnectOfferResponse,
  ConnectOfferStatus,
  ConnectPoll,
  ConnectStart,
  CreateAccountRequest,
  CreateApiTokenRequest,
  CreateApiTokenResponse,
  CreateConnectOfferRequest,
  CreateDestinationRequest,
  CreateProfileRequest,
  CreateUserRequest,
  IngestInfo,
  LoginRequest,
  MeResponse,
  ObsRelayStatus,
  ObsRelayTestResult,
  OverlayInfo,
  PlatformAppStatus,
  ProfilesResponse,
  RotateIngestKeyRequest,
  SettingsResponse,
  SetupRequest,
  SetupStatusResponse,
  SongRequestSettings,
  SpotifyConnectStart,
  SpotifyStatus,
  TitleResponse,
  TotpSetupResponse,
  UpdateAccountRequest,
  UpdateDestinationRequest,
  UpdateObsRelayRequest,
  UpdateProfileRequest,
  UpdateUserRequest,
  VersionResponse,
} from '@shared/api';
import { CSRF_HEADER } from '@shared/api';
import type {
  Account,
  ChatMessage,
  ConnectedApp,
  Destination,
  Feed,
  PairingRequest,
  PlatformId,
  PlatformInfo,
  Profile,
  SessionState,
  User,
} from '@shared/types';
import { withProfileQuery } from './state/profiles';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Called when any request returns 401 (session expired) — the app shows the login page. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

/** Title updates and connect flows touch every platform, so allow a generous timeout. */
const REQUEST_TIMEOUT_MS = 90_000;

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers[CSRF_HEADER] = csrfToken;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new ApiRequestError(0, 'The server took too long to respond', 'timeout');
    }
    throw new ApiRequestError(0, 'Could not reach the server', 'network');
  }
  if (!res.ok) {
    let err: ApiError = { error: res.statusText || `HTTP ${res.status}` };
    try {
      err = (await res.json()) as ApiError;
    } catch {
      /* non-JSON error */
    }
    if (res.status === 401 && err.code === 'unauthenticated') {
      setCsrfToken(null);
      onUnauthorized?.();
    }
    throw new ApiRequestError(res.status, err.error, err.code);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const get = <T>(url: string) => request<T>('GET', url);
const post = <T>(url: string, body: unknown = {}) => request<T>('POST', url, body);
const put = <T>(url: string, body: unknown) => request<T>('PUT', url, body);
const patch = <T>(url: string, body: unknown) => request<T>('PATCH', url, body);
const del = <T>(url: string) => request<T>('DELETE', url);

async function withCsrf(p: Promise<MeResponse>): Promise<MeResponse> {
  const me = await p;
  setCsrfToken(me.csrfToken);
  return me;
}

export const api = {
  // setup + auth
  setupStatus: () => get<SetupStatusResponse>('/api/setup/status'),
  setup: (body: SetupRequest) => withCsrf(post<MeResponse>('/api/setup', body)),
  login: (body: LoginRequest) => withCsrf(post<MeResponse>('/api/auth/login', body)),
  me: () => withCsrf(get<MeResponse>('/api/auth/me')),
  logout: async () => {
    await post<object>('/api/auth/logout');
    setCsrfToken(null);
  },
  changePassword: (body: ChangePasswordRequest) => post<object>('/api/auth/password', body),
  totpSetup: () => post<TotpSetupResponse>('/api/auth/totp/setup'),
  totpEnable: (code: string) => post<object>('/api/auth/totp/enable', { code }),
  totpDisable: (password: string) => post<object>('/api/auth/totp/disable', { password }),

  // users
  users: () => get<User[]>('/api/users'),
  createUser: (body: CreateUserRequest) => post<User>('/api/users', body),
  updateUser: (id: string, body: UpdateUserRequest) => patch<User>(`/api/users/${encodeURIComponent(id)}`, body),
  deleteUser: (id: string) => del<object>(`/api/users/${encodeURIComponent(id)}`),

  // platforms + developer apps
  platforms: () => get<PlatformInfo[]>('/api/platforms'),
  platformApps: () => get<PlatformAppStatus[]>('/api/platform-apps'),
  putPlatformApp: (platform: PlatformId, values: Record<string, string>) =>
    put<PlatformAppStatus>(`/api/platform-apps/${platform}`, { values }),

  // profiles
  profiles: () => get<ProfilesResponse>('/api/profiles'),
  createProfile: (body: CreateProfileRequest) => post<Profile>('/api/profiles', body),
  updateProfile: (id: string, body: UpdateProfileRequest) => patch<Profile>(`/api/profiles/${encodeURIComponent(id)}`, body),
  /** 400 'default_profile' for the default profile, 409 'session_live' while its session runs. */
  deleteProfile: (id: string) => del<object>(`/api/profiles/${encodeURIComponent(id)}`),

  // accounts (list per profile; create carries body.profileId)
  accounts: (profileId?: string) => get<Account[]>(withProfileQuery('/api/accounts', profileId)),
  createAccount: (body: CreateAccountRequest) => post<Account>('/api/accounts', body),
  updateAccount: (id: string, body: UpdateAccountRequest) => patch<Account>(`/api/accounts/${encodeURIComponent(id)}`, body),
  deleteAccount: (id: string) => del<object>(`/api/accounts/${encodeURIComponent(id)}`),
  connectAccount: (id: string) => post<ConnectStart>(`/api/accounts/${encodeURIComponent(id)}/connect`),
  pollConnect: (id: string) => post<ConnectPoll>(`/api/accounts/${encodeURIComponent(id)}/connect/poll`),
  completeConnect: (id: string, body: ConnectCompleteRequest) =>
    post<ConnectPoll>(`/api/accounts/${encodeURIComponent(id)}/connect/complete`, body),
  checkAccount: (id: string) => post<Account>(`/api/accounts/${encodeURIComponent(id)}/check`),

  // destinations (list per profile; create carries body.profileId)
  destinations: (profileId?: string) => get<Destination[]>(withProfileQuery('/api/destinations', profileId)),
  createDestination: (body: CreateDestinationRequest) => post<Destination>('/api/destinations', body),
  updateDestination: (id: string, body: UpdateDestinationRequest) =>
    patch<Destination>(`/api/destinations/${encodeURIComponent(id)}`, body),
  deleteDestination: (id: string) => del<object>(`/api/destinations/${encodeURIComponent(id)}`),
  setDestinationEnabled: (id: string, enabled: boolean) =>
    put<Destination>(`/api/destinations/${encodeURIComponent(id)}/enabled`, { enabled }),
  retryDestination: (id: string) => post<object>(`/api/destinations/${encodeURIComponent(id)}/retry`),

  // session (per profile)
  session: (profileId?: string) => get<SessionState>(withProfileQuery('/api/session', profileId)),
  startSession: (profileId?: string) => post<SessionState>(withProfileQuery('/api/session/start', profileId)),
  stopSession: (profileId?: string) => post<SessionState>(withProfileQuery('/api/session/stop', profileId)),
  setTitle: (title: string, profileId?: string) => put<TitleResponse>(withProfileQuery('/api/session/title', profileId), { title }),
  setAutoGoLive: (autoGoLive: boolean, profileId?: string) =>
    put<SessionState>(withProfileQuery('/api/session/auto', profileId), { autoGoLive }),
  /** 409 code 'session_live' while a session runs (test mode only changes while offline). */
  setTestMode: (testMode: boolean, profileId?: string) =>
    put<SessionState>(withProfileQuery('/api/session/test-mode', profileId), { testMode }),

  // ingest (per profile: each profile has its own OBS stream keys)
  ingest: (profileId?: string) => get<IngestInfo>(withProfileQuery('/api/ingest', profileId)),
  rotateIngestKey: (feed: Feed, profileId?: string) => {
    // The profile goes in the query (shared convention) and the body (accepted by the route).
    const body: RotateIngestKeyRequest & { profileId?: string } = profileId ? { feed, profileId } : { feed };
    return post<IngestInfo>(withProfileQuery('/api/ingest/rotate', profileId), body);
  },

  // chat (per profile)
  recentChat: (limit = 200, profileId?: string) => get<ChatMessage[]>(withProfileQuery(`/api/chat/recent?limit=${limit}`, profileId)),
  overlay: (profileId?: string) => get<OverlayInfo>(withProfileQuery('/api/chat/overlay', profileId)),
  rotateOverlay: (profileId?: string) => post<OverlayInfo>(withProfileQuery('/api/chat/overlay/rotate', profileId)),

  // settings + audit
  settings: () => get<SettingsResponse>('/api/settings'),
  version: () => get<VersionResponse>('/api/version'),
  putSettings: (body: Partial<AppSettings>) => put<SettingsResponse>('/api/settings', body),
  audit: (limit = 100, before?: number) =>
    get<AuditResponse>(`/api/audit?limit=${limit}${before !== undefined ? `&before=${before}` : ''}`),

  // external API tokens (Settings → API)
  apiTokens: () => get<ApiTokensResponse>('/api/tokens'),
  /** The response carries the secret: show it once, never store or log it. */
  createApiToken: (body: CreateApiTokenRequest) => post<CreateApiTokenResponse>('/api/tokens', body),
  /** Also removes the apps that token registered. */
  deleteApiToken: (id: string) => del<object>(`/api/tokens/${encodeURIComponent(id)}`),
  createConnectOffer: (body: CreateConnectOfferRequest) => post<ConnectOfferResponse>('/api/connect-offers', body),
  connectOfferStatus: (id: string) => get<ConnectOfferStatus>(`/api/connect-offers/${encodeURIComponent(id)}`),
  cancelConnectOffer: (id: string) => del<object>(`/api/connect-offers/${encodeURIComponent(id)}`),
  obsRelay: () => get<ObsRelayStatus>('/api/obs-relay'),
  updateObsRelay: (body: UpdateObsRelayRequest) => put<ObsRelayStatus>('/api/obs-relay', body),
  testObsRelay: () => post<ObsRelayTestResult>('/api/obs-relay/test', {}),

  // Spotify: now playing + chat song requests (per profile; the developer app is shared)
  music: (profileId?: string) => get<SpotifyStatus>(withProfileQuery('/api/music', profileId)),
  setSpotifyApp: (clientId: string, profileId?: string) => put<SpotifyStatus>(withProfileQuery('/api/music/app', profileId), { clientId }),
  startSpotifyConnect: (profileId?: string) => post<SpotifyConnectStart>(withProfileQuery('/api/music/connect/start', profileId)),
  completeSpotifyConnect: (pastedUrl: string, profileId?: string) =>
    post<SpotifyStatus>(withProfileQuery('/api/music/connect/complete', profileId), { pastedUrl }),
  disconnectSpotify: (profileId?: string) => del<SpotifyStatus>(withProfileQuery('/api/music/connection', profileId)),
  updateSongRequests: (patch: Partial<SongRequestSettings>, profileId?: string) =>
    put<SpotifyStatus>(withProfileQuery('/api/music/requests', profileId), patch),

  // app pairing + connected apps (Settings → API)
  /** Pending "connect this app" requests, newest first. */
  pairings: () => get<PairingRequest[]>('/api/pairings'),
  /** Creates the app's token; the app picks it up itself (the secret is not in the response for the UI to show). */
  approvePairing: (id: string, body: ApprovePairingRequest) =>
    post<CreateApiTokenResponse>(`/api/pairings/${encodeURIComponent(id)}/approve`, body),
  denyPairing: (id: string) => post<object>(`/api/pairings/${encodeURIComponent(id)}/deny`),
  apps: () => get<ConnectedApp[]>('/api/apps'),
  removeApp: (id: string) => del<object>(`/api/apps/${encodeURIComponent(id)}`),

  // browser login viewer
  browserOpen: (accountId: string, url?: string) =>
    post<object>(`/api/browser/${encodeURIComponent(accountId)}/open`, url ? { url } : {}),
  browserClose: (accountId: string, save: boolean) =>
    post<object>(`/api/browser/${encodeURIComponent(accountId)}/close`, { save }),
};

/** Build a ws:// or wss:// URL for a same-origin path. */
export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}
