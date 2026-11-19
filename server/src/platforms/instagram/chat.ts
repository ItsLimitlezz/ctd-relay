// Live comments, read from the producer page's "Comments" panel.
//
// The panel's markup is not documented and changes often, so everything Instagram-specific lives
// in a selector pack (chat-pack.ts) that an operator can replace on a running server. One loop:
// every poll it runs a fixed script in the page (chat-scan.ts) that finds the comments container,
// tags and parses the rows, then decides in Node which rows are new (reconcile). The pack is read
// again on every poll, so a new one takes effect without restarting the live.

import type { Logger } from 'pino';
import type { Page } from 'playwright';
import { abortable, fillField, humanPause, withTimeout } from '../../browser/helpers.js';
import { DriverError, type ChatMessageInput } from '../types.js';
import { chatPackStore, type IgChatPack } from './chat-pack.js';
import {
  newChatMemory,
  newestFirst,
  reconcile,
  scanExpression,
  snapshotExpression,
  type ChatDecision,
  type ChatMemory,
  type ContainerStrategy,
  type ScanResult,
  type ScanRow,
  type SnapshotResult,
} from './chat-scan.js';
import { click, visibleNow } from './flow.js';
import { DESCRIBE_CONTROLS_SOURCE, sel } from './selectors.js';
import { shortError } from './util.js';

/** Test overrides of the pack's timing (the pack's values apply when unset). */
export interface ChatTimings {
  pollMs?: number;
  tabRetryMs?: number;
}

export const DEFAULT_CHAT_TIMINGS: ChatTimings = {};

/**
 * Posted once into a Practice test live's own comment box (only the account sees Practice lives,
 * and the Instagram app doesn't show your own live), so a rehearsal checks that comments reach the chat.
 */
export const TEST_COMMENT = 'CTD Relay chat test ✅';
const TEST_COMMENT_DELAY_MS = 4_000;
/** No comment read this long after the test comment: log what the reader sees. */
const TEST_COMMENT_CHECK_MS = 20_000;
/** After this long without finding the comments panel, log the reader's state (once). */
const DIAGNOSE_AFTER_MS = 30_000;
/** After this long without a single comment row, log the reader's state (once). */
const DIAGNOSE_ROWS_AFTER_MS = 45_000;
const SCAN_TIMEOUT_MS = 15_000;
/** Reads that fail this many times in a row are reported once. */
const FAILURES_TO_REPORT = 5;
/**
 * A "Comments" control that does not say whether it is selected (no aria-selected) may be a
 * toggle: it is only clicked while no comments panel is showing, and at most this many times in a
 * row without the panel appearing.
 */
const MAX_BLIND_TAB_CLICKS = 3;
const MAX_TEXT = 2000;

/** One test comment per live (shared by the chat source's restarts). */
export interface ChatTest {
  comment: string | null;
  posted: boolean;
}

export type TabOutcome = 'selected' | 'clicked' | 'clicked-blind' | 'state-unknown' | 'not-found' | 'click-failed';

/** What the reader last saw, for logs and the debug capture. Counts and names only. */
export interface ReaderStatus {
  packVersion: string;
  packRevision: number;
  startedAt: string;
  lastReadAt: string | null;
  /** Reads that failed in a row (page busy, reloading). */
  failures: number;
  container: ContainerStrategy | null;
  rows: number;
  truncated: number;
  /** Pack entries the page could not use. */
  bad: string[];
  tab: TabOutcome | null;
  tabClicks: number;
  kept: number;
  dropped: number;
  newestFirst: boolean;
}

interface ActiveReader {
  page: Page;
  memory: ChatMemory;
  status: ReaderStatus;
}

/** Readers running in this process (one per Instagram live), for the debug capture. */
const readers = new Set<ActiveReader>();

/** Open the "Comments" tab of the producer (best effort). `allowBlind`: click a control that does not expose its state. */
async function selectCommentsTab(page: Page, pack: IgChatPack, signal: AbortSignal, allowBlind: boolean): Promise<TabOutcome> {
  const tab = await visibleNow(sel.commentsTab(page, pack.tab));
  if (!tab) return 'not-found';
  const selected = await tab.getAttribute('aria-selected', { timeout: 1000 }).catch(() => null);
  if (selected === 'true') return 'selected';
  if (selected === null && !allowBlind) return 'state-unknown';
  try {
    await click(tab, signal, 3_000);
  } catch (err) {
    if (signal.aborted) throw err;
    return 'click-failed';
  }
  return selected === null ? 'clicked-blind' : 'clicked';
}

