// Service interfaces. Each implementation lives in its own module (see docs/CONTRACTS.md);
// the composition root (main.ts) wires them together into AppServices.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from 'pino';
import type { BrowserContext, Page } from 'playwright';
import type { AppSettings } from '../../shared/api.js';
import type {
  Account,
  AccountStatus,
  ApiScope,
  ApiTokenInfo,
  AuditEntry,
  ChatMessage,
  ConnectedApp,
  PairingRequest,
  Profile,
  ProfileSummary,
  Destination,
  Feed,
  FeedState,
  PlatformId,
  Role,
  SessionState,
  TitleResult,
  TlsMode,
  TlsStatus,
  User,
} from '../../shared/types.js';
import { DEFAULT_PROFILE_ID } from '../../shared/types.js';
import type { AppConfig } from './config.js';
import type { EventBus } from './events.js';
import type { ChatMessageInput, ChatSourceItem, DriverContext, PlatformDriver, PushPlan } from './platforms/types.js';

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** Authenticated encryption for secrets at rest (AES-256-GCM). */
export interface SecretBox {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

/** Encrypted key/value storage bound to one scope (e.g. 'account:<id>'). */
export interface ScopedSecrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** JSON helpers. */
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------
// Repositories (SQLite)
// ---------------------------------------------------------------------------

export interface UserRecord extends User {
  passwordHash: string;
  totpSecret: string | null; // encrypted with SecretBox
  totpPendingSecret: string | null; // encrypted; set by totp/setup until enabled
  failedLogins: number;
  lockedUntil: string | null;
}

export interface UsersRepo {
  count(): number;
  list(): User[];
  get(id: string): UserRecord | null;
  getByUsername(username: string): UserRecord | null;
  create(input: { username: string; passwordHash: string; role: Role }): User;
  update(
    id: string,
    patch: Partial<
      Pick<UserRecord, 'role' | 'passwordHash' | 'totpSecret' | 'totpPendingSecret' | 'totpEnabled' | 'failedLogins' | 'lockedUntil' | 'lastLoginAt'>
    >,
  ): User;
  delete(id: string): void;
}

export interface AuthSessionRecord {
  id: string; // random 32-byte token (stored hashed in DB; this is the hash)
  userId: string;
  csrfToken: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
}

export interface AuthSessionsRepo {
  /** Creates a session; returns the record plus the raw token for the cookie. */
  create(userId: string, meta: { ip: string | null; userAgent: string | null }): { record: AuthSessionRecord; token: string };
  /** Look up by raw cookie token; returns null if missing/expired. Slides lastSeenAt/expiry. */
  touch(token: string): AuthSessionRecord | null;
  /**
   * Like touch() but read-only: null if missing/expired, never slides the expiry. Used to
   * re-validate long-lived connections (WebSockets). Optional until the DB module implements it.
   */
  peek?(token: string): AuthSessionRecord | null;
  delete(token: string): void;
  deleteForUser(userId: string, exceptToken?: string): void;
  purgeExpired(): void;
}

export interface ProfilesRepo {
  /** Oldest first; the default profile always exists. */
  list(): Profile[];
  get(id: string): Profile | null;
  getBySlug(slug: string): Profile | null;
  /** Slug is derived from the name and made unique; fixed afterwards. */
  create(input: { name: string; color: string | null }): Profile;
  update(id: string, patch: Partial<{ name: string; color: string | null }>): Profile;
  /** Removes the profile row only (callers clean up its destinations/accounts/secrets first). */
  delete(id: string): void;
}

/** Registered external apps (the hub registry). Persisted so resources survive restarts. */
export interface ConnectedAppsRepo {
  list(): ConnectedApp[];
  get(id: string): ConnectedApp | null;
  /** Insert or replace (only by the token that first registered it — callers check tokenId). */
  upsert(app: Omit<ConnectedApp, 'online' | 'registeredAt' | 'lastSeenAt'> & { registeredAt?: string }): ConnectedApp;
  touch(id: string): void;
  delete(id: string): void;
  /** Remove every app registered by a token (token revoked). */
  deleteByToken(tokenId: string): void;
}

export interface AccountsRepo {
  /** All profiles when profileId is omitted. */
  list(profileId?: string): Account[];
  get(id: string): Account | null;
  create(input: { profileId: string; platform: PlatformId; label: string; options: Record<string, unknown> }): Account;
  update(
    id: string,
    patch: Partial<{ label: string; status: AccountStatus; statusMessage: string | null; options: Record<string, unknown> }>,
  ): Account;
  delete(id: string): void;
}

export interface DestinationsRepo {
  /** All profiles when profileId is omitted. */
  list(profileId?: string): Destination[];
  get(id: string): Destination | null;
  create(input: {
    profileId: string;
    platform: PlatformId;
    accountId: string | null;
    name: string;
    feed: Feed;
    enabled: boolean;
    options: Record<string, unknown>;
    ingestUrl: string | null;
  }): Destination;
  update(
    id: string,
    patch: Partial<{
      accountId: string | null;
      name: string;
      feed: Feed;
      enabled: boolean;
      options: Record<string, unknown>;
      ingestUrl: string | null;
      hasStreamKey: boolean;
    }>,
  ): Destination;
  delete(id: string): void;
  /** Set accountId = null for all destinations using this account. */
  detachAccount(accountId: string): void;
}

/** JSON key/value settings. */
export interface SettingsRepo {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

/** Encrypted secrets table; scope examples: 'account:<id>', 'destination:<id>', 'app:<platform>', 'ingest', 'chat'. */
export interface SecretsRepo {
  scoped(scope: string): ScopedSecrets;
  deleteScope(scope: string): void;
}

export interface AuditRepo {
  log(entry: { userId: string | null; username: string | null; action: string; detail?: string | null; ip?: string | null }): void;
  list(opts: { limit: number; before?: number }): AuditEntry[];
}

/** Personal access tokens for the external API (/api/v1). Secrets are stored hashed (SHA-256). */
export interface ApiTokensRepo {
  list(): ApiTokenInfo[];
  /** Creates a token; the secret (`ctd_pat_…`) is returned once and never stored in plain text. */
  create(input: { name: string; scopes: ApiScope[]; createdBy: string | null; profileId?: string | null }): {
    token: ApiTokenInfo;
    secret: string;
  };
  /** Look up a presented secret; null if unknown. Updates lastUsedAt (at most once a minute). */
  verify(secret: string): ApiTokenInfo | null;
  delete(id: string): void;
}

export interface Repos {
  users: UsersRepo;
  authSessions: AuthSessionsRepo;
  accounts: AccountsRepo;
  destinations: DestinationsRepo;
  settings: SettingsRepo;
  secrets: SecretsRepo;
  audit: AuditRepo;
  apiTokens: ApiTokensRepo;
  profiles: ProfilesRepo;
  connectedApps: ConnectedAppsRepo;
}

/**
 * Per-profile storage keys. The default profile keeps the pre-profiles keys so existing installs
 * need no data migration: settings 'session.title' / 'session.autoGoLive' / 'session.testMode',
 * secret scopes 'ingest' (OBS keys) and 'chat' (overlay token). Other profiles prefix them.
 */
export function profileSettingKey(profileId: string, key: string): string {
  return profileId === DEFAULT_PROFILE_ID ? key : `profile:${profileId}:${key}`;
}
export function profileSecretScope(profileId: string, scope: 'ingest' | 'chat' | 'spotify'): string {
  return profileId === DEFAULT_PROFILE_ID ? scope : `${scope}:${profileId}`;
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export interface MediaMtxAuthRequest {
  user: string;
  password: string;
  ip: string;
  action: 'publish' | 'read' | 'playback' | 'api' | 'metrics' | 'pprof';
  path: string;
  protocol: string;
  id: string | null;
  query: string;
  token?: string;
  userAgent?: string;
}

/**
 * MediaMTX wrapper: ingest of each profile's two OBS feeds. Paths: default profile
 * `live/landscape` + `live/vertical` (unchanged from before profiles); other profiles
 * `live/<slug>/landscape` + `live/<slug>/vertical`. Each profile has its own OBS keys.
 */
export interface MediaServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Both feeds of one profile. */
  feeds(profileId: string): FeedState[];
  feed(profileId: string, feed: Feed): FeedState;
  /** Local URL FFmpeg uses to read a profile's feed (includes internal read credentials). */
  readUrl(profileId: string, feed: Feed): string;
  /** Decide a MediaMTX HTTP auth request (called by the internal auth route). */
  authorize(req: MediaMtxAuthRequest): boolean;
  /** A profile's OBS stream keys (generated on first use, stored encrypted). */
  ingestKeys(profileId: string): Promise<Record<Feed, string>>;
  rotateIngestKey(profileId: string, feed: Feed): Promise<string>;
  /** OBS "Stream Key" field value for a feed: `landscape?key=…` or `<slug>/landscape?key=…`. */
  streamKeyField(profileId: string, feed: Feed): Promise<string>;
  /** Profile created/deleted: start/stop accepting its paths, drop its keys on delete. */
  profileAdded(profile: Profile): Promise<void>;
  profileRemoved(profileId: string): Promise<void>;
  /** Path under the RTMP server, e.g. 'live'. OBS server URL = rtmp://<host>:<port>/<appName>. */
  readonly appName: string;
  /** The IP address OBS streams a profile's feeds from (null when it isn't streaming). */
  publisherAddress?(profileId: string): Promise<string | null>;
}

/** Supervises one FFmpeg process per destination. Emits 'push' events on the EventBus. */
export interface PushSupervisor {
  /** Start (or restart) pushing for `id`. Retries automatically with backoff until stop(id). */
  start(id: string, plan: PushPlan): void;
  stop(id: string): Promise<void>;
  stopAll(): Promise<void>;
  isRunning(id: string): boolean;
}

// ---------------------------------------------------------------------------
// Browser automation
// ---------------------------------------------------------------------------

export interface BrowserManager {
  /** Get (or launch) the account's context, restoring its encrypted storage state. */
  context(accountId: string): Promise<BrowserContext>;
  /** A page for the account; reuses the viewer page if one is open. */
  page(accountId: string, url?: string): Promise<Page>;
  /** Page used by the login viewer (created on demand, navigated to url if given). */
  viewerPage(accountId: string, url?: string): Promise<Page>;
  /**
   * Why the login viewer must not open `url` (a loopback/LAN/link-local... host), or null when it
   * may. Optional so test fakes can omit it (no check).
   */
  checkViewerUrl?(url: URL): Promise<string | null>;
  /** Persist storage state (cookies, localStorage, IndexedDB) encrypted. */
  save(accountId: string): Promise<void>;
  hasSavedSession(accountId: string): Promise<boolean>;
  /** Close the account's context. Saves first only when `save: true` (default false). */
  close(accountId: string, opts?: { save?: boolean }): Promise<void>;
  /** Delete the saved session. */
  clear(accountId: string): Promise<void>;
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface ChatHub {
  /**
   * Run `source` for a destination until `signal` aborts. Restarts it with backoff when it
   * throws or ends. Messages are normalized, deduplicated, stored in a ring buffer and
   * emitted as 'chat' events.
   */
  attach(
    destinationId: string,
    platform: PlatformId,
    source: (signal: AbortSignal) => AsyncIterable<ChatSourceItem>,
    signal: AbortSignal,
    /** Profile of the destination; stamped on every message/moderation. Default: default profile. */
    profileId?: string,
  ): void;
  /**
   * Add a line of Relay's own to a destination's chat (e.g. "🎵 … added …" for a song request):
   * normalized, stored and emitted like platform chat. Nothing is sent to the platform.
   */
  post(destinationId: string, platform: PlatformId, input: ChatMessageInput, profileId?: string): void;
  /** Recent chat of one profile (oldest first). Default: the default profile. */
  recent(limit?: number, profileId?: string): ChatMessage[];
  /** Per-profile token for the OBS chat overlay URL (created on first call). */
  overlayToken(profileId?: string): Promise<string>;
  rotateOverlayToken(profileId?: string): Promise<string>;
  /** Which profile an overlay token belongs to (null = unknown token). */
  profileForOverlayToken(token: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** One orchestrator (go-live engine) per profile; they run independently and simultaneously. */
export interface OrchestratorRegistry {
  /** Throws an error with statusCode 404 / code 'unknown_profile' for an unknown profile. */
  get(profileId: string): Orchestrator;
  all(): Orchestrator[];
  /** Create + init the orchestrator of a new profile. */
  add(profile: Profile): Promise<void>;
  /** Stop (if running) and drop a profile's orchestrator. */
  remove(profileId: string): Promise<void>;
  /** Every profile with its live situation (for switchers, WS 'profiles', the external API). */
  summaries(): ProfileSummary[];
  init(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface Orchestrator {
  readonly profileId: string;
  /** Subscribe to this profile's feed events, restore its title/auto/test-mode settings. */
  init(): Promise<void>;
  state(): SessionState;
  start(trigger: 'auto' | 'manual'): Promise<void>;
  stop(reason?: string): Promise<void>;
  setTitle(title: string): Promise<TitleResult[]>;
  setAutoGoLive(value: boolean): void;
  /**
   * Session test mode (persisted as 'session.testMode'). Only while no session runs: otherwise
   * throws an error with statusCode 409 and code 'session_live'.
   */
  setTestMode(value: boolean): void;
  /** Destination enabled/disabled or edited mid-session. */
  destinationChanged(id: string): Promise<void>;
  destinationRemoved(id: string): Promise<void>;
  retryDestination(id: string): Promise<void>;
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

export interface TlsMaterial {
  key: string; // PEM
  cert: string; // PEM (full chain)
}

export interface TlsManager {
  readonly mode: TlsMode;
  /** Load or create the initial certificate. Null when mode is 'off'. */
  init(): Promise<TlsMaterial | null>;
  /**
   * Start the plain-HTTP listener (ACME HTTP-01 + redirect to HTTPS) and the
   * issuance/renewal loop. onRenew is called with new material to hot-swap.
   */
  start(onRenew: (m: TlsMaterial) => void): Promise<void>;
  status(): TlsStatus;
  stop(): Promise<void>;
  /**
   * Plain-HTTP handoff for LAN clients: the HTTP listener passes requests from private/loopback/
   * CGNAT/ULA/link-local addresses for /api/v1, /dock and /overlay/* (and /overlay/ws upgrades) to
   * `handler` instead of redirecting them to HTTPS. Null removes it. Optional (no-op when TLS is off).
   */
  setLanHandler?(handler: LanHandler | null): void;
}

/** Where the TLS module's HTTP listener hands LAN requests (the Fastify app). */
export interface LanHandler {
  request(req: IncomingMessage, res: ServerResponse): void;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

// ---------------------------------------------------------------------------
// Platform registry + composition
// ---------------------------------------------------------------------------

export interface PlatformRegistry {
  get(id: PlatformId): PlatformDriver;
  all(): PlatformDriver[];
}

// ---------------------------------------------------------------------------
// Hub: connected apps + pairing (implemented in server/src/api/)
// ---------------------------------------------------------------------------

/** Presence + registry of external apps. Emits 'apps-changed' on the bus. */
export interface AppRegistry {
  /** Apps with `online` computed; resources filtered to `profileId` (+ unassigned) when given. */
  list(profileId?: string | null): ConnectedApp[];
  get(id: string): ConnectedApp | null;
  /** Register or update (heartbeat). Throws 409 'app_owned' if another token registered `id`. */
  register(token: ApiTokenInfo, input: Omit<ConnectedApp, 'tokenId' | 'profileId' | 'registeredAt' | 'lastSeenAt' | 'online'>): ConnectedApp;
  heartbeat(token: ApiTokenInfo, id: string): ConnectedApp;
  remove(id: string): void;
  /** Token revoked: drop its apps. */
  removeByToken(tokenId: string): void;
}

/** "Connect this app" requests, approved by an admin. Emits 'pairings-changed' on the bus. */
export interface PairingService {
  /** Unauthenticated (rate-limited by the route). Returns the secret the app polls with. */
  create(input: { appName: string; kind: string; requestedScopes: ApiScope[]; requestedProfileId: string | null; ip: string | null }): {
    pairing: PairingRequest;
    pollSecret: string;
  };
  /** 'pending' | 'denied' | 'expired' | { token secret + info, once } */
  poll(id: string, pollSecret: string): { status: 'pending' | 'denied' | 'expired' } | { status: 'approved'; secret: string; token: ApiTokenInfo };
  list(): PairingRequest[];
  approve(id: string, opts: { name?: string; scopes: ApiScope[]; profileId: string | null; approvedBy: string | null }): ApiTokenInfo;
  deny(id: string): void;
}

export interface AppServices {
  config: AppConfig;
  log: Logger;
  bus: EventBus;
  repos: Repos;
  secretBox: SecretBox;
  media: MediaServer;
  pushes: PushSupervisor;
  browser: BrowserManager;
  chat: ChatHub;
  platforms: PlatformRegistry;
  /** One go-live engine per profile. */
  orchestrators: OrchestratorRegistry;
  apps: AppRegistry;
  pairings: PairingService;
  tls: TlsManager;
  /** Build a DriverContext for a platform call. */
  driverContext(opts: {
    platform: PlatformId;
    accountId?: string | null;
    destinationId?: string | null;
    signal?: AbortSignal;
  }): Promise<DriverContext>;
  /** Current settings with defaults applied. */
  appSettings(): AppSettings;
  /** Public base URL (settings override, else derived from TLS public IP/host + PUBLIC_PORT). */
  publicBaseUrl(): string;
}
