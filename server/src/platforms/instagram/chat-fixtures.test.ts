// The comments reader against synthetic HTML fixtures (fixtures/README.md), in real headless Chromium.

import fs from 'node:fs';
import pino from 'pino';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTimeout } from '../../browser/helpers.js';
import type { ChatMessageInput } from '../types.js';
import { activeChatReaderCount, captureChatDebug, instagramChat } from './chat.js';
import { BUILTIN_CHAT_PACK, chatPackStore, mergeChatPack, parseChatPackOverride, type ChatPackOverride, type IgChatPack } from './chat-pack.js';
import { newChatMemory, scanExpression, snapshotExpression, type ChatMemory, type ScanResult, type ScanRow, type SnapshotNode, type SnapshotResult, type SnapshotText } from './chat-scan.js';
import { CHAT_CONTAINER_ATTR, CHAT_ROW_ATTR } from './selectors.js';

const fixture = (name: string): string => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const PANEL = fixture('comments-panel.html');
const OBFUSCATED = fixture('comments-obfuscated.html');
const OBFUSCATED_PACK = ((): ChatPackOverride => {
  const parsed = parseChatPackOverride(JSON.parse(fixture('pack-obfuscated.json')));
  if (!parsed.ok) throw new Error(parsed.problems.join('; '));
  return parsed.override;
})();
const ORIGIN = 'http://fixture.test';
const log = pino({ level: 'silent' });
const TIMINGS = { pollMs: 200, tabRetryMs: 600 };

/** Everything a person "wrote" in the fixtures: none of it may show up in a debug capture. */
const PRIVATE = ['fixture_user', 'fixture_host', 'love the stream', 'word0', 'word7', 'no avatar on this one', 'telling your followers', 'first comment', 'new layout', '🔥', '🎉'];

const scanOnce = (page: Page, pack: IgChatPack = BUILTIN_CHAT_PACK, stateKey = '__scanTest'): Promise<ScanResult> =>
  page.evaluate(scanExpression({ pack, packRevision: 1, stateKey, keep: 'tail' })) as Promise<ScanResult>;
const snapshot = (page: Page, pack: IgChatPack = BUILTIN_CHAT_PACK, scope: 'container' | 'page' = 'container', up = 0): Promise<SnapshotResult> =>
  page.evaluate(snapshotExpression({ pack, scope, up, maxNodes: 400, maxDepth: 14, maxChildren: 40 })) as Promise<SnapshotResult>;
const view = (r: ScanRow) => ({ author: r.author, text: r.text, kind: r.kind, join: r.join, drop: r.drop });

function* nodesOf(node: SnapshotNode | SnapshotText): Generator<SnapshotNode> {
  if ('text' in node) return;
  yield node;
  for (const child of node.children ?? []) yield* nodesOf(child);
}

