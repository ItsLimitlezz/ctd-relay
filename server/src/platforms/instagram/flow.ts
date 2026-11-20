// Browser steps for Instagram's desktop live flow (Live Producer). Every wait is bounded and
// honours the caller's AbortSignal; locators and texts come from selectors.ts.

import type { Logger } from 'pino';
import type { BrowserContext, Locator, Page } from 'playwright';
import { abortable, fillField, humanPause, readTextValue, waitForAny } from '../../browser/helpers.js';
import { DriverError } from '../types.js';
import { DESCRIBE_CONTROLS_SOURCE, LIVE_TITLE_ATTR, LOGIN_PATH, RE, SESSION_COOKIE, STREAM_DETAILS_SOURCE, sel } from './selectors.js';
import {
  instagramTitle,
  isMasked,
  isStreamKey,
  isStreamServerUrl,
  shortError,
  usernameFromAlt,
  usernameFromHref,
  type Audience,
} from './util.js';

export interface FlowTimeouts {
  /** Home page: logged-in UI or login form must show up. */
  pageLoad: number;
  /** One UI step (menu, dialog, button). */
  step: number;
  /** Stream URL + key screen after "Next". */
  streamDetails: number;
  /** After clicking "Go live": live indicator. */
  liveConfirm: number;
  /** Ending the live (click, confirm, ended state). */
  end: number;
  /** After going live: how long to look for the "Add link" control (before going live: a short look). */
  linkFind: number;
  /** One step of adding the link (form opens, "Add" enabled, form closes). */
  linkStep: number;
}

export const DEFAULT_TIMEOUTS: FlowTimeouts = {
  pageLoad: 25_000,
  step: 20_000,
  streamDetails: 30_000,
  liveConfirm: 25_000,
  // end() as a whole must fit the orchestrator's 30 s budget (plus 5 s summary + 8 s navigation).
  end: 15_000,
  linkFind: 4_000,
  linkStep: 8_000,
};

export interface FlowConfig {
  /** https://www.instagram.com (tests point this at a local fixture server). */
  baseUrl: string;
  timeouts: FlowTimeouts;
}

export const NOT_ELIGIBLE_MESSAGE =
  'This Instagram account cannot go live from a computer. Instagram requires a public professional account with at least ' +
  '1,000 followers in good standing, and Live Producer may not be available to every account.';
const SITE_CHANGED = 'Instagram may have changed its site.';

export function notEligible(): DriverError {
  return new DriverError(NOT_ELIGIBLE_MESSAGE, 'not-eligible');
}

function isTimeout(err: unknown): boolean {
  return err instanceof DriverError && err.code === 'timeout';
}

/** First visible element of `loc`, or null. Never throws. */
export async function visibleNow(loc: Locator, last = false): Promise<Locator | null> {
  const visible = loc.filter({ visible: true });
  const target = last ? visible.last() : visible.first();
  try {
    return (await target.isVisible()) ? target : null;
  } catch {
    return null; // detached / navigating
  }
}

/** Wait for a visible element; null on timeout (abort still rejects). */
export async function waitVisible(loc: Locator, page: Page, timeoutMs: number, signal: AbortSignal): Promise<Locator | null> {
  try {
    await waitForAny(page, { target: loc }, { timeoutMs, signal, pollMs: 150 });
    return await visibleNow(loc);
  } catch (err) {
    if (isTimeout(err)) return null;
    throw err;
  }
}

/** waitForAny that turns its generic timeout into a clearer DriverError. */
async function waitForStep(
  page: Page,
  candidates: Record<string, Locator>,
  timeoutMs: number,
  signal: AbortSignal,
  onTimeout: () => DriverError,
): Promise<string> {
  try {
    return await waitForAny(page, candidates, { timeoutMs, signal });
  } catch (err) {
    if (isTimeout(err)) throw onTimeout();
    throw err;
  }
}

/** Visible text of an error banner, shortened (for messages; Instagram texts never hold secrets). */
async function errorText(page: Page): Promise<string> {
  const el = await visibleNow(sel.platformError(page));
  const text = el ? await el.innerText({ timeout: 2000 }).catch(() => '') : '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 150) || 'unknown error';
}

