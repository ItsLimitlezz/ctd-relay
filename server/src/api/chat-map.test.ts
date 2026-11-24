import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../../shared/types.js';
import { normalizeChatMessage } from '../chat/normalize.js';
import { apiMessageFromUser, apiUserId, badgesAndRoles, chatMessageData, moderationEvent, rolesForBadge, textFragments } from './chat-map.js';

function msg(over: Partial<ChatMessage> = {}, author: Partial<ChatMessage['author']> = {}): ChatMessage {
  return {
    id: 'twitch:9d0a7c1e',
    platform: 'twitch',
    destinationId: '5b1c',
    author: { name: 'DJFan', ...author },
    text: 'hello',
    ts: '2026-10-17T03:00:04.123Z',
    kind: 'message',
    ...over,
  };
}

describe('chat.message mapping', () => {
  it('produces exactly the documented shape', () => {
    const data = chatMessageData(
      msg(
        {
          text: 'this set is fire Kappa https://kick.com/dprtmnttoronto',
          platformMessageId: '9d0a7c1e',
          fragments: [
            { type: 'text', text: 'this set is fire ' },
            { type: 'emote', text: 'Kappa', image: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0' },
            { type: 'text', text: ' ' },
            { type: 'link', text: 'https://kick.com/dprtmnttoronto', url: 'https://kick.com/dprtmnttoronto' },
          ],
        },
        { id: '144552210', login: 'djfan', color: '#1e90ff', badges: ['subscriber/12'] },
      ),
      'Twitch',
    );
    expect(data).toEqual({
      id: 'twitch:9d0a7c1e',
      platform: 'twitch',
      channel: 'Twitch',
      destinationId: '5b1c',
      platformMessageId: '9d0a7c1e',
      user: {
        id: 'twitch:144552210',
        login: 'djfan',
        name: 'DJFan',
        color: '#1E90FF',
        avatar: null,
        badges: [{ id: 'subscriber/12', label: 'subscriber' }],
        roles: ['subscriber'],
      },
      text: 'this set is fire Kappa https://kick.com/dprtmnttoronto',
      fragments: [
        { type: 'text', text: 'this set is fire ' },
        { type: 'emote', text: 'Kappa', image: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0' },
        { type: 'text', text: ' ' },
        { type: 'link', text: 'https://kick.com/dprtmnttoronto', url: 'https://kick.com/dprtmnttoronto' },
      ],
      reply: null,
      highlighted: false,
      action: false,
      kind: 'message',
      join: false,
      othersCount: null,
      ts: Date.parse('2026-10-17T03:00:04.123Z'),
    });
  });

  it('join lines: join and othersCount (v1.12), only on events', () => {
    const ig = (over: Partial<ChatMessage>) => chatMessageData(msg({ platform: 'instagram', id: 'instagram:x', text: 'DJFan and 3 others joined', ...over }), 'c');
    expect(ig({ kind: 'event', join: true, othersCount: 3 })).toMatchObject({ kind: 'event', join: true, othersCount: 3, user: { name: 'DJFan' } });
    expect(ig({ kind: 'event', join: true })).toMatchObject({ join: true, othersCount: null });
    expect(ig({ kind: 'message', join: true, othersCount: 3 })).toMatchObject({ join: false, othersCount: null });
    expect(ig({ kind: 'event', othersCount: 3 })).toMatchObject({ join: false, othersCount: null });
  });

  it('user ids: <platform>:<id>, or <platform>:name:<name> without one', () => {
    expect(chatMessageData(msg({}, { id: '42' }), 'c').user.id).toBe('twitch:42');
    expect(chatMessageData(msg({ platform: 'instagram', id: 'instagram:x' }, { name: 'Some One' }), 'c').user.id).toBe('instagram:name:Some One');
    expect(apiUserId('tiktok', null, 'a')).toBe('tiktok:name:a');
    expect(chatMessageData(msg(), 'c').user.login).toBeNull();
  });

  it('color only as #RRGGBB, avatar only https', () => {
    const c = (color?: string) => chatMessageData(msg({}, { color }), 'c').user.color;
    expect(c('#a1b2c3')).toBe('#A1B2C3');
    expect(c('#abc')).toBeNull();
    expect(c('#a1b2c3ff')).toBeNull();
    expect(c('red')).toBeNull();
    expect(c(undefined)).toBeNull();
    const a = (avatarUrl?: string) => chatMessageData(msg({}, { avatarUrl }), 'c').user.avatar;
    expect(a('https://cdn.test/a.png')).toBe('https://cdn.test/a.png');
    expect(a('http://cdn.test/a.png')).toBeNull();
    expect(a('javascript:alert(1)')).toBeNull();
    expect(a('not a url')).toBeNull();
  });

  it('normalizes roles from platform badges and keeps the raw badges', () => {
    const cases: [string, string[]][] = [
      ['broadcaster/1', ['broadcaster']],
      ['owner', ['broadcaster']],
      ['moderator/1', ['moderator']],
      ['mod', ['moderator']],
      ['vip/1', ['vip']],
      ['subscriber/3012', ['subscriber']],
      ['sub', ['subscriber']],
      ['sub-tier-2', ['subscriber']],
      ['sub_gifter', []],
      ['sub-gift-leader/1', []],
      ['founder/0', ['subscriber', 'founder']],
      ['member', ['member']],
      ['sponsor', ['member']],
      ['verified', ['verified']],
      ['partner/1', ['verified']],
      ['artist-badge/1', ['artist']],
      ['bot', ['bot']],
      ['premium/1', []],
      ['bits/100', []],
      ['OG', []],
    ];
    for (const [badge, roles] of cases) expect(rolesForBadge(badge), badge).toEqual(roles);

    const { badges, roles } = badgesAndRoles(['founder/0', 'moderator/1', 'vip/1', 'broadcaster/1', 'bits/100', '']);
    expect(roles).toEqual(['broadcaster', 'moderator', 'vip', 'subscriber', 'founder']); // canonical order, unique
    expect(badges).toEqual([
      { id: 'founder/0', label: 'founder' },
      { id: 'moderator/1', label: 'moderator' },
      { id: 'vip/1', label: 'vip' },
      { id: 'broadcaster/1', label: 'broadcaster' },
      { id: 'bits/100', label: 'bits' },
    ]);
    expect(badgesAndRoles(undefined)).toEqual({ badges: [], roles: [] });
  });

  it('builds text + link fragments whose joined text always equals the text', () => {
    const texts = [
      'hello',
      'see https://example.com/a?b=c#d now',
      'https://x.test',
      'two https://a.test and http://b.test/path.',
      'trailing (https://c.test/x).',
      'not a link: https:// nor http://',
      'ftp://nope.test stays text',
      'emoji 🎉 https://d.test/é?q=1 🎉',
      'https://a.test,https://b.test',
      '',
    ];
    for (const text of texts) {
      const frags = textFragments(text);
      expect(frags.map((f) => f.text).join(''), text).toBe(text);
      for (const f of frags) {
        expect(f.text.length).toBeGreaterThan(0);
        if (f.type === 'link') expect(f.url).toMatch(/^https?:\/\//);
      }
    }
    expect(textFragments('see https://example.com/a now')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', text: 'https://example.com/a', url: 'https://example.com/a' },
      { type: 'text', text: ' now' },
    ]);
    expect(textFragments('end https://x.test.')).toEqual([
      { type: 'text', text: 'end ' },
      { type: 'link', text: 'https://x.test', url: 'https://x.test/' },
      { type: 'text', text: '.' },
    ]);
    expect(textFragments('plain')).toEqual([{ type: 'text', text: 'plain' }]);
  });

  it('falls back to text fragments when driver fragments do not join to the text', () => {
    const data = chatMessageData(msg({ text: 'hi https://x.test', fragments: [{ type: 'text', text: 'something else' }] }), 'c');
    expect(data.fragments.map((f) => f.text).join('')).toBe('hi https://x.test');
    expect(data.fragments[1]).toMatchObject({ type: 'link' });
    // Non-https emote images are dropped.
    const emote = chatMessageData(msg({ text: 'Kappa', fragments: [{ type: 'emote', text: 'Kappa', image: 'http://x.test/k.png' }] }), 'c');
    expect(emote.fragments).toEqual([{ type: 'emote', text: 'Kappa' }]);
  });

  it('splits URLs out of driver text fragments (drivers resolve emotes, not links)', () => {
    const text = 'Kappa see https://kick.com/x. ok';
    const data = chatMessageData(
      msg({ text, fragments: [{ type: 'emote', text: 'Kappa', image: 'https://cdn.test/k.png' }, { type: 'text', text: ' see https://kick.com/x. ok' }] }),
      'c',
    );
    expect(data.fragments).toEqual([
      { type: 'emote', text: 'Kappa', image: 'https://cdn.test/k.png' },
      { type: 'text', text: ' see ' },
      { type: 'link', text: 'https://kick.com/x', url: 'https://kick.com/x' },
      { type: 'text', text: '. ok' },
    ]);
    expect(data.fragments.map((f) => f.text).join('')).toBe(text);
  });

  it('driver emote fragments survive ChatHub normalization end to end (collapsed spaces)', () => {
    const normalized = normalizeChatMessage(
      {
        id: 'm1',
        author: { name: 'DJFan' },
        text: 'so  good Kappa  https://x.test',
        fragments: [
          { type: 'text', text: 'so  good ' },
          { type: 'emote', text: 'Kappa', image: 'https://cdn.test/k.png' },
          { type: 'text', text: '  https://x.test' },
        ],
      },
      'twitch',
      'd',
    );
    const data = chatMessageData(normalized!, 'c');
    expect(data.text).toBe('so good Kappa https://x.test');
    expect(data.fragments).toEqual([
      { type: 'text', text: 'so good ' },
      { type: 'emote', text: 'Kappa', image: 'https://cdn.test/k.png' },
      { type: 'text', text: ' ' },
      { type: 'link', text: 'https://x.test', url: 'https://x.test/' },
    ]);
  });

  it('maps reply, action, highlighted, kind=event', () => {
    const data = chatMessageData(msg({ kind: 'event', action: true, highlighted: true, reply: { messageId: 'p1', userName: 'Ann' } }), 'c');
    expect(data).toMatchObject({ kind: 'event', action: true, highlighted: true, reply: { messageId: 'twitch:p1', userName: 'Ann', text: null } });
  });
});

describe('moderation mapping', () => {
  it('maps the three moderation kinds', () => {
    expect(
      moderationEvent({ kind: 'message-deleted', platform: 'twitch', destinationId: 'd', ts: '', messageId: 'twitch:1', platformMessageId: '1' }),
    ).toEqual({ type: 'chat.message.deleted', data: { messageId: 'twitch:1', platformMessageId: '1', platform: 'twitch', destinationId: 'd' } });
    // messageId is never null on the wire: unknown messages get the id they would have had.
    expect(
      moderationEvent({ kind: 'message-deleted', platform: 'kick', destinationId: 'd', ts: '', messageId: null, platformMessageId: '77' }).data,
    ).toMatchObject({ messageId: 'kick:77', platformMessageId: '77' });
    expect(moderationEvent({ kind: 'user-cleared', platform: 'twitch', destinationId: 'd', ts: '', userId: '144552210', userName: 'DJFan' })).toEqual({
      type: 'chat.user.cleared',
      data: { userId: 'twitch:144552210', userName: 'DJFan', platform: 'twitch', destinationId: 'd' },
    });
    expect(moderationEvent({ kind: 'user-cleared', platform: 'kick', destinationId: 'd', ts: '', userId: null, userName: 'bob' }).data).toMatchObject({
      userId: 'kick:name:bob',
    });
    expect(moderationEvent({ kind: 'cleared', platform: 'youtube', destinationId: 'd', ts: '' })).toEqual({
      type: 'chat.cleared',
      data: { platform: 'youtube', destinationId: 'd' },
    });
  });

  it('matches users like the ChatHub does', () => {
    const withId = chatMessageData(msg({}, { id: '1', login: 'djfan' }), 'c');
    const noId = chatMessageData(msg({}, { name: 'Ann' }), 'c');
    const clear = (userId: string | null, userName: string | null) => ({ kind: 'user-cleared' as const, platform: 'twitch' as const, destinationId: 'd', ts: '', userId, userName });
    expect(apiMessageFromUser(withId, clear('1', null))).toBe(true);
    expect(apiMessageFromUser(withId, clear('2', 'djfan'))).toBe(false); // ids decide when both have one
    expect(apiMessageFromUser(withId, clear(null, 'DJFAN'))).toBe(true);
    expect(apiMessageFromUser(noId, clear('9', 'ann'))).toBe(true);
    expect(apiMessageFromUser(noId, clear('9', null))).toBe(false);
  });
});
