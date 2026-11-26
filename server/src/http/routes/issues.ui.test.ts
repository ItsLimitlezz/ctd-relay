// Playwright UI test for the dashboard's issues (docs/API.md §17): the real issues strip, feed card,
// destination card and 7-day history (React, bundled with esbuild from web/src), fed by the real live
// store over the real /api/ws (WsHub + the API event hub's issue tracker) and the real issue routes
// (history in a real SQLite table), in Chromium. Skipped with CI_NO_BROWSER=1.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import websocket from '@fastify/websocket';
import { build } from 'esbuild';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Destination, FeedState, SessionState, User } from '../../../../shared/types.js';
import { EventHub, setEventHubFor } from '../../api/event-hub.js';
import { IssueHistory, setIssueHistoryFor } from '../../api/issue-history.js';
import { dest, dstate, platformInfo, session } from '../../api/test-helpers.js';
import { openDatabase } from '../../db/database.js';
import { createIssueHistoryRepo } from '../../db/issue-history-repo.js';
import { createRepos } from '../../db/repos.js';
import { EventBus } from '../../events.js';
import { createSecretBox } from '../../security/secretbox.js';
import type { AppServices } from '../../services.js';
import issueRoutes from './issues.js';
import wsRoutes from './ws.js';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const admin: User = { id: 'u1', username: 'admin', role: 'admin', totpEnabled: false, createdAt: '', lastLoginAt: null };
const DEST: Destination = dest('d1', { name: 'Twitch main', feed: 'vertical' });

const ENTRY = `
import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { IssueHistoryCard, IssuesStrip } from './components/Issues';
import { ToastProvider } from './components/Toast';
import { DestinationCard, FeedCard } from './pages/DashboardPage';
import { destinationIssues, feedIssues } from './state/issues';
import { LiveConnection, LiveStore } from './state/live-store';

const DEST = ${JSON.stringify(DEST)};
const store = new LiveStore();
store.startProfile('default');
new LiveConnection({
  url: () => 'ws://' + location.host + '/api/ws?profile=default',
  onMessage: (m) => store.dispatch(m),
  onConnectedChange: (c) => store.setConnected(c),
  checkAuth: async () => true,
}).start();

function App() {
  const issues = useSyncExternalStore(store.subscribe, () => store.getState().issues);
  return (
    <>
      <IssuesStrip issues={issues} />
      <FeedCard feed="landscape" state={null} loading={false} issues={feedIssues(issues, 'landscape')} />
      <DestinationCard dest={DEST} state={null} issues={destinationIssues(issues, 'd1')} onUpdated={() => undefined} />
      <IssueHistoryCard profile="default" />
    </>
  );
}

createRoot(document.getElementById('root')).render(<ToastProvider><App /></ToastProvider>);
`;

