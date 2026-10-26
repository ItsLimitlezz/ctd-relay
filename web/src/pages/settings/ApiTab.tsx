import { useEffect, useId, useReducer, useState, type FormEvent } from 'react';
import type {
  ApiAccessInfo,
  ApprovePairingRequest,
  ConnectOfferResponse,
  CreateApiTokenResponse,
  ObsRelayTestResult,
  UpdateObsRelayRequest,
} from '@shared/api';
import type { ApiScope, ApiTokenInfo, ConnectedApp, PairingRequest, ProfileSummary } from '@shared/types';
import { API_SCOPES, DEFAULT_PROFILE_ID } from '@shared/types';
import { api } from '../../api';
import { Badge } from '../../components/Badge';
import { Button, buttonClass } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmButton } from '../../components/ConfirmButton';
import { CopyField } from '../../components/CopyField';
import { EmptyState } from '../../components/EmptyState';
import { Field } from '../../components/Field';
import { formatDateTime } from '../../components/format';
import { ExternalIcon, KeyIcon, PlugIcon, PlusIcon } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { ProfileDot } from '../../components/ProfileBadge';
import { Select } from '../../components/Select';
import { Spinner } from '../../components/Spinner';
import { TextInput } from '../../components/TextInput';
import { toast } from '../../components/Toast';
import { cx, safeHttpUrl } from '../../components/utils';
import { setQuery, useQuery } from '../../router';
import { errorMessage } from '../../state/errors';
import { useApi, useNow } from '../../state/hooks';
import {
  APP_TOKEN_NAME_MAX,
  appStatusText,
  dockTokenName,
  EVERY_PROFILE,
  groupResources,
  knownScopes,
  pairingDefaults,
  pairingExpiresText,
  pendingPairings,
  profileFromSelect,
  profileSelectOptions,
  profileToSelect,
  resourceNames,
  resourceSummary,
  SECRET_SCOPES,
  sortApps,
  withSelectedOption,
} from '../../state/hub';
import { useConnectedApps, useLiveActions, usePairings } from '../../state/live';
import { useProfileContext } from '../../state/profile';
import { findProfile, profileLabel } from '../../state/profiles';
import {
  API_SCOPE_INFO,
  DEFAULT_TOKEN_SCOPES,
  DOCK_SCOPES,
  DOCK_TOKEN_NAME,
  dockUrl,
  hasErrors,
  orderedScopes,
  parseWholeNumber,
  relativeTime,
  TOKEN_NAME_MAX,
  tokenModalDismissible,
  tokenModalInitial,
  tokenModalReducer,
  validateTokenForm,
} from './settings-helpers';

export const API_DOCS_URL = 'https://github.com/ItsLimitlezz/ctd-relay/blob/main/docs/API.md';

type Profiles = readonly ProfileSummary[] | null;

/**
 * Settings → API: apps asking to connect (pairing), tokens for other apps (each limited to a profile
 * or for every profile), the connected apps and what they offer per profile, OBS dock links per
 * profile and how to connect. [admin]
 */
