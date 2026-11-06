import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { ASSET_KINDS, type AssetItem, type AssetKind, type AssetsResponse } from '@shared/api';
import type { ProfileSummary } from '@shared/types';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ConfirmButton } from '../components/ConfirmButton';
import { EmptyState } from '../components/EmptyState';
import { Field } from '../components/Field';
import { PlusIcon } from '../components/icons';
import { Select } from '../components/Select';
import { Spinner } from '../components/Spinner';
import { TextInput } from '../components/TextInput';
import { toast } from '../components/Toast';
import { cx } from '../components/utils';
import { useAuth } from '../state/auth';
import {
  ACCEPTED_EXTENSIONS,
  defaultAssetName,
  defaultKind,
  deleteBlockedReason,
  formatBytes,
  isAcceptedFile,
  KIND_LABEL,
  storageLine,
  usageText,
  validateAssetName,
} from '../state/assets';
import { errorMessage } from '../state/errors';
import { useProfileContext } from '../state/profile';
import './settings/admin.css';
import './assets.css';

/** A file waiting for (or going through) upload. */
export interface PendingUpload {
  key: number;
  file: File;
  name: string;
  kind: AssetKind;
  /** '' = every profile. */
  profileId: string;
  status: 'ready' | 'uploading' | 'error';
  progress: number;
  error: string | null;
}

let nextKey = 1;

/** Assets: the show-profile file library (LUTs first). Everyone sees the list; admins upload and delete. */
export default function AssetsPage() {
  const { isAdmin } = useAuth();
  const { profiles } = useProfileContext();
  const [data, setData] = useState<AssetsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.assets.list());
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (a: AssetItem) => {
    try {
      await api.assets.remove(a.id);
      toast.success(`${a.name} deleted.`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      void load();
    }
  };

  return (
    <AssetsView
      isAdmin={isAdmin}
      profiles={profiles ?? []}
      data={data}
      loadError={loadError}
      onReload={() => void load()}
      onDelete={remove}
    />
  );
}

export interface AssetsViewProps {
  isAdmin: boolean;
  profiles: readonly ProfileSummary[];
  /** null while loading. */
  data: AssetsResponse | null;
  loadError: string | null;
  onReload: () => void;
  onDelete: (a: AssetItem) => Promise<void>;
}

