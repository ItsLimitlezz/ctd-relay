import { useEffect, useState, type FormEvent } from 'react';
import type { Account, Destination, FeedState, PlatformInfo } from '@shared/types';
import { api } from '../../api';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { DynamicForm } from '../../components/DynamicForm';
import type { FormErrors } from '../../components/dynamic-form';
import { Field } from '../../components/Field';
import { PlatformBadge } from '../../components/PlatformBadge';
import { Select } from '../../components/Select';
import { Spinner } from '../../components/Spinner';
import { TextInput } from '../../components/TextInput';
import { Link } from '../../router';
import { errorMessage, isApiError } from '../../state/errors';
import { useApi } from '../../state/hooks';
import { useProfileId } from '../../state/profile';
import { hasErrors } from '../settings/settings-helpers';
import {
  accountOptions,
  buildCreateRequest,
  buildUpdateRequest,
  defaultAccountId,
  destinationErrorField,
  draftSecretsSet,
  feedOptions,
  feedRestriction,
  initialDraft,
  MAX_DESTINATION_NAME,
  streamKeyField,
  TRANSCODE_ERROR_KEY,
  usesAccounts,
  validateDraft,
  type DestinationDraft,
} from './destination-form';
import { TranscodeSection } from './TranscodeSection';

export interface DestinationFormProps {
  info: PlatformInfo;
  /** The profile's accounts, every platform (undefined while loading). */
  accounts: readonly Account[] | undefined;
  /** The destination being edited, or null to create one. */
  existing: Destination | null;
  onSaved: (dest: Destination) => void;
  onCancel: () => void;
  /** Back to the platform choice (create flow only). */
  onBack?: () => void;
  /** The profile's OBS feeds right now, when known (transcoding defaults and load hint). */
  liveFeeds?: readonly FeedState[] | undefined;
}

