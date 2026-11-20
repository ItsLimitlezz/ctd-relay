import { describe, expect, it } from 'vitest';
import type { ChatAlert } from '../../../shared/types.js';
import type { ChatMessageInput } from '../platforms/types.js';
import { RecentKeys, RingBuffer } from './buffers.js';
import { MAX_AUTHOR_LENGTH, MAX_OTHERS_COUNT, MAX_TEXT_LENGTH, cleanAlertAmount, cleanText, normalizeChatMessage, truncate } from './normalize.js';
import { safeErrorMessage } from './redact.js';
import { generateOverlayToken, tokensEqual } from './token.js';

const NOW = new Date('2026-10-11T12:00:00.000Z');

function input(over: Partial<ChatMessageInput> = {}): ChatMessageInput {
  return { author: { name: 'alice' }, text: 'hello', ts: '2026-10-11T11:59:00.000Z', ...over };
}

describe('normalizeChatMessage', () => {
  it('prefixes the platform id and fills platform/destination/kind', () => {
    const m = normalizeChatMessage(input({ id: 'abc' }), 'twitch', 'dest-1', NOW);
    expect(m).toEqual({
      id: 'twitch:abc',
      platform: 'twitch',
      destinationId: 'dest-1',
      author: { name: 'alice' },
      text: 'hello',
      ts: '2026-10-11T11:59:00.000Z',
      kind: 'message',
    });
  });

  it('keeps othersCount only on join events, as a whole number from 1', () => {
    const join = (over: Partial<ChatMessageInput>) => normalizeChatMessage(input({ kind: 'event', join: true, text: 'dj_fan and 3 others joined', ...over }), 'instagram', 'd', NOW);
    expect(join({ othersCount: 3 })).toMatchObject({ kind: 'event', join: true, othersCount: 3 });
    expect(join({ othersCount: MAX_OTHERS_COUNT })?.othersCount).toBe(MAX_OTHERS_COUNT);
    for (const bad of [0, -1, 2.5, Number.NaN, Infinity, MAX_OTHERS_COUNT + 1, '3' as unknown as number]) expect(join({ othersCount: bad }), String(bad)).not.toHaveProperty('othersCount');
    expect(join({})).not.toHaveProperty('othersCount');
    // Not a join line: no count, whatever the source sent.
    expect(join({ join: false, othersCount: 3 })).not.toHaveProperty('othersCount');
    expect(normalizeChatMessage(input({ join: true, othersCount: 3 }), 'instagram', 'd', NOW)).not.toHaveProperty('othersCount');
  });

  it('keeps kind=event', () => {
    expect(normalizeChatMessage(input({ kind: 'event' }), 'kick', 'd', NOW)?.kind).toBe('event');
  });

  it('hashes platform+author+text+ts into a stable id when the platform gives none', () => {
    const a = normalizeChatMessage(input(), 'youtube', 'd1', NOW);
    const b = normalizeChatMessage(input(), 'youtube', 'd2', NOW);
    const c = normalizeChatMessage(input({ text: 'other' }), 'youtube', 'd1', NOW);
    const d = normalizeChatMessage(input(), 'kick', 'd1', NOW);
    expect(a?.id).toMatch(/^youtube:[\w-]{24}$/);
    expect(a?.id).toBe(b?.id);
    expect(c?.id).not.toBe(a?.id);
    expect(d?.id).not.toBe(a?.id?.replace('youtube', 'kick'));
  });

  it('defaults ts to now for missing or invalid timestamps and normalizes valid ones to ISO', () => {
    expect(normalizeChatMessage(input({ ts: '' }), 'x', 'd', NOW)?.ts).toBe(NOW.toISOString());
    expect(normalizeChatMessage(input({ ts: 'not a date' }), 'x', 'd', NOW)?.ts).toBe(NOW.toISOString());
    expect(normalizeChatMessage(input({ ts: '2026-10-11T13:00:00+01:00' }), 'x', 'd', NOW)?.ts).toBe(
      '2026-10-11T12:00:00.000Z',
    );
  });

  it('strips control and bidi characters; line breaks become spaces', () => {
    const m = normalizeChatMessage(
      input({ text: 'a\u0000b\nc\r\n\td\u{202E}e\u0007', author: { name: '\u{2066}bob\u0000\n' } }),
      'twitch',
      'd',
      NOW,
    );
    expect(m?.text).toBe('ab c de');
    expect(m?.author.name).toBe('bob');
  });

  it('trims text to 500 and author to 64 characters without splitting surrogate pairs', () => {
    const m = normalizeChatMessage(input({ text: 'x'.repeat(600), author: { name: 'n'.repeat(100) } }), 'kick', 'd', NOW);
    expect(m?.text).toHaveLength(MAX_TEXT_LENGTH);
    expect(m?.author.name).toHaveLength(MAX_AUTHOR_LENGTH);

    const emoji = 'a'.repeat(MAX_TEXT_LENGTH - 1) + '\u{1F600}';
    const e = normalizeChatMessage(input({ text: emoji }), 'kick', 'd', NOW);
    expect(e?.text).toBe('a'.repeat(MAX_TEXT_LENGTH - 1));
  });

  it('keeps at most 10 unique badges, valid hex colors and http(s) avatars only', () => {
    const badges = Array.from({ length: 15 }, (_, i) => `b${i}`);
    const m = normalizeChatMessage(
      input({ author: { name: 'a', badges: ['b0', ...badges, ''], color: '#FF00aa', avatarUrl: 'https://cdn.example/a.png' } }),
      'twitch',
      'd',
      NOW,
    );
    expect(m?.author.badges).toEqual(badges.slice(0, 10));
    expect(m?.author.color).toBe('#FF00aa');
    expect(m?.author.avatarUrl).toBe('https://cdn.example/a.png');

    const bad = normalizeChatMessage(
      input({ author: { name: 'a', badges: [], color: 'red;background:url(x)', avatarUrl: 'javascript:alert(1)' } }),
      'twitch',
      'd',
      NOW,
    );
    expect(bad?.author).toEqual({ name: 'a' });
  });

  it('keeps author id/login, platformMessageId, action, highlighted and reply (cleaned)', () => {
    const m = normalizeChatMessage(
      input({
        id: 'abc',
        platformMessageId: ' pm\u0000-1 ',
        author: { name: 'Alice', id: 42 as unknown as string, login: 'alice\n' },
        action: true,
        highlighted: 'yes' as unknown as boolean,
        reply: { messageId: 'p1', userName: '‮bob', text: 'x'.repeat(600) },
      }),
      'twitch',
      'd',
      NOW,
    );
    expect(m?.platformMessageId).toBe('pm-1');
    expect(m?.author).toEqual({ name: 'Alice', id: '42', login: 'alice' });
    expect(m?.action).toBe(true);
    expect(m?.highlighted).toBeUndefined();
    expect(m?.reply).toEqual({ messageId: 'p1', userName: 'bob', text: 'x'.repeat(MAX_TEXT_LENGTH) });
    expect(normalizeChatMessage(input({ reply: {} }), 'x', 'd', NOW)).not.toHaveProperty('reply');
    expect(normalizeChatMessage(input({ reply: null }), 'x', 'd', NOW)).not.toHaveProperty('reply');
  });

  it('keeps fragments only when they join to exactly the cleaned text', () => {
    const ok = normalizeChatMessage(
      input({
        text: 'hi Kappa https://x.test',
        fragments: [
          { type: 'text', text: 'hi ' },
          { type: 'emote', text: 'Kappa', image: 'https://cdn.test/kappa.png', animated: true, url: 'javascript:alert(1)' },
          { type: 'text', text: ' ' },
          { type: 'link', text: 'https://x.test', url: 'https://x.test/' },
        ],
      }),
      'twitch',
      'd',
      NOW,
    );
    expect(ok?.fragments).toEqual([
      { type: 'text', text: 'hi ' },
      { type: 'emote', text: 'Kappa', image: 'https://cdn.test/kappa.png', animated: true },
      { type: 'text', text: ' ' },
      { type: 'link', text: 'https://x.test', url: 'https://x.test/' },
    ]);
    expect(ok?.fragments?.map((f) => f.text).join('')).toBe(ok?.text);

    // http image is dropped (https only), mention keeps its user id, cheermote its amount.
    const extras = normalizeChatMessage(
      input({
        text: '@bob Cheer100',
        fragments: [
          { type: 'mention', text: '@bob', userId: 'u1' },
          { type: 'text', text: ' ' },
          { type: 'cheermote', text: 'Cheer100', amount: 100, image: 'http://cdn.test/c.png' },
        ],
      }),
      'twitch',
      'd',
      NOW,
    );
    expect(extras?.fragments).toEqual([
      { type: 'mention', text: '@bob', userId: 'u1' },
      { type: 'text', text: ' ' },
      { type: 'cheermote', text: 'Cheer100', amount: 100 },
    ]);

    const mismatch = (fragments: unknown, text = 'hello world') =>
      normalizeChatMessage(input({ text, fragments: fragments as never }), 'twitch', 'd', NOW)?.fragments;
    expect(mismatch([{ type: 'text', text: 'hello' }])).toBeUndefined(); // doesn't cover the text
    expect(mismatch([{ type: 'text', text: 'hello there' }])).toBeUndefined(); // different text
    expect(mismatch([{ type: 'text', text: '  hello world  ' }])).toEqual([{ type: 'text', text: 'hello world' }]); // trimmed with the text
    expect(mismatch([{ type: 'bogus', text: 'hello world' }])).toBeUndefined();
    expect(mismatch([null])).toBeUndefined();
    expect(mismatch('hello world')).toBeUndefined();
    expect(mismatch([])).toBeUndefined();
    expect(mismatch([{ type: 'text', text: 'hello world' }])).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('keeps emotes when cleaning collapses spaces, trims or truncates the text', () => {
    const emote = (name: string) => ({ type: 'emote' as const, text: name, image: `https://cdn.test/${name}.png` });
    const collapsed = normalizeChatMessage(
      input({
        text: '  so   good  Kappa\tKappa  ',
        fragments: [{ type: 'text', text: '  so   good  ' }, emote('Kappa'), { type: 'text', text: '\t' }, emote('Kappa'), { type: 'text', text: '  ' }],
      }),
      'twitch',
      'd',
      NOW,
    );
    expect(collapsed?.text).toBe('so good Kappa Kappa');
    expect(collapsed?.fragments).toEqual([
      { type: 'text', text: 'so good ' },
      { type: 'emote', text: 'Kappa', image: 'https://cdn.test/Kappa.png' },
      { type: 'text', text: ' ' },
      { type: 'emote', text: 'Kappa', image: 'https://cdn.test/Kappa.png' },
    ]);

    // Truncated to MAX_TEXT_LENGTH: a cut emote becomes text, fragments after the cut are dropped.
    const filler = 'a'.repeat(MAX_TEXT_LENGTH - 3);
    const long = normalizeChatMessage(
      input({ text: `${filler} PogChamp Kappa`, fragments: [{ type: 'text', text: `${filler} ` }, emote('PogChamp'), { type: 'text', text: ' ' }, emote('Kappa')] }),
      'twitch',
      'd',
      NOW,
    );
    expect(long?.text).toBe(`${filler} Po`);
    expect(long?.fragments).toEqual([
      { type: 'text', text: `${filler} ` },
      { type: 'text', text: 'Po' },
    ]);
    expect(long?.fragments?.map((f) => f.text).join('')).toBe(long?.text);
  });

  it('drops messages without visible text and survives malformed input', () => {
    expect(normalizeChatMessage(input({ text: ' \n\u0000 ' }), 'x', 'd', NOW)).toBeNull();
    expect(normalizeChatMessage(null as unknown as ChatMessageInput, 'x', 'd', NOW)).toBeNull();
    const noAuthor = normalizeChatMessage({ text: 'hi' } as unknown as ChatMessageInput, 'x', 'd', NOW);
    expect(noAuthor?.author.name).toBe('unknown');
  });
});

describe('alerts', () => {
  function eventLine(alert: unknown, over: Partial<ChatMessageInput> = {}): ChatMessageInput {
    return input({ kind: 'event', author: { name: 'DJFan', id: '144552210' }, text: 'subscribed for 12 months', alert: alert as ChatAlert, ...over });
  }

  it('keeps a valid alert on an event line', () => {
    const alert: ChatAlert = {
      kind: 'subscription',
      user: { id: '144552210', name: 'DJFan' },
      amount: { unit: 'months', value: 12 },
      tier: '1000',
      message: { text: 'a year of DPRTMNT!' },
    };
    expect(normalizeChatMessage(eventLine(alert), 'twitch', 'd', NOW)?.alert).toEqual(alert);
    const superchat: ChatAlert = {
      kind: 'superchat',
      user: { id: 'UCx9', name: 'Night Owl', avatar: 'https://yt3.ggpht.com/a.jpg' },
      amount: { unit: 'currency', value: '5.00', currency: 'USD' },
      tier: '2',
    };
    expect(normalizeChatMessage(eventLine(superchat), 'youtube', 'd', NOW)?.alert).toEqual(superchat);
  });

  it('drops the alert on a plain message, for an unknown kind, or when it is not an object', () => {
    const sub = { kind: 'subscription', user: { name: 'DJFan' } };
    expect(normalizeChatMessage(eventLine(sub, { kind: 'message' }), 'twitch', 'd', NOW)).not.toHaveProperty('alert');
    expect(normalizeChatMessage(eventLine(sub, { kind: undefined }), 'twitch', 'd', NOW)).not.toHaveProperty('alert');
    for (const bad of [{ kind: 'donation', user: { name: 'x' } }, { user: { name: 'x' } }, 'subscription', ['subscription'], null, 7]) {
      const m = normalizeChatMessage(eventLine(bad), 'twitch', 'd', NOW);
      expect(m?.kind).toBe('event'); // the line itself stays
      expect(m).not.toHaveProperty('alert');
    }
  });

  it('never passes money as a float, negative or fractional counts, or unknown units', () => {
    const amountOf = (amount: unknown) => normalizeChatMessage(eventLine({ kind: 'superchat', user: { name: 'x' }, amount }), 'youtube', 'd', NOW)?.alert;
    expect(amountOf({ unit: 'currency', value: 5, currency: 'USD' })).toEqual({ kind: 'superchat', user: { name: 'x' } });
    expect(amountOf({ unit: 'currency', value: ' 1000 ', currency: 'jpy' })?.amount).toEqual({ unit: 'currency', value: '1000', currency: 'JPY' });
    expect(amountOf({ unit: 'currency', value: '5,00', currency: 'EUR' })).not.toHaveProperty('amount');
    expect(amountOf({ unit: 'bits', value: -1 })).not.toHaveProperty('amount');
    expect(amountOf({ unit: 'bits', value: 1.5 })).not.toHaveProperty('amount');
    expect(amountOf({ unit: 'seconds', value: 3 })).not.toHaveProperty('amount');
    expect(amountOf({ unit: 'kicks', value: 500 })?.amount).toEqual({ unit: 'kicks', value: 500 });
  });

  it('cleans and caps every text, keeps https avatars only, and anonymous users lose their id', () => {
    const recipients = Array.from({ length: 150 }, (_, i) => `viewer${i}`);
    const m = normalizeChatMessage(
      eventLine({
        kind: 'gift',
        user: { id: 999, name: '', anonymous: true, avatar: 'http://example.com/a.png' },
        amount: { unit: 'count', value: 5 },
        tier: 'x'.repeat(100),
        message: { text: `hi\u{202E}there\n${'y'.repeat(600)}` },
        gift: { recipients: ['a\u{202E}b', '', 7, ...recipients], total: 5.5 },
      }),
      'twitch',
      'd',
      NOW,
    );
    expect(m?.alert?.user).toEqual({ name: 'Anonymous', anonymous: true });
    expect(m?.alert?.tier).toHaveLength(32);
    expect(m?.alert?.message?.text.startsWith('hithere ')).toBe(true);
    expect(m?.alert?.message?.text).toHaveLength(MAX_TEXT_LENGTH);
    expect(m?.alert?.gift).toEqual({ recipients: ['ab', ...recipients.slice(0, 99)] });

    // A named user: control characters stripped, numeric id as text, author name as fallback.
    const named = normalizeChatMessage(eventLine({ kind: 'raid', user: { id: 42, name: 'R\naider' } }), 'twitch', 'd', NOW);
    expect(named?.alert?.user).toEqual({ id: '42', name: 'R aider' });
    const unnamed = normalizeChatMessage(eventLine({ kind: 'raid', user: {} }), 'twitch', 'd', NOW);
    expect(unnamed?.alert?.user).toEqual({ name: 'DJFan' });
    const noUser = normalizeChatMessage(eventLine({ kind: 'follow' }), 'twitch', 'd', NOW);
    expect(noUser?.alert).toEqual({ kind: 'follow', user: { name: 'DJFan' } });
  });

  it('cleanAlertAmount is the shared money/count check', () => {
    expect(cleanAlertAmount({ unit: 'currency', value: '0.99', currency: 'EUR' })).toEqual({ unit: 'currency', value: '0.99', currency: 'EUR' });
    expect(cleanAlertAmount({ unit: 'months', value: 3 })).toEqual({ unit: 'months', value: 3 });
    expect(cleanAlertAmount([1])).toBeUndefined();
  });
});

describe('text helpers', () => {
  it('truncate and cleanText', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdef', 3)).toBe('abc');
    expect(cleanText(42, 10)).toBe('');
    expect(cleanText('  a    b  ', 10)).toBe('a b');
  });

  it('safeErrorMessage hides URLs paths/queries and token-like values', () => {
    const msg = safeErrorMessage(
      new Error('GET https://api.example.com/v1/chat?access_token=SECRET1 failed; key=SECRET2 Bearer SECRET3'),
    );
    expect(msg).toContain('https://api.example.com');
    expect(msg).not.toMatch(/SECRET/);
    expect(safeErrorMessage('Twitch token expired')).toBe('Twitch token expired');
    expect(safeErrorMessage(undefined)).toBe('unknown error');
  });
});

describe('tokens', () => {
  it('generates 43-char base64url tokens and compares them', () => {
    const t = generateOverlayToken();
    expect(t).toMatch(/^[\w-]{43}$/);
    expect(generateOverlayToken()).not.toBe(t);
    expect(tokensEqual(t, t)).toBe(true);
    expect(tokensEqual(t, t.slice(0, -1))).toBe(false);
    expect(tokensEqual(t, '')).toBe(false);
  });
});

describe('buffers', () => {
  it('RingBuffer keeps the newest items, oldest first', () => {
    const rb = new RingBuffer<number>(3);
    expect(rb.last(10)).toEqual([]);
    for (let i = 1; i <= 5; i++) rb.push(i);
    expect(rb.size).toBe(3);
    expect(rb.last(10)).toEqual([3, 4, 5]);
    expect(rb.last(2)).toEqual([4, 5]);
    expect(rb.last(0)).toEqual([]);
    expect(() => new RingBuffer(0)).toThrow(RangeError);
  });

  it('RingBuffer.push reports the evicted item and removeWhere keeps the order of the rest', () => {
    const rb = new RingBuffer<number>(4);
    expect(rb.push(1)).toBeUndefined();
    for (let i = 2; i <= 4; i++) rb.push(i);
    expect(rb.push(5)).toBe(1);
    expect(rb.push(6)).toBe(2);
    expect(rb.last(10)).toEqual([3, 4, 5, 6]);
    expect(rb.removeWhere((n) => n % 2 === 0)).toEqual([4, 6]);
    expect(rb.size).toBe(2);
    expect(rb.last(10)).toEqual([3, 5]);
    expect(rb.removeWhere(() => false)).toEqual([]);
    rb.push(7);
    rb.push(8);
    expect(rb.push(9)).toBe(3);
    expect(rb.last(10)).toEqual([5, 7, 8, 9]);
  });

  it('RecentKeys forgets the oldest key past capacity', () => {
    const keys = new RecentKeys(2);
    expect(keys.add('a')).toBe(true);
    expect(keys.add('a')).toBe(false);
    keys.add('b');
    keys.add('c');
    expect(keys.size).toBe(2);
    expect(keys.has('a')).toBe(false);
    expect(keys.add('a')).toBe(true);
  });
});
