import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { TlsMode } from '../../shared/types.js';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

/** Optional string env var: empty/blank means unset (e.g. `PUBLIC_IP=` in a .env file). */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v?.trim() ? v.trim() : undefined));

const EnvSchema = z.object({
  DATA_DIR: z.string().default('./data'),
  /** Port the web UI listens on inside the container (HTTPS unless TLS_MODE=off). */
  WEB_PORT: z.coerce.number().int().default(8443),
  /** Plain-HTTP port for Let's Encrypt HTTP-01 challenges + redirect to HTTPS. 0 disables. */
  HTTP_PORT: z.coerce.number().int().default(8080),
  /** RTMP ingest port for OBS (keep this LAN-only). */
  RTMP_PORT: z.coerce.number().int().default(1935),
  /** MediaMTX control API port (bound to 127.0.0.1). */
  MEDIAMTX_API_PORT: z.coerce.number().int().default(9997),
  /** Externally visible HTTPS port (what the router forwards), used to build public URLs. */
  PUBLIC_PORT: z.coerce.number().int().default(443),
  TLS_MODE: z.enum(['auto', 'letsencrypt', 'self-signed', 'manual', 'off']).default('auto'),
  /** Public IP override (otherwise discovered). */
  PUBLIC_IP: optionalString,
  /** Optional domain name. When set, Let's Encrypt issues for the domain instead of the IP. */
  PUBLIC_HOST: optionalString,
  ACME_EMAIL: optionalString,
  ACME_STAGING: bool.default(false),
  /** For TLS_MODE=manual. */
  TLS_CERT_FILE: optionalString,
  TLS_KEY_FILE: optionalString,
  /** 32-byte key as 64 hex chars or base64. Otherwise generated into DATA_DIR/master.key. */
  MASTER_KEY: optionalString,
  MEDIAMTX_BIN: optionalString,
  FFMPEG_BIN: optionalString,
  BROWSER_HEADLESS: bool.default(true),
  /** Trust X-Forwarded-* headers (only when running behind your own reverse proxy). */
  TRUST_PROXY: bool.default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Set by the Docker build (CI): the git commit and build time of this image. */
  CTD_BUILD_COMMIT: optionalString,
  CTD_BUILD_DATE: optionalString,
  /** Show-profile asset storage: total quota in bytes (default 20 GB, see storage/blob-store.ts). */
  ASSETS_QUOTA_BYTES: z.coerce.number().int().positive().optional(),
});

/** Which build is running: shown at the bottom of the web UI and in the external API. */
export interface BuildInfo {
  /** Short git commit (7 chars), or null for a local/dev build. */
  commit: string | null;
  /** ISO time the image was built, or null. */
  date: string | null;
}

export function buildInfo(commit: string | undefined, date: string | undefined): BuildInfo {
  const sha = commit?.trim().toLowerCase() ?? '';
  const when = date?.trim() ?? '';
  return {
    commit: /^[0-9a-f]{7,40}$/.test(sha) ? sha.slice(0, 7) : null,
    date: when && Number.isFinite(Date.parse(when)) ? new Date(when).toISOString() : null,
  };
}

export interface AppConfig {
  dataDir: string;
  webPort: number;
  httpPort: number;
  rtmpPort: number;
  mediamtxApiPort: number;
  publicPort: number;
  tlsMode: TlsMode;
  publicIp: string | null;
  publicHost: string | null;
  acmeEmail: string | null;
  acmeStaging: boolean;
  tlsCertFile: string | null;
  tlsKeyFile: string | null;
  masterKey: string | null;
  mediamtxBin: string;
  ffmpegBin: string;
  browserHeadless: boolean;
  trustProxy: boolean;
  logLevel: string;
  version: string;
  /** Missing in hand-built test configs. */
  build?: BuildInfo;
  /** Asset storage limit overrides from the environment (defaults in storage/blob-store.ts). Missing in test configs. */
  assetLimits?: { quotaBytes?: number };
}

/**
 * Resolve a bundled tool: env override (path or bare name on PATH), else ./tools (dev). Docker sets the env vars.
 * A relative path is made absolute: MediaMTX is spawned with another cwd, which a relative command
 * would be resolved against. On Windows a path without an extension gets `.exe` when that file
 * exists (spawn would add it, but the existence check would not find the bare name).
 */
export function toolPath(envValue: string | undefined, name: string, platform: NodeJS.Platform = process.platform): string {
  if (envValue) {
    if (!/[\\/]/.test(envValue)) return envValue; // bare name: PATH lookup
    const resolved = path.resolve(envValue);
    if (platform === 'win32' && !path.extname(resolved) && fs.existsSync(`${resolved}.exe`)) return `${resolved}.exe`;
    return resolved;
  }
  return path.resolve('tools', `${name}${platform === 'win32' ? '.exe' : ''}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, version = '0.0.0'): AppConfig {
  const e = EnvSchema.parse(env);
  return {
    dataDir: path.resolve(e.DATA_DIR),
    webPort: e.WEB_PORT,
    httpPort: e.HTTP_PORT,
    rtmpPort: e.RTMP_PORT,
    mediamtxApiPort: e.MEDIAMTX_API_PORT,
    publicPort: e.PUBLIC_PORT,
    tlsMode: e.TLS_MODE,
    publicIp: e.PUBLIC_IP ?? null,
    publicHost: e.PUBLIC_HOST ?? null,
    acmeEmail: e.ACME_EMAIL ?? null,
    acmeStaging: e.ACME_STAGING,
    tlsCertFile: e.TLS_CERT_FILE ?? null,
    tlsKeyFile: e.TLS_KEY_FILE ?? null,
    masterKey: e.MASTER_KEY ?? null,
    mediamtxBin: toolPath(e.MEDIAMTX_BIN, 'mediamtx'),
    ffmpegBin: toolPath(e.FFMPEG_BIN, 'ffmpeg'),
    browserHeadless: e.BROWSER_HEADLESS,
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL,
    version,
    build: buildInfo(e.CTD_BUILD_COMMIT, e.CTD_BUILD_DATE),
    assetLimits: e.ASSETS_QUOTA_BYTES ? { quotaBytes: e.ASSETS_QUOTA_BYTES } : {},
  };
}
