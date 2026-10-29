import { useEffect, useState, type FormEvent } from 'react';
import type { NowPlaying, SongRequestSettings, SongRequestWho, SpotifyConnectStart, SpotifyStatus } from '@shared/api';
import { api } from '../../api';
import { Button, buttonClass } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmButton } from '../../components/ConfirmButton';
import { CopyField } from '../../components/CopyField';
import { EmptyState } from '../../components/EmptyState';
import { Field } from '../../components/Field';
import { formatDateTime } from '../../components/format';
import { ExternalIcon } from '../../components/icons';
import { ProfileTag } from '../../components/ProfileBadge';
import { Select } from '../../components/Select';
import { Spinner } from '../../components/Spinner';
import { TextInput } from '../../components/TextInput';
import { toast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import { safeHttpUrl } from '../../components/utils';
import { errorMessage } from '../../state/errors';
import { useApi } from '../../state/hooks';
import { useProfileContext } from '../../state/profile';
import { parseWholeNumber } from './settings-helpers';

const WHO_OPTIONS: { value: SongRequestWho; label: string }[] = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'subscribers', label: 'Subscribers / members, VIPs and moderators' },
  { value: 'vips', label: 'VIPs and moderators' },
  { value: 'moderators', label: 'Moderators only' },
];

/** Spotify of the current profile: now playing (for overlays and apps) and !sr song requests from chat. */
export function SpotifyTab() {
  const { profileId, current } = useProfileContext();
  const res = useApi(() => api.music(profileId), [profileId]);
  const s = res.data;

  // Keep the now playing preview fresh while the tab is open.
  useEffect(() => {
    const t = setInterval(res.reload, 5000);
    return () => clearInterval(t);
  }, [res.reload]);

  if (!s) {
    return (
      <Card>
        {res.error ? (
          <EmptyState
            title="Couldn't load Spotify"
            description={res.error}
            action={
              <Button onClick={res.reload} loading={res.loading}>
                Try again
              </Button>
            }
          />
        ) : (
          <div className="row muted">
            <Spinner size="sm" /> Loading…
          </div>
        )}
      </Card>
    );
  }

  return (
    <>
      <Card
        title={current ? `Spotify for ${current.name}` : 'Spotify'}
        subtitle="Show what you're playing on stream, and let chat add songs to your queue with !sr. Relay only reads and adds to the queue: it never skips, pauses or changes the volume."
        actions={<ProfileTag />}
      >
        {s.clientId ? <ConnectionSection status={s} profileId={profileId} onStatus={res.setData} /> : <AppSetup status={s} profileId={profileId} onStatus={res.setData} />}
      </Card>
      {s.connected && <NowPlayingCard nowPlaying={s.nowPlaying} />}
      {s.clientId && <RequestsCard status={s} profileId={profileId} onStatus={res.setData} />}
      {s.clientId && <AppCard status={s} profileId={profileId} onStatus={res.setData} />}
    </>
  );
}

interface SectionProps {
  status: SpotifyStatus;
  profileId: string;
  onStatus: (s: SpotifyStatus) => void;
}

// ---------------------------------------------------------------------------
// Developer app
// ---------------------------------------------------------------------------

function AppSetup({ status, profileId, onStatus }: SectionProps) {
  return (
    <div className="stack">
      <p className="small">
        Spotify needs a free developer app of your own (once, shared by every profile). The account that owns it needs{' '}
        <strong>Spotify Premium</strong>, and adding to the queue needs Premium too.
      </p>
      <ol className="steps">
        <li>
          Open{' '}
          <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">
            developer.spotify.com/dashboard
          </a>{' '}
          and click <strong>Create app</strong>.
        </li>
        <li>Name and description: anything, e.g. "CTD Relay".</li>
        <li>
          <strong>Redirect URI</strong>: add the address below exactly, then click <strong>Add</strong>.
        </li>
        <li>
          Under <strong>Which API/SDKs are you planning to use?</strong> tick <strong>Web API</strong>, accept the terms and save.
        </li>
        <li>
          If you sign in to Spotify with another account than the app's owner, add it under <strong>User Management</strong> (up to
          5 people).
        </li>
        <li>
          Open the app's <strong>Settings</strong> and copy the <strong>Client ID</strong> here. No client secret is needed.
        </li>
      </ol>
      <CopyField label="Redirect URI" value={status.redirectUri} />
      <ClientIdForm profileId={profileId} onStatus={onStatus} />
    </div>
  );
}

