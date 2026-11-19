// Instagram driver: browser automation of instagram.com's desktop live flow (Live Producer).
// Instagram has no public live API; every live gets a new stream URL + key, the title is set when
// the live is created, and "Go live" is clicked once Instagram shows our preview.
// Flow details and sources: selectors.ts.

import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { Page } from 'playwright';
import type { ConnectPoll, ConnectStart } from '../../../../shared/api.js';
import type { Account, PlatformInfo } from '../../../../shared/types.js';
import { requireLoggedIn } from '../../browser/helpers.js';
import { DriverError, type DriverContext, type PlatformDriver, type PreparedLive } from '../types.js';
import { DEFAULT_CHAT_TIMINGS, instagramChat, TEST_COMMENT, type ChatTimings } from './chat.js';
import { newChatMemory } from './chat-scan.js';
import {
  checkpointError,
  DEFAULT_TIMEOUTS,
  dismissInterstitials,
  endLive,
  fillSetup,
  goLive,
  hasSessionCookie,
  isLoggedIn,
  openLiveSetup,
  readStreamDetails,
  readUsername,
  visibleNow,
  type FlowConfig,
  type FlowTimeouts,
  type StreamDetails,
} from './flow.js';
import { DEFAULT_HEALTH_TIMINGS, HealthMonitor, ViewerReporter, watchHealth, type HealthTimings, type LiveMarks } from './health.js';
import { closeLinkForm, LiveLink } from './links.js';
import { IG_ORIGIN, LOGIN_PATH, sel } from './selectors.js';
import {
  DEFAULT_GO_LIVE_TIMEOUT_SEC,
  DEFAULT_TAKEDOWN_CONFIRM_SEC,
  DEFAULT_ZERO_VIEWER_SEC,
  joinStreamUrl,
  MAX_GO_LIVE_TIMEOUT_SEC,
  MAX_RECOVERY_ATTEMPTS,
  MAX_TAKEDOWN_CONFIRM_SEC,
  MAX_ZERO_VIEWER_SEC,
  MIN_GO_LIVE_TIMEOUT_SEC,
  MIN_TAKEDOWN_CONFIRM_SEC,
  optionProblems,
  readLiveOptions,
  shortError,
  type InstagramOptions,
} from './util.js';

export const instagramInfo: PlatformInfo = {
  id: 'instagram',
  name: 'Instagram',
  feeds: ['vertical'],
  defaultFeed: 'vertical',
  connectMethod: 'browser',
  accountFields: [],
  destinationFields: [
    {
      key: 'audience',
      label: 'Audience',
      type: 'select',
      target: 'option',
      default: 'public',
      options: [
        { value: 'public', label: 'Public' },
        { value: 'practice', label: 'Practice (only you)' },
      ],
      help: 'Practice = only you can see it — use it to test',
    },
    {
      key: 'goLiveTimeoutSec',
      label: 'Go-live timeout (seconds)',
      type: 'number',
      target: 'option',
      default: DEFAULT_GO_LIVE_TIMEOUT_SEC,
      help: `How long to wait for Instagram to receive the video before giving up (${MIN_GO_LIVE_TIMEOUT_SEC}–${MAX_GO_LIVE_TIMEOUT_SEC} s).`,
    },
    {
      key: 'autoRecover',
      label: 'Auto-recover takedowns',
      type: 'boolean',
      target: 'option',
      default: true,
      help: 'Automatically start a new live when Instagram ends this one (e.g. a copyright takedown).',
    },
    {
      key: 'takedownConfirmSec',
      label: 'Takedown confirm (seconds)',
      type: 'number',
      target: 'option',
      default: DEFAULT_TAKEDOWN_CONFIRM_SEC,
      help: `Push to Instagram down this long while OBS is still streaming ⇒ treat as a takedown (${MIN_TAKEDOWN_CONFIRM_SEC}–${MAX_TAKEDOWN_CONFIRM_SEC} s).`,
    },
    {
      key: 'zeroViewerSec',
      label: 'Zero-viewer takedown (seconds)',
      type: 'number',
      target: 'option',
      default: DEFAULT_ZERO_VIEWER_SEC,
      help:
        `Public lives only, needs auto-recover: 0 viewers this long ⇒ takedown, a new live is started ` +
        `(0 = off, up to ${MAX_ZERO_VIEWER_SEC} s). DPRTMNT uses 5. Leave 0 if your streams sometimes really have no viewers.`,
    },
    {
      key: 'links',
      label: 'Links',
      type: 'links',
      target: 'option',
      help: 'Links to attach to the live (Instagram allows one per live).',
    },
    {
      key: 'linkMode',
      label: 'Link on each live',
      type: 'select',
      target: 'option',
      default: 'rotate',
      options: [
        { value: 'off', label: "Don't add a link" },
        { value: 'rotate', label: 'Next link on every new live, cycling' },
        { value: 'first', label: 'Always the first link' },
      ],
    },
  ],
  developerApp: null,
  titleSupport: 'browser',
  chatSupport: 'browser',
  keyPerSession: true,
  experimental: true,
  notes:
    'The account must be allowed to go live from instagram.com on a computer: a public professional account with at least ' +
    '1,000 followers, in good standing. Every live gets a new stream key. The title is set when the live is created and ' +
    "can't be changed during it. Use one Instagram destination per account. When Instagram ends a live (e.g. a copyright " +
    'takedown), a new one is started automatically and gets the next link; viewers have to rejoin it. Test mode always ' +
    "uses the Practice audience (and doesn't move the link rotation). Browser automation may break when Instagram changes its site.",
  testMode: { supported: true, description: 'Practice audience — only you can see it' },
};

