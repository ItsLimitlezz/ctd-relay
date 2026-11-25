import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import type { IngestInfo } from '../../../../shared/api.js';
import type { Feed, User } from '../../../../shared/types.js';
import type { AppServices } from '../../services.js';
import ingestRoutes, { ingestHost } from './ingest.js';
import { srtStatusOn } from '../../../../shared/srt.js';

const admin: User = { id: 'u1', username: 'admin', role: 'admin', totpEnabled: false, createdAt: '', lastLoginAt: null };

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function build(opts: { user?: User | null; ingestHostSetting?: string; srtPort?: number } = {}) {
  const keys: Record<string, Record<Feed, string>> = {
    default: { landscape: 'LandKey000000000000000000', vertical: 'VertKey000000000000000000' },
    club: { landscape: 'ClubLand00000000000000000', vertical: 'ClubVert00000000000000000' },
  };
  const slugs: Record<string, string | null> = { default: null, club: 'dprtmnt' };
  const media = {
    appName: 'live',
    ingestKeys: vi.fn(async (profileId: string) => ({ ...keys[profileId]! })),
    streamKeyField: vi.fn(async (profileId: string, feed: Feed) => {
      const slug = slugs[profileId];
      return `${slug ? `${slug}/` : ''}${feed}?key=${keys[profileId]![feed]}`;
    }),
    rotateIngestKey: vi.fn(async (profileId: string, feed: Feed) => {
      keys[profileId]![feed] = 'RotatedKey00000000000000';
      return keys[profileId]![feed];
    }),
    srtStatus: opts.srtPort ? () => srtStatusOn(opts.srtPort!) : undefined,
  };
  const auditLog = vi.fn();
  const services = {
    config: { rtmpPort: 1936 },
    media,
    repos: {
      audit: { log: auditLog },
      profiles: { get: (id: string) => (id in slugs ? { id, slug: slugs[id] ?? 'main' } : null) },
    },
    appSettings: () => ({ publicBaseUrl: '', ingestHost: opts.ingestHostSetting ?? '', disconnectGraceSec: 15 }),
  } as unknown as AppServices;

  const user = opts.user === undefined ? admin : opts.user;
  app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('authSession', null);
  app.addHook('onRequest', async (req) => {
    req.user = user;
  });
  app.setErrorHandler((err, _req, reply) => reply.code(err instanceof ZodError ? 400 : 500).send({ error: String(err) }));
  await app.register(ingestRoutes, { services });
  return { app, media, auditLog };
}

describe('ingestHost', () => {
  it('prefers the setting, else the request host, and normalizes it', () => {
    expect(ingestHost('', '192.168.1.20')).toBe('192.168.1.20');
    expect(ingestHost('  nas.lan  ', '192.168.1.20')).toBe('nas.lan');
    expect(ingestHost('rtmp://nas.lan:1935/live', 'x')).toBe('nas.lan');
    expect(ingestHost('nas.lan:1935', 'x')).toBe('nas.lan');
    expect(ingestHost('', '[::1]')).toBe('[::1]');
    expect(ingestHost('fe80::1', 'x')).toBe('[fe80::1]');
    expect(ingestHost('', '')).toBe('localhost');
  });
});

