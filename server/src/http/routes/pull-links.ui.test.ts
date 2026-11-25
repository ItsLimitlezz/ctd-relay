// Playwright UI test for pull links (docs/GUEST-FEEDS.md → Pull link): the real Guest feeds card
// (React, bundled with esbuild from web/src) against the real web routes and PullLinks service (a fake
// MediaMTX connection list), in Chromium. Skipped with CI_NO_BROWSER=1.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '../../../../shared/types.js';
import { bindGuestFeeds } from '../../api/guest-feeds.js';
import { bindPullLinks } from '../../api/pull-links.js';
import { openDatabase } from '../../db/database.js';
import { createGuestFeedsRepo } from '../../db/guest-feeds-repo.js';
import { createGuestRoutesRepo } from '../../db/guest-routes-repo.js';
import { createRepos } from '../../db/repos.js';
import { EventBus } from '../../events.js';
import { DEFAULT_GUEST_LIMITS, GuestFeeds } from '../../media/guest-feeds.js';
import { bindGuestRoutes, GuestRoutes } from '../../media/guest-routes.js';
import { PullLinks, type RtmpConn } from '../../media/pull-links.js';
import { fakeSpawn } from '../../media/test-helpers.js';
import { createSecretBox } from '../../security/secretbox.js';
import type { AppServices, MediaServer } from '../../services.js';
import guestFeedRoutes from './guest-feeds.js';
import guestRouteRoutes from './guest-routes.js';
import pullLinkRoutes from './pull-links.js';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const admin: User = { id: 'u1', username: 'admin', role: 'admin', totpEnabled: false, createdAt: '', lastLoginAt: null };

const ENTRY = `
import { createRoot } from 'react-dom/client';
import { GuestFeedsCard } from './components/GuestFeedsCard';
import { ToastProvider } from './components/Toast';

createRoot(document.getElementById('root')).render(
  <ToastProvider>
    <GuestFeedsCard profileId="default" isAdmin />
  </ToastProvider>,
);
`;

