import { useMemo, useState } from 'react';
import type { Account, Destination, Feed, PlatformInfo } from '@shared/types';
import { FEEDS } from '@shared/types';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ConfirmButton } from '../components/ConfirmButton';
import { EmptyState } from '../components/EmptyState';
import { BroadcastIcon, LandscapeIcon, VerticalIcon } from '../components/icons';
import { Modal } from '../components/Modal';
import { PlatformBadge, platformName } from '../components/PlatformBadge';
import { ProfileTag } from '../components/ProfileBadge';
import { Spinner } from '../components/Spinner';
import { toast } from '../components/Toast';
import { Toggle } from '../components/Toggle';
import { cx } from '../components/utils';
import { errorMessage } from '../state/errors';
import { useApi, useDestinations } from '../state/hooks';
import { useAccountsVersion, useSession } from '../state/live';
import { useProfileId } from '../state/profile';
import { DestinationForm } from './destinations/DestinationForm';
import {
  destinationProblems,
  FEED_LABEL,
  FEED_SOURCE,
  groupByFeed,
  ingestHostLabel,
  streamKeyField,
  usesAccounts,
} from './destinations/destination-form';
import { PlatformPicker } from './destinations/PlatformPicker';
import { transcodeListLine } from './destinations/transcode-form';
import './settings/admin.css';

type ModalState = { kind: 'add'; info: PlatformInfo | null } | { kind: 'edit'; dest: Destination } | null;

export default function DestinationsPage() {
  const dests = useDestinations();
  const profileId = useProfileId();
  const platforms = useApi(() => api.platforms(), []);
  const accountsVersion = useAccountsVersion();
  // What OBS sends right now (when it is streaming): the transcoding form's defaults and load hint.
  const liveFeeds = useSession()?.feeds;
  // Only this profile's accounts: a destination must use an account of its own profile.
  const accounts = useApi(() => api.accounts(profileId), [accountsVersion, profileId]);
  const [modal, setModal] = useState<ModalState>(null);

  const infoById = useMemo(() => new Map((platforms.data ?? []).map((p) => [p.id as string, p])), [platforms.data]);
  const accountById = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a])), [accounts.data]);
  const grouped = useMemo(() => groupByFeed(dests.data ?? []), [dests.data]);

  const upsert = (d: Destination) =>
    dests.setData((list) => {
      if (!list) return [d];
      return list.some((x) => x.id === d.id) ? list.map((x) => (x.id === d.id ? d : x)) : [...list, d];
    });
  const removeLocal = (id: string) => dests.setData((list) => list?.filter((x) => x.id !== id));

  const closeModal = () => setModal(null);
  const saved = (d: Destination, created: boolean) => {
    upsert(d);
    setModal(null);
    toast.success(created ? `${d.name} added.` : `${d.name} saved.`);
  };

  const addButton = (
    <Button variant="primary" onClick={() => setModal({ kind: 'add', info: null })} disabled={!platforms.data}>
      Add destination
    </Button>
  );

  let body;
  if (!dests.data) {
    body = dests.error ? (
      <Card>
        <EmptyState
          title="Couldn't load destinations"
          description={dests.error}
          action={
            <Button onClick={dests.reload} loading={dests.loading}>
              Try again
            </Button>
          }
        />
      </Card>
    ) : (
      <Card>
        <div className="row muted">
          <Spinner size="sm" /> Loading destinations…
        </div>
      </Card>
    );
  } else if (dests.data.length === 0) {
    body = (
      <Card>
        <EmptyState
          icon={<BroadcastIcon />}
          title="No destinations yet"
          description="A destination sends one OBS feed (landscape or vertical) to one platform. Add Twitch, YouTube, Kick or any other platform you stream to."
          action={addButton}
        />
      </Card>
    );
  } else {
    body = FEEDS.map((feed) => (
      <FeedSection
        key={feed}
        feed={feed}
        destinations={grouped[feed]}
        infoById={infoById}
        accountById={accountById}
        onEdit={(dest) => setModal({ kind: 'edit', dest })}
        onChanged={upsert}
        onDeleted={removeLocal}
      />
    ));
  }

  const editInfo = modal?.kind === 'edit' ? infoById.get(modal.dest.platform) : undefined;
  let modalTitle = '';
  if (modal?.kind === 'add') modalTitle = modal.info ? `Add ${modal.info.name} destination` : 'Add a destination';
  else if (modal?.kind === 'edit') modalTitle = `Edit ${modal.dest.name}`;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Destinations</h1>
          <p>Each destination sends one OBS feed of this profile to one platform. Turn them on or off at any time.</p>
          <ProfileTag className="page-profile" />
        </div>
        {dests.data && dests.data.length > 0 && addButton}
      </div>

      {platforms.error && !platforms.data && (
        <div className="alert alert-warn row-between" role="alert">
          <span>Couldn't load the platform list: {platforms.error}</span>
          <Button size="sm" onClick={platforms.reload} loading={platforms.loading}>
            Retry
          </Button>
        </div>
      )}

      {body}

      <Modal
        open={modal !== null}
        onClose={closeModal}
        title={modalTitle}
        size="lg"
        dismissible={modal?.kind === 'add' && modal.info === null}
      >
        {modal?.kind === 'add' && modal.info === null && (
          <div className="stack">
            <p className="muted small">Choose where this destination streams to.</p>
            <PlatformPicker platforms={platforms.data ?? []} onPick={(info) => setModal({ kind: 'add', info })} />
          </div>
        )}
        {modal?.kind === 'add' && modal.info !== null && (
          <DestinationForm
            key={modal.info.id}
            info={modal.info}
            accounts={accounts.data}
            existing={null}
            liveFeeds={liveFeeds}
            onSaved={(d) => saved(d, true)}
            onCancel={closeModal}
            onBack={() => setModal({ kind: 'add', info: null })}
          />
        )}
        {modal?.kind === 'edit' &&
          (editInfo ? (
            <DestinationForm
              key={modal.dest.id}
              info={editInfo}
              accounts={accounts.data}
              existing={modal.dest}
              liveFeeds={liveFeeds}
              onSaved={(d) => saved(d, false)}
              onCancel={closeModal}
            />
          ) : platforms.data ? (
            <p className="muted">
              {platformName(modal.dest.platform)} isn't available on this server any more, so this destination can't be edited. You
              can still delete it.
            </p>
          ) : (
            <div className="row muted">
              <Spinner size="sm" /> Loading…
            </div>
          ))}
      </Modal>
    </div>
  );
}

