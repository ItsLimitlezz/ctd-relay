// Framework-free live state: reducer for WsServerMessage, the store, and a reconnecting
// WebSocket client. React bindings live in live.tsx.

import type { WsServerMessage } from '@shared/api';
import type { Account, ChatMessage, ChatModeration, ConnectedApp, PairingRequest, SessionState } from '@shared/types';

export const CHAT_LIMIT = 500;
/**
 * The most messages a 'hello' carries (server: `chat.recent(200)` in server/src/http/routes/ws.ts). A
 * shorter snapshot is the server's whole chat buffer. Raising it on the server is safe; lowering it below
 * this would make the client treat a partial snapshot as complete (and drop older messages).
 */
export const HELLO_CHAT_LIMIT = 200;
/** A full snapshot's window starts no later than the newest ts among its first this-many messages. */
export const HELLO_WINDOW_EDGE = 10;
/** How many moderated (removed) message ids are remembered so a later history merge can't re-add them. */
export const REMOVED_CHAT_LIMIT = 1000;
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 15_000;

export interface LiveState {
  /**
   * Profile the socket (and so session, feeds, destinations and chat) is for; null before the first
   * connection. Messages stamped with another profile are ignored.
   */
  profileId: string | null;
  /** WebSocket open and greeted by the server. */
  connected: boolean;
  /** Number of successful connections (hello messages) so far. */
  connections: number;
  session: SessionState | null;
  /** Combined chat, oldest first, capped at CHAT_LIMIT. */
  chat: ChatMessage[];
  /**
   * Ids of messages removed by chat moderation (most recent REMOVED_CHAT_LIMIT). A history snapshot
   * taken before the removal (REST or a reconnect) must not bring them back.
   */
  removedChat: ReadonlySet<string>;
  /** Latest account updates pushed by the server, by id. */
  accounts: Readonly<Record<string, Account>>;
  /** Bumped on every 'account' message and on reconnect. */
  accountsVersion: number;
  /** Bumped on every 'destinations-changed' message and on reconnect. */
  destinationsVersion: number;
  /**
   * Pending app pairings (admins; every profile). null until loaded over REST or pushed. Kept when
   * the profile changes.
   */
  pairings: PairingRequest[] | null;
  /** Bumped on every pushed 'pairings' list, so an older REST answer never replaces a newer push. */
  pairingsSeq: number;
  /** Connected apps (every profile). null until loaded over REST or pushed. Kept when the profile changes. */
  apps: ConnectedApp[] | null;
  /** Bumped on every pushed 'apps' list. */
  appsSeq: number;
}

export const initialLiveState: LiveState = {
  profileId: null,
  connected: false,
  connections: 0,
  session: null,
  chat: [],
  removedChat: new Set(),
  accounts: {},
  accountsVersion: 0,
  destinationsVersion: 0,
  pairings: null,
  pairingsSeq: 0,
  apps: null,
  appsSeq: 0,
};

