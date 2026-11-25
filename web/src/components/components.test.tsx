import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatMessage, FieldSpec } from '@shared/types';
import { LINKS_MAX } from '@shared/types';
import { AlertToggle, alertsEnabledMessage } from './AlertToggle';
import { Badge } from './Badge';
import { Button } from './Button';
import { ChatLog, countNewMessages } from './ChatLog';
import { ConfirmButton } from './ConfirmButton';
import { CopyField } from './CopyField';
import { DynamicForm } from './DynamicForm';
import { EmptyState } from './EmptyState';
import { Field } from './Field';
import { LinksEditor } from './LinksEditor';
import { PhaseBadge, PHASE_META } from './PhaseBadge';
import { PlatformBadge, platformMeta } from './PlatformBadge';
import { Tabs } from './Tabs';
import { TextInput } from './TextInput';
import { Toggle } from './Toggle';
import { safeHexColor, safeHttpUrl } from './utils';
import { readersText, srtPullStepsText } from './PullLink';
import { SrtLatencyNote, SrtUnavailable } from './SrtInfo';

const html = (el: ReactElement) => renderToStaticMarkup(el);

describe('components (static render)', () => {
  it('Button: variants and loading state', () => {
    const out = html(
      <Button variant="danger" size="sm" loading>
        Delete
      </Button>,
    );
    expect(out).toContain('btn btn-danger btn-sm');
    expect(out).toContain('disabled=""');
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('type="button"');
  });

  it('Field wires label, help and error to the control', () => {
    const out = html(
      <Field label="Name" id="name" help="Your name" error="Required">
        <TextInput value="" readOnly />
      </Field>,
    );
    expect(out).toContain('for="name"');
    expect(out).toContain('id="name"');
    expect(out).toContain('aria-describedby="name-error name-help"');
    expect(out).toContain('aria-invalid="true"');
  });

  it('Toggle renders an accessible switch', () => {
    const out = html(<Toggle checked onChange={() => undefined} aria-label="Enable" />);
    expect(out).toContain('role="switch"');
    expect(out).toContain('aria-checked="true"');
    expect(out).toContain('aria-label="Enable"');
    expect(out).not.toContain('aria-labelledby');
    // With a visible label the switch is named by it explicitly.
    const labelled = html(<Toggle checked={false} onChange={() => undefined} label="Test mode" />);
    const id = /<span id="([^"]+)">Test mode<\/span>/.exec(labelled)?.[1];
    expect(id).toBeTruthy();
    expect(labelled).toContain(`aria-labelledby="${id}"`);
  });

  it('PlatformBadge uses brand colors and initials', () => {
    const out = html(<PlatformBadge platform="kick" withName />);
    expect(out).toContain('background:#53FC18');
    expect(out).toContain('>K<');
    expect(out).toContain('Kick');
    expect(platformMeta('twitch').color).toBe('#9146FF');
    expect(platformMeta('mystery').name).toBe('mystery');
  });

  it('PhaseBadge covers every phase', () => {
    expect(html(<PhaseBadge phase="live" />)).toContain('tone-live');
    expect(html(<PhaseBadge phase="error" />)).toContain('Error');
    expect(Object.keys(PHASE_META)).toHaveLength(11);
  });

  it('PhaseBadge: recovering is an animated warning', () => {
    expect(PHASE_META.recovering).toEqual({ label: 'Recovering', tone: 'warn', pulse: true });
    const out = html(<PhaseBadge phase="recovering" />);
    expect(out).toContain('tone-warn');
    expect(out).toContain('Recovering');
    expect(out).toContain('dot-pulse');
  });

  it('Badge, EmptyState and Tabs render', () => {
    expect(html(<Badge tone="success" dot>On</Badge>)).toContain('badge tone-success');
    expect(html(<EmptyState title="Nothing" description="Here" />)).toContain('Nothing');
    const tabs = html(<Tabs tabs={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]} value="b" onChange={() => undefined} idPrefix="t" />);
    expect(tabs).toContain('role="tablist"');
    expect(tabs).toMatch(/id="t-tab-b"[^>]*aria-selected="true"|aria-selected="true"[^>]*id="t-tab-b"/);
  });

  it('ConfirmButton starts unarmed', () => {
    const out = html(<ConfirmButton onConfirm={() => undefined}>End stream</ConfirmButton>);
    expect(out).toContain('End stream');
    expect(out).not.toContain('Click again');
  });

  it('CopyField masks secrets until revealed', () => {
    const out = html(<CopyField value="live_abc123" secret />);
    expect(out).not.toContain('live_abc123');
    expect(out).toContain('Show');
    expect(html(<CopyField value="rtmp://host/live" />)).toContain('rtmp://host/live');
  });

  it('DynamicForm renders every field type and hides stored secrets', () => {
    const fields: FieldSpec[] = [
      { key: 'server', label: 'Server', type: 'url', required: true },
      { key: 'key', label: 'Stream key', type: 'secret', required: true },
      { key: 'mode', label: 'Mode', type: 'select', options: [{ value: 'a', label: 'Alpha' }] },
      { key: 'on', label: 'Enabled', type: 'boolean' },
      { key: 'n', label: 'Count', type: 'number' },
      { key: 't', label: 'Text', type: 'text', help: 'Some help' },
    ];
    const out = html(
      <DynamicForm
        fields={fields}
        values={{ server: 'rtmp://x/y', mode: 'a', on: true, n: 3, t: 'hello' }}
        onChange={() => undefined}
        secretsSet={{ key: true }}
        errors={{ server: 'Bad URL' }}
        idPrefix="f"
      />,
    );
    expect(out).toContain('type="url"');
    expect(out).toContain('value="rtmp://x/y"');
    expect(out).toContain('•••• set');
    expect(out).toContain('Change');
    expect(out).toContain('Alpha');
    expect(out).toContain('role="switch"');
    expect(out).toContain('value="3"');
    expect(out).toContain('Some help');
    expect(out).toContain('Bad URL');
    expect(out).toContain('id="f-server"');

    // Without a stored value the secret is a password input that password managers should ignore.
    const fresh = html(<DynamicForm fields={fields.slice(1, 2)} values={{}} onChange={() => undefined} />);
    expect(fresh).toContain('type="password"');
    expect(fresh).toMatch(/autocomplete="new-password"/i);
    expect(fresh).toContain('data-1p-ignore="true"');
  });

  it("DynamicForm renders a 'links' field as an ordered list editor", () => {
    const fields: FieldSpec[] = [
      { key: 'links', label: 'Links', type: 'links', help: 'One link per live' },
      { key: 'linkMode', label: 'Link mode', type: 'select', options: [{ value: 'rotate', label: 'Rotate' }], default: 'rotate' },
    ];
    const out = html(
      <DynamicForm
        fields={fields}
        values={{
          links: [
            { title: 'Kick - Live Stream', url: 'https://kick.com/dprtmnttoronto' },
            { title: 'Twitch - Live Stream', url: 'https://www.twitch.tv/dprtmnttoronto' },
          ],
          linkMode: 'rotate',
        }}
        onChange={() => undefined}
        idPrefix="dest-instagram"
      />,
    );
    expect(out).toContain('role="group"');
    expect(out).toContain('id="dest-instagram-links-label"');
    expect(out).toContain('value="Kick - Live Stream"');
    expect(out).toContain('value="https://www.twitch.tv/dprtmnttoronto"');
    expect(out).toContain('id="dest-instagram-links-2-url"');
    expect(out).toContain('aria-label="Move link 1 up"');
    expect(out).toContain('aria-label="Remove link 2"');
    expect(out).toContain('One link per live');
    expect(out).toContain('Add link');
    expect(out).toContain('2 of 20');
    expect(out).toContain('Rotate');

    // A non-array value (e.g. an old string option) renders as an empty list.
    expect(html(<DynamicForm fields={fields.slice(0, 1)} values={{ links: 'x' }} onChange={() => undefined} />)).toContain('No links yet.');
  });

  it('LinksEditor: move buttons at the ends are disabled, rows show their errors with the field error', () => {
    const rows = [
      { title: 'A', url: 'https://a.example' },
      { title: '', url: 'ftp://b.example' },
    ];
    const out = html(<LinksEditor id="l" label="Links" value={rows} onChange={() => undefined} error="Link 2: Title is required" />);
    expect(out).toMatch(/aria-label="Move link 1 up"[^>]*disabled=""|disabled=""[^>]*aria-label="Move link 1 up"/);
    expect(out).toMatch(/aria-label="Move link 2 down"[^>]*disabled=""|disabled=""[^>]*aria-label="Move link 2 down"/);
    expect(out).not.toMatch(/aria-label="Move link 1 down"[^>]*disabled=""/);
    expect(out).toContain('Link 2: Title is required');
    expect(out).toContain('id="l-2-title-error"');
    expect(out).toContain('URL must start with http:// or https://');
    expect(out).toContain('link-row is-invalid');
    expect(out).toContain('aria-describedby="l-error"');

    // Without a field error (not submitted yet) rows aren't flagged.
    const clean = html(<LinksEditor id="l" label="Links" value={rows} onChange={() => undefined} />);
    expect(clean).not.toContain('is-invalid');
    expect(clean).not.toContain('aria-invalid');
  });

  it('LinksEditor: "Add link" is disabled at the maximum', () => {
    const full = Array.from({ length: LINKS_MAX }, (_, i) => ({ title: `L${i}`, url: `https://e.example/${i}` }));
    const out = html(<LinksEditor id="l" label="Links" value={full} onChange={() => undefined} />);
    expect(out).toMatch(/disabled=""[^>]*>(<svg[\s\S]*?<\/svg>)?Add link/);
    expect(out).toContain(`Maximum of ${LINKS_MAX} links`);
    expect(html(<LinksEditor id="l" label="Links" value={[]} onChange={() => undefined} />)).not.toMatch(/disabled=""[^>]*>(<svg[\s\S]*?<\/svg>)?Add link/);
  });

  it('AlertToggle: off by default; the confirmation explains missing notifications', () => {
    const out = html(<AlertToggle />);
    expect(out).toContain('Alert me');
    expect(out).toContain('role="switch"');
    expect(out).toContain('aria-checked="false"');
    expect(alertsEnabledMessage('granted')).toEqual({ tone: 'success', message: expect.stringContaining('notification') });
    expect(alertsEnabledMessage('insecure')).toEqual({ tone: 'info', message: expect.stringMatching(/^Alerts on \(sound only\)\..*HTTPS/) });
    expect(alertsEnabledMessage('denied').message).toMatch(/blocked/);
    expect(alertsEnabledMessage('default').message).toMatch(/Allow notifications/);
    // Android without the service worker: no promise of a notification.
    const unavailable = alertsEnabledMessage('unavailable');
    expect(unavailable.tone).toBe('info');
    expect(unavailable.message).toMatch(/^Alerts on \(sound only\)\..*Pop-ups aren't available/);
    expect(unavailable.message).not.toMatch(/get a notification/);
  });

  it('ChatLog renders text as plain text (no HTML injection)', () => {
    const msg: ChatMessage = {
      id: '1',
      platform: 'youtube',
      destinationId: 'd',
      author: { name: '<b>bob</b>', color: 'red;background:url(x)', badges: ['mod'] },
      text: '<img src=x onerror=alert(1)>',
      ts: '2026-10-11T10:00:00.000Z',
      kind: 'message',
    };
    const out = html(<ChatLog messages={[msg]} />);
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('&lt;b&gt;bob&lt;/b&gt;');
    expect(out).not.toContain('url(x)');
    expect(out).toContain('mod');
    expect(html(<ChatLog messages={[]} emptyText="Quiet" />)).toContain('Quiet');
  });

  it('ChatLog: alert lines get a tag with the label and amount', () => {
    const superchat: ChatMessage = {
      id: 'yt:1',
      platform: 'youtube',
      destinationId: 'd',
      author: { name: 'Ann' },
      text: 'sent a Super Chat',
      ts: '2026-10-11T10:00:00.000Z',
      kind: 'event',
      alert: { kind: 'superchat', user: { name: 'Ann' }, amount: { unit: 'currency', value: '5.00', currency: 'USD' } },
    };
    const out = html(<ChatLog messages={[superchat]} />);
    expect(out).toContain('chat-msg is-event is-alert alert-superchat');
    expect(out).toContain('Super Chat');
    expect(out).toMatch(/<b class="chat-alert-amount">[^<]*5\.00<\/b>/);
    // A plain message with an alert field is not decorated.
    expect(html(<ChatLog messages={[{ ...superchat, kind: 'message' }]} />)).not.toContain('chat-alert-tag');
  });

  it('ChatLog: emotes render as images (https only), text stays text, /me is styled', () => {
    const msg: ChatMessage = {
      id: 'tw:1',
      platform: 'twitch',
      destinationId: 'd',
      author: { name: 'bob', color: '#ff0000' },
      text: '<b>hi</b> Kappa',
      ts: '2026-10-11T10:00:00.000Z',
      kind: 'message',
      action: true,
      fragments: [
        { type: 'text', text: '<b>hi</b> ' },
        { type: 'emote', text: 'Kappa', image: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0' },
      ],
    };
    const out = html(<ChatLog messages={[msg]} />);
    expect(out).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(out).toContain('<img class="chat-emote" src="https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0" alt="Kappa"');
    expect(out).toMatch(/referrerpolicy="no-referrer"/i);
    expect(out).toContain('is-action');
    expect(out).toContain('--author-color:#ff0000');
  });

  it('ChatLog counts new messages even when moderation removed the previous last one', () => {
    const at = (id: string, sec: number): ChatMessage => ({
      id,
      platform: 'kick',
      destinationId: 'd',
      author: { name: 'a' },
      text: id,
      ts: new Date(Date.UTC(2026, 9, 11, 10, 0, sec)).toISOString(),
      kind: 'message',
    });
    const list = [at('a', 1), at('b', 2), at('c', 3)];
    expect(countNewMessages(list, null)).toBe(3);
    expect(countNewMessages(list, { id: 'b', ts: Date.UTC(2026, 9, 11, 10, 0, 2) })).toBe(1);
    // 'c' was the last one and got deleted: nothing new.
    expect(countNewMessages(list.slice(0, 2), { id: 'c', ts: Date.UTC(2026, 9, 11, 10, 0, 3) })).toBe(0);
    // 'b' deleted, then 'd' arrived.
    expect(countNewMessages([at('a', 1), at('d', 4)], { id: 'b', ts: Date.UTC(2026, 9, 11, 10, 0, 2) })).toBe(1);
  });

  it('URL and color sanitizers', () => {
    expect(safeHttpUrl('https://twitch.tv/x')).toBe('https://twitch.tv/x');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('not a url')).toBeNull();
    expect(safeHexColor('#FF00aa')).toBe('#FF00aa');
    expect(safeHexColor('red')).toBeNull();
    expect(safeHexColor('#fff;background:url(x)')).toBeNull();
  });
});