/** Type `text` into the producer's comment box and send it. False when there is no comment box. */
async function postComment(page: Page, pack: IgChatPack, text: string, signal: AbortSignal, log: Logger): Promise<boolean> {
  const box = await visibleNow(sel.commentBox(page, pack.composer.css));
  if (!box) {
    const controls = await page.evaluate(`(${DESCRIBE_CONTROLS_SOURCE})()`).catch(() => null);
    log.warn({ controls }, 'Instagram comment box not found for the chat test; visible controls of the producer');
    return false;
  }
  await fillField(box, text, { signal, timeoutMs: 8_000, minDelayMs: 20, maxDelayMs: 60 });
  await humanPause(200, 400, signal);
  const post = await visibleNow(sel.commentPost(page, pack.composer.post), true);
  if (post && (await post.isEnabled({ timeout: 1_000 }).catch(() => false))) await post.click({ timeout: 5_000 });
  else await box.press('Enter', { timeout: 3_000 });
  return true;
}

/**
 * Practice test lives: once the reader runs, post the test comment, then check it came through;
 * when nothing was read, log the reader's state. Best effort, never throws.
 */
async function runChatTest(page: Page, test: ChatTest, signal: AbortSignal, log: Logger, readCount: () => number, status: () => ReaderStatus): Promise<void> {
  if (!test.comment || test.posted) return;
  try {
    await humanPause(TEST_COMMENT_DELAY_MS, TEST_COMMENT_DELAY_MS, signal);
    if (test.posted) return;
    test.posted = true;
    const before = readCount();
    if (!(await postComment(page, chatPackStore.active(), test.comment, signal, log))) return;
    log.info('Instagram chat test comment posted');
    await humanPause(TEST_COMMENT_CHECK_MS, TEST_COMMENT_CHECK_MS, signal);
    if (readCount() > before) {
      log.info('Instagram chat test: the comment reached the chat');
      return;
    }
    log.warn({ reader: status() }, "Instagram chat test: the test comment didn't reach the chat; the comments reader's state");
  } catch (err) {
    if (!signal.aborted) log.warn({ error: shortError(err) }, 'Instagram chat test failed');
  }
}

