import { useState } from 'react';
import type { PullLinkState } from '@shared/pull-links';
import { api, type PullLinkTarget } from '../api';
import { errorMessage } from '../state/errors';
import { useApi } from '../state/hooks';
import { Badge } from './Badge';
import { Button } from './Button';
import { ConfirmButton } from './ConfirmButton';
import { usePoll } from './GuestRoutes';
import { toast } from './Toast';
import { Toggle } from './Toggle';
import { copyText } from './utils';

/** How often the reader count is refreshed while the panel is on screen. */
export const PULL_POLL_MS = 3_000;

/** "2 of 2 watching" / "Nobody watching". */
export function readersText(s: Pick<PullLinkState, 'readers' | 'maxReaders'>): string {
  return s.readers === 0 ? 'Nobody watching' : `${s.readers} of ${s.maxReaders} watching`;
}

/** The three steps, with the link, for someone setting up OBS. */
export function pullStepsText(label: string, url: string): string {
  return [
    `Pull link for ${label} (keep it private: anyone with it can watch):`,
    url,
    'OBS: Sources → + (Add) → Media Source → untick "Local File" → paste the link into "Input".',
    'VLC: Media → Open Network Stream → paste the link.',
  ].join('\n');
}

/**
 * "Pull link (OBS, VLC)" (docs/GUEST-FEEDS.md → Pull link): a plain RTMP address to paste into an OBS
 * Media Source or VLC, with its own read key. Admins switch it on/off, copy it and rotate the key;
 * everyone sees whether it's on and how many players are reading.
 */
export function PullLinkPanel({ profileId, target, label, isAdmin }: { profileId: string; target: PullLinkTarget; label: string; isAdmin: boolean }) {
  const key = 'slot' in target ? `slot:${target.slot}` : `feed:${target.feed}`;
  const admin = useApi(() => (isAdmin ? api.pullLink(profileId, target) : Promise.resolve(null)), [profileId, key, isAdmin]);
  const all = useApi(() => (isAdmin ? Promise.resolve(null) : api.pullLinks(profileId)), [profileId, isAdmin]);
  usePoll(isAdmin ? admin.reload : all.reload, PULL_POLL_MS);
  const [busy, setBusy] = useState<string | null>(null);

  const state: PullLinkState | null | undefined = isAdmin
    ? admin.data
    : all.data
      ? 'slot' in target
        ? all.data.guestFeeds[target.slot]
        : all.data.feeds[target.feed]
      : undefined;
  if (!state) return null;
  if (!isAdmin && !state.enabled) return null;

  const info = admin.data;
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const copy = (text: string, what: string) =>
    run(`copy-${what}`, async () => {
      if (await copyText(text)) toast.success(`${what} copied. Keep it private: anyone with the link can watch.`);
      else toast.error("Couldn't copy here. Use HTTPS, or a browser that allows copying.");
    });

  const masked = info?.url ? `${info.serverUrl}?key=••••••••` : null;

  return (
    <div className="pull-link" aria-label={`Pull link for ${label}`} role="group">
      <div className="row">
        <strong className="small">Pull link (OBS, VLC)</strong>
        {isAdmin && state.maxReaders > 0 && (
          <Toggle
            size="sm"
            checked={state.enabled}
            busy={busy === 'toggle'}
            aria-label={`Pull link for ${label}`}
            onChange={(on) =>
              void run('toggle', async () => {
                await api.setPullLink(profileId, target, on);
                admin.reload();
              })
            }
          />
        )}
        {state.enabled && (
          <Badge tone={state.readers > 0 ? 'success' : 'neutral'} dot pulse={state.readers > 0}>
            {readersText(state)}
          </Badge>
        )}
      </div>
      {isAdmin && state.maxReaders === 0 && <span className="small muted">Pull links are turned off on this server (PULL_LINK_MAX_READERS=0).</span>}
      {isAdmin && info?.url && (
        <>
          <code className="small pull-link-url" title="The key is hidden here; Copy link copies the whole link.">
            {masked}
          </code>
          <div className="row">
            <Button size="sm" variant="primary" onClick={() => void copy(info.url!, 'Link')} loading={busy === 'copy-Link'}>
              Copy link
            </Button>
            <Button size="sm" onClick={() => void copy(pullStepsText(label, info.url!), 'Link and steps')} loading={busy === 'copy-Link and steps'}>
              Copy with steps
            </Button>
            <ConfirmButton
              size="sm"
              variant="ghost"
              confirmLabel={state.readers > 0 ? 'Disconnects who is watching. Sure?' : 'New link?'}
              loading={busy === 'rotate'}
              onConfirm={() =>
                run('rotate', async () => {
                  await api.rotatePullLink(profileId, target);
                  toast.warn('New pull link. The old one stopped working; copy the new one.');
                  admin.reload();
                })
              }
            >
              Rotate key
            </ConfirmButton>
          </div>
          <ol className="small pull-link-steps">
            <li>In OBS: Sources → + (Add) → Media Source.</li>
            <li>Untick “Local File”.</li>
            <li>Paste the link into “Input”. (VLC: Media → Open Network Stream.)</li>
          </ol>
          <span className="small text-warn">Anyone with this link can watch. Keep it private; rotate the key or switch it off to cut everyone off.</span>
        </>
      )}
    </div>
  );
}
