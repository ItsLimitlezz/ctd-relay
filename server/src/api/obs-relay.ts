// OBS socket relay (docs/API.md §12, docs/LIVE-MOBILE-INTEGRATION.md): CTD Live mobile controls OBS
// from anywhere — the same Wi-Fi or mobile data — through Relay instead of reaching OBS directly.
//
//   phone ──wss /api/v1/obs/socket + token──▶ Relay ──ws + OBS's password──▶ OBS :4455 (LAN)
//
// The phone signs in with its token (scope obs:control) before the upgrade. Relay then opens OBS's
// WebSocket with OBS's password, which never leaves the server, and passes obs-websocket 5 through
// unchanged both ways. The only edits: the Hello the phone gets has no authentication challenge,
// and Relay answers OBS's challenge when it forwards the phone's Identify.

import crypto from 'node:crypto';
import type { Logger } from 'pino';
import WebSocket, { type RawData } from 'ws';
import type { ObsRelayStatus, ObsRelayTestResult } from '../../../shared/api.js';
import { DEFAULT_PROFILE_ID, type ApiTokenInfo } from '../../../shared/types.js';
import type { AppServices } from '../services.js';

export const OBS_SUBPROTOCOL = 'obswebsocket.json';
export const DEFAULT_OBS_PORT = 4455;
/** Settings key (OBS's address and port) and secrets scope (OBS's password). */
export const OBS_RELAY_SETTINGS_KEY = 'obsRelay';
export const OBS_RELAY_SECRETS_SCOPE = 'obs-relay';
const PASSWORD_KEY = 'password';
/** How long Relay waits to reach OBS and get its Hello (the phone gets Relay's Hello only after that). */
export const OBS_CONNECT_TIMEOUT_MS = 5_000;
/**
 * How long Relay waits for OBS's Identified after forwarding the phone's Identify. OBS answers in
 * milliseconds on a LAN; with OBS_CONNECT_TIMEOUT_MS this keeps the worst case under the 10 s an
 * obs-websocket client waits, so the phone shows Relay's reason rather than its own timeout.
 */
export const OBS_IDENTIFY_TIMEOUT_MS = 3_000;
export const MAX_SOCKETS_PER_TOKEN = 4;
/** Pings both ways, drops sockets silent for IDLE_TIMEOUT_MS and phones whose token was revoked. */
export const MAINTENANCE_INTERVAL_MS = 15_000;
export const IDLE_TIMEOUT_MS = 60_000;
/** A phone this far behind on frames from OBS isn't reading; drop it rather than buffer without end. */
export const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
/** Frames from OBS (screenshots) may be large; the phone's own frames are capped by @fastify/websocket. */
const OBS_MAX_PAYLOAD = 256 * 1024 * 1024;

/** Relay's own close codes sit in 41xx; obs-websocket's are 4000–4012 and pass through as they are. */
export const OBS_RELAY_CLOSE = {
  notConfigured: 4100,
  unreachable: 4101,
  authFailed: 4102,
  obsClosed: 4103,
  /** obs-websocket's SessionInvalidated: the phone's token was revoked. */
  revoked: 4011,
  /** obs-websocket's NotIdentified: the phone sent something other than Identify first. */
  notIdentified: 4007,
  restarting: 1001,
} as const;

// Close reasons are shown to people as they are (≤ 123 bytes, see closeReason).
const NOT_CONFIGURED_TEXT = "CTD Relay doesn't know OBS's address yet: stream to Relay once, or set it in Settings → API.";
const SHARING_OFF_TEXT = "OBS isn't shared with CTD Relay: turn sharing on in OBS's CTD Relay dock, and OBS's WebSocket server.";
const AUTH_FAILED_TEXT = "OBS rejected CTD Relay's OBS password. Fix it in Relay: Settings → API → OBS.";
const NEEDS_PASSWORD_TEXT = 'OBS asks for a password: enter it in CTD Relay, Settings → API → OBS.';
const OBS_CLOSED_TEXT = 'OBS closed the connection (OBS quit or restarted).';
const IDENTIFY_TIMEOUT_TEXT = "OBS didn't answer CTD Relay in time.";
const REVOKED_TEXT = 'This phone was disconnected in CTD Relay. Scan a new code.';
const RESTARTING_TEXT = 'CTD Relay is restarting.';

const OP = { hello: 0, identify: 1, identified: 2, request: 6, requestResponse: 7 } as const;

