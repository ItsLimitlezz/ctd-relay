import { describe, expect, it } from 'vitest';
import type { MediaMtxAuthRequest } from '../services.js';
import {
  authorizeMediaRequest,
  generateKey,
  isLoopbackIp,
  isValidKey,
  queryParam,
  safeEqual,
  singleProfileAuth,
  type IngestAuthState,
  type IngestSecrets,
  type ProfileIngestKeys,
} from './authorize.js';
import { feedForPath, feedPath, parseFeedPath, PROFILE_PATHS_REGEX, streamKeyPath } from './paths.js';

const keys: IngestSecrets = {
  landscape: 'LandscapeKey_0123456789ab',
  vertical: 'VerticalKey_0123456789abc',
  internalReader: 'ReaderPass_0123456789abcd',
};
const single = singleProfileAuth(keys);

function req(overrides: Partial<MediaMtxAuthRequest>): MediaMtxAuthRequest {
  return { user: '', password: '', ip: '10.20.30.40', action: 'publish', path: 'live/landscape', protocol: 'rtmp', id: null, query: '', ...overrides };
}

describe('authorizeMediaRequest (default profile, unchanged behaviour)', () => {
  it.each([
    ['publish landscape with its key', req({ query: `key=${keys.landscape}` }), true],
    ['publish vertical with its key', req({ path: 'live/vertical', query: `key=${keys.vertical}` }), true],
    ['publish with a leading slash', req({ path: '/live/landscape', query: `key=${keys.landscape}` }), true],
    ['publish with key among other params', req({ query: `foo=1&key=${keys.landscape}&bar=2` }), true],
    ['publish with a wrong key', req({ query: 'key=nope' }), false],
    ['publish with the other feed key', req({ query: `key=${keys.vertical}` }), false],
    ['publish without key', req({ query: '' }), false],
    ['publish with the key as password', req({ password: keys.landscape }), false],
    ['publish to a wrong path', req({ path: 'live/other', query: `key=${keys.landscape}` }), false],
    ['publish to a nested path', req({ path: 'live/landscape/x', query: `key=${keys.landscape}` }), false],
    ['publish to an unknown profile path', req({ path: 'live/club/landscape', query: `key=${keys.landscape}` }), false],
    ['publish with the reader password', req({ query: `key=${keys.internalReader}` }), false],
    ['read from loopback with reader creds', req({ action: 'read', ip: '127.0.0.1', user: 'internal', password: keys.internalReader }), true],
    ['read from ::1', req({ action: 'read', ip: '::1', user: 'internal', password: keys.internalReader }), true],
    ['read from mapped loopback', req({ action: 'read', ip: '::ffff:127.0.0.1', user: 'internal', password: keys.internalReader }), true],
    ['read from LAN with reader creds', req({ action: 'read', ip: '10.20.30.40', user: 'internal', password: keys.internalReader }), false],
    ['read from loopback with wrong password', req({ action: 'read', ip: '127.0.0.1', user: 'internal', password: 'x' }), false],
    ['read from loopback with wrong user', req({ action: 'read', ip: '127.0.0.1', user: 'admin', password: keys.internalReader }), false],
    ['read from loopback without creds', req({ action: 'read', ip: '127.0.0.1' }), false],
    ['read with the publish key', req({ action: 'read', ip: '127.0.0.1', query: `key=${keys.landscape}` }), false],
    ['read a wrong path', req({ action: 'read', ip: '127.0.0.1', path: 'live/x', user: 'internal', password: keys.internalReader }), false],
    ['api', req({ action: 'api', ip: '127.0.0.1', user: 'internal', password: keys.internalReader }), false],
    ['playback', req({ action: 'playback', ip: '127.0.0.1', user: 'internal', password: keys.internalReader }), false],
    ['metrics', req({ action: 'metrics', ip: '127.0.0.1' }), false],
  ])('%s -> %s', (_name, request, allowed) => {
    expect(authorizeMediaRequest(request, single)).toBe(allowed);
  });

  it('denies everything before keys are loaded', () => {
    expect(authorizeMediaRequest(req({ query: `key=${keys.landscape}` }), null)).toBe(false);
    expect(authorizeMediaRequest(req({ query: `key=${keys.landscape}` }), singleProfileAuth(null))).toBe(false);
    const noReader: IngestAuthState = { readerPassword: null, publishKey: () => keys.landscape };
    expect(authorizeMediaRequest(req({ action: 'read', ip: '127.0.0.1', user: 'internal', password: 'x' }), noReader)).toBe(false);
  });
});

