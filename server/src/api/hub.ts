// The hub (docs/API.md §9.2): connected apps register themselves and what they offer (overlays…),
// so other apps find them through CTD Relay. Registrations are persisted (ConnectedAppsRepo);
// presence (`online` = seen in the last 90 s) is tracked here, and 'apps-changed' is emitted when an
// app registers, changes, unregisters, or crosses online/offline.
//
// Re-pairing: an app that pairs again (e.g. the CTD OBS plugin asking for new scopes) gets a new
// token but registers the same app id and name. That registration supersedes the earlier one: it
// takes the id over (even while the old entry still looks online), earlier entries of the same
// app left under suffixed ids are pruned, and the old token is revoked once it has gone unused for
// SUPERSEDED_GRACE_MS (a token still in use belongs to another live app and is kept).

import type { Logger } from 'pino';
import { z } from 'zod';
import type { ApiTokenInfo, AppResource, ConnectedApp } from '../../../shared/types.js';
import { LAST_USED_WRITE_INTERVAL_MS } from '../db/api-tokens-repo.js';
import type { EventBus } from '../events.js';
import type { AppRegistry, Repos } from '../services.js';
import { ApiProblem } from './http.js';
import { CONTROL_RE, deepEqual, jsonBytes } from './json.js';
import type { ApiConnectedApp, ApiOverlay } from './types.js';

export const APP_ID_RE = /^[a-z0-9-]{1,40}$/;
export const APP_KIND_RE = /^[a-z0-9-]{1,40}$/;
export const RESOURCE_TYPE_RE = /^[a-z0-9-]{1,40}$/;
export const CAPABILITY_RE = /^[a-z0-9_.:-]{1,64}$/;
/** An app is online when it registered or sent a heartbeat this recently. */
export const ONLINE_WINDOW_MS = 90_000;
/** How often online/offline transitions are looked for. */
export const PRESENCE_CHECK_MS = 15_000;
export const MAX_RESOURCES = 200;
export const MAX_META_BYTES = 4096;
/** Overlay `meta.scenes` (docs/API.md §9.2): counted apart from the rest of `meta`. */
export const MAX_SCENES = 50;
export const MAX_SCENES_BYTES = 16 * 1024;
export const MAX_CAPABILITIES = 50;
/** Registered apps in total, and per token (each app id is one connection). */
export const MAX_APPS = 100;
export const MAX_APPS_PER_TOKEN = 20;
export const OVERLAY_TYPE = 'overlay';
/**
 * A token superseded by a newer pairing of the same app is revoked once it has gone unused this
 * long after being superseded. Longer than two last-used writes (LAST_USED_WRITE_INTERVAL_MS), so a
 * token another live app still uses always shows it.
 */
export const SUPERSEDED_GRACE_MS = 3 * 60_000;
/** The suffix the CTD OBS plugin adds when it moves to a new id (`ctd-obs-plugin-<machine>-<6 hex>`). */
const RENEWED_ID_SUFFIX_RE = /-[0-9a-f]{6}$/;

/**
 * Could `a` and `b` be ids of the same app, one or both renewed after the id was taken? Equal once
 * the renewal suffix is stripped, or a renewed id's base is the start of the other (a renewed id
 * keeps only 18 characters of the machine name, the first id 25).
 */
export function sameAppIdFamily(a: string, b: string): boolean {
  const x = a.replace(RENEWED_ID_SUFFIX_RE, '');
  const y = b.replace(RENEWED_ID_SUFFIX_RE, '');
  return x === y || (x !== a && y.startsWith(x)) || (y !== b && x.startsWith(y));
}

/** What an app sends to register (PUT /apps/{id}); the registry adds token, profile and times. */
export type AppRegistration = Omit<ConnectedApp, 'tokenId' | 'profileId' | 'registeredAt' | 'lastSeenAt' | 'online'>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const noControls = (s: string) => !CONTROL_RE.test(s);

const label = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'required')
    .max(max, `at most ${max} characters`)
    .refine(noControls, 'control characters are not allowed');

