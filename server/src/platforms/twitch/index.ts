// Twitch driver: device-code login (public client), title + stream key + viewer count over Helix,
// anonymous IRC chat (with moderation and alerts) plus follow alerts over EventSub, and three Dual Format modes (relay one feed / OBS
// direct / Relay encodes both feeds as Enhanced Broadcasting tracks, multitrack.ts). Session test mode streams as a bandwidth test and leaves
// the (public) channel title alone; it can't reach OBS's own output in "OBS direct" mode, so that
// destination carries a warning on its card instead.

import type { ConnectPoll, ConnectStart } from '../../../../shared/api.js';
import type { Account, Destination, Feed, PlatformInfo } from '../../../../shared/types.js';
import { PlatformHttpError, truncateTitle } from '../common/http.js';
import { pollDeviceToken, saveTokens, startDeviceFlow } from '../common/oauth.js';
import {
  DriverError,
  type DriverContext,
  type LiveHealthEvent,
  type PlatformDriver,
  type PreparedLive,
  type PushPlan,
} from '../types.js';
import {
  canReadFollows,
  CONNECT_SCOPES,
  DEVICE_ENDPOINT,
  FOLLOWS_RECONNECT_HINT,
  forgetValidation,
  missingScopes,
  TITLE_MAX,
  toDriverError,
  TOKEN_ENDPOINT,
  TwitchClient,
  type TokenInfo,
} from './api.js';
import { readTwitchChat } from './chat.js';
import { readTwitchEvents, withSideSource } from './eventsub.js';
import { prepareMultitrack } from './multitrack.js';
import { pollViewers } from './viewers.js';
import {
  buildIngestUrl,
  DEFAULT_INGEST,
  DEFAULT_LANDSCAPE_FORMAT,
  DEFAULT_VERTICAL_FORMAT,
  readOptions,
  type TwitchDestinationOptions,
} from './options.js';

/** Pending device authorization, stored encrypted at account key 'device'. */
interface DeviceState {
  deviceCode: string;
  clientId: string;
  expiresAt: number;
  interval: number;
}

const APP_MISSING = 'Set up the Twitch developer app in Settings → Developer apps';

export const twitchInfo: PlatformInfo = {
  id: 'twitch',
  name: 'Twitch',
  feeds: ['landscape', 'vertical'],
  defaultFeed: 'landscape',
  connectMethod: 'device-code',
  accountFields: [],
  destinationFields: [
    {
      key: 'dualFormat',
      label: 'Dual Format',
      type: 'select',
      target: 'option',
      default: 'off',
      options: [
        { value: 'off', label: "Relay one feed (this destination's feed)" },
        { value: 'obs-direct', label: 'OBS sends Dual Format directly (app manages title + chat only)' },
        { value: 'relay-multitrack', label: 'Relay both feeds as Dual Format (Relay encodes them)' },
      ],
      help: 'Dual Format shows viewers a landscape and a vertical version of your stream. See the notes below.',
    },
    {
      key: 'ingestServer',
      label: 'Ingest server',
      type: 'url',
      target: 'option',
      placeholder: DEFAULT_INGEST,
      help: "Optional. Leave empty for Twitch's recommended global ingest. To override, paste an rtmp:// or rtmps:// server from https://ingest.twitch.tv/ingests (a trailing /{stream_key} is removed).",
    },
    {
      key: 'bandwidthTest',
      label: 'Bandwidth test (stream without going live)',
      type: 'boolean',
      target: 'option',
      default: false,
      help: 'Sends video to Twitch with ?bandwidthtest=true: nobody sees it and followers are not notified. Turn it off for real streams.',
    },
    {
      key: 'landscapeFormat',
      label: 'Landscape feed format (relay Dual Format only)',
      type: 'text',
      target: 'option',
      placeholder: DEFAULT_LANDSCAPE_FORMAT,
      help: 'Only used by "Relay both feeds": the resolution and frame rate OBS sends on the landscape feed, e.g. 1920x1080@60. Twitch picks the tracks from it; Relay scales the feed to them.',
    },
    {
      key: 'verticalFormat',
      label: 'Vertical feed format (relay Dual Format only)',
      type: 'text',
      target: 'option',
      placeholder: DEFAULT_VERTICAL_FORMAT,
      help: 'Only used by "Relay both feeds": the resolution and frame rate of the Aitum Vertical feed, e.g. 1080x1920@60.',
    },
  ],
  developerApp: {
    consoleUrl: 'https://dev.twitch.tv/console/apps',
    fields: [
      {
        key: 'clientId',
        label: 'Client ID',
        type: 'text',
        required: true,
        placeholder: 'e.g. abcdefghijklmnopqrstuvwxyz0123',
        help: 'From your app on dev.twitch.tv → Manage. No client secret is needed.',
      },
    ],
    instructions: [
      '1. Turn on two-factor authentication on your Twitch account (the developer console requires it).',
      '2. Open https://dev.twitch.tv/console/apps and click "Register Your Application".',
      '3. Name: anything unique, e.g. "CTD Relay <your name>".',
      '4. OAuth Redirect URLs: http://localhost (the form requires one; it is not used because the app signs in with a device code).',
      '5. Category: Broadcaster Suite.',
      '6. Client Type: Public.',
      '7. Click Create, then Manage, and copy the Client ID here.',
    ].join('\n'),
  },
  titleSupport: 'api',
  chatSupport: 'api',
  keyPerSession: false,
  experimental: false,
  notes: [
    'Dual Format: "Relay one feed" sends this destination\'s feed as a normal Twitch stream.',
    '"OBS sends Dual Format directly": OBS streams to Twitch itself with Enhanced Broadcasting and the Aitum Vertical canvas; this app sends no video to Twitch and only keeps the title in sync and reads chat.',
    '"Relay both feeds": Relay asks Twitch\'s Enhanced Broadcasting service for a configuration and encodes what it asks for on this server: two tracks per feed (e.g. 1080p60 and 360p30 of each), Twitch\'s minimum for Dual Format, about 12 Mbps of upload and a good share of the CPU. When Twitch refuses, the destination streams the landscape feed alone (with a warning on its card) instead of staying down.',
    'Bandwidth test streams without going live. Sign-ins expire after about 30 days without use.',
  ].join(' '),
  testMode: {
    supported: true,
    description:
      'Bandwidth test — Twitch receives the stream but nobody sees it, and the channel title is left unchanged. Not private with "OBS sends Dual Format directly": OBS streams to Twitch itself, publicly.',
  },
};

