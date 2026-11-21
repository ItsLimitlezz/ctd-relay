// Twitch presence for reports: the chatters list (stubbed fetch, no network).

import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Destination } from '../../../shared/types.js';
import { forgetValidation } from '../platforms/twitch/api.js';
import type { AppServices } from '../services.js';
import { createPresenceProvider } from './presence.js';

const dest = (over: Partial<Destination> = {}): Destination => ({
  id: 'd1',
  profileId: 'default',
  platform: 'twitch',
  accountId: 'acc1',
  name: 'Twitch',
  feed: 'landscape',
  enabled: true,
  options: {},
  ingestUrl: null,
  hasStreamKey: false,
  createdAt: '',
  updatedAt: '',
  ...over,
});

function services(): Pick<AppServices, 'driverContext'> {
  const tokens = { accessToken: 'tok', refreshToken: null, expiresAt: null, scope: null, tokenType: 'bearer' };
  const secrets = { get: async () => null, set: async () => {}, delete: async () => {}, getJson: async () => tokens, setJson: async () => {} };
  return {
    driverContext: async () =>
      ({ log: pino({ level: 'silent' }), accountSecrets: secrets, destinationSecrets: null, app: { clientId: 'cid' }, signal: new AbortController().signal }) as never,
  };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  forgetValidation();
});

describe('createPresenceProvider', () => {
  it('reads every page of the chatters list as the broadcaster (its own moderator)', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.includes('/oauth2/validate')) return ok({ client_id: 'cid', login: 'channel', user_id: '500', scopes: ['moderator:read:chatters'] });
        if (!url.includes('after=')) return ok({ data: [{ user_id: '1', user_login: 'viewer_a', user_name: 'Viewer_A' }], pagination: { cursor: 'c2' } });
        return ok({ data: [{ user_id: '2', user_login: 'viewer_b', user_name: '' }, { user_login: 'no_id' }], pagination: {} });
      }),
    );
    const r = await createPresenceProvider(services())(dest(), new AbortController().signal);
    expect(r).toEqual({
      ok: true,
      users: [
        { id: '1', login: 'viewer_a', name: 'Viewer_A' },
        { id: '2', login: 'viewer_b', name: 'viewer_b' },
      ],
    });
    const chatters = urls.filter((u) => u.includes('/chat/chatters'));
    expect(chatters[0]).toContain('broadcaster_id=500&moderator_id=500&first=1000');
    expect(chatters[1]).toContain('after=c2');
  });

  it('without moderator:read:chatters: says so instead of calling Twitch', async () => {
    const fetch = vi.fn(async () => ok({ client_id: 'cid', login: 'channel', user_id: '500', scopes: ['channel:manage:broadcast'] }));
    vi.stubGlobal('fetch', fetch);
    const r = await createPresenceProvider(services())(dest(), new AbortController().signal);
    expect(r).toMatchObject({ ok: false, reason: 'scope' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('other platforms do not report presence', async () => {
    const r = await createPresenceProvider(services())(dest({ platform: 'youtube' }), new AbortController().signal);
    expect(r).toEqual({ ok: false, reason: 'unsupported' });
  });
});
