// Transcoding in the web UI: the destination form's section, Settings → Transcoding and the
// dashboard card line (static renders + the pure helpers behind them).

import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TranscodeCapabilities, TranscodeEncoderResult, TranscodeSettingsResponse } from '@shared/api';
import { defaultTranscodeProfile } from '@shared/transcode';
import type { Destination, DestinationState, DestinationTranscodeStatus, PlatformInfo, TranscodeProfile } from '@shared/types';
import { AuthProvider } from '../../state/auth';
import { LiveProvider } from '../../state/live';
import { DestinationCard } from '../DashboardPage';
import { encoderRows, SETTINGS_TABS, settingsTab, workingCodecs } from '../settings/settings-helpers';
import { EncodersCard, SwitchCard } from '../settings/TranscodingTab';
import { buildCreateRequest, buildUpdateRequest, destinationErrorField, initialDraft, TRANSCODE_ERROR_KEY, validateDraft } from './destination-form';
import {
  audioSelectOptions,
  audioValue,
  codecSelectOptions,
  encoderSelectOptions,
  fpsSelectOptions,
  loadHint,
  orientFor,
  parseAudio,
  parseSize,
  sizeSelectOptions,
  transcodeBlocked,
  transcodeChanged,
  transcodeListLine,
  transcodeStatusLine,
  turnOff,
  turnOn,
  type TranscodeContext,
} from './transcode-form';
import { TranscodeSection } from './TranscodeSection';

const html = (el: ReactElement) => renderToStaticMarkup(el);
const noop = () => undefined;

const platform = (id: PlatformInfo['id'], name: string, feeds: PlatformInfo['feeds'] = ['landscape']): PlatformInfo => ({
  id,
  name,
  feeds,
  defaultFeed: feeds[0]!,
  connectMethod: 'none',
  accountFields: [],
  destinationFields: [],
  developerApp: null,
  titleSupport: 'none',
  chatSupport: 'none',
  keyPerSession: false,
  experimental: false,
});
const twitch = platform('twitch', 'Twitch', ['landscape', 'vertical']);
const youtube = platform('youtube', 'YouTube', ['landscape', 'vertical']);
const instagram = platform('instagram', 'Instagram', ['vertical']);

const enc = (encoder: string, codec: TranscodeEncoderResult['codec'], backend: TranscodeEncoderResult['backend'], ok: boolean, speed: number | null = null, error = 'Cannot load libcuda.so.1'): TranscodeEncoderResult => ({
  encoder,
  codec,
  backend,
  ok,
  speed: ok ? speed : null,
  device: null,
  error: ok ? null : error,
});

function caps(encoders: TranscodeEncoderResult[], state: TranscodeCapabilities['state'] = 'ready'): TranscodeCapabilities {
  const supported = { h264: false, hevc: false, av1: false };
  for (const e of encoders) if (e.ok) supported[e.codec] = true;
  return {
    state,
    probedAt: '2026-11-18T15:00:00.000Z',
    durationMs: 4200,
    ffmpegVersion: 'ffmpeg version n8.1.3-9-g29e619e767 Copyright (c) 2000-2026 the FFmpeg developers',
    hwaccels: [],
    decoders: { h264: [], hevc: [], av1: [] },
    encoders,
    supported,
    cpu: { cores: 32, model: null },
    devices: { renderNodes: [], nvidia: false },
    error: state === 'unavailable' ? 'FFmpeg not found' : null,
  };
}

/** The owner's server: CPU encoders only. */
const CPU = caps([
  enc('h264_nvenc', 'h264', 'nvenc', false),
  enc('h264_vaapi', 'h264', 'vaapi', false, null, 'no /dev/dri render node (GPU not passed through)'),
  enc('libx264', 'h264', 'software', true, 3.07),
  enc('libx265', 'hevc', 'software', true, 1.78),
  enc('libsvtav1', 'av1', 'software', true, 2.01),
]);
const ON = { settings: { enabled: true, maxWorkers: 2 }, caps: CPU };
const OFF = { settings: { enabled: false, maxWorkers: 2 }, caps: CPU };
const ULTRAWIDE = { codec: 'av1', width: 3440, height: 1440, fps: 60 };

