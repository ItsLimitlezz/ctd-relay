import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Destination } from '../../../../shared/types.js';
import type { BrowserManager, ScopedSecrets } from '../../services.js';
import type { OAuthTokens } from '../common/oauth.js';
import { DriverError, type DriverContext, type PreparedLive } from '../types.js';
import { forgetValidation } from './api.js';
import { dualFormatFallbackWarning, OBS_DIRECT_TEST_WARNING, twitchDriver } from './index.js';
import { DEFAULT_INGEST } from './options.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function memorySecrets(): ScopedSecrets & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(k) {
      return data.get(k) ?? null;
    },
    async set(k, v) {
      data.set(k, v);
    },
    async delete(k) {
      data.delete(k);
    },
    async getJson<T>(k: string) {
      const v = data.get(k);
      return v === undefined ? null : (JSON.parse(v) as T);
    },
    async setJson(k, v) {
      data.set(k, JSON.stringify(v));
    },
  };
}

function makeCtx(over: Partial<DriverContext> = {}) {
  const secrets = memorySecrets();
  const updates: Record<string, unknown>[] = [];
  const ctx: DriverContext = {
    log: pino({ level: 'silent' }),
    accountSecrets: secrets,
    destinationSecrets: null,
    app: { clientId: 'cid123' },
    browser: {} as BrowserManager,
    publicBaseUrl: 'https://example.test',
    updateAccount: async (patch) => {
      updates.push(patch);
    },
    signal: new AbortController().signal,
    ...over,
  };
  return { ctx, secrets, updates };
}

const now = new Date().toISOString();
const account: Account = {
  id: 'acc1',
  platform: 'twitch',
  label: 'Twitch',
  status: 'connected',
  statusMessage: null,
  options: { userId: '141981764', login: 'twitchdev' },
  createdAt: now,
  updatedAt: now,
};

function dest(options: Record<string, unknown> = {}, feed: Destination['feed'] = 'landscape'): Destination {
  return {
    id: 'dest1',
    platform: 'twitch',
    accountId: account.id,
    name: 'Twitch',
    feed,
    enabled: true,
    options,
    ingestUrl: null,
    hasStreamKey: false,
    createdAt: now,
    updatedAt: now,
  };
}

function tokens(over: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 3 * 3600_000,
    scope: 'channel:manage:broadcast channel:read:stream_key',
    tokenType: 'bearer',
    ...over,
  };
}

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

type Handler = (call: Call) => Response | Promise<Response>;

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Routes by "METHOD host/path"; unknown routes fail the test loudly. */
function stubFetch(routes: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      init.signal?.throwIfAborted();
      const url = new URL(String(input));
      const method = (init.method ?? 'GET').toUpperCase();
      const call: Call = { method, url, headers: new Headers(init.headers), body: typeof init.body === 'string' ? init.body : '' };
      calls.push(call);
      const handler = routes[`${method} ${url.host}${url.pathname}`];
      if (!handler) throw new Error(`unexpected request ${method} ${url.href}`);
      return handler(call);
    }),
  );
  return calls;
}

const VALIDATE_OK: Handler = (c) =>
  c.headers.get('authorization')?.startsWith('OAuth ')
    ? json(200, {
        client_id: 'cid123',
        login: 'twitchdev',
        user_id: '141981764',
        scopes: ['channel:manage:broadcast', 'channel:read:stream_key'],
        expires_in: 5000,
      })
    : json(401, { status: 401, message: 'invalid access token' });

const USERS_OK: Handler = () => json(200, { data: [{ id: '141981764', login: 'twitchdev', display_name: 'TwitchDev' }] });

const routes = {
  device: 'POST id.twitch.tv/oauth2/device',
  token: 'POST id.twitch.tv/oauth2/token',
  validate: 'GET id.twitch.tv/oauth2/validate',
  users: 'GET api.twitch.tv/helix/users',
  channels: 'PATCH api.twitch.tv/helix/channels',
  key: 'GET api.twitch.tv/helix/streams/key',
  config: 'POST ingest.twitch.tv/api/v3/GetClientConfiguration',
  streams: 'GET api.twitch.tv/helix/streams',
};

const form = (c: Call) => Object.fromEntries(new URLSearchParams(c.body));
/** A fresh run of the live's health watcher. */
const watch = (live: PreparedLive, signal: AbortSignal) => live.health!(signal)[Symbol.asyncIterator]();
const byRoute = (calls: Call[], route: string) => calls.filter((c) => `${c.method} ${c.url.host}${c.url.pathname}` === route);