/** Create/edit form for one destination. Platform fields come from `info.destinationFields`. */
export function DestinationForm({ info, accounts, existing, onSaved, onCancel, onBack, liveFeeds }: DestinationFormProps) {
  const [draft, setDraft] = useState<DestinationDraft>(() => initialDraft(info, accounts ?? [], existing));
  const [accountTouched, setAccountTouched] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // New destinations belong to the profile on screen (an existing one keeps its own).
  const profileId = useProfileId();
  // This server's transcoding switch and working encoders; the feed OBS sends now (defaults, hints).
  const transcoding = useApi(() => api.transcodeSettings(), []);
  const transcodeContext = { settings: transcoding.data?.settings ?? null, caps: transcoding.data?.capabilities ?? null };
  const feedVideo = liveFeeds?.find((f) => f.feed === draft.feed && f.online)?.video ?? null;

  // Accounts can arrive after the form opened: preselect one for a new destination.
  useEffect(() => {
    if (existing || accountTouched || !accounts || !usesAccounts(info)) return;
    const id = defaultAccountId(accounts, info.id);
    setDraft((d) => (d.accountId ? d : { ...d, accountId: id }));
  }, [accounts, existing, accountTouched, info]);

  const update = (patch: Partial<DestinationDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const secretsSet = draftSecretsSet(info, existing, draft);
  const keyField = streamKeyField(info);
  const canClearKey = !!existing?.hasStreamKey && !!keyField && !keyField.required && draft.values[keyField.key] === undefined;
  const feeds = feedOptions(info);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const v = validateDraft(info, draft, secretsSet, transcodeContext.caps, feedVideo?.fps ?? null);
    setErrors(v);
    setFormError(null);
    if (hasErrors(v)) return;
    setBusy(true);
    try {
      const saved = existing
        ? await api.updateDestination(existing.id, buildUpdateRequest(info, draft, existing))
        : await api.createDestination({ ...buildCreateRequest(info, draft), profileId });
      setBusy(false);
      onSaved(saved);
    } catch (err) {
      const msg = errorMessage(err);
      const field = isApiError(err, 400) ? destinationErrorField(info, msg) : null;
      if (field) setErrors({ [field]: msg });
      else setFormError(msg);
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      <div className="form-header">
        <span className="row">
          <PlatformBadge platform={info.id} withName />
          {info.experimental && <Badge tone="warn">Experimental</Badge>}
        </span>
        {onBack && (
          <button type="button" className="inline-link-button small" onClick={onBack} disabled={busy}>
            Change platform
          </button>
        )}
      </div>
      {info.notes && <p className="muted small">{info.notes}</p>}
      {info.keyPerSession && (
        <div className="alert">
          {info.name} issues a new stream key for every stream. The app fetches it automatically each time you go live.
        </div>
      )}

      <Field label="Name" required error={errors.name} help="Shown on the dashboard and in the chat view.">
        <TextInput
          value={draft.name}
          maxLength={MAX_DESTINATION_NAME}
          autoComplete="off"
          onValueChange={(name) => update({ name })}
          disabled={busy}
        />
      </Field>

      <Field label="Feed" error={errors.feed} help={feedRestriction(info) ?? 'Which OBS output this destination receives.'}>
        <Select
          options={feeds}
          value={draft.feed}
          onValueChange={(v) => update({ feed: v === 'vertical' ? 'vertical' : 'landscape' })}
          disabled={busy || feeds.length <= 1}
        />
      </Field>

      {usesAccounts(info) && (
        <AccountField
          info={info}
          accounts={accounts}
          value={draft.accountId}
          error={errors.accountId}
          disabled={busy}
          onChange={(accountId) => {
            setAccountTouched(true);
            update({ accountId });
          }}
        />
      )}

      {info.destinationFields.length > 0 && (
        <DynamicForm
          fields={info.destinationFields}
          values={draft.values}
          onChange={(values) => update({ values })}
          secretsSet={secretsSet}
          errors={errors}
          disabled={busy}
          idPrefix={`dest-${info.id}`}
        />
      )}

      {canClearKey &&
        keyField &&
        (draft.clearStreamKey ? (
          <p className="small item-warn">
            The saved {keyField.label.toLowerCase()} will be removed when you save.{' '}
            <button type="button" className="inline-link-button" onClick={() => update({ clearStreamKey: false })}>
              Undo
            </button>
          </p>
        ) : (
          <p className="small">
            <button type="button" className="inline-link-button" onClick={() => update({ clearStreamKey: true })} disabled={busy}>
              Remove the saved {keyField.label.toLowerCase()}
            </button>
          </p>
        ))}

      <TranscodeSection
        info={info}
        feed={draft.feed}
        value={draft.transcode}
        onChange={(transcode) => update({ transcode })}
        context={transcodeContext}
        feedVideo={feedVideo}
        error={errors[TRANSCODE_ERROR_KEY]}
        disabled={busy}
      />

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
          {existing ? 'Save changes' : 'Add destination'}
        </Button>
      </div>
    </form>
  );
}

interface AccountFieldProps {
  info: PlatformInfo;
  accounts: readonly Account[] | undefined;
  value: string;
  error: string | undefined;
  disabled: boolean;
  onChange: (accountId: string) => void;
}

function AccountField({ info, accounts, value, error, disabled, onChange }: AccountFieldProps) {
  if (accounts === undefined) {
    return (
      <div className="row muted small">
        <Spinner size="sm" label={null} /> Loading accounts…
      </div>
    );
  }
  const options = accountOptions(accounts, info.id);
  const connectLink = <Link to={`/accounts?add=${encodeURIComponent(info.id)}`}>Connect a {info.name} account</Link>;
  if (options.length === 0) {
    return (
      <div className="alert alert-warn">
        No {info.name} account is connected to this profile yet. {connectLink} on the Accounts page. You can save this
        destination now and link the account later.
      </div>
    );
  }
  const selected = accounts.find((a) => a.id === value);
  const help =
    selected && selected.status !== 'connected' ? (
      <span className="item-warn">This account needs attention. Reconnect it on the Accounts page.</span>
    ) : !value ? (
      <span className="item-warn">Without an account the app can't manage this {info.name} channel.</span>
    ) : (
      `The ${info.name} account (of this profile) this destination streams to.`
    );
  return (
    <Field label="Account" error={error} help={help}>
      <Select options={options} placeholder="No account" value={value} onValueChange={onChange} disabled={disabled} />
    </Field>
  );
}
