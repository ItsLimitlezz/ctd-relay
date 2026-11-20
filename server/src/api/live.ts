// Feed preview routes shared by the web UI (session cookie, /api/profiles/...) and the external API
// (bearer token, /api/v1/profiles/...): the JPEG thumbnail and the live preview (LL-HLS) proxy.
// See docs/PREVIEW.md and docs/API.md §10.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Feed } from '../../../shared/types.js';
import { DEFAULT_LIVE_MAX_VIEWERS, livePreviewServiceFor, PLAYLIST_CONTENT_TYPE, type LiveError, type LivePreviewService, type LiveResult } from '../media/live-preview.js';
import type { AppServices } from '../services.js';
import { grabWithFfmpeg, previewServiceFor, type PreviewService } from './previews.js';

export function isFeed(value: unknown): value is Feed {
  return value === 'landscape' || value === 'vertical';
}

/** The JPEG preview service of these services (FFmpeg grabs from MediaMTX). */
export function previewsOf(services: AppServices): PreviewService {
  return previewServiceFor(services, () => ({
    online: (profileId, feed) => services.media.feed(profileId, feed).online,
    grab: (profileId, feed) => grabWithFfmpeg(services.config.ffmpegBin, services.media.readUrl(profileId, feed)),
  }));
}

/** The live preview service of these services (LL-HLS from the loopback MediaMTX). */
export function livePreviewOf(services: AppServices): LivePreviewService {
  return livePreviewServiceFor(services, () => {
    const log = services.log.child({ mod: 'live-preview' });
    return {
      feed: (profileId, feed) => services.media.feed(profileId, feed),
      source: (profileId, feed) => services.media.hlsSource?.(profileId, feed) ?? null,
      maxViewers: services.config.livePreviewMaxViewers ?? DEFAULT_LIVE_MAX_VIEWERS,
      warn: (fields, msg) => log.warn(fields, msg),
    };
  });
}

export interface LiveRouteOptions {
  /** e.g. '/api/profiles/:id/feeds/:feed' or '/profiles/:id/feeds/:feed' (under the /api/v1 prefix). */
  base: string;
  preHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  /** For `live/<file>` (a player asks ~20 times a second); default: preHandler. */
  filePreHandler?: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  /** The `{id}` profile, checked; sends the error and returns null otherwise. */
  profile(req: FastifyRequest, reply: FastifyReply): string | null;
  /** Who is asking ('session:<id>' / 'token:<id>'): a viewer only works for whoever opened it. */
  who(req: FastifyRequest): string;
  /** Send an error in the route family's own format. */
  error(reply: FastifyReply, status: number, code: LiveError['code'], message: string): FastifyReply;
  live: () => LivePreviewService;
}

function feedOf(req: FastifyRequest): Feed | null {
  const feed = (req.params as Record<string, unknown> | undefined)?.feed;
  return isFeed(feed) ? feed : null;
}

/** Abort upstream work when the client goes away before the response is done. */
function clientGone(reply: FastifyReply): AbortSignal {
  const ac = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) ac.abort();
  });
  return ac.signal;
}

function sendLive(reply: FastifyReply, result: LiveResult, opts: LiveRouteOptions): FastifyReply {
  reply.header('cache-control', 'no-store');
  if (!result.ok) {
    if (result.retryAfterSec) reply.header('retry-after', String(result.retryAfterSec));
    return opts.error(reply, result.status, result.code, result.message);
  }
  if (result.kind === 'playlist') return reply.type(PLAYLIST_CONTENT_TYPE).send(result.body);
  if (result.contentLength && /^\d+$/.test(result.contentLength)) reply.header('content-length', result.contentLength);
  return reply.type(result.contentType).send(result.body);
}

/** GET <base>/live.m3u8 and <base>/live/<file>. */
export function registerLiveRoutes(app: FastifyInstance, opts: LiveRouteOptions): void {
  app.get(`${opts.base}/live.m3u8`, { preHandler: opts.preHandler }, async (req, reply) => {
    const profileId = opts.profile(req, reply);
    if (profileId === null) return reply;
    const feed = feedOf(req);
    if (!feed) return opts.error(reply, 404, 'not_found', 'Feed: landscape or vertical.');
    return sendLive(reply, await opts.live().open(profileId, feed, opts.who(req)), opts);
  });

  app.get(`${opts.base}/live/:file`, { preHandler: opts.filePreHandler ?? opts.preHandler }, async (req, reply) => {
    const profileId = opts.profile(req, reply);
    if (profileId === null) return reply;
    const feed = feedOf(req);
    if (!feed) return opts.error(reply, 404, 'not_found', 'Feed: landscape or vertical.');
    const file = (req.params as Record<string, unknown>).file;
    const query = (req.query ?? {}) as Record<string, unknown>;
    const result = await opts.live().file(profileId, feed, typeof file === 'string' ? file : '', query, opts.who(req), clientGone(reply));
    return sendLive(reply, result, opts);
  });
}
