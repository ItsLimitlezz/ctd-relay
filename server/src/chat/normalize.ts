// Turns driver-produced ChatMessageInput into a safe, bounded ChatMessage.

import { createHash } from 'node:crypto';
import type { ChatAlert, ChatAlertKind, ChatFragment, ChatMessage, PlatformId } from '../../../shared/types.js';
import type { ChatMessageInput } from '../platforms/types.js';

export const MAX_TEXT_LENGTH = 500;
export const MAX_AUTHOR_LENGTH = 64;
export const MAX_BADGES = 10;
/** Largest `othersCount` accepted on a join line ("<name> and N others joined"). */
export const MAX_OTHERS_COUNT = 9_999_999;
const MAX_BADGE_LENGTH = 32;
const MAX_ID_LENGTH = 200;
const MAX_URL_LENGTH = 2048;

// C0/C1 control characters plus bidi embeddings/overrides/isolates (can visually spoof overlays).
const CONTROL_RE = /[\u{0}-\u{1F}\u{7F}-\u{9F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;
const WHITESPACE_CONTROL_RE = /[\t\n\v\f\r\u{85}\u{2028}\u{2029}]+/gu;
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Cut to `max` UTF-16 units without leaving half of a surrogate pair. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** Line breaks/tabs become spaces, other control characters are removed, runs of spaces collapse. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(WHITESPACE_CONTROL_RE, ' ').replace(CONTROL_RE, '').replace(/ {2,}/g, ' ').trim();
  return truncate(cleaned, max).trim();
}

function cleanColor(value: unknown): string | undefined {
  return typeof value === 'string' && HEX_COLOR_RE.test(value.trim()) ? value.trim() : undefined;
}

function cleanAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function cleanBadges(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const badges: string[] = [];
  for (const b of value) {
    const clean = cleanText(b, MAX_BADGE_LENGTH);
    if (clean && !badges.includes(clean)) badges.push(clean);
    if (badges.length >= MAX_BADGES) break;
  }
  return badges.length > 0 ? badges : undefined;
}

function cleanTs(value: unknown, now: Date): string {
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (value !== '' && !Number.isNaN(d.getTime())) return d.toISOString();
  }
  return now.toISOString();
}

/** Stable id for messages whose platform gives none. */
export function hashMessageId(platform: PlatformId, author: string, text: string, ts: string): string {
  return createHash('sha256').update(JSON.stringify([platform, author, text, ts])).digest('base64url').slice(0, 24);
}

/**
 * Normalize one driver message. Returns null for messages with no visible text.
 * Defensive about runtime shapes: scrapers can hand us anything.
 */
export function normalizeChatMessage(
  input: ChatMessageInput,
  platform: PlatformId,
  destinationId: string,
  now: Date = new Date(),
): ChatMessage | null {
  if (!input || typeof input !== 'object') return null;
  const text = cleanText(input.text, MAX_TEXT_LENGTH);
  if (!text) return null;

  const rawAuthor: Partial<ChatMessage['author']> =
    input.author && typeof input.author === 'object' ? input.author : {};
  const name = cleanText(rawAuthor.name, MAX_AUTHOR_LENGTH) || 'unknown';
  const author: ChatMessage['author'] = { name };
  const color = cleanColor(rawAuthor.color);
  if (color) author.color = color;
  const badges = cleanBadges(rawAuthor.badges);
  if (badges) author.badges = badges;
  const avatarUrl = cleanAvatarUrl(rawAuthor.avatarUrl);
  if (avatarUrl) author.avatarUrl = avatarUrl;

  const authorId = cleanText(typeof rawAuthor.id === 'number' ? String(rawAuthor.id) : rawAuthor.id, MAX_ID_LENGTH);
  if (authorId) author.id = authorId;
  const login = cleanText(rawAuthor.login, MAX_AUTHOR_LENGTH);
  if (login) author.login = login;

  const ts = cleanTs(input.ts, now);
  const rawId = cleanText(input.id, MAX_ID_LENGTH);
  const id = `${platform}:${rawId || hashMessageId(platform, name, text, ts)}`;
  const kind: ChatMessage['kind'] = input.kind === 'event' ? 'event' : 'message';

  const msg: ChatMessage = { id, platform, destinationId, author, text, ts, kind };
  const platformMessageId = cleanText(input.platformMessageId, MAX_ID_LENGTH);
  if (platformMessageId) msg.platformMessageId = platformMessageId;
  const fragments = cleanFragments(input.fragments, text);
  if (fragments) msg.fragments = fragments;
  if (input.action === true) msg.action = true;
  if (input.highlighted === true) msg.highlighted = true;
  const reply = cleanReply(input.reply);
  if (reply) msg.reply = reply;
  // Alerts ride on event lines only (sub, gift, cheer, raid, Super Chat…).
  if (kind === 'event') {
    const alert = cleanAlert(input.alert, name);
    if (alert) msg.alert = alert;
    if (input.join === true) {
      msg.join = true;
      const others = input.othersCount;
      if (typeof others === 'number' && Number.isInteger(others) && others >= 1 && others <= MAX_OTHERS_COUNT) msg.othersCount = others;
    }
  }
  return msg;
}

