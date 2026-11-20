// What runs inside the producer page for the comments reader, and the pure logic that decides
// which of the rows it reports are new comments.
//
// The page scripts are fixed strings (plain JS, no transpiler helpers). Everything Instagram-
// specific comes in as data from the selector pack (chat-pack.ts): CSS selectors, attribute names
// and regex sources. The scripts never evaluate pack content as code.
//
// CHAT_SCAN_SOURCE     one read of the comments panel: find the container, find the rows, parse each.
// CHAT_SNAPSHOT_SOURCE the sanitised structure of the panel for the debug capture (no text).
// reconcile()          Node side: which scanned rows are new (dedupe across re-renders, re-mounts,
//                      reloads and virtualised lists), with a redacted decision log.

import { randomBytes } from 'node:crypto';
import { REGEX_INPUT_MAX, type IgChatPack } from './chat-pack.js';
import { CHAT_CONTAINER_ATTR, CHAT_ROW_ATTR } from './selectors.js';


export type ContainerStrategy = 'css' | 'tabpanel' | 'label' | 'composer' | 'heading';
export type PageDropReason = 'empty' | 'pinned' | 'system';

/** One row as the page parsed it. */
export interface ScanRow {
  /** Number of the row's element in this document (stable while the element lives). */
  n: number;
  id: string | null;
  author: string;
  text: string;
  kind: 'message' | 'event';
  join: boolean;
  /**
   * On a join line that names one user and a number of others ("<name> and 3 others joined"): that
   * number (capture group 1 of the `classify.join` pattern that matched). Else null.
   */
  othersCount: number | null;
  avatarUrl: string | null;
  badges: string[] | null;
  /** Not a comment to deliver, and why. */
  drop: PageDropReason | null;
  /** The text is a label-looking word kept because the row had no other text. */
  restored: boolean;
  hasAvatar: boolean;
}

export interface ScanResult {
  /** Changes when the document is replaced (reload, navigation). */
  doc: string;
  /** document.readyState is 'complete'. */
  ready: boolean;
  /** `n`: number of the container's element in this document (like ScanRow.n). */
  container: { strategy: ContainerStrategy; tag: string; role: string | null; n: number } | null;
  rows: ScanRow[];
  /** Rows left out because there were more than limits.maxRows. */
  truncated: number;
  /** Pack entries the page could not use (invalid selector or regex), as paths like "row.css[0]". */
  bad: string[];
}

export interface ScanArgs {
  pack: IgChatPack;
  packRevision: number;
  containerAttr: string;
  rowAttr: string;
  stateKey: string;
  inputMax: number;
  /** Which end of the list to keep when there are more than limits.maxRows rows. */
  keep: 'tail' | 'head';
}

export function scanExpression(args: Omit<ScanArgs, 'containerAttr' | 'rowAttr' | 'inputMax'>): string {
  const full: ScanArgs = { ...args, containerAttr: CHAT_CONTAINER_ATTR, rowAttr: CHAT_ROW_ATTR, inputMax: REGEX_INPUT_MAX };
  return `(${CHAT_SCAN_SOURCE})(${JSON.stringify(full)})`;
}

// Shared by both page scripts: safe wrappers around the pack's selectors and regexes.
const PAGE_HELPERS = String.raw`
  const P = args.pack;
  const CATTR = args.containerAttr;
  const RATTR = args.rowAttr;
  const bad = new Set();
  const rx = (src, where) => { try { return new RegExp(src, 'i'); } catch (e) { bad.add(where); return null; } };
  const rxList = (list, where) => list.map((s, i) => rx(s, where + '[' + i + ']')).filter(Boolean);
  const cut = (s) => String(s == null ? '' : s).slice(0, args.inputMax);
  const test = (re, s) => !!re && re.test(cut(s));
  const any = (list, s) => { const c = cut(s); for (const re of list) { if (re.test(c)) return true; } return false; };
  const qsa = (root, list, where) => {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      try { for (const el of root.querySelectorAll(list[i])) out.push(el); } catch (e) { bad.add(where + '[' + i + ']'); }
    }
    return out;
  };
  const matches = (el, list, where) => {
    for (let i = 0; i < list.length; i++) {
      try { if (el.matches(list[i])) return true; } catch (e) { bad.add(where + '[' + i + ']'); }
    }
    return false;
  };
  const closest = (el, list, where) => {
    for (let i = 0; i < list.length; i++) {
      try { const c = el.closest(list[i]); if (c) return c; } catch (e) { bad.add(where + '[' + i + ']'); }
    }
    return null;
  };
  const visible = (el) => !!(el && el.isConnected && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const ownText = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
  const RX = {
    panelLabel: rx(P.container.panelLabel, 'container.panelLabel'),
    composerHint: rx(P.container.composerHint, 'container.composerHint'),
    avatarAlt: rx(P.row.avatarAlt, 'row.avatarAlt'),
    tabName: rx(P.tab.name, 'tab.name'),
    meta: rxList(P.text.meta, 'text.meta'),
    event: rxList(P.classify.event, 'classify.event'),
    join: rxList(P.classify.join, 'classify.join'),
    system: rxList(P.classify.system, 'classify.system'),
    pinned: rxList(P.classify.pinned, 'classify.pinned'),
  };
  const altUser = (img) => {
    const m = RX.avatarAlt ? RX.avatarAlt.exec(cut((img.getAttribute('alt') || '').trim())) : null;
    return m && m[1] ? m[1].trim() : '';
  };
`;

/**
 * `(args: ScanArgs) => ScanResult`. Idempotent; run on every poll.
 *
 * Container (kept while it is visible and has rows; looked for again otherwise): the pack's
 * explicit selector, a tabpanel labelled "Comments", any element so labelled, the area around the
 * comment box, the area around a "Comments" heading. The first two are exact; of the others, one
 * with rows wins over an earlier one without. Around the comment box the reader climbs to the
 * first parent that is tall enough; when that box holds no rows and a parent further up (within the
 * climb, about as wide) holds avatar rows, that parent is the container (`climbPreferRows`).
 *
 * Rows: the pack's explicit selector, else the smallest ancestor of one avatar that also holds
 * text besides the username, plus list items without an avatar. A row never contains the comment
 * box or more than `maxAvatars` avatars. Rows are re-checked on every run, so a wrapper that
 * looked like a row while the list held one comment stops being one.
 *
 * Text: the row's visible text nodes (and emoji images) in order, minus the username, minus label
 * nodes ("Reply", "2m"), joined the way the browser lays them out (no space inside one line of
 * inline elements, so "@name," keeps its comma).
 */
