// The owner's live install holds developer-app credentials, accounts, destinations, stream keys and
// users. Schema changes are append-only: these tests prove an upgrade keeps all of it intact.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE_ID } from '../../../shared/types.js';
import { createSecretBox } from '../security/secretbox.js';
import { profileSecretScope, profileSettingKey } from '../services.js';
import { generateApiTokenSecret, hashApiToken } from './api-tokens-repo.js';
import { createAuditRepo } from './audit-repo.js';
import { MIGRATIONS, migrate, openDatabase, schemaVersion } from './database.js';
import { createSecretsRepo, createSettingsRepo } from './kv-repos.js';
import { createRepos } from './repos.js';
import { statementCache } from './rows.js';
import { createSessionsRepo } from './sessions-repo.js';
import { createUsersRepo } from './users-repo.js';

/** SHA-256 of each shipped migration step. A shipped step must never change. */
const SHIPPED_STEP_HASHES = [
  '4dd2c5b18087e881c32c2570a7f8871fa8b0a317c949d9392dc5bc7d306d2f9f', // v1: initial schema
  'd4c55d6e657418f8be8c2ab177595c933ec0b967bab0629f8a789f9ef6d21d69', // v2: api_tokens
  '000982e766f90785801da6c4a224207382f40d50cd1ae5271aa101a1426f26e3', // v3: profiles + connected apps
  'c501ccc8618f7e0a89d5cf9b5af09c38e0faf2d3ba42a3882eae8d117d7fca84', // v4: show profiles, revisions, blobs, asset library
];

const masterKey = crypto.randomBytes(32);
const box = createSecretBox(masterKey);
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctd-migrate-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function tables(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => String(r.name));
}

type TableInfo = { name: string }[];

function columns(db: DatabaseSync, table: string): TableInfo {
  return db.prepare(`PRAGMA table_info(${table})`).all() as TableInfo;
}

/** Every table's columns and rows (projected to `cols[table]` when given), in rowid order. */
function dump(db: DatabaseSync, names: string[], cols?: Record<string, TableInfo>) {
  return Object.fromEntries(
    names.map((t) => {
      const keep = cols?.[t]?.map((c) => c.name);
      const select = keep ? keep.join(', ') : '*';
      return [
        t,
        {
          // hex() makes the comparison byte-for-byte, not just "equal after decoding".
          rows: db.prepare(`SELECT ${select} FROM ${t} ORDER BY rowid`).all(),
          bytes: db
            .prepare(`SELECT ${(keep ?? columns(db, t).map((c) => c.name)).map((c) => `hex(${c})`).join(' || \'|\' || ')} AS b FROM ${t} ORDER BY rowid`)
            .all()
            .map((r) => r.b),
        },
      ];
    }),
  );
}

describe('migrations are append-only', () => {
  it('never changes a shipped step', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(SHIPPED_STEP_HASHES.length);
    SHIPPED_STEP_HASHES.forEach((hash, i) => {
      expect(crypto.createHash('sha256').update(MIGRATIONS[i] ?? '').digest('hex'), `migration step ${i + 1}`).toBe(hash);
    });
  });

  it('never drops, renames, updates or deletes anything', () => {
    for (const step of MIGRATIONS) {
      expect(step).not.toMatch(/\bDROP\b/i);
      expect(step).not.toMatch(/\bRENAME\b/i);
      expect(step).not.toMatch(/\bDELETE\s+FROM\b/i);
      expect(step).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
      expect(step).not.toMatch(/\bREPLACE\b/i);
    }
  });
});

