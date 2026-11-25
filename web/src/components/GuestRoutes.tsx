import { useEffect, useRef, useState, type FormEvent } from 'react';
import { feedLabel, type GuestRoute, type GuestRouteState } from '@shared/guest-routes';
import type { Feed } from '@shared/types';
import { api } from '../api';
import { errorMessage } from '../state/errors';
import { useApi } from '../state/hooks';
import { Badge } from './Badge';
import { Button } from './Button';
import { ConfirmButton } from './ConfirmButton';
import { Select } from './Select';
import { TextInput } from './TextInput';
import { toast } from './Toast';
import { Toggle } from './Toggle';
import type { Tone } from './utils';

/** How often route state is refreshed while the card is on screen. */
export const ROUTE_POLL_MS = 3_000;

/** Reload `reload` every `ms` while mounted. */
export function usePoll(reload: () => void, ms: number): void {
  const ref = useRef(reload);
  useEffect(() => {
    ref.current = reload;
  });
  useEffect(() => {
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}

const STATE_LABEL: Record<GuestRouteState, { label: string; tone: Tone }> = {
  idle: { label: 'Stopped', tone: 'neutral' },
  starting: { label: 'Starting', tone: 'info' },
  running: { label: 'Sending', tone: 'success' },
  retrying: { label: 'Retrying', tone: 'warn' },
  blocked: { label: 'Blocked', tone: 'danger' },
  failed: { label: 'Failed', tone: 'danger' },
};

export function routeStatus(r: GuestRoute): { label: string; tone: Tone } {
  if (r.state === 'idle' && r.auto) return { label: 'Waits for the feed', tone: 'neutral' };
  return STATE_LABEL[r.state];
}

export function routeTargetText(r: GuestRoute): string {
  if (r.target.kind === 'rtmp') return `${r.target.url ?? r.target.host}${r.target.hasKey ? ' (key set)' : ''}`;
  return `${feedLabel(r.target.feed)} feed of ${r.target.profileName ? `"${r.target.profileName}"` : 'a removed profile'}`;
}

/**
 * "Send this feed to…" (docs/GUEST-FEEDS.md → Routing): the routes of one guest feed with their live
 * state; admins add custom servers or profile inputs, start/stop them and switch "when the feed is online".
 */
export function GuestRoutesPanel({ profileId, slot, guestName, isAdmin }: { profileId: string; slot: string; guestName: string; isAdmin: boolean }) {
  const list = useApi(() => api.guestRoutes(profileId, slot), [profileId, slot]);
  usePoll(list.reload, ROUTE_POLL_MS);
  const [adding, setAdding] = useState(false);
  const routes = list.data?.routes ?? [];
  if (!isAdmin && routes.length === 0) return null;

  return (
    <div className="guest-routes stack" aria-label={`Routes of ${guestName}`}>
      {routes.length > 0 && (
        <ul className="guest-route-list">
          {routes.map((r) => (
            <RouteRow key={r.id} profileId={profileId} r={r} isAdmin={isAdmin} onChanged={list.reload} />
          ))}
        </ul>
      )}
      {isAdmin &&
        (adding ? (
          <AddRoute profileId={profileId} slot={slot} onDone={() => (setAdding(false), list.reload())} />
        ) : (
          <div className="row">
            <Button size="sm" onClick={() => setAdding(true)}>
              Send this feed to…
            </Button>
          </div>
        ))}
    </div>
  );
}

function RouteRow({ profileId, r, isAdmin, onChanged }: { profileId: string; r: GuestRoute; isAdmin: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const status = routeStatus(r);
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await fn();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
      onChanged();
    }
  };
  return (
    <li className="guest-route" data-route={r.id}>
      <div className="row">
        <strong>{r.name}</strong>
        <Badge tone={status.tone} dot pulse={r.state === 'running'}>
          {status.label}
        </Badge>
        {r.state === 'running' && r.bitrateKbps !== null && <span className="small muted">{Math.round(r.bitrateKbps)} kbps</span>}
      </div>
      <span className="small muted">→ {routeTargetText(r)}</span>
      {r.message && <span className={r.state === 'running' ? 'small text-warn' : 'small text-danger'}>{r.message}</span>}
      {isAdmin && (
        <div className="row guest-feed-actions">
          {r.active ? (
            <Button size="sm" onClick={() => void run('stop', () => api.stopGuestRoute(profileId, r.slot, r.id))} loading={busy === 'stop'}>
              Stop
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => void run('start', () => api.startGuestRoute(profileId, r.slot, r.id))} loading={busy === 'start'}>
              Start
            </Button>
          )}
          <Toggle
            size="sm"
            checked={r.auto}
            busy={busy === 'auto'}
            label="When the feed is online"
            onChange={(auto) => void run('auto', () => api.updateGuestRoute(profileId, r.slot, r.id, { auto }))}
          />
          <ConfirmButton
            size="sm"
            variant="ghost"
            confirmLabel="Remove this route?"
            loading={busy === 'remove'}
            aria-label={`Remove route ${r.name}`}
            onConfirm={() => void run('remove', () => api.removeGuestRoute(profileId, r.slot, r.id))}
          >
            Remove
          </ConfirmButton>
        </div>
      )}
    </li>
  );
}