export interface ObsRelaySettings {
  /** OBS's address set by hand; null = automatic (the plugin's address, else where OBS streams from). */
  host: string | null;
  port: number;
  /** Where OBS last streamed from (the automatic address while OBS isn't streaming). */
  lastSeenHost: string | null;
  /**
   * The CTD OBS plugin's last report (PUT /apps/{appId}/obs-websocket). It counts only while that
   * app is still registered: disconnecting the plugin deletes the app, and with it this share.
   */
  plugin?: PluginShare | null;
  /** Who saved the OBS password: typed in Settings ('manual', the default) or shared by the plugin. */
  passwordFrom?: 'manual' | 'plugin';
}

export interface PluginShare {
  appId: string;
  /**
   * The token that registered the app and made the share. A share counts only while that same token
   * owns the app: a takeover or re-pair (a new token on the same id) never revives it.
   */
  tokenId?: string;
  name: string;
  /** When the plugin last reported. */
  at: string;
  /** False: OBS's WebSocket server is off, or the user stopped sharing it in the plugin: don't connect. */
  enabled: boolean;
  /** The OBS machine's LAN address, or null when the plugin couldn't tell. */
  host: string | null;
}
const DEFAULT_SETTINGS: ObsRelaySettings = { host: null, port: DEFAULT_OBS_PORT, lastSeenHost: null };

/** What the CTD OBS plugin reports about OBS's WebSocket server (PUT /apps/{appId}/obs-websocket). */
export interface PluginWebSocketReport {
  appId: string;
  /** The token that sent the report (it owns the app). */
  tokenId?: string;
  appName: string;
  /** False = OBS's WebSocket server is off, or sharing was turned off in the plugin: forget and don't connect. */
  enabled: boolean;
  port: number;
  authRequired: boolean;
  /** undefined = not sent (keep the saved one); ignored when authRequired is false. */
  password?: string | null;
  /** The OBS machine's LAN address, or null when unknown. */
  host: string | null;
}

export interface ObsTarget {
  host: string;
  port: number;
  password: string | null;
}

export class ObsRelayError extends Error {
  constructor(
    readonly closeCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ObsRelayError';
  }
}

/** obs-websocket 5 authentication: base64(sha256(base64(sha256(password + salt)) + challenge)). */
export function obsAuthString(password: string, salt: string, challenge: string): string {
  const secret = crypto.createHash('sha256').update(password + salt, 'utf8').digest('base64');
  return crypto.createHash('sha256').update(secret + challenge, 'utf8').digest('base64');
}

/** A WebSocket close reason fits in 123 bytes (RFC 6455); cut longer ones on a character boundary. */
export function closeReason(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= 123) return text;
  let s = text;
  while (Buffer.byteLength(s, 'utf8') > 120) s = s.slice(0, -1);
  return `${s}…`;
}

function unreachableText(target: { host: string; port: number }): string {
  return `CTD Relay can't reach OBS at ${target.host}:${target.port}. Is OBS open, with its WebSocket server on?`;
}

type ObsMessage = { op: number; d: Record<string, unknown> };

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function parse(data: RawData): ObsMessage | null {
  try {
    const v = JSON.parse(rawText(data)) as { op?: unknown; d?: unknown } | null;
    if (!v || typeof v !== 'object' || typeof v.op !== 'number') return null;
    return { op: v.op, d: v.d && typeof v.d === 'object' && !Array.isArray(v.d) ? (v.d as Record<string, unknown>) : {} };
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** The Identify OBS gets: the phone's (or Relay's own), with OBS's challenge answered. */
function identifyFor(hello: ObsMessage, password: string | null, d: Record<string, unknown>): string {
  const out: Record<string, unknown> = { ...d };
  delete out.authentication;
  const auth = hello.d.authentication as { challenge?: unknown; salt?: unknown } | undefined;
  if (auth && typeof auth === 'object') {
    if (!password) throw new ObsRelayError(OBS_RELAY_CLOSE.authFailed, NEEDS_PASSWORD_TEXT);
    out.authentication = obsAuthString(password, String(auth.salt ?? ''), String(auth.challenge ?? ''));
  }
  return JSON.stringify({ op: OP.identify, d: out });
}

export type CreateObsSocket = (url: string) => WebSocket;

const createObsSocket: CreateObsSocket = (url) =>
  new WebSocket(url, OBS_SUBPROTOCOL, { handshakeTimeout: OBS_CONNECT_TIMEOUT_MS, maxPayload: OBS_MAX_PAYLOAD, perMessageDeflate: false });

export function obsUrl(target: { host: string; port: number }): string {
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  return `ws://${host}:${target.port}`;
}

/** Opens OBS's WebSocket and resolves with it once OBS's Hello arrived (OBS sends nothing else before Identify). */
export function openObs(target: ObsTarget, create: CreateObsSocket, timeoutMs: number): Promise<{ socket: WebSocket; hello: ObsMessage }> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = create(obsUrl(target));
    } catch {
      reject(new ObsRelayError(OBS_RELAY_CLOSE.unreachable, unreachableText(target)));
      return;
    }
    // Errors after the handshake surface as 'close'; this keeps one from ever being unhandled.
    socket.on('error', () => {});
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    const fail = () => {
      cleanup();
      socket.terminate();
      reject(new ObsRelayError(OBS_RELAY_CLOSE.unreachable, unreachableText(target)));
    };
    const onMessage = (data: RawData) => {
      const msg = parse(data);
      if (msg?.op !== OP.hello) return;
      cleanup();
      resolve({ socket, hello: msg });
    };
    const onClose = () => fail();
    const timer = setTimeout(fail, timeoutMs);
    socket.on('message', onMessage);
    socket.on('close', onClose);
  });
}

