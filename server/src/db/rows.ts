// Small helpers shared by the repositories: typed column access, JSON columns,
// a prepared-statement cache, and errors that map to HTTP status codes.

import type { SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import type { Db } from './database.js';

export type Row = Record<string, SQLOutputValue>;

/** Thrown for unknown ids. `statusCode` lets the app error handler answer 404. */
export class NotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Thrown for uniqueness violations (409). */
export class ConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** Thrown when a show profile save was based on a stale revision (409); `head` is the current one. */
export class RevisionConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'revision_conflict';
  constructor(readonly head: number) {
    super(`Revision conflict: the current revision is ${head}`);
    this.name = 'RevisionConflictError';
  }
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { errcode?: number; message?: string } | null;
  // 2067 = SQLITE_CONSTRAINT_UNIQUE, 1555 = SQLITE_CONSTRAINT_PRIMARYKEY
  return !!e && (e.errcode === 2067 || e.errcode === 1555 || /UNIQUE constraint failed/.test(e.message ?? ''));
}

export function str(row: Row, col: string): string {
  const v = row[col];
  if (typeof v !== 'string') throw new Error(`Column ${col}: expected text`);
  return v;
}

export function strOrNull(row: Row, col: string): string | null {
  const v = row[col];
  return typeof v === 'string' ? v : null;
}

export function int(row: Row, col: string): number {
  const v = row[col];
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  throw new Error(`Column ${col}: expected integer`);
}

export function bool(row: Row, col: string): boolean {
  return int(row, col) !== 0;
}

/** Parse a JSON object column; anything else (corrupt, array, null) becomes {}. */
export function jsonObject(row: Row, col: string): Record<string, unknown> {
  const v = row[col];
  if (typeof v !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(v);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Parse a JSON array column; anything else (corrupt, object, null) becomes []. */
export function jsonArray(row: Row, col: string): unknown[] {
  const v = row[col];
  if (typeof v !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export type Stmt = (sql: string) => StatementSync;

/** Prepare-once cache keyed by SQL text. */
export function statementCache(db: Db): Stmt {
  const cache = new Map<string, StatementSync>();
  return (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
}

/**
 * Build and run `UPDATE <table> SET ... , updated_at = ? WHERE id = ?` for the defined
 * entries of `values` (column -> value). Returns the number of changed rows.
 */
export function updateById(
  stmt: Stmt,
  table: string,
  id: string,
  values: Record<string, SQLInputValue | undefined>,
  touchUpdatedAt = true,
): number {
  const cols = Object.keys(values).filter((c) => values[c] !== undefined);
  const params = cols.map((c) => values[c] as SQLInputValue);
  if (touchUpdatedAt) {
    cols.push('updated_at');
    params.push(nowIso());
  }
  if (cols.length === 0) {
    const exists = stmt(`SELECT 1 AS x FROM ${table} WHERE id = ?`).get(id);
    return exists ? 1 : 0;
  }
  const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
  return Number(stmt(sql).run(...params, id).changes);
}