beforeEach(() => {
  forgetValidation();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Info + routing
// ---------------------------------------------------------------------------

describe('info', () => {
  it('describes the platform for the generic UI', () => {
    const { info } = twitchDriver;
    expect(info).toMatchObject({
      id: 'twitch',
      feeds: ['landscape', 'vertical'],
      defaultFeed: 'landscape',
      connectMethod: 'device-code',
      titleSupport: 'api',
      chatSupport: 'api',
      keyPerSession: false,
      experimental: false,
    });
    expect(info.developerApp?.consoleUrl).toBe('https://dev.twitch.tv/console/apps');
    expect(info.developerApp?.fields.map((f) => f.key)).toEqual(['clientId']);
    expect(info.developerApp?.instructions).toMatch(/Client Type: Public/);
    expect(info.developerApp?.instructions.split('\n').every((l) => /^\d+\. /.test(l))).toBe(true);
    const dual = info.destinationFields.find((f) => f.key === 'dualFormat');
    expect(dual?.options?.map((o) => o.value)).toEqual(['off', 'obs-direct', 'relay-multitrack']);
    expect(dual?.default).toBe('off');
    expect(info.destinationFields.every((f) => f.target === 'option')).toBe(true);
    expect(info.notes).toMatch(/encodes what it asks for on this server/);
    expect(info.testMode).toEqual({ supported: true, description: expect.stringMatching(/^Bandwidth test — .*OBS/) });
    expect(info.testMode?.description).toMatch(/title is left unchanged/);
    expect(info.testMode?.description).toMatch(/Not private with "OBS sends Dual Format directly".*publicly/);
    // Every destination is prepared in test mode (the default rule, no override): an "OBS direct"
    // one isn't skipped, because skipping would not stop OBS's own public output — it carries a
    // warning instead (see the prepare tests).
    expect(twitchDriver.supportsTestMode).toBeUndefined();
  });

  it('requires feeds per Dual Format mode', () => {
    expect(twitchDriver.requiredFeeds!(dest())).toEqual(['landscape']);
    expect(twitchDriver.requiredFeeds!(dest({}, 'vertical'))).toEqual(['vertical']);
    expect(twitchDriver.requiredFeeds!(dest({ dualFormat: 'obs-direct' }))).toEqual([]);
    expect(twitchDriver.requiredFeeds!(dest({ dualFormat: 'relay-multitrack' }))).toEqual(['landscape', 'vertical']);
  });

  it('validates destination options', async () => {
    const { ctx } = makeCtx();
    expect(await twitchDriver.validateDestination!(dest(), account, ctx)).toEqual([]);
    expect(await twitchDriver.validateDestination!(dest({ ingestServer: 'https://nope' }), account, ctx)).toHaveLength(1);
    expect(
      await twitchDriver.validateDestination!(dest({ dualFormat: 'relay-multitrack', landscapeFormat: 'huge' }), account, ctx),
    ).toEqual(['Landscape feed format must look like 1920x1080@60']);
  });
});

// ---------------------------------------------------------------------------
// Connect (device code grant)
// ---------------------------------------------------------------------------

describe('connect', () => {
  it('starts the device flow with `scopes` and stores the pending state', async () => {
    const calls = stubFetch({
      [routes.device]: () =>
        json(200, {
          device_code: 'dev-code',
          expires_in: 1800,
          interval: 5,
          user_code: 'ABCDEFGH',
          verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH',
        }),
    });
    const { ctx, secrets } = makeCtx();
    const start = await twitchDriver.startConnect!(account, ctx);
    expect(start).toEqual({
      method: 'device-code',
      userCode: 'ABCDEFGH',
      verificationUri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH',
      expiresIn: 1800,
      interval: 5,
    });
    expect(form(calls[0]!)).toEqual({ client_id: 'cid123', scopes: 'channel:manage:broadcast channel:read:stream_key moderator:read:followers' });
    const state = JSON.parse(secrets.data.get('device')!);
    expect(state).toMatchObject({ deviceCode: 'dev-code', clientId: 'cid123', interval: 5 });
  });

  it('needs the developer app', async () => {
    const { ctx } = makeCtx({ app: null });
    await expect(twitchDriver.startConnect!(account, ctx)).rejects.toMatchObject({
      code: 'misconfigured',
      message: 'Set up the Twitch developer app in Settings → Developer apps',
    });
  });

  it('explains a rejected Client ID', async () => {
    stubFetch({ [routes.device]: () => json(400, { status: 400, message: 'invalid client' }) });
    const { ctx } = makeCtx();
    await expect(twitchDriver.startConnect!(account, ctx)).rejects.toMatchObject({
      code: 'misconfigured',
      message: expect.stringMatching(/Client ID/),
    });
  });

  async function pending(ctx: DriverContext) {
    await ctx.accountSecrets!.setJson('device', {
      deviceCode: 'dev-code',
      clientId: 'cid123',
      expiresAt: Date.now() + 60_000,
      interval: 5,
    });
  }

  it('reports pending while the user has not approved', async () => {
    const calls = stubFetch({ [routes.token]: () => json(400, { status: 400, message: 'authorization_pending' }) });
    const { ctx, secrets } = makeCtx();
    await pending(ctx);
    expect(await twitchDriver.pollConnect!(account, ctx)).toEqual({ status: 'pending' });
    expect(form(calls[0]!)).toEqual({
      client_id: 'cid123',
      device_code: 'dev-code',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      scopes: 'channel:manage:broadcast channel:read:stream_key moderator:read:followers',
    });
    expect(secrets.data.has('device')).toBe(true);
  });

  it('treats a used/expired device code as expired', async () => {
    stubFetch({ [routes.token]: () => json(400, { status: 400, message: 'invalid device code' }) });
    const { ctx, secrets } = makeCtx();
    await pending(ctx);
    expect(await twitchDriver.pollConnect!(account, ctx)).toEqual({ status: 'expired' });
    expect(secrets.data.has('device')).toBe(false);
  });

  it('expires without state, after the deadline, or when the Client ID changed', async () => {
    const { ctx, secrets } = makeCtx();
    expect(await twitchDriver.pollConnect!(account, ctx)).toEqual({ status: 'expired' });
    await secrets.setJson('device', { deviceCode: 'x', clientId: 'cid123', expiresAt: Date.now() - 1, interval: 5 });
    expect(await twitchDriver.pollConnect!(account, ctx)).toEqual({ status: 'expired' });
    await secrets.setJson('device', { deviceCode: 'x', clientId: 'other', expiresAt: Date.now() + 60_000, interval: 5 });
    expect(await twitchDriver.pollConnect!(account, ctx)).toEqual({ status: 'expired' });
  });

  it('keeps polling through transient Twitch errors', async () => {
    stubFetch({ [routes.token]: () => json(503, { message: 'unavailable' }) });
    const { ctx, secrets } = makeCtx();
    await pending(ctx);
    expect(await twitchDriver.pollConnect!(account, ctx)).toEqual({ status: 'pending' });
    expect(secrets.data.has('device')).toBe(true);
  });

  it('connects: stores tokens, reads the identity and updates the account', async () => {
    stubFetch({
      [routes.token]: () =>
        json(200, {
          access_token: 'at-new',
          refresh_token: 'rt-new',
          expires_in: 14820,
          scope: ['channel:manage:broadcast', 'channel:read:stream_key'],
          token_type: 'bearer',
        }),
      [routes.validate]: VALIDATE_OK,
      [routes.users]: (c) => {
        expect(c.url.searchParams.get('id')).toBe('141981764');
        expect(c.headers.get('client-id')).toBe('cid123');
        expect(c.headers.get('authorization')).toBe('Bearer at-new');
        return USERS_OK(c);
      },
    });
    const { ctx, secrets, updates } = makeCtx();
    await pending(ctx);
    const pendingAccount = { ...account, status: 'pending' as const, options: {} };
    const result = await twitchDriver.pollConnect!(pendingAccount, ctx);
    expect(result.status).toBe('connected');
    if (result.status === 'connected') {
      expect(result.account).toMatchObject({ label: 'TwitchDev', status: 'connected', options: { userId: '141981764', login: 'twitchdev' } });
    }
    expect(updates).toEqual([
      { label: 'TwitchDev', status: 'connected', statusMessage: null, options: { userId: '141981764', login: 'twitchdev' } },
    ]);
    const stored = JSON.parse(secrets.data.get('oauth')!) as OAuthTokens;
    expect(stored).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new', scope: 'channel:manage:broadcast channel:read:stream_key' });
    expect(secrets.data.has('device')).toBe(false);
  });

  it('reports denied access and missing scopes as errors', async () => {
    stubFetch({ [routes.token]: () => json(400, { status: 400, message: 'access_denied' }) });
    const { ctx } = makeCtx();
    await pending(ctx);
    expect(await twitchDriver.pollConnect!(account, ctx)).toMatchObject({ status: 'error', message: expect.stringMatching(/denied/) });

    stubFetch({
      [routes.token]: () => json(200, { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 100 }),
      [routes.validate]: () => json(200, { client_id: 'cid123', login: 'twitchdev', user_id: '1', scopes: ['channel:manage:broadcast'] }),
    });
    await pending(ctx);
    expect(await twitchDriver.pollConnect!(account, ctx)).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/channel:read:stream_key/),
    });
  });
});

