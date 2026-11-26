// Domain types shared by the server and the web UI.
// Keep this file free of runtime dependencies (types + small constants only).

export type Feed = 'landscape' | 'vertical';
export const FEEDS: readonly Feed[] = ['landscape', 'vertical'];

export type PlatformId =
  | 'twitch'
  | 'youtube'
  | 'kick'
  | 'facebook'
  | 'x'
  | 'instagram'
  | 'tiktok'
  | 'custom';

export const PLATFORM_IDS: readonly PlatformId[] = [
  'twitch',
  'youtube',
  'kick',
  'facebook',
  'x',
  'instagram',
  'tiktok',
  'custom',
];

export type Role = 'admin' | 'operator';

// ---------------------------------------------------------------------------
// Generic form fields. Drivers describe their settings with these so the UI
// can render forms without platform-specific code.
// ---------------------------------------------------------------------------

/** 'links' = an ordered list of LinkItem ({ title, url }), stored as an array option. */
export type FieldType = 'text' | 'secret' | 'url' | 'select' | 'boolean' | 'number' | 'links';

/**
 * Where a destination field's value is stored:
 * - 'option'    -> Destination.options[key] (non-secret, returned to the UI)
 * - 'ingestUrl' -> Destination.ingestUrl (non-secret RTMP server URL)
 * - 'streamKey' -> encrypted secret, never returned to the UI (Destination.hasStreamKey tells if set)
 */
export type FieldTarget = 'option' | 'ingestUrl' | 'streamKey';

/** A link attached to a live (Instagram allows one per live). Value type of 'links' fields. */
export interface LinkItem {
  title: string;
  url: string;
}

export const LINKS_MAX = 20;
export const LINK_TITLE_MAX = 100;

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  target?: FieldTarget; // destination fields only; defaults to 'option'
  required?: boolean;
  /** For 'links' fields the default is an empty list (omit it). */
  default?: string | number | boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[]; // for 'select'
}

export type ConnectMethod = 'device-code' | 'oauth-paste' | 'token-paste' | 'browser' | 'none';

export interface DeveloperAppSpec {
  /** Where the user registers the app (e.g. https://dev.twitch.tv/console/apps). */
  consoleUrl: string;
  /** Fields to collect, e.g. clientId / clientSecret. */
  fields: FieldSpec[];
  /** Step-by-step setup instructions (plain text, one step per line). */
  instructions: string;
}

export interface PlatformInfo {
  id: PlatformId;
  name: string;
  /** Feeds this platform can accept. */
  feeds: Feed[];
  defaultFeed: Feed;
  /** How an account is connected. 'none' = no account needed (e.g. custom RTMP). */
  connectMethod: ConnectMethod;
  /** Options asked when creating an account (e.g. Facebook "page" vs "profile"). */
  accountFields: FieldSpec[];
  /** Fields shown when creating/editing a destination of this platform. */
  destinationFields: FieldSpec[];
  /** Developer app registration needed (Twitch, YouTube, Kick, Facebook Page). */
  developerApp: DeveloperAppSpec | null;
  titleSupport: 'api' | 'browser' | 'none';
  chatSupport: 'api' | 'browser' | 'unofficial' | 'none';
  /** True when the platform issues a new stream key for every stream (Instagram, TikTok). */
  keyPerSession: boolean;
  experimental: boolean;
  notes?: string;
  /**
   * What session test mode does on this platform. Unsupported (or omitted) = the destination is
   * skipped while test mode is on, so nothing goes out publicly.
   */
  testMode?: { supported: boolean; description: string };
}

// ---------------------------------------------------------------------------
// Accounts and destinations
// ---------------------------------------------------------------------------

export type AccountStatus = 'pending' | 'connected' | 'needs-login' | 'error';

/** A connected platform account (OAuth tokens / browser session live in encrypted storage). */
// ---------------------------------------------------------------------------
// Profiles: independent streaming set-ups (accounts, destinations, title, OBS keys, session)
// that can be live at the same time. Developer apps, users, HTTPS and API tokens are shared.
// ---------------------------------------------------------------------------

