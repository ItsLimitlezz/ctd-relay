// Every Instagram locator, label and in-page script lives here, so a site change is a contained fix.
//
// Flow (desktop instagram.com, "Live Producer"), as documented by Instagram and recent guides:
//   sidebar "Create" (+, svg "New post") → "Live video" → "Go live" setup: title + audience
//   (Public / Practice / sometimes Close friends) → "Next" → "Stream URL" + "Stream key" (new key
//   every live) → start sending video → preview → "Go live" (top right) → live; "Comments" tab;
//   "End live video" ends it.
//   https://about.instagram.com/blog/tips-and-tricks/instagram-live-producer/
//   https://support.restream.io/en/articles/6379108-stream-to-instagram
//   https://support.ecamm.com/en/articles/3847198-streaming-to-instagram-live-with-ecamm
// Ineligible accounts (since Aug 2025: public + 1,000 followers) see "Your account is no longer
// eligible for Live" — https://9to5mac.com/2025/08/01/new-instagram-rule-cuts-off-live-broadcasts-for-small-accounts/
//
// ASSUMPTIONS (not verifiable without an eligible logged-in account; keep locators tolerant):
// - Accessible names may repeat an icon label ("New post Create"), hence `names()` below.
// - The title is a textbox labelled/placeholdered "...title..."; the audience is a radio group,
//   a <select> or a custom dropdown labelled "Audience". SEEN (Oct 2026, user screenshot): the
//   "Add live video details" dialog has an "Add a title..." field and an unlabelled "Public ⌄"
//   dropdown (Public / Practice), then "Next".
// - Stream URL / key are inputs (or text) next to "Stream URL" / "Stream key" labels.
// - "Go live" stays disabled until the preview arrives; "End live video" asks for confirmation.
// - Comment rows show an avatar whose alt is "<username>'s profile picture" (the context is en-US).
//
// Takedowns (Stream Guard port). Instagram does not document the producer's wording; reported
// texts include a warning first ("Your live video will be removed soon if you continue to broadcast
// music you don't have permission to use"), then the live ends with "Your live video has ended" /
// "...was removed" / "...may go against our Community Guidelines" / copyright or "violates"
// notices. Matchers are deliberately broad but only read short dialogs, alerts and headings, never
// the comments (viewers could type the same words). A future/"may be removed" sentence is a
// warning, never an end. See TAKEDOWN_* below.
//
// Links: Instagram allows one link per live (Stream Guard: "IG allows one link per live"). Where
// the producer offers it is not documented; the driver looks for an "Add link" control in the setup
// form, then in the producer before going live, then right after going live, and fills a URL field
// (plus a title/label field when there is one) in the dialog it opens.

import type { Locator, Page } from 'playwright';
import type { IgChatPack } from './chat-pack.js';

export const IG_ORIGIN = 'https://www.instagram.com';
export const LOGIN_PATH = '/accounts/login/';
/** Cookie present only while logged in (HttpOnly, readable through the browser context). */
export const SESSION_COOKIE = 'sessionid';

/**
 * Regex matching any of `labels`, optionally repeated: an icon label + text gives accessible names
 * like "New post Create" (or "New postCreate" when the parts are inline). Case-insensitive.
 */
function names(...labels: string[]): RegExp {
  const alt = labels.join('|');
  return new RegExp(`^\\s*(?:${alt})(?:\\s*(?:${alt}))*\\s*$`, 'i');
}

