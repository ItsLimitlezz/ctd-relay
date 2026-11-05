import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IngestInfo } from '@shared/api';
import type { ProfileSummary } from '@shared/types';
import { ProfileTag } from '../components/ProfileBadge';
import { LiveProfilesIndicator, ProfileSwitcherView } from '../components/ProfileSwitcher';
import { AuthProvider } from '../state/auth';
import { ProfileContext, STATIC_PROFILE_CONTEXT, type ProfileContextValue } from '../state/profile';
import { ColorPicker, ProfileForm, ProfilesList } from './ProfilesPage';
import { IngestCard } from './settings/ObsTab';

const html = (el: ReactElement) => renderToStaticMarkup(el);
const noop = () => undefined;
const asyncNoop = async () => undefined;

const summary = (id: string, name: string, over: Partial<ProfileSummary> = {}): ProfileSummary => ({
  id,
  name,
  slug: id === 'default' ? 'main' : name.toLowerCase(),
  color: null,
  createdAt: '2026-10-15T14:00:00Z',
  updatedAt: '2026-10-15T14:00:00Z',
  status: 'offline',
  startedAt: null,
  testMode: false,
  destinations: 0,
  live: 0,
  down: 0,
  ...over,
});

const main = summary('default', 'Miami or Bust', { color: '#3B82F6', destinations: 4 });
const club = summary('club', 'DPRTMNT', { color: '#E11D48', destinations: 3 });

const withProfiles = (value: Partial<ProfileContextValue>, el: ReactElement) =>
  html(
    <AuthProvider>
      <ProfileContext.Provider value={{ ...STATIC_PROFILE_CONTEXT, ...value }}>{el}</ProfileContext.Provider>
    </AuthProvider>,
  );

describe('profiles page (static render)', () => {
  it('lists each profile with colour, status, counts, OBS key prefix and set-up links', () => {
    const live = { ...club, status: 'live' as const, live: 3, testMode: true };
    const out = html(<ProfilesList profiles={[main, live]} currentId="default" onSwitch={noop} onEdit={noop} onDelete={asyncNoop} />);
    expect(out).toContain('Miami or Bust');
    expect(out).toContain('DPRTMNT');
    expect(out).toContain('background:#E11D48');
    expect(out).toContain('Default');
    expect(out).toContain('On screen');
    expect(out).toContain('LIVE');
    expect(out).toContain('Test mode');
    expect(out).toContain('3 destinations enabled · 3 live');
    expect(out).toContain('landscape?key=…');
    expect(out).toContain('dprtmnt/landscape?key=…');
    expect(out).toContain('href="/accounts?profile=club"');
    expect(out).toContain('href="/settings?tab=obs&amp;profile=club"');
    // Only the other profile can be switched to.
    expect(out.match(/>Switch to</g)).toHaveLength(1);
  });

  it('delete is disabled with the reason for the default profile and while live', () => {
    const out = html(
      <ProfilesList profiles={[main, { ...club, status: 'live' }]} currentId="default" onSwitch={noop} onEdit={noop} onDelete={asyncNoop} />,
    );
    expect(out.match(/aria-label="Delete [^"]+"[^>]*disabled=""|disabled=""[^>]*aria-label="Delete [^"]+"/g)).toHaveLength(2);
    expect(out).toContain('default profile can');
    expect(out).toContain('End this profile’s stream before deleting it.');
    const offline = html(<ProfilesList profiles={[main, club]} currentId="club" onSwitch={noop} onEdit={noop} onDelete={asyncNoop} />);
    expect(offline.match(/disabled=""/g)).toHaveLength(1);
  });

  it('create form: name, colour swatches and the OBS key hint', () => {
    const out = html(<ProfileForm existing={null} suggestedColor="#E11D48" onSaved={noop} onCancel={noop} />);
    expect(out).toContain('maxLength="60"');
    expect(out).toContain('Create profile');
    expect(out).toContain('own OBS stream keys');
    expect(out.match(/type="radio"/g)).toHaveLength(9); // no colour + 8 swatches
    expect(out).toContain('type="color"');
  });

  it('edit form: renaming keeps the OBS keys', () => {
    const out = html(<ProfileForm existing={club} suggestedColor="#3B82F6" onSaved={noop} onCancel={noop} />);
    expect(out).toContain('value="DPRTMNT"');
    expect(out).toContain('dprtmnt/landscape?key=…');
    expect(out).toContain('Save');
    const def = html(<ProfileForm existing={main} suggestedColor="#3B82F6" onSaved={noop} onCancel={noop} />);
    expect(def).toContain('original OBS stream keys');
  });

  it('colour picker marks the chosen swatch or the custom colour', () => {
    expect(html(<ColorPicker value="#E11D48" onChange={noop} />).match(/checked=""/g)).toHaveLength(1);
    const custom = html(<ColorPicker value="#123456" onChange={noop} />);
    expect(custom).not.toContain('checked=""');
    expect(custom).toContain('swatch-custom is-checked');
    expect(custom).toContain('value="#123456"');
    expect(html(<ColorPicker value={null} onChange={noop} />)).toMatch(/<input type="radio"[^>]*checked=""/);
  });
});

