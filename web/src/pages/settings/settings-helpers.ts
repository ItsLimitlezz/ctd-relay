// Pure helpers for the settings tabs (and a few shared with the accounts/destinations pages).

import type { ApiAccessInfo, AppSettings, PlatformAppStatus } from '@shared/api';
import type { ApiScope, AuditEntry, FieldSpec, TlsMode, TlsStatus } from '@shared/types';
import { API_SCOPES } from '@shared/types';
import { cleanValues, type FormErrors, type FormValues } from '../../components/dynamic-form';
import type { Tone } from '../../components/utils';

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'https', label: 'HTTPS' },
  { id: 'obs', label: 'OBS setup' },
  { id: 'apps', label: 'Developer apps' },
  { id: 'users', label: 'Users' },
  { id: 'overlay', label: 'Chat overlay' },
  { id: 'spotify', label: 'Spotify' },
  { id: 'api', label: 'API' },
  { id: 'audit', label: 'Audit log' },
  { id: 'about', label: 'About' },
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id'];

/** Tab id from `?tab=` (unknown or missing -> 'general'). */
export function settingsTab(raw: string | null | undefined): SettingsTabId {
  const found = SETTINGS_TABS.find((t) => t.id === raw);
  return found ? found.id : 'general';
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const STEP_PREFIX = /^(?:step\s*\d+\s*[:.)-]\s*|\d+\s*[.)]\s+|[-*•]\s+)/i;

/** Split driver-provided instructions (one step per line) and drop any numbering already present. */
export function instructionLines(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(STEP_PREFIX, '').trim())
    .filter((line) => line.length > 0);
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "in 5 days", "3 hours ago", "now" — or `fallback` when the timestamp is missing/invalid. */
export function relativeTime(iso: string | null | undefined, now: number, fallback = '—'): string {
  if (!iso) return fallback;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return fallback;
  const diffSec = (t - now) / 1000;
  const abs = Math.abs(diffSec);
  if (abs < 45) return 'now';
  for (const [unit, size] of RELATIVE_UNITS) {
    if (abs >= size || unit === 'second') {
      return relativeFormat.format(Math.round(diffSec / size), unit);
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// General settings
// ---------------------------------------------------------------------------

export interface GeneralDraft {
  publicBaseUrl: string;
  ingestHost: string;
  /** Raw text from the input (validated into a number). */
  disconnectGraceSec: string;
}

export const GRACE_MAX = 600;

export function generalDraft(s: AppSettings): GeneralDraft {
  return { publicBaseUrl: s.publicBaseUrl, ingestHost: s.ingestHost, disconnectGraceSec: String(s.disconnectGraceSec) };
}

export function validateGeneral(d: GeneralDraft): Partial<Record<keyof GeneralDraft, string>> {
  const errors: Partial<Record<keyof GeneralDraft, string>> = {};
  const base = d.publicBaseUrl.trim();
  if (base) {
    let u: URL | null = null;
    try {
      u = new URL(base);
    } catch {
      u = null;
    }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
      errors.publicBaseUrl = 'Use a full address starting with https:// (or http://).';
    } else if (u.username || u.password || u.search || u.hash) {
      errors.publicBaseUrl = 'Use just the address, without a login, query string or #fragment.';
    }
  }
  const host = d.ingestHost.trim();
  if (host && (/\s/.test(host) || host.includes('://') || host.includes('/'))) {
    errors.ingestHost = 'Enter only a hostname or IP address, e.g. 192.168.1.20 (no rtmp://, no port).';
  } else if (host && /^[^[\]:]+:\d+$/.test(host)) {
    errors.ingestHost = 'Leave out the port; the RTMP port is added automatically.';
  }
  const grace = d.disconnectGraceSec.trim();
  if (!/^\d+$/.test(grace) || Number(grace) > GRACE_MAX) {
    errors.disconnectGraceSec = `Enter a whole number of seconds from 0 to ${GRACE_MAX}.`;
  }
  return errors;
}

/** The changed settings only (empty object = nothing to save). Assumes the draft is valid. */
export function generalChanges(d: GeneralDraft, current: AppSettings): Partial<AppSettings> {
  const out: Partial<AppSettings> = {};
  const base = d.publicBaseUrl.trim();
  const host = d.ingestHost.trim();
  const grace = Number(d.disconnectGraceSec.trim());
  if (base !== current.publicBaseUrl) out.publicBaseUrl = base;
  if (host !== current.ingestHost) out.ingestHost = host;
  if (Number.isFinite(grace) && grace !== current.disconnectGraceSec) out.disconnectGraceSec = grace;
  return out;
}

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

export const TLS_MODE_LABEL: Record<TlsMode, string> = {
  auto: 'Automatic',
  letsencrypt: "Let's Encrypt",
  'self-signed': 'Self-signed',
  manual: 'Your own certificate files',
  off: 'Off (plain HTTP)',
};

export const TLS_SOURCE_INFO: Record<TlsStatus['source'], { label: string; tone: Tone }> = {
  'letsencrypt-ip': { label: "Let's Encrypt (IP address)", tone: 'success' },
  'letsencrypt-domain': { label: "Let's Encrypt (domain)", tone: 'success' },
  'self-signed': { label: 'Self-signed', tone: 'warn' },
  manual: { label: 'Your own certificate', tone: 'info' },
  none: { label: 'No HTTPS', tone: 'danger' },
};

const DAY_MS = 24 * 3600 * 1000;

/** Badge tone for a certificate expiry: expired = danger, under 2 days = warn. */
export function expiryTone(notAfter: string | null, now: number): Tone {
  if (!notAfter) return 'neutral';
  const t = Date.parse(notAfter);
  if (Number.isNaN(t)) return 'neutral';
  if (t <= now) return 'danger';
  return t - now < 2 * DAY_MS ? 'warn' : 'success';
}

// ---------------------------------------------------------------------------
// Developer apps
// ---------------------------------------------------------------------------

/** Form values for a developer app: stored non-secret values, coerced to each field's type. */
export function appFormValues(fields: readonly FieldSpec[], status: Pick<PlatformAppStatus, 'values'>): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    if (f.type === 'secret') continue;
    const raw = status.values[f.key];
    if (raw === undefined || raw === '') {
      if (f.default !== undefined) out[f.key] = f.default;
      else if (f.type === 'boolean') out[f.key] = false;
      continue;
    }
    if (f.type === 'boolean') out[f.key] = raw === 'true' || raw === '1';
    else if (f.type === 'number') out[f.key] = Number.isFinite(Number(raw)) ? Number(raw) : raw;
    else out[f.key] = raw;
  }
  return out;
}

