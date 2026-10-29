// Wire types of the external API v1 (docs/API.md). Server-side only: the web UI never reads /api/v1.

import type {
  ApiScope,
  AppResource,
  ChatAlertKind,
  ConnectedApp,
  DestinationPhase,
  Feed,
  FeedState,
  PlatformId,
  PushStats,
  SessionStatus,
} from '../../../shared/types.js';

export const CONNECTOR = 'ctd-multi-stream';
export const CORE = 'core';

/** Every ChatAlert kind, in documentation order. */
export const ALERT_KINDS: readonly ChatAlertKind[] = ['follow', 'subscription', 'gift', 'cheer', 'kicks', 'raid', 'membership', 'superchat', 'tip'];

export type ApiAlertEventType = `alert.${ChatAlertKind}`;

export type ApiEventType =
  | 'chat.message'
  | 'chat.message.deleted'
  | 'chat.user.cleared'
  | 'chat.cleared'
  | ApiAlertEventType
  | 'stream.status'
  | 'feed.status'
  | 'destination.status'
  | 'destination.down'
  | 'destination.up'
  | 'system.notice'
  | 'profile.status'
  | 'profiles.changed'
  | 'apps.changed'
  | 'app.message'
  | 'obs.feed.state'
  | 'obs.feed.stats'
  | 'obs.output'
  | 'obs.scene'
  | 'obs.issue.raised'
  | 'obs.issue.cleared'
  | 'obs.sync.status'
  | 'music.nowplaying'
  | 'music.request'
  | 'system.reset';

/** Scope each event type needs. system.reset is a control frame every stream may get. */
export const EVENT_SCOPES: Record<ApiEventType, ApiScope | null> = {
  'chat.message': 'chat:read',
  'chat.message.deleted': 'chat:read',
  'chat.user.cleared': 'chat:read',
  'chat.cleared': 'chat:read',
  'alert.follow': 'chat:read',
  'alert.subscription': 'chat:read',
  'alert.gift': 'chat:read',
  'alert.cheer': 'chat:read',
  'alert.kicks': 'chat:read',
  'alert.raid': 'chat:read',
  'alert.membership': 'chat:read',
  'alert.superchat': 'chat:read',
  'alert.tip': 'chat:read',
  'stream.status': 'status:read',
  'feed.status': 'status:read',
  'destination.status': 'status:read',
  'destination.down': 'status:read',
  'destination.up': 'status:read',
  'system.notice': 'status:read',
  'profile.status': 'status:read',
  'profiles.changed': 'status:read',
  'apps.changed': 'apps:read',
  'app.message': 'apps:read',
  'obs.feed.state': 'status:read',
  'obs.feed.stats': 'status:read',
  'obs.output': 'status:read',
  'obs.scene': 'status:read',
  'obs.issue.raised': 'status:read',
  'obs.issue.cleared': 'status:read',
  'obs.sync.status': 'status:read',
  'music.nowplaying': 'status:read',
  'music.request': 'chat:read',
  'system.reset': null,
};

export const EVENT_TYPES = Object.keys(EVENT_SCOPES) as ApiEventType[];

export interface EnvelopeSource {
  connector: typeof CONNECTOR;
  /** Destination id, 'core' for session-wide events, or the sending app's id for obs.* events. */
  connection: string;
  /** PlatformId, 'core', or 'obs' (obs.* events from a connected app, v1.4). */
  platform: PlatformId | typeof CORE | 'obs';
  /**
   * Profile the event belongs to, or null for events about no single profile (profiles.changed,
   * apps.changed, app.message without a profile, notices for the whole server, system.reset).
   */
  profile: string | null;
}

export interface Envelope<T = unknown> {
  id: string;
  type: ApiEventType;
  ts: number;
  src: EnvelopeSource;
  data: T;
}

// ---- status ----

export interface ApiSession {
  status: SessionStatus;
  startedAt: string | null;
  title: string;
  testMode: boolean;
  autoGoLive: boolean;
  /** Viewers across every platform of the profile (sum of the known counts); null when none is known. v1.3. */
  viewers: number | null;
}

export type ApiFeed = FeedState;

export interface ApiDestination {
  id: string;
  name: string;
  platform: PlatformId;
  feed: Feed;
  enabled: boolean;
  phase: DestinationPhase;
  live: boolean;
  down: boolean;
  message: string | null;
  stats: PushStats | null;
  viewers: number | null;
  watchUrl: string | null;
  recoveries: number;
  lastRecovery: { at: string; reason: string } | null;
  since: string;
}

export interface ApiPlatform {
  platform: PlatformId;
  destinations: string[];
  live: boolean;
  title: string;
  /** Epoch ms since the first of its destinations went live, or null. */
  startedAt: number | null;
  viewers: number | null;
  error: string | null;
}