export const RE = {
  create: names('create', 'new post'),
  liveVideo: names('live video', 'live'),
  postItem: names('post'),
  /** Sidebar "Profile" link; its name usually starts with the avatar alt ("name's profile picture"). */
  profileLink: /profile\s*$/i,
  avatarAlt: /^(.+?)['’]s profile picture$/i,
  notNow: names('not now'),
  cookieDecline: names('decline optional cookies', 'only allow essential cookies', 'reject optional cookies'),
  // Kept narrow: producer hints like "you can't go live until we receive your stream" must not match.
  ineligible: /no longer eligible for live|(?:not|isn'?t) eligible (?:to go live|for live)|only public accounts with [\d,.]+ followers/i,
  postDialog: /^(?:create new post|drag photos and videos here)$/i,
  title: /title/i,
  audience: /audience|who can see/i,
  public: /^\s*public\b/i,
  practice: /^\s*practice\b/i,
  /** A dropdown that only shows the current audience ("Public ⌄"), with no "Audience" label. */
  audienceChoice: /^\s*(?:public|practice|close friends)\b/i,
  next: names('next'),
  streamUrlLabel: '^(?:stream|server) url$',
  streamKeyLabel: '^stream key$',
  showKey: /^(?:show|reveal)(?: stream)?(?: key)?$/i,
  goLive: names('go live'),
  goLiveConfirmDialog: /go live\s*\?|start (?:your |this )?live(?: video)?\s*\?/i,
  waitingForStream: /waiting for (?:your )?(?:stream|video|connection|signal)|connect your streaming software|no stream detected/i,
  endLive: names('end live video', 'end live'),
  endConfirm: /^\s*end(?: live(?: video)?)?(?: now)?\s*$/i,
  endConfirmDialog: /end (?:this |your )?live(?: video)?\s*\?|are you sure/i,
  liveNow: /^(?:you'?re live|you are live|live now)$/i,
  ended: /(?:live video|live) (?:has )?ended|your live video has ended|thanks for going live/i,
  afterEnd: names('done', 'close', 'not now', 'ok'),
  platformError: /something went wrong|couldn'?t start (?:your )?live|could not start (?:your )?live|try again later/i,

  // ---- takedown / health ----
  /** A notice that the live is (going to be) cut but still running: a warning, never an end. */
  takedownWarning:
    /\b(?:will|may|might|could|can) be (?:removed|ended|stopped|interrupted|muted|taken down)\b|\bif you (?:continue|keep)\b|\b(?:has been|was|is|been) muted\b|\bremoved soon\b/i,
  /**
   * The live was ended / removed by Instagram (a hard signal). No trailing \b: Playwright's
   * hasText reads textContent, which glues a heading to the next paragraph ("removedIt may…").
   */
  liveEnded:
    /\blive(?: video| broadcast| stream)?\b.{0,40}?\b(?:ended|removed|taken down|terminated)|\bwe(?:'ve| have)? (?:removed|ended|taken down) your live|\bthanks for going live|\blive (?:video )?(?:is )?no longer available/i,
  /**
   * "Interrupted" / "reconnecting" notices can be a short network blip that Instagram recovers
   * from: a warning only (a real end also drops the producer out of the live state, and the
   * runner's push-down rule covers a dead push).
   */
  liveInterrupted:
    /\blive(?: video| broadcast| stream)?\b.{0,40}?\b(?:interrupted|stopped|paused)\b|\breconnect(?:ing)?\b|\bconnection (?:lost|interrupted)\b|\b(?:poor|weak|unstable) (?:connection|network)\b/i,
  /** Policy wording; counts as an end only together with the word "live". */
  takedownPolicy:
    /violat|copyright|community (?:guidelines|standards)|intellectual property|(?:music|audio|content) (?:that )?(?:you don'?t have (?:the )?(?:permission|rights)|belongs to someone else)/i,
  /** "Share your live video?" prompt after a live ended. */
  sharePrompt: /share (?:your |this )?live|share (?:it )?(?:to|as) (?:a )?(?:reel|post|story)|save (?:your |this )?live|download (?:your |this )?live/i,
  /** Buttons that close an ended/share dialog without sharing or deleting anything. */
  leftoverDismiss: names('done', 'close', 'ok', 'okay', 'got it', 'not now', 'dismiss', "don't share", 'do not share', 'skip'),
  /** Viewer-count labels ("12 viewers", "Viewers", "watching"); never "views" (feed counts). */
  viewerLabel: /\bviewers?\b|\bwatching\b|viewer count/i,

  // ---- link (one per live) ----
  addLink: names('add link', 'add a link', 'add links', 'link', 'links'),
  /** The link's URL field: never the stream URL/key, the live title or the link's title. */
  linkUrl: /^(?!.*\b(?:stream|server|rtmps?|key|title|label|name|text|comment)\b)(?:.*\b(?:url|web address|website|link)\b|\s*https?:\/\/)/i,
  linkTitleHint: /title|label|text|name/i,
  linkSubmit: names('add', 'add link', 'save', 'done', 'apply', 'ok', 'confirm'),
  /** Closes the link form without adding anything (only ever looked up inside the tagged form). */
  linkCancel: names('cancel', 'close', 'not now', 'dismiss'),
  /** "Link Add a URL" (the URL option of the link-type chooser; never "WhatsApp link"). */
  linkTypeExternal: /^\s*link\b.*\badd a (?:url|link|website)\b/i,
  linkTypeConfirm: names('confirm', 'next', 'continue'),
  linkError:
    /couldn'?t add (?:the |your |this )?link|could not add (?:the |your |this )?link|(?:invalid|unsupported) (?:link|url)|link (?:isn'?t|is not|can'?t be|cannot be) (?:allowed|supported|valid|added)|enter a valid (?:link|url)/i,
} as const;

/** Attributes the driver sets on elements it found by script (link fields, the live's title). */
export const LIVE_TITLE_ATTR = 'data-ctd-ig-live-title';
export const LINK_URL_ATTR = 'data-ctd-ig-link-url';
export const LINK_TITLE_ATTR = 'data-ctd-ig-link-title';
/** The dialog the "Add link" control opened (tagged as soon as it shows, even without a URL field). */
export const LINK_FORM_ATTR = 'data-ctd-ig-link-form';
/** Dialogs already open before the "Add link" click (so the link form is the one that appears). */
export const PRE_DIALOG_ATTR = 'data-ctd-ig-pre';

/** Longest notice text classified as a takedown/warning (longer = a panel, not a notice). */
const NOTICE_MAX = 400;

/** Text of a dialog left over from an ended live (an end/takedown notice or a share prompt). */
export const LEFTOVER_DIALOG = new RegExp(`${RE.liveEnded.source}|${RE.sharePrompt.source}`, 'i');
/**
 * A short notice with policy wording plus "live" — what the health watcher treats as a takedown
 * ("Your live video was interrupted because it may include music that belongs to someone else").
 * Never "interrupted"/"reconnecting" alone: those are transient warnings, not ends.
 */
export const LEFTOVER_POLICY_NOTICE = new RegExp(
  `^(?=[\\s\\S]{0,${NOTICE_MAX}}$)(?=[\\s\\S]*\\blive\\b)(?=[\\s\\S]*(?:${RE.takedownPolicy.source}))`,
  'i',
);

type Scope = Page | Locator;

function anyRole(scope: Scope, roles: Parameters<Page['getByRole']>[0][], name: RegExp): Locator {
  let loc = scope.getByRole(roles[0]!, { name });
  for (const role of roles.slice(1)) loc = loc.or(scope.getByRole(role, { name }));
  return loc;
}

/** Locator factories. Callers apply `.filter({ visible: true }).first()` where needed. */
export const sel = {
  // ---- session ----
  loginForm: (p: Page) => p.locator('input[type="password"]').or(p.locator('input[name="username"]')),
  loggedInMarker: (p: Page) =>
    anyRole(p, ['link', 'button'], names('home', 'reels', 'messages', 'direct', 'create', 'new post'))
      .or(p.locator('a[href^="/direct/"], a[href="/reels/"]')),
  profileLink: (p: Page) => p.getByRole('link', { name: RE.profileLink }),
  avatarImages: (p: Page) => p.locator('img[alt$="profile picture" i]'),

  // ---- interstitials (never accept anything; only "Not now" / decline optional cookies) ----
  cookieDecline: (p: Page) => p.getByRole('button', { name: RE.cookieDecline }),
  notNow: (p: Page) => p.getByRole('button', { name: RE.notNow }),

  // ---- create → live ----
  createButton: (p: Page) => anyRole(p, ['link', 'button'], RE.create),
  liveOption: (p: Page) =>
    anyRole(p, ['link', 'menuitem', 'button', 'option'], RE.liveVideo).or(p.getByText(/^live video$/i)),
  postItem: (p: Page) => anyRole(p, ['link', 'menuitem', 'button', 'option'], RE.postItem),
  postDialog: (p: Page) => p.getByText(RE.postDialog),
  ineligible: (p: Page) => p.getByText(RE.ineligible),

  // ---- setup ("Go live" form) ----
  titleInput: (p: Page) =>
    p.getByRole('textbox', { name: RE.title }).or(p.getByPlaceholder(RE.title)).or(p.getByLabel(RE.title)),
  audienceRadio: (p: Page, re: RegExp) => p.getByRole('radio', { name: re }),
  audienceCombo: (p: Page) => anyRole(p, ['combobox', 'button'], RE.audience),
  /** An unlabelled <select> offering Practice (Instagram's setup form, Oct 2026: "Public ⌄"). */
  audienceSelect: (p: Page) => p.locator('select').filter({ has: p.locator('option', { hasText: RE.practice }) }),
  /** An unlabelled custom dropdown named after the current audience. */
  audienceTrigger: (p: Page) => anyRole(p, ['combobox', 'button'], RE.audienceChoice),
  audienceOption: (p: Page, re: RegExp) => anyRole(p, ['option', 'menuitemradio', 'menuitem', 'radio'], re),
  audienceText: (p: Page, re: RegExp) => p.getByText(re),
  nextButton: (p: Page) => p.getByRole('button', { name: RE.next }),

  // ---- stream details ----
  streamUrlField: (p: Page) =>
    p.getByLabel(new RegExp(RE.streamUrlLabel, 'i')).or(p.getByRole('textbox', { name: /(?:stream|server) url/i })),
  streamKeyField: (p: Page) =>
    p.getByLabel(new RegExp(RE.streamKeyLabel, 'i')).or(p.getByRole('textbox', { name: /stream key/i })),
  streamKeyLabel: (p: Page) => p.getByText(new RegExp(RE.streamKeyLabel, 'i')),
  showKeyButton: (p: Page) => p.getByRole('button', { name: RE.showKey }),

  // ---- producer ----
  goLiveButton: (p: Page) => p.getByRole('button', { name: RE.goLive }),
  /** "Go live" inside an open dialog (it then sits above the page's own button). */
  dialogGoLiveButton: (p: Page) => p.getByRole('dialog').getByRole('button', { name: RE.goLive }),
  /** A possible "Go live?" confirmation step after clicking "Go live". */
  goLiveConfirmButton: (p: Page) =>
    p
      .getByRole('alertdialog')
      .or(p.getByRole('dialog').filter({ hasText: RE.goLiveConfirmDialog }))
      .getByRole('button', { name: RE.goLive }),
  waitingForStream: (p: Page) => p.getByText(RE.waitingForStream),
  endLiveButton: (p: Page) => p.getByRole('button', { name: RE.endLive }),
  endConfirmButton: (p: Page) =>
    p
      .getByRole('alertdialog')
      .or(p.getByRole('dialog').filter({ hasText: RE.endConfirmDialog }))
      .getByRole('button', { name: RE.endConfirm }),
  liveNow: (p: Page) => p.getByText(RE.liveNow),
  ended: (p: Page) => p.getByText(RE.ended),
  afterEndButton: (p: Page) => p.getByRole('button', { name: RE.afterEnd }),
  platformError: (p: Page) => p.getByText(RE.platformError),
  // ---- comments (the selectors, roles and names come from the chat selector pack, chat-pack.ts) ----
  /** The "Comments" tab: the pack's CSS selectors, else one of its roles with a matching name. */
  commentsTab: (p: Page, tab: IgChatPack['tab']) => {
    const name = new RegExp(tab.name, 'i');
    const parts = [...tab.css.map((css) => p.locator(`css=${css}`)), ...tab.roles.map((role) => p.getByRole(role, { name }))];
    return parts.slice(1).reduce((loc, part) => loc.or(part), parts[0]!);
  },
  /** The producer's own comment box ("Add a comment…"); never the live's title field. */
  commentBox: (p: Page, hintCss: string[]) =>
    p
      .locator('textarea, input[type="text"], input:not([type]), [contenteditable="true"]')
      .and(hintCss.map((css) => p.locator(`css=${css}`)).reduce((loc, part) => loc.or(part), p.locator('css=:not(*)')))
      .and(p.locator(`:not([${LIVE_TITLE_ATTR}])`)),
  commentPost: (p: Page, name: string) => p.getByRole('button', { name: new RegExp(name, 'i') }),

  // ---- after a takedown ----
  /**
   * "Done" / "Close" / "Don't share" in a "live ended" or "share your live" dialog, or in a short
   * policy notice the health watcher counts as a takedown (never "Share"). The policy branch skips
   * dialogs holding inputs or comments, like the health probe: the setup form or the producer may
   * mention "Community Guidelines" (or a viewer may type "copyright") next to a "Go live" button.
   */
  leftoverDismiss: (p: Page) => {
    const dialogs = p.getByRole('dialog').or(p.getByRole('alertdialog'));
    const policyNotice = dialogs.filter({ hasText: LEFTOVER_POLICY_NOTICE }).filter({
      hasNot: p.locator(
        `input, textarea, select, [contenteditable="true"], [role="tabpanel"], [role="log"], [${CHAT_CONTAINER_ATTR}], [${CHAT_ROW_ATTR}]`,
      ),
    });
    return dialogs.filter({ hasText: LEFTOVER_DIALOG }).or(policyNotice).getByRole('button', { name: RE.leftoverDismiss });
  },

  // ---- link ----
  addLinkButton: (p: Page) => anyRole(p, ['button', 'link', 'menuitem'], RE.addLink),
  /** The link's URL field, in `scope` (the tagged link form when there is one, else the page). */
  linkUrlInput: (scope: Scope) =>
    scope
      .locator('input[type="url"]')
      .or(scope.getByRole('textbox', { name: RE.linkUrl }))
      .or(scope.getByPlaceholder(RE.linkUrl)),
  taggedLinkUrl: (p: Page) => p.locator(`[${LINK_URL_ATTR}]`),
  taggedLinkTitle: (p: Page) => p.locator(`[${LINK_TITLE_ATTR}]`),
  /** The dialog the "Add link" control opened (see TAG_LINK_FORM_SOURCE). */
  taggedLinkForm: (p: Page) => p.locator(`[${LINK_FORM_ATTR}]`),
  /** The dialog holding the (tagged) link URL field. */
  linkDialog: (p: Page) =>
    p
      .getByRole('dialog')
      .or(p.getByRole('alertdialog'))
      .filter({ has: p.locator(`[${LINK_URL_ATTR}]`) }),
  linkSubmit: (scope: Scope) => scope.getByRole('button', { name: RE.linkSubmit }),
  /**
   * The link-type chooser "Add link" opens first (SEEN Oct 2026, server log): "Link / Add a URL"
   * (radio name=linkType aria-label=external) or "WhatsApp link", then "Confirm".
   */
  linkTypeExternal: (scope: Scope) =>
    scope.getByRole('button', { name: RE.linkTypeExternal }).or(scope.locator('input[type="radio"][aria-label="external" i]')),
  linkTypeRadio: (scope: Scope) => scope.locator('input[type="radio"][aria-label="external" i], input[type="radio"][value="external" i]'),
  linkTypeConfirm: (scope: Scope) => scope.getByRole('button', { name: RE.linkTypeConfirm }),
  linkError: (p: Page) => p.getByText(RE.linkError),
};

// ---------------------------------------------------------------------------
// In-page scripts (plain JS strings: nothing from the TS toolchain leaks into the page)
// ---------------------------------------------------------------------------

/**
 * `(args) => { url, key }`: finds the values shown next to the "Stream URL" / "Stream key" labels
 * (label[for], or the nearest input / text leaf in the label's ancestors). Fallback for when the
 * fields are not exposed as labelled inputs.
 */
export const STREAM_DETAILS_SOURCE = `(args) => {
  const urlRe = new RegExp(args.urlLabel, 'i');
  const keyRe = new RegExp(args.keyLabel, 'i');
  const skipRe = /^(copy|copied|reset|reset key|reset stream key|show|hide|stream url|server url|stream key)$/i;
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const ownText = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
  const valueOf = (el) => (el.matches('input, textarea') ? String(el.value || '') : String(el.innerText || el.textContent || '')).trim();
  const find = (labelRe, accept) => {
    for (const el of document.querySelectorAll('label, span, div, p, h1, h2, h3, h4, h5, h6, dt, strong')) {
      if (!visible(el)) continue;
      const own = ownText(el);
      if (!own || !labelRe.test(own)) continue;
      if (el.tagName === 'LABEL' && el.htmlFor) {
        const target = document.getElementById(el.htmlFor);
        if (target && accept(valueOf(target))) return valueOf(target);
      }
      let node = el.parentElement;
      for (let depth = 0; depth < 5 && node; depth++, node = node.parentElement) {
        for (const input of node.querySelectorAll('input, textarea')) {
          const v = valueOf(input);
          if (accept(v)) return v;
        }
        for (const leaf of node.querySelectorAll('*')) {
          if (leaf === el || leaf.children.length > 0 || !visible(leaf)) continue;
          const t = String(leaf.textContent || '').trim();
          if (t && !skipRe.test(t) && accept(t)) return t;
        }
      }
    }
    return null;
  };
  const isUrl = (v) => /^rtmps?:\\/\\/\\S+$/i.test(v);
  // Keys hold digits (e.g. "1791...?s_bl=1&..."); a masked key ("••••") is returned so the caller
  // can click "Show" and read again.
  const isKey = (v) => !isUrl(v) && !skipRe.test(v) && ((/^\\S{10,}$/.test(v) && /\\d/.test(v)) || /^[•●*]{6,}$/.test(v));
  return { url: find(urlRe, isUrl), key: find(keyRe, isKey) };
}`;

/**
 * Attributes the chat reader (chat-scan.ts) sets on the comments container and on each comment
 * row. The health probe and the leftover-dialog check use them to keep away from the comments.
 */
export const CHAT_CONTAINER_ATTR = 'data-ctd-ig-comments';
export const CHAT_ROW_ATTR = 'data-ctd-ig-comment';

/** Arguments of HEALTH_PROBE_SOURCE (regex sources, so nothing needs escaping in the script). */
export const HEALTH_PROBE_ARGS = {
  warning: RE.takedownWarning.source,
  ended: RE.liveEnded.source,
  policy: RE.takedownPolicy.source,
  interrupted: RE.liveInterrupted.source,
  viewer: RE.viewerLabel.source,
  /** A number as a viewer count shows it ("0", "1,234", "1.2K"). */
  count: /^\d[\d.,\s]*(?:\s?[KkMm])?$/.source,
  /** The number inside a label ("12 viewers", "Viewers: 0"). */
  labelNumber: /\d[\d.,]*(?:\s?[KkMm])?/.source,
  /** "12 viewers" / "12 watching" / "Viewers: 12" as plain text. */
  countThenLabel: /^(\d[\d.,\s]*(?:\s?[KkMm])?)\s*(?:viewers?|watching|people watching)$/.source,
  labelThenCount: /^(?:viewers?|watching|viewer count)\s*:?\s*(\d[\d.,\s]*(?:\s?[KkMm])?)$/.source,
  commentsAttr: CHAT_CONTAINER_ATTR,
  commentAttr: CHAT_ROW_ATTR,
  maxNotice: NOTICE_MAX,
};

/**
 * `(args) => { ended, warning, viewers }` — one read of the producer page for the health watcher:
 * - `ended` / `warning`: text of a short visible notice (dialog, alert or heading) that says the
 *   live ended / was removed (or only warns). Never read from the comments (marked container,
 *   rows, lists, logs, panels labelled "comments") or from panels holding inputs or several avatars.
 * - `viewers`: the viewer count's raw text (parsed by the driver), from a "viewers"/"watching"
 *   label (aria-label/title, with the number inside it or next to the labelled icon) or a short
 *   "12 viewers" text outside the comments; null when not found.
 */
export const HEALTH_PROBE_SOURCE = `(args) => {
  const re = (s) => new RegExp(s, 'i');
  const warnRe = re(args.warning), endedRe = re(args.ended), policyRe = re(args.policy), interruptRe = re(args.interrupted);
  const viewerRe = re(args.viewer), countRe = re(args.count), labelNumRe = re(args.labelNumber);
  const countLabelRe = re(args.countThenLabel), labelCountRe = re(args.labelThenCount);
  const liveRe = /\\blive\\b/i;
  const avatarSel = 'img[alt$="profile picture" i]';
  const commentsSel = '[' + args.commentsAttr + '], [' + args.commentAttr + '], li, [role="listitem"], [role="row"], [role="log"], [role="feed"], article';
  const visible = (el) => !!(el && el.isConnected && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const squash = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const textOf = (el) => squash(el.innerText || el.textContent);
  // Comments: the chat marker's container/rows, list rows, logs, or a panel/region labelled "comments".
  const inComments = (el) => {
    if (el.closest(commentsSel)) return true;
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const role = node.getAttribute('role');
      if (role !== 'tabpanel' && role !== 'region' && role !== 'complementary') continue;
      const by = node.getAttribute('aria-labelledby');
      const tab = by ? document.getElementById(by) : null;
      if (/comment/i.test(node.getAttribute('aria-label') || (tab && tab.textContent) || '')) return true;
    }
    return false;
  };
  // Notice text without its buttons/links ("Share", "Done").
  const noticeText = (el) => {
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!p || p.closest('button, [role="button"], a, svg, time, script, style')) continue;
      const t = squash(n.textContent);
      if (t) parts.push(t);
    }
    return squash(parts.join(' '));
  };
  const out = { ended: null, warning: null, viewers: null };
  const classify = (t) => {
    if (!t || t.length > args.maxNotice) return;
    if (warnRe.test(t)) { if (!out.warning) out.warning = t; return; }
    if (endedRe.test(t) || (policyRe.test(t) && liveRe.test(t))) { if (!out.ended) out.ended = t; return; }
    if (interruptRe.test(t) && !out.warning) out.warning = t;
  };
  // Not role="status" / aria-live regions: they may announce viewers' comments, and a comment saying
  // "your live has ended" must never end a healthy live.
  const noticeSel = '[role="dialog"], [role="alertdialog"], [role="alert"]';
  for (const el of document.querySelectorAll(noticeSel)) {
    if (!visible(el) || inComments(el)) continue;
    if (el.querySelector('input, textarea, select, [contenteditable="true"], [role="tabpanel"], [role="log"], [' + args.commentsAttr + '], [' + args.commentAttr + ']')) continue;
    if (el.querySelectorAll(avatarSel).length > 1) continue;
    classify(noticeText(el));
  }
  for (const el of document.querySelectorAll('h1, h2, h3, h4, [role="heading"]')) {
    if (visible(el) && !inComments(el)) classify(noticeText(el));
  }

  const isCount = (s) => !!s && s.length <= 12 && countRe.test(s);
  const near = (el) => {
    const tag = String(el.tagName || '').toLowerCase();
    const host = tag === 'svg' || tag === 'img' || el.getAttribute('role') === 'img' ? el.parentElement : el;
    if (!host) return null;
    const own = textOf(host);
    if (isCount(own)) return own;
    for (const dir of ['nextElementSibling', 'previousElementSibling']) {
      let sib = host[dir];
      for (let i = 0; sib && i < 2; i++, sib = sib[dir]) {
        const t = textOf(sib);
        if (isCount(t)) return t;
      }
    }
    const parent = host.parentElement;
    const t = parent ? textOf(parent) : '';
    return isCount(t) ? t : null;
  };
  for (const el of document.querySelectorAll('[aria-label], [title]')) {
    if (!visible(el) && !(el.parentElement && visible(el.parentElement))) continue;
    if (inComments(el)) continue;
    const label = squash(el.getAttribute('aria-label') || el.getAttribute('title'));
    if (!label || label.length > 60 || !viewerRe.test(label)) continue;
    const m = labelNumRe.exec(label);
    if (m && isCount(m[0].trim())) { out.viewers = m[0].trim(); break; }
    const t = near(el);
    if (t !== null) { out.viewers = t; break; }
  }
  if (out.viewers === null) {
    // A short row with a visible avatar is a comment (or a viewer's name), not the live's count.
    const nearAvatar = (el) => {
      let node = el.parentElement;
      for (let i = 0; i < 2 && node && node !== document.body; i++, node = node.parentElement) {
        const avatar = Array.from(node.querySelectorAll(avatarSel)).some(visible);
        if (avatar && textOf(node).length <= 120) return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll('span, div, p, strong, b')) {
      if (el.children.length > 2) continue;
      const t = textOf(el);
      if (!t || t.length > 30) continue;
      const m = countLabelRe.exec(t) || labelCountRe.exec(t);
      if (!m || !visible(el) || inComments(el) || nearAvatar(el)) continue;
      out.viewers = m[1].trim();
      break;
    }
  }
  return out;
}`;

/** Arguments of LINK_TITLE_SOURCE. */
export const LINK_TITLE_ARGS = {
  urlAttr: LINK_URL_ATTR,
  titleAttr: LINK_TITLE_ATTR,
  liveTitleAttr: LIVE_TITLE_ATTR,
  hint: RE.linkTitleHint.source,
  bad: /stream|server|key|comment|search|rtmp/.source,
};

/**
 * `(args) => boolean`: tags the link's title/label field — the nearest visible text input around the
 * tagged link URL field (up to 4 levels up) whose label/placeholder says title/label/text/name,
 * preferring one that also says "link". Never the live's own title field (tagged by the driver).
 */
export const LINK_TITLE_SOURCE = `(args) => {
  for (const old of document.querySelectorAll('[' + args.titleAttr + ']')) old.removeAttribute(args.titleAttr);
  const url = document.querySelector('[' + args.urlAttr + ']');
  if (!url) return false;
  const hintRe = new RegExp(args.hint, 'i');
  const badRe = new RegExp(args.bad, 'i');
  const visible = (el) => !!(el && el.isConnected && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const hintOf = (el) => {
    const parts = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name')];
    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label) parts.push(label.textContent);
    }
    const wrap = el.closest('label');
    if (wrap) parts.push(wrap.textContent);
    return parts.filter(Boolean).join(' ');
  };
  let node = url.parentElement;
  for (let depth = 0; depth < 4 && node && node !== document.body; depth++, node = node.parentElement) {
    let fallback = null;
    for (const el of node.querySelectorAll('input:not([type]), input[type="text"], textarea')) {
      if (el === url || !visible(el) || el.hasAttribute(args.liveTitleAttr)) continue;
      const hint = hintOf(el);
      if (!hintRe.test(hint) || badRe.test(hint)) continue;
      if (/link/i.test(hint)) { el.setAttribute(args.titleAttr, ''); return true; }
      if (!fallback) fallback = el;
    }
    if (fallback) { fallback.setAttribute(args.titleAttr, ''); return true; }
  }
  return false;
}`;

/** Arguments of MARK_DIALOGS_SOURCE / TAG_LINK_FORM_SOURCE. */
export const LINK_FORM_ARGS = {
  formAttr: LINK_FORM_ATTR,
  preAttr: PRE_DIALOG_ATTR,
  dialogs: '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]',
};

/**
 * `(args) => void`, run right before clicking "Add link": clears old link-form/pre marks and marks
 * every dialog visible now, so the link form is the dialog that shows up after the click.
 */
export const MARK_DIALOGS_SOURCE = `(args) => {
  for (const attr of [args.formAttr, args.preAttr]) for (const el of document.querySelectorAll('[' + attr + ']')) el.removeAttribute(attr);
  const visible = (el) => !!(el && el.isConnected && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  for (const el of document.querySelectorAll(args.dialogs)) if (visible(el)) el.setAttribute(args.preAttr, '');
}`;

/**
 * `(args) => boolean`: tags the link form — the last (innermost/topmost) visible dialog that was not
 * open before the "Add link" click and holds a field. True when a visible form is tagged. A dialog
 * without fields (a notice) is never taken for the form.
 */
export const TAG_LINK_FORM_SOURCE = `(args) => {
  const visible = (el) => !!(el && el.isConnected && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const tagged = document.querySelector('[' + args.formAttr + ']');
  if (tagged && visible(tagged)) return true;
  let found = null;
  for (const el of document.querySelectorAll(args.dialogs)) {
    if (!visible(el) || el.hasAttribute(args.preAttr) || el.querySelector('[' + args.preAttr + ']')) continue;
    if (!el.querySelector('input, textarea, [contenteditable="true"]')) continue;
    found = el;
  }
  if (!found) return false;
  if (tagged) tagged.removeAttribute(args.formAttr);
  found.setAttribute(args.formAttr, '');
  return true;
}`;

/**
 * `() => string[]`: a short description of the visible controls in the topmost dialog (else the
 * page), logged when a setup step can't be found, so a site change can be fixed from the logs.
 * Roles, labels, states and short texts only; never input values.
 */
export const DESCRIBE_CONTROLS_SOURCE = `() => {
  const visible = (el) => !!(el && el.isConnected && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const squash = (s) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 50);
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]')).filter(visible);
  const root = dialogs.length ? dialogs[dialogs.length - 1] : document.body;
  const out = [];
  for (const el of root.querySelectorAll('button, a, input, select, label, [role], [aria-checked], [aria-selected], [aria-pressed]')) {
    if (out.length >= 60) break;
    if (!visible(el) || el.matches('svg, svg *')) continue;
    const parts = [el.tagName.toLowerCase()];
    const role = el.getAttribute('role');
    if (role) parts.push('role=' + role);
    if (el.type && el.tagName === 'INPUT') parts.push('type=' + el.type);
    for (const a of ['aria-label', 'aria-checked', 'aria-selected', 'aria-pressed', 'aria-expanded', 'aria-haspopup', 'placeholder', 'name']) {
      const v = el.getAttribute(a);
      if (v) parts.push(a + '=' + squash(v));
    }
    if (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox')) parts.push('checked=' + el.checked);
    if (el.tagName === 'SELECT') parts.push('options=' + Array.from(el.options).map((o) => squash(o.textContent)).join('|'));
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') {
      const t = squash(el.innerText || el.textContent);
      if (t) parts.push('"' + t + '"');
    }
    out.push(parts.join(' '));
  }
  return out;
}`;

/** `(attr) => void`: removes a marker attribute from every element. */
export const CLEAR_ATTR_SOURCE = `(attr) => { for (const el of document.querySelectorAll('[' + attr + ']')) el.removeAttribute(attr); }`;
