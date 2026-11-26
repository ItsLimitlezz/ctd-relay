// SRTLA receiver (docs/SRTLA.md): supervises upstream `srtla_rec` (BELABOX/srtla, pinned, AGPL-3.0).
//
//   srtla_rec <SRTLA_PORT> 127.0.0.1 <SRT_PORT>
//
// It takes the bonded UDP links of a BELABOX/Moblin sender on SRTLA_PORT, puts the SRT packets back
// in one stream and forwards them to the local MediaMTX SRT listener. It doesn't parse SRT beyond
// packet types, so the handshake's streamid (path + key) reaches MediaMTX, and Relay's auth hook,
// unchanged. A UDP relay: no decoding, no transcoding.
//
// Off (Relay keeps working exactly as without SRTLA, with the reason in the status) when SRTLA_PORT=0,
// SRT is off, the binary is missing, or the UDP port is taken. Restarts with backoff when it exits.
// Its output (sender IP:port, group pointers; never a key, since it doesn't read the streamid) still
// goes through the redactor, like MediaMTX's and FFmpeg's.

import type { ChildProcess } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import type { Logger } from 'pino';
import type { SrtStatus } from '../../../shared/srt.js';
import { DEFAULT_SRTLA_MAX_GROUPS, srtlaStatusOff, srtlaStatusOn, type SrtlaStatus } from '../../../shared/srtla.js';
import { defaultSpawn, onLines, terminate, type SpawnFn } from './process-utils.js';
import { redactSecretsInText } from './redact.js';

export interface SrtlaReceiverOptions {
  log: Logger;
  /** srtla_rec path (or a bare name on PATH). */
  bin: string;
  /** SRTLA_PORT; 0/undefined = off. */
  port: number | undefined;
  maxGroups?: number;
}

export interface SrtlaReceiverDeps {
  spawn?: SpawnFn;
  now?: () => number;
  /** Can the UDP port be bound? Default: a real bind test (mediamtx.ts udpPortFree). */
  udpPortFree: (port: number) => Promise<boolean>;
  /** Is the binary there and executable? Default: fs.access. */
  binaryExists?: (bin: string) => Promise<boolean>;
  restartMinMs?: number;
  restartMaxMs?: number;
}

export interface SrtlaReceiver {
  /** Start after MediaMTX (it needs SRT's state: on, and on which port). Never throws. */
  start(srt: SrtStatus): Promise<void>;
  stop(): Promise<void>;
  status(): SrtlaStatus;
  /** A process is running right now (tests, health). */
  running(): boolean;
}

const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 30_000;
const HEALTHY_AFTER_MS = 60_000;

/** srtla_rec's error lines (it prints everything to stderr; these are the ones worth a warning). */
const WARN_RE = /\b(failed|error|WARNING|rejecting)\b/i;

