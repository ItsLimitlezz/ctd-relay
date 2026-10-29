// Twitch OAuth (device code grant, public client) + Helix calls used by the driver.
//
// Docs (checked Oct 2026):
// - Device code grant: https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow
//   POST id.twitch.tv/oauth2/device (client_id, scopes) and POST id.twitch.tv/oauth2/token
//   (client_id, scopes, device_code, grant_type). Errors are HTTP 400 with {"message":"authorization_pending"}
//   or {"message":"invalid device code"}.
// - Refresh: https://dev.twitch.tv/docs/authentication/refresh-tokens/ — public clients send no secret;
//   refresh tokens may change (store the new one) and expire 30 days after they were issued.
// - Validate: https://dev.twitch.tv/docs/authentication/validate-tokens/ — "Authorization: OAuth <token>";
//   apps must validate tokens at start-up and hourly afterwards.
// - Helix: https://dev.twitch.tv/docs/api/reference/#modify-channel-information (title ≤ 140 chars, not empty),
//   #get-stream-key, #get-users, #get-streams (viewer_count; empty `data` while not live).

import type { Logger } from 'pino';
import type { ScopedSecrets } from '../../services.js';
import { fetchJson, PlatformHttpError } from '../common/http.js';
import { getValidTokens, loadTokens, refreshTokens, saveTokens, type OAuthTokens } from '../common/oauth.js';
import { DriverError } from '../types.js';

export const DEVICE_ENDPOINT = 'https://id.twitch.tv/oauth2/device';
export const TOKEN_ENDPOINT = 'https://id.twitch.tv/oauth2/token';
export const VALIDATE_ENDPOINT = 'https://id.twitch.tv/oauth2/validate';
export const HELIX = 'https://api.twitch.tv/helix';

/** Edit the title + read the stream key. Chat is read anonymously, so no chat scope. */
export const SCOPES = ['channel:manage:broadcast', 'channel:read:stream_key'] as const;
/**
 * Asked for on connect but not required: follow alerts (EventSub channel.follow). Accounts
 * connected before follows existed keep working without it until they reconnect.
 */
export const ALERT_SCOPES = ['moderator:read:followers'] as const;
/** Everything a (re)connect asks Twitch for. */
export const CONNECT_SCOPES = [...SCOPES, ...ALERT_SCOPES] as const;

export const TITLE_MAX = 140;
const VALIDATE_EVERY_MS = 60 * 60 * 1000;
const PLATFORM = 'Twitch';

export interface TokenInfo {
  clientId: string;
  userId: string;
  login: string;
  scopes: string[];
}

export function missingScopes(info: Pick<TokenInfo, 'scopes'>): string[] {
  return SCOPES.filter((s) => !info.scopes.includes(s));
}

/** True when the login may read follows (EventSub channel.follow). */
export function canReadFollows(info: Pick<TokenInfo, 'scopes'>): boolean {
  return ALERT_SCOPES.every((s) => info.scopes.includes(s));
}

/** Shown on the account when it predates follow alerts. */
export const FOLLOWS_RECONNECT_HINT = 'Reconnect this account to turn on follow alerts.';

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : '';
}

/** Twitch's `message` from an error body, if any. */
function bodyMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { message?: unknown };
    return typeof j.message === 'string' ? j.message.slice(0, 200) : '';
  } catch {
    return '';
  }
}

/**
 * Map a failure of a Twitch call to a user-facing DriverError. `what` completes
 * "Twitch rejected ..." (e.g. "the title"). Aborts (our signal) pass through untouched.
 */