function ClientIdForm({ profileId, onStatus, initial = '', onDone }: { profileId: string; onStatus: (s: SpotifyStatus) => void; initial?: string; onDone?: () => void }) {
  const [clientId, setClientId] = useState(initial);
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onStatus(await api.setSpotifyApp(clientId.trim(), profileId));
      toast.success(clientId.trim() ? 'Spotify Client ID saved.' : 'Spotify Client ID removed.');
      onDone?.();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={save}>
      <Field label="Client ID">
        <TextInput value={clientId} placeholder="e.g. 1a2b3c4d5e6f…" autoComplete="off" spellCheck={false} mono maxLength={64} onValueChange={setClientId} />
      </Field>
      <div className="row">
        <Button type="submit" variant="primary" loading={busy} disabled={!clientId.trim() && !initial}>
          Save
        </Button>
        {onDone && (
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function AppCard({ status, profileId, onStatus }: SectionProps) {
  const [editing, setEditing] = useState(false);
  return (
    <Card title="Spotify developer app" subtitle="Shared by every profile. Changing it signs every profile out of Spotify.">
      {editing ? (
        <ClientIdForm profileId={profileId} onStatus={onStatus} initial={status.clientId ?? ''} onDone={() => setEditing(false)} />
      ) : (
        <div className="stack">
          <p className="small">
            Client ID <code>{status.clientId}</code>
          </p>
          <CopyField label="Redirect URI (in the Spotify app)" value={status.redirectUri} />
          <div>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Change Client ID
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function ConnectionSection({ status, profileId, onStatus }: SectionProps) {
  const [start, setStart] = useState<SpotifyConnectStart | null>(null);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState<'start' | 'finish' | null>(null);

  const begin = async () => {
    setBusy('start');
    try {
      setStart(await api.startSpotifyConnect(profileId));
      setPasted('');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const finish = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('finish');
    try {
      const next = await api.completeSpotifyConnect(pasted.trim(), profileId);
      onStatus(next);
      setStart(null);
      toast.success(`Spotify connected${next.account ? ` as ${next.account.name}` : ''}.`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    try {
      onStatus(await api.disconnectSpotify(profileId));
      toast.success('Spotify disconnected.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (status.connected && !start) {
    return (
      <div className="stack">
        <div className="alert alert-success" role="status">
          Connected to Spotify as <strong>{status.account?.name ?? 'your account'}</strong>.
        </div>
        {status.error && (
          <div className="alert alert-warn" role="alert">
            {status.error}
          </div>
        )}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Button size="sm" variant="secondary" loading={busy === 'start'} onClick={() => void begin()}>
            Connect again
          </Button>
          <ConfirmButton size="sm" variant="ghost" confirmLabel="Disconnect Spotify?" onConfirm={disconnect}>
            Disconnect
          </ConfirmButton>
        </div>
      </div>
    );
  }

  const authorizeUrl = start ? safeHttpUrl(start.authorizeUrl) : null;
  return (
    <div className="stack">
      {!start ? (
        <>
          <p className="small">Connect the Spotify account you play music on while streaming.</p>
          <div>
            <Button variant="primary" loading={busy === 'start'} onClick={() => void begin()}>
              Connect Spotify
            </Button>
          </div>
        </>
      ) : (
        <form className="stack" onSubmit={finish}>
          <ol className="steps">
            <li>
              {authorizeUrl ? (
                <a className={buttonClass('primary', 'sm')} href={authorizeUrl} target="_blank" rel="noreferrer">
                  Open Spotify <ExternalIcon width={14} height={14} />
                </a>
              ) : (
                'Open the Spotify sign-in link'
              )}{' '}
              and approve access.
            </li>
            <li>
              Spotify then sends you to <code>{start.redirectUri}</code>, a page that doesn't load. That's expected.
            </li>
            <li>Copy the whole address from that tab's address bar and paste it here.</li>
          </ol>
          <Field label="Address of that page">
            <TextInput value={pasted} placeholder={`${start.redirectUri}?code=…`} autoComplete="off" spellCheck={false} mono onValueChange={setPasted} />
          </Field>
          <div className="row">
            <Button type="submit" variant="primary" loading={busy === 'finish'} disabled={!pasted.trim()}>
              Finish
            </Button>
            <Button variant="ghost" onClick={() => setStart(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Now playing
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function NowPlayingCard({ nowPlaying }: { nowPlaying: NowPlaying | null }) {
  const track = nowPlaying?.track ?? null;
  const art = track?.artUrl ? safeHttpUrl(track.artUrl) : null;
  return (
    <Card title="Now playing" subtitle="What overlays and apps get as music.nowplaying (API). Chat can ask with !song.">
      {!track ? (
        <p className="muted small">{nowPlaying ? 'Nothing is playing on Spotify.' : 'Reading Spotify…'}</p>
      ) : (
        <div className="row" style={{ alignItems: 'center', gap: 16 }}>
          {art && <img src={art} alt="" width={72} height={72} style={{ borderRadius: 4, flex: 'none' }} />}
          <div className="stack" style={{ gap: 2, minWidth: 0 }}>
            <strong>{track.title}</strong>
            <span className="small">{track.artists.join(', ')}</span>
            <span className="muted small">
              {nowPlaying?.playing ? 'Playing' : 'Paused'}
              {nowPlaying?.progressMs != null && track.durationMs > 0 && ` · ${formatMs(nowPlaying.progressMs)} / ${formatMs(track.durationMs)}`}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Song requests
// ---------------------------------------------------------------------------

function RequestsCard({ status, profileId, onStatus }: SectionProps) {
  const r = status.requests;
  const [draft, setDraft] = useState<SongRequestSettings>(r);
  const [cooldown, setCooldown] = useState(String(r.cooldownSec));
  const [maxMin, setMaxMin] = useState(String(Math.round(r.maxDurationSec / 60)));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(r);
    setCooldown(String(r.cooldownSec));
    setMaxMin(String(Math.round(r.maxDurationSec / 60)));
  }, [r.enabled, r.who, r.cooldownSec, r.maxDurationSec, r.allowExplicit, r.chatReplies]);

  const cooldownNum = parseWholeNumber(cooldown);
  const maxNum = parseWholeNumber(maxMin);
  const cooldownError = cooldownNum === null || Number.isNaN(cooldownNum) || cooldownNum > 3600 ? 'Use 0–3600 seconds.' : undefined;
  const maxError = maxNum === null || Number.isNaN(maxNum) || maxNum < 1 || maxNum > 60 ? 'Use 1–60 minutes.' : undefined;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (cooldownError || maxError) return;
    setBusy(true);
    try {
      onStatus(await api.updateSongRequests({ ...draft, cooldownSec: cooldownNum!, maxDurationSec: maxNum! * 60 }, profileId));
      toast.success('Song request settings saved.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Song requests" subtitle="Viewers type !sr and a song name (or a Spotify song link) in any platform's chat; Relay adds the best match to your Spotify queue.">
      <form className="stack" onSubmit={save}>
        <Toggle checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label="Take song requests (!sr)" />
        <Field label="Who can request">
          <Select options={WHO_OPTIONS} value={draft.who} onValueChange={(v) => setDraft({ ...draft, who: v as SongRequestWho })} />
        </Field>
        <div className="settings-grid" style={{ gap: 12 }}>
          <Field label="Cooldown per viewer (seconds)" error={cooldownError} help="Moderators have none.">
            <TextInput className="number-input" inputMode="numeric" value={cooldown} onValueChange={(v) => setCooldown(v.replace(/[^\d]/g, '').slice(0, 4))} />
          </Field>
          <Field label="Longest song (minutes)" error={maxError}>
            <TextInput className="number-input" inputMode="numeric" value={maxMin} onValueChange={(v) => setMaxMin(v.replace(/[^\d]/g, '').slice(0, 2))} />
          </Field>
        </div>
        <Toggle checked={draft.allowExplicit} onChange={(allowExplicit) => setDraft({ ...draft, allowExplicit })} label="Allow explicit songs" />
        <Toggle
          checked={draft.chatReplies}
          onChange={(chatReplies) => setDraft({ ...draft, chatReplies })}
          label='Show "🎵 … added …" lines in chat (Relay, the dock and the chat overlay)'
        />
        <p className="muted small">
          Relay can't post in the platforms' own chats, so viewers see the answer only where Relay's chat is shown. Spotify must be
          playing on a device for songs to be added.
        </p>
        <div>
          <Button type="submit" variant="primary" loading={busy} disabled={!!cooldownError || !!maxError}>
            Save
          </Button>
        </div>
      </form>
      {status.recentRequests.length > 0 && (
        <div className="stack" style={{ marginTop: 16 }}>
          <h3 className="small">Latest requests</h3>
          <ul className="stack small" style={{ gap: 4, listStyle: 'none', padding: 0, margin: 0 }}>
            {status.recentRequests.map((q) => (
              <li key={`${q.at}-${q.user}`}>
                <span className="muted">{formatDateTime(new Date(q.at).toISOString())}</span> <strong>{q.user}</strong>{' '}
                {q.ok && q.track ? (
                  <>
                    added {q.track.title} — {q.track.artists.join(', ')}
                  </>
                ) : (
                  <span className="muted">
                    “{q.query}”: {q.reason}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
