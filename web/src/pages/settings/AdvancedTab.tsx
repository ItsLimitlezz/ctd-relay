import { useState } from 'react';
import type { InstagramChatPackStatus } from '@shared/api';
import { api } from '../../api';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmButton } from '../../components/ConfirmButton';
import { EmptyState } from '../../components/EmptyState';
import { formatDateTime } from '../../components/format';
import { Spinner } from '../../components/Spinner';
import { toast } from '../../components/Toast';
import { errorMessage } from '../../state/errors';
import { useApi } from '../../state/hooks';
import { chatPackReaders } from './settings-helpers';

/** Settings → Advanced: operator tools that rarely need touching. */
export function AdvancedTab() {
  const pack = useApi(() => api.instagramChatPack(), []);
  const [reverting, setReverting] = useState(false);

  const revert = async () => {
    setReverting(true);
    try {
      pack.setData(await api.revertInstagramChatPack());
      toast.success('Instagram chat reader: back to the built-in selector pack.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setReverting(false);
    }
  };

  if (!pack.data) {
    return (
      <Card title="Instagram chat reader">
        {pack.error ? (
          <EmptyState
            title="Couldn't load the chat reader's settings"
            description={pack.error}
            action={
              <Button onClick={pack.reload} loading={pack.loading}>
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
  return <InstagramChatReaderCard status={pack.data} onRevert={revert} reverting={reverting} onRefresh={pack.reload} refreshing={pack.loading} />;
}

export interface InstagramChatReaderCardProps {
  status: InstagramChatPackStatus;
  onRevert: () => void | Promise<unknown>;
  reverting?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
}

/**
 * Which selector pack the Instagram comments reader runs with, and a way back to the built-in one.
 * Packs are changed through the API (docs/PLATFORMS.md → Instagram), not here.
 */
export function InstagramChatReaderCard({ status, onRevert, reverting = false, onRefresh, refreshing = false }: InstagramChatReaderCardProps) {
  const override = status.source === 'override';
  return (
    <Card
      title="Instagram chat reader"
      subtitle="Instagram's live comments are read from its page, and the page changes often. The reader's selectors live in a selector pack that can be replaced while a live is running."
      actions={
        onRefresh && (
          <Button variant="ghost" size="sm" onClick={onRefresh} loading={refreshing}>
            Refresh
          </Button>
        )
      }
    >
      <div className="stack">
        <dl className="kv kv-start">
          <dt>Selector pack</dt>
          <dd>
            <span className="mono">{status.version}</span> <Badge tone={override ? 'warn' : 'neutral'}>{override ? 'Operator override' : 'Built-in'}</Badge>
          </dd>
          {override && (
            <>
              <dt>Built-in pack</dt>
              <dd className="mono">{status.builtinVersion}</dd>
              <dt>Changed</dt>
              <dd>
                {formatDateTime(status.updatedAt, 'Unknown')}
                {status.updatedBy ? ` by ${status.updatedBy}` : ''}
              </dd>
            </>
          )}
          {status.note && (
            <>
              <dt>Note</dt>
              <dd>{status.note}</dd>
            </>
          )}
          <dt>Reading now</dt>
          <dd>{chatPackReaders(status.readers)}</dd>
        </dl>
        <p className="muted small">
          A pack is replaced through the API with a token that has the <code>system:admin</code> permission (see <code>docs/PLATFORMS.md</code>, "Tuning
          the chat reader live"). The reader picks up a new pack within a second, and the pack is kept across restarts. A pack holds selectors and
          text patterns only, never code.
        </p>
        <div className="row">
          <ConfirmButton onConfirm={onRevert} loading={reverting} disabled={!override} confirmLabel="Click again to revert">
            Revert to built-in
          </ConfirmButton>
          {!override && <span className="muted small">The built-in pack is active.</span>}
        </div>
      </div>
    </Card>
  );
}