export const CHAT_SCAN_SOURCE = String.raw`(args) => {
${PAGE_HELPERS}
  const w = window;
  let st = w[args.stateKey];
  if (!st) {
    st = { doc: Math.random().toString(36).slice(2) + Date.now().toString(36), ids: new WeakMap(), next: 1, cache: new WeakMap(), rev: null, bad: new Set() };
    Object.defineProperty(w, args.stateKey, { value: st, configurable: true, enumerable: false });
  }
  const tagged = document.querySelector('[' + CATTR + ']');
  if (st.rev !== args.packRevision) {
    // A new pack: parse every row again and look for the container again.
    st.rev = args.packRevision;
    st.cache = new WeakMap();
    st.bad = new Set();
    if (tagged) tagged.removeAttribute(CATTR);
  }

  const ORDER = ['css', 'tabpanel', 'label', 'composer', 'heading'];
  // The parents of el, nearest first: at most climbLevels of them, never the body.
  const climbPath = (el) => {
    const path = [];
    let node = el;
    for (let i = 0; i < P.container.climbLevels && node.parentElement && node.parentElement !== document.body; i++) {
      node = node.parentElement;
      path.push(node);
    }
    return path;
  };
  const tall = (el) => el.getBoundingClientRect().height >= P.container.climbMinHeight;
  // The first parent that is tall enough, else the last one reached.
  const climb = (el) => {
    const path = climbPath(el);
    return path.find(tall) || path[path.length - 1] || el;
  };
  // climbPreferRows: a parent further up is in the same column while it is at most this much wider,
  // and it needs this many rows (one avatar next to some text is also what a page header looks like).
  const SAME_COLUMN = 1.5;
  const MIN_ROWS_FURTHER_UP = 2;
  const FIND = {
    css: () => qsa(document, P.container.css, 'container.css').find(visible) || null,
    tabpanel: () => {
      for (const panel of document.querySelectorAll('[role="tabpanel"]')) {
        if (!visible(panel)) continue;
        const by = panel.getAttribute('aria-labelledby');
        const tab = by ? document.getElementById(by) : null;
        const label = (panel.getAttribute('aria-label') || (tab && tab.textContent) || '').trim();
        if (test(RX.panelLabel, label)) return panel;
      }
      return null;
    },
    label: () => {
      for (const el of document.querySelectorAll('[aria-label]')) {
        // Never a control or something inside one (a labelled icon in the "Comments" tab itself).
        if (visible(el) && test(RX.panelLabel, el.getAttribute('aria-label').trim()) && el.tagName.toLowerCase() !== 'svg' && !el.closest('button, a, [role="tab"], [role="button"]')) return el;
      }
      return null;
    },
    composer: () => {
      for (const box of qsa(document, P.container.composerCss, 'container.composerCss')) {
        const hint = (box.getAttribute('placeholder') || box.getAttribute('aria-label') || '').trim();
        if (!visible(box) || !test(RX.composerHint, hint)) continue;
        const path = climbPath(box);
        const at = path.findIndex(tall);
        const base = at >= 0 ? path[at] : path[path.length - 1] || box;
        if (!P.container.climbPreferRows || at < 0 || sureRows(base) > 0) return base;
        // The box the climb stopped at holds no comment row. It may be the empty panel, or a tall
        // box around the comment box only (the panel is further up). Take a parent that holds
        // comment rows, but only a near one: within the climb, in the same column, with enough rows.
        const limit = base.getBoundingClientRect().width * SAME_COLUMN;
        for (let i = at + 1; i < path.length; i++) {
          if (path[i].getBoundingClientRect().width > limit) break;
          if (sureRows(path[i]) >= MIN_ROWS_FURTHER_UP) return path[i];
        }
        return base;
      }
      return null;
    },
    heading: () => {
      for (const el of qsa(document, P.container.headingCss, 'container.headingCss')) {
        if (visible(el) && test(RX.panelLabel, ownText(el)) && !el.closest('button, a, [role="tab"], [role="button"]')) return climb(el);
      }
      return null;
    },
  };

  const isAvatar = (img) => matches(img, P.row.avatarCss, 'row.avatarCss');
  const hasExcluded = (el) => qsa(el, P.row.excludeCss, 'row.excludeCss').length > 0;
  const rowShaped = (el) => !hasExcluded(el) && qsa(el, P.row.avatarCss, 'row.avatarCss').length <= P.row.maxAvatars;
  const hasEmoji = (el) => qsa(el, P.text.emojiCss, 'text.emojiCss').some((i) => !isAvatar(i) && (i.getAttribute('alt') || '').trim());
  const rowsOf = (container) => {
    const set = new Set();
    if (P.row.css.length > 0) {
      for (const el of qsa(container, P.row.css, 'row.css')) {
        if (visible(el) && !hasExcluded(el)) set.add(el);
      }
    } else {
      for (const img of qsa(container, P.row.avatarCss, 'row.avatarCss')) {
        const user = altUser(img);
        let node = img.parentElement;
        while (node && node !== container) {
          const text = String(node.innerText || node.textContent || '').replace(user, '').trim();
          if (text || hasEmoji(node)) break;
          node = node.parentElement;
        }
        if (!node || node === container || !visible(node) || !rowShaped(node)) continue;
        set.add(node);
      }
      for (const item of qsa(container, P.row.fallbackCss, 'row.fallbackCss')) {
        if (set.has(item) || !visible(item) || !rowShaped(item) || !String(item.innerText || '').trim()) continue;
        let nested = false;
        for (const r of set) {
          if (r.contains(item) || item.contains(r)) { nested = true; break; }
        }
        if (!nested) set.add(item);
      }
    }
    const list = Array.from(set).sort((a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1));
    // Of two nested rows only the inner one is a row.
    return list.filter((el, i) => !(i + 1 < list.length && el.contains(list[i + 1])));
  };
  // One search per element and read: looking for the container asks for the same rows more than once.
  const rowsFound = new Map();
  const rowsIn = (el) => {
    let list = rowsFound.get(el);
    if (!list) { list = rowsOf(el); rowsFound.set(el, list); }
    return list;
  };
  // Rows that say "comment" on their own: around an avatar, or matched by the pack's row selector.
  const sureRows = (el) => rowsIn(el).filter((r) => P.row.css.length > 0 || qsa(r, P.row.avatarCss, 'row.avatarCss').length > 0).length;

  // The explicit selector and a labelled tab panel are exact: the first of them that hits is the
  // container, with or without rows. The other strategies are guesses: one that has rows is
  // preferred over an earlier one that has none.
  const locate = () => {
    let first = null;
    for (const name of ORDER) {
      const el = FIND[name]();
      if (!el) continue;
      const found = { name: name, el: el, rows: rowsIn(el) };
      if (found.rows.length > 0 || name === 'css' || name === 'tabpanel') return first && found.rows.length === 0 ? first : found;
      if (!first) first = found;
    }
    return first;
  };
  let container = document.querySelector('[' + CATTR + ']');
  let strategy = container ? container.getAttribute(CATTR) : null;
  if (container && (!visible(container) || ORDER.indexOf(strategy) < 0)) {
    container.removeAttribute(CATTR);
    container = null;
  }
  let rows = container ? rowsOf(container) : [];
  if (!container || rows.length === 0) {
    // Nothing tagged, or a tagged container without rows: it may be empty, or no longer be the
    // comments (a tab panel reused for another tab, a guess made before the panel opened). Look again.
    const found = locate();
    if (container && (!found || found.el !== container)) container.removeAttribute(CATTR);
    container = found ? found.el : null;
    strategy = found ? found.name : null;
    rows = found ? found.rows : [];
    if (container) container.setAttribute(CATTR, strategy);
  }
  let truncated = 0;
  if (rows.length > P.limits.maxRows) {
    truncated = rows.length - P.limits.maxRows;
    rows = args.keep === 'head' ? rows.slice(0, P.limits.maxRows) : rows.slice(truncated);
  }
  const rowSet = new Set(rows);
  for (const el of document.querySelectorAll('[' + RATTR + ']')) {
    if (!rowSet.has(el)) el.removeAttribute(RATTR);
  }
  for (const el of rows) {
    if (!el.hasAttribute(RATTR)) el.setAttribute(RATTR, '');
  }

  const parse = (el) => {
    const img = qsa(el, P.row.avatarCss, 'row.avatarCss')[0] || null;
    let author = img ? altUser(img) : '';
    const hasAvatar = !!img;
    const textEls = P.text.css.length > 0 ? qsa(el, P.text.css, 'text.css') : [];
    const inTextEl = (node) => textEls.some((t) => t === node || t.contains(node));
    const skipped = (parent) => {
      const c = closest(parent, P.text.skipCss, 'text.skipCss');
      return !!c && c !== el && el.contains(c);
    };
    const display = new Map();
    const inline = (node) => {
      let d = display.get(node);
      if (d === undefined) { d = getComputedStyle(node).display; display.set(node, d); }
      return d === 'contents' || d.indexOf('inline') === 0;
    };
    const blockOf = (node) => {
      let b = node;
      while (b !== el && b.parentElement && inline(b)) b = b.parentElement;
      return b;
    };
    const parts = [];
    const walker = document.createTreeWalker(el, 5); // text nodes + elements
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (!parent) continue;
      if (n.nodeType === 1) {
        if (n.tagName.toLowerCase() !== 'img' || !matches(n, P.text.emojiCss, 'text.emojiCss') || isAvatar(n)) continue;
        const alt = squash(n.getAttribute('alt'));
        if (alt && alt.length <= 16 && visible(n) && !skipped(parent)) parts.push({ t: alt, raw: alt, parent: parent, emoji: true });
        continue;
      }
      const t = squash(n.textContent);
      if (!t || !visible(parent) || skipped(parent)) continue;
      parts.push({ t: t, raw: String(n.textContent), parent: parent, emoji: false });
    }
    const texts = parts.filter((p) => !p.emoji);
    if (!author) {
      const link = qsa(el, P.text.authorCss, 'text.authorCss')[0] || null;
      const linkText = link ? squash(link.textContent) : '';
      author = linkText || (texts.length > 1 ? texts[0].t : '');
    }
    const join = (list) => {
      let out = '';
      let prev = null;
      for (const p of list) {
        if (prev && !/\s$/.test(prev.raw) && !/^\s/.test(p.raw) && blockOf(prev.parent) !== blockOf(p.parent)) out += ' ';
        out += p.raw;
        prev = p;
      }
      return squash(out);
    };
    const body = [];
    const metas = [];
    let pinnedLabels = [];
    let dropped = false;
    for (const p of parts) {
      if (!p.emoji && !dropped && author && p.t === author) { dropped = true; continue; }
      if (textEls.length > 0) {
        if (inTextEl(p.parent)) body.push(p);
        else if (!p.emoji && any(RX.pinned, p.t)) pinnedLabels.push(p);
        continue;
      }
      if (!p.emoji && any(RX.pinned, p.t)) { pinnedLabels.push(p); continue; }
      if (!p.emoji && any(RX.meta, p.t)) { metas.push(p); continue; }
      body.push(p);
    }
    let text = join(body);
    if (!dropped && author && text.toLowerCase().indexOf(author.toLowerCase() + ' ') === 0) text = text.slice(author.length + 1).trim();
    let restored = false;
    if (!text && pinnedLabels.length > 0) {
      // "pinned" is all the row says: it is the comment, not a label.
      text = pinnedLabels[0].t;
      pinnedLabels = [];
      restored = true;
    }
    if (!text && metas.length >= 2 && !metas[0].parent.closest('a, button, time, [role="button"], [role="link"]')) {
      // A comment that reads like a label ("now", "like"): the row's first label-looking text, when
      // the row still has its real labels after it.
      text = metas[0].t;
      restored = true;
    }
    const base = { author: author, text: text, kind: 'message', join: false, othersCount: null, id: null, avatarUrl: null, badges: null, restored: restored, hasAvatar: hasAvatar };
    if (!text) return Object.assign(base, { drop: 'empty' });
    const within = (list, where) => !!closest(el, list, where) || qsa(el, list, where).length > 0;
    if (pinnedLabels.length > 0 || (P.classify.pinnedCss.length > 0 && within(P.classify.pinnedCss, 'classify.pinnedCss'))) return Object.assign(base, { drop: 'pinned' });
    const whole = join(texts);
    if ((P.classify.systemCss.length > 0 && within(P.classify.systemCss, 'classify.systemCss')) || (!hasAvatar && (any(RX.system, text) || any(RX.system, whole)))) {
      return Object.assign(base, { drop: 'system' });
    }
    let isEvent = any(RX.event, text);
    if (!isEvent && !author) {
      // A presence line written as one piece of text ("name and 3 others joined", no avatar or link
      // to take the name from): the first word is who joined.
      const lead = /^([\p{L}\p{N}._]{1,30}) (.+)$/u.exec(cut(text));
      if (lead && any(RX.event, lead[2])) {
        author = lead[1];
        text = lead[2];
        isEvent = true;
      }
    }
    const isJoin = isEvent && any(RX.join, text);
    let othersCount = null;
    if (isJoin) {
      // The first join pattern that matches says how many others: its capture group 1, a number.
      for (const re of RX.join) {
        const m = re.exec(cut(text));
        if (!m) continue;
        const digits = m[1] ? String(m[1]).replace(/[,.]/g, '') : '';
        if (/^\d{1,7}$/.test(digits) && Number(digits) > 0) othersCount = Number(digits);
        break;
      }
    }
    let id = null;
    for (const attr of P.row.idAttrs) {
      const holder = el.hasAttribute(attr) ? el : el.querySelector('[' + CSS.escape(attr) + ']');
      const v = holder ? String(holder.getAttribute(attr) || '').trim() : '';
      if (v) { id = v.slice(0, 200); break; }
    }
    return Object.assign(base, {
      author: author || 'Instagram',
      text: isEvent && author ? author + ' ' + text : text,
      kind: isEvent ? 'event' : 'message',
      join: isJoin,
      othersCount: othersCount,
      id: id,
      avatarUrl: img && /^https?:/i.test(img.src || '') ? img.src : null,
      badges: qsa(el, P.classify.verifiedCss, 'classify.verifiedCss').length > 0 ? ['verified'] : null,
      drop: null,
    });
  };

  const numberOf = (el) => {
    let n = st.ids.get(el);
    if (!n) { n = st.next++; st.ids.set(el, n); }
    return n;
  };
  const out = [];
  for (const el of rows) {
    const n = numberOf(el);
    const content = String(el.textContent || '');
    const sig = content.length + ':' + el.getElementsByTagName('img').length + ':' + content;
    let cached = st.cache.get(el);
    if (!cached || cached.sig !== sig) {
      let data = null;
      try { data = parse(el); } catch (e) { data = null; }
      if (!data) continue;
      cached = { sig: sig, data: data };
      // An empty row may still be rendering (or be hidden for now): look again next time.
      if (data.drop !== 'empty') st.cache.set(el, cached);
    }
    out.push(Object.assign({ n: n }, cached.data));
  }
  // Rows are parsed once and cached, so unusable entries are remembered for as long as the pack is.
  for (const where of bad) st.bad.add(where);
  return {
    doc: st.doc,
    ready: document.readyState === 'complete',
    container: container ? { strategy: strategy, tag: container.tagName.toLowerCase(), role: container.getAttribute('role'), n: numberOf(container) } : null,
    rows: out,
    truncated: truncated,
    bad: Array.from(st.bad).slice(0, 40),
  };
}`;

