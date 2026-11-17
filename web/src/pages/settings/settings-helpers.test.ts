import { describe, expect, it } from 'vitest';
import type { TranscodeCapabilities } from '@shared/api';
import type { AuditEntry, FieldSpec } from '@shared/types';
import {
  apiSiteRoot,
  appendAudit,
  appFormValues,
  appSubmitValues,
  auditCursor,
  dockUrl,
  dockUrlFor,
  expiryTone,
  orderedScopes,
  transcodeSummary,
  validateTokenForm,
  fieldForMessage,
  generalChanges,
  generalDraft,
  hasErrors,
  instructionLines,
  overlayUrlWithParams,
  parseWholeNumber,
  relativeTime,
  settingsTab,
  tokenModalDismissible,
  tokenModalInitial,
  tokenModalReducer,
  type TokenModalAction,
  type TokenModalState,
  validateGeneral,
  validateNewUser,
  validatePassword,
} from './settings-helpers';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const settings = { publicBaseUrl: '', ingestHost: '', disconnectGraceSec: 15 };

describe('settings helpers', () => {
  it('reads the tab from the query', () => {
    expect(settingsTab('apps')).toBe('apps');
    expect(settingsTab('api')).toBe('api');
    expect(settingsTab('nope')).toBe('general');
    expect(settingsTab(null)).toBe('general');
  });

  it('splits instructions and drops existing numbering', () => {
    expect(instructionLines('1. Open the console\n\n2) Create an app\n- Copy the ID\nStep 4: Paste it here\nNo prefix')).toEqual([
      'Open the console',
      'Create an app',
      'Copy the ID',
      'Paste it here',
      'No prefix',
    ]);
    expect(instructionLines('')).toEqual([]);
    expect(instructionLines(null)).toEqual([]);
    // A version number is not a list marker.
    expect(instructionLines('2.5 GHz is fine')).toEqual(['2.5 GHz is fine']);
  });

  it('formats relative times', () => {
    expect(relativeTime('2026-10-16T12:00:00Z', NOW)).toBe('in 5 days');
    expect(relativeTime('2026-10-11T09:00:00Z', NOW)).toBe('3 hours ago');
    expect(relativeTime('2026-10-11T12:00:10Z', NOW)).toBe('now');
    expect(relativeTime(null, NOW)).toBe('—');
    expect(relativeTime('garbage', NOW, 'never')).toBe('never');
  });

  it('validates general settings and sends only changes', () => {
    expect(validateGeneral({ publicBaseUrl: 'https://203.0.113.7', ingestHost: '192.168.1.20', disconnectGraceSec: '15' })).toEqual({});
    expect(validateGeneral({ publicBaseUrl: '', ingestHost: 'fe80::1', disconnectGraceSec: '0' })).toEqual({});
    const bad = validateGeneral({ publicBaseUrl: 'ftp://x', ingestHost: 'rtmp://nas:1935', disconnectGraceSec: '601' });
    expect(Object.keys(bad).sort()).toEqual(['disconnectGraceSec', 'ingestHost', 'publicBaseUrl']);
    expect(validateGeneral({ publicBaseUrl: 'https://u:p@x', ingestHost: 'nas.local:1935', disconnectGraceSec: '1.5' })).toEqual({
      publicBaseUrl: expect.any(String),
      ingestHost: expect.stringContaining('port'),
      disconnectGraceSec: expect.any(String),
    });
    const draft = { ...generalDraft(settings), ingestHost: ' 192.168.1.20 ' };
    expect(generalChanges(draft, settings)).toEqual({ ingestHost: '192.168.1.20' });
    expect(generalChanges(generalDraft(settings), settings)).toEqual({});
    expect(generalChanges({ ...generalDraft(settings), disconnectGraceSec: '30' }, settings)).toEqual({ disconnectGraceSec: 30 });
  });

  it('colors certificate expiry', () => {
    expect(expiryTone('2026-10-20T00:00:00Z', NOW)).toBe('success');
    expect(expiryTone('2026-10-12T00:00:00Z', NOW)).toBe('warn');
    expect(expiryTone('2026-10-01T00:00:00Z', NOW)).toBe('danger');
    expect(expiryTone(null, NOW)).toBe('neutral');
  });

  it('maps developer-app values both ways (secrets only when typed)', () => {
    const fields: FieldSpec[] = [
      { key: 'clientId', label: 'Client ID', type: 'text', required: true },
      { key: 'clientSecret', label: 'Client secret', type: 'secret', required: true },
      { key: 'pkce', label: 'Use PKCE', type: 'boolean' },
      { key: 'port', label: 'Port', type: 'number' },
    ];
    expect(appFormValues(fields, { values: { clientId: 'abc', pkce: 'true', port: '8080' } })).toEqual({ clientId: 'abc', pkce: true, port: 8080 });
    expect(appFormValues(fields, { values: {} })).toEqual({ pkce: false });
    expect(appSubmitValues(fields, { clientId: ' abc ', pkce: true, port: 8080 })).toEqual({ clientId: 'abc', pkce: 'true', port: '8080' });
    expect(appSubmitValues(fields, { clientId: '', clientSecret: ' s3cret ' })).toEqual({ clientId: '', clientSecret: 's3cret', pkce: '', port: '' });
  });

  it('validates new users and passwords like the server', () => {
    expect(validateNewUser({ username: 'ok_user', password: 'long enough!', confirm: 'long enough!' })).toEqual({});
    expect(validateNewUser({ username: 'a b', password: 'short', confirm: 'x' })).toEqual({
      username: expect.any(String),
      password: expect.stringContaining('10'),
      confirm: expect.any(String),
    });
    expect(validatePassword('x'.repeat(257), 'x'.repeat(257)).password).toMatch(/256/);
  });

  it('adds overlay options to the URL', () => {
    const base = 'https://203.0.113.7/overlay/chat?token=tok_1';
    expect(overlayUrlWithParams(base, { fade: 30, max: 10 })).toBe(`${base}&fade=30&max=10`);
    expect(overlayUrlWithParams(base, { fade: 0, max: 15 })).toBe(base);
    expect(overlayUrlWithParams(base, { fade: null, max: 1000 })).toBe(base);
    expect(overlayUrlWithParams(`${base}&fade=5`, { fade: null })).toBe(base);
    expect(overlayUrlWithParams('not a url', { fade: 5 })).toBe('not a url');
    expect(parseWholeNumber('')).toBeNull();
    expect(parseWholeNumber(' 12 ')).toBe(12);
    expect(parseWholeNumber('1e3')).toBeNaN();
  });

  it('pages the audit log', () => {
    const e = (id: number): AuditEntry => ({ id, ts: '2026-10-11T00:00:00Z', userId: null, username: null, action: 'x', detail: null, ip: null });
    const first = [e(10), e(9), e(8)];
    expect(auditCursor(first)).toBe(8);
    expect(auditCursor([])).toBeUndefined();
    expect(appendAudit(first, [e(8), e(7)]).map((x) => x.id)).toEqual([10, 9, 8, 7]);
  });

  it('builds the OBS dock URL from the LAN address, else the HTTPS one', () => {
    const secret = 'ctd_pat_3fK9wQ1v-_abc';
    expect(dockUrl({ lanBaseUrl: 'http://192.168.1.20:30080/api/v1', baseUrl: 'https://203.0.113.7/api/v1' }, secret)).toEqual({
      url: 'http://192.168.1.20:30080/dock#token=ctd_pat_3fK9wQ1v-_abc',
      lan: true,
    });
    // The container can't tell its LAN address: fall back to the HTTPS base.
    expect(dockUrl({ lanBaseUrl: null, baseUrl: 'https://203.0.113.7/api/v1' }, secret)).toEqual({
      url: 'https://203.0.113.7/dock#token=ctd_pat_3fK9wQ1v-_abc',
      lan: false,
    });
    expect(dockUrl({ lanBaseUrl: 'not a url', baseUrl: 'https://h.example:8443/api/v1/' }, secret)?.url).toBe('https://h.example:8443/dock#token=ctd_pat_3fK9wQ1v-_abc');
    expect(dockUrl({ lanBaseUrl: null, baseUrl: 'ftp://x/api/v1' }, secret)).toBeNull();
    // Behind a reverse proxy on a sub-path, the prefix stays.
    expect(dockUrlFor('https://example.com/ctd/api/v1', secret)).toBe('https://example.com/ctd/dock#token=ctd_pat_3fK9wQ1v-_abc');
    // Anything unusual in the token is encoded the way the dock decodes it (URLSearchParams).
    const odd = dockUrlFor('http://nas.local/api/v1', 'a+b&c=d#e') ?? '';
    expect(new URLSearchParams(new URL(odd).hash.slice(1)).get('token')).toBe('a+b&c=d#e');
    expect(apiSiteRoot('https://u:p@203.0.113.7/api/v1?x=1#y')).toBe('https://203.0.113.7');
    expect(apiSiteRoot('http://[fe80::1]:30080/api/v1')).toBe('http://[fe80::1]:30080');
    expect(apiSiteRoot(null)).toBeNull();
  });

  it('validates new API tokens like the server', () => {
    expect(validateTokenForm('CTD Overlay', ['chat:read'])).toEqual({});
    expect(validateTokenForm('  ', [])).toEqual({ name: expect.any(String), scopes: expect.any(String) });
    expect(validateTokenForm('x'.repeat(61), ['status:read']).name).toMatch(/60/);
    expect(validateTokenForm('bad‮name', ['status:read']).name).toMatch(/control/);
    expect(validateTokenForm('ok', ['nope' as never]).scopes).toBeDefined();
    expect(orderedScopes(['status:read', 'chat:read', 'admin'])).toEqual(['chat:read', 'status:read']);
  });

  it('new-token modal: no close while creating, the secret is never lost or shown again later', () => {
    type S = TokenModalState<string>;
    const run = (s: S, ...actions: TokenModalAction<string>[]) => actions.reduce<S>(tokenModalReducer, s);
    const closed = tokenModalInitial<string>();
    const open = run(closed, { type: 'open' });
    expect(open).toEqual({ open: true, busy: false, created: null });
    expect(tokenModalDismissible(open)).toBe(true);
    expect(run(open, { type: 'close' })).toEqual(closed);

    // Escape / backdrop / × while the request is in flight: stays open, then shows the secret.
    const creating = run(open, { type: 'busy', busy: true });
    expect(tokenModalDismissible(creating)).toBe(false);
    expect(run(creating, { type: 'close' })).toBe(creating);
    const shown = run(creating, { type: 'close' }, { type: 'created', result: 'secret-1' });
    expect(shown).toEqual({ open: true, busy: false, created: 'secret-1' });
    expect(tokenModalDismissible(shown)).toBe(false); // only Done / × close it
    // A failed request makes it closable again.
    expect(run(creating, { type: 'busy', busy: false }, { type: 'close' })).toEqual(closed);

    // Done, then New token again: the form, not the old secret.
    const reopened = run(shown, { type: 'close' }, { type: 'open' });
    expect(reopened).toEqual({ open: true, busy: false, created: null });
    // Even if a secret was somehow left behind, opening starts fresh.
    expect(run({ open: false, busy: false, created: 'stale' }, { type: 'open' }).created).toBeNull();
    expect(run(closed, { type: 'close' })).toBe(closed);
  });

  it('matches server messages to fields by label', () => {
    const labels = { publicBaseUrl: 'Public base URL', ingestHost: 'Ingest host', key: 'Stream key', keyFile: 'Stream key file' };
    expect(fieldForMessage('Public base URL must start with http://', labels)).toBe('publicBaseUrl');
    expect(fieldForMessage('stream key file is missing', labels)).toBe('keyFile');
    expect(fieldForMessage('Something else', labels)).toBeNull();
    expect(hasErrors({ a: undefined })).toBe(false);
    expect(hasErrors({ a: 'x' })).toBe(true);
  });
});