const profile = (video: Partial<TranscodeProfile['video']> = {}, rest: Partial<TranscodeProfile> = {}): TranscodeProfile => ({
  mode: 'transcode',
  video: { codec: 'h264', width: 1920, height: 1080, fps: null, bitrateKbps: 6000, keyframeSec: 2, encoder: 'auto', ...video },
  audio: 'copy',
  fallback: 'copy',
  ...rest,
});

describe('transcoding helpers', () => {
  it('says why transcoding cannot be switched on', () => {
    expect(transcodeBlocked(twitch, ON)).toBeNull();
    expect(transcodeBlocked(twitch, { settings: null, caps: null })).toBeNull(); // still loading
    expect(transcodeBlocked(twitch, OFF)).toMatch(/turned off on this server/);
    expect(transcodeBlocked(twitch, { ...ON, caps: caps([], 'unavailable') })).toBe("This server can't transcode: FFmpeg not found");
    expect(transcodeBlocked(twitch, { ...ON, caps: caps([enc('libx265', 'hevc', 'software', true, 2)]) })).toBe(
      'No H.264 encoder works on this server, and that is what Twitch takes. See Settings → Transcoding.',
    );
    // The probe is still running: don't block on what isn't known yet.
    expect(transcodeBlocked(twitch, { ...ON, caps: caps([], 'probing') })).toBeNull();
  });

  it('switching on starts from the platform default, switching off keeps the settings', () => {
    const on = turnOn(null, twitch, 'landscape', ULTRAWIDE, CPU);
    expect(on).toEqual(defaultTranscodeProfile('twitch', 'landscape', ULTRAWIDE));
    expect(on.video).toMatchObject({ codec: 'h264', width: 1920, height: 1080, bitrateKbps: 6000, encoder: 'auto' });
    const off = turnOff({ ...on, video: { ...on.video, bitrateKbps: 4500 } });
    expect(off).toMatchObject({ mode: 'copy', video: { bitrateKbps: 4500 } });
    expect(turnOn(off, twitch, 'landscape', null, CPU)).toMatchObject({ mode: 'transcode', video: { bitrateKbps: 4500 } });
    expect(turnOff(null)).toBeNull();
  });

  it('starts with a codec this server can encode', () => {
    const hevcOnly = caps([enc('libx265', 'hevc', 'software', true, 2)]);
    expect(turnOn(null, youtube, 'landscape', null, hevcOnly).video.codec).toBe('hevc');
    expect(turnOn(null, youtube, 'landscape', null, CPU).video.codec).toBe('h264');
  });

  it('turns the frame to match the feed', () => {
    expect(orientFor(profile(), 'vertical').video).toMatchObject({ width: 1080, height: 1920 });
    expect(orientFor(profile({ width: 1080, height: 1920 }), 'landscape').video).toMatchObject({ width: 1920, height: 1080 });
    expect(orientFor(profile(), 'landscape')).toEqual(profile());
    expect(turnOn(profile({}, { mode: 'copy' }), twitch, 'vertical', null, CPU).video).toMatchObject({ width: 1080, height: 1920 });
  });

  it('offers what the platform takes and this server can do', () => {
    expect(sizeSelectOptions(twitch, 'landscape', { width: 1920, height: 1080 }).map((o) => o.label)).toEqual(['1920×1080 (1080p)', '1280×720 (720p)', '854×480 (480p)']);
    expect(sizeSelectOptions(instagram, 'vertical', { width: 1080, height: 1920 })[0]).toEqual({ value: '1080x1920', label: '1080×1920 (1080p)' });
    expect(sizeSelectOptions(twitch, 'landscape', { width: 1600, height: 900 })[0]).toEqual({ value: '1600x900', label: '1600×900 (custom)' });
    expect(parseSize('1280x720')).toEqual({ width: 1280, height: 720 });
    expect(parseSize('big')).toBeNull();

    expect(fpsSelectOptions(instagram, null, null).map((o) => o.label)).toEqual(['Same as the feed', '30 fps', '25 fps', '24 fps']);
    expect(fpsSelectOptions(twitch, { codec: 'h264', fps: 59.94 }, null)[0]?.label).toBe('Same as the feed (59.94 fps now)');
    expect(fpsSelectOptions(twitch, null, 48).at(-1)).toEqual({ value: '48', label: '48 fps' });

    expect(codecSelectOptions(youtube, CPU, 'h264').map((o) => o.label)).toEqual(['H.264', 'HEVC', 'AV1']);
    expect(codecSelectOptions(twitch, CPU, 'h264').map((o) => o.label)).toEqual(['H.264']);
    expect(codecSelectOptions(youtube, caps([enc('libx264', 'h264', 'software', true, 3)]), 'av1')[0]).toEqual({ value: 'av1', label: 'AV1 (not available here)' });

    expect(encoderSelectOptions('h264', CPU, 'auto')).toEqual([
      { value: 'auto', label: 'Automatic: libx264 (CPU)' },
      { value: 'libx264', label: 'libx264 (CPU)' },
    ]);
    const gpu = caps([enc('h264_nvenc', 'h264', 'nvenc', true, 12), enc('libx264', 'h264', 'software', true, 3)]);
    expect(encoderSelectOptions('h264', gpu, 'auto').map((o) => o.label)).toEqual(['Automatic: h264_nvenc (NVIDIA GPU)', 'h264_nvenc (NVIDIA GPU)', 'libx264 (CPU)']);
    expect(encoderSelectOptions('h264', CPU, 'h264_nvenc').at(-1)).toEqual({ value: 'h264_nvenc', label: 'h264_nvenc (not working here)' });
    expect(encoderSelectOptions('h264', null, 'auto')).toEqual([{ value: 'auto', label: 'Automatic' }]);

    expect(audioSelectOptions('copy')[0]).toEqual({ value: 'copy', label: "Keep the feed's audio" });
    expect(audioValue({ codec: 'aac', bitrateKbps: 160 })).toBe('160');
    expect(parseAudio('192')).toEqual({ codec: 'aac', bitrateKbps: 192 });
    expect(parseAudio('copy')).toBe('copy');
    expect(audioSelectOptions({ codec: 'aac', bitrateKbps: 96 }).at(-1)?.value).toBe('96');
  });

  it('gives a plain load estimate from the server test', () => {
    // 1080p60 on libx264 at 3.07×: about 147% of the test.
    const heavy = loadHint(profile(), twitch, CPU, ULTRAWIDE);
    expect(heavy).toMatchObject({ tone: 'warn' });
    expect(heavy?.text).toMatch(/libx264: about 147% of what it managed in this server's short test, so it may not keep up/);
    const light = loadHint(profile({ width: 1280, height: 720, fps: 30 }), twitch, CPU, ULTRAWIDE);
    expect(light).toEqual({ tone: 'ok', text: "Encodes on the CPU with libx264: about 33% of what it managed in this server's test." });
    // The feed isn't running and the profile keeps its rate: nothing to estimate from.
    expect(loadHint(profile(), twitch, CPU, null)?.text).toMatch(/Start OBS to see whether this server keeps up/);
    const gpu = caps([enc('h264_nvenc', 'h264', 'nvenc', true, 12)]);
    expect(loadHint(profile(), twitch, gpu, ULTRAWIDE)).toEqual({ tone: 'ok', text: 'Encodes on the NVIDIA GPU with h264_nvenc.' });
    expect(loadHint(profile(), twitch, null, ULTRAWIDE)).toBeNull();
    expect(loadHint(profile({ codec: 'hevc' }), twitch, caps([enc('libx264', 'h264', 'software', true, 3)]), ULTRAWIDE)).toBeNull();
  });

  it('describes a destination and a running encode', () => {
    expect(transcodeListLine(profile())).toBe('Transcoded: H.264 1920×1080 · source fps · 6000 kbps');
    expect(transcodeListLine(profile({}, { mode: 'copy' }))).toBeNull();
    expect(transcodeListLine(null)).toBeNull();
    const st = (over: Partial<DestinationTranscodeStatus>): DestinationTranscodeStatus => ({
      state: 'running',
      encoder: 'libx264',
      codec: 'h264',
      width: 1920,
      height: 1080,
      fps: 30,
      bitrateKbps: 6000,
      speed: 1,
      message: null,
      ...over,
    });
    expect(transcodeStatusLine(st({}))).toEqual({ tone: 'ok', text: 'Transcoding H.264 1920×1080 · 30 fps · 6000 kbps with libx264 · 1.00× real time' });
    expect(transcodeStatusLine(st({ state: 'starting', speed: null }))).toEqual({ tone: 'ok', text: 'Transcoding H.264 1920×1080 · 30 fps · 6000 kbps with libx264: starting' });
    expect(transcodeStatusLine(st({ state: 'behind', speed: 0.82 }))).toEqual({ tone: 'warn', text: 'Transcoding H.264 1920×1080 · 30 fps · 6000 kbps with libx264: 0.82× real time' });
    expect(transcodeStatusLine(st({ state: 'fallback-copy', encoder: null, speed: null }))).toEqual({
      tone: 'warn',
      text: 'Transcoding stopped: sending the original feed (wanted H.264 1920×1080 · 30 fps · 6000 kbps)',
    });
    expect(transcodeStatusLine(null)).toBeNull();
  });
});

describe('destination form requests', () => {
  const stored: Destination = {
    id: 'd1',
    platform: 'twitch',
    accountId: null,
    name: 'Twitch',
    feed: 'landscape',
    enabled: true,
    options: {},
    ingestUrl: null,
    hasStreamKey: false,
    transcode: profile(),
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };

  it('a new destination has no profile and sends none', () => {
    const draft = initialDraft(twitch, [], null);
    expect(draft.transcode).toBeNull();
    expect('transcode' in buildCreateRequest(twitch, draft)).toBe(false);
    expect(buildCreateRequest(twitch, { ...draft, transcode: profile() }).transcode).toEqual(profile());
  });

  it('an edit only sends the profile when it changed', () => {
    const draft = initialDraft(twitch, [], stored);
    expect(draft.transcode).toEqual(profile());
    expect('transcode' in buildUpdateRequest(twitch, draft, stored)).toBe(false);
    expect(buildUpdateRequest(twitch, { ...draft, transcode: turnOff(draft.transcode) }, stored).transcode).toMatchObject({ mode: 'copy' });
    expect(buildUpdateRequest(twitch, { ...draft, transcode: null }, stored).transcode).toBeNull();
    const plain = { ...stored, transcode: null };
    expect('transcode' in buildUpdateRequest(twitch, initialDraft(twitch, [], plain), plain)).toBe(false);
    expect(transcodeChanged(profile(), profile())).toBe(false);
    expect(transcodeChanged(null, undefined)).toBe(false);
    expect(transcodeChanged(profile(), profile({ bitrateKbps: 5000 }))).toBe(true);
  });

  it('saves the frame turned for the chosen feed', () => {
    const draft = { ...initialDraft(twitch, [], stored), feed: 'vertical' as const };
    expect(buildUpdateRequest(twitch, draft, stored).transcode?.video).toMatchObject({ width: 1080, height: 1920 });
  });

  it('checks the profile like the server does and shows server errors in the section', () => {
    const draft = { ...initialDraft(twitch, [], null), transcode: profile({ bitrateKbps: 0 }) };
    expect(validateDraft(twitch, draft, {}, CPU)[TRANSCODE_ERROR_KEY]).toBe('The video bitrate must be between 300 and 8500 kbps for Twitch');
    expect(validateDraft(twitch, { ...draft, transcode: profile({ encoder: 'h264_nvenc' }) }, {}, CPU)[TRANSCODE_ERROR_KEY]).toMatch(/h264_nvenc failed its test encode/);
    // Switched off: kept for later, the machine isn't asked.
    expect(validateDraft(twitch, { ...draft, transcode: profile({ encoder: 'h264_nvenc' }, { mode: 'copy' }) }, {}, CPU)[TRANSCODE_ERROR_KEY]).toBeUndefined();
    expect(validateDraft(twitch, { ...draft, transcode: profile() }, {}, CPU)[TRANSCODE_ERROR_KEY]).toBeUndefined();
    expect(validateDraft(twitch, { ...draft, transcode: null }, {})[TRANSCODE_ERROR_KEY]).toBeUndefined();
    expect(destinationErrorField(twitch, "Transcoding: Twitch doesn't accept AV1 (it takes H.264)")).toBe(TRANSCODE_ERROR_KEY);
  });
});

describe('TranscodeSection (static render)', () => {
  const section = (value: TranscodeProfile | null, context: TranscodeContext = ON, info = twitch, feedVideo: typeof ULTRAWIDE | null = null) =>
    html(<TranscodeSection info={info} feed={info.defaultFeed} value={value} onChange={noop} context={context} feedVideo={feedVideo} />);

  it('is off by default and says what turning it on does', () => {
    const out = section(null);
    expect(out).toContain('Transcoding');
    expect(out).toContain('aria-checked="false"');
    expect(out).toContain('Re-encode the landscape feed for this destination');
    expect(out).toContain('Off: Twitch gets the feed exactly as OBS sends it.');
    expect(out).toContain('up to 1920×1080, 60 fps, H.264');
    expect(out).not.toContain('Video bitrate');
  });

  it('cannot be switched on while the server switch is off, and points at the setting', () => {
    const out = section(null, OFF);
    expect(out).toMatch(/<button[^>]*role="switch"[^>]*disabled/);
    expect(out).toContain('Transcoding is turned off on this server.');
    expect(out).toContain('href="/settings?tab=transcoding"');
  });

  it('a saved profile stays visible and can be switched off while the server switch is off', () => {
    const out = section(profile(), OFF);
    expect(out).toContain('aria-checked="true"');
    expect(out).not.toMatch(/<button[^>]*role="switch"[^>]*disabled/);
    expect(out).toContain('Until then this destination gets the feed as OBS sends it.');
  });

  it('waits for the server check before offering anything', () => {
    const out = section(null, { settings: null, caps: null });
    expect(out).toContain('Checking what this server can encode');
    expect(out).toMatch(/<button[^>]*role="switch"[^>]*disabled/);
  });

  it('shows the settings, limited to the platform and this server', () => {
    const out = section(profile(), ON, twitch, ULTRAWIDE);
    expect(out).toContain('aria-checked="true"');
    for (const label of ['Video codec', 'Frame size', 'Frame rate', 'Video bitrate (kbps)', 'Encoder', 'Audio', 'If this server can&#x27;t keep up']) expect(out).toContain(label);
    expect(out).toContain('value="6000"');
    expect(out).toContain('Twitch: 6000 recommended, 8500 at most.');
    expect(out).toContain('Automatic: libx264 (CPU)');
    expect(out).toContain('Same as the feed (60 fps now)');
    expect(out).not.toContain('HEVC');
    expect(out).not.toContain('3840×2160');
    expect(out).toContain('about 147% of what it managed');
    expect(out).toContain('a running stream is never interrupted');
  });

  it('shows a validation error in the section', () => {
    const out = html(<TranscodeSection info={twitch} feed="landscape" value={profile()} onChange={noop} context={ON} feedVideo={null} error="The video bitrate must be between 300 and 8500 kbps for Twitch" />);
    expect(out).toContain('role="alert"');
    expect(out).toContain('between 300 and 8500 kbps');
  });
});

describe('Settings → Transcoding (static render)', () => {
  const response = (enabled: boolean, c = CPU): TranscodeSettingsResponse => ({ settings: { enabled, maxWorkers: 2 }, capabilities: c });
  const save = async () => undefined;

  it('has its own tab', () => {
    expect(SETTINGS_TABS.map((t) => t.id)).toContain('transcoding');
    expect(settingsTab('transcoding')).toBe('transcoding');
  });

  it('is off by default and explains that nothing is re-encoded', () => {
    const out = html(<SwitchCard data={response(false)} isAdmin saving={false} onSave={save} />);
    expect(out).toContain('Allow transcoding on this server');
    expect(out).toContain('aria-checked="false"');
    expect(out).toContain('nothing is re-encoded until this is on');
    expect(out).toContain('Destinations transcoding at once');
  });

  it('says what this server can encode once it is on', () => {
    const out = html(<SwitchCard data={response(true)} isAdmin saving={false} onSave={save} />);
    expect(out).toContain('aria-checked="true"');
    expect(out).toContain('this server can encode H.264, HEVC and AV1');
  });

  it("can't be turned on where no encoder works, and is read-only for operators", () => {
    const none = html(<SwitchCard data={response(false, caps([enc('h264_nvenc', 'h264', 'nvenc', false)]))} isAdmin saving={false} onSave={save} />);
    expect(none).toContain('No video encoder works on this server');
    expect(none).toMatch(/<button[^>]*role="switch"[^>]*disabled/);
    const operator = html(<SwitchCard data={response(true)} isAdmin={false} saving={false} onSave={save} />);
    expect(operator).toMatch(/<button[^>]*role="switch"[^>]*disabled/);
    expect(operator).toContain('Only an admin can change these.');
  });

  it('lists every encoder with its test result', () => {
    expect(encoderRows(CPU)).toEqual([
      { encoder: 'h264_nvenc', codec: 'H.264', runsOn: 'NVIDIA GPU (NVENC)', ok: false, result: 'Cannot load libcuda.so.1' },
      { encoder: 'h264_vaapi', codec: 'H.264', runsOn: 'GPU (VAAPI)', ok: false, result: 'no /dev/dri render node (GPU not passed through)' },
      { encoder: 'libx264', codec: 'H.264', runsOn: 'CPU', ok: true, result: 'Works · 3.07× real time at 720p30' },
      { encoder: 'libx265', codec: 'HEVC', runsOn: 'CPU', ok: true, result: 'Works · 1.78× real time at 720p30' },
      { encoder: 'libsvtav1', codec: 'AV1', runsOn: 'CPU', ok: true, result: 'Works · 2.01× real time at 720p30' },
    ]);
    expect(workingCodecs(CPU)).toBe('H.264, HEVC and AV1');
    expect(workingCodecs(caps([enc('libx264', 'h264', 'software', true, 3)]))).toBe('H.264');
    expect(workingCodecs(caps([]))).toBeNull();

    const out = html(<EncodersCard caps={CPU} isAdmin checking={false} onRecheck={noop} />);
    expect(out).toContain('libx264');
    expect(out).toContain('3.07× real time at 720p30');
    expect(out).toContain('Cannot load libcuda.so.1');
    expect(out).toContain('Check again');
    expect(out).toContain('32 CPU threads');
    expect(out).toContain('FFmpeg n8.1.3-9-g29e619e767');
  });

  it('shows the probe still running and FFmpeg missing', () => {
    expect(html(<EncodersCard caps={caps([], 'probing')} isAdmin checking={false} onRecheck={noop} />)).toContain('Checking which encoders work');
    expect(html(<EncodersCard caps={caps([], 'unavailable')} isAdmin checking={false} onRecheck={noop} />)).toContain('This server can&#x27;t transcode: FFmpeg not found.');
  });
});

describe('dashboard card while transcoding', () => {
  const dest: Destination = {
    id: 'tw',
    platform: 'twitch',
    accountId: null,
    name: 'Twitch main',
    feed: 'landscape',
    enabled: true,
    options: {},
    ingestUrl: null,
    hasStreamKey: true,
    transcode: profile(),
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
  const state = (over: Partial<DestinationState>): DestinationState => ({
    destinationId: 'tw',
    phase: 'live',
    message: null,
    stats: { bitrateKbps: 6000, fps: 60, speed: 1, uptimeSec: 120 },
    watchUrl: null,
    retries: 0,
    since: new Date().toISOString(),
    recoveries: 0,
    lastRecovery: null,
    ...over,
  });
  const status: DestinationTranscodeStatus = { state: 'running', encoder: 'libx264', codec: 'h264', width: 1920, height: 1080, fps: null, bitrateKbps: 6000, speed: 1, message: null };
  const card = (s: DestinationState) =>
    html(
      <AuthProvider>
        <LiveProvider>
          <DestinationCard dest={dest} state={s} onUpdated={noop} />
        </LiveProvider>
      </AuthProvider>,
    );

  it('shows what is being encoded and with which encoder', () => {
    const out = card(state({ transcode: status }));
    expect(out).toContain('Transcoding H.264 1920×1080 · source fps · 6000 kbps with libx264 · 1.00× real time');
    expect(out).not.toContain('dest-transcode is-warn');
  });

  it('warns when it is behind or fell back to the original feed', () => {
    const behind = card(state({ message: 'Transcoding is running at 0.82× real time, so viewers will see stutters.', transcode: { ...status, state: 'behind', speed: 0.82 } }));
    expect(behind).toContain('dest-transcode is-warn');
    expect(behind).toContain('0.82× real time');
    expect(behind).toContain('viewers will see stutters');
    const fell = card(state({ transcode: { ...status, state: 'fallback-copy', encoder: null, speed: null } }));
    expect(fell).toContain('Transcoding stopped: sending the original feed');
  });

  it('shows nothing extra for a copy destination or when it is not pushing', () => {
    expect(card(state({}))).not.toContain('dest-transcode');
    expect(card(state({ transcode: null }))).not.toContain('dest-transcode');
    expect(card(state({ phase: 'error', stats: null, transcode: status }))).not.toContain('dest-transcode');
  });
});
