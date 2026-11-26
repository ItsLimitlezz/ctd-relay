import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { WsServerMessage } from '../../../../shared/api.js';
import { DEFAULT_PROFILE_ID, type ConnectedApp, type DestinationPhase, type PairingRequest, type ProfileSummary, type ScopeUpgradeRequest } from '../../../../shared/types.js';
import { eventHubFor } from '../../api/event-hub.js';
import type { ApiIssueCleared, ApiIssueRaised, Envelope } from '../../api/types.js';
import type { EventBus } from '../../events.js';
import { profileOf } from '../../orchestrator/orchestrator.js';
import { isUnknownProfileError, profileParam } from '../../orchestrator/registry.js';
import type { AppServices } from '../../services.js';
import { sessionRevalidator, WS_SESSION_ENDED } from '../auth-plugin.js';
import { requireUser, sendError, type RouteOptions } from '../guards.js';

export const WS_PING_INTERVAL_MS = 30_000;
/** Skip sends to clients that aren't keeping up (slow network, backgrounded tab). */
export const WS_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

const OPEN = 1; // WebSocket.OPEN

/** The subset of a `ws` WebSocket the hub uses (keeps the hub testable with fakes). */
export interface HubSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, cb?: (err?: Error) => void): void;
  ping(): void;
  terminate(): void;
  /** Graceful close with a code (falls back to terminate() when absent). */
  close?(code?: number, reason?: string): void;
  on(event: 'pong' | 'close', listener: () => void): unknown;
}

/** Where the hub reads the cross-profile lists it pushes (each optional: missing = never sent). */
export interface HubSources {
  /** Every profile with its live situation ('profiles' messages). */
  profiles?: () => ProfileSummary[];
  /** Pending app pairings ('pairings' messages, admins only). */
  pairings?: () => PairingRequest[];
  /** Pending scope upgrades ('scope-upgrades' messages, admins only). */
  scopeUpgrades?: () => ScopeUpgradeRequest[];
  /** Connected apps ('apps' messages). */
  apps?: () => ConnectedApp[];
}

export interface ClientOptions {
  /** Profile whose session/feed/destination/chat/account/notice events the socket gets. Default: the default profile. */
  profileId?: string;
  /** Whether the user may see pending pairings; re-checked on every send (a demoted admin stops getting them). */
  isAdmin?: () => boolean;
}

interface Client {
  socket: HubSocket;
  alive: boolean;
  /** False once the session the socket was opened with is no longer valid. */
  isValid: (() => boolean) | null;
  profileId: string;
  isAdmin: (() => boolean) | null;
}

/**
 * Fans bus events out to every connected UI socket (one bus subscription per event type,
 * however many clients) and runs the ping/pong heartbeat.
 *
 * Profiles: a socket watches one profile (WS /api/ws?profile=<id>). Session, feed, destination,
 * chat, chat moderation, account and profile-specific notices go only to that profile's sockets;
 * notices without a profile and the cross-profile lists ('profiles', 'apps', admins' 'pairings')
 * go to every socket. 'profiles' is sent on any profile's session change and on profile edits, and
 * when a destination phase or the destination list changes the summaries (live/down counts).
 */
export class WsHub {
  private readonly clients = new Set<Client>();
  private readonly unsubscribers: (() => void)[];
  /** Last phase seen per destination: a phase change may change the profile summaries. */
  private readonly phases = new Map<string, DestinationPhase>();
  private profilesTimer: ReturnType<typeof setImmediate> | null = null;
  private profilesForce = false;
  private lastProfiles: string | null = null;

  constructor(
    bus: EventBus,
    private readonly log: Pick<Logger, 'debug'>,
    private readonly sources: HubSources = {},
  ) {
    this.unsubscribers = [
      bus.on('session', (session) => {
        this.toProfile(profileOf(session), { type: 'session', session });
        this.scheduleProfiles(true);
      }),
      bus.on('feed', (feed) => this.toProfile(profileOf(feed), { type: 'feed', feed })),
      bus.on('guest-feed', (g) => this.toProfile(g.profileId, { type: 'guest-feed', profileId: g.profileId, guestFeed: g.feed })),
      bus.on('guest-feeds-changed', (c) => this.toProfile(c.profileId, { type: 'guest-feeds-changed', profileId: c.profileId })),
      bus.on('destination', (state) => {
        this.toProfile(profileOf(state), { type: 'destination', state });
        if (this.phases.get(state.destinationId) !== state.phase) {
          this.phases.set(state.destinationId, state.phase);
          this.scheduleProfiles(false);
        }
      }),
      bus.on('chat', (message) => this.toProfile(profileOf(message), { type: 'chat', message })),
      bus.on('chat-moderation', (moderation) => this.toProfile(profileOf(moderation), { type: 'chat-moderation', moderation })),
      bus.on('account', (account) => this.toProfile(profileOf(account), { type: 'account', account })),
      bus.on('destinations-changed', (...args) => {
        const changed = args[0];
        if (changed?.profileId) this.toProfile(changed.profileId, { type: 'destinations-changed' });
        else this.broadcast({ type: 'destinations-changed' });
        this.phases.clear();
        this.scheduleProfiles(false);
      }),
      bus.on('notice', (n) => {
        const msg: WsServerMessage = { type: 'notice', level: n.level, message: n.message };
        if (n.profileId) this.toProfile(n.profileId, msg);
        else this.broadcast(msg);
      }),
      bus.on('profiles-changed', () => this.scheduleProfiles(true)),
      bus.on('pairings-changed', () => this.sendPairings(null)),
      bus.on('scope-upgrades-changed', () => this.sendScopeUpgrades(null)),
      bus.on('apps-changed', () => this.sendApps()),
    ];
  }