export async function click(target: Locator, signal: AbortSignal, timeoutMs = 10_000): Promise<void> {
  await humanPause(150, 450, signal);
  await abortable(target.click({ timeout: timeoutMs }), signal);
}

/**
 * Click a step button; when an overlay (notifications prompt, cookie banner) intercepts the
 * click, dismiss it and retry once.
 */
async function clickStep(page: Page, loc: Locator, what: string, signal: AbortSignal, timeoutMs: number): Promise<void> {
  const target = await waitVisible(loc, page, timeoutMs, signal);
  if (!target) throw new DriverError(`Couldn't find ${what} on Instagram. ${SITE_CHANGED}`, 'platform-error');
  try {
    await click(target, signal, 8_000);
  } catch (err) {
    if (signal.aborted) throw err;
    await dismissInterstitials(page, signal);
    const again = await visibleNow(loc);
    if (!again) throw new DriverError(`Couldn't click ${what} on Instagram (${shortError(err)})`, 'platform-error');
    await click(again, signal, 8_000);
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export async function hasSessionCookie(context: BrowserContext, baseUrl: string): Promise<boolean> {
  const cookies = await context.cookies(baseUrl);
  const now = Date.now() / 1000;
  return cookies.some((c) => c.name === SESSION_COOKIE && c.value !== '' && (c.expires === -1 || c.expires > now));
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

export function isLoginUrl(url: string): boolean {
  return pathOf(url).startsWith(LOGIN_PATH.replace(/\/$/, ''));
}

/** Instagram wants a security check (or the account is blocked): only the user can fix it. */
export function checkpointError(url: string): DriverError | null {
  if (!/^\/(?:challenge|checkpoint|accounts\/suspended|accounts\/disabled)(?:\/|$)/i.test(pathOf(url))) return null;
  return new DriverError(
    "Instagram wants you to confirm it's you. Open the account under Accounts, complete Instagram's check in the browser view, then try again.",
    'needs-login',
  );
}

/**
 * True when the page shows the logged-in Instagram UI and the session cookie exists.
 * Throws needs-login for security checkpoints and timeout when Instagram never renders.
 */
export async function isLoggedIn(page: Page, cfg: FlowConfig, signal: AbortSignal): Promise<boolean> {
  if (!(await hasSessionCookie(page.context(), cfg.baseUrl))) return false;
  const checkpoint = checkpointError(page.url());
  if (checkpoint) throw checkpoint;
  if (isLoginUrl(page.url())) return false;
  const which = await waitForStep(
    page,
    { in: sel.loggedInMarker(page), out: sel.loginForm(page) },
    cfg.timeouts.pageLoad,
    signal,
    () => new DriverError("Instagram didn't finish loading. Check the server's internet connection and try again.", 'timeout'),
  );
  return which === 'in';
}

/** The logged-in user's name from the sidebar "Profile" link (null if not found). */
export async function readUsername(page: Page): Promise<string | null> {
  const links = sel.profileLink(page).filter({ visible: true });
  const count = Math.min(5, await links.count().catch(() => 0));
  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    const fromHref = usernameFromHref(await link.getAttribute('href', { timeout: 2000 }).catch(() => null));
    if (fromHref) return fromHref;
    const alt = await link
      .locator('img')
      .first()
      .getAttribute('alt', { timeout: 1000 })
      .catch(() => null);
    const fromAlt = usernameFromAlt(alt);
    if (fromAlt) return fromAlt;
  }
  return null;
}

/**
 * Best effort: "Not now" on prompts, "decline optional cookies" on the cookie banner, and "Done" /
 * "Close" / "Don't share" on a "live ended" or "share your live" dialog left over from a live
 * Instagram ended (never "Share").
 */
export async function dismissInterstitials(page: Page, signal: AbortSignal, rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    let clicked = false;
    for (const loc of [sel.cookieDecline(page), sel.leftoverDismiss(page), sel.notNow(page)]) {
      const target = await visibleNow(loc);
      if (!target) continue;
      try {
        await click(target, signal, 3_000);
        clicked = true;
      } catch (err) {
        if (signal.aborted) throw err;
      }
    }
    if (!clicked) return;
    await humanPause(300, 700, signal);
  }
}

// ---------------------------------------------------------------------------
// Live setup
// ---------------------------------------------------------------------------

/** Create (+) → "Live video" → the setup form. Throws not-eligible when there is no live option. */
export async function openLiveSetup(page: Page, cfg: FlowConfig, signal: AbortSignal): Promise<void> {
  await dismissInterstitials(page, signal);
  await clickStep(page, sel.createButton(page), 'the "Create" button', signal, cfg.timeouts.step);

  const opened = await waitForStep(
    page,
    {
      live: sel.liveOption(page),
      ineligible: sel.ineligible(page),
      postDialog: sel.postDialog(page),
      postItem: sel.postItem(page),
    },
    cfg.timeouts.step,
    signal,
    () => new DriverError(`Instagram's "Create" menu did not open. ${SITE_CHANGED}`, 'platform-error'),
  );
  if (opened === 'ineligible') throw notEligible();
  if (opened !== 'live') {
    // The menu (or the upload dialog) opened without a live option: give it a moment to render.
    const live = await waitVisible(sel.liveOption(page), page, 2_000, signal);
    if (!live) {
      await page.keyboard.press('Escape').catch(() => {});
      throw notEligible();
    }
  }
  await clickStep(page, sel.liveOption(page), 'the "Live video" option', signal, cfg.timeouts.step);

  const setup = await waitForStep(
    page,
    {
      title: sel.titleInput(page),
      next: sel.nextButton(page),
      ineligible: sel.ineligible(page),
      error: sel.platformError(page),
    },
    cfg.timeouts.step,
    signal,
    () => new DriverError(`Instagram's live setup did not open. ${SITE_CHANGED}`, 'platform-error'),
  );
  if (setup === 'ineligible') throw notEligible();
  if (setup === 'error') throw new DriverError(`Instagram couldn't start a live: ${await errorText(page)}`, 'platform-error');
}

/**
 * Type the title, choose the audience, run `beforeNext` (e.g. add the live's link when the setup
 * form offers it; it must not throw except on abort), click "Next".
 */
export async function fillSetup(
  page: Page,
  input: { title: string; audience: Audience },
  cfg: FlowConfig,
  signal: AbortSignal,
  log: Logger,
  beforeNext?: () => Promise<void>,
): Promise<void> {
  await tagLiveTitle(page);
  if (input.title) await typeTitle(page, input.title, signal, log);
  await chooseAudience(page, input.audience, signal, log);
  if (beforeNext) await beforeNext();
  await humanPause(300, 800, signal);
  try {
    await clickWhenReady(page, sel.nextButton(page), 'the "Next" button', signal, cfg.timeouts.step);
  } catch (err) {
    // "Next" shown but disabled with an empty title: Instagram wants a title.
    if (!signal.aborted && !input.title && err instanceof DriverError && (await visibleNow(sel.nextButton(page)))) {
      throw new DriverError('Instagram needs a title for the live. Set a stream title on the dashboard and try again.', 'misconfigured');
    }
    throw err;
  }
}

/** Mark the live's title field so link-field detection never mistakes it for the link's title. */
async function tagLiveTitle(page: Page): Promise<void> {
  const field = await visibleNow(sel.titleInput(page));
  if (!field) return;
  await field
    .evaluate((el, attr) => (el as unknown as { setAttribute(n: string, v: string): void }).setAttribute(attr, ''), LIVE_TITLE_ATTR)
    .catch(() => {});
}

/** Title is set at creation only. A failure here is logged and the live goes on without it. */
async function typeTitle(page: Page, title: string, signal: AbortSignal, log: Logger): Promise<void> {
  const field = await visibleNow(sel.titleInput(page));
  if (!field) {
    log.warn('Instagram title field not found; continuing without a title');
    return;
  }
  try {
    const maxAttr = await field.getAttribute('maxlength', { timeout: 2000 }).catch(() => null);
    const max = maxAttr ? Number.parseInt(maxAttr, 10) : null;
    await fillField(field, instagramTitle(title, Number.isFinite(max) ? max : null), { signal, timeoutMs: 10_000 });
  } catch (err) {
    if (signal.aborted) throw err;
    log.warn({ error: shortError(err) }, 'typing the Instagram title failed; continuing');
  }
}

/** Wait until a button is visible and enabled, then click it (retrying once past overlays). */
async function clickWhenReady(page: Page, loc: Locator, what: string, signal: AbortSignal, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const target = await visibleNow(loc);
    if (target && (await target.isEnabled({ timeout: 1000 }).catch(() => false))) break;
    if (Date.now() >= deadline) {
      throw new DriverError(`Timed out waiting for ${what} on Instagram to become clickable`, 'timeout');
    }
    await humanPause(150, 250, signal);
  }
  await clickStep(page, loc, what, signal, 5_000);
}

