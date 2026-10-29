// Twitch EventSub over WebSocket: what Twitch never says in IRC chat (follows), as chat alerts.
// Docs: https://dev.twitch.tv/docs/eventsub/handling-websocket-events/
// - Connect to wss://eventsub.wss.twitch.tv/ws; the first message is session_welcome with a
//   session id, which must get a subscription (POST /helix/eventsub/subscriptions, transport
//   {method:'websocket', session_id}) within 10 s or Twitch closes the socket (4003).
// - session_keepalive arrives when nothing else did for keepalive_timeout_seconds; silence beyond
//   that means the connection is dead.
// - session_reconnect carries a reconnect_url: connect to it, and once its welcome arrives close the
//   old socket. Subscriptions move over by themselves (no new POST).
// - notification: metadata.message_id may be delivered more than once (dedupe), payload.event.
// - revocation: the subscription is gone (authorization_revoked, user_removed, version_removed).
// channel.follow v2: condition {broadcaster_user_id, moderator_user_id}, scope moderator:read:followers;
// event {user_id, user_login, user_name, broadcaster_user_id, followed_at}.
//
// Unlike IRC chat, this source never throws: it reconnects with its own backoff, and ends quietly
// when Twitch refuses the subscription (missing permission). Chat keeps working either way.

import type { Logger } from 'pino';
import { PlatformHttpError } from '../common/http.js';
import type { ChatMessageInput, ChatSourceItem } from '../types.js';
import { Inbox } from './chat.js';

export const EVENTSUB_WS_URL = 'wss://eventsub.wss.twitch.tv/ws';

/** The body of POST /helix/eventsub/subscriptions (without the transport). */
export interface EventSubSubscription {
  type: string;
  version: string;
  condition: Record<string, string>;
}

export interface TwitchEventsOptions {
  /** The channel (also the moderator: the broadcaster moderates their own channel). */
  broadcasterId: string;
  /** Create one subscription on `sessionId` (TwitchClient.subscribeEventSub). */
  subscribe(sessionId: string, sub: EventSubSubscription): Promise<void>;
  /** Override the server (tests). */
  url?: string;
  WebSocketImpl?: typeof WebSocket;
  /** For the welcome to arrive (and for a reconnect_url's welcome). */
  connectTimeoutMs?: number;
  /** Extra silence allowed beyond Twitch's keepalive_timeout_seconds. */
  keepaliveGraceMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  log?: Logger;
}

/** Twitch refused the subscription for good (permission, ineligible): stop retrying. */
class Refused extends Error {}

const WS_OPEN = 1;
const SEEN_IDS = 500;
/** A user who follows again (unfollow + follow) within this long gets no second alert. */
export const REFOLLOW_QUIET_MS = 6 * 60 * 60 * 1000;
const MAX_REMEMBERED_FOLLOWS = 5000;
/** `${broadcasterId}:${userId}` -> when their follow alert went out (survives reconnects). */
const recentFollows = new Map<string, number>();

