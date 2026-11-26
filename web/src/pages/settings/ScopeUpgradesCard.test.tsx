import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProfileSummary, ScopeUpgradeRequest } from '@shared/types';
import { scopeUpgradeBannerText } from '../../state/hub';
import { API_SCOPE_INFO } from './settings-helpers';
import { ScopeUpgradesCard } from './ScopeUpgradesCard';

const NOW = Date.parse('2026-11-26T03:00:00.000Z');
const asyncNoop = async () => undefined;
const profiles = [{ id: 'club', name: 'DPRTMNT' }] as unknown as ProfileSummary[];

const upgrade: ScopeUpgradeRequest = {
  id: 'up1',
  tokenId: 'tok1',
  tokenName: 'CTD OBS plugin',
  tokenPrefix: 'ctd_pat_3fK9',
  profileId: 'club',
  appName: 'CTD OBS plugin (Studio PC)',
  kind: 'ctd-obs-plugin',
  currentScopes: ['status:read'],
  adding: ['show:read', 'feeds:watch'],
  reason: `Live preview in the dock <script>${'x'.repeat(300)}`,
  createdAt: '2026-11-26T03:00:00.000Z',
  expiresAt: '2026-11-26T03:10:00.000Z',
};

describe('ScopeUpgradesCard', () => {
  it('names the app, lists the scopes by label, tags sensitive ones and quotes the reason', () => {
    const out = renderToStaticMarkup(
      <ScopeUpgradesCard pending={[upgrade]} loaded profiles={profiles} now={NOW} onApprove={asyncNoop} onDeny={asyncNoop} />,
    );
    expect(out).toContain('An app asks for more permissions');
    expect(out).toContain('CTD OBS plugin (Studio PC)');
    expect(out).toContain(API_SCOPE_INFO['show:read'].label);
    expect(out).toContain(API_SCOPE_INFO['feeds:watch'].label);
    // Only feeds:watch is sensitive, with its reason.
    expect(out.match(/>Sensitive</g)).toHaveLength(1);
    expect(out).toContain('Lets the app watch the live video, with sound.');
    expect(out).toContain('Only DPRTMNT');
    expect(out).toContain('ctd_pat_3fK9…');
    // The reason is the app's own text: escaped, quoted and cut short.
    expect(out).toContain('“Live preview in the dock &lt;script&gt;');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('x'.repeat(200));
    expect(out).toContain('Approve');
    expect(out).toContain('Deny');
  });

  it('every-profile tokens say so; nothing pending shows nothing', () => {
    const out = renderToStaticMarkup(
      <ScopeUpgradesCard pending={[{ ...upgrade, profileId: null, reason: null }]} loaded profiles={profiles} now={NOW} onApprove={asyncNoop} onDeny={asyncNoop} />,
    );
    expect(out).toContain('Every profile');
    expect(out).not.toContain('The app says');
    expect(renderToStaticMarkup(<ScopeUpgradesCard pending={[]} loaded profiles={profiles} now={NOW} onApprove={asyncNoop} onDeny={asyncNoop} />)).toBe('');
    expect(scopeUpgradeBannerText([upgrade])).toBe('CTD OBS plugin (Studio PC) asks for more permissions.');
  });
});