// ---------------------------------------------------------------------------
// Tokens + account check
// ---------------------------------------------------------------------------

describe('tokens', () => {
  it('refreshes an expiring token with client_id only and stores the new refresh token', async () => {
    const calls = stubFetch({
      [routes.token]: () =>
        json(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 14000, scope: ['channel:manage:broadcast', 'channel:read:stream_key'] }),
      [routes.validate]: (c) => {
        expect(c.headers.get('authorization')).toBe('OAuth at-2');
        return VALIDATE_OK(c);
      },
      [routes.users]: USERS_OK,
    });
    const { ctx, secrets } = makeCtx();
    await secrets.setJson('oauth', tokens({ expiresAt: Date.now() + 60_000 }));
    const result = await twitchDriver.checkAccount!(account, ctx);
    // An account connected before follow alerts: still connected, with a hint to reconnect.
    expect(result).toEqual({ status: 'connected', label: 'TwitchDev', message: 'Reconnect this account to turn on follow alerts.' });
    const refresh = byRoute(calls, routes.token)[0]!;
    expect(form(refresh)).toEqual({ grant_type: 'refresh_token', client_id: 'cid123', refresh_token: 'rt-1' });
    expect(JSON.parse(secrets.data.get('oauth')!)).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
  });

  it('refreshes once when two destinations of one account need a token at the same time', async () => {
    let refreshes = 0;
    stubFetch({
      [routes.token]: async (c) => {
        refreshes += 1;
        expect(form(c).refresh_token).toBe('rt-1');
        await new Promise((r) => setTimeout(r, 20));
        return json(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 14000 });
      },
      [routes.validate]: VALIDATE_OK,
      [routes.channels]: () => new Response(null, { status: 204 }),
    });
    const a = makeCtx();
    await a.secrets.setJson('oauth', tokens({ expiresAt: Date.now() + 1000 }));
    // Same account storage, but a different ScopedSecrets object (as every DriverContext gets).
    const view: ScopedSecrets = { ...a.secrets };
    const b = makeCtx({ accountSecrets: view });
    await Promise.all([
      twitchDriver.setTitleOffline!(dest(), account, 'one', a.ctx),
      twitchDriver.setTitleOffline!(dest(), account, 'two', b.ctx),
    ]);
    expect(refreshes).toBe(1);
  });

  it('reports needs-login when the token is revoked and the refresh token is rejected', async () => {
    stubFetch({
      [routes.validate]: () => json(401, { status: 401, message: 'invalid access token' }),
      [routes.token]: () => json(400, { error: 'Bad Request', status: 400, message: 'Invalid refresh token' }),
    });
    const { ctx, secrets } = makeCtx();
    await secrets.setJson('oauth', tokens());
    expect(await twitchDriver.checkAccount!(account, ctx)).toMatchObject({ status: 'needs-login', message: expect.stringMatching(/reconnect/) });
  });

  it('reports needs-login without stored tokens', async () => {
    const { ctx } = makeCtx();
    expect(await twitchDriver.checkAccount!(account, ctx)).toMatchObject({ status: 'needs-login' });
  });

  it('syncs a renamed login into the account options', async () => {
    stubFetch({
      [routes.validate]: () =>
        json(200, { client_id: 'cid123', login: 'newname', user_id: '141981764', scopes: ['channel:manage:broadcast', 'channel:read:stream_key', 'moderator:read:followers'] }),
      [routes.users]: () => json(200, { data: [{ id: '141981764', login: 'newname', display_name: 'NewName' }] }),
    });
    const { ctx, secrets, updates } = makeCtx();
    await secrets.setJson('oauth', tokens());
    expect(await twitchDriver.checkAccount!(account, ctx)).toEqual({ status: 'connected', label: 'NewName' });
    expect(updates).toEqual([{ options: { userId: '141981764', login: 'newname' } }]);
  });
});

