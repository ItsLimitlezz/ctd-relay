import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriverError } from '../types.js';
import {
  buildConfigRequest,
  CLIENT_CONFIG_URL,
  fetchClientConfig,
  OBS_CLIENT_VERSION,
  OBS_USER_AGENT,
  planFromConfig,
  prepareMultitrack,
  reportedSystem,
  stripHtml,
  type ClientConfigResponse,
  type MultitrackInput,
} from './multitrack.js';
import { parseVideoFormat } from './options.js';
import { DEFAULT_REPORTED_GPU, reportedGpuPreset } from './reported-gpus.js';

const AUTH = 'v1_abc_123_def_live_1_KEY';

function input(over: Partial<MultitrackInput> = {}): MultitrackInput {
  return {
    streamKey: 'live_1_KEY',
    landscape: parseVideoFormat('1920x1080@60')!,
    vertical: parseVideoFormat('1080x1920@60')!,
    ingestServer: null,
    bandwidthTest: false,
    ...over,
  };
}

const fps = (n: number) => ({ numerator: n, denominator: 1 });
const nvenc = (bitrate: number, profile = 'high') => ({ bitrate, bf: 3, keyint_sec: 2, preset: 'p6', profile, rate_control: 'CBR' });

/** The shape Twitch returned on 2026-10-21 for 4 tracks (trimmed). */
function config(over: Partial<ClientConfigResponse> = {}): ClientConfigResponse {
  return {
    meta: { service: 'IVS', schema_version: '2025-01-25', config_id: 'cfg-1' },
    status: { result: 'success', html_en_us: null },
    ingest_endpoints: [
      { protocol: 'RTMP', url_template: 'rtmp://iad05.contribute.live-video.net/app/{stream_key}', authentication: AUTH },
      { protocol: 'RTMPS', url_template: 'rtmps://iad05.contribute.live-video.net/app/{stream_key}', authentication: AUTH },
    ],
    encoder_configurations: [
      { type: 'obs_nvenc_h264_tex', width: 1920, height: 1080, framerate: fps(60), canvas_index: 0, settings: nvenc(6000) },
      { type: 'obs_nvenc_h264_tex', width: 640, height: 360, framerate: fps(30), canvas_index: 0, settings: nvenc(500, 'main') },
      { type: 'obs_nvenc_h264_tex', width: 1080, height: 1920, framerate: fps(60), canvas_index: 1, settings: nvenc(5000) },
      { type: 'obs_nvenc_h264_tex', width: 360, height: 640, framerate: fps(30), canvas_index: 1, settings: nvenc(500, 'main') },
    ],
    audio_configurations: { live: [{ codec: 'aac', track_id: 0, channels: 2, settings: { bitrate: 160 } }] },
    ...over,
  };
}

function expectRejected(fn: () => unknown, text: RegExp): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('misconfigured');
    expect((err as DriverError).message).toMatch(/^Twitch rejected relay Dual Format: /);
    expect((err as DriverError).message).toMatch(text);
    return;
  }
  throw new Error('expected a rejection');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildConfigRequest', () => {
  it('describes both canvases, this machine plus the reported GPU, and asks for Dual Format’s minimum of 4 tracks', () => {
    const body = buildConfigRequest(input());
    expect(body).toMatchObject({
      service: 'IVS',
      schema_version: '2025-01-25',
      authentication: 'live_1_KEY',
      client: { name: 'obs-studio', version: OBS_CLIENT_VERSION, supported_codecs: ['h264'] },
      preferences: {
        maximum_aggregate_bitrate: null,
        maximum_video_tracks: 4,
        vod_track_audio: false,
        composition_gpu_index: 0,
        canvases: [
          { width: 1920, height: 1080, canvas_width: 1920, canvas_height: 1080, framerate: { numerator: 60, denominator: 1 } },
          { width: 1080, height: 1920, canvas_width: 1080, canvas_height: 1920, framerate: { numerator: 60, denominator: 1 } },
        ],
      },
    });
    const caps = body.capabilities as { cpu: { logical_cores: number }; memory: { total: number }; gpu: unknown[] };
    expect(caps.cpu.logical_cores).toBeGreaterThan(0);
    expect(caps.memory.total).toBeGreaterThan(0);
    expect(caps.gpu).toEqual([DEFAULT_REPORTED_GPU]);
    expect((buildConfigRequest(input({ maxTracks: 2 })).preferences as { maximum_video_tracks: number }).maximum_video_tracks).toBe(4);
    expect((buildConfigRequest(input({ maxTracks: 6 })).preferences as { maximum_video_tracks: number }).maximum_video_tracks).toBe(6);
  });

  it('has the same top-level fields as OBS’s request and no others', () => {
    const body = buildConfigRequest(input());
    expect(Object.keys(body).sort()).toEqual(['authentication', 'capabilities', 'client', 'preferences', 'schema_version', 'service']);
    expect(Object.keys(body.capabilities as object).sort()).toEqual(['cpu', 'gaming_features', 'gpu', 'memory', 'system']);
  });

  it('reports the GPU the destination picked', () => {
    const gpu = reportedGpuPreset('arc-a770')!;
    const caps = buildConfigRequest(input({ gpu })).capabilities as { gpu: unknown[] };
    expect(caps.gpu).toEqual([gpu]);
  });

  it('can report CTD Relay as the client instead of OBS', () => {
    const body = buildConfigRequest(input({ client: 'relay', clientVersion: '1.2.3' }));
    expect(body.client).toEqual({ name: 'ctd-relay', version: '1.2.3', supported_codecs: ['h264'] });
  });
});

