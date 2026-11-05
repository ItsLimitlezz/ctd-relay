import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, toolPath } from './config.js';

describe('tool paths', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('makes a relative env path absolute (MediaMTX is spawned with another cwd)', () => {
    const config = loadConfig({ MEDIAMTX_BIN: './tools/mediamtx-test-bin', FFMPEG_BIN: 'tools/ffmpeg-test-bin' });
    expect(path.isAbsolute(config.mediamtxBin)).toBe(true);
    expect(config.mediamtxBin).toBe(path.resolve('tools', 'mediamtx-test-bin'));
    expect(config.ffmpegBin).toBe(path.resolve('tools', 'ffmpeg-test-bin'));
  });

  it('leaves a bare command name for the PATH lookup', () => {
    const config = loadConfig({ MEDIAMTX_BIN: 'mediamtx', FFMPEG_BIN: 'ffmpeg' });
    expect(config.mediamtxBin).toBe('mediamtx');
    expect(config.ffmpegBin).toBe('ffmpeg');
  });

  it('keeps an absolute env path', () => {
    const abs = path.resolve('somewhere', 'ffmpeg');
    expect(toolPath(abs, 'ffmpeg', 'linux')).toBe(abs);
  });

  it('on Windows adds .exe to an extensionless path when that file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctd-tools-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'mediamtx.exe'), '');
    const bare = path.join(dir, 'mediamtx');
    expect(toolPath(bare, 'mediamtx', 'win32')).toBe(`${bare}.exe`);
    expect(toolPath(bare, 'mediamtx', 'linux')).toBe(bare);
    // No such .exe: left as is.
    expect(toolPath(path.join(dir, 'ffmpeg'), 'ffmpeg', 'win32')).toBe(path.join(dir, 'ffmpeg'));
  });

  it('defaults to ./tools', () => {
    expect(toolPath(undefined, 'ffmpeg', 'win32')).toBe(path.resolve('tools', 'ffmpeg.exe'));
    expect(toolPath(undefined, 'ffmpeg', 'linux')).toBe(path.resolve('tools', 'ffmpeg'));
  });
});

describe('ASSETS_QUOTA_BYTES', () => {
  it('is an optional positive override of the asset quota', () => {
    expect(loadConfig({}).assetLimits).toEqual({});
    expect(loadConfig({ ASSETS_QUOTA_BYTES: '1000000' }).assetLimits).toEqual({ quotaBytes: 1_000_000 });
    expect(() => loadConfig({ ASSETS_QUOTA_BYTES: '-5' })).toThrow();
  });
});
