import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApiAccessInfo, ConnectStart, SettingsResponse } from '@shared/api';
import type { Account, ApiTokenInfo, ConnectedApp, Destination, PairingRequest, PlatformInfo, ProfileSummary, TlsStatus } from '@shared/types';
import { AuthProvider } from '../state/auth';
import { LiveProvider } from '../state/live';
import { AccountForm } from './accounts/AddAccountModal';
import { ConnectModal, Instructions, type ConnectState } from './accounts/ConnectModal';
import { DestinationForm } from './destinations/DestinationForm';
import { PlatformPicker } from './destinations/PlatformPicker';
import { AboutTab } from './settings/AboutTab';
import {
  AccessCard,
  ApprovePairingForm,
  ConnectedAppsCard,
  DockCard,
  NewTokenForm,
  PairingsCard,
  TokenSecret,
  TokensCard,
} from './settings/ApiTab';
import { GeneralTab } from './settings/GeneralTab';
import { HttpsTab } from './settings/HttpsTab';

const html = (el: ReactElement) => renderToStaticMarkup(el);
const withProviders = (el: ReactElement) =>
  html(
    <AuthProvider>
      <LiveProvider>{el}</LiveProvider>
    </AuthProvider>,
  );
const noop = () => undefined;

const kick: PlatformInfo = {
  id: 'kick',
  name: 'Kick',
  feeds: ['landscape'],
  defaultFeed: 'landscape',
  connectMethod: 'oauth-paste',
  accountFields: [],
  destinationFields: [
    { key: 'server', label: 'Server URL', type: 'url', target: 'ingestUrl', required: true },
    { key: 'key', label: 'Stream key', type: 'secret', target: 'streamKey' },
  ],
  developerApp: { consoleUrl: 'https://kick.com/settings/developer', fields: [], instructions: '' },
  titleSupport: 'api',
  chatSupport: 'api',
  keyPerSession: false,
  experimental: false,
  notes: 'Paste the stream key from your Kick dashboard.',
};

const instagram: PlatformInfo = {
  ...kick,
  id: 'instagram',
  name: 'Instagram',
  feeds: ['vertical'],
  defaultFeed: 'vertical',
  connectMethod: 'browser',
  destinationFields: [],
  developerApp: null,
  keyPerSession: true,
  experimental: true,
  notes: undefined,
};

