import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BUILTIN_CHAT_PACK } from './chat-pack.js';
import {
  alignWindow,
  CHAT_SCAN_SOURCE,
  CHAT_SNAPSHOT_SOURCE,
  MAX_DECISIONS,
  MAX_SETTLE_MS,
  newChatMemory,
  newestFirst,
  reconcile,
  scanExpression,
  snapshotExpression,
  type ChatMemory,
  type ScanResult,
  type ScanRow,
} from './chat-scan.js';

let nextEl = 1;
/** A parsed row; `n` (the element) is new unless given. */
function row(author: string, text: string, over: Partial<ScanRow> = {}): ScanRow {
  return { n: nextEl++, id: null, author, text, kind: 'message', join: false, avatarUrl: null, badges: null, drop: null, restored: false, hasAvatar: true, ...over };
}
function scan(rows: ScanRow[], over: Partial<ScanResult> = {}): ScanResult {
  return { doc: 'doc-1', ready: true, container: { strategy: 'tabpanel', tag: 'div', role: 'tabpanel' }, rows, truncated: 0, bad: [], ...over };
}
const OPTS = { packRevision: 1, historySize: 500 };
const texts = (rows: ScanRow[]) => rows.map((r) => `${r.author}: ${r.text}`);
/** One read: returns what was delivered. */
const read = (memory: ChatMemory, rows: ScanRow[], over: Partial<ScanResult> = {}) => texts(reconcile(memory, scan(rows, over), OPTS));
/** A memory that has already taken its (empty) baseline. */
function started(): ChatMemory {
  const memory = newChatMemory();
  reconcile(memory, scan([]), OPTS);
  return memory;
}
/** The same rows as new elements (what a re-render produces). */
const remount = (rows: ScanRow[]): ScanRow[] => rows.map((r) => ({ ...r, n: nextEl++ }));

