// Chat aggregation: runs each live destination's chat source, normalizes and de-duplicates
// messages, keeps a ring buffer of recent ones and emits them on the EventBus. Sources may also
// yield moderation (deleted message, banned/timed-out user, cleared chat): the affected messages
// leave the ring buffer and a 'chat-moderation' event tells overlays/clients to remove them.
//
// Profiles: every destination belongs to one profile (attach's `profileId`). Messages and
// moderation are stamped with it, and each profile has its own ring buffer, de-duplication and
// OBS chat overlay token (secret scope profileSecretScope(id, 'chat'): the default profile keeps
// the pre-profiles 'chat' scope, so its existing overlay URL keeps working).

import type { Logger } from 'pino';
import { DEFAULT_PROFILE_ID, type ChatMessage, type ChatModeration, type PlatformId } from '../../../shared/types.js';
import type { EventBus } from '../events.js';
import { isChatModeration, type ChatMessageInput, type ChatModerationInput, type ChatSourceItem } from '../platforms/types.js';
import { profileSecretScope, type ChatHub, type ProfilesRepo, type ScopedSecrets, type SecretsRepo } from '../services.js';
import { RecentKeys, RingBuffer } from './buffers.js';
import { MAX_AUTHOR_LENGTH, cleanText, normalizeChatMessage } from './normalize.js';
import { safeErrorMessage } from './redact.js';
import { generateOverlayToken, tokensEqual } from './token.js';

/** Per profile. */
export const RING_SIZE = 500;
/** Per profile. */
export const DEDUPE_SIZE = 2000;
export const DEFAULT_RECENT = 200;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** A source that streamed this long before failing restarts with the minimum backoff again. */
export const HEALTHY_RESET_MS = 60_000;

const TOKEN_KEY = 'overlayToken';
const MIN_STORED_TOKEN_LENGTH = 32;
const MAX_MODERATION_ID_LENGTH = 200;

export interface ChatHubDeps {
  bus: EventBus;
  log: Logger;
  /**
   * Where overlay tokens are stored. Pass the secrets repo (`repos.secrets`): each profile then
   * gets its own persisted token in scope profileSecretScope(id, 'chat'). A single ScopedSecrets
   * (the legacy 'chat' scope, as before profiles) still serves the default profile; other
   * profiles' tokens then only live in memory (they change on restart) and a warning is logged.
   */
  secrets: SecretsRepo | ScopedSecrets;
  /**
   * Profiles (`repos.profiles`): lets profileForOverlayToken() find tokens of every profile after a
   * restart, refuses tokens for unknown profiles, and drops a deleted profile's chat + token.
   * Without it only the default profile and profiles used since start are known.
   */
  profiles?: Pick<ProfilesRepo, 'list' | 'get'>;
}

/** One profile's chat: ring buffer, de-duplication and the platform-id index for moderation. */
interface ProfileChat {
  buffer: RingBuffer<ChatMessage>;
  seen: RecentKeys;
  /** destination + platform message id -> hub message id (bounded, insertion order). */
  byPlatformId: Map<string, string>;
}

function isSecretsRepo(s: SecretsRepo | ScopedSecrets): s is SecretsRepo {
  return typeof (s as Partial<SecretsRepo>).scoped === 'function';
}

function unknownProfileError(): Error {
  return Object.assign(new Error('Profile not found'), { statusCode: 404, code: 'unknown_profile' });
}

type ChatSource = (signal: AbortSignal) => AsyncIterable<ChatSourceItem>;

const ABORTED = Symbol('aborted');

/** Resolves with ABORTED once the signal fires (or immediately if it already has). */
function abortPromise(signal: AbortSignal): { promise: Promise<typeof ABORTED>; dispose(): void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<typeof ABORTED>((resolve) => {
    if (signal.aborted) {
      resolve(ABORTED);
      return;
    }
    onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    promise,
    dispose: () => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    },
  };
}

/** Sleep that ends early (without throwing) when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Consume one run of a source until it ends, throws, or the signal aborts. Iterates manually
 * so an abort stops us promptly even if the source ignores its signal.
 */