// ---- debug snapshot ----

/**
 * Interface words the debug capture may show. In a label (alt, aria-label, placeholder, title)
 * the words on this list are shown and every other word becomes # marks; another attribute's
 * value is shown only when every word in it is on the list. Text nodes are never shown. So user
 * names and comment text never leave the page (a user name that happens to be one of these common
 * words would read as an interface word, which identifies nobody).
 */
export const LABEL_VOCABULARY: readonly string[] = [
  'a', 'add', 'all', 'an', 'and', 'audience', 'back', 'button', 'by', 'cancel', 'chat', 'close', 'comment', 'comments', 'details', 'done', 'emoji',
  'end', 'for', 'go', 'hide', 'host', 'in', 'info', 'insights', 'join', 'joined', 'like', 'liked', 'likes', 'link', 'live', 'menu', 'message',
  'messages', 'moderator', 'more', 'mute', 'new', 'next', 'now', 'of', 'off', 'on', 'open', 'options', 'photo', 'picture', 'pin', 'pinned', 'post',
  'profile', 'question', 'questions', 'reply', 'replies', 'report', 'request', 'requests', 'search', 'see', 'send', 'settings', 'setup', 'share',
  'show', 'stream', 'tab', 'the', 'this', 'to', 'translation', 'turn', 'unpin', 'verified', 'video', 'view', 'viewer', 'viewers', 'watching', 'your',
];