// ---------------------------------------------------------------------------
// Prepare / title
// ---------------------------------------------------------------------------

describe('prepare', () => {
  async function connected() {
    const made = makeCtx();
    await made.secrets.setJson('oauth', tokens());
    return made;
  }

  function liveRoutes(extra: Record<string, Handler> = {}): Record<string, Handler> {
    return {
      [routes.validate]: VALIDATE_OK,
      [routes.channels]: () => new Response(null, { status: 204 }),
      [routes.key]: () => json(200, { data: [{ stream_key: 'live_141981764_SECRET' }] }),
      ...extra,
    };
  }

  it('sets only the (truncated) title and relays the destination feed to the default ingest', async () => {
    const calls = stubFetch(liveRoutes());
    const { ctx } = await connected();
    const longTitle = '🎮'.repeat(150);
    const live = await twitchDriver.prepare(dest({}, 'vertical'), account, longTitle, ctx);

    const patch = byRoute(calls, routes.channels)[0]!;
    expect(patch.url.searchParams.get('broadcaster_id')).toBe('141981764');
    expect(patch.headers.get('client-id')).toBe('cid123');
    expect(patch.headers.get('authorization')).toBe('Bearer at-1');
    const body = JSON.parse(patch.body) as Record<string, string>;
    expect(Object.keys(body)).toEqual(['title']);
    expect([...body.title!]).toHaveLength(140);

    expect(byRoute(calls, routes.key)[0]!.url.searchParams.get('broadcaster_id')).toBe('141981764');
    expect(live.push).toEqual({ url: `${DEFAULT_INGEST}/live_141981764_SECRET`, mode: 'copy', feeds: ['vertical'] });
    expect(live.watchUrl).toBe('https://www.twitch.tv/twitchdev');
    expect(typeof live.chat).toBe('function');
    expect(typeof live.setTitle).toBe('function');
    expect(live.end).toBeUndefined();
  });

  it('uses the ingest override and the bandwidth test flag', async () => {
    stubFetch(liveRoutes());
    const { ctx } = await connected();
    const live = await twitchDriver.prepare(
      dest({ ingestServer: 'rtmps://use20.contribute.live-video.net/app/', bandwidthTest: true }),
      account,
      'Title',
      ctx,
    );
    expect(live.push?.url).toBe('rtmps://use20.contribute.live-video.net/app/live_141981764_SECRET?bandwidthtest=true');
  });

  it('test mode always streams as a bandwidth test', async () => {
    stubFetch(liveRoutes());
    const made = makeCtx({ testMode: true });
    await made.secrets.setJson('oauth', tokens());
    const live = await twitchDriver.prepare(dest(), account, 'Title', made.ctx);
    expect(live.push?.url).toBe(`${DEFAULT_INGEST}/live_141981764_SECRET?bandwidthtest=true`);
    // ...without doubling the flag when the destination already tests.
    const again = await twitchDriver.prepare(dest({ bandwidthTest: true }), account, 'Title', made.ctx);
    expect(again.push?.url).toBe(`${DEFAULT_INGEST}/live_141981764_SECRET?bandwidthtest=true`);
    // OBS direct sends no video from here: nothing to change (it is flagged instead, see below).
    expect((await twitchDriver.prepare(dest({ dualFormat: 'obs-direct' }), account, 'Title', made.ctx)).push).toBeNull();
  });

  it('test mode leaves the public channel title unchanged (prepare and live)', async () => {
    const calls = stubFetch(liveRoutes());
    const made = makeCtx({ testMode: true });
    await made.secrets.setJson('oauth', tokens());
    for (const options of [{}, { dualFormat: 'obs-direct' }]) {
      const live = await twitchDriver.prepare(dest(options), account, 'Rehearsal', made.ctx);
      await expect(live.setTitle!('Changed mid-test')).resolves.toBeUndefined();
    }
    expect(byRoute(calls, routes.channels)).toHaveLength(0);
    // The stream key is still fetched for the relay (the bandwidth test needs it).
    expect(byRoute(calls, routes.key)).toHaveLength(1);
  });

  it('test mode with OBS direct: still chat + viewers, but the card says OBS streams publicly', async () => {
    stubFetch(liveRoutes({ [routes.streams]: () => json(200, { data: [{ user_id: '141981764', type: 'live', viewer_count: 7 }] }) }));
    const made = makeCtx({ testMode: true });
    await made.secrets.setJson('oauth', tokens());
    const live = await twitchDriver.prepare(dest({ dualFormat: 'obs-direct' }), account, 'T', made.ctx);
    expect(live.push).toBeNull();
    expect(typeof live.chat).toBe('function');

    const ctl = new AbortController();
    const events = watch(live, ctl.signal);
    expect((await events.next()).value).toEqual({ type: 'warning', message: OBS_DIRECT_TEST_WARNING });
    expect(OBS_DIRECT_TEST_WARNING).toMatch(/^Not private: OBS streams to Twitch itself/);
    expect([...OBS_DIRECT_TEST_WARNING].length).toBeLessThanOrEqual(200); // the runner's message limit
    expect((await events.next()).value).toEqual({ type: 'viewers', count: 7 });
    ctl.abort();
    // An aborted watcher yields nothing, the warning included.
    expect(await watch(live, ctl.signal).next()).toEqual({ done: true, value: undefined });
  });

  it('no warning for OBS direct outside test mode, nor for relayed destinations in test mode', async () => {
    stubFetch(liveRoutes({ [routes.streams]: () => json(200, { data: [] }) }));
    const plain = await connected();
    const testing = makeCtx({ testMode: true });
    await testing.secrets.setJson('oauth', tokens());
    const cases = [
      { ctx: plain.ctx, options: { dualFormat: 'obs-direct' } },
      { ctx: testing.ctx, options: {} },
    ];
    for (const { ctx, options } of cases) {
      const live = await twitchDriver.prepare(dest(options), account, 'T', ctx);
      const ctl = new AbortController();
      expect((await watch(live, ctl.signal).next()).value).toEqual({ type: 'viewers', count: null });
      ctl.abort();
    }
  });

  it('test mode applies to relay Dual Format too', async () => {
    stubFetch(
      liveRoutes({
        [routes.config]: () =>
          json(200, {
            meta: { config_id: 'cfg-9' },
            status: { result: 'success' },
            ingest_endpoints: [{ protocol: 'RTMPS', url_template: 'rtmps://x.contribute.live-video.net/app/{stream_key}', authentication: 'v1_auth' }],
            encoder_configurations: [
              { type: 'obs_x264', width: 1920, height: 1080, framerate: { numerator: 60, denominator: 1 }, canvas_index: 0, settings: { bitrate: 6000 } },
              { type: 'obs_x264', width: 1080, height: 1920, framerate: { numerator: 60, denominator: 1 }, canvas_index: 1, settings: { bitrate: 5000 } },
            ],
            audio_configurations: { live: [{ codec: 'aac' }] },
          }),
      }),
    );
    const made = makeCtx({ testMode: true });
    await made.secrets.setJson('oauth', tokens());
    const live = await twitchDriver.prepare(dest({ dualFormat: 'relay-multitrack' }), account, 'T', made.ctx);
    expect(live.push?.url).toBe('rtmps://x.contribute.live-video.net/app/v1_auth?bandwidthtest=true&clientConfigId=cfg-9');
  });

  it('health reports viewers from Helix (null until the stream is listed)', async () => {
    let listed = false;
    const calls = stubFetch(
      liveRoutes({
        [routes.streams]: () => json(200, { data: listed ? [{ user_id: '141981764', type: 'live', viewer_count: 42 }] : [] }),
      }),
    );
    const { ctx } = await connected();
    const live = await twitchDriver.prepare(dest(), account, 'T', ctx);
    expect(typeof live.health).toBe('function');
    expect(live.recovery).toBeUndefined();

    const ctl = new AbortController();
    const first = await watch(live, ctl.signal).next();
    expect(first.value).toEqual({ type: 'viewers', count: null });
    listed = true;
    const second = await watch(live, ctl.signal).next();
    expect(second.value).toEqual({ type: 'viewers', count: 42 });
    ctl.abort();

    const req = byRoute(calls, routes.streams)[0]!;
    expect(req.url.searchParams.get('user_id')).toBe('141981764');
    expect(req.headers.get('client-id')).toBe('cid123');
    expect(req.headers.get('authorization')).toBe('Bearer at-1');
  });

  it('health stops at once when its signal aborts', async () => {
    stubFetch(liveRoutes({ [routes.streams]: () => json(200, { data: [] }) }));
    const { ctx } = await connected();
    const live = await twitchDriver.prepare(dest(), account, 'T', ctx);
    const ctl = new AbortController();
    ctl.abort();
    expect(await watch(live, ctl.signal).next()).toEqual({ done: true, value: undefined });
  });

  it('OBS direct: no video, no stream key, still title + chat', async () => {
    const calls = stubFetch(liveRoutes());
    const { ctx } = await connected();
    const live = await twitchDriver.prepare(dest({ dualFormat: 'obs-direct' }), account, 'Hello', ctx);
    expect(live.push).toBeNull();
    expect(byRoute(calls, routes.key)).toHaveLength(0);
    expect(byRoute(calls, routes.channels)).toHaveLength(1);
    expect(typeof live.chat).toBe('function');
  });

  it('skips an empty title (Twitch rejects it)', async () => {
    const calls = stubFetch(liveRoutes());
    const { ctx } = await connected();
    await twitchDriver.prepare(dest(), account, '   ', ctx);
    expect(byRoute(calls, routes.channels)).toHaveLength(0);
  });

  it('refreshes once and retries after a Helix 401', async () => {
    let first = true;
    const calls = stubFetch(
      liveRoutes({
        [routes.key]: (c) => {
          if (first) {
            first = false;
            return json(401, { error: 'Unauthorized', status: 401, message: 'Invalid OAuth token' });
          }
          expect(c.headers.get('authorization')).toBe('Bearer at-2');
          return json(200, { data: [{ stream_key: 'live_141981764_SECRET' }] });
        },
        [routes.token]: () => json(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 14000 }),
      }),
    );
    const { ctx, secrets } = await connected();
    const live = await twitchDriver.prepare(dest(), account, 'T', ctx);
    expect(live.push?.url).toContain('live_141981764_SECRET');
    expect(byRoute(calls, routes.token)).toHaveLength(1);
    expect(JSON.parse(secrets.data.get('oauth')!)).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
  });

  it('continues when Twitch rejects the title, but fails on a missing permission', async () => {
    stubFetch(liveRoutes({ [routes.channels]: () => json(400, { status: 400, message: 'Title too long' }) }));
    const { ctx } = await connected();
    const live = await twitchDriver.prepare(dest(), account, 'T', ctx);
    expect(live.push).not.toBeNull();

    stubFetch(
      liveRoutes({
        [routes.channels]: () => json(401, { status: 401, message: 'Missing scope: channel:manage:broadcast' }),
      }),
    );
    await expect(twitchDriver.prepare(dest(), account, 'T', ctx)).rejects.toMatchObject({ code: 'needs-login' });
  });

  it('maps stream-key failures', async () => {
    stubFetch(liveRoutes({ [routes.key]: () => json(200, { data: [] }) }));
    const { ctx } = await connected();
    await expect(twitchDriver.prepare(dest(), account, 'T', ctx)).rejects.toMatchObject({ code: 'platform-error' });
    stubFetch(liveRoutes({ [routes.key]: () => json(500, { message: 'boom' }) }));
    await expect(twitchDriver.prepare(dest(), account, 'T', ctx)).rejects.toMatchObject({
      code: 'platform-error',
      message: expect.stringMatching(/HTTP 500/),
    });
  });

  it('requires an account, tokens and the developer app', async () => {
    const { ctx } = makeCtx();
    await expect(twitchDriver.prepare(dest(), null, 'T', ctx)).rejects.toMatchObject({ code: 'not-connected' });
    await expect(twitchDriver.prepare(dest(), account, 'T', ctx)).rejects.toMatchObject({ code: 'not-connected' });
    const noApp = makeCtx({ app: {} });
    await expect(twitchDriver.prepare(dest(), account, 'T', noApp.ctx)).rejects.toMatchObject({ code: 'misconfigured' });
  });

  it('refuses invalid options before calling Twitch', async () => {
    const calls = stubFetch(liveRoutes());
    const { ctx } = await connected();
    await expect(twitchDriver.prepare(dest({ ingestServer: 'ftp://x' }), account, 'T', ctx)).rejects.toBeInstanceOf(DriverError);
    expect(calls).toHaveLength(0);
  });

  it('live setTitle changes only the title', async () => {
    const calls = stubFetch(liveRoutes());
    const { ctx } = await connected();
    const live: PreparedLive = await twitchDriver.prepare(dest(), account, 'First', ctx);
    await live.setTitle!('Second');
    const patches = byRoute(calls, routes.channels).map((c) => JSON.parse(c.body) as unknown);
    expect(patches).toEqual([{ title: 'First' }, { title: 'Second' }]);
    // Validated once (cached for an hour).
    expect(byRoute(calls, routes.validate)).toHaveLength(1);

    stubFetch(liveRoutes({ [routes.channels]: () => json(400, { status: 400, message: 'bad title' }) }));
    await expect(live.setTitle!('Third')).rejects.toMatchObject({ message: 'Twitch rejected the title: bad title' });
  });

  it('live calls do not depend on the prepare signal', async () => {
    const calls = stubFetch(liveRoutes());
    const ctl = new AbortController();
    const made = makeCtx({ signal: ctl.signal });
    await made.secrets.setJson('oauth', tokens());
    const live = await twitchDriver.prepare(dest(), account, 'First', made.ctx);
    ctl.abort();
    await live.setTitle!('After abort');
    expect(JSON.parse(byRoute(calls, routes.channels).at(-1)!.body)).toEqual({ title: 'After abort' });
    // ...while prepare itself honors it.
    await expect(twitchDriver.prepare(dest(), account, 'x', made.ctx)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('relay Dual Format asks Twitch for a two-canvas configuration and encodes what it returns', async () => {
    const calls = stubFetch(
      liveRoutes({
        [routes.config]: (c) => {
          const body = JSON.parse(c.body) as { authentication: string; preferences: { canvases: unknown[]; maximum_video_tracks: number } };
          expect(body.authentication).toBe('live_141981764_SECRET');
          expect(body.preferences.canvases).toHaveLength(2);
          expect(body.preferences.maximum_video_tracks).toBe(4);
          return json(200, {
            meta: { config_id: 'cfg-9' },
            status: { result: 'success' },
            ingest_endpoints: [{ protocol: 'RTMPS', url_template: 'rtmps://x.contribute.live-video.net/app/{stream_key}', authentication: 'v1_auth' }],
            encoder_configurations: [
              { type: 'obs_x264', width: 1280, height: 720, framerate: { numerator: 30, denominator: 1 }, canvas_index: 0, settings: { bitrate: 3000 } },
              { type: 'obs_x264', width: 640, height: 360, framerate: { numerator: 30, denominator: 1 }, canvas_index: 0, settings: { bitrate: 500 } },
              { type: 'obs_x264', width: 720, height: 1280, framerate: { numerator: 30, denominator: 1 }, canvas_index: 1, settings: { bitrate: 3000 } },
              { type: 'obs_x264', width: 360, height: 640, framerate: { numerator: 30, denominator: 1 }, canvas_index: 1, settings: { bitrate: 500 } },
            ],
            audio_configurations: { live: [{ codec: 'aac', track_id: 0, channels: 2, settings: { bitrate: 160 } }] },
          });
        },
      }),
    );
    const { ctx } = await connected();
    const live = await twitchDriver.prepare(
      dest({ dualFormat: 'relay-multitrack', landscapeFormat: '1280x720@30', verticalFormat: '720x1280@30' }),
      account,
      'T',
      ctx,
    );
    expect(live.push).toMatchObject({
      url: 'rtmps://x.contribute.live-video.net/app/v1_auth?clientConfigId=cfg-9',
      mode: 'ivs',
      feeds: ['landscape', 'vertical'],
    });
    expect(live.push?.ivs?.tracks.map((t) => `${t.feed} ${t.width}x${t.height} ${t.bitrateKbps}k`)).toEqual([
      'landscape 1280x720 3000k',
      'landscape 640x360 500k',
      'vertical 720x1280 3000k',
      'vertical 360x640 500k',
    ]);
    expect(byRoute(calls, routes.config)).toHaveLength(1);
  });

  it('relay Dual Format refused: streams the landscape feed alone with a warning on the card', async () => {
    stubFetch(
      liveRoutes({
        [routes.config]: () => json(200, { status: { result: 'error', html_en_us: 'Your GPU is not supported.' }, encoder_configurations: [] }),
      }),
    );
    const { ctx } = await connected();
    const live = await twitchDriver.prepare(dest({ dualFormat: 'relay-multitrack' }, 'vertical'), account, 'T', ctx);
    expect(live.push).toMatchObject({ mode: 'copy', feeds: ['landscape'] });
    expect(live.push?.url).toMatch(/^rtmps?:\/\/.+\/live_141981764_SECRET$/);

    const ctl = new AbortController();
    const first = await watch(live, ctl.signal).next();
    expect(first.value).toEqual({
      type: 'warning',
      message:
        'Streaming landscape only: Twitch refused relay Dual Format (Your GPU is not supported). Dual Format is tried again on the next live.',
    });
    ctl.abort();
  });

  it('dualFormatFallbackWarning strips the rejection wrapper', () => {
    expect(
      dualFormatFallbackWarning(
        'Twitch rejected relay Dual Format: Your broadcast software (ctd-multi-stream) did not send GPU Information. Use "OBS sends Dual Format directly" instead.',
      ),
    ).toBe(
      'Streaming landscape only: Twitch refused relay Dual Format (Your broadcast software (ctd-multi-stream) did not send GPU Information). Dual Format is tried again on the next live.',
    );
  });
});

describe('setTitleOffline', () => {
  it('patches only the title and skips empty titles', async () => {
    const calls = stubFetch({
      [routes.validate]: VALIDATE_OK,
      [routes.channels]: () => new Response(null, { status: 204 }),
    });
    const { ctx, secrets } = makeCtx();
    await secrets.setJson('oauth', tokens());
    await twitchDriver.setTitleOffline!(dest(), account, 'Offline title', ctx);
    await twitchDriver.setTitleOffline!(dest(), account, '', ctx);
    const patches = byRoute(calls, routes.channels);
    expect(patches).toHaveLength(1);
    expect(JSON.parse(patches[0]!.body)).toEqual({ title: 'Offline title' });
  });

  it('maps a 401 with a mismatched Client ID to needs-login', async () => {
    stubFetch({
      [routes.validate]: VALIDATE_OK,
      [routes.channels]: () => json(401, { status: 401, message: 'Client ID and OAuth token do not match' }),
    });
    const { ctx, secrets } = makeCtx();
    await secrets.setJson('oauth', tokens());
    await expect(twitchDriver.setTitleOffline!(dest(), account, 'x', ctx)).rejects.toMatchObject({
      code: 'needs-login',
      message: expect.stringMatching(/different Client ID/),
    });
  });
});