async function bundle(): Promise<string> {
  const out = await build({
    stdin: { contents: ENTRY, resolveDir: path.join(ROOT, 'web/src'), loader: 'tsx', sourcefile: 'pull-links-ui-entry.tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    platform: 'browser',
    logLevel: 'silent',
    alias: { '@shared': path.join(ROOT, 'shared') },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    plugins: [
      {
        // The live WebSocket store needs the whole app shell; routes are polled over HTTP anyway.
        name: 'stub-live',
        setup(b) {
          b.onResolve({ filter: /\/state\/live$/ }, () => ({ path: 'live-stub', namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, async () => {
            // Every export of the real module as a no-op (only the card's useLiveEvent is called here).
            const real = await fs.readFile(path.join(ROOT, 'web/src/state/live.tsx'), 'utf8');
            const names = [...real.matchAll(/^export (?:function|const|class) (\w+)/gm)].map((m) => m[1]);
            return { contents: names.map((n) => `export function ${n}() { return undefined; }`).join('\n'), loader: 'js' };
          });
        },
      },
    ],
  });
  return out.outputFiles[0]!.text;
}

describe.skipIf(!!process.env.CI_NO_BROWSER)('pull link UI (Chromium)', () => {
  let app: FastifyInstance;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let base: string;
  let pull: PullLinks;
  let slot: string;
  let conns: RtmpConn[] = [];
  const kicked: string[] = [];

  beforeAll(async () => {
    const js = await bundle();
    const db = openDatabase(':memory:');
    const repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
    const bus = new EventBus();
    const log = pino({ level: 'silent' });
    const guests = new GuestFeeds({ repo: createGuestFeedsRepo(db), secrets: repos.secrets, bus, log, limits: DEFAULT_GUEST_LIMITS });
    guests.attachMedia({ kick: async () => true });
    const routes = new GuestRoutes({
      config: { rtmpPort: 1935, ffmpegBin: 'ffmpeg' },
      repo: createGuestRoutesRepo(db),
      guests,
      secrets: repos.secrets,
      settings: repos.settings,
      profiles: repos.profiles,
      bus,
      log,
      lookup: async () => ['203.0.113.9'],
      localAddresses: () => ['127.0.0.1'],
      supervisorDeps: { spawn: fakeSpawn().spawn },
    });
    routes.attachMedia({ guestReadUrl: (s: string) => `rtmp://127.0.0.1:1935/guest/${s}`, feed: () => ({ online: false }) } as unknown as MediaServer);
    pull = new PullLinks({ secrets: repos.secrets, log, maxReaders: 2, guestProfileOf: (s) => guests.profileOf(s), slugOf: () => null, profileOfSlug: () => 'default' });
    await pull.load();
    pull.attachMedia({
      listConns: async () => conns,
      kickConn: async (id) => {
        kicked.push(id);
        conns = conns.filter((c) => c.id !== id);
        return true;
      },
    });
    const services = {
      config: { rtmpPort: 1935, ffmpegBin: 'ffmpeg' },
      log,
      media: {},
      repos: { ...repos, audit: { log: () => undefined } },
      appSettings: () => ({ publicBaseUrl: '', ingestHost: 'relay.example.com', disconnectGraceSec: 15 }),
    } as unknown as AppServices;
    bindGuestFeeds(services, guests);
    bindGuestRoutes(services, routes);
    bindPullLinks(services, pull);
    slot = (await guests.create('default', 'MacBook')).slot;

    app = Fastify();
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (req) => {
      req.user = admin;
    });
    await app.register(guestFeedRoutes, { services });
    await app.register(guestRouteRoutes, { services });
    await app.register(pullLinkRoutes, { services });
    app.get('/api/profiles', async () => ({ profiles: [{ id: 'default', name: 'Main' }] }));
    app.get('/app.js', async (_req, reply) => reply.type('text/javascript').send(js));
    app.get('/', async (_req, reply) => reply.type('text/html').send('<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>'));
    base = await app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch();
    context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    page = await context.newPage();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
  });

  it('switch on, copy the link, see readers, rotate (disconnects them), switch off', async () => {
    await page.goto(base);
    const panel = page.getByRole('group', { name: 'Pull link for extra feed "MacBook"' });
    await panel.waitFor();
    await panel.getByText('Pull link (OBS, VLC)').waitFor();
    const toggle = panel.getByRole('switch', { name: 'Pull link for extra feed "MacBook"' });
    expect(await toggle.getAttribute('aria-checked')).toBe('false');

    await toggle.click();
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true');
    await panel.getByText('Nobody watching').waitFor();
    const key = pull.readKey(`guest/${slot}`)!;
    expect(key).toBeTruthy();
    // The masked link, the steps and the warning; the key itself is not on the page.
    await panel.getByText(`rtmp://relay.example.com:1935/guest/${slot}?key=••••••••`).waitFor();
    await panel.getByText('Untick “Local File”.').waitFor();
    await panel.getByText(/Paste the link into “Input”/).waitFor();
    await panel.getByText(/Anyone with this link can watch/).waitFor();
    expect(await page.content()).not.toContain(key);

    await panel.getByRole('button', { name: 'Copy link' }).click();
    await expect.poll(() => page.evaluate("navigator.clipboard.readText()")).toBe(`rtmp://relay.example.com:1935/guest/${slot}?key=${key}`);
    await panel.getByRole('button', { name: 'Copy with steps' }).click();
    await expect.poll(() => page.evaluate("navigator.clipboard.readText()")).toContain('Media Source');

    // Someone reads with the link: the card counts them (Relay's own reader isn't counted).
    conns = [
      { id: 'r1', state: 'read', path: `guest/${slot}`, query: `key=${key}` },
      { id: 'i1', state: 'read', path: `guest/${slot}`, query: 'user=internal&pass=x' },
    ];
    await pull.apply(conns, Date.now());
    await panel.getByText('1 of 2 watching').waitFor({ timeout: 10_000 });

    // Rotate: confirm, the reader is disconnected, a new key.
    await panel.getByRole('button', { name: 'Rotate key' }).click();
    await panel.getByRole('button', { name: /Disconnects who is watching/ }).click();
    await expect.poll(() => kicked).toEqual(['r1']);
    await expect.poll(() => pull.readKey(`guest/${slot}`)).not.toBe(key);
    await pull.apply(conns, Date.now());
    await panel.getByText('Nobody watching').waitFor({ timeout: 10_000 });

    // Off: the link and steps go away.
    await toggle.click();
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false');
    await expect.poll(() => panel.getByRole('button', { name: 'Copy link' }).count()).toBe(0);
    expect(pull.state({ kind: 'guest', profileId: 'default', slot }).enabled).toBe(false);
  }, 60_000);
});
