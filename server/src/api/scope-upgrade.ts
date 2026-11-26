// Scope upgrades (docs/API.md §9.3.1, v1.18): a paired app asks for more scopes for the token it
// already holds; an admin approves or denies it in Settings → API. Approving adds exactly the
// requested scopes to that token: its secret, name and profile never change, so the app keeps
// working with the same token, now with more scopes.
//
// Requests live in memory only (a restart forgets them: the app's next poll gets 410 and it asks
// again). One pending request per token; a new one replaces it.

import crypto from 'node:crypto';
import type { Logger } from 'pino';
import { ADMIN_ONLY_SCOPES, API_SCOPES, type ApiScope, type ApiTokenInfo, type ScopeUpgradeRequest } from '../../../shared/types.js';
import type { EventBus } from '../events.js';
import type { Repos, ScopeUpgradeService } from '../services.js';
import { ApiProblem } from './http.js';

/** Scopes an upgrade can add: every scope except the admin-only ones (system:admin). */
export const UPGRADE_SCOPES: readonly ApiScope[] = API_SCOPES.filter((s) => !ADMIN_ONLY_SCOPES.includes(s));
/** How long a request waits for the admin. */
export const SCOPE_UPGRADE_TTL_MS = 10 * 60_000;
/** Pending requests at once, across every token. */
export const MAX_PENDING_SCOPE_UPGRADES = 10;
/** Finished requests (approved, denied, expired) still answer polls this long, then are forgotten. */
export const SCOPE_UPGRADE_RETAIN_MS = 10 * 60_000;
export const SCOPE_UPGRADE_SWEEP_MS = 15_000;
export const SCOPE_UPGRADE_APP_NAME_MAX = 60;
export const SCOPE_UPGRADE_REASON_MAX = 200;

/** `<boot>-<uuid>`: the boot part tells a request from before a restart (410) from an unknown one (404). */
const UPGRADE_ID_RE = /^([0-9a-f]{8})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type State = 'pending' | 'approved' | 'denied' | 'expired';

interface Entry {
  id: string;
  tokenId: string;
  appName: string | null;
  adding: ApiScope[];
  reason: string | null;
  createdAtMs: number;
  expiresAtMs: number;
  state: State;
  finalAtMs: number | null;
}

export interface ScopeUpgradeServiceDeps {
  repos: Pick<Repos, 'apiTokens' | 'audit' | 'connectedApps'>;
  bus: EventBus;
  log: Pick<Logger, 'info' | 'warn'>;
  now?: () => number;
  sweepMs?: number;
}

export interface ScopeUpgradeServiceHandle extends ScopeUpgradeService {
  /** Expire and forget requests now (also runs every SCOPE_UPGRADE_SWEEP_MS). */
  sweep(): void;
  close(): void;
}

/** App names and reasons come from the app: quote and bound them in audit lines. */
const quoted = (s: string) => JSON.stringify(s.length > 100 ? `${s.slice(0, 99)}…` : s);