function toChatInput(row: ScanRow): ChatMessageInput {
  const author: ChatMessageInput['author'] = { name: row.author.slice(0, 100) || 'Unknown' };
  if (row.avatarUrl) author.avatarUrl = row.avatarUrl;
  if (row.badges?.length) author.badges = row.badges;
  const msg: ChatMessageInput = { author, text: row.text.slice(0, MAX_TEXT), ts: new Date().toISOString(), kind: row.kind };
  if (row.id) {
    // A comment id from the page (pack setting row.idAttrs): the hub dedupes on it too.
    msg.id = row.id;
    msg.platformMessageId = row.id;
  }
  if (row.join) msg.join = true;
  return msg;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> => humanPause(ms, ms, signal);

/**
 * Yields new live comments until `signal` aborts (throws if the page closes). `memory` is the
 * live's reader memory: pass the same object to every restart of the source for one live.
 */
export async function* instagramChat(
  page: Page,
  signal: AbortSignal,
  log: Logger,
  timings: ChatTimings = DEFAULT_CHAT_TIMINGS,
  test: ChatTest = { comment: null, posted: false },
  memory: ChatMemory = newChatMemory(),
): AsyncGenerator<ChatMessageInput> {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  if (signal.aborted) return; // aborted before the first read: the listener below would never fire
  signal.addEventListener('abort', stop, { once: true });
  const started = Date.now();
  let pack = chatPackStore.active();
  let revision = chatPackStore.revision();
  const status: ReaderStatus = {
    packVersion: pack.version,
    packRevision: revision,
    startedAt: new Date(started).toISOString(),
    lastReadAt: null,
    failures: 0,
    container: null,
    rows: 0,
    truncated: 0,
    bad: [],
    tab: null,
    tabClicks: 0,
    kept: memory.kept,
    dropped: memory.dropped,
    newestFirst: newestFirst(memory),
  };
  const reader: ActiveReader = { page, memory, status };
  readers.add(reader);
  let read = 0;
  const tester = runChatTest(page, test, ctl.signal, log, () => read, () => ({ ...status }));
  try {
    let nextTabAt = 0;
    let blindLeft = MAX_BLIND_TAB_CLICKS;
    let warnedBlind = false;
    let warnedBad = -1;
    let diagnosedPanel = false;
    let diagnosedRows = false;
    let sawContainer = false;
    let sawRows = false;
    let scan: ScanResult | null = null;

    while (!ctl.signal.aborted) {
      if (page.isClosed()) throw new DriverError('The chat page was closed', 'platform-error');

      // A new selector pack (admin API) takes effect here, on the next poll.
      if (chatPackStore.revision() !== revision) {
        pack = chatPackStore.active();
        revision = chatPackStore.revision();
        status.packVersion = pack.version;
        status.packRevision = revision;
        nextTabAt = 0;
        blindLeft = MAX_BLIND_TAB_CLICKS;
        log.info({ version: pack.version, source: chatPackStore.state().source }, 'Instagram chat reader: selector pack changed');
      }
      const pollMs = Math.max(200, timings.pollMs ?? pack.timing.pollMs);
      const tabRetryMs = Math.max(200, timings.tabRetryMs ?? pack.timing.tabRetryMs);

      try {
        const expression = scanExpression({ pack, packRevision: revision, stateKey: memory.stateKey, keep: newestFirst(memory) ? 'head' : 'tail' });
        scan = await abortable(withTimeout(page.evaluate(expression) as Promise<ScanResult>, SCAN_TIMEOUT_MS, 'Chat scan timed out'), ctl.signal);
      } catch (err) {
        if (ctl.signal.aborted) break;
        // Navigation in progress, context destroyed, slow page: try again, more slowly while it lasts.
        scan = null;
        status.failures++;
        if (status.failures === FAILURES_TO_REPORT) log.warn({ error: shortError(err), failures: status.failures }, "Instagram comments can't be read right now (page busy or reloading); retrying");
      }

      if (scan) {
        if (status.failures >= FAILURES_TO_REPORT) log.info('Instagram comments are being read again');
        status.failures = 0;
        status.lastReadAt = new Date().toISOString();
        status.container = scan.container?.strategy ?? null;
        status.rows = scan.rows.length;
        status.truncated = scan.truncated;
        status.bad = scan.bad;
        if (scan.bad.length > 0 && warnedBad !== revision) {
          warnedBad = revision;
          log.warn({ bad: scan.bad, version: pack.version }, 'Instagram chat reader: the page could not use some selector pack entries');
        }
        if (scan.container) {
          sawContainer = true;
          if (scan.container.strategy !== 'heading') blindLeft = MAX_BLIND_TAB_CLICKS;
        }
        if (scan.rows.length > 0) sawRows = true;
        const fresh = reconcile(memory, scan, { packRevision: revision, historySize: pack.limits.history });
        status.kept = memory.kept;
        status.dropped = memory.dropped;
        status.newestFirst = newestFirst(memory);
        for (const row of fresh) {
          if (ctl.signal.aborted) break;
          read++;
          yield toChatInput(row);
        }
      }

      // The comments only render while the "Comments" tab is selected. Open it when the last read
      // found no panel (at the start, and whenever a re-render put the producer back on another
      // tab). Decided from a read, never before the first one or while the page cannot be read: a
      // click on a control that does not say whether it is selected could close an open panel.
      if (scan) {
        const panelOpen = !!scan.container && scan.container.strategy !== 'heading';
        const sureOpen = !!scan.container && (scan.container.strategy === 'css' || scan.container.strategy === 'tabpanel');
        const wantTab = !panelOpen || (scan.rows.length === 0 && !sureOpen);
        if (wantTab && Date.now() >= nextTabAt) {
          nextTabAt = Date.now() + tabRetryMs;
          try {
            status.tab = await selectCommentsTab(page, pack, ctl.signal, !panelOpen && blindLeft > 0);
          } catch (err) {
            if (ctl.signal.aborted) break;
            status.tab = 'click-failed';
            log.debug({ error: shortError(err) }, 'Instagram comments tab not selected');
          }
          if (status.tab === 'clicked' || status.tab === 'clicked-blind') status.tabClicks++;
          if (status.tab === 'clicked-blind') blindLeft--;
          if (status.tab === 'click-failed') log.debug('Instagram comments tab not selected (the click failed)');
          if (!panelOpen && blindLeft === 0 && !warnedBlind) {
            warnedBlind = true;
            log.warn({ reader: { ...status } }, "Instagram comments panel didn't open after clicking the Comments control; not clicking it again (tune the selector pack)");
          }
        }
      }

      const waited = Date.now() - started;
      if (!diagnosedPanel && !sawContainer && waited >= DIAGNOSE_AFTER_MS) {
        diagnosedPanel = true;
        log.warn({ reader: { ...status } }, 'Instagram comments panel not found; the reader state (POST …/instagram/chat/debug shows the page structure)');
      }
      if (!diagnosedRows && !sawRows && waited >= DIAGNOSE_ROWS_AFTER_MS) {
        diagnosedRows = true;
        log.warn({ reader: { ...status } }, 'no Instagram comment rows found yet; the reader state (POST …/instagram/chat/debug shows the page structure)');
      }

      const wait = scan ? pollMs : Math.min(pollMs * 2 ** Math.min(status.failures, 6), Math.max(pollMs, pack.timing.backoffMaxMs));
      try {
        await sleep(wait, ctl.signal);
      } catch {
        break; // aborted
      }
    }
  } finally {
    readers.delete(reader);
    ctl.abort();
    await tester;
    signal.removeEventListener('abort', stop);
  }
}

// ---- debug capture ----

export interface DebugCaptureOptions {
  /** 'container' (default): the comments panel; 'page': the whole page when no panel is found. */
  scope?: 'container' | 'page';
  /** Climb this many parents above the container (to see what is around it). */
  up?: number;
  /** How many of the last parse decisions to return. */
  decisions?: number;
  maxNodes?: number;
}

export interface ReaderDebug {
  reader: ReaderStatus;
  /** Null when the page could not be read (the error is in `error`). */
  snapshot: SnapshotResult | null;
  /** The "Comments" tab as the pack finds it. */
  tab: { matches: number; visible: boolean; ariaSelected: string | null } | null;
  /** The comment box as the pack finds it. */
  composer: { matches: number } | null;
  /** Newest last. Lengths only, never the author or the text. */
  decisions: ChatDecision[];
  error?: string;
}

export const DEBUG_DEFAULTS = { decisions: 50, maxNodes: 400, maxDepth: 14, maxChildren: 40 } as const;

/** How many Instagram lives are being read right now. */
export function activeChatReaderCount(): number {
  return readers.size;
}

/**
 * A sanitised picture of what each running reader sees (docs/API.md → chat debug): the panel's
 * structure without any text, how many elements each pack selector matches, and the last parse
 * decisions. Read-only: it changes nothing in the page.
 */
export async function captureChatDebug(opts: DebugCaptureOptions = {}): Promise<ReaderDebug[]> {
  const pack = chatPackStore.active();
  const out: ReaderDebug[] = [];
  for (const reader of [...readers].slice(0, 4)) {
    const decisions = reader.memory.decisions.slice(-Math.max(0, Math.min(opts.decisions ?? DEBUG_DEFAULTS.decisions, 200)));
    const item: ReaderDebug = { reader: { ...reader.status, bad: [...reader.status.bad] }, snapshot: null, tab: null, composer: null, decisions };
    try {
      if (reader.page.isClosed()) throw new Error('the page is closed');
      const expression = snapshotExpression({
        pack,
        scope: opts.scope ?? 'container',
        up: Math.max(0, Math.min(opts.up ?? 0, 6)),
        maxNodes: Math.max(20, Math.min(opts.maxNodes ?? DEBUG_DEFAULTS.maxNodes, 1_500)),
        maxDepth: DEBUG_DEFAULTS.maxDepth,
        maxChildren: DEBUG_DEFAULTS.maxChildren,
      });
      item.snapshot = await withTimeout(reader.page.evaluate(expression) as Promise<SnapshotResult>, SCAN_TIMEOUT_MS, 'The page did not answer');
      const tab = sel.commentsTab(reader.page, pack.tab);
      const visibleTab = await visibleNow(tab);
      const selected = visibleTab ? await visibleTab.getAttribute('aria-selected', { timeout: 1000 }).catch(() => null) : null;
      item.tab = {
        matches: await tab.count(),
        visible: visibleTab !== null,
        // An attribute value from the page: only its two meaningful values are passed on.
        ariaSelected: selected === 'true' || selected === 'false' ? selected : selected === null ? null : 'other',
      };
      item.composer = { matches: await sel.commentBox(reader.page, pack.composer.css).count() };
    } catch (err) {
      // A fixed wording: a browser error message can quote elements of the page.
      item.error = reader.page.isClosed()
        ? 'the page is closed'
        : /did not answer|timed out|timeout/i.test(shortError(err))
          ? 'the page did not answer in time'
          : 'the page could not be read (it may be navigating or reloading)';
    }
    out.push(item);
  }
  return out;
}