export interface ApiStatus {
  session: ApiSession;
  feeds: ApiFeed[];
  destinations: ApiDestination[];
  platforms: ApiPlatform[];
}

// ---- chat ----

export type ApiRole = 'broadcaster' | 'moderator' | 'vip' | 'subscriber' | 'member' | 'verified' | 'founder' | 'artist' | 'bot';
export const API_ROLES: readonly ApiRole[] = ['broadcaster', 'moderator', 'vip', 'subscriber', 'member', 'verified', 'founder', 'artist', 'bot'];

export interface ApiChatFragment {
  type: 'text' | 'emote' | 'mention' | 'link' | 'cheermote';
  text: string;
  image?: string;
  animated?: boolean;
  url?: string;
  userId?: string;
  amount?: number;
}

export interface ApiChatMessage {
  id: string;
  platform: PlatformId;
  channel: string;
  destinationId: string;
  platformMessageId: string | null;
  user: {
    id: string;
    login: string | null;
    name: string;
    color: string | null;
    avatar: string | null;
    badges: { id: string; label: string }[];
    roles: ApiRole[];
  };
  text: string;
  fragments: ApiChatFragment[];
  reply: { messageId: string | null; userName: string | null; text: string | null } | null;
  highlighted: boolean;
  action: boolean;
  kind: 'message' | 'event';
  /** v1.3: a "<name> joined" presence line (Instagram, TikTok), not a comment; always with kind 'event'. */
  join: boolean;
  ts: number;
}

/** Count units of ApiAlert.amount (integers); money uses unit 'currency'. */
export const ALERT_COUNT_UNITS = ['months', 'count', 'bits', 'kicks', 'viewers'] as const;

/**
 * alert.<kind> data: the CTD Overlay alert payload (shared ChatAlert) plus where it came from.
 * Optional fields are omitted when they don't apply (never null, except `gift`, which ChatAlert allows).
 */
export interface ApiAlert {
  kind: ChatAlertKind;
  /** `id` has the chat.message `user.id` form (`<platform>:<id>` / `<platform>:name:<name>`); absent for anonymous users. */
  user: { id?: string; name: string; avatar?: string; anonymous?: boolean };
  /** Counts are integers; money is an ISO 4217 currency + a decimal string ("5.00"), never a float. */
  amount?: { unit: (typeof ALERT_COUNT_UNITS)[number]; value: number } | { unit: 'currency'; value: string; currency: string };
  tier?: string;
  message?: { text: string };
  gift?: { recipients?: string[]; total?: number } | null;
  platform: PlatformId;
  destinationId: string;
  /** `id` of the chat.message (kind "event") that carried this alert. */
  messageId: string;
  /** Epoch ms (the chat message's time). */
  ts: number;
}

export interface ApiChatMessageDeleted {
  messageId: string;
  platformMessageId: string;
  platform: PlatformId;
  destinationId: string;
}

export interface ApiChatUserCleared {
  userId: string | null;
  userName: string | null;
  platform: PlatformId;
  destinationId: string;
}

export interface ApiChatCleared {
  platform: PlatformId;
  destinationId: string;
}

export interface ApiDestinationDown {
  destinationId: string;
  name: string;
  platform: PlatformId;
  phase: DestinationPhase;
  reason: string | null;
}

export interface ApiDestinationUp {
  destinationId: string;
  name: string;
  platform: PlatformId;
  downForSec: number;
  recoveries: number;
}

export interface ApiNotice {
  level: 'info' | 'warn' | 'error';
  message: string;
}

// ---- profiles + the hub (v1.2) ----

/** GET /profiles item and profile.status data (a ProfileSummary). */
export interface ApiProfile {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  status: SessionStatus;
  startedAt: string | null;
  testMode: boolean;
  destinations: number;
  live: number;
  down: number;
  createdAt: string;
  updatedAt: string;
}

/** GET /profiles/{id}/ingest */
export interface ApiIngest {
  profileId: string;
  serverUrl: string;
  feeds: { feed: Feed; streamKey: string; fullUrl: string }[];
}

/** A connected app as other apps see it (the registering token's id stays internal). */
export type ApiConnectedApp = Omit<ConnectedApp, 'tokenId'>;

export type ApiAppResource = AppResource;

/** apps.changed data. */
export interface ApiAppsChanged {
  apps: ApiConnectedApp[];
}

/** GET /profiles/{id}/overlays item. */
export interface ApiOverlay {
  appId: string;
  appName: string;
  appOnline: boolean;
  id: string;
  name: string;
  url?: string;
  width?: number;
  height?: number;
  meta?: Record<string, unknown>;
}

/** app.message data. */
export interface ApiAppMessage {
  id: string;
  from: string | null;
  to: string | null;
  type: string;
  profileId: string | null;
  replyTo: string | null;
  data: Record<string, unknown>;
  /** Epoch ms. */
  ts: number;
}