export interface SnapshotArgs {
  pack: IgChatPack;
  containerAttr: string;
  rowAttr: string;
  inputMax: number;
  vocabulary: readonly string[];
  /** 'container': the comments container (climbing `up` parents); 'page': the document body. */
  scope: 'container' | 'page';
  up: number;
  maxNodes: number;
  maxDepth: number;
  maxChildren: number;
}

/** A label attribute (alt, aria-label, placeholder, title). */
export interface SnapshotLabel {
  len: number;
  /**
   * The label with every word that is not an interface word replaced by # marks ("profile photo
   * of #############"). Absent when no word of it is an interface word, and for avatar alts.
   */
  text?: string;
  /** Pack patterns the label matches (e.g. "avatarAlt", "panelLabel"). */
  is?: string[];
}

export interface SnapshotNode {
  tag: string;
  /** Set on the elements the reader tagged. */
  ctd?: 'container' | 'row';
  class?: string[];
  /** Attributes whose values are structural (role, type, aria-selected, ...). */
  attrs?: Record<string, string>;
  /**
   * data-* and other attributes: the name and the shape of the value ("digits/5", "word/12",
   * "path/1", "https"). A value made of interface words only is shown, marked with "=".
   */
  data?: Record<string, string>;
  labels?: Record<string, SnapshotLabel>;
  /** Width x height in px; absent when the element is not visible. */
  box?: [number, number];
  children?: (SnapshotNode | SnapshotText)[];
  /** Children left out (limits). */
  more?: number;
}

export interface SnapshotText {
  /** Length of the text; the text itself is never returned. */
  text: number;
  is?: string[];
}

export interface SelectorCount {
  /** Elements matching in the whole page. */
  page: number;
  /** Elements matching inside the comments container (null when there is none). */
  container: number | null;
  /** Of the page matches, how many are visible. */
  visible: number;
}

