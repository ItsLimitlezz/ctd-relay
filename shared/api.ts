// HTTP + WebSocket API contract between the server and the web UI.
//
// Conventions:
// - All JSON. Errors: non-2xx with body ApiError.
// - Auth: session cookie `ctd_session` (HttpOnly). Every non-GET /api request must send
//   header `x-csrf-token` with the token returned by /api/auth/me or /api/auth/login.
// - Role legend in comments: [public] no auth, [user] any logged-in user, [admin] admin only.

import type {
  Account,
  ApiScope,
  ApiTokenInfo,
  AuditEntry,
  ConnectedApp,
  PairingRequest,
  ChatMessage,
  ChatModeration,
  ConnectMethod,
  Destination,
  DestinationState,
  Feed,
  FeedState,
  FieldSpec,
  PlatformId,
  Profile,
  ProfileSummary,
  PlatformInfo,
  Role,
  SessionState,
  TitleResult,
  TlsStatus,
  User,
} from './types.js';

export interface ApiError {
  error: string; // human-readable message
  code?: string; // machine-readable, e.g. 'totp_required', 'locked', 'csrf'
}

export const CSRF_HEADER = 'x-csrf-token';
export const SESSION_COOKIE = 'ctd_session';

// ---------------------------------------------------------------------------
// Setup + auth
// ---------------------------------------------------------------------------

/** GET /api/setup/status [public] */
export interface SetupStatusResponse {
  needsSetup: boolean;
}

/** POST /api/setup [public] — only works while no users exist. Logs the new admin in. */
export interface SetupRequest {
  setupCode: string;
  username: string;
  password: string;
}

/** POST /api/auth/login [public] -> MeResponse. 401 with code 'totp_required' when a TOTP code is needed. */
export interface LoginRequest {
  username: string;
  password: string;
  totp?: string;
}

/** GET /api/auth/me [user] ; also the response of login + setup */
export interface MeResponse {
  user: User;
  csrfToken: string;
}

/** POST /api/auth/logout [user] -> {} */

/** POST /api/auth/password [user] -> {} */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/** POST /api/auth/totp/setup [user] -> TotpSetupResponse (secret not active until enabled) */
export interface TotpSetupResponse {
  secret: string;
  otpauthUrl: string;
  qrSvg: string;
}
/** POST /api/auth/totp/enable [user] -> {} */
export interface TotpEnableRequest {
  code: string;
}
/** POST /api/auth/totp/disable [user] -> {} */
export interface TotpDisableRequest {
  password: string;
}

// ---------------------------------------------------------------------------
// Users [admin]
// ---------------------------------------------------------------------------

/** GET /api/users -> User[] */
/** POST /api/users -> User */
export interface CreateUserRequest {
  username: string;
  password: string;
  role: Role;
}
/** PATCH /api/users/:id -> User */
export interface UpdateUserRequest {
  role?: Role;
  password?: string;
  /** Turn off the user's 2FA (lost authenticator). */
  resetTotp?: boolean;
}
/** DELETE /api/users/:id -> {} (cannot delete yourself or the last admin) */

// ---------------------------------------------------------------------------
// Profiles
//
// Profile scoping convention: every per-profile route takes `?profile=<id>` (default: the default
// profile, so pre-profiles clients keep working): GET/POST /api/session*, PUT /api/session/*,
// GET /api/destinations, GET /api/accounts, GET /api/ingest (+ POST /api/ingest/rotate),
// GET /api/chat/recent, GET /api/chat/overlay (+ rotate), WS /api/ws.
// Creates carry the profile in the body (`profileId`, default: default profile). Routes on one
// destination/account (`/:id`) need no profile: ids are global.
// Shared by every profile: developer apps (/api/platform-apps), users, settings, TLS, API tokens,
// audit.
// ---------------------------------------------------------------------------

/** GET /api/profiles [user] -> ProfilesResponse (every profile + its live situation) */
export interface ProfilesResponse {
  profiles: ProfileSummary[];
}
/** POST /api/profiles [admin] -> Profile. The slug is derived from the name (made unique). */
export interface CreateProfileRequest {
  name: string;
  color?: string | null;
}
/** PATCH /api/profiles/:id [admin] -> Profile. The slug never changes (OBS keys keep working). */
export interface UpdateProfileRequest {
  name?: string;
  color?: string | null;
}
/**
 * DELETE /api/profiles/:id [admin] -> {}. Refused for the default profile (400 'default_profile')
 * and while that profile's session is not offline (409 'session_live'). Deletes the profile's
 * destinations and accounts with their keys, tokens and browser sessions, and its OBS keys.
 */

export type { Profile, ProfileSummary };

// ---------------------------------------------------------------------------
// Platforms + developer apps
// ---------------------------------------------------------------------------

