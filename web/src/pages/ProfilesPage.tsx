import { useEffect, useId, useState, type FormEvent } from 'react';
import type { Feed, Profile, ProfileSummary } from '@shared/types';
import { DEFAULT_PROFILE_ID, FEEDS } from '@shared/types';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ConfirmButton } from '../components/ConfirmButton';
import { EmptyState } from '../components/EmptyState';
import { FeedThumbnail } from '../components/FeedThumbnail';
import { Field } from '../components/Field';
import { LayersIcon, PlusIcon } from '../components/icons';
import { LivePlayerModal } from '../components/LivePlayer';
import { Modal } from '../components/Modal';
import { ProfileDot, ProfileStatusBadge } from '../components/ProfileBadge';
import { Spinner } from '../components/Spinner';
import { TextInput } from '../components/TextInput';
import { toast } from '../components/Toast';
import { cx } from '../components/utils';
import { Link } from '../router';
import { errorMessage } from '../state/errors';
import { useProfileContext } from '../state/profile';
import {
  deleteBlockedReason,
  normalizeHexColor,
  obsKeyHint,
  PROFILE_COLORS,
  PROFILE_NAME_MAX,
  profileColor,
  profileCountsText,
  slugPreview,
  suggestColor,
  validateProfileName,
} from '../state/profiles';
import './settings/admin.css';

type ModalState = { kind: 'create' } | { kind: 'created'; profile: Profile } | { kind: 'edit'; profile: ProfileSummary } | null;

