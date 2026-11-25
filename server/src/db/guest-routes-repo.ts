// Guest feed routes (docs/GUEST-FEEDS.md → Routing): one row per route, on the guest feeds' own
// migration track (guest-feeds-repo.ts, step g2). Stream keys of custom targets are in the encrypted
// secrets (scope `guest-route:<routeId>`, key 'streamKey'), never here. A route goes with its guest
// slot and with its target profile (ON DELETE CASCADE).

import { randomBytes } from 'node:crypto';
import { GUEST_ROUTE_ID_RE, type GuestRouteKind } from '../../../shared/guest-routes.js';
import type { Feed } from '../../../shared/types.js';
import type { Db } from './database.js';
import { migrateGuestFeeds } from './guest-feeds-repo.js';
import { int, isUniqueViolation, nowIso, str, type Row } from './rows.js';

export interface GuestRouteRow {
  id: string;
  slot: string;
  kind: GuestRouteKind;
  name: string;
  /** rtmp: the server URL as entered. */
  url: string | null;
  /** profile: the target profile and input. */
  targetProfileId: string | null;
  targetFeed: Feed | null;
  auto: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GuestRoutesRepo {
  all(): GuestRouteRow[];
  listBySlot(slot: string): GuestRouteRow[];
  get(id: string): GuestRouteRow | null;
  create(input: Pick<GuestRouteRow, 'slot' | 'kind' | 'name' | 'url' | 'targetProfileId' | 'targetFeed' | 'auto'>): GuestRouteRow;
  update(id: string, patch: Partial<Pick<GuestRouteRow, 'name' | 'url' | 'auto'>>): GuestRouteRow | null;
  delete(id: string): boolean;
}

const COLUMNS = 'id, slot, kind, name, url, target_profile_id, target_feed, auto, created_at, updated_at';
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function newRouteId(): string {
  let id = '';
  for (const b of randomBytes(10)) id += ID_ALPHABET[b % ID_ALPHABET.length];
  return id;
}

function optStr(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' ? v : null;
}

function toRow(row: Row): GuestRouteRow {
  const feed = optStr(row, 'target_feed');
  return {
    id: str(row, 'id'),
    slot: str(row, 'slot'),
    kind: str(row, 'kind') === 'profile' ? 'profile' : 'rtmp',
    name: str(row, 'name'),
    url: optStr(row, 'url'),
    targetProfileId: optStr(row, 'target_profile_id'),
    targetFeed: feed === 'landscape' || feed === 'vertical' ? feed : null,
    auto: int(row, 'auto') === 1,
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

export function createGuestRoutesRepo(db: Db, newId: () => string = newRouteId): GuestRoutesRepo {
  migrateGuestFeeds(db);
  const get = (id: string): GuestRouteRow | null => {
    const row = db.prepare(`SELECT ${COLUMNS} FROM guest_routes WHERE id = ?`).get(id);
    return row ? toRow(row) : null;
  };
  return {
    all: () => db.prepare(`SELECT ${COLUMNS} FROM guest_routes ORDER BY created_at, rowid`).all().map(toRow),
    listBySlot: (slot) => db.prepare(`SELECT ${COLUMNS} FROM guest_routes WHERE slot = ? ORDER BY created_at, rowid`).all(slot).map(toRow),
    get,
    create(input) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const id = newId();
        if (!GUEST_ROUTE_ID_RE.test(id)) throw new Error('invalid guest route id');
        const now = nowIso();
        try {
          db.prepare(`INSERT INTO guest_routes (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            id,
            input.slot,
            input.kind,
            input.name,
            input.url,
            input.targetProfileId,
            input.targetFeed,
            input.auto ? 1 : 0,
            now,
            now,
          );
          return get(id)!;
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
      }
      throw new Error('Could not pick a free guest route id');
    },
    update(id, patch) {
      const cur = get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      db.prepare('UPDATE guest_routes SET name = ?, url = ?, auto = ?, updated_at = ? WHERE id = ?').run(next.name, next.url, next.auto ? 1 : 0, nowIso(), id);
      return get(id);
    },
    delete: (id) => db.prepare('DELETE FROM guest_routes WHERE id = ?').run(id).changes > 0,
  };
}
