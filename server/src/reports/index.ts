// Stream reports service (docs/REPORTS.md): one per AppServices, like musicFor() and
// transcodeCapabilitiesFor(). main.ts binds the database with bindReportsDatabase() and starts it.

import type { ReportSettings } from '../../../shared/reports.js';
import type { Db } from '../db/database.js';
import type { AppServices } from '../services.js';
import { createPresenceProvider } from './presence.js';
import { ReportRecorder, reportSettingsFrom, type PresenceProvider } from './recorder.js';
import type { ReportContext } from './report.js';
import { migrateReports } from './schema.js';
import { createReportStore, type ReportStore } from './store.js';

export const REPORT_SETTINGS_KEY = 'reports';

export interface ReportsService {
  /** False when the report tables could not be opened (e.g. made by a newer Relay); routes answer 503. */
  readonly available: boolean;
  readonly store: ReportStore;
  readonly recorder: ReportRecorder;
  context(): ReportContext;
  settings(): ReportSettings;
  saveSettings(next: ReportSettings): ReportSettings;
  start(): void;
  close(): void;
}

const databases = new WeakMap<AppServices, Db>();
const instances = new WeakMap<AppServices, ReportsService>();

export function bindReportsDatabase(services: AppServices, db: Db): void {
  databases.set(services, db);
}

export function createReportsService(
  services: Pick<AppServices, 'bus' | 'log' | 'repos' | 'orchestrators' | 'driverContext'>,
  db: Db,
  opts: { presence?: PresenceProvider | null; now?: () => number; timers?: boolean } = {},
): ReportsService {
  const log = services.log.child({ mod: 'reports' });
  let available = true;
  try {
    migrateReports(db);
  } catch (err) {
    available = false;
    log.error({ error: err instanceof Error ? err.message : String(err) }, 'reports: the report tables cannot be used; stream reports are off');
  }
  const store = createReportStore(db);
  const settings = (): ReportSettings => reportSettingsFrom(services.repos.settings.get<unknown>(REPORT_SETTINGS_KEY, null));
  const recorder = new ReportRecorder({
    bus: services.bus,
    store,
    log,
    settings,
    destination: (id) => services.repos.destinations.get(id),
    sessions: () => {
      try {
        return services.orchestrators.all().map((o) => o.state());
      } catch {
        return [];
      }
    },
    presence: opts.presence === undefined ? createPresenceProvider(services) : opts.presence,
    now: opts.now,
    timers: opts.timers,
  });
  const profileName = (id: string): string | null => {
    try {
      return services.repos.profiles.get(id)?.name ?? null;
    } catch {
      return null;
    }
  };
  return {
    available,
    store,
    recorder,
    context: () => ({ store, now: opts.now, profileName }),
    settings,
    saveSettings(next) {
      const clean = reportSettingsFrom(next);
      services.repos.settings.set(REPORT_SETTINGS_KEY, clean);
      recorder.settingsChanged();
      recorder.retention();
      return clean;
    },
    start() {
      if (available) recorder.start();
    },
    close() {
      recorder.close();
    },
  };
}

/** The reports service of these services (created on first use; needs bindReportsDatabase first). */
export function reportsFor(services: AppServices): ReportsService {
  let r = instances.get(services);
  if (!r) {
    const db = databases.get(services);
    if (!db) throw new Error('reports: no database bound (bindReportsDatabase)');
    r = createReportsService(services, db);
    instances.set(services, r);
  }
  return r;
}

/** Tests: use this service for these services. */
export function setReportsFor(services: AppServices, r: ReportsService): void {
  instances.set(services, r);
}
