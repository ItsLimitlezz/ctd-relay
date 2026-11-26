// Personal access tokens for the external API (/api/v1). The secret is shown once at creation;
// only its SHA-256 is stored, so a database leak doesn't hand out working tokens.

import crypto from 'node:crypto';
import { API_SCOPES, type ApiScope, type ApiTokenInfo } from '../../../shared/types.js';
import type { ApiTokensRepo } from '../services.js';
import { str, strOrNull, type Row, type Stmt } from './rows.js';

export const API_TOKEN_PREFIX = 'ctd_pat_';
/** `ctd_pat_` + 32 random bytes as base64url (43 characters). */
export const API_TOKEN_RE = /^ctd_pat_[A-Za-z0-9_-]{43}$/;
/** Characters of the secret kept in clear to recognise a token ("ctd_pat_3fK9"). */
export const API_TOKEN_PREFIX_LENGTH = 12;
/** last_used_at is written at most this often per token. */
export const LAST_USED_WRITE_INTERVAL_MS = 60_000;

const COLUMNS = 'id, name, scopes, prefix, secret_hash, created_at, created_by, last_used_at, profile_id';

export function hashApiToken(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function generateApiTokenSecret(): string {
  return `${API_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

/** Parse the JSON scopes column, keeping only known scopes (in canonical order). */
function parseScopes(value: unknown): ApiScope[] {
  if (typeof value !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return API_SCOPES.filter((s) => parsed.includes(s));
}

function toInfo(row: Row): ApiTokenInfo {
  return {
    id: str(row, 'id'),
    name: str(row, 'name'),
    scopes: parseScopes(row.scopes),
    // NULL = every profile (also every token created before profiles existed).
    profileId: strOrNull(row, 'profile_id'),
    prefix: str(row, 'prefix'),
    createdAt: str(row, 'created_at'),
    createdBy: strOrNull(row, 'created_by'),
    lastUsedAt: strOrNull(row, 'last_used_at'),
  };
}

export function createApiTokensRepo(stmt: Stmt, now: () => number = Date.now): ApiTokensRepo {
  const get = (id: string): ApiTokenInfo | null => {
    const row = stmt(`SELECT ${COLUMNS} FROM api_tokens WHERE id = ?`).get(id);
    return row ? toInfo(row) : null;
  };

  return {
    list() {
      return stmt(`SELECT ${COLUMNS} FROM api_tokens ORDER BY created_at, rowid`).all().map(toInfo);
    },

    create({ name, scopes, createdBy, profileId }) {
      const id = crypto.randomUUID();
      const secret = generateApiTokenSecret();
      const clean = API_SCOPES.filter((s) => scopes.includes(s));
      stmt(`INSERT INTO api_tokens (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`).run(
        id,
        name,
        JSON.stringify(clean),
        secret.slice(0, API_TOKEN_PREFIX_LENGTH),
        hashApiToken(secret),
        new Date(now()).toISOString(),
        createdBy,
        profileId ?? null,
      );
      const token = get(id);
      if (!token) throw new Error('API token insert failed');
      return { token, secret };
    },

    verify(secret) {
      if (typeof secret !== 'string' || !API_TOKEN_RE.test(secret)) return null;
      const row = stmt(`SELECT ${COLUMNS} FROM api_tokens WHERE secret_hash = ?`).get(hashApiToken(secret));
      if (!row) return null;
      const info = toInfo(row);
      const t = now();
      const last = info.lastUsedAt ? Date.parse(info.lastUsedAt) : Number.NaN;
      if (!(t - last < LAST_USED_WRITE_INTERVAL_MS)) {
        info.lastUsedAt = new Date(t).toISOString();
        stmt('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(info.lastUsedAt, info.id);
      }
      return info;
    },

    delete(id) {
      stmt('DELETE FROM api_tokens WHERE id = ?').run(id);
    },

    addScopes(id, scopes) {
      const row = stmt('SELECT scopes FROM api_tokens WHERE id = ?').get(id);
      if (!row) return null;
      // The same JSON column as ever (no schema change: older versions still read it). Values this
      // version doesn't know (written by a newer one) are kept; new scopes go after them.
      let stored: unknown;
      try {
        stored = typeof row.scopes === 'string' ? JSON.parse(row.scopes) : [];
      } catch {
        stored = [];
      }
      const kept = Array.isArray(stored) ? stored.filter((v): v is string => typeof v === 'string') : [];
      const added = API_SCOPES.filter((s) => scopes.includes(s) && !kept.includes(s));
      if (added.length > 0) stmt('UPDATE api_tokens SET scopes = ? WHERE id = ?').run(JSON.stringify([...kept, ...added]), id);
      return get(id);
    },
  };
}