/** The profile every pre-profiles install was migrated into. Keeps the legacy OBS paths/keys. */
export const DEFAULT_PROFILE_ID = 'default';

export interface Profile {
  id: string;
  name: string;
  /**
   * URL-safe, unique, fixed at creation (renaming keeps it, so OBS settings never break).
   * OBS stream key prefix for non-default profiles: `<slug>/landscape?key=…`.
   */
  slug: string;
  /** Optional accent colour (#RRGGBB) to tell profiles apart in the UI. */
  color: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A profile plus its live situation, for switchers and overviews. */
export interface ProfileSummary extends Profile {
  status: SessionStatus;
  startedAt: string | null;
  testMode: boolean;
  /** Enabled destinations / currently live / currently down. */
  destinations: number;
  live: number;
  down: number;
}

export interface Account {
  id: string;
  /** Owning profile. Always set by the server (optional only for older test fixtures). */
  profileId?: string;
  platform: PlatformId;
  label: string;
  status: AccountStatus;
  statusMessage: string | null;
  /** Non-secret options (e.g. { mode: 'page' } for Facebook). */
  options: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** One output: a platform account + which feed goes there. */
export interface Destination {
  id: string;
  /** Owning profile. Always set by the server (optional only for older test fixtures). */
  profileId?: string;
  platform: PlatformId;
  accountId: string | null;
  name: string;
  feed: Feed;
  enabled: boolean;
  /** Non-secret, platform-specific options (see PlatformInfo.destinationFields). */
  options: Record<string, unknown>;
  /** Manually entered RTMP(S) server URL, for paste-a-key platforms. */
  ingestUrl: string | null;
  /** Whether a stream key is stored. The key itself is never sent to the UI. */
  hasStreamKey: boolean;
  /**
   * Re-encode the feed for this destination (docs/TRANSCODING.md). null/absent = copy, as before:
   * the platform gets the feed exactly as OBS sends it. Only used while Settings → Transcoding is on.
   */
  transcode?: TranscodeProfile | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Transcoding (docs/TRANSCODING.md). Off unless the server's switch is on and the destination has a
// profile with mode 'transcode'. Limits and defaults per platform: shared/transcode.ts.
// ---------------------------------------------------------------------------

export type VideoCodec = 'h264' | 'hevc' | 'av1';
export const VIDEO_CODECS: readonly VideoCodec[] = ['h264', 'hevc', 'av1'];

/** What a destination gets instead of the copied feed. */
export interface TranscodeProfile {
  /** 'copy' keeps today's behaviour (same as `transcode: null`); the saved settings stay for later. */
  mode: 'copy' | 'transcode';
  video: {
    codec: VideoCodec;
    /** Output frame size. The feed is scaled to fit and letterboxed/pillarboxed, never stretched. */
    width: number;
    height: number;
    /** null = keep the feed's frame rate. Otherwise 24..120 (frames are dropped or repeated). */
    fps: number | null;
    /** Constant bitrate in kbit/s. */
    bitrateKbps: number;
    /** Keyframe every N seconds (every platform asks for 2). */
    keyframeSec: number;
    /** 'auto' = the best encoder that passed this machine's test encode, or one encoder by name. */
    encoder: string;
  };
  /** 'copy' keeps the feed's audio when it is AAC (else AAC 160 kbps); or always re-encode to AAC. */
  audio: 'copy' | { codec: 'aac'; bitrateKbps: number };
  /**
   * When the encode can't keep up or the encoder fails: 'copy' sends the original feed instead (only
   * if the platform accepts it; otherwise Relay keeps transcoding and warns), 'stop' stops this
   * destination with the reason. Other destinations are never affected.
   */
  fallback: 'copy' | 'stop';
}

/**
 * - starting: the encode is starting
 * - running: encoding in real time
 * - behind: encoding slower than real time (viewers see stutters); falls back after a while
 * - fallback-copy: gave up transcoding for this push; the platform gets the original feed
 */
export type TranscodeRunState = 'starting' | 'running' | 'behind' | 'fallback-copy';

/** Live transcoding state of one destination (DestinationState.transcode). */
export interface DestinationTranscodeStatus {
  state: TranscodeRunState;
  /** FFmpeg encoder in use, e.g. "libx264" (null in fallback-copy). */
  encoder: string | null;
  codec: VideoCodec;
  width: number;
  height: number;
  /** Output frame rate; null = the feed's rate. */
  fps: number | null;
  bitrateKbps: number;
  /** Encoding speed over the last seconds (1.00 = real time); null until measured. */
  speed: number | null;
  /** Why it is behind / fell back, in plain words. */
  message: string | null;
}

// ---------------------------------------------------------------------------
// Live session state
// ---------------------------------------------------------------------------

export interface FeedState {
  /** Profile whose OBS sends this feed. Always set by the server. */
  profileId?: string;
  feed: Feed;
  online: boolean;
  since: string | null;
  /**
   * fps and keyframeSec are measured a few seconds after OBS connects (once per connection);
   * keyframeSecIsMinimum: fewer than two keyframes in the window, so the interval is at least that.
   */
  video: { codec: string; width?: number; height?: number; fps?: number; keyframeSec?: number; keyframeSecIsMinimum?: boolean } | null;
  audio: { codec: string; sampleRate?: number; channels?: number } | null;
  bitrateKbps: number | null;
}

export type DestinationPhase =
  | 'idle' // session not running
  | 'disabled' // destination disabled
  | 'waiting-for-feed' // session running, required feed(s) offline
  | 'preparing' // driver.prepare() running (title, key, create live)
  | 'connecting' // ffmpeg started, waiting for data to flow
  | 'confirming' // driver confirm() running (e.g. clicking "Go Live")
  | 'live'
  | 'retrying'
  | 'recovering' // the platform killed the live (e.g. copyright takedown); building a fresh one
  | 'ending'
  | 'error';

export interface PushStats {
  bitrateKbps: number;
  fps: number;
  speed: number;
  uptimeSec: number;
}

export interface DestinationState {
  destinationId: string;
  /** Always set by the server. */
  profileId?: string;
  phase: DestinationPhase;
  message: string | null;
  stats: PushStats | null;
  watchUrl: string | null;
  retries: number;
  since: string;
  /** Automatic takedown recoveries this session (fresh live created after the platform killed one). */
  recoveries: number;
  /** Most recent takedown that triggered a recovery, this session. */
  lastRecovery: { at: string; reason: string } | null;
  /** Current viewers on the platform, when the driver can read them (null = unknown). */
  viewers?: number | null;
  /**
   * Feeds this destination is waiting for: offline ones, or (with `blocked`) the online feed it can't
   * send. Non-empty only while the phase is `waiting-for-feed`.
   */
  waitingFor?: Feed[];
  /** Set while this destination's push transcodes (or fell back to copy); null/absent = plain copy. */
  transcode?: DestinationTranscodeStatus | null;
  /**
   * Set while the feed is online but can't be sent (e.g. HEVC video): nothing is pushed and no
   * retries run until OBS sends H.264; then the destination starts by itself. Only while the phase is
   * `waiting-for-feed`; `message` says what to change.
   */
  blocked?: DestinationBlock | null;
}

/** Why a destination can't send an online feed (shared/feed-codec.ts). */
export interface DestinationBlock {
  reason: 'feed-video-codec' | 'feed-audio-codec' | 'feed-audio-missing';
  feed: Feed;
  /** The feed's codec that can't be sent ('hevc', 'av1', 'opus'…); null when the feed has no audio. */
  codec: string | null;
}

export type SessionStatus = 'offline' | 'starting' | 'live' | 'stopping';

export interface SessionState {
  /** The profile this session belongs to. Always set by the server. */
  profileId?: string;
  status: SessionStatus;
  sessionId: string | null;
  startedAt: string | null;
  title: string;
  autoGoLive: boolean;
  /**
   * Test mode: every destination uses its platform's private/test setting (Twitch bandwidth test,
   * YouTube private, Instagram Practice, Facebook only-me); platforms without one are skipped.
   * Settings key 'session.testMode'. Can only change while offline.
   */
  testMode?: boolean;
  feeds: FeedState[];
  destinations: DestinationState[];
}

export interface TitleResult {
  destinationId: string;
  ok: boolean;
  skipped?: boolean;
  /** Failure reason, or for skipped results the reason it was skipped. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface ChatMessage {
  id: string;
  platform: PlatformId;
  destinationId: string;
  /** Profile of the destination. Always set by the ChatHub. */
  profileId?: string;
  author: {
    name: string;
    color?: string;
    badges?: string[];
    avatarUrl?: string;
    /** Platform user id (unprefixed), when the platform exposes one. */
    id?: string;
    /** Login/handle, when different from the display name. */
    login?: string;
  };
  text: string;
  ts: string; // ISO timestamp
  kind: 'message' | 'event';
  /** The platform's own message id (needed to apply deletions). */
  platformMessageId?: string;
  /** Text split into parts (emotes, mentions, links). Joining every part's text equals `text`. */
  fragments?: ChatFragment[];
  /** /me message. */
  action?: boolean;
  /** Highlighted / paid / pinned message. */
  highlighted?: boolean;
  reply?: { messageId?: string; userName?: string; text?: string } | null;
  /**
   * Structured alert carried by a `kind: 'event'` line (sub, gift, cheer, raid, membership, Super Chat…).
   * Matches CTD Overlay's alert payload; the external API also emits it as `alert.<kind>`.
   */
  alert?: ChatAlert;
  /**
   * A presence line, not a comment: someone joined / started watching ("dj_fan joined" in Instagram's
   * and TikTok's live chat). Only on `kind: 'event'` lines.
   */
  join?: boolean;
  /**
   * On a `join` line that names one user and a number of others ("dj_fan and 3 others joined" in
   * Instagram's live chat): that number. `author` is the named user.
   */
  othersCount?: number;
}

export type ChatAlertKind = 'follow' | 'subscription' | 'gift' | 'cheer' | 'kicks' | 'raid' | 'membership' | 'superchat' | 'tip';

export interface ChatAlert {
  kind: ChatAlertKind;
  user: { id?: string; name: string; avatar?: string; anonymous?: boolean };
  /** Counts as integers; money as an ISO 4217 currency + decimal string value ("5.00"), never a float. */
  amount?:
    | { unit: 'months' | 'count' | 'bits' | 'kicks' | 'viewers'; value: number }
    | { unit: 'currency'; value: string; currency: string };
  tier?: string;
  message?: { text: string };
  gift?: { recipients?: string[]; total?: number } | null;
}

export interface ChatFragment {
  type: 'text' | 'emote' | 'mention' | 'link' | 'cheermote';
  text: string;
  image?: string;
  animated?: boolean;
  url?: string;
  userId?: string;
  amount?: number;
}

/** Moderation that removes chat (so overlays can remove it too). */
export type ChatModeration = (
  | { kind: 'message-deleted'; platform: PlatformId; destinationId: string; ts: string; messageId: string | null; platformMessageId: string }
  | { kind: 'user-cleared'; platform: PlatformId; destinationId: string; ts: string; userId: string | null; userName: string | null }
  | { kind: 'cleared'; platform: PlatformId; destinationId: string; ts: string }
) & {
  /** Profile of the destination. Always set by the ChatHub. */
  profileId?: string;
};

// ---------------------------------------------------------------------------
// Users, audit, TLS
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  username: string;
  role: Role;
  totpEnabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuditEntry {
  id: number;
  ts: string;
  userId: string | null;
  username: string | null;
  action: string;
  detail: string | null;
  ip: string | null;
}

// ---------------------------------------------------------------------------
// External API tokens (other apps, e.g. CTD Overlay, reading chat/status)
// ---------------------------------------------------------------------------

/**
 * chat:read   = chat history + live chat/moderation/alert events
 * status:read = stream/destination status and the profiles list
 * ingest:read = a profile's OBS server URL + stream keys (lets the OBS plugin configure OBS)
 * apps:read   = connected apps, their resources (e.g. overlays per profile) and app messages
 * apps:write  = register this app + its resources, send messages to other apps
 * obs:write   = send OBS events (feed/output/scene state) into the hub (the CTD OBS plugin; v1.4)
 * obs:control = control OBS through Relay's OBS WebSocket relay, /obs/socket (CTD Live mobile; v1.6)
 * show:read    = show profiles (manifests, bundles), their assets and the asset library (CTD OBS plugin; v1.9)
 * show:write   = save show-profile revisions and upload blobs (v1.9)
 * show:secrets = the encrypted third-party secrets of a show profile, e.g. browser-source URL keys (v1.9)
 * system:admin = operator tools that change how this server works, e.g. the Instagram chat reader's
 *                selector pack and its debug capture (v1.11). Only for tokens an admin creates in
 *                Settings → API for every profile; never granted through pairing (ADMIN_ONLY_SCOPES).
 * reports:read = stream reports: viewers, chat counts, events, the audience leaderboards and
 *                exports (v1.13, docs/REPORTS.md). Holds viewer names: grant it with care.
 * feeds:watch  = watch a feed live, video and sound (LL-HLS, v1.14, docs/PREVIEW.md). Each player
 *                pulls the feed's full bitrate. The JPEG thumbnails stay under status:read.
 */
export type ApiScope =
  | 'chat:read'
  | 'status:read'
  | 'ingest:read'
  | 'apps:read'
  | 'apps:write'
  | 'obs:write'
  | 'obs:control'
  | 'show:read'
  | 'show:write'
  | 'show:secrets'
  | 'system:admin'
  | 'reports:read'
  | 'feeds:watch';
export const API_SCOPES: readonly ApiScope[] = [
  'chat:read',
  'status:read',
  'ingest:read',
  'apps:read',
  'apps:write',
  'obs:write',
  'obs:control',
  'show:read',
  'show:write',
  'show:secrets',
  'system:admin',
  'reports:read',
  'feeds:watch',
];
/** Scopes an app cannot ask for by pairing, and that a token limited to one profile cannot hold. */
export const ADMIN_ONLY_SCOPES: readonly ApiScope[] = ['system:admin'];
/**
 * Scopes an operator should think twice about, with the one-line reason shown next to them when an
 * app asks for them (pairing or a scope upgrade, docs/API.md §9.3.1). Other scopes have no entry.
 */
export const SENSITIVE_SCOPES: Readonly<Partial<Record<ApiScope, string>>> = {
  'show:secrets': 'Hands out the keys saved in OBS sources (e.g. browser-source URL keys).',
  'reports:read': 'Shows viewer names and who chatted the most.',
  'ingest:read': 'Hands out the stream keys of OBS.',
  'feeds:watch': 'Lets the app watch the live video, with sound.',
  'obs:control': 'Lets the app control OBS: scenes, streaming and recording.',
};

// ---------------------------------------------------------------------------
// Connected apps (the hub): other apps register themselves and what they offer, so apps can
// find each other through CTD Relay (e.g. the OBS plugin lists CTD Overlay's overlays
// assigned to a profile and adds them as browser sources).
// ---------------------------------------------------------------------------

/** Something an app offers. Overlays are the first resource type; others are free-form. */
export interface AppResource {
  /** 'overlay' (a browser-source URL) or an app-defined type ([a-z0-9-]). */
  type: string;
  /** Unique within the app. */
  id: string;
  name: string;
  /** Profile this resource is assigned to, or null = not assigned / every profile. */
  profileId: string | null;
  /** For overlays: the URL to load in an OBS browser source. */
  url?: string;
  width?: number;
  height?: number;
  /**
   * Free-form extra data (≤ 4 KB JSON). Overlays may add `scenes: OverlayScene[]`, which is
   * validated and has its own limits (≤ 50 scenes, ≤ 16 KB JSON, not counted in the 4 KB).
   */
  meta?: Record<string, unknown>;
}

/**
 * One scene of an overlay, in an overlay resource's `meta.scenes`: a browser-source URL that shows
 * only that scene (pinned), for the same canvas and size as the overlay's main `url`.
 */
export interface OverlayScene {
  /** Unique within the overlay (≤ 100). */
  id: string;
  /** ≤ 120 characters. */
  name: string;
  /** http(s), ≤ 2048 characters. */
  url: string;
}

/** The `meta` keys of an overlay resource that CTD apps agree on; every key is optional and others are allowed. */
export interface OverlayMeta {
  canvas?: 'landscape' | 'vertical';
  fps?: number;
  transparent?: boolean;
  /** Stable role key shared by the equivalent overlay of every profile. */
  slot?: string;
  scenes?: OverlayScene[];
  [key: string]: unknown;
}

export interface ConnectedApp {
  /** Chosen by the app ([a-z0-9-], ≤ 40), e.g. 'ctd-overlay', 'ctd-obs-plugin-studio-pc'. */
  id: string;
  name: string;
  /** 'ctd-overlay' | 'ctd-obs-plugin' | 'custom' | … (free-form, [a-z0-9-]). */
  kind: string;
  version: string | null;
  /** Where the app itself can be reached, if it has a UI/API (shown as a link). */
  baseUrl: string | null;
  capabilities: string[];
  resources: AppResource[];
  /** Token that registered the app (only that token may update/remove it). */
  tokenId: string;
  /** Profile of that token (null = every profile). */
  profileId: string | null;
  registeredAt: string;
  lastSeenAt: string;
  /** Seen within the last 90 s (apps re-register or heartbeat every ≤ 60 s). */
  online: boolean;
}

/** A pending "connect this app" request (pairing), approved by an admin in Settings → API. */
export interface PairingRequest {
  id: string;
  appName: string;
  kind: string;
  /** Short code the app shows; the admin checks it matches before approving. */
  code: string;
  requestedScopes: ApiScope[];
  requestedProfileId: string | null;
  ip: string | null;
  createdAt: string;
  expiresAt: string;
}

/**
 * A pending scope upgrade (docs/API.md §9.3.1, v1.18): an app asks for more scopes for the token it
 * already holds; an admin approves (the same token gains exactly `adding`) or denies it in
 * Settings → API. Never holds a secret.
 */
export interface ScopeUpgradeRequest {
  id: string;
  tokenId: string;
  tokenName: string;
  /** First characters of the token (e.g. "ctd_pat_3fK9"), to recognise it. */
  tokenPrefix: string;
  /** The token's profile, or null = every profile. An upgrade never changes it. */
  profileId: string | null;
  /** The name the app gave, else the name of the app registered with the token; null if neither. */
  appName: string | null;
  /** Kind of the app registered with the token, if any. */
  kind: string | null;
  /** What the token holds now. */
  currentScopes: ApiScope[];
  /** What approving adds (never an admin-only scope, never one it holds). */
  adding: ApiScope[];
  /** Why the app asks, as the app wrote it (≤ 200 characters; untrusted text). */
  reason: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface ApiTokenInfo {
  id: string;
  name: string;
  scopes: ApiScope[];
  /**
   * Profile the token is limited to, or null = every profile (tokens created before profiles
   * existed are null and keep their old behaviour: they read the default profile unless asked).
   */
  profileId: string | null;
  /** First characters of the secret, to recognise it (e.g. "ctd_pat_3fK9"). */
  prefix: string;
  createdAt: string;
  createdBy: string | null;
  lastUsedAt: string | null;
}

export type TlsMode ='auto' | 'letsencrypt' | 'self-signed' | 'manual' | 'off';

export interface TlsStatus {
  mode: TlsMode;
  /** What is actually being served right now. */
  source: 'letsencrypt-ip' | 'letsencrypt-domain' | 'self-signed' | 'manual' | 'none';
  subject: string | null; // IP or hostname on the cert
  notAfter: string | null;
  fingerprint256: string | null;
  publicIp: string | null;
  lastError: string | null;
  nextRenewalAt: string | null;
}
