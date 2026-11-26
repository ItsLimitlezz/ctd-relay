// "CTD OBS plugin asks for more permissions. Review" — shown to admins on every page while an app
// asks for more scopes for its token (except on Settings → API, which lists them).

import { Link, useQuery, useRoute } from '../router';
import { useAuth } from '../state/auth';
import { useNow } from '../state/hooks';
import { pendingScopeUpgrades, scopeUpgradeBannerText } from '../state/hub';
import { useScopeUpgrades } from '../state/live';
import { buttonClass } from './Button';
import { KeyIcon } from './icons';

export function ScopeUpgradeBanner() {
  const { isAdmin } = useAuth();
  const upgrades = useScopeUpgrades();
  const route = useRoute();
  const query = useQuery();
  const any = isAdmin && (upgrades?.length ?? 0) > 0;
  const now = useNow(any ? 15_000 : null);
  if (!any) return null;
  if (route.name === 'settings' && query.get('tab') === 'api') return null;
  const pending = pendingScopeUpgrades(upgrades, now);
  if (pending.length === 0) return null;
  const target = pending.length === 1 ? `/settings?tab=api&upgrade=${encodeURIComponent((pending[0] as { id: string }).id)}` : '/settings?tab=api';
  return (
    <div className="pairing-banner" role="status">
      <KeyIcon width={18} height={18} />
      <span className="pairing-banner-text">{scopeUpgradeBannerText(pending)}</span>
      <Link to={target} className={buttonClass('primary', 'sm')}>
        Review
      </Link>
    </div>
  );
}
