// Show profiles (v1.9, docs/API.md §14): a Relay profile's OBS set-up (scene collection, OBS
// profile, vertical canvas, assets) saved by the CTD OBS plugin as numbered revisions, and the
// content-addressed blobs (bundles, LUTs, media) they reference.
//
// Each Relay profile has at most one show profile, so the routes hang off /profiles/{id}/show.
// Blobs are shared between profiles (deduplicated by SHA-256), so a profile-limited token only
// "sees" a blob that one of its own revisions or a library entry visible to it references, or
// that it uploaded itself: /blobs/check answers "missing" for anything else, and the upload then
// proves it holds the bytes. Nothing tells a token whether another profile has a file.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiTokenInfo } from '../../../shared/types.js';
import { audit } from '../http/guards.js';
import type { AppServices, ShowRevisionRecord, ShowRevisionSummary } from '../services.js';
import { BlobError, SHA256_RE, isBlobKind, maxBytesForKind, type BlobKind } from '../storage/blob-store.js';
import { ConcurrencyLimiter, PROBLEM_CONTENT_TYPE, params, problem, query, sendProblem } from './http.js';
import { CONTROL_RE, jsonBytes } from './json.js';
import type { ApiLibraryAsset, ApiShowProfile, ApiShowRevision, ApiShowSecret, ApiShowSummary } from './types.js';
import type { V1Context } from './v1.js';

/** Manifest schema versions this server accepts. */
export const SHOW_MANIFEST_SCHEMAS: readonly number[] = [1];
export const MAX_UPLOADS_PER_TOKEN = 2;
export const MAX_CHECK_ITEMS = 1000;
export const MAX_MANIFEST_ASSETS = 2000;
export const NOTE_MAX = 500;
export const NAME_MAX = 100;
export const MAX_SECRETS = 200;
export const SECRET_VALUE_MAX = 8 * 1024;
/** Uploads a token made recently are "visible" to it before a revision references them. */
const PROVEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PROVEN_PER_TOKEN = 10_000;
/** The save body holds the manifest (≤ the manifest limit) plus secrets and a note. */
const SAVE_BODY_SLACK = 2 * 1024 * 1024;

/** Secret scope of a show profile (SecretBox): one key per revision, `rev:<n>`. */
export const showSecretScope = (showProfileId: string): string => `show:${showProfileId}`;

const sha256 = z.string().regex(SHA256_RE, 'must be a lowercase hex SHA-256');
const text = (max: number) => z.string().max(max).refine((s) => !CONTROL_RE.test(s), 'control characters are not allowed');

const CheckBody = z.object({
  items: z.array(z.object({ sha256, size: z.number().int().nonnegative() })).max(MAX_CHECK_ITEMS),
});

const SaveBody = z.object({
  parentRevision: z.number().int().nonnegative(),
  manifest: z.record(z.string(), z.unknown()),
  bundleSha256: sha256,
  note: text(NOTE_MAX).nullish(),
  secrets: z
    .array(z.object({ source: z.string().min(1).max(64), key: z.string().min(1).max(128), value: z.string().max(SECRET_VALUE_MAX) }))
    .max(MAX_SECRETS)
    .optional(),
});

