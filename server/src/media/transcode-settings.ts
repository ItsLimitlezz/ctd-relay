// The server-wide transcoding switch (settings key 'transcode', docs/TRANSCODING.md §2) and what the
// push supervisor needs to transcode: the switch, and this machine's capability probe.

import type { TranscodeCapabilities, TranscodeSettings } from '../../../shared/api.js';
import { DEFAULT_MAX_WORKERS, MAX_WORKERS_LIMIT } from '../../../shared/transcode.js';
import type { SettingsRepo } from '../services.js';
import type { TranscodeRuntime } from './ffmpeg-supervisor.js';
import type { TranscodeCapabilityService } from './transcode-capabilities.js';

export const TRANSCODE_SETTINGS_KEY = 'transcode';

export const DEFAULT_TRANSCODE_SETTINGS: TranscodeSettings = { enabled: false, maxWorkers: DEFAULT_MAX_WORKERS };

/** Stored settings with defaults applied; anything malformed counts as the default (off). */
export function readTranscodeSettings(settings: Pick<SettingsRepo, 'get'>): TranscodeSettings {
  const raw = settings.get<unknown>(TRANSCODE_SETTINGS_KEY, null);
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const n = o.maxWorkers;
  return {
    enabled: o.enabled === true,
    maxWorkers: typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_WORKERS_LIMIT ? n : DEFAULT_MAX_WORKERS,
  };
}

/** A push about to transcode waits this long for a capability probe that is still running. */
export const PROBE_WAIT_MS = 30_000;

/**
 * What the push supervisor reads when a push starts. `capabilities` is looked up lazily: the
 * capability service belongs to the app's services, which are built after the supervisor.
 */
export function createTranscodeRuntime(
  settings: Pick<SettingsRepo, 'get'>,
  capabilities: () => Pick<TranscodeCapabilityService, 'get' | 'start'>,
  waitMs = PROBE_WAIT_MS,
): TranscodeRuntime {
  return {
    settings: () => readTranscodeSettings(settings),
    async capabilities(): Promise<TranscodeCapabilities> {
      const svc = capabilities();
      const current = svc.get();
      if (current.state !== 'probing') return current;
      // Startup probe still running (or never started): join it, but don't hold a stream for long.
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<TranscodeCapabilities>((resolve) => {
        timer = setTimeout(() => resolve(svc.get()), waitMs);
      });
      try {
        return await Promise.race([svc.start(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