describe('reportedSystem', () => {
  const host = { platform: 'linux' as const, release: '6.12.33', version: '#1 SMP', arch: 'x64', osRelease: null };

  it('reports Windows the way OBS does', () => {
    expect(reportedSystem({ ...host, platform: 'win32', release: '10.0.19045', version: 'Windows 10 Pro' })).toEqual({
      version: '10.0',
      name: 'Windows',
      build: 19045,
      release: 'unavailable',
      revision: '0',
      bits: 64,
      arm: false,
      armEmulation: false,
    });
  });

  it('reports Linux the way OBS does, from /etc/os-release', () => {
    const osRelease = 'PRETTY_NAME="Debian GNU/Linux 12"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n';
    expect(reportedSystem({ ...host, arch: 'arm64', osRelease })).toEqual({
      version: 'Linux 6.12.33 #1 SMP',
      name: 'Debian GNU/Linux',
      build: 0,
      release: '12',
      revision: '',
      bits: 64,
      arm: true,
      armEmulation: false,
    });
  });

  it('falls back like OBS when there is no /etc/os-release, and caps the version length', () => {
    const system = reportedSystem({ ...host, version: 'x'.repeat(300) });
    expect(system.name).toBe('Linux-based distribution');
    expect(system.release).toBe('unknown');
    expect(String(system.version)).toHaveLength(128);
  });
});

