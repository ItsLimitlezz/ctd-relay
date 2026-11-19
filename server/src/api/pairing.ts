// Pairing ("connect to CTD Relay", docs/API.md §9.3): an app asks for a token without the
// user copying one. It shows a short code; an admin approves it in Settings → API (choosing the
// profile and scopes); the app polls with its pollSecret and receives the token once.
//
// Requests live in memory only (a restart forgets them: the app's next poll gets `expired` and it
// starts over). The token is created on approval; its secret is held until the app collects it,
// then forgotten. A token nobody collects is revoked when the request expires.

import crypto from 'node:crypto';
import type { Logger } from 'pino';
import { ADMIN_ONLY_SCOPES, API_SCOPES, type ApiScope, type ApiTokenInfo, type PairingRequest } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import type { EventBus } from '../events.js';
import type { PairingService, Repos } from '../services.js';
import { lanClientPolicy } from '../tls/http-listener.js';
import { ApiProblem, addressBucket } from './http.js';

/** Scopes an app may ask for, and be given, by pairing (docs/API.md §9.3). */
export const PAIRING_SCOPES: readonly ApiScope[] = API_SCOPES.filter((s) => !ADMIN_ONLY_SCOPES.includes(s));

/** How long a request waits for the admin, and how long an approved token waits to be collected. */
export const PAIRING_TTL_MS = 10 * 60_000;
/** Seconds the app should wait between polls. */
export const PAIRING_POLL_INTERVAL_SEC = 3;
/** Pending requests at once (the unauthenticated endpoint can't fill memory or the admin's screen). */
export const MAX_PENDING_PAIRINGS = 10;
/**
 * Pending requests per address (IPv4 address, or IPv6 /64): one client can't take every slot. 3 lets
 * the OBS plugin and CTD Overlay pair at the same time from behind one NAT.
 */
export const MAX_PENDING_PAIRINGS_PER_ADDRESS = 3;
/**
 * Of MAX_PENDING_PAIRINGS, at most this many for non-LAN peers, so requests from the internet can
 * never use up the slots the owner's LAN apps pair with ("LAN" as for the plain-HTTP handoff:
 * private ranges, or LAN_HTTP_CIDRS; nobody when LAN_HTTP=off).
 */
export const MAX_PENDING_PAIRINGS_INTERNET = 5;
/** Finished requests (denied, expired, collected) still answer polls this long, then are forgotten. */
export const PAIRING_RETAIN_MS = 10 * 60_000;
export const PAIRING_SWEEP_MS = 15_000;
/** No 0/O, 1/I/L or U: easy to read aloud and compare. */
export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{3}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{3}$/;
export const TOKEN_NAME_MAX = 60;

type State = 'pending' | 'approved' | 'denied' | 'claimed' | 'expired';

interface Entry {
  pairing: PairingRequest;
  secretHash: Buffer;
  state: State;
  expiresAtMs: number;
  /** When it reached a final state (denied/claimed/expired), for retention. */
  finalAtMs: number | null;
  /** Approved: the token and its secret until the app collects it (or the request expires). */
  token: ApiTokenInfo | null;
  secret: string | null;
  approvedAtMs: number | null;
  /** addressBucket() of the requesting address, and whether it is a LAN peer (per-address / pool limits). */
  bucket: string;
  lan: boolean;
}

export interface PairingServiceDeps {
  repos: Pick<Repos, 'apiTokens' | 'profiles' | 'audit' | 'connectedApps'>;
  bus: EventBus;
  log: Pick<Logger, 'info' | 'warn'>;
  config?: Pick<AppConfig, 'version'>;
  now?: () => number;
  sweepMs?: number;
  /** Whether a requesting address is a LAN peer. Default: the LAN_HTTP / LAN_HTTP_CIDRS policy. */
  isLanClient?: (ip: string | undefined) => boolean;
}

export interface PairingServiceHandle extends PairingService {
  /** Expire and forget requests now (also runs every PAIRING_SWEEP_MS). */
  sweep(): void;
  /** Seconds until a pending slot frees up (the oldest pending request expires). */
  retryAfterSec(): number;
  close(): void;
}