async function defaultBinaryExists(bin: string): Promise<boolean> {
  if (!bin.includes('/') && !bin.includes('\\')) return true; // PATH lookup: spawn reports ENOENT
  try {
    await fs.access(bin, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The receiver's arguments: listen port, then where SRT is (always the local MediaMTX). */
export function srtlaArgs(port: number, srtPort: number): string[] {
  return [String(port), '127.0.0.1', String(srtPort)];
}

export function createSrtlaReceiver(opts: SrtlaReceiverOptions, deps: SrtlaReceiverDeps): SrtlaReceiver {
  const { log, bin } = opts;
  const maxGroups = opts.maxGroups ?? DEFAULT_SRTLA_MAX_GROUPS;
  const spawn = deps.spawn ?? defaultSpawn;
  const now = deps.now ?? Date.now;
  const binaryExists = deps.binaryExists ?? defaultBinaryExists;
  const restartMin = deps.restartMinMs ?? RESTART_MIN_MS;
  const restartMax = deps.restartMaxMs ?? RESTART_MAX_MS;
  const wanted = opts.port && opts.port > 0 ? opts.port : null;
  const notFound = `srtla_rec was not found at ${bin}, so SRTLA is off (SRT and RTMP work as usual). Run \`npm run setup-tools\` with a C compiler installed, or set SRTLA_BIN.`;

  let status: SrtlaStatus = wanted ? srtlaStatusOff('The media server is not running yet.', maxGroups) : srtlaStatusOff('SRTLA is turned off on this server (SRTLA_PORT=0).', maxGroups);
  let active = false;
  let proc: ChildProcess | null = null;
  let startedAt = 0;
  let attempt = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  let lastError: string | null = null;
  let args: string[] = [];

  function onLine(line: string): void {
    const text = redactSecretsInText(line.trim());
    if (!text) return;
    if (WARN_RE.test(text)) {
      lastError = text;
      log.warn(`srtla_rec: ${text}`);
    } else {
      log.debug(`srtla_rec: ${text}`);
    }
  }

  function killOnExit(): void {
    try {
      proc?.kill();
    } catch {
      // ignore
    }
  }

  function spawnProcess(): void {
    lastError = null;
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      status = srtlaStatusOff(notFound, maxGroups);
      log.error(notFound);
      return;
    }
    proc = child;
    startedAt = now();
    onLines(child.stdout, onLine);
    onLines(child.stderr, onLine);
    let ended = false;
    const onEnd = (code: number | null, signal: NodeJS.Signals | null, spawnError?: NodeJS.ErrnoException) => {
      if (ended) return;
      ended = true;
      if (proc !== child) return;
      proc = null;
      if (!active) return;
      if (spawnError && (spawnError.code === 'ENOENT' || spawnError.code === 'EACCES')) {
        status = srtlaStatusOff(notFound, maxGroups);
        log.error(notFound);
        return; // nothing to retry until the binary is installed
      }
      if (now() - startedAt >= HEALTHY_AFTER_MS) attempt = 0;
      const delay = Math.min(restartMax, restartMin * 2 ** attempt);
      attempt++;
      log.warn({ code, signal, lastError, attempt }, `srtla_rec exited unexpectedly; restarting in ${Math.round(delay / 1000)} s`);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (active && !proc) spawnProcess();
      }, delay);
    };
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (child.pid === undefined) onEnd(null, null, err);
      else log.warn({ err: err.message }, 'srtla_rec process error');
    });
    child.on('exit', (code, signal) => onEnd(code, signal));
    if (child.pid !== undefined) log.info({ pid: child.pid, srtlaPort: wanted, maxGroups }, 'srtla_rec started');
  }

  return {
    async start(srt) {
      if (active) return;
      if (!wanted) return;
      if (!srt.enabled || !srt.port) {
        status = srtlaStatusOff(`SRTLA needs SRT, and SRT is off: ${srt.reason ?? 'SRT_PORT=0.'}`, maxGroups);
        log.info('SRT is off, so SRTLA stays off');
        return;
      }
      if (wanted === srt.port) {
        status = srtlaStatusOff(`SRTLA_PORT and SRT_PORT are both ${wanted}; give SRTLA its own UDP port (default 5000), then restart.`, maxGroups);
        log.warn({ srtlaPort: wanted }, 'SRTLA_PORT equals SRT_PORT; SRTLA stays off');
        return;
      }
      if (!(await binaryExists(bin).catch(() => false))) {
        status = srtlaStatusOff(notFound, maxGroups);
        log.warn(notFound);
        return;
      }
      if (!(await deps.udpPortFree(wanted).catch(() => false))) {
        status = srtlaStatusOff(`UDP port ${wanted} is already in use on this machine, so SRTLA is off (SRT and RTMP work as usual). Free the port or set SRTLA_PORT to another one, then restart.`, maxGroups);
        log.warn({ srtlaPort: wanted }, 'SRTLA port is in use; SRTLA stays off');
        return;
      }
      args = srtlaArgs(wanted, srt.port);
      active = true;
      attempt = 0;
      status = srtlaStatusOn(wanted, maxGroups);
      process.once('exit', killOnExit);
      spawnProcess();
    },

    async stop() {
      active = false;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      process.off('exit', killOnExit);
      const child = proc;
      proc = null;
      if (child) await terminate(child, 3_000);
    },

    status() {
      return status;
    },

    running() {
      return proc !== null;
    },
  };
}