/**
 * Shown on an "OBS direct" destination's card while test mode is on: the video never passes through
 * this app, so the bandwidth test can't apply to it.
 */
export const OBS_DIRECT_TEST_WARNING =
  "Not private: OBS streams to Twitch itself, so test mode can't hide it. Stop OBS's own Twitch output for a private rehearsal.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireClientId(ctx: DriverContext): string {
  const clientId = ctx.app?.clientId?.trim();
  if (!clientId) throw new DriverError(APP_MISSING, 'misconfigured');
  return clientId;
}

/** `signal: null` = no caller signal (calls are still bounded by fetch timeouts). */
function makeClient(ctx: DriverContext, account: Account | null, signal: AbortSignal | null = ctx.signal): TwitchClient {
  if (!account || !ctx.accountSecrets) {
    throw new DriverError('No Twitch account linked to this destination — pick one in Destinations', 'not-connected');
  }
  const clientId = requireClientId(ctx);
  return new TwitchClient({
    clientId,
    accountId: account.id,
    secrets: ctx.accountSecrets,
    log: ctx.log,
    ...(signal ? { signal } : {}),
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAuthProblem(err: unknown): boolean {
  return err instanceof DriverError && ['needs-login', 'not-connected', 'misconfigured'].includes(err.code);
}

function isTransient(err: unknown): boolean {
  if (err instanceof PlatformHttpError) return err.status >= 500 || err.status === 429;
  if (err instanceof Error && err.name === 'TimeoutError') return true;
  return err instanceof TypeError; // fetch network failure
}

/** Validate (hourly) and keep the account's userId/login in sync with Twitch. */
async function identity(client: TwitchClient, ctx: DriverContext, account: Account): Promise<TokenInfo> {
  const info = await client.validate();
  const missing = missingScopes(info);
  if (missing.length > 0) {
    throw new DriverError(`Reconnect the Twitch account in Accounts to grant: ${missing.join(', ')}`, 'needs-login');
  }
  if (account.options.userId !== info.userId || account.options.login !== info.login) {
    try {
      await ctx.updateAccount({ options: { ...account.options, userId: info.userId, login: info.login } });
    } catch (err) {
      ctx.log.warn({ accountId: account.id, error: message(err) }, 'twitch: saving the channel identity failed');
    }
  }
  return info;
}

/** Set the channel title (only the title). Empty titles are skipped: Twitch rejects them. */
async function applyTitle(client: TwitchClient, broadcasterId: string, title: string): Promise<boolean> {
  const t = truncateTitle(title, TITLE_MAX);
  if (!t) return false;
  await client.setTitle(broadcasterId, t);
  return true;
}

/** `options` with session test mode applied: test mode always streams as a bandwidth test. */
function effectiveOptions(options: TwitchDestinationOptions, ctx: DriverContext): TwitchDestinationOptions {
  return ctx.testMode === true && !options.bandwidthTest ? { ...options, bandwidthTest: true } : options;
}

/** `events` preceded by a standing warning (the viewer watcher never yields 'ok', so it stays). */
async function* warnFirst(
  message: string,
  events: AsyncIterable<LiveHealthEvent>,
  signal: AbortSignal,
): AsyncGenerator<LiveHealthEvent, void, undefined> {
  if (signal.aborted) return;
  yield { type: 'warning', message };
  yield* events;
}

/** The card warning while "Relay both feeds" falls back to the landscape feed alone. */
export function dualFormatFallbackWarning(reason: string): string {
  const why = reason.replace(/^Twitch rejected relay Dual Format:\s*/, '').replace(/\s*Use "OBS sends Dual Format directly" instead\.?$/, '');
  return `Streaming landscape only: Twitch refused relay Dual Format (${why.replace(/[\s.]+$/, '')}). Dual Format is tried again on the next live.`;
}

async function pushPlan(
  dest: Destination,
  options: TwitchDestinationOptions,
  client: TwitchClient,
  info: TokenInfo,
  ctx: DriverContext,
): Promise<{ plan: PushPlan | null; warning: string | null }> {
  if (options.dualFormat === 'obs-direct') return { plan: null, warning: null };
  let key: string;
  try {
    key = await client.streamKey(info.userId);
  } catch (err) {
    throw toDriverError(err, 'the stream key request');
  }
  const single = (feed: Feed): PushPlan => ({
    url: buildIngestUrl(options.ingestServer ?? DEFAULT_INGEST, key, options.bandwidthTest),
    mode: 'copy',
    feeds: [feed],
  });
  if (options.dualFormat === 'relay-multitrack') {
    try {
      const plan = await prepareMultitrack(
        {
          streamKey: key,
          landscape: options.landscapeFormat,
          vertical: options.verticalFormat,
          ingestServer: options.ingestServer,
          bandwidthTest: options.bandwidthTest,
        },
        ctx.signal,
        (warning) => ctx.log.warn({ destinationId: dest.id, warning }, 'twitch: Enhanced Broadcasting warning'),
      );
      return { plan, warning: null };
    } catch (err) {
      if (!(err instanceof DriverError)) throw err; // aborts
      // Twitch refused (or its config service is unreachable): stay on air with a normal stream of
      // the main canvas instead of leaving Twitch down. Retried as Dual Format on the next live.
      ctx.log.warn({ destinationId: dest.id, error: err.message }, 'twitch: relay Dual Format refused; streaming landscape only');
      return { plan: single('landscape'), warning: dualFormatFallbackWarning(err.message) };
    }
  }
  return { plan: single(dest.feed), warning: null };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export const twitchDriver: PlatformDriver = {
  info: twitchInfo,

  requiredFeeds(dest: Destination): Feed[] {
    const { dualFormat } = readOptions(dest).options;
    if (dualFormat === 'relay-multitrack') return ['landscape', 'vertical'];
    if (dualFormat === 'obs-direct') return []; // no video from us: live as soon as the session starts
    return [dest.feed];
  },

  // ---- account connection: OAuth device code grant ----

  async startConnect(account: Account, ctx: DriverContext): Promise<ConnectStart> {
    const clientId = requireClientId(ctx);
    const secrets = ctx.accountSecrets;
    if (!secrets) throw new DriverError('Account storage is unavailable', 'platform-error');
    let start;
    try {
      start = await startDeviceFlow({
        endpoint: DEVICE_ENDPOINT,
        clientId,
        scopes: [...CONNECT_SCOPES],
        scopeParam: 'scopes', // Twitch uses `scopes`, not RFC 8628's `scope`
        signal: ctx.signal,
      });
    } catch (err) {
      if (err instanceof PlatformHttpError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw new DriverError(
          'Twitch rejected the Client ID. Check Settings → Developer apps: copy the Client ID of an app whose Client Type is Public.',
          'misconfigured',
        );
      }
      throw toDriverError(err, 'the sign-in request');
    }
    const state: DeviceState = {
      deviceCode: start.deviceCode,
      clientId,
      expiresAt: Date.now() + start.expiresIn * 1000,
      interval: start.interval,
    };
    await secrets.setJson('device', state);
    ctx.log.info({ accountId: account.id }, 'twitch: device authorization started');
    return {
      method: 'device-code',
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      ...(start.verificationUriComplete ? { verificationUriComplete: start.verificationUriComplete } : {}),
      expiresIn: start.expiresIn,
      interval: start.interval,
    };
  },

  async pollConnect(account: Account, ctx: DriverContext): Promise<ConnectPoll> {
    const secrets = ctx.accountSecrets;
    if (!secrets) throw new DriverError('Account storage is unavailable', 'platform-error');
    const state = await secrets.getJson<DeviceState>('device');
    if (!state?.deviceCode) return { status: 'expired' };
    const clientId = requireClientId(ctx);
    if (state.clientId !== clientId || Date.now() >= state.expiresAt) {
      await secrets.delete('device');
      return { status: 'expired' };
    }

    let result;
    try {
      result = await pollDeviceToken({
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId,
        deviceCode: state.deviceCode,
        extraParams: { scopes: CONNECT_SCOPES.join(' ') },
        signal: ctx.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      if (isTransient(err)) {
        ctx.log.warn({ accountId: account.id, error: message(err) }, 'twitch: device token poll failed; will retry');
        return { status: 'pending' };
      }
      await secrets.delete('device');
      if (err instanceof PlatformHttpError) {
        const detail = toDriverError(err, 'the sign-in');
        return { status: 'error', message: `${message(detail)}. Check that the Twitch app's Client Type is Public.` };
      }
      return { status: 'error', message: message(toDriverError(err, 'the sign-in')) };
    }

    switch (result.status) {
      case 'pending':
      case 'slow_down':
        return { status: 'pending' };
      case 'expired':
        await secrets.delete('device');
        return { status: 'expired' };
      case 'denied':
        await secrets.delete('device');
        return { status: 'error', message: 'Access was denied on Twitch. Click Connect to try again.' };
      case 'ok':
        break;
    }

    // Store the tokens before anything else: the device code is single-use.
    await saveTokens(secrets, result.tokens);
    await secrets.delete('device');
    forgetValidation(account.id);

    try {
      const client = makeClient(ctx, account);
      const info = await client.validate(true);
      const missing = missingScopes(info);
      if (missing.length > 0) {
        return { status: 'error', message: `Twitch did not grant: ${missing.join(', ')}. Click Connect and approve every permission.` };
      }
      let label = info.login;
      try {
        label = (await client.displayName(info.userId)) ?? info.login;
      } catch (err) {
        ctx.log.warn({ accountId: account.id, error: message(err) }, 'twitch: reading the display name failed');
      }
      const options = { ...account.options, userId: info.userId, login: info.login };
      await ctx.updateAccount({ label, status: 'connected', statusMessage: null, options });
      ctx.log.info({ accountId: account.id, login: info.login }, 'twitch: account connected');
      return { status: 'connected', account: { ...account, label, status: 'connected', statusMessage: null, options } };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      return { status: 'error', message: message(toDriverError(err, 'the new login')) };
    }
  },

  async checkAccount(account: Account, ctx: DriverContext) {
    const client = makeClient(ctx, account);
    try {
      const info = await client.validate(true);
      const missing = missingScopes(info);
      if (missing.length > 0) {
        return { status: 'needs-login' as const, message: `Reconnect to grant: ${missing.join(', ')}` };
      }
      await identity(client, ctx, account);
      let label: string | null = null;
      try {
        label = await client.displayName(info.userId);
      } catch (err) {
        ctx.log.warn({ accountId: account.id, error: message(err) }, 'twitch: reading the display name failed');
      }
      return {
        status: 'connected' as const,
        ...(label ? { label } : {}),
        ...(canReadFollows(info) ? {} : { message: FOLLOWS_RECONNECT_HINT }),
      };
    } catch (err) {
      const e = toDriverError(err, 'the login check');
      if (e instanceof DriverError && (e.code === 'needs-login' || e.code === 'not-connected')) {
        return { status: 'needs-login' as const, message: e.message };
      }
      throw e;
    }
  },

  // ---- destination ----

  async validateDestination(dest: Destination): Promise<string[]> {
    return readOptions(dest).problems;
  },

  async setTitleOffline(dest: Destination, account: Account | null, title: string, ctx: DriverContext): Promise<void> {
    if (!truncateTitle(title, TITLE_MAX)) return;
    const client = makeClient(ctx, account);
    try {
      const info = await identity(client, ctx, account!);
      await applyTitle(client, info.userId, title);
    } catch (err) {
      throw toDriverError(err, 'the title');
    }
  },

  async prepare(dest: Destination, account: Account | null, title: string, ctx: DriverContext): Promise<PreparedLive> {
    const parsed = readOptions(dest);
    if (parsed.problems.length > 0) throw new DriverError(parsed.problems.join('; '), 'misconfigured');
    const options = effectiveOptions(parsed.options, ctx);
    const testMode = ctx.testMode === true;
    // Test mode can't reach OBS's own Twitch output: warn here and on the destination card (health).
    const publicInTest = testMode && options.dualFormat === 'obs-direct';
    if (publicInTest) {
      ctx.log.warn(
        { destinationId: dest.id },
        'twitch: test mode does not affect "OBS sends Dual Format directly" — OBS streams to Twitch itself, publicly',
      );
    }
    const client = makeClient(ctx, account);
    try {
      const info = await identity(client, ctx, account!);

      if (testMode) {
        // The channel title is public even during a bandwidth test: a rehearsal leaves it alone.
        ctx.log.info({ destinationId: dest.id }, 'twitch: test mode leaves the channel title unchanged');
      } else {
        // The title is not essential to go live: log and continue unless the login itself is broken.
        try {
          await applyTitle(client, info.userId, title);
        } catch (err) {
          const e = toDriverError(err, 'the title');
          if (isAuthProblem(e) || (err instanceof Error && err.name === 'AbortError')) throw e;
          ctx.log.warn({ destinationId: dest.id, error: message(e) }, 'twitch: setting the title failed; continuing');
        }
      }

      const { plan: push, warning: fallbackWarning } = await pushPlan(dest, options, client, info, ctx);
      const standingWarning = publicInTest ? OBS_DIRECT_TEST_WARNING : fallbackWarning;
      ctx.log.info(
        { destinationId: dest.id, mode: fallbackWarning ? 'landscape-fallback' : options.dualFormat, bandwidthTest: options.bandwidthTest, testMode },
        'twitch: live prepared',
      );

      // The live outlives prepare's signal: later calls rely on fetch timeouts instead.
      const liveClient = makeClient(ctx, account, null);
      const login = info.login;
      const broadcasterId = info.userId;
      return {
        push,
        watchUrl: `https://www.twitch.tv/${login}`,
        async setTitle(next: string): Promise<void> {
          if (testMode) {
            ctx.log.info({ destinationId: dest.id }, 'twitch: test mode leaves the channel title unchanged');
            return;
          }
          try {
            const current = await liveClient.validate(); // hourly validation while live
            await applyTitle(liveClient, current.userId, next);
          } catch (err) {
            throw toDriverError(err, 'the title');
          }
        },
        // IRC chat, plus follow alerts over EventSub when the login allows them (they can't come from IRC).
        chat: (signal: AbortSignal) => {
          const irc = (s: AbortSignal) => readTwitchChat(login, s, { log: ctx.log });
          if (!canReadFollows(info)) return irc(signal);
          const events = (s: AbortSignal) =>
            readTwitchEvents(
              { broadcasterId, subscribe: (sessionId, sub) => liveClient.subscribeEventSub(sessionId, sub, s), log: ctx.log },
              s,
            );
          return withSideSource(irc, events, signal, ctx.log);
        },
        // Viewers only (GET /helix/streams every 30 s); never 'ended': Twitch lives aren't recovered.
        // validate() is cached for an hour: it keeps up Twitch's hourly validation during long lives.
        health: (signal: AbortSignal) => {
          const viewers = pollViewers(
            async (s) => {
              await liveClient.validate();
              return liveClient.viewerCount(broadcasterId, s);
            },
            signal,
            { log: ctx.log, logContext: { destinationId: dest.id, platform: 'twitch' } },
          );
          return standingWarning ? warnFirst(standingWarning, viewers, signal) : viewers;
        },
        // No end(): a Twitch stream ends when the video stops.
      };
    } catch (err) {
      throw toDriverError(err, 'the request');
    }
  },
};