const httpUrl = (max: number) => z.string().max(max, `at most ${max} characters`).refine(isHttpUrl, 'must be an http:// or https:// URL');
const dimension = z.number().int().min(1).max(16384);

const ResourceSchema = z.object({
  type: z.string().regex(RESOURCE_TYPE_RE, '[a-z0-9-], at most 40 characters'),
  id: z.string().min(1, 'required').max(100, 'at most 100 characters').refine(noControls, 'control characters are not allowed'),
  name: label(120),
  profileId: z.string().min(1).max(64).nullable().optional(),
  url: httpUrl(2048).optional(),
  width: dimension.optional(),
  height: dimension.optional(),
  // Size and (for overlays) `scenes` are checked by checkMeta, which needs the resource type.
  meta: z
    .record(z.string(), z.unknown())
    .refine((m) => !Array.isArray(m), 'must be an object')
    .optional(),
});

const SceneSchema = z.looseObject({
  id: z.string().min(1, 'required').max(100, 'at most 100 characters').refine(noControls, 'control characters are not allowed'),
  name: z.string().min(1, 'required').max(120, 'at most 120 characters').refine(noControls, 'control characters are not allowed'),
  url: httpUrl(2048),
});
const ScenesSchema = z
  .array(SceneSchema)
  .max(MAX_SCENES, `at most ${MAX_SCENES} scenes`)
  .refine((scenes) => new Set(scenes.map((s) => s.id)).size === scenes.length, 'scene ids must be unique within the overlay')
  .refine((scenes) => jsonBytes(scenes) <= MAX_SCENES_BYTES, `at most ${MAX_SCENES_BYTES} bytes of JSON`);

/**
 * `meta` limits. An overlay's `meta.scenes` (its scenes as single-scene browser-source URLs, which
 * the OBS plugin loads like the main `url`) must be well formed and has its own size budget; the
 * rest of `meta` is free-form within MAX_META_BYTES. Nothing is rewritten: `meta` is stored as sent.
 */
function checkMeta(type: string, meta: Record<string, unknown>, path: string): void {
  let rest = meta;
  if (type === OVERLAY_TYPE && meta.scenes !== undefined) {
    const parsed = ScenesSchema.safeParse(meta.scenes);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = [path, 'scenes', ...(first?.path ?? [])].join('.');
      throw new ApiProblem(400, 'invalid', `${where}: ${first?.message ?? 'invalid'}`);
    }
    const { scenes: _scenes, ...others } = meta;
    rest = others;
  }
  if (jsonBytes(rest) > MAX_META_BYTES) {
    const what = rest === meta ? '' : ' (not counting scenes)';
    throw new ApiProblem(400, 'invalid', `${path}: at most ${MAX_META_BYTES} bytes of JSON${what}`);
  }
}

const RegistrationSchema = z.object({
  name: label(80),
  kind: z.string().regex(APP_KIND_RE, '[a-z0-9-], at most 40 characters'),
  version: z.string().trim().max(40, 'at most 40 characters').refine(noControls, 'control characters are not allowed').nullable().optional(),
  baseUrl: httpUrl(500).nullable().optional(),
  capabilities: z.array(z.string().regex(CAPABILITY_RE, '[a-z0-9_.:-], at most 64 characters')).max(MAX_CAPABILITIES, `at most ${MAX_CAPABILITIES}`).optional(),
  resources: z.array(ResourceSchema).max(MAX_RESOURCES, `at most ${MAX_RESOURCES} resources`).optional(),
});

/** zod issues as one readable line. */
export function issuesText(error: z.ZodError): string {
  const text = error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
  return text.length > 500 ? `${text.slice(0, 497)}…` : text;
}