// ---------------------------------------------------------------------------
// Alerts (ChatMessage.alert, the CTD Overlay alert shape). They reach the web UI, the overlays and
// the external API (which maps them again in api/alert-map.ts with these same rules).
// ---------------------------------------------------------------------------

export const MAX_ALERT_TIER_LENGTH = 32;
export const MAX_GIFT_RECIPIENTS = 100;
/** Money: up to 15 integer digits and 8 decimals ("5", "5.00", "0.99", "1234.5"). */
export const DECIMAL_RE = /^\d{1,15}(?:\.\d{1,8})?$/;
/** ISO 4217 currency code. */
export const CURRENCY_RE = /^[A-Z]{3}$/;

type AlertAmount = NonNullable<ChatAlert['amount']>;
type AlertCountUnit = Extract<AlertAmount, { value: number }>['unit'];
// Written as records so the compiler flags a kind or unit added to the shared type but not here.
const ALERT_KINDS = new Set<string>(
  Object.keys({ follow: 0, subscription: 0, gift: 0, cheer: 0, kicks: 0, raid: 0, membership: 0, superchat: 0, tip: 0 } satisfies Record<ChatAlertKind, 0>),
);
const ALERT_COUNT_UNITS = new Set<string>(
  Object.keys({ months: 0, count: 0, bits: 0, kicks: 0, viewers: 0 } satisfies Record<AlertCountUnit, 0>),
);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Non-negative safe integer, else undefined. */
function cleanCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** cleanText for values that may also arrive as numbers (ids, tiers). */
function cleanTextOrNumber(value: unknown, max: number): string {
  return cleanText(typeof value === 'number' && Number.isFinite(value) ? String(value) : value, max);
}

/**
 * An alert amount: a known count unit with a non-negative integer, or money as a decimal string
 * with an ISO 4217 currency. Anything else (a float money value, "5,00", a negative count) is
 * undefined: never guessed at.
 */
export function cleanAlertAmount(value: unknown): AlertAmount | undefined {
  const a = asRecord(value);
  if (!a) return undefined;
  if (a.unit === 'currency') {
    if (typeof a.value !== 'string' || typeof a.currency !== 'string') return undefined;
    const amount = a.value.trim();
    const currency = a.currency.trim().toUpperCase();
    return DECIMAL_RE.test(amount) && CURRENCY_RE.test(currency) ? { unit: 'currency', value: amount, currency } : undefined;
  }
  const n = cleanCount(a.value);
  if (typeof a.unit !== 'string' || !ALERT_COUNT_UNITS.has(a.unit) || n === undefined) return undefined;
  return { unit: a.unit as AlertCountUnit, value: n };
}

function cleanGift(value: unknown): NonNullable<ChatAlert['gift']> | undefined {
  const g = asRecord(value);
  if (!g) return undefined;
  const out: NonNullable<ChatAlert['gift']> = {};
  if (Array.isArray(g.recipients)) {
    const recipients: string[] = [];
    for (const r of g.recipients as unknown[]) {
      if (recipients.length >= MAX_GIFT_RECIPIENTS) break;
      const name = cleanText(r, MAX_AUTHOR_LENGTH);
      if (name) recipients.push(name);
    }
    if (recipients.length > 0) out.recipients = recipients;
  }
  const total = cleanCount(g.total);
  if (total !== undefined) out.total = total;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A driver's alert, cleaned like the rest of the message, or undefined when it isn't one (not an
 * object, unknown kind). The user name falls back to `authorName` ('Anonymous' for an anonymous
 * user, who never keeps an id); the avatar must be https; text is cleaned and capped; optional
 * parts that are malformed are left out.
 */
export function cleanAlert(value: unknown, authorName: string): ChatAlert | undefined {
  const a = asRecord(value);
  if (!a || typeof a.kind !== 'string' || !ALERT_KINDS.has(a.kind)) return undefined;

  const u = asRecord(a.user) ?? {};
  const anonymous = u.anonymous === true;
  const name = cleanText(u.name, MAX_AUTHOR_LENGTH) || (anonymous ? 'Anonymous' : authorName);
  const id = anonymous ? '' : cleanTextOrNumber(u.id, MAX_ID_LENGTH);
  const user: ChatAlert['user'] = id ? { id, name } : { name };
  const avatar = cleanHttpUrl(u.avatar, true);
  if (avatar) user.avatar = avatar;
  if (anonymous) user.anonymous = true;

  const alert: ChatAlert = { kind: a.kind as ChatAlertKind, user };
  const amount = cleanAlertAmount(a.amount);
  if (amount) alert.amount = amount;
  const tier = cleanTextOrNumber(a.tier, MAX_ALERT_TIER_LENGTH);
  if (tier) alert.tier = tier;
  const text = cleanText(asRecord(a.message)?.text, MAX_TEXT_LENGTH);
  if (text) alert.message = { text };
  const gift = cleanGift(a.gift);
  if (gift) alert.gift = gift;
  return alert;
}

export const MAX_FRAGMENTS = 200;
const FRAGMENT_TYPES = new Set<ChatFragment['type']>(['text', 'emote', 'mention', 'link', 'cheermote']);

/** Fragment text: same character rules as cleanText, but no trimming/collapsing (they must join to `text`). */
function cleanFragmentText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(WHITESPACE_CONTROL_RE, ' ').replace(CONTROL_RE, '');
}