async function bundle(): Promise<string> {
  const out = await build({
    stdin: { contents: ENTRY, resolveDir: path.join(ROOT, 'web/src'), loader: 'tsx', sourcefile: 'issues-ui-entry.tsx' },
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
        // The React bindings of the live store need the whole app shell (auth, profiles): the entry
        // drives the real LiveStore + LiveConnection itself, so the bindings are no-ops here.
        name: 'stub-live',
        setup(b) {
          b.onResolve({ filter: /\/state\/live$/ }, () => ({ path: 'live-stub', namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, async () => {
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

describe.skipIf(!!process.env.CI_NO_BROWSER)('issues on the dashboard (Chromium)', () => {
  let app: FastifyInstance;
  let browser: Browser;
  let page: Page;
  let base: string;
  let hub: EventHub;
  let history: IssueHistory;
  const bus = new EventBus();
  const feed = (name: FeedState['feed'], online: boolean): FeedState => ({ feed: name, online, since: online ? '2026-11-20T19:59:00Z' : null, video: null, audio: null, bitrateKbps: null });
  let current: SessionState = session({ feeds: [feed('landscape', true), feed('vertical', true)], destinations: [dstate('d1', 'live')] });

  beforeAll(async () => {
    const js = await bundle();
    const db = openDatabase(':memory:');
    const repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
    const log = pino({ level: 'silent' });
    const services = {
      bus,
      log,
      repos,
      orchestrators: { get: () => ({ profileId: 'default', state: () => current }), summaries: () => [] },
      chat: { recent: () => [] },
      pairings: { list: () => [] },
      apps: { list: () => [] },
    } as unknown as AppServices;
    // No hold times (the tracker's own tests cover them); stream.down stays out of the way.
    hub = new EventHub({
      bus,
      log,
      state: () => current,
      destinations: () => [DEST],
      destination: (id) => (id === DEST.id ? DEST : null),
      platformInfo,
      issueHolds: { feed: 0, destination: 0, waiting: 0, output: 0, stream: 3600_000 },
    });
    setEventHubFor(services, hub);
    history = new IssueHistory({ repo: createIssueHistoryRepo(db), events: hub, log, timers: false });
    setIssueHistoryFor(services, history);
    history.start();

    app = Fastify();
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (req) => {
      req.user = admin;
    });
    await app.register(websocket);
    await app.register(wsRoutes, { services });
    await app.register(issueRoutes, { services });
    app.get('/app.js', async (_req, reply) => reply.type('text/javascript').send(js));
    app.get('/', async (_req, reply) => reply.type('text/html').send('<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>'));
    base = await app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch();
    page = await browser.newPage();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    history?.close();
    hub?.close();
  });

  const setFeed = (name: FeedState['feed'], online: boolean) => {
    current = { ...current, feeds: current.feeds.map((f) => (f.feed === name ? feed(name, online) : f)) };
    bus.emit('feed', feed(name, online));
  };
  const setDest = (phase: 'live' | 'error') => {
    current = { ...current, destinations: [dstate('d1', phase)] };
    bus.emit('destination', dstate('d1', phase, phase === 'error' ? { message: 'Twitch refused the stream' } : {}));
  };

  it('raise → strip row and badges appear; clear → they go away; the history keeps them', async () => {
    await page.goto(base);
    await page.getByRole('heading', { name: 'Landscape feed' }).waitFor();
    const strip = page.getByTestId('issues-strip');
    expect(await strip.count()).toBe(0);
    expect(await page.getByTestId('issue-history').textContent()).toContain('No issues in the last 7 days');

    // The landscape feed drops during the live, and the destination fails.
    setFeed('landscape', false);
    setDest('error');
    await strip.waitFor();
    const rows = strip.getByTestId('issue-row');
    await expect.poll(() => rows.count()).toBe(2);
    const feedRow = rows.filter({ hasText: 'Landscape feed lost' });
    await feedRow.waitFor();
    expect(await feedRow.textContent()).toContain('Landscape feed');
    expect(await feedRow.textContent()).toMatch(/Critical/);
    expect(await feedRow.getAttribute('class')).toContain('is-critical');
    const destRow = rows.filter({ hasText: 'Destination Twitch main' });
    await destRow.waitFor();
    // How long it has been open, ticking.
    const age = destRow.locator('.issue-age');
    await expect.poll(async () => (await age.textContent()) ?? '').toMatch(/open \d+ s/);
    const first = await age.textContent();
    await expect.poll(async () => await age.textContent(), { timeout: 5000 }).not.toBe(first);

    // Badges on the affected cards.
    await page.getByTestId('feed-issues-landscape').waitFor();
    expect(await page.getByTestId('feed-issues-landscape').textContent()).toBe('1 issue');
    expect(await page.getByTestId('dest-issues-d1').textContent()).toBe('1 issue');

    // Both clear: the rows and badges go, live.
    setFeed('landscape', true);
    await expect.poll(() => rows.count()).toBe(1);
    await page.getByTestId('feed-issues-landscape').waitFor({ state: 'detached' });
    setDest('live');
    await strip.waitFor({ state: 'detached' });
    await page.getByTestId('dest-issues-d1').waitFor({ state: 'detached' });

    // The 7-day history shows both, with how they ended.
    await page.getByTestId('issue-history').getByRole('button', { name: 'Refresh' }).click();
    const past = page.getByTestId('issue-history-row');
    await expect.poll(() => past.count()).toBe(2);
    const text = (await page.getByTestId('issue-history').textContent()) ?? '';
    expect(text).toContain('Landscape feed lost');
    expect(text).toContain('Destination Twitch main');
    expect(text).toContain('Recovered after');
  }, 60_000);
});