/** Validate a registration (shape, limits, overlay URLs, unique resource ids). Throws a 400 ApiProblem. */
export function parseAppRegistration(id: unknown, body: unknown): AppRegistration {
  if (typeof id !== 'string' || !APP_ID_RE.test(id)) {
    throw new ApiProblem(400, 'invalid', 'App id: [a-z0-9-], 1 to 40 characters (e.g. ctd-overlay, ctd-obs-plugin-studio-pc)');
  }
  const parsed = RegistrationSchema.safeParse(body ?? {});
  if (!parsed.success) throw new ApiProblem(400, 'invalid', issuesText(parsed.error));
  const b = parsed.data;
  const seen = new Set<string>();
  const resources: AppResource[] = [];
  for (const [i, r] of (b.resources ?? []).entries()) {
    if (seen.has(r.id)) throw new ApiProblem(400, 'invalid', `resources.${i}.id: "${r.id}" is used twice (ids are unique within the app)`);
    seen.add(r.id);
    if (r.type === OVERLAY_TYPE && r.url === undefined) throw new ApiProblem(400, 'invalid', `resources.${i}.url: required for overlays (the browser-source URL)`);
    const out: AppResource = { type: r.type, id: r.id, name: r.name, profileId: r.profileId ?? null };
    if (r.url !== undefined) out.url = r.url;
    if (r.width !== undefined) out.width = r.width;
    if (r.height !== undefined) out.height = r.height;
    if (r.meta !== undefined) {
      checkMeta(r.type, r.meta, `resources.${i}.meta`);
      out.meta = r.meta;
    }
    resources.push(out);
  }
  return {
    id,
    name: b.name,
    kind: b.kind,
    version: b.version ? b.version : null,
    baseUrl: b.baseUrl ?? null,
    capabilities: [...new Set(b.capabilities ?? [])],
    resources,
  };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** What other apps see of an app: everything but the registering token's id. */
export function publicApp(app: ConnectedApp): ApiConnectedApp {
  return {
    id: app.id,
    name: app.name,
    kind: app.kind,
    version: app.version,
    baseUrl: app.baseUrl,
    capabilities: [...app.capabilities],
    resources: app.resources.map((r) => ({ ...r })),
    profileId: app.profileId,
    registeredAt: app.registeredAt,
    lastSeenAt: app.lastSeenAt,
    online: app.online,
  };
}

/**
 * The apps as seen from one profile: apps connected for that profile or for every profile (apps
 * limited to another profile are left out), each with only the resources assigned to that profile
 * or unassigned. `profileId` null = no filter.
 */
export function appsForProfile<T extends Pick<ConnectedApp, 'profileId' | 'resources'>>(apps: readonly T[], profileId: string | null | undefined): T[] {
  if (profileId === null || profileId === undefined) return [...apps];
  return apps
    .filter((a) => a.profileId === null || a.profileId === profileId)
    .map((a) => ({ ...a, resources: a.resources.filter((r) => r.profileId === null || r.profileId === profileId) }));
}

/** Every overlay assigned to `profileId`, from every app (GET /profiles/{id}/overlays). */
export function overlaysFor(apps: readonly Pick<ConnectedApp, 'id' | 'name' | 'online' | 'resources'>[], profileId: string): ApiOverlay[] {
  const out: ApiOverlay[] = [];
  for (const app of apps) {
    for (const r of app.resources) {
      if (r.type !== OVERLAY_TYPE || r.profileId !== profileId) continue;
      const item: ApiOverlay = { appId: app.id, appName: app.name, appOnline: app.online, id: r.id, name: r.name };
      if (r.url !== undefined) item.url = r.url;
      if (r.width !== undefined) item.width = r.width;
      if (r.height !== undefined) item.height = r.height;
      if (r.meta !== undefined) item.meta = r.meta;
      out.push(item);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface AppRegistryDeps {
  /**
   * apiTokens: lets a re-paired app take its id back and supersede its old token (see canTakeOver);
   * without it ids stay with their token. audit: records superseded tokens being revoked.
   */
  repos: Pick<Repos, 'connectedApps' | 'profiles'> & Partial<Pick<Repos, 'apiTokens' | 'audit'>>;
  bus: EventBus;
  log: Pick<Logger, 'info' | 'warn'>;
  now?: () => number;
  presenceCheckMs?: number;
}

export interface AppRegistryHandle extends AppRegistry {
  /** Look for online/offline transitions now (also runs every PRESENCE_CHECK_MS). */
  checkPresence(): void;
  /** Revoke superseded tokens whose grace period is over (also runs every PRESENCE_CHECK_MS). */
  checkSuperseded(): void;
  /** Stop the presence timer. */
  close(): void;
}

function sameContent(a: ConnectedApp, b: ConnectedApp): boolean {
  const pick = (x: ConnectedApp) => [x.name, x.kind, x.version, x.baseUrl, x.capabilities, x.resources, x.profileId];
  return deepEqual(pick(a), pick(b));
}

export function createAppRegistry(deps: AppRegistryDeps): AppRegistryHandle {
  const { repos, bus, log } = deps;
  const now = deps.now ?? Date.now;
  /** Last register/heartbeat per app (epoch ms). Seeded from the repo, so presence survives restarts. */
  const lastSeen = new Map<string, number>();
  /** The online flag the last 'apps-changed' reflected. */
  const shownOnline = new Map<string, boolean>();
  /**
   * Tokens superseded by a newer pairing of the same app: old token id → the token that superseded
   * it and when. In memory: after a restart a pending one is simply kept (its entries are gone already).
   */
  const superseded = new Map<string, { by: string; at: number; appId: string }>();

  const isOnline = (id: string) => now() - (lastSeen.get(id) ?? Number.NEGATIVE_INFINITY) <= ONLINE_WINDOW_MS;

  const withPresence = (app: ConnectedApp): ConnectedApp => {
    const seen = lastSeen.get(app.id);
    return { ...app, lastSeenAt: seen !== undefined ? new Date(seen).toISOString() : app.lastSeenAt, online: isOnline(app.id) };
  };

  const changed = () => bus.emit('apps-changed');

  const forget = (id: string) => {
    lastSeen.delete(id);
    shownOnline.delete(id);
  };

  try {
    for (const app of repos.connectedApps.list()) {
      const t = Date.parse(app.lastSeenAt);
      lastSeen.set(app.id, Number.isFinite(t) ? t : 0);
      shownOnline.set(app.id, isOnline(app.id));
    }
  } catch (err) {
    log.warn({ error: (err as Error).message }, 'hub: reading the connected apps failed');
  }

  const owned = (token: ApiTokenInfo, id: string): ConnectedApp => {
    const app = repos.connectedApps.get(id);
    if (!app) throw new ApiProblem(404, 'not_found', `No app is registered as "${id}". Register it with PUT /api/v1/apps/${id}.`);
    if (app.tokenId !== token.id) throw new ApiProblem(409, 'app_owned', `"${id}" was registered by another token; pick another app id.`);
    return app;
  };

  const tokenById = (id: string): ApiTokenInfo | null => repos.apiTokens?.list().find((t) => t.id === id) ?? null;
  const newer = (a: ApiTokenInfo, b: ApiTokenInfo) => Date.parse(a.createdAt) > Date.parse(b.createdAt);
  /**
   * Does `a` reach everything `b` reaches (every profile, or the same profile)? Only then can `a` be
   * the same app paired again: a token limited to one profile never pushes out, or gets revoked, a
   * connection made for every profile or for another profile.
   */
  const covers = (a: ApiTokenInfo, b: ApiTokenInfo) => (a.profileId ?? null) === null || (a.profileId ?? null) === (b.profileId ?? null);

  /**
   * May `token` take over `existing`, registered by another token? Yes when that token was revoked,
   * or when `token` is newer than its owner and the app is of the same kind and either offline or
   * the same app by name (the name carries the machine: "CTD OBS plugin (<machine>)") with a token
   * that covers its owner's profile: the same app paired again, which keeps its app id. A live app
   * of another name, or one a narrower token asks for, never moves.
   */
  const canTakeOver = (token: ApiTokenInfo, existing: ConnectedApp, reg: AppRegistration): boolean => {
    if (!repos.apiTokens) return false;
    const owner = tokenById(existing.tokenId);
    if (!owner) return true;
    if (existing.kind !== reg.kind || !newer(token, owner)) return false;
    return !isOnline(existing.id) || (existing.name === reg.name && covers(token, owner));
  };

  /** `oldTokenId` was superseded by `token` (a newer pairing of the same app): revoke it after the grace period. */
  const supersede = (oldTokenId: string, token: ApiTokenInfo, appId: string) => {
    const old = tokenById(oldTokenId);
    if (!old || oldTokenId === token.id || !covers(token, old)) return;
    if (!superseded.has(oldTokenId)) superseded.set(oldTokenId, { by: token.id, at: now(), appId });
  };

  /**
   * Earlier entries of the app `saved` just registered, left under other ids (the plugin moved to a
   * suffixed id when its id was refused): same kind, name and profile, an id of the same family,
   * offline, and registered by an older (or revoked) token. Removed; their tokens are superseded.
   */
  const pruneEarlier = (token: ApiTokenInfo, saved: ConnectedApp): boolean => {
    if (!repos.apiTokens) return false;
    let pruned = false;
    for (const other of repos.connectedApps.list()) {
      if (other.id === saved.id || other.tokenId === token.id) continue;
      if (other.kind !== saved.kind || other.name !== saved.name || other.profileId !== saved.profileId) continue;
      if (!sameAppIdFamily(other.id, saved.id) || isOnline(other.id)) continue;
      const owner = tokenById(other.tokenId);
      if (owner && !newer(token, owner)) continue;
      repos.connectedApps.delete(other.id);
      forget(other.id);
      pruned = true;
      log.info({ appId: other.id, replacedBy: saved.id, tokenId: other.tokenId }, 'hub: earlier entry of a re-paired app removed');
      if (owner) supersede(owner.id, token, saved.id);
    }
    return pruned;
  };

  const checkSuperseded = () => {
    if (superseded.size === 0 || !repos.apiTokens) return;
    const t = now();
    for (const [oldId, s] of superseded) {
      if (t < s.at + SUPERSEDED_GRACE_MS) continue;
      superseded.delete(oldId);
      const old = tokenById(oldId);
      const by = tokenById(s.by);
      // Already revoked, or the newer token is gone (revoked meanwhile): nothing to do / keep the old one.
      if (!old || !by) continue;
      const lastUsed = old.lastUsedAt ? Date.parse(old.lastUsedAt) : Number.NEGATIVE_INFINITY;
      if (lastUsed > s.at + LAST_USED_WRITE_INTERVAL_MS) {
        log.info({ tokenId: oldId, appId: s.appId }, 'hub: superseded token still in use (another app); kept');
        continue;
      }
      if (repos.connectedApps.list().some((a) => a.tokenId === oldId)) {
        log.info({ tokenId: oldId, appId: s.appId }, 'hub: superseded token still has apps; kept');
        continue;
      }
      repos.apiTokens.delete(oldId);
      try {
        repos.audit?.log({
          userId: null,
          username: null,
          action: 'api_token.superseded',
          detail: `${old.name} ${old.prefix}…: ${s.appId} paired again (${by.name} ${by.prefix}…); the old token was revoked`,
        });
      } catch (err) {
        log.warn({ error: (err as Error).message }, 'hub: auditing a superseded token failed');
      }
      log.info({ tokenId: oldId, by: s.by, appId: s.appId }, 'hub: superseded token revoked');
    }
  };

  const checkPresence = () => {
    let any = false;
    for (const id of lastSeen.keys()) {
      const online = isOnline(id);
      if (shownOnline.get(id) !== online) {
        shownOnline.set(id, online);
        any = true;
      }
    }
    if (any) changed();
  };

  const timer = setInterval(() => {
    try {
      checkPresence();
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'hub: presence check failed');
    }
    try {
      checkSuperseded();
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'hub: revoking superseded tokens failed');
    }
  }, deps.presenceCheckMs ?? PRESENCE_CHECK_MS);
  timer.unref?.();

  return {
    list(profileId) {
      return appsForProfile(repos.connectedApps.list().map(withPresence), profileId);
    },

    get(id) {
      const app = repos.connectedApps.get(id);
      return app ? withPresence(app) : null;
    },

    register(token, input) {
      const parsed = parseAppRegistration(input.id, input);
      const tokenProfile = token.profileId ?? null;
      let known: Set<string> | null = null;
      const dropped: string[] = [];
      for (const r of parsed.resources) {
        if (r.profileId === null) continue;
        if (tokenProfile !== null && r.profileId !== tokenProfile) {
          throw new ApiProblem(
            403,
            'profile_forbidden',
            `This token is limited to profile "${tokenProfile}": resource "${r.id}" can only be assigned to it or to null.`,
          );
        }
        known ??= new Set(repos.profiles.list().map((p) => p.id));
        if (!known.has(r.profileId)) dropped.push(r.id);
      }
      // A resource assigned to a profile that doesn't exist (typically one deleted since the app last
      // looked) is left out rather than refusing the whole registration, which is also the app's
      // heartbeat. The response lists what was kept.
      const reg: AppRegistration =
        dropped.length === 0 ? parsed : { ...parsed, resources: parsed.resources.filter((r) => r.profileId === null || known?.has(r.profileId) === true) };
      if (dropped.length > 0) log.info({ appId: reg.id, resources: dropped.length }, 'hub: resources for unknown profiles left out');

      const found = repos.connectedApps.get(reg.id);
      const takenOver = found && found.tokenId !== token.id ? found : null;
      if (takenOver) {
        if (!canTakeOver(token, takenOver, reg)) {
          throw new ApiProblem(409, 'app_owned', `"${reg.id}" was registered by another token; pick another app id.`);
        }
        log.info({ appId: reg.id, kind: reg.kind, from: takenOver.tokenId, tokenId: token.id }, 'hub: app re-registered by a newer token');
      }
      // Taken over: counts as a new registration for this token's limits.
      const existing = found && found.tokenId === token.id ? found : null;
      if (!existing) {
        const all = repos.connectedApps.list();
        if (all.length >= MAX_APPS) throw new ApiProblem(409, 'limit', `At most ${MAX_APPS} apps can be registered; remove unused ones in Settings → API.`);
        if (all.filter((a) => a.tokenId === token.id).length >= MAX_APPS_PER_TOKEN) {
          throw new ApiProblem(409, 'limit', `At most ${MAX_APPS_PER_TOKEN} apps per token.`);
        }
      }

      const saved = repos.connectedApps.upsert({
        ...reg,
        tokenId: token.id,
        profileId: tokenProfile,
        ...(existing ? { registeredAt: existing.registeredAt } : {}),
      });
      lastSeen.set(saved.id, now());
      const wasOnline = shownOnline.get(saved.id) === true;
      shownOnline.set(saved.id, true);
      if (!existing) log.info({ appId: saved.id, kind: saved.kind, tokenId: token.id }, 'hub: app registered');
      // The same app (kind and name) paired again: its old token is superseded.
      if (takenOver && takenOver.kind === saved.kind && takenOver.name === saved.name) supersede(takenOver.tokenId, token, saved.id);
      const pruned = pruneEarlier(token, saved);
      if (!existing || !wasOnline || pruned || !sameContent(existing, saved)) changed();
      return withPresence(saved);
    },

    heartbeat(token, id) {
      const app = owned(token, id);
      repos.connectedApps.touch(id);
      lastSeen.set(id, now());
      if (shownOnline.get(id) !== true) {
        shownOnline.set(id, true);
        changed();
      }
      return withPresence(repos.connectedApps.get(id) ?? app);
    },

    remove(id) {
      if (!repos.connectedApps.get(id)) return;
      repos.connectedApps.delete(id);
      forget(id);
      log.info({ appId: id }, 'hub: app removed');
      changed();
    },

    removeByToken(tokenId) {
      const gone = repos.connectedApps.list().filter((a) => a.tokenId === tokenId);
      repos.connectedApps.deleteByToken(tokenId);
      if (gone.length === 0) return;
      for (const a of gone) forget(a.id);
      log.info({ tokenId, apps: gone.length }, 'hub: apps of a revoked token removed');
      changed();
    },

    checkPresence,

    checkSuperseded,

    close() {
      clearInterval(timer);
    },
  };
}