  get size(): number {
    return this.clients.size;
  }

  /**
   * Forward the API event hub's issue.raised / issue.cleared (docs/API.md §17) to the sockets of the
   * issue's profile as 'issue-raised' / 'issue-cleared' (v1.18).
   */
  attachIssues(events: { subscribe(listener: (env: Envelope) => void): () => void }): void {
    this.unsubscribers.push(
      events.subscribe((env) => {
        const profileId = env.src.profile;
        if (!profileId) return;
        if (env.type === 'issue.raised') this.toProfile(profileId, { type: 'issue-raised', profileId, issue: env.data as ApiIssueRaised });
        else if (env.type === 'issue.cleared') this.toProfile(profileId, { type: 'issue-cleared', profileId, issue: env.data as ApiIssueCleared });
      }),
    );
  }

  /**
   * Register a socket; `hello` is sent first so it always precedes forwarded events (admins then get
   * the pending pairings, so an "app wants to connect" banner shows right away).
   * `isValid` is re-checked on every heartbeat; the socket is closed with 4401 once it fails.
   */
  add(socket: HubSocket, hello: WsServerMessage, isValid?: () => boolean, opts: ClientOptions = {}): void {
    const client: Client = {
      socket,
      alive: true,
      isValid: isValid ?? null,
      profileId: opts.profileId ?? DEFAULT_PROFILE_ID,
      isAdmin: opts.isAdmin ?? null,
    };
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('close', () => this.clients.delete(client));
    this.send(client, JSON.stringify(hello));
    if (socket.readyState !== OPEN) return;
    this.clients.add(client);
    this.sendPairings(client);
    this.sendScopeUpgrades(client);
  }

  broadcast(msg: WsServerMessage): void {
    if (this.clients.size === 0) return;
    const data = JSON.stringify(msg);
    for (const client of this.clients) this.send(client, data);
  }

