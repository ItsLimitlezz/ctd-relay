// Playwright UI test for guest feed routing (docs/GUEST-FEEDS.md → Routing): the real Guest feeds card
// and feed card (React, bundled with esbuild from web/src), against the real web routes and route
// service (fake FFmpeg, fake MediaMTX state), in Chromium. Skipped with CI_NO_BROWSER=1.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '../../../../shared/types.js';
import { bindGuestFeeds } from '../../api/guest-feeds.js';
import { openDatabase } from '../../db/database.js';
import { createGuestFeedsRepo } from '../../db/guest-feeds-repo.js';
import { createGuestRoutesRepo } from '../../db/guest-routes-repo.js';
import { createRepos } from '../../db/repos.js';
import { EventBus } from '../../events.js';
import { DEFAULT_GUEST_LIMITS, GuestFeeds } from '../../media/guest-feeds.js';
import { bindGuestRoutes, GuestRoutes } from '../../media/guest-routes.js';
import { guestPath } from '../../media/paths.js';
import { fakeSpawn } from '../../media/test-helpers.js';
import { createSecretBox } from '../../security/secretbox.js';
import type { AppServices, MediaServer } from '../../services.js';
import guestFeedRoutes from './guest-feeds.js';
import guestRouteRoutes from './guest-routes.js';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const KEY = 'live_sk_UIKEY0000000000000zz';
const admin: User = { id: 'u1', username: 'admin', role: 'admin', totpEnabled: false, createdAt: '', lastLoginAt: null };

const ENTRY = `
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GuestFeedsCard } from './components/GuestFeedsCard';
import { ToastProvider } from './components/Toast';
import { FeedCard, routedFrom } from './pages/DashboardPage';
import { api } from './api';

function ClubLandscape() {
  const [routes, setRoutes] = useState(null);
  useEffect(() => {
    const t = setInterval(() => void api.profileGuestRoutes('club').then(setRoutes, () => undefined), 300);
    return () => clearInterval(t);
  }, []);
  return <FeedCard feed="landscape" state={null} loading={false} routedFrom={routedFrom(routes, 'landscape')} />;
}

createRoot(document.getElementById('root')).render(
  <ToastProvider>
    <GuestFeedsCard profileId="default" isAdmin />
    <div id="club"><ClubLandscape /></div>
  </ToastProvider>,
);
`;