export interface SnapshotResult {
  page: { host: string; pathSegments: number; ready: boolean; title: number };
  container: { strategy: string | null; tag: string; role: string | null; box: [number, number]; rows: number } | null;
  root: 'container' | 'ancestor' | 'page';
  tree: SnapshotNode | null;
  nodes: number;
  truncated: boolean;
  /** Per pack selector ("row.avatarCss[0]"): how many elements it matches, or "invalid". */
  selectors: Record<string, SelectorCount | 'invalid'>;
  /** Per pack label pattern: how many elements carry a label it matches. */
  patterns: Record<string, number>;
  bad: string[];
}

export function snapshotExpression(args: Omit<SnapshotArgs, 'containerAttr' | 'rowAttr' | 'inputMax' | 'vocabulary'>): string {
  const full: SnapshotArgs = { ...args, containerAttr: CHAT_CONTAINER_ATTR, rowAttr: CHAT_ROW_ATTR, inputMax: REGEX_INPUT_MAX, vocabulary: LABEL_VOCABULARY };
  return `(${CHAT_SNAPSHOT_SOURCE})(${JSON.stringify(full)})`;
}

/**
 * `(args: SnapshotArgs) => SnapshotResult`: the structure of the comments panel with everything a
 * person wrote removed. Kept: tag names, class names, structural attribute values (role, type,
 * aria-selected, ...), attribute names. Text nodes become their length. Labels become their length
 * unless made of interface words only. Every other attribute value (data-*, id, href, src, style,
 * value, ...) becomes a shape word ("digits/5", "word/12", "path/1", "https", ...), or is shown
 * when it is made of interface words only (never for URLs, `value` or `style`). No URLs, no cookies.
 */
export const CHAT_SNAPSHOT_SOURCE = String.raw`(args) => {
${PAGE_HELPERS}
  const VOCAB = new Set(args.vocabulary);
  const SAFE = new Set(['role', 'type', 'dir', 'tabindex', 'hidden', 'contenteditable', 'draggable', 'loading', 'disabled', 'inputmode', 'autocomplete',
    'aria-selected', 'aria-hidden', 'aria-expanded', 'aria-checked', 'aria-disabled', 'aria-live', 'aria-atomic', 'aria-modal', 'aria-haspopup',
    'aria-multiline', 'aria-orientation', 'aria-pressed', 'aria-busy', 'aria-current', 'aria-level']);
  const LABELS = new Set(['alt', 'aria-label', 'placeholder', 'title', 'aria-placeholder', 'aria-description', 'aria-roledescription', 'aria-valuetext']);
  const SAFE_VALUE = /^[a-z0-9_-]{0,24}$/i;
  // In "name:rest" the name is only a scheme when it is one of these; anything else could be a word someone wrote.
  const SCHEMES = new Set(['http', 'https', 'data', 'blob', 'about', 'javascript', 'mailto', 'tel', 'sms', 'intent', 'instagram']);
  const interfaceWords = (v) => {
    const words = v.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return v.length <= 60 && words.length > 0 && words.every((x) => VOCAB.has(x));
  };
  const shape = (name, value) => {
    const v = String(value);
    if (v === '') return 'empty';
    if (v === 'true' || v === 'false') return v;
    if (name === 'href' || name === 'src' || name === 'srcset' || name === 'poster' || name === 'action') {
      const m = /^([a-z][a-z0-9+.-]*):/i.exec(v);
      if (m) return SCHEMES.has(m[1].toLowerCase()) ? m[1].toLowerCase() : 'scheme';
      if (v[0] === '#') return 'hash';
      if (v[0] === '/') return 'path/' + v.split('?')[0].split('/').filter(Boolean).length;
      return 'relative';
    }
    // A value made of interface words only ("live-comments") is shown, marked with "=".
    if (name !== 'value' && name !== 'style' && interfaceWords(v)) return '=' + v;
    if (/^\d+$/.test(v)) return 'digits/' + v.length;
    if (/^[0-9a-f]+$/i.test(v)) return 'hex/' + v.length;
    if (/^[\[{]/.test(v)) return 'json/' + v.length;
    if (/^\S+$/.test(v)) return 'word/' + v.length;
    return 'text/' + v.length;
  };
  const kinds = (s, forLabel) => {
    const is = [];
    if (forLabel) {
      if (test(RX.avatarAlt, s)) is.push('avatarAlt');
      if (test(RX.composerHint, s)) is.push('composerHint');
      if (test(RX.tabName, s)) is.push('tabName');
    }
    if (test(RX.panelLabel, s)) is.push('panelLabel');
    if (any(RX.meta, s)) is.push('meta');
    if (any(RX.event, s)) is.push('event');
    if (any(RX.join, s)) is.push('join');
    if (any(RX.system, s)) is.push('system');
    if (any(RX.pinned, s)) is.push('pinned');
    return is;
  };
  const label = (value) => {
    const v = squash(value);
    const o = { len: v.length };
    const is = kinds(v, true);
    if (is.length > 0) o.is = is;
    // The avatar alt holds the user name: never shown, whatever its words are.
    if (is.indexOf('avatarAlt') >= 0) return o;
    // Interface words are shown; every other word becomes # marks of its length.
    let shown = 0;
    const masked = v.slice(0, 80).replace(/[\p{L}\p{N}_.]+/gu, (word) => {
      const plain = word.toLowerCase().replace(/[_.]+$/, '');
      if (VOCAB.has(plain)) { shown++; return word.toLowerCase(); }
      return '#'.repeat(Math.min(word.length, 30));
    });
    if (shown > 0) o.text = masked.replace(/[^\x20-\x7e\u2026#]/g, '#');
    return o;
  };
  const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };

  let container = document.querySelector('[' + CATTR + ']');
  let root = null;
  let rootKind = 'page';
  if (args.scope === 'container' && container) {
    root = container;
    rootKind = 'container';
    for (let i = 0; i < args.up && root.parentElement && root.parentElement !== document.documentElement; i++) {
      root = root.parentElement;
      rootKind = 'ancestor';
    }
  } else {
    root = document.body;
  }

  let nodes = 0;
  let truncated = false;
  const walk = (el, depth) => {
    nodes++;
    const o = { tag: el.tagName.toLowerCase() };
    const attrs = {};
    const data = {};
    const labels = {};
    for (const a of Array.from(el.attributes).slice(0, 40)) {
      const name = a.name.toLowerCase();
      if (name === CATTR) { o.ctd = 'container'; continue; }
      if (name === RATTR) { o.ctd = 'row'; continue; }
      if (name === 'class') {
        const list = String(a.value).split(/\s+/).filter(Boolean).slice(0, 16).map((c) => c.slice(0, 48));
        if (list.length > 0) o.class = list;
      } else if (LABELS.has(name)) labels[name] = label(a.value);
      else if (SAFE.has(name) && SAFE_VALUE.test(a.value)) attrs[name] = a.value;
      else data[name.slice(0, 64)] = shape(name, a.value);
    }
    if (Object.keys(attrs).length > 0) o.attrs = attrs;
    if (Object.keys(data).length > 0) o.data = data;
    if (Object.keys(labels).length > 0) o.labels = labels;
    if (visible(el)) o.box = box(el);
    if (o.tag === 'svg' || o.tag === 'script' || o.tag === 'style' || o.tag === 'iframe') return o; // nothing useful inside
    const kids = [];
    let left = 0;
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        const t = squash(child.textContent);
        if (!t) continue;
        if (kids.length >= args.maxChildren) { left++; continue; }
        const item = { text: t.length };
        const is = kinds(t, false);
        if (is.length > 0) item.is = is;
        kids.push(item);
      } else if (child.nodeType === 1) {
        if (kids.length >= args.maxChildren || depth >= args.maxDepth || nodes >= args.maxNodes) { left++; truncated = true; continue; }
        kids.push(walk(child, depth + 1));
      }
    }
    if (kids.length > 0) o.children = kids;
    if (left > 0) o.more = left;
    return o;
  };
  const tree = root ? walk(root, 0) : null;

  const selectors = {};
  const count = (path, selector) => {
    try {
      const all = Array.from(document.querySelectorAll(selector));
      selectors[path] = {
        page: all.length,
        container: container ? container.querySelectorAll(selector).length : null,
        visible: all.filter(visible).length,
      };
    } catch (e) {
      selectors[path] = 'invalid';
    }
  };
  const lists = {
    'tab.css': P.tab.css, 'container.css': P.container.css, 'container.composerCss': P.container.composerCss, 'container.headingCss': P.container.headingCss,
    'row.css': P.row.css, 'row.avatarCss': P.row.avatarCss, 'row.fallbackCss': P.row.fallbackCss, 'row.excludeCss': P.row.excludeCss,
    'text.css': P.text.css, 'text.skipCss': P.text.skipCss, 'text.authorCss': P.text.authorCss, 'text.emojiCss': P.text.emojiCss,
    'classify.systemCss': P.classify.systemCss, 'classify.pinnedCss': P.classify.pinnedCss, 'classify.verifiedCss': P.classify.verifiedCss,
    'composer.css': P.composer.css,
  };
  for (const path of Object.keys(lists)) lists[path].forEach((s, i) => count(path + '[' + i + ']', s));
  P.row.idAttrs.forEach((attr, i) => count('row.idAttrs[' + i + ']', '[' + CSS.escape(attr) + ']'));

  const labelled = Array.from(document.querySelectorAll('[aria-label], [placeholder], [alt]')).filter(visible);
  const labelOf = (el) => squash(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('alt'));
  const patterns = {
    'container.panelLabel': labelled.filter((el) => test(RX.panelLabel, labelOf(el))).length,
    'container.composerHint': labelled.filter((el) => test(RX.composerHint, labelOf(el))).length,
    'row.avatarAlt': Array.from(document.querySelectorAll('img[alt]')).filter((el) => test(RX.avatarAlt, squash(el.getAttribute('alt')))).length,
    'tab.name': Array.from(document.querySelectorAll('[role="tab"], [role="button"], [role="link"], [role="menuitem"], button, a')).filter((el) => visible(el) && test(RX.tabName, squash(el.getAttribute('aria-label') || el.textContent))).length,
  };

  return {
    page: { host: location.host, pathSegments: location.pathname.split('/').filter(Boolean).length, ready: document.readyState === 'complete', title: document.title.length },
    container: container ? { strategy: container.getAttribute(CATTR) || null, tag: container.tagName.toLowerCase(), role: SAFE_VALUE.test(container.getAttribute('role') || '') ? container.getAttribute('role') : null, box: box(container), rows: container.querySelectorAll('[' + RATTR + ']').length } : null,
    root: rootKind,
    tree: tree,
    nodes: nodes,
    truncated: truncated,
    selectors: selectors,
    patterns: patterns,
    bad: Array.from(bad).slice(0, 40),
  };
}`;