async function consume(source: ChatSource, signal: AbortSignal, onItem: (m: ChatSourceItem) => void): Promise<void> {
  const it = source(signal)[Symbol.asyncIterator]();
  const aborted = abortPromise(signal);
  let finished = false;
  try {
    while (!signal.aborted) {
      const next = it.next();
      next.catch(() => {}); // the race may abandon this promise; never leave it unhandled
      let result: IteratorResult<ChatSourceItem> | typeof ABORTED;
      try {
        result = await Promise.race([next, aborted.promise]);
      } catch (err) {
        finished = true;
        throw err;
      }
      if (result === ABORTED || signal.aborted) return;
      if (result.done) {
        finished = true;
        return;
      }
      onItem(result.value);
    }
  } finally {
    aborted.dispose();
    // Ask an abandoned iterator to clean up (close sockets...). Not awaited: a stuck source must not block us.
    if (!finished && typeof it.return === 'function') {
      const ret = it.return.bind(it);
      Promise.resolve()
        .then(() => ret())
        .catch(() => {});
    }
  }
}

/** The platform's own id for a stored message (explicit, else the unprefixed hub id). */
function platformIdOf(msg: ChatMessage): string {
  return msg.platformMessageId ?? msg.id.slice(msg.platform.length + 1);
}

const indexKey = (destinationId: string, platformMessageId: string) => `${destinationId}\n${platformMessageId}`;

/** Does `msg` belong to the user a 'user-cleared' moderation names? Ids win; names are case-insensitive. */
export function messageFromUser(msg: Pick<ChatMessage, 'author'>, userId: string | null, userName: string | null): boolean {
  if (userId && msg.author.id) return msg.author.id === userId;
  if (userId && !userName) return false;
  if (!userName) return false;
  const name = userName.toLowerCase();
  return msg.author.name.toLowerCase() === name || msg.author.login?.toLowerCase() === name;
}

/** The message with its profile, placed right after the destination it came from. */
function withProfile(msg: ChatMessage, profileId: string): ChatMessage {
  const { id, platform, destinationId, ...rest } = msg;
  return { id, platform, destinationId, profileId, ...rest };
}

