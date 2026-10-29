// Composition root: build every service, wire them together, start listening.

import fs from 'node:fs';
import type https from 'node:https';
import path from 'node:path';
import pino, { type Logger } from 'pino';
import type { AppSettings } from '../../shared/api.js';
import { eventHubFor } from './api/event-hub.js';
import { musicFor } from './music/music-service.js';
import { createAppRegistry } from './api/hub.js';
import { createLanHandler } from './api/lan.js';
import { createPairingService } from './api/pairing.js';
import { createChatHub } from './chat/chat-hub.js';
import { createBrowserManager } from './browser/browser-manager.js';
import { loadConfig, type AppConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { createRepos } from './db/repos.js';
import { EventBus } from './events.js';
import { buildApp } from './http/app.js';
import { createPushSupervisor } from './media/ffmpeg-supervisor.js';
import { createMediaServer } from './media/mediamtx.js';
import { errorMessage, redactText } from './orchestrator/async-utils.js';
import { createOrchestratorRegistry } from './orchestrator/registry.js';
import { createPlatformRegistry } from './platforms/registry.js';
import type { DriverContext } from './platforms/types.js';
import { createSecretBox, loadMasterKey } from './security/secretbox.js';
import { announceSetupCodeIfNeeded } from './security/setup-code.js';
import type { AppServices } from './services.js';
import { createTlsManager } from './tls/tls-manager.js';

export const DEFAULT_APP_SETTINGS: AppSettings = {
  publicBaseUrl: '',
  ingestHost: '',
  disconnectGraceSec: 15,
};

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Hard deadline for a graceful shutdown. Keep it under the container's stop grace period
 * (stop_grace_period: 30s in docker-compose.yml and the TrueNAS app YAML). The orchestrator
 * teardown fits inside: push stop (<= ~7 s) + end() (DEFAULT_TIMINGS.shutdownEndTimeoutMs, 15 s),
 * leaving the rest for the browser session save and closing the listeners.
 */
export const SHUTDOWN_FORCE_EXIT_MS = 28_000;

async function saveBrowserSessions(services: AppServices): Promise<void> {
  let accounts: { id: string }[];
  try {
    accounts = services.repos.accounts.list();
  } catch {
    return;
  }
  await Promise.all(
    accounts.map((a) =>
      services.browser.save(a.id).catch((err: unknown) =>
        services.log.warn({ accountId: a.id, error: err instanceof Error ? err.message : String(err) }, 'saving browser session on shutdown failed'),
      ),
    ),
  );
}

/** Secret-free log fields for something thrown (messages and stacks can embed RTMP URLs with keys). */
function crashFields(err: unknown): { error: string; name?: string; stack?: string } {
  if (!(err instanceof Error)) return { error: errorMessage(err) };
  return { error: errorMessage(err), name: err.name, ...(err.stack ? { stack: redactText(err.stack) } : {}) };
}

/**
 * Process-level safety net. An uncaught exception leaves the process in an unknown state: log it
 * and exit non-zero, so Docker (restart: unless-stopped) or TrueNAS restarts the app. An unhandled
 * promise rejection is only logged (Node's default would kill the process for it). Returns a
 * function that removes the handlers (tests).
 */
export function installProcessHandlers(
  log: Pick<Logger, 'fatal' | 'error'>,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  let exiting = false;
  const onException = (err: unknown, origin: string): void => {
    try {
      log.fatal({ ...crashFields(err), origin }, 'uncaught exception; exiting so the app is restarted');
    } catch {
      console.error('uncaught exception; exiting', errorMessage(err));
    }
    if (exiting) return;
    exiting = true;
    exit(1);
  };
  const onRejection = (reason: unknown): void => {
    try {
      log.error(crashFields(reason), 'unhandled promise rejection');
    } catch {
      console.error('unhandled promise rejection', errorMessage(reason));
    }
  };
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  return () => {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
  };
}

function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export async function createServices(config: AppConfig): Promise<AppServices> {
  fs.mkdirSync(config.dataDir, { recursive: true });

  const log = pino({
    level: config.logLevel,
    redact: {
      paths: ['*.password', '*.streamKey', '*.accessToken', '*.refreshToken', '*.token', '*.url', 'req.headers.cookie'],
      censor: '[redacted]',
    },
  });
  const bus = new EventBus();
  const masterKey = loadMasterKey(config);
  const secretBox = createSecretBox(masterKey);
  const db = openDatabase(path.join(config.dataDir, 'app.db'));
  const repos = createRepos(db, secretBox);

  const tls = createTlsManager({ config, log: log.child({ mod: 'tls' }), settings: repos.settings });
  // Every profile's OBS ingest (the default profile keeps live/landscape|vertical and the 'ingest' keys).
  const media = createMediaServer({ config, bus, log: log.child({ mod: 'mediamtx' }), repos });
  // Push ids are destination ids; the supervisor reads the destination's profile to pick its feeds.
  const pushes = createPushSupervisor({ config, bus, log: log.child({ mod: 'ffmpeg' }), media, repos });
  const browser = createBrowserManager({ config, log: log.child({ mod: 'browser' }), secrets: repos.secrets });
  // Per-profile chat + overlay tokens (the default profile keeps its 'chat' scope token, so the
  // existing OBS overlay URL keeps working).
  const chat = createChatHub({ bus, log: log.child({ mod: 'chat' }), secrets: repos.secrets, profiles: repos.profiles });
  const platforms = createPlatformRegistry();
  // The hub: connected apps (presence + resources) and "connect this app" pairing requests.
  const apps = createAppRegistry({ repos, bus, log: log.child({ mod: 'apps' }) });
  const pairings = createPairingService({ repos, bus, log: log.child({ mod: 'pairing' }), config });

  const appSettings = (): AppSettings => ({ ...DEFAULT_APP_SETTINGS, ...repos.settings.get<Partial<AppSettings>>('app', {}) });

  const publicBaseUrl = (): string => {
    const override = appSettings().publicBaseUrl.trim();
    if (override) return override.replace(/\/+$/, '');
    if (config.tlsMode === 'off') return `http://localhost:${config.webPort}`;
    const host = config.publicHost ?? tls.status().publicIp ?? config.publicIp ?? 'localhost';
    const port = config.publicPort === 443 ? '' : `:${config.publicPort}`;
    return `https://${hostForUrl(host)}${port}`;
  };

  const services = {
    config,
    log,
    bus,
    repos,
    secretBox,
    media,
    pushes,
    browser,
    chat,
    platforms,
    apps,
    pairings,
    tls,
    appSettings,
    publicBaseUrl,
  } as Omit<AppServices, 'orchestrators' | 'driverContext'> as AppServices;

  services.driverContext = async ({ platform, accountId, destinationId, signal }): Promise<DriverContext> => {
    const app = await repos.secrets.scoped(`app:${platform}`).getJson<Record<string, string>>('values');
    return {
      log: log.child({ mod: `platform:${platform}`, accountId, destinationId }),
      accountSecrets: accountId ? repos.secrets.scoped(`account:${accountId}`) : null,
      destinationSecrets: destinationId ? repos.secrets.scoped(`destination:${destinationId}`) : null,
      app: app && Object.keys(app).length > 0 ? app : null,
      browser,
      publicBaseUrl: publicBaseUrl(),
      signal: signal ?? new AbortController().signal,
      async updateAccount(patch) {
        if (!accountId) return;
        const updated = repos.accounts.update(accountId, patch);
        bus.emit('account', updated);
      },
    };
  };

  // One go-live engine per profile; profiles run independently and can be live at the same time.
  services.orchestrators = createOrchestratorRegistry(services);
  return services;
}

/** Stop the hub's background timers (presence checks, pairing expiry), when the implementation has them. */
function closeHub(services: AppServices): void {
  for (const part of [services.apps, services.pairings]) (part as Partial<{ close(): void }>).close?.();
}

export async function main(): Promise<void> {
  const config = loadConfig(process.env, readVersion());
  const services = await createServices(config);
  const { log } = services;
  installProcessHandlers(log);

  // External API event buffer: subscribe before anything starts emitting.
  const apiEvents = eventHubFor(services);
  // Spotify now playing + chat song requests (listens to chat, polls connected profiles).
  const music = musicFor(services);
  music.start();

  await services.media.start();
  await services.orchestrators.init();

  const tlsMaterial = await services.tls.init();
  const app = await buildApp(services, tlsMaterial);
  await app.listen({ host: '0.0.0.0', port: config.webPort });
  log.info(`Web UI listening on ${tlsMaterial ? 'https' : 'http'}://0.0.0.0:${config.webPort}`);

  // LAN clients get /api/v1, /dock and /overlay over plain HTTP on HTTP_PORT (TLS modes only).
  services.tls.setLanHandler?.(createLanHandler(app));

  await services.tls.start((material) => {
    if (tlsMaterial) {
      (app.server as https.Server).setSecureContext({ key: material.key, cert: material.cert });
      log.info('TLS certificate reloaded');
    }
  });

  announceSetupCodeIfNeeded(services.repos, log);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      log.warn('shutdown took too long; exiting');
      process.exit(1);
    }, SHUTDOWN_FORCE_EXIT_MS);
    force.unref();
    try {
      // Save browser sessions up front (storage state only, contexts stay open for end()), so a
      // slow end() cannot cost the login. browser.shutdown() saves again and closes afterwards.
      const earlySave = saveBrowserSessions(services);
      // Every profile's session ends in parallel, within the same budget.
      await services.orchestrators.shutdown();
      await earlySave;
      await services.pushes.stopAll();
      await services.browser.shutdown();
      await services.media.stop();
      await services.tls.stop();
      await app.close();
      music.close();
      apiEvents.close();
      closeHub(services);
    } catch (err) {
      log.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