function cleanHttpUrl(value: unknown, httpsOnly: boolean): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || (!httpsOnly && url.protocol === 'http:')) return url.toString();
  } catch {
    // not a URL
  }
  return undefined;
}

/**
 * Map well-formed driver fragments onto the cleaned message text. Cleaning trims, collapses runs of
 * spaces and truncates, and only ever drops spaces or cuts the tail, so each fragment keeps its
 * share of `text` (the dropped spaces and the cut tail go missing from whichever fragment held them;
 * a cut emote/mention/link becomes plain text). Joining the result always gives exactly `text`.
 * Returns undefined when the fragments don't spell `text` (consumers then build text + links).
 */
function cleanFragments(value: unknown, text: string): ChatFragment[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FRAGMENTS) return undefined;
  const parsed: ChatFragment[] = [];
  for (const raw of value as unknown[]) {
    if (!raw || typeof raw !== 'object') return undefined;
    const f = raw as Partial<Record<keyof ChatFragment, unknown>>;
    const type = f.type as ChatFragment['type'];
    if (!FRAGMENT_TYPES.has(type)) return undefined;
    const fragText = cleanFragmentText(f.text);
    if (!fragText) continue;
    const frag: ChatFragment = { type, text: fragText };
    const image = cleanHttpUrl(f.image, true);
    if (image) frag.image = image;
    if (f.animated === true) frag.animated = true;
    const url = cleanHttpUrl(f.url, false);
    if (url) frag.url = url;
    const userId = cleanText(typeof f.userId === 'number' ? String(f.userId) : f.userId, MAX_ID_LENGTH);
    if (userId) frag.userId = userId;
    if (typeof f.amount === 'number' && Number.isFinite(f.amount)) frag.amount = f.amount;
    parsed.push(frag);
  }

  const out: ChatFragment[] = [];
  let pos = 0;
  for (const frag of parsed) {
    if (pos >= text.length) break; // truncated away
    let kept = '';
    let cut = false;
    const chars = Array.from(frag.text);
    for (let k = 0; k < chars.length; k++) {
      const ch = chars[k] ?? '';
      if (pos >= text.length) {
        cut = chars.slice(k).some((c) => c !== ' ');
        break;
      }
      if (text.startsWith(ch, pos)) {
        kept += ch;
        pos += ch.length;
      } else if (ch !== ' ') {
        return undefined; // not the same text: cleaning only drops spaces or cuts the tail
      }
    }
    if (!kept) continue;
    // A truncated emote/mention/link is no longer one: keep what is left as plain text.
    out.push(cut && frag.type !== 'text' ? { type: 'text', text: kept } : { ...frag, text: kept });
  }
  if (out.length === 0 || pos !== text.length) return undefined;
  return out;
}

function cleanReply(value: unknown): ChatMessage['reply'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  const reply: NonNullable<ChatMessage['reply']> = {};
  const messageId = cleanText(r.messageId, MAX_ID_LENGTH);
  if (messageId) reply.messageId = messageId;
  const userName = cleanText(r.userName, MAX_AUTHOR_LENGTH);
  if (userName) reply.userName = userName;
  const text = cleanText(r.text, MAX_TEXT_LENGTH);
  if (text) reply.text = text;
  return Object.keys(reply).length > 0 ? reply : undefined;
}
