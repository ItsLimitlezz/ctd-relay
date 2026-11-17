import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, type TranscodeCapabilities } from '../../../../shared/api.js';
import type { Role } from '../../../../shared/types.js';
import { createTestApi, type TestApi } from '../../api/test-helpers.js';
import { TranscodeCapabilityService, setTranscodeCapabilitiesFor, type RunFn } from '../../media/transcode-capabilities.js';

let t: TestApi;

beforeEach(async () => {
  t = await createTestApi();
});
afterEach(async () => {
  await t.close();
});

function login(role: Role) {
  const user = t.repos.users.create({ username: role, passwordHash: 'x', role });
  const { token } = t.repos.authSessions.create(user.id, { ip: null, userAgent: null });
  return `${SESSION_COOKIE}=${token}`;
}

/** A capability service whose FFmpeg has libx264 only (working) and h264_nvenc (no driver). */
async function probedService(): Promise<TranscodeCapabilityService> {
  const run: RunFn = async (_cmd, args) => {
    const res = (stdout: string, code = 0, stderr = '') => ({ code, stdout, stderr, timedOut: false, spawnError: null });
    if (args.includes('-version')) return res('ffmpeg version n8.1.3 Copyright (c) the FFmpeg developers\n');
    if (args.includes('-hwaccels')) return res('Hardware acceleration methods:\ncuda\n');
    if (args.includes('-encoders')) {
      return res(' ------\n V....D libx264   libx264 H.264 (codec h264)\n V....D h264_nvenc   NVIDIA NVENC H.264 encoder (codec h264)\n');
    }
    if (args.includes('-decoders')) return res(' ------\n VFS..D h264   H.264\n');
    if (args.includes('h264_nvenc')) return res('', 255, '[h264_nvenc @ 0x1] Cannot load libcuda.so.1\n');
    return res('frame=30\nspeed=4.2x\nprogress=end\n');
  };
  const svc = new TranscodeCapabilityService({ ffmpegBin: 'ffmpeg', run, listRenderNodes: () => [], hasNvidiaDevice: () => false, cpu: () => ({ cores: 4, model: null }) });
  await svc.start();
  return svc;
}

describe('GET /api/system/transcode-capabilities', () => {
  it('needs a signed-in user (any role)', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/system/transcode-capabilities' })).statusCode).toBe(401);
    const res = await t.app.inject({ method: 'GET', url: '/api/system/transcode-capabilities', headers: { cookie: login('operator') } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('reports probing before the startup probe has run, then the cached result', async () => {
    const cookie = login('admin');
    const before = (await t.app.inject({ method: 'GET', url: '/api/system/transcode-capabilities', headers: { cookie } })).json<TranscodeCapabilities>();
    expect(before).toMatchObject({ state: 'probing', encoders: [], supported: { h264: false, hevc: false, av1: false } });

    setTranscodeCapabilitiesFor(t.services, await probedService());
    const after = (await t.app.inject({ method: 'GET', url: '/api/system/transcode-capabilities', headers: { cookie } })).json<TranscodeCapabilities>();
    expect(after).toMatchObject({ state: 'ready', supported: { h264: true, hevc: false, av1: false }, hwaccels: ['cuda'] });
    expect(after.encoders).toEqual([
      { encoder: 'h264_nvenc', codec: 'h264', backend: 'nvenc', ok: false, speed: null, device: null, error: 'Cannot load libcuda.so.1' },
      { encoder: 'libx264', codec: 'h264', backend: 'software', ok: true, speed: 4.2, device: null, error: null },
    ]);
  });
});

describe('GET /api/v1/system/transcode-capabilities', () => {
  const get = (token?: string) =>
    t.app.inject({ method: 'GET', url: '/api/v1/system/transcode-capabilities', headers: token ? { authorization: `Bearer ${token}` } : {} });

  it('needs a token with status:read', async () => {
    expect((await get()).statusCode).toBe(401);
    const res = await get(t.token(['chat:read']));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'missing_scope' });
  });

  it('returns the cached result (server-wide: a profile-limited token sees it too)', async () => {
    setTranscodeCapabilitiesFor(t.services, await probedService());
    const club = t.addProfile('Club');
    const res = await get(t.token(['status:read'], 'dock', club.id));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json<TranscodeCapabilities>()).toMatchObject({ state: 'ready', supported: { h264: true } });
  });

  it('is in the OpenAPI document', async () => {
    const doc = (await t.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json<{ info: { version: string }; paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } }>();
    expect(doc.info.version).toMatch(/^1\.10 /);
    expect(doc.paths['/system/transcode-capabilities']).toBeDefined();
    expect(doc.components.schemas.TranscodeCapabilities).toBeDefined();
  });
});
