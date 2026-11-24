// Overlay summaries (docs/API.md §9.5): what a CTD Overlay server says about its versions, beside
// the overlays it registers on the hub, for the CTD OBS plugin's "CTD Overlays" dock. Kept apart
// from the registration on purpose: a resource's `meta` stays within its 4 KB, and the summary
// (template versions, update state, trimmed release notes) is sent only when it changes.
//
//   PUT /apps/{appId}/summary           apps:write, by the token that registered the app
//   GET /profiles/{id}/overlay-summary  apps:read, the summaries seen from one profile
//
// In memory, like the OBS state (§10): a server restart forgets them until each app sends again
// (CTD Overlay sends at least every few minutes). Only the fields below are kept: anything else in
// the body (an overlay's key or URL, a GitHub token, an error's stack) is dropped, never stored or
// shown. A summary goes when its app unregisters, or when another token takes its id over.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ConnectedApp } from '../../../shared/types.js';
import { APP_ID_RE, appsForProfile, issuesText, OVERLAY_TYPE } from './hub.js';
import { params, sendProblem } from './http.js';
import { CONTROL_RE } from './json.js';
import type { V1Context } from './v1.js';

/** A summary's body, as JSON: room for 200 templates with their notes. */
export const SUMMARY_BODY_LIMIT = 64 * 1024;
export const SUMMARY_SCHEMA = 'ctd-overlay-summary/1';
export const MAX_SUMMARY_TEMPLATES = 200;
export const MAX_SUMMARY_OVERLAYS = 500;
export const MAX_NOTE_RELEASES = 5;
export const MAX_NOTE_LINES = 8;
export const NOTE_LINE_MAX = 200;

const noControls = (s: string) => !CONTROL_RE.test(s);
const text = (max: number) => z.string().trim().max(max).refine(noControls, 'control characters are not allowed');
const id = z.string().min(1).max(100).refine(noControls, 'control characters are not allowed');
/** A SemVer-ish version ("1.2.3", "2.0.0-beta.1"); at most 40 characters. */
const version = z.string().regex(/^v?\d+(\.\d+){0,2}([-+][0-9A-Za-z.-]+)?$/, 'a version like 1.2.3').max(40);
const iso = z.string().max(40).refine((s) => Number.isFinite(Date.parse(s)), 'an ISO 8601 time');
const httpUrl = z
  .string()
  .max(500)
  .refine((s) => {
    try {
      const u = new URL(s);
      return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && !u.search && !u.hash;
    } catch {
      return false;
    }
  }, 'an http(s) URL without credentials, query or fragment');
const UPDATE_KINDS = ['none', 'patch', 'minor', 'major'] as const;

const NoteSchema = z.object({
  version,
  /**
   * The release notes, trimmed to a few plain lines joined with "\n" (one string, not an array: the OBS plugin
   * reads JSON with libobs's obs_data, which drops arrays of strings).
   */
  text: z
    .string()
    .max(MAX_NOTE_LINES * (NOTE_LINE_MAX + 1))
    .refine((t) => !CONTROL_RE.test(t.replace(/\n/g, ' ')), 'control characters are not allowed (but \\n between lines)')
    .refine((t) => t.split('\n').length <= MAX_NOTE_LINES && t.split('\n').every((l) => l.length <= NOTE_LINE_MAX), `at most ${MAX_NOTE_LINES} lines of ${NOTE_LINE_MAX} characters`),
});

const TemplateSchema = z.object({
  id,
  name: text(120),
  /** The newest installed version. */
  installed: version,
  /** The oldest version an overlay is on now (absent: no overlay uses it). */
  oldestInUse: version.optional(),
  /** The newest release of its followed source; null or absent: not followed, or never checked. */
  latest: version.nullable().optional(),
  source: z
    .object({
      kind: z.enum(['github', 'url', 'none']),
      /** owner/name, for a GitHub source (no URL: a release page is built from it). */
      repo: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/).optional(),
      /**
       * The release tag prefix the source follows ("tn-v" for tn-v1.2.0): one repository can hold several templates,
       * one per prefix, so a source is its repo and prefix together.
       */
      tagPrefix: z.string().regex(/^[A-Za-z0-9._/-]{1,64}$/).optional(),
      /** Follows one release only (owner/name@tag). */
      pinned: z.boolean().optional(),
    })
    .optional(),
  /** New releases move overlays by themselves (the source's autoUpgrade is "safe"). */
  auto: z.boolean().optional(),
  /** From `oldestInUse` to `latest`: patch and minor go by themselves, major waits. */
  update: z.enum(UPDATE_KINDS).optional(),
  checkedAt: iso.nullable().optional(),
  /** The last check failed: a short code ("rate-limited", "no-release", …), never the message. */
  problem: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  notes: z.array(NoteSchema).max(MAX_NOTE_RELEASES).optional(),
});

const OverlaySchema = z.object({
  /** Its id: the part of each registered resource's id before the first ":". */
  id,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: text(120).optional(),
  /** The show it belongs to (its name), for grouping. */
  show: text(120).nullable().optional(),
  template: z.object({ id, name: text(120).optional(), version }),
  /** A newer version is installed and the overlay waits for the operator to upgrade it. */
  waiting: z
    .object({
      to: version,
      major: z.boolean(),
      /** Why, in a few words ("a major version", "it drops settings or scenes", "its show is live"). */
      why: text(120).optional(),
    })
    .optional(),
});