describe('SRT pull link (docs/SRT.md)', () => {
  it('the copied steps say: untick Local File, paste into Input, Input Format mpegts', () => {
    const text = srtPullStepsText('Guest A', 'srt://relay.example.com:8890?streamid=read:guest/q7m2x9k4tb:key=k&latency=500000');
    expect(text).toContain('srt://relay.example.com:8890?streamid=read:guest/q7m2x9k4tb:key=k&latency=500000');
    expect(text).toContain('untick "Local File"');
    expect(text).toContain('"Input"');
    expect(text).toContain('mpegts');
    expect(text).toContain('150000'); // the LAN alternative
    expect(readersText({ readers: 0, maxReaders: 2 })).toBe('Nobody watching');
  });

  it('explains latency (microseconds, LAN vs internet) and says plainly when SRT is off', () => {
    const srt = { enabled: true, port: 8890, latencyMs: 500, lanLatencyMs: 150, reason: null };
    const note = renderToStaticMarkup(<SrtLatencyNote srt={srt} />);
    expect(note).toContain('latency=500000');
    expect(note).toContain('500 ms');
    expect(note).toContain('lower it');
    expect(note).toContain('latency=150000'); // LAN alternative
    expect(note).toContain('8890');
    const off = renderToStaticMarkup(<SrtUnavailable srt={{ ...srt, enabled: false, port: null, reason: 'UDP port 8890 is already in use on this machine.' }} />);
    expect(off).toContain('available on this server');
    expect(off).toContain('UDP port 8890 is already in use');
    expect(off).toContain('RTMP works as usual');
  });
});