/**
 * Values to PUT: every non-secret field as a string ('' clears it), secrets only when the user
 * typed a new one (absent = keep the stored secret).
 */
export function appSubmitValues(fields: readonly FieldSpec[], values: FormValues): Record<string, string> {
  const clean = cleanValues(fields, values);
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = clean[f.key];
    if (f.type === 'secret') {
      if (typeof v === 'string' && v.trim()) out[f.key] = v.trim();
    } else {
      out[f.key] = v === undefined || v === null ? '' : String(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Same rules as the server (security/passwords.ts). */
export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

export function validatePassword(password: string, confirm: string): { password?: string; confirm?: string } {
  const e: { password?: string; confirm?: string } = {};
  if (password.length < PASSWORD_MIN) e.password = `Use at least ${PASSWORD_MIN} characters.`;
  else if (password.length > PASSWORD_MAX) e.password = `Use at most ${PASSWORD_MAX} characters.`;
  if (confirm !== password) e.confirm = "Passwords don't match.";
  return e;
}

export function validateNewUser(v: { username: string; password: string; confirm: string }): {
  username?: string;
  password?: string;
  confirm?: string;
} {
  const e: { username?: string; password?: string; confirm?: string } = { ...validatePassword(v.password, v.confirm) };
  if (!USERNAME_RE.test(v.username.trim())) e.username = '3–32 characters: letters, digits, "_", "." or "-".';
  return e;
}

// ---------------------------------------------------------------------------
// Chat overlay
// ---------------------------------------------------------------------------

export const OVERLAY_DEFAULT_MAX = 15;
export const OVERLAY_MAX_LIMIT = 100;
export const OVERLAY_FADE_MAX = 3600;

/**
 * Overlay URL with the optional `fade` (seconds, 0 = never) and `max` (visible messages) options.
 * Out-of-range or default values are left out. Returns the input unchanged if it isn't a URL.
 */
export function overlayUrlWithParams(url: string, opts: { fade?: number | null; max?: number | null }): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const { fade, max } = opts;
  if (fade !== undefined && fade !== null && Number.isFinite(fade) && fade > 0 && fade <= OVERLAY_FADE_MAX) {
    u.searchParams.set('fade', String(Math.round(fade)));
  } else {
    u.searchParams.delete('fade');
  }
  if (max !== undefined && max !== null && Number.isFinite(max) && max >= 1 && max <= OVERLAY_MAX_LIMIT && Math.round(max) !== OVERLAY_DEFAULT_MAX) {
    u.searchParams.set('max', String(Math.round(max)));
  } else {
    u.searchParams.delete('max');
  }
  return u.href;
}

/** Parse an optional whole number from an input ('' -> null, invalid -> NaN). */
export function parseWholeNumber(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  return /^\d+$/.test(s) ? Number(s) : Number.NaN;
}

// ---------------------------------------------------------------------------
// External API (Settings → API)
// ---------------------------------------------------------------------------

/** Same limit as the server (http/routes/tokens.ts). */
export const TOKEN_NAME_MAX = 60;
export const DOCK_TOKEN_NAME = 'OBS dock';
export const DOCK_SCOPES: readonly ApiScope[] = ['status:read', 'chat:read'];

export const API_SCOPE_INFO: Readonly<Record<ApiScope, { label: string; help: string }>> = {
  'chat:read': { label: 'Read chat', help: 'Chat history and live chat: messages, alerts (subs, gifts, Super Chats…) and removed messages.' },
  'status:read': { label: 'Read status', help: 'Stream, feed and destination status, bitrates, viewers, notices and the list of profiles.' },
  'ingest:read': {
    label: 'Read OBS stream keys',
    help: "The profile's OBS server and stream keys, so an app (the CTD OBS plugin) can set up OBS. Stream keys are secrets: only for apps that configure OBS.",
  },
  'apps:read': {
    label: 'See connected apps',
    help: 'The other connected apps and what they offer (e.g. the overlays CTD Overlay assigned to a profile), and messages sent to this app.',
  },
  'apps:write': {
    label: 'Register and message apps',
    help: 'Register this app and what it offers so other apps can find it, and send messages to other apps through CTD Relay.',
  },
  'obs:write': {
    label: 'Send OBS events',
    help: "OBS's state — sources losing or regaining signal, outputs starting and stopping, scene changes — for apps like CTD Live mobile to show (the CTD OBS plugin).",
  },
  'obs:control': {
    label: 'Control OBS',
    help: 'Full control of OBS through CTD Relay, from anywhere: scenes, previews, start/stop stream and recording (CTD Live mobile). OBS’s own password stays on this server.',
  },
};

/** Permissions a new token starts with (read-only basics; the others are opt-in). */
export const DEFAULT_TOKEN_SCOPES: readonly ApiScope[] = ['chat:read', 'status:read'];

/** Scopes in the standard order, unknown ones dropped. */
export function orderedScopes(scopes: readonly string[]): ApiScope[] {
  return API_SCOPES.filter((s) => scopes.includes(s));
}

// C0/C1 controls and bidi overrides (the server rejects them too).
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/;

export function validateTokenForm(name: string, scopes: readonly ApiScope[]): { name?: string; scopes?: string } {
  const e: { name?: string; scopes?: string } = {};
  const n = name.trim();
  if (!n) e.name = 'Give the token a name, e.g. the app that will use it.';
  else if (n.length > TOKEN_NAME_MAX) e.name = `Use at most ${TOKEN_NAME_MAX} characters.`;
  else if (CONTROL_RE.test(n)) e.name = 'Use plain text without control characters.';
  if (orderedScopes(scopes).length === 0) e.scopes = 'Pick at least one permission.';
  return e;
}

const API_SUFFIX = '/api/v1';

/** The site root of an API base URL ("https://h:30443/api/v1" -> "https://h:30443"), or null. */
export function apiSiteRoot(base: string | null | undefined): string | null {
  if (!base) return null;
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  let path = u.pathname.replace(/\/+$/, '');
  if (path.endsWith(API_SUFFIX)) path = path.slice(0, -API_SUFFIX.length);
  return `${u.origin}${path.replace(/\/+$/, '')}`;
}

/** The OBS dock URL for a site root: the token goes in the fragment, which browsers never send. */
export function dockUrlFor(base: string | null | undefined, secret: string): string | null {
  const root = apiSiteRoot(base);
  return root ? `${root}/dock#${new URLSearchParams({ token: secret }).toString()}` : null;
}

/**
 * The OBS dock URL: on the LAN address when known (OBS runs on the same network; plain HTTP there
 * needs no certificate), else the HTTPS address.
 */
export function dockUrl(access: Pick<ApiAccessInfo, 'lanBaseUrl' | 'baseUrl'>, secret: string): { url: string; lan: boolean } | null {
  const lan = dockUrlFor(access.lanBaseUrl, secret);
  if (lan) return { url: lan, lan: true };
  const pub = dockUrlFor(access.baseUrl, secret);
  return pub ? { url: pub, lan: false } : null;
}

/** The New-token modal: the form, a create request in flight, then the secret (shown once). */
export interface TokenModalState<T> {
  open: boolean;
  /** A create request is in flight: the modal can't close, or the new secret would be lost. */
  busy: boolean;
  created: T | null;
}

export type TokenModalAction<T> = { type: 'open' } | { type: 'close' } | { type: 'busy'; busy: boolean } | { type: 'created'; result: T };

export function tokenModalInitial<T>(): TokenModalState<T> {
  return { open: false, busy: false, created: null };
}

export function tokenModalReducer<T>(state: TokenModalState<T>, action: TokenModalAction<T>): TokenModalState<T> {
  switch (action.type) {
    case 'open':
      // Always starts at the form, never at an earlier secret.
      return { open: true, busy: false, created: null };
    case 'close':
      return state.busy || !state.open ? state : tokenModalInitial<T>();
    case 'busy':
      return state.busy === action.busy ? state : { ...state, busy: action.busy };
    case 'created':
      return { open: true, busy: false, created: action.result };
  }
}

/** Escape and the backdrop don't close it while creating or while the secret is shown (only Done / ×). */
export function tokenModalDismissible(state: TokenModalState<unknown>): boolean {
  return !state.busy && state.created === null;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export const AUDIT_PAGE_SIZE = 100;

/** Append an older page (newest first overall), dropping duplicates by id. */
export function appendAudit(existing: readonly AuditEntry[], page: readonly AuditEntry[]): AuditEntry[] {
  const seen = new Set(existing.map((e) => e.id));
  return existing.concat(page.filter((e) => !seen.has(e.id)));
}

/** Cursor for the next (older) page: the smallest id seen. */
export function auditCursor(entries: readonly AuditEntry[]): number | undefined {
  let min: number | undefined;
  for (const e of entries) if (min === undefined || e.id < min) min = e.id;
  return min;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Map a server validation message to the field it is about, by label prefix
 * ("Stream key is required" -> 'streamKey'). Longest label wins. Returns null when unknown.
 */
export function fieldForMessage(message: string, labels: Readonly<Record<string, string>>): string | null {
  const msg = message.trim().toLowerCase();
  let best: { key: string; len: number } | null = null;
  for (const [key, label] of Object.entries(labels)) {
    const l = label.trim().toLowerCase();
    if (l && msg.startsWith(l) && (!best || l.length > best.len)) best = { key, len: l.length };
  }
  return best?.key ?? null;
}

/** Errors object -> true when it has any message. */
export function hasErrors(errors: Readonly<Record<string, string | undefined>> | FormErrors): boolean {
  return Object.values(errors).some((v) => !!v);
}
