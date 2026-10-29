import { useEffect, type ReactNode } from 'react';
import { api } from '../api';
import { Button, buttonClass } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { LayersIcon } from '../components/icons';
import { Spinner } from '../components/Spinner';
import { tabId, TabPanel, Tabs } from '../components/Tabs';
import { Link, setQuery, useQuery } from '../router';
import { useApi, type ApiResource } from '../state/hooks';
import type { SettingsResponse } from '@shared/api';
import { AboutTab } from './settings/AboutTab';
import { ApiTab } from './settings/ApiTab';
import { AuditTab } from './settings/AuditTab';
import { DeveloperAppsTab } from './settings/DeveloperAppsTab';
import { GeneralTab } from './settings/GeneralTab';
import { HttpsTab } from './settings/HttpsTab';
import { ObsTab } from './settings/ObsTab';
import { OverlayTab } from './settings/OverlayTab';
import { SETTINGS_TABS, settingsTab, type SettingsTabId } from './settings/settings-helpers';
import { SpotifyTab } from './settings/SpotifyTab';
import { UsersTab } from './settings/UsersTab';
import './settings/admin.css';

const ID_PREFIX = 'settings';

export default function SettingsPage() {
  const query = useQuery();
  const tab = settingsTab(query.get('tab'));
  // General, HTTPS and About share one request.
  const settings = useApi(() => api.settings(), []);

  // On narrow screens the tab bar scrolls sideways: keep the selected tab visible (e.g. ?tab=apps links).
  useEffect(() => {
    document.getElementById(tabId(ID_PREFIX, tab))?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Server, security, OBS and API configuration. OBS setup, the chat overlay and Spotify are per profile; the rest is shared.</p>
        </div>
        <Link to="/profiles" className={buttonClass('secondary', 'sm')}>
          <LayersIcon width={16} height={16} /> Streaming profiles
        </Link>
      </div>
      <Tabs
        tabs={SETTINGS_TABS}
        value={tab}
        onChange={(id) => setQuery({ tab: id })}
        idPrefix={ID_PREFIX}
        aria-label="Settings sections"
      />
      <TabPanel idPrefix={ID_PREFIX} id={tab} className="settings-panel">
        <TabContent tab={tab} settings={settings} />
      </TabPanel>
    </div>
  );
}

function TabContent({ tab, settings }: { tab: SettingsTabId; settings: ApiResource<SettingsResponse> }) {
  switch (tab) {
    case 'general':
      return withSettings(settings, (data) => <GeneralTab data={data} onSaved={(res) => settings.setData(res)} />);
    case 'https':
      return withSettings(settings, (data) => <HttpsTab tls={data.tls} onRefresh={settings.reload} refreshing={settings.loading} />);
    case 'obs':
      return <ObsTab />;
    case 'apps':
      return <DeveloperAppsTab />;
    case 'users':
      return <UsersTab />;
    case 'overlay':
      return <OverlayTab />;
    case 'spotify':
      return <SpotifyTab />;
    case 'api':
      return <ApiTab />;
    case 'audit':
      return <AuditTab />;
    case 'about':
      return <AboutTab version={settings.data?.version ?? null} />;
  }
}

function withSettings(settings: ApiResource<SettingsResponse>, render: (data: SettingsResponse) => ReactNode): ReactNode {
  if (settings.data) return render(settings.data);
  return (
    <Card>
      {settings.error ? (
        <EmptyState
          title="Couldn't load settings"
          description={settings.error}
          action={
            <Button onClick={settings.reload} loading={settings.loading}>
              Try again
            </Button>
          }
        />
      ) : (
        <div className="row muted">
          <Spinner size="sm" /> Loading settings…
        </div>
      )}
    </Card>
  );
}