export function createScopeUpgradeService(deps: ScopeUpgradeServiceDeps): ScopeUpgradeServiceHandle {
  const { repos, bus, log } = deps;
  const now = deps.now ?? Date.now;
  const entries = new Map<string, Entry>();
  /** Changes on every start: requests live in memory, and the app learns they're gone with 410. */
  const boot = crypto.randomBytes(4).toString('hex');

  const changed = () => bus.emit('scope-upgrades-changed');
  const pending = () => [...entries.values()].filter((e) => e.state === 'pending');
  const tokenOf = (id: string): ApiTokenInfo | null => repos.apiTokens.list().find((t) => t.id === id) ?? null;

  const auditLine = (action: string, detail: string, ip: string | null = null) => {
    try {
      repos.audit.log({ userId: null, username: null, action, detail, ip });
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'scope upgrade: audit failed');
    }
  };

  /** "\"CTD OBS plugin\" token=ctd_pat_3fK9… adding=feeds:watch" (never the secret: only the stored prefix). */
  const describe = (e: Entry, token: Pick<ApiTokenInfo, 'prefix'> | null) =>
    `${e.appName !== null ? `${quoted(e.appName)} ` : ''}token=${token ? `${token.prefix}…` : '(revoked)'} adding=${e.adding.join(', ')}`;

  const expire = (e: Entry, why: string, token: ApiTokenInfo | null) => {
    e.state = 'expired';
    e.finalAtMs = now();
    auditLine('scope_upgrade.expired', `${describe(e, token)} (${why})`);
    log.info({ upgradeId: e.id, tokenId: e.tokenId, why }, 'scope upgrade: expired');
  };

  /** Expire what is due or whose token was revoked; forget old finished requests. */
  const sweep = () => {
    const t = now();
    let pendingChanged = false;
    let tokens: Map<string, ApiTokenInfo> | null = null;
    for (const [id, e] of entries) {
      if (e.state === 'pending') {
        tokens ??= new Map(repos.apiTokens.list().map((x) => [x.id, x]));
        const token = tokens.get(e.tokenId) ?? null;
        if (!token) {
          expire(e, 'token revoked', null);
          pendingChanged = true;
        } else if (t >= e.expiresAtMs) {
          expire(e, 'not answered in time', token);
          pendingChanged = true;
        }
      }
      if (e.finalAtMs !== null && t >= e.finalAtMs + SCOPE_UPGRADE_RETAIN_MS) entries.delete(id);
    }
    if (pendingChanged) changed();
  };

  const timer = setInterval(() => {
    try {
      sweep();
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'scope upgrade: sweep failed');
    }
  }, deps.sweepMs ?? SCOPE_UPGRADE_SWEEP_MS);
  timer.unref?.();

  const view = (e: Entry, token: ApiTokenInfo | null): ScopeUpgradeRequest => {
    const app = token ? repos.connectedApps.list().find((a) => a.tokenId === token.id) : undefined;
    return {
      id: e.id,
      tokenId: e.tokenId,
      tokenName: token?.name ?? '',
      tokenPrefix: token?.prefix ?? '',
      profileId: token?.profileId ?? null,
      appName: e.appName ?? app?.name ?? null,
      kind: app?.kind ?? null,
      currentScopes: token ? [...token.scopes] : [],
      adding: [...e.adding],
      reason: e.reason,
      createdAt: new Date(e.createdAtMs).toISOString(),
      expiresAt: new Date(e.expiresAtMs).toISOString(),
    };
  };

  const pendingEntry = (id: string): { e: Entry; token: ApiTokenInfo } => {
    sweep();
    const e = entries.get(id);
    if (!e) throw new ApiProblem(404, 'not_found', 'No such request for more permissions (it may have expired).');
    if (e.state === 'expired') throw new ApiProblem(410, 'expired', 'This request has expired; the app has to ask again.');
    if (e.state !== 'pending') throw new ApiProblem(409, 'invalid', `This request was already ${e.state}.`);
    const token = tokenOf(e.tokenId);
    // sweep() just expired requests of revoked tokens; this covers a revoke in between.
    if (!token) {
      expire(e, 'token revoked', null);
      changed();
      throw new ApiProblem(410, 'expired', 'The token was revoked; the request has expired.');
    }
    return { e, token };
  };

  return {
    request(token, input) {
      sweep();
      // Unknown scopes (newer ones, anything) and admin-only ones are ignored, like pairing.
      const asked = UPGRADE_SCOPES.filter((s) => input.scopes.includes(s));
      if (asked.length === 0) throw new ApiProblem(400, 'invalid', `scopes: any of ${UPGRADE_SCOPES.join(', ')}`);
      const adding = asked.filter((s) => !token.scopes.includes(s));
      if (adding.length === 0) return { status: 'approved', scopes: [...token.scopes] };

      // One pending request per token: the new one replaces it (and doesn't count against the cap).
      const others = pending().filter((e) => e.tokenId !== token.id);
      if (others.length >= MAX_PENDING_SCOPE_UPGRADES) {
        const oldest = Math.min(...others.map((e) => e.expiresAtMs));
        throw new ApiProblem(
          429,
          'rate_limited',
          `${MAX_PENDING_SCOPE_UPGRADES} requests for more permissions are already waiting. Try again later.`,
          Math.max(1, Math.ceil((oldest - now()) / 1000)),
        );
      }
      for (const old of pending()) if (old.tokenId === token.id) expire(old, 'replaced by a newer request', token);

      const t = now();
      const e: Entry = {
        id: `${boot}-${crypto.randomUUID()}`,
        tokenId: token.id,
        appName: input.appName,
        adding,
        reason: input.reason,
        createdAtMs: t,
        expiresAtMs: t + SCOPE_UPGRADE_TTL_MS,
        state: 'pending',
        finalAtMs: null,
      };
      entries.set(e.id, e);
      auditLine('scope_upgrade.request', describe(e, token), input.ip);
      log.info({ upgradeId: e.id, tokenId: token.id, adding }, 'scope upgrade: an app asks for more scopes');
      changed();
      return { status: 'pending', upgrade: view(e, token) };
    },

    poll(id, tokenId) {
      sweep();
      const e = entries.get(id);
      if (!e) {
        // Issued before a restart (the memory is gone): expired, so the app simply asks again.
        const m = UPGRADE_ID_RE.exec(id);
        return m && m[1] !== boot ? { status: 'expired' } : null;
      }
      if (e.tokenId !== tokenId) return null;
      if (e.state === 'approved') return { status: 'approved', scopes: tokenOf(tokenId)?.scopes ?? [] };
      return { status: e.state };
    },

    list() {
      sweep();
      const open = pending();
      if (open.length === 0) return [];
      const tokens = new Map(repos.apiTokens.list().map((x) => [x.id, x]));
      return open.sort((a, b) => b.createdAtMs - a.createdAtMs).map((e) => view(e, tokens.get(e.tokenId) ?? null));
    },

    approve(id) {
      const { e, token } = pendingEntry(id);
      // Re-checked here: never an admin-only scope, whatever the request holds.
      const adding = e.adding.filter((s) => UPGRADE_SCOPES.includes(s));
      // Only scopes: the token's profile, name and secret stay as they are.
      const updated = repos.apiTokens.addScopes(token.id, adding);
      if (!updated) {
        expire(e, 'token revoked', null);
        changed();
        throw new ApiProblem(410, 'expired', 'The token was revoked; the request has expired.');
      }
      const upgrade = view(e, token);
      e.state = 'approved';
      e.finalAtMs = now();
      log.info({ upgradeId: id, tokenId: token.id, adding }, 'scope upgrade: approved');
      changed();
      return { upgrade, token: updated };
    },

    deny(id) {
      const { e, token } = pendingEntry(id);
      const upgrade = view(e, token);
      e.state = 'denied';
      e.finalAtMs = now();
      log.info({ upgradeId: id, tokenId: token.id }, 'scope upgrade: denied');
      changed();
      return upgrade;
    },

    sweep,

    close() {
      clearInterval(timer);
    },
  };
}