  /** One heartbeat round: close revoked sessions, terminate clients that missed the previous ping, ping the rest. */
  heartbeat(): void {
    for (const client of this.clients) {
      if (!this.stillValid(client)) {
        this.clients.delete(client);
        if (client.socket.close) client.socket.close(WS_SESSION_ENDED, 'Session ended');
        else client.socket.terminate();
        continue;
      }
      if (!client.alive) {
        this.clients.delete(client);
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      try {
        client.socket.ping();
      } catch {
        this.clients.delete(client);
        client.socket.terminate();
      }
    }
  }

  close(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    if (this.profilesTimer) clearImmediate(this.profilesTimer);
    this.profilesTimer = null;
    for (const client of this.clients) client.socket.terminate();
    this.clients.clear();
  }

  // ---------------------------------------------------------------------------

  private toProfile(profileId: string, msg: WsServerMessage): void {
    if (this.clients.size === 0) return;
    let data: string | null = null;
    for (const client of this.clients) {
      if (client.profileId !== profileId) continue;
      data ??= JSON.stringify(msg);
      this.send(client, data);
    }
  }

  /**
   * Coalesces bursts (a start emits several session events) into one 'profiles' message on the
   * next turn of the event loop. `force` (a session change or a profile edit) always sends; a
   * destination-driven check only sends when the summaries changed.
   */
  private scheduleProfiles(force: boolean): void {
    if (!this.sources.profiles || this.unsubscribers.length === 0) return;
    this.profilesForce ||= force;
    if (this.profilesTimer) return;
    this.profilesTimer = setImmediate(() => this.flushProfiles());
  }

  private flushProfiles(): void {
    this.profilesTimer = null;
    const force = this.profilesForce;
    this.profilesForce = false;
    if (this.clients.size === 0 || !this.sources.profiles) {
      this.lastProfiles = null;
      return;
    }
    let profiles: ProfileSummary[];
    try {
      profiles = this.sources.profiles();
    } catch (err) {
      this.log.debug({ error: (err as Error).message }, 'building ws profiles failed');
      return;
    }
    const data = JSON.stringify({ type: 'profiles', profiles } satisfies WsServerMessage);
    if (!force && data === this.lastProfiles) return;
    this.lastProfiles = data;
    for (const client of this.clients) this.send(client, data);
  }

  /** Pending pairings to every admin socket, or to `only` (a new socket) when it is an admin's. */
  private sendPairings(only: Client | null): void {
    if (!this.sources.pairings || this.clients.size === 0) return;
    const targets = (only ? [only] : [...this.clients]).filter((c) => this.admin(c));
    if (targets.length === 0) return;
    let pairings: PairingRequest[];
    try {
      pairings = this.sources.pairings();
    } catch (err) {
      this.log.debug({ error: (err as Error).message }, 'listing pairings failed');
      return;
    }
    const data = JSON.stringify({ type: 'pairings', pairings } satisfies WsServerMessage);
    for (const client of targets) this.send(client, data);
  }

  /** Pending scope upgrades to every admin socket, or to `only` (a new socket) when it is an admin's and some are pending. */
  private sendScopeUpgrades(only: Client | null): void {
    if (!this.sources.scopeUpgrades || this.clients.size === 0) return;
    const targets = (only ? [only] : [...this.clients]).filter((c) => this.admin(c));
    if (targets.length === 0) return;
    let upgrades: ScopeUpgradeRequest[];
    try {
      upgrades = this.sources.scopeUpgrades();
    } catch (err) {
      this.log.debug({ error: (err as Error).message }, 'listing scope upgrades failed');
      return;
    }
    // A new socket hears nothing when nothing waits (older tests and clients see the same messages as before).
    if (only && upgrades.length === 0) return;
    const data = JSON.stringify({ type: 'scope-upgrades', upgrades } satisfies WsServerMessage);
    for (const client of targets) this.send(client, data);
  }

  private sendApps(): void {
    if (!this.sources.apps || this.clients.size === 0) return;
    let apps: ConnectedApp[];
    try {
      apps = this.sources.apps();
    } catch (err) {
      this.log.debug({ error: (err as Error).message }, 'listing connected apps failed');
      return;
    }
    this.broadcast({ type: 'apps', apps });
  }

  private admin(client: Client): boolean {
    if (!client.isAdmin) return false;
    try {
      return client.isAdmin();
    } catch (err) {
      this.log.debug({ error: (err as Error).message }, 'ws admin re-check failed');
      return false;
    }
  }

  private stillValid(client: Client): boolean {
    if (!client.isValid) return true;
    try {
      return client.isValid();
    } catch (err) {
      // A transient DB error must not sign everyone out; the next round checks again.
      this.log.debug({ error: (err as Error).message }, 'ws session re-check failed');
      return true;
    }
  }

  private send(client: Client, data: string): void {
    const { socket } = client;
    if (socket.readyState !== OPEN || socket.bufferedAmount > WS_MAX_BUFFERED_BYTES) return;
    try {
      socket.send(data, (err) => {
        if (err) this.log.debug({ error: err.message }, 'ws send failed');
      });
    } catch (err) {
      this.log.debug({ error: (err as Error).message }, 'ws send failed');
    }
  }
}

/**
 * GET /api/ws?profile=<id> [user]: live events for the web UI (see WsServerMessage), for one profile
 * (default profile when omitted; 404 'unknown_profile' / 400 'invalid' before the upgrade).
 * Client messages are ignored.
 */
const wsRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const log = services.log.child({ mod: 'ws' });
  // Read lazily: services.orchestrators/pairings/apps are wired after the services object is built.
  const hub = new WsHub(services.bus, log, {
    profiles: () => services.orchestrators.summaries(),
    pairings: () => services.pairings.list(),
    scopeUpgrades: () => services.scopeUpgrades.list(),
    apps: () => services.apps.list(),
  });
  // Issues (v1.18): the API event hub decides what is open; the dashboard shows it live.
  let issues: ReturnType<typeof eventHubFor> | null = null;
  try {
    issues = eventHubFor(services);
    hub.attachIssues(issues);
  } catch (err) {
    log.warn({ error: (err as Error).message }, 'ws: no live issues (the API event hub is not available)');
  }
  const timer = setInterval(() => hub.heartbeat(), WS_PING_INTERVAL_MS);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    hub.close();
  });

  const preHandler = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    await requireUser(req, reply);
    if (reply.sent) return reply;
    const profileId = profileParam(req.query);
    if (profileId === null) return sendError(reply, 400, 'profile: must be a profile id', 'invalid');
    try {
      services.orchestrators.get(profileId);
    } catch (err) {
      if (!isUnknownProfileError(err)) throw err;
      return sendError(reply, 404, 'Unknown profile', 'unknown_profile');
    }
  };

  app.get('/api/ws', { websocket: true, preHandler }, (socket, req) => {
    socket.on('message', () => {
      // Read-only channel: ignore anything the client sends.
    });
    const profileId = profileParam(req.query) ?? DEFAULT_PROFILE_ID;
    let hello: WsServerMessage;
    try {
      hello = {
        type: 'hello',
        session: services.orchestrators.get(profileId).state(),
        chat: services.chat.recent(200, profileId),
        profiles: services.orchestrators.summaries(),
        ...(issues ? { issues: issues.openIssues(profileId) } : {}),
      };
    } catch (err) {
      log.error({ error: (err as Error).message }, 'building ws hello failed');
      socket.close(1011, 'Internal error');
      return;
    }
    const userId = req.user?.id ?? null;
    hub.add(socket, hello, sessionRevalidator(services, req), {
      profileId,
      isAdmin: () => userId !== null && services.repos.users.get(userId)?.role === 'admin',
    });
  });
};

export default wsRoutes;
