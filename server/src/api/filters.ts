// `types=` filters (comma-separated globs) and scope checks for event streams.

import type { ApiScope } from '../../../shared/types.js';
import { EVENT_SCOPES, EVENT_TYPES, OPT_IN_EVENT_TYPES, type ApiEventType } from './types.js';

const GLOB_RE = /^[a-z*]+(?:\.[a-z*]+)*$/;
const MAX_GLOBS = 20;
const MAX_GLOB_LENGTH = 64;

export type TypeFilter =
  | { ok: true; types: ReadonlySet<ApiEventType> }
  | { ok: false; status: 400 | 403; code: 'invalid' | 'missing_scope'; detail: string };

/**
 * Does `glob` match `s`? `*` matches any run of characters, dots included (`chat.*` matches
 * `chat.message.deleted`). Iterative two-pointer matcher, O(glob × s) worst case: never build a
 * backtracking RegExp from client input (`***…x` is exponential in V8's regex engine).
 */
export function globMatch(glob: string, s: string): boolean {
  let g = 0;
  let i = 0;
  let star = -1;
  let mark = 0;
  while (i < s.length) {
    if (g < glob.length && glob[g] !== '*' && glob[g] === s[i]) {
      g++;
      i++;
    } else if (g < glob.length && glob[g] === '*') {
      star = g++;
      mark = i;
    } else if (star >= 0) {
      g = star + 1;
      i = ++mark;
    } else {
      return false;
    }
  }
  while (g < glob.length && glob[g] === '*') g++;
  return g === glob.length;
}

/** Event types a token may receive (system.reset is a control frame everyone gets). */
export function scopeTypes(scopes: readonly ApiScope[]): Set<ApiEventType> {
  return new Set(EVENT_TYPES.filter((t) => {
    const scope = EVENT_SCOPES[t];
    return scope === null || scopes.includes(scope);
  }));
}

/**
 * Resolve the `types` query parameter against the token's scopes. Without it: everything the
 * scopes allow. With it: the matching types, 400 when nothing matches any v1 event type, 403 when
 * every matching type needs a scope the token lacks.
 */
export function resolveTypes(raw: unknown, scopes: readonly ApiScope[]): TypeFilter {
  const allowed = scopeTypes(scopes);
  const byDefault = new Set([...allowed].filter((t) => !OPT_IN_EVENT_TYPES.has(t)));
  if (raw === undefined || raw === '') return { ok: true, types: byDefault };
  if (typeof raw !== 'string') return { ok: false, status: 400, code: 'invalid', detail: 'types must be given once, as a comma-separated list' };
  const globs = raw.split(',').map((g) => g.trim()).filter((g) => g.length > 0);
  if (globs.length === 0) return { ok: true, types: byDefault };
  if (globs.length > MAX_GLOBS) return { ok: false, status: 400, code: 'invalid', detail: `types: at most ${MAX_GLOBS} entries` };
  for (const g of globs) {
    if (g.length > MAX_GLOB_LENGTH || !GLOB_RE.test(g)) {
      return { ok: false, status: 400, code: 'invalid', detail: `types: "${g.slice(0, MAX_GLOB_LENGTH)}" is not an event type or glob (e.g. chat.*, destination.down)` };
    }
  }
  const patterns = globs.map((g) => g.replace(/\*+/g, '*'));
  const requested = EVENT_TYPES.filter((t) => t !== 'system.reset' && patterns.some((p) => (OPT_IN_EVENT_TYPES.has(t) ? p === t : globMatch(p, t))));
  if (requested.length === 0) return { ok: false, status: 400, code: 'invalid', detail: 'types matches no event type' };
  const granted = requested.filter((t) => allowed.has(t));
  if (granted.length === 0) {
    const needed = [...new Set(requested.map((t) => EVENT_SCOPES[t]).filter((s): s is ApiScope => s !== null))];
    return {
      ok: false,
      status: 403,
      code: 'missing_scope',
      detail: `This token needs the ${needed.join(' or ')} scope for these events. Create a token with it in Settings → API.`,
    };
  }
  return { ok: true, types: new Set<ApiEventType>([...granted, 'system.reset']) };
}