describe('profile switcher + tags (static render)', () => {
  it('shows the current profile with its colour; the menu lists every profile with live status', () => {
    const closed = html(<ProfileSwitcherView profiles={[main, club]} currentId="club" canManage onSelect={noop} />);
    expect(closed).toContain('DPRTMNT');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('role="menu"');

    const open = html(
      <ProfileSwitcherView
        profiles={[{ ...main, status: 'live' }, { ...club, status: 'live', testMode: true }]}
        currentId="club"
        canManage
        onSelect={noop}
        defaultOpen
      />,
    );
    expect(open).toContain('role="menu"');
    expect(open).toContain('2 live: Miami or Bust · DPRTMNT');
    expect(open.match(/role="menuitemradio"/g)).toHaveLength(2);
    expect(open).toMatch(/aria-checked="true"[^>]*>.*DPRTMNT/);
    expect(open).toContain('test mode');
    expect(open).toContain('href="/profiles"');
    expect(open).toContain('Manage profiles');
    // Operators can switch but not manage.
    expect(html(<ProfileSwitcherView profiles={[main, club]} currentId="club" canManage={false} onSelect={noop} defaultOpen />)).not.toContain(
      'Manage profiles',
    );
  });

  it('marks the switcher when another profile is live', () => {
    const out = html(<ProfileSwitcherView profiles={[main, { ...club, status: 'live' }]} currentId="default" canManage onSelect={noop} />);
    expect(out).toContain('profile-button-live');
    expect(out).toContain('DPRTMNT is live');
    expect(html(<ProfileSwitcherView profiles={[main, club]} currentId="default" canManage onSelect={noop} />)).not.toContain('profile-button-live');
  });

  it('header pill: every live profile, only when one is not on screen or several are live', () => {
    const both = [
      { ...main, status: 'live' as const },
      { ...club, status: 'live' as const },
    ];
    const out = withProfiles({ profiles: both, profileId: 'default', current: both[0] }, <LiveProfilesIndicator />);
    expect(out).toContain('2 live: Miami or Bust · DPRTMNT');
    // Compact form "● 2" on phones: the word is a separate span the phone CSS hides; the pill is never hidden.
    expect(out).toContain('<span class="live-summary-short">2<span class="live-summary-word"> live</span></span>');
    const onlyCurrent = [main, { ...club, status: 'live' as const }];
    expect(withProfiles({ profiles: onlyCurrent, profileId: 'club', current: onlyCurrent[1] }, <LiveProfilesIndicator />)).toBe('');
    expect(withProfiles({ profiles: onlyCurrent, profileId: 'default', current: main }, <LiveProfilesIndicator />)).toContain('DPRTMNT is live');
  });

  it('"Profile: <name>" tag on scoped pages', () => {
    const out = withProfiles({ profiles: [main, club], profileId: 'club', current: club }, <ProfileTag />);
    expect(out).toContain('Profile:');
    expect(out).toContain('DPRTMNT');
    expect(out).toContain('background:#E11D48');
    // Before the list loads it still names the profile.
    expect(withProfiles({}, <ProfileTag />)).toContain('Main');
  });
});

describe('OBS setup per profile (static render)', () => {
  const info = (profileId: string, prefix: string): IngestInfo => ({
    profileId,
    serverUrl: 'rtmp://10.20.30.40:1936/live',
    feeds: [
      { feed: 'landscape', streamKey: `${prefix}landscape?key=abc`, fullUrl: `rtmp://10.20.30.40:1936/live/${prefix}landscape?key=abc` },
      { feed: 'vertical', streamKey: `${prefix}vertical?key=def`, fullUrl: `rtmp://10.20.30.40:1936/live/${prefix}vertical?key=def` },
    ],
  });

  it("names the profile and says each profile needs its own OBS output", () => {
    const out = withProfiles(
      { profiles: [main, club], profileId: 'club', current: club },
      <IngestCard info={info('club', 'dprtmnt/')} profile={club} profileCount={2} rotating={null} onRotate={asyncNoop} />,
    );
    expect(out).toContain('Stream to DPRTMNT');
    expect(out).toContain('Each profile has its own stream keys');
    expect(out).not.toContain('original keys');
    expect(out).toContain('value="rtmp://10.20.30.40:1936/live"');
    expect(out).not.toContain('key=abc'); // masked
  });

  it('the default profile keeps its original keys; one profile needs no explanation', () => {
    const def = withProfiles(
      { profiles: [main, club], profileId: 'default', current: main },
      <IngestCard info={info('default', '')} profile={main} profileCount={2} rotating={null} onRotate={asyncNoop} />,
    );
    expect(def).toContain('These are your original keys');
    const single = withProfiles({}, <IngestCard info={info('default', '')} profile={null} profileCount={1} rotating={null} onRotate={asyncNoop} />);
    expect(single).toContain('Stream to this server');
    expect(single).not.toContain('Each profile has its own stream keys');
  });
});