const FEED_ICON: Record<Feed, typeof LandscapeIcon> = { landscape: LandscapeIcon, vertical: VerticalIcon };

interface FeedSectionProps {
  feed: Feed;
  destinations: Destination[];
  infoById: ReadonlyMap<string, PlatformInfo>;
  accountById: ReadonlyMap<string, Account>;
  onEdit: (dest: Destination) => void;
  onChanged: (dest: Destination) => void;
  onDeleted: (id: string) => void;
}

function FeedSection({ feed, destinations, infoById, accountById, onEdit, onChanged, onDeleted }: FeedSectionProps) {
  const Icon = FEED_ICON[feed];
  const enabled = destinations.filter((d) => d.enabled).length;
  return (
    <Card
      title={
        <span className="feed-title">
          <Icon /> {FEED_LABEL[feed]} feed
        </span>
      }
      subtitle={`From the ${FEED_SOURCE[feed]}`}
      actions={
        destinations.length > 0 ? (
          <Badge tone={enabled > 0 ? 'accent' : 'neutral'} title={`${enabled} of ${destinations.length} enabled`}>
            {enabled}/{destinations.length} on
          </Badge>
        ) : undefined
      }
      flush
      aria-label={`${FEED_LABEL[feed]} feed destinations`}
    >
      {destinations.length === 0 ? (
        <p className="list-empty">Nothing is bound to this feed.</p>
      ) : (
        <ul className="item-list" style={{ marginTop: 10 }}>
          {destinations.map((d) => (
            <DestinationRow
              key={d.id}
              dest={d}
              info={infoById.get(d.platform)}
              account={d.accountId ? accountById.get(d.accountId) : undefined}
              onEdit={() => onEdit(d)}
              onChanged={onChanged}
              onDeleted={onDeleted}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

interface DestinationRowProps {
  dest: Destination;
  info: PlatformInfo | undefined;
  account: Account | undefined;
  onEdit: () => void;
  onChanged: (dest: Destination) => void;
  onDeleted: (id: string) => void;
}

function DestinationRow({ dest, info, account, onEdit, onChanged, onDeleted }: DestinationRowProps) {
  const [toggling, setToggling] = useState(false);
  const problems = destinationProblems(info, dest, account);
  const host = info && !usesAccounts(info) ? ingestHostLabel(dest.ingestUrl) : null;
  const showKeySaved = !!info && !!streamKeyField(info) && dest.hasStreamKey;
  const transcoded = transcodeListLine(dest.transcode);

  const toggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      onChanged(await api.setDestinationEnabled(dest.id, enabled));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setToggling(false);
    }
  };

  const remove = async () => {
    try {
      await api.deleteDestination(dest.id);
      onDeleted(dest.id);
      toast.success(`${dest.name} deleted.`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <li className={cx('item-row', !dest.enabled && 'is-disabled')}>
      <div className="item-main">
        <PlatformBadge platform={dest.platform} />
        <div className="item-text">
          <div className="item-title">
            <span>{dest.name}</span>
            {info?.experimental && <Badge tone="warn">Experimental</Badge>}
            {!dest.enabled && <Badge>Off</Badge>}
          </div>
          <div className="item-sub">
            <span>{info?.name ?? platformName(dest.platform)}</span>
            {account && <span>{account.label}</span>}
            {host && <span className="mono">{host}</span>}
            {showKeySaved && <span>Stream key saved</span>}
            {transcoded && <span>{transcoded}</span>}
            {problems.map((p) => (
              <span key={p} className="item-warn">
                {p}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="item-actions">
        <Toggle
          size="sm"
          checked={dest.enabled}
          busy={toggling}
          aria-label={`${dest.enabled ? 'Disable' : 'Enable'} ${dest.name}`}
          onChange={(v) => void toggle(v)}
        />
        <Button size="sm" onClick={onEdit}>
          Edit
        </Button>
        <ConfirmButton size="sm" variant="ghost" confirmLabel="Delete?" onConfirm={remove} aria-label={`Delete ${dest.name}`}>
          Delete
        </ConfirmButton>
      </div>
    </li>
  );
}