export function toDriverError(err: unknown, what: string): unknown {
  if (err instanceof DriverError) return err;
  if (errorName(err) === 'AbortError') return err;
  if (errorName(err) === 'TimeoutError') return new DriverError('Twitch did not respond in time. Try again.', 'timeout');
  if (err instanceof PlatformHttpError) {
    const msg = bodyMessage(err.body);
    if (err.status === 401) {
      if (/scope/i.test(msg)) {
        return new DriverError('The Twitch account is missing a permission — reconnect it in Accounts', 'needs-login');
      }
      if (/client id/i.test(msg)) {
        return new DriverError(
          'The Twitch account was connected with a different Client ID — reconnect it in Accounts',
          'needs-login',
        );
      }
      return new DriverError('Twitch login expired — reconnect the account in Accounts', 'needs-login');
    }
    if (err.status === 403) {
      return new DriverError(`Twitch refused ${what}${msg ? `: ${msg}` : ''}`, 'not-eligible');
    }
    if (err.status === 429) return new DriverError('Twitch rate limit reached. Try again in a minute.', 'platform-error');
    if (err.status >= 500) return new DriverError(`Twitch is having problems (HTTP ${err.status}). Try again later.`, 'platform-error');
    return new DriverError(`Twitch rejected ${what}${msg ? `: ${msg}` : ` (HTTP ${err.status})`}`, 'platform-error');
  }
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  const reason = typeof cause === 'string' ? cause : err instanceof Error ? err.message : 'unknown error';
  return new DriverError(`Couldn't reach Twitch (${reason.slice(0, 120)})`, 'platform-error');
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Recent successful validations per account (Twitch asks for hourly validation). */
const validated = new Map<string, { accessToken: string; at: number; info: TokenInfo }>();
/**
 * Token loads/refreshes in flight per account. Refresh tokens can change on every refresh, so two
 * destinations of one account must never refresh in parallel. (common/oauth.ts dedupes per
 * ScopedSecrets object, but every DriverContext gets a new one.)
 */
const loading = new Map<string, Promise<OAuthTokens>>();
/** Forced refreshes in flight per account (after a 401). */
const forced = new Map<string, Promise<OAuthTokens>>();

/** Share one in-flight promise per account key in `map`. */
function shared(map: Map<string, Promise<OAuthTokens>>, key: string, run: () => Promise<OAuthTokens>): Promise<OAuthTokens> {
  const existing = map.get(key);
  if (existing) return existing;
  const p = run().finally(() => {
    if (map.get(key) === p) map.delete(key);
  });
  map.set(key, p);
  return p;
}

const settle = (p: Promise<unknown> | undefined): Promise<unknown> => (p ? p.catch(() => undefined) : Promise.resolve());

export interface TwitchClientOptions {
  clientId: string;
  accountId: string;
  secrets: ScopedSecrets;
  log: Logger;
  signal?: AbortSignal;
}

export class TwitchClient {
  constructor(private readonly opts: TwitchClientOptions) {}

  private refresh(refreshToken: string, previous: OAuthTokens | null): Promise<OAuthTokens> {
    return refreshTokens({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: this.opts.clientId,
      refreshToken,
      previous,
      signal: this.opts.signal,
    });
  }

  /** Stored tokens, refreshed when they expire within 5 minutes. */
  async tokens(): Promise<OAuthTokens> {
    const { secrets, accountId } = this.opts;
    await settle(forced.get(accountId));
    return shared(loading, accountId, () => getValidTokens(secrets, PLATFORM, (rt, prev) => this.refresh(rt, prev)));
  }

  /** Refresh now because Twitch rejected `stale` (revoked/expired early). */
  private async forceRefresh(stale: string): Promise<OAuthTokens> {
    const { secrets, accountId } = this.opts;
    await settle(loading.get(accountId));
    return shared(forced, accountId, async () => {
      const current = await loadTokens(secrets);
      if (!current) throw new DriverError('Twitch account is not connected — connect it in Accounts', 'not-connected');
      if (current.accessToken !== stale) return current; // someone refreshed meanwhile
      if (!current.refreshToken) throw new DriverError('Twitch login expired — reconnect the account in Accounts', 'needs-login');
      try {
        const fresh = await this.refresh(current.refreshToken, current);
        await saveTokens(secrets, fresh);
        this.opts.log.info({ accountId: this.opts.accountId }, 'twitch: access token refreshed after a 401');
        return fresh;
      } catch (err) {
        if (err instanceof PlatformHttpError && (err.status === 400 || err.status === 401)) {
          throw new DriverError('Twitch login expired — reconnect the account in Accounts', 'needs-login');
        }
        throw err;
      }
    });
  }

  /** Run `call` with a valid access token; on 401 refresh once and retry. */
  async authed<T>(call: (accessToken: string) => Promise<T>): Promise<T> {
    const tokens = await this.tokens();
    try {
      return await call(tokens.accessToken);
    } catch (err) {
      if (!(err instanceof PlatformHttpError) || err.status !== 401 || /scope|client id/i.test(bodyMessage(err.body))) throw err;
      const fresh = await this.forceRefresh(tokens.accessToken);
      return call(fresh.accessToken);
    }
  }

  private helixHeaders(accessToken: string): Record<string, string> {
    return { 'Client-Id': this.opts.clientId, Authorization: `Bearer ${accessToken}`, accept: 'application/json' };
  }

  /**
   * Validate the token (cached for an hour per account unless `force`). Refreshes on 401.
   * Throws DriverError('needs-login') when the login is gone.
   */
  async validate(force = false): Promise<TokenInfo> {
    const tokens = await this.tokens();
    const cached = validated.get(this.opts.accountId);
    if (!force && cached && cached.accessToken === tokens.accessToken && Date.now() - cached.at < VALIDATE_EVERY_MS) {
      return cached.info;
    }
    let accessToken = tokens.accessToken;
    let info = await validateToken(accessToken, this.opts.signal);
    if (!info) {
      accessToken = (await this.forceRefresh(accessToken)).accessToken;
      info = await validateToken(accessToken, this.opts.signal);
    }
    if (!info) {
      validated.delete(this.opts.accountId);
      throw new DriverError('Twitch login expired — reconnect the account in Accounts', 'needs-login');
    }
    if (info.clientId && info.clientId !== this.opts.clientId) {
      throw new DriverError('The Twitch account was connected with a different Client ID — reconnect it in Accounts', 'needs-login');
    }
    validated.set(this.opts.accountId, { accessToken, at: Date.now(), info });
    return info;
  }

  async displayName(userId: string): Promise<string | null> {
    const json = await this.authed((token) =>
      fetchJson<{ data?: { id?: string; login?: string; display_name?: string }[] }>(
        `${HELIX}/users?id=${encodeURIComponent(userId)}`,
        { headers: this.helixHeaders(token), signal: this.opts.signal },
      ),
    );
    const user = json?.data?.[0];
    return user?.display_name?.trim() || user?.login?.trim() || null;
  }

  /** PATCH the channel title — only the title, never category/game/tags. */
  async setTitle(broadcasterId: string, title: string): Promise<void> {
    await this.authed((token) =>
      fetchJson<unknown>(`${HELIX}/channels?broadcaster_id=${encodeURIComponent(broadcasterId)}`, {
        method: 'PATCH',
        headers: { ...this.helixHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
        signal: this.opts.signal,
      }),
    );
  }

  /**
   * Current viewers of the channel's live stream (GET /helix/streams?user_id=). Null while the
   * stream isn't listed yet (Twitch takes a minute or two after going live) or isn't live.
   */
  async viewerCount(broadcasterId: string, signal?: AbortSignal): Promise<number | null> {
    const json = await this.authed((token) =>
      fetchJson<{ data?: { type?: string; viewer_count?: unknown }[] }>(
        `${HELIX}/streams?user_id=${encodeURIComponent(broadcasterId)}`,
        { headers: this.helixHeaders(token), signal: signal ?? this.opts.signal },
      ),
    );
    const stream = json?.data?.[0];
    if (!stream || (stream.type && stream.type !== 'live')) return null;
    const n = stream.viewer_count;
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
  }

  /** POST /helix/eventsub/subscriptions on a WebSocket session (202; 409 = it already exists). */
  async subscribeEventSub(sessionId: string, sub: { type: string; version: string; condition: Record<string, string> }, signal?: AbortSignal): Promise<void> {
    await this.authed((token) =>
      fetchJson<unknown>(`${HELIX}/eventsub/subscriptions`, {
        method: 'POST',
        headers: { ...this.helixHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ ...sub, transport: { method: 'websocket', session_id: sessionId } }),
        signal: signal ?? this.opts.signal,
      }),
    );
  }

  async streamKey(broadcasterId: string): Promise<string> {
    const json = await this.authed((token) =>
      fetchJson<{ data?: { stream_key?: string }[] }>(
        `${HELIX}/streams/key?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
        { headers: this.helixHeaders(token), signal: this.opts.signal },
      ),
    );
    const key = json?.data?.[0]?.stream_key?.trim();
    if (!key) throw new DriverError('Twitch did not return a stream key for this channel', 'platform-error');
    return key;
  }
}

/** GET /oauth2/validate. Returns null when Twitch says the token is invalid (401). */
export async function validateToken(accessToken: string, signal?: AbortSignal): Promise<TokenInfo | null> {
  try {
    const json = await fetchJson<{ client_id?: string; login?: string; user_id?: string; scopes?: string[] | null }>(
      VALIDATE_ENDPOINT,
      { headers: { Authorization: `OAuth ${accessToken}`, accept: 'application/json' }, signal },
    );
    if (!json?.user_id || !json.login) throw new DriverError('Twitch returned a token without a user — reconnect the account', 'needs-login');
    return {
      clientId: json.client_id ?? '',
      userId: json.user_id,
      login: json.login.toLowerCase(),
      scopes: Array.isArray(json.scopes) ? json.scopes : [],
    };
  } catch (err) {
    if (err instanceof PlatformHttpError && err.status === 401) return null;
    throw err;
  }
}

/** Forget cached validations (tests, or after an account reconnects). */
export function forgetValidation(accountId?: string): void {
  if (accountId) validated.delete(accountId);
  else validated.clear();
}