/** The owner's data as an older release wrote it (raw SQL for tables whose repos changed since). */
async function seedOwnerData(db: DatabaseSync, version: number) {
  const stmt = statementCache(db);
  const users = createUsersRepo(stmt);
  const settings = createSettingsRepo(stmt);
  const secrets = createSecretsRepo(stmt, box);

  const user = users.create({ username: 'Owner', passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA', role: 'admin' });
  users.update(user.id, { totpEnabled: true, totpSecret: box.encrypt('JBSWY3DPEHPK3PXP'), lastLoginAt: '2026-10-01T10:00:00.000Z' });
  const login = createSessionsRepo(stmt).create(user.id, { ip: '192.168.1.9', userAgent: 'Firefox' });
  createAuditRepo(stmt).log({ userId: user.id, username: 'Owner', action: 'login', detail: null, ip: '192.168.1.9' });

  const accountId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO accounts (id, platform, label, status, status_message, options, created_at, updated_at)
     VALUES (?, 'youtube', 'Miami or Bust', 'connected', NULL, '{"channelId":"UC123"}', '2026-10-01T10:00:00.000Z', '2026-10-02T10:00:00.000Z')`,
  ).run(accountId);
  const browserAccountId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO accounts (id, platform, label, status, status_message, options, created_at, updated_at)
     VALUES (?, 'instagram', 'IG ✨', 'needs-login', 'Log in again', '{}', '2026-10-01T11:00:00.000Z', '2026-10-01T11:00:00.000Z')`,
  ).run(browserAccountId);

  const destinationId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO destinations (id, platform, account_id, name, feed, enabled, options, ingest_url, has_stream_key, created_at, updated_at)
     VALUES (?, 'youtube', ?, 'YouTube main', 'landscape', 1, ?, 'rtmps://a.rtmps.youtube.com/live2', 1, '2026-10-01T10:05:00.000Z', '2026-10-01T10:05:00.000Z')`,
  ).run(destinationId, accountId, JSON.stringify({ privacy: 'public', links: [{ title: 'Shop', url: 'https://example.com' }] }));
  const customId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO destinations (id, platform, account_id, name, feed, enabled, options, ingest_url, has_stream_key, created_at, updated_at)
     VALUES (?, 'custom', NULL, 'Backup RTMP', 'vertical', 0, '{}', 'rtmp://backup.example/live', 1, '2026-10-01T10:06:00.000Z', '2026-10-01T10:06:00.000Z')`,
  ).run(customId);

  const youtubeApp = { clientId: '1234-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-super-secret' };
  const twitchApp = { clientId: 'twitchclient', clientSecret: 'twitchsecret' };
  const ingestKeys = { landscape: 'LandscapeKey_0123456789ab', vertical: 'VerticalKey_0123456789abc', internalReader: 'ReaderPass_0123456789abcd' };
  const overlayToken = 'O'.repeat(43);
  await secrets.scoped('app:youtube').setJson('values', youtubeApp);
  await secrets.scoped('app:twitch').setJson('values', twitchApp);
  await secrets.scoped(`account:${accountId}`).setJson('oauth', { accessToken: 'ya29.token', refreshToken: '1//refresh' });
  await secrets.scoped(`browser:${browserAccountId}`).setJson('storageState', { cookies: [{ name: 'sessionid', value: 'abc' }] });
  await secrets.scoped(`destination:${destinationId}`).set('streamKey', 'abcd-efgh-ijkl-mnop');
  await secrets.scoped(`destination:${customId}`).set('streamKey', 'custom-key');
  for (const [k, v] of Object.entries(ingestKeys)) await secrets.scoped('ingest').set(k, v);
  await secrets.scoped('chat').set('overlayToken', overlayToken);
  settings.set('app', { publicBaseUrl: 'https://stream.example.com', ingestHost: '192.168.1.20', disconnectGraceSec: 20 });
  settings.set('session.title', 'Miami or Bust — day 3');
  settings.set('session.autoGoLive', false);
  settings.set('session.testMode', true);

  let token: { id: string; secret: string } | null = null;
  if (version >= 2) {
    const secret = generateApiTokenSecret();
    token = { id: crypto.randomUUID(), secret };
    db.prepare(
      `INSERT INTO api_tokens (id, name, scopes, prefix, secret_hash, created_at, created_by, last_used_at)
       VALUES (?, 'CTD Overlay', '["chat:read","status:read"]', ?, ?, '2026-10-12T09:00:00.000Z', 'Owner', NULL)`,
    ).run(token.id, secret.slice(0, 12), hashApiToken(secret));
  }

  return { user, login, accountId, browserAccountId, destinationId, customId, youtubeApp, twitchApp, ingestKeys, overlayToken, token };
}