describe('authorizeMediaRequest (several profiles)', () => {
  const club: ProfileIngestKeys = { landscape: 'ClubLandscape_0123456789', vertical: 'ClubVertical_01234567890' };
  const auth: IngestAuthState = {
    readerPassword: keys.internalReader,
    publishKey: ({ slug, feed }) => (slug === null ? keys[feed] : slug === 'dprtmnt' ? club[feed] : null),
  };

  it.each([
    ['club landscape with its key', req({ path: 'live/dprtmnt/landscape', query: `key=${club.landscape}` }), true],
    ['club vertical with its key', req({ path: 'live/dprtmnt/vertical', query: `key=${club.vertical}` }), true],
    ['default landscape still with the legacy key', req({ query: `key=${keys.landscape}` }), true],
    ['club path with the default key', req({ path: 'live/dprtmnt/landscape', query: `key=${keys.landscape}` }), false],
    ['default path with the club key', req({ query: `key=${club.landscape}` }), false],
    ['club path with its other feed key', req({ path: 'live/dprtmnt/landscape', query: `key=${club.vertical}` }), false],
    ['unknown slug with a club key', req({ path: 'live/other/landscape', query: `key=${club.landscape}` }), false],
    ['deeper path', req({ path: 'live/a/dprtmnt/landscape', query: `key=${club.landscape}` }), false],
    ['uppercase slug', req({ path: 'live/DPRTMNT/landscape', query: `key=${club.landscape}` }), false],
    ['read a club feed from loopback', req({ action: 'read', path: 'live/dprtmnt/vertical', ip: '127.0.0.1', user: 'internal', password: keys.internalReader }), true],
    ['read an unknown profile feed', req({ action: 'read', path: 'live/other/vertical', ip: '127.0.0.1', user: 'internal', password: keys.internalReader }), false],
  ])('%s -> %s', (_name, request, allowed) => {
    expect(authorizeMediaRequest(request, auth)).toBe(allowed);
  });
});

describe('paths', () => {
  it('builds and parses feed paths per profile', () => {
    expect(feedPath('landscape')).toBe('live/landscape');
    expect(feedPath('vertical', 'dprtmnt')).toBe('live/dprtmnt/vertical');
    expect(streamKeyPath('landscape')).toBe('landscape');
    expect(streamKeyPath('landscape', 'dprtmnt')).toBe('dprtmnt/landscape');
    expect(parseFeedPath('live/landscape')).toEqual({ slug: null, feed: 'landscape' });
    expect(parseFeedPath('/live/dprtmnt/vertical')).toEqual({ slug: 'dprtmnt', feed: 'vertical' });
    for (const bad of ['live', 'live/', 'live/square', 'other/landscape', 'live/a/b/landscape', 'live/Club/landscape', `live/${'x'.repeat(33)}/landscape`, 'live/dprtmnt/landscape/']) {
      expect(parseFeedPath(bad), bad).toBeNull();
    }
    expect(feedForPath('live/vertical')).toBe('vertical');
    expect(feedForPath('live/dprtmnt/vertical')).toBeNull();
  });

  it('has a MediaMTX regex path matching exactly the non-default profile paths', () => {
    expect(PROFILE_PATHS_REGEX.startsWith('~')).toBe(true);
    const re = new RegExp(PROFILE_PATHS_REGEX.slice(1));
    expect(re.test('live/dprtmnt/landscape')).toBe(true);
    expect(re.test('live/miami-or-bust-2/vertical')).toBe(true);
    for (const p of ['live/landscape', 'live/vertical', 'live/x/y/landscape', 'live/dprtmnt/square', 'xlive/dprtmnt/landscape']) expect(re.test(p), p).toBe(false);
  });
});

describe('helpers', () => {
  it('generates 24-char url-safe keys', () => {
    const a = generateKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(isValidKey(a)).toBe(true);
    expect(generateKey()).not.toBe(a);
    expect(isValidKey('short')).toBe(false);
    expect(isValidKey('has spaces in it and is long')).toBe(false);
    expect(isValidKey(null)).toBe(false);
  });

  it('compares in constant time regardless of length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('recognizes loopback addresses', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '[::1]']) expect(isLoopbackIp(ip)).toBe(true);
    for (const ip of ['192.168.1.2', '10.0.0.1', '::ffff:10.0.0.1', 'fe80::1', '', 'localhost']) expect(isLoopbackIp(ip)).toBe(false);
  });

  it('reads query params with or without a leading ?', () => {
    expect(queryParam('?key=a%2Bb', 'key')).toBe('a+b');
    expect(queryParam('x=1', 'key')).toBeNull();
  });
});