async function bundle(): Promise<string> {
  const out = await build({
    stdin: { contents: ENTRY, resolveDir: path.join(ROOT, 'web/src'), loader: 'tsx', sourcefile: 'guest-routes-ui-entry.tsx' },
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

describe.skipIf(!!process.env.CI_NO_BROWSER)('guest feed routing UI (Chromium)', () => {
  let app: FastifyInstance;
  let browser: Browser;
  let page: Page;
  let base: string;
  let guests: GuestFeeds;
  let slot: string;
  let t = 1_000_000;
  const spawn = fakeSpawn();

  beforeAll(async () => {
    const js = await bundle();
    const db = openDatabase(':memory:');
    const repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
    db.prepare("INSERT INTO profiles (id, name, slug, color, created_at, updated_at) VALUES ('club', 'Club', 'club', NULL, 'x', 'x')").run();
    const bus = new EventBus();
    const log = pino({ level: 'silent' });
    guests = new GuestFeeds({ repo: createGuestFeedsRepo(db), secrets: repos.secrets, bus, log, limits: DEFAULT_GUEST_LIMITS });
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
      supervisorDeps: { spawn: spawn.spawn },
    });
    routes.attachMedia({ guestReadUrl: (s: string) => `rtmp://127.0.0.1:1935/guest/${s}`, feed: () => ({ online: false }) } as unknown as MediaServer);
    const services = {
      config: { rtmpPort: 1935, ffmpegBin: 'ffmpeg' },
      log,
      media: {},
      repos: { ...repos, audit: { log: () => undefined } },
      appSettings: () => ({ publicBaseUrl: '', ingestHost: 'relay.example.com', disconnectGraceSec: 15 }),
    } as unknown as AppServices;
    bindGuestFeeds(services, guests);
    bindGuestRoutes(services, routes);
    slot = (await guests.create('default', 'MacBook')).slot;

    app = Fastify();
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (req) => {
      req.user = admin;
    });
    await app.register(guestFeedRoutes, { services });
    await app.register(guestRouteRoutes, { services });
    app.get('/api/profiles', async () => ({ profiles: [{ id: 'default', name: 'Main' }, { id: 'club', name: 'Club' }] }));
    app.get('/app.js', async (_req, reply) => reply.type('text/javascript').send(js));
    app.get('/', async (_req, reply) => reply.type('text/html').send('<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>'));
    base = await app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch();
    page = await browser.newPage();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
  });

  const guestOnline = () => {
    t += 1000;
    guests.apply(
      new Map([[guestPath(slot), { name: guestPath(slot), online: true, onlineTime: 'x', inboundBytes: 0, tracks2: [{ codec: 'H264', codecProps: { width: 1280, height: 720 } }] }]]),
      t,
    );
  };

  it('"Send this feed to…": add a profile route and a custom server, start it, see the source on the feed card', async () => {
    await page.goto(base);
    await page.getByText('MacBook', { exact: true }).waitFor();

    // A profile's feed: Club, Landscape.
    await page.getByRole('button', { name: 'Send this feed to…' }).click();
    await page.getByLabel("A profile's feed").check();
    await page.getByLabel('Target profile').selectOption('club');
    await page.getByLabel('Input').selectOption('landscape');
    await page.getByRole('button', { name: 'Add route' }).click();
    const route = page.locator('.guest-route').filter({ hasText: 'Club · Landscape' });
    await route.waitFor();
    await expect.poll(() => route.textContent()).toContain('Stopped');
    await expect.poll(() => route.textContent()).toContain('Landscape feed of "Club"');

    // A refused custom server shows why, and is not added.
    await page.getByRole('button', { name: 'Send this feed to…' }).click();
    await page.getByLabel('Server URL').fill('rtmp://127.0.0.1/live');
    await page.getByRole('button', { name: 'Add route' }).click();
    await page.getByText(/loopback/).first().waitFor();
    // A good one, with a key that is never shown again.
    await page.getByLabel('Server URL').fill('rtmps://live.example.com/app');
    await page.getByLabel('Stream key').fill(KEY);
    await page.getByRole('button', { name: 'Add route' }).click();
    const custom = page.locator('.guest-route').filter({ hasText: 'live.example.com' });
    await custom.waitFor();
    await expect.poll(() => custom.textContent()).toContain('(key set)');
    expect(await page.content()).not.toContain(KEY);

    // Start while the guest isn't sending: refused with the reason.
    await route.getByRole('button', { name: 'Start' }).click();
    await page.getByText(/isn't sending right now/).first().waitFor();

    // The guest sends: start it; the route runs and Club's Landscape card names its source.
    guestOnline();
    await route.getByRole('button', { name: 'Start' }).click();
    await route.getByRole('button', { name: 'Stop' }).waitFor();
    await page.getByTestId('feed-source-landscape').waitFor();
    expect(await page.getByTestId('feed-source-landscape').textContent()).toContain('Source: extra feed MacBook');
    expect(spawn.calls.length).toBeGreaterThan(0);
    expect(spawn.last()!.args).toContain('copy');

    // Stop: the indicator goes.
    await route.getByRole('button', { name: 'Stop' }).click();
    await route.getByRole('button', { name: 'Start' }).waitFor();
    await page.getByTestId('feed-source-landscape').waitFor({ state: 'detached' });

    // "When the feed is online" on the custom server route.
    await custom.getByRole('switch', { name: 'When the feed is online' }).click();
    await expect.poll(() => custom.getByRole('switch', { name: 'When the feed is online' }).getAttribute('aria-checked')).toBe('true');
  }, 60_000);
});
