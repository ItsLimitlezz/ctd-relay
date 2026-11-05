import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppResource } from '../../../shared/types.js';
import { createSecretBox } from '../security/secretbox.js';
import type { Repos } from '../services.js';
import { openDatabase, type Db } from './database.js';
import { createRepos } from './repos.js';

let db: Db;
let repos: Repos;

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
});

const overlay: AppResource = {
  type: 'overlay',
  id: 'ovl_h',
  name: 'DPRTMNT takeover — landscape',
  profileId: 'club',
  url: 'http://10.20.30.40:30200/o/takeover-h?key=abc',
  width: 1920,
  height: 1080,
  meta: { canvas: 'landscape', fps: 60, transparent: true },
};

function register(id: string, tokenId: string, patch: Partial<Parameters<Repos['connectedApps']['upsert']>[0]> = {}) {
  return repos.connectedApps.upsert({
    id,
    name: 'CTD Overlay',
    kind: 'ctd-overlay',
    version: '1.4.0',
    baseUrl: 'http://10.20.30.40:30200',
    capabilities: ['overlays', 'overlay.create'],
    resources: [overlay],
    tokenId,
    profileId: null,
    ...patch,
  });
}

describe('connected apps repo', () => {
  it('inserts, reads back JSON columns and reports online=false', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-15T14:00:00.000Z'));
    const app = register('ctd-overlay', 'tok-1');
    expect(app).toEqual({
      id: 'ctd-overlay',
      name: 'CTD Overlay',
      kind: 'ctd-overlay',
      version: '1.4.0',
      baseUrl: 'http://10.20.30.40:30200',
      capabilities: ['overlays', 'overlay.create'],
      resources: [overlay],
      tokenId: 'tok-1',
      profileId: null,
      registeredAt: '2026-10-15T14:00:00.000Z',
      lastSeenAt: '2026-10-15T14:00:00.000Z',
      online: false,
    });
    expect(repos.connectedApps.get('ctd-overlay')).toEqual(app);
    expect(repos.connectedApps.get('missing')).toBeNull();
  });

  it('updates in place, keeping the registration time, and touches lastSeenAt', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-15T14:00:00.000Z'));
    register('ctd-overlay', 'tok-1');
    vi.setSystemTime(Date.parse('2026-10-15T14:01:00.000Z'));
    const updated = register('ctd-overlay', 'tok-1', { version: '1.5.0', resources: [], capabilities: [], baseUrl: null, profileId: 'club' });
    expect(updated).toMatchObject({
      version: '1.5.0',
      resources: [],
      capabilities: [],
      baseUrl: null,
      profileId: 'club',
      registeredAt: '2026-10-15T14:00:00.000Z',
      lastSeenAt: '2026-10-15T14:01:00.000Z',
    });
    vi.setSystemTime(Date.parse('2026-10-15T14:02:00.000Z'));
    repos.connectedApps.touch('ctd-overlay');
    expect(repos.connectedApps.get('ctd-overlay')?.lastSeenAt).toBe('2026-10-15T14:02:00.000Z');
    repos.connectedApps.touch('missing'); // no-op
    expect(register('x', 't', { registeredAt: '2026-01-01T00:00:00.000Z' }).registeredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(repos.connectedApps.list().map((a) => a.id)).toEqual(['x', 'ctd-overlay']); // by registration time
  });

  it('deletes one app or every app of a revoked token', () => {
    register('ctd-overlay', 'tok-1');
    register('ctd-overlay-dprtmnt', 'tok-1');
    register('ctd-obs-plugin-studio', 'tok-2', { kind: 'ctd-obs-plugin', resources: [] });
    repos.connectedApps.delete('ctd-overlay');
    expect(repos.connectedApps.list().map((a) => a.id)).toEqual(['ctd-overlay-dprtmnt', 'ctd-obs-plugin-studio']);
    repos.connectedApps.deleteByToken('tok-1');
    expect(repos.connectedApps.list().map((a) => a.id)).toEqual(['ctd-obs-plugin-studio']);
  });

  it('survives corrupt JSON columns', () => {
    register('ctd-overlay', 'tok-1');
    db.prepare("UPDATE connected_apps SET capabilities = '{nope', resources = ? WHERE id = 'ctd-overlay'").run(
      JSON.stringify([{ type: 'overlay', id: 'ok', name: 'OK', profileId: 7, width: 'wide' }, { id: 'no-type' }, 'junk', null]),
    );
    expect(repos.connectedApps.get('ctd-overlay')).toMatchObject({
      capabilities: [],
      resources: [{ type: 'overlay', id: 'ok', name: 'OK', profileId: null }],
    });
  });
});
