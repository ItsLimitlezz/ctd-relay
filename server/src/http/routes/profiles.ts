// Profiles: independent streaming set-ups that can be live at the same time.
//   GET    /api/profiles      [user]  -> ProfilesResponse (every profile + its live situation)
//   POST   /api/profiles      [admin] -> Profile (201)
//   PATCH  /api/profiles/:id  [admin] -> Profile (the slug never changes: OBS keys keep working)
//   DELETE /api/profiles/:id  [admin] -> {} (not the default profile, not while its session runs)

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ProfilesResponse } from '../../../../shared/api.js';
import { DEFAULT_PROFILE_ID, type Profile } from '../../../../shared/types.js';
import { profileSecretScope, profileSettingKey, type AppServices, type Orchestrator } from '../../services.js';
import { audit, requireAdmin, requireUser, type RouteOptions } from '../guards.js';
import { HttpError, idParams, installErrorHandler } from '../validation.js';

export const PROFILE_NAME_MAX = 60;

/** Per-profile settings (keys as stored for the default profile; others get the `profile:<id>:` prefix). */
export const PROFILE_SETTING_KEYS = ['session.title', 'session.autoGoLive', 'session.testMode'] as const;

// Control characters (incl. line breaks) are not allowed in a profile name.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(PROFILE_NAME_MAX, `Name must be at most ${PROFILE_NAME_MAX} characters`)
  .refine((s) => !CONTROL_CHARS.test(s), 'Name must be a single line of text');

const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Colour must look like #RRGGBB')
  .transform((s) => s.toUpperCase())
  .nullable();

const createBody = z.object({ name: nameSchema, color: colorSchema.optional() });
const updateBody = z.object({ name: nameSchema.optional(), color: colorSchema.optional() });

function unknownProfile(): HttpError {
  return new HttpError(404, 'Profile not found', 'unknown_profile');
}

/** Short, secret-free description of a profile for the audit log. */
function describe(p: Profile): string {
  return `"${p.name}" id=${p.id} slug=${p.slug}`;
}

const profileRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const { repos, bus } = services;
  installErrorHandler(app);

  function getProfile(id: string): Profile {
    const profile = repos.profiles.get(id);
    if (!profile) throw unknownProfile();
    return profile;
  }

  /** The profile's orchestrator, or null when the registry does not have it (never added / failed). */
  function orchestratorOf(id: string): Orchestrator | null {
    try {
      return services.orchestrators.get(id);
    } catch {
      return null;
    }
  }

  app.get('/api/profiles', { preHandler: requireUser }, async (): Promise<ProfilesResponse> => {
    return { profiles: services.orchestrators.summaries() };
  });

  app.post('/api/profiles', { preHandler: requireAdmin }, async (req, reply) => {
    const body = createBody.parse(req.body ?? {});
    const profile = repos.profiles.create({ name: body.name, color: body.color ?? null });
    try {
      await services.media.profileAdded(profile);
      await services.orchestrators.add(profile);
    } catch (err) {
      // Don't leave a half-created profile behind (no OBS paths, no go-live engine).
      req.log.error({ err, profileId: profile.id }, 'creating a profile failed; rolling back');
      await rollBackCreate(services, req, profile.id);
      throw err;
    }
    bus.emit('profiles-changed');
    audit(services, req, 'profile.create', describe(profile));
    return reply.code(201).send(profile);
  });

  app.patch('/api/profiles/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = updateBody.parse(req.body ?? {});
    const before = getProfile(id);
    const patch: { name?: string; color?: string | null } = {};
    if (body.name !== undefined && body.name !== before.name) patch.name = body.name;
    if (body.color !== undefined && body.color !== before.color) patch.color = body.color;
    if (Object.keys(patch).length === 0) return before;
    const updated = repos.profiles.update(id, patch);
    bus.emit('profiles-changed');
    const changes = [
      patch.name !== undefined ? `name "${before.name}" -> "${updated.name}"` : null,
      patch.color !== undefined ? `color ${before.color ?? 'none'} -> ${updated.color ?? 'none'}` : null,
    ].filter(Boolean);
    audit(services, req, 'profile.update', `id=${id} ${changes.join(', ')}`);
    return updated;
  });

  app.delete('/api/profiles/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParams.parse(req.params);
    if (id === DEFAULT_PROFILE_ID) throw new HttpError(400, 'The default profile cannot be deleted', 'default_profile');
    const profile = getProfile(id);
    const orchestrator = orchestratorOf(id);
    if (orchestrator && orchestrator.state().status !== 'offline') {
      throw new HttpError(409, `"${profile.name}" is live. End its stream before deleting the profile.`, 'session_live');
    }

    // 1. Stop its go-live engine (nothing may start a live for it any more).
    await services.orchestrators.remove(id);

    // 2. Its destinations with their stream keys.
    let destinationCount = deleteDestinations(id);

    // 3. Its accounts with their tokens and browser sessions (best effort for the browser).
    let accountCount = await deleteAccounts(req, id);

    // 4. Its OBS paths and keys (kicks its OBS).
    await services.media.profileRemoved(id);

    // The profile row still exists until the very end, so a request handled during the awaits above
    // may have created a destination or account for it. Sweep again until nothing is left; the last
    // check and everything below run without an await in between, so nothing can slip in after it.
    for (let pass = 0; pass < 3 && hasProfileRows(id); pass++) {
      destinationCount += deleteDestinations(id);
      accountCount += await deleteAccounts(req, id);
    }
    if (hasProfileRows(id)) {
      // Still racing: drop the rows (and secrets) without the async browser clean-up.
      destinationCount += deleteDestinations(id);
      accountCount += deleteAccountRows(id);
    }

    // ---- From here on: synchronous only (no await) up to the profile row delete. ----

    // 5. Its settings, ingest keys and overlay token.
    for (const key of PROFILE_SETTING_KEYS) repos.settings.delete(profileSettingKey(id, key));
    repos.secrets.deleteScope(profileSecretScope(id, 'ingest'));
    repos.secrets.deleteScope(profileSecretScope(id, 'chat'));
    repos.secrets.deleteScope(profileSecretScope(id, 'spotify'));

    // 6. API tokens limited to it (and the apps they registered). Every-profile tokens stay, but the
    //    resources their apps assigned to this profile go (they would otherwise show as "Deleted
    //    profile" in Settings → API). They are dropped, not unassigned: unassigned means "every profile".
    const tokens = repos.apiTokens.list().filter((t) => t.profileId === id);
    for (const t of tokens) {
      repos.apiTokens.delete(t.id);
      services.apps.removeByToken(t.id);
    }
    const appsChanged = dropAppResources(id);

    // 7. The profile itself.
    repos.profiles.delete(id);
    if (appsChanged > 0) bus.emit('apps-changed');
    bus.emit('destinations-changed', { profileId: id });
    bus.emit('profiles-changed');
    audit(
      services,
      req,
      'profile.delete',
      `${describe(profile)} destinations=${destinationCount} accounts=${accountCount} tokens=${tokens.length} apps=${appsChanged}`,
    );
    return {};
  });

  /** True while the profile still has destinations or accounts. */
  function hasProfileRows(id: string): boolean {
    return repos.destinations.list(id).length > 0 || repos.accounts.list(id).length > 0;
  }

  /** Delete the profile's destinations with their stream keys. Synchronous. */
  function deleteDestinations(id: string): number {
    const destinations = repos.destinations.list(id);
    for (const d of destinations) {
      repos.secrets.deleteScope(`destination:${d.id}`);
      repos.destinations.delete(d.id);
    }
    return destinations.length;
  }

  /** Delete the profile's accounts, closing and clearing their browser sessions first (best effort). */
  async function deleteAccounts(req: FastifyRequest, id: string): Promise<number> {
    const accounts = repos.accounts.list(id);
    for (const a of accounts) {
      try {
        await services.browser.close(a.id, { save: false });
      } catch (err) {
        req.log.warn({ err, accountId: a.id }, 'closing browser context failed');
      }
      try {
        await services.browser.clear(a.id);
      } catch (err) {
        req.log.warn({ err, accountId: a.id }, 'clearing browser session failed');
      }
      deleteAccount(a.id);
    }
    return accounts.length;
  }

  /** Delete the profile's account rows and secrets without touching the browser. Synchronous. */
  function deleteAccountRows(id: string): number {
    const accounts = repos.accounts.list(id);
    for (const a of accounts) deleteAccount(a.id);
    return accounts.length;
  }

  function deleteAccount(accountId: string): void {
    repos.secrets.deleteScope(`account:${accountId}`);
    repos.secrets.deleteScope(`browser:${accountId}`);
    repos.accounts.delete(accountId);
  }

  /**
   * Remove the resources assigned to `profileId` from every remaining connected app (apps connected
   * for every profile, e.g. CTD Overlay). Returns how many apps changed. Synchronous.
   */
  function dropAppResources(profileId: string): number {
    let count = 0;
    for (const a of repos.connectedApps.list()) {
      const kept = a.resources.filter((r) => r.profileId !== profileId);
      if (kept.length === a.resources.length) continue;
      repos.connectedApps.upsert({ ...a, resources: kept });
      count++;
    }
    return count;
  }
};

/** Undo a profile create whose media/orchestrator set-up failed. Best effort. */
async function rollBackCreate(services: AppServices, req: FastifyRequest, id: string): Promise<void> {
  try {
    await services.orchestrators.remove(id);
  } catch {
    // never added
  }
  try {
    await services.media.profileRemoved(id);
  } catch (err) {
    req.log.warn({ err, profileId: id }, 'rolling back the profile media failed');
  }
  services.repos.secrets.deleteScope(profileSecretScope(id, 'ingest'));
  services.repos.profiles.delete(id);
}

export default profileRoutes;
