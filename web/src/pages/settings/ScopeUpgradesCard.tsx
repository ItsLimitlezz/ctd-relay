// Settings → API: apps asking for more permissions for the token they already have (scope
// upgrades, docs/API.md §9.3.1). Approve adds exactly the listed permissions to that token; its
// profile stays the same. All or nothing.

import { useEffect, useState } from 'react';
import type { ProfileSummary, ScopeUpgradeRequest } from '@shared/types';
import { SENSITIVE_SCOPES as SENSITIVE_SCOPE_REASONS } from '@shared/types';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { KeyIcon } from '../../components/icons';
import { cx } from '../../components/utils';
import { knownScopes, pairingExpiresText, quotedReason, scopeUpgradeAppName } from '../../state/hub';
import { profileLabel } from '../../state/profiles';
import { API_SCOPE_INFO } from './settings-helpers';

export interface ScopeUpgradesCardProps {
  /** Pending, unexpired requests (newest first). */
  pending: readonly ScopeUpgradeRequest[];
  /** The list was loaded at least once. */
  loaded: boolean;
  profiles: readonly ProfileSummary[] | null;
  now: number;
  /** `?upgrade=<id>` from the app's approve link: that request is brought into view. */
  focusId?: string | null;
  error?: string | null;
  onRetry?: () => void;
  onApprove: (u: ScopeUpgradeRequest) => Promise<void>;
  onDeny: (u: ScopeUpgradeRequest) => Promise<void>;
}

export function ScopeUpgradesCard({ pending, loaded, profiles, now, focusId = null, error = null, onRetry, onApprove, onDeny }: ScopeUpgradesCardProps) {
  const focusMissing = !!focusId && loaded && !pending.some((u) => u.id === focusId);
  if (pending.length === 0 && !focusMissing && !error) return null;
  return (
    <Card
      className={cx(pending.length > 0 && 'pairings-card')}
      title={pending.length === 1 ? 'An app asks for more permissions' : pending.length > 1 ? `${pending.length} apps ask for more permissions` : 'More permissions'}
      subtitle="Approving adds exactly these permissions to the token the app already has. It keeps the same token and the same profile. Deny if you don't expect this."
    >
      <div className="stack">
        {error && (
          <div className="alert alert-warn row-between" role="alert">
            <span>Couldn't load requests for more permissions: {error}</span>
            {onRetry && (
              <Button size="sm" onClick={onRetry}>
                Retry
              </Button>
            )}
          </div>
        )}
        {focusMissing && <div className="alert">That request has expired or was already handled. Ask the app to try again.</div>}
        {pending.length > 0 && (
          <ul className="pairing-list" aria-label="Requests for more permissions">
            {pending.map((u) => (
              <ScopeUpgradeRow key={u.id} upgrade={u} profiles={profiles} now={now} focused={u.id === focusId} onApprove={onApprove} onDeny={onDeny} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function ScopeUpgradeRow({
  upgrade: u,
  profiles,
  now,
  focused,
  onApprove,
  onDeny,
}: {
  upgrade: ScopeUpgradeRequest;
  profiles: readonly ProfileSummary[] | null;
  now: number;
  focused: boolean;
  onApprove: ScopeUpgradesCardProps['onApprove'];
  onDeny: ScopeUpgradesCardProps['onDeny'];
}) {
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const adding = knownScopes(u.adding);
  const reason = quotedReason(u.reason);
  const name = scopeUpgradeAppName(u);

  // Arriving from the app's approve link: bring the request into view.
  useEffect(() => {
    if (focused) document.getElementById(`upgrade-${u.id}`)?.scrollIntoView({ block: 'nearest' });
  }, []);

  const run = async (what: 'approve' | 'deny') => {
    setBusy(what);
    try {
      await (what === 'approve' ? onApprove(u) : onDeny(u));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="pairing-row" id={`upgrade-${u.id}`}>
      <div className="pairing-head">
        <span className="user-avatar" aria-hidden="true">
          <KeyIcon width={16} height={16} />
        </span>
        <div className="item-text">
          <div className="item-title">
            <span>{name}</span>
            {u.kind && <Badge>{u.kind}</Badge>}
          </div>
          <div className="item-sub">
            <span>
              Token “{u.tokenName}” <code className="small">{u.tokenPrefix}…</code>
            </span>
            <span>{u.profileId === null ? 'Every profile' : `Only ${profileLabel(u.profileId, profiles)}`}</span>
            <span>{pairingExpiresText(u, now)}</span>
          </div>
        </div>
      </div>
      <div className="stack">
        {reason && (
          <p className="small">
            The app says (its own words): <span className="muted">{reason}</span>
          </p>
        )}
        <p className="small">
          {name} would also be able to{u.profileId === null ? ', for every profile' : `, for ${profileLabel(u.profileId, profiles)} only`}:
        </p>
        <div className="check-group" role="list" aria-label="Permissions to add">
          {adding.map((s) => {
            const sensitive = SENSITIVE_SCOPE_REASONS[s];
            return (
              <div key={s} className="check-row" role="listitem">
                <span>
                  <strong>{API_SCOPE_INFO[s].label}</strong> <code className="small">{s}</code>
                  {sensitive && (
                    <>
                      {' '}
                      <Badge tone="warn">Sensitive</Badge>
                    </>
                  )}
                  <span className="check-help">{sensitive ? `${sensitive} ${API_SCOPE_INFO[s].help}` : API_SCOPE_INFO[s].help}</span>
                </span>
              </div>
            );
          })}
        </div>
        {u.currentScopes.length > 0 && (
          <p className="small muted">It already has: {knownScopes(u.currentScopes).map((s) => API_SCOPE_INFO[s].label).join(', ')}.</p>
        )}
      </div>
      <div className="pairing-actions">
        <span className="spacer" />
        <Button size="sm" variant="ghost" loading={busy === 'deny'} disabled={busy !== null} onClick={() => void run('deny')}>
          Deny
        </Button>
        <Button size="sm" variant="primary" loading={busy === 'approve'} disabled={busy !== null} onClick={() => void run('approve')}>
          Approve
        </Button>
      </div>
    </li>
  );
}