export function followSubscription(broadcasterId: string): EventSubSubscription {
  return {
    type: 'channel.follow',
    version: '2',
    condition: { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId },
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** True the first time `userId` follows `broadcasterId` within REFOLLOW_QUIET_MS. */
function freshFollow(broadcasterId: string, userId: string, now = Date.now()): boolean {
  const key = `${broadcasterId}:${userId}`;
  const at = recentFollows.get(key);
  if (at !== undefined && now - at < REFOLLOW_QUIET_MS) return false;
  if (recentFollows.size >= MAX_REMEMBERED_FOLLOWS) {
    for (const [k, t] of recentFollows) if (now - t >= REFOLLOW_QUIET_MS) recentFollows.delete(k);
    if (recentFollows.size >= MAX_REMEMBERED_FOLLOWS) recentFollows.delete(recentFollows.keys().next().value!);
  }
  recentFollows.set(key, now);
  return true;
}

/** Forget remembered follows (tests). */
export function forgetFollows(): void {
  recentFollows.clear();
}

/** A channel.follow event -> an event line with a `follow` alert (null when unusable or a quick re-follow). */
export function followToChat(event: unknown, messageId: string): ChatMessageInput | null {
  const e = (event ?? {}) as Record<string, unknown>;
  const userId = str(e.user_id);
  const name = str(e.user_name) || str(e.user_login);
  if (!userId || !name) return null;
  if (!freshFollow(str(e.broadcaster_user_id), userId)) return null;
  const login = str(e.user_login).toLowerCase();
  const input: ChatMessageInput = {
    author: { name, id: userId, ...(login ? { login } : {}) },
    text: `${name} followed`,
    kind: 'event',
    alert: { kind: 'follow', user: { id: userId, name } },
  };
  if (messageId) input.id = `follow-${messageId}`;
  const ts = Date.parse(str(e.followed_at));
  if (Number.isFinite(ts)) input.ts = new Date(ts).toISOString();
  return input;
}

interface Envelope {
  metadata?: { message_id?: string; message_type?: string; subscription_type?: string };
  payload?: {
    session?: { id?: string; keepalive_timeout_seconds?: number | null; reconnect_url?: string | null };
    subscription?: { type?: string; status?: string };
    event?: unknown;
  };
}

/**
 * One EventSub session (following reconnect_urls) until it fails: items go to `out`, failures
 * close `out` with an error (a Refused one when retrying won't help). Returns the cleanup.
 */
function runSession(opts: TwitchEventsOptions, out: Inbox<ChatSourceItem>, onWelcome: () => void): () => void {
  const WS = opts.WebSocketImpl ?? WebSocket;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
  const graceMs = opts.keepaliveGraceMs ?? 5_000;
  const seen: string[] = [];
  let current: WebSocket | null = null;
  let pending: WebSocket | null = null;
  let keepaliveMs = 0;
  let lastActivity = Date.now();
  let subscribed = false;
  let welcomeTimer: ReturnType<typeof setTimeout> | undefined;

  const fail = (err: Error): void => out.close(err);

  const onNotification = (env: Envelope): void => {
    const id = str(env.metadata?.message_id);
    if (id) {
      if (seen.includes(id)) return;
      seen.push(id);
      if (seen.length > SEEN_IDS) seen.shift();
    }
    if (env.metadata?.subscription_type === 'channel.follow') {
      const item = followToChat(env.payload?.event, id);
      if (item) out.push(item);
    }
  };

  const subscribeAll = async (sessionId: string): Promise<void> => {
    try {
      await opts.subscribe(sessionId, followSubscription(opts.broadcasterId));
    } catch (err) {
      if (err instanceof PlatformHttpError && err.status === 409) return; // already subscribed
      if (err instanceof PlatformHttpError && (err.status === 400 || err.status === 401 || err.status === 403)) {
        fail(new Refused(`Twitch refused follow alerts (HTTP ${err.status})`));
        return;
      }
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const open = (url: string): void => {
    const ws = new WS(url);
    pending = ws;
    clearTimeout(welcomeTimer);
    welcomeTimer = setTimeout(() => fail(new Error('Twitch EventSub did not welcome us in time')), connectTimeoutMs);

    ws.addEventListener('message', (ev: MessageEvent) => {
      if (ws !== current && ws !== pending) return;
      lastActivity = Date.now();
      if (typeof ev.data !== 'string') return;
      let env: Envelope;
      try {
        env = JSON.parse(ev.data) as Envelope;
      } catch {
        return;
      }
      switch (env.metadata?.message_type) {
        case 'session_welcome': {
          if (ws !== pending) return;
          clearTimeout(welcomeTimer);
          const old = current;
          current = ws;
          pending = null;
          keepaliveMs = Math.max(0, Number(env.payload?.session?.keepalive_timeout_seconds) || 0) * 1000;
          if (old) closeQuietly(old);
          onWelcome();
          const sessionId = str(env.payload?.session?.id);
          if (!subscribed && sessionId) {
            subscribed = true;
            void subscribeAll(sessionId);
          }
          return;
        }
        case 'session_reconnect': {
          const next = str(env.payload?.session?.reconnect_url);
          // Plain ws:// only when we were pointed at one (the tests' fake server).
          const allowed = next.startsWith('wss://') || (next.startsWith('ws://') && !!opts.url?.startsWith('ws://'));
          if (ws === current && allowed) open(next);
          return;
        }
        case 'notification':
          onNotification(env);
          return;
        case 'revocation':
          opts.log?.warn({ type: env.payload?.subscription?.type, status: env.payload?.subscription?.status }, 'twitch eventsub: subscription revoked');
          fail(new Refused(`Twitch revoked the ${str(env.payload?.subscription?.type) || 'event'} subscription`));
          return;
        default:
          return; // session_keepalive (activity already noted)
      }
    });
    ws.addEventListener('close', (ev: CloseEvent) => {
      // The old socket closing after a reconnect is expected.
      if (ws === pending || (ws === current && pending === null)) fail(new Error(`Twitch EventSub disconnected (code ${ev.code})`));
    });
    ws.addEventListener('error', () => {
      if (ws === pending || (ws === current && pending === null)) fail(new Error('Twitch EventSub connection error'));
    });
  };

  open(opts.url ?? EVENTSUB_WS_URL);
  const watchdog = setInterval(() => {
    if (current && keepaliveMs > 0 && Date.now() - lastActivity > keepaliveMs + graceMs) {
      fail(new Error('Twitch EventSub went silent'));
    }
  }, 1_000);
  watchdog.unref?.();

  return () => {
    clearTimeout(welcomeTimer);
    clearInterval(watchdog);
    for (const ws of [current, pending]) if (ws) closeQuietly(ws);
    current = null;
    pending = null;
  };
}

function closeQuietly(ws: WebSocket): void {
  try {
    if (ws.readyState === WS_OPEN || ws.readyState === 0) ws.close(1000);
  } catch {
    /* already closed */
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Yield follow alerts of `opts.broadcasterId` until `signal` aborts. Reconnects by itself (1 s
 * doubling to 60 s, reset after a welcome); ends quietly when Twitch refuses the subscription.
 */
export async function* readTwitchEvents(opts: TwitchEventsOptions, signal: AbortSignal): AsyncGenerator<ChatSourceItem, void, undefined> {
  const minMs = opts.backoffMinMs ?? 1_000;
  const maxMs = opts.backoffMaxMs ?? 60_000;
  let backoff = minMs;
  while (!signal.aborted) {
    const inbox = new Inbox<ChatSourceItem>();
    const onAbort = (): void => inbox.close();
    signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = runSession(opts, inbox, () => {
      backoff = minMs;
    });
    try {
      for (;;) {
        const next = await inbox.next();
        if (next.done) break;
        yield next.value;
      }
    } catch (err) {
      if (err instanceof Refused) {
        opts.log?.warn({ error: err.message }, 'twitch eventsub: follow alerts are off for this live');
        return;
      }
      opts.log?.info({ error: err instanceof Error ? err.message : String(err), retryInMs: backoff }, 'twitch eventsub: reconnecting');
    } finally {
      cleanup();
      signal.removeEventListener('abort', onAbort);
    }
    if (signal.aborted) return;
    await sleep(backoff, signal);
    backoff = Math.min(maxMs, backoff * 2);
  }
}

/**
 * Items of `main` and `side` as they come. Ends (or throws) when `main` does; `side` ending or
 * failing only stops `side`. Both get a signal that aborts when the consumer stops.
 */
export async function* withSideSource<T>(
  main: (signal: AbortSignal) => AsyncIterable<T>,
  side: (signal: AbortSignal) => AsyncIterable<T>,
  signal: AbortSignal,
  log?: Logger,
): AsyncGenerator<T, void, undefined> {
  const inner = new AbortController();
  const stop = (): void => inner.abort();
  if (signal.aborted) return;
  signal.addEventListener('abort', stop, { once: true });
  const inbox = new Inbox<T>();
  void (async () => {
    try {
      for await (const item of main(inner.signal)) inbox.push(item);
      inbox.close();
    } catch (err) {
      inbox.close(err);
    }
  })();
  void (async () => {
    try {
      for await (const item of side(inner.signal)) inbox.push(item);
    } catch (err) {
      log?.warn({ error: err instanceof Error ? err.message : String(err) }, 'twitch: side chat source failed');
    }
  })();
  try {
    for (;;) {
      const next = await inbox.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    signal.removeEventListener('abort', stop);
    inner.abort();
  }
}
