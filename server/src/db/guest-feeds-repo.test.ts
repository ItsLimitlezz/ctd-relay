import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, migrate, openDatabase, schemaVersion } from './database.js';
import { createGuestFeedsRepo, guestFeedSchemaVersion, GUEST_FEED_MIGRATIONS, migrateGuestFeeds, newSlotId } from './guest-feeds-repo.js';

describe('guest feed table (own migration track)', () => {
  it('only adds tables: PRAGMA user_version stays where 0.2.80 left it', () => {
    const db = openDatabase(':memory:');
    const before = schemaVersion(db);
    expect(before).toBe(MIGRATIONS.length);
    createGuestFeedsRepo(db);
    expect(schemaVersion(db)).toBe(before);
    expect(guestFeedSchemaVersion(db)).toBe(GUEST_FEED_MIGRATIONS.length);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'guest_%' ORDER BY name").all().map((r) => r.name);
    expect(tables).toEqual(['guest_feeds', 'guest_feeds_meta']);
    db.close();
  });

  it('downgrade: 0.2.80 (the main migrations alone) still opens a database 0.2.90 wrote, and deleting a profile there removes its slots', () => {
    const file = ':memory:';
    const db = openDatabase(file);
    const repo = createGuestFeedsRepo(db);
    repo.create('default', 'Remote cam 1');
    // What 0.2.80 does on start: migrate() with its own (identical) main migration list.
    expect(() => migrate(db, MIGRATIONS)).not.toThrow();
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    // 0.2.80 can delete a profile (FK cascade takes the slots along).
    db.prepare("INSERT INTO profiles (id, name, slug, color, created_at, updated_at) VALUES ('p2', 'Club', 'club', NULL, 'x', 'x')").run();
    repo.create('p2', 'Guest laptop');
    db.prepare("DELETE FROM profiles WHERE id = 'p2'").run();
    expect(repo.list('p2')).toEqual([]);
    expect(repo.list('default')).toHaveLength(1);
    db.close();
  });

  it('re-running is a no-op and a newer track is refused', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE profiles (id TEXT PRIMARY KEY)');
    migrateGuestFeeds(db);
    migrateGuestFeeds(db);
    expect(guestFeedSchemaVersion(db)).toBe(1);
    expect(() => migrateGuestFeeds(db, [])).toThrow(/newer than this app supports/);
    db.close();
  });
});

describe('GuestFeedsRepo', () => {
  it('creates, renames, revokes and deletes slots per profile, oldest first', () => {
    const db = openDatabase(':memory:');
    const repo = createGuestFeedsRepo(db);
    const a = repo.create('default', 'A');
    const b = repo.create('default', 'B');
    expect(a.id).toMatch(/^[a-z0-9]{10}$/);
    expect(repo.list('default').map((r) => r.name)).toEqual(['A', 'B']);
    expect(repo.count('default')).toBe(2);
    expect(repo.rename(a.id, 'A2')?.name).toBe('A2');
    expect(repo.setRevoked(b.id, true)?.revoked).toBe(true);
    expect(repo.delete(a.id)).toBe(true);
    expect(repo.get(a.id)).toBeNull();
    expect(repo.rename('nope000000', 'x')).toBeNull();
    expect(repo.deleteProfile('default')).toEqual([b.id]);
    db.close();
  });

  it('retries on an id collision', () => {
    const db = openDatabase(':memory:');
    const ids = ['aaaaaaaaaa', 'aaaaaaaaaa', 'bbbbbbbbbb'];
    const repo = createGuestFeedsRepo(db, () => ids.shift()!);
    expect(repo.create('default', 'A').id).toBe('aaaaaaaaaa');
    expect(repo.create('default', 'B').id).toBe('bbbbbbbbbb');
    db.close();
  });

  it('slot ids are 10 characters of [a-z0-9]', () => {
    for (let i = 0; i < 50; i++) expect(newSlotId()).toMatch(/^[a-z0-9]{10}$/);
  });
});