// ---------------------------------------------------------------------------
// Parsing + reducer
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse one WebSocket frame. Unknown or malformed messages return null (ignored). */
export function parseServerMessage(raw: unknown): WsServerMessage | null {
  if (typeof raw !== 'string') return null;
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(d)) return null;
  switch (d.type) {
    case 'hello':
      // `profiles` is optional here (servers before profiles don't send it).
      return isObject(d.session) && Array.isArray(d.chat) && (d.profiles === undefined || Array.isArray(d.profiles))
        ? (d as WsServerMessage)
        : null;
    case 'profiles':
      return Array.isArray(d.profiles) ? (d as WsServerMessage) : null;
    case 'guest-feed':
      return typeof d.profileId === 'string' && isObject(d.guestFeed) && typeof d.guestFeed.slot === 'string' ? (d as WsServerMessage) : null;
    case 'guest-feeds-changed':
      return typeof d.profileId === 'string' ? (d as WsServerMessage) : null;
    case 'pairings':
      return Array.isArray(d.pairings) ? (d as WsServerMessage) : null;
    case 'apps':
      return Array.isArray(d.apps) ? (d as WsServerMessage) : null;
    case 'session':
      return isObject(d.session) ? (d as WsServerMessage) : null;
    case 'feed':
      return isObject(d.feed) ? (d as WsServerMessage) : null;
    case 'destination':
      return isObject(d.state) ? (d as WsServerMessage) : null;
    case 'chat':
      return isObject(d.message) ? (d as WsServerMessage) : null;
    case 'chat-moderation':
      return isObject(d.moderation) && typeof d.moderation.kind === 'string' && typeof d.moderation.destinationId === 'string'
        ? (d as WsServerMessage)
        : null;
    case 'account':
      return isObject(d.account) ? (d as WsServerMessage) : null;
    case 'destinations-changed':
      return d as WsServerMessage;
    case 'notice':
      return typeof d.message === 'string' ? (d as WsServerMessage) : null;
    default:
      return null;
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set();

function tsOf(m: ChatMessage): number {
  const t = Date.parse(m.ts);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Append new messages (deduplicated by id), keep chronological order, cap the length. Ids in
 * `removed` (moderated messages) are never added back.
 */
export function mergeChat(
  existing: ChatMessage[],
  incoming: readonly ChatMessage[],
  limit = CHAT_LIMIT,
  removed: ReadonlySet<string> = EMPTY_SET,
): ChatMessage[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((m) => m.id));
  const added: ChatMessage[] = [];
  for (const m of incoming) {
    if (seen.has(m.id) || removed.has(m.id)) continue;
    seen.add(m.id);
    added.push(m);
  }
  if (added.length === 0) return existing;
  const merged = existing.concat(added);
  // Fast path: live messages arrive in order. Otherwise (e.g. history after a reconnect) sort.
  let ordered = true;
  for (let i = Math.max(1, existing.length); i < merged.length; i++) {
    if (tsOf(merged[i] as ChatMessage) < tsOf(merged[i - 1] as ChatMessage)) {
      ordered = false;
      break;
    }
  }
  if (!ordered) merged.sort((a, b) => tsOf(a) - tsOf(b));
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}

/** The message's time, or null when it has none we can read. */
function validTs(m: ChatMessage): number | null {
  const t = Date.parse(m.ts);
  return Number.isNaN(t) ? null : t;
}

/**
 * Apply a server chat snapshot (a 'hello'). The server's buffer is the source of truth: chat moderation
 * that happened while the socket was down (sleep, network drop, server restart) shows up only as
 * messages missing from it, so those are dropped here before the snapshot is merged.
 *
 * - A snapshot shorter than HELLO_CHAT_LIMIT is the server's whole buffer: every held message missing
 *   from it is gone on the server (moderated, or the server restarted) and is dropped.
 * - A full snapshot is only the newest messages in server arrival order, and older held messages may
 *   simply have fallen out of it. `ts` is the platform's time, not arrival order (platforms are polled
 *   with different delays), so only held messages that are clearly inside the window are dropped: newer
 *   than the oldest snapshot message of the same destination (one platform's messages arrive in time
 *   order), or, for a destination with nothing in the snapshot, newer than the window's first messages.
 *   A moderation near the start of the window can be missed; a message that was not moderated is not
 *   dropped unless a platform reorders its own messages.
 *
 * Dropped ids are not added to the removed-id memory: they may not have been moderated, and after a
 * server restart a platform can deliver the same messages again.
 */
export function reconcileChat(
  existing: ChatMessage[],
  snapshot: readonly ChatMessage[],
  limit = CHAT_LIMIT,
  removed: ReadonlySet<string> = EMPTY_SET,
): ChatMessage[] {
  const inSnapshot = new Set(snapshot.map((m) => m.id));
  let keep: (m: ChatMessage) => boolean;
  if (snapshot.length < HELLO_CHAT_LIMIT) {
    keep = (m) => inSnapshot.has(m.id);
  } else {
    // Per destination: the time of its first message in the snapshot (snapshot order = arrival order).
    const marks = new Map<string, number>();
    let start: number | null = null;
    for (let i = 0; i < snapshot.length; i++) {
      const m = snapshot[i] as ChatMessage;
      const t = validTs(m);
      if (t === null) continue;
      if (!marks.has(m.destinationId)) marks.set(m.destinationId, t);
      if (i < HELLO_WINDOW_EDGE) start = start === null ? t : Math.max(start, t);
    }
    const windowStart = start;
    keep = (m) => {
      if (inSnapshot.has(m.id)) return true;
      const t = validTs(m);
      const mark = marks.get(m.destinationId) ?? windowStart;
      // Unknown times: keep (never drop a message we can't place).
      return t === null || mark === null || t <= mark;
    };
  }
  const kept = existing.filter(keep);
  return mergeChat(kept.length === existing.length ? existing : kept, snapshot, limit, removed);
}

/**
 * Does `msg` belong to the user a 'user-cleared' moderation names? Same rule as the server's chat hub:
 * ids win when both sides have one; otherwise the display name or login, case-insensitively.
 */
export function messageFromUser(msg: Pick<ChatMessage, 'author'>, userId: string | null, userName: string | null): boolean {
  const author = msg.author ?? {};
  if (userId && author.id) return author.id === userId;
  if (!userName) return false;
  const name = userName.toLowerCase();
  const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : null);
  return lower(author.name) === name || lower(author.login) === name;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Whether a moderation event removes this message. Always scoped to the moderated destination. */
export function moderationRemoves(mod: ChatModeration, m: ChatMessage): boolean {
  if (m.destinationId !== mod.destinationId) return false;
  switch (mod.kind) {
    case 'message-deleted': {
      const messageId = str(mod.messageId);
      const platformMessageId = str(mod.platformMessageId);
      if (messageId !== null && m.id === messageId) return true;
      if (platformMessageId === null) return false;
      // Hub ids are "<platform>:<platform message id>" when the driver gave no explicit id.
      return m.platformMessageId === platformMessageId || m.id === `${mod.platform}:${platformMessageId}`;
    }
    case 'user-cleared':
      return m.platform === mod.platform && messageFromUser(m, str(mod.userId), str(mod.userName));
    case 'cleared':
      return true;
    default:
      return false;
  }
}

/**
 * Remove what a moderation event removed: one message, one user's messages, or a destination's
 * whole chat. Returns the same array when nothing matched.
 */
export function applyModeration(chat: ChatMessage[], mod: ChatModeration): { chat: ChatMessage[]; removedIds: string[] } {
  const removedIds: string[] = [];
  const kept = chat.filter((m) => {
    if (!moderationRemoves(mod, m)) return true;
    removedIds.push(m.id);
    return false;
  });
  return removedIds.length ? { chat: kept, removedIds } : { chat, removedIds };
}

/** Remember removed ids (bounded, oldest forgotten first). */
export function rememberRemoved(removed: ReadonlySet<string>, ids: readonly string[], limit = REMOVED_CHAT_LIMIT): ReadonlySet<string> {
  if (ids.length === 0) return removed;
  const next = new Set(removed);
  for (const id of ids) {
    next.delete(id);
    next.add(id);
  }
  for (const id of next) {
    if (next.size <= limit) break;
    next.delete(id);
  }
  return next;
}

function upsert<T>(list: readonly T[], item: T, same: (x: T) => boolean): T[] {
  const i = list.findIndex(same);
  if (i === -1) return [...list, item];
  const copy = list.slice();
  copy[i] = item;
  return copy;
}

/**
 * Whether something stamped with `profileId` belongs to the store's profile. Unstamped data (older
 * servers) and a store without a profile accept everything.
 */
export function sameProfile(state: Pick<LiveState, 'profileId'>, profileId: string | null | undefined): boolean {
  return !profileId || !state.profileId || profileId === state.profileId;
}

export function reduceLive(state: LiveState, msg: WsServerMessage): LiveState {
  switch (msg.type) {
    case 'profiles':
      // Every profile's summary: handled by the profile provider, not stored here.
      return state;
    case 'pairings':
      return { ...state, pairings: msg.pairings, pairingsSeq: state.pairingsSeq + 1 };
    case 'apps':
      return { ...state, apps: msg.apps, appsSeq: state.appsSeq + 1 };
    case 'hello': {
      // On a reconnect, anything may have changed while we were away: let pages refetch.
      const bump = state.connections > 0 ? 1 : 0;
      return {
        ...state,
        connections: state.connections + 1,
        session: msg.session,
        // Reconciled, not just merged: messages moderated while we were away are missing from it.
        chat: reconcileChat(state.chat, msg.chat, CHAT_LIMIT, state.removedChat),
        accountsVersion: state.accountsVersion + bump,
        destinationsVersion: state.destinationsVersion + bump,
      };
    }
    case 'session':
      if (!sameProfile(state, msg.session.profileId)) return state;
      return { ...state, session: msg.session };
    case 'feed':
      if (!state.session || !sameProfile(state, msg.feed.profileId)) return state;
      return {
        ...state,
        session: { ...state.session, feeds: upsert(state.session.feeds, msg.feed, (f) => f.feed === msg.feed.feed) },
      };
    case 'destination':
      if (!state.session || !sameProfile(state, msg.state.profileId)) return state;
      return {
        ...state,
        session: {
          ...state.session,
          destinations: upsert(
            state.session.destinations,
            msg.state,
            (d) => d.destinationId === msg.state.destinationId,
          ),
        },
      };
    case 'chat': {
      if (!sameProfile(state, msg.message.profileId)) return state;
      const chat = mergeChat(state.chat, [msg.message], CHAT_LIMIT, state.removedChat);
      return chat === state.chat ? state : { ...state, chat };
    }
    case 'chat-moderation': {
      if (!sameProfile(state, msg.moderation.profileId)) return state;
      const { chat, removedIds } = applyModeration(state.chat, msg.moderation);
      // A deleted message we never received (or already dropped) is remembered too, by both id forms.
      const ids = removedIds.slice();
      if (msg.moderation.kind === 'message-deleted') {
        const m = msg.moderation;
        if (typeof m.messageId === 'string' && m.messageId) ids.push(m.messageId);
        if (typeof m.platformMessageId === 'string' && m.platformMessageId) ids.push(`${m.platform}:${m.platformMessageId}`);
      }
      const removedChat = rememberRemoved(state.removedChat, ids);
      if (chat === state.chat && removedChat === state.removedChat) return state;
      return { ...state, chat, removedChat };
    }
    case 'account':
      return {
        ...state,
        accounts: { ...state.accounts, [msg.account.id]: msg.account },
        accountsVersion: state.accountsVersion + 1,
      };
    case 'destinations-changed':
      return { ...state, destinationsVersion: state.destinationsVersion + 1 };
    case 'notice':
      return state;
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class LiveStore {
  private state: LiveState = initialLiveState;
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(msg: WsServerMessage) => void>();

  getState = (): LiveState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Raw message listeners (called after the state is updated). */
  onEvent = (listener: (msg: WsServerMessage) => void): (() => void) => {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  };

  dispatch(msg: WsServerMessage): void {
    this.set(reduceLive(this.state, msg));
    for (const l of this.eventListeners) {
      try {
        l(msg);
      } catch (err) {
        console.error('live event listener failed', err);
      }
    }
  }

  setConnected(connected: boolean): void {
    if (this.state.connected !== connected) this.set({ ...this.state, connected });
  }

  /**
   * Start showing `profileId`: its session, chat and accounts start empty (the next 'hello' fills
   * them); pairings and connected apps (shared by every profile) are kept.
   */
  startProfile(profileId: string): void {
    const s = this.state;
    if (s.profileId === profileId && s.connections === 0 && s.session === null) return;
    this.set({ ...initialLiveState, profileId, pairings: s.pairings, pairingsSeq: s.pairingsSeq, apps: s.apps, appsSeq: s.appsSeq });
  }

  /**
   * Apply a SessionState returned by a REST call (e.g. start/stop). `profileId` = the profile the
   * caller asked about: an answer that arrives after a profile switch is dropped.
   */
  applySession(session: SessionState, profileId?: string): void {
    if (!sameProfile(this.state, profileId) || !sameProfile(this.state, session.profileId)) return;
    this.set({ ...this.state, session });
  }

  /** Use a REST snapshot only while the WebSocket hasn't delivered one yet. */
  seedSession(session: SessionState, profileId?: string): void {
    if (!this.state.session) this.applySession(session, profileId);
  }

  /** Merge fields into the current session (e.g. the title after a successful update). */
  patchSession(patch: Partial<SessionState>, profileId?: string): void {
    if (this.state.session && sameProfile(this.state, profileId)) this.applySession({ ...this.state.session, ...patch }, profileId);
  }

  mergeChat(messages: readonly ChatMessage[], profileId?: string): void {
    if (!sameProfile(this.state, profileId)) return;
    const mine = messages.filter((m) => sameProfile(this.state, m.profileId));
    const chat = mergeChat(this.state.chat, mine, CHAT_LIMIT, this.state.removedChat);
    if (chat !== this.state.chat) this.set({ ...this.state, chat });
  }

  /**
   * Load pairings over REST. Ignored when a pushed list arrived while the request was in flight
   * (the push is newer). Rejects with the request's error.
   */
  async loadPairings(fetch: () => Promise<PairingRequest[]>): Promise<void> {
    const seq = this.state.pairingsSeq;
    const list = await fetch();
    if (this.state.pairingsSeq === seq) this.set({ ...this.state, pairings: list });
  }

  /** Load connected apps over REST (same rule as loadPairings). */
  async loadApps(fetch: () => Promise<ConnectedApp[]>): Promise<void> {
    const seq = this.state.appsSeq;
    const list = await fetch();
    if (this.state.appsSeq === seq) this.set({ ...this.state, apps: list });
  }

  reset(): void {
    this.set(initialLiveState);
  }

  private set(next: LiveState): void {
    if (next === this.state) return;
    this.state = next;
    for (const l of this.listeners) l();
  }
}

// ---------------------------------------------------------------------------
// Reconnecting WebSocket client
// ---------------------------------------------------------------------------

/** The subset of WebSocket we use (lets tests inject a fake). */
export interface SocketLike {
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}

export interface LiveConnectionOptions {
  url: () => string;
  onMessage: (msg: WsServerMessage) => void;
  onConnectedChange: (connected: boolean) => void;
  /**
   * Called before reconnecting when the previous attempt never got a 'hello' (upgrade
   * rejected or server down). Resolve false to stop for good (session expired).
   */
  checkAuth?: () => Promise<boolean>;
  createSocket?: (url: string) => SocketLike;
}

/** 1 s, 2 s, 4 s, 8 s, then 15 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, Math.min(attempt, 10)));
}

const defaultCreateSocket = (url: string): SocketLike => new WebSocket(url) as unknown as SocketLike;

export class LiveConnection {
  private socket: SocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = true;
  private greeted = false;
  private connected = false;
  /** Generation counter so late async callbacks from an old attempt are ignored. */
  private gen = 0;

  constructor(private readonly opts: LiveConnectionOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.gen++;
    this.clearTimer();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close(1000, 'bye');
      } catch {
        /* already closed */
      }
    }
    this.setConnected(false);
  }

  /** Reconnect right away if we're waiting to retry (network back, tab visible again). */
  kick(): void {
    if (this.stopped || this.socket || !this.timer) return;
    this.clearTimer();
    this.attempt = 0;
    this.open();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private open(): void {
    const gen = ++this.gen;
    this.greeted = false;
    let s: SocketLike;
    try {
      s = (this.opts.createSocket ?? defaultCreateSocket)(this.opts.url());
    } catch {
      this.scheduleReconnect(gen);
      return;
    }
    this.socket = s;
    const current = () => gen === this.gen && this.socket === s;
    s.onmessage = (ev) => {
      if (!current()) return;
      const msg = parseServerMessage(ev.data);
      if (!msg) return;
      if (msg.type === 'hello') {
        this.greeted = true;
        this.attempt = 0;
        this.setConnected(true);
      }
      this.opts.onMessage(msg);
    };
    s.onclose = (ev) => {
      if (!current()) return;
      this.socket = null;
      // 4401 = the server ended our session (logout, expiry, user removed): re-check auth before
      // reconnecting, which sends the app to the login page.
      if ((ev as { code?: number } | null)?.code === 4401) this.greeted = false;
      this.setConnected(false);
      this.scheduleReconnect(gen);
    };
    s.onerror = () => {
      /* 'close' always follows */
    };
  }

  private scheduleReconnect(gen: number): void {
    if (this.stopped) return;
    const needsAuthCheck = !this.greeted && this.opts.checkAuth !== undefined;
    const delay = reconnectDelay(this.attempt++);
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped || gen !== this.gen) return;
      if (!needsAuthCheck || !this.opts.checkAuth) {
        this.open();
        return;
      }
      this.opts.checkAuth().then(
        (ok) => {
          if (this.stopped || gen !== this.gen || this.socket) return;
          if (ok) this.open();
          else this.stop();
        },
        () => {
          if (!this.stopped && gen === this.gen && !this.socket) this.open();
        },
      );
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.opts.onConnectedChange(connected);
  }
}