export interface ObsRelayDeps {
  createSocket?: CreateObsSocket;
  timeoutMs?: number;
  now?: () => number;
  maintenanceIntervalMs?: number;
  idleTimeoutMs?: number;
}

interface Session {
  tokenId: string;
  phone: WebSocket;
  obs: WebSocket | null;
  phoneSeenAt: number;
  obsSeenAt: number;
  finish(code: number, reason: string): void;
}

export class ObsRelay {
  private readonly sessions = new Set<Session>();
  private readonly log: Logger;
  private readonly create: CreateObsSocket;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly timer: NodeJS.Timeout;

  /** OBS connections (profile:feed:since) whose publisher address was already looked up. */
  private readonly seenFeeds = new Set<string>();

  constructor(
    private readonly services: Pick<AppServices, 'repos' | 'media' | 'log'> & Partial<Pick<AppServices, 'bus' | 'apps'>>,
    deps: ObsRelayDeps = {},
  ) {
    this.log = services.log.child({ mod: 'obs-relay' });
    this.create = deps.createSocket ?? createObsSocket;
    this.timeoutMs = deps.timeoutMs ?? OBS_CONNECT_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
    this.idleTimeoutMs = deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.timer = setInterval(() => this.maintain(), deps.maintenanceIntervalMs ?? MAINTENANCE_INTERVAL_MS);
    this.timer.unref();
    // Remember where OBS streams from whenever a feed comes online, so a phone that connects later,
    // while OBS isn't streaming, still finds it ("stream to Relay once").
    services.bus?.on('feed', (state) => {
      if (!state.online || !state.since) return;
      const key = `${state.profileId ?? DEFAULT_PROFILE_ID}:${state.feed}:${state.since}`;
      if (this.seenFeeds.has(key)) return;
      this.seenFeeds.add(key);
      if (this.seenFeeds.size > 200) this.seenFeeds.delete(this.seenFeeds.values().next().value!);
      void this.detectHost(state.profileId ?? null).catch(() => {});
    });
    // An app removed (DELETE /apps/{id}, token revoked) or taken over by another token: drop its share now.
    services.bus?.on('apps-changed', () => {
      void this.dropStaleShare().catch((err: unknown) => this.log.warn({ err }, 'obs relay: dropping a stale OBS share failed'));
    });
  }

  // ---- settings ----

  settings(): ObsRelaySettings {
    return { ...DEFAULT_SETTINGS, ...this.services.repos.settings.get<Partial<ObsRelaySettings>>(OBS_RELAY_SETTINGS_KEY, {}) };
  }

  private secrets() {
    return this.services.repos.secrets.scoped(OBS_RELAY_SECRETS_SCOPE);
  }

  private async password(): Promise<string | null> {
    return (await this.secrets().get(PASSWORD_KEY)) || null;
  }