describe('page scripts', () => {
  it('are valid JavaScript whatever the pack holds, and carry the pack as data', () => {
    const hostile = structuredClone(BUILTIN_CHAT_PACK);
    hostile.version = '`); globalThis.pwned = 1; (`';
    hostile.container.css = ['"]); globalThis.pwned = 1; //'];
    hostile.text.meta = ["'); globalThis.pwned = 1; ('"];
    const expressions: [string, string][] = [
      [CHAT_SCAN_SOURCE, scanExpression({ pack: hostile, packRevision: 1, stateKey: '__k', keep: 'tail' })],
      [CHAT_SNAPSHOT_SOURCE, snapshotExpression({ pack: hostile, scope: 'container', up: 0, maxNodes: 50, maxDepth: 5, maxChildren: 5 })],
    ];
    for (const [source, expression] of expressions) {
      expect(() => new vm.Script(expression)).not.toThrow();
      // The fixed function, called with one JSON literal: the pack is nowhere else.
      const prefix = `(${source})(`;
      expect(expression.startsWith(prefix)).toBe(true);
      expect(expression.endsWith(')')).toBe(true);
      const arg = JSON.parse(expression.slice(prefix.length, -1)) as { pack: unknown };
      expect(arg.pack).toEqual(hostile);
    }
    expect((globalThis as { pwned?: unknown }).pwned).toBeUndefined();
  });

  it('never build code from strings', () => {
    for (const source of [CHAT_SCAN_SOURCE, CHAT_SNAPSHOT_SOURCE]) {
      expect(source).not.toMatch(/\beval\s*\(|new Function|setTimeout\s*\(\s*['"`]|innerHTML|document\.write|\bimport\s*\(/);
    }
  });

  it('the snapshot script has no way to return text: text nodes become numbers', () => {
    expect(CHAT_SNAPSHOT_SOURCE).toContain('const item = { text: t.length }');
    expect(CHAT_SNAPSHOT_SOURCE).not.toMatch(/location\.href|document\.cookie|localStorage|\.search\b/);
  });
});

describe('alignWindow', () => {
  it('finds how much of a window the history already covers', () => {
    expect(alignWindow(['a', 'b', 'c'], ['b', 'c', 'd'])).toBe(2);
    expect(alignWindow(['a', 'b', 'c'], ['a', 'b'])).toBe(2); // sits inside the history
    expect(alignWindow(['a', 'b', 'c'], ['c', 'd', 'e'])).toBe(1);
    expect(alignWindow(['a', 'b', 'c'], ['x', 'y'])).toBe(-1);
    expect(alignWindow([], ['x'])).toBe(-1);
    expect(alignWindow(['a'], [])).toBe(0);
    // Repeats: the earliest alignment explains the most.
    expect(alignWindow(['x', 'x', 'x'], ['x', 'x', 'x', 'x'])).toBe(3);
    expect(alignWindow(['a', 'b', 'a', 'b'], ['a', 'b', 'c'])).toBe(2);
  });
});

describe('reconcile: what is new', () => {
  it('takes what is on screen at the first read as the baseline, then delivers additions', () => {
    const memory = newChatMemory();
    const a = row('ann', 'hello');
    const b = row('bob', 'hi');
    expect(read(memory, [a, b])).toEqual([]);
    expect(read(memory, [a, b])).toEqual([]);
    const c = row('cat', 'new one');
    expect(read(memory, [a, b, c])).toEqual(['cat: new one']);
    expect(read(memory, [a, b, c])).toEqual([]);
    expect(memory.decisions.map((d) => `${d.verdict}:${d.reason}`)).toEqual(['dropped:baseline', 'dropped:baseline', 'kept:new']);
  });

  it('delivers the same words again when they are a new row', () => {
    const memory = started();
    const a = row('ann', 'lol');
    expect(read(memory, [a])).toEqual(['ann: lol']);
    const b = row('ann', 'lol');
    expect(read(memory, [a, b])).toEqual(['ann: lol']);
    const c = row('ann', 'lol');
    expect(read(memory, [a, b, c])).toEqual(['ann: lol']);
  });

  it('delivers the comments that were posted while the comments tab was not selected', () => {
    const memory = newChatMemory();
    // The reader starts, the panel is not open: an empty baseline.
    expect(read(memory, [], { container: null })).toEqual([]);
    expect(read(memory, [], { container: null })).toEqual([]);
    // The tab gets selected and shows what viewers wrote meanwhile.
    const backlog = [row('ann', 'first'), row('bob', 'second')];
    expect(read(memory, backlog)).toEqual(['ann: first', 'bob: second']);
    expect(read(memory, backlog)).toEqual([]);
  });

  it('waits for a page that is still loading before taking an empty baseline (bounded)', () => {
    const memory = newChatMemory();
    const t0 = new Date('2026-01-01T00:00:00Z');
    const at = (ms: number) => ({ ...OPTS, now: new Date(t0.getTime() + ms) });
    expect(reconcile(memory, scan([], { ready: false }), at(0))).toEqual([]);
    expect(memory.baselined).toBe(false);
    // The existing comments render while the page loads: they are the baseline, not new.
    const old = [row('ann', 'from before'), row('bob', 'also before')];
    expect(reconcile(memory, scan(old, { ready: false }), at(1_000))).toEqual([]);
    expect(memory.baselined).toBe(true);
    expect(texts(reconcile(memory, scan([...old, row('cat', 'fresh')]), at(2_000)))).toEqual(['cat: fresh']);

    // A page that never finishes loading is not waited for forever.
    const slow = newChatMemory();
    reconcile(slow, scan([], { ready: false }), at(0));
    reconcile(slow, scan([], { ready: false }), at(MAX_SETTLE_MS - 1));
    expect(slow.baselined).toBe(false);
    reconcile(slow, scan([], { ready: false }), at(MAX_SETTLE_MS));
    expect(slow.baselined).toBe(true);
  });
});

describe('reconcile: re-renders are not new comments', () => {
  it('does not deliver a re-mounted list again (every row a new element, same content)', () => {
    const memory = started();
    const rows = [row('ann', 'one'), row('bob', 'two'), row('ann', 'one'), row('cat', 'three')];
    expect(read(memory, rows)).toHaveLength(4);
    expect(read(memory, remount(rows))).toEqual([]);
    expect(memory.decisions.slice(-4).every((d) => d.verdict === 'dropped' && d.reason === 'rerender')).toBe(true);
    // A re-mount that also brings one new comment delivers exactly that one.
    const again = remount(rows);
    expect(read(memory, [...again, row('dee', 'four')])).toEqual(['dee: four']);
  });

  it('does not deliver the list again when the tab is switched away and back', () => {
    const memory = started();
    const rows = [row('ann', 'one'), row('bob', 'two')];
    read(memory, rows);
    expect(read(memory, [], { container: null })).toEqual([]); // another tab: no panel
    expect(read(memory, remount(rows))).toEqual([]);
  });

  it('does not deliver the list again after the page reloads, and still delivers what arrived meanwhile', () => {
    const memory = started();
    const rows = [row('ann', 'one'), row('bob', 'two'), row('cat', 'three')];
    read(memory, rows);
    // The reload: a new document, nothing readable for a moment, then the newest comments again.
    expect(read(memory, [], { doc: 'doc-2', ready: false, container: null })).toEqual([]);
    const after = [...remount(rows).slice(1), row('dee', 'during the reload')];
    expect(read(memory, after, { doc: 'doc-2' })).toEqual(['dee: during the reload']);
    expect(read(memory, after, { doc: 'doc-2' })).toEqual([]);
  });

  it('does not deliver again when a restarted source reads the same live (shared memory, new elements)', () => {
    const memory = started();
    const rows = [row('ann', 'one'), row('bob', 'two')];
    read(memory, rows);
    // The ChatHub restarted the source: same memory, the page's rows are numbered from scratch.
    expect(read(memory, remount(rows))).toEqual([]);
  });

  it('copes with a virtualised list: old rows leave, scrolled-back rows are re-created', () => {
    const memory = started();
    const all = Array.from({ length: 12 }, (_, i) => row(`user${i % 3}`, `comment ${i}`));
    for (let i = 1; i <= all.length; i++) read(memory, all.slice(Math.max(0, i - 5), i)); // a 5-row window following the chat
    expect(memory.kept).toBe(12);
    // The list scrolls up: rows 4..6 are created again above the ones on screen.
    const window = [...remount(all.slice(4, 7)), ...all.slice(7, 12)];
    expect(read(memory, window)).toEqual([]);
    // It scrolls all the way up (nothing known on screen): still nothing new.
    expect(read(memory, remount(all.slice(0, 5)))).toEqual([]);
    // Back at the bottom with two new comments.
    expect(read(memory, [...remount(all.slice(9, 12)), row('user9', 'comment 12'), row('user9', 'comment 13')])).toEqual(['user9: comment 12', 'user9: comment 13']);
    expect(memory.kept).toBe(14);
  });

  it('delivers a whole new screen of comments when the chat moved on between two reads', () => {
    const memory = started();
    read(memory, [row('ann', 'one'), row('bob', 'two')]);
    expect(read(memory, [row('cat', 'three'), row('dee', 'four'), row('eve', 'five')])).toEqual(['cat: three', 'dee: four', 'eve: five']);
  });

  it('does not deliver the rest of the list again when a comment in the middle was removed', () => {
    const memory = started();
    const rows = [row('ann', 'one'), row('bob', 'spam'), row('cat', 'three'), row('dee', 'four')];
    read(memory, rows);
    const without = remount([rows[0]!, rows[2]!, rows[3]!]);
    expect(read(memory, [...without, row('eve', 'five')])).toEqual(['eve: five']);
  });

  it('delivers a recycled element whose content changed', () => {
    const memory = started();
    const a = row('ann', 'one');
    const b = row('bob', 'two');
    read(memory, [a, b]);
    // The list reuses bob's element for a new comment.
    expect(read(memory, [a, { ...b, author: 'cat', text: 'three' }])).toEqual(['cat: three']);
  });

  it('a pinned copy that the page did not recognise is still not delivered twice', () => {
    const memory = started();
    const rows = [row('ann', 'pin me'), row('bob', 'two')];
    read(memory, rows);
    expect(read(memory, [row('ann', 'pin me'), ...rows])).toEqual([]); // the copy appears above the list
    expect(memory.decisions.at(-1)).toMatchObject({ verdict: 'dropped', reason: 'rerender' });
  });
});

describe('reconcile: rows the page ruled out, ids, packs, direction', () => {
  it('logs pinned copies and system notices once and never delivers them', () => {
    const memory = started();
    const pinned = row('ann', 'pinned text', { drop: 'pinned' });
    const system = row('Instagram', 'notice', { drop: 'system', hasAvatar: false });
    const empty = row('bob', '', { drop: 'empty' });
    const real = row('cat', 'real');
    expect(read(memory, [pinned, system, empty, real])).toEqual(['cat: real']);
    expect(read(memory, [pinned, system, empty, real])).toEqual([]);
    expect(memory.decisions.map((d) => d.reason)).toEqual(['pinned', 'system', 'new']);
    // A row that was still empty is delivered once it has text.
    expect(read(memory, [pinned, system, { ...empty, text: 'late text', drop: null }, real])).toEqual(['bob: late text']);
  });

  it('dedupes by comment id when the page has one, wherever the row shows up', () => {
    const memory = started();
    const a = row('ann', 'one', { id: 'c1' });
    const b = row('bob', 'two', { id: 'c2' });
    expect(read(memory, [a, b])).toHaveLength(2);
    expect(read(memory, remount([a, b]))).toEqual([]);
    // Same words, new id: a new comment even in the middle of the list.
    expect(read(memory, [a, row('ann', 'one', { id: 'c3' }), b])).toEqual(['ann: one']);
    expect(read(memory, [row('ann', 'again', { id: 'c1' })], { doc: 'doc-2' })).toEqual([]);
    expect(memory.decisions.at(-1)).toMatchObject({ verdict: 'dropped', reason: 'duplicate-id', hasId: true });
  });

  it('takes a new baseline when the selector pack changes (rows may parse differently)', () => {
    const memory = started();
    const rows = [row('ann', 'one'), row('bob', 'two')];
    read(memory, rows);
    // Under the new pack the same elements read differently (say, without a leaked label).
    const reparsed = rows.map((r) => ({ ...r, text: `${r.text} (clean)` }));
    expect(texts(reconcile(memory, scan(reparsed), { ...OPTS, packRevision: 2 }))).toEqual([]);
    expect(memory.decisions.slice(-2).map((d) => d.reason)).toEqual(['pack-changed', 'pack-changed']);
    expect(texts(reconcile(memory, scan([...reparsed, row('cat', 'three')]), { ...OPTS, packRevision: 2 }))).toEqual(['cat: three']);
  });

  it('delivers what a new pack finds when the old one could not read anything', () => {
    const memory = started();
    // The reader is blind (Instagram changed its page): reads find a container but no rows.
    expect(read(memory, [])).toEqual([]);
    // The operator stores a pack that works: the comments on screen were never delivered.
    const rows = [row('ann', 'missed one'), row('bob', 'missed two')];
    expect(texts(reconcile(memory, scan(rows), { ...OPTS, packRevision: 2 }))).toEqual(['ann: missed one', 'bob: missed two']);
    expect(texts(reconcile(memory, scan(rows), { ...OPTS, packRevision: 2 }))).toEqual([]);
  });

  it('learns a newest-first list and then treats the top as the new end', () => {
    const memory = started();
    let list: ScanRow[] = [row('ann', 'c0')];
    read(memory, list);
    const delivered: string[] = [];
    for (let i = 1; i <= 6; i++) {
      list = [row('ann', `c${i}`), ...list];
      delivered.push(...read(memory, list));
    }
    expect(delivered).toEqual(['ann: c1', 'ann: c2', 'ann: c3', 'ann: c4', 'ann: c5', 'ann: c6']);
    expect(newestFirst(memory)).toBe(true);
    // Now a repeat of earlier words at the top is a new comment, and two at once come out oldest first.
    list = [row('bob', 'second'), row('ann', 'c1'), ...list];
    expect(read(memory, list)).toEqual(['ann: c1', 'bob: second']);
    // A re-mount of a newest-first list delivers nothing.
    expect(read(memory, remount(list))).toEqual([]);
  });

  it('keeps bounded state and a redacted decision log', () => {
    const memory = started();
    const secretAuthor = 'very_private_user';
    const secretText = 'a very private sentence';
    let list: ScanRow[] = [];
    for (let i = 0; i < 700; i++) {
      list = [...list.slice(-20), row(secretAuthor, `${secretText} ${i}`)];
      reconcile(memory, scan(list), { packRevision: 1, historySize: 100 });
    }
    expect(memory.kept).toBe(700);
    expect(memory.history.length).toBeLessThanOrEqual(100);
    expect(memory.decisions).toHaveLength(MAX_DECISIONS);
    const log = JSON.stringify(memory.decisions);
    expect(log).not.toContain(secretAuthor);
    expect(log).not.toContain('private');
    expect(memory.decisions.at(-1)).toEqual({
      at: expect.any(String),
      row: expect.any(Number),
      verdict: 'kept',
      reason: 'new',
      kind: 'message',
      join: false,
      authorLength: secretAuthor.length,
      textLength: `${secretText} 699`.length,
      hasAvatar: true,
      hasId: false,
      restored: false,
    });
  });
});
