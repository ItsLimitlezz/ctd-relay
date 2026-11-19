// ChatMessage (internal) -> chat.message data (docs/API.md §5).

import type { ChatMessage, ChatModeration, PlatformId } from '../../../shared/types.js';
import {
  API_ROLES,
  type ApiChatCleared,
  type ApiChatFragment,
  type ApiChatMessage,
  type ApiChatMessageDeleted,
  type ApiChatUserCleared,
  type ApiRole,
} from './types.js';

const COLOR_RE = /^#[0-9a-f]{6}$/i;
/** http(s) URLs in plain text. Trailing punctuation stays text ("see https://x.test." -> link + "."). */
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"]+$/;

/** `<platform>:<id>`, or `<platform>:name:<display name>` when the platform has no user id. */
export function apiUserId(platform: PlatformId, id: string | null | undefined, name: string): string {
  return id ? `${platform}:${id}` : `${platform}:name:${name}`;
}

function badgeName(badge: string): string {
  const slash = badge.indexOf('/');
  return (slash >= 0 ? badge.slice(0, slash) : badge).trim().toLowerCase();
}

/** Roles a raw platform badge implies. */
export function rolesForBadge(badge: string): ApiRole[] {
  const name = badgeName(badge).replace(/[\s_]+/g, '-');
  if (name === 'broadcaster' || name === 'owner') return ['broadcaster'];
  if (name === 'moderator' || name === 'mod') return ['moderator'];
  if (name === 'vip') return ['vip'];
  if (name === 'founder') return ['subscriber', 'founder'];
  // subscriber, sub, sub-tier-1, subscriber-12... but not gifting badges (sub-gifter, sub-gift-leader).
  if (name.startsWith('sub') && !name.includes('gift')) return ['subscriber'];
  if (name === 'member' || name === 'sponsor') return ['member'];
  if (name === 'verified' || name === 'partner') return ['verified'];
  if (name === 'artist' || name.startsWith('artist-')) return ['artist'];
  if (name === 'bot' || name === 'bot-badge' || name === 'chatbot') return ['bot'];
  return [];
}

export function badgesAndRoles(badges: readonly string[] | undefined): { badges: { id: string; label: string }[]; roles: ApiRole[] } {
  const out: { id: string; label: string }[] = [];
  const roles = new Set<ApiRole>();
  for (const raw of badges ?? []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    out.push({ id: raw, label: badgeName(raw) || raw });
    for (const role of rolesForBadge(raw)) roles.add(role);
  }
  return { badges: out, roles: API_ROLES.filter((r) => roles.has(r)) };
}

function linkUrl(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Plain text -> text + link fragments. Joining every fragment's text gives back `text` exactly. */
export function textFragments(text: string): ApiChatFragment[] {
  const out: ApiChatFragment[] = [];
  let plain = '';
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    let candidate = m[0];
    const trailing = TRAILING_PUNCT_RE.exec(candidate)?.[0] ?? '';
    if (trailing) candidate = candidate.slice(0, -trailing.length);
    const url = candidate.length > 'https://'.length ? linkUrl(candidate) : null;
    if (!url) continue;
    plain += text.slice(last, start);
    if (plain) out.push({ type: 'text', text: plain });
    plain = '';
    out.push({ type: 'link', text: candidate, url });
    last = start + candidate.length;
  }
  plain += text.slice(last);
  if (plain) out.push({ type: 'text', text: plain });
  return out;
}

function fragmentsOf(msg: ChatMessage): ApiChatFragment[] {
  const given = msg.fragments;
  if (given && given.length > 0 && given.map((f) => f.text).join('') === msg.text) {
    // Driver text fragments still get their URLs split into link fragments (drivers resolve emotes, not links).
    return given.flatMap((f): ApiChatFragment[] => {
      if (f.type === 'text') return textFragments(f.text);
      const frag: ApiChatFragment = { type: f.type, text: f.text };
      if (f.image?.startsWith('https://')) frag.image = f.image;
      if (f.animated) frag.animated = true;
      if (f.url) frag.url = f.url;
      if (f.userId) frag.userId = f.userId;
      if (typeof f.amount === 'number') frag.amount = f.amount;
      return [frag];
    });
  }
  return textFragments(msg.text);
}

function httpsUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/** `channel` is the destination's name (looked up by the caller). */
export function chatMessageData(msg: ChatMessage, channel: string): ApiChatMessage {
  const { badges, roles } = badgesAndRoles(msg.author.badges);
  const color = msg.author.color && COLOR_RE.test(msg.author.color) ? msg.author.color.toUpperCase() : null;
  const ts = Date.parse(msg.ts);
  const reply = msg.reply
    ? {
        messageId: msg.reply.messageId ? `${msg.platform}:${msg.reply.messageId}` : null,
        userName: msg.reply.userName ?? null,
        text: msg.reply.text ?? null,
      }
    : null;
  return {
    id: msg.id,
    platform: msg.platform,
    channel,
    destinationId: msg.destinationId,
    platformMessageId: msg.platformMessageId ?? null,
    user: {
      id: apiUserId(msg.platform, msg.author.id, msg.author.name),
      login: msg.author.login ?? null,
      name: msg.author.name,
      color,
      avatar: httpsUrl(msg.author.avatarUrl),
      badges,
      roles,
    },
    text: msg.text,
    fragments: fragmentsOf(msg),
    reply,
    highlighted: msg.highlighted === true,
    action: msg.action === true,
    kind: msg.kind,
    join: msg.kind === 'event' && msg.join === true,
    othersCount: msg.kind === 'event' && msg.join === true && typeof msg.othersCount === 'number' ? msg.othersCount : null,
    ts: Number.isFinite(ts) ? ts : Date.now(),
  };
}

export type ModerationEvent =
  | { type: 'chat.message.deleted'; data: ApiChatMessageDeleted }
  | { type: 'chat.user.cleared'; data: ApiChatUserCleared }
  | { type: 'chat.cleared'; data: ApiChatCleared };

export function moderationEvent(m: ChatModeration): ModerationEvent {
  switch (m.kind) {
    case 'message-deleted':
      return {
        type: 'chat.message.deleted',
        data: {
          // Unknown message: the id it would have had (the hub's `<platform>:<platform message id>` scheme).
          messageId: m.messageId ?? `${m.platform}:${m.platformMessageId}`,
          platformMessageId: m.platformMessageId,
          platform: m.platform,
          destinationId: m.destinationId,
        },
      };
    case 'user-cleared':
      return {
        type: 'chat.user.cleared',
        data: {
          userId: m.userId ? apiUserId(m.platform, m.userId, '') : m.userName ? apiUserId(m.platform, null, m.userName) : null,
          userName: m.userName,
          platform: m.platform,
          destinationId: m.destinationId,
        },
      };
    case 'cleared':
      return { type: 'chat.cleared', data: { platform: m.platform, destinationId: m.destinationId } };
  }
}

/** Does a mapped chat message belong to the user a chat.user.cleared names? (Mirrors the ChatHub rule.) */
export function apiMessageFromUser(msg: ApiChatMessage, m: Extract<ChatModeration, { kind: 'user-cleared' }>): boolean {
  const hasId = !msg.user.id.startsWith(`${msg.platform}:name:`);
  if (m.userId && hasId) return msg.user.id === `${msg.platform}:${m.userId}`;
  if (!m.userName) return false;
  const name = m.userName.toLowerCase();
  return msg.user.name.toLowerCase() === name || msg.user.login?.toLowerCase() === name;
}