describe('the configuration request’s user agent', () => {
  function stubFetch(): () => Headers {
    let seen = new Headers();
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen = new Headers(init.headers);
      return new Response(JSON.stringify(config()), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return () => seen;
  }

  it('is OBS’s when reporting OBS', async () => {
    const headers = stubFetch();
    await prepareMultitrack(input(), new AbortController().signal);
    expect(headers().get('user-agent')).toBe(OBS_USER_AGENT);
  });

  it('is not OBS’s when reporting CTD Relay', async () => {
    const headers = stubFetch();
    await prepareMultitrack(input({ client: 'relay' }), new AbortController().signal);
    expect(headers().get('user-agent')).not.toBe(OBS_USER_AGENT);
  });
});

describe('planFromConfig', () => {
  it('encodes every track Twitch asked for, in its order, at its size, rate and bitrate', () => {
    const plan = planFromConfig(config(), input());
    expect(plan).toMatchObject({ url: `rtmps://iad05.contribute.live-video.net/app/${AUTH}?clientConfigId=cfg-1`, mode: 'ivs', feeds: ['landscape', 'vertical'] });
    expect(plan.ivs).toEqual({
      tracks: [
        { feed: 'landscape', width: 1920, height: 1080, fps: fps(60), bitrateKbps: 6000, keyintSec: 2, profile: 'high', bframes: 3 },
        { feed: 'landscape', width: 640, height: 360, fps: fps(30), bitrateKbps: 500, keyintSec: 2, profile: 'main', bframes: 3 },
        { feed: 'vertical', width: 1080, height: 1920, fps: fps(60), bitrateKbps: 5000, keyintSec: 2, profile: 'high', bframes: 3 },
        { feed: 'vertical', width: 360, height: 640, fps: fps(30), bitrateKbps: 500, keyintSec: 2, profile: 'main', bframes: 3 },
      ],
      audioBitrateKbps: 160,
      audioChannels: 2,
      preset: 'veryfast',
    });
  });

  it('keeps bandwidthtest before clientConfigId and honors an rtmp:// override', () => {
    const plan = planFromConfig(config(), input({ ingestServer: 'rtmp://live-fra.twitch.tv/app/', bandwidthTest: true }));
    expect(plan.url).toBe(`rtmp://live-fra.twitch.tv/app/${AUTH}?bandwidthtest=true&clientConfigId=cfg-1`);
  });

  it('picks RTMP when only RTMP is offered and keeps a template query', () => {
    const plan = planFromConfig(
      config({ ingest_endpoints: [{ protocol: 'RTMP', url_template: 'rtmp://h/app/{stream_key}?x=1', authentication: AUTH }] }),
      input(),
    );
    expect(plan.url).toBe(`rtmp://h/app/${AUTH}?x=1&clientConfigId=cfg-1`);
  });

  it('falls back to the stream key when no authentication is returned', () => {
    const plan = planFromConfig(config({ ingest_endpoints: [{ protocol: 'RTMPS', url_template: 'rtmps://h/app/{stream_key}' }] }), input());
    expect(plan.url).toBe('rtmps://h/app/live_1_KEY?clientConfigId=cfg-1');
  });

  it('rejects an error status with Twitch’s message as text', () => {
    expectRejected(
      () =>
        planFromConfig(
          config({
            status: { result: 'error', html_en_us: '<p>Your channel is not enabled for <b>Enhanced Broadcasting</b> &amp; Dual Format.</p>' },
            encoder_configurations: [],
          }),
          input(),
        ),
      /Your channel is not enabled for Enhanced Broadcasting & Dual Format\./,
    );
  });

  it("surfaces Twitch's real track-count error (response captured 2026-10-21)", () => {
    const captured: ClientConfigResponse = {
      status: {
        result: 'error',
        html_en_us:
          'Amazon IVS Multitrack Video requires at least 2 tracks per canvas.  You have either requested too few encodes (3) to support this, or we believe your GPU would not handle this workload.',
      },
      encoder_configurations: [],
      audio_configurations: { live: [], vod: [] },
    };
    expectRejected(() => planFromConfig(captured, input()), /at least 2 tracks per canvas/);
  });

  it('passes warnings on and continues', () => {
    const warn = vi.fn();
    planFromConfig(config({ status: { result: 'warning', html_en_us: 'Driver <i>old</i>' } }), input(), warn);
    expect(warn).toHaveBeenCalledWith('Driver old');
  });

  it('rejects what Relay can’t encode: no vertical track, unknown canvases, non-H.264, a non-landscape first track, audio mismatches', () => {
    const enc = config().encoder_configurations!;
    expectRejected(() => planFromConfig(config({ encoder_configurations: [enc[0]!, enc[1]!] }), input()), /no track for the vertical feed/);
    expectRejected(() => planFromConfig(config({ encoder_configurations: [enc[0]!, { ...enc[2]!, canvas_index: 2 }] }), input()), /unknown canvas/);
    expectRejected(() => planFromConfig(config({ encoder_configurations: [{ ...enc[0]!, type: 'jim_hevc_nvenc' }, enc[2]!] }), input()), /HEVC/);
    expectRejected(() => planFromConfig(config({ encoder_configurations: [enc[2]!, enc[0]!] }), input()), /first track is not the landscape feed/);
    expectRejected(() => planFromConfig(config({ encoder_configurations: [{ ...enc[0]!, settings: {} }, enc[2]!] }), input()), /no bitrate/);
    expectRejected(() => planFromConfig(config({ audio_configurations: { live: [] } }), input()), /0 audio tracks/);
    expectRejected(() => planFromConfig(config({ audio_configurations: { live: [{ codec: 'opus' }] } }), input()), /opus audio/);
    expectRejected(() => planFromConfig(config({ ingest_endpoints: [] }), input()), /no RTMP ingest endpoint/);
  });
});

describe('fetchClientConfig / prepareMultitrack', () => {
  it('POSTs JSON to Twitch and returns a plan', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(config()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const plan = await prepareMultitrack(input(), new AbortController().signal);
    expect(plan.mode).toBe('ivs');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CLIENT_CONFIG_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string).authentication).toBe('live_1_KEY');
  });

  it('maps a 4xx to misconfigured with the server message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: { result: 'error', html_en_us: 'Invalid <b>stream key</b>' } }), { status: 400 })),
    );
    await expect(fetchClientConfig({}, new AbortController().signal)).rejects.toMatchObject({
      code: 'misconfigured',
      message: expect.stringMatching(/Invalid stream key/),
    });
  });

  it('maps 5xx and network failures to retryable errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 503 })));
    await expect(fetchClientConfig({}, new AbortController().signal)).rejects.toMatchObject({ code: 'platform-error' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(fetchClientConfig({}, new AbortController().signal)).rejects.toMatchObject({ code: 'platform-error' });
  });

  it('passes aborts through', async () => {
    const ctl = new AbortController();
    ctl.abort();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit) => {
        init.signal?.throwIfAborted();
        return new Response('{}');
      }),
    );
    await expect(fetchClientConfig({}, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('stripHtml', () => {
  it('removes tags and decodes entities', () => {
    expect(stripHtml('<a href="x">Learn&nbsp;more</a><br/>now &lt;3')).toBe('Learn more now <3');
  });
});
