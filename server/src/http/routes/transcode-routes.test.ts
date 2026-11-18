// The transcoding switch, the encoder re-check and the per-destination profile over the web API
// (docs/TRANSCODING.md §2, §4.4): real routes, auth plugin and SQLite, real platform registry.

import crypto from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { CSRF_HEADER, SESSION_COOKIE, type TranscodeCapabilities, type TranscodeSettingsResponse } from '../../../../shared/api.js';
import type { Destination, Role, TranscodeProfile } from '../../../../shared/types.js';
import { openDatabase, type Db } from '../../db/database.js';
import { createRepos } from '../../db/repos.js';
import { EventBus } from '../../events.js';
import { TranscodeCapabilityService, setTranscodeCapabilitiesFor, type RunFn } from '../../media/transcode-capabilities.js';
import { createPlatformRegistry } from '../../platforms/registry.js';
import { createSecretBox } from '../../security/secretbox.js';
import type { AppServices, Repos } from '../../services.js';
import authPlugin from '../auth-plugin.js';
import { sendError } from '../guards.js';
import destinationRoutes from './destinations.js';
import systemRoutes from './system.js';

let app: FastifyInstance;
let db: Db;
let repos: Repos;
let services: AppServices;
let changed: string[];

beforeEach(async () => {
  db = openDatabase(':memory:');
  repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
  changed = [];
  services = {
    config: { tlsMode: 'off', version: '9.9.9', ffmpegBin: 'ffmpeg' },
    log: pino({ level: 'silent' }),
    bus: new EventBus(),
    repos,
    platforms: createPlatformRegistry(),
    orchestrators: {
      get: () => ({
        destinationChanged: async (id: string) => void changed.push(id),
        destinationRemoved: async () => {},
      }),
    },
  } as unknown as AppServices;
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return sendError(reply, 400, err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 'invalid');
    throw err;
  });
  await app.register(cookie);
  await app.register(authPlugin, { services });
  await app.register(destinationRoutes, { services });
  await app.register(systemRoutes, { services });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
});

function login(role: Role = 'admin', username: string = role) {
  const user = repos.users.create({ username, passwordHash: 'x', role });
  const { record, token } = repos.authSessions.create(user.id, { ip: null, userAgent: null });
  return { cookie: `${SESSION_COOKIE}=${token}`, csrf: record.csrfToken };
}
type Session = ReturnType<typeof login>;

