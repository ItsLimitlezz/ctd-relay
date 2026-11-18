// Destinations: one platform output bound to a feed, owned by one profile. Stream keys live in
// encrypted secrets (scope 'destination:<id>', key 'streamKey') and are never returned to the UI.
// Lists are per profile (`?profile=`, default: the default profile); `/:id` routes need no profile
// (ids are global) and always talk to the destination's own profile orchestrator.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isTranscoding, validateTranscodeProfile } from '../../../../shared/transcode.js';
import type { Destination, Feed, FieldSpec, PlatformInfo, TranscodeProfile } from '../../../../shared/types.js';
import { transcodeCapabilitiesFor } from '../../media/transcode-capabilities.js';
import type { DestinationsRepo } from '../../services.js';
import { audit, requireAdmin, requireUser, type RouteOptions } from '../guards.js';
import {
  badRequest,
  feedSchema,
  idParams,
  installErrorHandler,
  MAX_NAME,
  normalizeFields,
  notFound,
  optionsSchema,
  parseIngestUrl,
  parseStreamKey,
  platformIdSchema,
  profileFromQuery,
  profileIdField,
  profileOf,
  requireDriver,
  resolveProfileId,
} from '../validation.js';

/** '' and null both mean "no account"; undefined means "not submitted". */
const accountIdField = z
  .string()
  .max(128)
  .nullish()
  .transform((v) => (v === undefined ? undefined : v || null));

/** Transcoding profile (docs/TRANSCODING.md §2): the shape here, the limits in checkTranscode(). */
const transcodeSchema = z.strictObject({
  mode: z.enum(['copy', 'transcode']),
  video: z.strictObject({
    codec: z.enum(['h264', 'hevc', 'av1']),
    width: z.number().int().min(2).max(7680),
    height: z.number().int().min(2).max(7680),
    fps: z.number().int().min(1).max(240).nullable(),
    bitrateKbps: z.number().int().min(1).max(1_000_000),
    keyframeSec: z.number().int().min(1).max(60),
    encoder: z.string().regex(/^[a-z0-9_]{1,40}$/, 'Unknown encoder'),
  }),
  audio: z.union([z.literal('copy'), z.strictObject({ codec: z.literal('aac'), bitrateKbps: z.number().int().min(1).max(1000) })]),
  fallback: z.enum(['copy', 'stop']),
});

const destinationFields = {
  accountId: accountIdField,
  name: z.string().trim().min(1, 'Name is required').max(MAX_NAME),
  feed: feedSchema,
  enabled: z.boolean().optional(),
  options: optionsSchema.nullish(),
  ingestUrl: z.string().max(4096).nullish(),
  streamKey: z.string().max(4096).nullish(),
  /** undefined = not submitted (keep), null = copy. */
  transcode: transcodeSchema.nullish(),
};

const createBody = z.object({ profileId: profileIdField, platform: platformIdSchema, ...destinationFields });
const updateBody = z.object({ profileId: profileIdField, ...destinationFields }).partial();
const enabledBody = z.object({ enabled: z.boolean() });

type DestinationPatch = Parameters<DestinationsRepo['update']>[1];

interface PlatformFields {
  options: FieldSpec[];
  ingestUrl: FieldSpec | null;
  streamKey: FieldSpec | null;
}

function splitFields(info: PlatformInfo): PlatformFields {
  const fields = info.destinationFields;
  return {
    options: fields.filter((f) => (f.target ?? 'option') === 'option'),
    ingestUrl: fields.find((f) => f.target === 'ingestUrl') ?? null,
    streamKey: fields.find((f) => f.target === 'streamKey') ?? null,
  };
}

/** Value to store for ingestUrl given a submitted value (null/'' = none -> default or required error). */
function ingestUrlValue(info: PlatformInfo, field: FieldSpec | null, input: string | null | undefined): string | null {
  const value = input?.trim() || null;
  if (value === null) {
    if (typeof field?.default === 'string' && field.default) return field.default;
    if (field?.required) throw badRequest(`${field.label} is required`);
    return null;
  }
  if (!field) throw badRequest(`${info.name} destinations do not take a server URL`);
  return parseIngestUrl(value);
}