describe('transcodeSummary', () => {
  const base: TranscodeCapabilities = {
    state: 'ready',
    probedAt: '2026-11-09T12:00:00.000Z',
    durationMs: 2100,
    ffmpegVersion: 'ffmpeg version n8.1.3',
    hwaccels: ['vaapi'],
    decoders: { h264: ['h264'], hevc: ['hevc'], av1: ['libdav1d'] },
    encoders: [
      { encoder: 'h264_vaapi', codec: 'h264', backend: 'vaapi', ok: true, speed: 7.5, device: '/dev/dri/renderD128', error: null },
      { encoder: 'hevc_vaapi', codec: 'hevc', backend: 'vaapi', ok: false, speed: null, device: null, error: 'No usable encoding profile found.' },
      { encoder: 'libx264', codec: 'h264', backend: 'software', ok: true, speed: 2.2, device: null, error: null },
      { encoder: 'libx265', codec: 'hevc', backend: 'software', ok: true, speed: null, device: null, error: null },
    ],
    supported: { h264: true, hevc: true, av1: false },
    cpu: { cores: 4, model: null },
    devices: { renderNodes: ['/dev/dri/renderD128'], nvidia: false },
    error: null,
  };

  it('lists the working encoders per codec, GPU first', () => {
    expect(transcodeSummary(base)).toBe('H.264: h264_vaapi (GPU), libx264 (CPU, 2.2×) · HEVC: libx265 (CPU) · AV1: none');
  });

  it('probing and unavailable', () => {
    expect(transcodeSummary({ ...base, state: 'probing', encoders: [] })).toBe('Checking which encoders work…');
    expect(transcodeSummary({ ...base, state: 'unavailable', error: "FFmpeg can't run: spawn ffmpeg ENOENT" })).toBe(
      "Unavailable: FFmpeg can't run: spawn ffmpeg ENOENT",
    );
  });
});