/**
 * Select Public or Practice. Practice must never silently fall back to Public: if it can't be
 * selected and verified, the live is not created.
 */
async function chooseAudience(page: Page, audience: Audience, signal: AbortSignal, log: Logger): Promise<void> {
  const re = audience === 'practice' ? RE.practice : RE.public;
  let ok = false;
  try {
    ok = await selectAudience(page, re, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    log.warn({ error: shortError(err) }, 'selecting the Instagram audience failed');
  }
  if (ok) return;
  // What the form shows instead, so the selectors can be fixed from the server log.
  const controls = await page.evaluate(`(${DESCRIBE_CONTROLS_SOURCE})()`).catch(() => null);
  log.warn({ audience, controls }, 'Instagram audience not selected; visible controls of the setup form');
  if (audience === 'practice') {
    throw new DriverError(`Couldn't select the "Practice" audience on Instagram, so no live was started. ${SITE_CHANGED}`, 'platform-error');
  }
  log.warn("Instagram audience selector not found; keeping Instagram's default audience");
}

async function isChecked(loc: Locator): Promise<boolean> {
  return loc.isChecked({ timeout: 2000 }).catch(() => false);
}

/** Text of an audience dropdown without its label ("Audience: Practice" → "Practice"). */
async function shownAudience(combo: Locator): Promise<string> {
  const text = await combo.innerText({ timeout: 2000 }).catch(() => '');
  return text
    .replace(RE.audience, ' ')
    .replace(/^[\s:·-]+/, '')
    .trim();
}

/** Pick the option matching `re` in a native <select>; true only when it is then selected. */
async function chooseInSelect(select: Locator, re: RegExp, signal: AbortSignal): Promise<boolean> {
  const labels = (await select.locator('option').allTextContents()).map((l) => l.trim());
  const label = labels.find((l) => re.test(l));
  if (!label) return false;
  await humanPause(150, 400, signal);
  await abortable(select.selectOption({ label }, { timeout: 5_000 }), signal);
  const chosen = await select.evaluate((el) => {
    const s = el as { selectedOptions?: ArrayLike<{ textContent: string | null }> };
    return s.selectedOptions?.[0]?.textContent ?? '';
  });
  return re.test(chosen.trim());
}

/** Open a custom dropdown and pick the option matching `re`; true only when it then shows it. */
async function chooseInDropdown(page: Page, trigger: Locator, re: RegExp, signal: AbortSignal): Promise<boolean> {
  if (re.test(await shownAudience(trigger))) return true;
  await click(trigger, signal, 5_000);
  const option = await waitVisible(sel.audienceOption(page, re).or(sel.audienceText(page, re)), page, 5_000, signal);
  if (!option) {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  await click(option, signal, 5_000);
  await humanPause(200, 400, signal);
  return re.test(await shownAudience(trigger));
}

async function selectAudience(page: Page, re: RegExp, signal: AbortSignal): Promise<boolean> {
  // 1. A radio group.
  const radio = await visibleNow(sel.audienceRadio(page, re));
  if (radio) {
    if (!(await isChecked(radio))) await click(radio, signal, 5_000);
    return isChecked(radio);
  }

  // 2. A dropdown labelled "Audience": native <select> or a custom listbox.
  const combo = await visibleNow(sel.audienceCombo(page));
  if (combo) {
    const tag = await combo.evaluate((el) => String((el as { tagName?: unknown }).tagName ?? '')).catch(() => '');
    if (tag.toUpperCase() === 'SELECT') return chooseInSelect(combo, re, signal);
    return chooseInDropdown(page, combo, re, signal);
  }

  // 3. An unlabelled <select> offering Practice ("Public ⌄", Instagram's setup form in Oct 2026).
  const select = await visibleNow(sel.audienceSelect(page));
  if (select) return chooseInSelect(select, re, signal);

  // 4. An unlabelled custom dropdown named after the current audience.
  const trigger = await visibleNow(sel.audienceTrigger(page));
  if (trigger) return chooseInDropdown(page, trigger, re, signal);

  // 5. Clickable text (e.g. a label whose radio input is visually hidden).
  const text = await visibleNow(sel.audienceText(page, re));
  if (!text) return false;
  await click(text, signal, 5_000);
  return text
    .evaluate((el) => {
      type N = {
        closest(s: string): N | null;
        querySelector(s: string): N | null;
        getAttribute(n: string): string | null;
        control?: N | null;
        checked?: boolean;
        type?: string;
      };
      const node = el as unknown as N;
      const label = node.closest('label');
      const target =
        label?.control ?? node.querySelector('input') ?? node.closest('[role="radio"], [role="option"], [role="menuitemradio"]');
      if (!target) return false;
      if (typeof target.checked === 'boolean' && target.type) return target.checked;
      return target.getAttribute('aria-checked') === 'true' || target.getAttribute('aria-selected') === 'true';
    })
    .catch(() => false);
}

// ---------------------------------------------------------------------------
// Stream URL + key
// ---------------------------------------------------------------------------

export interface StreamDetails {
  server: string;
  key: string;
}

async function readField(loc: Locator): Promise<string> {
  const field = await visibleNow(loc);
  if (!field) return '';
  return readTextValue(field, { timeoutMs: 3_000 }).catch(() => '');
}

async function readDetailsOnce(page: Page): Promise<{ server: string | null; key: string | null; masked: boolean }> {
  let server = await readField(sel.streamUrlField(page));
  let key = await readField(sel.streamKeyField(page));
  if (!isStreamServerUrl(server) || !isStreamKey(key)) {
    const args = { urlLabel: RE.streamUrlLabel, keyLabel: RE.streamKeyLabel };
    const scanned = (await page
      .evaluate(`(${STREAM_DETAILS_SOURCE})(${JSON.stringify(args)})`)
      .catch(() => null)) as { url?: unknown; key?: unknown } | null;
    if (!isStreamServerUrl(server) && typeof scanned?.url === 'string') server = scanned.url.trim();
    if (!isStreamKey(key) && typeof scanned?.key === 'string') key = scanned.key.trim();
  }
  return {
    server: isStreamServerUrl(server) ? server : null,
    key: isStreamKey(key) ? key : null,
    masked: isMasked(key),
  };
}

/** Read the new Stream URL + key shown after "Next". The values are never logged. */
export async function readStreamDetails(page: Page, cfg: FlowConfig, signal: AbortSignal): Promise<StreamDetails> {
  const which = await waitForStep(
    page,
    {
      key: sel.streamKeyField(page),
      keyLabel: sel.streamKeyLabel(page),
      ineligible: sel.ineligible(page),
      error: sel.platformError(page),
    },
    cfg.timeouts.streamDetails,
    signal,
    () => new DriverError(`Instagram did not show the stream URL and key. ${SITE_CHANGED}`, 'platform-error'),
  );
  if (which === 'ineligible') throw notEligible();
  if (which === 'error') throw new DriverError(`Instagram couldn't create the live: ${await errorText(page)}`, 'platform-error');

  for (let attempt = 0; attempt < 4; attempt++) {
    const details = await readDetailsOnce(page);
    if (details.server && details.key) return { server: details.server, key: details.key };
    if (details.masked) {
      const show = await visibleNow(sel.showKeyButton(page));
      if (show) await click(show, signal, 3_000).catch((err: unknown) => {
        if (signal.aborted) throw err;
      });
    }
    await humanPause(500, 900, signal);
  }
  throw new DriverError(`Couldn't read the stream URL and key from Instagram. ${SITE_CHANGED}`, 'platform-error');
}

// ---------------------------------------------------------------------------
// Go live / end
// ---------------------------------------------------------------------------

/**
 * Wait (≤ timeoutMs) for "Go live" to become enabled — Instagram enables it once the preview of
 * our video arrives — click it and wait for the live indicator.
 */
export async function goLive(page: Page, timeoutMs: number, cfg: FlowConfig, signal: AbortSignal, log?: Logger): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen = false;
  for (;;) {
    signal.throwIfAborted();
    if (page.isClosed()) throw new DriverError('The Instagram page was closed before going live', 'platform-error');
    // The one in the open dialog first: a dialog (e.g. the stream key step) covers the page's own button.
    const button = (await visibleNow(sel.dialogGoLiveButton(page), true)) ?? (await visibleNow(sel.goLiveButton(page), true));
    if (button) {
      seen = true;
      const enabled = await button.isEnabled({ timeout: 1000 }).catch(() => false);
      if (enabled && !(await visibleNow(sel.waitingForStream(page)))) {
        await clickGoLive(page, button, signal, log);
        break;
      }
    } else if (await visibleNow(sel.endLiveButton(page))) {
      return; // already live
    } else if (await visibleNow(sel.ineligible(page))) {
      throw notEligible();
    }
    if (Date.now() >= deadline) {
      if (!seen) throw new DriverError(`Couldn't find Instagram's "Go live" button. ${SITE_CHANGED}`, 'platform-error');
      throw new DriverError('Instagram never received the video — check the vertical feed', 'timeout');
    }
    await humanPause(400, 600, signal);
  }
  await waitUntilLive(page, cfg, signal);
}

/**
 * Click "Go live". When something covers it (Playwright waits for the click until it times out),
 * log what the page shows — the full Playwright error names the covering element — close prompts,
 * and click the button directly (a DOM click event, which a covering layer can't swallow).
 */
async function clickGoLive(page: Page, button: Locator, signal: AbortSignal, log?: Logger): Promise<void> {
  await clickThrough(page, button, signal, 'Go live', 8_000, log, async () =>
    (await visibleNow(sel.dialogGoLiveButton(page), true)) ?? (await visibleNow(sel.goLiveButton(page), true)),
  );
}

/**
 * Click `button`; when something covers it (the click times out), log what the page shows (the full
 * Playwright error names the covering element), close prompts, and click it directly with a DOM
 * click event, which a covering layer can't swallow. `refind` locates the button again afterwards.
 */
async function clickThrough(
  page: Page,
  button: Locator,
  signal: AbortSignal,
  what: string,
  timeoutMs: number,
  log: Logger | undefined,
  refind: () => Promise<Locator | null>,
): Promise<void> {
  try {
    await click(button, signal, timeoutMs);
    return;
  } catch (err) {
    if (signal.aborted) throw err;
    const controls = await page.evaluate(`(${DESCRIBE_CONTROLS_SOURCE})()`).catch(() => null);
    log?.warn(
      { error: err instanceof Error ? err.message.slice(0, 1500) : String(err), controls },
      `clicking Instagram's "${what}" failed; visible controls of the page`,
    );
  }
  await dismissInterstitials(page, signal);
  const again = (await refind()) ?? button;
  await abortable(again.dispatchEvent('click', undefined, { timeout: 5_000 }), signal);
}

async function waitUntilLive(page: Page, cfg: FlowConfig, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + cfg.timeouts.liveConfirm;
  let confirmations = 0;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new DriverError('Instagram did not confirm that the live started', 'timeout');
    const which = await waitForAny(
      page,
      {
        live: sel.endLiveButton(page),
        liveText: sel.liveNow(page),
        confirm: sel.goLiveConfirmButton(page),
        error: sel.platformError(page),
      },
      { timeoutMs: left, signal },
    ).catch((err: unknown) => {
      if (isTimeout(err)) throw new DriverError('Instagram did not confirm that the live started', 'timeout');
      throw err;
    });
    if (which === 'live' || which === 'liveText') return;
    if (which === 'error') throw new DriverError(`Instagram couldn't start the live: ${await errorText(page)}`, 'platform-error');
    // A "Go live?" confirmation step.
    if (confirmations++ >= 2) throw new DriverError('Instagram did not confirm that the live started', 'timeout');
    const confirm = await visibleNow(sel.goLiveConfirmButton(page), true);
    if (confirm) await click(confirm, signal);
  }
}

