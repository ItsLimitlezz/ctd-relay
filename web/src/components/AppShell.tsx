import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { VersionResponse } from '@shared/api';
import type { SessionStatus } from '@shared/types';
import { api } from '../api';
import { Link, ROUTES, useRoute } from '../router';
import { useAuth } from '../state/auth';
import { useNow } from '../state/hooks';
import { useLiveConnections, useLiveStatus, useSession } from '../state/live';
import { useProfileContext } from '../state/profile';
import { profileColor } from '../state/profiles';
import { Button } from './Button';
import { elapsedSeconds, formatDuration } from './format';
import { CloseIcon, FlaskIcon, MenuIcon } from './icons';
import { PairingBanner } from './PairingBanner';
import { ScopeUpgradeBanner } from './ScopeUpgradeBanner';
import { LiveProfilesIndicator, ProfileSwitcher } from './ProfileSwitcher';
import { StatusDot } from './StatusDot';
import { cx, type Tone } from './utils';

/** Top bar (brand, profile switcher, live indicators, nav, user menu) + main content area. */
export function AppShell({ children }: { children: ReactNode }) {
  const { user, isAdmin, logout } = useAuth();
  const { current } = useProfileContext();
  const route = useRoute();
  const [navOpen, setNavOpen] = useState(false);
  // The current profile's colour underlines the top bar, so it's clear which set-up is on screen.
  const accent = profileColor(current);
  const appStyle = accent ? ({ '--profile-color': accent } as CSSProperties) : undefined;

  // Close the mobile menu on navigation and on Escape.
  useEffect(() => setNavOpen(false), [route.pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  const items = ROUTES.filter((r) => r.nav && (!r.adminOnly || isAdmin));

  return (
    <div className={cx('app', accent && 'has-profile-color')} style={appStyle}>
      <header className="topbar">
        <div className="topbar-inner">
          <button
            type="button"
            className="icon-btn nav-toggle"
            aria-label={navOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={navOpen}
            aria-controls="main-nav"
            onClick={() => setNavOpen((o) => !o)}
          >
            {navOpen ? <CloseIcon /> : <MenuIcon />}
          </button>
          <Link to="/" className="brand" aria-label="CTD Relay home">
            <img src="/favicon.svg" alt="" width={26} height={26} />
            <span className="brand-text">CTD Relay</span>
          </Link>
          <ProfileSwitcher />
          <nav id="main-nav" className={cx('nav', navOpen && 'is-open')} aria-label="Main">
            {items.map((r) => (
              <Link key={r.name} to={r.path} className="nav-link" aria-current={route.name === r.name ? 'page' : undefined}>
                {r.label}
              </Link>
            ))}
            {user && (
              <div className="nav-mobile-footer">
                <span className="muted small truncate">
                  Signed in as <strong>{user.username}</strong> ({user.role})
                </span>
                <Button size="sm" onClick={() => void logout()}>
                  Log out
                </Button>
              </div>
            )}
          </nav>
          <div className="spacer" />
          <LiveProfilesIndicator />
          <TestModeIndicator />
          <LiveIndicator />
          {user && <UserMenu username={user.username} role={user.role} onLogout={() => void logout()} />}
        </div>
      </header>
      <main className="main" id="main">
        <PairingBanner />
        <ScopeUpgradeBanner />
        {children}
      </main>
      <AppFooter />
    </div>
  );
}

const REPO_URL = 'https://github.com/ItsLimitlezz/ctd-relay';

/** "v0.1.0 · build d6b0c9e (Oct 17, 01:30)" — which server build is running, so tests name it. */
export function versionLabel(v: VersionResponse): { version: string; build: string } {
  const date = v.buildDate ? new Date(v.buildDate) : null;
  const when = date && Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;
  return {
    version: `v${v.version}`,
    build: v.commit ? `build ${v.commit}${when ? ` (${when})` : ''}` : 'dev build',
  };
}

/** Bottom line of every page: app version, build (commit + date) and API revision. */
function AppFooter() {
  const [info, setInfo] = useState<VersionResponse | null>(null);
  const connected = useLiveStatus();
  // Re-read after the live connection comes back: that's when an updated server restarted.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    api.version().then(
      (v) => !cancelled && setInfo(v),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [connected]);
  if (!info) return null;
  const label = versionLabel(info);
  return (
    <footer className="app-footer muted small">
      CTD Relay {label.version} ·{' '}
      {info.commit ? (
        <a href={`${REPO_URL}/commit/${info.commit}`} target="_blank" rel="noreferrer">
          {label.build}
        </a>
      ) : (
        label.build
      )}{' '}
      · API {info.apiRevision}
    </footer>
  );
}

const STATUS_UI: Record<SessionStatus, { label: string; tone: Tone; pulse: boolean }> = {
  offline: { label: 'Offline', tone: 'neutral', pulse: false },
  starting: { label: 'Starting', tone: 'warn', pulse: true },
  live: { label: 'LIVE', tone: 'live', pulse: true },
  stopping: { label: 'Stopping', tone: 'warn', pulse: true },
};

export const TEST_MODE_TITLE = 'Test mode is on: streams are private where the platform allows it; platforms without a test mode are skipped.';

/** Orange "TEST MODE" pill in the top bar while session test mode is on (links to the dashboard). */
export function TestModeIndicator() {
  const session = useSession();
  if (session?.testMode !== true) return null;
  return (
    <Link to="/" className="live-pill is-test" title={TEST_MODE_TITLE} aria-label="Test mode is on">
      <FlaskIcon width={14} height={14} />
      <span>
        TEST<span className="test-pill-long"> MODE</span>
      </span>
    </Link>
  );
}

/**
 * The current profile's session status pill (links to the dashboard); shows reconnecting when the
 * socket is down.
 */
export function LiveIndicator() {
  const session = useSession();
  const connected = useLiveStatus();
  const connections = useLiveConnections();
  const { current } = useProfileContext();
  const live = session?.status === 'live';
  const now = useNow(live ? 1000 : null);

  if (!connected) {
    const label = connections === 0 ? 'Connecting…' : 'Reconnecting…';
    return (
      <span className="live-pill is-warn" title="Live updates from the server are unavailable" role="status">
        <StatusDot tone="warn" pulse />
        {label}
      </span>
    );
  }
  const ui = STATUS_UI[session?.status ?? 'offline'];
  const whose = current ? ` (${current.name})` : '';
  return (
    <Link to="/" className={cx('live-pill', live && 'is-live')} title={`Stream status${whose}`} aria-label={`Stream status${whose}: ${ui.label}`}>
      <StatusDot tone={ui.tone} pulse={ui.pulse} />
      {ui.label}
      {live && <span className="live-elapsed">{formatDuration(elapsedSeconds(session?.startedAt, now))}</span>}
    </Link>
  );
}

function UserMenu({ username, role, onLogout }: { username: string; role: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const route = useRoute();

  useEffect(() => setOpen(false), [route.pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="user-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${username}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="avatar" aria-hidden="true">
          {username.charAt(0)}
        </span>
        <span className="user-name truncate">{username}</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-header">
            <div className="truncate">
              <strong>{username}</strong>
            </div>
            <div className="muted small">{role === 'admin' ? 'Administrator' : 'Operator'}</div>
          </div>
          <Link to="/profile" className="menu-item" role="menuitem">
            Profile &amp; security
          </Link>
          <button type="button" className="menu-item is-danger" role="menuitem" onClick={onLogout}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
