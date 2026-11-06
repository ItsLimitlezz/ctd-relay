import { lazy, Suspense, useEffect, type ComponentType } from 'react';
import { AppShell } from './components/AppShell';
import { Button, buttonClass } from './components/Button';
import { EmptyState } from './components/EmptyState';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ShieldIcon } from './components/icons';
import { Spinner } from './components/Spinner';
import { ToastProvider } from './components/Toast';
import ChatPage from './pages/ChatPage';
import DashboardPage from './pages/DashboardPage';
import LoginPage from './pages/LoginPage';
import ProfilePage from './pages/ProfilePage';
import SetupPage from './pages/SetupPage';
import { Link, navigate, useRoute, type RouteName } from './router';
import { AuthProvider, rememberReturnTo, takeReturnTo, useAuth } from './state/auth';
import { reloadingImport } from './state/chunk-reload';
import { LiveProvider, useSession } from './state/live';
import { ProfileProvider, useProfileContext } from './state/profile';

// Admin pages are loaded on demand (they're built by another module and may grow large).
// After a container update the old chunks are gone: reload once to get the new build.
const DestinationsPage = lazy(reloadingImport(() => import('./pages/DestinationsPage')));
const AccountsPage = lazy(reloadingImport(() => import('./pages/AccountsPage')));
const AssetsPage = lazy(reloadingImport(() => import('./pages/AssetsPage')));
const SettingsPage = lazy(reloadingImport(() => import('./pages/SettingsPage')));
const ProfilesPage = lazy(reloadingImport(() => import('./pages/ProfilesPage')));

const PAGES: Record<Exclude<RouteName, 'login' | 'setup'>, ComponentType> = {
  dashboard: DashboardPage,
  chat: ChatPage,
  destinations: DestinationsPage,
  accounts: AccountsPage,
  assets: AssetsPage,
  settings: SettingsPage,
  profiles: ProfilesPage,
  profile: ProfilePage,
};

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <ProfileProvider>
          <LiveProvider>
            <Root />
          </LiveProvider>
        </ProfileProvider>
      </AuthProvider>
    </ToastProvider>
  );
}

function FullPageSpinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="full-center">
      <Spinner size="lg" label={label} />
    </div>
  );
}

function Root() {
  const auth = useAuth();
  const route = useRoute();
  const profile = useProfileContext();
  const { status } = auth;

  // Keep the URL in line with the auth state.
  useEffect(() => {
    if (status === 'setup' && route.name !== 'setup') {
      navigate('/setup', { replace: true });
    } else if (status === 'anonymous' && route.name !== 'login') {
      if (route.name !== 'setup') rememberReturnTo(route.pathname + route.search);
      navigate('/login', { replace: true });
    } else if (status === 'authenticated' && (route.name === 'login' || route.name === 'setup')) {
      navigate(takeReturnTo(), { replace: true });
    } else if (status === 'authenticated' && route.pathname !== route.path) {
      // Unknown or non-canonical path (e.g. "/Chat/"): show the canonical URL.
      navigate(route.path + route.search, { replace: true });
    }
  }, [status, route.name, route.path, route.pathname, route.search]);

  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'error') {
    return (
      <div className="full-center">
        <h1>Can't reach CTD Relay</h1>
        <p>{auth.error}</p>
        <Button variant="primary" onClick={auth.retry}>
          Try again
        </Button>
      </div>
    );
  }
  if (status === 'setup') {
    return route.name === 'setup' ? (
      <>
        <DocumentTitle label="Setup" />
        <SetupPage />
      </>
    ) : (
      <FullPageSpinner />
    );
  }
  if (status === 'anonymous') {
    return route.name === 'login' ? (
      <>
        <DocumentTitle label="Sign in" />
        <LoginPage />
      </>
    ) : (
      <FullPageSpinner />
    );
  }
  if (route.name === 'login' || route.name === 'setup') return <FullPageSpinner />;

  const Page = PAGES[route.name];
  return (
    <AppShell>
      <DocumentTitle label={route.label} />
      {/* Keyed by profile too: switching profile starts the page fresh (no data from the other one). */}
      <ErrorBoundary key={`${route.name}:${profile.profileId}`}>
        {!profile.ready ? (
          <FullPageSpinner label="Loading profiles…" />
        ) : route.adminOnly && !auth.isAdmin ? (
          <EmptyState
            icon={<ShieldIcon />}
            title="Admins only"
            description="Ask an administrator if you need access to this page."
            action={
              <Link to="/" className={buttonClass('primary')}>
                Back to dashboard
              </Link>
            }
          />
        ) : (
          <Suspense fallback={<FullPageSpinner />}>
            <Page />
          </Suspense>
        )}
      </ErrorBoundary>
    </AppShell>
  );
}

/**
 * "Chat · CTD Relay", prefixed with "LIVE" while streaming; with several profiles, the
 * profile's name follows the page ("LIVE · Dashboard · DPRTMNT · CTD Relay").
 */
function DocumentTitle({ label }: { label: string }) {
  const live = useSession()?.status === 'live';
  const { profiles, current } = useProfileContext();
  const profileName = current && profiles && profiles.length > 1 ? current.name : null;
  useEffect(() => {
    document.title = `${live ? 'LIVE · ' : ''}${label}${profileName ? ` · ${profileName}` : ''} · CTD Relay`;
  }, [label, live, profileName]);
  return null;
}