function call(s: Session | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, csrf = true) {
  const headers: Record<string, string> = {};
  if (s) headers.cookie = s.cookie;
  if (s && csrf) headers[CSRF_HEADER] = s.csrf;
  return app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

/** Capabilities of a machine whose FFmpeg has libx264 (works) and h264_nvenc (no driver): CPU only. */
async function cpuOnly(counter?: { probes: number }): Promise<TranscodeCapabilityService> {
  const run: RunFn = async (_cmd, args) => {
    const res = (stdout: string, code = 0, stderr = '') => ({ code, stdout, stderr, timedOut: false, spawnError: null });
    if (args.includes('-version')) {
      if (counter) counter.probes++;
      return res('ffmpeg version n8.1.3 Copyright (c) the FFmpeg developers\n');
    }
    if (args.includes('-hwaccels')) return res('Hardware acceleration methods:\ncuda\n');
    if (args.includes('-encoders')) return res(' ------\n V....D libx264   libx264 H.264 (codec h264)\n V....D h264_nvenc   NVIDIA NVENC H.264 encoder (codec h264)\n');
    if (args.includes('-decoders')) return res(' ------\n VFS..D h264   H.264\n');
    if (args.includes('h264_nvenc')) return res('', 255, '[h264_nvenc @ 0x1] Cannot load libcuda.so.1\n');
    return res('frame=30\nspeed=3.07x\nprogress=end\n');
  };
  const svc = new TranscodeCapabilityService({ ffmpegBin: 'ffmpeg', run, listRenderNodes: () => [], hasNvidiaDevice: () => false, cpu: () => ({ cores: 32, model: null }) });
  await svc.start();
  return svc;
}

const profile = (video: Partial<TranscodeProfile['video']> = {}, rest: Partial<TranscodeProfile> = {}): TranscodeProfile => ({
  mode: 'transcode',
  video: { codec: 'h264', width: 1920, height: 1080, fps: null, bitrateKbps: 6000, keyframeSec: 2, encoder: 'auto', ...video },
  audio: 'copy',
  fallback: 'copy',
  ...rest,
});

const custom = (transcode?: unknown) => ({
  platform: 'custom',
  name: 'Backup RTMP',
  feed: 'landscape',
  ingestUrl: 'rtmp://backup.example/live',
  streamKey: 'custom-key',
  ...(transcode !== undefined ? { transcode } : {}),
});

const audits = () => repos.audit.list({ limit: 50 }).map((a) => `${a.action} ${a.detail ?? ''}`.trim());

describe('/api/system/transcode', () => {
  it('is off by default, readable by any signed-in user', async () => {
    expect((await call(null, 'GET', '/api/system/transcode')).statusCode).toBe(401);
    const res = await call(login('operator'), 'GET', '/api/system/transcode');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json<TranscodeSettingsResponse>()).toMatchObject({ settings: { enabled: false, maxWorkers: 2 }, capabilities: { state: 'probing' } });
  });

  it('only an admin can change it, with the CSRF token', async () => {
    expect((await call(login('operator'), 'PUT', '/api/system/transcode', { enabled: true })).statusCode).toBe(403);
    const admin = login();
    expect((await call(admin, 'PUT', '/api/system/transcode', { enabled: true }, false)).statusCode).toBe(403);
    expect(repos.settings.get('transcode', null)).toBeNull();
    expect(audits()).toEqual([]);
  });

  it('turns transcoding on and off, keeps the rest, and audits what changed', async () => {
    const admin = login();
    let res = await call(admin, 'PUT', '/api/system/transcode', { enabled: true });
    expect(res.statusCode).toBe(200);
    expect(res.json<TranscodeSettingsResponse>().settings).toEqual({ enabled: true, maxWorkers: 2 });
    expect(repos.settings.get('transcode', null)).toEqual({ enabled: true, maxWorkers: 2 });

    res = await call(admin, 'PUT', '/api/system/transcode', { maxWorkers: 4 });
    expect(res.json<TranscodeSettingsResponse>().settings).toEqual({ enabled: true, maxWorkers: 4 });
    // Saving the same values again changes and audits nothing.
    await call(admin, 'PUT', '/api/system/transcode', { enabled: true, maxWorkers: 4 });
    res = await call(admin, 'PUT', '/api/system/transcode', { enabled: false });
    expect(res.json<TranscodeSettingsResponse>().settings).toEqual({ enabled: false, maxWorkers: 4 });
    expect(audits().reverse()).toEqual(['transcode.settings enabled=true', 'transcode.settings maxWorkers=4', 'transcode.settings enabled=false']);
  });

  it('refuses values out of range and unknown fields', async () => {
    const admin = login();
    for (const body of [{ maxWorkers: 0 }, { maxWorkers: 9 }, { maxWorkers: 1.5 }, { enabled: 'yes' }, { enabled: true, encoder: 'libx264' }]) {
      const res = await call(admin, 'PUT', '/api/system/transcode', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(repos.settings.get('transcode', null)).toBeNull();
  });
});

describe('POST /api/system/transcode-capabilities/refresh', () => {
  it('is admin only and CSRF-checked', async () => {
    expect((await call(null, 'POST', '/api/system/transcode-capabilities/refresh')).statusCode).toBe(401);
    expect((await call(login('operator'), 'POST', '/api/system/transcode-capabilities/refresh')).statusCode).toBe(403);
    expect((await call(login('admin', 'a2'), 'POST', '/api/system/transcode-capabilities/refresh', undefined, false)).statusCode).toBe(403);
  });

  it('runs the probe again, answers with the new result and audits it', async () => {
    const counter = { probes: 0 };
    setTranscodeCapabilitiesFor(services, await cpuOnly(counter));
    expect(counter.probes).toBe(1);
    const res = await call(login(), 'POST', '/api/system/transcode-capabilities/refresh');
    expect(res.statusCode).toBe(200);
    expect(counter.probes).toBe(2);
    expect(res.json<TranscodeCapabilities>()).toMatchObject({ state: 'ready', supported: { h264: true, hevc: false, av1: false } });
    expect(audits()).toEqual(['transcode.recheck working=libx264']);
  });
});

describe('destination transcoding profile', () => {
  it('is null unless given, round-trips, and PATCH keeps / replaces / clears it', async () => {
    setTranscodeCapabilitiesFor(services, await cpuOnly());
    const admin = login();
    const plain = (await call(admin, 'POST', '/api/destinations', custom())).json<Destination>();
    expect(plain.transcode).toBeNull();

    const created = await call(admin, 'POST', '/api/destinations', { ...custom(profile()), name: 'Transcoded' });
    expect(created.statusCode).toBe(201);
    const dest = created.json<Destination>();
    expect(dest.transcode).toEqual(profile());
    expect(JSON.stringify(dest)).not.toContain('custom-key');

    // Not submitted: kept.
    let res = await call(admin, 'PATCH', `/api/destinations/${dest.id}`, { name: 'Renamed' });
    expect(res.json<Destination>()).toMatchObject({ name: 'Renamed', transcode: profile() });
    // Replaced.
    const smaller = profile({ width: 1280, height: 720, fps: 30, bitrateKbps: 3000 }, { fallback: 'stop', audio: { codec: 'aac', bitrateKbps: 128 } });
    res = await call(admin, 'PATCH', `/api/destinations/${dest.id}`, { transcode: smaller });
    expect(res.json<Destination>().transcode).toEqual(smaller);
    // null = copy.
    res = await call(admin, 'PATCH', `/api/destinations/${dest.id}`, { transcode: null });
    expect(res.json<Destination>().transcode).toBeNull();

    const list = (await call(login('operator'), 'GET', '/api/destinations')).json<Destination[]>();
    expect(list.map((d) => d.transcode)).toEqual([null, null]);
    expect(audits().filter((a) => a.startsWith('destination.update')).map((a) => a.split('fields=')[1])).toEqual(['transcode', 'transcode', 'name']);
    // The orchestrator hears about each change (it never ends a live for a profile edit).
    expect(changed).toEqual([plain.id, dest.id, dest.id, dest.id, dest.id]);
  });

  it("refuses what the platform doesn't take, with a plain message", async () => {
    setTranscodeCapabilitiesFor(services, await cpuOnly());
    const admin = login();
    const kick = { platform: 'kick', name: 'Kick', feed: 'landscape', ingestUrl: 'rtmps://ingest.example.com/app', streamKey: 'kick-key' };
    const cases: [unknown, RegExp][] = [
      [profile({ codec: 'hevc' }), /^Transcoding: Kick doesn't accept HEVC \(it takes H\.264\)$/],
      [profile({ width: 2560, height: 1440 }), /^Transcoding: Kick takes at most 1920×1080 \(got 2560×1440\)$/],
      [profile({ bitrateKbps: 12000 }), /^Transcoding: The video bitrate must be between 300 and 8000 kbps for Kick$/],
      [profile({ fps: 120 }), /^Transcoding: The frame rate must be between 15 and 60 fps for Kick$/],
    ];
    for (const [transcode, message] of cases) {
      const res = await call(admin, 'POST', '/api/destinations', { ...kick, transcode });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'transcode_invalid' });
      expect(res.json<{ error: string }>().error).toMatch(message);
    }
    expect(repos.destinations.list()).toEqual([]);
  });

  it('refuses a codec or encoder this machine cannot use, but keeps a copy-mode profile for later', async () => {
    setTranscodeCapabilitiesFor(services, await cpuOnly());
    const admin = login();
    let res = await call(admin, 'POST', '/api/destinations', custom(profile({ codec: 'av1' })));
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('Transcoding: This server has no working AV1 encoder (see Settings → Transcoding)');
    res = await call(admin, 'POST', '/api/destinations', custom(profile({ encoder: 'h264_nvenc' })));
    expect(res.json<{ error: string }>().error).toBe('Transcoding: h264_nvenc failed its test encode on this server (Cannot load libcuda.so.1)');
    res = await call(admin, 'POST', '/api/destinations', custom(profile({ encoder: 'libx264' })));
    expect(res.statusCode).toBe(201);

    // Saved switched off ('copy'): nothing encodes, so the machine isn't asked.
    res = await call(admin, 'POST', '/api/destinations', custom(profile({ codec: 'av1' }, { mode: 'copy' })));
    expect(res.statusCode).toBe(201);
    expect(res.json<Destination>().transcode).toMatchObject({ mode: 'copy', video: { codec: 'av1' } });
    // ...but switching it on is checked.
    res = await call(admin, 'PATCH', `/api/destinations/${res.json<Destination>().id}`, { transcode: profile({ codec: 'av1' }) });
    expect(res.statusCode).toBe(400);
  });

  it('checks only the platform while the startup probe is still running', async () => {
    const admin = login();
    expect((await call(admin, 'POST', '/api/destinations', custom(profile({ codec: 'av1' })))).statusCode).toBe(201);
  });

  it('refuses a malformed profile', async () => {
    const admin = login();
    const bad: unknown[] = [
      'transcode',
      { mode: 'transcode' },
      { ...profile(), mode: 'gpu' },
      { ...profile(), video: { ...profile().video, encoder: 'libx264; rm -rf /' } },
      { ...profile(), video: { ...profile().video, encoder: '-vf' } },
      { ...profile(), video: { ...profile().video, width: '1920' } },
      { ...profile(), video: { ...profile().video, extra: 1 } },
      { ...profile(), audio: { codec: 'mp3', bitrateKbps: 128 } },
      { ...profile(), fallback: 'retry' },
      { ...profile(), preset: 'slow' },
    ];
    for (const transcode of bad) {
      const res = await call(admin, 'POST', '/api/destinations', custom(transcode));
      expect(res.statusCode, JSON.stringify(transcode)).toBe(400);
    }
    expect(repos.destinations.list()).toEqual([]);
  });

  it('is admin only, like every destination edit', async () => {
    const dest = (await call(login(), 'POST', '/api/destinations', custom())).json<Destination>();
    const res = await call(login('operator'), 'PATCH', `/api/destinations/${dest.id}`, { transcode: profile() });
    expect(res.statusCode).toBe(403);
    expect(repos.destinations.get(dest.id)?.transcode).toBeNull();
  });
});
