import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SettingsRepo } from '../../services.js';
import {
  BUILTIN_CHAT_PACK,
  CHAT_PACK_MAX_BYTES,
  CHAT_PACK_SETTING,
  ChatPackStore,
  mergeChatPack,
  overrideIsRedundant,
  parseChatPackOverride,
  regexProblem,
  selectorProblem,
  type ChatPackOverride,
} from './chat-pack.js';

function memorySettings(initial: Record<string, unknown> = {}): SettingsRepo & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    get: <T>(key: string, fallback: T): T => (data.has(key) ? (structuredClone(data.get(key)) as T) : fallback),
    set: (key, value) => void data.set(key, structuredClone(value)),
    delete: (key) => void data.delete(key),
  };
}

const ok = (value: unknown): ChatPackOverride => {
  const parsed = parseChatPackOverride(value);
  if (!parsed.ok) throw new Error(parsed.problems.join('; '));
  return parsed.override;
};
const problems = (value: unknown): string[] => {
  const parsed = parseChatPackOverride(value);
  return parsed.ok ? [] : parsed.problems;
};

describe('built-in pack', () => {
  it('passes its own validation (every selector and pattern is one an operator could send)', () => {
    expect(problems(BUILTIN_CHAT_PACK)).toEqual([]);
  });

  it('builtin-3: climbs far enough for the live layout, and does not deliver a backlog', () => {
    const p = BUILTIN_CHAT_PACK;
    expect(p.version).toBe('builtin-3');
    expect(p.container).toMatchObject({ climbLevels: 10, climbMinHeight: 320, climbPreferRows: true });
    expect(p.timing).toMatchObject({ backlogAsHistory: true, liveStartGraceMs: 60_000 });
  });

  it('keeps the values the reader had before packs existed', () => {
    const p = BUILTIN_CHAT_PACK;
    expect(p.tab).toMatchObject({ roles: ['tab', 'button'], css: [] });
    expect(new RegExp(p.tab.name, 'i').test('Comments')).toBe(true);
    expect(new RegExp(p.tab.name, 'i').test('Comment comments')).toBe(true); // icon label + text
    expect(new RegExp(p.tab.name, 'i').test('Comments are off')).toBe(false);
    expect(p.container.panelLabel).toBe('^(live )?comments?$');
    expect(p.container.composerCss).toEqual(['textarea', 'input[type="text"]', '[contenteditable="true"]']);
    expect(p.container).toMatchObject({ composerHint: 'comment' });
    expect(p.row.avatarCss).toEqual(['img[alt$="profile picture" i]']);
    expect(new RegExp(p.row.avatarAlt, 'i').exec("fixture_user_a's profile picture")?.[1]).toBe('fixture_user_a');
    expect(new RegExp(p.row.avatarAlt, 'i').exec('fixture_user_a’s profile picture')?.[1]).toBe('fixture_user_a');
    expect(p.row.fallbackCss).toEqual(['li', '[role="listitem"]', '[role="row"]']);
    expect(p.text.skipCss).toEqual(['button', 'time', 'svg']);
    expect(p.timing.pollMs).toBe(1000);
    const meta = (s: string) => p.text.meta.some((m) => new RegExp(m, 'i').test(s));
    for (const label of ['Reply', 'See translation', 'Pin comment', 'liked', '·', 'now', 'Just now', '2m', '15 s', '3 hours ago', 'Verified']) expect(meta(label), label).toBe(true);
    for (const text of ['reply to me', 'now what', '2 much', 'hello']) expect(meta(text), text).toBe(false);
    const join = (s: string) => p.classify.join.some((m) => new RegExp(m, 'i').test(s));
    const event = (s: string) => p.classify.event.some((m) => new RegExp(m, 'i').test(s));
    expect(join('joined')).toBe(true);
    expect(join('joined the live video.')).toBe(true);
    expect(join('requested to join')).toBe(false);
    expect(event('requested to join')).toBe(true);
    expect(event('joined us from Miami')).toBe(false);
  });

  it('join patterns: capture group 1 of the one that matches is how many others joined (singular, plural, "more")', () => {
    const p = BUILTIN_CHAT_PACK;
    const others = (s: string): string | null | undefined => {
      for (const m of p.classify.join) {
        const hit = new RegExp(m, 'i').exec(s);
        if (hit) return hit[1] ?? null;
      }
      return undefined; // not a join line
    };
    const event = (s: string) => p.classify.event.some((m) => new RegExp(m, 'i').test(s));
    expect(others('and 3 others joined')).toBe('3');
    expect(others('and 1 other joined')).toBe('1');
    expect(others('and 12 more joined the live video.')).toBe('12');
    expect(others('And 4 Others Joined The Live')).toBe('4');
    expect(others('and 1,234 others joined')).toBe('1,234');
    expect(others('joined')).toBeNull();
    expect(others('joined the live video')).toBeNull();
    expect(others('and 3 others joined me for lunch')).toBeUndefined();
    expect(others('and others joined')).toBeUndefined();
    for (const s of ['and 3 others joined', 'and 1 other joined', 'and 12 more joined the live video.', 'and 1,234 others joined']) expect(event(s), s).toBe(true);
    // Every built-in pattern passes the pack's own checks.
    for (const s of [...p.classify.event, ...p.classify.join]) expect(regexProblem(s), s).toBeNull();
  });
});