/** Streaming profiles: list with live status, create, rename, recolour, delete. [admin] */
export default function ProfilesPage() {
  const { profiles, profileId: currentId, select, refresh } = useProfileContext();
  const [modal, setModal] = useState<ModalState>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Fresh on open (the live socket keeps it current afterwards).
  useEffect(() => {
    refresh().then(
      () => setLoadError(null),
      (err: unknown) => setLoadError(errorMessage(err)),
    );
  }, [refresh]);

  const remove = async (p: ProfileSummary) => {
    try {
      await api.deleteProfile(p.id);
      toast.success(`${p.name} deleted.`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      void refresh().catch(() => undefined);
    }
  };

  const closeModal = () => setModal(null);
  const newButton = (
    <Button variant="primary" icon={<PlusIcon width={16} height={16} />} onClick={() => setModal({ kind: 'create' })}>
      New profile
    </Button>
  );

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Profiles</h1>
          <p>
            Independent streaming set-ups, e.g. your personal channel and a club night. Each has its own accounts, destinations,
            title, OBS stream keys, test mode and chat, and several can be live at the same time.
          </p>
        </div>
        {newButton}
      </div>

      {profiles === null ? (
        <Card>
          {loadError ? (
            <EmptyState
              title="Couldn't load the profiles"
              description={loadError}
              action={<Button onClick={() => void refresh().then(() => setLoadError(null), (err: unknown) => setLoadError(errorMessage(err)))}>Try again</Button>}
            />
          ) : (
            <div className="row muted">
              <Spinner size="sm" /> Loading profiles…
            </div>
          )}
        </Card>
      ) : (
        <ProfilesList
          profiles={profiles}
          currentId={currentId}
          onSwitch={(p) => select(p.id, '/')}
          onEdit={(p) => setModal({ kind: 'edit', profile: p })}
          onDelete={remove}
        />
      )}

      <Card title="Shared by every profile" subtitle="Set up once, used by all profiles.">
        <ul className="steps shared-list">
          <li>
            <Link to="/settings?tab=apps">Developer apps</Link>: the Twitch, YouTube, Kick and Facebook apps you registered connect
            the accounts of every profile.
          </li>
          <li>
            <Link to="/settings?tab=users">Users</Link>, <Link to="/settings?tab=https">HTTPS</Link> and the{' '}
            <Link to="/settings?tab=audit">audit log</Link>.
          </li>
          <li>
            <Link to="/settings?tab=api">API tokens and connected apps</Link>: each token is limited to one profile or works for
            every profile; apps such as CTD Overlay assign what they offer to a profile.
          </li>
        </ul>
      </Card>

      <Modal
        open={modal !== null}
        onClose={closeModal}
        title={modal?.kind === 'edit' ? `Edit ${modal.profile.name}` : modal?.kind === 'created' ? 'Profile created' : 'New profile'}
        size="sm"
      >
        {modal?.kind === 'create' && (
          <ProfileForm
            existing={null}
            suggestedColor={suggestColor(profiles)}
            onCancel={closeModal}
            onSaved={(p) => {
              toast.success(`${p.name} created.`);
              setModal({ kind: 'created', profile: p });
              void refresh().catch(() => undefined);
            }}
          />
        )}
        {modal?.kind === 'edit' && (
          <ProfileForm
            existing={modal.profile}
            suggestedColor={suggestColor(profiles)}
            onCancel={closeModal}
            onSaved={(p) => {
              toast.success(`${p.name} saved.`);
              closeModal();
              void refresh().catch(() => undefined);
            }}
          />
        )}
        {modal?.kind === 'created' && (
          <CreatedPanel
            profile={modal.profile}
            onSwitch={(to) => {
              closeModal();
              select(modal.profile.id, to);
            }}
            onClose={closeModal}
          />
        )}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface ProfilesListProps {
  profiles: readonly ProfileSummary[];
  currentId: string;
  onSwitch: (p: ProfileSummary) => void;
  onEdit: (p: ProfileSummary) => void;
  onDelete: (p: ProfileSummary) => Promise<void>;
}

export function ProfilesList({ profiles, currentId, onSwitch, onEdit, onDelete }: ProfilesListProps) {
  if (profiles.length === 0) {
    return (
      <Card>
        <EmptyState icon={<LayersIcon />} title="No profiles" description="The server reported no profiles. Reload the page." />
      </Card>
    );
  }
  return (
    <Card flush>
      <ul className="item-list" aria-label="Streaming profiles">
        {profiles.map((p) => (
          <ProfileRow key={p.id} profile={p} current={p.id === currentId} onSwitch={onSwitch} onEdit={onEdit} onDelete={onDelete} />
        ))}
      </ul>
    </Card>
  );
}

function ProfileRow({
  profile: p,
  current,
  onSwitch,
  onEdit,
  onDelete,
}: {
  profile: ProfileSummary;
  current: boolean;
  onSwitch: ProfilesListProps['onSwitch'];
  onEdit: ProfilesListProps['onEdit'];
  onDelete: ProfilesListProps['onDelete'];
}) {
  const blocked = deleteBlockedReason(p);
  const q = `profile=${encodeURIComponent(p.id)}`;
  return (
    <li className={cx('item-row profile-row', current && 'is-current')}>
      <div className="item-main is-top">
        <ProfileDot profile={p} className="is-lg" />
        <div className="item-text">
          <div className="item-title">
            <span>{p.name}</span>
            {p.id === DEFAULT_PROFILE_ID && <Badge>Default</Badge>}
            {current && <Badge tone="accent">On screen</Badge>}
            <ProfileStatusBadge profile={p} />
          </div>
          <div className="item-sub">
            <span>{profileCountsText(p)}</span>
            <span>
              OBS keys <code className="small">{obsKeyHint(p)}</code>
            </span>
            {blocked && <span className="faint">{blocked}</span>}
          </div>
          <ProfileFeeds profile={p} />
          <nav className="profile-links" aria-label={`Set up ${p.name}`}>
            <Link to={`/accounts?${q}`}>Accounts</Link>
            <Link to={`/destinations?${q}`}>Destinations</Link>
            <Link to={`/settings?tab=obs&${q}`}>OBS setup</Link>
            <Link to={`/settings?tab=overlay&${q}`}>Chat overlay</Link>
          </nav>
        </div>
      </div>
      <div className="item-actions">
        {!current && (
          <Button size="sm" onClick={() => onSwitch(p)}>
            Switch to
          </Button>
        )}
        <Button size="sm" onClick={() => onEdit(p)}>
          Edit
        </Button>
        <ConfirmButton
          size="sm"
          variant="ghost"
          disabled={blocked !== null}
          title={blocked ?? `Deletes ${p.name}'s accounts, destinations, stream keys and chat overlay`}
          confirmLabel="Delete it and its accounts?"
          aria-label={`Delete ${p.name}`}
          onConfirm={() => onDelete(p)}
        >
          Delete
        </ConfirmButton>
      </div>
    </li>
  );
}

/** Both feeds of a profile: thumbnails (probed: the list has no feed states) and Watch. */
function ProfileFeeds({ profile }: { profile: ProfileSummary }) {
  const [watching, setWatching] = useState<Feed | null>(null);
  return (
    <div className="profile-feeds" aria-label={`${profile.name} feeds`}>
      {FEEDS.map((feed) => (
        <FeedThumbnail key={feed} profileId={profile.id} feed={feed} state={undefined} compact onWatch={() => setWatching(feed)} />
      ))}
      {watching && <LivePlayerModal open onClose={() => setWatching(null)} profileId={profile.id} feed={watching} context={profile.name} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

export function ProfileForm({
  existing,
  suggestedColor,
  onSaved,
  onCancel,
}: {
  existing: Pick<Profile, 'id' | 'name' | 'color' | 'slug'> | null;
  suggestedColor: string;
  onSaved: (p: Profile) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [color, setColor] = useState<string | null>(existing ? profileColor(existing) : suggestedColor);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const slug = existing ? existing.slug : slugPreview(name);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const nameError = validateProfileName(name);
    setError(nameError);
    setFormError(null);
    if (nameError) return;
    setBusy(true);
    try {
      const body = { name: name.trim(), color };
      onSaved(existing ? await api.updateProfile(existing.id, body) : await api.createProfile(body));
    } catch (err) {
      setFormError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      <Field label="Name" error={error ?? undefined} required help="E.g. DPRTMNT or Miami or Bust. Shown in the switcher, notices and the OBS dock.">
        <TextInput value={name} autoFocus autoComplete="off" maxLength={PROFILE_NAME_MAX} onValueChange={setName} />
      </Field>
      <ColorPicker value={color} onChange={setColor} />
      <p className="muted small">
        {existing ? (
          existing.id === DEFAULT_PROFILE_ID ? (
            <>Renaming keeps the original OBS stream keys, so OBS keeps working.</>
          ) : (
            <>
              Renaming keeps the OBS stream keys (<code>{existing.slug}/landscape?key=…</code>), so OBS keeps working.
            </>
          )
        ) : slug ? (
          <>
            Its OBS stream keys will start with <code>{slug}/</code> (the exact keys are in Settings → OBS setup).
          </>
        ) : (
          <>It gets its own OBS stream keys (Settings → OBS setup).</>
        )}
      </p>
      {formError && (
        <div className="alert alert-danger" role="alert">
          {formError}
        </div>
      )}
      <div className="form-actions is-end">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          {existing ? 'Save' : 'Create profile'}
        </Button>
      </div>
    </form>
  );
}

/** Palette swatches, "no colour" and a custom colour (native colour input). */
export function ColorPicker({ value, onChange }: { value: string | null; onChange: (color: string | null) => void }) {
  const name = useId();
  const upper = value?.toUpperCase() ?? null;
  const isCustom = upper !== null && !PROFILE_COLORS.some((c) => c.value === upper);
  return (
    <fieldset className="swatches">
      <legend className="field-label">Colour</legend>
      <div className="swatch-row">
        <label className="swatch" title="No colour">
          <input type="radio" name={name} checked={upper === null} onChange={() => onChange(null)} />
          <span className="swatch-chip is-none" aria-hidden="true" />
          <span className="sr-only">No colour</span>
        </label>
        {PROFILE_COLORS.map((c) => (
          <label key={c.value} className="swatch" title={c.label}>
            <input type="radio" name={name} checked={upper === c.value} onChange={() => onChange(c.value)} />
            <span className="swatch-chip" style={{ background: c.value }} aria-hidden="true" />
            <span className="sr-only">{c.label}</span>
          </label>
        ))}
        <label className={cx('swatch swatch-custom', isCustom && 'is-checked')} title="Custom colour">
          <input
            type="color"
            value={(upper ?? '#3B82F6').toLowerCase()}
            onChange={(e) => onChange(normalizeHexColor(e.currentTarget.value) ?? null)}
            aria-label="Custom colour"
          />
          <span
            className={cx('swatch-chip', !isCustom && 'is-rainbow')}
            style={isCustom && upper ? { background: upper } : undefined}
            aria-hidden="true"
          />
        </label>
      </div>
    </fieldset>
  );
}

/** Next steps after creating a profile. */
function CreatedPanel({ profile, onSwitch, onClose }: { profile: Profile; onSwitch: (to: string) => void; onClose: () => void }) {
  return (
    <div className="stack">
      <p>
        <ProfileDot profile={profile} className="is-inline" />
        <strong>{profile.name}</strong> is ready. Switch to it to set it up:
      </p>
      <ol className="steps">
        <li>
          <strong>Accounts</strong>: connect its Instagram, TikTok, Twitch… (your developer apps are shared).
        </li>
        <li>
          <strong>Destinations</strong>: where it streams, and which feed each one gets.
        </li>
        <li>
          <strong>OBS setup</strong>: its own server and stream keys for the OBS that streams this profile.
        </li>
      </ol>
      <div className="form-actions is-end">
        <Button variant="ghost" onClick={onClose}>
          Stay here
        </Button>
        <Button onClick={() => onSwitch('/settings?tab=obs')}>OBS setup</Button>
        <Button variant="primary" onClick={() => onSwitch('/accounts')}>
          Set up accounts
        </Button>
      </div>
    </div>
  );
}
