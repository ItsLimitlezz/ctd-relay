// Read-only Twitch chat over IRC-over-WebSocket, logged in anonymously.
// Docs: https://dev.twitch.tv/docs/chat/irc/ (wss://irc-ws.chat.twitch.tv:443, PING/PONG, RECONNECT).
// Anonymous read-only login (NICK justinfan<digits>, any PASS) is the long-standing convention
// used by tmi.js and Twitch's own web player; it needs no token or scope.
// Reconnecting is the ChatHub's job: this source throws (or ends) when the connection closes.

import { randomInt } from 'node:crypto';
import type { Logger } from 'pino';
import type { ChatSourceItem } from '../types.js';
import { GiftBombFilter, ircToChat, parseIrcLine } from './irc.js';

export const IRC_WS_URL = 'wss://irc-ws.chat.twitch.tv:443';

/** Twitch login names: lowercase letters, digits, underscore. Also guards against IRC injection. */
const LOGIN_RE = /^[a-z0-9_]{1,25}$/;
const WS_OPEN = 1;
/** Messages buffered while the consumer is busy; older ones are dropped beyond this. */
const MAX_BUFFERED = 1000;

export interface TwitchChatOptions {
  /** Override the server (tests). */
  url?: string;
  WebSocketImpl?: typeof WebSocket;
  connectTimeoutMs?: number;
  /** We PING the server this often (and check for silence). */
  pingIntervalMs?: number;
  /** Close the connection when nothing arrived for this long. */
  idleTimeoutMs?: number;
  log?: Logger;
}

export function isValidLogin(login: string): boolean {
  return LOGIN_RE.test(login);
}

/** Single-consumer async queue: values in order, then end or an error. */
export class Inbox<T> {
  private readonly items: T[] = [];
  private waiter: { resolve: (r: IteratorResult<T, undefined>) => void; reject: (err: unknown) => void } | null = null;
  private closed: { error: unknown } | null = null;

  push(item: T): void {
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve({ value: item, done: false });
      return;
    }
    this.items.push(item);
    if (this.items.length > MAX_BUFFERED) this.items.shift();
  }

  /** Ends the stream; with an error, the consumer gets it after the buffered items. */
  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = { error };
    const w = this.waiter;
    this.waiter = null;
    if (!w) return;
    if (error !== undefined) w.reject(error);
    else w.resolve({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<T, undefined>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.closed) {
      return this.closed.error !== undefined
        ? Promise.reject(this.closed.error)
        : Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
}

/**
 * Yield chat messages and moderation (deleted messages, bans/timeouts, cleared chat) of
 * `#channelLogin` until `signal` aborts (then it returns) or the connection fails (then it throws,
 * so the ChatHub reconnects with backoff).
 */
export async function* readTwitchChat(
  channelLogin: string,
  signal: AbortSignal,
  opts: TwitchChatOptions = {},
): AsyncGenerator<ChatSourceItem, void, undefined> {
  const channel = channelLogin.trim().toLowerCase();
  if (!isValidLogin(channel)) throw new Error('Invalid Twitch channel name for chat');
  if (signal.aborted) return;

  const connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
  const pingIntervalMs = opts.pingIntervalMs ?? 60_000;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 150_000;
  const WS = opts.WebSocketImpl ?? WebSocket;

  const inbox = new Inbox<ChatSourceItem>();
  const giftBombs = new GiftBombFilter();
  const ws = new WS(opts.url ?? IRC_WS_URL);
  let opened = false;
  let lastActivity = Date.now();

  const send = (line: string): void => {
    if (ws.readyState !== WS_OPEN) return;
    try {
      ws.send(`${line}\r\n`);
    } catch (err) {
      inbox.close(err);
    }
  };

  const onLine = (line: string): void => {
    const msg = parseIrcLine(line);
    if (!msg) return;
    switch (msg.command) {
      case 'PING':
        send(`PONG :${msg.params[0] ?? 'tmi.twitch.tv'}`);
        return;
      case 'RECONNECT':
        inbox.close(new Error('Twitch chat server asked to reconnect'));
        return;
      case 'NOTICE': {
        const text = msg.params[1] ?? '';
        if (/login authentication failed|improperly formatted auth|invalid nick/i.test(text)) {
          inbox.close(new Error(`Twitch chat login failed: ${text.slice(0, 200)}`));
        } else {
          opts.log?.debug({ notice: msg.tags['msg-id'] ?? null }, 'twitch chat notice');
        }
        return;
      }
      default: {
        const item = giftBombs.apply(msg, ircToChat(msg));
        if (item) inbox.push(item);
      }
    }
  };

  const onOpen = (): void => {
    opened = true;
    clearTimeout(connectTimer);
    lastActivity = Date.now();
    send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    send('PASS SCHMOOPIIE');
    send(`NICK justinfan${randomInt(10_000, 99_999_999)}`);
    send(`JOIN #${channel}`);
  };
  const onMessage = (ev: MessageEvent): void => {
    lastActivity = Date.now();
    if (typeof ev.data !== 'string') return;
    for (const line of ev.data.split(/\r?\n/)) if (line) onLine(line);
  };
  const onClose = (ev: CloseEvent): void => {
    inbox.close(signal.aborted ? undefined : new Error(`Twitch chat disconnected (code ${ev.code})`));
  };
  const onError = (): void => {
    inbox.close(new Error(opened ? 'Twitch chat connection error' : 'Could not connect to Twitch chat'));
  };
  const onAbort = (): void => inbox.close();

  ws.addEventListener('open', onOpen);
  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', onClose);
  ws.addEventListener('error', onError);
  signal.addEventListener('abort', onAbort, { once: true });

  const connectTimer = setTimeout(() => {
    if (!opened) inbox.close(new Error('Connecting to Twitch chat timed out'));
  }, connectTimeoutMs);
  const pingTimer = setInterval(() => {
    if (!opened) return;
    if (Date.now() - lastActivity >= idleTimeoutMs) inbox.close(new Error('Twitch chat connection went silent'));
    else send('PING :tmi.twitch.tv');
  }, pingIntervalMs);
  pingTimer.unref?.();

  try {
    for (;;) {
      const next = await inbox.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    clearTimeout(connectTimer);
    clearInterval(pingTimer);
    signal.removeEventListener('abort', onAbort);
    ws.removeEventListener('open', onOpen);
    ws.removeEventListener('message', onMessage);
    ws.removeEventListener('close', onClose);
    ws.removeEventListener('error', onError);
    try {
      ws.close(1000);
    } catch {
      /* already closed */
    }
  }
}
