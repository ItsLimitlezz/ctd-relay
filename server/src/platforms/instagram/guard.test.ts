// Stream Guard port, end to end in real headless Chromium against the local instagram.com fixture:
// takedown detection (health), recovery policy, link rotation, prepare after a takedown.

import pino from 'pino';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LiveHealthEvent, PlatformDriver, PreparedLive } from '../types.js';
import { createInstagramDriver } from './index.js';
import { DEFAULT_TIMEOUTS } from './flow.js';
import { captureEndState, DEFAULT_HEALTH_TIMINGS, HealthMonitor, VIEWERS_UNAVAILABLE_WARNING, watchHealth } from './health.js';
import { sel } from './selectors.js';
import {
  FakeBrowserManager,
  FakeSecrets,
  makeAccount,
  makeCtx,
  makeDestination,
  startFixtureServer,
  type FixtureConfig,
  type FixtureServer,
} from './test-helpers.js';

const TIMEOUTS = { pageLoad: 8_000, step: 8_000, streamDetails: 8_000, liveConfirm: 8_000, end: 10_000, linkFind: 1_500, linkStep: 5_000 };
const HEALTH = { pollMs: 150, setupBackMs: 600, liveLostMs: 3_000, viewerUnavailableMs: 1_000 };

const KICK = { title: 'Kick - Live Stream', url: 'https://kick.com/dprtmnttoronto' };
const TWITCH = { title: 'Twitch - Live Stream', url: 'https://www.twitch.tv/dprtmnttoronto' };
const LINKS = [KICK, TWITCH];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, check: () => boolean, ms = 6_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/**
 * Runs live.health() in the background and records its events: viewer counts in `viewers`,
 * everything else in `events`.
 */
function watch(live: PreparedLive) {
  const ctl = new AbortController();
  const events: LiveHealthEvent[] = [];
  const viewers: (number | null)[] = [];
  let finished = false;
  const done = (async () => {
    for await (const ev of live.health!(ctl.signal)) {
      if (ev.type === 'viewers') viewers.push(ev.count);
      else events.push(ev);
    }
    finished = true;
  })();
  return {
    events,
    viewers,
    get finished() {
      return finished;
    },
    waitFor: (type: Exclude<LiveHealthEvent['type'], 'viewers'>, ms?: number) =>
      until(`health event ${type}`, () => events.some((e) => e.type === type), ms),
    waitForViewers: (count: number | null, ms?: number) => until(`viewers ${count}`, () => viewers.includes(count), ms),
    async stop() {
      ctl.abort();
      await done;
    },
  };
}

