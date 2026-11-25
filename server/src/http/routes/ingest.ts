// OBS setup info: RTMP server URL + per-feed stream keys of one profile [admin].
// `?profile=<id>` (default: the default profile, whose keys are the pre-profiles ones).

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IngestInfo } from '../../../../shared/api.js';
import { DEFAULT_PROFILE_ID, FEEDS } from '../../../../shared/types.js';
import type { AppServices } from '../../services.js';
import { audit, requireAdmin, type RouteOptions } from '../guards.js';
import { HttpError, installErrorHandler } from '../validation.js';
import { srtStatusOf } from '../../media/srt-status.js';
import { srtPublishUrlFromStreamKey } from '../../../../shared/srt.js';

const profileIdSchema = z.string().min(1).max(128);
const RotateSchema = z.object({ feed: z.enum(FEEDS), profileId: profileIdSchema.optional() });
const QuerySchema = z.object({ profile: profileIdSchema.optional() });

/** Host for the OBS server URL: the ingestHost setting, else the host the browser used. */
export function ingestHost(setting: string, requestHostname: string): string {
  let host = setting.trim();
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname;
    } catch {
      // keep as typed
    }
  }
  host = host.replace(/\/.*$/, '');
  if (!host) host = requestHostname;
  // Strip a port from "host:port" (but not from a bare IPv6 address), then bracket IPv6.
  if (!host.startsWith('[') && /^[^:]+:\d+$/.test(host)) host = host.slice(0, host.lastIndexOf(':'));
  if (host.startsWith('[')) host = host.slice(0, host.indexOf(']') + 1);
  else if (host.includes(':')) host = `[${host}]`;
  return host || 'localhost';
}

/** 404 `unknown_profile` unless the profile exists. */
export function requireProfileId(services: AppServices, profileId: string): string {
  if (!services.repos.profiles.get(profileId)) throw new HttpError(404, 'Profile not found', 'unknown_profile');
  return profileId;
}

/**
 * What OBS needs to stream into a profile: server URL (`rtmp://<host>:<rtmpPort>/live`) and, per
 * feed, the "Stream Key" field (`landscape?key=…` for the default profile, `<slug>/landscape?key=…`
 * for the others). `host` is the ingestHost setting or the given request host.
 */
export async function ingestInfoFor(services: AppServices, profileId: string, requestHostname: string): Promise<IngestInfo> {
  const { media, config } = services;
  const host = ingestHost(services.appSettings().ingestHost, requestHostname);
  const serverUrl = `rtmp://${host}:${config.rtmpPort}/${media.appName}`;
  const srt = srtStatusOf(media);
  const feeds = await Promise.all(
    FEEDS.map(async (feed) => {
      const streamKey = await media.streamKeyField(profileId, feed);
      const srtUrl = srt.enabled && srt.port ? srtPublishUrlFromStreamKey(host, srt.port, media.appName, streamKey) : null;
      return { feed, streamKey, fullUrl: `${serverUrl}/${streamKey}`, srtUrl };
    }),
  );
  return { profileId, serverUrl, feeds, srt };
}

/** IngestInfo for a request (`?profile=`, default: the default profile). */
export async function buildIngestInfo(services: AppServices, req: FastifyRequest, profileId?: string): Promise<IngestInfo> {
  const id = requireProfileId(services, profileId ?? QuerySchema.parse(req.query ?? {}).profile ?? DEFAULT_PROFILE_ID);
  return ingestInfoFor(services, id, req.hostname);
}

const ingestRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  installErrorHandler(app);

  app.get('/api/ingest', { preHandler: requireAdmin }, async (req, reply) => {
    const info = await buildIngestInfo(services, req);
    reply.header('cache-control', 'no-store');
    return info;
  });

  app.post('/api/ingest/rotate', { preHandler: requireAdmin }, async (req, reply) => {
    const body = RotateSchema.parse(req.body ?? {});
    const query = QuerySchema.parse(req.query ?? {});
    const profileId = requireProfileId(services, body.profileId ?? query.profile ?? DEFAULT_PROFILE_ID);
    await services.media.rotateIngestKey(profileId, body.feed);
    audit(services, req, 'ingest.rotate', profileId === DEFAULT_PROFILE_ID ? body.feed : `${body.feed} profile=${profileId}`);
    reply.header('cache-control', 'no-store');
    return buildIngestInfo(services, req, profileId);
  });
};

export default ingestRoutes;
