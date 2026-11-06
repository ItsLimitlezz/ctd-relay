import { describe, expect, it } from 'vitest';
import { obsHost } from './profiles.js';

const LAN = '10.20.30.40';

describe('obsHost', () => {
  const host = (requestHostname: string, ingestHostSetting = '', lanHttpHost: string | null = LAN) =>
    obsHost({ ingestHostSetting, lanHttpHost: lanHttpHost ?? undefined, requestHostname });

  it('hands OBS the public host it used, not the LAN address', () => {
    expect(host('203.0.113.7')).toBe('203.0.113.7');
    expect(host('203.0.113.7:8443')).toBe('203.0.113.7');
    expect(host('relay.example.com')).toBe('relay.example.com');
  });

  it('uses LAN_HTTP_HOST when the request came over a private address', () => {
    expect(host('192.168.1.77')).toBe(LAN);
    expect(host('10.20.30.40', '', '192.168.1.77')).toBe('192.168.1.77');
    expect(host('nas.local')).toBe(LAN);
    expect(host('localhost')).toBe(LAN);
  });

  it('falls back when the request host is missing', () => {
    expect(host('')).toBe(LAN);
    expect(host('', '', null)).toBe('localhost');
  });

  it('keeps the request host when it is private and LAN_HTTP_HOST is unset', () => {
    expect(host('192.168.1.77', '', null)).toBe('192.168.1.77');
  });

  it('still prefers the OBS host from Settings', () => {
    expect(host('203.0.113.7', 'http://192.168.1.77:8443/')).toBe('192.168.1.77');
  });
});