describe.skipIf(!!process.env.CI_NO_BROWSER)('instagram stream guard (Chromium + local fixture)', () => {
  let browser: Browser;
  let fx: FixtureServer;
  let context: BrowserContext;
  let manager: FakeBrowserManager;
  let driver: PlatformDriver;
  let clock = 0;

  beforeAll(async () => {
    fx = await startFixtureServer();
    browser = await chromium.launch({ headless: true });
    driver = createInstagramDriver({
      baseUrl: fx.origin,
      timeouts: TIMEOUTS,
      chat: { pollMs: 200, tabRetryMs: 2_000 },
      health: HEALTH,
      now: () => clock,
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await fx?.close();
  });

  async function setup(patch: Partial<FixtureConfig> = {}): Promise<void> {
    await context?.close();
    fx.reset({ previewDelayMs: 300, ...patch });
    context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } });
    await context.addCookies([{ name: 'sessionid', value: 'test-session', url: fx.origin }]);
    manager = new FakeBrowserManager(context);
  }

  beforeEach(async () => {
    clock = 0;
    await setup();
  });
  afterEach(async () => {
    await context?.close();
  });

  function prepare(
    options: Record<string, unknown> = {},
    secrets: FakeSecrets | null = null,
    title = 'Saturday set',
    testMode?: boolean,
  ): Promise<PreparedLive> {
    const { ctx } = makeCtx(manager, new AbortController().signal, secrets);
    if (testMode !== undefined) ctx.testMode = testMode;
    return driver.prepare(makeDestination(options), makeAccount(), title, ctx);
  }

  async function goLive(options: Record<string, unknown> = {}, secrets: FakeSecrets | null = null, testMode?: boolean): Promise<PreparedLive> {
    const live = await prepare(options, secrets, undefined, testMode);
    await live.confirm!(new AbortController().signal);
    return live;
  }

  const page = () => manager.page('acc-ig');
  const linkEvents = () => fx.events.filter((e) => e.type === 'link').map((e) => e.value);

  // ---- recovery policy ----

  it('recovery policy follows autoRecover / takedownConfirmSec', async () => {
    const on = await prepare();
    expect(on.recovery).toEqual({ pushDownConfirmMs: 5_000, maxAttempts: 3 });
    expect(typeof on.health).toBe('function');
    await on.end!();
    const custom = await prepare({ takedownConfirmSec: 12 });
    expect(custom.recovery).toEqual({ pushDownConfirmMs: 12_000, maxAttempts: 3 });
    await custom.end!();
    const off = await prepare({ autoRecover: false });
    expect(off.recovery).toBeUndefined();
    await off.end!();
  }, 60_000);

  // ---- health ----

  it('takedown notice → ended with its text; end() then just closes it (no Share) and the next prepare works', async () => {
    const live = await goLive();
    const health = watch(live);
    await sleep(500);
    expect(health.events).toEqual([]); // live and fine
    await (await page()).evaluate(`window.__takedown('Your live video was removed', 'It may go against our Community Guidelines on music.')`);
    await health.waitFor('ended', 3_000);
    expect(health.events).toEqual([
      { type: 'ended', reason: 'Your live video was removed It may go against our Community Guidelines on music.' },
    ]);
    await sleep(400);
    expect(health.finished).toBe(false); // stays quiet until stopped
    await health.stop();

    await live.end!(); // harmless: no throw, dialog closed without sharing
    expect(fx.events).toContainEqual({ type: 'takedown-dismissed' });
    expect(fx.events).not.toContainEqual({ type: 'share' });
    expect(fx.events.some((e) => e.type === 'end')).toBe(false); // nothing left to end

    // Recovery: a brand-new live on a page that greets us with a leftover "removed" dialog.
    fx.config.leftover = 'ended';
    const again = await prepare();
    expect(fx.events).toContainEqual({ type: 'leftover-dismissed' });
    expect(fx.events).not.toContainEqual({ type: 'share' });
    expect(fx.events.filter((e) => e.type === 'title')).toHaveLength(2); // a second live was created
    await again.confirm!(new AbortController().signal);
    expect(fx.events.filter((e) => e.type === 'golive')).toHaveLength(2);
    await again.end!();
    expect(fx.events).toContainEqual({ type: 'end' });
  }, 90_000);

  it('when Instagram ends the live, the log has the whole notice and the state of the page; an unknown dialog is logged once', async () => {
    const live = await goLive();
    const p = await page();
    const lines: Record<string, unknown>[] = [];
    const log = pino({ level: 'info' }, { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) });
    const marks = { liveAt: 0, sawLive: false };
    const monitor = new HealthMonitor({ audience: 'public', zeroViewerSec: 0, timings: { ...DEFAULT_HEALTH_TIMINGS, ...HEALTH }, startedAt: 0, marks });
    const ctl = new AbortController();
    const events: LiveHealthEvent[] = [];
    const done = (async () => {
      for await (const ev of watchHealth(p, ctl.signal, { cfg: { baseUrl: fx.origin, timeouts: DEFAULT_TIMEOUTS }, monitor, pollMs: 150, now: () => clock, isCurrent: () => true, log })) events.push(ev);
    })();
    const logged = (msg: RegExp) => lines.filter((l) => msg.test(String(l.msg)));
    try {
      // Comments that read like notices, and dialogs that could carry names, never reach the log.
      await p.evaluate(`(() => {
        window.__addComment('fixture_viewer', 'your live video has ended lol');
        const add = (id, html) => { const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.id = id; d.innerHTML = html; document.body.appendChild(d); };
        add('named', '<img alt="fixture_viewer\\'s profile picture" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="><p>fixture_viewer wants to join</p><button>Accept</button>');
        add('linked', '<p>Read <a href="/fixture_viewer/">this</a> first</p><button>OK then</button>');
        add('prompt', '<h3>Made-up prompt nobody has seen</h3><p>Do you want to keep going?</p><button>Keep going</button><div role="button">Stop</div>');
      })()`);
      await until('the unknown dialog in the log', () => logged(/dialog the health watcher does not know/).length > 0);
      await sleep(600); // several more reads
      expect(logged(/dialog the health watcher does not know/)).toEqual([
        expect.objectContaining({ text: 'Made-up prompt nobody has seen Do you want to keep going?', buttons: ['Keep going', 'Stop'], liveForSec: 0 }),
      ]);
      expect(events).toEqual([]); // an unknown dialog ends nothing, and nothing was clicked
      expect(await p.locator('#prompt').count()).toBe(1);
      await p.evaluate(`for (const id of ['named', 'linked', 'prompt']) document.getElementById(id).remove()`);

      clock = 70 * 60_000 + 46_000;
      const long = 'It was ended for a made-up reason. ' + 'More detail about that reason. '.repeat(8).trim();
      await p.evaluate(`window.__takedown('Live video ended', ${JSON.stringify(long)})`);
      await until('the ended event', () => events.some((e) => e.type === 'ended'));
      expect(events).toEqual([{ type: 'ended', reason: `${`Live video ended ${long}`.slice(0, 157)}…` }]); // the event keeps its short reason
      const [line] = logged(/^Instagram ended the live$/);
      expect(line).toMatchObject({
        level: 40,
        rule: 'notice',
        liveForSec: 70 * 60 + 46,
        endButton: false,
        page: {
          notices: [{ role: 'dialog', text: `Live video ended ${long}`, length: `Live video ended ${long}`.length, buttons: ['Share', 'Done'] }],
          visibility: 'visible',
          focused: true,
          online: true,
          pathDepth: expect.any(Number),
        },
      });
      const json = JSON.stringify(lines);
      expect(json).not.toContain('fixture_viewer');
      expect(json).not.toContain('lol');
      expect(json).not.toMatch(/https?:\/\/|sessionid|test-session/);
      // The capture is a read: the notice is still there for end() to close.
      expect(fx.events).not.toContainEqual({ type: 'takedown-dismissed' });
      expect(await captureEndState(p)).toMatchObject({ notices: [{ role: 'dialog' }] });
    } finally {
      ctl.abort();
      await done;
    }
    await live.end!();
    expect(fx.events).not.toContainEqual({ type: 'share' });
  }, 60_000);

  it('a "share your live?" leftover is closed with "Don\'t share" before the new live', async () => {
    await setup({ leftover: 'share' });
    const live = await prepare();
    expect(fx.events).toContainEqual({ type: 'leftover-dismissed' });
    expect(fx.events).not.toContainEqual({ type: 'share' });
    expect(live.push?.url).toMatch(/^rtmps:/);
    await live.end!();
  }, 60_000);

  it('a policy notice without "ended"/"removed" wording → ended; end() and the next prepare both close it', async () => {
    const live = await goLive();
    const health = watch(live);
    await (await page()).evaluate(
      `window.__takedown('Live video interrupted', 'Your live video was interrupted because it may include music that belongs to someone else')`,
    );
    await health.waitFor('ended', 3_000);
    expect(health.events).toEqual([
      {
        type: 'ended',
        reason: 'Live video interrupted Your live video was interrupted because it may include music that belongs to someone else',
      },
    ]);
    await health.stop();

    await live.end!();
    expect(fx.events).toContainEqual({ type: 'takedown-dismissed' });
    expect(fx.events).not.toContainEqual({ type: 'share' });

    // Instagram greets the recovery with the same notice: it's closed and a new live is created.
    fx.config.leftover = 'policy';
    const again = await prepare();
    expect(fx.events).toContainEqual({ type: 'leftover-dismissed' });
    expect(fx.events).not.toContainEqual({ type: 'share' });
    expect(fx.events.filter((e) => e.type === 'title')).toHaveLength(2);
    await again.end!();
  }, 90_000);

  it('leftover dismissal never targets a form or the producer that mentions policy wording', async () => {
    const p = await context.newPage();
    const cases: [string, number][] = [
      ['<div role="dialog"><h2>Live video interrupted</h2><p>It may include music that belongs to someone else.</p><button>Share</button><button>Done</button></div>', 1],
      ['<div role="alertdialog"><h2>Live stopped: copyright claim</h2><button>OK</button></div>', 1],
      // The setup form: an input, "Go live" and a guidelines reminder.
      ['<div role="dialog" aria-label="Go live"><h2>Go live</h2><input placeholder="Add a title"><p>Follow our Community Guidelines.</p><button>Close</button><button>Next</button></div>', 0],
      // The producer: "End live video" and a viewer comment saying "copyright".
      ['<div role="dialog" aria-label="Live producer"><button>End live video</button><button>Close</button><div role="tabpanel"><div>troll: copyright!</div></div></div>', 0],
      // A transient notice (a warning for the health watcher, not an end).
      ['<div role="dialog"><p>Your live video was interrupted. Reconnecting…</p><button>OK</button></div>', 0],
    ];
    for (const [html, expected] of cases) {
      await p.setContent(html);
      expect([html, await sel.leftoverDismiss(p).count()]).toEqual([html, expected]);
    }
    await p.close();
  }, 30_000);

  it('producer drops back to its setup state → ended', async () => {
    const live = await goLive();
    const health = watch(live);
    await sleep(400);
    await (await page()).evaluate('window.__dropLive()');
    await sleep(400);
    expect(health.events).toEqual([]); // not before setupBackMs (fake clock still at 0)
    clock = 1_000;
    await health.waitFor('ended', 4_000);
    expect(health.events).toEqual([{ type: 'ended', reason: 'the Instagram producer is back at the setup screen' }]);
    await health.stop();
    await live.end!();
  }, 60_000);

  it('soft Instagram notice → warning, ok when it clears', async () => {
    const live = await goLive();
    const health = watch(live);
    const warning = "Your live video will be removed soon if you continue to broadcast music you don't have permission to use";
    await (await page()).evaluate(`window.__warn(${JSON.stringify(warning)})`);
    await health.waitFor('warning', 3_000);
    expect(health.events).toEqual([{ type: 'warning', message: `Instagram: "${warning}"` }]);
    await (await page()).evaluate(`window.__warn('')`);
    await health.waitFor('ok', 3_000);
    expect(health.events.some((e) => e.type === 'ended')).toBe(false);
    await health.stop();
    await live.end!();
  }, 60_000);

  it('Public + zeroViewerSec=5: 0 viewers ends the live only after the 60 s grace', async () => {
    await setup({ viewerUi: 'icon', viewers: 0 });
    const live = await goLive({ audience: 'public', zeroViewerSec: 5 }); // went live at clock 0
    const health = watch(live);
    clock = 30_000; // in the grace, 0 viewers for 30 s
    await sleep(600);
    clock = 59_000;
    await sleep(600);
    expect(health.events).toEqual([]);
    clock = 61_000; // grace over: the 5 s count starts
    await sleep(600);
    clock = 64_000;
    await sleep(600);
    expect(health.events).toEqual([]);
    clock = 67_000;
    await health.waitFor('ended', 3_000);
    expect(health.events).toEqual([{ type: 'ended', reason: '0 viewers for 5 s' }]);
    await health.stop();
    await live.end!();
  }, 60_000);

  it('zeroViewerSec without auto-recover: the 0-viewer rule never ends the live', async () => {
    await setup({ viewerUi: 'icon', viewers: 0 });
    const live = await goLive({ audience: 'public', zeroViewerSec: 5, autoRecover: false });
    expect(live.recovery).toBeUndefined();
    const health = watch(live);
    for (const t of [61_000, 67_000, 120_000, 600_000]) {
      clock = t;
      await sleep(400);
    }
    expect(health.events).toEqual([]); // no 'ended', no viewer warning
    await health.stop();
    await live.end!();
    expect(fx.events).toContainEqual({ type: 'end' });
  }, 60_000);

  it('viewers present ("N viewers" text) → no end; a viewer leaving starts the count', async () => {
    await setup({ viewerUi: 'text', viewers: 7 });
    const live = await goLive({ audience: 'public', zeroViewerSec: 5 });
    const health = watch(live);
    clock = 100_000;
    await sleep(500);
    clock = 200_000;
    await sleep(500);
    expect(health.events).toEqual([]);
    await (await page()).evaluate('window.__setViewers(0)');
    await sleep(500);
    clock = 206_000;
    await health.waitFor('ended', 3_000);
    expect(health.events).toEqual([{ type: 'ended', reason: '0 viewers for 5 s' }]);
    await health.stop();
    await live.end!();
  }, 60_000);

  it('Practice never fires the viewer rule', async () => {
    await setup({ viewerUi: 'icon', viewers: 0 });
    const live = await goLive({ audience: 'practice', zeroViewerSec: 5 });
    const health = watch(live);
    for (const t of [61_000, 120_000, 600_000]) {
      clock = t;
      await sleep(400);
    }
    expect(health.events).toEqual([]);
    await health.stop();
    await live.end!();
  }, 60_000);

  it('unreadable count never fires (comments saying "0 viewers" / "live ended" are ignored); one warning instead', async () => {
    await setup({ viewerUi: 'none' });
    const live = await goLive({ audience: 'public', zeroViewerSec: 5 });
    const p = await page();
    await p.click('#tabComments');
    await p.evaluate(`window.__addComment('troll', '0 viewers')`);
    await p.evaluate(`window.__addComment('troll', 'Your live video has ended')`);
    await p.evaluate(`window.__addPlain('troll2', 'Your live video was removed for copyright')`);
    const health = watch(live);
    clock = 61_000;
    await sleep(500);
    clock = 70_000;
    await health.waitFor('warning', 3_000);
    clock = 300_000;
    await sleep(500);
    expect(health.events).toEqual([{ type: 'warning', message: VIEWERS_UNAVAILABLE_WARNING }]);
    await health.stop();
    await live.end!();
  }, 60_000);

  it('logged out during the live → warning, not ended', async () => {
    const live = await goLive();
    const health = watch(live);
    await sleep(300);
    await context.clearCookies();
    await health.waitFor('warning', 3_000);
    expect(health.events[0]).toMatchObject({ type: 'warning', message: expect.stringMatching(/session expired/) });
    await (await page()).evaluate('window.__dropLive()');
    await sleep(500);
    clock = 100_000; // well past setupBackMs / liveLostMs
    await sleep(1_000);
    expect(health.events.some((e) => e.type === 'ended')).toBe(false);
    await health.stop();
    await live.end!();
  }, 60_000);

  it("a late end() of a replaced live never touches the replacement's page", async () => {
    const killed = await prepare();
    const replacement = await prepare(); // same destination (a recovery whose old end() timed out)
    const p = await page();
    await killed.end!();
    expect(await p.isVisible('#producer')).toBe(true); // still the replacement's producer
    await replacement.confirm!(new AbortController().signal);
    await killed.end!(); // idempotent, still nothing
    expect(fx.events.some((e) => e.type === 'end')).toBe(false);
    await replacement.end!();
    expect(fx.events).toContainEqual({ type: 'end' });
  }, 60_000);

  // ---- links ----

  it('rotate: each new live gets the next link, cycling; position kept in destinationSecrets', async () => {
    await setup({ linkUi: 'producer' });
    const secrets = new FakeSecrets();
    for (const expected of [KICK, TWITCH, KICK]) {
      const live = await prepare({ links: LINKS, linkMode: 'rotate' }, secrets);
      expect(linkEvents().at(-1)).toBe(`${expected.title}|${expected.url}`);
      await live.end!();
    }
    expect(linkEvents()).toHaveLength(3);
    expect(await secrets.getJson('linkRotation')).toEqual({ index: 1 });
    // Stream Guard's links.json "index": 1 → the next live gets the second link.
    const live = await prepare({ links: LINKS }, secrets);
    expect(linkEvents().at(-1)).toBe(`${TWITCH.title}|${TWITCH.url}`);
    await live.end!();
  }, 120_000);

  it('rotate without a secret store still rotates (in memory)', async () => {
    await setup({ linkUi: 'producer' });
    const first = await prepare({ links: LINKS });
    await first.end!();
    const second = await prepare({ links: LINKS });
    await second.end!();
    expect(linkEvents()).toEqual([`${KICK.title}|${KICK.url}`, `${TWITCH.title}|${TWITCH.url}`]);
  }, 60_000);

  it('Instagram\'s link-type chooser first (Oct 2026): picks "Link / Add a URL", confirms, then fills the URL form', async () => {
    await setup({ linkUi: 'producer', linkChooser: true });
    const secrets = new FakeSecrets();
    const live = await prepare({ links: LINKS }, secrets);
    expect(fx.events).toContainEqual({ type: 'link-type', value: 'external' });
    expect(fx.events).not.toContainEqual({ type: 'link-type', value: 'whatsapp' });
    expect(linkEvents()).toEqual([`${KICK.title}|${KICK.url}`]);
    expect(await (await page()).isVisible('#linkChooser')).toBe(false);
    expect(await secrets.getJson('linkRotation')).toEqual({ index: 1 });
    await live.end!();
  }, 60_000);

  it('first: always the first link; the setup form is used when it offers "Add link"', async () => {
    await setup({ linkUi: 'setup' });
    const secrets = new FakeSecrets();
    for (let i = 0; i < 2; i++) {
      const live = await prepare({ links: LINKS, linkMode: 'first' }, secrets);
      await live.end!();
    }
    expect(linkEvents()).toEqual([`${KICK.title}|${KICK.url}`, `${KICK.title}|${KICK.url}`]);
    expect(await secrets.getJson('linkRotation')).toBeNull();
    // The link was added before "Next" (the live's own title is untouched).
    const firstLink = fx.events.findIndex((e) => e.type === 'link');
    const firstTitle = fx.events.findIndex((e) => e.type === 'title');
    expect(firstLink).toBeLessThan(firstTitle);
    expect(fx.events.find((e) => e.type === 'title')?.value).toBe('Saturday set');
  }, 60_000);

  it('off or an empty list: no link is added', async () => {
    await setup({ linkUi: 'producer' });
    const off = await prepare({ links: LINKS, linkMode: 'off' });
    await off.end!();
    const empty = await prepare({ links: [], linkMode: 'rotate' });
    await empty.end!();
    expect(fx.events.some((e) => e.type === 'link-opened')).toBe(false);
  }, 60_000);

  it('only offered once live: added right after going live, the link title cut to the field', async () => {
    await setup({ linkUi: 'live', linkTitleMax: 10 });
    const secrets = new FakeSecrets();
    const live = await prepare({ links: LINKS }, secrets);
    expect(linkEvents()).toEqual([]);
    expect(await secrets.getJson('linkRotation')).toBeNull();
    await live.confirm!(new AbortController().signal);
    expect(linkEvents()).toEqual([`Kick - Liv|${KICK.url}`]);
    expect(await secrets.getJson('linkRotation')).toEqual({ index: 1 });
    const health = watch(live);
    await sleep(400);
    expect(health.events).toEqual([]); // no link warning
    await health.stop();
    await live.end!();
  }, 60_000);

  it('Instagram refuses the link: the live still starts, the index is kept, health warns', async () => {
    await setup({ linkUi: 'producer', linkFails: true });
    const secrets = new FakeSecrets();
    await secrets.setJson('linkRotation', { index: 1 });
    const live = await goLive({ links: LINKS }, secrets);
    expect(fx.events).toContainEqual({ type: 'link-refused' });
    expect(fx.events).toContainEqual({ type: 'golive' });
    expect(linkEvents()).toEqual([]);
    expect(await secrets.getJson('linkRotation')).toEqual({ index: 1 });
    expect(await (await page()).isVisible('#linkDialog')).toBe(false); // form closed again
    const health = watch(live);
    await health.waitFor('warning', 2_000);
    expect(health.events[0]).toMatchObject({
      type: 'warning',
      message: expect.stringMatching(/^Couldn't add the link "Twitch - Live Stream" to the Instagram live: Instagram said: Couldn't add link/),
    });
    await health.stop();
    await live.end!();
  }, 60_000);

  for (const linkUi of ['setup', 'producer'] as const) {
    it(`a link form whose URL field isn't recognized (${linkUi}) is closed: the live still starts, the index is kept`, async () => {
      await setup({ linkUi, linkUrlUnlabelled: true });
      const secrets = new FakeSecrets();
      const live = await prepare({ links: LINKS }, secrets);
      const p = await page();
      expect(fx.events).toContainEqual({ type: 'link-opened' });
      expect(fx.events).toContainEqual({ type: 'link-cancelled' }); // its own Cancel, no Escape needed
      expect(fx.events).not.toContainEqual({ type: 'key-escape' });
      expect(await p.isVisible('#linkDialog')).toBe(false);
      await live.confirm!(new AbortController().signal);
      expect(fx.events).toContainEqual({ type: 'golive' });
      expect(linkEvents()).toEqual([]);
      expect(await secrets.getJson('linkRotation')).toBeNull();
      const health = watch(live);
      await health.waitFor('warning', 2_000);
      expect(health.events[0]).toMatchObject({ type: 'warning', message: expect.stringMatching(/link form has no URL field/) });
      await health.stop();
      await live.end!();
      expect(fx.events).toContainEqual({ type: 'end' });
    }, 60_000);
  }

  it('an "Add link" control that opens nothing leaves the setup form alone (no Escape)', async () => {
    await setup({ linkUi: 'setup', linkDead: true });
    const secrets = new FakeSecrets();
    const live = await prepare({ links: LINKS }, secrets);
    expect(fx.events).toContainEqual({ type: 'link-dead' });
    expect(fx.events).not.toContainEqual({ type: 'link-opened' });
    expect(fx.events).not.toContainEqual({ type: 'key-escape' });
    expect(fx.events.find((e) => e.type === 'title')?.value).toBe('Saturday set'); // "Next" was clicked
    expect(await secrets.getJson('linkRotation')).toBeNull();
    await live.confirm!(new AbortController().signal);
    expect(fx.events).toContainEqual({ type: 'golive' });
    await live.end!();
  }, 60_000);

  it('a link form that stays open after "Add" (address already in the title) is closed and counts as failed', async () => {
    await setup({ linkUi: 'producer', linkSticky: 'silent' });
    const secrets = new FakeSecrets();
    const { ctx } = makeCtx(manager, new AbortController().signal, secrets);
    const live = await driver.prepare(makeDestination({ links: LINKS }), makeAccount(), 'Set kick.com/dprtmnttoronto', ctx);
    expect(fx.events).toContainEqual({ type: 'link-sticky' });
    expect(fx.events).toContainEqual({ type: 'link-cancelled' });
    expect(await (await page()).isVisible('#linkDialog')).toBe(false);
    expect(await secrets.getJson('linkRotation')).toBeNull();
    await live.confirm!(new AbortController().signal);
    expect(fx.events).toContainEqual({ type: 'golive' });
    const health = watch(live);
    await health.waitFor('warning', 2_000);
    expect(health.events[0]).toMatchObject({ type: 'warning', message: expect.stringMatching(/link form stayed open/) });
    await health.stop();
    await live.end!();
  }, 60_000);

  it('a link form that stays open after the link shows up on the producer is closed, then the link counts', async () => {
    await setup({ linkUi: 'producer', linkSticky: 'shown' });
    const secrets = new FakeSecrets();
    const live = await prepare({ links: LINKS }, secrets);
    expect(linkEvents()).toEqual([`${KICK.title}|${KICK.url}`]);
    expect(fx.events).toContainEqual({ type: 'link-cancelled' });
    expect(await (await page()).isVisible('#linkDialog')).toBe(false);
    expect(await secrets.getJson('linkRotation')).toEqual({ index: 1 });
    await live.confirm!(new AbortController().signal);
    expect(fx.events).toContainEqual({ type: 'golive' });
    const health = watch(live);
    await sleep(400);
    expect(health.events).toEqual([]); // no link warning
    await health.stop();
    await live.end!();
  }, 60_000);

  // ---- viewers ----

  it('reports the viewer count: at once, on every change, again after 30 s, null once unreadable', async () => {
    await setup({ viewerUi: 'icon', viewers: 7 });
    const live = await goLive({ audience: 'public' }); // 0-viewer rule off: viewers are still reported
    const health = watch(live);
    await health.waitForViewers(7, 3_000);
    const p = await page();
    await p.evaluate('window.__setViewers(9)');
    await health.waitForViewers(9, 3_000);
    await sleep(500);
    expect(health.viewers).toEqual([7, 9]); // unchanged count: not repeated within 30 s
    clock = 31_000;
    await until('the count to be repeated', () => health.viewers.length >= 3, 3_000);
    expect(health.viewers).toEqual([7, 9, 9]);
    await p.evaluate('window.__setViewers(null)'); // count hidden
    await sleep(500);
    expect(health.viewers).toEqual([7, 9, 9]); // a short gap keeps the last count
    clock = 40_000;
    await health.waitForViewers(null, 3_000);
    expect(health.viewers).toEqual([7, 9, 9, null]);
    expect(health.events).toEqual([]);
    await health.stop();
    await live.end!();
  }, 60_000);

  it('no readable count → viewers null (never a made-up 0)', async () => {
    await setup({ viewerUi: 'none' });
    const live = await goLive();
    const health = watch(live);
    await health.waitForViewers(null, 3_000);
    expect(health.viewers).toEqual([null]);
    await health.stop();
    await live.end!();
  }, 60_000);

  // ---- test mode ----

  it('test mode: Practice whatever the audience option says, no watch URL, no 0-viewer rule, viewers still reported', async () => {
    await setup({ viewerUi: 'icon', viewers: 0 });
    const live = await goLive({ audience: 'public', zeroViewerSec: 5 }, null, true);
    expect(fx.events).toContainEqual({ type: 'audience', value: 'Practice' });
    expect(fx.events).not.toContainEqual({ type: 'audience', value: 'Public' });
    expect(live.watchUrl).toBeNull();
    expect(live.recovery).toEqual({ pushDownConfirmMs: 5_000, maxAttempts: 3 }); // Stream Guard still recovers
    const health = watch(live);
    for (const t of [61_000, 67_000, 120_000]) {
      clock = t;
      await sleep(400);
    }
    expect(health.events).toEqual([]); // Practice: never ended for 0 viewers
    expect(health.viewers[0]).toBe(0);
    await health.stop();
    await live.end!();
    expect(fx.events).toContainEqual({ type: 'end' });
  }, 60_000);

  it('test mode: recoveries stay Practice and the link rotation is not moved', async () => {
    await setup({ linkUi: 'producer' });
    const secrets = new FakeSecrets();
    await secrets.setJson('linkRotation', { index: 1 });
    const audiences = () => fx.events.filter((e) => e.type === 'audience').map((e) => e.value);
    for (let i = 0; i < 2; i++) {
      // The second prepare is what a Stream Guard recovery does (same destination, same context).
      const live = await prepare({ audience: 'public', links: LINKS }, secrets, undefined, true);
      expect(linkEvents().at(-1)).toBe(`${TWITCH.title}|${TWITCH.url}`); // the link is still added
      await live.end!();
    }
    expect(audiences()).toEqual(['Practice', 'Practice']);
    expect(await secrets.getJson('linkRotation')).toEqual({ index: 1 }); // the saved position is untouched
    // Back to normal: Public, the same link, and now the rotation moves on.
    const live = await prepare({ audience: 'public', links: LINKS }, secrets, undefined, false);
    expect(audiences().at(-1)).toBe('Public');
    expect(linkEvents().at(-1)).toBe(`${TWITCH.title}|${TWITCH.url}`);
    expect(await secrets.getJson('linkRotation')).toEqual({ index: 2 });
    await live.end!();
  }, 120_000);

  it('no "Add link" anywhere: the live starts, the index is kept, health warns', async () => {
    const secrets = new FakeSecrets();
    const live = await goLive({ links: LINKS }, secrets);
    expect(fx.events).toContainEqual({ type: 'golive' });
    expect(await secrets.getJson('linkRotation')).toBeNull();
    const health = watch(live);
    await health.waitFor('warning', 2_000);
    expect(health.events[0]).toMatchObject({ type: 'warning', message: expect.stringMatching(/no "Add link" option found/) });
    await health.stop();
    await live.end!();
  }, 60_000);
});