describe('ingest routes', () => {
  it('GET /api/ingest returns the default profile settings, unchanged from before profiles', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/api/ingest', headers: { host: '192.168.1.20:8443' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json<IngestInfo>()).toEqual({
      profileId: 'default',
      serverUrl: 'rtmp://192.168.1.20:1936/live',
      feeds: [
        { feed: 'landscape', streamKey: 'landscape?key=LandKey000000000000000000', fullUrl: 'rtmp://192.168.1.20:1936/live/landscape?key=LandKey000000000000000000', srtUrl: null },
        { feed: 'vertical', streamKey: 'vertical?key=VertKey000000000000000000', fullUrl: 'rtmp://192.168.1.20:1936/live/vertical?key=VertKey000000000000000000', srtUrl: null },
      ],
      srt: expect.objectContaining({ enabled: false, port: null }),
    });
  });

  it('GET /api/ingest?profile= returns that profile’s own OBS settings', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/api/ingest?profile=club', headers: { host: 'nas.lan' } });
    expect(res.statusCode).toBe(200);
    expect(res.json<IngestInfo>()).toEqual({
      profileId: 'club',
      serverUrl: 'rtmp://nas.lan:1936/live',
      feeds: [
        { feed: 'landscape', streamKey: 'dprtmnt/landscape?key=ClubLand00000000000000000', fullUrl: 'rtmp://nas.lan:1936/live/dprtmnt/landscape?key=ClubLand00000000000000000', srtUrl: null },
        { feed: 'vertical', streamKey: 'dprtmnt/vertical?key=ClubVert00000000000000000', fullUrl: 'rtmp://nas.lan:1936/live/dprtmnt/vertical?key=ClubVert00000000000000000', srtUrl: null },
      ],
      srt: expect.objectContaining({ enabled: false, port: null }),
    });
    expect((await app.inject({ method: 'GET', url: '/api/ingest?profile=default' })).json<IngestInfo>().profileId).toBe('default');
  });

  it('with SRT on, each feed also has its SRT server address (OBS Server field, key in the streamid)', async () => {
    const { app } = await build({ srtPort: 8890 });
    const info = (await app.inject({ method: 'GET', url: '/api/ingest?profile=club', headers: { host: 'nas.lan' } })).json<IngestInfo>();
    expect(info.srt).toMatchObject({ enabled: true, port: 8890, latencyMs: 150, internetLatencyMs: 800, reason: null });
    expect(info.feeds.map((f) => f.srtUrl)).toEqual([
      'srt://nas.lan:8890?streamid=publish:live/dprtmnt/landscape:key=ClubLand00000000000000000&latency=150000',
      'srt://nas.lan:8890?streamid=publish:live/dprtmnt/vertical:key=ClubVert00000000000000000&latency=150000',
    ]);
  });

  it('answers 404 unknown_profile for an unknown profile', async () => {
    const { app, media } = await build();
    const res = await app.inject({ method: 'GET', url: '/api/ingest?profile=nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Profile not found', code: 'unknown_profile' });
    const rot = await app.inject({ method: 'POST', url: '/api/ingest/rotate', payload: { feed: 'vertical', profileId: 'nope' } });
    expect(rot.statusCode).toBe(404);
    expect(media.rotateIngestKey).not.toHaveBeenCalled();
  });

  it('uses the ingestHost setting when set', async () => {
    const { app } = await build({ ingestHostSetting: 'nas.lan' });
    const res = await app.inject({ method: 'GET', url: '/api/ingest', headers: { host: 'public.example.com' } });
    expect(res.json<IngestInfo>().serverUrl).toBe('rtmp://nas.lan:1936/live');
  });

  it('POST /api/ingest/rotate rotates one feed of the default profile and audits it', async () => {
    const { app, media, auditLog } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/ingest/rotate', payload: { feed: 'vertical' }, headers: { host: 'nas.lan' } });
    expect(res.statusCode).toBe(200);
    expect(media.rotateIngestKey).toHaveBeenCalledWith('default', 'vertical');
    expect(res.json<IngestInfo>().feeds[1]?.streamKey).toBe('vertical?key=RotatedKey00000000000000');
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', action: 'ingest.rotate', detail: 'vertical' }));
    expect(JSON.stringify(auditLog.mock.calls)).not.toContain('RotatedKey');
  });

  it('POST /api/ingest/rotate rotates another profile (body profileId or ?profile=)', async () => {
    const { app, media, auditLog } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/ingest/rotate', payload: { feed: 'landscape', profileId: 'club' } });
    expect(res.statusCode).toBe(200);
    expect(media.rotateIngestKey).toHaveBeenCalledWith('club', 'landscape');
    expect(res.json<IngestInfo>()).toMatchObject({ profileId: 'club', feeds: [{ streamKey: 'dprtmnt/landscape?key=RotatedKey00000000000000' }, {}] });
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ingest.rotate', detail: 'landscape profile=club' }));

    await app.inject({ method: 'POST', url: '/api/ingest/rotate?profile=club', payload: { feed: 'vertical' } });
    expect(media.rotateIngestKey).toHaveBeenLastCalledWith('club', 'vertical');
    expect(JSON.stringify(auditLog.mock.calls)).not.toContain('RotatedKey');
  });

  it('validates the feed', async () => {
    const { app, media } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/ingest/rotate', payload: { feed: 'square' } });
    expect(res.statusCode).toBe(400);
    expect(media.rotateIngestKey).not.toHaveBeenCalled();
  });

  it('is admin-only', async () => {
    const operator: User = { ...admin, role: 'operator' };
    expect((await (await build({ user: operator })).app.inject({ method: 'GET', url: '/api/ingest' })).statusCode).toBe(403);
    await app?.close();
    const anon = await build({ user: null });
    expect((await anon.app.inject({ method: 'GET', url: '/api/ingest' })).statusCode).toBe(401);
    expect((await anon.app.inject({ method: 'POST', url: '/api/ingest/rotate', payload: { feed: 'vertical' } })).statusCode).toBe(401);
    expect(anon.media.rotateIngestKey).not.toHaveBeenCalled();
  });
});