// ---- which rows are new ----

export type DecisionReason =
  /** Delivered: a new row at the newest end of the list. */
  | 'new'
  /** Delivered: a row elsewhere in the list whose content was never delivered. */
  | 'late'
  /** Not delivered: already on screen when the reader first read the comments of this live. */
  | 'baseline'
  /** Not delivered: on screen at the first read with rows under a changed selector pack. */
  | 'pack-changed'
  /** Not delivered: a re-created row of a comment that was already delivered. */
  | 'rerender'
  /** Not delivered: the comment id was already delivered. */
  | 'duplicate-id'
  | PageDropReason;

/** One parse decision, kept for the debug capture. Lengths only: never the author or the text. */
export interface ChatDecision {
  at: string;
  /** Element number of the row (see ScanRow.n). */
  row: number;
  verdict: 'kept' | 'dropped';
  reason: DecisionReason;
  kind: 'message' | 'event';
  join: boolean;
  authorLength: number;
  textLength: number;
  hasAvatar: boolean;
  hasId: boolean;
  /** The text is a label-looking word the reader kept (see ScanRow.restored). */
  restored: boolean;
}

export const MAX_DECISIONS = 200;
const MAX_ELEMENTS = 2_000;
const MAX_IDS = 5_000;

/**
 * What the reader remembers for one live. Shared by the chat source's restarts (the ChatHub
 * restarts a source that failed), so a restart does not deliver the comments on screen again.
 */