/** The page body. Operators get the list only: no drop zone, no delete buttons. */
export function AssetsView({ isAdmin, profiles, data, loadError, onReload, onDelete }: AssetsViewProps) {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Assets</h1>
          <p>
            Files the OBS show set-ups use, such as colour LUTs.{' '}
            {isAdmin ? 'Upload a file, name it and choose which profile it is for.' : 'Only admins can upload or delete files.'}
          </p>
        </div>
      </div>

      {isAdmin && <UploadCard profiles={profiles} onUploaded={onReload} />}

      {data === null ? (
        <Card>
          {loadError ? (
            <EmptyState title="Couldn't load the assets" description={loadError} action={<Button onClick={onReload}>Try again</Button>} />
          ) : (
            <div className="row muted">
              <Spinner size="sm" /> Loading assets…
            </div>
          )}
        </Card>
      ) : (
        <AssetsList data={data} profiles={profiles} isAdmin={isAdmin} onDelete={onDelete} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface AssetsListProps {
  data: AssetsResponse;
  profiles: readonly ProfileSummary[];
  isAdmin: boolean;
  onDelete: (a: AssetItem) => Promise<void>;
}

export function AssetsList({ data, profiles, isAdmin, onDelete }: AssetsListProps) {
  const profileName = (id: string) => profiles.find((p) => p.id === id)?.name ?? id;
  const used = storageLine(data.usedBytes, data.quotaBytes);
  const pct = data.quotaBytes > 0 ? Math.min(100, Math.round((data.usedBytes / data.quotaBytes) * 100)) : 0;
  return (
    <Card title="Library" subtitle={used} className="assets-library">
      {data.quotaBytes > 0 && (
        <div className="asset-quota" role="progressbar" aria-label="Storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      {data.items.length === 0 ? (
        <EmptyState title="No assets yet" description={isAdmin ? 'Drop a .cube or .png file above to add one.' : 'An admin can upload files here.'} />
      ) : (
        <ul className="item-list asset-list" aria-label="Assets">
          {data.items.map((a) => {
            const blocked = deleteBlockedReason(a, profileName);
            const usage = usageText(a.usage, profileName);
            return (
              <li key={a.id} className="item-row asset-row">
                <div className="item-main is-top">
                  <div className="item-text">
                    <div className="item-title">
                      <span>{a.name}</span>
                      <Badge>{KIND_LABEL[a.kind] ?? a.kind}</Badge>
                      {a.usage.some((u) => u.isHead) && <Badge tone="accent">In use</Badge>}
                    </div>
                    <div className="item-sub">
                      <span>{a.profileId === null ? 'Every profile' : profileName(a.profileId)}</span>
                      <span>{formatBytes(a.size)}</span>
                      <span>{usage || 'Not used yet'}</span>
                    </div>
                  </div>
                </div>
                {isAdmin && (
                  <div className="item-actions">
                    <ConfirmButton
                      size="sm"
                      variant="ghost"
                      disabled={blocked !== null}
                      title={blocked ?? `Deletes ${a.name} from the library`}
                      confirmLabel="Delete it?"
                      aria-label={`Delete ${a.name}`}
                      onConfirm={() => onDelete(a)}
                    >
                      Delete
                    </ConfirmButton>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Upload (admins)
// ---------------------------------------------------------------------------

export function UploadCard({ profiles, onUploaded }: { profiles: readonly ProfileSummary[]; onUploaded: () => void }) {
  const [queue, setQueue] = useState<PendingUpload[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const patch = (key: number, p: Partial<PendingUpload>) => setQueue((q) => q.map((u) => (u.key === key ? { ...u, ...p } : u)));
  const drop = (key: number) => setQueue((q) => q.filter((u) => u.key !== key));

  const add = (files: FileList | File[]) => {
    const picked = Array.from(files);
    const rejected = picked.filter((f) => !isAcceptedFile(f.name));
    if (rejected.length > 0) toast.error(`Only ${ACCEPTED_EXTENSIONS.join(' and ')} files for now: ${rejected.map((f) => f.name).join(', ')}`);
    const accepted = picked.filter((f) => isAcceptedFile(f.name));
    setQueue((q) => [
      ...q,
      ...accepted.map<PendingUpload>((file) => ({
        key: nextKey++,
        file,
        name: defaultAssetName(file.name),
        kind: defaultKind(file.name),
        profileId: '',
        status: 'ready',
        progress: 0,
        error: null,
      })),
    ]);
  };

  const start = async (u: PendingUpload) => {
    const nameError = validateAssetName(u.name);
    if (nameError) return patch(u.key, { error: nameError, status: 'error' });
    patch(u.key, { status: 'uploading', progress: 0, error: null });
    try {
      const item = await api.assets.upload(u.file, { name: u.name.trim(), kind: u.kind, profileId: u.profileId || null }, (f) =>
        patch(u.key, { progress: f }),
      );
      toast.success(`${item.name} uploaded.`);
      drop(u.key);
      onUploaded();
    } catch (err) {
      patch(u.key, { status: 'error', error: errorMessage(err) });
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) add(e.dataTransfer.files);
  };

  return (
    <Card title="Upload" subtitle={`Drag ${ACCEPTED_EXTENSIONS.join(' or ')} files here.`}>
      <div
        className={cx('asset-dropzone', dragging && 'is-dragging')}
        data-testid="asset-dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p>Drop files here, or</p>
        <Button icon={<PlusIcon width={16} height={16} />} onClick={() => input.current?.click()}>
          Choose files
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={ACCEPTED_EXTENSIONS.join(',')}
          onChange={(e) => {
            if (e.currentTarget.files) add(e.currentTarget.files);
            e.currentTarget.value = '';
          }}
        />
      </div>

      {queue.length > 0 && (
        <ul className="item-list asset-queue" aria-label="Files to upload">
          {queue.map((u) => (
            <li key={u.key} className="asset-queue-row">
              <div className="asset-queue-fields">
                <Field label="Name" error={u.status === 'error' && validateAssetName(u.name) ? (validateAssetName(u.name) ?? undefined) : undefined}>
                  <TextInput value={u.name} maxLength={100} disabled={u.status === 'uploading'} onValueChange={(name) => patch(u.key, { name })} />
                </Field>
                <Field label="Type">
                  <Select
                    value={u.kind}
                    disabled={u.status === 'uploading'}
                    options={ASSET_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
                    onValueChange={(kind) => patch(u.key, { kind: kind as AssetKind })}
                  />
                </Field>
                <Field label="Profile">
                  <Select
                    value={u.profileId}
                    disabled={u.status === 'uploading'}
                    options={[{ value: '', label: 'Every profile' }, ...profiles.map((p) => ({ value: p.id, label: p.name }))]}
                    onValueChange={(profileId) => patch(u.key, { profileId })}
                  />
                </Field>
              </div>
              <div className="asset-queue-foot">
                <span className="small muted truncate">
                  {u.file.name} · {formatBytes(u.file.size)}
                </span>
                {u.status === 'uploading' && (
                  <div
                    className="asset-progress"
                    role="progressbar"
                    aria-label={`Uploading ${u.file.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(u.progress * 100)}
                  >
                    <span style={{ width: `${Math.round(u.progress * 100)}%` }} />
                  </div>
                )}
                {u.status === 'error' && u.error && (
                  <span className="item-error small" role="alert">
                    {u.error}
                  </span>
                )}
                <div className="item-actions">
                  <Button size="sm" variant="ghost" disabled={u.status === 'uploading'} onClick={() => drop(u.key)}>
                    Remove
                  </Button>
                  <Button size="sm" variant="primary" loading={u.status === 'uploading'} onClick={() => void start(u)}>
                    {u.status === 'error' ? 'Retry' : 'Upload'}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
