// HTTP plumbing for /api/v1: RFC 9457 problem details, bearer tokens, per-token limits.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { canonicalIp } from '../tls/public-ip.js';

export const PROBLEM_TYPE = 'https://github.com/ItsLimitlezz/ctd-multi-stream/blob/main/docs/API.md#errors';
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export type ProblemCode =
  | 'unauthenticated'
  | 'missing_scope'
  | 'invalid'
  | 'rate_limited'
  | 'not_found'
  | 'unknown_profile'
  | 'profile_forbidden'
  | 'app_owned'
  | 'limit'
  | 'denied'
  | 'expired'
  | 'feed_offline'
  | 'unavailable'
  | 'internal'
  | 'revision_conflict'
  | 'missing_blobs'
  | 'hash_mismatch'
  | 'quota_exceeded';

const TITLES: Record<ProblemCode, string> = {
  unauthenticated: 'Unauthenticated',
  missing_scope: 'Missing scope',
  invalid: 'Invalid request',
  rate_limited: 'Rate limited',
  not_found: 'Not found',
  unknown_profile: 'Unknown profile',
  profile_forbidden: 'Other profile',
  app_owned: 'App registered by another token',
  limit: 'Limit reached',
  denied: 'Pairing denied',
  expired: 'Pairing expired',
  feed_offline: 'Feed offline',
  unavailable: 'Temporarily unavailable',
  internal: 'Internal error',
  revision_conflict: 'Revision conflict',
  missing_blobs: 'Missing blobs',
  hash_mismatch: 'Hash mismatch',
  quota_exceeded: 'Storage quota exceeded',
};

export const PROBLEM_CODES = Object.keys(TITLES) as ProblemCode[];

export function isProblemCode(value: unknown): value is ProblemCode {
  return typeof value === 'string' && Object.hasOwn(TITLES, value);
}

/**
 * An error the /api/v1 error handler turns into a problem response (status + code + message),
 * thrown by the hub services (AppRegistry, PairingService) and route helpers.
 */
export class ApiProblem extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ProblemCode,
    message: string,
    /** Sent as Retry-After (seconds) when set. */
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'ApiProblem';
  }
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: ProblemCode;
}

export function problem(status: number, code: ProblemCode, detail: string): Problem {
  return { type: PROBLEM_TYPE, title: TITLES[code], status, detail, code };
}

export function sendProblem(reply: FastifyReply, status: number, code: ProblemCode, detail: string): FastifyReply {
  if (status === 401) reply.header('WWW-Authenticate', 'Bearer realm="ctd-multi-stream"');
  return reply.code(status).type(PROBLEM_CONTENT_TYPE).send(problem(status, code, detail));
}

/** The parsed query string as a plain record. */
export function query(req: FastifyRequest): Record<string, unknown> {
  const q = req.query;
  return q && typeof q === 'object' ? (q as Record<string, unknown>) : {};
}

/** Route parameters as a plain record. */
export function params(req: FastifyRequest): Record<string, unknown> {
  const p = req.params;
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
}

/** Longest secret we bother hashing (real ones are 51 characters). */
const MAX_TOKEN_LENGTH = 256;

/**
 * The presented token: `Authorization: Bearer <token>`, or (only where allowed) `?access_token=`.
 * Returns '' when a credential was sent but is malformed, null when none was sent.
 */
export function presentedToken(req: FastifyRequest, allowQuery: boolean): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.length > 0) {
    const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
    return m?.[1] && m[1].length <= MAX_TOKEN_LENGTH ? m[1] : '';
  }
  if (allowQuery) {
    const q = (req.query as Record<string, unknown> | undefined)?.access_token;
    if (typeof q === 'string' && q.length > 0) return q.length <= MAX_TOKEN_LENGTH ? q : '';
    if (q !== undefined) return '';
  }
  return null;
}

/**
 * The key per-address limits count a client under: an IPv4 address as is (IPv4-mapped IPv6
 * unwrapped), an IPv6 address by its /64 (one host usually holds a whole /64, so per-address
 * limits on full IPv6 addresses would be trivial to dodge). 'unknown' when there is no usable address.
 */
export function addressBucket(ip: string | null | undefined): string {
  const c = ip ? canonicalIp(ip.replace(/%.*$/, '')) : null;
  if (!c) return 'unknown';
  if (c.type === 'ipv4') return c.ip;
  // Canonical IPv6 is compressed lower-case hex without a dotted tail: expand the "::".
  const halves = c.ip.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array.from({ length: Math.max(0, fill) }, () => '0'), ...tail];
  if (groups.length !== 8) return c.ip;
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** In-memory sliding-window limiter: at most `limit` hits per `windowMs` per key. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit; when over the limit returns the seconds until one is allowed again. */
  hit(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = this.now();
    this.sweep(now);
    const since = now - this.windowMs;
    let list = this.hits.get(key);
    if (!list) {
      list = [];
      this.hits.set(key, list);
    }
    let drop = 0;
    while (drop < list.length && (list[drop] ?? 0) <= since) drop++;
    if (drop > 0) list.splice(0, drop);
    if (list.length >= this.limit) {
      const oldest = list[0] ?? now;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)) };
    }
    list.push(now);
    return { ok: true };
  }

  /** Forget keys idle for a whole window (bounded memory). */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, list] of this.hits) if ((list.at(-1) ?? 0) <= now - this.windowMs) this.hits.delete(key);
  }

  get size(): number {
    return this.hits.size;
  }
}

/** Counts open streams per key. */
export class ConcurrencyLimiter {
  private readonly open = new Map<string, number>();

  constructor(readonly max: number) {}

  acquire(key: string): boolean {
    const n = this.open.get(key) ?? 0;
    if (n >= this.max) return false;
    this.open.set(key, n + 1);
    return true;
  }

  release(key: string): void {
    const n = (this.open.get(key) ?? 0) - 1;
    if (n > 0) this.open.set(key, n);
    else this.open.delete(key);
  }

  count(key: string): number {
    return this.open.get(key) ?? 0;
  }
}
