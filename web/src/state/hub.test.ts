import { describe, expect, it } from 'vitest';
import type { AppResource, ConnectedApp, PairingRequest, Profile } from '@shared/types';
import { DEFAULT_PROFILE_ID } from '@shared/types';
import {
  appStatusText,
  BASIC_SCOPES,
  dockTokenName,
  EVERY_PROFILE,
  groupResources,
  knownScopes,
  pairingBannerText,
  pairingDefaults,
  pairingExpiresText,
  pendingPairings,
  profileFromSelect,
  profileSelectOptions,
  profileToSelect,
  resourceNames,
  resourceSummary,
  sortApps,
  withSelectedOption,
} from './hub';

const NOW = Date.parse('2026-10-15T18:00:00Z');
const profiles: Pick<Profile, 'id' | 'name'>[] = [
  { id: '6f1d2c', name: 'DPRTMNT' },
  { id: DEFAULT_PROFILE_ID, name: 'Miami or Bust' },
];

const pairing = (id: string, over: Partial<PairingRequest> = {}): PairingRequest => ({
  id,
  appName: 'CTD OBS plugin (Studio PC)',
  kind: 'ctd-obs-plugin',
  code: 'KQ7-2MX',
  requestedScopes: ['status:read', 'chat:read', 'ingest:read', 'apps:read', 'apps:write'],
  requestedProfileId: null,
  ip: '192.168.1.30',
  createdAt: '2026-10-15T17:58:00Z',
  expiresAt: '2026-10-15T18:08:00Z',
  ...over,
});

const overlay = (id: string, profileId: string | null, name = id): AppResource => ({ type: 'overlay', id, name, profileId, url: `http://h/o/${id}` });

const app = (id: string, over: Partial<ConnectedApp> = {}): ConnectedApp => ({
  id,
  name: id,
  kind: 'ctd-overlay',
  version: '1.4.0',
  baseUrl: null,
  capabilities: [],
  resources: [],
  tokenId: 't1',
  profileId: null,
  registeredAt: '2026-10-15T17:00:00Z',
  lastSeenAt: '2026-10-15T17:59:30Z',
  online: true,
  ...over,
});

describe('profile pickers', () => {
  it('lists the default profile first, then "Every profile"', () => {
    expect(profileSelectOptions(profiles)).toEqual([
      { value: DEFAULT_PROFILE_ID, label: 'Miami or Bust' },
      { value: '6f1d2c', label: 'DPRTMNT' },
      { value: EVERY_PROFILE, label: 'Every profile' },
    ]);
    expect(profileSelectOptions(null)).toEqual([{ value: EVERY_PROFILE, label: 'Every profile' }]);
  });

  it('always offers the selected value, so the picker never shows another profile than the one used', () => {
    const opts = profileSelectOptions(profiles);
    expect(withSelectedOption(opts, '6f1d2c', profiles)).toEqual(opts);
    expect(withSelectedOption(opts, EVERY_PROFILE, profiles)).toEqual(opts);
    // Deleted meanwhile: listed (before "Every profile") and labelled as such.
    expect(withSelectedOption(opts, 'gone99', profiles)).toEqual([
      { value: DEFAULT_PROFILE_ID, label: 'Miami or Bust' },
      { value: '6f1d2c', label: 'DPRTMNT' },
      { value: 'gone99', label: 'Deleted profile' },
      { value: EVERY_PROFILE, label: 'Every profile' },
    ]);
    // List not loaded yet.
    expect(withSelectedOption(profileSelectOptions(null), 'club42', null)).toEqual([
      { value: 'club42', label: 'Profile' },
      { value: EVERY_PROFILE, label: 'Every profile' },
    ]);
    // Without an "Every profile" option (dock link picker): appended.
    expect(withSelectedOption([{ value: '6f1d2c', label: 'DPRTMNT' }], DEFAULT_PROFILE_ID, null)).toEqual([
      { value: '6f1d2c', label: 'DPRTMNT' },
      { value: DEFAULT_PROFILE_ID, label: 'Main' },
    ]);
  });

  it('maps "every profile" to null and back', () => {
    expect(profileFromSelect(EVERY_PROFILE)).toBeNull();
    expect(profileFromSelect('')).toBeNull();
    expect(profileFromSelect('6f1d2c')).toBe('6f1d2c');
    expect(profileToSelect(null)).toBe(EVERY_PROFILE);
    expect(profileToSelect(undefined)).toBe(EVERY_PROFILE);
    expect(profileToSelect('6f1d2c')).toBe('6f1d2c');
  });
});