function AddRoute({ profileId, slot, onDone }: { profileId: string; slot: string; onDone: () => void }) {
  const [kind, setKind] = useState<'rtmp' | 'profile'>('rtmp');
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [target, setTarget] = useState(profileId);
  const [feed, setFeed] = useState<Feed>('landscape');
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const profiles = useApi(() => api.profiles(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (kind === 'rtmp') await api.addGuestRoute(profileId, slot, { kind, url, streamKey: key || null, auto });
      else await api.addGuestRoute(profileId, slot, { kind, profileId: target, feed, auto });
      toast.success('Route added.');
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack guest-route-form" onSubmit={submit} aria-label="Send this feed to">
      <div className="row" role="radiogroup" aria-label="Send to">
        <label className="row">
          <input type="radio" name={`kind-${slot}`} checked={kind === 'rtmp'} onChange={() => setKind('rtmp')} /> A custom server (RTMP/RTMPS)
        </label>
        <label className="row">
          <input type="radio" name={`kind-${slot}`} checked={kind === 'profile'} onChange={() => setKind('profile')} /> A profile's feed
        </label>
      </div>
      {kind === 'rtmp' ? (
        <>
          <TextInput value={url} onValueChange={setUrl} placeholder="rtmps://live.example.com/app" aria-label="Server URL" mono required />
          <TextInput value={key} onValueChange={setKey} type="password" autoComplete="off" placeholder="Stream key (optional)" aria-label="Stream key" mono />
          <span className="small muted">Passthrough: the feed's video is copied as it is, never re-encoded. The key is stored encrypted and never shown again.</span>
        </>
      ) : (
        <>
          <div className="row">
            <Select
              aria-label="Target profile"
              value={target}
              onValueChange={setTarget}
              options={(profiles.data?.profiles ?? []).map((p) => ({ value: p.id, label: p.name }))}
            />
            <Select
              aria-label="Input"
              value={feed}
              onValueChange={(v) => setFeed(v === 'vertical' ? 'vertical' : 'landscape')}
              options={[
                { value: 'landscape', label: 'Landscape feed' },
                { value: 'vertical', label: 'Vertical feed' },
              ]}
            />
          </div>
          <span className="small muted">
            The profile then uses the guest exactly like a feed from OBS. Relay refuses while OBS is sending that feed, and never starts the profile's Go
            live.
          </span>
        </>
      )}
      <Toggle checked={auto} onChange={setAuto} label="Start when the feed is online" />
      <div className="row">
        <Button type="submit" size="sm" variant="primary" loading={busy}>
          Add route
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