  /** `password`: undefined keeps the saved one, '' or null removes it. A password typed here is 'manual'. */
  async configure(input: { host: string | null; port: number; password?: string | null }): Promise<void> {
    const s = this.settings();
    const next: ObsRelaySettings = { ...s, host: input.host, port: input.port };
    if (input.password !== undefined) {
      if (input.password) await this.secrets().set(PASSWORD_KEY, input.password);
      else await this.secrets().delete(PASSWORD_KEY);
      next.passwordFrom = 'manual';
    }
    this.services.repos.settings.set(OBS_RELAY_SETTINGS_KEY, next);
  }

  /** The plugin's share, while the app that made it is still registered to the same token (else null). */
  private activePlugin(s: ObsRelaySettings): PluginShare | null {
    const p = s.plugin ?? null;
    if (!p) return null;
    const apps = this.services.apps;
    if (!apps) return p;
    const app = apps.get(p.appId);
    if (!app) return null;
    return !p.tokenId || app.tokenId === p.tokenId ? p : null;
  }

  /**
   * Drop a share whose app was removed or taken over (DELETE /apps/{id}, a revoked token, a new
   * token on the id), with the password it brought. Runs on every apps change, so nothing stale
   * lingers until the next phone connects.
   */
  async dropStaleShare(): Promise<void> {
    const s = this.settings();
    if (!s.plugin || this.activePlugin(s)) return;
    const dropped = s.plugin;
    const pluginPassword = s.passwordFrom === 'plugin';
    // Settings first (synchronously), so no other report can interleave with a stale copy.
    this.services.repos.settings.set(OBS_RELAY_SETTINGS_KEY, { ...s, plugin: null, ...(pluginPassword ? { passwordFrom: 'manual' as const } : {}) });
    if (pluginPassword) await this.secrets().delete(PASSWORD_KEY);
    this.log.info({ appId: dropped.appId }, 'obs relay: dropped the OBS share of a removed or taken-over app');
    this.services.repos.audit.log({
      userId: null,
      username: null,
      action: 'obs_relay.plugin_share_dropped',
      detail: `OBS WebSocket share from ${dropped.name} (${dropped.appId}) dropped: the app was removed or re-registered by another token${pluginPassword ? '; password forgotten' : ''}`,
    });
  }

  async status(): Promise<ObsRelayStatus> {
    const s = this.settings();
    const plugin = this.activePlugin(s);
    return {
      host: s.host,
      port: s.port,
      hasPassword: (await this.currentPassword(s)) !== null,
      detectedHost: plugin?.host ?? (await this.detectHost(null)),
      sessions: this.sessions.size,
      reportedBy: plugin ? { appId: plugin.appId, name: plugin.name, at: plugin.at } : null,
      serverEnabled: plugin ? plugin.enabled : null,
    };
  }

  /**
   * The saved password, minus one the plugin shared if that plugin is gone (disconnecting it deletes
   * its app, and with it what it shared).
   */
  private async currentPassword(s: ObsRelaySettings): Promise<string | null> {
    if (s.passwordFrom === 'plugin' && !this.activePlugin(s)) {
      await this.secrets().delete(PASSWORD_KEY);
      this.services.repos.settings.set(OBS_RELAY_SETTINGS_KEY, { ...this.settings(), passwordFrom: 'manual' });
      return null;
    }
    return this.password();
  }

  /**
   * The CTD OBS plugin reports OBS's WebSocket settings, so nobody types the password. Port and
   * password follow OBS; an address typed in Settings still wins. `enabled: false` (OBS's server
   * off, or sharing turned off in the plugin) forgets what the plugin shared and stops the relay
   * from connecting. Returns what changed (for the audit log; the plugin repeats itself every few minutes).
   */
  async reportFromPlugin(r: PluginWebSocketReport): Promise<{ changed: string[] }> {
    const s = this.settings();
    const before = this.activePlugin(s);
    const changed: string[] = [];
    const share: PluginShare = {
      appId: r.appId,
      ...(r.tokenId ? { tokenId: r.tokenId } : {}),
      name: r.appName,
      at: new Date(this.now()).toISOString(),
      enabled: r.enabled,
      host: r.enabled ? r.host : null,
    };
    if (!before || before.appId !== r.appId) changed.push(`shared by ${r.appName}`);
    if ((before?.enabled ?? null) !== r.enabled) changed.push(r.enabled ? 'sharing on' : 'sharing off');
    if (r.enabled && (before?.host ?? null) !== share.host) changed.push('address');
    if (r.enabled && s.port !== r.port) changed.push('port');

    const saved = await this.password();
    let passwordFrom = s.passwordFrom;
    const pluginPassword = s.passwordFrom === 'plugin';
    if (!r.enabled || !r.authRequired) {
      // Forget a password the plugin shared; one typed in Settings is the admin's to remove.
      if (pluginPassword && saved !== null) {
        await this.secrets().delete(PASSWORD_KEY);
        passwordFrom = 'manual';
        changed.push('password forgotten');
      }
    } else if (typeof r.password === 'string' && r.password && (r.password !== saved || !pluginPassword)) {
      await this.secrets().set(PASSWORD_KEY, r.password);
      passwordFrom = 'plugin';
      if (r.password !== saved) changed.push('password');
    }
    this.services.repos.settings.set(OBS_RELAY_SETTINGS_KEY, {
      ...s,
      ...(r.enabled ? { port: r.port } : {}),
      plugin: share,
      ...(passwordFrom ? { passwordFrom } : {}),
    });
    return { changed };
  }