const account: Account = {
  id: 'acc1',
  platform: 'kick',
  label: 'my_channel',
  status: 'pending',
  statusMessage: null,
  options: {},
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

const dest: Destination = {
  id: 'd1',
  platform: 'kick',
  accountId: null,
  name: 'Kick main',
  feed: 'landscape',
  enabled: true,
  options: {},
  ingestUrl: 'rtmps://ingest.example/app',
  hasStreamKey: true,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

const connect = (start: ConnectStart | null, state?: ConnectState) =>
  withProviders(
    <ConnectModal
      account={account}
      info={kick}
      state={state ?? (start ? { phase: 'ready', start } : { phase: 'starting' })}
      onRestart={noop}
      onConnected={noop}
      onClose={noop}
    />,
  );

describe('destinations UI (static render)', () => {
  it('PlatformPicker shows feeds, experimental flag and notes', () => {
    const out = html(<PlatformPicker platforms={[instagram, kick]} onPick={noop} />);
    expect(out.indexOf('Kick')).toBeLessThan(out.indexOf('Instagram'));
    expect(out).toContain('Vertical only');
    expect(out).toContain('Landscape only');
    expect(out).toContain('Experimental');
    expect(out).toContain('Paste the stream key from your Kick dashboard.');
  });

  it('DestinationForm (new) links to the accounts page when no account exists', () => {
    const out = html(<DestinationForm info={kick} accounts={[]} existing={null} onSaved={noop} onCancel={noop} onBack={noop} />);
    expect(out).toContain('href="/accounts?add=kick"');
    expect(out).toContain('value="Kick"');
    expect(out).toContain('Change platform');
    expect(out).toContain('Add destination');
    expect(out).toContain('type="password"');
  });

  it('DestinationForm (edit) shows the stored key as set and offers to remove it', () => {
    const out = html(<DestinationForm info={kick} accounts={[account]} existing={dest} onSaved={noop} onCancel={noop} />);
    expect(out).toContain('•••• set');
    expect(out).toContain('Remove the saved stream key');
    expect(out).toContain('value="rtmps://ingest.example/app"');
    expect(out).toContain('my_channel (not connected)');
    expect(out).toContain('Save changes');
    expect(out).not.toContain('Change platform');
  });

  it('DestinationForm explains vertical-only and per-stream keys', () => {
    const out = html(<DestinationForm info={instagram} accounts={undefined} existing={null} onSaved={noop} onCancel={noop} />);
    expect(out).toContain('Instagram only accepts the vertical feed.');
    expect(out).toContain('new stream key for every stream');
    expect(out).toContain('Loading accounts');
    expect(out).toMatch(/<select[^>]*disabled/);
  });
});

describe('connect flow (static render)', () => {
  it('device code: big code, open + copy buttons, countdown', () => {
    const out = connect({
      method: 'device-code',
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://www.twitch.tv/activate',
      verificationUriComplete: 'https://www.twitch.tv/activate?device-code=WDJB-MJHT',
      expiresIn: 1800,
      interval: 5,
    });
    expect(out).toContain('WDJB-MJHT');
    expect(out).toContain('href="https://www.twitch.tv/activate?device-code=WDJB-MJHT"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('Copy code');
    expect(out).toContain('30:00');
  });

  it('oauth paste: login link, redirect URI and paste field', () => {
    const out = connect({
      method: 'oauth-paste',
      authorizeUrl: 'https://id.kick.com/oauth/authorize?client_id=x&state=acc1.r',
      redirectUri: 'https://203.0.113.7/oauth/callback/kick',
      instructions: 'Log in with the account you stream from.',
    });
    expect(out).toContain('href="https://id.kick.com/oauth/authorize?client_id=x&amp;state=acc1.r"');
    expect(out).toContain('https://203.0.113.7/oauth/callback/kick');
    expect(out).toContain('Address you landed on');
    expect(out).toContain('Log in with the account you stream from.');
  });

  it('oauth paste: an unsafe authorize URL is not rendered as a link', () => {
    const out = connect({ method: 'oauth-paste', authorizeUrl: 'javascript:alert(1)', redirectUri: 'https://h/cb', instructions: '' });
    expect(out).not.toContain('javascript:');
    expect(out).toContain('invalid link');
  });

  it('token paste renders the driver fields', () => {
    const out = connect({
      method: 'token-paste',
      fields: [{ key: 'token', label: 'Page access token', type: 'secret', required: true }],
      instructions: '1. Open Graph API Explorer\n2. Copy the token',
    });
    expect(out).toContain('Page access token');
    expect(out).toContain('<ol class="steps">');
    expect(out).toContain('Open Graph API Explorer');
  });

  it('browser login shows the live viewer and the confirm buttons', () => {
    const out = connect({ method: 'browser', startUrl: 'https://kick.com/login', instructions: 'Log in to Kick.' });
    expect(out).toContain('role="application"');
    expect(out).toContain('I&#x27;m logged in');
    expect(out).toContain('Cancel');
  });

  it('starting and failed (missing developer app) states', () => {
    expect(connect(null)).toContain('Contacting Kick');
    const failed = connect(null, { phase: 'failed', message: 'Set up the Kick developer app first.', misconfigured: true });
    expect(failed).toContain('Set up the Kick developer app first.');
    expect(failed).toContain('href="/settings?tab=apps"');
    expect(failed).toContain('Try again');
  });

  it('add account: Facebook Page mode asks for the Meta app, profile mode can continue without it', () => {
    const facebook: PlatformInfo = {
      ...kick,
      id: 'facebook',
      name: 'Facebook',
      accountFields: [
        {
          key: 'mode',
          label: 'Account type',
          type: 'select',
          required: true,
          default: 'page',
          options: [
            { value: 'page', label: 'Page' },
            { value: 'profile', label: 'Profile' },
          ],
        },
      ],
    };
    const apps = [{ platform: 'facebook' as const, configured: false, values: {}, secretsSet: {}, redirectUri: null }];
    const form = (info: PlatformInfo) =>
      html(<AccountForm info={info} apps={apps} onBack={noop} onCancel={noop} onCreated={noop} />);

    const page = form(facebook);
    expect(page).toContain('needs a free developer app');
    expect(page).toContain('href="/settings?tab=apps"');
    expect(page).not.toContain('Continue');

    const profileField = { ...facebook.accountFields[0]!, default: 'profile' };
    const profile = form({ ...facebook, accountFields: [profileField] });
    expect(profile).not.toContain('needs a free developer app');
    expect(profile).toContain('Continue');
    expect(profile).toContain('in a browser shown right here');
  });

  it('Instructions: one line is a paragraph, several are a list', () => {
    expect(html(<Instructions text="Just one step" />)).toBe('<p class="small">Just one step</p>');
    expect(html(<Instructions text="" />)).toBe('');
  });
});

describe('settings tabs (static render)', () => {
  const tls: TlsStatus = {
    mode: 'auto',
    source: 'self-signed',
    subject: '203.0.113.7',
    notAfter: '2027-10-11T00:00:00Z',
    fingerprint256: 'AB:CD:EF',
    publicIp: '203.0.113.7',
    lastError: 'HTTP-01 challenge failed: port 80 not reachable',
    nextRenewalAt: null,
  };

  it('HTTPS tab: fingerprint, guidance and last error', () => {
    const out = html(<HttpsTab tls={tls} onRefresh={noop} refreshing={false} />);
    expect(out).toContain('AB:CD:EF');
    expect(out).toContain('your browser will warn');
    expect(out).toContain('port 80 not reachable');
    expect(out).toContain('Never forward 1935');
    expect(out).toContain('PUBLIC_HOST');
    expect(out).toContain('TLS_MODE=off');
  });

  it('General tab shows the current values', () => {
    const data: SettingsResponse = {
      settings: { publicBaseUrl: 'https://203.0.113.7', ingestHost: '192.168.1.20', disconnectGraceSec: 15 },
      tls,
      version: '1.2.3',
    };
    const out = html(<GeneralTab data={data} onSaved={noop} />);
    expect(out).toContain('value="https://203.0.113.7"');
    expect(out).toContain('value="192.168.1.20"');
    expect(out).toContain('value="15"');
  });

  it('About tab shows the version', () => {
    expect(html(<AboutTab version="1.2.3" />)).toContain('1.2.3');
  });
});

describe('Settings → API (static render)', () => {
  const NOW = Date.parse('2026-10-14T12:00:00Z');
  const token: ApiTokenInfo = {
    id: 't1',
    name: 'CTD Overlay',
    scopes: ['status:read', 'chat:read'],
    profileId: null,
    prefix: 'ctd_pat_3fK9',
    createdAt: '2026-10-01T10:00:00Z',
    createdBy: 'admin',
    lastUsedAt: '2026-10-14T09:00:00Z',
  };
  const access: ApiAccessInfo = {
    baseUrl: 'https://203.0.113.7/api/v1',
    lanBaseUrl: 'http://192.168.1.20:30080/api/v1',
    tlsFingerprint256: 'AB:CD:EF:01',
    openApiUrl: 'https://203.0.113.7/api/v1/openapi.json',
  };
  const secret = 'ctd_pat_3fK9wQ1vSECRETSECRETSECRETSECRETSECRETxx';
  const asyncNoop = async () => undefined;
  const profile = (id: string, name: string, color: string | null): ProfileSummary => ({
    id,
    name,
    slug: name.toLowerCase(),
    color,
    createdAt: '2026-10-01T10:00:00Z',
    updatedAt: '2026-10-01T10:00:00Z',
    status: 'offline',
    startedAt: null,
    testMode: false,
    destinations: 0,
    live: 0,
    down: 0,
  });
  const profiles = [profile('default', 'Miami or Bust', '#3B82F6'), profile('club', 'DPRTMNT', '#E11D48')];
  const pairing: PairingRequest = {
    id: 'pr1',
    appName: 'CTD OBS plugin (Studio PC)',
    kind: 'ctd-obs-plugin',
    code: 'KQ7-2MX',
    requestedScopes: ['status:read', 'chat:read', 'ingest:read'],
    requestedProfileId: null,
    ip: '192.168.1.30',
    createdAt: '2026-10-14T11:59:00Z',
    expiresAt: '2026-10-14T12:10:00Z',
  };

  it('lists tokens with scopes, prefix, dates and a two-step revoke', () => {
    const out = html(<TokensCard tokens={[token]} now={NOW} onNew={noop} onRevoke={asyncNoop} />);
    expect(out).toContain('CTD Overlay');
    expect(out.indexOf('chat:read')).toBeLessThan(out.indexOf('status:read'));
    expect(out).toContain('ctd_pat_3fK9…');
    expect(out).toContain('by admin');
    expect(out).toContain('Last used 3 hours ago');
    expect(out).toContain('Revoke');
    expect(out).toContain('New token');
    expect(html(<TokensCard tokens={[{ ...token, lastUsedAt: null }]} now={NOW} onNew={noop} onRevoke={asyncNoop} />)).toContain('Never used');
    expect(html(<TokensCard tokens={[]} now={NOW} onNew={noop} onRevoke={asyncNoop} />)).toContain('No tokens yet');
  });

  it('new token form: name, profile and a checkbox per scope (read-only basics checked)', () => {
    const out = html(<NewTokenForm onCreated={noop} onCancel={noop} />);
    expect(out.match(/type="checkbox"/g)).toHaveLength(7);
    // Only chat:read and status:read start checked; stream keys, the hub and OBS access are opt-in.
    expect(out.match(/type="checkbox" checked=""/g)).toHaveLength(2);
    for (const s of ['chat:read', 'status:read', 'ingest:read', 'apps:read', 'apps:write', 'obs:write', 'obs:control']) expect(out).toContain(s);
    expect(out).toContain('maxLength="60"');
    expect(out).toContain('Create token');
    expect(out).toContain('Profile');
    expect(out).toContain('Every profile');
  });

  it('new token form: the profile on screen is preselected, with every profile as an option', () => {
    const out = html(<NewTokenForm profiles={profiles} defaultProfileId="club" onCreated={noop} onCancel={noop} />);
    expect(out).toMatch(/<option value="club" selected="">DPRTMNT<\/option>/);
    expect(out).toContain('<option value="default">Miami or Bust</option>');
    expect(out).toContain('<option value="*">Every profile</option>');
    // A profile that no longer exists falls back to every profile.
    const gone = html(<NewTokenForm profiles={profiles} defaultProfileId="gone" onCreated={noop} onCancel={noop} />);
    expect(gone).toMatch(/<option value="\*" selected="">Every profile<\/option>/);
  });

  it('token list shows which profile each token is limited to', () => {
    const tokens: ApiTokenInfo[] = [
      { ...token, id: 't1', name: 'Old token', profileId: null },
      { ...token, id: 't2', name: 'Club overlay', profileId: 'club' },
      { ...token, id: 't3', name: 'Orphan', profileId: 'gone' },
    ];
    const out = html(<TokensCard tokens={tokens} profiles={profiles} now={NOW} onNew={noop} onRevoke={asyncNoop} />);
    expect(out).toContain('Every profile');
    expect(out).toContain('Profile: DPRTMNT');
    expect(out).toContain('Profile: Deleted profile');
    expect(out).toContain('background:#E11D48');
  });

  it('pending pairing: app, code, requested access, and the approve form for a single request', () => {
    const out = html(
      <PairingsCard pending={[pairing]} loaded profiles={profiles} now={NOW} onApprove={asyncNoop} onDeny={asyncNoop} />,
    );
    expect(out).toContain('An app wants to connect');
    expect(out).toContain('CTD OBS plugin (Studio PC)');
    expect(out).toContain('ctd-obs-plugin');
    expect(out).toContain('KQ7-2MX');
    expect(out).toContain('Asks for every profile');
    expect(out).toContain('From 192.168.1.30');
    expect(out).toContain('expires in 10 min');
    // One request: opened for review with what the app asked for.
    expect(out).toContain('Approve');
    expect(out).toContain('Deny');
    expect(out).toContain('value="CTD OBS plugin (Studio PC)"');
    expect(out).toMatch(/<option value="\*" selected="">Every profile<\/option>/);
    expect(out.match(/type="checkbox" checked=""/g)).toHaveLength(3);
    expect(out.match(/requested/g)?.length).toBeGreaterThanOrEqual(3);
    expect(out).toContain('read the OBS stream keys of every profile');
  });

  it('several pairings: a compact row each; nothing at all when none are pending', () => {
    const second = { ...pairing, id: 'pr2', appName: 'CTD Overlay', kind: 'ctd-overlay', code: 'ZZ4-9PQ', requestedScopes: ['chat:read' as const] };
    const out = html(<PairingsCard pending={[pairing, second]} loaded profiles={profiles} now={NOW} onApprove={asyncNoop} onDeny={asyncNoop} />);
    expect(out).toContain('2 apps want to connect');
    expect(out).toContain('ZZ4-9PQ');
    expect(out.match(/>Review</g)).toHaveLength(2);
    expect(out).not.toContain('Approve');
    // The app's approve link opens that request.
    const focused = html(
      <PairingsCard pending={[pairing, second]} loaded profiles={profiles} now={NOW} focusId="pr2" onApprove={asyncNoop} onDeny={asyncNoop} />,
    );
    expect(focused.match(/>Review</g)).toHaveLength(1);
    expect(focused).toContain('Approve');
    expect(html(<PairingsCard pending={[]} loaded profiles={profiles} now={NOW} onApprove={asyncNoop} onDeny={asyncNoop} />)).toBe('');
    const handled = html(<PairingsCard pending={[]} loaded profiles={profiles} now={NOW} focusId="old" onApprove={asyncNoop} onDeny={asyncNoop} />);
    expect(handled).toContain('expired or was already handled');
  });

  it('approve form: a profile-limited request starts on that profile', () => {
    const out = html(
      <ApprovePairingForm
        pairing={{ ...pairing, requestedProfileId: 'club', requestedScopes: ['chat:read'] }}
        profiles={profiles}
        onApprove={asyncNoop}
        onDeny={asyncNoop}
        onCancel={noop}
      />,
    );
    expect(out).toMatch(/<option value="club" selected="">DPRTMNT<\/option>/);
    expect(out.match(/type="checkbox" checked=""/g)).toHaveLength(1);
    expect(out).not.toContain('OBS stream keys of');
    expect(out).toContain('only ever sees this profile');
  });

  it('connected apps: presence, profile, resources grouped by profile, remove', () => {
    const apps: ConnectedApp[] = [
      {
        id: 'ctd-overlay',
        name: 'CTD Overlay',
        kind: 'ctd-overlay',
        version: '1.4.0',
        baseUrl: 'http://10.20.30.40:30200',
        capabilities: ['overlays', 'overlay.create'],
        resources: [
          { type: 'overlay', id: 'ovl_h', name: 'DPRTMNT takeover — landscape', profileId: 'club', url: 'http://h/o/1' },
          { type: 'overlay', id: 'ovl_v', name: 'DPRTMNT takeover — vertical', profileId: 'club', url: 'http://h/o/2' },
          { type: 'overlay', id: 'ovl_m', name: 'Chat box', profileId: 'default', url: 'http://h/o/3' },
        ],
        tokenId: 't1',
        profileId: null,
        registeredAt: '2026-10-14T10:00:00Z',
        lastSeenAt: '2026-10-14T11:59:30Z',
        online: true,
      },
      {
        id: 'ctd-obs-plugin-studio',
        name: 'CTD OBS plugin',
        kind: 'ctd-obs-plugin',
        version: null,
        baseUrl: 'javascript:alert(1)',
        capabilities: [],
        resources: [],
        tokenId: 't2',
        profileId: 'club',
        registeredAt: '2026-10-14T10:00:00Z',
        lastSeenAt: '2026-10-14T11:50:00Z',
        online: false,
      },
    ];
    const out = html(<ConnectedAppsCard apps={apps} profiles={profiles} now={NOW} onRemove={asyncNoop} />);
    expect(out).toContain('CTD Overlay');
    expect(out).toContain('v1.4.0');
    expect(out).toContain('Online');
    expect(out).toContain('Offline · last seen 10 min ago');
    expect(out).toContain('href="http://10.20.30.40:30200/"');
    expect(out).not.toContain('javascript:');
    // Default profile first, then DPRTMNT.
    expect(out.indexOf('Miami or Bust:')).toBeLessThan(out.indexOf('DPRTMNT:'));
    expect(out).toContain('2 overlays');
    expect(out).toContain('DPRTMNT takeover — landscape, DPRTMNT takeover — vertical');
    expect(out.indexOf('CTD Overlay')).toBeLessThan(out.indexOf('CTD OBS plugin')); // online first
    expect(out.match(/>Remove</g)).toHaveLength(2);
    expect(html(<ConnectedAppsCard apps={[]} profiles={profiles} now={NOW} onRemove={asyncNoop} />)).toContain('No apps connected yet');
    expect(html(<ConnectedAppsCard apps={null} profiles={profiles} now={NOW} error="Nope" onRemove={asyncNoop} />)).toContain('Nope');
  });

  it('OBS dock: one link per profile when there are several', () => {
    const out = html(
      <DockCard access={access} profiles={profiles} profileValue="club" onProfileChange={noop} created={null} busy={false} onCreate={noop} />,
    );
    expect(out).toMatch(/<option value="club" selected="">DPRTMNT<\/option>/);
    expect(out).not.toContain('Every profile');
    expect(out).toContain('OBS dock — DPRTMNT');
    expect(out).toContain('DPRTMNT only');
    const single = html(<DockCard access={access} profiles={[profiles[0]!]} profileValue="default" onProfileChange={noop} created={null} busy={false} onCreate={noop} />);
    expect(single).not.toContain('<select');
  });

  it('shows a new secret once, masked, with a clear warning', () => {
    const out = html(<TokenSecret created={{ token, secret }} access={access} onDone={noop} />);
    expect(out).toContain("you won&#x27;t see it again");
    expect(out).not.toContain(secret);
    expect(out).toContain('Copy');
    expect(out).toContain('Show');
    expect(out).toContain('http://192.168.1.20:30080/api/v1');
  });

  it('OBS dock: one button, then the dock URL (masked) and the OBS steps', () => {
    const before = html(<DockCard access={access} created={null} busy={false} onCreate={noop} />);
    expect(before).toContain('Create dock link');
    expect(before).toContain('Custom Browser Docks');
    expect(before).not.toContain('Dock URL');
    const after = html(<DockCard access={access} created={{ token: { ...token, name: 'OBS dock' }, secret }} busy={false} onCreate={noop} />);
    expect(after).toContain('Dock URL');
    expect(after).not.toContain(secret);
    expect(after).toContain("LAN address");
    expect(after).toContain('Create another dock link');
  });

  it('without a LAN address: a hint, and the HTTPS base for the dock', () => {
    const noLan = { ...access, lanBaseUrl: null };
    const dock = html(<DockCard access={noLan} created={{ token, secret }} busy={false} onCreate={noop} />);
    expect(dock).toContain('LAN_HTTP_HOST');
    expect(dock).toContain('192.168.x.x:30443');
    expect(dock).toContain('Uses the HTTPS address');
    const conn = html(<AccessCard access={noLan} />);
    expect(conn).toContain('LAN_HTTP_HOST');
    expect(conn).not.toContain('On your network (LAN)');
  });

  it('connection details: both URLs, fingerprint and OpenAPI with copy buttons', () => {
    const out = html(<AccessCard access={access} />);
    expect(out).toContain('value="http://192.168.1.20:30080/api/v1"');
    expect(out).toContain('value="https://203.0.113.7/api/v1"');
    expect(out).toContain('value="AB:CD:EF:01"');
    expect(out).toContain('value="https://203.0.113.7/api/v1/openapi.json"');
    expect(out).toContain('href="https://203.0.113.7/api/v1/openapi.json"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out.match(/>Copy</g)?.length).toBe(4);
    const unsafe = html(<AccessCard access={{ ...access, openApiUrl: 'javascript:alert(1)' }} />);
    expect(unsafe).not.toContain('href="javascript:');
  });
});
