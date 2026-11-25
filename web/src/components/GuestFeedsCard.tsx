import { useState, type FormEvent } from 'react';
import { GUEST_NAME_MAX, guestOrientation, type GuestFeed, type GuestFeedList } from '@shared/guest-feeds';
import { api } from '../api';
import { errorMessage } from '../state/errors';
import { applyGuestFeed, bitrateWarning, guestFeedState, guestMediaLine, guestSource, guestStatus, ingestText } from '../state/guest-feeds';
import { useApi } from '../state/hooks';
import { useLiveEvent } from '../state/live';
import { Badge } from './Badge';
import { Button } from './Button';
import { Card } from './Card';
import { ConfirmButton } from './ConfirmButton';
import { FeedThumbnail } from './FeedThumbnail';
import { GuestRoutesPanel } from './GuestRoutes';
import { LivePlayerModal } from './LivePlayer';
import { Spinner } from './Spinner';
import { TextInput } from './TextInput';
import { toast } from './Toast';
import { copyText } from './utils';

/**
 * Guest feeds (docs/GUEST-FEEDS.md): remote guests send video to Relay, CTD OBS pulls it in as a
 * "CTD Relay Feed" source. Everyone sees the slots, thumbnails and Watch; admins add, rename and
 * remove slots, copy a slot's ingest details and rotate or revoke its key.
 */
export function GuestFeedsCard({ profileId, isAdmin }: { profileId: string; isAdmin: boolean }) {
  const list = useApi(() => api.guestFeeds(profileId), [profileId]);
  const [watching, setWatching] = useState<GuestFeed | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  useLiveEvent('guest-feed', (msg) => {
    if (msg.profileId === profileId) list.setData((l) => applyGuestFeed(l ?? null, msg.guestFeed) ?? l);
  });
  useLiveEvent('guest-feeds-changed', (msg) => {
    if (msg.profileId === profileId) list.reload();
  });

  const data = list.data;
  if (data && data.maxSlots === 0) return null; // turned off on this server (GUEST_FEEDS_MAX=0)

  const watched = watching && data?.guestFeeds.find((g) => g.slot === watching.slot);

  return (
    <Card
      title="Guest feeds"
      subtitle="Video a remote guest sends to Relay, for CTD OBS to use as a source (CTD Relay Feed). Never sent to your platforms."
      actions={
        <Button size="sm" variant="ghost" onClick={() => setShowHelp((v) => !v)} aria-expanded={showHelp}>
          {showHelp ? 'Hide help' : 'How a guest sends video'}
        </Button>
      }
    >
      <div className="stack">
        {showHelp && <GuestHelp />}
        {!data ? (
          list.error ? (
            <p className="muted">
              Couldn't load the guest feeds: {list.error}{' '}
              <Button size="sm" onClick={list.reload}>
                Try again
              </Button>
            </p>
          ) : (
            <div className="row muted">
              <Spinner size="sm" /> Loading…
            </div>
          )
        ) : (
          <>
            {data.guestFeeds.length === 0 && <p className="muted">No guest feeds yet.{isAdmin ? ' Add one, then send its ingest details to your guest.' : ''}</p>}
            <ul className="guest-feeds">
              {data.guestFeeds.map((g) => (
                <GuestRow key={g.slot} profileId={profileId} list={data} g={g} isAdmin={isAdmin} onWatch={() => setWatching(g)} onChanged={list.reload} />
              ))}
            </ul>
            {isAdmin && <AddGuest profileId={profileId} list={data} onAdded={list.reload} />}
          </>
        )}
      </div>
      {watched && (
        <LivePlayerModal
          open
          onClose={() => setWatching(null)}
          profileId={profileId}
          feed={guestOrientation(watched)}
          state={guestFeedState(watched, profileId)}
          source={guestSource(profileId, watched)}
        />
      )}
    </Card>
  );
}