export type EndResult = 'ended' | 'not-live' | 'closed' | 'skipped';

/**
 * End the live: "End live video" → confirmation → ended state → close the summary without
 * sharing. Returns 'not-live' when there was no live to end (never went live / Instagram already
 * ended it — a "live ended"/"share" dialog is then closed without sharing). `stillOwner` is
 * checked before every click: once it returns false (the page now hosts a newer live) nothing
 * more is clicked ('skipped').
 */
export async function endLive(page: Page, cfg: FlowConfig, stillOwner: () => boolean = () => true, log?: Logger): Promise<EndResult> {
  if (page.isClosed()) return 'closed';
  if (!stillOwner()) return 'skipped';
  const signal = AbortSignal.timeout(cfg.timeouts.end);
  // Instagram ended it already (takedown): its notice would block the "End" click.
  if (await visibleNow(sel.leftoverDismiss(page))) await dismissLeftovers(page, stillOwner);
  const endButton = await visibleNow(sel.endLiveButton(page));
  if (!endButton) {
    await dismissLeftovers(page, stillOwner);
    return 'not-live';
  }
  if (!stillOwner()) return 'skipped';
  // Live test (Oct 2026): this click timed out like "Go live" did; a live that isn't ended stays up.
  await clickThrough(page, endButton, signal, 'End live video', 5_000, log, () => visibleNow(sel.endLiveButton(page)));

  let confirmed = false;
  for (;;) {
    if (page.isClosed()) return 'closed';
    if (!stillOwner()) return 'skipped';
    if (signal.aborted) throw new DriverError('Instagram did not confirm that the live ended', 'timeout');
    if (await visibleNow(sel.ended(page))) break;
    if (!confirmed) {
      // The confirmation dialog's button, or a second "End live video" button (the dialog's).
      const ends = sel.endLiveButton(page).filter({ visible: true });
      const confirm = (await visibleNow(sel.endConfirmButton(page), true)) ?? ((await ends.count().catch(() => 0)) > 1 ? ends.last() : null);
      if (confirm) {
        await clickThrough(page, confirm, signal, 'End live (confirm)', 4_000, log, () => visibleNow(sel.endConfirmButton(page), true));
        confirmed = true;
        continue;
      }
    }
    if (!(await visibleNow(sel.endLiveButton(page))) && !(await visibleNow(sel.endConfirmButton(page)))) break;
    await humanPause(300, 500, signal).catch(() => {});
  }

  if (!stillOwner()) return 'skipped';
  await dismissAfterEnd(page);
  return 'ended';
}

/**
 * Close "live ended" / "share your live" dialogs left by a live Instagram ended (best effort,
 * bounded, never throws; never "Share").
 */
export async function dismissLeftovers(page: Page, stillOwner: () => boolean = () => true): Promise<void> {
  const signal = AbortSignal.timeout(6_000);
  try {
    for (let i = 0; i < 3 && !page.isClosed() && stillOwner(); i++) {
      const button = await visibleNow(sel.leftoverDismiss(page), true);
      if (!button) return;
      await click(button, signal, 3_000);
      await humanPause(250, 450, signal);
    }
  } catch {
    // best effort
  }
}

/** Close the post-live summary ("Done" / "Close"); never "Share" or "Delete". */
async function dismissAfterEnd(page: Page): Promise<void> {
  const signal = AbortSignal.timeout(5_000);
  try {
    const button = await waitVisible(sel.afterEndButton(page), page, 3_000, signal);
    if (button) await click(button, signal, 3_000);
  } catch {
    // best effort
  }
}