/** A manifest path: relative, forward slashes, no `..`, no drive letters or absolute paths. */
export function safeRelativePath(p: unknown): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 255) return false;
  if (p.startsWith('/') || p.includes('\\') || /^[a-zA-Z]:/.test(p) || CONTROL_RE.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Every file path the manifest's `files` names (collection, profile[], canvases.*.file, plugins.*). */
function manifestPaths(files: unknown): unknown[] {
  if (!files || typeof files !== 'object') return [];
  const f = files as Record<string, unknown>;
  const out: unknown[] = [];
  if (f.collection !== undefined) out.push(f.collection);
  if (Array.isArray(f.profile)) out.push(...f.profile);
  if (f.canvases && typeof f.canvases === 'object') for (const c of Object.values(f.canvases)) out.push((c as { file?: unknown } | null)?.file);
  if (f.plugins && typeof f.plugins === 'object') out.push(...Object.values(f.plugins));
  return out;
}

export interface ParsedManifest {
  name: string;
  assets: { sha256: string; kind: string }[];
  appId: string | null;
}

/** Check what the server relies on in a manifest; the rest is the plugin's business. Returns a problem text or the parsed parts. */
export function parseManifest(m: Record<string, unknown>): ParsedManifest | string {
  if (typeof m.schema !== 'number' || !SHOW_MANIFEST_SCHEMAS.includes(m.schema)) {
    return `manifest.schema ${String(m.schema)} is not supported (this server reads ${SHOW_MANIFEST_SCHEMAS.join(', ')}); update CTD Relay`;
  }
  const name = typeof m.name === 'string' ? m.name.trim() : '';
  if (!name || name.length > NAME_MAX || CONTROL_RE.test(name)) return `manifest.name: 1–${NAME_MAX} characters, no control characters`;
  const files = m.files;
  if (files !== undefined && (typeof files !== 'object' || files === null || Array.isArray(files))) return 'manifest.files must be an object';
  for (const p of manifestPaths(files)) {
    if (!safeRelativePath(p)) return `manifest.files: "${String(p).slice(0, 80)}" is not a safe relative path`;
  }
  const rawAssets = m.assets ?? [];
  if (!Array.isArray(rawAssets)) return 'manifest.assets must be an array';
  if (rawAssets.length > MAX_MANIFEST_ASSETS) return `manifest.assets: at most ${MAX_MANIFEST_ASSETS}`;
  const assets: ParsedManifest['assets'] = [];
  for (const a of rawAssets) {
    const sha = (a as { sha256?: unknown } | null)?.sha256;
    if (typeof sha !== 'string' || !SHA256_RE.test(sha)) return 'manifest.assets[].sha256 must be a lowercase hex SHA-256';
    const kind = (a as { kind?: unknown }).kind;
    assets.push({ sha256: sha, kind: typeof kind === 'string' ? kind : 'other' });
  }
  const savedBy = m.savedBy as { appId?: unknown } | null | undefined;
  const appId = typeof savedBy?.appId === 'string' && savedBy.appId.length <= 64 && !CONTROL_RE.test(savedBy.appId) ? savedBy.appId : null;
  return { name, assets, appId };
}

function apiRevision(r: ShowRevisionSummary, profileId: string): ApiShowRevision {
  return {
    profileId,
    revision: r.revision,
    parentRevision: r.parentRevision,
    bundleSha256: r.bundleSha256,
    size: r.size,
    savedBy: { appId: r.savedByApp },
    note: r.note,
    pinned: r.pinned,
    savedAt: r.createdAt,
  };
}

/** GET /profiles item `show` (null before the first save). */
export function showSummary(services: AppServices, profileId: string): ApiShowSummary | null {
  const sp = services.repos.showProfiles.getByProfile(profileId);
  if (!sp || sp.headRevision === 0) return null;
  const head = services.repos.showProfiles.getRevision(sp.id, sp.headRevision);
  return { headRevision: sp.headRevision, updatedAt: sp.updatedAt, savedBy: { appId: head?.savedByApp ?? null } };
}

/** Parse a single-range `Range: bytes=…` header against `size`. undefined = no/ignored header, null = unsatisfiable. */
export function parseRange(header: unknown, size: number): { start: number; end: number } | null | undefined {
  if (typeof header !== 'string' || header.trim() === '') return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined; // multi-range or malformed: send the whole file (RFC 9110 allows ignoring)
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return null;
  return { start, end };
}

export function registerShowRoutes(app: FastifyInstance, ctx: V1Context): void {
  const { services, requireToken, authOf, resolveProfile } = ctx;
  const { repos } = services;
  const uploads = new ConcurrencyLimiter(MAX_UPLOADS_PER_TOKEN);
  /** tokenId → sha256 → when it uploaded it. */
  const proven = new Map<string, Map<string, number>>();

  const store = () => services.blobStore;

  const prove = (tokenId: string, sha: string): void => {
    let m = proven.get(tokenId);
    if (!m) {
      m = new Map();
      proven.set(tokenId, m);
    }
    m.delete(sha);
    m.set(sha, ctx.now());
    while (m.size > MAX_PROVEN_PER_TOKEN) m.delete(m.keys().next().value as string);
  };
  const isProven = (tokenId: string, sha: string): boolean => {
    const at = proven.get(tokenId)?.get(sha);
    return at !== undefined && ctx.now() - at < PROVEN_TTL_MS;
  };

  /** Can this token read (or build on) the blob? Every-profile tokens see every referenced blob. */
  const canSee = (token: ApiTokenInfo, sha: string): boolean => {
    if (!store().has(sha)) return false;
    if (isProven(token.id, sha)) return true;
    return repos.blobs.isVisible(sha, token.profileId ?? null);
  };
  /** For /blobs/check and saves: an every-profile token may build on anything stored. */
  const usable = (token: ApiTokenInfo, sha: string): boolean => {
    if (token.profileId == null) return store().has(sha);
    return canSee(token, sha);
  };

  const pathProfile = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const { token } = authOf(req);
    const raw = params(req).id;
    const p = resolveProfile(token, typeof raw === 'string' && raw !== '' ? raw : '\u0000', null);
    if (!p.ok || p.profile === null) {
      if (!p.ok) sendProblem(reply, p.status === 400 ? 404 : p.status, p.status === 400 ? 'unknown_profile' : p.code, p.detail);
      return null;
    }
    return p.profile;
  };

  const showOf = (profileId: string, reply: FastifyReply) => {
    const sp = repos.showProfiles.getByProfile(profileId);
    if (!sp || sp.headRevision === 0) {
      sendProblem(reply, 404, 'not_found', 'This profile has no show profile yet (save one from CTD OBS first).');
      return null;
    }
    return sp;
  };

  const revisionParam = (req: FastifyRequest, reply: FastifyReply): number | null => {
    const raw = params(req).rev;
    if (typeof raw !== 'string' || !/^[1-9]\d{0,9}$/.test(raw)) {
      sendProblem(reply, 404, 'not_found', 'No such revision');
      return null;
    }
    return Number(raw);
  };

  // ---- show profiles ----

  app.get('/profiles/:id/show', { preHandler: requireToken('show:read') }, async (req, reply) => {
    const profileId = pathProfile(req, reply);
    if (profileId === null) return reply;
    const sp = showOf(profileId, reply);
    if (!sp) return reply;
    const head = repos.showProfiles.getRevision(sp.id, sp.headRevision);
    const body: ApiShowProfile = {
      id: sp.id,
      profileId,
      name: sp.name,
      headRevision: sp.headRevision,
      createdAt: sp.createdAt,
      updatedAt: sp.updatedAt,
      savedBy: { appId: head?.savedByApp ?? null },
    };
    return reply.header('cache-control', 'no-store').send(body);
  });

  app.get('/profiles/:id/show/revisions', { preHandler: requireToken('show:read') }, async (req, reply) => {
    const profileId = pathProfile(req, reply);
    if (profileId === null) return reply;
    const sp = showOf(profileId, reply);
    if (!sp) return reply;
    const items = repos.showProfiles.listRevisions(sp.id).map((r) => apiRevision(r, profileId));
    return reply.header('cache-control', 'no-store').send({ items, head: sp.headRevision });
  });

  const loadRevision = (req: FastifyRequest, reply: FastifyReply): { profileId: string; showProfileId: string; rev: ShowRevisionRecord } | null => {
    const profileId = pathProfile(req, reply);
    if (profileId === null) return null;
    const sp = showOf(profileId, reply);
    if (!sp) return null;
    const n = revisionParam(req, reply);
    if (n === null) return null;
    const rev = repos.showProfiles.getRevision(sp.id, n);
    if (!rev) {
      sendProblem(reply, 404, 'not_found', `No revision ${n} (it may have been pruned; see /show/revisions)`);
      return null;
    }
    return { profileId, showProfileId: sp.id, rev };
  };

  app.get('/profiles/:id/show/revisions/:rev', { preHandler: requireToken('show:read') }, async (req, reply) => {
    const found = loadRevision(req, reply);
    if (!found) return reply;
    let manifest: unknown;
    try {
      manifest = JSON.parse(found.rev.manifest);
    } catch {
      manifest = null;
    }
    return reply.header('cache-control', 'no-store').send({ ...apiRevision(found.rev, found.profileId), manifest });
  });

  app.get('/profiles/:id/show/revisions/:rev/bundle', { preHandler: requireToken('show:read') }, async (req, reply) => {
    const found = loadRevision(req, reply);
    if (!found) return reply;
    return sendBlob(req, reply, found.rev.bundleSha256, `bundle-${found.rev.revision}.tar`);
  });

  // The values the manifest's `secrets[]` stand for. Kept out of the bundle so the bundle stays
  // byte-identical to its hash; only for tokens the admin gave show:secrets.
  app.get('/profiles/:id/show/revisions/:rev/secrets', { preHandler: requireToken('show:secrets') }, async (req, reply) => {
    const found = loadRevision(req, reply);
    if (!found) return reply;
    const items = (await repos.secrets.scoped(showSecretScope(found.showProfileId)).getJson<ApiShowSecret[]>(`rev:${found.rev.revision}`)) ?? [];
    const { token } = authOf(req);
    services.repos.audit.log({
      userId: null,
      username: null,
      action: 'show.secrets.read',
      detail: `profile ${found.profileId} revision ${found.rev.revision} by token ${token.name}`,
      ip: req.ip,
    });
    return reply.header('cache-control', 'no-store').send({ items });
  });

  app.post(
    '/profiles/:id/show/revisions',
    { preHandler: requireToken('show:write'), bodyLimit: SAVE_BODY_SLACK + 1024 * 1024 },
    async (req, reply) => {
      const profileId = pathProfile(req, reply);
      if (profileId === null) return reply;
      const { token } = authOf(req);
      const body = SaveBody.parse(req.body ?? {});
      const limits = store().limits();
      const manifestText = JSON.stringify(body.manifest);
      if (Buffer.byteLength(manifestText, 'utf8') > limits.manifestBytes) {
        return sendProblem(reply, 413, 'limit', `The manifest is over ${limits.manifestBytes} bytes`);
      }
      const parsed = parseManifest(body.manifest);
      if (typeof parsed === 'string') return sendProblem(reply, 400, 'invalid', parsed);
      if (body.secrets && jsonBytes(body.secrets) > SAVE_BODY_SLACK) return sendProblem(reply, 413, 'limit', 'secrets: too large');

      const needed = [...new Set([body.bundleSha256, ...parsed.assets.map((a) => a.sha256)])];
      const missing = needed.filter((sha) => !usable(token, sha));
      if (missing.length > 0) {
        return reply
          .code(400)
          .type(PROBLEM_CONTENT_TYPE)
          .send({ ...problem(400, 'missing_blobs', `Upload these blobs first (PUT /blobs/{sha256}): ${missing.length} missing`), missing });
      }
      const bundle = repos.blobs.get(body.bundleSha256);
      if (bundle && bundle.size > limits.bundleBytes) return sendProblem(reply, 413, 'limit', `The bundle is over ${limits.bundleBytes} bytes`);
      const size = needed.reduce((sum, sha) => sum + (repos.blobs.get(sha)?.size ?? 0), 0);

      const before = repos.showProfiles.getByProfile(profileId);
      const keptBefore = before ? repos.showProfiles.listRevisions(before.id).map((r) => r.revision) : [];
      let saved: ShowRevisionRecord;
      try {
        saved = repos.showProfiles.addRevision(
          {
            profileId,
            name: parsed.name,
            parentRevision: body.parentRevision,
            manifest: manifestText,
            bundleSha256: body.bundleSha256,
            size,
            blobs: needed,
            savedByApp: parsed.appId,
            savedByToken: token.id,
            note: body.note ?? null,
          },
          limits.maxRevisions,
        );
      } catch (err) {
        const e = err as { code?: unknown; head?: unknown };
        if (e.code === 'revision_conflict' && typeof e.head === 'number') {
          return reply
            .code(409)
            .type(PROBLEM_CONTENT_TYPE)
            .send({
              ...problem(409, 'revision_conflict', `Revision ${e.head} was saved meanwhile; load it, merge and save with parentRevision ${e.head}`),
              head: e.head,
            });
        }
        throw err;
      }

      // Secrets of this revision; drop those of revisions the save pruned.
      const secrets = repos.secrets.scoped(showSecretScope(saved.showProfileId));
      if (body.secrets && body.secrets.length > 0) await secrets.setJson(`rev:${saved.revision}`, body.secrets satisfies ApiShowSecret[]);
      const keptNow = new Set(repos.showProfiles.listRevisions(saved.showProfileId).map((r) => r.revision));
      for (const n of keptBefore) if (!keptNow.has(n)) await secrets.delete(`rev:${n}`);

      services.repos.audit.log({
        userId: null,
        username: null,
        action: 'show.save',
        detail: `profile ${profileId} revision ${saved.revision} (parent ${body.parentRevision}) by token ${token.name}`,
        ip: req.ip,
      });
      services.bus.emit('show-changed', { profileId, revision: saved.revision, parentRevision: saved.parentRevision, byAppId: parsed.appId });
      return reply.code(201).header('cache-control', 'no-store').send(apiRevision(saved, profileId));
    },
  );

  // ---- blobs ----

  app.post('/blobs/check', { preHandler: requireToken('show:write'), bodyLimit: 256 * 1024 }, async (req, reply) => {
    const { token } = authOf(req);
    const body = CheckBody.parse(req.body ?? {});
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const item of body.items) {
      if (seen.has(item.sha256)) continue;
      seen.add(item.sha256);
      if (!usable(token, item.sha256)) missing.push(item.sha256);
    }
    return reply.header('cache-control', 'no-store').send({ missing });
  });

  // Raw bodies: streamed straight to disk, so the 1 MB JSON body limit doesn't apply. The blob
  // store counts the bytes against the kind's limit and the quota and checks the hash.
  app.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

    raw.put('/blobs/:sha256', { preHandler: requireToken('show:write'), bodyLimit: Number.MAX_SAFE_INTEGER }, async (req, reply) => {
      const { token } = authOf(req);
      const sha = params(req).sha256;
      if (typeof sha !== 'string' || !SHA256_RE.test(sha)) return sendProblem(reply, 400, 'invalid', 'The path must be the lowercase hex SHA-256 of the body');
      const kindRaw = query(req).kind ?? 'other';
      if (!isBlobKind(kindRaw)) return sendProblem(reply, 400, 'invalid', 'kind must be one of lut, image, video, audio, font, html, bundle, other');
      const kind: BlobKind = kindRaw;
      const lengthHeader = req.headers['content-length'];
      const expectedSize = typeof lengthHeader === 'string' && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : undefined;
      const limit = maxBytesForKind(kind, store().limits());
      if (expectedSize !== undefined && expectedSize > limit) return sendProblem(reply, 413, 'limit', `Larger than the ${kind} limit (${limit} bytes)`);
      if (!uploads.acquire(token.id)) {
        reply.header('retry-after', '5');
        return sendProblem(reply, 429, 'rate_limited', `At most ${MAX_UPLOADS_PER_TOKEN} uploads per token at once`);
      }
      try {
        const source = (req.body as NodeJS.ReadableStream | undefined) ?? req.raw;
        const res = await store().write(sha, source as AsyncIterable<Buffer>, { kind, ...(expectedSize !== undefined ? { expectedSize } : {}) });
        prove(token.id, sha);
        if (res.created) {
          services.repos.audit.log({
            userId: null,
            username: null,
            action: 'show.blob.upload',
            detail: `${kind} ${sha.slice(0, 12)} (${res.record.size} bytes) by token ${token.name}`,
            ip: req.ip,
          });
        }
        return reply.code(res.created ? 201 : 200).send({ sha256: sha, size: res.record.size, kind: res.record.kind, created: res.created });
      } catch (err) {
        if (err instanceof BlobError) {
          if (err.code === 'aborted') {
            req.log.debug({ sha256: sha }, 'blob upload aborted');
            return reply.code(400).send(problem(400, 'invalid', err.message));
          }
          const code = err.code === 'hash_mismatch' ? 'hash_mismatch' : err.code === 'quota_exceeded' ? 'quota_exceeded' : err.code === 'too_large' ? 'limit' : 'invalid';
          const status = err.code === 'unsupported_type' ? 415 : err.statusCode;
          // The rest of the body is unread: close the connection rather than drain gigabytes.
          if (!req.raw.readableEnded) reply.header('connection', 'close');
          return sendProblem(reply, status, code, err.message);
        }
        throw err;
      } finally {
        uploads.release(token.id);
      }
    });
  });

  async function sendBlob(req: FastifyRequest, reply: FastifyReply, sha: string, filename: string): Promise<FastifyReply> {
    const st = store().stat(sha);
    if (!st) return sendProblem(reply, 404, 'not_found', 'No such blob');
    reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('etag', `"${sha}"`)
      .header('accept-ranges', 'bytes');
    if (req.headers['if-none-match'] === `"${sha}"`) return reply.code(304).send();
    const range = parseRange(req.headers.range, st.size);
    if (range === null) return reply.code(416).header('content-range', `bytes */${st.size}`).send();
    if (range) {
      reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${st.size}`).header('content-length', String(range.end - range.start + 1));
      return reply.send(store().open(sha, range));
    }
    reply.header('content-length', String(st.size));
    return reply.send(store().open(sha));
  }

  app.get('/blobs/:sha256', { preHandler: requireToken('show:read') }, async (req, reply) => {
    const { token } = authOf(req);
    const sha = params(req).sha256;
    // Same answer for "no such blob" and "not yours": existence never leaks across profiles.
    if (typeof sha !== 'string' || !SHA256_RE.test(sha) || !canSee(token, sha)) return sendProblem(reply, 404, 'not_found', 'No such blob');
    return sendBlob(req, reply, sha, sha);
  });

  // ---- the asset library (uploaded in the web UI, Assets page) ----

  app.get('/library', { preHandler: requireToken('show:read') }, async (req, reply) => {
    const { token } = authOf(req);
    const q = query(req);
    let profileId: string | undefined;
    if (q.profile !== undefined && q.profile !== '') {
      const p = resolveProfile(token, q.profile, null);
      if (!p.ok) return sendProblem(reply, p.status, p.code, p.detail);
      profileId = p.profile ?? undefined;
    } else if (token.profileId) {
      profileId = token.profileId;
    }
    const kind = typeof q.kind === 'string' && q.kind !== '' ? q.kind : undefined;
    if (kind !== undefined && !isBlobKind(kind)) return sendProblem(reply, 400, 'invalid', 'kind must be one of lut, image, video, audio, font, html, bundle, other');
    const items: ApiLibraryAsset[] = repos.assetLibrary
      .list({ ...(profileId !== undefined ? { profileId } : {}), ...(kind !== undefined ? { kind } : {}) })
      .map((a) => ({ id: a.id, sha256: a.sha256, name: a.name, kind: a.kind, profileId: a.profileId, size: a.size, createdAt: a.createdAt }));
    return reply.header('cache-control', 'no-store').send({ items });
  });
}