function GuestRow({
  profileId,
  list,
  g,
  isAdmin,
  onWatch,
  onChanged,
}: {
  profileId: string;
  list: GuestFeedList;
  g: GuestFeed;
  isAdmin: boolean;
  onWatch: () => void;
  onChanged: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(g.name);
  const [busy, setBusy] = useState<string | null>(null);
  const status = guestStatus(g);
  const media = guestMediaLine(g);
  const warning = bitrateWarning(g, list);

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

  const copyIngest = () =>
    run('copy', async () => {
      const text = ingestText(g.name, await api.guestIngest(profileId, g.slot));
      if (!text) {
        toast.warn('This slot has no key. Rotate it to make a new one.');
        return;
      }
      if (await copyText(text)) toast.success('Ingest details copied. Send them only to this guest: the key works like a password.');
      else toast.error("Couldn't copy here. Use HTTPS, or a browser that allows copying.");
    });

  const saveName = (e: FormEvent) => {
    e.preventDefault();
    void run('rename', async () => {
      await api.renameGuestFeed(profileId, g.slot, name);
      setRenaming(false);
      onChanged();
    });
  };

  return (
    <li className="guest-feed">
      <FeedThumbnail
        profileId={profileId}
        feed={guestOrientation(g)}
        state={g.key === 'revoked' ? { ...guestFeedState(g, profileId), online: false } : guestFeedState(g, profileId)}
        source={guestSource(profileId, g)}
        compact
        onWatch={onWatch}
      />
      <div className="guest-feed-body">
        {renaming ? (
          <form className="row" onSubmit={saveName}>
            <TextInput value={name} maxLength={GUEST_NAME_MAX} onValueChange={setName} aria-label="Guest feed name" autoFocus />
            <Button size="sm" type="submit" variant="primary" loading={busy === 'rename'}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => (setRenaming(false), setName(g.name))}>
              Cancel
            </Button>
          </form>
        ) : (
          <div className="row">
            <strong>{g.name}</strong>
            <Badge tone={status.tone} dot pulse={g.online}>
              {status.label}
            </Badge>
            {g.problem && (
              <Badge tone={g.problem.blocking ? 'danger' : 'warn'} title={g.problem.message}>
                {g.problem.label} ⚠
              </Badge>
            )}
          </div>
        )}
        {media && <span className="small muted">{media}</span>}
        {g.problem && <span className="small">{g.problem.message}</span>}
        {warning && <span className="small text-warn">{warning}</span>}
        {isAdmin && !renaming && (
          <div className="row guest-feed-actions">
            <Button size="sm" onClick={copyIngest} loading={busy === 'copy'} disabled={g.key === 'revoked'}>
              Copy ingest details
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}>
              Rename
            </Button>
            <ConfirmButton
              size="sm"
              variant="ghost"
              confirmLabel={g.online ? 'Disconnects the guest. Sure?' : 'New key?'}
              loading={busy === 'rotate'}
              onConfirm={() =>
                run('rotate', async () => {
                  await api.rotateGuestKey(profileId, g.slot);
                  toast.warn(`New key for ${g.name}. Copy the ingest details again and send them to the guest.`);
                  onChanged();
                })
              }
            >
              {g.key === 'revoked' ? 'New key' : 'Rotate key'}
            </ConfirmButton>
            {g.key === 'active' && (
              <ConfirmButton
                size="sm"
                variant="ghost"
                confirmLabel="Revoke? Nobody can send until a new key."
                loading={busy === 'revoke'}
                onConfirm={() =>
                  run('revoke', async () => {
                    await api.revokeGuestKey(profileId, g.slot);
                    onChanged();
                  })
                }
              >
                Revoke key
              </ConfirmButton>
            )}
            <ConfirmButton
              size="sm"
              variant="ghost"
              confirmLabel="Remove it?"
              loading={busy === 'remove'}
              aria-label={`Remove ${g.name}`}
              onConfirm={() =>
                run('remove', async () => {
                  await api.removeGuestFeed(profileId, g.slot);
                  onChanged();
                })
              }
            >
              Remove
            </ConfirmButton>
          </div>
        )}
        <GuestRoutesPanel profileId={profileId} slot={g.slot} guestName={g.name} isAdmin={isAdmin} />
      </div>
    </li>
  );
}

function AddGuest({ profileId, list, onAdded }: { profileId: string; list: GuestFeedList; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const full = list.guestFeeds.length >= list.maxSlots;

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const clean = name.trim() || `Guest ${list.guestFeeds.length + 1}`;
    setBusy(true);
    try {
      await api.addGuestFeed(profileId, clean);
      setName('');
      toast.success(`${clean} added. Copy its ingest details and send them to your guest.`);
      onAdded();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (full) return <p className="small muted">{list.maxSlots} guest feeds is the most per profile on this server.</p>;
  return (
    <form className="row" onSubmit={add}>
      <TextInput value={name} onValueChange={setName} maxLength={GUEST_NAME_MAX} placeholder={`Guest ${list.guestFeeds.length + 1}`} aria-label="New guest feed name" />
      <Button type="submit" variant="primary" size="sm" loading={busy}>
        Add guest feed
      </Button>
    </form>
  );
}

/** "How a guest sends video": OBS, Larix, other apps. Placeholders only, never a real address. */
export function GuestHelp() {
  return (
    <div className="alert guest-help">
      <p>
        <strong>How a guest sends video.</strong> Add a slot, press <em>Copy ingest details</em> and send them to the guest (privately: the key works
        like a password). They need H.264 video and AAC audio, a keyframe every 2 s, and a steady upload of about 1.5× their bitrate.
      </p>
      <ul>
        <li>
          <strong>OBS:</strong> Settings → Stream → Service <em>Custom…</em>, Server <code>rtmp://&lt;relay host&gt;:&lt;RTMP port&gt;/guest</code>, Stream
          Key <code>&lt;slot&gt;?key=&lt;key&gt;</code>. Output: x264 or hardware H.264, CBR, 2500–6000 kbps, keyframe interval 2 s, AAC 160 kbps.
        </li>
        <li>
          <strong>Larix Broadcaster (phone):</strong> Settings → Connections → New: paste the <em>Full URL</em>{' '}
          <code>rtmp://&lt;relay host&gt;:&lt;RTMP port&gt;/guest/&lt;slot&gt;?key=&lt;key&gt;</code>. Video codec H.264, audio AAC.
        </li>
        <li>
          <strong>Other apps</strong> (vMix, Wirecast, Streamlabs, an encoder box): any custom RTMP output with the server and stream key above, or the
          full URL.
        </li>
      </ul>
      <p className="small muted">
        The guest needs to reach Relay's RTMP port from the internet: through a VPN to your network (safest), or a port you forward on purpose (see
        the guest feeds guide). Rotate or revoke a key any time; the guest is disconnected at once. CTD OBS adds a guest feed with the <em>CTD Relay
        Feed</em> source.
      </p>
    </div>
  );
}