export function createChatHub({ bus, log, secrets, profiles }: ChatHubDeps): ChatHub {
  const chats = new Map<string, ProfileChat>();
  const attachments = new Map<string, AbortController>();

  function chatOf(profileId: string): ProfileChat {
    let chat = chats.get(profileId);
    if (!chat) {
      chat = { buffer: new RingBuffer<ChatMessage>(RING_SIZE), seen: new RecentKeys(DEDUPE_SIZE), byPlatformId: new Map() };
      chats.set(profileId, chat);
    }
    return chat;
  }

  function index(chat: ProfileChat, msg: ChatMessage): void {
    const key = indexKey(msg.destinationId, platformIdOf(msg));
    chat.byPlatformId.delete(key);
    chat.byPlatformId.set(key, msg.id);
    if (chat.byPlatformId.size > DEDUPE_SIZE) {
      const oldest = chat.byPlatformId.keys().next();
      if (!oldest.done) chat.byPlatformId.delete(oldest.value);
    }
  }

  /** A throwing listener must not be mistaken for a source failure. */
  function safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      log.error({ reason: safeErrorMessage(err) }, 'chat listener failed');
    }
  }

  function push(profileId: string, destinationId: string, platform: PlatformId, input: ChatMessageInput): void {
    let normalized: ChatMessage | null;
    try {
      normalized = normalizeChatMessage(input, platform, destinationId);
    } catch {
      return; // malformed input from a scraper; drop it
    }
    if (!normalized) return;
    const chat = chatOf(profileId);
    if (!chat.seen.add(normalized.id)) return;
    const message = withProfile(normalized, profileId);
    chat.buffer.push(message);
    index(chat, message);
    safely(() => bus.emit('chat', message));
  }

  function moderate(profileId: string, destinationId: string, platform: PlatformId, input: ChatModerationInput): void {
    const ts = new Date().toISOString();
    const chat = chatOf(profileId);
    let moderation: ChatModeration;
    switch (input.kind) {
      case 'message-deleted': {
        const platformMessageId = cleanText(input.platformMessageId, MAX_MODERATION_ID_LENGTH);
        if (!platformMessageId) return;
        const prefixed = `${platform}:${platformMessageId}`;
        const removed = chat.buffer.removeWhere(
          (m) => m.destinationId === destinationId && (m.platformMessageId === platformMessageId || m.id === prefixed),
        );
        const key = indexKey(destinationId, platformMessageId);
        // Unknown message (never seen, or forgotten): the id it would have had under the hub's scheme.
        const messageId = removed[0]?.id ?? chat.byPlatformId.get(key) ?? prefixed;
        chat.byPlatformId.delete(key);
        moderation = { kind: 'message-deleted', platform, destinationId, profileId, ts, messageId, platformMessageId };
        break;
      }
      case 'user-cleared': {
        const userId = cleanText(typeof input.userId === 'number' ? String(input.userId) : input.userId, MAX_MODERATION_ID_LENGTH) || null;
        const userName = cleanText(input.userName, MAX_AUTHOR_LENGTH) || null;
        if (!userId && !userName) return;
        chat.buffer.removeWhere((m) => m.destinationId === destinationId && messageFromUser(m, userId, userName));
        moderation = { kind: 'user-cleared', platform, destinationId, profileId, ts, userId, userName };
        break;
      }
      case 'cleared':
        chat.buffer.removeWhere((m) => m.destinationId === destinationId);
        moderation = { kind: 'cleared', platform, destinationId, profileId, ts };
        break;
      default:
        return;
    }
    const event = moderation;
    safely(() => bus.emit('chat-moderation', event));
  }

  function onItem(profileId: string, destinationId: string, platform: PlatformId, item: ChatSourceItem): void {
    if (!item || typeof item !== 'object') return;
    if (isChatModeration(item)) moderate(profileId, destinationId, platform, item);
    else push(profileId, destinationId, platform, item);
  }

  async function run(profileId: string, destinationId: string, platform: PlatformId, source: ChatSource, signal: AbortSignal): Promise<void> {
    let delay = BACKOFF_MIN_MS;
    while (!signal.aborted) {
      const startedAt = Date.now();
      let reason = 'source ended';
      try {
        await consume(source, signal, (item) => onItem(profileId, destinationId, platform, item));
      } catch (err) {
        reason = safeErrorMessage(err);
      }
      if (signal.aborted) break;
      if (Date.now() - startedAt >= HEALTHY_RESET_MS) delay = BACKOFF_MIN_MS;
      log.warn({ destinationId, platform, reason, retryInMs: delay }, 'chat source stopped; restarting');
      await sleep(delay, signal);
      delay = Math.min(delay * 2, BACKOFF_MAX_MS);
    }
  }

  // ---- overlay tokens (one per profile) ----

  const secretsRepo = isSecretsRepo(secrets) ? secrets : null;
  const legacyScope = isSecretsRepo(secrets) ? null : secrets;
  /** profile id -> its current token (only tokens read from / written to storage, or memory-only ones). */
  const tokens = new Map<string, string>();
  let warnedMemoryOnly = false;

  /** Persistent storage of a profile's token, or null when only the legacy 'chat' scope was given. */
  function tokenStore(profileId: string): ScopedSecrets | null {
    if (secretsRepo) return secretsRepo.scoped(profileSecretScope(profileId, 'chat'));
    return profileId === DEFAULT_PROFILE_ID ? legacyScope : null;
  }

  function profileExists(profileId: string): boolean {
    return profileId === DEFAULT_PROFILE_ID || !profiles || Boolean(profiles.get(profileId));
  }

  /** Profiles whose tokens may be presented: every profile when known, else the ones seen so far. */
  function candidateProfiles(): string[] {
    const ids = new Set<string>([DEFAULT_PROFILE_ID]);
    if (profiles) for (const p of profiles.list()) ids.add(p.id);
    else for (const id of tokens.keys()) ids.add(id);
    return [...ids];
  }

  // Token reads/writes are serialized so a rotate can't race a first-time create.
  let tokenQueue: Promise<unknown> = Promise.resolve();
  function serialize<T>(op: () => Promise<T>): Promise<T> {
    const result = tokenQueue.then(op, op);
    tokenQueue = result.catch(() => undefined);
    return result;
  }

  /** A profile's stored token (cached), or null when it has none yet. Call inside serialize(). */
  async function readToken(profileId: string): Promise<string | null> {
    const cached = tokens.get(profileId);
    if (cached) return cached;
    const store = tokenStore(profileId);
    if (!store) return null;
    const stored = await store.get(TOKEN_KEY);
    if (stored && stored.length >= MIN_STORED_TOKEN_LENGTH) {
      tokens.set(profileId, stored);
      return stored;
    }
    return null;
  }

  /** Store a new token for a profile. Call inside serialize(). */
  async function writeToken(profileId: string): Promise<string> {
    const token = generateOverlayToken();
    const store = tokenStore(profileId);
    if (store) {
      await store.set(TOKEN_KEY, token);
    } else if (!warnedMemoryOnly) {
      warnedMemoryOnly = true;
      log.warn('chat hub has no secrets repo: overlay tokens of non-default profiles are kept in memory only');
    }
    tokens.set(profileId, token);
    return token;
  }

  function checkProfile(profileId: string): void {
    if (!profileExists(profileId)) throw unknownProfileError();
  }

  // A deleted profile takes its chat and overlay token with it (its secret scope is deleted by the
  // profile route); forget both so the old overlay URL stops working at once.
  if (profiles) {
    bus.on('profiles-changed', () => {
      let live: Set<string>;
      try {
        live = new Set(profiles.list().map((p) => p.id));
      } catch (err) {
        log.warn({ reason: safeErrorMessage(err) }, 'could not list profiles');
        return;
      }
      live.add(DEFAULT_PROFILE_ID);
      for (const id of [...chats.keys()]) if (!live.has(id)) chats.delete(id);
      for (const id of [...tokens.keys()]) if (!live.has(id)) tokens.delete(id);
    });
  }

  return {
    attach(destinationId, platform, source, signal, profileId = DEFAULT_PROFILE_ID) {
      attachments.get(destinationId)?.abort();
      attachments.delete(destinationId);
      if (signal.aborted) return;
      const profile = profileId || DEFAULT_PROFILE_ID;

      const controller = new AbortController();
      const onParentAbort = (): void => controller.abort();
      signal.addEventListener('abort', onParentAbort, { once: true });
      attachments.set(destinationId, controller);
      log.debug({ destinationId, platform, profileId: profile }, 'chat attached');

      void run(profile, destinationId, platform, source, controller.signal)
        .catch((err: unknown) => log.error({ destinationId, platform, reason: safeErrorMessage(err) }, 'chat loop crashed'))
        .finally(() => {
          signal.removeEventListener('abort', onParentAbort);
          if (attachments.get(destinationId) === controller) attachments.delete(destinationId);
          log.debug({ destinationId, platform }, 'chat detached');
        });
    },

    post(destinationId, platform, input, profileId = DEFAULT_PROFILE_ID) {
      push(profileId || DEFAULT_PROFILE_ID, destinationId, platform, input);
    },

    recent(limit = DEFAULT_RECENT, profileId = DEFAULT_PROFILE_ID) {
      const n = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 0), RING_SIZE) : DEFAULT_RECENT;
      return chats.get(profileId || DEFAULT_PROFILE_ID)?.buffer.last(n) ?? [];
    },

    overlayToken(profileId = DEFAULT_PROFILE_ID) {
      const profile = profileId || DEFAULT_PROFILE_ID;
      // Queued even when cached, so a read never returns a token that a pending rotate replaces.
      return serialize(async () => {
        checkProfile(profile);
        const existing = await readToken(profile);
        if (existing) return existing;
        const token = await writeToken(profile);
        log.info({ profileId: profile }, 'created chat overlay token');
        return token;
      });
    },

    rotateOverlayToken(profileId = DEFAULT_PROFILE_ID) {
      const profile = profileId || DEFAULT_PROFILE_ID;
      return serialize(async () => {
        checkProfile(profile);
        const token = await writeToken(profile);
        log.info({ profileId: profile }, 'rotated chat overlay token');
        return token;
      });
    },

    profileForOverlayToken(token) {
      return serialize(async () => {
        if (typeof token !== 'string' || token.length === 0) return null;
        let match: string | null = null;
        // Compare against every profile (constant-time each, no early exit).
        for (const id of candidateProfiles()) {
          const current = await readToken(id);
          if (current !== null && tokensEqual(token, current) && match === null) match = id;
        }
        return match;
      });
    },
  };
}
