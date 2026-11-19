// End-to-end driver tests against a local fake of instagram.com's live flow, in real headless Chromium.

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTimeout } from '../../browser/helpers.js';
import { DriverError, type ChatSourceItem, type PlatformDriver, type PreparedLive } from '../types.js';
import { DEFAULT_TIMEOUTS, endLive, goLive, type FlowConfig } from './flow.js';
import { TEST_COMMENT } from './chat.js';
import { createInstagramDriver } from './index.js';
import {
  FakeBrowserManager,
  FIXTURE_KEY,
  FIXTURE_SERVER_URL,
  FIXTURE_USER,
  makeAccount,
  makeCtx,
  makeDestination,
  startFixtureServer,
  type FixtureConfig,
  type FixtureServer,
} from './test-helpers.js';

const TIMEOUTS = { pageLoad: 8_000, step: 8_000, streamDetails: 8_000, liveConfirm: 8_000, end: 10_000 };

async function next(it: AsyncIterator<ChatSourceItem>, ms = 8_000): Promise<ChatSourceItem> {
  const r = await withTimeout(it.next(), ms, 'no chat message');
  if (r.done) throw new Error('chat ended');
  return r.value;
}

async function waitForEvent(fx: FixtureServer, type: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fx.events.some((e) => e.type === type)) {
    if (Date.now() > deadline) throw new Error(`event ${type} not seen: ${JSON.stringify(fx.events)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!!process.env.CI_NO_BROWSER)('instagram driver (Chromium + local fixture)', () => {
  let browser: Browser;
  let fx: FixtureServer;
  let context: BrowserContext;
  let manager: FakeBrowserManager;
  let driver: PlatformDriver;
  let cfg: FlowConfig;

  beforeAll(async () => {
    fx = await startFixtureServer();
    browser = await chromium.launch({ headless: true });
    driver = createInstagramDriver({ baseUrl: fx.origin, timeouts: TIMEOUTS, chat: { pollMs: 200, tabRetryMs: 2_000 } });
    cfg = { baseUrl: fx.origin, timeouts: { ...DEFAULT_TIMEOUTS, ...TIMEOUTS } };
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await fx?.close();
  });

  async function setup(patch: Partial<FixtureConfig> = {}, cookie = true): Promise<void> {
    await context?.close();
    fx.reset(patch);
    context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } });
    if (cookie) await context.addCookies([{ name: 'sessionid', value: 'test-session', url: fx.origin }]);
    manager = new FakeBrowserManager(context);
  }

  beforeEach(() => setup());
  afterEach(async () => {
    await context?.close();
  });

  async function prepareLive(options: Record<string, unknown> = {}, title = 'My vertical stream'): Promise<PreparedLive> {
    const { ctx } = makeCtx(manager);
    return driver.prepare(makeDestination(options), makeAccount(), title, ctx);
  }

  it('prepare → confirm → chat → end with Practice audience, prompts and cookie banner', async () => {
    await setup({ notificationsPrompt: true, cookieBanner: true, previewDelayMs: 1_500 });
    const title = 'A very long stream title that Instagram will cut short';
    const live = await prepareLive({ audience: 'practice', goLiveTimeoutSec: 30 }, title);

    expect(live.push).toEqual({ url: `${FIXTURE_SERVER_URL}${FIXTURE_KEY}`, mode: 'copy', feeds: ['vertical'] });
    expect(live.watchUrl).toBeNull(); // practice: nothing public to watch
    expect(live.setTitle).toBeUndefined();
    expect(fx.events).toContainEqual({ type: 'cookies-declined' });
    expect(fx.events).not.toContainEqual({ type: 'cookies-allowed' });
    expect(fx.events).toContainEqual({ type: 'notifications-dismissed' });
    expect(fx.events).toContainEqual({ type: 'title', value: title.slice(0, 30) }); // field maxlength = 30
    expect(fx.events).toContainEqual({ type: 'audience', value: 'Practice' });
    expect(fx.events.some((e) => e.type === 'golive')).toBe(false);

    await live.confirm!(new AbortController().signal);
    expect(fx.events).toContainEqual({ type: 'golive' });

    const chatCtl = new AbortController();
    const chat = live.chat!(chatCtl.signal)[Symbol.asyncIterator]();
    const first = next(chat);
    const page = await manager.page('acc-ig');
    await new Promise((r) => setTimeout(r, 600)); // baseline taken
    await page.evaluate(`window.__addComment('alice', 'hello from the fixture 👋')`);
    expect(await first).toMatchObject({ author: { name: 'alice' }, text: 'hello from the fixture 👋', kind: 'message' });
    await page.evaluate(`window.__addJoin('bob')`);
    expect(await next(chat)).toMatchObject({ author: { name: 'bob' }, text: 'bob joined', kind: 'event', join: true });
    await page.evaluate(`window.__addComment('alice', 'hello from the fixture 👋')`); // same text again = new message
    expect(await next(chat)).toMatchObject({ author: { name: 'alice' }, text: 'hello from the fixture 👋' });
    await page.evaluate(`window.__addPlain('carol', 'no avatar here')`); // list item without an avatar
    expect(await next(chat)).toMatchObject({ author: { name: 'carol' }, text: 'no avatar here', kind: 'message' });
    chatCtl.abort();
    expect((await withTimeout(chat.next(), 3_000, 'chat did not end on abort')).done).toBe(true);

    await live.end!();
    expect(fx.events).toContainEqual({ type: 'end' });
    expect(fx.events).toContainEqual({ type: 'done' });
    expect(fx.events).not.toContainEqual({ type: 'share' });
    expect(manager.saves).toBeGreaterThanOrEqual(2);
    await live.end!(); // idempotent
  }, 90_000);

  it('test mode (Practice): posts one test comment in the producer and the chat reads it back', async () => {
    await setup({ previewDelayMs: 300 });
    const { ctx } = makeCtx(manager);
    ctx.testMode = true;
    const live = await driver.prepare(makeDestination({ audience: 'public' }), makeAccount(), 'Rehearsal', ctx);
    await live.confirm!(new AbortController().signal);
    const chatCtl = new AbortController();
    const chat = live.chat!(chatCtl.signal)[Symbol.asyncIterator]();
    expect(await withTimeout(next(chat), 15_000, 'test comment not read')).toMatchObject({ text: TEST_COMMENT, kind: 'message' });
    expect(fx.events.filter((e) => e.type === 'comment-posted')).toEqual([{ type: 'comment-posted', value: TEST_COMMENT }]);
    chatCtl.abort();
    // A restarted chat source doesn't post it again.
    const againCtl = new AbortController();
    const again = live.chat!(againCtl.signal)[Symbol.asyncIterator]();
    const pending = again.next();
    await new Promise((r) => setTimeout(r, 5_500));
    expect(fx.events.filter((e) => e.type === 'comment-posted')).toHaveLength(1);
    againCtl.abort();
    expect((await withTimeout(pending, 5_000, 'chat did not stop')).done).toBe(true);
    await live.end!();
  }, 60_000);

  it('goes live when a layer covers "Go live" (the real click times out; a direct click goes through)', async () => {
    await setup({ goLiveCovered: true, previewDelayMs: 300 });
    const live = await prepareLive({ audience: 'practice', goLiveTimeoutSec: 30 });
    await live.confirm!(new AbortController().signal);
    expect(fx.events).toContainEqual({ type: 'golive' });
    // Still covered: "End live video" must get through too (a live that isn't ended stays up).
    await live.end!();
    expect(fx.events).toContainEqual({ type: 'end' });
  }, 60_000);

  it('public audience: watch URL, select dropdown, masked key in text, "Go live?" step, end without confirm', async () => {
    await setup({ audienceUi: 'select', detailsUi: 'text', goLiveConfirm: true, endConfirm: false, previewDelayMs: 300 });
    const live = await prepareLive({ audience: 'public' });
    expect(live.push?.url).toBe(`${FIXTURE_SERVER_URL}${FIXTURE_KEY}`);
    expect(live.watchUrl).toBe(`${fx.origin}/${FIXTURE_USER}/live/`);
    expect(fx.events).toContainEqual({ type: 'audience', value: 'Public' });
    await live.confirm!(new AbortController().signal);
    expect(fx.events.filter((e) => e.type === 'golive')).toHaveLength(1);
    await live.end!();
    expect(fx.events).toContainEqual({ type: 'end' });
  }, 60_000);

  it('selects Practice in a custom dropdown', async () => {
    await setup({ audienceUi: 'dropdown' });
    const live = await prepareLive({ audience: 'practice' });
    expect(fx.events).toContainEqual({ type: 'audience', value: 'Practice' });
    await live.end!();
  }, 60_000);

  it('selects Practice in an unlabelled "Public ⌄" select (Instagram, Oct 2026)', async () => {
    await setup({ audienceUi: 'bare-select' });
    const live = await prepareLive({ audience: 'practice' });
    expect(fx.events).toContainEqual({ type: 'audience', value: 'Practice' });
    await live.end!();
  }, 60_000);

  it('selects Practice in an unlabelled custom dropdown', async () => {
    await setup({ audienceUi: 'bare-dropdown' });
    const live = await prepareLive({ audience: 'practice' });
    expect(fx.events).toContainEqual({ type: 'audience', value: 'Practice' });
    await live.end!();
  }, 60_000);

  it('refuses to start when Practice cannot be selected', async () => {
    await setup({ audienceUi: 'none' });
    const err = await prepareLive({ audience: 'practice' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('platform-error');
    expect((err as DriverError).message).toMatch(/Practice/);
    expect(fx.events.some((e) => e.type === 'title')).toBe(false); // "Next" never clicked
  }, 60_000);

  it('an empty title that Instagram requires → misconfigured', async () => {
    await setup({ requireTitle: true });
    const quick = createInstagramDriver({ baseUrl: fx.origin, timeouts: { ...TIMEOUTS, step: 2_000 } });
    const { ctx } = makeCtx(manager);
    const err = await quick.prepare(makeDestination(), makeAccount(), '', ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('misconfigured');
    expect((err as DriverError).message).toMatch(/title/);
  }, 30_000);

  it('logged out (no session cookie) → needs-login and the account is flagged', async () => {
    await setup({ loggedIn: false }, false);
    const { ctx, updates } = makeCtx(manager);
    const err = await driver.prepare(makeDestination(), makeAccount(), 'x', ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('needs-login');
    expect(updates).toContainEqual({ status: 'needs-login', statusMessage: (err as DriverError).message });
  }, 30_000);

  it('cookie present but login form shown → needs-login', async () => {
    await setup({ loggedIn: false }, true);
    const err = await prepareLive().catch((e: unknown) => e);
    expect((err as DriverError).code).toBe('needs-login');
  }, 30_000);

  it('no "Live video" in the Create menu → not-eligible', async () => {
    await setup({ eligibility: 'no-live' });
    const err = await prepareLive().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('not-eligible');
    expect((err as DriverError).message).toMatch(/1,000 followers/);
  }, 30_000);

  it('"no longer eligible for Live" notice → not-eligible', async () => {
    await setup({ eligibility: 'notice' });
    const err = await prepareLive().catch((e: unknown) => e);
    expect((err as DriverError).code).toBe('not-eligible');
  }, 30_000);

  it('one live per account: a second destination on the same account is refused until the first ends', async () => {
    const live = await prepareLive();
    const { ctx } = makeCtx(manager);
    const err = await driver.prepare(makeDestination({}, 'dest-2'), makeAccount(), 'x', ctx).catch((e: unknown) => e);
    expect((err as DriverError).code).toBe('misconfigured');
    // While live, an account check must not navigate the page away from the producer.
    const page = await manager.page('acc-ig');
    const before = await page.isVisible('#producer');
    expect(await driver.checkAccount!(makeAccount(), ctx)).toEqual({ status: 'connected' });
    expect(await page.isVisible('#producer')).toBe(before);
    // Logging in again is refused while live, without pointing at a (non-existent) developer app.
    const refused = await driver.startConnect!(makeAccount(), ctx).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DriverError);
    expect((refused as DriverError).code).not.toBe('misconfigured');
    expect((refused as DriverError).message).toMatch(/live right now/);
    await live.end!(); // never went live: leaves the producer
    expect(fx.events.some((e) => e.type === 'end')).toBe(false);
    const again = await driver.prepare(makeDestination({}, 'dest-2'), makeAccount(), 'x', ctx);
    await again.end!();
  }, 60_000);

  it('confirm rejects promptly on abort', async () => {
    await setup({ previewDelayMs: -1 });
    const live = await prepareLive({ goLiveTimeoutSec: 60 });
    const ctl = new AbortController();
    const p = live.confirm!(ctl.signal);
    setTimeout(() => ctl.abort(), 300);
    const t0 = Date.now();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - t0).toBeLessThan(3_000);
    await live.end!();
  }, 60_000);

  it('goLive times out with a clear message when no preview arrives', async () => {
    await setup({ previewDelayMs: -1 });
    const live = await prepareLive();
    const page = await manager.page('acc-ig');
    const err = await goLive(page, 1_500, cfg, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('timeout');
    expect((err as DriverError).message).toBe('Instagram never received the video — check the vertical feed');
    expect(await endLive(page, cfg)).toBe('not-live');
    await live.end!();
  }, 60_000);

  it('goLive reports a missing button as a site change', async () => {
    const page: Page = await manager.page('acc-ig', `${fx.origin}/`);
    const err = await goLive(page, 1_000, cfg, new AbortController().signal).catch((e: unknown) => e);
    expect((err as DriverError).code).toBe('platform-error');
    expect((err as DriverError).message).toMatch(/Go live/);
  }, 30_000);

  it('completeConnect: logged in → connected with @username; session saved', async () => {
    const { ctx, updates } = makeCtx(manager);
    const result = await driver.completeConnect!(makeAccount(), {}, ctx);
    expect(result).toMatchObject({ status: 'connected', account: { label: `@${FIXTURE_USER}`, status: 'connected' } });
    expect(updates).toContainEqual({ label: `@${FIXTURE_USER}`, status: 'connected', statusMessage: null });
    expect(manager.saves).toBe(1);
  }, 30_000);

  it('completeConnect: not logged in yet → pending with a hint, nothing saved', async () => {
    await setup({ loggedIn: false }, false);
    const { ctx, updates } = makeCtx(manager);
    const result = await driver.completeConnect!(makeAccount(), {}, ctx);
    expect(result).toMatchObject({ status: 'pending', message: expect.stringMatching(/Not logged in to Instagram/) });
    expect(updates).toEqual([]);
    expect(manager.saves).toBe(0);
  }, 30_000);

  it('checkAccount: connected with label, or needs-login', async () => {
    const { ctx } = makeCtx(manager);
    expect(await driver.checkAccount!(makeAccount(), ctx)).toEqual({ status: 'connected', label: `@${FIXTURE_USER}` });
    await context.clearCookies();
    expect(await driver.checkAccount!(makeAccount(), ctx)).toMatchObject({ status: 'needs-login' });
  }, 30_000);

  it('startConnect returns the browser login flow', async () => {
    const { ctx } = makeCtx(manager);
    const start = await driver.startConnect!(makeAccount(), ctx);
    expect(start).toEqual({
      method: 'browser',
      startUrl: `${fx.origin}/accounts/login/`,
      instructions: 'Log in to Instagram in the window below (including 2FA), then click "I\'m logged in".',
    });
    expect((await createInstagramDriver().startConnect!(makeAccount(), ctx)) as { startUrl: string }).toMatchObject({
      startUrl: 'https://www.instagram.com/accounts/login/',
    });
  });

  it('prepare without an account → not-connected', async () => {
    const { ctx } = makeCtx(manager);
    const err = await driver.prepare(makeDestination({}, 'd', null), null, 'x', ctx).catch((e: unknown) => e);
    expect((err as DriverError).code).toBe('not-connected');
  });
});