/** Validated stream key from a submitted value ('' = none). */
function streamKeyValue(info: PlatformInfo, field: FieldSpec | null, input: string | null | undefined): string {
  const key = input ? parseStreamKey(input) : '';
  if (key && !field) throw badRequest(`${info.name} destinations do not take a stream key`);
  if (!key && field?.required) throw badRequest(`${field.label} is required`);
  return key;
}

function describe(dest: Destination): string {
  return `${dest.platform} id=${dest.id} profile=${profileOf(dest)} feed=${dest.feed} name=${JSON.stringify(dest.name)}`;
}

const destinationRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const { repos, bus } = services;
  installErrorHandler(app);

  const keyStore = (id: string) => repos.secrets.scoped(`destination:${id}`);

  function getDestination(id: string): Destination {
    const dest = repos.destinations.get(id);
    if (!dest) throw notFound('Destination');
    return dest;
  }

  function checkFeed(info: PlatformInfo, feed: Feed): void {
    if (!info.feeds.includes(feed)) throw badRequest(`${info.name} does not accept the ${feed} feed`);
  }

  /** A destination's account must be of its platform and belong to the same profile. */
  function checkAccount(info: PlatformInfo, profileId: string, accountId: string | null): string | null {
    if (accountId === null) return null;
    const account = repos.accounts.get(accountId);
    if (!account) throw badRequest('Account not found');
    if (account.platform !== info.id) throw badRequest(`That account is not a ${info.name} account`);
    if (profileOf(account) !== profileId) {
      throw badRequest('That account belongs to another profile', 'account_profile_mismatch');
    }
    return accountId;
  }

  /**
   * A submitted transcoding profile must fit the platform (codec, size, frame rate, bitrate) and,
   * when it is switched on, this machine (a working encoder). null = copy. A profile saved in 'copy'
   * mode is only checked against the platform: it is kept for later and nothing encodes.
   */
  function checkTranscode(info: PlatformInfo, profile: TranscodeProfile | null): TranscodeProfile | null {
    if (profile === null) return null;
    const caps = isTranscoding(profile) ? transcodeCapabilitiesFor(services).get() : null;
    const problems = validateTranscodeProfile(profile, info.id, info.name, caps);
    if (problems.length > 0) throw badRequest(`Transcoding: ${problems[0]}`, 'transcode_invalid');
    return profile;
  }

  /** The destination's profile orchestrator (read lazily: wired after the routes are built). */
  const orchestratorOf = (dest: Destination) => services.orchestrators.get(profileOf(dest));

  /** Tell the profile's orchestrator (mid-session changes) and the UIs. Never fails the request. */
  async function changed(req: FastifyRequest, dest: Destination): Promise<void> {
    try {
      await orchestratorOf(dest).destinationChanged(dest.id);
    } catch (err) {
      req.log.warn({ err, destinationId: dest.id }, 'orchestrator.destinationChanged failed');
    }
    bus.emit('destinations-changed', { profileId: profileOf(dest) });
  }

  app.get('/api/destinations', { preHandler: requireUser }, async (req) =>
    repos.destinations.list(profileFromQuery(services, req.query)),
  );

  app.post('/api/destinations', { preHandler: requireAdmin }, async (req, reply) => {
    const body = createBody.parse(req.body);
    const profileId = resolveProfileId(services, body.profileId);
    const { info } = requireDriver(services, body.platform);
    const fields = splitFields(info);
    checkFeed(info, body.feed);
    const accountId = checkAccount(info, profileId, body.accountId ?? null);
    const options = normalizeFields(fields.options, body.options);
    const ingestUrl = ingestUrlValue(info, fields.ingestUrl, body.ingestUrl);
    const streamKey = streamKeyValue(info, fields.streamKey, body.streamKey);
    const transcode = checkTranscode(info, body.transcode ?? null);

    let dest = repos.destinations.create({
      profileId,
      platform: body.platform,
      accountId,
      name: body.name,
      feed: body.feed,
      enabled: body.enabled ?? true,
      options,
      ingestUrl,
      transcode,
    });
    if (streamKey) {
      try {
        await keyStore(dest.id).set('streamKey', streamKey);
        dest = repos.destinations.update(dest.id, { hasStreamKey: true });
      } catch (err) {
        repos.secrets.deleteScope(`destination:${dest.id}`);
        repos.destinations.delete(dest.id);
        throw err;
      }
    }

    await changed(req, dest);
    audit(services, req, 'destination.create', describe(dest));
    return reply.code(201).send(dest);
  });

  app.patch('/api/destinations/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = updateBody.parse(req.body);
    const current = getDestination(id);
    const profileId = profileOf(current);
    // Destinations stay in their profile (its accounts, OBS feeds and session); the UI may echo it.
    if (body.profileId && body.profileId !== profileId) {
      throw badRequest("A destination can't move to another profile; create it in that profile instead");
    }
    const { info } = requireDriver(services, current.platform);
    const fields = splitFields(info);

    // Validate everything before touching storage.
    const patch: DestinationPatch = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.feed !== undefined) {
      checkFeed(info, body.feed);
      patch.feed = body.feed;
    }
    if (body.accountId !== undefined) patch.accountId = checkAccount(info, profileId, body.accountId);
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.options != null) patch.options = normalizeFields(fields.options, body.options, current.options);
    if (body.ingestUrl !== undefined) patch.ingestUrl = ingestUrlValue(info, fields.ingestUrl, body.ingestUrl);
    if (body.transcode !== undefined) patch.transcode = checkTranscode(info, body.transcode);
    // streamKey: undefined = keep, '' / null = clear, otherwise replace.
    const newKey = body.streamKey === undefined ? undefined : streamKeyValue(info, fields.streamKey, body.streamKey);

    if (newKey) {
      await keyStore(id).set('streamKey', newKey);
      patch.hasStreamKey = true;
    } else if (newKey === '') {
      await keyStore(id).delete('streamKey');
      patch.hasStreamKey = false;
    }

    const keys = Object.keys(patch).map((k) => (k === 'hasStreamKey' ? 'streamKey' : k));
    if (keys.length === 0) return current;
    const updated = repos.destinations.update(id, patch);
    await changed(req, updated);
    audit(services, req, 'destination.update', `${describe(updated)} fields=${keys.join(',')}`);
    return updated;
  });

  app.delete('/api/destinations/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParams.parse(req.params);
    const dest = getDestination(id);
    try {
      await orchestratorOf(dest).destinationRemoved(id);
    } catch (err) {
      req.log.warn({ err, destinationId: id }, 'orchestrator.destinationRemoved failed');
    }
    repos.secrets.deleteScope(`destination:${id}`);
    repos.destinations.delete(id);
    bus.emit('destinations-changed', { profileId: profileOf(dest) });
    audit(services, req, 'destination.delete', describe(dest));
    return {};
  });

  // Operators may toggle and retry destinations during a session.

  app.put('/api/destinations/:id/enabled', { preHandler: requireUser }, async (req) => {
    const { id } = idParams.parse(req.params);
    const { enabled } = enabledBody.parse(req.body);
    getDestination(id);
    const updated = repos.destinations.update(id, { enabled });
    await changed(req, updated);
    audit(services, req, enabled ? 'destination.enable' : 'destination.disable', describe(updated));
    return updated;
  });

  app.post('/api/destinations/:id/retry', { preHandler: requireUser }, async (req) => {
    const { id } = idParams.parse(req.params);
    const dest = getDestination(id);
    await orchestratorOf(dest).retryDestination(id);
    audit(services, req, 'destination.retry', describe(dest));
    return {};
  });
};

export default destinationRoutes;