const NOT_LOGGED_IN =
  'Not logged in to Instagram yet. Log in in the browser view (including any 2FA or security check), then click "I\'m logged in".';
const SESSION_EXPIRED = 'Instagram session expired — log in again from Accounts';

export interface InstagramDriverOptions {
  /** Default https://www.instagram.com (tests use a local fixture server). */
  baseUrl?: string;
  timeouts?: Partial<FlowTimeouts>;
  chat?: Partial<ChatTimings>;
  health?: Partial<HealthTimings>;
  /** Clock of the health watcher (tests). Default Date.now. */
  now?: () => number;
}

/**
 * The runner gives confirm() 180 s; going live may use most of it, a link added after going live
 * only gets what is left of this (minus a margin).
 */
const CONFIRM_BUDGET_MS = 170_000;
const MIN_LIVE_LINK_MS = 5_000;
const MAX_LIVE_LINK_MS = 30_000;

/** The live that currently owns an account's page. */
interface Owner {
  destinationId: string;
  token: symbol;
}

function keyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function isAbortLike(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && err.name === 'AbortError';
}

/** Playwright/unknown errors → DriverError with a short, URL-free message. */
function toDriverError(err: unknown, what: string, signal?: AbortSignal): unknown {
  if (err instanceof DriverError || isAbortLike(err, signal)) return err;
  return new DriverError(`${what}: ${shortError(err)}`, 'platform-error');
}

