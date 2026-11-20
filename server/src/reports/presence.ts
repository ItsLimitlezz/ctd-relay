// Presence for stream reports: platforms that tell Relay who is in the chat right now. Only Twitch
// does (Get Chatters, scope moderator:read:chatters). Every other platform answers 'unsupported',
// and its viewers only count as "attended" when they chat or join; Relay never makes up watch time.

import type { Destination } from '../../../shared/types.js';
import { canReadChatters, TwitchClient } from '../platforms/twitch/api.js';
import type { AppServices } from '../services.js';
import type { PresenceProvider, PresenceResult } from './recorder.js';

export function createPresenceProvider(services: Pick<AppServices, 'driverContext'>): PresenceProvider {
  return async (dest: Destination, signal: AbortSignal): Promise<PresenceResult> => {
    if (dest.platform !== 'twitch' || !dest.accountId) return { ok: false, reason: 'unsupported' };
    const ctx = await services.driverContext({ platform: 'twitch', accountId: dest.accountId, destinationId: dest.id, signal });
    const clientId = ctx.app?.clientId?.trim();
    if (!clientId || !ctx.accountSecrets) return { ok: false, reason: 'unsupported' };
    const client = new TwitchClient({ clientId, accountId: dest.accountId, secrets: ctx.accountSecrets, log: ctx.log, signal });
    const info = await client.validate();
    if (!canReadChatters(info)) {
      return { ok: false, reason: 'scope', message: 'Twitch: reconnect the account to allow the chatters list (watch time)' };
    }
    return { ok: true, users: await client.chatters(info.userId, info.userId, signal) };
  };
}