describe('pairing requests', () => {
  it('keeps unexpired requests, newest first', () => {
    const list = [
      pairing('old', { createdAt: '2026-10-15T17:50:00Z' }),
      pairing('expired', { expiresAt: '2026-10-15T17:59:59Z' }),
      pairing('new', { createdAt: '2026-10-15T17:59:00Z' }),
    ];
    expect(pendingPairings(list, NOW).map((p) => p.id)).toEqual(['new', 'old']);
    expect(pendingPairings(null, NOW)).toEqual([]);
  });

  it('says when a request expires', () => {
    expect(pairingExpiresText(pairing('a'), NOW)).toBe('expires in 8 min');
    expect(pairingExpiresText(pairing('a', { expiresAt: '2026-10-15T18:00:40Z' }), NOW)).toBe('expires in 40 s');
    expect(pairingExpiresText(pairing('a', { expiresAt: '2026-10-15T17:00:00Z' }), NOW)).toBe('expired');
    expect(pairingExpiresText(pairing('a', { expiresAt: 'nope' }), NOW)).toBe('');
  });

  it('starts the approve form with what the app asked for', () => {
    expect(pairingDefaults(pairing('a'), profiles)).toEqual({
      name: 'CTD OBS plugin (Studio PC)',
      scopes: ['chat:read', 'status:read', 'ingest:read', 'apps:read', 'apps:write'],
      profileId: null,
    });
    expect(pairingDefaults(pairing('a', { requestedProfileId: '6f1d2c' }), profiles).profileId).toBe('6f1d2c');
    // A profile that's gone falls back to the default one, never to every profile.
    expect(pairingDefaults(pairing('a', { requestedProfileId: 'gone' }), profiles).profileId).toBe(DEFAULT_PROFILE_ID);
    // Unknown scopes are dropped; nothing usable -> the read-only basics.
    expect(pairingDefaults(pairing('a', { requestedScopes: ['admin:all' as never] }), profiles).scopes).toEqual([...BASIC_SCOPES]);
    // An admin-only scope (operator tools) is never part of what a pairing starts with.
    expect(pairingDefaults(pairing('a', { requestedScopes: ['system:admin', 'status:read'] }), profiles).scopes).toEqual(['status:read']);
    expect(pairingDefaults(pairing('a', { requestedScopes: ['system:admin'] }), profiles).scopes).toEqual([...BASIC_SCOPES]);
    expect(pairingDefaults(pairing('a', { appName: 'x'.repeat(80) }), profiles).name).toHaveLength(60);
    expect(knownScopes(['apps:write', 'nope', 'chat:read'])).toEqual(['chat:read', 'apps:write']);
  });

  it('builds the banner text', () => {
    expect(pairingBannerText([])).toBe('');
    expect(pairingBannerText([pairing('a')])).toBe('CTD OBS plugin (Studio PC) wants to connect to CTD Relay (code KQ7-2MX).');
    expect(pairingBannerText([pairing('a'), pairing('b')])).toBe('2 apps want to connect to CTD Relay.');
  });
});

describe('connected apps', () => {
  it('lists online apps first, then by name', () => {
    const list = [app('b-off', { online: false, name: 'B' }), app('z', { name: 'Z' }), app('a', { name: 'A' })];
    expect(sortApps(list).map((a) => a.id)).toEqual(['a', 'z', 'b-off']);
  });

  it('groups resources by profile in profile order, unassigned last', () => {
    const groups = groupResources(
      [overlay('h', '6f1d2c'), overlay('all', null), overlay('m', DEFAULT_PROFILE_ID), overlay('v', '6f1d2c'), overlay('x', 'gone')],
      profiles,
    );
    expect(groups.map((g) => [g.profileId, g.resources.map((r) => r.id)])).toEqual([
      [DEFAULT_PROFILE_ID, ['m']],
      ['6f1d2c', ['h', 'v']],
      ['gone', ['x']],
      [null, ['all']],
    ]);
    expect(groupResources(undefined, profiles)).toEqual([]);
  });

  it('summarises resources', () => {
    expect(resourceSummary([overlay('h', null), overlay('v', null)])).toBe('2 overlays');
    expect(resourceSummary([overlay('h', null), { type: 'scene', id: 's', name: 'S', profileId: null }])).toBe('1 overlay, 1 scene');
    const many = ['A', 'B', 'C', 'D', 'E'].map((n) => overlay(n.toLowerCase(), null, n));
    expect(resourceNames(many)).toBe('A, B, C +2 more');
    expect(resourceNames(many.slice(0, 2))).toBe('A, B');
  });

  it('describes presence', () => {
    expect(appStatusText(app('a'), NOW)).toBe('Online');
    expect(appStatusText(app('a', { online: false, lastSeenAt: '2026-10-15T17:55:00Z' }), NOW)).toBe('Offline · last seen 5 min ago');
    expect(appStatusText(app('a', { online: false, lastSeenAt: '' }), NOW)).toBe('Offline');
  });

  it('names dock tokens after their profile, within the length limit', () => {
    expect(dockTokenName('OBS dock', null)).toBe('OBS dock');
    expect(dockTokenName('OBS dock', 'DPRTMNT')).toBe('OBS dock — DPRTMNT');
    const long = dockTokenName('OBS dock', 'x'.repeat(80));
    expect(long).toHaveLength(60);
    expect(long.endsWith('…')).toBe(true);
  });
});