/** GET /api/platforms [user] -> PlatformInfo[] */
export type PlatformsResponse = PlatformInfo[];

/** GET /api/platform-apps [admin] -> PlatformAppStatus[] (one per platform that needs a developer app) */
export interface PlatformAppStatus {
  platform: PlatformId;
  configured: boolean;
  /** Non-secret values (e.g. clientId). Secret fields are reported only as set/unset. */
  values: Record<string, string>;
  secretsSet: Record<string, boolean>;
  /** Redirect URI to paste into the developer console, when the platform needs one. */
  redirectUri: string | null;
}
/** PUT /api/platform-apps/:platform [admin] -> PlatformAppStatus. Empty-string secret = keep existing. */
export interface PutPlatformAppRequest {
  values: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Accounts [admin]
// ---------------------------------------------------------------------------

/** GET /api/accounts -> Account[] */
/** POST /api/accounts -> Account (status 'pending') */
export interface CreateAccountRequest {
  /** Owning profile (default: the default profile). */
  profileId?: string;
  platform: PlatformId;
  label?: string;
  options?: Record<string, unknown>;
}
/** PATCH /api/accounts/:id -> Account */
export interface UpdateAccountRequest {
  label?: string;
  options?: Record<string, unknown>;
}
/** DELETE /api/accounts/:id -> {} (also deletes tokens + browser session; destinations get accountId null) */

/** POST /api/accounts/:id/connect -> ConnectStart */
export type ConnectStart =
  | {
      method: 'device-code';
      userCode: string;
      verificationUri: string;
      verificationUriComplete?: string;
      expiresIn: number; // seconds
      interval: number; // seconds between polls
    }
  | {
      method: 'oauth-paste';
      authorizeUrl: string;
      redirectUri: string;
      instructions: string;
    }
  | {
      method: 'token-paste';
      fields: FieldSpec[];
      instructions: string;
    }
  | {
      method: 'browser';
      startUrl: string;
      instructions: string;
    }
  | { method: 'none' };

/** POST /api/accounts/:id/connect/poll -> ConnectPoll (device-code: call every `interval` seconds) */
export type ConnectPoll =
  | { status: 'pending'; message?: string }
  | { status: 'connected'; account: Account }
  | { status: 'expired' }
  | { status: 'error'; message: string };

/** POST /api/accounts/:id/connect/complete -> ConnectPoll (oauth-paste / token-paste / browser "I'm done") */
export interface ConnectCompleteRequest {
  pastedUrl?: string;
  fields?: Record<string, string>;
}

/** POST /api/accounts/:id/check -> Account (re-validate tokens / browser session) */

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

/** GET /api/destinations [user] -> Destination[] */
/** POST /api/destinations [admin] -> Destination */
export interface CreateDestinationRequest {
  /** Owning profile (default: the default profile). The account must belong to the same profile. */
  profileId?: string;
  platform: PlatformId;
  accountId?: string | null;
  name: string;
  feed: Feed;
  enabled?: boolean;
  options?: Record<string, unknown>;
  ingestUrl?: string | null;
  streamKey?: string | null;
}
/** PATCH /api/destinations/:id [admin] -> Destination. streamKey: undefined = keep, '' or null = clear. */
export type UpdateDestinationRequest = Partial<Omit<CreateDestinationRequest, 'platform'>>;
/** DELETE /api/destinations/:id [admin] -> {} */
/** POST /api/destinations/:id/retry [user] -> {} (restart a failed destination during a session) */
/** PUT /api/destinations/:id/enabled [user] body { enabled: boolean } -> Destination (works mid-session) */
export interface SetEnabledRequest {
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Session (go live, title)
// ---------------------------------------------------------------------------

/** GET /api/session [user] -> SessionState */
/** POST /api/session/start [user] -> SessionState */
/** POST /api/session/stop [user] -> SessionState */
/** PUT /api/session/title [user] -> TitleResponse */
export interface SetTitleRequest {
  title: string;
}
export interface TitleResponse {
  title: string;
  results: TitleResult[];
}
/** PUT /api/session/auto [user] -> SessionState */
export interface SetAutoGoLiveRequest {
  autoGoLive: boolean;
}
/** PUT /api/session/test-mode [user] -> SessionState. 409 code 'session_live' while a session runs. */
export interface SetTestModeRequest {
  testMode: boolean;
}

// ---------------------------------------------------------------------------
// Ingest (OBS setup)
// ---------------------------------------------------------------------------

/** GET /api/ingest [admin] -> IngestInfo */
export interface IngestInfo {
  /** Profile these OBS settings belong to. */
  profileId: string;
  /** e.g. rtmp://192.168.1.20:1935/live  (host = address the browser used, overridable in settings) */
  serverUrl: string;
  /**
   * Default profile: `landscape?key=…` (unchanged from before profiles). Other profiles:
   * `<slug>/landscape?key=…` — each profile has its own keys, so two OBS can stream at once.
   */
  feeds: { feed: Feed; streamKey: string; fullUrl: string }[];
}
/** POST /api/ingest/rotate [admin] body { feed } -> IngestInfo */
export interface RotateIngestKeyRequest {
  feed: Feed;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/** GET /api/chat/recent?limit=200 [user] -> ChatMessage[] (oldest first) */
/** GET /api/chat/overlay [admin] -> OverlayInfo */
export interface OverlayInfo {
  url: string; // full URL incl. token, for an OBS browser source
}
/** POST /api/chat/overlay/rotate [admin] -> OverlayInfo */
/** GET /overlay/chat?token=... [token] -> HTML page; WS /overlay/ws?token=... -> WsServerMessage of type 'chat' only */

// ---------------------------------------------------------------------------
// Settings [admin]
// ---------------------------------------------------------------------------

export interface AppSettings {
  /** Base URL used in links shown to the user (OAuth redirect hints, overlay URL). Empty = auto. */
  publicBaseUrl: string;
  /** Host shown in the OBS server URL. Empty = the host the browser used. */
  ingestHost: string;
  /** Seconds to wait after OBS disconnects before ending the session (covers OBS reconnects). */
  disconnectGraceSec: number;
}
/**
 * GET /api/version [user] -> VersionResponse: which build is running (shown at the bottom of every
 * page, so it's clear what is being tested). Not public: the login page doesn't show it.
 */
export interface VersionResponse {
  /** package.json version, e.g. "0.1.0". */
  version: string;
  /** Short git commit of the image, or null for a local/dev build. */
  commit: string | null;
  /** ISO time the image was built, or null. */
  buildDate: string | null;
  /** External API revision (docs/API.md changelog), e.g. "1.3". */
  apiRevision: string;
}

/** GET /api/settings -> SettingsResponse ; PUT /api/settings body Partial<AppSettings> -> SettingsResponse */
export interface SettingsResponse {
  settings: AppSettings;
  tls: TlsStatus;
  version: string;
}

// ---------------------------------------------------------------------------
// External API tokens [admin] — the external API itself lives under /api/v1 (docs/API.md)
// ---------------------------------------------------------------------------

/** GET /api/tokens -> ApiTokensResponse */
export interface ApiTokensResponse {
  tokens: ApiTokenInfo[];
  access: ApiAccessInfo;
}
/** How another app reaches the external API. */
export interface ApiAccessInfo {
  /** e.g. https://203.0.113.7/api/v1 */
  baseUrl: string;
  /** LAN address for apps on the same network/NAS, e.g. https://192.168.1.20:30443/api/v1 (null if unknown). */
  lanBaseUrl: string | null;
  /** SHA-256 fingerprint of the certificate being served, for apps that pin it (self-signed). */
  tlsFingerprint256: string | null;
  openApiUrl: string;
}
/** POST /api/tokens -> CreateApiTokenResponse (the secret is shown once) */
export interface CreateApiTokenRequest {
  name: string;
  scopes: ApiScope[];
  /** Limit the token to one profile (recommended for overlays/docks). Omitted/null = every profile. */
  profileId?: string | null;
}
export interface CreateApiTokenResponse {
  token: ApiTokenInfo;
  secret: string;
}
/** DELETE /api/tokens/:id -> {} */

/**
 * "Connect a phone" [admin] (docs/API.md §11): a one-time QR code CTD Live mobile scans, over the
 * LAN or mobile data, to get its own read-only token (status + chat).
 * POST /api/connect-offers body CreateConnectOfferRequest -> ConnectOfferResponse
 * GET /api/connect-offers/:id -> ConnectOfferStatus ; DELETE /api/connect-offers/:id -> {}
 */
export interface CreateConnectOfferRequest {
  /** Limit the phone to one profile, or null = every profile. */
  profileId: string | null;
}
export interface ConnectOfferStatus {
  id: string;
  state: 'waiting' | 'connected' | 'expired';
  /** The phone's name once it connected. */
  deviceName: string | null;
  expiresAt: string;
}
export interface ConnectOfferResponse extends ConnectOfferStatus {
  /** QR code as an SVG document (show it as an image). */
  qrSvg: string;
  /** The text in the QR code (ctdrelay://connect?…), e.g. to copy to a phone. */
  uri: string;
  /** The address phones on mobile data will use, and the LAN one (null when unknown). */
  apiUrl: string;
  lanApiUrl: string | null;
  /** True when apiUrl is a private/LAN address: phones on mobile data can't reach it. */
  apiUrlIsPrivate: boolean;
}

/**
 * "OBS on your computer" [admin]: where the OBS socket relay (/api/v1/obs/socket, CTD Live mobile)
 * finds OBS's WebSocket server.
 * GET /api/obs-relay -> ObsRelayStatus ; PUT /api/obs-relay body UpdateObsRelayRequest -> ObsRelayStatus
 * POST /api/obs-relay/test -> ObsRelayTestResult
 */
export interface ObsRelayStatus {
  /** OBS's address set by hand; null = automatic (the address OBS streams to Relay from). */
  host: string | null;
  port: number;
  hasPassword: boolean;
  /** The automatic address: the CTD OBS plugin's machine, else where OBS streams from (null = unknown). */
  detectedHost: string | null;
  /** Phones connected through the relay right now. */
  sessions: number;
  /** The CTD OBS plugin filled these settings in (its app id, name and when), or null. */
  reportedBy: { appId: string; name: string; at: string } | null;
  /** OBS's WebSocket server is on, as the plugin last reported (null = no report). */
  serverEnabled: boolean | null;
}
export interface UpdateObsRelayRequest {
  host: string | null;
  port: number;
  /** Omitted = keep the saved one; '' or null = none (OBS's "Enable Authentication" is off). */
  password?: string | null;
}
export type ObsRelayTestResult =
  | { ok: true; host: string; port: number; obsVersion: string | null; obsWebSocketVersion: string | null }
  | { ok: false; host: string | null; port: number; error: string };

/** GET /api/pairings [admin] -> PairingRequest[] (pending app connections, newest first) */
/** POST /api/pairings/:id/approve [admin] -> CreateApiTokenResponse (the app receives the token itself; the secret is not shown) */
export interface ApprovePairingRequest {
  /** Token name (default: the app's name). */
  name?: string;
  scopes: ApiScope[];
  /** Limit to one profile (recommended), or null = every profile. */
  profileId: string | null;
}
/** POST /api/pairings/:id/deny [admin] -> {} */

/** GET /api/apps [admin] -> ConnectedApp[] (for Settings → API; DELETE /api/apps/:id [admin] -> {} removes one) */

// ---------------------------------------------------------------------------
// Audit [admin]
// ---------------------------------------------------------------------------

/** GET /api/audit?limit=100&before=<id> -> AuditEntry[] (newest first) */
export type AuditResponse = AuditEntry[];

// ---------------------------------------------------------------------------
// Browser login viewer [admin]
// ---------------------------------------------------------------------------

/** POST /api/browser/:accountId/open body { url? } -> {} (opens/navigates the account's viewer page) */
export interface BrowserOpenRequest {
  url?: string;
}
/** POST /api/browser/:accountId/close body { save: boolean } -> {} */

/**
 * WS /api/browser/:accountId/ws
 * Server -> client: BrowserServerMessage. Client -> server: BrowserClientMessage.
 * Coordinates are in page CSS pixels of the viewport reported by the last 'frame'.
 */
export type BrowserServerMessage =
  | { type: 'frame'; data: string /* base64 jpeg */; width: number; height: number }
  | { type: 'url'; url: string; title: string }
  | { type: 'closed' }
  | { type: 'error'; message: string };

export type BrowserClientMessage =
  | {
      type: 'mouse';
      action: 'move' | 'down' | 'up' | 'wheel';
      x: number;
      y: number;
      button?: 'left' | 'right' | 'middle';
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
    }
  | { type: 'key'; action: 'down' | 'up'; key: string; code: string; text?: string; modifiers: number }
  | { type: 'type'; text: string } // paste / IME text
  | { type: 'navigate'; url: string }
  | { type: 'back' }
  | { type: 'reload' }
  | { type: 'resize'; width: number; height: number };

// ---------------------------------------------------------------------------
// Live events WebSocket
// ---------------------------------------------------------------------------

/** WS /api/ws [user]. Server pushes: */
/**
 * WS /api/ws?profile=<id> [user]: session/feed/destination/chat messages are for that profile
 * (default profile when omitted); `profiles` summaries cover every profile (sent in hello and on
 * any profile's session change) so the UI can show which profiles are live.
 */
export type WsServerMessage =
  | { type: 'hello'; session: SessionState; chat: ChatMessage[]; profiles: ProfileSummary[] }
  | { type: 'profiles'; profiles: ProfileSummary[] }
  /** [admin sockets only] pending pairings changed (show "an app wants to connect"). */
  | { type: 'pairings'; pairings: PairingRequest[] }
  /** Connected apps changed (registered/updated/removed/online/offline). */
  | { type: 'apps'; apps: ConnectedApp[] }
  | { type: 'session'; session: SessionState }
  | { type: 'feed'; feed: FeedState }
  | { type: 'destination'; state: DestinationState }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'chat-moderation'; moderation: ChatModeration }
  | { type: 'account'; account: Account }
  | { type: 'destinations-changed' }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string };

export type { ConnectMethod };