export function createInstagramDriver(opts: InstagramDriverOptions = {}): PlatformDriver {
  const baseUrl = (opts.baseUrl ?? IG_ORIGIN).replace(/\/+$/, '');
  const home = `${baseUrl}/`;
  const cfg: FlowConfig = { baseUrl, timeouts: { ...DEFAULT_TIMEOUTS, ...opts.timeouts } };
  const chatTimings: ChatTimings = { ...DEFAULT_CHAT_TIMINGS, ...opts.chat };
  const healthTimings: HealthTimings = { ...DEFAULT_HEALTH_TIMINGS, ...opts.health };
  const now = opts.now ?? Date.now;

  /**
   * accountId → the live using that account's (single) browser page. While set, account checks
   * must not navigate the page and another destination can't use the account. Each prepare() gets
   * a new token, so a late end() of a killed live never touches the page of its replacement.
   */
  const busy = new Map<string, Owner>();
  /** destinationId → rotation index, used when the destination has no secret store. */
  const rotationMemory = new Map<string, number>();
  /** destinationId → hash of the last stream key (a recovery must get a new live, not the killed one). */
  const lastKeys = new Map<string, string>();

  async function saveSession(ctx: DriverContext, accountId: string, log: Logger): Promise<void> {
    try {
      await ctx.browser.save(accountId);
    } catch (err) {
      log.warn({ error: shortError(err) }, 'saving the Instagram browser session failed');
    }
  }

  /** Cookie-only check, for when the page is busy with a live and must not navigate. */
  async function cookieCheck(account: Account, ctx: DriverContext): Promise<boolean> {
    return hasSessionCookie(await ctx.browser.context(account.id), baseUrl);
  }

  async function markNeedsLogin(ctx: DriverContext, message: string): Promise<void> {
    await ctx.updateAccount({ status: 'needs-login', statusMessage: message }).catch(() => {});
  }

  interface LiveParts {
    page: Page;
    account: Account;
    details: StreamDetails;
    options: InstagramOptions;
    username: string | null;
    link: LiveLink;
    /** True while this live still owns the account's page. */
    isCurrent: () => boolean;
    release: () => void;
    ctx: DriverContext;
    log: Logger;
    /** Session test mode (Practice): the chat posts one test comment so the reader can be checked. */
    testMode: boolean;
  }

  /** Add the link right after going live (last chance), within what is left of confirm's budget. */
  async function addLinkAfterGoLive(parts: LiveParts, signal: AbortSignal, confirmStarted: number): Promise<void> {
    const { link, page } = parts;
    if (!link.pending) return;
    const budget = Math.min(MAX_LIVE_LINK_MS, CONFIRM_BUDGET_MS - (Date.now() - confirmStarted));
    if (budget < MIN_LIVE_LINK_MS) {
      link.skip('no time left after going live');
      return;
    }
    const linkSignal = AbortSignal.any([signal, AbortSignal.timeout(budget)]);
    try {
      await link.attempt(page, 'live', linkSignal, {
        findMs: Math.min(cfg.timeouts.linkFind, Math.floor(budget / 3)),
        stepMs: cfg.timeouts.linkStep,
        final: true,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      // Only the link's own time budget ran out. addLiveLink already tried to close the form it
      // opened; try once more so it never stays over "End live video".
      await closeLinkForm(page);
      link.skip('adding it took too long');
    }
  }

  function prepared(parts: LiveParts): PreparedLive {
    const { page, account, details, options, username, link, isCurrent, release, ctx, log, testMode } = parts;
    const marks: LiveMarks = { liveAt: null, sawLive: false };
    // Practice test lives: one test comment per live (only the account sees it), once the reader runs.
    const chatTest = { comment: testMode && options.audience === 'practice' ? TEST_COMMENT : null, posted: false };
    // What the comments reader remembers for this live, kept across restarts of the chat source.
    const chatMemory = newChatMemory();
    let ending: Promise<void> | null = null;
    return {
      push: { url: joinStreamUrl(details.server, details.key), mode: 'copy', feeds: ['vertical'] },
      watchUrl: options.audience === 'public' && username ? `${baseUrl}/${username}/live/` : null,
      ...(options.autoRecover
        ? { recovery: { pushDownConfirmMs: options.takedownConfirmSec * 1000, maxAttempts: MAX_RECOVERY_ATTEMPTS } }
        : {}),

      async confirm(signal) {
        const started = Date.now();
        try {
          await closeLinkForm(page); // a link form left open would take the "Go live" click (no-op otherwise)
          await goLive(page, options.goLiveTimeoutSec * 1000, cfg, signal, log);
        } catch (err) {
          throw toDriverError(err, 'Instagram automation failed', signal); // the runner prefixes "Couldn't go live"
        }
        marks.liveAt = now();
        if (await visibleNow(sel.endLiveButton(page))) marks.sawLive = true;
        log.info({ audience: options.audience }, 'Instagram live started');
        await addLinkAfterGoLive(parts, signal, started);
        await saveSession(ctx, account.id, log);
      },

      end() {
        ending ??= (async () => {
          if (!isCurrent()) {
            // A newer live (e.g. the recovery of this one) owns the page now: don't touch it.
            log.info('Instagram page already used by a newer live; nothing to end');
            return;
          }
          try {
            await closeLinkForm(page); // never leave a link form over "End live video" (no-op otherwise)
            const result = await endLive(page, cfg, isCurrent, log);
            log.info({ result }, 'Instagram live ended');
          } catch (err) {
            log.warn({ error: shortError(err) }, 'ending the Instagram live failed; leaving the live page');
          }
          try {
            // Leaving the producer also abandons a live that was never started.
            if (!page.isClosed() && isCurrent()) {
              await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 8_000 }).catch(() => {});
              await saveSession(ctx, account.id, log);
            }
          } finally {
            release();
          }
        })();
        return ending;
      },

      chat: (signal) => instagramChat(page, signal, log, chatTimings, chatTest, chatMemory),

      health(signal) {
        const monitor = new HealthMonitor({
          audience: options.audience,
          // The 0-viewer rule starts a new live, so it only applies with auto-recover (as on TikTok):
          // without a recovery policy the runner would just end a healthy live.
          zeroViewerSec: options.autoRecover ? options.zeroViewerSec : 0,
          timings: healthTimings,
          startedAt: now(),
          marks,
          extraWarning: () => link.warning,
        });
        const viewers = new ViewerReporter(healthTimings.viewersReportMs, healthTimings.viewersHoldMs);
        return watchHealth(page, signal, { cfg, monitor, viewers, pollMs: healthTimings.pollMs, now, isCurrent, log });
      },
    };
  }

  return {
    info: instagramInfo,

    async startConnect(account): Promise<ConnectStart> {
      if (busy.has(account.id)) {
        // Not 'misconfigured': the UI reads that code as a missing developer app.
        throw new DriverError('This Instagram account is live right now. Stop the live before logging in again.', 'platform-error');
      }
      return {
        method: 'browser',
        startUrl: `${baseUrl}${LOGIN_PATH}`,
        instructions: 'Log in to Instagram in the window below (including 2FA), then click "I\'m logged in".',
      };
    },

    async completeConnect(account, _input, ctx): Promise<ConnectPoll> {
      const log = ctx.log.child({ platform: 'instagram', accountId: account.id });
      try {
        if (busy.has(account.id)) {
          return (await cookieCheck(account, ctx))
            ? { status: 'connected', account: { ...account, status: 'connected', statusMessage: null } }
            : { status: 'error', message: NOT_LOGGED_IN };
        }
        // Clicked "I'm logged in" before the login (or Instagram's check) is finished: still pending.
        const page = await ctx.browser.page(account.id); // the login view's page, as the user left it
        if (!(await hasSessionCookie(page.context(), baseUrl))) return { status: 'pending', message: NOT_LOGGED_IN };
        const checkpoint = checkpointError(page.url());
        if (checkpoint) return { status: 'pending', message: checkpoint.message };

        let path = '';
        try {
          path = new URL(page.url()).pathname;
        } catch {
          // about:blank etc.
        }
        if (!page.url().startsWith(baseUrl) || path !== '/') {
          await page.goto(home, { waitUntil: 'domcontentloaded' });
        }
        if (!(await isLoggedIn(page, cfg, ctx.signal))) return { status: 'pending', message: NOT_LOGGED_IN };
        await dismissInterstitials(page, ctx.signal);

        const username = await readUsername(page);
        const label = username ? `@${username}` : account.label;
        await ctx.updateAccount({ label, status: 'connected', statusMessage: null });
        await saveSession(ctx, account.id, log);
        log.info('Instagram account connected');
        return { status: 'connected', account: { ...account, label, status: 'connected', statusMessage: null } };
      } catch (err) {
        if (isAbortLike(err, ctx.signal)) return { status: 'error', message: 'Checking the Instagram login took too long. Try again.' };
        const e = toDriverError(err, "Couldn't check the Instagram login");
        return { status: 'error', message: e instanceof Error ? e.message : NOT_LOGGED_IN };
      }
    },

    async checkAccount(account, ctx) {
      const log = ctx.log.child({ platform: 'instagram', accountId: account.id });
      if (busy.has(account.id)) {
        // Live right now: don't touch the page.
        return (await cookieCheck(account, ctx)) ? { status: 'connected' } : { status: 'needs-login', message: SESSION_EXPIRED };
      }
      try {
        const page = await ctx.browser.page(account.id, home);
        let loggedIn: boolean;
        try {
          loggedIn = await isLoggedIn(page, cfg, ctx.signal);
        } catch (err) {
          if (err instanceof DriverError && err.code === 'needs-login') return { status: 'needs-login', message: err.message };
          throw err;
        }
        if (!loggedIn) return { status: 'needs-login', message: SESSION_EXPIRED };
        await dismissInterstitials(page, ctx.signal);
        const username = await readUsername(page);
        const label = username ? `@${username}` : undefined;
        await ctx.updateAccount({ ...(label ? { label } : {}), status: 'connected', statusMessage: null });
        await saveSession(ctx, account.id, log);
        return label ? { status: 'connected', label } : { status: 'connected' };
      } catch (err) {
        throw toDriverError(err, "Couldn't check the Instagram account", ctx.signal);
      }
    },

    async validateDestination(dest) {
      const problems = optionProblems(dest);
      if (!dest.accountId) problems.push('Choose the Instagram account to stream to');
      if (dest.feed !== 'vertical') problems.push('Instagram only accepts the vertical feed');
      return problems;
    },

    async prepare(dest, account, title, ctx) {
      if (!account) throw new DriverError('Connect an Instagram account for this destination in Accounts', 'not-connected');
      const owner = busy.get(account.id);
      if (owner && owner.destinationId !== dest.id) {
        throw new DriverError(
          'This Instagram account is already live from another destination. Use one Instagram destination per account.',
          'misconfigured',
        );
      }
      const token = Symbol(dest.id);
      busy.set(account.id, { destinationId: dest.id, token });
      const isCurrent = () => busy.get(account.id)?.token === token;
      const release = () => {
        if (isCurrent()) busy.delete(account.id);
      };

      const log = ctx.log.child({ platform: 'instagram', destinationId: dest.id });
      // Test mode: Practice audience whatever the destination says (also on Stream Guard recoveries,
      // which prepare again with the same context); a test live doesn't move the link rotation.
      const testMode = ctx.testMode === true;
      const options = readLiveOptions(dest, testMode);
      const { signal } = ctx;
      let page: Page | null = null;
      let setupOpened = false;
      try {
        const link = await LiveLink.choose(options.links, options.linkMode, ctx.destinationSecrets, rotationMemory, dest.id, log, {
          advance: !testMode,
        });
        page = await ctx.browser.page(account.id, home);
        const p = page;
        await requireLoggedIn(p, () => isLoggedIn(p, cfg, signal), 'Instagram');
        const username = await readUsername(p);

        // Always a brand-new live (also after a takedown): Create → Live video → new key.
        setupOpened = true;
        await openLiveSetup(p, cfg, signal); // dismisses prompts, the cookie banner and leftover "live ended" dialogs first
        const linkStep = cfg.timeouts.linkStep;
        await fillSetup(p, { title, audience: options.audience }, cfg, signal, log, async () => {
          await link.attempt(p, 'setup', signal, { findMs: 0, stepMs: linkStep, final: false });
          await closeLinkForm(p); // a link form left open would take the "Next" click (no-op otherwise)
        });
        const details = await readStreamDetails(p, cfg, signal);
        const hash = keyHash(details.key);
        if (lastKeys.get(dest.id) === hash) {
          log.warn('Instagram returned the same stream key as the previous live of this destination');
        }
        lastKeys.set(dest.id, hash);
        log.info({ audience: options.audience, testMode }, 'Instagram live created; stream URL and key read');
        await link.attempt(p, 'producer', signal, { findMs: 1_000, stepMs: linkStep, final: false });
        await saveSession(ctx, account.id, log);
        return prepared({ page: p, account, details, options, username, link, isCurrent, release, ctx, log, testMode });
      } catch (err) {
        const ownsPage = isCurrent();
        release();
        if (err instanceof DriverError && err.code === 'needs-login') await markNeedsLogin(ctx, err.message);
        // Don't leave a half-created live behind (leaving the producer abandons it).
        if (ownsPage && setupOpened && page && !page.isClosed()) {
          void page.goto(home, { waitUntil: 'domcontentloaded' }).catch(() => {});
        }
        throw toDriverError(err, 'Instagram automation failed', signal);
      }
    },
  };
}

export const instagramDriver: PlatformDriver = createInstagramDriver();