export const SummarySchema = z.object({
  schema: z.literal(SUMMARY_SCHEMA),
  server: z.object({ name: text(80).optional(), version: version.nullable() }),
  /** The address of its admin UI (control panel), without a path's query or fragment. */
  ui: httpUrl.nullable().optional(),
  templates: z.array(TemplateSchema).max(MAX_SUMMARY_TEMPLATES),
  overlays: z.array(OverlaySchema).max(MAX_SUMMARY_OVERLAYS),
});

export type OverlaySummary = z.infer<typeof SummarySchema>;

interface Stored {
  tokenId: string;
  receivedAt: string;
  summary: OverlaySummary;
}

/** One app's summary as GET /profiles/{id}/overlay-summary lists it. */
export interface ApiOverlaySummary extends OverlaySummary {
  appId: string;
  appName: string;
  appOnline: boolean;
  receivedAt: string;
}

/** The overlay ids an app registered for `profileId` (the part of each overlay resource's id before ":"). */
export function overlayIdsFor(app: Pick<ConnectedApp, 'resources'>, profileId: string): Set<string> {
  const out = new Set<string>();
  for (const r of app.resources) {
    if (r.type !== OVERLAY_TYPE || r.profileId !== profileId) continue;
    out.add(r.id.split(':')[0] ?? r.id);
  }
  return out;
}

/**
 * A summary as seen from one profile: the overlays the app registered for that profile, and the
 * templates those use or that no overlay uses (installed, not yet used). Templates only another
 * profile's overlays use are left out, so a token limited to one profile learns nothing of the
 * others' set-up.
 */
export function summaryForProfile(summary: OverlaySummary, app: Pick<ConnectedApp, 'resources'>, profileId: string): OverlaySummary {
  const ids = overlayIdsFor(app, profileId);
  const overlays = summary.overlays.filter((o) => ids.has(o.id));
  const used = new Set(overlays.map((o) => o.template.id));
  const usedAnywhere = new Set(summary.overlays.map((o) => o.template.id));
  const templates = summary.templates.filter((t) => used.has(t.id) || !usedAnywhere.has(t.id));
  return { ...summary, templates, overlays };
}

export interface SummaryStore {
  put(appId: string, tokenId: string, summary: OverlaySummary, at: string): void;
  /** The summary of a registered app, while the token that sent it still owns the app id. */
  get(app: Pick<ConnectedApp, 'id' | 'tokenId'>): Stored | null;
  /** Forget the summaries of apps no longer registered. */
  prune(registered: ReadonlySet<string>): void;
  size(): number;
}

export function createSummaryStore(): SummaryStore {
  const byApp = new Map<string, Stored>();
  return {
    put(appId, tokenId, summary, at) {
      byApp.set(appId, { tokenId, summary, receivedAt: at });
    },
    get(app) {
      const s = byApp.get(app.id);
      if (!s) return null;
      if (s.tokenId !== app.tokenId) {
        byApp.delete(app.id); // the id was taken over: the old app's summary isn't the new one's
        return null;
      }
      return s;
    },
    prune(registered) {
      for (const id of byApp.keys()) if (!registered.has(id)) byApp.delete(id);
    },
    size: () => byApp.size,
  };
}

const stores = new WeakMap<object, SummaryStore>();
/** One store per running server (keyed by its services). */
export function summaryStoreFor(services: object): SummaryStore {
  let s = stores.get(services);
  if (!s) {
    s = createSummaryStore();
    stores.set(services, s);
  }
  return s;
}

export function registerOverlaySummaryRoutes(app: FastifyInstance, ctx: V1Context): void {
  const { services, requireToken, authOf } = ctx;
  const store = summaryStoreFor(services);
  const off = services.bus.on('apps-changed', () => {
    try {
      store.prune(new Set(services.apps.list().map((a) => a.id)));
    } catch (err) {
      services.log.warn({ error: (err as Error).message }, 'overlay summaries: pruning failed');
    }
  });
  app.addHook('onClose', async () => off());

  app.put('/apps/:appId/summary', { preHandler: requireToken('apps:write'), bodyLimit: SUMMARY_BODY_LIMIT }, async (req, reply) => {
    const { token } = authOf(req);
    const appId = params(req).appId;
    if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) return sendProblem(reply, 400, 'invalid', 'App id: [a-z0-9-], 1 to 40 characters');
    const registered = services.apps.get(appId);
    if (!registered) return sendProblem(reply, 404, 'not_found', `No app is registered as "${appId}": register it first (PUT /api/v1/apps/${appId}).`);
    if (registered.tokenId !== token.id) return sendProblem(reply, 409, 'app_owned', `"${appId}" was registered by another token.`);
    const parsed = SummarySchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'invalid', issuesText(parsed.error));
    store.put(appId, token.id, parsed.data, new Date(ctx.now()).toISOString());
    return reply.code(204).header('cache-control', 'no-store').send();
  });

  app.get('/profiles/:id/overlay-summary', { preHandler: requireToken('apps:read') }, async (req, reply) => {
    const { token } = authOf(req);
    const raw = params(req).id;
    if (typeof raw !== 'string' || raw === '') return sendProblem(reply, 404, 'unknown_profile', 'No profile with this id (see GET /api/v1/profiles).');
    const p = ctx.resolveProfile(token, raw, null);
    if (!p.ok) return sendProblem(reply, p.status, p.code, p.detail);
    const profileId = p.profile as string;
    const items: ApiOverlaySummary[] = [];
    for (const a of appsForProfile(services.apps.list(), profileId)) {
      const s = store.get(a);
      if (!s) continue;
      items.push({ appId: a.id, appName: a.name, appOnline: a.online, receivedAt: s.receivedAt, ...summaryForProfile(s.summary, a, profileId) });
    }
    return reply.header('cache-control', 'no-store').send({ items });
  });
}