export function ApiTab() {
  const res = useApi(() => api.apiTokens(), []);
  const now = useNow(15_000);
  const { profiles, profileId: currentId } = useProfileContext();
  const pairings = usePairings();
  const apps = useConnectedApps();
  const { loadPairings, loadApps } = useLiveActions();
  const [pairingsError, setPairingsError] = useState<string | null>(null);
  const [appsError, setAppsError] = useState<string | null>(null);
  const [modal, dispatchModal] = useReducer(tokenModalReducer<CreateApiTokenResponse>, undefined, tokenModalInitial<CreateApiTokenResponse>);
  const [dock, setDock] = useState<CreateApiTokenResponse | null>(null);
  const [dockBusy, setDockBusy] = useState(false);
  const [dockProfile, setDockProfile] = useState<string>(currentId);
  const focusPair = useQuery().get('pair');

  const reloadPairings = () =>
    loadPairings().then(
      () => setPairingsError(null),
      (err: unknown) => setPairingsError(errorMessage(err)),
    );
  const reloadApps = () =>
    loadApps().then(
      () => setAppsError(null),
      (err: unknown) => setAppsError(errorMessage(err)),
    );

  // Fresh lists on open; the live socket keeps them current afterwards.
  useEffect(() => {
    void reloadPairings();
    void reloadApps();
  }, [loadPairings, loadApps]);

  const addToken = (t: ApiTokenInfo) =>
    res.setData((d) => (d ? { ...d, tokens: [...d.tokens.filter((x) => x.id !== t.id), t] } : d));

  const revoke = async (t: ApiTokenInfo) => {
    try {
      await api.deleteApiToken(t.id);
      res.setData((d) => (d ? { ...d, tokens: d.tokens.filter((x) => x.id !== t.id) } : d));
      if (dock?.token.id === t.id) setDock(null);
      toast.success(`"${t.name}" revoked. Apps using it can't connect anymore.`);
      void reloadApps(); // its apps were removed with it
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const createDock = async () => {
    setDockBusy(true);
    try {
      const profileId = profileFromSelect(dockProfile);
      const name = dockTokenName(DOCK_TOKEN_NAME, profileId && profiles && profiles.length > 1 ? profileLabel(profileId, profiles) : null);
      const result = await api.createApiToken({ name, scopes: [...DOCK_SCOPES], profileId });
      addToken(result.token);
      setDock(result);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDockBusy(false);
    }
  };

  const approve = async (p: PairingRequest, body: ApprovePairingRequest) => {
    const result = await api.approvePairing(p.id, body); // errors are shown by the form
    addToken(result.token);
    toast.success(`${p.appName || 'The app'} is connected. It receives its token by itself.`);
    if (focusPair === p.id) setQuery({ pair: null });
    void reloadPairings();
  };

  const deny = async (p: PairingRequest) => {
    try {
      await api.denyPairing(p.id);
      toast.info(`Denied ${p.appName || 'the app'}'s request to connect.`);
      if (focusPair === p.id) setQuery({ pair: null });
      void reloadPairings();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const removeApp = async (a: ConnectedApp) => {
    try {
      await api.removeApp(a.id);
      toast.success(`${a.name} removed. It reappears if it registers again; revoke its token to disconnect it for good.`);
      void reloadApps();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  // Ignored while a create request is in flight (the reducer keeps it open).
  const closeModal = () => dispatchModal({ type: 'close' });
  const pending = pendingPairings(pairings, now);

  return (
    <>
      <PairingsCard
        pending={pending}
        loaded={pairings !== null}
        profiles={profiles}
        now={now}
        focusId={focusPair}
        error={pairingsError}
        onRetry={() => void reloadPairings()}
        onApprove={approve}
        onDeny={deny}
      />
      <PhoneConnectCard profiles={profiles} defaultProfileId={currentId} onConnected={res.reload} />
      <ObsRelayCard />
      {!res.data ? (
        <Card>
          {res.error ? (
            <EmptyState
              title="Couldn't load the API settings"
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
      ) : (
        <>
          <TokensCard tokens={res.data.tokens} profiles={profiles} now={now} onNew={() => dispatchModal({ type: 'open' })} onRevoke={revoke} />
          <ConnectedAppsCard apps={apps} profiles={profiles} now={now} error={appsError} onRetry={() => void reloadApps()} onRemove={removeApp} />
          <DockCard
            access={res.data.access}
            profiles={profiles}
            profileValue={dockProfile}
            onProfileChange={(v) => {
              setDockProfile(v);
              setDock(null);
            }}
            created={dock}
            busy={dockBusy}
            onCreate={() => void createDock()}
          />
          <AccessCard access={res.data.access} />
          {/* While creating it can't close; while the secret is on screen, only the explicit Done / close button dismisses it. */}
          <Modal
            open={modal.open}
            onClose={closeModal}
            title={modal.created ? 'Token created' : 'New API token'}
            size="sm"
            dismissible={tokenModalDismissible(modal)}
          >
            {modal.created ? (
              <TokenSecret created={modal.created} access={res.data.access} onDone={closeModal} />
            ) : (
              <NewTokenForm
                profiles={profiles}
                defaultProfileId={currentId}
                onCancel={closeModal}
                onBusyChange={(busy) => dispatchModal({ type: 'busy', busy })}
                onCreated={(result) => {
                  addToken(result.token);
                  dispatchModal({ type: 'created', result });
                }}
              />
            )}
          </Modal>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Permissions checklist (new token + pairing approval)
// ---------------------------------------------------------------------------

function ScopeChecklist({
  scopes,
  onChange,
  requested,
  error,
}: {
  scopes: readonly ApiScope[];
  onChange: (scopes: ApiScope[]) => void;
  /** Scopes the app asked for (marked "requested"). */
  requested?: readonly ApiScope[];
  error?: string;
}) {
  const errorId = useId();
  const toggle = (s: ApiScope, on: boolean) => onChange(orderedScopes(on ? [...scopes, s] : scopes.filter((x) => x !== s)));
  return (
    <fieldset className="check-group" aria-describedby={error ? errorId : undefined}>
      <legend className="field-label">Permissions</legend>
      {API_SCOPES.map((s) => (
        <label key={s} className="check-row">
          <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => toggle(s, e.currentTarget.checked)} />
          <span>
            <strong>{API_SCOPE_INFO[s].label}</strong> <code className="small">{s}</code>
            {requested?.includes(s) && (
              <>
                {' '}
                <Badge tone="info">requested</Badge>
              </>
            )}
            <span className="check-help">{API_SCOPE_INFO[s].help}</span>
          </span>
        </label>
      ))}
      {error && (
        <p id={errorId} className="field-error">
          {error}
        </p>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Pairing ("an app wants to connect")
// ---------------------------------------------------------------------------

export interface PairingsCardProps {
  /** Pending, unexpired requests (newest first). */
  pending: readonly PairingRequest[];
  /** The list was loaded at least once. */
  loaded: boolean;
  profiles: Profiles;
  now: number;
  /** `?pair=<id>` from the app's approve link: that request opens for review. */
  focusId?: string | null;
  error?: string | null;
  onRetry?: () => void;
  onApprove: (p: PairingRequest, body: ApprovePairingRequest) => Promise<void>;
  onDeny: (p: PairingRequest) => Promise<void>;
}

export function PairingsCard({ pending, loaded, profiles, now, focusId = null, error = null, onRetry, onApprove, onDeny }: PairingsCardProps) {
  const focusMissing = !!focusId && loaded && !pending.some((p) => p.id === focusId);
  if (pending.length === 0 && !focusMissing && !error) return null;
  return (
    <Card
      className={cx(pending.length > 0 && 'pairings-card')}
      title={pending.length === 1 ? 'An app wants to connect' : pending.length > 1 ? `${pending.length} apps want to connect` : 'App connections'}
      subtitle="Check that the code matches the one the app shows, pick the profile and permissions, then approve. The app receives its own token; nothing to copy."
    >
      <div className="stack">
        {error && (
          <div className="alert alert-warn row-between" role="alert">
            <span>Couldn't load connection requests: {error}</span>
            {onRetry && (
              <Button size="sm" onClick={onRetry}>
                Retry
              </Button>
            )}
          </div>
        )}
        {focusMissing && (
          <div className="alert">That connection request has expired or was already handled. Ask the app to connect again.</div>
        )}
        {pending.length > 0 && (
          <ul className="pairing-list" aria-label="Pending app connections">
            {pending.map((p) => (
              <PairingRow
                key={p.id}
                pairing={p}
                profiles={profiles}
                now={now}
                initiallyOpen={p.id === focusId || pending.length === 1}
                onApprove={onApprove}
                onDeny={onDeny}
              />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function PairingRow({
  pairing: p,
  profiles,
  now,
  initiallyOpen,
  onApprove,
  onDeny,
}: {
  pairing: PairingRequest;
  profiles: Profiles;
  now: number;
  initiallyOpen: boolean;
  onApprove: PairingsCardProps['onApprove'];
  onDeny: PairingsCardProps['onDeny'];
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [denying, setDenying] = useState(false);
  const requested = knownScopes(p.requestedScopes);

  // Arriving from the app's approve link: bring the request into view.
  useEffect(() => {
    if (initiallyOpen) document.getElementById(`pair-${p.id}`)?.scrollIntoView({ block: 'nearest' });
  }, []);

  const deny = async () => {
    setDenying(true);
    try {
      await onDeny(p);
    } finally {
      setDenying(false);
    }
  };

  return (
    <li className="pairing-row" id={`pair-${p.id}`}>
      <div className="pairing-head">
        <span className="user-avatar" aria-hidden="true">
          <PlugIcon width={16} height={16} />
        </span>
        <div className="item-text">
          <div className="item-title">
            <span>{p.appName || 'Unnamed app'}</span>
            {p.kind && <Badge>{p.kind}</Badge>}
          </div>
          <div className="item-sub">
            <span>Asks for {p.requestedProfileId === null ? 'every profile' : profileLabel(p.requestedProfileId, profiles)}</span>
            {p.ip && <span>From {p.ip}</span>}
            <span>{pairingExpiresText(p, now)}</span>
          </div>
        </div>
        <span className="pairing-code" title="The app shows this code" aria-label={`Code ${p.code}`}>
          {p.code}
        </span>
      </div>
      {open ? (
        <ApprovePairingForm pairing={p} profiles={profiles} onApprove={onApprove} onDeny={deny} denying={denying} onCancel={() => setOpen(false)} />
      ) : (
        <div className="pairing-actions">
          <div className="pairing-scopes">
            {requested.map((s) => (
              <Badge key={s} tone={SECRET_SCOPES.includes(s) ? 'warn' : 'info'} title={API_SCOPE_INFO[s].help}>
                {s}
              </Badge>
            ))}
          </div>
          <span className="spacer" />
          <Button size="sm" variant="ghost" loading={denying} onClick={() => void deny()}>
            Deny
          </Button>
          <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
            Review
          </Button>
        </div>
      )}
    </li>
  );
}

export function ApprovePairingForm({
  pairing: p,
  profiles,
  onApprove,
  onDeny,
  denying = false,
  onCancel,
}: {
  pairing: PairingRequest;
  profiles: Profiles;
  onApprove: PairingsCardProps['onApprove'];
  onDeny: () => Promise<void>;
  denying?: boolean;
  onCancel: () => void;
}) {
  const [initial] = useState(() => pairingDefaults(p, profiles));
  const [name, setName] = useState(initial.name);
  const [profileValue, setProfileValue] = useState(profileToSelect(initial.profileId));
  const [scopes, setScopes] = useState<ApiScope[]>(initial.scopes);
  const [errors, setErrors] = useState<{ name?: string; scopes?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const profileId = profileFromSelect(profileValue);
  const requested = knownScopes(p.requestedScopes);
  const secrets = scopes.filter((s) => SECRET_SCOPES.includes(s));
  const target = profileId === null ? 'every profile' : profileLabel(profileId, profiles);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const v = validateTokenForm(name, scopes);
    setErrors(v);
    setFormError(null);
    if (hasErrors(v)) return;
    setBusy(true);
    try {
      await onApprove(p, { name: name.trim(), scopes: orderedScopes(scopes), profileId });
    } catch (err) {
      setFormError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className="stack pairing-form" onSubmit={(e) => void submit(e)} noValidate>
      <p className="small">
        Approve only if <strong>{p.appName || 'the app'}</strong> shows the code <span className="pairing-code is-inline">{p.code}</span>.
      </p>
      <Field label="Token name" error={errors.name} required help="Shown in the token list and the audit log.">
        <TextInput value={name} autoComplete="off" spellCheck={false} maxLength={APP_TOKEN_NAME_MAX} onValueChange={setName} />
      </Field>
      <Field
        label="Profile"
        help={
          profileId === null
            ? 'Every profile: the app can read and pick any profile itself (e.g. the CTD OBS plugin’s profile picker).'
            : 'Recommended for overlays and docks: the app only ever sees this profile.'
        }
      >
        <Select options={withSelectedOption(profileSelectOptions(profiles), profileValue, profiles)} value={profileValue} onValueChange={setProfileValue} />
      </Field>
      <ScopeChecklist scopes={scopes} onChange={setScopes} requested={requested} error={errors.scopes} />
      {secrets.length > 0 && (
        <div className="alert alert-warn">
          This app will be able to read the OBS stream keys of {target}. Allow it only for an app that sets up OBS (the CTD OBS
          plugin).
        </div>
      )}
      {formError && (
        <div className="alert alert-danger" role="alert">
          {formError}
        </div>
      )}
      <div className="form-actions is-end">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Later
        </Button>
        <Button variant="ghost" onClick={() => void onDeny()} loading={denying} disabled={busy}>
          Deny
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          Approve
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export function TokensCard({
  tokens,
  profiles = null,
  now,
  onNew,
  onRevoke,
}: {
  tokens: readonly ApiTokenInfo[];
  profiles?: Profiles;
  now: number;
  onNew: () => void;
  onRevoke: (t: ApiTokenInfo) => Promise<void>;
}) {
  return (
    <Card
      title="API tokens"
      subtitle="Let other apps use your chat, stream status and profiles: CTD Overlay, the CTD OBS plugin, the OBS dock, bots and scripts. A token can never start, stop or change a stream."
      actions={
        <Button size="sm" variant="primary" icon={<PlusIcon width={14} height={14} />} onClick={onNew}>
          New token
        </Button>
      }
      flush
    >
      <div style={{ marginTop: 10 }}>
        {tokens.length === 0 ? (
          <EmptyState icon={<KeyIcon />} title="No tokens yet" description="Create one per app, so you can revoke each on its own." />
        ) : (
          <ul className="item-list" aria-label="API tokens">
            {tokens.map((t) => (
              <TokenRow key={t.id} token={t} profiles={profiles} now={now} onRevoke={onRevoke} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function lastUsed(iso: string | null, now: number): string {
  if (!iso) return 'Never used';
  const rel = relativeTime(iso, now, '');
  return rel ? `Last used ${rel === 'now' ? 'just now' : rel}` : 'Never used';
}

/** "Profile: DPRTMNT" (limited) or "Every profile". Tokens from before profiles have no profileId. */
function TokenProfile({ profileId, profiles }: { profileId: string | null | undefined; profiles: Profiles }) {
  const id = profileId ?? null;
  if (id === null) return <span title="Not limited to a profile (reads the default profile unless the app asks for another)">Every profile</span>;
  return (
    <span className="token-profile" title="This token only sees this profile">
      <ProfileDot profile={findProfile(profiles, id)} />
      Profile: {profileLabel(id, profiles)}
    </span>
  );
}

function TokenRow({
  token: t,
  profiles,
  now,
  onRevoke,
}: {
  token: ApiTokenInfo;
  profiles: Profiles;
  now: number;
  onRevoke: (t: ApiTokenInfo) => Promise<void>;
}) {
  return (
    <li className="item-row">
      <div className="item-main">
        <span className="user-avatar" aria-hidden="true">
          <KeyIcon width={16} height={16} />
        </span>
        <div className="item-text">
          <div className="item-title">
            <span>{t.name}</span>
            {orderedScopes(t.scopes).map((s) => (
              <Badge key={s} tone={SECRET_SCOPES.includes(s) ? 'warn' : 'info'} title={API_SCOPE_INFO[s].help}>
                {s}
              </Badge>
            ))}
          </div>
          <div className="item-sub">
            <TokenProfile profileId={t.profileId} profiles={profiles} />
            <code className="token-prefix" title="The start of the token, to recognise it">
              {t.prefix}…
            </code>
            <span>
              Created {formatDateTime(t.createdAt)}
              {t.createdBy ? ` by ${t.createdBy}` : ''}
            </span>
            <span>{lastUsed(t.lastUsedAt, now)}</span>
          </div>
        </div>
      </div>
      <div className="item-actions">
        <ConfirmButton size="sm" variant="ghost" confirmLabel="Revoke? Apps lose access" onConfirm={() => onRevoke(t)}>
          Revoke
        </ConfirmButton>
      </div>
    </li>
  );
}

export function NewTokenForm({
  profiles = null,
  defaultProfileId = DEFAULT_PROFILE_ID,
  onCreated,
  onCancel,
  onBusyChange,
}: {
  profiles?: Profiles;
  /** Preselected profile (the one on screen). */
  defaultProfileId?: string;
  onCreated: (result: CreateApiTokenResponse) => void;
  onCancel: () => void;
  /** A create request started (true) or failed (false). On success onCreated replaces the form. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(() => [...DEFAULT_TOKEN_SCOPES]);
  const [profileValue, setProfileValue] = useState(() =>
    !profiles || findProfile(profiles, defaultProfileId) ? defaultProfileId : EVERY_PROFILE,
  );
  const [errors, setErrors] = useState<{ name?: string; scopes?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const profileId = profileFromSelect(profileValue);
  const options = withSelectedOption(
    profiles ? profileSelectOptions(profiles) : [{ value: defaultProfileId, label: profileLabel(defaultProfileId, null) }, { value: EVERY_PROFILE, label: 'Every profile' }],
    profileValue,
    profiles,
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const v = validateTokenForm(name, scopes);
    setErrors(v);
    setFormError(null);
    if (hasErrors(v)) return;
    setBusy(true);
    onBusyChange?.(true);
    let result: CreateApiTokenResponse;
    try {
      result = await api.createApiToken({ name: name.trim(), scopes: orderedScopes(scopes), profileId });
    } catch (err) {
      setFormError(errorMessage(err));
      setBusy(false);
      onBusyChange?.(false);
      return;
    }
    onCreated(result);
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      <Field label="Name" error={errors.name} required help="The app that will use it, e.g. CTD Overlay. Shown in the token list and the audit log.">
        <TextInput value={name} autoFocus autoComplete="off" spellCheck={false} maxLength={TOKEN_NAME_MAX} onValueChange={setName} />
      </Field>
      <Field
        label="Profile"
        help="Recommended: limit overlays and docks to one profile. With every profile, the app chooses the profile itself (older tokens work like this)."
      >
        <Select options={options} value={profileValue} onValueChange={setProfileValue} />
      </Field>
      <ScopeChecklist scopes={scopes} onChange={setScopes} error={errors.scopes} />
      {scopes.some((s) => SECRET_SCOPES.includes(s)) && (
        <div className="alert alert-warn">
          {API_SCOPE_INFO['ingest:read'].label} hands out stream keys: give it only to an app that sets up OBS.
        </div>
      )}
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
          Create token
        </Button>
      </div>
    </form>
  );
}

/** The new secret, shown once. Masked by default so it never ends up on stream; Copy works either way. */
export function TokenSecret({ created, access, onDone }: { created: CreateApiTokenResponse; access: ApiAccessInfo; onDone: () => void }) {
  return (
    <div className="stack">
      <div className="alert alert-warn" role="alert">
        <strong>Copy it now — you won't see it again.</strong> Only a hash is kept. If you lose it, revoke it and create a new one.
      </div>
      <CopyField
        label={`Token "${created.token.name}"`}
        value={created.secret}
        secret
        help="Hidden so it can't show up on stream. Copy works without showing it."
      />
      <p className="muted small">
        Apps send it as <code>Authorization: Bearer &lt;token&gt;</code> to <code className="break-all">{access.lanBaseUrl ?? access.baseUrl}</code>.
      </p>
      <div className="form-actions is-end">
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connected apps (the hub)
// ---------------------------------------------------------------------------

export function ConnectedAppsCard({
  apps,
  profiles,
  now,
  error = null,
  onRetry,
  onRemove,
}: {
  /** null while loading. */
  apps: readonly ConnectedApp[] | null;
  profiles: Profiles;
  now: number;
  error?: string | null;
  onRetry?: () => void;
  onRemove: (a: ConnectedApp) => Promise<void>;
}) {
  let body;
  if (apps === null) {
    body = error ? (
      <EmptyState
        title="Couldn't load the connected apps"
        description={error}
        action={onRetry ? <Button onClick={onRetry}>Try again</Button> : undefined}
      />
    ) : (
      <div className="row muted" style={{ padding: 18 }}>
        <Spinner size="sm" /> Loading…
      </div>
    );
  } else if (apps.length === 0) {
    body = (
      <EmptyState
        icon={<PlugIcon />}
        title="No apps connected yet"
        description="CTD Overlay, the CTD OBS plugin and other apps show up here once they connect, with what they offer to each profile."
      />
    );
  } else {
    body = (
      <ul className="item-list" aria-label="Connected apps">
        {sortApps(apps).map((a) => (
          <AppRow key={a.id} app={a} profiles={profiles} now={now} onRemove={onRemove} />
        ))}
      </ul>
    );
  }
  return (
    <Card
      title="Connected apps"
      subtitle="Apps register here with what they offer, e.g. the overlays CTD Overlay assigned to each profile, so other apps (the CTD OBS plugin) find them through CTD Relay and can message each other."
      flush
    >
      <div style={{ marginTop: 10 }}>{body}</div>
    </Card>
  );
}

function AppRow({ app: a, profiles, now, onRemove }: { app: ConnectedApp; profiles: Profiles; now: number; onRemove: (a: ConnectedApp) => Promise<void> }) {
  const groups = groupResources(a.resources, profiles);
  const link = safeHttpUrl(a.baseUrl);
  return (
    <li className="item-row">
      <div className="item-main is-top">
        <span className="user-avatar" aria-hidden="true">
          <PlugIcon width={16} height={16} />
        </span>
        <div className="item-text">
          <div className="item-title">
            <span>{a.name}</span>
            <Badge tone={a.online ? 'success' : 'neutral'} dot>
              {a.online ? 'Online' : 'Offline'}
            </Badge>
            {a.kind && <Badge>{a.kind}</Badge>}
            {a.version && <span className="faint small">v{a.version}</span>}
          </div>
          <div className="item-sub">
            <TokenProfile profileId={a.profileId} profiles={profiles} />
            {!a.online && <span>{appStatusText(a, now)}</span>}
            <code className="small">{a.id}</code>
            {link && (
              <a href={link} target="_blank" rel="noopener noreferrer">
                Open app
              </a>
            )}
          </div>
          {groups.length > 0 && (
            <ul className="app-resources" aria-label={`What ${a.name} offers`}>
              {groups.map((g) => (
                <li key={g.profileId ?? EVERY_PROFILE}>
                  <ProfileDot profile={findProfile(profiles, g.profileId)} />
                  <strong>{g.profileId === null ? 'Every profile' : profileLabel(g.profileId, profiles)}:</strong>{' '}
                  <span>{resourceSummary(g.resources)}</span> <span className="muted">({resourceNames(g.resources)})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="item-actions">
        <ConfirmButton
          size="sm"
          variant="ghost"
          confirmLabel="Remove? It can register again"
          title="Unregister the app. To disconnect it for good, revoke its token."
          onConfirm={() => onRemove(a)}
        >
          Remove
        </ConfirmButton>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// OBS dock
// ---------------------------------------------------------------------------

/** Shown when the server can't tell its LAN address (it runs in a container). */
export function LanHint() {
  return (
    <div className="alert">
      The server can't tell its LAN address (it runs in a container), so links here use the HTTPS address. For a LAN link, open
      this page through the NAS's LAN address (for example <code>https://192.168.x.x:30443</code>) or set{' '}
      <code>LAN_HTTP_HOST</code> to the NAS IP, then reload this page.
    </div>
  );
}

export function DockCard({
  access,
  profiles = null,
  profileValue = DEFAULT_PROFILE_ID,
  onProfileChange,
  created,
  busy,
  onCreate,
}: {
  access: ApiAccessInfo;
  profiles?: Profiles;
  /** The profile the next dock link is for. */
  profileValue?: string;
  onProfileChange?: (value: string) => void;
  created: CreateApiTokenResponse | null;
  busy: boolean;
  onCreate: () => void;
}) {
  const link = created ? dockUrl(access, created.secret) : null;
  const several = (profiles?.length ?? 0) > 1;
  const profileName = profileLabel(profileFromSelect(profileValue), profiles);
  const options = withSelectedOption(
    profileSelectOptions(profiles).filter((o) => o.value !== EVERY_PROFILE),
    profileValue,
    profiles,
  );
  return (
    <Card title="OBS dock" subtitle="Live status, bitrates, every destination, viewers and the merged chat of one profile, in a panel inside OBS.">
      <div className="stack">
        {access.lanBaseUrl === null && <LanHint />}
        {several && onProfileChange && (
          <Field label="Profile" help="Each dock link shows one profile. Make one per profile you stream (e.g. one per OBS).">
            <Select options={options} value={profileValue} onValueChange={onProfileChange} disabled={busy} />
          </Field>
        )}
        {created && (
          <>
            <div className="alert alert-warn" role="alert">
              <strong>Copy the dock URL now — you won't see it again.</strong> It contains a new read-only token ("{created.token.name}"):
              anyone with the URL can read {several ? `${profileName}'s` : 'your'} chat and stream status.
            </div>
            {link ? (
              <CopyField
                label="Dock URL"
                value={link.url}
                secret
                help={
                  link.lan
                    ? "Uses this server's LAN address: for OBS on the same network. Hidden so it can't show up on stream."
                    : "Uses the HTTPS address. With a self-signed certificate OBS may refuse it; prefer a LAN link (see above). Hidden so it can't show up on stream."
                }
              />
            ) : (
              <CopyField
                label="Dock token"
                value={created.secret}
                secret
                help="Couldn't build the URL from the server address: open this server's /dock page and add #token= followed by this token."
              />
            )}
          </>
        )}
        <ol className="steps">
          <li>
            {created ? (
              'Copy the dock URL above.'
            ) : (
              <>
                Click <strong>Create dock link</strong>. It makes a read-only token named "
                {dockTokenName(DOCK_TOKEN_NAME, several ? profileName : null)}" (status + chat{several ? `, ${profileName} only` : ''}).
              </>
            )}
          </li>
          <li>
            In OBS: <strong>Docks → Custom Browser Docks…</strong> (older OBS: <strong>View → Docks → Custom Browser Docks</strong>).
          </li>
          <li>
            Dock Name: <strong>CTD Relay</strong>. URL: paste the dock URL. Click <strong>Apply</strong>.
          </li>
          <li>The dock opens as a panel; drag it next to your other docks.</li>
        </ol>
        <div>
          <Button variant={created ? 'secondary' : 'primary'} loading={busy} onClick={onCreate}>
            {created ? 'Create another dock link' : 'Create dock link'}
          </Button>
        </div>
        {created && (
          <p className="muted small">Each link has its own token. When you replace a link, revoke the old "{created.token.name}" token above.</p>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Connect a phone (QR code for CTD Live mobile)
// ---------------------------------------------------------------------------

/** "4:59" until `iso`, or null once it's past. */
export function countdown(iso: string, now: number): string | null {
  const left = Math.ceil((Date.parse(iso) - now) / 1000);
  if (!Number.isFinite(left) || left <= 0) return null;
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

export function PhoneConnectCard({
  profiles = null,
  defaultProfileId = DEFAULT_PROFILE_ID,
  onConnected,
}: {
  profiles?: Profiles;
  defaultProfileId?: string;
  /** A phone claimed the code (a token was created): reload the token list. */
  onConnected?: () => void;
}) {
  const [profileValue, setProfileValue] = useState<string>(() => profileToSelect(defaultProfileId));
  const [offer, setOffer] = useState<ConnectOfferResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow(offer?.state === 'waiting' ? 1000 : null);
  const several = (profiles?.length ?? 0) > 1;
  const left = offer ? countdown(offer.expiresAt, now) : null;
  const state = offer?.state === 'waiting' && left === null ? 'expired' : offer?.state;

  // While the code is on screen, check every 2 s whether a phone used it.
  useEffect(() => {
    if (!offer || offer.state !== 'waiting') return;
    let stop = false;
    const timer = setInterval(() => {
      api.connectOfferStatus(offer.id).then(
        (s) => {
          if (stop || s.state === 'waiting') return;
          setOffer((o) => (o && o.id === s.id ? { ...o, state: s.state, deviceName: s.deviceName } : o));
          if (s.state === 'connected') {
            toast.success(`${s.deviceName ?? 'The phone'} is connected.`);
            onConnected?.();
          }
        },
        () => {},
      );
    }, 2000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [offer?.id, offer?.state]);

  // An unused code is withdrawn when it's hidden or the page is left.
  useEffect(() => {
    const id = offer?.state === 'waiting' ? offer.id : null;
    return () => {
      if (id) void api.cancelConnectOffer(id).catch(() => {});
    };
  }, [offer?.id, offer?.state]);

  const show = async () => {
    setBusy(true);
    try {
      setOffer(await api.createConnectOffer({ profileId: profileFromSelect(profileValue) }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Connect a phone" subtitle="CTD Live mobile: scan once and it connects, on your Wi-Fi or on mobile data.">
      <div className="stack">
        {several && !offer && (
          <Field label="Profile" help="What the phone sees: one profile, or every profile.">
            <Select options={withSelectedOption(profileSelectOptions(profiles), profileValue, profiles)} value={profileValue} onValueChange={setProfileValue} disabled={busy} />
          </Field>
        )}
        {offer && state === 'waiting' && (
          <div className="stack" style={{ alignItems: 'center' }}>
            <img
              className="qr-code"
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(offer.qrSvg)}`}
              alt="QR code to connect CTD Live mobile"
              width={240}
              height={240}
            />
            <p className="small" role="status">
              In <strong>CTD Live mobile</strong>, tap <strong>Scan</strong> and point the camera here. Works once, for {left}.
            </p>
            {offer.apiUrlIsPrivate && (
              <div className="alert alert-warn">
                This server only knows its LAN address ({offer.apiUrl}), so the phone can connect on your Wi-Fi but not on mobile
                data. Check that your router forwards port 443 and that Settings → Network shows your public address.
              </div>
            )}
            <p className="muted small">
              The phone connects to <code>{offer.apiUrl}</code>
              {offer.lanApiUrl ? (
                <>
                  {' '}
                  (on your Wi-Fi: <code>{offer.lanApiUrl}</code>)
                </>
              ) : null}
              . Don't show this code on stream: until it's used it lets a phone in.
            </p>
          </div>
        )}
        {offer && state === 'connected' && (
          <div className="alert alert-success" role="status">
            <strong>{offer.deviceName ?? 'The phone'}</strong> is connected. It's in the token list above, where you can revoke it any time.
          </div>
        )}
        {offer && state === 'expired' && <div className="alert">That code expired or was replaced. Show a new one.</div>}
        <p className="muted small">
          The phone can control OBS through CTD Relay (scenes, previews, starting and stopping the stream; set up OBS below) and
          read{several ? ' the profile you pick' : ''}: live status, viewers, chat and the feed previews. Never your stream keys or
          settings.
        </p>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {offer && state === 'waiting' ? (
            <Button variant="secondary" onClick={() => setOffer(null)}>
              Hide code
            </Button>
          ) : (
            <Button variant="primary" loading={busy} onClick={() => void show()}>
              {offer ? 'Connect another phone' : 'Show QR code'}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// OBS on your computer (the phone's OBS socket relay)
// ---------------------------------------------------------------------------

/** "Connected to OBS 31.1.2 (WebSocket 5.6.2) at 192.168.1.50:4455." */
export function obsTestText(r: Extract<ObsRelayTestResult, { ok: true }>): string {
  const what = [r.obsVersion ? `OBS ${r.obsVersion}` : 'OBS', r.obsWebSocketVersion ? `(WebSocket ${r.obsWebSocketVersion})` : null].filter(Boolean).join(' ');
  return `Connected to ${what} at ${r.host}:${r.port}.`;
}

/** Where CTD Relay finds OBS's WebSocket server, so phones can control OBS from anywhere. [admin] */
export function ObsRelayCard() {
  const res = useApi(() => api.obsRelay(), []);
  const s = res.data;
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [password, setPassword] = useState('');
  const [portError, setPortError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'clear' | null>(null);
  const [test, setTest] = useState<ObsRelayTestResult | null>(null);

  useEffect(() => {
    if (!s) return;
    setHost(s.host ?? '');
    setPort(String(s.port));
  }, [s?.host, s?.port]);

  const update = async (body: UpdateObsRelayRequest, what: 'save' | 'clear') => {
    setBusy(what);
    try {
      res.setData(await api.updateObsRelay(body));
      setPassword('');
      setTest(null);
      toast.success(what === 'clear' ? 'OBS password removed.' : 'OBS settings saved. Use Test connection to check them.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const p = parseWholeNumber(port);
    if (p === null || !Number.isInteger(p) || p < 1 || p > 65535) {
      setPortError("A port from 1 to 65535 (OBS's default is 4455).");
      return;
    }
    setPortError(null);
    void update({ host: host.trim() || null, port: p, ...(password ? { password } : {}) }, 'save');
  };

  const runTest = async () => {
    setBusy('test');
    setTest(null);
    try {
      setTest(await api.testObsRelay());
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="OBS on your computer" subtitle="CTD Live mobile controls OBS through CTD Relay, from anywhere: Relay connects to OBS on your network.">
      {!s ? (
        res.error ? (
          <EmptyState
            title="Couldn't load the OBS settings"
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
        )
      ) : (
        <form className="stack" onSubmit={save}>
          {s.reportedBy ? (
            <div className="alert alert-success" role="status">
              Filled in by <strong>{s.reportedBy.name}</strong> (the CTD OBS plugin), {formatDateTime(s.reportedBy.at)}. It keeps the
              port and password in step with OBS, so there is nothing to type.
            </div>
          ) : (
            <p className="small">
              The CTD OBS plugin fills this in by itself. Without it: in OBS, <strong>Tools → WebSocket Server Settings</strong>, tick{' '}
              <strong>Enable WebSocket server</strong>, then copy the port and password here (<strong>Show Connect Info</strong> shows
              both).
            </p>
          )}
          {s.serverEnabled === false && (
            <div className="alert alert-warn" role="alert">
              OBS's WebSocket server is off, so phones can't control OBS. In OBS: <strong>Tools → WebSocket Server Settings</strong> →{' '}
              <strong>Enable WebSocket server</strong>.
            </div>
          )}
          <p className="muted small">The password stays on this server: phones never see it.</p>
          <Field
            label="OBS address"
            help={
              s.detectedHost
                ? `Leave empty to use ${s.detectedHost}, the address OBS streams to Relay from. Enter an address only if OBS runs on another computer.`
                : 'Leave empty to use the address OBS streams to Relay from (stream once first), or enter the IP of the computer running OBS.'
            }
          >
            <TextInput value={host} placeholder={s.detectedHost ?? '192.168.1.50'} autoComplete="off" spellCheck={false} mono maxLength={253} onValueChange={setHost} />
          </Field>
          <Field label="Port" error={portError}>
            <TextInput value={port} inputMode="numeric" autoComplete="off" mono maxLength={5} invalid={!!portError} onValueChange={setPort} />
          </Field>
          <Field
            label="Password"
            help={s.hasPassword ? 'Saved. Leave empty to keep it, or type a new one.' : "Leave empty if OBS's Enable Authentication is off."}
          >
            <TextInput type="password" value={password} autoComplete="new-password" maxLength={256} onValueChange={setPassword} />
          </Field>
          {test &&
            (test.ok ? (
              <div className="alert alert-success" role="status">
                {obsTestText(test)}
              </div>
            ) : (
              <div className="alert alert-danger" role="alert">
                {test.error}
              </div>
            ))}
          {s.sessions > 0 && (
            <p className="muted small" role="status">
              {s.sessions === 1 ? 'A phone is' : `${s.sessions} phones are`} controlling OBS through Relay right now.
            </p>
          )}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Button type="submit" variant="primary" loading={busy === 'save'} disabled={busy !== null && busy !== 'save'}>
              Save
            </Button>
            <Button variant="secondary" loading={busy === 'test'} disabled={busy !== null && busy !== 'test'} onClick={() => void runTest()}>
              Test connection
            </Button>
            {s.hasPassword && (
              <Button
                variant="ghost"
                loading={busy === 'clear'}
                disabled={busy !== null && busy !== 'clear'}
                onClick={() => void update({ host: s.host, port: s.port, password: null }, 'clear')}
              >
                Remove password
              </Button>
            )}
          </div>
        </form>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export function AccessCard({ access }: { access: ApiAccessInfo }) {
  const openApi = safeHttpUrl(access.openApiUrl);
  return (
    <Card title="Connect an app" subtitle="Where other apps reach the API (v1). Every request needs a token from the list above.">
      <div className="stack">
        <p className="small">
          Apps with a <strong>Connect to CTD Relay</strong> option (CTD Overlay, the CTD OBS plugin) only need the address
          below: they ask to connect, and you approve them on this page with the profile and permissions of your choice. No token
          to copy.
        </p>
        {access.lanBaseUrl ? (
          <CopyField
            label="On your network (LAN)"
            value={access.lanBaseUrl}
            help="For apps on the same network as this server: CTD Overlay on the NAS, OBS, local bots."
          />
        ) : (
          <LanHint />
        )}
        <CopyField label="From anywhere (HTTPS)" value={access.baseUrl} help="For apps outside your network." />
        {access.tlsFingerprint256 && (
          <CopyField
            label="Certificate SHA-256 fingerprint"
            value={access.tlsFingerprint256}
            help="Apps that connect over HTTPS to a self-signed certificate can pin this."
          />
        )}
        <CopyField label="OpenAPI description" value={access.openApiUrl} help="Machine-readable description of every endpoint (no token needed)." />
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {openApi && (
            <a href={openApi} target="_blank" rel="noopener noreferrer" className={buttonClass('ghost', 'sm')}>
              <ExternalIcon width={14} height={14} /> Open OpenAPI
            </a>
          )}
          <a href={API_DOCS_URL} target="_blank" rel="noopener noreferrer" className={buttonClass('ghost', 'sm')}>
            <ExternalIcon width={14} height={14} /> API documentation
          </a>
        </div>
      </div>
    </Card>
  );
}