describe('selectorProblem', () => {
  it('accepts plain CSS', () => {
    for (const s of ['li', '[role="listitem"]', 'img[alt$="profile picture" i]', 'div.x1n2onr6 > span:not(.u)', 'a[href^="/"]', '[data-testid="live-comments"] div:has(> img)', '.a\\:b']) {
      expect(selectorProblem(s), s).toBeNull();
    }
  });

  it('refuses anything that is not a plain CSS selector', () => {
    for (const s of [
      '',
      ' li',
      'xpath=//div',
      'text=Comments',
      'internal:role=button',
      'div >> span',
      'div { color: red }',
      'a; b',
      '@import url(x)',
      '<script>',
      'div /* x */',
      'a[href="x"',
      'div:not(.a',
      'a)',
      'li\u0000',
      `div${'.a'.repeat(120)}`,
    ]) {
      expect(selectorProblem(s), JSON.stringify(s)).not.toBeNull();
    }
  });
});

describe('regexProblem', () => {
  it('accepts ordinary label patterns', () => {
    for (const s of ['^(live )?comments?$', "^(.+?)['’]s profile picture$", '^\\d+\\s?[smhdw]$', 'comment', '^pinned by .{1,60}$']) expect(regexProblem(s), s).toBeNull();
  });

  it('refuses invalid, oversized and backreferencing patterns', () => {
    expect(regexProblem('')).toMatch(/empty/);
    expect(regexProblem('(')).toMatch(/not a valid regular expression/);
    expect(regexProblem('[a-')).toMatch(/not a valid regular expression/);
    expect(regexProblem('a'.repeat(301))).toMatch(/longer than/);
    expect(regexProblem('(a)\\1')).toMatch(/backreferences/);
    expect(regexProblem('(?<x>a)\\k<x>')).toMatch(/backreferences/);
    expect(regexProblem('a\nb')).toMatch(/control characters/);
  });

  it('refuses patterns that blow up on long input, without hanging', () => {
    const started = Date.now();
    for (const s of ['^(a+)+$', '^(\\w+\\s?)+$', '^(.*a){20}$', '(x+x+)+y', '^(comment|comments)+$'.replace('+$', '*)*$').replace('^(', '^((')]) {
      expect(regexProblem(s), s).toMatch(/too slow/);
    }
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('refuses a slow pattern whatever it stops at: a space, a letter, a line break', () => {
    // These pass on a run that ends in "!" or NUL; an ordinary comment ("aaaa… b") makes them run for hours.
    for (const s of ['^(\\S+)+$', '^([^ ]+)+$', '^(\\D+)+$', '^(.+)+$']) expect(regexProblem(s), s).toMatch(/too slow/);
  });

  it('refuses a slow pattern that writes its characters as escapes', () => {
    for (const s of ['(\\x62+)+$', '(\\u0062+)+$', '(\\u0131+)+$', '(\\xe9+)+$', '(\\041+)+$', '(\\cJ+)+$', '(\\x62|\\x62\\x62)+$']) {
      expect(regexProblem(s), s).toMatch(/too slow/);
    }
  });

  it('refuses a slow pattern behind a literal start', () => {
    for (const s of ['^pinned by (\\w+\\s?)+$', '^joined (\\S+)+$']) expect(regexProblem(s), s).toMatch(/too slow/);
  });

  it('accepts ordinary patterns in other languages and with counts', () => {
    for (const s of ['^(antworten|gefällt mir|übersetzung anzeigen)$', '^(コメント|ライブコメント)$', '^comments?( \\(\\d+\\))?$', '^[a-z0-9._]{1,30} (joined|is watching)$', 'profile picture of (.+)$']) {
      expect(regexProblem(s), s).toBeNull();
    }
  });
});

describe('parseChatPackOverride', () => {
  it('accepts a partial pack and returns exactly what was sent', () => {
    const sent = { schema: 1, version: '2026-11-20 a', row: { css: ['[data-comment-id]'], idAttrs: ['data-comment-id'] }, timing: { pollMs: 750 } };
    expect(ok(sent)).toEqual(sent);
    expect(ok({ schema: 1, version: 'v1' })).toEqual({ schema: 1, version: 'v1' });
  });

  it('accepts the example pack shipped with the fixtures', () => {
    const file = new URL('./fixtures/pack-obfuscated.json', import.meta.url);
    expect(problems(JSON.parse(fs.readFileSync(file, 'utf8')))).toEqual([]);
  });

  it('accepts the 0.2.40 settings and checks their types and ranges', () => {
    const sent = { schema: 1, version: 'v', container: { climbPreferRows: false }, timing: { backlogAsHistory: false, liveStartGraceMs: 0 } };
    expect(ok(sent)).toEqual(sent);
    expect(problems({ schema: 1, version: 'v', timing: { backlogAsHistory: 'no' } })[0]).toMatch(/^timing\.backlogAsHistory:/);
    expect(problems({ schema: 1, version: 'v', timing: { liveStartGraceMs: 600_001 } })[0]).toMatch(/^timing\.liveStartGraceMs:/);
    expect(problems({ schema: 1, version: 'v', container: { climbPreferRows: 1 } })[0]).toMatch(/^container\.climbPreferRows:/);
  });

  it('refuses unknown keys, wrong types and out-of-range numbers, naming the path', () => {
    expect(problems({ schema: 1, version: 'v', rows: {} })[0]).toMatch(/Unrecognized key/i);
    expect(problems({ schema: 1, version: 'v', row: { script: 'alert(1)' } })[0]).toMatch(/row.*Unrecognized key/i);
    expect(problems({ schema: 2, version: 'v' })[0]).toMatch(/^schema:/);
    expect(problems({ schema: 1 })[0]).toMatch(/^version:/);
    expect(problems({ schema: 1, version: 'v<script>' })[0]).toMatch(/^version:/);
    expect(problems({ schema: 1, version: 'v', timing: { pollMs: 50 } })[0]).toMatch(/^timing\.pollMs:/);
    expect(problems({ schema: 1, version: 'v', timing: { pollMs: 1.5 } })[0]).toMatch(/^timing\.pollMs:/);
    expect(problems({ schema: 1, version: 'v', limits: { maxRows: 100000 } })[0]).toMatch(/^limits\.maxRows:/);
    expect(problems({ schema: 1, version: 'v', tab: { roles: ['dialog'] } })[0]).toMatch(/^tab\.roles\.0:/);
    expect(problems({ schema: 1, version: 'v', row: { idAttrs: ['data-id"] , *[x'] } })[0]).toMatch(/^row\.idAttrs\.0:.*attribute name/);
    expect(problems({ schema: 1, version: 'v', row: { css: ['xpath=//div'] } })[0]).toMatch(/^row\.css\.0: CSS selector: selector engine prefixes/);
    expect(problems({ schema: 1, version: 'v', text: { meta: ['^(a+)+$'] } })[0]).toMatch(/^text\.meta\.0: regular expression: too slow/);
    expect(problems({ schema: 1, version: 'v', row: { css: Array.from({ length: 13 }, () => 'li') } })[0]).toMatch(/^row\.css:/);
    for (const junk of [null, 'pack', 42, [], undefined]) expect(problems(junk).length, String(junk)).toBeGreaterThan(0);
  });

  it('bounds the time spent checking one pack, however many slow patterns it holds', () => {
    const slow = Array.from({ length: 24 }, (_, i) => `^(a+)+${'b'.repeat(i)}$`);
    const started = Date.now();
    const found = problems({ schema: 1, version: 'v', text: { meta: slow }, classify: { event: slow, join: slow, system: slow, pinned: slow } });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toMatch(/too slow/);
    // A good pack right after is checked normally.
    expect(problems(BUILTIN_CHAT_PACK)).toEqual([]);
  });

  it('refuses a pack over the size cap before looking at it', () => {
    const big = { schema: 1, version: 'v', note: 'x'.repeat(CHAT_PACK_MAX_BYTES) };
    expect(problems(big)).toEqual([`body: larger than ${CHAT_PACK_MAX_BYTES} bytes`]);
  });

  it('has no place for code: function-looking strings are only ever selectors or patterns, and fail as such', () => {
    expect(problems({ schema: 1, version: 'v', container: { css: ['"); fetch("https://example.invalid"); ("'] } })[0]).toMatch(/CSS selector/);
    expect(problems({ schema: 1, version: 'v', container: { css: ['div', '() => document.cookie'] } })[0]).toMatch(/container\.css\.1/);
    expect(problems({ schema: 1, version: 'v', extract: '(el) => el.textContent' })[0]).toMatch(/Unrecognized key/i);
  });
});

describe('mergeChatPack', () => {
  it('puts the override on top of the built-in pack, replacing lists whole', () => {
    const merged = mergeChatPack(ok({ schema: 1, version: 'mine', note: 'why', row: { css: ['.c'] }, text: { meta: ['^x$'] }, timing: { pollMs: 2000 } }));
    expect(merged.version).toBe('mine');
    expect(merged.note).toBe('why');
    expect(merged.row.css).toEqual(['.c']);
    expect(merged.row.avatarCss).toEqual(BUILTIN_CHAT_PACK.row.avatarCss);
    expect(merged.text.meta).toEqual(['^x$']);
    expect(merged.timing).toEqual({ ...BUILTIN_CHAT_PACK.timing, pollMs: 2000 });
    expect(merged.classify).toEqual(BUILTIN_CHAT_PACK.classify);
  });

  it('never changes the built-in pack', () => {
    const before = JSON.stringify(BUILTIN_CHAT_PACK);
    const merged = mergeChatPack(ok({ schema: 1, version: 'mine', row: { css: ['.c'] } }));
    merged.row.css.push('.d');
    merged.text.meta.length = 0;
    expect(JSON.stringify(BUILTIN_CHAT_PACK)).toBe(before);
    expect(mergeChatPack(null)).toEqual(BUILTIN_CHAT_PACK);
  });
});

describe('ChatPackStore', () => {
  it('starts on the built-in pack', () => {
    const store = new ChatPackStore();
    expect(store.state()).toMatchObject({ source: 'builtin', override: null, updatedAt: null, updatedBy: null });
    expect(store.active()).toEqual(BUILTIN_CHAT_PACK);
  });

  it('stores an override, survives a restart, and reverts', () => {
    const settings = memorySettings();
    const store = new ChatPackStore();
    store.attach(settings);
    const r0 = store.revision();
    const override = ok({ schema: 1, version: 'tuned-1', row: { css: ['[data-comment-id]'] } });
    store.setOverride(override, 'admin', new Date('2026-11-20T10:00:00Z'));
    expect(store.revision()).toBeGreaterThan(r0);
    expect(store.state()).toMatchObject({ source: 'override', updatedAt: '2026-11-20T10:00:00.000Z', updatedBy: 'admin', builtinVersion: BUILTIN_CHAT_PACK.version });
    expect(store.active().row.css).toEqual(['[data-comment-id]']);
    expect(settings.data.get(CHAT_PACK_SETTING)).toEqual({ override, updatedAt: '2026-11-20T10:00:00.000Z', updatedBy: 'admin' });

    // A new process: the stored override is loaded again.
    const restarted = new ChatPackStore();
    expect(restarted.attach(settings)).toEqual([]);
    expect(restarted.state()).toMatchObject({ source: 'override', updatedBy: 'admin' });
    expect(restarted.active().version).toBe('tuned-1');

    const r1 = restarted.revision();
    expect(restarted.revert()).toBe(true);
    expect(restarted.revision()).toBeGreaterThan(r1);
    expect(restarted.state().source).toBe('builtin');
    expect(settings.data.has(CHAT_PACK_SETTING)).toBe(false);
    expect(restarted.revert()).toBe(false);
  });

  it('an override stored before the upgrade that now only repeats built-in values still loads and works', () => {
    // What was stored on a 0.2.30 server during the live run that led to builtin-3.
    const stored = { schema: 1, version: 'live-1-climb', container: { climbLevels: 10, climbMinHeight: 320 } };
    const settings = memorySettings({ [CHAT_PACK_SETTING]: { override: stored, updatedAt: '2026-11-19T17:20:00.000Z', updatedBy: 'token Support agent' } });
    const store = new ChatPackStore();
    expect(store.attach(settings)).toEqual([]);
    expect(store.state()).toMatchObject({ source: 'override', builtinVersion: 'builtin-3', override: stored });
    // The same settings as the built-in pack, under the operator's label; the new settings come from the built-in pack.
    expect(store.active()).toEqual({ ...BUILTIN_CHAT_PACK, version: 'live-1-climb' });
    expect(overrideIsRedundant(store.state().override!)).toBe(true);
    // Deleting it changes nothing but the label.
    expect(store.revert()).toBe(true);
    expect(store.active()).toEqual(BUILTIN_CHAT_PACK);
    expect(settings.data.has(CHAT_PACK_SETTING)).toBe(false);

    expect(overrideIsRedundant(ok({ schema: 1, version: 'v' }))).toBe(true);
    expect(overrideIsRedundant(ok({ schema: 1, version: 'v', row: { avatarCss: [...BUILTIN_CHAT_PACK.row.avatarCss] } }))).toBe(true);
    expect(overrideIsRedundant(ok({ schema: 1, version: 'v', container: { climbLevels: 10, climbMinHeight: 321 } }))).toBe(false);
    expect(overrideIsRedundant(ok({ schema: 1, version: 'v', row: { css: ['.c'] } }))).toBe(false);
  });

  it('ignores a stored pack that no longer validates, and says why', () => {
    const settings = memorySettings({ [CHAT_PACK_SETTING]: { override: { schema: 1, version: 'old', row: { css: ['xpath=//div'] } }, updatedAt: 'x', updatedBy: 'y' } });
    const store = new ChatPackStore();
    const found = store.attach(settings);
    expect(found[0]).toMatch(/^row\.css\.0:/);
    expect(store.state().source).toBe('builtin');
    // Not deleted: the operator can still read it out of the database and fix it.
    expect(settings.data.has(CHAT_PACK_SETTING)).toBe(true);
    for (const junk of ['text', 7, { override: null }, {}]) {
      const s = new ChatPackStore();
      expect(s.attach(memorySettings({ [CHAT_PACK_SETTING]: junk }))).toEqual([]);
      expect(s.state().source).toBe('builtin');
    }
  });

  it('hands out copies: changing what it returned does not change the stored override', () => {
    const store = new ChatPackStore();
    const override = ok({ schema: 1, version: 'v', row: { css: ['.c'] } });
    store.setOverride(override, null);
    override.row!.css!.push('.changed-later');
    expect(store.state().override?.row?.css).toEqual(['.c']);
    expect(store.active().row.css).toEqual(['.c']);
  });
});