describe.skipIf(!!process.env.CI_NO_BROWSER)('instagram chat reader (Chromium + synthetic fixtures)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    chatPackStore.attach(null); // built-in pack, nothing stored
    context = await browser.newContext();
    await context.route(`${ORIGIN}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: path === '/obfuscated' ? OBFUSCATED : PANEL });
    });
    page = await context.newPage();
  });
  afterEach(async () => {
    await context?.close();
    chatPackStore.attach(null);
  });

  /** Start the reader; `next()` waits for one message, `none()` checks nothing arrives. */
  function startReader(memory: ChatMemory = newChatMemory()) {
    const ctl = new AbortController();
    const it = instagramChat(page, ctl.signal, log, TIMINGS, { comment: null, posted: false }, memory)[Symbol.asyncIterator]();
    let pending: Promise<IteratorResult<ChatMessageInput>> | null = null;
    const pull = () => (pending ??= it.next());
    void pull().catch(() => undefined); // a generator only runs once it is asked for a value
    return {
      async next(ms = 6_000): Promise<ChatMessageInput> {
        const r = await withTimeout(pull(), ms, 'no chat message');
        pending = null;
        if (r.done) throw new Error('chat ended');
        return r.value;
      },
      async none(ms = 1_200): Promise<void> {
        const got = await Promise.race([pull().then((r) => r.value as ChatMessageInput | undefined), new Promise<'quiet'>((resolve) => setTimeout(() => resolve('quiet'), ms))]);
        if (got !== 'quiet') throw new Error(`unexpected chat message: ${JSON.stringify(got)}`);
      },
      async stop(): Promise<void> {
        ctl.abort();
        await withTimeout(pull().catch(() => undefined), 5_000, 'chat did not stop');
      },
    };
  }
  /** Wait until the reader has taken its baseline (first settled read). */
  const baselined = async (memory: ChatMemory): Promise<void> => {
    const deadline = Date.now() + 6_000;
    while (!memory.baselined) {
      if (Date.now() > deadline) throw new Error('the reader never read the page');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  describe('one read of a labelled comments panel (built-in pack)', () => {
    it('tells comments, joins, pinned copies and system notices apart, with mentions, emoji and long text intact', async () => {
      await page.goto(`${ORIGIN}/panel`);
      const result = await scanOnce(page);
      expect(result.container).toEqual({ strategy: 'tabpanel', tag: 'div', role: 'tabpanel' });
      expect(result.bad).toEqual([]);
      const long = Array.from({ length: 100 }, (_, i) => `word${i % 10}`).join(' ');
      expect(result.rows.map(view)).toEqual([
        { author: 'fixture_user_b', text: 'hey @fixture_user_a, love the stream 🔥🔥', kind: 'message', join: false, drop: 'pinned' },
        { author: '', text: "We're telling your followers that you've started a live video.", kind: 'message', join: false, drop: 'system' },
        { author: 'fixture_user_a', text: 'fixture_user_a joined', kind: 'event', join: true, drop: null },
        { author: 'fixture_user_b', text: 'hey @fixture_user_a, love the stream 🔥🔥', kind: 'message', join: false, drop: null },
        { author: 'fixture_user_c', text: long, kind: 'message', join: false, drop: null },
        { author: 'fixture_user_d', text: 'now', kind: 'message', join: false, drop: null },
        { author: 'fixture_user_e', text: '🎉🎉', kind: 'message', join: false, drop: null },
        { author: 'fixture_user_f', text: 'fixture_user_f and 3 others joined', kind: 'event', join: true, drop: null },
        { author: 'fixture_user_a', text: 'Pinned', kind: 'message', join: false, drop: null },
        { author: 'fixture_user_g', text: 'fixture_user_g requested to join', kind: 'event', join: false, drop: null },
        { author: 'fixture_user_h', text: 'no avatar on this one', kind: 'message', join: false, drop: null },
      ]);
      const by = (author: string) => result.rows.find((r) => r.author === author && !r.drop)!;
      expect(by('fixture_user_c').badges).toEqual(['verified']); // also: the curly apostrophe in the alt
      expect(by('fixture_user_d').restored).toBe(true); // "now" reads like a timestamp label
      expect(by('fixture_user_h').hasAvatar).toBe(false);
      // The comment box is never a row; the reader's tags are on the container and on each row.
      expect(await page.locator(`[${CHAT_ROW_ATTR}]`).count()).toBe(11);
      expect(await page.locator(`.composer[${CHAT_ROW_ATTR}], .composer [${CHAT_ROW_ATTR}]`).count()).toBe(0);
      expect(await page.locator(`#panel[${CHAT_CONTAINER_ATTR}="tabpanel"]`).count()).toBe(1);
    });

    it('gives each element a stable number and reads a changed row again', async () => {
      await page.goto(`${ORIGIN}/panel`);
      const first = await scanOnce(page);
      const second = await scanOnce(page);
      expect(second.rows.map((r) => r.n)).toEqual(first.rows.map((r) => r.n));
      await page.evaluate(`document.querySelector('[data-fx="label-like"] .t').textContent = 'edited text'`);
      const third = await scanOnce(page);
      expect(third.rows.find((r) => r.author === 'fixture_user_d')).toMatchObject({ text: 'edited text', restored: false, n: first.rows.find((r) => r.author === 'fixture_user_d')!.n });
    });

    it('stops treating a wrapper as a row once it holds more than one comment', async () => {
      await page.goto(`${ORIGIN}/panel`);
      // An empty list whose first comment arrives without text yet: the avatar's nearest ancestor with text is the list.
      await page.evaluate(`(() => {
        const list = document.getElementById('list');
        list.innerHTML = '<p>Say something nice</p>';
        document.getElementById('pinned').remove();
        const row = document.createElement('div'); row.className = 'row';
        row.innerHTML = '<a href="/fixture_user_a/"><img class="av" alt="fixture_user_a\\'s profile picture" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="></a><span class="t"></span>';
        list.appendChild(row);
      })()`);
      const early = await scanOnce(page);
      expect(early.rows.map((r) => r.text)).toEqual(['Say something nice']); // the list itself, for now
      await page.evaluate(`document.querySelector('#list .row .t').textContent = 'here now'; window.__add('fixture_user_b', 'second')`);
      const later = await scanOnce(page);
      expect(later.rows.map(view)).toEqual([
        { author: 'fixture_user_a', text: 'here now', kind: 'message', join: false, drop: null },
        { author: 'fixture_user_b', text: 'second', kind: 'message', join: false, drop: null },
      ]);
      expect(await page.locator(`#list[${CHAT_ROW_ATTR}]`).count()).toBe(0); // the stale tag is gone
    });

    it('moves from a heading-based guess to the real panel when it opens', async () => {
      await page.goto(`${ORIGIN}/panel`);
      await page.evaluate(`window.__tab('setup'); const h = document.createElement('h2'); h.textContent = 'Comments'; h.id = 'stray'; document.body.appendChild(h)`);
      const closed = await scanOnce(page);
      expect(closed.container?.strategy).toBe('heading');
      expect(closed.rows).toEqual([]);
      await page.evaluate(`window.__tab('comments')`);
      const open = await scanOnce(page);
      expect(open.container?.strategy).toBe('tabpanel');
      expect(open.rows.length).toBe(11);
      expect(await page.locator(`[${CHAT_CONTAINER_ATTR}]`).count()).toBe(1);
    });
  });

  describe('finding the container', () => {
    it('lets go of a tab panel that now shows another tab, and of nothing while it is merely empty', async () => {
      await page.goto(`${ORIGIN}/panel`);
      expect((await scanOnce(page)).container?.strategy).toBe('tabpanel');
      // No comments yet: still the comments panel.
      await page.evaluate(`window.__keepLast(0); document.getElementById('pinned').remove()`);
      const empty = await scanOnce(page);
      expect(empty.container?.strategy).toBe('tabpanel');
      expect(empty.rows).toEqual([]);
      // The framework reuses the panel element for the "Stream setup" tab.
      await page.evaluate(`(() => {
        const panel = document.getElementById('panel');
        panel.setAttribute('aria-labelledby', 'tab-setup');
        panel.querySelector('.composer').remove();
        document.getElementById('tab-comments').setAttribute('aria-selected', 'false');
      })()`);
      const other = await scanOnce(page);
      expect(other.container).toBeNull();
      expect(await page.locator(`[${CHAT_CONTAINER_ATTR}]`).count()).toBe(0);
    });

    it('does not take a labelled icon inside the Comments tab for the comments', async () => {
      await page.goto(`${ORIGIN}/panel`);
      await page.evaluate(`(() => {
        window.__tab('setup');
        const icon = document.createElement('span');
        icon.setAttribute('aria-label', 'Comments');
        icon.textContent = '*';
        document.getElementById('tab-comments').prepend(icon);
      })()`);
      expect((await scanOnce(page)).container).toBeNull();
    });

    it('prefers a guess that has rows over an earlier guess that has none', async () => {
      await page.goto(`${ORIGIN}/panel`);
      // No tab panel role any more; an empty region labelled "Comments" sits above the real list.
      await page.evaluate(`(() => {
        document.getElementById('panel').removeAttribute('role');
        const region = document.createElement('section');
        region.setAttribute('aria-label', 'Comments');
        region.style.minHeight = '10px';
        region.textContent = ' ';
        document.body.prepend(region);
      })()`);
      const result = await scanOnce(page);
      expect(result.container?.strategy).toBe('composer');
      expect(result.rows.length).toBe(11);
    });
  });

  describe('a redesigned page', () => {
    it('is not readable with the built-in pack and readable with an override, comment ids included', async () => {
      await page.goto(`${ORIGIN}/obfuscated`);
      const blind = await scanOnce(page);
      expect(blind.container).toBeNull();
      expect(blind.rows).toEqual([]);

      const tuned = await scanOnce(page, mergeChatPack(OBFUSCATED_PACK), '__scanTuned');
      expect(tuned.container?.strategy).toBe('css');
      expect(tuned.rows.map((r) => ({ id: r.id, author: r.author, text: r.text, drop: r.drop }))).toEqual([
        { id: 'c1001', author: 'fixture_user_a', text: 'first comment in the new layout', drop: null },
        // With an explicit text selector a comment that reads like a label is simply the comment.
        { id: 'c1002', author: 'fixture_user_b', text: 'like', drop: null },
      ]);
    });

    it('reports pack entries the page cannot use instead of failing', async () => {
      await page.goto(`${ORIGIN}/obfuscated`);
      const pack = mergeChatPack(OBFUSCATED_PACK);
      pack.row.css = ['[data-comment-id]', 'div:unknown-pseudo(x)'];
      pack.text.skipCss = ['time', ':::'];
      const result = await scanOnce(page, pack, '__scanBad');
      expect(result.rows).toHaveLength(2);
      expect(result.bad.sort()).toEqual(['row.css[1]', 'text.skipCss[1]']);
    });

    it('a pack cannot run code in the page: hostile strings are only ever selectors and patterns', async () => {
      await page.goto(`${ORIGIN}/obfuscated`);
      const pack = mergeChatPack(OBFUSCATED_PACK);
      pack.version = '`); window.pwned = 1; (`';
      pack.container.css = ['"]); window.pwned = 1; //', '[data-testid="live-comments"]'];
      pack.text.meta = ["'); window.pwned = 1; ('", '<img src=x onerror="window.pwned=1">'];
      pack.row.idAttrs = ['data-comment-id', 'onclick'];
      const result = await scanOnce(page, pack, '__scanHostile');
      expect(result.rows).toHaveLength(2);
      await snapshot(page, pack, 'page');
      expect(await page.evaluate('window.pwned')).toBeUndefined();
    });
  });

  describe('debug snapshot', () => {
    it('keeps the structure of the panel and none of what people wrote', async () => {
      await page.goto(`${ORIGIN}/panel`);
      await scanOnce(page);
      const snap = await snapshot(page);
      const json = JSON.stringify(snap);
      for (const secret of PRIVATE) expect(json, secret).not.toContain(secret);
      expect(json).not.toMatch(/https?:\/\/|data:image|base64/);

      expect(snap.page).toEqual({ host: 'fixture.test', pathSegments: 1, ready: true, title: expect.any(Number) });
      expect(snap.container).toMatchObject({ strategy: 'tabpanel', tag: 'div', role: 'tabpanel', rows: 11 });
      expect(snap.root).toBe('container');
      expect(snap.tree).toMatchObject({ tag: 'div', ctd: 'container', attrs: { role: 'tabpanel' } });
      const nodes = [...nodesOf(snap.tree!)];
      expect(nodes.filter((n) => n.ctd === 'row')).toHaveLength(11);
      // Class names and structural attributes are kept.
      expect(nodes.some((n) => n.class?.includes('pin-label'))).toBe(true);
      expect(nodes.some((n) => n.tag === 'span' && n.attrs?.role === 'button')).toBe(true);
      // Avatar alts hold a user name: length and what they match, nothing else.
      const avatar = nodes.find((n) => n.tag === 'img' && n.class?.includes('av'))!;
      expect(avatar.labels!.alt).toEqual({ len: "fixture_user_b's profile picture".length, is: ['avatarAlt'] });
      expect(avatar.data).toEqual({ src: 'data' });
      // Links: how deep the path is, never the path.
      expect(nodes.find((n) => n.tag === 'a')!.data).toEqual({ href: 'path/1' });
      // An interface label is readable; text nodes are lengths, with what they match.
      const input = nodes.find((n) => n.tag === 'input')!;
      expect(input.labels!.placeholder).toEqual({ len: 14, is: ['composerHint'], text: 'add a comment…' });
      const pinLabel = nodes.find((n) => n.class?.includes('pin-label'))!;
      expect(pinLabel.children).toEqual([{ text: 6, is: ['pinned'] }]);
      const metaTexts = nodes.filter((n) => n.class?.includes('meta')).flatMap((n) => [...nodesOf(n)]).flatMap((n) => n.children ?? []).filter((c): c is SnapshotText => 'text' in c);
      expect(metaTexts.every((t) => t.is?.includes('meta'))).toBe(true);
      // data-* values: shown only when made of interface words, else their shape.
      const fx = nodes.map((n) => n.data?.['data-fx']).filter(Boolean);
      expect(fx).toContain('=join');
      expect(fx).toContain('word/11'); // "pinned-copy"

      // Which pack selectors match what.
      expect(snap.selectors['row.avatarCss[0]']).toEqual({ page: 10, container: 10, visible: 10 });
      expect(snap.selectors['row.fallbackCss[0]']).toEqual({ page: 2, container: 2, visible: 2 });
      expect(snap.selectors['classify.verifiedCss[0]']).toMatchObject({ page: 1, container: 1 });
      expect(snap.patterns).toMatchObject({ 'row.avatarAlt': 10, 'container.composerHint': 1, 'tab.name': 1 });
      expect(snap.bad).toEqual([]);
    });

    it('shows a page the reader cannot read: masked labels, attribute names, selector counts of zero', async () => {
      await page.goto(`${ORIGIN}/obfuscated`);
      await scanOnce(page);
      const snap = await snapshot(page, BUILTIN_CHAT_PACK, 'container'); // no container: falls back to the page
      expect(snap.container).toBeNull();
      expect(snap.root).toBe('page');
      const json = JSON.stringify(snap);
      for (const secret of PRIVATE) expect(json, secret).not.toContain(secret);
      const nodes = [...nodesOf(snap.tree!)];
      const list = nodes.find((n) => n.data?.['data-testid'])!;
      expect(list.data).toMatchObject({ 'data-testid': '=live-comments', id: 'word/4' });
      const row = nodes.find((n) => n.data?.['data-comment-id'])!;
      expect(row.data!['data-comment-id']).toBe('hex/5'); // "c1001": the shape, never the id
      expect(row.class).toEqual(['x9f619', 'x1lliihq']);
      // The new avatar alt: its interface words, the user name masked.
      const img = nodes.find((n) => n.tag === 'img')!;
      expect(img.labels!.alt).toEqual({ len: 'Profile photo of fixture_user_a'.length, text: 'profile photo of ##############' });
      expect(snap.selectors['row.avatarCss[0]']).toEqual({ page: 0, container: null, visible: 0 });
      expect(snap.patterns).toMatchObject({ 'row.avatarAlt': 0, 'container.panelLabel': 0 });

      // With the override the same capture shows the pack working.
      const pack = mergeChatPack(OBFUSCATED_PACK);
      await scanOnce(page, pack, '__scanTuned');
      const tuned = await snapshot(page, pack, 'container', 1);
      expect(tuned.root).toBe('ancestor');
      expect(tuned.container).toMatchObject({ strategy: 'css', rows: 2 });
      expect(tuned.selectors['row.css[0]']).toEqual({ page: 2, container: 2, visible: 2 });
      expect(tuned.selectors['row.idAttrs[0]']).toEqual({ page: 2, container: 2, visible: 2 });
      expect(tuned.patterns['row.avatarAlt']).toBe(2);
      for (const secret of PRIVATE) expect(JSON.stringify(tuned), secret).not.toContain(secret);
    });
  });

  describe('the running reader', () => {
    it('delivers only new comments across re-renders, tab switches and a page reload', async () => {
      await page.goto(`${ORIGIN}/panel`);
      const memory = newChatMemory();
      const chat = startReader(memory);
      try {
        await baselined(memory);
        await chat.none(600); // what was on screen is the baseline
        await page.evaluate(`window.__add('fixture_user_a', 'lol')`);
        expect(await chat.next()).toMatchObject({ author: { name: 'fixture_user_a' }, text: 'lol', kind: 'message' });
        await page.evaluate(`window.__add('fixture_user_a', 'lol')`); // the same words again are a new comment
        expect(await chat.next()).toMatchObject({ author: { name: 'fixture_user_a' }, text: 'lol' });

        // The framework re-renders the list: every row is a new element.
        await page.evaluate(`window.__remount()`);
        await chat.none();
        await page.evaluate(`window.__remount(); window.__add('fixture_user_b', 'after the re-render')`);
        expect(await chat.next()).toMatchObject({ text: 'after the re-render' });
        await chat.none(600);

        // A re-render puts the producer back on another tab: the reader reopens "Comments".
        await page.evaluate(`window.__tab('setup')`);
        await page.waitForFunction(`document.getElementById('tab-comments').getAttribute('aria-selected') === 'true'`, undefined, { timeout: 6_000 });
        await chat.none();

        // Old rows leave a long list; nothing is delivered for that.
        await page.evaluate(`window.__keepLast(4)`);
        await chat.none(600);

        // The page reloads (the fixture comes back with its original rows): nothing is delivered again.
        await page.reload();
        await chat.none(1_500);
        await page.evaluate(`window.__add('fixture_user_c', 'after the reload')`);
        expect(await chat.next()).toMatchObject({ author: { name: 'fixture_user_c' }, text: 'after the reload' });
        expect(memory.kept).toBe(4);
      } finally {
        await chat.stop();
      }
    });

    it('opens the comments tab when it is not selected, and delivers what was written meanwhile', async () => {
      await page.goto(`${ORIGIN}/panel`);
      await page.evaluate(`window.__tab('setup'); window.__keepLast(0); document.getElementById('pinned').remove()`);
      // Clicking the tab is slow to register (the first tries change nothing).
      await page.evaluate(`(() => { let n = 0; const tab = document.getElementById('tab-comments'); const open = tab.onclick; tab.onclick = () => { if (++n >= 2) open(); }; })()`);
      const memory = newChatMemory();
      const chat = startReader(memory);
      try {
        await baselined(memory); // an empty baseline: no panel yet
        await page.evaluate(`window.__add('fixture_user_a', 'written before the tab opened'); window.__add('fixture_user_b', 'this one too')`);
        expect(await chat.next()).toMatchObject({ author: { name: 'fixture_user_a' }, text: 'written before the tab opened' });
        expect(await chat.next()).toMatchObject({ author: { name: 'fixture_user_b' }, text: 'this one too' });
        await chat.none(800);
      } finally {
        await chat.stop();
      }
    });

    it('a restarted source for the same live does not deliver the comments on screen again', async () => {
      await page.goto(`${ORIGIN}/panel`);
      const memory = newChatMemory();
      const first = startReader(memory);
      await baselined(memory);
      await page.evaluate(`window.__add('fixture_user_a', 'before the restart')`);
      expect(await first.next()).toMatchObject({ text: 'before the restart' });
      await first.stop();
      expect(activeChatReaderCount()).toBe(0);

      await page.evaluate(`window.__add('fixture_user_b', 'while it was down')`);
      const second = startReader(memory);
      try {
        expect(await second.next()).toMatchObject({ text: 'while it was down' });
        await second.none(800);
      } finally {
        await second.stop();
      }
    });

    it('picks up a new selector pack on the next poll, without restarting, and reverts the same way', async () => {
      await page.goto(`${ORIGIN}/obfuscated`);
      const memory = newChatMemory();
      const chat = startReader(memory);
      try {
        await baselined(memory);
        await page.evaluate(`window.__add('fixture_user_c', 'nobody reads this yet')`);
        await chat.none(800); // the built-in pack cannot read this page

        chatPackStore.setOverride(OBFUSCATED_PACK, 'test');
        // The fix: what is on screen was never delivered, so it is delivered now, with its ids.
        expect(await chat.next()).toMatchObject({ id: 'c1001', author: { name: 'fixture_user_a' }, text: 'first comment in the new layout' });
        expect(await chat.next()).toMatchObject({ id: 'c1002', text: 'like' });
        expect(await chat.next()).toMatchObject({ id: 'c1003', author: { name: 'fixture_user_c' }, text: 'nobody reads this yet' });
        await page.evaluate(`window.__add('fixture_user_a', 'live tuning works')`);
        expect(await chat.next()).toMatchObject({ id: 'c1004', text: 'live tuning works' });
        // The same comment id again (a duplicate render) is not delivered.
        await page.evaluate(`window.__add('fixture_user_a', 'live tuning works', 'c1004')`);
        await chat.none(800);

        chatPackStore.revert();
        await page.evaluate(`window.__add('fixture_user_b', 'unreadable again')`);
        await chat.none(800);
      } finally {
        await chat.stop();
      }
    });

    it('debug capture of a running reader: state, sanitised structure and redacted decisions', async () => {
      expect(await captureChatDebug()).toEqual([]); // no live being read
      await page.goto(`${ORIGIN}/panel`);
      const memory = newChatMemory();
      const chat = startReader(memory);
      try {
        await baselined(memory);
        await page.evaluate(`window.__add('fixture_user_a', 'a private remark')`);
        await chat.next();
        expect(activeChatReaderCount()).toBe(1);
        const [capture] = await captureChatDebug({ decisions: 5 });
        expect(capture!.error).toBeUndefined();
        expect(capture!.reader).toMatchObject({ packVersion: BUILTIN_CHAT_PACK.version, container: 'tabpanel', rows: 12, failures: 0, kept: 1, bad: [], newestFirst: false });
        expect(capture!.tab).toEqual({ matches: 1, visible: true, ariaSelected: 'true' });
        expect(capture!.composer).toEqual({ matches: 1 });
        expect(capture!.snapshot!.container).toMatchObject({ strategy: 'tabpanel', rows: 12 });
        expect(capture!.decisions).toHaveLength(5);
        expect(capture!.decisions.at(-1)).toMatchObject({ verdict: 'kept', reason: 'new', authorLength: 14, textLength: 16, hasAvatar: true });
        expect(capture!.decisions.some((d) => d.reason === 'baseline')).toBe(true);
        const json = JSON.stringify(capture);
        for (const secret of [...PRIVATE, 'private remark']) expect(json, secret).not.toContain(secret);
        // decisions: 0 means none, not all of them.
        expect((await captureChatDebug({ decisions: 0 }))[0]!.decisions).toEqual([]);
        expect((await captureChatDebug({ decisions: 1 }))[0]!.decisions).toHaveLength(1);
      } finally {
        await chat.stop();
      }
    });
  });
});