  /** Where OBS streams from right now (the given profile first), else where it last did. */
  async detectHost(profileId: string | null): Promise<string | null> {
    const { media, repos } = this.services;
    if (media.publisherAddress) {
      const ids = new Set([profileId ?? DEFAULT_PROFILE_ID, DEFAULT_PROFILE_ID, ...repos.profiles.list().map((p) => p.id)]);
      for (const id of ids) {
        let address: string | null = null;
        try {
          address = await media.publisherAddress(id);
        } catch {
          address = null;
        }
        if (!address) continue;
        const s = this.settings();
        if (s.lastSeenHost !== address) repos.settings.set(OBS_RELAY_SETTINGS_KEY, { ...s, lastSeenHost: address });
        return address;
      }
    }
    return this.settings().lastSeenHost;
  }

  /**
   * Where the relay connects: an address typed in Settings, else the plugin's (refused with 4100
   * while the plugin says sharing is off), else where OBS streams from. Null = no address known.
   */
  async target(profileId: string | null): Promise<ObsTarget | null> {
    const s = this.settings();
    const plugin = this.activePlugin(s);
    const password = await this.currentPassword(s);
    if (s.host) return { host: s.host, port: s.port, password };
    if (plugin && !plugin.enabled) throw new ObsRelayError(OBS_RELAY_CLOSE.notConfigured, SHARING_OFF_TEXT);
    const host = plugin?.host ?? (await this.detectHost(profileId));
    return host ? { host, port: s.port, password } : null;
  }

  /** Settings → API "Test": connect to OBS as the relay would and ask for its version. */
  async test(): Promise<ObsRelayTestResult> {
    const port = this.settings().port;
    let target: ObsTarget | null;
    try {
      target = await this.target(null);
    } catch (err) {
      return { ok: false, host: null, port, error: err instanceof Error ? err.message : String(err) };
    }
    if (!target) return { ok: false, host: null, port, error: NOT_CONFIGURED_TEXT };
    let socket: WebSocket | null = null;
    try {
      const opened = await openObs(target, this.create, this.timeoutMs);
      socket = opened.socket;
      const version = await this.getVersion(opened.socket, opened.hello, target.password);
      return {
        ok: true,
        host: target.host,
        port: target.port,
        obsVersion: str(version.obsVersion),
        obsWebSocketVersion: str(version.obsWebSocketVersion) ?? str(opened.hello.d.obsWebSocketVersion),
      };
    } catch (err) {
      return { ok: false, host: target.host, port: target.port, error: err instanceof Error ? err.message : String(err) };
    } finally {
      socket?.close(1000);
    }
  }

