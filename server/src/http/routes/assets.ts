// Assets (v1.9): the show-profile asset library (LUTs first) behind the web UI's Assets page.
// Admins upload, rename, reassign and delete; every user can list. Files are the content-addressed
// blobs of the blob store, shared with the external API's show profiles (/api/v1/blobs, /api/v1/library).

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ASSET_KINDS, type AssetItem, type AssetKind, type AssetsResponse } from '../../../../shared/api.js';
import { CONTROL_RE } from '../../api/json.js';
import type { AppServices, LibraryAsset } from '../../services.js';
import { BlobError, SHA256_RE, maxBytesForKind } from '../../storage/blob-store.js';
import { audit, requireAdmin, requireUser, sendError, type RouteOptions } from '../guards.js';
import { MAX_PROFILE_ID } from '../validation.js';

export const ASSET_NAME_MAX = 100;

const IdParams = z.object({ id: z.string().min(1).max(64) });
const nameSchema = z
  .string()
  .trim()
  .min(1, 'name is required')
  .max(ASSET_NAME_MAX, `name: at most ${ASSET_NAME_MAX} characters`)
  .refine((s) => !CONTROL_RE.test(s), 'name: control characters are not allowed');
const PatchBody = z.strictObject({
  name: nameSchema.optional(),
  profileId: z.string().trim().min(1).max(MAX_PROFILE_ID).nullable().optional(),
});

function isAssetKind(v: unknown): v is AssetKind {
  return typeof v === 'string' && (ASSET_KINDS as readonly string[]).includes(v);
}

function issues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
}

const scopeLabel = (services: Pick<AppServices, 'repos'>, profileId: string | null): string =>
  profileId === null ? 'every profile' : `profile ${services.repos.profiles.get(profileId)?.name ?? profileId}`;

const assetRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const { repos } = services;

  const toItem = (a: LibraryAsset): AssetItem => ({
    id: a.id,
    sha256: a.sha256,
    name: a.name,
    kind: a.kind as AssetKind,
    profileId: a.profileId,
    size: a.size,
    uploadedBy: a.uploadedBy,
    createdAt: a.createdAt,
    usage: repos.blobs.usage(a.sha256).map((u) => ({ profileId: u.profileId, revision: u.revision, isHead: u.isHead })),
  });

  app.get('/api/assets', { preHandler: requireUser }, async (_req, reply): Promise<AssetsResponse> => {
    reply.header('cache-control', 'no-store');
    return {
      items: repos.assetLibrary.list().map(toItem),
      usedBytes: services.blobStore.usedBytes(),
      quotaBytes: services.blobStore.limits().quotaBytes,
    };
  });

  // Raw bodies: streamed straight to disk, so the app's 1 MB JSON body limit doesn't apply. The blob
  // store counts the bytes against the kind's limit and the quota and checks the hash.
  await app.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

    raw.put('/api/assets', { preHandler: requireAdmin, bodyLimit: Number.MAX_SAFE_INTEGER }, async (req, reply) => {
      const q = (req.query ?? {}) as Record<string, unknown>;
      const name = nameSchema.safeParse(q.name);
      if (!name.success) return sendError(reply, 400, issues(name.error), 'invalid');
      if (!isAssetKind(q.kind)) return sendError(reply, 400, `kind must be one of ${ASSET_KINDS.join(', ')}`, 'invalid');
      const kind = q.kind;
      if (q.profile !== undefined && typeof q.profile !== 'string') return sendError(reply, 400, 'profile must be a profile id', 'invalid');
      const profileRaw = typeof q.profile === 'string' ? q.profile.trim() : '';
      if (profileRaw.length > MAX_PROFILE_ID) return sendError(reply, 400, 'profile must be a profile id', 'invalid');
      const profileId = profileRaw === '' ? null : profileRaw;
      if (profileId !== null && !repos.profiles.get(profileId)) return sendError(reply, 404, 'Profile not found', 'unknown_profile');
      const sha = req.headers['x-content-sha256'];
      if (typeof sha !== 'string' || !SHA256_RE.test(sha)) {
        return sendError(reply, 400, 'x-content-sha256 must be the lowercase hex SHA-256 of the file', 'invalid_hash');
      }
      const lengthHeader = req.headers['content-length'];
      const expectedSize = typeof lengthHeader === 'string' && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : undefined;
      const limit = maxBytesForKind(kind, services.blobStore.limits());
      if (expectedSize !== undefined && expectedSize > limit) {
        reply.header('connection', 'close');
        return sendError(reply, 413, `Larger than the ${kind} limit (${limit} bytes)`, 'too_large');
      }
      try {
        const source = (req.body as NodeJS.ReadableStream | undefined) ?? req.raw;
        await services.blobStore.write(sha, source as AsyncIterable<Buffer>, { kind, ...(expectedSize !== undefined ? { expectedSize } : {}) });
      } catch (err) {
        if (!(err instanceof BlobError)) throw err;
        if (err.code === 'aborted') {
          req.log.debug({ sha256: sha }, 'asset upload aborted');
          return;
        }
        // The rest of the body is unread: close the connection rather than drain gigabytes.
        if (!req.raw.readableEnded) reply.header('connection', 'close');
        switch (err.code) {
          case 'too_large':
            return sendError(reply, 413, err.message, 'too_large');
          case 'quota_exceeded':
            return sendError(reply, 413, err.message, 'quota_exceeded');
          case 'unsupported_type':
            return sendError(reply, 415, err.message, 'unsupported_type');
          default:
            return sendError(reply, 400, err.message, err.code);
        }
      }
      const asset = repos.assetLibrary.create({ sha256: sha, name: name.data, kind, profileId, uploadedBy: req.user?.username ?? null });
      audit(services, req, 'asset.upload', `${kind} ${JSON.stringify(asset.name)} ${sha.slice(0, 12)} (${asset.size} bytes), ${scopeLabel(services, profileId)}`);
      services.bus.emit('library-changed', { profileId });
      return reply.header('cache-control', 'no-store').send(toItem(asset));
    });
  });

  app.patch('/api/assets/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 400, 'Invalid asset id', 'invalid');
    const body = PatchBody.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, issues(body.error), 'invalid');
    const existing = repos.assetLibrary.get(params.data.id);
    if (!existing) return sendError(reply, 404, 'Asset not found', 'not_found');
    const patch: Partial<{ name: string; profileId: string | null }> = {};
    if (body.data.name !== undefined) patch.name = body.data.name;
    if (body.data.profileId !== undefined) {
      if (body.data.profileId !== null && !repos.profiles.get(body.data.profileId)) return sendError(reply, 404, 'Profile not found', 'unknown_profile');
      patch.profileId = body.data.profileId;
    }
    const updated = repos.assetLibrary.update(existing.id, patch);
    audit(
      services,
      req,
      'asset.update',
      `${JSON.stringify(existing.name)} -> ${JSON.stringify(updated.name)}, ${scopeLabel(services, existing.profileId)} -> ${scopeLabel(services, updated.profileId)}`,
    );
    services.bus.emit('library-changed', { profileId: updated.profileId });
    if (existing.profileId !== updated.profileId) services.bus.emit('library-changed', { profileId: existing.profileId });
    return reply.header('cache-control', 'no-store').send(toItem(updated));
  });

  app.delete('/api/assets/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 400, 'Invalid asset id', 'invalid');
    const asset = repos.assetLibrary.get(params.data.id);
    if (!asset) return sendError(reply, 404, 'Asset not found', 'not_found');
    if (repos.blobs.usage(asset.sha256).some((u) => u.isHead)) {
      return sendError(reply, 409, 'A show profile still uses this file. Save a new revision without it first.', 'asset_in_use');
    }
    // The blob file stays for the GC: it removes unreferenced blobs after 7 days.
    repos.assetLibrary.delete(asset.id);
    audit(services, req, 'asset.delete', `${asset.kind} ${JSON.stringify(asset.name)} ${asset.sha256.slice(0, 12)}`);
    services.bus.emit('library-changed', { profileId: asset.profileId });
    return {};
  });
};

export default assetRoutes;