describe.each(Array.from({ length: MIGRATIONS.length - 1 }, (_, i) => i + 1))('upgrading a v%i database', (fromVersion) => {
  it('keeps every byte of the owner data and moves it into the default profile', async () => {
    const file = path.join(dir, 'app.db');

    // 1. A database as an older release left it, with the owner's data in it.
    const old = new DatabaseSync(file);
    old.exec('PRAGMA journal_mode = WAL');
    migrate(old, MIGRATIONS.slice(0, fromVersion));
    expect(schemaVersion(old)).toBe(fromVersion);
    const f = await seedOwnerData(old, fromVersion);

    const oldTables = tables(old);
    const oldColumns = Object.fromEntries(oldTables.map((t) => [t, columns(old, t)]));
    const before = dump(old, oldTables, oldColumns);
    old.close();

    // 2. The new release opens it (runs every pending migration).
    const db = openDatabase(file);
    try {
      expect(schemaVersion(db)).toBe(MIGRATIONS.length);
      expect(tables(db)).toEqual(expect.arrayContaining([...oldTables, 'api_tokens', 'profiles', 'connected_apps']));

      // Every pre-existing table: the old columns unchanged (new ones only appended), and the old
      // columns of every row byte-identical.
      for (const t of oldTables) {
        expect(columns(db, t).slice(0, oldColumns[t]!.length), t).toEqual(oldColumns[t]);
      }
      expect(dump(db, oldTables, oldColumns)).toEqual(before);

      // Existing accounts/destinations now belong to the default profile; tokens to every profile.
      expect(db.prepare('SELECT DISTINCT profile_id FROM accounts').all()).toEqual([{ profile_id: DEFAULT_PROFILE_ID }]);
      expect(db.prepare('SELECT DISTINCT profile_id FROM destinations').all()).toEqual([{ profile_id: DEFAULT_PROFILE_ID }]);
      expect(db.prepare('SELECT profile_id FROM api_tokens').all()).toEqual(f.token ? [{ profile_id: null }] : []);
      const profiles = db.prepare('SELECT * FROM profiles').all();
      expect(profiles).toEqual([
        { id: 'default', name: 'Main', slug: 'main', color: null, created_at: expect.any(String), updated_at: expect.any(String) },
      ]);
      expect(String(profiles[0]?.created_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(db.prepare('SELECT COUNT(*) AS n FROM connected_apps').get()?.n).toBe(0);

      // 3. Everything is still readable through the repos with the same master key.
      const repos = createRepos(db, createSecretBox(masterKey));
      expect(repos.users.getByUsername('owner')).toMatchObject({ id: f.user.id, role: 'admin', totpEnabled: true });
      expect(box.decrypt(repos.users.get(f.user.id)!.totpSecret!)).toBe('JBSWY3DPEHPK3PXP');
      expect(repos.authSessions.touch(f.login.token)?.userId).toBe(f.user.id);
      expect(repos.profiles.list()).toEqual([expect.objectContaining({ id: DEFAULT_PROFILE_ID, name: 'Main', slug: 'main', color: null })]);
      expect(repos.accounts.get(f.accountId)).toEqual({
        id: f.accountId,
        profileId: DEFAULT_PROFILE_ID,
        platform: 'youtube',
        label: 'Miami or Bust',
        status: 'connected',
        statusMessage: null,
        options: { channelId: 'UC123' },
        createdAt: '2026-10-01T10:00:00.000Z',
        updatedAt: '2026-10-02T10:00:00.000Z',
      });
      expect(repos.accounts.list(DEFAULT_PROFILE_ID).map((a) => a.id)).toEqual([f.accountId, f.browserAccountId]);
      expect(repos.destinations.list(DEFAULT_PROFILE_ID).map((d) => d.id)).toEqual([f.destinationId, f.customId]);
      expect(repos.destinations.list().map((d) => d.id)).toEqual([f.destinationId, f.customId]);
      expect(repos.destinations.get(f.destinationId)).toMatchObject({
        profileId: DEFAULT_PROFILE_ID,
        hasStreamKey: true,
        accountId: f.accountId,
        enabled: true,
        options: { privacy: 'public', links: [{ title: 'Shop', url: 'https://example.com' }] },
      });
      expect(await repos.secrets.scoped('app:youtube').getJson('values')).toEqual(f.youtubeApp);
      expect(await repos.secrets.scoped('app:twitch').getJson('values')).toEqual(f.twitchApp);
      expect(await repos.secrets.scoped(`account:${f.accountId}`).getJson('oauth')).toEqual({ accessToken: 'ya29.token', refreshToken: '1//refresh' });
      expect(await repos.secrets.scoped(`browser:${f.browserAccountId}`).getJson('storageState')).toEqual({ cookies: [{ name: 'sessionid', value: 'abc' }] });
      expect(await repos.secrets.scoped(`destination:${f.destinationId}`).get('streamKey')).toBe('abcd-efgh-ijkl-mnop');
      expect(await repos.secrets.scoped(`destination:${f.customId}`).get('streamKey')).toBe('custom-key');

      // The default profile reads the legacy keys: OBS keys, overlay token and session settings.
      const ingest = repos.secrets.scoped(profileSecretScope(DEFAULT_PROFILE_ID, 'ingest'));
      for (const [k, v] of Object.entries(f.ingestKeys)) expect(await ingest.get(k)).toBe(v);
      expect(await repos.secrets.scoped(profileSecretScope(DEFAULT_PROFILE_ID, 'chat')).get('overlayToken')).toBe(f.overlayToken);
      expect(repos.settings.get(profileSettingKey(DEFAULT_PROFILE_ID, 'session.title'), '')).toBe('Miami or Bust — day 3');
      expect(repos.settings.get(profileSettingKey(DEFAULT_PROFILE_ID, 'session.autoGoLive'), true)).toBe(false);
      expect(repos.settings.get(profileSettingKey(DEFAULT_PROFILE_ID, 'session.testMode'), false)).toBe(true);
      expect(repos.settings.get('app', {})).toEqual({ publicBaseUrl: 'https://stream.example.com', ingestHost: '192.168.1.20', disconnectGraceSec: 20 });

      // The existing API token keeps working, for every profile.
      if (f.token) {
        expect(repos.apiTokens.verify(f.token.secret)).toMatchObject({ id: f.token.id, name: 'CTD Overlay', scopes: ['chat:read', 'status:read'], profileId: null });
        expect(repos.apiTokens.list()).toEqual([expect.objectContaining({ id: f.token.id, profileId: null })]);
      }
    } finally {
      db.close();
    }

    // 4. Opening again (every restart) is a no-op for the data, and the new tables work alongside it.
    const again = openDatabase(file);
    try {
      expect(schemaVersion(again)).toBe(MIGRATIONS.length);
      // The token's last_used_at was written by verify() above; everything else is untouched.
      const { api_tokens: _now, ...stable } = dump(again, oldTables, oldColumns);
      const { api_tokens: _before, ...expected } = before;
      expect(stable).toEqual(expected);
      expect(again.prepare('SELECT COUNT(*) AS n FROM profiles').get()?.n).toBe(1);

      const repos = createRepos(again, createSecretBox(masterKey));
      const club = repos.profiles.create({ name: 'DPRTMNT', color: '#E11D48' });
      const { token, secret } = repos.apiTokens.create({ name: 'OBS', scopes: ['status:read'], createdBy: 'Owner', profileId: club.id });
      expect(repos.apiTokens.verify(secret)).toMatchObject({ id: token.id, profileId: club.id });
      const acc = repos.accounts.create({ profileId: club.id, platform: 'twitch', label: 'DPRTMNT Twitch', options: {} });
      expect(repos.accounts.list(club.id).map((a) => a.id)).toEqual([acc.id]);
      expect(repos.accounts.list(DEFAULT_PROFILE_ID).map((a) => a.id)).toEqual([f.accountId, f.browserAccountId]);
      expect(await repos.secrets.scoped('app:youtube').getJson('values')).toEqual(f.youtubeApp);
    } finally {
      again.close();
    }
  });
});

describe('a fresh database', () => {
  it('starts with the default profile and no apps', () => {
    const db = openDatabase(':memory:');
    try {
      const repos = createRepos(db, box);
      expect(repos.profiles.list()).toEqual([
        { id: DEFAULT_PROFILE_ID, name: 'Main', slug: 'main', color: null, createdAt: expect.any(String), updatedAt: expect.any(String) },
      ]);
      expect(repos.connectedApps.list()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('is at v4 with the show profile tables', () => {
    const db = openDatabase(':memory:');
    try {
      expect(schemaVersion(db)).toBe(4);
      expect(MIGRATIONS.length).toBe(4);
      expect(tables(db)).toEqual(expect.arrayContaining(['show_profiles', 'show_revisions', 'blobs', 'revision_blobs', 'asset_library']));
      const repos = createRepos(db, box);
      expect(repos.showProfiles.list()).toEqual([]);
      expect(repos.assetLibrary.list()).toEqual([]);
      expect(repos.blobs.totalSize()).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('v3 to v4', () => {
  it('keeps existing data and adds empty show profile tables', async () => {
    const old = new DatabaseSync(':memory:');
    migrate(old, MIGRATIONS.slice(0, 3));
    expect(schemaVersion(old)).toBe(3);
    await seedOwnerData(old, 3);
    const names = tables(old);
    const before = dump(old, names);
    migrate(old);
    try {
      expect(schemaVersion(old)).toBe(4);
      expect(dump(old, names)).toEqual(before);
      for (const t of ['show_profiles', 'show_revisions', 'blobs', 'revision_blobs', 'asset_library']) {
        expect(old.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n, t).toBe(0);
      }
    } finally {
      old.close();
    }
  });
});
