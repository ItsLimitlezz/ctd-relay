// Pure helpers for the hub in the web UI: app pairing requests ("an app wants to connect"),
// connected apps and their resources, and profile pickers for tokens (Settings → API).

import type { ApiScope, AppResource, ConnectedApp, PairingRequest, Profile } from '@shared/types';
import { API_SCOPES, DEFAULT_PROFILE_ID } from '@shared/types';
import { formatAgo, plural } from '../components/format';
import { findProfile, profileLabel, sortProfiles } from './profiles';

/** Select value meaning "every profile" (a token or app not limited to one profile). */
export const EVERY_PROFILE = '*';
/** Same limit as the server's token names. */
export const APP_TOKEN_NAME_MAX = 60;
/** Scopes a pairing gets when the app asked for none it can have. */
export const BASIC_SCOPES: readonly ApiScope[] = ['chat:read', 'status:read'];
/** Scopes that hand out secrets (stream keys, show-profile secrets): highlighted when approving. */
export const SECRET_SCOPES: readonly ApiScope[] = ['ingest:read', 'show:secrets'];

// ---------------------------------------------------------------------------
// Profile pickers
// ---------------------------------------------------------------------------

/** Options for a profile picker: each profile (default first), then "Every profile". */
export function profileSelectOptions(
  profiles: readonly Pick<Profile, 'id' | 'name'>[] | null | undefined,
  everyLabel = 'Every profile',
): { value: string; label: string }[] {
  const list = sortProfiles(profiles ?? []).map((p) => ({ value: p.id, label: p.name }));
  return [...list, { value: EVERY_PROFILE, label: everyLabel }];
}

/**
 * Make sure the picker can show `value`: a profile missing from the options (deleted meanwhile, or
 * not in the list yet) is added, labelled "Deleted profile" / "Profile", so the select never shows
 * one profile while the form would use another.
 */
export function withSelectedOption(
  options: readonly { value: string; label: string }[],
  value: string,
  profiles: readonly Pick<Profile, 'id' | 'name'>[] | null | undefined,
): { value: string; label: string }[] {
  if (value === '' || options.some((o) => o.value === value)) return [...options];
  const extra = { value, label: profileLabel(profileFromSelect(value), profiles) };
  const every = options.findIndex((o) => o.value === EVERY_PROFILE);
  if (every === -1) return [...options, extra];
  return [...options.slice(0, every), extra, ...options.slice(every)];
}

export function profileFromSelect(value: string): string | null {
  return value === EVERY_PROFILE || value === '' ? null : value;
}

export function profileToSelect(profileId: string | null | undefined): string {
  return profileId ?? EVERY_PROFILE;
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

function timeOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Requests that haven't expired yet, newest first. */
export function pendingPairings(list: readonly PairingRequest[] | null | undefined, now: number): PairingRequest[] {
  return (list ?? [])
    .filter((p) => {
      const exp = timeOf(p.expiresAt);
      return exp === null || exp > now;
    })
    .sort((a, b) => (timeOf(b.createdAt) ?? 0) - (timeOf(a.createdAt) ?? 0));
}

/** "expires in 9 min" / "expires in 40 s" / "expired". */
export function pairingExpiresText(p: Pick<PairingRequest, 'expiresAt'>, now: number): string {
  const exp = timeOf(p.expiresAt);
  if (exp === null) return '';
  const s = Math.floor((exp - now) / 1000);
  if (s <= 0) return 'expired';
  if (s < 60) return `expires in ${s} s`;
  return `expires in ${Math.ceil(s / 60)} min`;
}

/** Known scopes in the standard order. */
export function knownScopes(scopes: readonly string[] | null | undefined): ApiScope[] {
  const list = scopes ?? [];
  return API_SCOPES.filter((s) => list.includes(s));
}

export interface PairingApproval {
  name: string;
  scopes: ApiScope[];
  profileId: string | null;
}

/**
 * The approve form's starting values: what the app asked for. A requested profile that no longer
 * exists falls back to the default profile (never silently widened to every profile).
 */
export function pairingDefaults(p: PairingRequest, profiles: readonly Pick<Profile, 'id'>[] | null | undefined): PairingApproval {
  const scopes = knownScopes(p.requestedScopes);
  let profileId: string | null = p.requestedProfileId ?? null;
  if (profileId !== null && profiles && !findProfile(profiles, profileId)) profileId = DEFAULT_PROFILE_ID;
  return {
    name: (p.appName || p.kind || 'App').trim().slice(0, APP_TOKEN_NAME_MAX),
    scopes: scopes.length ? scopes : [...BASIC_SCOPES],
    profileId,
  };
}

/** Banner text for pending requests ('' when none). */
export function pairingBannerText(pending: readonly Pick<PairingRequest, 'appName' | 'code'>[]): string {
  if (pending.length === 0) return '';
  if (pending.length === 1) {
    const p = pending[0] as Pick<PairingRequest, 'appName' | 'code'>;
    return `${p.appName || 'An app'} wants to connect to CTD Relay (code ${p.code}).`;
  }
  return `${pending.length} apps want to connect to CTD Relay.`;
}

// ---------------------------------------------------------------------------
// Connected apps
// ---------------------------------------------------------------------------

/** Online apps first, then by name. */
export function sortApps<T extends Pick<ConnectedApp, 'online' | 'name' | 'id'>>(apps: readonly T[]): T[] {
  return [...apps].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export interface ResourceGroup {
  /** null = not assigned to a profile (every profile). */
  profileId: string | null;
  resources: AppResource[];
}

/** An app's resources by profile: profiles in their usual order, unknown ids after, unassigned last. */
export function groupResources(
  resources: readonly AppResource[] | null | undefined,
  profiles: readonly Pick<Profile, 'id'>[] | null | undefined,
): ResourceGroup[] {
  const groups = new Map<string | null, AppResource[]>();
  for (const r of resources ?? []) {
    const key = typeof r.profileId === 'string' && r.profileId ? r.profileId : null;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const order = sortProfiles(profiles ?? []).map((p) => p.id);
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib) || a.localeCompare(b);
  });
  return keys.map((profileId) => ({ profileId, resources: groups.get(profileId) as AppResource[] }));
}

/** "2 overlays" / "2 overlays, 1 scene" for a group of resources. */
export function resourceSummary(resources: readonly Pick<AppResource, 'type'>[]): string {
  const counts = new Map<string, number>();
  for (const r of resources) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  return [...counts.entries()].map(([type, n]) => plural(n, type || 'resource')).join(', ');
}

/** "Takeover — landscape, Takeover — vertical +2 more" (names as plain text). */
export function resourceNames(resources: readonly Pick<AppResource, 'name' | 'id'>[], max = 3): string {
  const names = resources.map((r) => (r.name || r.id || '').trim()).filter(Boolean);
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max} more`;
}

/** "Online" / "Offline · last seen 5 min ago". */
export function appStatusText(app: Pick<ConnectedApp, 'online' | 'lastSeenAt'>, now: number): string {
  if (app.online) return 'Online';
  const ago = formatAgo(app.lastSeenAt, now);
  return ago ? `Offline · last seen ${ago}` : 'Offline';
}

/** Token name for an OBS dock link limited to one profile. */
export function dockTokenName(base: string, profileName: string | null): string {
  if (!profileName) return base.slice(0, APP_TOKEN_NAME_MAX);
  const full = `${base} — ${profileName.trim()}`;
  return full.length <= APP_TOKEN_NAME_MAX ? full : `${full.slice(0, APP_TOKEN_NAME_MAX - 1).trimEnd()}…`;
}