function hashSecret(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

function randomCode(): string {
  let out = '';
  for (let i = 0; i < 6; i++) {
    if (i === 3) out += '-';
    out += PAIRING_CODE_ALPHABET.charAt(crypto.randomInt(PAIRING_CODE_ALPHABET.length));
  }
  return out;
}

export function createPairingService(deps: PairingServiceDeps): PairingServiceHandle {
  const { repos, bus, log } = deps;
  const now = deps.now ?? Date.now;
  const entries = new Map<string, Entry>();

  const isLan = deps.isLanClient ?? lanClientPolicy(process.env).isLanClient;
  const changed = () => bus.emit('pairings-changed');
  const pending = () => [...entries.values()].filter((e) => e.state === 'pending');
  /** False once an admin revoked the token (Settings → API, or deleting its profile) before the app collected it. */
  const tokenExists = (tokenId: string) => repos.apiTokens.list().some((t) => t.id === tokenId);

  const finish = (e: Entry, state: 'denied' | 'claimed' | 'expired') => {
    e.state = state;
    e.finalAtMs = now();
    e.secret = null;
  };

  /** Expire what is due; revoke tokens nobody collected; forget old finished requests. */
  const sweep = () => {
    const t = now();
    let pendingChanged = false;
    for (const [id, e] of entries) {
      if (e.state === 'pending' && t >= e.expiresAtMs) {
        finish(e, 'expired');
        pendingChanged = true;
      } else if (e.state === 'approved' && e.approvedAtMs !== null && t >= e.approvedAtMs + PAIRING_TTL_MS) {
        const token = e.token;
        finish(e, 'expired');
        // Already revoked by an admin: nothing to delete, and no misleading "never collected; revoked" audit.
        if (token && tokenExists(token.id)) {
          try {
            repos.connectedApps.deleteByToken(token.id);
            repos.apiTokens.delete(token.id);
            repos.audit.log({ userId: null, username: null, action: 'pairing.expire', detail: `${e.pairing.appName}: token ${token.prefix}… never collected; revoked` });
          } catch (err) {
            log.warn({ error: (err as Error).message }, 'pairing: revoking an uncollected token failed');
          }
          log.info({ pairingId: id, tokenId: token.id }, 'pairing: approved token never collected; revoked');
        }
      }
      if (e.finalAtMs !== null && t >= e.finalAtMs + PAIRING_RETAIN_MS) entries.delete(id);
    }
    if (pendingChanged) changed();
  };

  const timer = setInterval(() => {
    try {
      sweep();
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'pairing: sweep failed');
    }
  }, deps.sweepMs ?? PAIRING_SWEEP_MS);
  timer.unref?.();

  const pendingEntry = (id: string): Entry => {
    sweep();
    const e = entries.get(id);
    if (!e) throw new ApiProblem(404, 'not_found', 'No such pairing request (it may have expired).');
    if (e.state === 'expired') throw new ApiProblem(410, 'expired', 'This pairing request has expired; the app has to ask again.');
    if (e.state !== 'pending') throw new ApiProblem(409, 'invalid', `This pairing request was already ${e.state === 'denied' ? 'denied' : 'approved'}.`);
    return e;
  };

  return {
    create(input) {
      sweep();
      const open = pending();
      const bucket = addressBucket(input.ip);
      const lan = isLan(input.ip ?? undefined);
      const fromHere = open.filter((e) => e.bucket === bucket);
      if (fromHere.length >= MAX_PENDING_PAIRINGS_PER_ADDRESS) {
        throw new ApiProblem(
          429,
          'rate_limited',
          `${MAX_PENDING_PAIRINGS_PER_ADDRESS} pairing requests from this address are already waiting for approval. Approve or deny them in Settings → API, or try again later.`,
          retryAfter(fromHere),
        );
      }
      const internet = lan ? [] : open.filter((e) => !e.lan);
      if (internet.length >= MAX_PENDING_PAIRINGS_INTERNET) {
        throw new ApiProblem(
          429,
          'rate_limited',
          `${MAX_PENDING_PAIRINGS_INTERNET} apps outside the LAN are already waiting for approval. Approve or deny them in Settings → API, or try again later.`,
          retryAfter(internet),
        );
      }
      if (open.length >= MAX_PENDING_PAIRINGS) {
        throw new ApiProblem(
          429,
          'rate_limited',
          `${MAX_PENDING_PAIRINGS} apps are already waiting for approval. Approve or deny them in Settings → API, or try again later.`,
          retryAfter(open),
        );
      }
      const t = now();
      const id = crypto.randomUUID();
      const pollSecret = crypto.randomBytes(32).toString('base64url');
      const codes = new Set(open.map((e) => e.pairing.code));
      let code = randomCode();
      while (codes.has(code)) code = randomCode();
      const pairing: PairingRequest = {
        id,
        appName: input.appName,
        kind: input.kind,
        code,
        requestedScopes: PAIRING_SCOPES.filter((s) => input.requestedScopes.includes(s)),
        requestedProfileId: input.requestedProfileId,
        ip: input.ip,
        createdAt: new Date(t).toISOString(),
        expiresAt: new Date(t + PAIRING_TTL_MS).toISOString(),
      };
      entries.set(id, {
        pairing,
        secretHash: hashSecret(pollSecret),
        state: 'pending',
        expiresAtMs: t + PAIRING_TTL_MS,
        finalAtMs: null,
        token: null,
        secret: null,
        approvedAtMs: null,
        bucket,
        lan,
      });
      log.info({ pairingId: id, kind: input.kind, ip: input.ip }, 'pairing: an app asks to connect');
      changed();
      return { pairing: { ...pairing, requestedScopes: [...pairing.requestedScopes] }, pollSecret };
    },

    poll(id, pollSecret) {
      sweep();
      const e = entries.get(id);
      // Unknown id and wrong secret look the same as an expired request: no oracle, and an app
      // polling across a server restart simply starts over.
      if (!e || typeof pollSecret !== 'string' || !crypto.timingSafeEqual(hashSecret(pollSecret), e.secretHash)) return { status: 'expired' };
      switch (e.state) {
        case 'pending':
          return { status: 'pending' };
        case 'denied':
          return { status: 'denied' };
        case 'approved': {
          const { token, secret } = e;
          if (!token || !secret) return { status: 'expired' };
          // Revoked before the app collected it: never hand out a dead secret as 'approved'.
          if (!tokenExists(token.id)) {
            finish(e, 'expired');
            log.info({ pairingId: id, tokenId: token.id }, 'pairing: token revoked before the app collected it');
            return { status: 'expired' };
          }
          finish(e, 'claimed');
          log.info({ pairingId: id, tokenId: token.id }, 'pairing: token collected by the app');
          return { status: 'approved', secret, token };
        }
        default:
          return { status: 'expired' };
      }
    },

    list() {
      sweep();
      return pending()
        .map((e) => ({ ...e.pairing, requestedScopes: [...e.pairing.requestedScopes] }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    },

    approve(id, opts) {
      const e = pendingEntry(id);
      // Admin-only scopes are never granted by approving a code an app showed.
      const scopes = PAIRING_SCOPES.filter((s) => opts.scopes.includes(s));
      if (scopes.length === 0) throw new ApiProblem(400, 'invalid', 'Pick at least one scope.');
      if (opts.profileId !== null && !repos.profiles.get(opts.profileId)) {
        throw new ApiProblem(404, 'unknown_profile', 'Unknown profile.');
      }
      const name = (opts.name?.trim() || e.pairing.appName).slice(0, TOKEN_NAME_MAX);
      const created = repos.apiTokens.create({ name, scopes, createdBy: opts.approvedBy, profileId: opts.profileId });
      // Older repos may not echo the binding back; the token is what the admin chose.
      const token: ApiTokenInfo = { ...created.token, profileId: created.token.profileId ?? opts.profileId };
      e.state = 'approved';
      e.token = token;
      e.secret = created.secret;
      e.approvedAtMs = now();
      log.info({ pairingId: id, tokenId: token.id }, 'pairing: approved');
      changed();
      return token;
    },

    deny(id) {
      const e = pendingEntry(id);
      finish(e, 'denied');
      log.info({ pairingId: id }, 'pairing: denied');
      changed();
    },

    sweep,

    retryAfterSec() {
      const open = pending();
      return open.length < MAX_PENDING_PAIRINGS ? 0 : retryAfter(open);
    },

    close() {
      clearInterval(timer);
    },
  };

  /** Seconds until the oldest of these pending requests expires (frees its slot). */
  function retryAfter(open: Entry[]): number {
    if (open.length === 0) return 0;
    const oldest = Math.min(...open.map((e) => e.expiresAtMs));
    return Math.max(1, Math.ceil((oldest - now()) / 1000));
  }
}