  private getVersion(socket: WebSocket, hello: ObsMessage, password: string | null): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const done = (err: Error | null, value?: Record<string, unknown>) => {
        clearTimeout(timer);
        socket.off('message', onMessage);
        socket.off('close', onClose);
        if (err) reject(err);
        else resolve(value ?? {});
      };
      const onMessage = (data: RawData) => {
        const msg = parse(data);
        if (msg?.op === OP.identified) {
          socket.send(JSON.stringify({ op: OP.request, d: { requestType: 'GetVersion', requestId: 'ctd-relay-test' } }));
        } else if (msg?.op === OP.requestResponse && msg.d.requestId === 'ctd-relay-test') {
          const data = msg.d.responseData;
          done(null, data && typeof data === 'object' ? (data as Record<string, unknown>) : {});
        }
      };
      const onClose = (code: number) => done(new ObsRelayError(code, code === 4009 ? AUTH_FAILED_TEXT : OBS_CLOSED_TEXT));
      const timer = setTimeout(() => done(new ObsRelayError(OBS_RELAY_CLOSE.unreachable, IDENTIFY_TIMEOUT_TEXT)), this.timeoutMs);
      socket.on('message', onMessage);
      socket.on('close', onClose);
      try {
        socket.send(identifyFor(hello, password, { rpcVersion: 1, eventSubscriptions: 0 }));
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ---- sessions ----

  socketsFor(tokenId: string): number {
    let n = 0;
    for (const s of this.sessions) if (s.tokenId === tokenId) n++;
    return n;
  }

  /** The token was revoked: close its phones now. */
  disconnectToken(tokenId: string): void {
    for (const s of [...this.sessions]) if (s.tokenId === tokenId) s.finish(OBS_RELAY_CLOSE.revoked, REVOKED_TEXT);
  }

  /** Shutdown: phones reconnect after the restart. */
  closeAll(): void {
    for (const s of [...this.sessions]) s.finish(OBS_RELAY_CLOSE.restarting, RESTARTING_TEXT);
  }

  /** A phone opened /obs/socket with a valid token (checked by the route). */
  accept(phone: WebSocket, token: ApiTokenInfo, ip: string | null): void {
    const log = this.log.child({ tokenId: token.id, ip });
    // connecting: reaching OBS · hello: the phone has OBS's Hello · identifying: Identify sent to OBS · open: relaying
    let phase: 'connecting' | 'hello' | 'identifying' | 'open' | 'closed' = 'connecting';
    let hello: ObsMessage | null = null;
    let password: string | null = null;
    let identifyTimer: NodeJS.Timeout | null = null;

    const session: Session = {
      tokenId: token.id,
      phone,
      obs: null,
      phoneSeenAt: this.now(),
      obsSeenAt: this.now(),
      finish: (code, reason) => {
        if (phase === 'closed') return;
        const wasOpen = phase === 'open';
        phase = 'closed';
        if (identifyTimer) clearTimeout(identifyTimer);
        this.sessions.delete(session);
        if (phone.readyState === WebSocket.OPEN || phone.readyState === WebSocket.CONNECTING) phone.close(code, closeReason(reason));
        const obs = session.obs;
        if (obs && obs.readyState === WebSocket.OPEN) obs.close(1000);
        else obs?.terminate();
        log[code === 1000 || wasOpen ? 'info' : 'warn']({ code, reason }, 'phone left the OBS relay');
      },
    };
    this.sessions.add(session);

    const toPhone = (data: RawData, isBinary: boolean) => {
      if (phone.readyState !== WebSocket.OPEN) return;
      if (phone.bufferedAmount > MAX_BUFFERED_BYTES) {
        phone.terminate();
        session.finish(1008, 'Too far behind on frames from OBS.');
        return;
      }
      phone.send(data, { binary: isBinary });
    };

    phone.on('error', () => {});
    phone.on('pong', () => {
      session.phoneSeenAt = this.now();
    });
    phone.on('close', () => session.finish(1000, 'The phone disconnected.'));
    phone.on('message', (data, isBinary) => {
      session.phoneSeenAt = this.now();
      const obs = session.obs;
      if (phase === 'open' && obs) {
        if (obs.readyState === WebSocket.OPEN) obs.send(data, { binary: isBinary });
        return;
      }
      if (phase !== 'hello' || !obs || !hello) {
        if (phase !== 'closed') session.finish(OBS_RELAY_CLOSE.notIdentified, 'Send Identify after Hello.');
        return;
      }
      const msg = parse(data);
      if (msg?.op !== OP.identify) {
        session.finish(OBS_RELAY_CLOSE.notIdentified, 'Send Identify after Hello.');
        return;
      }
      let identify: string;
      try {
        identify = identifyFor(hello, password, msg.d);
      } catch (err) {
        const e = err instanceof ObsRelayError ? err : new ObsRelayError(1011, 'Internal error');
        session.finish(e.closeCode, e.message);
        return;
      }
      phase = 'identifying';
      identifyTimer = setTimeout(() => session.finish(OBS_RELAY_CLOSE.unreachable, IDENTIFY_TIMEOUT_TEXT), Math.min(this.timeoutMs, OBS_IDENTIFY_TIMEOUT_MS));
      obs.send(identify);
    });

    const wire = (obs: WebSocket) => {
      obs.on('pong', () => {
        session.obsSeenAt = this.now();
      });
      // One handler for the whole session, so frames OBS sends right behind Identified (in the same
      // TCP read) are forwarded in order, never dropped.
      obs.on('message', (data, isBinary) => {
        session.obsSeenAt = this.now();
        if (phase === 'open') {
          toPhone(data, isBinary);
          return;
        }
        if (phase === 'identifying' && parse(data)?.op === OP.identified) {
          phase = 'open';
          if (identifyTimer) clearTimeout(identifyTimer);
          identifyTimer = null;
          log.info('phone connected to OBS through the relay');
          toPhone(data, isBinary);
        }
      });
      obs.on('close', (code, reasonBuf) => {
        if (phase === 'identifying' && code === 4009) {
          session.finish(OBS_RELAY_CLOSE.authFailed, AUTH_FAILED_TEXT);
          return;
        }
        const reason = reasonBuf.toString('utf8');
        if (code >= 4000 && code <= 4999) session.finish(code, reason || OBS_CLOSED_TEXT);
        else session.finish(OBS_RELAY_CLOSE.obsClosed, OBS_CLOSED_TEXT);
      });
    };

    // A function, not `phase === 'closed'` inline: the phone can leave while we await.
    const closed = (): boolean => phase === 'closed';
    void (async () => {
      const target = await this.target(token.profileId ?? null);
      if (closed()) return;
      if (!target) {
        session.finish(OBS_RELAY_CLOSE.notConfigured, NOT_CONFIGURED_TEXT);
        return;
      }
      const opened = await openObs(target, this.create, this.timeoutMs);
      if (closed()) {
        opened.socket.terminate();
        return;
      }
      session.obs = opened.socket;
      session.obsSeenAt = this.now();
      hello = opened.hello;
      password = target.password;
      wire(opened.socket);
      // The phone gets OBS's own Hello, minus the challenge: its token already signed it in.
      const d = { ...opened.hello.d };
      delete d.authentication;
      phase = 'hello';
      phone.send(JSON.stringify({ op: OP.hello, d }));
    })().catch((err: unknown) => {
      const e = err instanceof ObsRelayError ? err : new ObsRelayError(1011, 'Internal error');
      if (!(err instanceof ObsRelayError)) log.error({ err }, 'OBS relay failed');
      session.finish(e.closeCode, e.message);
    });
  }

  /** Pings, idle sockets, revoked tokens. */
  private maintain(): void {
    if (this.sessions.size === 0) return;
    const t = this.now();
    let valid: Set<string>;
    try {
      valid = new Set(
        this.services.repos.apiTokens
          .list()
          .filter((tk) => tk.scopes.includes('obs:control'))
          .map((tk) => tk.id),
      );
    } catch (err) {
      this.log.warn({ err }, 'could not check the tokens of relayed phones');
      valid = new Set([...this.sessions].map((s) => s.tokenId));
    }
    for (const s of [...this.sessions]) {
      if (!valid.has(s.tokenId)) {
        s.finish(OBS_RELAY_CLOSE.revoked, REVOKED_TEXT);
        continue;
      }
      if (t - s.phoneSeenAt > this.idleTimeoutMs) {
        s.phone.terminate();
        s.finish(1001, 'The phone stopped answering.');
        continue;
      }
      if (s.obs && t - s.obsSeenAt > this.idleTimeoutMs) {
        s.obs.terminate();
        s.finish(OBS_RELAY_CLOSE.obsClosed, OBS_CLOSED_TEXT);
        continue;
      }
      try {
        if (s.phone.readyState === WebSocket.OPEN) s.phone.ping();
        if (s.obs?.readyState === WebSocket.OPEN) s.obs.ping();
      } catch {
        // closing; its 'close' handler finishes the session
      }
    }
  }
}

const registry = new WeakMap<object, ObsRelay>();

/** The OBS relay of these services (one per process, shared by the /api/v1 route and Settings → API). */
export function obsRelayFor(services: Pick<AppServices, 'repos' | 'media' | 'log'> & Partial<Pick<AppServices, 'bus' | 'apps'>>, deps?: ObsRelayDeps): ObsRelay {
  let relay = registry.get(services);
  if (!relay) {
    relay = new ObsRelay(services, deps);
    registry.set(services, relay);
  }
  return relay;
}
