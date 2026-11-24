import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOCK_CSS, DOCK_HTML, DOCK_JS } from './dock-assets.js';
import { DOCK_CSP } from './dock.js';
import { createTestApi, type TestApi } from './test-helpers.js';

describe('dock routes', () => {
  let t: TestApi;
  beforeEach(async () => {
    t = await createTestApi();
  });
  afterEach(async () => {
    await t.close();
  });

  it('serves the page with a strict CSP and no inline script', async () => {
    for (const url of ['/dock', '/dock/']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toBe(DOCK_CSP);
      expect(csp).toMatch(/script-src 'self'(;|$)/);
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|upgrade-insecure-requests/);
      expect(csp).toMatch(/connect-src 'self'/);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    }
    const html = DOCK_HTML;
    const scripts = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/g) ?? [];
    expect(scripts).toEqual(['<script src="/dock/dock.js" defer></script>']);
    expect(html).not.toMatch(/\son\w+\s*=/i); // no inline handlers
    expect(html).not.toMatch(/\sstyle\s*=/i); // no inline styles
    expect(html).not.toMatch(/javascript:/i);
  });

  it('serves dock.js and dock.css with ETag revalidation', async () => {
    const js = await t.app.inject({ method: 'GET', url: '/dock/dock.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/^text\/javascript/);
    const again = await t.app.inject({ method: 'GET', url: '/dock/dock.js', headers: { 'if-none-match': String(js.headers.etag) } });
    expect(again.statusCode).toBe(304);
    const css = await t.app.inject({ method: 'GET', url: '/dock/dock.css' });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toMatch(/^text\/css/);
    expect(css.body).toBe(DOCK_CSS);
  });

  it('script is valid JS and never parses text as HTML', () => {
    expect(() => new vm.Script(DOCK_JS)).not.toThrow();
    expect(DOCK_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(DOCK_JS).not.toMatch(/EventSource/); // fetch streaming, so the token goes in a header
  });
});

// ---- the dock script against a tiny fake DOM ----

class El {
  id = '';
  hidden = false;
  className = '';
  title = '';
  alt = '';
  src = '';
  referrerPolicy = '';
  checked = false;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 100;
  offsetWidth = 0;
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: El[] = [];
  parent: El | null = null;
  private text = '';
  listeners: Record<string, (() => void)[]> = {};
  classList = {
    add: (c: string) => {
      if (!this.className.split(' ').includes(c)) this.className = `${this.className} ${c}`.trim();
    },
    remove: (c: string) => {
      this.className = this.className.split(' ').filter((x) => x && x !== c).join(' ');
    },
  };
  constructor(readonly tag: string) {}
  get textContent(): string {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this.text;
  }
  set textContent(v: string) {
    this.children = [];
    this.text = v;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  appendChild(c: El) {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  get childElementCount(): number {
    return this.children.length;
  }
  get firstElementChild(): El | null {
    return this.children[0] ?? null;
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  all(): El[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}

/** Aborting a request errors its (otherwise endless) body stream, like a real fetch. */
function abortable(stream: ReadableStream<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    start(c) {
      signal.addEventListener('abort', () => c.error(new Error('aborted')));
    },
    async pull(c) {
      const { value, done } = await reader.read();
      if (done) c.close();
      else c.enqueue(value);
    },
  });
}

function harness(
  hash: string,
  routes: Record<string, () => { status: number; body?: unknown; stream?: ReadableStream<Uint8Array> }>,
  extra: Record<string, unknown> = {},
) {
  const byId: Record<string, El> = {};
  for (const id of [
    'setup',
    'setup-reason',
    'app',
    'status-panel',
    'session-pill',
    'profile-chip',
    'profile-dot',
    'profile-name',
    'session-timer',
    'test-badge',
    'alert-toggle',
    'session-title',
    'feeds',
    'issues',
    'destinations',
    'toast',
    'chat-panel',
    'chat',
    'conn',
  ]) {
    byId[id] = Object.assign(new El('div'), { id });
  }
  byId.setup!.hidden = true;
  byId.app!.hidden = true;
  const body = new El('body');
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn = async (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => {
    calls.push({ url, headers: init.headers });
    const path = url.split('?')[0]!;
    const route = routes[path];
    const r = route ? route() : { status: 404, body: {} };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: () => null },
      json: async () => r.body,
      body: r.stream && init.signal ? abortable(r.stream, init.signal) : (r.stream ?? null),
    };
  };
  const context = vm.createContext({
    location: { hash },
    document: {
      getElementById: (id: string) => byId[id] ?? null,
      createElement: (tag: string) => new El(tag),
      querySelector: (sel: string) => {
        const m = /^\[data-dest="(.*)"\]$/.exec(sel);
        return m ? (byId.destinations!.all().find((e) => e.attrs['data-dest'] === m[1]) ?? null) : null;
      },
      body,
    },
    fetch: fetchFn,
    URLSearchParams,
    TextDecoder,
    Map,
    Promise,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    localStorage: { getItem: () => null, setItem: () => {} },
    window: {},
    Date,
    JSON,
    Math,
    Number,
    String,
    Array,
    Object,
    isFinite,
    ...extra,
  });
  vm.runInContext(DOCK_JS, context);
  return { byId, calls };
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

function sse(frames: object[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('retry: 3000\n\n'));
      for (const env of frames) {
        const e = env as { id: string; type: string };
        controller.enqueue(enc.encode(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(env)}\n\n`));
      }
      // stay open
    },
  });
}

const TOKEN = `ctd_pat_${'A'.repeat(43)}`;

describe('dock script', () => {
  it('explains how to get a token when there is none or it is malformed', async () => {
    const none = harness('', {});
    expect(none.byId.setup!.hidden).toBe(false);
    expect(none.byId['setup-reason']!.textContent).toMatch(/No API token/);
    expect(none.calls).toEqual([]);
    const bad = harness('#token=nope', {});
    expect(bad.byId['setup-reason']!.textContent).toMatch(/not a CTD Relay API token/);
  });

  it('tells the user when the token is revoked', async () => {
    const h = harness(`#token=${TOKEN}`, { '/api/v1/': () => ({ status: 401, body: {} }) });
    await flush();
    expect(h.byId.setup!.hidden).toBe(false);
    expect(h.byId['setup-reason']!.textContent).toMatch(/invalid or was revoked/);
  });

  it('loads status + chat with the token in a header (never in the URL), then follows the event stream', async () => {
    const dest = (over: object) => ({
      id: 'd1',
      name: 'Instagram',
      platform: 'instagram',
      feed: 'vertical',
      enabled: true,
      phase: 'live',
      live: true,
      down: false,
      message: null,
      stats: { bitrateKbps: 4010, fps: 30, speed: 1, uptimeSec: 5 },
      viewers: 12,
      watchUrl: null,
      recoveries: 0,
      lastRecovery: null,
      since: '2026-10-17T03:00:00Z',
      ...over,
    });
    const chatEnv = (id: string, text: string) => ({
      id: `01JA7Q8M9X2V4C6B8N0P2R4T${id}`,
      type: 'chat.message',
      ts: 1,
      src: {},
      data: { id: `twitch:${id}`, platform: 'twitch', destinationId: 't1', platformMessageId: id, user: { id: `twitch:u${id}`, name: `<b>user${id}</b>`, color: '#FF0000', badges: [], roles: [] }, text, fragments: [{ type: 'text', text }], kind: 'message' },
    });
    const h = harness(`#token=${TOKEN}`, {
      '/api/v1/': () => ({ status: 200, body: { token: { scopes: ['chat:read', 'status:read'], profileId: null } } }),
      '/api/v1/events/poll': () => ({ status: 200, body: { items: [], next: '01JA7Q8M9X2V4C6B8N0P2R4T00', reset: false } }),
      '/api/v1/profiles/default': () => ({ status: 200, body: { id: 'default', name: 'Miami or Bust', color: '#3B82F6' } }),
      '/api/v1/status': () => ({
        status: 200,
        body: {
          session: { status: 'live', startedAt: new Date().toISOString(), title: 'Show', testMode: true, autoGoLive: true },
          feeds: [{ feed: 'landscape', online: true, video: { width: 1920, height: 1080 }, bitrateKbps: 6012 }],
          destinations: [dest({})],
          platforms: [],
        },
      }),
      '/api/v1/chat': () => ({ status: 200, body: { items: [chatEnv('10', '<img src=x onerror=alert(1)>')], next: 'x' } }),
      '/api/v1/events': () => ({
        status: 200,
        stream: sse([
          { id: '01JA7Q8M9X2V4C6B8N0P2R4T11', type: 'destination.status', data: dest({ phase: 'recovering', live: false, down: true, message: 'Instagram ended the live (copyright)' }) },
          { id: '01JA7Q8M9X2V4C6B8N0P2R4T12', type: 'destination.down', data: { destinationId: 'd1' } },
          chatEnv('13', 'hello'),
          { id: '01JA7Q8M9X2V4C6B8N0P2R4T14', type: 'chat.message.deleted', data: { messageId: 'twitch:10', platformMessageId: '10', platform: 'twitch', destinationId: 't1' } },
        ]),
      }),
    });
    await flush();

    // An every-profile token without #…&profile= shows the default profile.
    expect(h.calls.map((c) => c.url)).toEqual([
      '/api/v1/',
      '/api/v1/events/poll?profile=default',
      '/api/v1/profiles/default',
      '/api/v1/status?profile=default',
      '/api/v1/chat?limit=100&profile=default',
      '/api/v1/events?profile=default',
    ]);
    for (const c of h.calls) {
      expect(c.url).not.toContain(TOKEN);
      expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`);
    }
    // Resumes from the cursor taken before loading.
    expect(h.calls[5]!.headers['last-event-id']).toBe('01JA7Q8M9X2V4C6B8N0P2R4T00');

    const { byId } = h;
    expect(byId.app!.hidden).toBe(false);
    expect(byId['session-pill']!.textContent).toBe('LIVE');
    expect(byId['profile-chip']!.hidden).toBe(false);
    expect(byId['profile-name']!.textContent).toBe('Miami or Bust');
    expect(byId['profile-dot']!.style.backgroundColor).toBe('#3B82F6');
    expect(byId['test-badge']!.hidden).toBe(false);
    expect(byId['session-title']!.textContent).toBe('Show');
    expect(byId.feeds!.textContent).toContain('1920×1080 · 6012 kbps');

    const row = byId.destinations!.children[0]!;
    expect(row.className).toContain('down');
    expect(row.textContent).toContain('Instagram ended the live (copyright)');
    expect(row.textContent).toContain('DOWN');
    expect(row.children[0]!.children[0]!.textContent).toBe('I'); // platform letter badge

    // Chat: the deleted message is gone; text is never parsed as HTML.
    const chat = byId.chat!;
    expect(chat.children).toHaveLength(1);
    expect(chat.textContent).toContain('<b>user13</b>hello');
    expect(chat.all().some((e) => e.tag === 'img')).toBe(false);
  });

  it('an HEVC feed reads "Landscape: HEVC ⚠" and its destination is DOWN with what to change; it clears when the feed is H.264', async () => {
    const message = 'Landscape feed is HEVC. YouTube gets the stream unchanged and needs H.264. In CTD OBS: Relay dock → Send stream (switches to H.264), or Settings → Output → Video encoder: H.264.';
    const hevc = {
      feed: 'landscape',
      online: true,
      video: { codec: 'hevc', width: 1920, height: 1080 },
      bitrateKbps: 6012,
      problem: { reason: 'feed-video-codec', codec: 'hevc', label: 'HEVC', blocking: true, message: 'Landscape feed is HEVC. …' },
    };
    const blocked = {
      id: 'y1',
      name: 'YouTube',
      platform: 'youtube',
      feed: 'landscape',
      enabled: true,
      phase: 'waiting-for-feed',
      live: false,
      down: true,
      waitingFor: ['landscape'],
      blocked: { reason: 'feed-video-codec', feed: 'landscape', codec: 'hevc' },
      message,
      stats: null,
      viewers: null,
      watchUrl: null,
      recoveries: 0,
      lastRecovery: null,
      since: '2026-11-19T01:00:00Z',
    };
    const h = harness(`#token=${TOKEN}`, {
      '/api/v1/': () => ({ status: 200, body: { token: { scopes: ['status:read'], profileId: null } } }),
      '/api/v1/events/poll': () => ({ status: 200, body: { items: [], next: '01JA7Q8M9X2V4C6B8N0P2R4T00', reset: false } }),
      '/api/v1/profiles/default': () => ({ status: 200, body: { id: 'default', name: 'Main', color: null } }),
      '/api/v1/status': () => ({
        status: 200,
        body: { session: { status: 'live', startedAt: new Date().toISOString(), title: 'Show', testMode: false, autoGoLive: true }, feeds: [hevc], destinations: [blocked], platforms: [] },
      }),
      '/api/v1/events': () => ({
        status: 200,
        stream: sse([
          { id: '01JA7Q8M9X2V4C6B8N0P2R4T11', type: 'feed.status', data: { ...hevc, feed: 'vertical', video: { codec: 'h264', width: 1080, height: 1920 }, problem: null } },
        ]),
      }),
    });
    await flush();
    const [landscape, vertical] = h.byId.feeds!.children;
    expect(landscape!.textContent).toBe('Landscape:HEVC ⚠ · 1920×1080 · 6012 kbps');
    expect(landscape!.className).toContain('problem');
    expect(vertical!.textContent).toBe('Vertical1080×1920 · 6012 kbps');
    expect(vertical!.className).not.toContain('problem');
    const row = h.byId.destinations!.children[0]!;
    expect(row.className).toContain('down');
    expect(row.textContent).toContain('DOWN');
    expect(row.textContent).toContain(message);
  });

  it('chat.user.cleared follows the server rule: two real user ids decide, names only without one', async () => {
    const chatEnv = (n: number, userId: string, name: string) => ({
      id: `01JA7Q8M9X2V4C6B8N0P2R4T${n}`,
      type: 'chat.message',
      ts: 1,
      src: {},
      data: { id: `twitch:m${n}`, platform: 'twitch', destinationId: 't1', platformMessageId: null, user: { id: userId, name, login: null, badges: [], roles: [] }, text: `msg ${n}`, kind: 'message' },
    });
    const h = harness(`#token=${TOKEN}`, {
      '/api/v1/': () => ({ status: 200, body: { token: { scopes: ['chat:read'] } } }),
      '/api/v1/events/poll': () => ({ status: 200, body: { items: [], next: '01JA7Q8M9X2V4C6B8N0P2R4T00', reset: false } }),
      '/api/v1/chat': () => ({
        status: 200,
        body: { items: [chatEnv(10, 'twitch:111', 'Ann'), chatEnv(11, 'twitch:222', 'Ann'), chatEnv(12, 'twitch:name:Ann', 'Ann'), chatEnv(13, 'twitch:333', 'Bob')], next: 'x' },
      }),
      '/api/v1/events': () => ({
        status: 200,
        stream: sse([{ id: '01JA7Q8M9X2V4C6B8N0P2R4T20', type: 'chat.user.cleared', data: { userId: 'twitch:111', userName: 'Ann', platform: 'twitch', destinationId: 't1' } }]),
      }),
    });
    await flush();
    // m10: same id. m11: another user who happens to share the display name (kept). m12: no id, name matches.
    expect(h.byId.chat!.textContent).not.toContain('msg 10');
    expect(h.byId.chat!.textContent).toContain('msg 11');
    expect(h.byId.chat!.textContent).not.toContain('msg 12');
    expect(h.byId.chat!.textContent).toContain('msg 13');
  });

  it('reconnects with the cursor when the stream goes silent (no pings for 45 s)', async () => {
    const timers: { fn: () => void; ms: number; id: number; done: boolean }[] = [];
    const fire = (pred: (ms: number) => boolean) => {
      for (const t of timers.filter((x) => !x.done && pred(x.ms))) {
        t.done = true;
        t.fn();
      }
    };
    const h = harness(
      `#token=${TOKEN}`,
      {
        '/api/v1/': () => ({ status: 200, body: { token: { scopes: ['chat:read'] } } }),
        '/api/v1/events/poll': () => ({ status: 200, body: { items: [], next: '01JA7Q8M9X2V4C6B8N0P2R4T00', reset: false } }),
        '/api/v1/chat': () => ({ status: 200, body: { items: [], next: 'x' } }),
        '/api/v1/events': () => ({
          status: 200,
          stream: sse([{ id: '01JA7Q8M9X2V4C6B8N0P2R4T31', type: 'chat.cleared', data: { platform: 'twitch', destinationId: 't1' } }]),
        }),
      },
      {
        AbortController,
        setTimeout: (fn: () => void, ms: number) => {
          const t = { fn, ms, id: timers.length + 1, done: false };
          timers.push(t);
          return t.id;
        },
        clearTimeout: (id: number) => {
          const t = timers.find((x) => x.id === id);
          if (t) t.done = true;
        },
      },
    );
    await flush();
    const streams = () => h.calls.filter((c) => c.url.split('?')[0] === '/api/v1/events');
    expect(streams()).toHaveLength(1);
    expect(timers.filter((t) => !t.done && t.ms === 45000)).toHaveLength(1); // one live watchdog

    fire((ms) => ms === 45000); // 45 s of silence: abort
    await flush();
    expect(h.byId.conn!.textContent).toMatch(/Reconnecting/);
    fire((ms) => ms < 2000); // the retry delay (delivered events reset the backoff to ~1 s)
    await flush();
    expect(streams()).toHaveLength(2);
    expect(streams()[1]!.headers['last-event-id']).toBe('01JA7Q8M9X2V4C6B8N0P2R4T31');
  });

  it('a token limited to a profile shows that profile (whatever the link says); profile.status renames it live', async () => {
    const h = harness(`#token=${TOKEN}&profile=default`, {
      '/api/v1/': () => ({ status: 200, body: { token: { scopes: ['status:read'], profileId: 'club-1' } } }),
      '/api/v1/events/poll': () => ({ status: 200, body: { items: [], next: '01JA7Q8M9X2V4C6B8N0P2R4T00', reset: false } }),
      '/api/v1/profiles/club-1': () => ({ status: 200, body: { id: 'club-1', name: 'DPRTMNT', color: '#E11D48' } }),
      '/api/v1/status': () => ({ status: 200, body: { session: { status: 'offline' }, feeds: [], destinations: [], platforms: [] } }),
      '/api/v1/events': () => ({
        status: 200,
        stream: sse([
          { id: '01JA7Q8M9X2V4C6B8N0P2R4T41', type: 'profile.status', data: { id: 'other', name: 'Not mine', color: null } },
          { id: '01JA7Q8M9X2V4C6B8N0P2R4T42', type: 'profile.status', data: { id: 'club-1', name: 'DPRTMNT Toronto', color: 'red;}' } },
        ]),
      }),
    });
    await flush();
    expect(h.calls.map((c) => c.url)).toEqual(['/api/v1/', '/api/v1/events/poll?profile=club-1', '/api/v1/profiles/club-1', '/api/v1/status?profile=club-1', '/api/v1/events?profile=club-1']);
    expect(h.byId['profile-name']!.textContent).toBe('DPRTMNT Toronto');
    expect(h.byId['profile-dot']!.style.backgroundColor).toBe(''); // not a #RRGGBB colour: ignored
  });

  it('an every-profile token follows #…&profile=<id>; an unknown profile explains what to do', async () => {
    const h = harness(`#token=${TOKEN}&profile=club-1`, {
      '/api/v1/': () => ({ status: 200, body: { token: { scopes: ['chat:read'], profileId: null } } }),
      '/api/v1/events/poll': () => ({ status: 200, body: { items: [], next: '01JA7Q8M9X2V4C6B8N0P2R4T00', reset: false } }),
      '/api/v1/chat': () => ({ status: 200, body: { items: [], next: 'x' } }),
      '/api/v1/events': () => ({ status: 200, stream: sse([]) }),
    });
    await flush();
    expect(h.calls.map((c) => c.url)).toEqual(['/api/v1/', '/api/v1/events/poll?profile=club-1', '/api/v1/chat?limit=100&profile=club-1', '/api/v1/events?profile=club-1']);

    const gone = harness(`#token=${TOKEN}&profile=deleted`, {
      '/api/v1/': () => ({ status: 200, body: { token: { scopes: ['chat:read'], profileId: null } } }),
      '/api/v1/events/poll': () => ({ status: 404, body: { code: 'unknown_profile' } }),
    });
    await flush();
    expect(gone.byId.setup!.hidden).toBe(false);
    expect(gone.byId['setup-reason']!.textContent).toMatch(/profile/);
  });

  it('shows open issues (GET /status, then issue.*), critical first; a down destination stays a red row only', async () => {
    const issue = (id: string, over: object = {}) => ({ id, kind: 'feed.offline', rule: null, severity: 'critical', title: 'Vertical feed lost', message: 'OBS stopped sending the vertical feed; the landscape feed is still live.', subject: { type: 'feed', feed: 'vertical' }, onProgram: null, scene: null, firstSeen: 2, updatedAt: 2, ...over });
    const h = harness(`#token=${TOKEN}`, {
      '/api/v1/': () => ({ status: 200, body: { token: { scopes: ['status:read'], profileId: null } } }),
      '/api/v1/events/poll': () => ({ status: 200, body: { items: [], next: '01JA7Q8M9X2V4C6B8N0P2R4T00', reset: false } }),
      '/api/v1/profiles/default': () => ({ status: 200, body: { id: 'default', name: 'Show', color: null } }),
      '/api/v1/status': () => ({
        status: 200,
        body: {
          session: { status: 'live', startedAt: new Date().toISOString(), title: 'Show', testMode: false, autoGoLive: true },
          feeds: [],
          destinations: [],
          platforms: [],
          issues: [
            issue('obs.issue|app|av-drift|Cam', { kind: 'obs.issue', severity: 'warning', title: '<b>A/V drift</b>', message: null, firstSeen: 1 }),
            issue('destination.down|d1', { kind: 'destination.down', severity: 'warning', title: 'Twitch is down' }),
          ],
        },
      }),
      '/api/v1/events': () => ({
        status: 200,
        stream: sse([
          { id: '01JA7Q8M9X2V4C6B8N0P2R4T11', type: 'issue.raised', data: { ...issue('feed.offline|vertical'), update: false } },
          { id: '01JA7Q8M9X2V4C6B8N0P2R4T12', type: 'issue.raised', data: { ...issue('stream.down', { kind: 'stream.down', title: 'Stream down on every platform', message: null, firstSeen: 3 }), update: false } },
          { id: '01JA7Q8M9X2V4C6B8N0P2R4T13', type: 'issue.cleared', data: { id: 'stream.down', resolution: 'recovered' } },
        ]),
      }),
    });
    h.byId['alert-toggle']!.checked = true;
    await flush();
    const list = h.byId.issues!;
    expect(list.hidden).toBe(false);
    expect(list.children.map((c) => c.className)).toEqual(['issue critical', 'issue warning']);
    expect(list.children[0]!.textContent).toBe('Vertical feed lostOBS stopped sending the vertical feed; the landscape feed is still live.');
    expect(list.children[1]!.textContent).toBe('<b>A/V drift</b>'); // text, never HTML
    expect(list.textContent).not.toContain('Twitch is down');
    expect(list.textContent).not.toContain('Stream down');
  });

  it('a chat-only token hides the status panel', async () => {
    const h = harness(`#token=${TOKEN}`, {
      '/api/v1/': () => ({ status: 200, body: { token: { scopes: ['chat:read'] } } }),
      '/api/v1/events/poll': () => ({ status: 200, body: { items: [], next: '01JA7Q8M9X2V4C6B8N0P2R4T00', reset: false } }),
      '/api/v1/chat': () => ({ status: 200, body: { items: [], next: 'x' } }),
      '/api/v1/events': () => ({ status: 200, stream: sse([]) }),
    });
    await flush();
    expect(h.byId['status-panel']!.hidden).toBe(true);
    expect(h.byId['chat-panel']!.hidden).toBe(false);
    expect(h.calls.map((c) => c.url.split('?')[0])).not.toContain('/api/v1/status');
  });
});
