// Wording and fallback rules for destinations that wait for an OBS feed (phase `waiting-for-feed`).

import type { Destination, Feed } from '../../../shared/types.js';

/** "Waiting for vertical feed", "Waiting for landscape feed" or "Waiting for both feeds". */
export function waitingForFeedMessage(missing: readonly Feed[]): string {
  const feeds = new Set(missing);
  if (feeds.has('landscape') && feeds.has('vertical')) return 'Waiting for both feeds';
  const only = feeds.has('vertical') ? 'vertical' : 'landscape';
  return `Waiting for ${only} feed`;
}

/**
 * The feeds a destination needs, without asking its driver: the status API has no driver access.
 * Mirrors the Twitch driver's requiredFeeds (Dual Format relay needs both, OBS-direct needs none).
 */
export function requiredFeedsOf(dest: Pick<Destination, 'platform' | 'feed' | 'options'>): Feed[] {
  if (dest.platform === 'twitch') {
    const dual = dest.options?.dualFormat;
    if (dual === 'relay-multitrack') return ['landscape', 'vertical'];
    if (dual === 'obs-direct') return [];
  }
  return [dest.feed];
}
