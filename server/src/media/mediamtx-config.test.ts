import { describe, expect, it } from 'vitest';
import { buildMediaMtxConfig } from './mediamtx-config.js';

describe('buildMediaMtxConfig', () => {
  const yml = buildMediaMtxConfig({ rtmpPort: 1935, apiPort: 9997, authPort: 41234 });
  const has = (line: string) => expect(yml.split('\n')).toContain(line);

  it('enables RTMP only, without encryption, on the configured port', () => {
    has('rtmp: true');
    has('rtmpEncryption: "no"');
    has('rtmpAddress: ":1935"');
    for (const off of ['rtsp', 'hls', 'webrtc', 'srt', 'moq', 'playback', 'metrics', 'pprof']) has(`${off}: false`);
  });

  it('binds the API to loopback', () => {
    has('api: true');
    has('apiAddress: "127.0.0.1:9997"');
  });

  it('delegates auth to the loopback auth server, excluding api/metrics', () => {
    has('authMethod: http');
    has('authHTTPAddress: "http://127.0.0.1:41234/auth"');
    expect(yml).toMatch(/authHTTPExclude:\n {2}- action: api\n {2}- action: metrics\n/);
  });

  it("declares the default profile's two feed paths and one regex for every other profile (no all_others)", () => {
    expect(yml).toContain(
      [
        'paths:',
        '  live/landscape:',
        '    source: publisher',
        '  live/vertical:',
        '    source: publisher',
        '  "~^live/[a-z0-9-]{1,32}/(landscape|vertical)$":',
        '    source: publisher',
        '',
      ].join('\n'),
    );
    expect(yml.trimEnd().endsWith('    source: publisher')).toBe(true);
    expect(yml).not.toContain('all_others');
    expect(yml).not.toContain('all:');
  });

  it('uses only top-level keys known to MediaMTX v1.21', () => {
    const known = new Set([
      'logLevel', 'logDestinations', 'logStructured', 'readTimeout', 'writeTimeout', 'authMethod', 'authHTTPAddress',
      'authHTTPExclude', 'api', 'apiAddress', 'metrics', 'pprof', 'playback', 'rtmp', 'rtmpEncryption', 'rtmpAddress',
      'rtsp', 'hls', 'webrtc', 'srt', 'moq', 'pathDefaults', 'paths',
    ]);
    // (HLS keys: see "only uses HLS keys known to MediaMTX v1.21".)
    const topKeys = yml.split('\n').filter((l) => /^[A-Za-z]/.test(l)).map((l) => l.split(':')[0]);
    expect(topKeys.filter((k) => !known.has(k ?? ''))).toEqual([]);
  });

  describe('live preview (LL-HLS)', () => {
    const hls = buildMediaMtxConfig({ rtmpPort: 1935, apiPort: 9997, authPort: 41234, hlsPort: 9996 });
    const lines = hls.split('\n');

    it('is off without an HLS port', () => {
      has('hls: false');
      expect(yml).not.toContain('hlsAddress');
    });

    it('binds Low-Latency HLS to loopback only, muxed on demand, closed 30 s after the last request', () => {
      for (const l of [
        'hls: true',
        'hlsAddress: "127.0.0.1:9996"',
        'hlsEncryption: false',
        'hlsAllowOrigins: []',
        'hlsTrustedProxies: []',
        'hlsAlwaysRemux: false',
        'hlsVariant: lowLatency',
        'hlsPartDuration: 200ms',
        'hlsDirectory: ""',
        'hlsMuxerCloseAfter: 30s',
      ]) expect(lines).toContain(l);
      expect(lines).not.toContain('hls: false');
      // Everything else stays off (no WebRTC, RTSP, ...), and auth still goes through the hook.
      for (const off of ['rtsp', 'webrtc', 'srt', 'moq', 'playback']) expect(lines).toContain(`${off}: false`);
      expect(lines).toContain('authMethod: http');
    });

    it('never listens on every interface', () => {
      expect(hls).not.toMatch(/hlsAddress: ":/);
      expect(hls).not.toMatch(/hlsAddress: "0\.0\.0\.0/);
    });

    it('only uses HLS keys known to MediaMTX v1.21', () => {
      const known = new Set([
        'hls', 'hlsAddress', 'hlsEncryption', 'hlsServerKey', 'hlsServerCert', 'hlsAllowOrigins', 'hlsTrustedProxies',
        'hlsAlwaysRemux', 'hlsVariant', 'hlsSegmentCount', 'hlsSegmentDuration', 'hlsPartDuration', 'hlsSegmentMaxSize',
        'hlsDirectory', 'hlsMuxerCloseAfter', 'hlsCDNSecret',
      ]);
      const keys = lines.filter((l) => /^hls/.test(l)).map((l) => l.split(':')[0] ?? '');
      expect(keys.filter((k) => !known.has(k))).toEqual([]);
    });

    it('rejects an invalid HLS port', () => {
      expect(() => buildMediaMtxConfig({ rtmpPort: 1935, apiPort: 9997, authPort: 1, hlsPort: 0 })).toThrow(/hlsPort/);
    });
  });

  it('rejects invalid ports', () => {
    expect(() => buildMediaMtxConfig({ rtmpPort: 0, apiPort: 9997, authPort: 1 })).toThrow(/rtmpPort/);
    expect(() => buildMediaMtxConfig({ rtmpPort: 1935, apiPort: 70000, authPort: 1 })).toThrow(/apiPort/);
  });
});