export interface ChatMemory {
  /** Name of the reader's state object in the page (element numbers live there). */
  stateKey: string;
  doc: string | null;
  baselined: boolean;
  /** When the first read happened (ms), for the bounded wait on a page that is still loading. */
  firstScanAt: number | null;
  /** Pack revision the rows were last parsed with. */
  packRevision: number | null;
  /** When the live went live (ms), when the driver knows it: a live this young has no backlog. */
  liveStartedAt: number | null;
  /**
   * Set while the reader has not read a single row since it started ('start') or since the selector
   * pack changed ('pack': the old pack read nothing; 'pack-reading': it was reading). The rows of
   * the first read that has some are the backlog. Cleared by that read, or once the panel has been
   * seen empty for EMPTY_SETTLE_MS (then there is no backlog, and what shows up later is new).
   */
  pending: 'start' | 'pack' | 'pack-reading' | null;
  /** The container seen without rows while `pending`, and since when (ms). */
  emptyContainer: number | null;
  emptySince: number | null;
  /** Rows taken as history instead of delivered (the baseline and backlogs), in total. */
  backlog: number;
  /** Element number → the key last accounted for (this document only). */
  elements: Map<number, string>;
  /** Keys of the rows accounted for (delivered or baseline), oldest first. */
  history: string[];
  ids: Set<string>;
  /** Evidence for where new rows appear: the end of the list (usual) or its start. */
  tailNew: number;
  headNew: number;
  /** Deliverable rows in the last read (0: the reader saw nothing it could read). */
  lastRows: number;
  decisions: ChatDecision[];
  kept: number;
  dropped: number;
}

export function newChatMemory(liveStartedAt: number | null = null): ChatMemory {
  return {
    stateKey: `__ctdIgChat_${randomBytes(6).toString('hex')}`,
    doc: null,
    baselined: false,
    firstScanAt: null,
    packRevision: null,
    liveStartedAt,
    pending: null,
    emptyContainer: null,
    emptySince: null,
    backlog: 0,
    elements: new Map(),
    history: [],
    ids: new Set(),
    tailNew: 0,
    headNew: 0,
    lastRows: 0,
    decisions: [],
    kept: 0,
    dropped: 0,
  };
}

/** Rows are newest-first when the evidence clearly says so. */
export function newestFirst(memory: ChatMemory): boolean {
  return memory.headNew > memory.tailNew + 2;
}

const rowKey = (row: ScanRow): string => (row.drop ? `!${row.drop}\u0000${row.author}\u0000${row.text}` : `${row.kind}\u0000${row.author}\u0000${row.text}`);

function countOf(list: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of list) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

/**
 * `keys` is a window of a list whose earlier content is `history` (both oldest first). Returns
 * how many leading keys are already in the history: the largest overlap of a history suffix with
 * the window's start, or the whole window when it sits inside the history. -1 when nothing lines up.
 */
export function alignWindow(history: readonly string[], keys: readonly string[]): number {
  if (keys.length === 0) return 0;
  for (let j = 0; j < history.length; j++) {
    const m = Math.min(keys.length, history.length - j);
    let same = true;
    for (let i = 0; i < m; i++) {
      if (keys[i] !== history[j + i]) {
        same = false;
        break;
      }
    }
    if (same) return m;
  }
  return -1;
}

export interface ReconcileOptions {
  packRevision: number;
  historySize: number;
  now?: Date;
  /** Pack setting timing.backlogAsHistory (default on). */
  backlogAsHistory?: boolean;
  /** Pack setting timing.liveStartGraceMs. */
  liveStartGraceMs?: number;
}

/** Longest wait for a still-loading page before an empty first read is taken as "no comments yet". */
export const MAX_SETTLE_MS = 10_000;
/** A comments panel seen without rows for this long is empty: there is no backlog to wait for. */
export const EMPTY_SETTLE_MS = 5_000;
export const DEFAULT_LIVE_START_GRACE_MS = 60_000;
/** With nothing lining up, repeats are only counted against this many recent comments (at least). */
const RECENT_WINDOW = 50;

/**
 * Decide which rows of one scan are new comments, and remember them. Returns the rows to deliver,
 * oldest first.
 *
 * - The comments on screen when the reader first gets to read them are history (remembered, not
 *   delivered): at the first read of a live, at the first read with rows after the selector pack
 *   changed, and when the panel only becomes readable later (the tab was closed, the page was still
 *   rendering). Two exceptions. A live younger than `liveStartGraceMs` has no history, so what is
 *   on screen is new and is delivered. And a panel that was seen empty for EMPTY_SETTLE_MS had no
 *   backlog: what shows up in it later is new.
 * - With `backlogAsHistory` off (how 0.2.30 worked): only the rows of the first read are the
 *   baseline, and those of the first read after a pack change when the old pack was reading. Rows
 *   that become readable later are delivered at once.
 * - An element seen before with the same content is never delivered again.
 * - With some known rows on screen: a new row past the newest known one is new. A new row among or
 *   before the known ones is a re-created row when its content was delivered before, else a late one.
 * - With no known row on screen (the panel re-mounted, the page reloaded, or the chat moved a whole
 *   screen): the rows are lined up against the delivered history, and only what comes after the
 *   overlap is new. Rows that repeat an earlier comment word for word are therefore still delivered
 *   when they are new, and not delivered when the list merely re-rendered.
 */
