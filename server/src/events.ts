import { EventEmitter } from 'node:events';
import type { NowPlaying, SongRequestResult } from '../../shared/api.js';
import type {
  Account,
  ChatMessage,
  ChatModeration,
  DestinationState,
  Feed,
  FeedState,
  PushStats,
  SessionState,
} from '../../shared/types.js';

/**
 * State reported by the FFmpeg supervisor for one push (keyed by destination id).
 * 'failed' is final (retrying can't help, e.g. FFmpeg missing or an unsupported plan): the push is no
 * longer supervised and the orchestrator treats it as an error.
 */
export type PushStatus = 'starting' | 'running' | 'retrying' | 'stopped' | 'failed';

export interface PushEvent {
  id: string;
  status: PushStatus;
  message: string | null;
  stats: PushStats | null;
  attempt: number;
}

export interface AppEvents {
  /** A feed went online/offline or its stats changed (emitted by MediaServer). */
  feed: [FeedState];
  /** FFmpeg push status changes and periodic stats (emitted by PushSupervisor). */
  push: [PushEvent];
  /** Full session snapshot (emitted by Orchestrator on any session-level change). */
  session: [SessionState];
  /** One destination's state changed (emitted by Orchestrator). */
  destination: [DestinationState];
  /** New chat message (emitted by ChatHub). */
  chat: [ChatMessage];
  /** Chat removed by moderation: deleted message, banned/timed-out user, cleared chat (emitted by ChatHub). */
  'chat-moderation': [ChatModeration];
  /** Account changed (status, label...) (emitted by account routes / drivers via DriverContext). */
  account: [Account];
  /** Destination list or config changed (emitted by destination routes). Profile when known. */
  'destinations-changed': [] | [{ profileId: string }];
  /**
   * User-facing notice (any component). `profileId` when it concerns one profile. `kind`, `subject`
   * and `codec` (optional) say what it is about for connected apps (system.notice, docs/API.md).
   */
  notice: [{ level: 'info' | 'warn' | 'error'; message: string; profileId?: string } & NoticeAbout];
  /** Profiles created/renamed/deleted (emitted by profile routes). */
  'profiles-changed': [];
  /** Connected apps registered/updated/removed/went online or offline (emitted by AppRegistry). */
  'apps-changed': [];
  /** Pending pairings changed (emitted by PairingService). */
  'pairings-changed': [];
  /** A message from one connected app to another (or to all), relayed by the hub. */
  'app-message': [AppMessage];
  /** An OBS event a connected app (the CTD OBS plugin) sent into the hub (POST /api/v1/apps/{id}/events). */
  'obs-event': [ObsEvent];
  /** What a profile's Spotify plays changed: another song, play/pause, a seek (emitted by MusicService). */
  music: [{ profileId: string; nowPlaying: NowPlaying }];
  /** A chat song request was handled, queued or refused (emitted by MusicService). */
  'music-request': [{ profileId: string; destinationId: string; result: SongRequestResult }];
  /** A show-profile revision was saved (emitted by the /api/v1 show routes). */
  'show-changed': [{ profileId: string; revision: number; parentRevision: number | null; byAppId: string | null }];
  /** The asset library changed (emitted by the Assets routes). `profileId` null = an every-profile entry. */
  'library-changed': [{ profileId: string | null }];
}

/**
 * What a notice is about, for apps that act on it instead of only showing it. Named like the
 * suite's issue contract (`kind` + `subject`), so the same problem can be raised as an issue later.
 */
export interface NoticeAbout {
  /** 'feed.codec': a feed's video or audio codec can't be sent (shared/feed-codec.ts). */
  kind?: 'feed.codec';
  subject?: { type: 'feed'; feed: Feed };
  /** The codec in question ('hevc', 'av1', 'opus'). */
  codec?: string;
}

/** OBS event relayed by the hub (docs/API.md §10). `data` is already size-checked. */
export interface ObsEvent {
  appId: string;
  profileId: string;
  type: string;
  /** The app's own event id (deduped by the hub). */
  id: string;
  /** Epoch ms on the hub's clock. */
  ts: number;
  data: Record<string, unknown>;
}

/** App-to-app message relayed through the hub (external API `POST /api/v1/messages`). */
export interface AppMessage {
  id: string;
  /** Sender app id (registered by the sending token) or null if the sender isn't registered. */
  from: string | null;
  fromTokenId: string;
  /** Recipient app id, or null = every app that can read it. */
  to: string | null;
  /** App-defined, e.g. 'overlay.create' ([a-z0-9_.-], ≤ 64). */
  type: string;
  /** Profile it concerns (null = not profile-specific). Tokens limited to another profile don't get it. */
  profileId: string | null;
  /** Id of the message this replies to. */
  replyTo: string | null;
  data: Record<string, unknown>;
  ts: string;
}

/** Typed wrapper around EventEmitter. */
export class EventBus {
  private readonly ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(100);
  }

  emit<K extends keyof AppEvents>(event: K, ...args: AppEvents[K]): void {
    this.ee.emit(event, ...args);
  }

  on<K extends keyof AppEvents>(event: K, listener: (...args: AppEvents[K]) => void): () => void {
    this.ee.on(event, listener as (...a: unknown[]) => void);
    return () => this.ee.off(event, listener as (...a: unknown[]) => void);
  }

  once<K extends keyof AppEvents>(event: K, listener: (...args: AppEvents[K]) => void): () => void {
    this.ee.once(event, listener as (...a: unknown[]) => void);
    return () => this.ee.off(event, listener as (...a: unknown[]) => void);
  }
}