export function reconcile(memory: ChatMemory, scan: ScanResult, opts: ReconcileOptions): ScanRow[] {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const decide = (row: ScanRow, verdict: ChatDecision['verdict'], reason: DecisionReason): void => {
    memory.decisions.push({
      at,
      row: row.n,
      verdict,
      reason,
      kind: row.kind,
      join: row.join,
      authorLength: row.author.length,
      textLength: row.text.length,
      hasAvatar: row.hasAvatar,
      hasId: row.id !== null,
      restored: row.restored,
    });
    if (memory.decisions.length > MAX_DECISIONS) memory.decisions.splice(0, memory.decisions.length - MAX_DECISIONS);
    if (verdict === 'kept') memory.kept++;
    else memory.dropped++;
  };
  const remember = (row: ScanRow, key: string): void => {
    memory.history.push(key);
    if (row.id) {
      memory.ids.add(row.id);
      if (memory.ids.size > MAX_IDS) memory.ids.delete(memory.ids.values().next().value!);
    }
  };

  if (scan.doc !== memory.doc) {
    memory.doc = scan.doc;
    memory.elements.clear();
  }

  // Rows the page already ruled out: logged once per element and content, never part of the history.
  const rows: ScanRow[] = [];
  for (const row of scan.rows) {
    if (!row.drop) {
      rows.push(row);
      continue;
    }
    const key = rowKey(row);
    if (memory.elements.get(row.n) !== key) {
      memory.elements.set(row.n, key);
      if (row.drop !== 'empty') decide(row, 'dropped', row.drop);
    }
  }

  const nowMs = now.getTime();
  const guard = opts.backlogAsHistory ?? true;
  const age = memory.liveStartedAt === null ? null : nowMs - memory.liveStartedAt;
  const young = age !== null && age >= 0 && age < (opts.liveStartGraceMs ?? DEFAULT_LIVE_START_GRACE_MS);
  const blind = memory.lastRows === 0;
  memory.lastRows = rows.length;

  let first = false;
  if (!memory.baselined) {
    // Nothing to read in a page that is still loading: the existing comments may not have
    // rendered yet, and an empty baseline now would deliver them all as new. Wait (bounded).
    memory.firstScanAt ??= nowMs;
    if (rows.length === 0 && !scan.ready && nowMs - memory.firstScanAt < MAX_SETTLE_MS) return [];
    memory.baselined = true;
    memory.packRevision = opts.packRevision;
    memory.pending = 'start';
    memory.emptyContainer = null;
    memory.emptySince = null;
    first = true;
  } else if (memory.packRevision !== opts.packRevision) {
    // A changed pack may parse the rows on screen differently, and may be the first one that can
    // read them at all.
    memory.packRevision = opts.packRevision;
    memory.pending = blind ? 'pack' : 'pack-reading';
    memory.emptyContainer = null;
    memory.emptySince = null;
  }

  if (memory.pending) {
    if (rows.length === 0) {
      // No rows yet. A panel that stays empty has no backlog; a "Comments" heading without rows is
      // only a guess that the panel exists, and no container means it is not showing.
      const panel = scan.container && scan.container.strategy !== 'heading' ? scan.container.n : null;
      if (panel === null || panel !== memory.emptyContainer) {
        memory.emptyContainer = panel;
        memory.emptySince = panel === null ? null : nowMs;
      } else if (memory.emptySince !== null && nowMs - memory.emptySince >= EMPTY_SETTLE_MS) {
        memory.pending = null;
      }
      trim(memory, opts.historySize);
      return [];
    }
    const kind = memory.pending;
    memory.pending = null;
    // The first rows this reader gets to see. History, unless the live is too young to have one;
    // rows the old pack was already delivering are always history (they may parse differently now).
    const asHistory = first ? !(guard && young) : kind === 'pack-reading' ? true : guard && !young;
    if (asHistory) {
      const reason: DecisionReason = kind === 'start' ? 'baseline' : 'pack-changed';
      for (const row of rows) {
        const key = rowKey(row);
        if (memory.elements.get(row.n) === key) continue;
        memory.elements.set(row.n, key);
        remember(row, key);
        decide(row, 'dropped', reason);
        memory.backlog++;
      }
      trim(memory, opts.historySize);
      return [];
    }
  }

  const keys = rows.map(rowKey);
  const known = rows.map((row, i) => memory.elements.get(row.n) === keys[i]);
  const fresh: ScanRow[] = [];
  const deliver = (row: ScanRow, key: string, reason: 'new' | 'late'): void => {
    if (row.id && memory.ids.has(row.id)) {
      decide(row, 'dropped', 'duplicate-id');
      return;
    }
    remember(row, key);
    decide(row, 'kept', reason);
    fresh.push(row);
  };

  if (known.some(Boolean)) {
    const first = known.indexOf(true);
    const last = known.lastIndexOf(true);
    const top = newestFirst(memory);
    const inHistory = countOf(memory.history);
    // Oldest first: a newest-first list is walked backwards.
    const order = rows.map((_, i) => i);
    if (top) order.reverse();
    for (const i of order) {
      if (known[i]) continue;
      const row = rows[i]!;
      const key = keys[i]!;
      const atNewEnd = top ? i < first : i > last;
      if (atNewEnd) {
        if (top) memory.headNew++;
        else memory.tailNew++;
        deliver(row, key, 'new');
      } else if (row.id) deliver(row, key, 'late');
      else if (inHistory.has(key)) decide(row, 'dropped', 'rerender');
      else {
        // Never delivered, yet not at the end where new rows appear: evidence about the list's direction.
        if (!top && i < first) memory.headNew++;
        if (top && i > last) memory.tailNew++;
        deliver(row, key, 'late');
      }
    }
  } else if (rows.length > 0) {
    const withIds = rows.every((r) => r.id);
    if (withIds) {
      for (let i = 0; i < rows.length; i++) deliver(rows[i]!, keys[i]!, 'new');
    } else {
      // Line the window up with the history, in the list's direction (both are tried when unknown).
      const forward = alignWindow(memory.history, keys);
      const reversedKeys = [...keys].reverse();
      const backward = alignWindow(memory.history, reversedKeys);
      const top = newestFirst(memory) ? backward >= 0 || forward < 0 : forward <= 0 && backward > 0;
      const ordered = top ? [...rows].reverse() : rows;
      const orderedKeys = top ? reversedKeys : keys;
      const overlap = top ? backward : forward;
      if (overlap >= 0) {
        for (let i = 0; i < ordered.length; i++) {
          if (i < overlap) decide(ordered[i]!, 'dropped', 'rerender');
          else deliver(ordered[i]!, orderedKeys[i]!, 'new');
        }
      } else {
        // Nothing lines up (the chat moved on, or a row in the middle changed): deliver what the
        // history does not account for, counting repeats.
        const left = countOf(memory.history.slice(-Math.max(RECENT_WINDOW, ordered.length * 2)));
        for (let i = 0; i < ordered.length; i++) {
          const key = orderedKeys[i]!;
          const n = left.get(key) ?? 0;
          if (n > 0) {
            left.set(key, n - 1);
            decide(ordered[i]!, 'dropped', 'rerender');
          } else deliver(ordered[i]!, key, 'new');
        }
      }
    }
  }

  for (let i = 0; i < rows.length; i++) memory.elements.set(rows[i]!.n, keys[i]!);
  trim(memory, opts.historySize);
  return fresh;
}

function trim(memory: ChatMemory, historySize: number): void {
  if (memory.history.length > historySize) memory.history.splice(0, memory.history.length - historySize);
  if (memory.elements.size > MAX_ELEMENTS) {
    let excess = memory.elements.size - MAX_ELEMENTS;
    for (const key of memory.elements.keys()) {
      if (excess-- <= 0) break;
      memory.elements.delete(key);
    }
  }
}
